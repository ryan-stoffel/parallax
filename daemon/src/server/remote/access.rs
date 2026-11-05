//! Account sign-in (0091): a client signed in to this host's account gets a session without a
//! pairing code, once one of the user's devices approved its key.
//!
//! - `POST /api/auth/account`: a Clerk token, with a `DPoP` proof bound to it, only while `relay`
//!   is on. [`crate::clerk`] checks the token, that it is this host's account's, and that it is
//!   fresh by this computer's clock. An approved key gets a session as pairing gives, a removed
//!   one is refused, and any other starts a request, or finds its own, which waits for approval.
//! - `POST /api/auth/approval`: the request's next step, with a proof from the same key. The
//!   client sends its random value once, and the host answers with its own, which it committed to
//!   in its first answer, so both show the same [`remote::approval_code`] and neither picked its
//!   value after seeing the other's. Once a device approves the request (`access/approve`), the
//!   client's next call gets its session. With `wait`, a call holds for up to
//!   [`remote::APPROVAL_WAIT`] until that happens. With `allow`, the device named by the setup
//!   command approves its own request ([`Access::setup_started`]). No other client's Allow counts,
//!   since nothing it holds tells it from a client with a caught token. With `deny`, a client drops
//!   its own request.
//!
//! One request waits at a time, at most [`MAX_REQUESTS`] start an hour, and each lapses after
//! [`remote::REQUEST_LIFETIME`]. A new one doesn't replace a waiting one unless the user denies
//! it, so nobody can wear the user down with prompts. The hourly counts, setup codes' runs among
//! them, and the waiting request are kept in `host_settings.account_limits` ([`persist`]), so a
//! restart resets none of it.
//!
//! The host keeps the approved and removed client keys and the account's approved host ids, and
//! approved clients copy them between hosts (`access/merge`). A removed key is never approved
//! again, so the lists merge with no clock. A removal also goes straight to the account's other
//! online hosts, signed by this host's key and carried by the relay, which can't forge one
//! ([`remove`], [`receive_removal`]). Read-only keys (`access/setReadOnly`) are a list of their
//! own that merges the same way: nothing takes a key off, so no merge, removal, or compromised
//! host can raise a device.
//!
//! - `POST /api/auth/peer` (0101): another of the user's computers, with a `DPoP` proof from its
//!   host key and no Clerk token, only while `agentWork` is on, when the key's thumbprint is in the
//!   approved hosts and neither removed nor refused here. It gets an ordinary session named
//!   "`<name>` agents", replacing its earlier one, so Settings lists one per computer and revokes
//!   it there. plxd keeps the token in memory, and asks again after a restart.

use std::collections::{BTreeSet, VecDeque};
use std::sync::Mutex;
use std::time::Duration;

use parallax_protocol::jsonrpc::ErrorObject;
use parallax_protocol::{AccessMergeParams, AccessRequest, AccessState};
use parallax_store::Store;
use serde::{Deserialize, Serialize};
use serde_json::json;
use tokio::sync::watch;
use tokio_util::sync::CancellationToken;
use tracing::{debug, info, warn};

use super::{
    HOUR, Request, StoredSession, clean_name, host_key, host_name, lock, new_session,
    read_sessions, refused, routes, write_sessions,
};
use crate::agents::store_error;
use crate::clerk;
use crate::remote::{self, HostKey, Proven};
use crate::server::Daemon;

/// At most this many new devices' requests start an hour (0091).
pub(crate) const MAX_REQUESTS: usize = 5;

/// Who may sign in with the account, as `host_settings.account_access` keeps it.
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct Lists {
    pub approved_clients: BTreeSet<String>,
    pub removed_clients: BTreeSet<String>,
    approved_hosts: BTreeSet<String>,
    /// Those added with Allow alone, which clients take no lists from.
    #[serde(default)]
    allowed_hosts: BTreeSet<String>,
    /// The read-only keys. Any other has full access. Nothing takes a key off, a removal included.
    #[serde(default)]
    pub read_only_clients: BTreeSet<String>,
    /// The computers whose agents' session the user revoked here (0101). This host's alone, so
    /// merges leave it, and turning `agentWork` off forgets it.
    #[serde(default, skip_serializing_if = "BTreeSet::is_empty")]
    refused_peers: BTreeSet<String>,
}

impl Lists {
    /// Adds `other`'s entries. A key removed on either side ends up removed and not approved. A
    /// key read-only on either side ends up read-only, and a removal doesn't touch that list.
    fn merge(&mut self, other: Self) {
        self.approved_clients.extend(other.approved_clients);
        self.removed_clients.extend(other.removed_clients);
        self.approved_hosts.extend(other.approved_hosts);
        self.allowed_hosts.extend(other.allowed_hosts);
        self.read_only_clients.extend(other.read_only_clients);
        let removed = &self.removed_clients;
        self.approved_clients.retain(|key| !removed.contains(key));
    }
}

/// The approvals waiting, in memory, and a version that changes with them and the stored lists.
#[derive(Debug)]
pub(crate) struct Access {
    state: Mutex<State>,
    version: watch::Sender<u64>,
}

impl Default for Access {
    fn default() -> Self {
        Self {
            state: Mutex::default(),
            version: watch::Sender::new(0),
        }
    }
}

/// What waits and what counts, by this computer's clock, as [`persist`] keeps it.
#[derive(Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct State {
    /// A new device's request, while it waits.
    #[serde(default)]
    pending: Option<Pending>,
    /// When requests started, within the last hour.
    #[serde(default)]
    started: VecDeque<jiff::Timestamp>,
    /// When setup codes' SPAKE2 runs started, within the last hour.
    #[serde(default)]
    setup_runs: VecDeque<jiff::Timestamp>,
    /// The name of the device the latest setup code approved.
    #[serde(skip)]
    setup_approved: Option<String>,
    /// The device named for the waiting setup code, and when that code lapses. A setup command is
    /// the one way from a device to a new computer that the relay can't touch.
    #[serde(skip)]
    setup_device: Option<(String, jiff::Timestamp)>,
}

