//! Claude Remote Control threads (PLX-1140): the sessions `claude remote-control` serves on the
//! user's computers, which plxd follows as threads ([`crate::backend::claude::remote`]).
//!
//! [`run`] lists them through Claude Code's sign-in ([`cloud`]) at startup and every
//! [`SYNC_EVERY`], or [`SYNC_IDLE`] after a listing that found none, and imports, not archived,
//! each that was active in the last [`RECENT`], has a conversation on `claude.ai`, and wasn't
//! imported before: in its repository's checkout when one is registered here, never cloning one
//! nobody asked for. A session whose transcript is on this computer too, as one
//! `claude remote-control` serves here, is left to Import sessions, as are older ones. Every
//! import of a session, by hand or by the sync, is kept in `host_settings` ([`remember`]), so a
//! thread the user archived or deleted never comes back. Listing reads no transcript once every
//! recent session was taken, a whole pass is bounded by [`SYNC_LIMIT`], and it stays silent
//! while Claude Code isn't set up or signed in.
//!
//! The last listing is kept, with what each run following a session last reported of it
//! ([`crate::backend::Event::RemoteControl`]), for `thread/remoteControl`, which answers from them
//! and lists again in the background once they're [`STALE`].

use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, PoisonError};
use std::time::Duration;

use jiff::{SignedDuration, Timestamp};
use parallax_protocol::jsonrpc::ErrorObject;
use parallax_protocol::{
    RemoteControlSession, RemoteControlState, ThreadRemoteControlOriginParams,
    ThreadRemoteControlOriginResult, ThreadRemoteControlParams, ThreadRemoteControlResult,
};
use tokio::time::Instant;
use tokio_util::sync::CancellationToken;
use tracing::{debug, info, warn};

use crate::agents::convert::{RUNNING, STARTING};
use crate::backend::claude::remote::{is_session, url};
use crate::importer::cloud::{self, Conversation, Listed};
use crate::server::Daemon;
use crate::threads::{store, store_error};

/// How often plxd lists the sessions to import new ones.
const SYNC_EVERY: Duration = Duration::from_mins(3);

/// How often it lists them after a listing that found no Remote Control session, so a user who
/// doesn't use Remote Control starts `claude -p` rarely.
const SYNC_IDLE: Duration = Duration::from_mins(30);

/// How long one pass of the sync may take in all, imports included.
const SYNC_LIMIT: Duration = Duration::from_mins(10);

/// How long after startup the first listing waits, so it doesn't slow plxd's start.
const FIRST_SYNC: Duration = Duration::from_secs(10);

/// How recently a session was active for the sync to import it.
const RECENT: SignedDuration = SignedDuration::from_hours(7 * 24);

/// How old the last listing may be before `thread/remoteControl` lists again.
const STALE: Duration = Duration::from_secs(30);

/// How long one listing may take.
const LIMIT: Duration = Duration::from_secs(60);

/// What plxd knows of the user's Claude Remote Control sessions.
#[derive(Debug, Default)]
pub(crate) struct RemoteControl {
    known: Mutex<Known>,
    /// Set while `thread/remoteControl` lists them again in the background, so those don't pile
    /// up. The sync takes no lock: a listing of its own beside one costs only a second process.
    refreshing: AtomicBool,
}

#[derive(Debug, Default)]
struct Known {
    /// The last listing, by session id.
    listed: HashMap<String, Listed>,
    /// When it was read.
    at: Option<Instant>,
    /// What each session's run last reported, by session id.
    live: HashMap<String, RemoteControlState>,
    /// The sessions the sync left out, with no conversation on `claude.ai` or with their
    /// transcript on this computer too, with when they last changed then, so they're checked
    /// again only once they change.
    skipped: HashMap<String, Option<Timestamp>>,
}

impl RemoteControl {
    fn known(&self) -> std::sync::MutexGuard<'_, Known> {
        self.known.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// Keeps `state`, which the run following session `session_id` reported.
    pub(crate) fn saw(&self, session_id: &str, state: RemoteControlState) {
        self.known().live.insert(session_id.to_owned(), state);
    }

    fn keep(&self, listed: Vec<Listed>) {
        let mut known = self.known();
        known.listed = listed.into_iter().map(|s| (s.id.clone(), s)).collect();
        known.at = Some(Instant::now());
    }
}

