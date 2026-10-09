//! Normal threads (#110, decision 0017): agents with no coordinator, behind the `threads`
//! capability.
//!
//! A thread is an agent run that belongs to a repo entry instead of a project: its run's
//! `project_id`, and so its `agent.*` events and `agent/list`, use the entry's id. The runner
//! ([`crate::agents`]) starts, streams, messages, cancels, commits, and resumes it exactly as it
//! does a worker. This module adds the repo entries, the scratch repositories that threads with
//! no repo run in, archiving, and deleting.
//!
//! Each thread with no repo gets its own scratch repository at `<data folder>/scratch/<run id>`,
//! so one quick chat can't read another's work. They all belong to plxd's scratch entry, whose
//! path is the `scratch` folder, made on first use.
//!
//! A thread can have a parent, the run that launched it, a fork origin, a title, and a settled
//! flag (decision 0041). Deleting a run leaves its children with no parent and its forks with no
//! origin.
//!
//! `thread/fork` (decision 0050) makes a thread that continues another's conversation from one of
//! its turns, in a workspace of the same kind. It starts no CLI: its log begins with the parent's
//! transcript up to that turn, and its first message either forks the parent's vendor session
//! (the actor's `fork_source`) or hands that transcript to a new session, as 0014's move does.
//!
//! `thread/start` with `project` starts a Project's child (0042) through the same
//! [`agents::create`] as a Project's other runs, so it runs in the Project's mode with its header,
//! cut from the integration branch, and wakes the coordinator. Its scope and thread row's repo are
//! the Project, and its parent the Project's current coordinator, or none before it has one.
//!
//! A thread started with `checkout` gets no worktree: it works in its repo entry's own checkout,
//! on the branch the user has out or the one `checkoutRef` switches it to, and plxd leaves its
//! changes there uncommitted. A thread with no repo has no checkout, so it can't ask for one.
//!
//! `thread/start` with `naming` returns as soon as the thread has started, and [`crate::naming`]
//! names it and its branch in the background (0058).

use std::path::{Component, Path, PathBuf};
use std::sync::Arc;

use jiff::Timestamp;
use parallax_protocol::jsonrpc::ErrorObject;
use parallax_protocol::{
    AgentOutputItem, AgentStatus, ErrorKind, ForkedFrom, MAX_THREAD_TITLE_BYTES, ParallaxEvent,
    ProjectId, Repo, RepoAddParams, RepoAddResult, RepoId, RepoRefsParams, RepoRefsResult,
    RepoUpdateParams, RepoUpdateResult, RunId, Thread, ThreadArchiveParams, ThreadArchiveResult,
    ThreadDeleteResult, ThreadForkParams, ThreadListResult, ThreadSearchParams, ThreadSearchResult,
    ThreadStartParams, ThreadStartResult, ThreadUpdateParams, ThreadUpdateResult, TurnId,
};
use parallax_store::{RepoFields, ThreadFields, ThreadUpdate};
use tokio_util::sync::CancellationToken;
use tracing::{info, warn};
use uuid::Uuid;

use crate::agents::convert::{agent_run, option_value};
use crate::agents::{self, NewFork, NewRun, NewThread, RunOptions};
use crate::backend::check_argument;
use crate::orchestrator::{self, Action, Command, Lane};
use crate::repo;
use crate::server::Daemon;
use crate::worktree::valid_branch_slug;

/// The folder under plxd's data folder that holds threads' scratch repositories.
const SCRATCH_DIR: &str = "scratch";

/// The scratch entry's name.
const SCRATCH_NAME: &str = "No Repo";

const MAX_PATH_BYTES: usize = 1024;

/// How many threads `thread/search` returns by default, and at most.
const DEFAULT_SEARCH_LIMIT: u32 = 20;
const MAX_SEARCH_LIMIT: u32 = 100;

/// The longest query `thread/search` takes, in bytes.
const MAX_QUERY_BYTES: usize = 1024;

async fn store<T: Send + 'static>(
    daemon: &Daemon,
    job: impl FnOnce(&mut crate::store::Tx) -> Result<T, ErrorObject> + Send + 'static,
) -> Result<T, ErrorObject> {
    daemon.store.run(&CancellationToken::new(), job).await
}

fn store_error(error: &parallax_store::StoreError) -> ErrorObject {
    agents::store_error(error)
}

fn corrupt(what: &str, id: Uuid) -> ErrorObject {
    ErrorObject::internal_error(format!("the stored {what} {id} has an invalid id"))
}

/// A store row as the protocol's repo entry.
pub(crate) fn repo_entry(row: parallax_store::Repo) -> Result<Repo, ErrorObject> {
    Ok(Repo {
        id: RepoId::try_from(row.id).map_err(|_| corrupt("repo entry", row.id))?,
        name: row.fields.name,
        path: row.fields.path,
        scratch: row.fields.scratch,
        icon: row.icon.map(crate::store::protocol_icon),
        created_at: row.created_at,
    })
}

/// A store row as the protocol's thread.
pub(crate) fn thread_entry(row: &parallax_store::Thread) -> Result<Thread, ErrorObject> {
    let run = |id: Uuid| RunId::try_from(id).map_err(|_| corrupt("thread", row.id));
    let forked_from = row
        .fields
        .forked_from
        .map(|from| {
            Ok::<_, ErrorObject>(ForkedFrom {
                run: run(from.run)?,
                turn: TurnId::try_from(from.turn).map_err(|_| corrupt("thread", row.id))?,
            })
        })
        .transpose()?;
    Ok(Thread {
        id: run(row.id)?,
        repo: RepoId::try_from(row.repo_id).map_err(|_| corrupt("thread", row.id))?,
        archived: row.archived,
        created_at: row.created_at,
        seen_at: row.seen_at,
        snoozed_until: row.snoozed_until,
        last_prompt_at: Some(row.last_prompt_at),
        parent: row.parent.map(run).transpose()?,
        forked_from,
        title: row.fields.title.clone(),
        settled: row.settled,
    })
}