/// A new device's request.
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Pending {
    id: String,
    /// The `DPoP` key thumbprint it is for.
    thumbprint: String,
    name: String,
    host_value: [u8; remote::APPROVAL_VALUE_BYTES],
    /// The client's value, once it sent it. Only then does the request have a code.
    client_value: Option<[u8; remote::APPROVAL_VALUE_BYTES]>,
    expires_at: jiff::Timestamp,
    /// A device approved it, so the client's next call gets its session.
    approved: bool,
}

/// The hour [`MAX_REQUESTS`] and [`super::MAX_SETUP_RUNS`] are counted in.
fn hour() -> jiff::SignedDuration {
    jiff::SignedDuration::try_from(HOUR).unwrap_or_default()
}

/// Counts one more start in `starts` at `now`, unless `max` started within the hour.
fn count_start(starts: &mut VecDeque<jiff::Timestamp>, max: usize, now: jiff::Timestamp) -> bool {
    while starts
        .front()
        .is_some_and(|at| now.duration_since(*at) >= hour())
    {
        starts.pop_front();
    }
    if starts.len() >= max {
        return false;
    }
    starts.push_back(now);
    true
}

/// Where a request stands for the client that made it.
#[derive(Debug, PartialEq, Eq)]
enum Step {
    /// Approved: a session, named so.
    Approved(String),
    /// Still waiting, with the host's value once the client sent its own.
    Waiting(Option<[u8; remote::APPROVAL_VALUE_BYTES]>),
}

impl Access {
    /// Marks a change, for `access/get` callers waiting on one.
    fn changed(&self) {
        self.version.send_modify(|version| *version += 1);
    }

    /// The state, with a lapsed request dropped.
    fn live(&self) -> std::sync::MutexGuard<'_, State> {
        let mut state = lock(&self.state);
        if state
            .pending
            .as_ref()
            .is_some_and(|p| jiff::Timestamp::now() >= p.expires_at)
        {
            state.pending = None;
            self.changed();
        }
        state
    }

    /// Starts a request for `thumbprint`, named `name`, or finds the one it has: its id and the
    /// host's commitment.
    fn start(&self, thumbprint: &str, name: &str) -> Result<(String, String), &'static str> {
        let mut state = self.live();
        if state
            .setup_device
            .as_ref()
            .is_some_and(|(device, until)| device != thumbprint && jiff::Timestamp::now() < *until)
        {
            return Err("this computer is waiting for another of your devices");
        }
        if let Some(pending) = &state.pending {
            if pending.thumbprint != thumbprint {
                return Err("another device's request is waiting");
            }
            let commitment = remote::approval_commitment(&pending.host_value);
            return Ok((pending.id.clone(), commitment));
        }
        let now = jiff::Timestamp::now();
        if !count_start(&mut state.started, MAX_REQUESTS, now) {
            return Err("too many new devices asked this hour");
        }
        let mut host_value = [0; remote::APPROVAL_VALUE_BYTES];
        getrandom::fill(&mut host_value).map_err(|_| "no random numbers")?;
        let id = remote::random_token(16);
        let lifetime = jiff::SignedDuration::try_from(remote::REQUEST_LIFETIME).unwrap_or_default();
        state.pending = Some(Pending {
            id: id.clone(),
            thumbprint: thumbprint.to_owned(),
            name: name.to_owned(),
            host_value,
            client_value: None,
            expires_at: now + lifetime,
            approved: false,
        });
        drop(state);
        self.changed();
        Ok((id, remote::approval_commitment(&host_value)))
    }

    /// The next step of request `id` for the key `thumbprint`, taking the client's `value` the
    /// first time it comes. An approved request is used up by the step that hands out its session.
    fn step(&self, id: &str, thumbprint: &str, value: Option<&[u8]>) -> Result<Step, &'static str> {
        let mut state = self.live();
        let Some(pending) = state
            .pending
            .as_mut()
            .filter(|p| p.id == id && p.thumbprint == thumbprint)
        else {
            return Err("no such request: it lapsed, was denied, or is another key's");
        };
        let mut changed = false;
        if let Some(value) = value {
            let value: [u8; remote::APPROVAL_VALUE_BYTES] =
                value.try_into().map_err(|_| "a bad value")?;
            match pending.client_value {
                None => {
                    pending.client_value = Some(value);
                    changed = true;
                }
                Some(kept) if kept == value => {}
                // A second value would let the client pick one after seeing the host's.
                Some(_) => return Err("the request already has another value"),
            }
        }
        let step = if pending.approved {
            let name = pending.name.clone();
            state.pending = None;
            changed = true;
            Step::Approved(name)
        } else {
            Step::Waiting(pending.client_value.map(|_| pending.host_value))
        };
        drop(state);
        if changed {
            self.changed();
        }
        Ok(step)
    }

    /// Whether request `id` waits for the key `thumbprint`.
    fn owns(&self, id: &str, thumbprint: &str) -> bool {
        self.live()
            .pending
            .as_ref()
            .is_some_and(|p| p.id == id && p.thumbprint == thumbprint)
    }

    /// The key request `id` asks for, if it waits and has a code to compare.
    fn approvable(&self, id: &str) -> Result<String, &'static str> {
        let state = self.live();
        match state.pending.as_ref().filter(|p| p.id == id) {
            Some(pending) if pending.client_value.is_some() => Ok(pending.thumbprint.clone()),
            Some(_) => Err("the request has no code yet"),
            None => Err("no such request: it lapsed or was denied"),
        }
    }

    /// The name on request `id`, if `thumbprint` is the device named for the waiting setup code,
    /// and the request is that key's and has a code to compare.
    fn named_device(&self, id: &str, thumbprint: &str) -> Option<String> {
        let state = self.live();
        let (device, until) = state.setup_device.as_ref()?;
        if device != thumbprint || jiff::Timestamp::now() >= *until {
            return None;
        }
        state
            .pending
            .as_ref()
            .filter(|p| p.id == id && p.thumbprint == thumbprint && p.client_value.is_some())
            .map(|p| p.name.clone())
    }

    /// Marks the request for `thumbprint` approved, so its client's next step gets a session.
    fn mark_approved(&self, thumbprint: &str) {
        let mut state = self.live();
        if let Some(pending) = state
            .pending
            .as_mut()
            .filter(|p| p.thumbprint == thumbprint)
        {
            pending.approved = true;
        }
        drop(state);
        self.changed();
    }

    /// Drops the request waiting for a key in `removed`, approved or not, so a removed device
    /// can't take a session it was approved for before the removal.
    fn drop_removed(&self, removed: &BTreeSet<String>) {
        let mut state = self.live();
        if state
            .pending
            .as_ref()
            .is_some_and(|p| removed.contains(&p.thumbprint))
        {
            state.pending = None;
        }
    }

    /// Marks the waiting request approved if its key is in `approved`, as when another computer's
    /// Allow reaches here through `access/merge`. That key would get a session by signing in now,
    /// so this grants nothing new, and the request ends without a prompt of its own.
    fn approve_listed(&self, approved: &BTreeSet<String>) {
        if let Some(pending) = self
            .live()
            .pending
            .as_mut()
            .filter(|p| approved.contains(&p.thumbprint))
        {
            pending.approved = true;
        }
    }

    /// Counts a setup code's SPAKE2 run: false when [`super::MAX_SETUP_RUNS`] started within the
    /// hour.
    pub(super) fn setup_run(&self) -> bool {
        let counted = count_start(
            &mut lock(&self.state).setup_runs,
            super::MAX_SETUP_RUNS,
            jiff::Timestamp::now(),
        );
        if counted {
            self.changed();
        }
        counted
    }

    /// Drops the waiting request, as unlinking (`relay` off) does.
    pub(crate) fn clear(&self) {
        if lock(&self.state).pending.take().is_some() {
            self.changed();
        }
    }

    /// Drops request `id`, so another can start.
    fn deny(&self, id: &str) -> Result<(), &'static str> {
        let mut state = self.live();
        if state.pending.as_ref().is_none_or(|p| p.id != id) {
            return Err("no such request: it lapsed or was denied");
        }
        state.pending = None;
        drop(state);
        self.changed();
        Ok(())
    }

    /// Forgets which device the last setup code approved, as a new one starts, good `until`. With
    /// `device`, that key's Allow is enough until then, and another key's request is dropped and
    /// refused, so nobody with a caught token can hold the one waiting slot.
    pub(crate) fn setup_started(&self, device: Option<String>, until: jiff::Timestamp) {
        let mut state = lock(&self.state);
        state.setup_approved = None;
        if let Some(device) = &device {
            state.pending.take_if(|p| p.thumbprint != *device);
        }
        state.setup_device = device.map(|device| (device, until));
        drop(state);
        self.changed();
    }

    /// The waiting request as `access/get` shows it, with its code once it has one, and the
    /// device the setup code approved.
    fn view(&self, host_id: &str) -> (Option<AccessRequest>, Option<String>) {
        let state = self.live();
        let pending = state.pending.as_ref().map(|p| AccessRequest {
            id: p.id.clone(),
            name: p.name.clone(),
            thumbprint: p.thumbprint.clone(),
            code: p
                .client_value
                .map(|value| remote::approval_code(&p.host_value, &value, host_id, &p.thumbprint)),
            expires_at: p.expires_at.to_string(),
        });
        (pending, state.setup_approved.clone())
    }
}

