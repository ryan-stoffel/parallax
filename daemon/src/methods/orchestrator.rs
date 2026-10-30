//! `orchestrator/list`, `orchestrator/create`, `orchestrator/start`, which starts an orchestrator
//! behind the `orchestrator` capability (0024), and `orchestrator/update`, which renames an
//! orchestrator or sets its icon behind the `orchestratorEdit` capability (PLX-227, 0032), its
//! permission mode behind `orchestratorPermission` (0042), its autonomy level behind
//! `orchestratorAutonomy` (0043), its base branch behind `integrationBranch` (0045), how its
//! children are placed behind `orchestratorPlacement` (0046), its checks behind `checks` (PLX-411,
//! 0045), or the computer its children run on behind `orchestratorComputer` (0057),
//! `orchestrator/delete`, behind `orchestratorDelete` (PLX-338), and `orchestrator/fromThreads`,
//! behind `orchestratorFromThreads` (0042).

use std::collections::HashSet;
use std::path::{Component, Path};
use std::sync::Arc;

use jiff::Timestamp;
use parallax_protocol::jsonrpc::ErrorObject;
use parallax_protocol::{
    AgentRunResult, ChosenIcon, ErrorKind, InboxKind, OrchestratorAutonomy,
    OrchestratorCreateParams, OrchestratorCreateResult, OrchestratorDeleteParams,
    OrchestratorDeleteResult, OrchestratorFreshParams, OrchestratorFromThreadsParams,
    OrchestratorFromThreadsResult, OrchestratorListParams, OrchestratorListResult,
    OrchestratorPermission, OrchestratorStartParams, OrchestratorUpdateParams,
    OrchestratorUpdateResult, ParallaxEvent, RunId, ScopeId,
};
use tracing::{info, warn};
use uuid::Uuid;

use super::Context;
use crate::agents::{self, orchestrator};
use crate::backend::check_argument;
use crate::dispatcher::{self, Action, Command, Outcome};
use crate::repo;
use crate::server::Daemon;
use crate::store::{self, store_error};

/// Every orchestrator, oldest first, with the event log's `seq` from before the read, to subscribe
/// after.
pub(crate) async fn list(
    context: &Context,
    _: OrchestratorListParams,
) -> Result<OrchestratorListResult, ErrorObject> {
    let (orchestrators, seq) = context
        .daemon
        .reader
        .snapshot(&context.cancel, move |store| {
            let rows = store
                .list_orchestrators()
                .map_err(|error| store_error(&error))?;
            rows.into_iter()
                .map(|row| {
                    let orchestrator_run = orchestrator::orchestrator_of(store, row.id)?;
                    store::orchestrator(row, orchestrator_run)
                })
                .collect::<Result<_, _>>()
        })
        .await?;
    Ok(OrchestratorListResult { orchestrators, seq })
}

/// Creates an orchestrator, or returns the one that already has this id and these params.
///
/// `orchestrator.created` is appended only when the row is new. The store's thread is the only
/// writer, since the lock admits one plxd per data folder, so the lookup before the create can't
/// race another create.
///
/// Only a new orchestrator's `repoPath` has to be a repository, so a retry still returns the
/// orchestrator after its folder is gone.
///
/// A new orchestrator's integration branch and its worktree are cut after the row is written, as
/// best effort (0045): a repository with no commit yet has nothing to cut from, and the first run
/// started in the orchestrator tries again.
pub(crate) async fn create(
    context: &Context,
    params: OrchestratorCreateParams,
) -> Result<OrchestratorCreateResult, ErrorObject> {
    Ok(create_or_get(context, params).await?.0)
}

