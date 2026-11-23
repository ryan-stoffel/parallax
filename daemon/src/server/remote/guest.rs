//! Guest links (0108): one thread shown to one browser, through the relay, for 24 hours.
//!
//! The owner makes a link with `guest/create`. Its secret derives two keys with HKDF-SHA256
//! ([`derive`]): a relay pass, whose SHA-256 plxd sends the relay so it can count the guest
//! ([`Guests::relay_frame`]), and a host key, which never leaves plxd and the guest's browser.
//! plxd keeps only their hashes, and the secret goes out once, in `guest/create`'s answer.
//!
//! On a stream the relay marked `guest: <linkId>`, the remote listener serves only:
//!
//! - `POST /api/auth/guest` ([`sign_in`]): the host key and a `DPoP` proof. The first key binds the
//!   link, that key gets in again, and any other is refused.
//! - `GET /ws` ([`admit`]): a WebSocket for the bound key's proof, with no ticket and no session,
//!   at the guest level: the link's one thread, read-only unless it allows suggestions
//!   ([`crate::methods::guest`]). plxd starts the connection itself, so a guest sends no
//!   `initialize`. Everything it gets about the thread is [`GuestItem`]s that [`items`] builds from
//!   scratch, and no other notification.
//!
//! Links live in this plxd's memory, so a restart ends them all. Expiry, `guest/revoke`, a new
//! link for the thread, archiving or deleting the thread, and `hostedClient` turning off each end
//! one ([`end`]): it's forgotten, its connections and relay streams close, and the relay's list
//! drops it.

use std::collections::{HashMap, VecDeque};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use jiff::Timestamp;
use parallax_protocol::jsonrpc::ErrorObject;
use parallax_protocol::{
    AgentOutputItem, ErrorKind, GuestCreateResult, GuestEntry, GuestItem, GuestLink,
    GuestSuggestion, ParallaxEvent, RunId, TurnId,
};
use ring::hkdf;
use serde::Deserialize;
use serde_json::json;
use tokio::time::Instant;
use tokio_util::sync::CancellationToken;
use tracing::{info, warn};

use super::{Request, host_key, hosted_on, lock, refused};
use crate::agents::store_error;
use crate::event_log::{Entry, run_of};
use crate::remote;
use crate::server::Daemon;

/// How long a link works, as T3's does.
pub(crate) const LIFETIME: Duration = Duration::from_hours(24);

/// The most links live at once, as the relay keeps for a host.
const MAX_LINKS: usize = 20;

/// The most requests one link's guest makes a minute, across its connections.
pub(crate) const MAX_READS: usize = 10;

/// The window [`MAX_READS`] counts in.
const READ_WINDOW: Duration = Duration::from_mins(1);

/// The most suggestions that wait on one link.
const MAX_SUGGESTIONS: usize = 5;

/// HKDF's `info` for the relay pass and the host key. A browser derives the same.
const PASS_INFO: &[u8] = b"parallax guest relay pass v1";
const HOST_KEY_INFO: &[u8] = b"parallax guest host key v1";

/// What a request for a link that doesn't exist, ended, or has another host key hears. One answer
/// for all three tells a guesser nothing.
const UNKNOWN: &str = "an unknown or ended guest link";

/// The relay pass and the host key the 32-byte `secret` derives: HKDF-SHA256 with no salt, each
/// 32 bytes under its own `info`, so one tells nothing about the other.
pub(crate) fn derive(secret: &[u8]) -> ([u8; 32], [u8; 32]) {
    let key = hkdf::Salt::new(hkdf::HKDF_SHA256, &[]).extract(secret);
    let expand = |info: &[u8]| {
        let mut out = [0; 32];
        let info = [info];
        key.expand(&info, hkdf::HKDF_SHA256)
            .and_then(|okm| okm.fill(&mut out))
            .expect("HKDF-SHA256 gives 32 bytes");
        out
    };
    (expand(PASS_INFO), expand(HOST_KEY_INFO))
}

