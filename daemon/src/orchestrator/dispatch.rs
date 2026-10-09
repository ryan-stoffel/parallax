//! `orchestration/dispatch` (0059 phase 2, PLX-644): T3 Code's thread commands, each checked
//! against the thread graph and carried out by the thread's actor, which still runs turns until
//! phase 3 replaces it with adapters.
//!
//! A command takes the lock of its own id, so a retry waits for its first try, then returns the
//! stored outcome if there is one. It doesn't hold its thread's lane while the actor works,
//! since the actor takes that lane itself; the actor's channel keeps one thread's commands in
//! order. Its receipt, and the effect a Stop's cascade needs, commit together once it is done. A
//! crash between the actor's change and the receipt leaves no receipt, and the retry runs it
//! again: a message is idempotent on its id in the actor, a queue change made twice leaves the
//! queue as once or fails `queuedMessageNotFound`, and a second Stop changes nothing.

use std::sync::Arc;

use parallax_protocol::jsonrpc::ErrorObject;
use parallax_protocol::{
    AgentSendParams, DispatchMode, DispatchResult, ErrorKind, OrchestrationCommand, RunId,
    ThreadRunStatus, TurnId,
};
use parallax_store::{NewEffect, OrchestrationReceipt};
use tokio_util::sync::CancellationToken;
use tracing::info;
use uuid::Uuid;

use super::{DELEGATED_TASKS_STOP, Effect};
use crate::agents::{self, Delivery, QueueOp};
use crate::server::Daemon;
use crate::store::store_error;

/// Runs `command` as `orchestration/dispatch`: see the module documentation.
pub(crate) async fn dispatch(
    daemon: &Arc<Daemon>,
    command_id: Option<Uuid>,
    command: OrchestrationCommand,
) -> Result<DispatchResult, ErrorObject> {
    let (thread, kind) = describe(&command)?;
    let id = command_id.unwrap_or_else(Uuid::now_v7);
    let _retries = daemon.orchestrator.lane(id).await;
    let key = id.hyphenated().to_string();
    let lookup = key.clone();
    let receipt = daemon
        .reader
        .run(&CancellationToken::new(), move |db| {
            db.orchestration_receipt(&lookup)
                .map_err(|error| store_error(&error))
        })
        .await?;
    if let Some(receipt) = receipt {
        if receipt.thread_id != Uuid::from(thread) || receipt.kind != kind {
            return Err(ErrorObject::parallax(
                ErrorKind::IdConflict,
                format!(
                    "command {key} was already used for {} on {}",
                    receipt.kind, receipt.thread_id
                ),
            ));
        }
        return match receipt.error {
            Some(error) => Err(serde_json::from_str(&error).map_err(ErrorObject::internal_error)?),
            None => Ok(DispatchResult {
                seq: receipt.result_seq.unwrap_or_else(|| daemon.log.head()),
            }),
        };
    }
    let acted = act(daemon, thread, command).await;
    let (error, cascade) = match &acted {
        Ok(cascade) => (None, cascade.clone()),
        Err(error) => (
            Some(serde_json::to_string(error).map_err(ErrorObject::internal_error)?),
            None,
        ),
    };
    let seq = daemon.log.head();
    let effect = cascade
        .map(|children| stop_effect(&key, thread, children))
        .transpose()?;
    let woke = effect.is_some();
    let receipt = OrchestrationReceipt {
        command_id: key,
        thread_id: thread.into(),
        kind: kind.to_owned(),
        result_seq: error.is_none().then_some(seq),
        error,
    };
    daemon
        .store
        .run(&CancellationToken::new(), move |db| {
            db.insert_orchestration_receipt(&receipt)
                .map_err(|error| store_error(&error))?;
            if let Some(effect) = &effect {
                db.enqueue_effect(effect)
                    .map_err(|error| store_error(&error))?;
            }
            Ok(())
        })
        .await?;
    if woke {
        daemon.orchestrator.notify();
    }
    acted.map(|_| DispatchResult { seq })
}