/// Brings back the counts and waiting request [`persist`] kept, as the server starts.
pub(crate) async fn restore(daemon: &Daemon) {
    let kept = daemon
        .reader
        .run(&CancellationToken::new(), |db| {
            db.account_limits().map_err(|e| store_error(&e))
        })
        .await;
    let Some(state) = kept
        .ok()
        .flatten()
        .and_then(|json| serde_json::from_str::<State>(&json).ok())
    else {
        return;
    };
    *lock(&daemon.remote.access.state) = state;
    daemon.remote.access.changed();
}

/// Keeps the counts and waiting request in the store after each change, until `stop`.
pub(crate) async fn persist(daemon: std::sync::Arc<Daemon>, stop: CancellationToken) {
    let access = &daemon.remote.access;
    let mut versions = access.version.subscribe();
    let mut written = String::new();
    loop {
        versions.borrow_and_update();
        let json = serde_json::to_string(&*access.live()).unwrap_or_default();
        if json != written {
            let kept = json.clone();
            let stored = daemon
                .store
                .run(&CancellationToken::new(), move |db| {
                    db.set_account_limits(&kept).map_err(|e| store_error(&e))
                })
                .await;
            match stored {
                Ok(()) => written = json,
                Err(error) => warn!(error = %error.message, "could not keep the sign-in limits"),
            }
        }
        tokio::select! {
            changed = versions.changed() => if changed.is_err() { return },
            () = stop.cancelled() => return,
        }
    }
}

pub(super) fn read_lists(db: &Store) -> Result<Lists, ErrorObject> {
    let Some(json) = db.account_access().map_err(|e| store_error(&e))? else {
        return Ok(Lists::default());
    };
    serde_json::from_str(&json).map_err(|e| {
        ErrorObject::internal_error(format!("the account's approvals are unreadable: {e}"))
    })
}

async fn lists(daemon: &Daemon) -> Result<Lists, ErrorObject> {
    daemon
        .reader
        .run(&CancellationToken::new(), |db| read_lists(db))
        .await
}