/// A title as `thread/start` and `thread/update` take it: trimmed, with empty meaning none, and
/// at most [`MAX_THREAD_TITLE_BYTES`] bytes.
fn check_title(title: &str) -> Result<Option<String>, ErrorObject> {
    let title = title.trim();
    if title.len() > MAX_THREAD_TITLE_BYTES {
        return Err(ErrorObject::invalid_params(format!(
            "title must be at most {MAX_THREAD_TITLE_BYTES} bytes"
        )));
    }
    Ok((!title.is_empty()).then(|| title.to_owned()))
}

fn thread_not_found(id: RunId) -> ErrorObject {
    ErrorObject::parallax(
        ErrorKind::ThreadNotFound,
        format!("no thread has run id {id}"),
    )
}

/// The repository a run's scope stands for: a project's, or a repo entry's path. For the scratch
/// entry it is the folder that holds the scratch repositories.
pub(crate) fn scope_path(
    db: &parallax_store::Store,
    scope: ProjectId,
) -> Result<String, ErrorObject> {
    if let Some(project) = db.get_project(scope.into()).map_err(|e| store_error(&e))? {
        return Ok(project.repo_path);
    }
    if let Some(repo) = db.get_repo(scope.into()).map_err(|e| store_error(&e))? {
        return Ok(repo.fields.path);
    }
    Err(ErrorObject::parallax(
        ErrorKind::ProjectNotFound,
        format!("no project has id {scope}"),
    ))
}

/// Whether `scope` is plxd's scratch entry, whose threads have no repository of the user's.
pub(crate) fn is_scratch(
    db: &parallax_store::Store,
    scope: ProjectId,
) -> Result<bool, ErrorObject> {
    Ok(db
        .get_repo(scope.into())
        .map_err(|e| store_error(&e))?
        .is_some_and(|repo| repo.fields.scratch))
}

/// The scope whose context folder run `run` of `scope` writes notes to: the run's own id for a
/// thread with no repo, so one quick chat never reads another's notes, and `scope` otherwise.
pub(crate) fn context_scope(
    db: &parallax_store::Store,
    scope: ProjectId,
    run: RunId,
) -> Result<ProjectId, ErrorObject> {
    if is_scratch(db, scope)? {
        ProjectId::try_from(Uuid::from(run)).map_err(|_| corrupt("run", run.into()))
    } else {
        Ok(scope)
    }
}

/// The thread row of run `id`, for a retried `thread/start`. A run that isn't a thread's has
/// its id taken.
pub(crate) async fn existing_thread(
    daemon: &Arc<Daemon>,
    id: RunId,
) -> Result<parallax_store::Thread, ErrorObject> {
    store(daemon, move |db| {
        db.get_thread(id.into())
            .map_err(|e| store_error(&e))?
            .ok_or_else(|| {
                ErrorObject::parallax(
                    ErrorKind::IdConflict,
                    format!("run {id} exists and is not a thread"),
                )
            })
    })
    .await
}

/// Stages a new thread's `thread.started`, a host-level event, in the job that records it.
pub(crate) fn stage_started(
    db: &mut crate::store::Tx,
    row: &parallax_store::Thread,
) -> Result<(), ErrorObject> {
    let thread = thread_entry(row)?;
    db.stage(
        thread.created_at,
        None,
        ParallaxEvent::ThreadStarted { thread },
    );
    Ok(())
}

/// `thread/list`.
pub(crate) async fn list(daemon: &Arc<Daemon>) -> Result<ThreadListResult, ErrorObject> {
    let ((repos, threads), seq) = daemon
        .reader
        .snapshot(&CancellationToken::new(), |db| {
            let repos = db.list_repos().map_err(|e| store_error(&e))?;
            let threads = db.list_threads().map_err(|e| store_error(&e))?;
            Ok((repos, threads))
        })
        .await?;
    Ok(ThreadListResult {
        repos: repos
            .into_iter()
            .map(repo_entry)
            .collect::<Result<_, _>>()?,
        threads: threads.iter().map(thread_entry).collect::<Result<_, _>>()?,
        seq,
    })
}

fn check_path(path: &str) -> Result<(), ErrorObject> {
    if path.len() > MAX_PATH_BYTES {
        return Err(ErrorObject::invalid_params(format!(
            "path must be at most {MAX_PATH_BYTES} bytes"
        )));
    }
    if path.contains('\0') {
        return Err(ErrorObject::invalid_params("path must not contain NUL"));
    }
    if !Path::new(path).is_absolute() {
        return Err(ErrorObject::invalid_params("path must be an absolute path"));
    }
    let has_dot_segment = Path::new(path)
        .components()
        .any(|component| matches!(component, Component::ParentDir | Component::CurDir))
        || path.contains("/./")
        || path.ends_with("/.");
    if has_dot_segment {
        return Err(ErrorObject::invalid_params(
            "path must not contain . or .. segments",
        ));
    }
    Ok(())
}