/// What `event` shows a guest of thread `thread`: [`GuestItem`]s built from scratch, copying only
/// what a transcript needs. Nothing comes from another thread's event, and nothing from a kind or
/// item not named here, permission and secret requests, run records, and queues among them.
pub(crate) fn items(event: &ParallaxEvent, thread: RunId) -> Vec<GuestItem> {
    if run_of(event) != Some(thread) {
        return Vec::new();
    }
    match event {
        ParallaxEvent::AgentOutput { items, .. } => items.iter().filter_map(item).collect(),
        ParallaxEvent::AgentUpdated { state, .. } => vec![GuestItem::Status {
            status: state.status,
        }],
        ParallaxEvent::ThreadReverted { turns, .. } => vec![GuestItem::Reverted {
            turns: turns.clone(),
        }],
        _ => Vec::new(),
    }
}

/// One transcript item as a guest sees it, if it sees it: the user's messages, the agent's
/// replies, its tool calls and their output, and where turns end. A hidden or wake turn, and every
/// other item, shows nothing.
fn item(item: &AgentOutputItem) -> Option<GuestItem> {
    match item {
        AgentOutputItem::TurnStarted {
            turn_id,
            text,
            wake: false,
            hidden: false,
            ..
        } => Some(GuestItem::TurnStarted {
            turn_id: *turn_id,
            text: text.clone(),
        }),
        AgentOutputItem::TextDelta { message_id, text } => Some(GuestItem::TextDelta {
            message_id: message_id.clone(),
            text: text.clone(),
        }),
        AgentOutputItem::Text { message_id, text } => Some(GuestItem::Text {
            message_id: message_id.clone(),
            text: text.clone(),
        }),
        AgentOutputItem::ToolCall {
            call_id,
            name,
            input,
        } => Some(GuestItem::ToolCall {
            call_id: call_id.clone(),
            name: name.clone(),
            input: input.clone(),
        }),
        AgentOutputItem::ToolResult {
            call_id,
            status,
            output,
            ..
        } => Some(GuestItem::ToolResult {
            call_id: call_id.clone(),
            status: *status,
            output: output.clone(),
        }),
        AgentOutputItem::TurnFinished {
            turn_id, result, ..
        } => Some(GuestItem::TurnFinished {
            turn_id: *turn_id,
            result: result.clone(),
        }),
        _ => None,
    }
}

/// The entry an event at `seq` and `time` shows a guest of `thread`, if it shows anything.
pub(crate) fn guest_entry(
    event: &ParallaxEvent,
    seq: u64,
    time: Timestamp,
    thread: RunId,
) -> Option<GuestEntry> {
    let items = items(event, thread);
    (!items.is_empty()).then_some(GuestEntry { seq, time, items })
}

/// [`guest_entry`] for an entry of the event log. Only the thread's own entries are parsed.
pub(crate) fn log_entry(entry: &Entry, thread: RunId) -> Option<GuestEntry> {
    if entry.run != Some(thread) {
        return None;
    }
    guest_entry(&entry.event(), entry.seq, entry.time, thread)
}

/// A live link.
#[derive(Debug)]
pub(crate) struct Link {
    pub(crate) id: String,
    pub(crate) thread: RunId,
    pub(crate) can_suggest: bool,
    created_at: Timestamp,
    expires_at: Timestamp,
    expires: Instant,
    /// The SHA-256 of the relay pass, in hex, as the relay gets it.
    pass_hash: String,
    host_key_hash: [u8; 32],
    state: Mutex<State>,
    /// Cancelled when the link ends, which closes its guest's connections.
    pub(crate) ended: CancellationToken,
}

#[derive(Debug, Default)]
struct State {
    /// The bound key's JWK thumbprint, and when it bound.
    bound: Option<(String, Timestamp)>,
    /// When each request in the last [`READ_WINDOW`] came.
    reads: VecDeque<Instant>,
    suggestions: Vec<GuestSuggestion>,
}

impl Link {
    /// Whether it still works: not ended, and not past its expiry, which its watcher may not have
    /// seen yet.
    pub(crate) fn live(&self) -> bool {
        !self.ended.is_cancelled() && Instant::now() < self.expires
    }