/// Lists the sessions at startup, then every [`SYNC_EVERY`] while there are some and every
/// [`SYNC_IDLE`] while there are none, importing new ones, until `stop`.
pub(crate) async fn run(daemon: Arc<Daemon>, stop: CancellationToken) {
    let mut next = Instant::now() + FIRST_SYNC;
    loop {
        tokio::select! {
            () = stop.cancelled() => return,
            () = tokio::time::sleep_until(next) => {}
        }
        // A pass waiting on Claude Code ends with plxd, rather than holding up its shutdown.
        let found = tokio::select! {
            () = stop.cancelled() => return,
            found = tokio::time::timeout(SYNC_LIMIT, sync(&daemon)) => found.unwrap_or_else(|_| {
                warn!("syncing Claude Remote Control sessions took too long");
                true
            }),
        };
        next = Instant::now() + if found { SYNC_EVERY } else { SYNC_IDLE };
    }
}

/// Lists the sessions and imports the recent ones not imported before. Returns whether it found
/// any Remote Control session.
async fn sync(daemon: &Arc<Daemon>) -> bool {
    let mut control = match cloud::start(daemon).await {
        Ok(control) => control,
        Err(error) => {
            debug!(%error, "not syncing Claude Remote Control sessions");
            return false;
        }
    };
    let listed = match cloud::listed(&mut control, false).await {
        Ok(listed) => listed,
        Err(error) => {
            debug!(%error, "could not list Claude Remote Control sessions");
            return false;
        }
    };
    let found = !listed.is_empty();
    daemon.remote_control.keep(listed.clone());
    let synced = match synced(daemon).await {
        Ok(synced) => synced,
        Err(error) => {
            warn!(error = %error.message, "could not read the synced Claude Remote Control sessions");
            return found;
        }
    };
    let wanted: Vec<Listed> = {
        let known = daemon.remote_control.known();
        to_import(&listed, &synced, &known.skipped, Timestamp::now())
            .into_iter()
            .cloned()
            .collect()
    };
    if wanted.is_empty() {
        return found;
    }
    let here = match crate::importer::claude_here().await {
        Ok(here) => here,
        Err(error) => {
            warn!(error = %error.message, "could not read this computer's Claude Code sessions");
            return found;
        }
    };
    let ids: Vec<String> = wanted.iter().map(|s| s.id.clone()).collect();
    let conversations = cloud::conversations(&mut control, &ids).await;
    drop(control);
    for (session, conversation) in wanted.into_iter().zip(conversations) {
        if !imports(&conversation, &here) {
            let mut known = daemon.remote_control.known();
            known.skipped.insert(session.id, session.updated);
            continue;
        }
        match crate::importer::import_remote(Arc::clone(daemon), &session.id, None, true).await {
            Ok(_) => info!(session = %session.id, "imported a Claude Remote Control session"),
            Err(error) => {
                warn!(session = %session.id, error = %error.message, "could not import a Claude Remote Control session");
            }
        }
    }
    found
}

/// Whether the sync imports a session that holds `conversation`: one with a conversation whose
/// transcript isn't among `here`, this computer's Claude Code sessions, as Import sessions lists
/// it.
fn imports(conversation: &Conversation, here: &HashSet<String>) -> bool {
    match conversation {
        Conversation::None => false,
        Conversation::Some { local } => !local.as_ref().is_some_and(|id| here.contains(id)),
    }
}

/// The sessions of `listed` to import at `now`: active in the last [`RECENT`], not archived, not
/// in `synced`, and not in `skipped` as of their last change.
fn to_import<'a>(
    listed: &'a [Listed],
    synced: &HashSet<String>,
    skipped: &HashMap<String, Option<Timestamp>>,
    now: Timestamp,
) -> Vec<&'a Listed> {
    let since = now - RECENT;
    listed
        .iter()
        .filter(|s| s.updated.is_some_and(|at| at >= since))
        .filter(|s| s.status.as_deref() != Some("archived"))
        .filter(|s| !synced.contains(&s.id))
        .filter(|s| skipped.get(&s.id) != Some(&s.updated))
        .collect()
}