/// `repo/add`: registers the repository at `path`, or returns the entry it already has.
pub(crate) async fn add_repo(
    daemon: &Arc<Daemon>,
    params: RepoAddParams,
) -> Result<RepoAddResult, ErrorObject> {
    let RepoAddParams { id, path } = params;
    check_path(&path)?;
    let not_a_repository =
        |message: String| ErrorObject::parallax(ErrorKind::NotARepository, message);
    repo::check(Path::new(&path)).map_err(|error| not_a_repository(error.to_string()))?;
    let canonical = Path::new(&path)
        .canonicalize()
        .map_err(|error| not_a_repository(format!("{path} can't be resolved: {error}")))?;
    let data_dir = daemon
        .data_dir
        .root()
        .canonicalize()
        .unwrap_or_else(|_| daemon.data_dir.root().to_owned());
    if canonical.starts_with(&data_dir) {
        return Err(not_a_repository(format!(
            "{path} is inside plxd's data folder, which holds Parallax's own worktrees, scratch \
             repositories, and notes"
        )));
    }
    let Some(canonical) = canonical.to_str().map(str::to_owned) else {
        return Err(not_a_repository(format!("{path} is not valid UTF-8")));
    };
    let name = Path::new(&canonical)
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or(&canonical)
        .to_owned();
    store(daemon, move |db| {
        let fields = RepoFields {
            name,
            path: canonical,
            scratch: false,
        };
        let (repo, created) = add(db, id.into(), &fields)?;
        let repo = repo_entry(repo)?;
        if created {
            db.stage(
                repo.created_at,
                None,
                ParallaxEvent::RepoAdded { repo: repo.clone() },
            );
            info!(repo = %repo.id, path = %repo.path, "registered a repository for threads");
        }
        Ok(RepoAddResult { repo })
    })
    .await
}

/// Adds a repo entry, and says whether it is new.
fn add(
    db: &mut parallax_store::Store,
    id: Uuid,
    fields: &RepoFields,
) -> Result<(parallax_store::Repo, bool), ErrorObject> {
    let known = db
        .list_repos()
        .map_err(|e| store_error(&e))?
        .into_iter()
        .any(|repo| repo.fields.path == fields.path);
    let repo = db.add_repo(id, fields).map_err(|error| match error {
        parallax_store::StoreError::IdConflict { id } => ErrorObject::parallax(
            ErrorKind::IdConflict,
            format!("repo entry {id} exists with another path"),
        ),
        other => store_error(&other),
    })?;
    Ok((repo, !known))
}

/// The folder that holds threads' scratch repositories, created and canonical.
fn scratch_root(daemon: &Daemon) -> Result<PathBuf, ErrorObject> {
    let root = daemon.data_dir.root().join(SCRATCH_DIR);
    std::fs::create_dir_all(&root)
        .and_then(|()| root.canonicalize())
        .map_err(|error| {
            ErrorObject::internal_error(format!(
                "could not create the scratch folder {}: {error}",
                root.display()
            ))
        })
}

/// plxd's scratch entry, made on first use.
async fn scratch_entry(daemon: &Arc<Daemon>) -> Result<parallax_store::Repo, ErrorObject> {
    let root = scratch_root(daemon)?;
    store(daemon, move |db| {
        if let Some(repo) = db.scratch_repo().map_err(|e| store_error(&e))? {
            return Ok(repo);
        }
        let fields = RepoFields {
            name: SCRATCH_NAME.to_owned(),
            path: root.to_string_lossy().into_owned(),
            scratch: true,
        };
        let (row, created) = add(db, RepoId::generate().into(), &fields)?;
        if created {
            let repo = repo_entry(row.clone())?;
            db.stage(repo.created_at, None, ParallaxEvent::RepoAdded { repo });
        }
        Ok(row)
    })
    .await
}

/// The repo entry a thread starts in: `repo`, or plxd's scratch entry when it names none.
pub(crate) async fn start_entry(
    daemon: &Arc<Daemon>,
    repo: Option<RepoId>,
) -> Result<parallax_store::Repo, ErrorObject> {
    let Some(id) = repo else {
        return scratch_entry(daemon).await;
    };
    store(daemon, move |db| {
        db.get_repo(id.into())
            .map_err(|e| store_error(&e))?
            .ok_or_else(|| {
                ErrorObject::parallax(
                    ErrorKind::RepoNotFound,
                    format!("no repo entry has id {id}"),
                )
            })
    })
    .await
}

/// A thread with no repo's scratch repository, under its scratch entry: made unless the run id is
/// `taken`. `None` for a repo entry.
async fn scratch_dir(
    daemon: &Daemon,
    entry: &parallax_store::Repo,
    run_id: RunId,
    taken: bool,
) -> Result<Option<PathBuf>, ErrorObject> {
    if !entry.fields.scratch {
        return Ok(None);
    }
    let dir = PathBuf::from(&entry.fields.path).join(run_id.to_string());
    if !taken {
        daemon
            .agents
            .worktrees()
            .init_scratch(&dir)
            .await
            .map_err(|error| {
                ErrorObject::parallax(
                    ErrorKind::WorktreeFailed,
                    format!("could not make the thread's scratch repository: {error}"),
                )
            })?;
    }
    Ok(Some(dir))
}

/// `thread/start`: see the module documentation. Idempotent on the run id.
pub(crate) async fn start(
    daemon: Arc<Daemon>,
    params: ThreadStartParams,
) -> Result<ThreadStartResult, ErrorObject> {
    check_start(&params)?;
    let ThreadStartParams {
        run_id,
        repo,
        project,
        parent,
        title,
        prompt,
        account,
        model,
        effort,
        permission,
        context_window,
        fast,
        branch_slug,
        images,
        approvals,
        checkout,
        base,
        checkout_ref,
        threads,
        notify,
        naming,
    } = params;
    let git_ref = git_ref(checkout, base, checkout_ref)?;
    let title = title.as_deref().map(check_title).transpose()?.flatten();
    // A retry, or a run id that is taken, needs no new scratch repository: `agents::create`
    // answers it from the existing run.
    let stored = store(&daemon, move |db| {
        db.get_run(run_id.into())
            .map(|row| row.map(|row| row.fields.parent))
            .map_err(|e| store_error(&e))
    })
    .await?;
    let taken = stored.is_some();
    let (scope, scratch) = workspace(&daemon, project, repo, checkout, run_id, taken).await?;
    // A retry is answered from its run, whatever became of its parent since, and a Project's
    // child keeps the coordinator it started under.
    let parent = match (project, stored) {
        (Some(_), Some(stored)) => stored.and_then(|id| RunId::try_from(id).ok()),
        (Some(project), None) => coordinator(&daemon, project).await?,
        (None, Some(_)) => parent,
        (None, None) => {
            check_parent(&daemon, parent).await?;
            parent
        }
    };
    let new = NewRun {
        run_id,
        scope,
        prompt,
        images,
        threads,
        account,
        coordinator_thread: None,
        notify: notify.unwrap_or(true),
        options: RunOptions {
            model,
            effort,
            permission,
            context_window,
            fast,
        },
        approvals,
        explore: false,
        thread: Some(NewThread {
            scratch: scratch.clone(),
            branch_slug,
            checkout,
            git_ref,
            parent,
            fields: ThreadFields {
                forked_from: None,
                title,
            },
            fork: None,
        }),
    };
    let created = match agents::create(Arc::clone(&daemon), new).await {
        Ok(created) => created,
        Err(error) => {
            if let Some(dir) = scratch
                && !taken
            {
                remove_unused_scratch(&daemon, run_id, &dir).await;
            }
            return Err(error);
        }
    };
    let thread = created
        .thread
        .as_ref()
        .ok_or_else(|| ErrorObject::internal_error("a new thread has no thread row"))?;
    if let Some(naming) = naming.filter(|_| !taken) {
        crate::naming::start(&daemon, &created.run, naming);
    }
    Ok(ThreadStartResult {
        thread: thread_entry(thread)?,
        run: created.run,
    })
}