    /// Counts one of the guest's requests. False past [`MAX_READS`] in the last minute.
    pub(crate) fn take_read(&self) -> bool {
        let mut state = lock(&self.state);
        let now = Instant::now();
        while state
            .reads
            .front()
            .is_some_and(|at| now.duration_since(*at) >= READ_WINDOW)
        {
            state.reads.pop_front();
        }
        if state.reads.len() >= MAX_READS {
            return false;
        }
        state.reads.push_back(now);
        true
    }

    /// Binds the link to the key `thumbprint` if nothing has, and says whether it's that key's.
    fn bind(&self, thumbprint: &str) -> bool {
        let mut state = lock(&self.state);
        if let Some((bound, _)) = &state.bound {
            return bound == thumbprint;
        }
        state.bound = Some((thumbprint.to_owned(), Timestamp::now()));
        true
    }

    /// Whether the key `thumbprint` bound it.
    fn bound_to(&self, thumbprint: &str) -> bool {
        lock(&self.state)
            .bound
            .as_ref()
            .is_some_and(|(bound, _)| bound == thumbprint)
    }

    /// Keeps the guest's message `text` until the owner sends or dismisses it.
    pub(crate) fn suggest(&self, text: String) -> Result<GuestSuggestion, ErrorObject> {
        if !self.can_suggest {
            return Err(refusal("This guest link doesn't take suggestions."));
        }
        let mut state = lock(&self.state);
        if state.suggestions.len() >= MAX_SUGGESTIONS {
            return Err(refusal("Too many suggestions are waiting for the owner."));
        }
        let suggestion = GuestSuggestion {
            id: TurnId::generate(),
            text,
            at: Timestamp::now(),
        };
        state.suggestions.push(suggestion.clone());
        Ok(suggestion)
    }

    /// The waiting suggestion `id`.
    pub(crate) fn suggestion(&self, id: TurnId) -> Option<GuestSuggestion> {
        let state = lock(&self.state);
        state.suggestions.iter().find(|s| s.id == id).cloned()
    }

    /// Drops the waiting suggestion `id`, and says whether it waited.
    pub(crate) fn drop_suggestion(&self, id: TurnId) -> bool {
        let mut state = lock(&self.state);
        let before = state.suggestions.len();
        state.suggestions.retain(|s| s.id != id);
        state.suggestions.len() < before
    }

    fn view(&self) -> GuestLink {
        let state = lock(&self.state);
        GuestLink {
            id: self.id.clone(),
            thread_id: self.thread,
            created_at: self.created_at,
            expires_at: self.expires_at,
            can_suggest: self.can_suggest,
            bound_at: state.bound.as_ref().map(|(_, at)| *at),
            suggestions: state.suggestions.clone(),
        }
    }
}

/// The live links, by id.
#[derive(Debug)]
pub(crate) struct Guests {
    links: Mutex<HashMap<String, Arc<Link>>>,
    lifetime: Duration,
}

impl Guests {
    /// No links, each made to last `lifetime`: [`LIFETIME`], or less in tests.
    pub(crate) fn new(lifetime: Duration) -> Self {
        Self {
            links: Mutex::default(),
            lifetime,
        }
    }

    /// Link `id`, while it's live.
    pub(crate) fn get(&self, id: &str) -> Option<Arc<Link>> {
        lock(&self.links)
            .get(id)
            .filter(|link| link.live())
            .cloned()
    }

    /// The live links, oldest first.
    pub(crate) fn list(&self) -> Vec<GuestLink> {
        let mut links: Vec<_> = lock(&self.links)
            .values()
            .filter(|link| link.live())
            .map(|link| link.view())
            .collect();
        links.sort_by_key(|link| link.created_at);
        links
    }

    /// Whether any link is live.
    pub(crate) fn any_live(&self) -> bool {
        lock(&self.links).values().any(|link| link.live())
    }

    /// The relay's copy of the live links (0108): each one's id, the SHA-256 of its pass in hex,
    /// and its expiry in seconds since the epoch. A link missing from it is withdrawn.
    pub(crate) fn relay_frame(&self) -> String {
        let links: Vec<_> = lock(&self.links)
            .values()
            .filter(|link| link.live())
            .map(|link| {
                json!({
                    "link": link.id,
                    "pass": link.pass_hash,
                    "expires": link.expires_at.as_second(),
                })
            })
            .collect();
        json!({ "t": "guests", "links": links }).to_string()
    }