/// [`create`], and whether the orchestrator already existed.
async fn create_or_get(
    context: &Context,
    params: OrchestratorCreateParams,
) -> Result<(OrchestratorCreateResult, bool), ErrorObject> {
    check(&params)?;
    let data_dir = context.daemon.data_dir.clone();
    let (mut result, existed) = context
        .daemon
        .store
        .run(&context.cancel, move |store| {
            let (id, fields) = store::fields(params);
            let existed = store
                .get_orchestrator(id)
                .map_err(|error| store_error(&error))?
                .is_some();
            if !existed {
                repo::check(Path::new(&fields.repo_path)).map_err(|error| {
                    ErrorObject::parallax(ErrorKind::NotARepository, error.to_string())
                })?;
            }
            let row = store
                .create_orchestrator(id, &fields)
                .map_err(|error| store_error(&error))?;
            let orchestrator_run = orchestrator::orchestrator_of(store, id)?;
            let orchestrator = store::orchestrator(row, orchestrator_run)?;
            if !existed {
                let seq = store.stage(
                    orchestrator.created_at,
                    None,
                    ParallaxEvent::OrchestratorCreated {
                        orchestrator: orchestrator.clone(),
                    },
                );
                info!(orchestrator = %orchestrator.id, seq, "created an orchestrator");
                // Best effort (#155): an orchestrator's shared context folder is also ensured
                // lazily on its first `context/*` call, so a failure here never blocks orchestrator
                // creation.
                if let Err(error) = crate::context::ensure_dir(&data_dir, orchestrator.id) {
                    warn!(orchestrator = %orchestrator.id, %error, "could not create the shared context folder");
                }
            }
            Ok((OrchestratorCreateResult { orchestrator }, existed))
        })
        .await?;
    if !existed {
        // Detached, so a dropped connection never leaves a worktree half checked out.
        let id = result.orchestrator.id;
        let cut = context
            .detached(|daemon| async move { agents::integration(&daemon, id).await })
            .await;
        match cut {
            Ok(Some(row)) => {
                result.orchestrator.base_branch = row.base_branch;
                result.orchestrator.integration_branch = row.integration_branch;
            }
            Ok(None) => {}
            Err(error) => {
                warn!(orchestrator = %result.orchestrator.id, %error, "could not cut the orchestrator's integration branch");
            }
        }
    }
    Ok((result, existed))
}

/// Starts the orchestrator, detached from the request as `agent/start` is, so a dropped
/// connection never leaves it half started.
pub(crate) async fn start(
    context: &Context,
    params: OrchestratorStartParams,
) -> Result<AgentRunResult, ErrorObject> {
    super::agent::check_message("prompt", &params.prompt, &params.images)?;
    let run = context
        .detached(|daemon| orchestrator::start(daemon, params))
        .await?;
    Ok(AgentRunResult { run })
}

/// `orchestrator/fresh` (PLX-937, decision 0079).
pub(crate) async fn fresh(
    context: &Context,
    params: OrchestratorFreshParams,
) -> Result<AgentRunResult, ErrorObject> {
    let run = orchestrator::fresh(&context.daemon, params.orchestrator).await?;
    Ok(AgentRunResult { run })
}

/// Makes an orchestrator from threads (0042): checks them, creates the orchestrator on their
/// repository as `orchestrator/create` does, starts its orchestrator, and moves each thread into it
/// as the orchestrator's child. The orchestrator and the moves are detached from the request, as
/// `orchestrator/start` is. Each step is idempotent, so a retry finishes what a failed request
/// left, except an orchestrator that can't start: that refusal would repeat, so the orchestrator
/// this call created is removed.
pub(crate) async fn from_threads(
    context: &Context,
    params: OrchestratorFromThreadsParams,
) -> Result<OrchestratorFromThreadsResult, ErrorObject> {
    let OrchestratorFromThreadsParams {
        id,
        run_id,
        name,
        permission,
        threads,
        account,
    } = params;
    if threads.is_empty() {
        return Err(ErrorObject::invalid_params(
            "threads must name at least one thread",
        ));
    }
    if threads.iter().collect::<HashSet<_>>().len() != threads.len() {
        return Err(ErrorObject::invalid_params(
            "threads must not name a thread twice",
        ));
    }
    let (repo_path, backends) = threads_repo(context, id, threads.clone()).await?;
    for (thread, backend) in backends {
        agents::fits_mode(&context.daemon, &backend, permission).map_err(|mut error| {
            error.message = format!("thread {thread}: {}", error.message);
            error
        })?;
    }
    let (mut created, existed) = create_or_get(
        context,
        OrchestratorCreateParams {
            id,
            name,
            repo_path,
            icon: None,
            permission: Some(permission),
            autonomy: None,
            base_branch: None,
        },
    )
    .await?;
    let start = OrchestratorStartParams {
        orchestrator: id,
        run_id,
        prompt: orchestrator::from_threads_prompt(&threads),
        account,
        model: None,
        effort: None,
        permission: None,
        images: Vec::new(),
        approvals: true,
    };
    let run = context
        .detached(|daemon| async move {
            let run = match orchestrator::start(Arc::clone(&daemon), start).await {
                Ok(run) => run,
                Err(error) => {
                    // A retry would be refused the same way, so don't leave an empty Orchestrator.
                    if !existed && let Err(error) = remove(Arc::clone(&daemon), id, None).await {
                        warn!(orchestrator = %id, %error, "could not remove the orchestrator its orchestrator didn't start in");
                    }
                    return Err(error);
                }
            };
            for thread in threads {
                agents::join(&daemon, thread, id, run_id).await?;
            }
            Ok(run)
        })
        .await?;
    created.orchestrator.run = Some(run_id);
    Ok(OrchestratorFromThreadsResult {
        orchestrator: created.orchestrator,
        run,
    })
}