/// Refuses an invalid `branchSlug`, and, with `project`, what the Project decides for its child
/// (0042).
fn check_start(params: &ThreadStartParams) -> Result<(), ErrorObject> {
    if let Some(slug) = &params.branch_slug
        && !valid_branch_slug(slug)
    {
        return Err(ErrorObject::invalid_params(
            "branchSlug must be 1 to 40 lowercase letters, digits, and hyphens, \
             with no leading or trailing hyphen",
        ));
    }
    if params.project.is_none() {
        return Ok(());
    }
    let decided = [
        ("repo", params.repo.is_some()),
        ("parent", params.parent.is_some()),
        ("checkout", params.checkout),
        ("base", params.base.is_some()),
        ("checkoutRef", params.checkout_ref.is_some()),
    ];
    match decided.iter().find(|(_, given)| *given) {
        Some((name, _)) => Err(ErrorObject::invalid_params(format!(
            "a Project's child runs in a new worktree of the Project's repository, with its \
             coordinator as parent; leave out {name}"
        ))),
        None => Ok(()),
    }
}

/// A new thread's scope, and the scratch repository it runs in, if any: `project`, or else the
/// repo entry `repo` names, the scratch entry when it names none.
async fn workspace(
    daemon: &Arc<Daemon>,
    project: Option<ProjectId>,
    repo: Option<RepoId>,
    checkout: bool,
    run_id: RunId,
    taken: bool,
) -> Result<(ProjectId, Option<PathBuf>), ErrorObject> {
    if let Some(project) = project {
        return Ok((project, None));
    }
    let entry = start_entry(daemon, repo).await?;
    if checkout && entry.fields.scratch {
        return Err(ErrorObject::invalid_params(
            "checkout needs a repo: a thread with no repo has no checkout to work in",
        ));
    }
    let scope = ProjectId::try_from(entry.id).map_err(|_| corrupt("repo entry", entry.id))?;
    Ok((scope, scratch_dir(daemon, &entry, run_id, taken).await?))
}

/// A new child's parent (0042): `project`'s current coordinator, or `None` before it has one.
/// Fails with `projectNotFound` unless `project` is a Project.
async fn coordinator(daemon: &Daemon, project: ProjectId) -> Result<Option<RunId>, ErrorObject> {
    store(daemon, move |db| {
        if db
            .get_project(project.into())
            .map_err(|e| store_error(&e))?
            .is_none()
        {
            return Err(ErrorObject::parallax(
                ErrorKind::ProjectNotFound,
                format!("no project has id {project}"),
            ));
        }
        agents::coordinator::coordinator_of(db, project.into())
    })
    .await
}

/// Fails with `runNotFound` unless `parent`, when set, is a run that exists (0041).
async fn check_parent(daemon: &Daemon, parent: Option<RunId>) -> Result<(), ErrorObject> {
    let Some(parent) = parent else {
        return Ok(());
    };
    store(daemon, move |db| {
        db.get_run(parent.into())
            .map_err(|e| store_error(&e))?
            .map(drop)
            .ok_or_else(|| agents::run_not_found(parent))
    })
    .await
}

/// The thread `thread/fork` forks, as the store has it (0050).
struct Parent {
    run: parallax_store::Run,
    status: AgentStatus,
    entry: parallax_store::Repo,
    /// Its latest commit: its last one, or else its worktree's base.
    commit: Option<String>,
    /// Its recorded turns' ids.
    turns: Vec<Uuid>,
    /// Its newest recorded turn's id.
    latest: Option<Uuid>,
    /// Whether it is itself a fork, whose prompt's turn is the history it copied.
    forked: bool,
}

