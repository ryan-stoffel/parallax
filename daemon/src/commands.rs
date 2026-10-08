//! Command ids (0052, PLX-482): claim a receipt before a listed method runs, wait for an
//! in-flight one, and fill or delete it when the command ends.

use std::collections::HashMap;
use std::future::Future;
use std::sync::{Mutex, MutexGuard, PoisonError};

use futures_util::FutureExt;
use parallax_protocol::ErrorKind;
use parallax_protocol::jsonrpc::{ErrorObject, Request};
use parallax_protocol::methods::RequestMethod;
use serde::Serialize;
use serde_json::Value;
use tokio::sync::{oneshot, watch};
use tokio_util::sync::CancellationToken;
use tokio_util::task::TaskTracker;
use uuid::Uuid;

use crate::server::Daemon;
use crate::store::store_error;

/// Methods that keep a receipt when the request carries `commandId`.
pub(crate) const RECEIPTED_METHODS: &[&str] = &[
    "agent/approve",
    "agent/commit",
    "agent/push",
    "agent/openPr",
    "agent/resumeNow",
    "queue/cancel",
    "queue/steer",
    "question/ask",
    "question/answer",
    "question/escalate",
    "land/queue",
    "land/approve",
    "land/sendBack",
    "project/start",
    "project/delete",
    "thread/delete",
];

/// Detached command tasks and in-memory waiters for an in-flight claim.
pub(crate) struct Commands {
    tracker: TaskTracker,
    waiters: Mutex<HashMap<String, watch::Sender<Option<CommandOutcome>>>>,
}

/// What a waiter receives when a claim is filled or deleted.
#[derive(Clone, Debug)]
enum CommandOutcome {
    Ready(Result<Value, ErrorObject>),
    AppliedError(ErrorObject),
}

/// What [`claim`] decided.
enum Claim {
    /// This task inserted the row and must run the method.
    Run,
    /// A result (or stored error) is already there.
    Ready(Result<Value, ErrorObject>),
    /// Same method and hash, no result yet: wait for the owner.
    Wait,
}

impl Commands {
    pub(crate) fn new() -> Self {
        Self {
            tracker: TaskTracker::new(),
            waiters: Mutex::new(HashMap::new()),
        }
    }

    /// Runs `work` on a task the connection never aborts, and returns its reply.
    pub(crate) fn spawn<F>(&self, work: F) -> oneshot::Receiver<F::Output>
    where
        F: Future + Send + 'static,
        F::Output: Send + 'static,
    {
        let (tx, rx) = oneshot::channel();
        self.tracker.spawn(async move {
            let _ = tx.send(work.await);
        });
        rx
    }

    /// Stops accepting new detached commands, so [`Self::wait`] can finish.
    pub(crate) fn close(&self) {
        self.tracker.close();
    }

    /// Waits for every detached command that is still running.
    pub(crate) async fn wait(&self) {
        self.tracker.wait().await;
    }

    fn subscribe(&self, command_id: &str) -> watch::Receiver<Option<CommandOutcome>> {
        let mut waiters = lock(&self.waiters);
        if let Some(tx) = waiters.get(command_id) {
            return tx.subscribe();
        }
        let (tx, rx) = watch::channel(None);
        waiters.insert(command_id.to_owned(), tx);
        rx
    }

    fn wake(&self, command_id: &str, outcome: Result<Value, ErrorObject>) {
        let tx = lock(&self.waiters).remove(command_id);
        if let Some(tx) = tx {
            let _ = tx.send(Some(CommandOutcome::Ready(outcome)));
        }
    }

    /// A side effect happened before its final write failed. Never delete this claim on error.
    pub(crate) fn applied_error(&self, command_id: Uuid, error: ErrorObject) {
        if let Some(tx) = lock(&self.waiters).get(&command_id.hyphenated().to_string()) {
            tx.send_replace(Some(CommandOutcome::AppliedError(error)));
        }
    }

