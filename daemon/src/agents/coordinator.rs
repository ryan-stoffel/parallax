//! A project's coordinator chat (RYA-41, decision 0024): a no-write run with wispd's MCP tools
//! bound to the project and to the run's own id as its coordinator thread (0019).
//!
//! `project/start` records it like any run, without a worktree row, and hands it to the same
//! actor as a worker's, so `agent/send`, `agent/cancel`, `agent/events`, the `agent.*` events, and
//! resuming after a restart work unchanged. The actor runs it in the project's own detached
//! worktree, [`crate::paths::DataDir::coordinator_dir`], which it moves to the repository's `HEAD`
//! before each CLI process (RYA-171). A project has one live coordinator: a new run replaces the
//! last one unless that one is still starting or running, and takes over the same worktree.

use std::collections::HashMap;
use std::sync::Arc;

use tracing::info;
use uuid::Uuid;
use wisp_protocol::jsonrpc::ErrorObject;
use wisp_protocol::{AgentRun, ErrorKind, ProjectStartParams, Role, RunId, WispEvent};
use wisp_store::{RunFields, RunState};

use super::actor::Actor;
use super::convert::{NO_WRITE, RUNNING, STARTING, agent_run, option_name};
use super::worker::worker_unavailable;
use super::{RunOptions, existing, prepare, requested_account, store, store_error};
use crate::backend::Backend;
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
        images,
    } = params;
    let _starting = daemon.agents.start_guard(run_id).await;
    let options = RunOptions {
        model,
        effort,
        permission: None,
    };
    let mut fields = RunFields {
        project_id: project.into(),
        prompt: prompt.clone(),
        requested_account: requested_account(account.as_ref()),
        policy: NO_WRITE.to_owned(),
        backend: String::new(),
        coordinator_thread: Some(Uuid::from(run_id)),
        model: options.model.clone(),
        effort: options.effort.and_then(option_name),
        permission: None,
    };
    if let Some(run) = existing(&daemon, run_id, &fields).await? {
        return Ok(run);
    }
    let (prepared, repo_path) =
        prepare(&daemon, project, run_id, account, Role::Coordinator).await?;
    options.check(prepared.resolved.backend())?;
    fields.backend = prepared.resolved.backend().name().into();
    let state = RunState {
        status: STARTING.to_owned(),
        account_id: prepared.resolved.account_id(),
        ..RunState::default()
    };
    // One store job, so two starts with different run ids can't both find no live coordinator.
    let row = store(&daemon, move |db| {
        if db
            .get_project(project.into())
            .map_err(|e| store_error(&e))?
            .is_none()
        {
            return Err(ErrorObject::wisp(
                ErrorKind::ProjectNotFound,
                format!("no project has id {project}"),
            ));
        }
        if let Some(current) = newest(db, project.into())?
            && (current.state.status == STARTING || current.state.status == RUNNING)
        {
            return Err(ErrorObject::wisp(
                ErrorKind::IdConflict,
                format!(
                    "project {project}'s coordinator, run {}, is running; message it with \
                     agent/send, or stop it before starting over",
                    current.id
                ),
            ));
        }
        db.create_run(run_id.into(), &fields, &state)
            .map_err(|e| store_error(&e))
    })
    .await?;
    let snapshot = agent_run(&row, None)?;
    daemon
        .log
        .append(
            snapshot.created_at,
            Some(project),
            WispEvent::AgentStarted {
                run_id,
                run: Some(snapshot),
            },
        )
        .await;
    info!(run = %run_id, project = %project, backend = %row.fields.backend, "created a project's coordinator");

    let mut actor = Actor::new(Arc::clone(&daemon), row, None, HashMap::new());
    let message = first_message(&prompt, &repo_path);
    actor
        .launch(prepared, message, images, None, None, None)
        .await;
    // The actor owns a live CLI from here on, so it is spawned whatever the snapshot says.
    let run = actor.snapshot();
    daemon.agents.spawn(actor);
    run
}

/// Refuses a backend that can't run a coordinator (0004: Claude Code and Codex; Codex's is
/// RYA-39).
pub(super) fn check_backend(backend: &dyn Backend) -> Result<(), ErrorObject> {
    if backend.capabilities().coordinator {
        return Ok(());
    }
    Err(worker_unavailable(format!(
        "the {} backend can't run a project's coordinator yet; choose a Claude Code account",
        backend.name()
    )))
}

/// `project`'s coordinator: its newest no-write run. `project/start` with a new run id replaces it
/// unless it is starting or running, so one whose session can't be resumed never locks the
/// project.
pub(crate) fn coordinator_of(
    db: &wisp_store::Store,
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
fn newest(db: &wisp_store::Store, project: Uuid) -> Result<Option<wisp_store::Run>, ErrorObject> {
    let runs = db.list_runs(Some(project)).map_err(|e| store_error(&e))?;
    Ok(runs
        .into_iter()
        .rev()
        .find(|run| run.fields.policy == NO_WRITE))
}

/// The coordinator's first message: its instructions, where it is, then the user's message.
fn first_message(message: &str, repo: &str) -> String {
    format!(
        "{INSTRUCTIONS}\nThe project's repository is {repo}. Your working directory is a copy of \
         its latest commit, updated each time wispd starts you, so it doesn't have the user's \
         uncommitted changes.\n\nThe user's message:\n{message}"
    )
}