/// The sessions imported before, by hand or by the sync.
async fn synced(daemon: &Daemon) -> Result<HashSet<String>, ErrorObject> {
    store(daemon, |db| {
        let json = db.remote_control_synced().map_err(|e| store_error(&e))?;
        Ok(json
            .and_then(|json| serde_json::from_str::<HashSet<String>>(&json).ok())
            .unwrap_or_default())
    })
    .await
}

/// Keeps Claude Remote Control session `id` as imported, which the sync never imports again.
///
/// # Errors
///
/// When the store can't keep it.
pub(crate) async fn remember(daemon: &Daemon, id: String) -> Result<(), ErrorObject> {
    store(daemon, move |db| {
        let json = db.remote_control_synced().map_err(|e| store_error(&e))?;
        let mut taken: Vec<String> = json
            .and_then(|json| serde_json::from_str(&json).ok())
            .unwrap_or_default();
        if !taken.contains(&id) {
            taken.push(id);
        }
        let json = serde_json::to_string(&taken)
            .map_err(|e| ErrorObject::internal_error(e.to_string()))?;
        db.set_remote_control_synced(&json)
            .map_err(|e| store_error(&e))
    })
    .await
}

/// Lists the sessions again, unless a refresh runs now, without importing.
async fn refresh(daemon: Arc<Daemon>) {
    let refreshing = &daemon.remote_control.refreshing;
    if refreshing.swap(true, Ordering::AcqRel) {
        return;
    }
    // Cleared however this ends.
    let _done = Refreshing(refreshing);
    let listed = tokio::time::timeout(LIMIT, async {
        let mut control = cloud::start(&daemon).await?;
        cloud::listed(&mut control, false).await
    })
    .await;
    match listed {
        Ok(Ok(listed)) => daemon.remote_control.keep(listed),
        Ok(Err(error)) => debug!(%error, "could not list Claude Remote Control sessions"),
        Err(_) => {}
    }
}

/// Clears [`RemoteControl::refreshing`] when dropped.
struct Refreshing<'a>(&'a AtomicBool);

impl Drop for Refreshing<'_> {
    fn drop(&mut self) {
        self.0.store(false, Ordering::Release);
    }
}

/// `thread/remoteControl`: see [`ThreadRemoteControlResult`].
pub(crate) async fn session(
    daemon: &Arc<Daemon>,
    params: ThreadRemoteControlParams,
) -> Result<ThreadRemoteControlResult, ErrorObject> {
    let id = params.run_id;
    let row = store(daemon, move |db| {
        db.get_run(id.into()).map_err(|e| store_error(&e))
    })
    .await?;
    let Some(row) = row else {
        return Err(ErrorObject::invalid_params(format!("no run {id}")));
    };
    let Some(session_id) = row.state.session_id.filter(|id| is_session(id)) else {
        return Ok(ThreadRemoteControlResult { session: None });
    };
    let running = [RUNNING, STARTING].contains(&row.state.status.as_str());
    let (listed, reported, old) = {
        let known = daemon.remote_control.known();
        (
            known.listed.get(&session_id).cloned(),
            known.live.get(&session_id).copied(),
            known.at.is_none_or(|at| at.elapsed() >= STALE),
        )
    };
    if old {
        tokio::spawn(refresh(Arc::clone(daemon)));
    }
    let state = match (running, reported, &listed) {
        (true, Some(reported), _) => Some(reported),
        (true, None, _) => Some(RemoteControlState::Running),
        (false, _, Some(listed)) => Some(listed_state(listed.status.as_deref())),
        (false, _, None) => None,
    };
    Ok(ThreadRemoteControlResult {
        session: Some(RemoteControlSession {
            url: url(&session_id),
            repository: listed.as_ref().and_then(|s| s.repository.clone()),
            branch: listed.and_then(|s| s.branch),
            session_id,
            state,
        }),
    })
}

/// `thread/remoteControlOrigin`: see [`ThreadRemoteControlOriginResult`].
pub(crate) async fn origin(
    daemon: &Arc<Daemon>,
    params: ThreadRemoteControlOriginParams,
) -> Result<ThreadRemoteControlOriginResult, ErrorObject> {
    let id = params.run_id;
    let row = store(daemon, move |db| {
        db.get_run(id.into()).map_err(|e| store_error(&e))
    })
    .await?;
    let Some(row) = row else {
        return Err(ErrorObject::invalid_params(format!("no run {id}")));
    };
    let Some(session_id) = row.state.session_id.filter(|id| is_session(id)) else {
        return Ok(ThreadRemoteControlOriginResult { origin: None });
    };
    let origin = cloud::origin(daemon, &session_id)
        .await
        .map_err(ErrorObject::internal_error)?;
    Ok(ThreadRemoteControlOriginResult {
        origin: Some(origin),
    })
}