/// The path of the repository `threads` are all on, with each thread's backend, or why they can't
/// make Orchestrator `orchestrator`: each must be a thread on a repo entry, not the scratch one,
/// with a worktree of its own, and in no orchestrator but this one, which a retry finds them in.
/// One plxd is one host, so threads on one repo entry share a host too.
async fn threads_repo(
    context: &Context,
    orchestrator: ScopeId,
    threads: Vec<RunId>,
) -> Result<(String, Vec<(RunId, String)>), ErrorObject> {
    context
        .daemon
        .store
        .run(&context.cancel, move |db| {
            let mut repo: Option<parallax_store::Repo> = None;
            let mut backends = Vec::new();
            for id in threads {
                let not_found = || {
                    ErrorObject::parallax(
                        ErrorKind::ThreadNotFound,
                        format!("no thread has run id {id}"),
                    )
                };
                let thread = db
                    .get_thread(id.into())
                    .map_err(|e| store_error(&e))?
                    .ok_or_else(not_found)?;
                let run = db
                    .get_run(id.into())
                    .map_err(|e| store_error(&e))?
                    .ok_or_else(not_found)?;
                let in_other_orchestrator = run.fields.project_id != Uuid::from(orchestrator)
                    && db
                        .get_orchestrator(run.fields.project_id)
                        .map_err(|e| store_error(&e))?
                        .is_some();
                // A child `thread/start` made has the orchestrator's id as its repo, not an
                // entry's.
                let entry = db.get_repo(thread.repo_id).map_err(|e| store_error(&e))?;
                let Some(entry) = entry.filter(|_| !in_other_orchestrator) else {
                    return Err(ErrorObject::invalid_params(format!(
                        "thread {id} is already in an orchestrator"
                    )));
                };
                if entry.fields.scratch {
                    return Err(ErrorObject::invalid_params(format!(
                        "thread {id} has no repository, so it has no branch to land"
                    )));
                }
                if db
                    .get_worktree(id.into())
                    .map_err(|e| store_error(&e))?
                    .is_none()
                {
                    return Err(ErrorObject::invalid_params(format!(
                        "thread {id} has no worktree of its own: it works in the repository's \
                         checkout, or its worktree was removed"
                    )));
                }
                match &repo {
                    Some(first) if first.id != entry.id => {
                        return Err(ErrorObject::invalid_params(format!(
                            "the threads are on two repositories, {} and {}",
                            first.fields.path, entry.fields.path
                        )));
                    }
                    Some(_) => {}
                    None => repo = Some(entry),
                }
                backends.push((id, run.fields.backend));
            }
            repo.map(|repo| (repo.fields.path, backends))
                .ok_or_else(|| ErrorObject::invalid_params("threads must name at least one thread"))
        })
        .await
}

