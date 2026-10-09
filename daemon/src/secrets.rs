//! `request_secret` (0063, PLX-648), as T3 Code's `SecretRequests`: an agent asks the user for a
//! secret, the user answers in the app, and the agent gets a one-time `secret-ref:<id>` that a
//! tool such as `schedule/save` uses up. The value goes from `secret/answer` straight to the
//! host's keystore under the ref's id, so it never reaches the transcript, the event log, the
//! store, the logs, or a prompt. Only the ref, the thread that asked, and when it expires are
//! stored (`secret_refs`).
//!
//! A request lives in memory while its turn runs, as T3's runtime requests do: `secret/request`
//! records it with a `secretRequested` transcript item, which the app shows as a private card,
//! and waits for its answer. A turn that ends first cancels it. A ref works once, only for the
//! thread that asked, within 24 hours. [`run`] removes expired refs and their values, with one
//! timer for the next to expire and none while there are none. A host with no keystore (Windows,
//! PLX-23) refuses requests.

use std::collections::HashMap;
use std::sync::{Arc, Mutex, PoisonError};
use std::time::{Duration, Instant};

use jiff::{SignedDuration, Timestamp};
use parallax_protocol::jsonrpc::ErrorObject;
use parallax_protocol::{
    AccountId, AgentOutputItem, AgentStatus, ErrorKind, ParallaxEvent, ProjectId, RunId,
    SecretAnswerParams, SecretAnswerResult, SecretChoice, SecretRequestParams, SecretRequestResult,
    SecretStatus,
};
use tokio::sync::Notify;
use tokio_util::sync::CancellationToken;
use tracing::warn;
use uuid::Uuid;
use zeroize::Zeroizing;

use crate::server::Daemon;
use crate::store::store_error;

/// How long a ref works, as T3's.
const REF_LIFETIME: SignedDuration = SignedDuration::from_hours(24);

/// What a ref starts with.
const REF_PREFIX: &str = "secret-ref:";

/// The longest one `secret/request` waits, under a connection's idle timeout.
const MAX_WAIT: Duration = Duration::from_secs(50);

/// How often a waiting `secret/request` checks that its turn still runs.
const RUN_CHECK: Duration = Duration::from_secs(1);

/// How long a request is remembered after it is made, so a retry finds its answer.
const REMEMBERED: Duration = Duration::from_hours(2);

/// The longest label, reason, placeholder, and secret, in bytes.
const MAX_TEXT_BYTES: usize = 2 * 1024;
const MAX_SECRET_BYTES: usize = 64 * 1024;

/// The requests made since plxd started, and the expiry timer's wake-up.
#[derive(Default)]
pub(crate) struct Secrets {
    requests: Mutex<HashMap<Uuid, Request>>,
    changed: Notify,
    refs: Notify,
}

struct Request {
    run: RunId,
    status: SecretStatus,
    secret_ref: Option<String>,
    at: Instant,
}

impl Secrets {
    fn lock(&self) -> std::sync::MutexGuard<'_, HashMap<Uuid, Request>> {
        self.requests.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// Request `id`'s status and ref, if plxd has it.
    fn stands(&self, id: Uuid) -> Option<(SecretStatus, Option<String>)> {
        self.lock()
            .get(&id)
            .map(|request| (request.status, request.secret_ref.clone()))
    }
}