pub(crate) async fn account(daemon: &Daemon) -> Option<String> {
    daemon
        .reader
        .run(&CancellationToken::new(), |db| {
            db.relay_account().map_err(|e| store_error(&e))
        })
        .await
        .ok()
        .flatten()
}

/// Records `user`, a Clerk user id, as the account this host registered under (0091). Only a
/// trusted caller names it, never the relay.
pub(crate) async fn record_account(daemon: &Daemon, user: &str) -> Result<(), String> {
    let owned = user.to_owned();
    daemon
        .store
        .run(&CancellationToken::new(), move |db| {
            db.set_relay_account(&owned).map_err(|e| store_error(&e))
        })
        .await
        .map_err(|e| e.message)?;
    info!(%user, "recorded this computer's account");
    daemon.remote.access.changed();
    Ok(())
}

/// Whether the account approved the computer with relay id `host_id` (0091).
pub(crate) async fn approved_host(daemon: &Daemon, host_id: &str) -> Result<bool, ErrorObject> {
    Ok(lists(daemon).await?.approved_hosts.contains(host_id))
}

/// Changes the stored lists with `change`, ends the sessions of every removed key and of each
/// computer no longer approved, and closes the connections of every key that just became read-only,
/// which reconnect read-only.
async fn update(
    daemon: &Daemon,
    cancel: &CancellationToken,
    change: impl FnOnce(&mut Lists) -> Result<(), ErrorObject> + Send + 'static,
) -> Result<Lists, ErrorObject> {
    let (lists, ended, limited) = daemon
        .store
        .run(cancel, move |db| {
            let mut lists = read_lists(db)?;
            let read_only_before = lists.read_only_clients.clone();
            change(&mut lists)?;
            let json = serde_json::to_string(&lists)
                .map_err(|e| ErrorObject::internal_error(e.to_string()))?;
            db.set_account_access(&json).map_err(|e| store_error(&e))?;
            // A removed device's session works only until its host learns of the removal.
            let mut sessions = read_sessions(db)?;
            let (ended, kept) = sessions.drain(..).partition::<Vec<_>, _>(|s| {
                lists.removed_clients.contains(&s.thumbprint)
                    || (s.peer && !lists.approved_hosts.contains(&s.thumbprint))
            });
            if !ended.is_empty() {
                write_sessions(db, &kept)?;
            }
            let limited = kept
                .into_iter()
                .filter(|s| {
                    lists.read_only_clients.contains(&s.thumbprint)
                        && !read_only_before.contains(&s.thumbprint)
                })
                .map(|s| s.id)
                .collect::<Vec<_>>();
            Ok((lists, ended, limited))
        })
        .await?;
    for session in ended {
        info!(session = %session.id, "ended a removed device's session");
        daemon.remote.revoke(&session.id);
    }
    for session in limited {
        info!(%session, "closed a session whose device became read-only");
        daemon.remote.revoke(&session);
    }
    daemon.remote.access.drop_removed(&lists.removed_clients);
    daemon.remote.access.approve_listed(&lists.approved_clients);
    daemon.remote.access.changed();
    Ok(lists)
}

/// Adds `thumbprint` to the approved clients, unless it was removed.
fn approve_key(lists: &mut Lists, thumbprint: String) -> Result<(), ErrorObject> {
    if lists.removed_clients.contains(&thumbprint) {
        return Err(ErrorObject::invalid_params(
            "That device was removed. It can start over with a new key in its Settings.",
        ));
    }
    lists.approved_clients.insert(thumbprint);
    Ok(())
}

/// `access/get`: who may sign in, and what waits. With `after`, answers once the version moves
/// from it, or `stop` ends the wait.
pub(crate) async fn state(
    daemon: &Daemon,
    after: Option<u64>,
    stop: &CancellationToken,
) -> Result<AccessState, ErrorObject> {
    let access = &daemon.remote.access;
    if let Some(after) = after {
        let mut versions = access.version.subscribe();
        while *versions.borrow_and_update() == after {
            tokio::select! {
                changed = versions.changed() => if changed.is_err() { break },
                () = stop.cancelled() => break,
            }
        }
    }
    let version = *access.version.borrow();
    let lists = lists(daemon).await?;
    let host_id = host_key(daemon)
        .await
        .map_err(|e| ErrorObject::internal_error(e.to_string()))?
        .host_id();
    let (pending, setup_approved) = access.view(&host_id);
    Ok(AccessState {
        version,
        account: account(daemon).await,
        approved_clients: lists.approved_clients.into_iter().collect(),
        removed_clients: lists.removed_clients.into_iter().collect(),
        approved_hosts: lists.approved_hosts.into_iter().collect(),
        allowed_hosts: lists.allowed_hosts.into_iter().collect(),
        read_only_clients: lists.read_only_clients.into_iter().collect(),
        pending,
        setup_approved,
    })
}

/// `access/merge`: merges another host's lists into this one's.
pub(crate) async fn merge(
    daemon: &Daemon,
    cancel: &CancellationToken,
    params: AccessMergeParams,
) -> Result<(), ErrorObject> {
    let all = [
        &params.approved_clients,
        &params.removed_clients,
        &params.approved_hosts,
        &params.allowed_hosts,
        &params.read_only_clients,
    ];
    if let Some(bad) = all.into_iter().flatten().find(|id| !remote::is_host_id(id)) {
        return Err(ErrorObject::invalid_params(format!(
            "{bad} isn't a key thumbprint or host id"
        )));
    }
    let other = Lists {
        approved_clients: params.approved_clients.into_iter().collect(),
        removed_clients: params.removed_clients.into_iter().collect(),
        approved_hosts: params.approved_hosts.into_iter().collect(),
        allowed_hosts: params.allowed_hosts.into_iter().collect(),
        read_only_clients: params.read_only_clients.into_iter().collect(),
        refused_peers: BTreeSet::new(),
    };
    update(daemon, cancel, move |lists| {
        lists.merge(other);
        Ok(())
    })
    .await?;
    Ok(())
}