    fn remove(&self, id: &str) -> Option<Arc<Link>> {
        lock(&self.links).remove(id)
    }

    fn ids(&self) -> Vec<String> {
        lock(&self.links).keys().cloned().collect()
    }
}

/// A guest refusal with `message`, for the owner or the guest.
pub(crate) fn refusal(message: &str) -> ErrorObject {
    ErrorObject::parallax(ErrorKind::GuestRefused, message)
}

/// Makes a link to `thread` that lasts the configured lifetime, ending the thread's live one.
/// Refused while `hostedClient` is off, for a thread that doesn't exist or is archived, and past
/// [`MAX_LINKS`].
pub(crate) async fn create(
    daemon: &Arc<Daemon>,
    thread: RunId,
    can_suggest: bool,
) -> Result<GuestCreateResult, ErrorObject> {
    if !hosted_on(daemon).await {
        return Err(refusal(super::HOSTED_OFF));
    }
    // Read before the thread, so an archive the read misses comes after it in the log.
    let after = daemon.log.head();
    let row = daemon
        .reader
        .run(&CancellationToken::new(), move |db| {
            db.get_thread(thread.into()).map_err(|e| store_error(&e))
        })
        .await?;
    match row {
        None => return Err(crate::threads::thread_not_found(thread)),
        Some(row) if row.archived => return Err(refusal("The thread is archived.")),
        Some(_) => {}
    }
    let host_id = host_key(daemon)
        .await
        .map_err(|e| ErrorObject::internal_error(e.to_string()))?
        .host_id();
    let (link, secret) = new_link(thread, can_suggest, daemon.guests.lifetime);
    keep(daemon, &link).await?;
    tokio::spawn(watch(Arc::clone(daemon), Arc::clone(&link), after));
    info!(link = %link.id, %thread, can_suggest, "made a guest link");
    let fragment = format!("{host_id}.{}.{}", link.id, remote::base64url(&secret));
    Ok(GuestCreateResult {
        link: link.view(),
        fragment,
    })
}

/// A new link to `thread` lasting `lifetime`, and the secret its keys come from.
fn new_link(thread: RunId, can_suggest: bool, lifetime: Duration) -> (Arc<Link>, [u8; 32]) {
    let mut secret = [0; 32];
    getrandom::fill(&mut secret).expect("the OS's random numbers");
    let (pass, host_key) = derive(&secret);
    let created_at = Timestamp::now();
    let expires_at = created_at
        .checked_add(jiff::SignedDuration::try_from(lifetime).unwrap_or_default())
        .unwrap_or(created_at);
    let link = Arc::new(Link {
        id: remote::random_token(16),
        thread,
        can_suggest,
        created_at,
        expires_at,
        expires: Instant::now() + lifetime,
        pass_hash: remote::hex(&remote::sha256(&pass)),
        host_key_hash: remote::sha256(&host_key),
        state: Mutex::default(),
        ended: CancellationToken::new(),
    });
    (link, secret)
}

/// Keeps `link` as its thread's one live link: in one step under the lock, it ends the thread's
/// other links and checks [`MAX_LINKS`], so two calls at once leave one. Then it reads
/// `hostedClient` again, so a link kept as the switch turns off, after `close_hosted` ended the
/// others, ends at once.
async fn keep(daemon: &Daemon, link: &Arc<Link>) -> Result<(), ErrorObject> {
    let replaced = {
        let mut links = lock(&daemon.guests.links);
        let others = links.values().filter(|l| l.thread != link.thread).count();
        if others >= MAX_LINKS {
            return Err(refusal("This computer has 20 live guest links already."));
        }
        let replaced: Vec<_> = links
            .iter()
            .filter(|(_, l)| l.thread == link.thread)
            .map(|(id, _)| id.clone())
            .collect();
        let replaced: Vec<_> = replaced.iter().filter_map(|id| links.remove(id)).collect();
        links.insert(link.id.clone(), Arc::clone(link));
        replaced
    };
    for old in &replaced {
        close(daemon, old, "a new link for its thread");
    }
    daemon.relay.guests_changed.notify_one();
    if !hosted_on(daemon).await {
        end(daemon, &link.id, "the hosted client turned off");
        return Err(refusal(super::HOSTED_OFF));
    }
    Ok(())
}

