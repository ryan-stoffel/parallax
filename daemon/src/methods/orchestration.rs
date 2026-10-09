//! `orchestration/*` (0059 phase 2, PLX-644), behind the `orchestration` capability: commands
//! through [`crate::orchestrator::dispatch_command`], and the shell and thread subscriptions,
//! which answer with a snapshot at a `seq` and then send the events after it on the connection's
//! cursors, as `events/subscribe` does, or replay a short gap instead.

use std::sync::Arc;

use parallax_protocol::jsonrpc::ErrorObject;
use parallax_protocol::{
    DispatchResult, LoggedEvent, MAX_REPLAY_BYTES, MAX_REPLAY_EVENTS, OrchestrationCommand,
    ProjectId, RunId, ShellSnapshot, SubscribeShellParams, SubscribeShellResult,
    SubscribeThreadParams, SubscribeThreadResult, SubscriptionId, ThreadHistoryParams,
    ThreadHistoryResult, ThreadSnapshot,
};

use super::agent::{MAX_EVENTS_PAGE_BYTES, logged};
use super::{Context, Cursor};
use crate::agents::{self, coordinator};
use crate::store::{self, store_error};
use crate::{graph, threads};

/// The most events a snapshot or history page carries, as `agent/events`' default page.
const PAGE_EVENTS: usize = 500;

pub(super) async fn dispatch(
    context: &Context,
    command: OrchestrationCommand,
) -> Result<DispatchResult, ErrorObject> {
    crate::orchestrator::dispatch_command(&context.daemon, context.command_id, command).await
}

/// `orchestration/subscribeShell`: every project's and the host's events, cut down as
/// `events/subscribe`'s `shell` filter cuts them (PLX-454).
pub(super) async fn subscribe_shell(
    context: &Context,
    params: SubscribeShellParams,
) -> Result<(SubscribeShellResult, Cursor), ErrorObject> {
    let mut cursor = Cursor {
        subscription: SubscriptionId::generate(),
        project: None,
        all: true,
        after: 0,
        run: None,
        shell: true,
    };
    if let Some(after) = params.after_seq
        && replays(context, after, &cursor)
    {
        cursor.after = after;
        let result = SubscribeShellResult {
            subscription: cursor.subscription,
            snapshot: None,
        };
        return Ok((result, cursor));
    }
    let ((projects, repos, threads, runs, requests), seq) = context
        .daemon
        .reader
        .snapshot(&context.cancel, |db| {
            let error = |error| store_error(&error);
            let projects = db
                .list_projects()
                .map_err(error)?
                .into_iter()
                .map(|row| {
                    let coordinator = coordinator::coordinator_of(db, row.id)?;
                    store::project(row, coordinator)
                })
                .collect::<Result<Vec<_>, _>>()?;
            let repos = db
                .list_repos()
                .map_err(error)?
                .into_iter()
                .map(threads::repo_entry)
                .collect::<Result<Vec<_>, _>>()?;
            let threads = db
                .list_threads()
                .map_err(error)?
                .iter()
                .map(threads::thread_entry)
                .collect::<Result<Vec<_>, _>>()?;
            let runs = db
                .list_runs_with_worktrees(None)
                .map_err(error)?
                .iter()
                .map(|(row, worktree)| agents::snapshot(row, worktree.as_ref()))
                .collect::<Result<Vec<_>, _>>()?;
            let requests = graph::requests(db, None)?;
            Ok((projects, repos, threads, runs, requests))
        })
        .await?;
    cursor.after = seq;
    let result = SubscribeShellResult {
        subscription: cursor.subscription,
        snapshot: Some(ShellSnapshot {
            seq,
            projects,
            repos,
            threads,
            runs,
            requests,
        }),
    };
    Ok((result, cursor))
}