/// `access/approve`: approves request `id`'s key, so its client's next step gets a session.
pub(crate) async fn approve(
    daemon: &Daemon,
    cancel: &CancellationToken,
    id: &str,
) -> Result<(), ErrorObject> {
    let access = &daemon.remote.access;
    let thumbprint = access.approvable(id).map_err(ErrorObject::invalid_params)?;
    let key = thumbprint.clone();
    update(daemon, cancel, move |lists| approve_key(lists, key)).await?;
    access.mark_approved(&thumbprint);
    info!(%thumbprint, "approved a new device");
    Ok(())
}

/// `access/deny`: drops request `id`.
pub(crate) fn deny(daemon: &Daemon, id: &str) -> Result<(), ErrorObject> {
    daemon
        .remote
        .access
        .deny(id)
        .map_err(ErrorObject::invalid_params)
}

/// `access/remove`: removes a client's key for good, ends its sessions here, and tells the
/// account's other online hosts, unless this host already knew.
pub(crate) async fn remove(
    daemon: &Daemon,
    cancel: &CancellationToken,
    thumbprint: String,
) -> Result<(), ErrorObject> {
    if !remote::is_host_id(&thumbprint) {
        return Err(ErrorObject::invalid_params("not a key thumbprint"));
    }
    info!(%thumbprint, "removed a device");
    let known = lists(daemon).await?.removed_clients.contains(&thumbprint);
    let key = thumbprint.clone();
    update(daemon, cancel, move |lists| {
        lists.removed_clients.insert(key);
        lists.merge(Lists::default());
        Ok(())
    })
    .await?;
    if !known {
        daemon.relay.tell_removed(thumbprint);
    }
    Ok(())
}

/// A removal the relay passed on from another host: applied as [`remove`] applies one, and not
/// passed on, when its signature checks out for this host's account and this host approved its
/// signer. The relay holds no approved host's key, so it can't make one, and replaying a real one
/// changes nothing. A computer added with Allow alone may be a fake one the user clicked through,
/// so it gives no removals, even with its id in `approved_hosts` too, which merges can leave.
pub(crate) async fn receive_removal(daemon: &Daemon, statement: &str) {
    let Some(account) = account(daemon).await else {
        return;
    };
    let (signer, removed) = match remote::open_removal(statement, &account) {
        Ok(opened) => opened,
        Err(why) => {
            debug!(why, "ignored a device's removal from the relay");
            return;
        }
    };
    let Ok(known) = lists(daemon).await else {
        return;
    };
    if !known.approved_hosts.contains(&signer) || known.allowed_hosts.contains(&signer) {
        debug!(%signer, "ignored a device's removal signed by a computer not approved here");
        return;
    }
    let fresh: BTreeSet<String> = removed
        .into_iter()
        .filter(|key| !known.removed_clients.contains(key))
        .collect();
    if fresh.is_empty() {
        return;
    }
    info!(%signer, count = fresh.len(), "another computer removed a device");
    let applied = update(daemon, &CancellationToken::new(), move |lists| {
        lists.removed_clients.extend(fresh);
        lists.merge(Lists::default());
        Ok(())
    })
    .await;
    if let Err(error) = applied {
        warn!(error = %error.message, "could not keep a device's removal");
    }
}

/// `access/setReadOnly`: makes session `id`'s device read-only. The mark is the key's, so signing
/// in again keeps it, and nothing takes it off.
pub(crate) async fn set_read_only(
    daemon: &Daemon,
    cancel: &CancellationToken,
    id: String,
) -> Result<(), ErrorObject> {
    let session = id.clone();
    let thumbprint = daemon
        .reader
        .run(cancel, move |db| {
            let sessions = read_sessions(db)?;
            let found = sessions.into_iter().find(|s| s.id == session);
            Ok(found.map(|s| s.thumbprint))
        })
        .await?
        .ok_or_else(|| ErrorObject::invalid_params(format!("no session is {id}")))?;
    info!(%thumbprint, "made a device read-only");
    update(daemon, cancel, move |lists| {
        lists.read_only_clients.insert(thumbprint);
        Ok(())
    })
    .await?;
    Ok(())
}

/// `access/forgetHost`: drops a computer the user removed from the approved hosts, and deletes
/// this computer's saved session for it, so setting it up again takes its code. An offline
/// computer that still lists it can copy the entry back when it next syncs (PLX-1312).
pub(crate) async fn forget_host(
    daemon: &Daemon,
    cancel: &CancellationToken,
    host_id: String,
) -> Result<(), ErrorObject> {
    if !remote::is_host_id(&host_id) {
        return Err(ErrorObject::invalid_params("not a host id"));
    }
    remote::forget_host(daemon.data_dir.root(), &host_id)
        .map_err(|error| ErrorObject::internal_error(format!("couldn't forget it: {error}")))?;
    info!(%host_id, "forgot a removed computer");
    update(daemon, cancel, move |lists| {
        lists.approved_hosts.remove(&host_id);
        lists.allowed_hosts.remove(&host_id);
        Ok(())
    })
    .await?;
    Ok(())
}

/// Approves the key that paired with a setup code, as `label` (0091), unless it was removed.
pub(super) async fn approve_by_setup(
    daemon: &Daemon,
    proven: &Proven,
    label: &str,
) -> Result<(), (u16, serde_json::Value)> {
    let key = proven.thumbprint.clone();
    let approved = update(daemon, &CancellationToken::new(), move |lists| {
        approve_key(lists, key)
    })
    .await;
    if let Err(error) = approved {
        return Err(removed(&error.message));
    }
    let access = &daemon.remote.access;
    access.mark_approved(&proven.thumbprint);
    lock(&access.state).setup_approved = Some(clean_name(label));
    access.changed();
    info!(thumbprint = %proven.thumbprint, "a setup code approved a new device");
    Ok(())
}