/// Ends link `id`, for `why`: forgets it, closes its guest's connections and relay streams, and
/// tells the relay. False when no such link was live.
pub(crate) fn end(daemon: &Daemon, id: &str, why: &str) -> bool {
    let Some(link) = daemon.guests.remove(id) else {
        return false;
    };
    close(daemon, &link, why);
    daemon.relay.guests_changed.notify_one();
    true
}

/// Closes a forgotten `link`'s connections and relay streams.
fn close(daemon: &Daemon, link: &Link, why: &str) {
    link.ended.cancel();
    daemon.relay.cut_guest(&link.id);
    info!(link = %link.id, why, "ended a guest link");
}

/// Ends every link, as `hostedClient` turning off does.
pub(crate) fn end_all(daemon: &Daemon, why: &str) {
    for id in daemon.guests.ids() {
        end(daemon, &id, why);
    }
}

/// Ends `link` when it expires, or when an event after `after` says its thread was archived or
/// deleted, whichever path did it. A log that dropped events before this read them ends it too,
/// since it can't tell.
async fn watch(daemon: Arc<Daemon>, link: Arc<Link>, mut after: u64) {
    let mut head = daemon.log.watch();
    loop {
        match daemon
            .log
            .next_matching(after, |entry| ends_thread(entry, link.thread))
        {
            Ok((Some(_), _)) => {
                end(&daemon, &link.id, "its thread was archived or deleted");
                return;
            }
            Ok((None, seq)) => after = seq,
            Err(_) => {
                warn!(link = %link.id, "a guest link's watch fell behind the event log");
                end(&daemon, &link.id, "its watch fell behind the event log");
                return;
            }
        }
        tokio::select! {
            () = link.ended.cancelled() => return,
            () = tokio::time::sleep_until(link.expires) => {
                end(&daemon, &link.id, "it expired");
                return;
            }
            changed = head.changed() => if changed.is_err() {
                return;
            },
        }
    }
}

/// Whether `entry` archives or deletes thread `thread`.
fn ends_thread(entry: &Entry, thread: RunId) -> bool {
    match entry.kind() {
        "thread.updated" | "thread.deleted" => match entry.event().as_ref() {
            ParallaxEvent::ThreadUpdated { thread: updated } => {
                updated.id == thread && updated.archived
            }
            ParallaxEvent::ThreadDeleted { run_id, .. } => *run_id == thread,
            _ => false,
        },
        _ => false,
    }
}

/// `POST /api/auth/guest` on a stream the relay marked with link `link_id`: `{"hostKey"}` in
/// base64url and a `DPoP` proof. The first proof's key binds the link, and that key gets in again.
/// It answers with the thread, the link's expiry, and whether it takes suggestions.
pub(super) fn sign_in(
    daemon: &Daemon,
    link_id: &str,
    request: &Request,
) -> (u16, serde_json::Value) {
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Body {
        host_key: String,
    }
    let host_key = serde_json::from_slice::<Body>(&request.body)
        .ok()
        .and_then(|body| remote::base64url_decode(&body.host_key));
    let Some(host_key) = host_key else {
        return (400, json!({ "error": "invalid_request" }));
    };
    let proven = match request.proof(None) {
        Ok(proven) => proven,
        Err(why) => return refused(why),
    };
    if !daemon.remote.first_use(&proven) {
        return refused("a replayed DPoP proof");
    }
    let link = daemon.guests.get(link_id);
    let Some(link) = link.filter(|link| remote::sha256(&host_key) == link.host_key_hash) else {
        return refused(UNKNOWN);
    };
    if !link.bind(&proven.thumbprint) {
        warn!(link = %link.id, "refused a second browser's key for a guest link");
        let why = "This link is open in another browser";
        return (
            403,
            json!({ "error": "access_denied", "error_description": why }),
        );
    }
    (
        200,
        json!({
            "threadId": link.thread,
            "expiresAt": link.expires_at,
            "canSuggest": link.can_suggest,
        }),
    )
}