    /// Drops a waiter nobody else is using, after a ready result made waiting unnecessary.
    fn drop_idle(&self, command_id: &str) {
        let mut waiters = lock(&self.waiters);
        if let Some(tx) = waiters.get(command_id)
            && tx.borrow().is_none()
            && tx.receiver_count() <= 1
        {
            waiters.remove(command_id);
        }
    }
}

impl Default for Commands {
    fn default() -> Self {
        Self::new()
    }
}

/// Whether `method` keeps a receipt.
#[must_use]
pub(crate) fn keeps_receipt(method: &str) -> bool {
    RECEIPTED_METHODS.contains(&method)
}

/// Takes `commandId` out of `request`'s params so a method that denies unknown fields still
/// parses. Absent is fine; a value that is not a UUID is `invalidParams`.
pub(crate) fn take_command_id(request: &mut Request) -> Result<Option<Uuid>, ErrorObject> {
    let Some(Value::Object(map)) = request.params.as_mut() else {
        return Ok(None);
    };
    let Some(value) = map.remove("commandId") else {
        return Ok(None);
    };
    let Some(text) = value.as_str() else {
        return Err(ErrorObject::invalid_params("commandId must be a UUID"));
    };
    Uuid::parse_str(text)
        .map(Some)
        .map_err(|_| ErrorObject::invalid_params("commandId must be a UUID"))
}

/// SHA-256 of `params` serialized again, without `commandId`.
pub(crate) fn params_hash(params: &impl Serialize) -> Result<String, ErrorObject> {
    let bytes = serde_json::to_vec(params).map_err(ErrorObject::internal_error)?;
    Ok(crate::sha256_hex(&bytes))
}

/// The run a method names, if its params have `runId` or `run`.
pub(crate) fn run_id_of(params: &impl Serialize) -> Option<String> {
    let value = serde_json::to_value(params).ok()?;
    let object = value.as_object()?;
    object
        .get("runId")
        .or_else(|| object.get("run"))
        .and_then(Value::as_str)
        .map(str::to_owned)
}

/// Deletes claims that have no result and no `effect_id`. Call once at start, before recover.
pub(crate) async fn purge_incomplete(daemon: &Daemon) -> Result<(), ErrorObject> {
    daemon
        .store
        .run(&CancellationToken::new(), |db| {
            db.delete_incomplete_claims().map_err(|e| store_error(&e))?;
            Ok(())
        })
        .await
}

/// Runs `handler` after claiming, fills the receipt on success, and deletes it on a clean
/// error. A panic deletes the claim too.
pub(crate) async fn run_receipted<M, F, Fut>(
    daemon: &Daemon,
    command_id: Uuid,
    params: M::Params,
    handler: F,
) -> Result<Value, ErrorObject>
where
    M: RequestMethod,
    F: FnOnce(M::Params) -> Fut,
    Fut: Future<Output = Result<M::Result, ErrorObject>>,
{
    if let Some(ready) = claim::<M>(daemon, command_id, &params).await? {
        return ready;
    }
    let id = command_id.hyphenated().to_string();
    let ran = std::panic::AssertUnwindSafe(handler(params))
        .catch_unwind()
        .await;
    match ran {
        Ok(Ok(result)) => {
            let outcome = serde_json::to_value(&result).map_err(ErrorObject::internal_error);
            finish(daemon, &id, outcome.clone()).await?;
            outcome
        }
        Ok(Err(error)) => {
            finish(daemon, &id, Err(error.clone())).await?;
            Err(error)
        }
        Err(_) => {
            let error = ErrorObject::internal_error("the request failed unexpectedly");
            finish(daemon, &id, Err(error.clone())).await?;
            Err(error)
        }
    }
}