/// `secret/request`: see the module documentation.
pub(crate) async fn request(
    daemon: &Daemon,
    params: SecretRequestParams,
) -> Result<SecretRequestResult, ErrorObject> {
    let SecretRequestParams {
        run_id,
        request_id,
        label,
        reason,
        placeholder,
        wait_ms,
    } = params;
    if cfg!(not(any(target_os = "macos", target_os = "linux"))) {
        return Err(ErrorObject::parallax(
            ErrorKind::KeychainUnavailable,
            crate::keystore::UNAVAILABLE_MESSAGE,
        ));
    }
    let id = request_id_of(&request_id)?;
    for (name, text) in [("label", &label), ("reason", &reason)] {
        check_text(name, text)?;
    }
    if let Some(placeholder) = &placeholder {
        check_text("placeholder", placeholder)?;
    }
    let secrets = &daemon.secrets;
    let known = secrets.lock().get(&id).map(|request| request.run);
    match known {
        Some(run) if run != run_id => {
            return Err(ErrorObject::parallax(
                ErrorKind::IdConflict,
                format!("request {request_id} belongs to another thread"),
            ));
        }
        Some(_) => {}
        None => {
            let project = running(daemon, run_id).await?.ok_or_else(|| {
                ErrorObject::invalid_params(format!(
                    "thread {run_id} isn't running a turn: a secret is asked for from inside one"
                ))
            })?;
            {
                let mut requests = secrets.lock();
                requests.retain(|_, request| request.at.elapsed() < REMEMBERED);
                requests.insert(
                    id,
                    Request {
                        run: run_id,
                        status: SecretStatus::Pending,
                        secret_ref: None,
                        at: Instant::now(),
                    },
                );
            }
            let item = AgentOutputItem::SecretRequested {
                request_id: id.hyphenated().to_string(),
                label,
                reason,
                placeholder,
            };
            log(daemon, run_id, project, item).await;
        }
    }
    let deadline = Instant::now() + Duration::from_millis(wait_ms.into()).min(MAX_WAIT);
    loop {
        let changed = secrets.changed.notified();
        tokio::pin!(changed);
        changed.as_mut().enable();
        let (status, secret_ref) = secrets
            .stands(id)
            .unwrap_or((SecretStatus::Cancelled, None));
        if status != SecretStatus::Pending || Instant::now() >= deadline {
            return Ok(SecretRequestResult { status, secret_ref });
        }
        let left = deadline.saturating_duration_since(Instant::now());
        tokio::select! {
            () = changed => {}
            () = tokio::time::sleep(left.min(RUN_CHECK)) => {
                if running(daemon, run_id).await?.is_none() {
                    end(daemon, run_id, id, SecretStatus::Cancelled, None).await;
                }
            }
        }
    }
}

/// `secret/answer`: see the module documentation. Answers to one request run one at a time, and
/// only the first counts.
pub(crate) async fn answer(
    daemon: &Daemon,
    params: SecretAnswerParams,
) -> Result<SecretAnswerResult, ErrorObject> {
    let SecretAnswerParams {
        run_id,
        request_id,
        answer,
    } = params;
    let id = request_id_of(&request_id)?;
    let _lane = daemon.orchestrator.lane(id).await;
    match daemon.secrets.lock().get(&id) {
        Some(request) if request.run == run_id && request.status == SecretStatus::Pending => {}
        Some(request) if request.run == run_id => {
            return Err(ErrorObject::invalid_params(
                "this secret request was already answered",
            ));
        }
        _ => {
            return Err(ErrorObject::invalid_params(
                "this secret request no longer exists",
            ));
        }
    }
    match answer {
        SecretChoice::Save { secret } => {
            let secret = Zeroizing::new(secret);
            if secret.trim().is_empty() || secret.len() > MAX_SECRET_BYTES {
                return Err(ErrorObject::invalid_params(format!(
                    "the secret must be 1 to {MAX_SECRET_BYTES} bytes"
                )));
            }
            // The agent waits inside the turn that asked; once it has ended, no one would get
            // the ref.
            if running(daemon, run_id).await?.is_none() {
                end(daemon, run_id, id, SecretStatus::Cancelled, None).await;
                return Err(ErrorObject::invalid_params(
                    "the agent that asked has stopped, so this secret can't be used",
                ));
            }
            let secret_ref = save(daemon, run_id, secret).await?;
            end(daemon, run_id, id, SecretStatus::Saved, Some(secret_ref)).await;
            daemon.secrets.refs.notify_one();
        }
        SecretChoice::Decline => end(daemon, run_id, id, SecretStatus::Declined, None).await,
        SecretChoice::Cancel => end(daemon, run_id, id, SecretStatus::Cancelled, None).await,
        SecretChoice::Unknown => {
            return Err(ErrorObject::invalid_params(
                "answer must be save, decline, or cancel",
            ));
        }
    }
    Ok(SecretAnswerResult {})
}