/// Whether `GET /ws` on a stream the relay marked with link `link_id` opens: no ticket, and a
/// `DPoP` proof from the key that bound the link. The link, and a token that closes the
/// connection when `closing` closes or the link ends.
pub(super) fn admit(
    daemon: &Daemon,
    link_id: &str,
    request: &Request,
    closing: &CancellationToken,
) -> Result<(Arc<Link>, CancellationToken), (u16, serde_json::Value)> {
    if request.query("wsTicket").is_some() {
        return Err(refused("a guest opens its socket with its proof"));
    }
    let proven = request.proof_for("GET", None).map_err(refused)?;
    if !daemon.remote.first_use(&proven) {
        return Err(refused("a replayed DPoP proof"));
    }
    let Some(link) = daemon.guests.get(link_id) else {
        return Err(refused(UNKNOWN));
    };
    if !link.bound_to(&proven.thumbprint) {
        return Err(refused("a key this guest link isn't bound to"));
    }
    let connection = closes_with(&link.ended, closing);
    Ok((link, connection))
}

/// A token for one connection that `closing` or `ended` cancels, whichever comes first.
fn closes_with(ended: &CancellationToken, closing: &CancellationToken) -> CancellationToken {
    let connection = closing.child_token();
    let (ended, closes) = (ended.clone(), connection.clone());
    tokio::spawn(async move {
        tokio::select! {
            () = ended.cancelled() => closes.cancel(),
            () = closes.cancelled() => {}
        }
    });
    connection
}

/// Events and a snapshot with every field a guest must never get set to [`fixtures::SECRET`],
/// beside the transcript a guest does get, for the projection's tests here and in
/// [`crate::server::connection`] and [`crate::methods`].
#[cfg(test)]
pub(crate) mod fixtures {
    use parallax_protocol::{LoggedEvent, ParallaxEvent, RunId, ThreadSnapshot, TurnId};
    use serde_json::{Value, json};

    /// What every field a guest must never get holds.
    pub(crate) const SECRET: &str = "s3cr3t";

    /// Text a guest's transcript does show.
    pub(crate) const SHOWN: [&str; 5] = [
        "Hello from the owner",
        "The visible reply",
        "visible-tool-input",
        "visible tool output",
        "The visible result",
    ];

    const TIME: &str = "2026-11-22T16:00:00Z";

    /// Thread `thread`'s run record, every private field set.
    fn run(thread: RunId, other: RunId) -> Value {
        json!({
            "id": thread,
            "project": "01a0d349-6e00-7c9e-80e2-0426486a8cae",
            "prompt": "s3cr3t prompt in the run record",
            "policy": "workspaceWrite",
            "status": "running",
            "backend": "s3cr3t-backend",
            "accountId": "acct-s3cr3t",
            "branch": "parallax/s3cr3t",
            "worktreePath": "/Users/s3cr3t-user/Library/Application Support/parallax/worktrees/app",
            "sessionId": "sess-s3cr3t",
            "error": "s3cr3t error",
            "orchestratorThread": other,
            "model": "s3cr3t-model",
            "pullRequests": ["https://github.com/o/s3cr3t/pull/1"],
            "createdAt": TIME,
            "updatedAt": TIME,
        })
    }