/// Renames an orchestrator or sets its icon, permission mode, autonomy level, base branch,
/// automatic landing, placement settings, checks, or computer, and appends `orchestrator.updated`
/// when that changed anything. Runs pick up a new mode when they next start a CLI process (0042),
/// questions a new level when they are next asked (0043), and waiting children new placement
/// settings at once (0046). A new proposal for its checks adds a `needsYou` item for the user to
/// confirm it (PLX-411). Ask me also sends the questions already open to Needs you (PLX-474).
///
/// `orchestrator.updated` and the escalated questions' `inbox.added` events are staged in their
/// rows' transaction and published once it commits (0052), so a subscriber after a
/// `orchestrator/list` or `inbox/list` snapshot's `seq` never misses them. `updatedAt` stays as it
/// is (0032).
pub(crate) async fn update(
    context: &Context,
    mut params: OrchestratorUpdateParams,
) -> Result<OrchestratorUpdateResult, ErrorObject> {
    if let Some(name) = &params.name {
        check_name(name)?;
    }
    if let Some(icon) = &params.icon {
        check_icon(icon)?;
    }
    check_permission(params.permission)?;
    check_autonomy(params.autonomy)?;
    check_base_branch(params.base_branch.as_deref())?;
    if params
        .max_children
        .is_some_and(|max| !(1..=MAX_CHILDREN).contains(&max))
    {
        return Err(ErrorObject::invalid_params(format!(
            "maxChildren must be from 1 to {MAX_CHILDREN}"
        )));
    }
    for (name, checks) in [
        ("checks", &mut params.checks),
        ("proposedChecks", &mut params.proposed_checks),
    ] {
        if let Some(command) = checks {
            *command = check_checks(name, command)?;
        }
    }
    if let Some(computer) = &params.computer {
        check_computer(context, params.orchestrator, computer).await?;
    }
    let proposal = params
        .proposed_checks
        .clone()
        .filter(|command| params.checks.is_none() && !command.is_empty());
    let ask_me = params.autonomy == Some(OrchestratorAutonomy::Ask);
    let (result, proposed) = context
        .daemon
        .store
        .run(&context.cancel, move |store| {
            let (id, edit) = store::edit(params);
            let (row, changed) = store
                .update_orchestrator(id, &edit)
                .map_err(|error| store_error(&error))?;
            let orchestrator_run = orchestrator::orchestrator_of(store, id)?;
            let orchestrator = store::orchestrator(row, orchestrator_run)?;
            if changed {
                let seq = store.stage(
                    Timestamp::now(),
                    None,
                    ParallaxEvent::OrchestratorUpdated {
                        orchestrator: orchestrator.clone(),
                    },
                );
                info!(orchestrator = %orchestrator.id, seq, "updated an orchestrator");
            }
            if ask_me {
                super::question::escalate_open(store, orchestrator.id)?;
            }
            let proposed = proposal.filter(|_| changed).zip(orchestrator.run);
            Ok((OrchestratorUpdateResult { orchestrator }, proposed))
        })
        .await?;
    // More room, or API keys allowed, may start a waiting child (0046).
    context.daemon.agents.placement.notify_one();
    if let Some((command, orchestrator_run)) = proposed {
        let text = format!(
            "The orchestrator proposes these checks, to run after each landing: {command}. \
             Confirm or edit them in the orchestrator's settings."
        );
        let orchestrator = result.orchestrator.id;
        super::inbox::add(
            &context.daemon,
            orchestrator,
            orchestrator_run,
            InboxKind::NeedsYou,
            text,
        )
        .await;
    }
    Ok(result)
}

/// The most children an orchestrator may run at once (0046).
const MAX_CHILDREN: u32 = 100;

/// A checks command as `orchestrator/update` stores it, trimmed: at most [`MAX_CHECKS_BYTES`], with
/// no NUL, which no shell can run (PLX-411).
fn check_checks(name: &str, command: &str) -> Result<String, ErrorObject> {
    let command = command.trim();
    if command.len() > MAX_CHECKS_BYTES {
        return Err(ErrorObject::invalid_params(format!(
            "{name} must be at most {MAX_CHECKS_BYTES} bytes"
        )));
    }
    if command.contains('\0') {
        return Err(ErrorObject::invalid_params(format!(
            "{name} must not contain NUL"
        )));
    }
    Ok(command.to_owned())
}

/// The longest checks command `orchestrator/update` takes.
const MAX_CHECKS_BYTES: usize = 4096;

/// `orchestrator/update`'s `computer` (0057). Refused with `unsupportedOption` while plxd doesn't
/// follow it ([`Daemon::orchestrator_computer`]). Otherwise empty, which clears it, or a node
/// 0056's device filter admits, on an orchestrator whose repository has an `origin` for the device
/// to find its copy by. Whether the device is online isn't checked, so the user can pick it ahead
/// of time.
async fn check_computer(
    context: &Context,
    orchestrator: ScopeId,
    computer: &str,
) -> Result<(), ErrorObject> {
    let daemon = &context.daemon;
    if !daemon.orchestrator_computer {
        return Err(ErrorObject::parallax(
            ErrorKind::UnsupportedOption,
            "computer needs the orchestratorComputer capability, which this plxd doesn't have",
        ));
    }
    if computer.is_empty() {
        return Ok(());
    }
    let id = orchestrator.into();
    let row = daemon
        .reader
        .run(&context.cancel, move |db| {
            db.get_orchestrator(id)
                .map_err(|error| store_error(&error))?
                .ok_or_else(|| store_error(&parallax_store::StoreError::NotFound { id }))
        })
        .await?;
    let status =
        daemon.connect.tailnet.status().await.map_err(|error| {
            ErrorObject::invalid_params(format!("Can't check {computer}: {error}"))
        })?;
    if status.own_peer(computer).is_none() {
        return Err(ErrorObject::invalid_params(format!(
            "{computer} isn't one of this computer's devices"
        )));
    }
    if crate::repo_clone::origin(daemon, Path::new(&row.repo_path))
        .await
        .is_none()
    {
        return Err(ErrorObject::invalid_params(
            "This repository has no origin, so another computer can't find it.",
        ));
    }
    Ok(())
}

