//! A project's coordinator chat (PLX-41, decision 0024): a no-write run whose coordinator thread is
//! its own id, with a thread's Parallax tools bound to that run (0041, PLX-380). Any backend whose
//! kind has the project's permission mode runs it, as its full CLI in that mode (0042).
//!
//! `project/start` records it like any run, without a worktree row, and hands it to the same
//! actor as a worker's, so `agent/send`, `agent/cancel`, `agent/events`, the `agent.*` events, and
//! resuming after a restart work unchanged. The actor runs it in a detached worktree at the
//! integration branch's tip, refreshed before each CLI process, so its edits reach neither the
//! user's checkout nor the branch (0042). A project has one live coordinator: a new run replaces
//! the last one unless that one is still starting or running, and takes over the same worktree.

use std::collections::HashMap;
use std::fmt::Write as _;
use std::sync::Arc;

use parallax_protocol::jsonrpc::ErrorObject;
use parallax_protocol::{
    AgentRun, ErrorKind, ProjectAutonomy, ProjectPermission, ProjectStartParams, Role, RunId,
};
use parallax_store::{RunFields, RunState};
use tracing::info;
use uuid::Uuid;

use super::actor::Actor;
use super::convert::{NO_WRITE, RUNNING, STARTING, agent_run, option_name};
use super::{RunOptions, existing, log_started, prepare, requested_account, store, store_error};
use crate::methods::question::level;
use crate::server::Daemon;

/// The coordinator's instructions, sent ahead of the user's first message.
const INSTRUCTIONS: &str = include_str!("coordinator.md");

/// `project/start`: see the module documentation. Idempotent on the run id, and refused while the
/// project's coordinator is starting or running.
pub(crate) async fn start(
    daemon: Arc<Daemon>,
    params: ProjectStartParams,
) -> Result<AgentRun, ErrorObject> {
    let ProjectStartParams {
        project,
        run_id,
        prompt,
        account,
        model,
        effort,
        // It runs in the project's mode instead (0042).
        permission: _,
        images,
        // It asks through the inbox, as every Project child does (0042), and so gets plxd's tools
        // on Codex and ACP, which attach them only with `approvals`.
        approvals: _,
    } = params;
    let _starting = daemon.agents.start_guard(run_id).await;
    // An unknown project has no mode, and fails below with `projectNotFound`.
    let mode = super::project_mode(&daemon, project).await?;
    let options = RunOptions {
        model,
        effort,
        permission: mode.and_then(ProjectPermission::agent),
        ..RunOptions::default()
    };
    let mut fields = RunFields {
        project_id: project.into(),
        prompt: prompt.clone(),
        requested_account: requested_account(account.as_ref()),
        policy: NO_WRITE.to_owned(),
        backend: String::new(),
        coordinator_thread: Some(Uuid::from(run_id)),
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
    let (prepared, repo_path) =
        prepare(&daemon, project, run_id, account, Role::Coordinator).await?;
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
    // One store job, so two starts with different run ids can't both find no live coordinator.
    let (row, autonomy) = store(&daemon, move |db| {
        let Some(project_row) = db
            .get_project(project.into())
            .map_err(|e| store_error(&e))?
        else {
            return Err(ErrorObject::parallax(
                ErrorKind::ProjectNotFound,
                format!("no project has id {project}"),
            ));
        };
        if let Some(current) = newest(db, project.into())?
            && (current.state.status == STARTING || current.state.status == RUNNING)
        {
            return Err(ErrorObject::parallax(
                ErrorKind::IdConflict,
                format!(
                    "project {project}'s coordinator, run {}, is running; message it with \
                     agent/send, or stop it before starting over",
                    current.id
                ),
            ));
        }
        let row = db
            .create_run(run_id.into(), &fields, &state)
            .map_err(|e| store_error(&e))?;
        Ok((row, crate::store::project_autonomy(&project_row.autonomy)))
    })
    .await?;
    log_started(&daemon, project, agent_run(&row, None)?).await;
    info!(run = %run_id, project = %project, backend = %row.fields.backend, "created a project's coordinator");

    let mut actor = Actor::new(Arc::clone(&daemon), row, None, HashMap::new());
    let message = first_message(&prompt, &repo_path, autonomy);
    actor
        .launch(prepared, message, images, None, None, None)
        .await;
    // The actor owns a live CLI from here on, so it is spawned whatever the snapshot says.
    let run = actor.snapshot();
    daemon.agents.spawn(actor);
    super::wake::hand_over(&daemon, project.into(), run_id);
    run
}

/// `project`'s coordinator: its newest no-write run. `project/start` with a new run id replaces it
/// unless it is starting or running, so one whose session can't be resumed never locks the
/// project.
pub(crate) fn coordinator_of(
    db: &parallax_store::Store,
    project: Uuid,
) -> Result<Option<RunId>, ErrorObject> {
    newest(db, project)?
        .map(|run| {
            RunId::try_from(run.id).map_err(|_| {
                ErrorObject::internal_error(format!("the stored run {} has an invalid id", run.id))
            })
        })
        .transpose()
}

/// `project`'s newest no-write run.
// ponytail: scans the project's runs; a coordinator column on projects if that gets slow.
fn newest(
    db: &parallax_store::Store,
    project: Uuid,
) -> Result<Option<parallax_store::Run>, ErrorObject> {
    let runs = db.list_runs(Some(project)).map_err(|e| store_error(&e))?;
    Ok(runs
        .into_iter()
        .rev()
        .find(|run| run.fields.policy == NO_WRITE))
}

/// The user's first message to the coordinator of a Project made from `threads`
/// (`project/fromThreads`, 0042): read them and draft the brief for the user to approve.
// ponytail: the draft is text in its reply; make it a memory proposal once PLX-476 lets a
// coordinator propose one.
pub(crate) fn from_threads_prompt(threads: &[RunId]) -> String {
    let mut list = String::new();
    for id in threads {
        let _ = writeln!(list, "- {id}");
    }
    format!(
        "I made this Project from these threads, which are now your children:\n{list}\nRead each \
         with thread_read. Then draft the Project's brief: its goal, scope, and constraints, in a \
         few lines, from what the threads were doing. Reply with the draft for me to approve, and \
         start no new work until I do. Once I approve it, save it as brief.md with memory_write."
    )
}

/// The coordinator's first message: its instructions, where it is, the Project's autonomy level
/// (0043), then the user's message.
pub(super) fn first_message(message: &str, repo: &str, autonomy: ProjectAutonomy) -> String {
    format!(
        "{INSTRUCTIONS}\nThe project's repository is {repo}, the user's own checkout: leave it \
         alone. Read the code in your working directory instead, a copy of the integration \
         branch's latest commit that Parallax resets each time it starts you, so it doesn't have \
         the user's uncommitted changes, and nothing written there is kept.\n\n{} Each question \
         Parallax wakes you with names the level as it is then, since the user can change \
         it.\n\nThe user's message:\n{message}",
        level(autonomy)
    )
}