    /// The private things one turn on `thread` carries, and an event of `other`'s.
    pub(crate) fn events(thread: RunId, other: RunId) -> Vec<ParallaxEvent> {
        let turn = TurnId::generate();
        let items = json!([
            { "kind": "sessionStarted", "sessionId": "sess-s3cr3t", "model": "s3cr3t-model" },
            {
                "kind": "turnStarted", "turnId": turn, "text": SHOWN[0], "from": other,
                "threads": [other], "computers": ["s3cr3t-pc"]
            },
            { "kind": "turnStarted", "text": "s3cr3t hidden turn", "hidden": true },
            { "kind": "turnStarted", "text": "s3cr3t wake turn", "wake": true },
            { "kind": "reasoning", "text": "s3cr3t thinking" },
            { "kind": "text", "text": SHOWN[1] },
            { "kind": "toolCall", "callId": "toolu_1", "name": "Read", "input": { "path": SHOWN[2] } },
            { "kind": "toolResult", "callId": "toolu_1", "status": "ok", "output": SHOWN[3] },
            {
                "kind": "approvalRequested", "approvalId": "01a0f1c2-3d4e-7f50-8a61-7b8c9d0e1f21",
                "toolName": "Bash", "input": { "command": "cat ~/.ssh/s3cr3t" },
                "callId": "toolu_2", "alwaysAllow": ["Bash(s3cr3t:*)"], "expiresAt": TIME
            },
            {
                "kind": "secretRequested", "requestId": "01a0f701-4d5e-7f60-9b72-8c9d0e1f2a04",
                "label": "s3cr3t label", "reason": "s3cr3t reason", "placeholder": "s3cr3t"
            },
            {
                "kind": "subagent", "callId": "toolu_3", "agentType": "s3cr3t",
                "item": { "kind": "toolCall", "callId": "toolu_4", "name": "Bash",
                          "input": { "command": "s3cr3t" } }
            },
            { "kind": "notice", "detail": "s3cr3t notice" },
            { "kind": "warning", "detail": "s3cr3t warning" },
            {
                "kind": "turnFinished", "turnId": turn, "result": SHOWN[4],
                "sessionId": "sess-s3cr3t", "cursor": "s3cr3t-cursor"
            },
        ]);
        [
            json!({ "kind": "agent.started", "runId": thread, "run": run(thread, other) }),
            json!({ "kind": "agent.updated", "runId": thread, "state": {
                "status": "running", "accountId": "acct-s3cr3t", "backend": "s3cr3t-backend",
                "sessionId": "sess-s3cr3t", "error": "s3cr3t error", "model": "s3cr3t-model",
                "updatedAt": TIME
            } }),
            json!({ "kind": "agent.output", "runId": thread, "items": items }),
            json!({ "kind": "queue.updated", "runId": thread, "messages": [
                { "id": TurnId::generate(), "text": "queued s3cr3t", "images": 0, "threads": [other] }
            ] }),
            json!({ "kind": "agent.output", "runId": other, "items": [
                { "kind": "text", "text": "s3cr3t from another thread" }
            ] }),
        ]
        .into_iter()
        .map(|event| serde_json::from_value(event).expect("a known event"))
        .collect()
    }

    /// Thread `thread`'s snapshot with [`events`], its run record, its queued and attached runs,
    /// a waiting permission request, and a watched pull request.
    pub(crate) fn snapshot(thread: RunId, other: RunId) -> ThreadSnapshot {
        let logged: Vec<_> = events(thread, other)
            .into_iter()
            .enumerate()
            .map(|(seq, event)| LoggedEvent {
                seq: seq as u64 + 1,
                time: TIME.parse().unwrap(),
                project: None,
                event,
            })
            .collect();
        let request = logged[2].clone();
        let snapshot = json!({
            "seq": 9,
            "thread": run(thread, other),
            "runs": [{
                "id": TurnId::generate(), "status": "queued", "text": "queued s3cr3t run",
                "images": 0, "threads": [other], "from": other
            }],
            "events": logged,
            "more": false,
            "requests": [request],
            "watching": ["https://github.com/o/s3cr3t/pull/2"],
        });
        serde_json::from_value(snapshot).expect("a snapshot")
    }