/// The thread a command is for, and its type.
fn describe(command: &OrchestrationCommand) -> Result<(RunId, &'static str), ErrorObject> {
    Ok(match command {
        OrchestrationCommand::MessageDispatch { thread_id, .. } => (*thread_id, "message.dispatch"),
        OrchestrationCommand::QueuedRunReorder { thread_id, .. } => {
            (*thread_id, "queued-run.reorder")
        }
        OrchestrationCommand::QueuedRunEdit { thread_id, .. } => (*thread_id, "queued-run.edit"),
        OrchestrationCommand::QueuedRunCancel { thread_id, .. } => {
            (*thread_id, "queued-run.cancel")
        }
        OrchestrationCommand::QueuedMessagePromoteToSteer { thread_id, .. } => {
            (*thread_id, "queued-message.promote-to-steer")
        }
        OrchestrationCommand::QueueResume { thread_id } => (*thread_id, "queue.resume"),
        OrchestrationCommand::RunInterrupt { thread_id, .. } => (*thread_id, "run.interrupt"),
        OrchestrationCommand::Unknown => {
            return Err(ErrorObject::invalid_params("unknown command type"));
        }
    })
}

/// Checks `command` against `thread`'s graph and has its actor carry it out. A Stop answers
/// with the children its cascade stops, if it has any.
async fn act(
    daemon: &Arc<Daemon>,
    thread: RunId,
    command: OrchestrationCommand,
) -> Result<Option<Vec<RunId>>, ErrorObject> {
    match command {
        OrchestrationCommand::MessageDispatch {
            thread_id,
            message_id,
            text,
            images,
            threads,
            model,
            effort,
            permission,
            context_window,
            fast,
            account,
            dispatch_mode,
        } => {
            crate::methods::check_message("text", &text, &images)?;
            let threads = agents::attached::check(daemon, threads).await?;
            let delivery = delivery(daemon, thread, dispatch_mode).await?;
            let params = AgentSendParams {
                run_id: thread_id,
                turn_id: message_id,
                text,
                model,
                effort,
                permission,
                context_window,
                fast,
                account,
                images,
                threads,
                from: None,
                delivery: None,
            };
            let daemon = Arc::clone(daemon);
            let detached = Arc::clone(&daemon);
            detached
                .agents
                .detached(agents::send_with(daemon, params, delivery))
                .await?;
            Ok(None)
        }
        OrchestrationCommand::QueuedRunReorder { run_ids, .. } => {
            queue(daemon, thread, QueueOp::Reorder { ids: run_ids }).await
        }
        OrchestrationCommand::QueuedRunEdit { run_id, text, .. } => {
            queued(daemon, thread, run_id).await?;
            if !text.trim().is_empty() {
                crate::methods::check_message("text", &text, &[])?;
            }
            queue(daemon, thread, QueueOp::Edit { id: run_id, text }).await
        }
        OrchestrationCommand::QueuedRunCancel { run_id, .. } => {
            queued(daemon, thread, run_id).await?;
            queue(daemon, thread, QueueOp::Cancel { id: run_id }).await
        }
        OrchestrationCommand::QueuedMessagePromoteToSteer { run_id, .. } => {
            queued(daemon, thread, run_id).await?;
            queue(daemon, thread, QueueOp::Steer { id: run_id }).await
        }
        OrchestrationCommand::QueueResume { .. } => queue(daemon, thread, QueueOp::Resume).await,
        OrchestrationCommand::RunInterrupt { hold_queue, .. } => {
            stop(daemon, thread, hold_queue).await
        }
        OrchestrationCommand::Unknown => Err(ErrorObject::invalid_params("unknown command type")),
    }
}

