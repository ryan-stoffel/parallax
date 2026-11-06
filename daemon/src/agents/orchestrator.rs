//! An orchestrator chat (PLX-41, decision 0024): a no-write run whose orchestrator thread is
//! its own id, with a thread's Parallax tools bound to that run (0041, PLX-380). Any backend whose
//! kind has the orchestrator's permission mode runs it, as its full CLI in that mode (0042).
//!
//! `orchestrator/start` records it like any run, without a worktree row, and hands it to the same
//! actor as a worker's, so `agent/send`, `agent/cancel`, `agent/events`, the `agent.*` events, and
//! resuming after a restart work unchanged. The actor runs it in a detached worktree at the
//! integration branch's tip, refreshed before each CLI process, so its edits reach neither the
//! user's checkout nor the branch (0042). An orchestrator has one live orchestrator: a new run
//! replaces the last one unless that one is still starting or running, and takes over the same
//! worktree.

use std::collections::HashMap;
use std::fmt::Write as _;
use std::sync::Arc;

use parallax_protocol::jsonrpc::ErrorObject;
use parallax_protocol::{
    AgentRun, ErrorKind, OrchestratorAutonomy, OrchestratorPermission, OrchestratorStartParams,
    Role, RunId, ScopeId,
};
use parallax_store::{RunFields, RunState};
use tracing::info;
use uuid::Uuid;

use super::actor::Actor;
use super::convert::{NO_WRITE, RUNNING, STARTING, option_name};
use super::{RunOptions, existing, prepare, requested_account, stage_started, store, store_error};
use crate::methods::question::level;
use crate::server::Daemon;

/// The orchestrator's instructions, pinned to its system prompt ([`instructions`]).
const INSTRUCTIONS: &str = include_str!("orchestrator.md");

/// `orchestrator/start`: see the module documentation. Idempotent on the run id, and refused while
/// the orchestrator is starting or running.
#[expect(clippy::too_many_lines, reason = "the steps of a start, in order")]
pub(crate) async fn start(
    daemon: Arc<Daemon>,
    params: OrchestratorStartParams,
) -> Result<AgentRun, ErrorObject> {
    let OrchestratorStartParams {
        orchestrator,
        run_id,
        prompt,
        account,
        model,
        effort,
        // It runs in the orchestrator's mode instead (0042).
        permission: _,
        images,
        // It asks through the inbox, as every orchestrator child does (0042), and so gets plxd's
        // tools on Codex and ACP, which attach them only with `approvals`.
        approvals: _,
    } = params;
    let _lane = daemon.dispatcher.lane(run_id).await;
    // An unknown orchestrator has no mode, and fails below with `orchestratorNotFound`.
    let mode = super::orchestrator_mode(&daemon, orchestrator).await?;
    let options = RunOptions {
        model,
        effort,
        permission: mode.and_then(OrchestratorPermission::agent),
        ..RunOptions::default()
    };
    let mut fields = RunFields {
        project_id: orchestrator.into(),
        prompt: prompt.clone(),
        requested_account: requested_account(account.as_ref()),
        policy: NO_WRITE.to_owned(),
        backend: String::new(),
        orchestrator_thread: Some(Uuid::from(run_id)),
        // Its own thread, never its own parent (0041).
        parent: None,
        notify_parent: false,
        model: options.model.clone(),
        effort: options.effort.and_then(option_name),
        permission: options.permission.and_then(option_name),
        context_window: None,
        fast: None,
        approvals: true,
        checkout: false,
        explore: false,
    };
    if let Some(run) = existing(&daemon, run_id, &fields).await? {
        return Ok(run);
    }
    let (prepared, _) = prepare(
        &daemon,
        orchestrator,
        run_id,
        account,
        Role::Orchestrator,
        false,
    )
    .await?;
    if let Some(mode) = mode {
        super::in_mode(prepared.resolved.backend(), mode)?;
    }
    options.check(prepared.resolved.backend())?;
    fields.backend = prepared.resolved.backend().name().into();
    let state = RunState {
        status: STARTING.to_owned(),
        account_id: prepared.resolved.account_id(),
        ..RunState::default()
    };
    // One store job, so two starts with different run ids can't both find no live orchestrator.
    let (row, replaced, handed) = store(&daemon, move |db| {
        require_orchestrator(db, orchestrator)?;
        let current = newest(db, orchestrator.into())?;
        if let Some(current) = &current
            && (current.state.status == STARTING || current.state.status == RUNNING)
        {
            return Err(ErrorObject::parallax(
                ErrorKind::IdConflict,
                format!(
                    "orchestrator {orchestrator}'s run {} is running; message it with \
                     agent/send, or stop it before starting over",
                    current.id
                ),
            ));
        }
        let row = db
            .create_run(run_id.into(), &fields, &state)
            .map_err(|e| store_error(&e))?;
        stage_started(db, &row, None)?;
        // Its run is the orchestrator's thread from here on (0093), taking over from the one it
        // replaces.
        let (thread, before) = db
            .create_orchestrator_thread(row.id, orchestrator.into())
            .map_err(|e| store_error(&e))?;
        crate::threads::stage_started(db, &thread)?;
        if let Some(before) = before {
            crate::threads::stage_updated(db, &before)?;
        }
        // In the job that makes the row, so no child's end is both handed over and sent to it
        // (PLX-936).
        let handed = super::wake::handed(db, orchestrator.into(), row.id);
        Ok((row, current.map(|current| current.id), handed))
    })
    .await?;
    // The orchestrator it replaces may have an idle session in the same worktree: it ends, so two
    // orchestrator CLIs never share it (0060).
    if let Some(old) = replaced.and_then(|id| RunId::try_from(id).ok()) {
        super::detach(&daemon, old).await;
    }
    info!(run = %run_id, orchestrator = %orchestrator, backend = %row.fields.backend, "created an orchestrator");

    let mut actor = Actor::new(Arc::clone(&daemon), row, None, HashMap::new());
    actor
        .launch(prepared, prompt, images, None, None, None)
        .await;
    // The actor owns a live CLI from here on, so it is spawned whatever the snapshot says.
    let run = actor.snapshot();
    daemon.agents.spawn(actor);
    super::wake::hand_over(&daemon, run_id, handed);
    run
}

