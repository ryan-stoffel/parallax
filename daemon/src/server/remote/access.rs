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
//!   [`remote::APPROVAL_WAIT`] until that happens.
//!
//! One request waits at a time, at most [`MAX_REQUESTS`] start an hour, and each lapses after
//! [`remote::REQUEST_LIFETIME`]. A new one doesn't replace a waiting one unless the user denies
//! it, so nobody can wear the user down with prompts.
//!
//! The host keeps the approved and removed client keys and the account's approved host ids, and
//! approved clients copy them between hosts (`access/merge`). A removed key is never approved
//! again, so the lists merge with no clock.

use std::collections::{BTreeSet, VecDeque};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use parallax_protocol::jsonrpc::ErrorObject;
use parallax_protocol::{AccessMergeParams, AccessRequest, AccessState};
use parallax_store::Store;
use serde::{Deserialize, Serialize};
use serde_json::json;
use tokio::sync::watch;
use tokio_util::sync::CancellationToken;
use tracing::{info, warn};

use super::{
    HOUR, Request, clean_name, host_key, host_name, lock, new_session, read_sessions, refused,
    routes, write_sessions,
};
use crate::agents::store_error;
use crate::clerk;
use crate::remote::{self, HostKey, Proven};
use crate::server::Daemon;

/// At most this many new devices' requests start an hour (0091).
pub(crate) const MAX_REQUESTS: usize = 5;

/// Who may sign in with the account, as `host_settings.account_access` keeps it.
#[derive(Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Lists {
    approved_clients: BTreeSet<String>,
    removed_clients: BTreeSet<String>,
    approved_hosts: BTreeSet<String>,
}

impl Lists {
    /// Adds `other`'s entries. A key removed on either side ends up removed and not approved.
    fn merge(&mut self, other: Self) {
        self.approved_clients.extend(other.approved_clients);
        self.removed_clients.extend(other.removed_clients);
        self.approved_hosts.extend(other.approved_hosts);
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

#[derive(Debug, Default)]
struct State {
    /// A new device's request, while it waits.
    pending: Option<Pending>,
    /// When requests started, within the last hour.
    started: VecDeque<Instant>,
    /// The name of the device the latest setup code approved.
    setup_approved: Option<String>,
}

/// A new device's request.
#[derive(Debug)]
struct Pending {
    id: String,
    /// The `DPoP` key thumbprint it is for.
    thumbprint: String,
    name: String,
    host_value: [u8; remote::APPROVAL_VALUE_BYTES],
    /// The client's value, once it sent it. Only then does the request have a code.
    client_value: Option<[u8; remote::APPROVAL_VALUE_BYTES]>,
    expires: Instant,
    expires_at: jiff::Timestamp,
    /// A device approved it, so the client's next call gets its session.
    approved: bool,
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
            .is_some_and(|p| Instant::now() >= p.expires)
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
        if let Some(pending) = &state.pending {
            if pending.thumbprint != thumbprint {
                return Err("another device's request is waiting");
            }
            let commitment = remote::approval_commitment(&pending.host_value);
            return Ok((pending.id.clone(), commitment));
        }
        let now = Instant::now();
        while state
            .started
            .front()
            .is_some_and(|at| now.duration_since(*at) >= HOUR)
        {
            state.started.pop_front();
        }
        if state.started.len() >= MAX_REQUESTS {
            return Err("too many new devices asked this hour");
        }
        state.started.push_back(now);
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
            expires: now + remote::REQUEST_LIFETIME,
            expires_at: jiff::Timestamp::now() + lifetime,
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

    /// Forgets which device the last setup code approved, as a new one starts.
    pub(crate) fn setup_started(&self) {
        lock(&self.state).setup_approved = None;
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

fn read_lists(db: &Store) -> Result<Lists, ErrorObject> {
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

async fn account(daemon: &Daemon) -> Option<String> {
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

/// Changes the stored lists with `change`, and ends the sessions of every removed key.
async fn update(
    daemon: &Daemon,
    cancel: &CancellationToken,
    change: impl FnOnce(&mut Lists) -> Result<(), ErrorObject> + Send + 'static,
) -> Result<Lists, ErrorObject> {
    let (lists, ended) = daemon
        .store
        .run(cancel, move |db| {
            let mut lists = read_lists(db)?;
            change(&mut lists)?;
            let json = serde_json::to_string(&lists)
                .map_err(|e| ErrorObject::internal_error(e.to_string()))?;
            db.set_account_access(&json).map_err(|e| store_error(&e))?;
            // A removed device's session works only until its host learns of the removal.
            let mut sessions = read_sessions(db)?;
            let (ended, kept) = sessions
                .drain(..)
                .partition::<Vec<_>, _>(|s| lists.removed_clients.contains(&s.thumbprint));
            if !ended.is_empty() {
                write_sessions(db, &kept)?;
            }
            Ok((lists, ended))
        })
        .await?;
    for session in ended {
        info!(session = %session.id, "ended a removed device's session");
        daemon.remote.revoke(&session.id);
    }
    daemon.remote.access.changed();
    Ok(lists)
}

/// Adds `thumbprint` to the approved clients, unless it was removed.
fn approve_key(lists: &mut Lists, thumbprint: String) -> Result<(), ErrorObject> {
    if lists.removed_clients.contains(&thumbprint) {
        return Err(ErrorObject::invalid_params(
            "That device was removed. It can sign in again with a new key.",
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

/// `access/remove`: removes a client's key for good, and ends its sessions here.
pub(crate) async fn remove(
    daemon: &Daemon,
    cancel: &CancellationToken,
    thumbprint: String,
) -> Result<(), ErrorObject> {
    if !remote::is_host_id(&thumbprint) {
        return Err(ErrorObject::invalid_params("not a key thumbprint"));
    }
    info!(%thumbprint, "removed a device");
    update(daemon, cancel, move |lists| {
        lists.removed_clients.insert(thumbprint);
        lists.merge(Lists::default());
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

fn removed(why: &str) -> (u16, serde_json::Value) {
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
    let Some(token) = new_session(daemon, proven, label, false).await else {
        return (500, json!({ "error": "server_error" }));
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
        return removed("this device was removed");
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
    }
    let Ok(body) = serde_json::from_slice::<Approval>(&request.body) else {
        return (400, json!({ "error": "invalid_request" }));
    };
    let value = match body.value.as_deref().map(remote::base64url_decode) {
        Some(None) => return (400, json!({ "error": "invalid_request" })),
        Some(Some(value)) => Some(value),
        None => None,
    };
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
    let deadline = tokio::time::Instant::now() + remote::APPROVAL_WAIT;
    let mut versions = access.version.subscribe();
    let mut value = value.as_deref();
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
}