/// `thread/fork`: see [`ThreadForkParams`] and decision 0050. Idempotent on the new run id.
pub(crate) async fn fork(
    daemon: Arc<Daemon>,
    params: ThreadForkParams,
) -> Result<ThreadStartResult, ErrorObject> {
    let ThreadForkParams {
        run_id,
        new_run_id,
        turn_id,
        account,
        model,
        parent: caller,
    } = params;
    // Share creation's per-id guard so a retry checks its fork identity after any competing
    // creation finishes, and concurrent forks cannot prepare the same scratch repository.
    // Check retries before generic creation compares options, which another backend may filter.
    let lane = daemon.orchestrator.lane(new_run_id).await;
    if let Some(done) = existing_fork(&daemon, new_run_id, run_id, turn_id, caller).await? {
        return Ok(done);
    }
    check_parent(&daemon, caller).await?;
    let parent = load_parent(&daemon, run_id).await?;
    let turn = fork_turn(&parent, run_id, turn_id)?;
    let events = agents::logged_events(&daemon, run_id).await?;
    let first = first_turn(run_id)?;
    let events: Vec<_> = events.into_iter().map(|event| event.event).collect();
    let (transcript, ended) = transcript_until(&events, turn, first, &parent);
    if !ended && matches!(parent.status, AgentStatus::Starting | AgentStatus::Running) {
        return Err(still_running(run_id, turn));
    }
    let (checkout, git_ref, scratch) = fork_workspace(&daemon, &parent, run_id, new_run_id).await?;
    let fields = &parent.run.fields;
    let scope =
        ProjectId::try_from(parent.entry.id).map_err(|_| corrupt("repo entry", parent.entry.id))?;
    let new = NewRun {
        run_id: new_run_id,
        scope,
        prompt: fields.prompt.clone(),
        images: Vec::new(),
        threads: Vec::new(),
        account: Some(
            account.unwrap_or_else(|| agents::session_account(&parent.run.state.account_id)),
        ),
        coordinator_thread: None,
        // A fork with a parent wakes it as a launched child does, once its CLIs end (0041).
        notify: caller.is_some(),
        options: RunOptions {
            model: model.clone().or_else(|| fields.model.clone()),
            effort: fields.effort.as_deref().and_then(option_value),
            permission: fields.permission.as_deref().and_then(option_value),
            context_window: fields.context_window,
            fast: fields.fast,
        },
        approvals: fields.approvals,
        thread: Some(NewThread {
            scratch: scratch.clone(),
            branch_slug: None,
            checkout,
            git_ref,
            parent: caller,
            fields: ThreadFields {
                forked_from: Some(parallax_store::ForkedFrom {
                    run: run_id.into(),
                    turn: turn.into(),
                }),
                title: None,
            },
            fork: Some(NewFork {
                parent_backend: fields.backend.clone(),
                model_given: model.is_some(),
                keep_permission: caller.is_some(),
                transcript,
            }),
        }),
        explore: false,
    };
    let created = match agents::create_started(Arc::clone(&daemon), new, &lane).await {
        Ok(created) => created,
        Err(error) => {
            if let Some(dir) = scratch {
                remove_unused_scratch(&daemon, new_run_id, &dir).await;
            }
            return Err(error);
        }
    };
    let thread = created
        .thread
        .as_ref()
        .ok_or_else(|| ErrorObject::internal_error("a new fork has no thread row"))?;
    Ok(ThreadStartResult {
        thread: thread_entry(thread)?,
        run: created.run,
    })
}

/// The fork a retried `thread/fork` already made: `None` if `new_run_id` is free, and
/// `idConflict` if it is anything but a fork of `run_id`, at `turn_id` if that is given, for
/// `caller`. An empty stored parent isn't compared, since deleting the parent cleared it (0041).
async fn existing_fork(
    daemon: &Daemon,
    new_run_id: RunId,
    run_id: RunId,
    turn_id: Option<TurnId>,
    caller: Option<RunId>,
) -> Result<Option<ThreadStartResult>, ErrorObject> {
    store(daemon, move |db| {
        let Some(run) = db.get_run(new_run_id.into()).map_err(|e| store_error(&e))? else {
            return Ok(None);
        };
        let same = |from: parallax_store::ForkedFrom| {
            from.run == Uuid::from(run_id)
                && turn_id.is_none_or(|turn| from.turn == Uuid::from(turn))
        };
        let thread = db
            .get_thread(new_run_id.into())
            .map_err(|e| store_error(&e))?
            .filter(|thread| {
                thread.fields.forked_from.is_some_and(same)
                    && thread
                        .parent
                        .is_none_or(|parent| caller.map(Uuid::from) == Some(parent))
            })
            .ok_or_else(|| {
                ErrorObject::parallax(
                    ErrorKind::IdConflict,
                    format!("run {new_run_id} exists and is not that fork of thread {run_id}"),
                )
            })?;
        let worktree = db
            .get_worktree(new_run_id.into())
            .map_err(|e| store_error(&e))?;
        Ok(Some(ThreadStartResult {
            thread: thread_entry(&thread)?,
            run: agent_run(&run, worktree.as_ref())?,
        }))
    })
    .await
}

/// Thread `run_id`, for `thread/fork`, or `threadNotFound`.
async fn load_parent(daemon: &Daemon, run_id: RunId) -> Result<Parent, ErrorObject> {
    store(daemon, move |db| {
        let id = Uuid::from(run_id);
        let error = |error| store_error(&error);
        let thread = db
            .get_thread(id)
            .map_err(error)?
            .ok_or_else(|| thread_not_found(run_id))?;
        let run = db
            .get_run(id)
            .map_err(error)?
            .ok_or_else(|| thread_not_found(run_id))?;
        let entry = db
            .get_repo(thread.repo_id)
            .map_err(error)?
            .ok_or_else(|| corrupt("thread", id))?;
        let worktree = db.get_worktree(id).map_err(error)?;
        let status = agent_run(&run, worktree.as_ref())?.status;
        let commit = run
            .state
            .commit_sha
            .clone()
            .or_else(|| worktree.map(|worktree| worktree.base));
        let turns = db
            .run_turns(id)
            .map_err(error)?
            .into_iter()
            .map(|(turn, _)| turn)
            .collect();
        let latest = db.latest_turn(id).map_err(error)?;
        let forked = thread.fields.forked_from.is_some();
        Ok(Parent {
            run,
            status,
            entry,
            commit,
            turns,
            latest,
            forked,
        })
    })
    .await
}

/// The prompt's turn of run `run_id`, which has no turn id of its own: `thread/fork` names it by
/// the run's id (0050).
fn first_turn(run_id: RunId) -> Result<TurnId, ErrorObject> {
    TurnId::try_from(Uuid::from(run_id)).map_err(|_| corrupt("run", run_id.into()))
}