/// How a message with `mode` reaches `thread`. A steer or restart aimed at a run that has ended
/// starts as its own, as T3 Code does when steering comes too late.
async fn delivery(
    daemon: &Daemon,
    thread: RunId,
    mode: DispatchMode,
) -> Result<Delivery, ErrorObject> {
    let (target, steer) = match mode {
        DispatchMode::DeferStart
        | DispatchMode::QueueAfterActive
        | DispatchMode::StartImmediately => return Ok(Delivery::Queue),
        DispatchMode::SteerActive { target_run_id } => (target_run_id, Delivery::Steer),
        DispatchMode::RestartActive { target_run_id } => (target_run_id, Delivery::Restart),
        DispatchMode::Unknown => return Err(ErrorObject::invalid_params("unknown dispatch mode")),
    };
    let run = graph_run(daemon, thread, target).await?;
    match run.map(|run| run.status) {
        Some(ThreadRunStatus::Starting | ThreadRunStatus::Running | ThreadRunStatus::Waiting) => {
            Ok(steer)
        }
        Some(_) => Ok(Delivery::Queue),
        None => Err(ErrorObject::invalid_params(format!(
            "thread {thread} has no run {target}"
        ))),
    }
}

/// Run `id` of `thread` from the graph, once the thread's stored events are in it.
async fn graph_run(
    daemon: &Daemon,
    thread: RunId,
    id: TurnId,
) -> Result<Option<parallax_protocol::ThreadRun>, ErrorObject> {
    daemon
        .store
        .run(&CancellationToken::new(), move |db| {
            db.import_thread(thread.into())?;
            Ok(crate::graph::runs(db, thread.into())?
                .into_iter()
                .find(|run| run.id == id))
        })
        .await
}

/// Fails with `queuedMessageNotFound` unless run `id` waits in `thread`'s queue.
async fn queued(daemon: &Daemon, thread: RunId, id: TurnId) -> Result<(), ErrorObject> {
    match graph_run(daemon, thread, id).await? {
        Some(run) if run.status == ThreadRunStatus::Queued => Ok(()),
        _ => Err(ErrorObject::parallax(
            ErrorKind::QueuedMessageNotFound,
            format!("thread {thread} has no queued run {id}"),
        )),
    }
}

async fn queue(
    daemon: &Arc<Daemon>,
    thread: RunId,
    op: QueueOp,
) -> Result<Option<Vec<RunId>>, ErrorObject> {
    let work = agents::queue(Arc::clone(daemon), thread, op, None);
    daemon.agents.detached(work).await?;
    Ok(None)
}

/// Stops `thread`'s turn (0059's `run.interrupt`). With `hold_queue`, its queue waits for
/// `queue.resume`, and it answers with the children still running, for the cascade. A Project's
/// coordinator stops only its own turn, and its queue goes on (Ryan, 0059).
pub(super) async fn stop(
    daemon: &Arc<Daemon>,
    thread: RunId,
    hold_queue: bool,
) -> Result<Option<Vec<RunId>>, ErrorObject> {
    let (coordinator, children) = daemon
        .reader
        .run(&CancellationToken::new(), move |db| {
            let error = |error| store_error(&error);
            let row = db
                .get_run(thread.into())
                .map_err(error)?
                .ok_or_else(|| agents::run_not_found(thread))?;
            let children = db.running_children(thread.into()).map_err(error)?;
            Ok((row.fields.policy == agents::NO_WRITE, children))
        })
        .await?;
    let hold = hold_queue && !coordinator;
    let work = {
        let daemon = Arc::clone(daemon);
        async move { agents::interrupt(&daemon, thread, hold).await }
    };
    daemon.agents.detached(work).await?;
    let children: Vec<RunId> = children
        .into_iter()
        .filter_map(|id| RunId::try_from(id).ok())
        .collect();
    if hold && !children.is_empty() {
        info!(%thread, children = children.len(), "a Stop stops the threads it started");
        return Ok(Some(children));
    }
    Ok(None)
}

/// The cascade's effect for a Stop that command `command_id` made on `thread`. Its id is the
/// command's, so a replay can't enqueue it twice.
pub(super) fn stop_effect(
    command_id: &str,
    thread: RunId,
    children: Vec<RunId>,
) -> Result<NewEffect, ErrorObject> {
    let effect = Effect::DelegatedTasksStop { children };
    Ok(NewEffect {
        id: format!("{command_id}/0"),
        command_id: command_id.to_owned(),
        thread_id: thread.into(),
        kind: DELEGATED_TASKS_STOP.to_owned(),
        payload: serde_json::to_string(&effect).map_err(ErrorObject::internal_error)?,
    })
}