/// Adds `commandId` to serialized params for a write `plxd mcp` retries with the same request.
#[must_use]
pub(crate) fn with_command_id(method: &str, params: impl Serialize) -> Value {
    let mut value =
        serde_json::to_value(params).unwrap_or_else(|_| Value::Object(serde_json::Map::new()));
    if !keeps_receipt(method) && !is_mutating_write(method) {
        return value;
    }
    if let Some(object) = value.as_object_mut() {
        object.insert(
            "commandId".to_owned(),
            Value::String(Uuid::now_v7().hyphenated().to_string()),
        );
    }
    value
}

fn is_mutating_write(method: &str) -> bool {
    matches!(
        method,
        "agent/start"
            | "agent/send"
            | "agent/cancel"
            | "agent/accept"
            | "agent/requestChanges"
            | "agent/autoResume"
            | "thread/start"
            | "thread/fork"
            | "thread/archive"
            | "thread/update"
            | "project/create"
            | "project/update"
            | "context/write"
            | "pr/link"
            | "pr/unlink"
            | "queue/edit"
            | "queue/reorder"
            | "memory/write"
            | "memory/delete"
            | "memory/propose"
    )
}

async fn claim<M: RequestMethod>(
    daemon: &Daemon,
    command_id: Uuid,
    params: &M::Params,
) -> Result<Option<Result<Value, ErrorObject>>, ErrorObject> {
    let hash = params_hash(params)?;
    let run_id = run_id_of(params);
    let id = command_id.hyphenated().to_string();
    let method = M::NAME.to_owned();
    let mut waiting = daemon.commands.subscribe(&id);
    let decided = {
        let id = id.clone();
        let hash = hash.clone();
        let method = method.clone();
        daemon
            .store
            .run(&CancellationToken::new(), move |db| {
                let (inserted, row) = db
                    .claim_command(&id, &method, &hash, run_id.as_deref())
                    .map_err(|e| store_error(&e))?;
                if row.method != method || row.params_hash != hash {
                    return Err(ErrorObject::parallax(
                        ErrorKind::IdConflict,
                        format!("command {id} was already used with a different method or params"),
                    ));
                }
                if let Some(json) = row.result {
                    return Ok(Claim::Ready(decode_stored(&json)?));
                }
                if inserted {
                    Ok(Claim::Run)
                } else {
                    Ok(Claim::Wait)
                }
            })
            .await?
    };
    match decided {
        Claim::Run => Ok(None),
        Claim::Ready(ready) => {
            daemon.commands.drop_idle(&id);
            Ok(Some(ready))
        }
        Claim::Wait => wait_for(&mut waiting).await,
    }
}

async fn wait_for(
    waiting: &mut watch::Receiver<Option<CommandOutcome>>,
) -> Result<Option<Result<Value, ErrorObject>>, ErrorObject> {
    match waiting.borrow().clone() {
        Some(CommandOutcome::Ready(ready)) => return Ok(Some(ready)),
        Some(CommandOutcome::AppliedError(error)) => return Ok(Some(Err(error))),
        None => {}
    }
    waiting
        .changed()
        .await
        .map_err(|_| ErrorObject::internal_error("the command waiter closed"))?;
    match waiting.borrow().clone() {
        Some(CommandOutcome::Ready(ready)) => Ok(Some(ready)),
        Some(CommandOutcome::AppliedError(error)) => Ok(Some(Err(error))),
        None => Err(ErrorObject::internal_error("the command waiter closed")),
    }
}