/// A session's state from its listed `status`, with no run following it.
fn listed_state(status: Option<&str>) -> RemoteControlState {
    match status {
        Some("running" | "pending") => RemoteControlState::Running,
        Some("requires_action") => RemoteControlState::Waiting,
        Some("archived") => RemoteControlState::Archived,
        _ => RemoteControlState::Idle,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn listed(id: &str, updated: &str, status: Option<&str>) -> Listed {
        Listed {
            id: id.to_owned(),
            title: None,
            updated: Some(updated.parse().unwrap()),
            status: status.map(str::to_owned),
            repository: None,
            branch: None,
        }
    }

    #[test]
    fn the_sync_imports_recent_sessions_it_never_took() {
        let now: Timestamp = "2026-10-29T12:00:00Z".parse().unwrap();
        let sessions = [
            listed("session_new", "2026-10-29T11:00:00Z", Some("idle")),
            listed("session_week", "2026-10-22T12:00:00Z", None),
            listed("session_old", "2026-10-21T11:59:00Z", Some("idle")),
            listed("session_archived", "2026-10-29T11:00:00Z", Some("archived")),
            listed("session_taken", "2026-10-29T11:00:00Z", Some("running")),
            listed("session_empty", "2026-10-29T10:00:00Z", Some("idle")),
            listed("session_changed", "2026-10-29T10:30:00Z", Some("idle")),
        ];
        let synced = HashSet::from(["session_taken".to_owned()]);
        let skipped = HashMap::from([
            ("session_empty".to_owned(), sessions[5].updated),
            ("session_changed".to_owned(), sessions[5].updated),
        ]);
        let ids: Vec<&str> = to_import(&sessions, &synced, &skipped, now)
            .iter()
            .map(|s| s.id.as_str())
            .collect();
        assert_eq!(ids, ["session_new", "session_week", "session_changed"]);
    }

    #[test]
    fn the_sync_leaves_out_a_session_with_no_conversation_or_one_whose_transcript_is_here() {
        let here = HashSet::from(["5c5f05dc".to_owned()]);
        let some = |local: Option<&str>| Conversation::Some {
            local: local.map(str::to_owned),
        };
        assert!(!imports(&Conversation::None, &here));
        assert!(!imports(&some(Some("5c5f05dc")), &here));
        assert!(imports(&some(Some("e67d791e")), &here));
        assert!(imports(&some(None), &here));
    }

    #[tokio::test]
    async fn every_import_is_remembered_once_so_the_sync_never_brings_it_back() {
        let dir = tempfile::tempdir().unwrap();
        let daemon = Daemon::for_tests(dir.path(), 10, Duration::from_secs(90));
        assert!(synced(&daemon).await.unwrap().is_empty());
        remember(&daemon, "session_hand".into()).await.unwrap();
        remember(&daemon, "session_hand".into()).await.unwrap();
        remember(&daemon, "session_sync".into()).await.unwrap();
        let synced = synced(&daemon).await.unwrap();
        assert_eq!(
            synced,
            HashSet::from(["session_hand".to_owned(), "session_sync".to_owned()])
        );
        let now: Timestamp = "2026-10-29T12:00:00Z".parse().unwrap();
        let listed = [listed("session_hand", "2026-10-29T11:00:00Z", Some("idle"))];
        assert!(to_import(&listed, &synced, &HashMap::new(), now).is_empty());
    }

    #[test]
    fn a_session_with_no_run_following_it_shows_its_listed_status() {
        assert_eq!(listed_state(Some("running")), RemoteControlState::Running);
        assert_eq!(
            listed_state(Some("requires_action")),
            RemoteControlState::Waiting
        );
        assert_eq!(listed_state(Some("archived")), RemoteControlState::Archived);
        assert_eq!(listed_state(Some("failed")), RemoteControlState::Idle);
        assert_eq!(listed_state(None), RemoteControlState::Idle);
    }
}