pub(super) fn removed(why: &str) -> (u16, serde_json::Value) {
    (
        403,
        json!({ "error": "access_denied", "error_description": why }),
    )
}

fn limited(why: &str) -> (u16, serde_json::Value) {
    (
        429,
        json!({ "error": "slow_down", "error_description": why }),
    )
}

/// A new session for `proven`'s key, named `label`, as pairing answers with it.
async fn session(daemon: &Daemon, proven: &Proven, label: &str) -> (u16, serde_json::Value) {
    let token = match new_session(daemon, proven, label, false).await {
        Ok(token) => token,
        Err(refusal) => return refusal,
    };
    (
        200,
        json!({
            "accessToken": token,
            "tokenType": "DPoP",
            "name": host_name(daemon).await,
            "routes": routes(daemon).await,
        }),
    )
}

/// `POST /api/auth/account`: a Clerk token from a client signed in to this host's account.
pub(super) async fn sign_in(
    daemon: &Daemon,
    _: &HostKey,
    request: &Request,
) -> (u16, serde_json::Value) {
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct SignIn {
        token: String,
        #[serde(default)]
        client_label: String,
    }
    let Ok(body) = serde_json::from_slice::<SignIn>(&request.body) else {
        return (400, json!({ "error": "invalid_request" }));
    };
    // Unlinking (`relay` off) stops new account sign-ins; sessions already issued stay.
    if !crate::relay::wanted(daemon).await {
        return removed("Reach from anywhere is off on this computer");
    }
    let proven = match request.proof(Some(&body.token)) {
        Ok(proven) => proven,
        Err(why) => return refused(why),
    };
    let Some(account) = account(daemon).await else {
        return removed("this computer isn't signed in to an account");
    };
    let offset = daemon.relay.clock_offset_ms();
    if Duration::from_millis(offset.unsigned_abs()) > clerk::CLOCK_SKEW {
        warn!(
            seconds = offset / 1000,
            "refused an account sign-in: this computer's clock is off from the relay's"
        );
        return refused("this computer's clock is off; set it to the right time");
    }
    let now = clerk::now();
    let verified = match daemon.clerk.verify(&body.token, now).await {
        Ok(verified) => verified,
        Err(why) => return refused(why),
    };
    if let Err(why) = clerk::check_sign_in(&verified, &account, now) {
        return refused(why);
    }
    // Only a good token gets its proof remembered, so strangers can't grow the map.
    if !daemon.remote.first_use(&proven) {
        return refused("a replayed DPoP proof");
    }
    let Ok(lists) = lists(daemon).await else {
        return (500, json!({ "error": "server_error" }));
    };
    if lists.removed_clients.contains(&proven.thumbprint) {
        return removed(remote::DEVICE_REMOVED);
    }
    if lists.approved_clients.contains(&proven.thumbprint) {
        info!(name = %clean_name(&body.client_label), "an approved device signed in");
        return session(daemon, &proven, &body.client_label).await;
    }
    let name = clean_name(&body.client_label);
    match daemon.remote.access.start(&proven.thumbprint, &name) {
        Ok((id, commitment)) => {
            info!(%name, "a new device asks to be approved");
            (
                202,
                json!({ "status": "pending", "request": id, "commitment": commitment }),
            )
        }
        Err(why) => limited(why),
    }
}

/// Why a computer with key `thumbprint` gets no session for its agents here now, if it doesn't:
/// the words its agent reads.
fn peer_refusal(db: &Store, thumbprint: &str) -> Result<Option<&'static str>, ErrorObject> {
    if !db.agent_work().map_err(|e| store_error(&e))? {
        return Ok(Some(
            "it has \"Let agents on my other computers work here\" off",
        ));
    }
    let lists = read_lists(db)?;
    Ok(if lists.removed_clients.contains(thumbprint) {
        Some("it removed this computer")
    } else if lists.refused_peers.contains(thumbprint) {
        Some("its user revoked this computer's agents there")
    } else if lists.approved_hosts.contains(thumbprint) {
        None
    } else {
        Some("it hasn't approved this computer")
    })
}

/// `POST /api/auth/peer`: see the module documentation. Everything is checked again in the write
/// that keeps the session, so a change of `agentWork` or the lists can't land in between.
pub(super) async fn peer(daemon: &Daemon, request: &Request) -> (u16, serde_json::Value) {
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Peer {
        #[serde(default)]
        client_label: String,
    }
    let Ok(body) = serde_json::from_slice::<Peer>(&request.body) else {
        return (400, json!({ "error": "invalid_request" }));
    };
    let proven = match request.proof(None) {
        Ok(proven) => proven,
        Err(why) => return refused(why),
    };
    let key = proven.thumbprint.clone();
    let checked = daemon
        .reader
        .run(&CancellationToken::new(), move |db| peer_refusal(db, &key))
        .await;
    match checked {
        Ok(None) => {}
        Ok(Some(why)) => return removed(why),
        Err(_) => return (500, json!({ "error": "server_error" })),
    }
    // Only a computer that passed gets its proof remembered, so strangers can't grow the map.
    if !daemon.remote.first_use(&proven) {
        return refused("a replayed DPoP proof");
    }
    let token = remote::random_token(32);
    let session = StoredSession {
        id: uuid::Uuid::new_v4().to_string(),
        name: clean_name(&format!("{} agents", clean_name(&body.client_label))),
        token_hash: remote::hex(&remote::sha256(token.as_bytes())),
        thumbprint: proven.thumbprint.clone(),
        created_at: jiff::Timestamp::now().to_string(),
        browser: false,
        peer: true,
    };
    let name = session.name.clone();
    let stored = daemon
        .store
        .run(&CancellationToken::new(), move |db| {
            if let Some(why) = peer_refusal(db, &session.thumbprint)? {
                return Ok(Err(why));
            }
            let mut sessions = read_sessions(db)?;
            let replaced: Vec<String> = sessions
                .iter()
                .filter(|s| s.peer && s.thumbprint == session.thumbprint)
                .map(|s| s.id.clone())
                .collect();
            sessions.retain(|s| !replaced.contains(&s.id));
            sessions.push(session);
            write_sessions(db, &sessions)?;
            Ok(Ok(replaced))
        })
        .await;
    match stored {
        Ok(Ok(replaced)) => {
            for id in replaced {
                daemon.remote.revoke(&id);
            }
            info!(%name, "another computer's agents got a session");
            (
                200,
                json!({
                    "accessToken": token,
                    "tokenType": "DPoP",
                    "name": host_name(daemon).await,
                }),
            )
        }
        Ok(Err(why)) => removed(why),
        Err(error) => {
            warn!(error = %error.message, "could not keep a computer's session");
            (500, json!({ "error": "server_error" }))
        }
    }
}

