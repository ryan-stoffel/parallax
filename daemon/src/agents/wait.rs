//! `agent/wait` (PLX-451): waits until any or all of some runs are idle, without polling.
//!
//! A run's status only changes with an `agent.updated` or `agent.finished` in the event log, and
//! plxd stores the status before it appends the `agent.updated`. So the wait sleeps on the log's
//! watch, checks each batch of new events for one about its runs, and reads the runs from the
//! store again only when it finds one.
//!
//! Deleting a thread drops its run's events from the log's window without a gap the wait can
//! see, but it then appends `thread.deleted`, which wakes the wait too: its re-read finds the run
//! gone and answers `runNotFound`.

use std::sync::Arc;
use std::time::Duration;

use parallax_protocol::jsonrpc::ErrorObject;
use parallax_protocol::{
    AgentRun, AgentStatus, AgentWaitParams, AgentWaitResult, AgentWaitUntil, ParallaxEvent, RunId,
};
use tokio::time::{Instant, sleep_until};
use tokio_util::sync::CancellationToken;

use super::{run_not_found, snapshot, store_error};
use crate::methods::Context;
use crate::server::Daemon;

/// The most runs one `agent/wait` takes.
const MAX_RUNS: usize = 50;

/// The longest one `agent/wait` waits, in milliseconds: under the connection's 90 s idle timeout,
/// so a client that sends nothing else meanwhile keeps its connection.
const MAX_TIMEOUT_MS: u32 = 60_000;

/// Answers `agent/wait`: the runs once `until` holds, or as they stand when the timeout, capped
/// at [`MAX_TIMEOUT_MS`], passes or the connection stops reading (the client closed its side or
/// plxd is stopping), both reported as `timedOut`. Fails with `runNotFound` for a run that
/// doesn't exist or is deleted meanwhile, and stops when the request is cancelled.
pub(crate) async fn wait(
    context: &Context,
    params: AgentWaitParams,
) -> Result<AgentWaitResult, ErrorObject> {
    let Context {
        daemon,
        cancel,
        stopped_reading,
        ..
    } = context;
    let AgentWaitParams {
        run_ids,
        until,
        timeout_ms,
    } = params;
    if run_ids.is_empty() || run_ids.len() > MAX_RUNS {
        return Err(ErrorObject::invalid_params(format!(
            "runIds takes 1 to {MAX_RUNS} runs"
        )));
    }
    let all = match until {
        AgentWaitUntil::Any => false,
        AgentWaitUntil::All => true,
        AgentWaitUntil::Unknown => return Err(ErrorObject::invalid_params("unknown until")),
    };
    let deadline = Instant::now() + Duration::from_millis(timeout_ms.min(MAX_TIMEOUT_MS).into());
    // Subscribed before the first read, so no append after it goes unnoticed.
    let mut watch = daemon.log.watch();
    loop {
        let (runs, mut seen) = read(daemon, cancel, &run_ids).await?;
        let done = if all {
            runs.iter().all(idle)
        } else {
            runs.iter().any(idle)
        };
        if done {
            return Ok(AgentWaitResult {
                runs,
                timed_out: false,
            });
        }
        loop {
            tokio::select! {
                () = cancel.cancelled() => return Err(ErrorObject::request_cancelled()),
                () = sleep_until(deadline) => {
                    return Ok(AgentWaitResult { runs, timed_out: true });
                }
                () = stopped_reading.cancelled() => {
                    return Ok(AgentWaitResult { runs, timed_out: true });
                }
                // The log outlives `daemon`, so its watch never closes here.
                _ = watch.changed() => {}
            }
            let head = daemon.log.head();
            let touched = daemon.log.any_after(seen, |event| match event {
                ParallaxEvent::AgentUpdated { run_id, .. }
                | ParallaxEvent::AgentFinished { run_id, .. }
                | ParallaxEvent::ThreadDeleted { run_id, .. } => run_ids.contains(run_id),
                _ => false,
            });
            seen = head;
            if touched {
                break;
            }
        }
    }
}

/// Whether `run` is idle, as `thread_wait` sees it: neither starting nor running.
fn idle(run: &AgentRun) -> bool {
    !matches!(run.status, AgentStatus::Starting | AgentStatus::Running)
}

/// The runs, in the order given, and the log's head from just before they were read.
async fn read(
    daemon: &Daemon,
    cancel: &CancellationToken,
    run_ids: &[RunId],
) -> Result<(Vec<AgentRun>, u64), ErrorObject> {
    let log = Arc::clone(&daemon.log);
    let run_ids = run_ids.to_vec();
    let (rows, seq) = daemon
        .store
        .run(cancel, move |db| {
            let seq = log.head();
            let rows = run_ids
                .into_iter()
                .map(|id| {
                    let row = db
                        .get_run(id.into())
                        .map_err(|error| store_error(&error))?
                        .ok_or_else(|| run_not_found(id))?;
                    let worktree = db
                        .get_worktree(id.into())
                        .map_err(|error| store_error(&error))?;
                    Ok((row, worktree))
                })
                .collect::<Result<Vec<_>, ErrorObject>>()?;
            Ok((rows, seq))
        })
        .await?;
    let runs = rows
        .iter()
        .map(|(row, worktree)| snapshot(row, worktree.as_ref()))
        .collect::<Result<_, _>>()?;
    Ok((runs, seq))
}