/// Keeps `secret` in the keystore under a new ref for `run`, and records the ref.
async fn save(
    daemon: &Daemon,
    run: RunId,
    secret: Zeroizing<String>,
) -> Result<String, ErrorObject> {
    let key = AccountId::generate();
    let keys = Arc::clone(&daemon.keys);
    tokio::task::spawn_blocking(move || keys.set(key, &secret))
        .await
        .map_err(|error| ErrorObject::internal_error(error.to_string()))?
        .map_err(|error| crate::methods::keychain_error(&error))?;
    let expires = Timestamp::now() + REF_LIFETIME;
    let recorded = daemon
        .store
        .run(&CancellationToken::new(), move |db| {
            db.add_secret_ref(key.into(), run.into(), expires)
                .map_err(|e| store_error(&e))
        })
        .await;
    if let Err(error) = recorded {
        forget(daemon, vec![key]).await;
        return Err(error);
    }
    Ok(format!("{REF_PREFIX}{key}"))
}

/// Ends request `id` of `run` with `status`, unless it ended already, and logs how.
async fn end(
    daemon: &Daemon,
    run: RunId,
    id: Uuid,
    status: SecretStatus,
    secret_ref: Option<String>,
) {
    {
        let mut requests = daemon.secrets.lock();
        let Some(request) = requests
            .get_mut(&id)
            .filter(|request| request.status == SecretStatus::Pending)
        else {
            return;
        };
        request.status = status;
        request.secret_ref = secret_ref;
    }
    daemon.secrets.changed.notify_waiters();
    let project = daemon
        .reader
        .run(&CancellationToken::new(), move |db| {
            db.get_run(run.into()).map_err(|e| store_error(&e))
        })
        .await
        .ok()
        .flatten()
        .and_then(|row| ProjectId::try_from(row.fields.project_id).ok());
    let Some(project) = project else {
        return;
    };
    let item = AgentOutputItem::SecretResolved {
        request_id: id.hyphenated().to_string(),
        status,
    };
    log(daemon, run, project, item).await;
}

/// Logs `item` in `run`'s transcript.
async fn log(daemon: &Daemon, run: RunId, project: ProjectId, item: AgentOutputItem) {
    let event = ParallaxEvent::AgentOutput {
        run_id: run,
        items: vec![item],
        compacted: None,
    };
    let logged = daemon
        .store
        .run(&CancellationToken::new(), move |db| {
            db.stage(Timestamp::now(), Some(project), event);
            Ok(())
        })
        .await;
    if let Err(error) = logged {
        warn!(%run, error = %error.message, "could not log a secret request");
    }
}

/// `run`'s scope while it is running a turn, else `None`.
async fn running(daemon: &Daemon, run: RunId) -> Result<Option<ProjectId>, ErrorObject> {
    let row = daemon
        .reader
        .run(&CancellationToken::new(), move |db| {
            db.get_run(run.into()).map_err(|e| store_error(&e))
        })
        .await?
        .ok_or_else(|| crate::agents::run_not_found(run))?;
    let status = crate::agents::snapshot(&row, None)?.status;
    if !matches!(status, AgentStatus::Starting | AgentStatus::Running) {
        return Ok(None);
    }
    Ok(ProjectId::try_from(row.fields.project_id).ok())
}