/// `orchestrator/fresh`: ends `orchestrator`'s orchestrator's session, so its next message starts
/// its next epoch from the packet (PLX-937, decision 0079).
pub(crate) async fn fresh(
    daemon: &Arc<Daemon>,
    orchestrator: ScopeId,
) -> Result<AgentRun, ErrorObject> {
    let current = store(daemon, move |db| {
        require_orchestrator(db, orchestrator)?;
        orchestrator_of(db, orchestrator.into())
    })
    .await?;
    let Some(run) = current else {
        return Err(ErrorObject::parallax(
            ErrorKind::RunNotFound,
            format!("orchestrator {orchestrator} has no run"),
        ));
    };
    super::ask(daemon, run, |reply| super::actor::Command::Fresh { reply }).await
}

/// Fails with `orchestratorNotFound` unless `orchestrator` is an orchestrator in the store.
fn require_orchestrator(
    db: &parallax_store::Store,
    orchestrator: ScopeId,
) -> Result<(), ErrorObject> {
    match db
        .get_orchestrator(orchestrator.into())
        .map_err(|e| store_error(&e))?
    {
        Some(_) => Ok(()),
        None => Err(ErrorObject::parallax(
            ErrorKind::OrchestratorNotFound,
            format!("no orchestrator has id {orchestrator}"),
        )),
    }
}

/// `orchestrator`'s orchestrator: its newest no-write run. `orchestrator/start` with a new run id
/// replaces it unless it is starting or running, so one whose session can't be resumed never locks
/// the orchestrator.
pub(crate) fn orchestrator_of(
    db: &parallax_store::Store,
    orchestrator: Uuid,
) -> Result<Option<RunId>, ErrorObject> {
    newest(db, orchestrator)?
        .map(|run| {
            RunId::try_from(run.id).map_err(|_| {
                ErrorObject::internal_error(format!("the stored run {} has an invalid id", run.id))
            })
        })
        .transpose()
}

/// `orchestrator`'s newest no-write run.
// ponytail: scans the orchestrator's runs; an orchestrator column on orchestrators if that gets
// slow.
fn newest(
    db: &parallax_store::Store,
    orchestrator: Uuid,
) -> Result<Option<parallax_store::Run>, ErrorObject> {
    let runs = db
        .list_runs(Some(orchestrator))
        .map_err(|e| store_error(&e))?;
    Ok(runs
        .into_iter()
        .rev()
        .find(|run| run.fields.policy == NO_WRITE))
}

/// The user's first message to an orchestrator made from `threads`
/// (`orchestrator/fromThreads`, 0042): read them and propose a brief for the user to save.
pub(crate) fn from_threads_prompt(threads: &[RunId]) -> String {
    let mut list = String::new();
    for id in threads {
        let _ = writeln!(list, "- {id}");
    }
    format!(
        "I made this orchestrator from these threads, which are now your children:\n{list}\nRead each \
         with thread_read. Then draft the orchestrator's brief: its goal, scope, and constraints, in a \
         few lines, from what the threads were doing. Propose it with memory_propose (kind brief, \
         orchestrator scope) for me to save or discard, and start no new work until I save it."
    )
}

/// The orchestrator's instructions, where it is, and the orchestrator's autonomy level (0043),
/// which every CLI process of its run gets in its system prompt, so compaction never drops them and
/// a new level applies from the next process (0078). `repo` is `None` for one with no repo, and
/// `project` the instructions of the Project its thread is in (0093).
pub(super) fn instructions(
    repo: Option<&str>,
    autonomy: OrchestratorAutonomy,
    project: Option<&str>,
) -> String {
    let place = match repo {
        Some(repo) => format!(
            "The orchestrator's repository is {repo}, the user's own checkout: leave it alone. \
             Read the code in your working directory instead, a copy of the integration branch's \
             latest commit that Parallax resets each time it starts you, so it doesn't have the \
             user's uncommitted changes, and nothing written there is kept."
        ),
        None => "The orchestrator has no repository, so it has no integration branch and nothing \
                 lands: each child works in a scratch repository of its own."
            .to_owned(),
    };
    let mut text = format!(
        "{INSTRUCTIONS}\n{place}\n\n{} Each question Parallax wakes you with names the level as \
         it is then, since the user can change it.",
        level(autonomy)
    );
    if let Some(project) = project {
        text.push_str("\n\n");
        text.push_str(project);
    }
    text
}

#[cfg(test)]
pub(crate) mod tests;