/// Deletes an orchestrator (PLX-338), detached from the request as `thread/delete` is, so a dropped
/// connection never leaves it half deleted.
pub(crate) async fn delete(
    context: &Context,
    params: OrchestratorDeleteParams,
) -> Result<OrchestratorDeleteResult, ErrorObject> {
    let command_id = context.command_id;
    context
        .detached(|daemon| remove(daemon, params.orchestrator, command_id))
        .await
}

/// Deletes each of `orchestrator`'s runs through its actor, as `thread/delete` deletes a thread's,
/// orchestrators first so none starts another run meanwhile. Then the dispatcher's
/// `orchestrator.delete` (0059), once no run is left, deletes the orchestrator's row and appends
/// `orchestrator.deleted` in one transaction, and its `orchestrator.cleanup` effect removes the
/// integration worktree, keeping its branch (0045), the orchestrator's worktree (0042), and its
/// shared context folder. Each pass looks again, for a run an orchestrator started while it was
/// stopping; a worker is recorded only while its scope exists, so none can start after the row is
/// gone. A crash midway leaves the orchestrator listed, and deleting it again finishes the job. A
/// retry of a delete that committed answers from its receipt.
async fn remove(
    daemon: Arc<Daemon>,
    orchestrator: ScopeId,
    command_id: Option<Uuid>,
) -> Result<OrchestratorDeleteResult, ErrorObject> {
    if dispatcher::replayed(
        &daemon,
        command_id,
        orchestrator,
        dispatcher::ORCHESTRATOR_DELETE,
    )
    .await?
    {
        return Ok(OrchestratorDeleteResult {});
    }
    // One id for every pass: a busy pass stores nothing.
    let command_id = Some(command_id.unwrap_or_else(Uuid::now_v7));
    loop {
        let command = Command::new(command_id, orchestrator, Action::DeleteOrchestrator);
        let runs = match daemon.dispatcher.dispatch(&daemon, command).await? {
            Outcome::Done(_) => break,
            Outcome::Busy(runs) => runs,
        };
        for run in runs {
            let run = RunId::try_from(run).map_err(|_| {
                ErrorObject::internal_error(format!("the stored run {run} has an invalid id"))
            })?;
            match agents::delete(&daemon, run, true, None).await {
                Ok(()) => {}
                // Another `orchestrator/delete` got to it first.
                Err(error)
                    if error
                        .parallax_data()
                        .is_some_and(|data| data.kind == ErrorKind::RunNotFound) => {}
                Err(error) => return Err(error),
            }
        }
    }
    info!(%orchestrator, "deleted an orchestrator");
    Ok(OrchestratorDeleteResult {})
}

/// The longest `name` plxd accepts, in bytes.
const MAX_NAME_BYTES: usize = 256;

/// The longest `repoPath` plxd accepts, in bytes: macOS's `PATH_MAX`.
const MAX_REPO_PATH_BYTES: usize = 1024;

/// The longest icon name plxd accepts, in characters (0032).
const MAX_ICON_NAME_CHARS: usize = 64;

/// The longest icon color plxd accepts, in characters (0032).
pub(crate) const MAX_ICON_COLOR_CHARS: usize = 32;