/// Refuses the computer with key `thumbprint` here until `agentWork` turns off (0101).
pub(super) fn refuse_peer(db: &Store, thumbprint: &str) -> Result<(), ErrorObject> {
    let mut lists = read_lists(db)?;
    lists.refused_peers.insert(thumbprint.to_owned());
    let json =
        serde_json::to_string(&lists).map_err(|e| ErrorObject::internal_error(e.to_string()))?;
    db.set_account_access(&json).map_err(|e| store_error(&e))
}

/// Ends every session other computers' agents have here, and forgets which were refused, as
/// `agentWork` turns off (0101).
pub(crate) async fn close_peers(daemon: &Daemon) {
    let closed = daemon
        .store
        .run(&CancellationToken::new(), |db| {
            let mut sessions = read_sessions(db)?;
            let (closed, kept) = sessions.drain(..).partition::<Vec<_>, _>(|s| s.peer);
            write_sessions(db, &kept)?;
            let mut lists = read_lists(db)?;
            lists.refused_peers.clear();
            let json = serde_json::to_string(&lists)
                .map_err(|e| ErrorObject::internal_error(e.to_string()))?;
            db.set_account_access(&json).map_err(|e| store_error(&e))?;
            Ok(closed)
        })
        .await;
    match closed {
        Ok(closed) => {
            for session in closed {
                info!(session = %session.id, "ended a computer's agents' session");
                daemon.remote.revoke(&session.id);
            }
        }
        Err(error) => warn!(error = %error.message, "could not end computers' sessions"),
    }
}