    /// Whether `sent` holds nothing private: no [`SECRET`] and not `other`'s id.
    pub(crate) fn private_in(sent: &str, other: RunId) -> Vec<String> {
        let mut found = Vec::new();
        if let Some(at) = sent.find(SECRET) {
            let start = at.saturating_sub(40);
            found.push(sent[start..(at + 20).min(sent.len())].to_owned());
        }
        if sent.contains(&other.to_string()) {
            found.push(format!("another thread's id, {other}"));
        }
        found
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;
    use std::time::Duration;

    use parallax_protocol::{ErrorKind, RunId};
    use tokio_util::sync::CancellationToken;

    use super::fixtures::{SHOWN, events, private_in};
    use super::{LIFETIME, closes_with, derive, items, keep, new_link};
    use crate::agents::store_error;
    use crate::server::Daemon;

    #[tokio::test]
    async fn a_guests_connection_closes_when_its_link_ends_or_its_listener_closes() {
        let (ended, closing) = (CancellationToken::new(), CancellationToken::new());
        let connection = closes_with(&ended, &closing);
        ended.cancel();
        tokio::time::timeout(Duration::from_secs(5), connection.cancelled())
            .await
            .expect("the link's end closes it");
        assert!(!closing.is_cancelled(), "and nothing else");
        let other = closes_with(&CancellationToken::new(), &closing);
        closing.cancel();
        assert!(other.is_cancelled(), "the listener's close does too");
    }

    #[test]
    fn the_secret_derives_two_unrelated_keys_the_same_way_each_time() {
        let secret = [7; 32];
        let (pass, host_key) = derive(&secret);
        assert_ne!(pass, host_key);
        assert_eq!(derive(&secret), (pass, host_key));
        assert_ne!(derive(&[8; 32]).0, pass);
        // RFC 5869 HKDF-SHA256 with no salt, as a browser's WebCrypto derives it.
        assert_eq!(
            crate::remote::hex(&pass),
            "59f3b2e085f02b97ccf4660f389658d0eaf136baaf17a572418345a52707d8d9"
        );
    }

    #[test]
    fn a_guest_gets_only_its_threads_transcript_and_no_private_field() {
        let (thread, other) = (RunId::generate(), RunId::generate());
        let shown: Vec<_> = events(thread, other)
            .iter()
            .flat_map(|event| items(event, thread))
            .collect();
        let sent = serde_json::to_string(&shown).unwrap();
        assert_eq!(private_in(&sent, other), Vec::<String>::new(), "{sent}");
        for text in SHOWN {
            assert!(sent.contains(text), "{text} in {sent}");
        }
        let kinds: Vec<_> = serde_json::to_value(&shown)
            .unwrap()
            .as_array()
            .unwrap()
            .iter()
            .map(|item| item["kind"].as_str().unwrap().to_owned())
            .collect();
        assert_eq!(
            kinds,
            [
                "status",
                "turnStarted",
                "text",
                "toolCall",
                "toolResult",
                "turnFinished"
            ],
            "a permission request is dropped, not shown"
        );
    }

    /// A daemon with `hostedClient` as `on` says.
    async fn daemon(dir: &std::path::Path, on: bool) -> Arc<Daemon> {
        let daemon = Daemon::for_tests(dir, 10, Duration::from_secs(90));
        daemon
            .store
            .run(&CancellationToken::new(), move |db| {
                db.set_hosted_client(on).map_err(|e| store_error(&e))
            })
            .await
            .unwrap();
        daemon
    }

    #[tokio::test]
    async fn two_links_made_at_once_for_one_thread_leave_one_live() {
        let dir = tempfile::tempdir().unwrap();
        let daemon = daemon(dir.path(), true).await;
        let thread = RunId::generate();
        // Both calls passed their checks before either kept its link, as two at once do.
        let (a, _) = new_link(thread, false, LIFETIME);
        let (b, _) = new_link(thread, false, LIFETIME);
        let (kept_a, kept_b) = tokio::join!(keep(&daemon, &a), keep(&daemon, &b));
        kept_a.unwrap();
        kept_b.unwrap();
        assert_eq!(daemon.guests.list().len(), 1);
        assert!(
            a.ended.is_cancelled() != b.ended.is_cancelled(),
            "the one replaced is closed"
        );
    }

    #[tokio::test]
    async fn a_link_kept_as_the_switch_turns_off_ends_at_once() {
        let dir = tempfile::tempdir().unwrap();
        // `create` read the switch on, then it turned off and `close_hosted` ended every link.
        let daemon = daemon(dir.path(), false).await;
        let (link, _) = new_link(RunId::generate(), false, LIFETIME);
        let refused = keep(&daemon, &link).await.unwrap_err();
        assert_eq!(
            refused.data.and_then(|data| data.get("kind").cloned()),
            Some(serde_json::to_value(ErrorKind::GuestRefused).unwrap())
        );
        assert!(daemon.guests.list().is_empty());
        assert!(link.ended.is_cancelled());
    }
}