// The limits also bound every `orchestrator.created` and `orchestrator.updated` event, and with it
// the event log's memory, far below the frame limit.
fn check(params: &OrchestratorCreateParams) -> Result<(), ErrorObject> {
    let OrchestratorCreateParams {
        name,
        repo_path,
        icon,
        permission,
        autonomy,
        base_branch,
        ..
    } = params;
    check_name(name)?;
    check_permission(*permission)?;
    check_autonomy(*autonomy)?;
    check_base_branch(base_branch.as_deref())?;
    if let Some(icon) = icon {
        check_icon(icon)?;
    }
    if repo_path.len() > MAX_REPO_PATH_BYTES {
        return Err(ErrorObject::invalid_params(format!(
            "repoPath must be at most {MAX_REPO_PATH_BYTES} bytes"
        )));
    }
    if repo_path.contains('\0') {
        return Err(ErrorObject::invalid_params("repoPath must not contain NUL"));
    }
    if !Path::new(repo_path).is_absolute() {
        return Err(ErrorObject::invalid_params(
            "repoPath must be an absolute path",
        ));
    }
    // One folder has one spelling, so the stored path names the folder that was checked and a
    // retry spelled differently is a conflict. `components()` drops a `.` inside the path, so
    // the text is checked for those too.
    let has_dot_segment = Path::new(repo_path)
        .components()
        .any(|component| matches!(component, Component::ParentDir | Component::CurDir))
        || repo_path.contains("/./")
        || repo_path.ends_with("/.");
    if has_dot_segment {
        return Err(ErrorObject::invalid_params(
            "repoPath must not contain . or .. segments",
        ));
    }
    Ok(())
}

/// The rules for an orchestrator's name, in `orchestrator/create` and `orchestrator/update` alike.
fn check_name(name: &str) -> Result<(), ErrorObject> {
    if name.trim().is_empty() {
        return Err(ErrorObject::invalid_params("name must not be empty"));
    }
    if name.len() > MAX_NAME_BYTES {
        return Err(ErrorObject::invalid_params(format!(
            "name must be at most {MAX_NAME_BYTES} bytes"
        )));
    }
    if name.contains('\0') {
        return Err(ErrorObject::invalid_params("name must not contain NUL"));
    }
    Ok(())
}

/// An orchestrator runs in Auto or Bypass Permissions (0042), so a mode this plxd doesn't know is
/// refused.
fn check_permission(permission: Option<OrchestratorPermission>) -> Result<(), ErrorObject> {
    if permission == Some(OrchestratorPermission::Unknown) {
        return Err(ErrorObject::invalid_params(
            "permission must be auto or bypass",
        ));
    }
    Ok(())
}

/// A level this plxd doesn't know would leave nobody sure who answers (0043), so it is refused.
fn check_autonomy(autonomy: Option<OrchestratorAutonomy>) -> Result<(), ErrorObject> {
    if autonomy == Some(OrchestratorAutonomy::Unknown) {
        return Err(ErrorObject::invalid_params(
            "autonomy must be ask, routine, or full",
        ));
    }
    Ok(())
}

/// A base branch is passed to git as an argument (0045), so it is checked as one. Whether it names
/// a local or remote-tracking branch is checked when the integration branch is cut.
fn check_base_branch(base: Option<&str>) -> Result<(), ErrorObject> {
    if let Some(base) = base {
        if base.len() > MAX_NAME_BYTES {
            return Err(ErrorObject::invalid_params(format!(
                "baseBranch must be at most {MAX_NAME_BYTES} bytes"
            )));
        }
        check_argument("baseBranch", base)
            .map_err(|e| ErrorObject::invalid_params(e.to_string()))?;
    }
    Ok(())
}

/// An icon's name and color are keys of `a-z`, `0-9`, and `-` (0032). plxd never reads them, so
/// that is all it checks. Its image is capped and checked as a prompt's are (0038).
pub(crate) fn check_icon(icon: &ChosenIcon) -> Result<(), ErrorObject> {
    check_key("icon.name", &icon.name, MAX_ICON_NAME_CHARS)?;
    if let Some(color) = &icon.color {
        check_key("icon.color", color, MAX_ICON_COLOR_CHARS)?;
    }
    if let Some(image) = &icon.image {
        crate::images::check_icon(image)?;
    }
    Ok(())
}

pub(crate) fn check_key(field: &str, key: &str, max: usize) -> Result<(), ErrorObject> {
    let allowed = |byte: u8| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-';
    if (1..=max).contains(&key.len()) && key.bytes().all(allowed) {
        Ok(())
    } else {
        Err(ErrorObject::invalid_params(format!(
            "{field} must be 1 to {max} characters of a-z, 0-9, and -"
        )))
    }
}
