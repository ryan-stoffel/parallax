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
//!   ([`crate::methods::guest`]), with an outgoing filter that passes only [`shown`] events.
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
    ErrorKind, GuestCreateResult, GuestLink, GuestSuggestion, ParallaxEvent, RunId, TurnId,
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

/// Whether a guest of thread `thread` may see `event`: a kind on the list, of that thread's run.
/// Anything else is dropped, host-wide events and kinds added later among them.
pub(crate) fn shown(event: &ParallaxEvent, thread: RunId) -> bool {
    matches!(
        event,
        ParallaxEvent::AgentStarted { .. }
            | ParallaxEvent::AgentUpdated { .. }
            | ParallaxEvent::AgentOutput { .. }
            | ParallaxEvent::AgentFinished { .. }
            | ParallaxEvent::ThreadReverted { .. }
    ) && run_of(event) == Some(thread)
}

/// [`shown`] for an entry of the event log. Only the thread's own entries are parsed.
pub(crate) fn shown_entry(entry: &Entry, thread: RunId) -> bool {
    entry.run == Some(thread) && shown(&entry.event(), thread)
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

    fn of_thread(&self, thread: RunId) -> Vec<String> {
        lock(&self.links)
            .values()
            .filter(|link| link.thread == thread)
            .map(|link| link.id.clone())
            .collect()
    }

    fn ids(&self) -> Vec<String> {
        lock(&self.links).keys().cloned().collect()
    }
}

/// A guest refusal with `message`, for the owner or the guest.
pub(crate) fn refusal(message: &str) -> ErrorObject {
    ErrorObject::parallax(ErrorKind::GuestRefused, message)
}

/// Makes a link to `thread` that lasts the configured lifetime, after ending the thread's live
/// one. Refused while `hostedClient` is off, for a thread that doesn't exist or is archived, and
/// past [`MAX_LINKS`].
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
    for id in daemon.guests.of_thread(thread) {
        end(daemon, &id, "a new link for its thread");
    }
    let host_id = host_key(daemon)
        .await
        .map_err(|e| ErrorObject::internal_error(e.to_string()))?
        .host_id();
    let mut secret = [0; 32];
    getrandom::fill(&mut secret).expect("the OS's random numbers");
    let (pass, host_key) = derive(&secret);
    let id = remote::random_token(16);
    let created_at = Timestamp::now();
    let lifetime = daemon.guests.lifetime;
    let expires_at = created_at
        .checked_add(jiff::SignedDuration::try_from(lifetime).unwrap_or_default())
        .unwrap_or(created_at);
    let link = Arc::new(Link {
        id: id.clone(),
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
    {
        let mut links = lock(&daemon.guests.links);
        if links.len() >= MAX_LINKS {
            return Err(refusal("This computer has 20 live guest links already."));
        }
        links.insert(id.clone(), Arc::clone(&link));
    }
    tokio::spawn(watch(Arc::clone(daemon), Arc::clone(&link), after));
    daemon.relay.guests_changed.notify_one();
    info!(link = %id, %thread, can_suggest, "made a guest link");
    let fragment = format!("{host_id}.{id}.{}", remote::base64url(&secret));
    Ok(GuestCreateResult {
        link: link.view(),
        fragment,
    })
}

/// Ends link `id`, for `why`: forgets it, closes its guest's connections and relay streams, and
/// tells the relay. False when no such link was live.
pub(crate) fn end(daemon: &Daemon, id: &str, why: &str) -> bool {
    let Some(link) = daemon.guests.remove(id) else {
        return false;
    };
    link.ended.cancel();
    daemon.relay.cut_guest(id);
    daemon.relay.guests_changed.notify_one();
    info!(link = %id, why, "ended a guest link");
    true
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

#[cfg(test)]
mod tests {
    use parallax_protocol::{ParallaxEvent, RunId};

    use tokio_util::sync::CancellationToken;

    use super::{closes_with, derive, shown};

    #[tokio::test]
    async fn a_guests_connection_closes_when_its_link_ends_or_its_listener_closes() {
        let (ended, closing) = (CancellationToken::new(), CancellationToken::new());
        let connection = closes_with(&ended, &closing);
        ended.cancel();
        tokio::time::timeout(std::time::Duration::from_secs(5), connection.cancelled())
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
    fn a_guest_sees_only_its_threads_events_of_the_listed_kinds() {
        let (thread, other) = (RunId::generate(), RunId::generate());
        let wakeups = |run_id| ParallaxEvent::AgentWakeupsPaused { run_id };
        let deleted = ParallaxEvent::ThreadDeleted {
            run_id: thread,
            repo: parallax_protocol::RepoId::generate(),
        };
        let output = |run_id| ParallaxEvent::AgentOutput {
            run_id,
            items: Vec::new(),
            compacted: None,
        };
        assert!(shown(&output(thread), thread));
        assert!(!shown(&output(other), thread), "another thread's");
        assert!(!shown(&wakeups(thread), thread), "a kind off the list");
        assert!(!shown(&deleted, thread), "host-wide");
        assert!(!shown(&ParallaxEvent::Unknown, thread));
    }
}