/// `orchestration/subscribeThread`: one thread's events, as `events/subscribe`'s `run` filter
/// keeps them (PLX-454).
pub(super) async fn subscribe_thread(
    context: &Context,
    params: SubscribeThreadParams,
) -> Result<(SubscribeThreadResult, Cursor), ErrorObject> {
    let SubscribeThreadParams {
        thread_id,
        after_seq,
    } = params;
    let daemon = &context.daemon;
    let project = daemon
        .reader
        .run(&context.cancel, move |db| {
            let row = db
                .get_run(thread_id.into())
                .map_err(|error| store_error(&error))?
                .ok_or_else(|| agents::run_not_found(thread_id))?;
            ProjectId::try_from(row.fields.project_id)
                .map_err(|_| ErrorObject::internal_error("a stored project id is not a UUIDv7"))
        })
        .await?;
    let mut cursor = Cursor {
        subscription: SubscriptionId::generate(),
        project: Some(project),
        all: false,
        after: 0,
        run: Some(thread_id),
        shell: false,
    };
    if let Some(after) = after_seq
        && replays(context, after, &cursor)
    {
        cursor.after = after;
        let result = SubscribeThreadResult {
            subscription: cursor.subscription,
            snapshot: None,
        };
        return Ok((result, cursor));
    }
    // A thread from before the graph gets its runs now, ahead of the background import.
    daemon
        .store
        .run(&context.cancel, move |db| {
            db.import_thread(thread_id.into())
        })
        .await?;
    let seq = daemon.log.head();
    let (thread, runs, requests) = daemon
        .reader
        .run(&context.cancel, move |db| {
            let error = |error| store_error(&error);
            let row = db
                .get_run(thread_id.into())
                .map_err(error)?
                .ok_or_else(|| agents::run_not_found(thread_id))?;
            let worktree = db.get_worktree(row.id).map_err(error)?;
            let thread = agents::snapshot(&row, worktree.as_ref())?;
            let runs = graph::runs(db, thread_id.into())?;
            let requests = graph::requests(db, Some(thread_id.into()))?;
            Ok((thread, runs, requests))
        })
        .await?;
    let (events, more) = page(context, thread_id, seq + 1).await?;
    cursor.after = seq;
    let result = SubscribeThreadResult {
        subscription: cursor.subscription,
        snapshot: Some(ThreadSnapshot {
            seq,
            thread,
            runs,
            events,
            more,
            requests,
        }),
    };
    Ok((result, cursor))
}

/// `orchestration/threadHistory`: the page of a thread's events before `before` (PLX-490's
/// paging).
pub(super) async fn thread_history(
    context: &Context,
    params: ThreadHistoryParams,
) -> Result<ThreadHistoryResult, ErrorObject> {
    let (events, more) = page(context, params.thread_id, params.before).await?;
    Ok(ThreadHistoryResult { events, more })
}

/// Thread `thread`'s newest events before `before`, oldest first, within a page's limits, and
/// whether older ones remain. Reads through the log's own connection, as `agent/events` does.
async fn page(
    context: &Context,
    thread: RunId,
    before: u64,
) -> Result<(Vec<LoggedEvent>, bool), ErrorObject> {
    let log = Arc::clone(&context.daemon.log);
    let (entries, more) = tokio::task::spawn_blocking(move || {
        log.run_events_before(thread, before, PAGE_EVENTS, MAX_EVENTS_PAGE_BYTES)
    })
    .await
    .map_err(ErrorObject::internal_error)?
    .map_err(|error| store_error(&error))?;
    Ok((
        entries.iter().rev().map(|entry| logged(entry)).collect(),
        more,
    ))
}

/// Whether a resume after `after` replays the gap: it is still in the window, and small enough
/// for `cursor` (0059).
fn replays(context: &Context, after: u64, cursor: &Cursor) -> bool {
    context.daemon.log.fits(
        after,
        |entry| cursor.keeps(entry),
        MAX_REPLAY_EVENTS,
        MAX_REPLAY_BYTES,
    )
}