/// The turn a fork continues after: `turn_id`, or the parent's latest. `invalidParams` for a
/// turn the parent didn't record, including one a fork copied from its own parent, and for the
/// one it is still running.
fn fork_turn(
    parent: &Parent,
    run_id: RunId,
    turn_id: Option<TurnId>,
) -> Result<TurnId, ErrorObject> {
    let first = first_turn(run_id)?;
    let latest = match parent.latest {
        Some(id) => TurnId::try_from(id).map_err(|_| corrupt("turn", id))?,
        None => first,
    };
    let turn = turn_id.unwrap_or(latest);
    if turn != first && !parent.turns.contains(&Uuid::from(turn)) {
        return Err(ErrorObject::invalid_params(format!(
            "thread {run_id} has no turn {turn} of its own: a turn a fork copied is forked from \
             the thread it came from"
        )));
    }
    if turn == latest && matches!(parent.status, AgentStatus::Starting | AgentStatus::Running) {
        return Err(still_running(run_id, turn));
    }
    Ok(turn)
}

fn still_running(run_id: RunId, turn: TurnId) -> ErrorObject {
    ErrorObject::invalid_params(format!(
        "thread {run_id} is still running turn {turn}: fork it once the turn ends"
    ))
}

/// `events`' `agent.output` items up to the end of the parent's turn `turn`, one list per
/// event, for a fork's log (0050), and whether that end was found. Approval items are left out,
/// since their requests were the parent CLI's.
///
/// Only the parent's own recorded turns mark turns: a `turnStarted` a fork copied from its own
/// parent is part of its prompt's turn, `first`. The copy ends at `turn`'s `turnFinished`, which
/// for the prompt's turn has no turn id, or else at the `agent.finished` of the CLI that ran it,
/// as a stopped, interrupted, or usage-limited turn logs no `turnFinished`. A follow-up's
/// `turnStarted` can come before the end of the turn it followed, as Claude Code's driver
/// reports it once written, so a later turn's `turnStarted` is skipped. A turn with neither end,
/// as when plxd itself died, ends where the next turn started. A fork's prompt's turn has no end
/// of its own, so it counts as found.
fn transcript_until(
    events: &[ParallaxEvent],
    turn: TurnId,
    first: TurnId,
    parent: &Parent,
) -> (Vec<Vec<AgentOutputItem>>, bool) {
    // The `turnFinished` turn id that ends the copy, if one does.
    let end = if turn == first {
        (!parent.forked).then_some(None)
    } else {
        Some(Some(turn))
    };
    let mut reached = turn == first;
    // Each copied item, with the index of the event it came from.
    let mut copied: Vec<(usize, &AgentOutputItem)> = Vec::new();
    // Where the first turn after `turn` started.
    let mut next = None;
    let mut found = false;
    'events: for (index, event) in events.iter().enumerate() {
        let items = match event {
            ParallaxEvent::AgentOutput { items, .. } => items,
            ParallaxEvent::AgentFinished { .. } if reached && end.is_some() => {
                found = true;
                break;
            }
            _ => continue,
        };
        for item in items {
            match item {
                AgentOutputItem::TurnStarted {
                    turn_id: Some(id), ..
                } if parent.turns.contains(&Uuid::from(*id)) => {
                    if *id == turn {
                        reached = true;
                    } else if reached {
                        next.get_or_insert(copied.len());
                        continue;
                    }
                }
                AgentOutputItem::TurnFinished { turn_id, .. }
                    if reached && end == Some(*turn_id) =>
                {
                    copied.push((index, item));
                    found = true;
                    break 'events;
                }
                AgentOutputItem::ApprovalRequested { .. }
                | AgentOutputItem::ApprovalResolved { .. } => continue,
                _ => {}
            }
            copied.push((index, item));
        }
    }
    if !found && let Some(next) = next {
        copied.truncate(next);
    }
    let mut kept: Vec<Vec<AgentOutputItem>> = Vec::new();
    let mut last = None;
    for (index, item) in copied {
        match kept.last_mut() {
            Some(items) if last == Some(index) => items.push(item.clone()),
            _ => kept.push(vec![item.clone()]),
        }
        last = Some(index);
    }
    (kept, found || end.is_none())
}

/// Where a fork works (0050): `checkout` for a Current checkout thread's fork, which works in the
/// same checkout; otherwise the base of its worktree, the parent's latest commit, and for a
/// thread with no repo the fork's own scratch repository, which that commit is fetched into.
async fn fork_workspace(
    daemon: &Arc<Daemon>,
    parent: &Parent,
    run_id: RunId,
    new_run_id: RunId,
) -> Result<(bool, Option<String>, Option<PathBuf>), ErrorObject> {
    if parent.run.fields.checkout {
        return Ok((true, None, None));
    }
    let Some(dir) = scratch_dir(daemon, &parent.entry, new_run_id, false).await? else {
        return Ok((false, parent.commit.clone(), None));
    };
    let from = PathBuf::from(&parent.entry.fields.path).join(run_id.to_string());
    let Some(commit) = parent.commit.clone().filter(|_| from.is_dir()) else {
        return Ok((false, None, Some(dir)));
    };
    if let Err(error) = daemon
        .agents
        .worktrees()
        .fetch_commit(&dir, &from, &commit)
        .await
    {
        remove_unused_scratch(daemon, new_run_id, &dir).await;
        return Err(ErrorObject::parallax(
            ErrorKind::WorktreeFailed,
            format!("could not copy thread {run_id}'s latest commit: {error}"),
        ));
    }
    Ok((false, Some(commit), Some(dir)))
}