/// Uses up `secret_ref` for thread `from`: its value, which leaves the keystore. A ref another
/// thread asked for is refused and kept.
pub(crate) async fn consume(
    daemon: &Daemon,
    secret_ref: &str,
    from: Option<RunId>,
) -> Result<Zeroizing<String>, ErrorObject> {
    let refused = |why: &str| ErrorObject::invalid_params(format!("secretRef: {why}"));
    let key = secret_ref
        .strip_prefix(REF_PREFIX)
        .and_then(|id| Uuid::try_parse(id).ok())
        .and_then(|id| AccountId::try_from(id).ok())
        .ok_or_else(|| refused("that is not a secretRef"))?;
    let from = from.ok_or_else(|| refused("only the thread that asked for it can use it"))?;
    let taken = daemon
        .store
        .run(&CancellationToken::new(), move |db| {
            let error = |error| store_error(&error);
            let taken = db.take_secret_ref(key.into()).map_err(error)?;
            if let Some((thread, expires)) = taken
                && thread != Uuid::from(from)
            {
                db.add_secret_ref(key.into(), thread, expires)
                    .map_err(error)?;
                return Ok(Err("only the thread that asked for it can use it"));
            }
            Ok(Ok(taken))
        })
        .await?
        .map_err(refused)?;
    let Some((_, expires)) = taken else {
        return Err(refused(
            "it was used already or doesn't exist; ask again with request_secret",
        ));
    };
    let keys = Arc::clone(&daemon.keys);
    let value = tokio::task::spawn_blocking(move || {
        let value = keys.get(key);
        let _ = keys.delete(key);
        value
    })
    .await
    .map_err(|error| ErrorObject::internal_error(error.to_string()))?
    .map_err(|error| crate::methods::keychain_error(&error))?;
    if expires <= Timestamp::now() {
        return Err(refused("it expired; ask again with request_secret"));
    }
    value.ok_or_else(|| refused("its value is gone; ask again with request_secret"))
}

/// Removes the keystore values `keys`, logging a failure, since the value is still there.
async fn forget(daemon: &Daemon, keys: Vec<AccountId>) {
    let store = Arc::clone(&daemon.keys);
    let removed = tokio::task::spawn_blocking(move || {
        keys.into_iter()
            .filter(|key| store.delete(*key).is_err())
            .count()
    })
    .await
    .unwrap_or(1);
    if removed > 0 {
        warn!(
            failed = removed,
            "could not remove expired secrets from the keystore"
        );
    }
}

/// The expiry timer: see the module documentation. Returns when `stop` is cancelled.
pub(crate) async fn run(daemon: Arc<Daemon>, stop: CancellationToken) {
    loop {
        let swept = daemon
            .store
            .run(&CancellationToken::new(), |db| {
                let error = |error| store_error(&error);
                let (expired, next) = db.secret_ref_expiry(Timestamp::now()).map_err(error)?;
                for id in &expired {
                    db.take_secret_ref(*id).map_err(error)?;
                }
                Ok((expired, next))
            })
            .await;
        let next = match swept {
            Ok((expired, next)) => {
                let keys = expired
                    .into_iter()
                    .filter_map(|id| AccountId::try_from(id).ok())
                    .collect::<Vec<_>>();
                if !keys.is_empty() {
                    forget(&daemon, keys).await;
                }
                next
            }
            Err(error) => {
                warn!(error = %error.message, "could not remove expired secret refs");
                None
            }
        };
        let wait = next
            .map(|at| Duration::try_from(at.duration_since(Timestamp::now())).unwrap_or_default());
        tokio::select! {
            () = stop.cancelled() => return,
            () = daemon.secrets.refs.notified() => {}
            () = tokio::time::sleep(wait.unwrap_or_default()), if wait.is_some() => {}
        }
    }
}

fn request_id_of(id: &str) -> Result<Uuid, ErrorObject> {
    Uuid::try_parse(id)
        .map_err(|_| ErrorObject::invalid_params(format!("{id:?} is not a request id")))
}

fn check_text(name: &str, text: &str) -> Result<(), ErrorObject> {
    if text.trim().is_empty() || text.len() > MAX_TEXT_BYTES {
        return Err(ErrorObject::invalid_params(format!(
            "{name} must be 1 to {MAX_TEXT_BYTES} bytes"
        )));
    }
    Ok(())
}