/// `POST /api/auth/approval`: the next step of a new device's request, from the key it is for.
pub(super) async fn approval(
    daemon: &Daemon,
    _: &HostKey,
    request: &Request,
) -> (u16, serde_json::Value) {
    #[derive(Deserialize)]
    struct Approval {
        request: String,
        value: Option<String>,
        #[serde(default)]
        wait: bool,
        /// The user clicked Allow on this client.
        #[serde(default)]
        allow: bool,
        /// The user clicked Deny on this client.
        #[serde(default)]
        deny: bool,
    }
    let Ok(body) = serde_json::from_slice::<Approval>(&request.body) else {
        return (400, json!({ "error": "invalid_request" }));
    };
    let value = match body.value.as_deref().map(remote::base64url_decode) {
        Some(None) => return (400, json!({ "error": "invalid_request" })),
        Some(Some(value)) => Some(value),
        None => None,
    };
    // Unlinking stops account sign-ins, a request already waiting included.
    if !crate::relay::wanted(daemon).await {
        daemon.remote.access.clear();
        return removed("Reach from anywhere is off on this computer");
    }
    let proven = match request.proof(None) {
        Ok(proven) => proven,
        Err(why) => return refused(why),
    };
    let access = &daemon.remote.access;
    // Only the request's own key gets its proof remembered, so strangers can't grow the map, and
    // a replayed proof changes nothing.
    if !access.owns(&body.request, &proven.thumbprint) {
        return refused("no such request: it lapsed, was denied, or is another key's");
    }
    if !daemon.remote.first_use(&proven) {
        return refused("a replayed DPoP proof");
    }
    if body.deny {
        return match access.deny(&body.request) {
            Ok(()) => (200, json!({ "status": "denied" })),
            Err(why) => refused(why),
        };
    }
    let deadline = tokio::time::Instant::now() + remote::APPROVAL_WAIT;
    let mut versions = access.version.subscribe();
    let mut value = value.as_deref();
    let mut allow = body.allow;
    let mut needs_host = false;
    loop {
        versions.borrow_and_update();
        let step = match access.step(&body.request, &proven.thumbprint, value.take()) {
            Ok(step) => step,
            Err(why) => return refused(why),
        };
        let host_value = match step {
            Step::Approved(name) => return session(daemon, &proven, &name).await,
            Step::Waiting(host_value) => host_value,
        };
        if std::mem::take(&mut allow) {
            if let Some(name) = access.named_device(&body.request, &proven.thumbprint) {
                if let Err(refusal) = approve_by_setup(daemon, &proven, &name).await {
                    return refusal;
                }
                continue;
            }
            // Allow alone proves nothing from any other key: this computer must confirm too.
            needs_host = true;
        }
        let waited = body.wait
            && tokio::time::timeout_at(deadline, versions.changed())
                .await
                .is_ok_and(|changed| changed.is_ok());
        if !waited {
            return (
                202,
                json!({
                    "status": "pending",
                    "value": host_value.map(|v| remote::base64url(&v)),
                    "needsHost": needs_host,
                }),
            );
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const KEY: &str = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
    const OTHER: &str = "BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";

    #[test]
    fn a_waiting_request_takes_one_value_and_is_never_replaced_unless_denied() {
        let access = Access::default();
        let (id, commitment) = access.start(KEY, "phone").unwrap();
        assert_eq!(
            access.start(KEY, "phone").unwrap(),
            (id.clone(), commitment.clone())
        );
        assert_eq!(
            access.start(OTHER, "laptop"),
            Err("another device's request is waiting")
        );
        // No code to approve until the client sends its value.
        assert!(access.approvable(&id).is_err());
        assert_eq!(access.step(&id, KEY, None), Ok(Step::Waiting(None)));
        assert!(access.step(&id, OTHER, None).is_err(), "another key's");

        let value = [7; remote::APPROVAL_VALUE_BYTES];
        let Ok(Step::Waiting(Some(host_value))) = access.step(&id, KEY, Some(&value)) else {
            panic!("the host reveals its value");
        };
        assert_eq!(remote::approval_commitment(&host_value), commitment);
        assert_eq!(
            access.step(&id, KEY, Some(&[8; remote::APPROVAL_VALUE_BYTES])),
            Err("the request already has another value")
        );
        let (pending, _) = access.view("host");
        let code = remote::approval_code(&host_value, &value, "host", KEY);
        assert_eq!(pending.unwrap().code.as_deref(), Some(code.as_str()));

        assert_eq!(access.approvable(&id).as_deref(), Ok(KEY));
        access.mark_approved(KEY);
        assert_eq!(
            access.step(&id, KEY, None),
            Ok(Step::Approved("phone".to_owned()))
        );
        assert!(access.step(&id, KEY, None).is_err(), "used up");

        let (denied, _) = access.start(OTHER, "laptop").unwrap();
        access.deny(&denied).unwrap();
        assert!(
            access.start(KEY, "phone").is_ok(),
            "a denial frees the slot"
        );
    }

    #[test]
    fn a_named_device_alone_can_ask_and_allow_while_its_setup_code_lasts() {
        let access = Access::default();
        let (other, _) = access.start(OTHER, "laptop").unwrap();
        let later = jiff::Timestamp::now() + jiff::SignedDuration::from_mins(10);
        access.setup_started(Some(KEY.to_owned()), later);
        assert!(access.step(&other, OTHER, None).is_err(), "dropped");
        assert_eq!(
            access.start(OTHER, "laptop"),
            Err("this computer is waiting for another of your devices"),
            "a caught token can't hold the slot"
        );
        let (id, _) = access.start(KEY, "phone").unwrap();
        assert_eq!(access.named_device(&id, KEY), None, "no code yet");
        let value = [7; remote::APPROVAL_VALUE_BYTES];
        access.step(&id, KEY, Some(&value)).unwrap();
        assert_eq!(access.named_device(&id, KEY).as_deref(), Some("phone"));
        assert_eq!(access.named_device(&id, OTHER), None);

        // Past the code's life, or with a bare command, nobody's Allow counts.
        access.setup_started(Some(KEY.to_owned()), jiff::Timestamp::now());
        assert_eq!(access.named_device(&id, KEY), None);
        access.setup_started(None, later);
        assert_eq!(access.named_device(&id, KEY), None);
        assert!(access.start(OTHER, "laptop").is_err(), "KEY's still waits");
    }

    #[test]
    fn at_most_five_requests_start_an_hour() {
        let access = Access::default();
        for _ in 0..MAX_REQUESTS {
            let (id, _) = access.start(KEY, "phone").unwrap();
            access.deny(&id).unwrap();
        }
        assert_eq!(
            access.start(KEY, "phone"),
            Err("too many new devices asked this hour")
        );
    }

    #[test]
    fn removal_wins_a_merge_from_either_side() {
        let mut here = Lists::default();
        here.approved_clients.insert(KEY.to_owned());
        let mut there = Lists::default();
        there.removed_clients.insert(KEY.to_owned());
        there.approved_clients.insert(OTHER.to_owned());
        there.approved_hosts.insert(OTHER.to_owned());
        here.merge(there);
        assert!(!here.approved_clients.contains(KEY));
        assert!(here.approved_clients.contains(OTHER));
        assert!(here.approved_hosts.contains(OTHER));
        assert!(approve_key(&mut here, KEY.to_owned()).is_err());

        let mut back = Lists::default();
        back.approved_clients.insert(KEY.to_owned());
        let mut removed = Lists::default();
        removed.removed_clients.insert(KEY.to_owned());
        back.merge(removed);
        assert!(back.approved_clients.is_empty(), "the other way round too");
    }

    #[test]
    fn no_merge_raises_a_read_only_key_from_either_side() {
        let mut limited = Lists::default();
        limited.read_only_clients.insert(KEY.to_owned());
        // A host that never heard of the mark, or one that wants it gone, lists it as approved at
        // most. It has no way to say otherwise.
        let mut other = Lists::default();
        other.approved_clients.insert(KEY.to_owned());

        let mut here = limited.clone();
        here.merge(other.clone());
        assert!(here.read_only_clients.contains(KEY), "merged into it");
        let mut there = other;
        there.merge(limited);
        assert!(there.read_only_clients.contains(KEY), "it spreads too");
    }

    #[test]
    fn a_removal_and_a_read_only_mark_clear_neither_the_other_from_either_side() {
        let mut marked = Lists::default();
        marked.read_only_clients.insert(KEY.to_owned());
        let mut removed = Lists::default();
        removed.removed_clients.insert(KEY.to_owned());
        for (mut here, there) in [(marked.clone(), removed.clone()), (removed, marked)] {
            here.merge(there);
            assert!(here.read_only_clients.contains(KEY));
            assert!(here.removed_clients.contains(KEY));
        }
    }

    #[test]
    fn stored_lists_from_before_read_only_devices_still_read() {
        let old = r#"{"approvedClients":["k"],"removedClients":[],"approvedHosts":[]}"#;
        let lists: Lists = serde_json::from_str(old).unwrap();
        assert!(lists.read_only_clients.is_empty());
    }
}