/// The ref a thread starts from: `base` for a worktree, `checkoutRef` with `checkout`, checked as
/// a git argument.
fn git_ref(
    checkout: bool,
    base: Option<String>,
    checkout_ref: Option<String>,
) -> Result<Option<String>, ErrorObject> {
    let (reference, what) = match (checkout, base, checkout_ref) {
        (true, Some(_), _) => return Err(ErrorObject::invalid_params("base is not for checkout")),
        (false, _, Some(_)) => {
            return Err(ErrorObject::invalid_params("checkoutRef needs checkout"));
        }
        (true, None, reference) => (reference, "checkoutRef"),
        (false, reference, None) => (reference, "base"),
    };
    if let Some(reference) = &reference {
        check_argument(what, reference).map_err(|e| ErrorObject::invalid_params(e.to_string()))?;
    }
    Ok(reference)
}

/// `repo/refs`: the branches of repo entry `repo`'s repository.
pub(crate) async fn refs(
    daemon: &Arc<Daemon>,
    params: RepoRefsParams,
) -> Result<RepoRefsResult, ErrorObject> {
    let entry = start_entry(daemon, Some(params.repo)).await?;
    let refs = daemon
        .agents
        .worktrees()
        .refs(Path::new(&entry.fields.path))
        .await
        .map_err(|error| ErrorObject::parallax(ErrorKind::WorktreeFailed, error.to_string()))?;
    Ok(RepoRefsResult { refs })
}

/// Removes a scratch repository made for a `thread/start` that didn't create its run.
async fn remove_unused_scratch(daemon: &Arc<Daemon>, run_id: RunId, dir: &Path) {
    let exists = store(daemon, move |db| {
        db.get_run(run_id.into())
            .map(|row| row.is_some())
            .map_err(|e| store_error(&e))
    })
    .await;
    if matches!(exists, Ok(false)) {
        remove_scratch(daemon, run_id, dir);
    }
}

/// Removes `dir`, a thread's scratch repository, after checking that it is exactly
/// `<scratch folder>/<run id>`, so a stored path can never send the removal elsewhere.
fn remove_scratch(daemon: &Daemon, run_id: RunId, dir: &Path) {
    let Ok(root) = scratch_root(daemon) else {
        return;
    };
    let expected = root.join(run_id.to_string());
    let is_expected = dir
        .canonicalize()
        .is_ok_and(|canonical| canonical == expected);
    let is_folder = std::fs::symlink_metadata(&expected).is_ok_and(|meta| meta.is_dir());
    if !is_expected || !is_folder {
        warn!(run = %run_id, dir = %dir.display(), "not removing a scratch repository outside the scratch folder");
        return;
    }
    if let Err(error) = std::fs::remove_dir_all(&expected) {
        warn!(run = %run_id, %error, "could not remove a thread's scratch repository");
    }
}

/// `thread/search` (PLX-372, PLX-487): the threads whose title or messages match the query,
/// trimmed, title matches first, then the one with the newest message.
pub(crate) async fn search(
    daemon: &Arc<Daemon>,
    params: ThreadSearchParams,
) -> Result<ThreadSearchResult, ErrorObject> {
    let query = params.query.trim().to_owned();
    if query.is_empty() {
        return Err(ErrorObject::invalid_params("query must not be empty"));
    }
    if query.len() > MAX_QUERY_BYTES {
        return Err(ErrorObject::invalid_params(format!(
            "query must be at most {MAX_QUERY_BYTES} bytes"
        )));
    }
    let limit = params
        .limit
        .unwrap_or(DEFAULT_SEARCH_LIMIT)
        .min(MAX_SEARCH_LIMIT) as usize;
    let rows = daemon
        .reader
        .run(&CancellationToken::new(), move |db| {
            db.search_threads(&query, limit)
                .map_err(|e| store_error(&e))
        })
        .await?;
    let threads = rows.iter().map(thread_entry).collect::<Result<_, _>>()?;
    Ok(ThreadSearchResult { threads })
}

/// `thread/archive`: the orchestrator's `thread.archive` or `thread.unarchive` (0059).
pub(crate) async fn archive(
    daemon: &Arc<Daemon>,
    params: ThreadArchiveParams,
    command_id: Option<Uuid>,
) -> Result<ThreadArchiveResult, ErrorObject> {
    let ThreadArchiveParams { run_id, archived } = params;
    if archived {
        daemon.terminals.close_thread(&run_id.to_string());
    }
    let thread = metadata(daemon, command_id, run_id, Action::Archive(archived)).await?;
    Ok(ThreadArchiveResult { thread })
}

/// `thread/update`: marks a thread seen or snoozes it (0033), or sets its title or settled flag
/// (0041), through the orchestrator's `thread.metadata.update` (0059), which appends
/// `thread.updated` when anything changed.
pub(crate) async fn update(
    daemon: &Arc<Daemon>,
    params: ThreadUpdateParams,
    command_id: Option<Uuid>,
) -> Result<ThreadUpdateResult, ErrorObject> {
    let ThreadUpdateParams {
        run_id,
        seen,
        snoozed_until,
        title,
        settled,
    } = params;
    let update = ThreadUpdate {
        seen,
        snoozed_until,
        title: title.as_deref().map(check_title).transpose()?,
        settled,
    };
    let thread = metadata(daemon, command_id, run_id, Action::Update(update)).await?;
    Ok(ThreadUpdateResult { thread })
}

/// Dispatches a metadata command on thread `run_id` and returns the thread after it.
async fn metadata(
    daemon: &Daemon,
    command_id: Option<Uuid>,
    run_id: RunId,
    action: Action,
) -> Result<Thread, ErrorObject> {
    let command = Command::new(command_id, run_id, action);
    let rows = daemon
        .orchestrator
        .dispatch(daemon, command)
        .await?
        .rows()?;
    thread_entry(&rows.thread.ok_or_else(|| thread_not_found(run_id))?)
}