async fn finish(
    daemon: &Daemon,
    command_id: &str,
    outcome: Result<Value, ErrorObject>,
) -> Result<(), ErrorObject> {
    let stored = match &outcome {
        Ok(value) => serde_json::to_string(value),
        Err(error) => serde_json::to_string(error),
    };
    let id = command_id.to_owned();
    let applied_error = lock(&daemon.commands.waiters)
        .get(command_id)
        .and_then(|tx| match tx.borrow().clone() {
            Some(CommandOutcome::AppliedError(error)) => Some(error),
            _ => None,
        });
    let fill = outcome.is_ok() || applied_error.is_some();
    let persisted = daemon
        .store
        .run(&CancellationToken::new(), move |db| {
            match (stored, fill) {
                (Ok(json), true) => {
                    let row = db
                        .command_receipt(&id)
                        .map_err(|e| store_error(&e))?
                        .ok_or_else(|| {
                            ErrorObject::internal_error("the command receipt disappeared")
                        })?;
                    if row.result.is_none()
                        && !db
                            .fill_command_receipt(&id, &json)
                            .map_err(|e| store_error(&e))?
                    {
                        return Err(ErrorObject::internal_error(
                            "the command receipt disappeared",
                        ));
                    }
                }
                (Ok(_), false) => match db.command_receipt(&id).map_err(|e| store_error(&e))? {
                    Some(row) if row.result.is_some() => {}
                    Some(_) => {
                        db.delete_command_claim(&id).map_err(|e| store_error(&e))?;
                    }
                    None => {}
                },
                (Err(error), _) => return Err(ErrorObject::internal_error(error)),
            }
            Ok(())
        })
        .await;
    if let Err(error) = persisted {
        let error = applied_error.unwrap_or(error);
        // Keep a terminal failure for this process: the durable claim may still be incomplete.
        // A later retry must fail explicitly rather than create a waiter with no owner.
        if let Some(tx) = lock(&daemon.commands.waiters).get(command_id) {
            tx.send_replace(Some(CommandOutcome::Ready(Err(error.clone()))));
        }
        return Err(error);
    }
    daemon.commands.wake(command_id, outcome);
    Ok(())
}

/// Complete a command in the same writer job as its mutation.
pub(crate) fn complete<T: Serialize>(
    db: &mut crate::store::Tx,
    id: Option<Uuid>,
    result: &T,
) -> Result<(), ErrorObject> {
    if let Some(id) = id {
        let json = serde_json::to_string(result).map_err(ErrorObject::internal_error)?;
        if !db
            .fill_command_receipt(&id.hyphenated().to_string(), &json)
            .map_err(|e| store_error(&e))?
        {
            return Err(ErrorObject::internal_error(
                "the command receipt disappeared",
            ));
        }
    }
    Ok(())
}

fn decode_stored(json: &str) -> Result<Result<Value, ErrorObject>, ErrorObject> {
    let value: Value = serde_json::from_str(json).map_err(ErrorObject::internal_error)?;
    if let Ok(error) = serde_json::from_value::<ErrorObject>(value.clone())
        && error.code < 0
    {
        return Ok(Err(error));
    }
    Ok(Ok(value))
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

#[cfg(test)]
mod tests {
    use parallax_protocol::jsonrpc::Request;
    use serde_json::json;

    use super::{keeps_receipt, params_hash, take_command_id};

    #[test]
    fn take_command_id_strips_a_uuid_and_rejects_a_bad_value() {
        let mut request = Request {
            id: 1.into(),
            method: "project/delete".to_owned(),
            params: Some(json!({
                "project": "01901234-5678-7000-8000-000000000001",
                "commandId": "01901234-5678-7000-8000-0000000000aa"
            })),
        };
        let id = take_command_id(&mut request).unwrap().unwrap();
        assert_eq!(id.to_string(), "01901234-5678-7000-8000-0000000000aa");
        assert_eq!(
            request.params,
            Some(json!({"project": "01901234-5678-7000-8000-000000000001"}))
        );

        let mut bad = Request {
            id: 2.into(),
            method: "project/delete".to_owned(),
            params: Some(json!({"commandId": "not-a-uuid"})),
        };
        assert!(take_command_id(&mut bad).is_err());
    }

    #[test]
    fn listed_methods_keep_a_receipt_and_the_same_params_hash_the_same() {
        assert!(keeps_receipt("project/delete"));
        assert!(!keeps_receipt("project/list"));
        let a = params_hash(&json!({"project": "p"})).unwrap();
        let b = params_hash(&json!({"project": "p"})).unwrap();
        assert_eq!(a, b);
        assert_ne!(a, params_hash(&json!({"project": "q"})).unwrap());
    }
}