/// After run `run_id`'s thread row changed in this job, stages `thread.updated` if the run is a
/// thread: a recorded message moved its `lastPromptAt`, for the sidebar's order (0033), or joining
/// a Project gave it a parent (PLX-419).
pub(crate) fn prompted(db: &mut crate::store::Tx, run_id: Uuid) -> Result<(), ErrorObject> {
    let Some(row) = db.get_thread(run_id).map_err(|e| store_error(&e))? else {
        return Ok(());
    };
    db.stage(
        Timestamp::now(),
        None,
        ParallaxEvent::ThreadUpdated {
            thread: thread_entry(&row)?,
        },
    );
    Ok(())
}

/// `repo/update`: sets a repo entry's icon (0033), appending `repo.updated` when it changed.
pub(crate) async fn update_repo(
    daemon: &Arc<Daemon>,
    params: RepoUpdateParams,
) -> Result<RepoUpdateResult, ErrorObject> {
    let RepoUpdateParams { repo, icon } = params;
    crate::methods::project::check_icon(&icon)?;
    let stored = crate::store::stored_icon(icon);
    store(daemon, move |db| {
        let (row, changed) =
            db.set_repo_icon(repo.into(), &stored)
                .map_err(|error| match error {
                    parallax_store::StoreError::NotFound { .. } => ErrorObject::parallax(
                        ErrorKind::RepoNotFound,
                        format!("no repo entry has id {repo}"),
                    ),
                    other => store_error(&other),
                })?;
        let repo = repo_entry(row)?;
        if changed {
            db.stage(
                Timestamp::now(),
                None,
                ParallaxEvent::RepoUpdated { repo: repo.clone() },
            );
        }
        Ok(RepoUpdateResult { repo })
    })
    .await
}

/// `thread/delete`: through the run's actor ([`agents::delete`]), which cancels a running CLI,
/// waits for it to exit, and then calls [`purge`]. A retry of a delete that committed answers
/// from its receipt (0059), before and, for one that raced it, after asking the actor.
pub(crate) async fn delete(
    daemon: &Arc<Daemon>,
    run_id: RunId,
    command_id: Option<Uuid>,
) -> Result<ThreadDeleteResult, ErrorObject> {
    let replayed =
        || orchestrator::replayed(daemon, command_id, run_id, orchestrator::THREAD_DELETE);
    if replayed().await? {
        return Ok(ThreadDeleteResult {});
    }
    store(daemon, move |db| {
        db.get_thread(run_id.into())
            .map_err(|e| store_error(&e))?
            .ok_or_else(|| thread_not_found(run_id))
    })
    .await?;
    match agents::delete(daemon, run_id, false, command_id).await {
        Ok(()) => Ok(ThreadDeleteResult {}),
        Err(error)
            if error
                .parallax_data()
                .is_some_and(|data| data.kind == ErrorKind::RunNotFound) =>
        {
            if replayed().await? {
                Ok(ThreadDeleteResult {})
            } else {
                Err(thread_not_found(run_id))
            }
        }
        Err(error) => Err(error),
    }
}

/// Deletes run `run_id` once its CLI has exited, through the orchestrator's `thread.delete`
/// (0059) in `lane`, which the actor holds: its rows and stored events, and for a thread its
/// thread row and `thread.deleted`, in one transaction, then its terminals and its events in
/// memory. A Project's run (`project/delete`, PLX-338) has no thread row and gets no event of its
/// own. The store clears the run from its children's parent and its forks' origin, and each such
/// thread gets `thread.updated` (0041). The `thread.cleanup` effect then removes `worktree` and
/// its branch, and for a thread with no repo its scratch repository and its own context folder.
pub(crate) async fn purge(
    daemon: &Arc<Daemon>,
    lane: &Lane<'_>,
    run_id: RunId,
    worktree: Option<parallax_store::Worktree>,
    command_id: Option<Uuid>,
) -> Result<(), ErrorObject> {
    let command = Command::new(command_id, run_id, Action::Delete { worktree });
    daemon.orchestrator.commit(daemon, lane, command).await?;
    daemon.terminals.close_thread(&run_id.to_string());
    daemon.log.purge_run(run_id);
    info!(run = %run_id, "deleted a run");
    Ok(())
}

/// Removes a deleted thread with no repo's scratch repository and its own context folder.
pub(crate) fn remove_scratch_and_context(daemon: &Daemon, run_id: RunId) {
    if let Ok(root) = scratch_root(daemon) {
        remove_scratch(daemon, run_id, &root.join(run_id.to_string()));
    }
    if let Ok(scope) = ProjectId::try_from(Uuid::from(run_id)) {
        remove_context(daemon, scope);
    }
}

/// Removes `scope`'s shared context folder, `context/<scope>`: a deleted thread with no repo's
/// own, or a deleted Project's (PLX-338).
pub(crate) fn remove_context(daemon: &Daemon, scope: ProjectId) {
    let dir = daemon.data_dir.context_dir(scope);
    if !std::fs::symlink_metadata(&dir).is_ok_and(|meta| meta.is_dir()) {
        return;
    }
    if let Err(error) = std::fs::remove_dir_all(&dir) {
        warn!(%scope, %error, "could not remove a deleted scope's context folder");
    }
}

#[cfg(all(test, unix))]
mod tests {
    use parallax_protocol::jsonrpc::INVALID_PARAMS;

    use super::check_path;

    #[test]
    fn repo_paths_are_absolute_and_plain() {
        assert!(check_path("/Users/me/src/parallax").is_ok());
        for path in [
            "src/parallax",
            "/Users/me/../parallax",
            "/Users/me/./parallax",
            "/a\0b",
        ] {
            assert_eq!(check_path(path).unwrap_err().code, INVALID_PARAMS, "{path}");
        }
        let long = format!("/{}", "p".repeat(super::MAX_PATH_BYTES));
        assert_eq!(check_path(&long).unwrap_err().code, INVALID_PARAMS);
    }
}
