//! The M3 runner (#156, decision 0014): runs a worker end to end.
//!
//! `agent/start` resolves the worker's account through routing (#119), refuses a worker plxd
//! can't sandbox (0013) or a run option its backend can't honor (PLX-97),
//! creates the run's worktree (#154), records the run, and starts the
//! backend in the worktree, with no allowed folder for the shared context (#155, 0044). From then
//! on one [`actor`] task per run owns it: it streams the backend's events into the event log as
//! `agent.*` events, records usage (#120) against whichever account the run is on, takes
//! `agent/send` and `agent/cancel`, and when a CLI process ends, commits the worktree through
//! #166's hardened `commit_all` and reports the diff in `agent.updated`.
//!
//! A run whose client started it with `approvals`, and every run in a Project, its coordinator
//! included, lets its CLI ask before a tool call (PLX-222, decisions 0031 and 0042). It logs the
//! request, takes `agent/approve`'s answer, and denies it itself when nobody answers in time
//! ([`approvals`]). Every launch of the run, a resume included, keeps the flag.
//!
//! A run outlives its CLI processes: `agent/send` to a run whose CLI has ended resumes the
//! vendor session in the same worktree. When plxd stops, running CLIs are cancelled and their
//! runs recorded `interrupted`; a run still `starting` or `running` in the store when plxd
//! starts (a crash) is marked `interrupted` too. Either kind resumes through `agent/send`, and
//! either wakes the parent that launched it once plxd starts again ([`wake::catch_up`]).
//!
//! A project's coordinator (0024) is a run too, started by [`coordinator::start`] instead, with
//! no recorded worktree; the same actor runs it. Children wake the run that launched them when they
//! finish, a coordinator or any thread, and a run started in a Project wakes its coordinator
//! ([`wake`]).
//!
//! Every run in a Project, its coordinator included, runs in the Project's permission mode, Auto
//! or Bypass (0042), whatever its request or a later `agent/send` asks for. Each new CLI process
//! reads the mode again, so one `project/update` changed applies from the run's next process. A
//! backend that doesn't map the mode is refused ([`in_mode`]), never moved to another mode.
//!
//! A Project's child starts on the account [`placement`]'s fixed rules pick (0046), or waits,
//! recorded as `waiting`, until one has room.
//!
//! A normal thread's run is full Claude Code in every mode, with no worker sandbox, when its client
//! answers permission requests, and its first message is the user's own (0034). A Project's
//! children run the same way, through `agent/start`: always with `approvals`, and with a short
//! header naming the Project and its tools, then its brief and memory index (0044), before the
//! task (0042). A thread started
//! with `checkout` has no worktree either: it runs in its repo entry's own checkout, on the branch
//! the user has out or the one `checkoutRef` switches it to first. plxd never commits it, since the
//! checkout can hold the user's own uncommitted work, so its changes stay there for the user to
//! review, and it has no diff to accept or open a PR from.

mod actor;
mod approvals;
pub(crate) mod attached;
pub(crate) mod cleanup;
pub(crate) mod compact;
pub(crate) mod convert;
pub(crate) mod coordinator;
pub(crate) mod handoff;
mod placement;
mod resume;
pub(crate) mod review;
pub(crate) mod wait;
pub(crate) mod wake;
pub(crate) mod worker;

use std::collections::HashMap;
use std::fmt::Write as _;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, Mutex, PoisonError};
use std::time::Duration;

use parallax_protocol::jsonrpc::ErrorObject;
use parallax_protocol::{
    AccountChoice, AgentAcceptParams, AgentAcceptResult, AgentApproveParams, AgentApproveResult,
    AgentAttachParams, AgentAttachResult, AgentDelivery, AgentEffort, AgentImageParams,
    AgentOpenPrResult, AgentOutcome, AgentOutputItem, AgentPermission, AgentRun, AgentSendParams,
    AgentStartParams, ApprovalId, CoordinatorThreadId, ErrorKind, GitStatus, ImageId,
    ImageMediaType, ParallaxEvent, PrActParams, PrDiffResult, PrViewParams, ProjectId,
    ProjectPermission, PromptImage, PullRequest, QueueResult, Role, RunId, TurnId,
};
use parallax_store::{RunFields, RunState, StoreError, ThreadFields, WorktreeFields};
use tokio::sync::{mpsc, oneshot};
use tokio_util::sync::CancellationToken;
use tokio_util::task::TaskTracker;
use tracing::{error, info, warn};
use uuid::Uuid;

use self::actor::{Actor, Command, Queued};
pub(crate) use self::actor::{Delivery, GitAction, QueueOp, logged_events, session_account};
pub(crate) use self::approvals::APPROVAL_TIMEOUT;
pub(crate) use self::convert::NO_WRITE;
pub(crate) use self::convert::agent_run as snapshot;
use self::convert::{
    COMPLETED, RUNNING, STARTING, WORKSPACE_WRITE, agent_run, option_name, option_value,
};
pub(crate) use self::resume::Timing as ResumeTiming;
use self::worker::{StoredKeyAccounts, sandbox_path, worker_unavailable};
use crate::backend::{Backend, ToolPolicy, check_argument};
use crate::context::memory;
use crate::orchestrator::{self, Lane};
use crate::routing::{self, BackendRegistry, Defaults, Resolved, RoutingError};
use crate::server::Daemon;
use crate::worktree::{CreatedWorktree, PrError, WorktreeError, WorktreeManager, github_pr_urls};

/// How long a stopping plxd waits for its runs to record that they were interrupted.
const SHUTDOWN_WAIT: Duration = Duration::from_secs(15);

/// Every run's actor, and what they share.
pub(crate) struct Agents {
    backends: BackendRegistry,
    worktrees: WorktreeManager,
    actors: Mutex<HashMap<RunId, mpsc::Sender<Command>>>,
    running: AtomicU32,
    tracker: TaskTracker,
    shutdown: CancellationToken,
    /// How long a run's permission request waits for an answer (PLX-222).
    approval_timeout: Duration,
    /// When a run a usage limit stopped resumes (PLX-371).
    resume_timing: ResumeTiming,
    /// Wakes the dispatcher of children waiting to be placed (PLX-413, [`placement`]).
    pub(crate) placement: tokio::sync::Notify,
    /// Held from placing a Project's child until it counts as running or waiting, so two at once
    /// never both take a Project's last free slot (0046).
    placing: tokio::sync::Mutex<()>,
}

impl std::fmt::Debug for Agents {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Agents")
            .field("backends", &self.backends)
            .field("running", &self.running())
            .finish_non_exhaustive()
    }
}

/// What starting a run's CLI needs, from [`prepare`].
pub(super) struct Prepared {
    resolved: Resolved,
    accounts: StoredKeyAccounts,
    place: Place,
}

/// Where a run's CLI starts, and what that needs.
pub(super) enum Place {
    /// A thread, in its worktree or its repo entry's checkout: a normal thread, or a Project's
    /// child (0042). With `approvals` it runs as the full CLI (0034). Without, Claude Code keeps
    /// the worker sandbox (0013), which needs these folders. A child's first message starts with
    /// `header`.
    Worker {
        home: PathBuf,
        data_dir: PathBuf,
        context: PathBuf,
        header: Option<String>,
    },
    /// A project's coordinator, with no sandbox (0024), in a detached worktree of `repo` that the
    /// actor moves to the integration branch's tip before each CLI process (0042).
    Coordinator { repo: PathBuf },
}

impl Agents {
    /// A runner that starts workers on `backends`, in worktrees `worktrees` makes.
    pub fn new(backends: BackendRegistry, worktrees: WorktreeManager) -> Self {
        Self {
            backends,
            worktrees,
            actors: Mutex::new(HashMap::new()),
            running: AtomicU32::new(0),
            tracker: TaskTracker::new(),
            shutdown: CancellationToken::new(),
            approval_timeout: APPROVAL_TIMEOUT,
            resume_timing: ResumeTiming::default(),
            placement: tokio::sync::Notify::new(),
            placing: tokio::sync::Mutex::new(()),
        }
    }

    /// Denies a permission request nobody answered after `timeout` instead of
    /// [`APPROVAL_TIMEOUT`].
    #[must_use]
    pub fn with_approval_timeout(mut self, timeout: Duration) -> Self {
        self.approval_timeout = timeout;
        self
    }

    /// How long a permission request waits for an answer.
    pub(super) fn approval_timeout(&self) -> Duration {
        self.approval_timeout
    }

    /// Resumes runs a usage limit stopped with `timing` instead of the default.
    #[must_use]
    pub fn with_resume_timing(mut self, timing: ResumeTiming) -> Self {
        self.resume_timing = timing;
        self
    }

    /// When a run a usage limit stopped resumes.
    pub(super) fn resume_timing(&self) -> ResumeTiming {
        self.resume_timing
    }

    /// How many runs have a CLI running, for `host/health`.
    pub fn running(&self) -> u32 {
        self.running.load(Ordering::Relaxed)
    }

    /// Runs `task` to the end even if the request that started it is dropped, as when its
    /// connection closes: a disconnect never stops an agent (0007).
    pub async fn detached<T: Send + 'static>(
        &self,
        task: impl Future<Output = Result<T, ErrorObject>> + Send + 'static,
    ) -> Result<T, ErrorObject> {
        self.tracker.spawn(task).await.map_err(|error| {
            ErrorObject::internal_error(format!("the run's task failed: {error}"))
        })?
    }

    fn actor(&self, id: RunId) -> Option<mpsc::Sender<Command>> {
        self.actors
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .get(&id)
            .cloned()
    }

    fn spawn(&self, actor: Actor) -> mpsc::Sender<Command> {
        let (commands, receiver) = mpsc::channel(16);
        self.actors
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .insert(actor.id(), commands.clone());
        self.tracker
            .spawn(actor.run(receiver, self.shutdown.clone()));
        commands
    }

    /// Runs `task` in the background, dropping it when plxd stops.
    pub(crate) fn background(&self, task: impl Future<Output = ()> + Send + 'static) {
        let shutdown = self.shutdown.clone();
        self.tracker.spawn(async move {
            tokio::select! {
                () = shutdown.cancelled() => {}
                () = task => {}
            }
        });
    }

    /// Stops every running CLI, and waits a while for their runs to record that they were
    /// interrupted. Called once, when plxd stops, before the store closes.
    pub async fn shutdown(&self) {
        self.shutdown.cancel();
        self.tracker.close();
        if tokio::time::timeout(SHUTDOWN_WAIT, self.tracker.wait())
            .await
            .is_err()
        {
            warn!("some agent runs did not record that they were interrupted in time");
        }
    }
}

/// Stores `job`'s answer from the store's thread. The runner's store jobs are never cancelled:
/// a run's bookkeeping has to happen whether or not anyone is still waiting for it.
async fn store<T: Send + 'static>(
    daemon: &Daemon,
    job: impl FnOnce(&mut crate::store::Tx) -> Result<T, ErrorObject> + Send + 'static,
) -> Result<T, ErrorObject> {
    daemon.store.run(&CancellationToken::new(), job).await
}

pub(crate) fn store_error(error: &StoreError) -> ErrorObject {
    error!(%error, "the project store failed for an agent run");
    ErrorObject::internal_error(format!("the project store failed: {error}"))
}

pub(crate) fn run_not_found(id: RunId) -> ErrorObject {
    ErrorObject::parallax(ErrorKind::RunNotFound, format!("no agent run has id {id}"))
}

pub(crate) fn run_accepted(id: RunId) -> ErrorObject {
    ErrorObject::parallax(
        ErrorKind::RunAccepted,
        format!("run {id} was accepted; its worktree and branch are gone"),
    )
}

fn requested_account(account: Option<&AccountChoice>) -> Option<String> {
    account.and_then(|account| serde_json::to_string(account).ok())
}

/// The project's repository, the routing inputs, and the paths run `run` of `project` needs,
/// checked: everything that can refuse a worker, or a coordinator when `role` is one, before
/// anything is created. For a run that exists already, or one that isn't a thread.
pub(super) async fn prepare(
    daemon: &Arc<Daemon>,
    project: ProjectId,
    run: RunId,
    requested: Option<AccountChoice>,
    role: Role,
) -> Result<(Prepared, String), ErrorObject> {
    prepare_run(daemon, project, run, requested, role, false).await
}

/// [`prepare`], where `new_thread` says the run being created is a normal thread's
/// (`thread/start`), whose thread row doesn't exist yet.
async fn prepare_run(
    daemon: &Arc<Daemon>,
    project: ProjectId,
    run: RunId,
    requested: Option<AccountChoice>,
    role: Role,
    new_thread: bool,
) -> Result<(Prepared, String), ErrorObject> {
    let (repo_path, context_scope, project_row, thread_run, defaults, mut accounts) =
        store(daemon, move |db| {
            let repo_path = crate::threads::scope_path(db, project)?;
            // A run whose scope is a Project, not a repo entry, is its coordinator or one of its
            // children (0042).
            let project_row = db
                .get_project(project.into())
                .map_err(|e| store_error(&e))?;
            // The run itself is a thread: one `thread/start` made, or a Project's child, not any
            // run on a repo entry, such as one `agent/start` made there.
            let thread_run = new_thread
                || project_row.is_some()
                || db
                    .get_thread(run.into())
                    .map_err(|e| store_error(&e))?
                    .is_some();
            let context_scope = crate::threads::context_scope(db, project, run)?;
            let defaults = crate::methods::read_defaults(db)?;
            let mut accounts = HashMap::new();
            for account in db.list_accounts().map_err(|error| store_error(&error))? {
                let account = crate::store::key_account(account)?;
                accounts.insert(account.id, account.provider);
            }
            Ok((
                repo_path,
                context_scope,
                project_row,
                thread_run,
                defaults,
                StoredKeyAccounts(accounts),
            ))
        })
        .await?;
    let chosen = requested.as_ref().or(defaults.worker.as_ref());
    placement::api_keys(role, project_row.as_ref(), chosen, &mut accounts)?;
    let defaults = Defaults {
        coordinator: defaults.coordinator,
        worker: defaults.worker,
    };
    let policy = match role {
        Role::Coordinator => ToolPolicy::NoWrite,
        Role::Worker => ToolPolicy::WorkspaceWrite,
    };
    let resolved = routing::resolve(
        &daemon.agents.backends,
        &accounts,
        &defaults,
        role,
        requested,
        policy,
    )
    .map_err(|error| routing_error(&error))?;
    if role == Role::Coordinator {
        let place = Place::Coordinator {
            repo: PathBuf::from(&repo_path),
        };
        let prepared = Prepared {
            resolved,
            accounts,
            place,
        };
        return Ok((prepared, repo_path));
    }
    // A Codex or Cursor thread is full Codex or Cursor Agent, with no worker sandbox to check
    // (0035, 0036). Any other run on them is refused, even one on a repo entry: they run nothing
    // else.
    if !(thread_run && resolved.backend().full_thread()) {
        worker::check_backend(resolved.backend())?;
    }
    if let Some(cli) = worker::cli_of(resolved.backend()) {
        // Only this CLI's status: a full probe also waits on the slowest of the others.
        let mut detected = daemon.cli_detector.get(cli).await;
        if worker::check_version(cli, Some(&detected)).is_err() {
            // The user may have just updated the CLI: look again before refusing.
            detected = daemon.cli_detector.refresh_one(cli).await;
            worker::check_version(cli, Some(&detected))?;
        }
        #[cfg(target_os = "linux")]
        if cli == parallax_protocol::CliKind::Claude {
            worker::check_linux_sandbox(&daemon.cli_detector, Some(&detected)).await?;
        }
    }
    let home = worker::home()?;
    let data_dir = sandbox_path(daemon.data_dir.root(), "plxd's data folder")?;
    let context = crate::context::ensure_dir(&daemon.data_dir, context_scope).map_err(|error| {
        worker_unavailable(format!(
            "could not create the shared context folder: {error}"
        ))
    })?;
    let context = sandbox_path(&context, "the shared context folder")?;
    sandbox_path(Path::new(&repo_path), "the project's repository")?;
    let header = match project_row.map(|row| row.name) {
        Some(name) => Some(child_header(&name, &memory::start(daemon, project).await?)),
        None => None,
    };
    let prepared = Prepared {
        resolved,
        accounts,
        place: Place::Worker {
            home,
            data_dir,
            context,
            header,
        },
    };
    Ok((prepared, repo_path))
}

/// What a run asks of its CLI beyond the prompt (PLX-97), each `None` for the CLI's default. The
/// run keeps them for every launch, including a resume. A waiting message stores its own as JSON
/// (PLX-370).
#[derive(Clone, Debug, Default, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(default)]
pub(crate) struct RunOptions {
    pub model: Option<String>,
    pub effort: Option<AgentEffort>,
    pub permission: Option<AgentPermission>,
    pub context_window: Option<u32>,
    pub fast: Option<bool>,
}

impl RunOptions {
    /// Refuses, with `unsupportedOption`, a model name that can't be a CLI argument, or an
    /// effort, permission, context window, or fast mode that `backend` doesn't map.
    fn check(&self, backend: &dyn Backend) -> Result<(), ErrorObject> {
        let refuse = |detail: String| ErrorObject::parallax(ErrorKind::UnsupportedOption, detail);
        let name = backend.name();
        if let Some(model) = &self.model
            && check_argument("model", model).is_err()
        {
            return Err(refuse(format!(
                "the model {model:?} can't be passed to the {name} backend's CLI"
            )));
        }
        if let Some(effort) = self.effort
            && !backend.efforts().contains(&effort)
        {
            let effort = option_name(effort).unwrap_or_default();
            return Err(refuse(format!(
                "the {name} backend can't run with effort {effort}"
            )));
        }
        if let Some(permission) = self.permission
            && !backend.permissions().contains(&permission)
        {
            let permission = option_name(permission).unwrap_or_default();
            return Err(refuse(format!(
                "the {name} backend can't run with permission {permission}"
            )));
        }
        if let Some(tokens) = self.context_window
            && !backend.context_windows().contains(&tokens)
        {
            return Err(refuse(format!(
                "the {name} backend can't run with a {tokens}-token context window"
            )));
        }
        if self.fast.is_some() && !backend.fast_mode() {
            return Err(refuse(format!(
                "the {name} backend can't run in or out of fast mode"
            )));
        }
        Ok(())
    }

    /// For a fork onto `backend` when its parent ran on another (0050): drops the effort,
    /// permission (unless [`NewFork::keep_permission`]), context window, and fast mode `backend`
    /// doesn't map, and the parent's model unless `thread/fork` named one, here and in `fields`.
    fn fork_onto(&mut self, fork: Option<&NewFork>, backend: &dyn Backend, fields: &mut RunFields) {
        let Some(fork) = fork.filter(|fork| backend.name() != fork.parent_backend) else {
            return;
        };
        if !fork.model_given {
            self.model = None;
        }
        self.effort = self.effort.filter(|e| backend.efforts().contains(e));
        self.permission = self
            .permission
            .filter(|p| fork.keep_permission || backend.permissions().contains(p));
        self.context_window = self
            .context_window
            .filter(|w| backend.context_windows().contains(w));
        self.fast = self.fast.filter(|_| backend.fast_mode());
        fields.model.clone_from(&self.model);
        fields.effort = self.effort.and_then(option_name);
        fields.permission = self.permission.and_then(option_name);
        fields.context_window = self.context_window;
        fields.fast = self.fast;
    }
}

fn routing_error(error: &RoutingError) -> ErrorObject {
    match error {
        &RoutingError::NoAccount { role } => ErrorObject::parallax(
            ErrorKind::NoDefaultAccount,
            format!(
                "no account was named, and the {} role has no default; set one with \
                 accounts/defaults/set",
                crate::store::role_text(role)
            ),
        ),
        &RoutingError::UnknownKeyAccount { id } => ErrorObject::parallax(
            ErrorKind::AccountNotFound,
            format!("no key account has id {id}"),
        ),
        RoutingError::UnknownBackend { .. } | RoutingError::UnknownProvider { .. } => {
            worker_unavailable(error.to_string())
        }
        RoutingError::UnknownChoice => {
            ErrorObject::invalid_params("account must be a subscription or a key")
        }
    }
}

/// Switches the checkout at `repo_path`, `project`'s (a thread's repo entry), to `reference`.
/// Refuses, with `worktreeFailed`, while another thread runs in it, since the switch would move
/// that thread's work to a branch it never chose.
async fn switch_checkout(
    daemon: &Daemon,
    project: ProjectId,
    repo_path: &Path,
    reference: &str,
) -> Result<(), ErrorObject> {
    let busy = store(daemon, move |db| {
        db.list_runs(Some(project.into()))
            .map(|runs| {
                runs.iter().any(|run| {
                    run.fields.checkout && [STARTING, RUNNING].contains(&run.state.status.as_str())
                })
            })
            .map_err(|e| store_error(&e))
    })
    .await?;
    if busy {
        return Err(ErrorObject::parallax(
            ErrorKind::WorktreeFailed,
            "another thread is running in this checkout; switching its branch would move that \
             thread's work",
        ));
    }
    daemon
        .agents
        .worktrees
        .switch(repo_path, reference)
        .await
        .map_err(|error| worktree_failed(&error))
}

fn worktree_failed(error: &WorktreeError) -> ErrorObject {
    ErrorObject::parallax(ErrorKind::WorktreeFailed, error.to_string())
}

/// The run `run_id` already is, for a retry of `agent/start` that asks for the same `fields`, or
/// `idConflict` if they differ. The backend isn't compared: routing resolves it, not the
/// request, and neither is a parent the store no longer has. `None` for a new run.
async fn existing(
    daemon: &Arc<Daemon>,
    run_id: RunId,
    fields: &RunFields,
) -> Result<Option<AgentRun>, ErrorObject> {
    let found = store(daemon, move |db| {
        let Some(row) = db.get_run(run_id.into()).map_err(|e| store_error(&e))? else {
            return Ok(None);
        };
        let worktree = db
            .get_worktree(run_id.into())
            .map_err(|e| store_error(&e))?;
        Ok(Some((row, worktree)))
    })
    .await?;
    let Some((row, worktree)) = found else {
        return Ok(None);
    };
    // An empty stored parent isn't compared: deleting the parent cleared it (0041), and a retry
    // still names it.
    let stored = RunFields {
        backend: fields.backend.clone(),
        parent: row.fields.parent.or(fields.parent),
        ..row.fields.clone()
    };
    if stored != *fields {
        return Err(ErrorObject::parallax(
            ErrorKind::IdConflict,
            format!(
                "run {run_id} exists with a different project, prompt, account, policy, \
                 coordinator thread, parent, notify, model, effort, permission, context window, \
                 fast mode, or approvals"
            ),
        ));
    }
    agent_run(&row, worktree.as_ref()).map(Some)
}

/// Creates `run_id`'s worktree of `repo_path`, and returns it with its canonical path and the
/// repository's shared git folder, both checked for the sandbox. A worktree whose paths the
/// sandbox can't hold is removed again.
async fn create_worktree(
    agents: &Agents,
    repo_path: &Path,
    run_id: RunId,
    thread: Option<&NewThread>,
    base: Option<&str>,
) -> Result<(CreatedWorktree, PathBuf, PathBuf), ErrorObject> {
    let branch_slug = thread.and_then(|thread| thread.branch_slug.as_deref());
    let base = base.or(thread.and_then(|thread| thread.git_ref.as_deref()));
    let created = agents
        .worktrees
        .create_named(repo_path, run_id, base, branch_slug)
        .await
        .map_err(|error| worktree_failed(&error))?;
    let paths = async {
        let worktree = sandbox_path(&created.path, "the run's worktree")?;
        let common = agents
            .worktrees
            .git_common_dir(repo_path)
            .await
            .map_err(|error| worktree_failed(&error))?;
        let common = sandbox_path(&common, "the repository's git folder")?;
        Ok::<_, ErrorObject>((worktree, common))
    }
    .await;
    match paths {
        Ok((worktree, common)) => Ok((created, worktree, common)),
        Err(error) => {
            if let Err(cleanup) = agents
                .worktrees
                .remove(repo_path, &created.path, &created.branch)
                .await
            {
                warn!(run = %run_id, %cleanup, "could not remove a worktree for a run that didn't start");
            }
            Err(error)
        }
    }
}

/// The canonical paths a run in `repo_path`'s own checkout needs, checked for the sandbox: the
/// checkout, its cwd, and the repository's shared git folder, which stays read-only to it.
pub(super) async fn checkout_paths(
    agents: &Agents,
    repo_path: &Path,
) -> Result<(PathBuf, PathBuf), ErrorObject> {
    let cwd = sandbox_path(repo_path, "the project's repository")?;
    let common = agents
        .worktrees
        .git_common_dir(repo_path)
        .await
        .map_err(|error| worktree_failed(&error))?;
    let common = sandbox_path(&common, "the repository's git folder")?;
    Ok((cwd, common))
}

/// Records run `run_id` through the orchestrator's `thread.create` (0059), in `lane`, which the
/// caller holds: its run row, its worktree's when it has one, and its thread's when it is one,
/// with `agent.started` and `thread.started`, in one transaction. `prepare_run` read the scope
/// in an earlier job, so a Project that `project/delete` removed since gets no run (PLX-338).
/// Removes the worktree `created` when the run isn't recorded.
async fn record(
    daemon: &Arc<Daemon>,
    lane: &Lane<'_>,
    run_id: RunId,
    (fields, state): (RunFields, RunState),
    thread: Option<ThreadFields>,
    repo_path: &Path,
    created: Option<&CreatedWorktree>,
) -> Result<
    (
        parallax_store::Run,
        Option<parallax_store::Worktree>,
        Option<parallax_store::Thread>,
    ),
    ErrorObject,
> {
    let worktree = created.map(|created| WorktreeFields {
        repo_path: repo_path.to_string_lossy().into_owned(),
        path: created.path.to_string_lossy().into_owned(),
        branch: created.branch.clone(),
        base: created.base.clone(),
        git_dir: created.git_dir.to_string_lossy().into_owned(),
        base_dirty: created.base_dirty,
    });
    let command = orchestrator::Command::new(
        None,
        run_id,
        orchestrator::Action::Create(Box::new(orchestrator::NewRows {
            fields,
            state,
            worktree,
            thread,
        })),
    );
    let recorded = daemon
        .orchestrator
        .commit(daemon, lane, command)
        .await
        .and_then(orchestrator::Outcome::rows)
        .and_then(|rows| {
            let run = rows
                .run
                .ok_or_else(|| ErrorObject::internal_error("a recorded run has no row"))?;
            Ok((run, rows.worktree, rows.thread))
        });
    if recorded.is_err()
        && let Some(created) = created
        && let Err(cleanup) = daemon
            .agents
            .worktrees
            .remove(repo_path, &created.path, &created.branch)
            .await
    {
        warn!(run = %run_id, %cleanup, "could not remove a worktree for a run that wasn't recorded");
    }
    recorded
}

/// The permission mode every run in `scope` runs in (0042): its Project's, or `None` when `scope`
/// is a repo entry, whose threads keep their own.
pub(super) async fn project_mode(
    daemon: &Arc<Daemon>,
    scope: ProjectId,
) -> Result<Option<ProjectPermission>, ErrorObject> {
    store(daemon, move |db| {
        let row = db.get_project(scope.into()).map_err(|e| store_error(&e))?;
        Ok(row.map(|row| crate::store::project_permission(&row.permission)))
    })
    .await
}

/// Cuts Project `scope`'s integration branch and its worktree when either is missing (0045), and
/// returns the project row as it stands, with its integration branch. `None` when `scope` is a
/// repo entry, not a Project.
pub(crate) async fn integration(
    daemon: &Arc<Daemon>,
    scope: ProjectId,
) -> Result<Option<parallax_store::Project>, ErrorObject> {
    let Some(mut row) = store(daemon, move |db| {
        db.get_project(scope.into()).map_err(|e| store_error(&e))
    })
    .await?
    else {
        return Ok(None);
    };
    let worktrees = &daemon.agents.worktrees;
    let repo = Path::new(&row.repo_path);
    let base = match &row.base_branch {
        Some(base) => base.clone(),
        None => worktrees
            .default_branch(repo)
            .await
            .map_err(|error| worktree_failed(&error))?,
    };
    let branch = worktrees
        .ensure_integration(
            repo,
            scope,
            row.integration_branch.as_deref(),
            &row.name,
            &base,
        )
        .await
        .map_err(|error| worktree_failed(&error))?;
    if row.integration_branch.as_ref() != Some(&branch) || row.base_branch.is_none() {
        let (recorded, base_branch) = (branch.clone(), base.clone());
        store(daemon, move |db| {
            db.set_integration_branch(scope.into(), &recorded, &base_branch)
                .map_err(|e| store_error(&e))
        })
        .await?;
        row.base_branch.get_or_insert(base);
        row.integration_branch = Some(branch);
    }
    Ok(Some(row))
}

/// The Project's `mode` as a run on `backend` takes it, from its [`Backend::project_permissions`],
/// or `unsupportedOption` saying why it can't: a run in a Project is never moved to another mode
/// (0042).
pub(super) fn in_mode(
    backend: &dyn Backend,
    mode: ProjectPermission,
) -> Result<AgentPermission, ErrorObject> {
    let name = actor::backend_name(backend.name());
    let maps = |mode: ProjectPermission| {
        mode.agent()
            .filter(|permission| backend.project_permissions().contains(permission))
    };
    let (label, other) = match mode {
        ProjectPermission::Auto => ("Auto", ProjectPermission::Bypass),
        ProjectPermission::Bypass => ("Bypass Permissions", ProjectPermission::Auto),
        ProjectPermission::Unknown => {
            return Err(ErrorObject::parallax(
                ErrorKind::UnsupportedOption,
                "the Project's permission mode is one this plxd doesn't know",
            ));
        }
    };
    if let Some(permission) = maps(mode) {
        return Ok(permission);
    }
    let detail = if maps(other).is_some() {
        let other = if other == ProjectPermission::Bypass {
            "Bypass"
        } else {
            "Auto"
        };
        // A model service has Auto in its threads but not in a Project.
        let scope = if mode
            .agent()
            .is_some_and(|permission| backend.permissions().contains(&permission))
        {
            " in a Project"
        } else {
            ""
        };
        format!("{name} has no {label}{scope}. Set the Project to {other} to use it.")
    } else {
        format!("{name} has neither Auto nor Bypass Permissions, so it can't run in a Project.")
    };
    Err(ErrorObject::parallax(ErrorKind::UnsupportedOption, detail))
}

/// `project/fromThreads`' check that a run on backend `name` can run in Project mode `mode`. A
/// backend this host no longer has passes, since its run can't start anywhere.
pub(crate) fn fits_mode(
    daemon: &Daemon,
    name: &str,
    mode: ProjectPermission,
) -> Result<(), ErrorObject> {
    match daemon.agents.backends.by_backend_name(name) {
        Some((_, backend)) => in_mode(backend.as_ref(), mode).map(|_| ()),
        None => Ok(()),
    }
}

/// Stages `row`'s `agent.started` on its project's events, in the job that records it.
pub(crate) fn stage_started(
    db: &mut crate::store::Tx,
    row: &parallax_store::Run,
    worktree: Option<&parallax_store::Worktree>,
) -> Result<(), ErrorObject> {
    let run = agent_run(row, worktree)?;
    db.stage(
        run.created_at,
        Some(run.project),
        ParallaxEvent::AgentStarted {
            run_id: run.id,
            run: Some(run),
        },
    );
    Ok(())
}

/// `agent/start`: see the module documentation. Idempotent on the run id.
pub(crate) async fn start(
    daemon: Arc<Daemon>,
    params: AgentStartParams,
) -> Result<AgentRun, ErrorObject> {
    let AgentStartParams {
        run_id,
        project,
        prompt,
        account,
        coordinator_thread,
        model,
        effort,
        permission,
        context_window,
        fast,
        images,
        approvals,
        threads,
        notify,
        explore,
        ..
    } = params;
    let new = NewRun {
        run_id,
        scope: project,
        prompt,
        images,
        threads,
        account,
        coordinator_thread,
        notify: notify.unwrap_or(true),
        options: RunOptions {
            model,
            effort,
            permission,
            context_window,
            fast,
        },
        approvals,
        explore,
        thread: None,
    };
    Ok(create(daemon, new).await?.run)
}

/// A run to create: a project's worker, or a normal thread (#110), which belongs to a repo entry
/// instead of a project.
pub(crate) struct NewRun {
    pub run_id: RunId,
    /// The project, or for a thread its repo entry, whose id the run's events go to.
    pub scope: ProjectId,
    pub prompt: String,
    /// The prompt's images (PLX-191), already checked.
    pub images: Vec<PromptImage>,
    /// The threads attached to the prompt (PLX-372), already checked.
    pub threads: Vec<RunId>,
    pub account: Option<AccountChoice>,
    /// The coordinator thread starting the run through `plxd mcp` (#195).
    pub coordinator_thread: Option<CoordinatorThreadId>,
    /// The run wakes its parent, if it has one, when a CLI process of its ends (PLX-380, 0025).
    pub notify: bool,
    pub options: RunOptions,
    /// The client answers the run's permission requests (PLX-222, 0031).
    pub approvals: bool,
    /// A Project's exploration child, which never lands (0045).
    pub explore: bool,
    pub thread: Option<NewThread>,
}

/// What a normal thread adds to a run.
pub(crate) struct NewThread {
    /// A thread with no repo's own scratch repository, which the caller made. Its worktree is
    /// cut from this instead of from the scope's path.
    pub scratch: Option<PathBuf>,
    /// The name after `parallax/` for the worktree's branch, already checked.
    pub branch_slug: Option<String>,
    /// Work in the repo entry's own checkout instead of a worktree. Never set with `scratch`.
    pub checkout: bool,
    /// The ref the worktree starts from, or with `checkout`, the ref the checkout switches to
    /// first. Already checked.
    pub git_ref: Option<String>,
    /// The run that launches it (0041), already checked to exist.
    pub parent: Option<RunId>,
    /// Its fork origin and title (0041), already checked.
    pub fields: ThreadFields,
    /// Set for a fork (0050): no CLI starts, and its log begins with the parent's transcript.
    pub fork: Option<NewFork>,
}

/// What a fork (0050) adds to a new thread.
pub(crate) struct NewFork {
    /// The parent's backend: its model carries over only to the same one.
    pub parent_backend: String,
    /// Whether `thread/fork` named the model.
    pub model_given: bool,
    /// Whether the fork keeps its parent's permission onto a backend that doesn't map it, so
    /// [`RunOptions::check`] refuses it: set for a fork a thread asked for, whose mode is capped
    /// at its caller's (PLX-465). Dropping it would run the fork in the default, Edit, which can
    /// be more than the caller's.
    pub keep_permission: bool,
    /// The parent's `agent.output` items up to the fork point, one list per event, oldest first.
    pub transcript: Vec<Vec<AgentOutputItem>>,
}

/// A created run, and its thread row for a normal thread.
pub(crate) struct CreatedRun {
    pub run: AgentRun,
    pub thread: Option<parallax_store::Thread>,
}

/// A new run's parent (0041): the one its thread names, or the coordinator that starts it, whose
/// subagents are its children.
fn parent(thread: Option<&NewThread>, coordinator: Option<CoordinatorThreadId>) -> Option<Uuid> {
    thread
        .and_then(|thread| thread.parent)
        .map(Uuid::from)
        .or(coordinator.map(Uuid::from))
}

/// A new fork's run, recorded with no CLI (0050): logs the parent's transcript up to the fork
/// point as the fork's own, after its `agent.started`, in one job. Its first `agent/send` starts a
/// CLI. The copy is its own job, after the one that records the run, since a long transcript
/// shouldn't hold that one up: a crash between the two leaves the fork with none of it.
async fn fork_created(
    daemon: &Daemon,
    project: ProjectId,
    run_id: RunId,
    fork: NewFork,
    row: &parallax_store::Run,
    worktree: Option<parallax_store::Worktree>,
    thread: Option<parallax_store::Thread>,
) -> Result<CreatedRun, ErrorObject> {
    let at = row.created_at;
    let copied = store(daemon, move |db| {
        for items in fork.transcript {
            db.stage(
                at,
                Some(project),
                ParallaxEvent::AgentOutput {
                    run_id,
                    items,
                    compacted: None,
                },
            );
        }
        Ok(())
    })
    .await;
    if let Err(error) = copied {
        warn!(run = %run_id, error = %error.message, "could not copy a fork's transcript");
    }
    Ok(CreatedRun {
        run: agent_run(row, worktree.as_ref())?,
        thread,
    })
}

/// Creates and starts a run: see the module documentation. Idempotent on the run id. A fork
/// (`NewThread::fork`) is created with no CLI, at rest where its parent's turn ended.
pub(crate) async fn create(daemon: Arc<Daemon>, new: NewRun) -> Result<CreatedRun, ErrorObject> {
    let lane = daemon.orchestrator.lane(new.run_id).await;
    create_started(Arc::clone(&daemon), new, &lane).await
}

/// Creates a run while holding its start guard, including callers' fork validation and workspace
/// preparation. The caller keeps the guard through recording, transcript copying, and cleanup.
#[expect(
    clippy::too_many_lines,
    reason = "one sequence of steps, each of which must happen before the next"
)]
pub(crate) async fn create_started(
    daemon: Arc<Daemon>,
    new: NewRun,
    lane: &Lane<'_>,
) -> Result<CreatedRun, ErrorObject> {
    let agents = &daemon.agents;
    let NewRun {
        run_id,
        scope: project,
        prompt,
        images,
        threads,
        mut account,
        coordinator_thread,
        notify,
        mut options,
        mut approvals,
        explore,
        mut thread,
    } = new;
    let fork = thread.as_mut().and_then(|thread| thread.fork.take());
    // A run in a Project runs in its mode, whatever the request asked for, and asks through the
    // inbox, whoever started it (0042).
    // ponytail: a retry after `project/update` changed the mode gets idConflict; compare the
    // stored mode instead if that bites.
    let mode = project_mode(&daemon, project).await?;
    if let Some(mode) = mode {
        options.permission = mode.agent();
        approvals = true;
    }
    // What the request asks for, as the runs table stores it. Routing fills in the backend below.
    let mut fields = RunFields {
        project_id: project.into(),
        prompt: prompt.clone(),
        requested_account: requested_account(account.as_ref()),
        policy: WORKSPACE_WRITE.to_owned(),
        backend: String::new(),
        coordinator_thread: coordinator_thread.map(Uuid::from),
        parent: parent(thread.as_ref(), coordinator_thread),
        notify_parent: notify && parent(thread.as_ref(), coordinator_thread).is_some(),
        model: options.model.clone(),
        effort: options.effort.and_then(option_name),
        permission: options.permission.and_then(option_name),
        context_window: options.context_window,
        fast: options.fast,
        approvals,
        checkout: thread.as_ref().is_some_and(|thread| thread.checkout),
        explore,
    };

    if let Some(run) = existing(&daemon, run_id, &fields).await? {
        let row = if thread.is_some() {
            Some(crate::threads::existing_thread(&daemon, run_id).await?)
        } else {
            None
        };
        return Ok(CreatedRun { run, thread: row });
    }
    // The attached threads are read before anything is created, so a failure leaves nothing.
    let attached = attached::prompt(&daemon, run_id, &threads, &prompt).await?;
    let (sent, seen) = (attached.text, attached.seen);
    // A Project's child goes where its rules say, or waits (0046).
    let requested = account.clone();
    let mut waiting = None;
    let mut placing = None;
    if let Some(mode) = mode.filter(|_| fork.is_none()) {
        placing = Some(daemon.agents.placing.lock().await);
        let model = options.model.as_deref();
        match placement::place(&daemon, project, None, account.as_ref(), model, mode).await? {
            placement::Placed::Start(placed) => account = Some(placed),
            placement::Placed::Wait { reason, on } => {
                waiting = Some(reason);
                account = on.or(account);
            }
            placement::Placed::Picked => {}
        }
    }
    let (prepared, scope_path) = prepare_run(
        &daemon,
        project,
        run_id,
        account,
        Role::Worker,
        thread.is_some(),
    )
    .await?;
    if let Some(mode) = mode {
        in_mode(prepared.resolved.backend(), mode)?;
    }
    options.fork_onto(fork.as_ref(), prepared.resolved.backend(), &mut fields);
    options.check(prepared.resolved.backend())?;
    let repo_path = match thread.as_ref().and_then(|thread| thread.scratch.clone()) {
        Some(scratch) => scratch.to_string_lossy().into_owned(),
        None => scope_path,
    };
    let (created, (cwd, git_common_dir)) = if fields.checkout {
        if let Some(reference) = thread.as_ref().and_then(|thread| thread.git_ref.as_deref()) {
            switch_checkout(&daemon, project, Path::new(&repo_path), reference).await?;
        }
        (None, checkout_paths(agents, Path::new(&repo_path)).await?)
    } else {
        // A Project's run is cut from its integration branch's tip (0045).
        let base = match mode {
            Some(_) => integration(&daemon, project)
                .await?
                .and_then(|row| row.integration_branch),
            None => None,
        };
        let (created, worktree_path, git_common_dir) = create_worktree(
            agents,
            Path::new(&repo_path),
            run_id,
            thread.as_ref(),
            base.as_deref(),
        )
        .await?;
        (Some(created), (worktree_path, git_common_dir))
    };

    fields.backend = prepared.resolved.backend().name().into();
    let status = match (&fork, &waiting) {
        (Some(_), _) => COMPLETED,
        (None, Some(_)) => convert::WAITING,
        (None, None) => STARTING,
    };
    let state = RunState {
        status: status.to_owned(),
        account_id: prepared.resolved.account_id(),
        error: waiting.clone(),
        ..RunState::default()
    };
    let is_thread = thread.is_some();
    let (row, worktree, thread_row) = record(
        &daemon,
        lane,
        run_id,
        (fields, state),
        thread.map(|thread| thread.fields),
        Path::new(&repo_path),
        created.as_ref(),
    )
    .await?;
    // It counts as starting or waiting now.
    drop(placing);
    info!(run = %run_id, project = %project, backend = %row.fields.backend, thread = is_thread, checkout = row.fields.checkout, "created an agent run");
    if let Some(fork) = fork {
        return fork_created(&daemon, project, run_id, fork, &row, worktree, thread_row).await;
    }
    if waiting.is_some() {
        let run = agent_run(&row, worktree.as_ref())?;
        placement::queue(&daemon, &run, prompt, images, threads, requested).await?;
        if coordinator_thread.is_none() {
            wake::started(&daemon, &run);
        }
        return Ok(CreatedRun {
            run,
            thread: thread_row,
        });
    }

    // A run just created here has no sent turns yet.
    let mut actor = Actor::new(Arc::clone(&daemon), row, worktree, HashMap::new());
    let task = first_prompt(&sent, &prepared.place)?;
    let paths = Some((cwd, git_common_dir));
    actor.attach(None, threads);
    if actor
        .launch(prepared, task, images, None, None, paths)
        .await
    {
        actor.record_initial_seen(seen).await;
    }
    // The actor owns a live CLI from here on, so it is spawned whatever the snapshot says.
    let run = actor.snapshot();
    agents.spawn(actor);
    let run = run?;
    // A run started in a Project wakes its coordinator, unless the coordinator launched it (0043).
    if mode.is_some() && coordinator_thread.is_none() {
        wake::started(&daemon, &run);
    }
    Ok(CreatedRun {
        run,
        thread: thread_row,
    })
}

/// A new thread's first message: `prompt` as the user or the coordinator wrote it, as in Claude
/// Code (0034), after a Project child's header (0042).
pub(super) fn first_prompt(prompt: &str, place: &Place) -> Result<String, ErrorObject> {
    match place {
        Place::Worker { header, .. } => Ok(format!("{}{prompt}", header.as_deref().unwrap_or(""))),
        Place::Coordinator { .. } => Err(ErrorObject::internal_error(
            "a thread was prepared as a coordinator",
        )),
    }
}

/// The start of a Project child's first message (0042): the Project's name, the plxd tools
/// every kind gives a child, which always runs with `approvals` (0041), and then the brief and
/// memory index when there are any (0044). The task follows it.
fn child_header(project: &str, start: &memory::Start) -> String {
    let tools = [
        crate::mcp::thread::TOOLS,
        crate::mcp::thread::CONTEXT_TOOLS,
        crate::mcp::question::CHILD_TOOLS,
        crate::mcp::memory::CHILD_TOOLS,
    ]
    .concat()
    .join(", ");
    let mut header = format!(
        "You are working on a task in the Parallax Project \"{project}\".\n\
         Your Parallax tools are on the plxd MCP server: {tools}.\n\n"
    );
    if let Some(brief) = &start.brief {
        let _ = write!(header, "The Project's brief:\n{brief}\n\n");
    }
    if !start.index.is_empty() {
        header.push_str(&start.index);
        header.push('\n');
    }
    header.push_str("Your task:\n");
    header
}

impl Agents {
    /// Drops run `id`'s actor from the map, so no new command reaches it.
    pub(crate) fn forget(&self, id: RunId) {
        self.actors
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .remove(&id);
    }

    /// Drops run `id`'s idle actor from the map, if no command can still reach it (PLX-459):
    /// none waits in its channel `commands`, and the map's sender is the only one. Every other
    /// sender is cloned from the map under this lock, so once it's removed none can appear, and
    /// a command that already holds one, as [`ask`] does between [`actor_for`] and its send,
    /// keeps the actor running. Whether it was dropped, so the actor stops.
    fn retire(&self, id: RunId, commands: &mpsc::Receiver<Command>) -> bool {
        let mut actors = self.actors.lock().unwrap_or_else(PoisonError::into_inner);
        // The count first: a holder sends and drops its sender without this lock, as
        // `wake::notify` does, so a channel seen empty before the count could fill before it.
        // Once the map's is the only sender, under this lock, every earlier send has landed and
        // no new one can come, so the emptiness check after it is final.
        let alone =
            commands.sender_strong_count() == 1 && actors.contains_key(&id) && commands.is_empty();
        if alone {
            actors.remove(&id);
        }
        alone
    }

    /// The worktrees every run is created in.
    pub(crate) fn worktrees(&self) -> &WorktreeManager {
        &self.worktrees
    }

    /// The backends runs start on.
    pub(crate) fn backends(&self) -> &BackendRegistry {
        &self.backends
    }
}

/// The command channel of `id`'s actor, spawning one for a run created before this plxd
/// started, or whose idle actor stopped (PLX-459).
async fn actor_for(daemon: &Arc<Daemon>, id: RunId) -> Result<mpsc::Sender<Command>, ErrorObject> {
    let agents = &daemon.agents;
    if let Some(actor) = agents.actor(id) {
        return Ok(actor);
    }
    let _lane = daemon.orchestrator.lane(id).await;
    if let Some(actor) = agents.actor(id) {
        return Ok(actor);
    }
    let (row, worktree, turns) = store(daemon, move |db| {
        let row = db
            .get_run(id.into())
            .map_err(|e| store_error(&e))?
            .ok_or_else(|| run_not_found(id))?;
        let worktree = db.get_worktree(id.into()).map_err(|e| store_error(&e))?;
        // Only an accepted run has lost its worktree, and a coordinator or a checkout thread
        // never had one (0024).
        if worktree.is_none()
            && row.state.status != convert::ACCEPTED
            && row.fields.policy != convert::NO_WRITE
            && !row.fields.checkout
        {
            return Err(ErrorObject::internal_error(format!(
                "run {id} has no recorded worktree"
            )));
        }
        let turns = db.run_turns(id.into()).map_err(|e| store_error(&e))?;
        Ok((row, worktree, turns))
    })
    .await?;
    // A restarted actor rebuilds `agent/send`'s idempotency from the store (#190), since a fresh
    // one has no memory of what a previous plxd already sent to this run's CLI.
    let turns = turns
        .into_iter()
        .filter_map(|(turn_id, text)| {
            if let Ok(turn_id) = TurnId::try_from(turn_id) {
                Some((turn_id, text))
            } else {
                warn!(run = %id, "a stored turn id is not a UUIDv7; ignoring it");
                None
            }
        })
        .collect();
    Ok(agents.spawn(Actor::new(Arc::clone(daemon), row, worktree, turns)))
}

async fn ask<T>(
    daemon: &Arc<Daemon>,
    id: RunId,
    command: impl FnOnce(oneshot::Sender<Result<T, ErrorObject>>) -> Command,
) -> Result<T, ErrorObject> {
    let (reply, answer) = oneshot::channel();
    let mut command = command(reply);
    let stopping = || ErrorObject::internal_error("plxd is stopping");
    // An actor that `thread/delete` or `project/delete` just stopped has closed its channel: look
    // the run up again, which then finds it gone.
    for _ in 0..2 {
        let actor = actor_for(daemon, id).await?;
        match actor.send(command).await {
            Ok(()) => return answer.await.map_err(|_| stopping())?,
            Err(mpsc::error::SendError(returned)) => command = returned,
        }
    }
    Err(stopping())
}

/// `agent/send`.
pub(crate) async fn send(
    daemon: Arc<Daemon>,
    params: AgentSendParams,
) -> Result<AgentRun, ErrorObject> {
    let delivery = match params.delivery.unwrap_or_default() {
        AgentDelivery::Queue => Delivery::Queue,
        AgentDelivery::Steer => Delivery::Steer,
        AgentDelivery::Unknown => {
            return Err(ErrorObject::invalid_params(
                "delivery must be queue or steer",
            ));
        }
    };
    send_with(daemon, params, delivery).await
}

/// `agent/send` with `delivery`, which its params' `delivery` can't say for a restart (0059).
pub(crate) async fn send_with(
    daemon: Arc<Daemon>,
    params: AgentSendParams,
    delivery: Delivery,
) -> Result<AgentRun, ErrorObject> {
    let AgentSendParams {
        run_id,
        turn_id,
        text,
        model,
        effort,
        permission,
        context_window,
        fast,
        account,
        images,
        threads,
        from,
        delivery: _,
    } = params;
    if let Some(from) = from {
        sender_exists(&daemon, from).await?;
    }
    let message = Queued {
        turn_id,
        text,
        images,
        threads,
        options: RunOptions {
            model,
            effort,
            permission,
            context_window,
            fast,
        },
        account,
        from,
    };
    ask(&daemon, run_id, |reply| Command::Send {
        message,
        delivery,
        reply,
    })
    .await
}

/// `run.interrupt` (0059): stops run `id`'s turn and keeps its queue, held when `hold_queue`.
pub(crate) async fn interrupt(
    daemon: &Arc<Daemon>,
    id: RunId,
    hold_queue: bool,
) -> Result<AgentRun, ErrorObject> {
    ask(daemon, id, |reply| Command::Interrupt { hold_queue, reply }).await
}

/// `queue/*` (PLX-370): through the run's actor, which keeps its waiting messages.
pub(crate) async fn queue(
    daemon: Arc<Daemon>,
    run_id: RunId,
    op: QueueOp,
    command_id: Option<Uuid>,
) -> Result<QueueResult, ErrorObject> {
    ask(&daemon, run_id, |reply| Command::Queue {
        op,
        command_id,
        reply,
    })
    .await
}

/// Starts the actor of every run that has waiting messages a plxd before this one stored, so
/// they are sent (PLX-370). Called once at startup, after [`recover`].
pub(crate) async fn deliver_queued(daemon: &Arc<Daemon>) {
    let runs = store(daemon, |db| db.queued_runs().map_err(|e| store_error(&e))).await;
    let runs = match runs {
        Ok(runs) => runs,
        Err(error) => {
            warn!(error = %error.message, "could not read which runs have waiting messages");
            return;
        }
    };
    for run in runs {
        let Ok(id) = RunId::try_from(run) else {
            warn!(%run, "a run with waiting messages has an id that is not a UUIDv7");
            continue;
        };
        if let Err(error) = actor_for(daemon, id).await {
            warn!(run = %id, error = %error.message, "could not send a run's waiting messages");
        }
    }
}

/// `agent/image`: one of a run's stored images (PLX-191, decision 0026).
pub(crate) async fn image(
    daemon: &Arc<Daemon>,
    params: AgentImageParams,
) -> Result<PromptImage, ErrorObject> {
    let AgentImageParams { run_id, image_id } = params;
    let stored = store(daemon, move |db| {
        if db
            .get_run(run_id.into())
            .map_err(|e| store_error(&e))?
            .is_none()
        {
            return Err(run_not_found(run_id));
        }
        db.image(run_id.into(), image_id.into())
            .map_err(|e| store_error(&e))
    })
    .await?
    .ok_or_else(|| {
        ErrorObject::parallax(
            ErrorKind::ImageNotFound,
            format!("run {run_id} has no image {image_id}"),
        )
    })?;
    Ok(PromptImage {
        media_type: option_value(&stored.media_type).unwrap_or(ImageMediaType::Unknown),
        data: stored.data,
    })
}

/// `agent/attach`: keeps a page or recording a run's browser tools made with its images
/// (PLX-639). Its data must be base64 of a `text/html` or `video/webm` file.
pub(crate) async fn attach(
    daemon: &Arc<Daemon>,
    params: AgentAttachParams,
) -> Result<AgentAttachResult, ErrorObject> {
    let AgentAttachParams { run_id, attachment } = params;
    if !matches!(
        attachment.media_type,
        ImageMediaType::Html | ImageMediaType::Webm
    ) || crate::images::decode(&attachment.data).is_none()
    {
        return Err(ErrorObject::invalid_params(
            "attachment must be base64 of a text/html or video/webm file",
        ));
    }
    let id = ImageId::generate();
    let stored = parallax_store::StoredImage {
        media_type: option_name(attachment.media_type).unwrap_or_default(),
        data: attachment.data,
    };
    store(daemon, move |db| {
        if db
            .get_run(run_id.into())
            .map_err(|e| store_error(&e))?
            .is_none()
        {
            return Err(run_not_found(run_id));
        }
        db.add_images(run_id.into(), &[(id.into(), stored)])
            .map_err(|e| store_error(&e))
    })
    .await?;
    Ok(AgentAttachResult { image_id: id })
}

/// `agent/cancel`, by the user or, with `from`, by another thread's Parallax tools (0041).
pub(crate) async fn cancel(
    daemon: Arc<Daemon>,
    id: RunId,
    from: Option<RunId>,
) -> Result<AgentRun, ErrorObject> {
    if let Some(from) = from {
        sender_exists(&daemon, from).await?;
    }
    ask(&daemon, id, |reply| Command::Cancel { from, reply }).await
}

/// Fails with `runNotFound` unless `from`, the thread a message or interrupt comes from (0041), is
/// a run on the host.
async fn sender_exists(daemon: &Daemon, from: RunId) -> Result<(), ErrorObject> {
    store(daemon, move |db| {
        db.get_run(from.into())
            .map_err(|e| store_error(&e))?
            .map(|_| ())
            .ok_or_else(|| run_not_found(from))
    })
    .await
}

/// `pr/link` and `pr/unlink` (0041): adds `url`, a GitHub pull request's, to run `run_id`'s
/// links, or removes it, through the run's actor.
pub(crate) async fn link_pr(
    daemon: Arc<Daemon>,
    run_id: RunId,
    url: String,
    linked: bool,
) -> Result<AgentRun, ErrorObject> {
    if linked && github_pr_urls(&url) != [url.as_str()] {
        return Err(ErrorObject::invalid_params(format!(
            "{url:?} is not a GitHub pull request URL, such as https://github.com/owner/repo/pull/1"
        )));
    }
    ask(&daemon, run_id, |reply| Command::LinkPr {
        url,
        linked,
        reply,
    })
    .await
}

/// Renames run `run_id`'s worktree branch for `slug`, a valid branch slug, through the run's
/// actor, once its thread is named (0058).
pub(crate) async fn rename_branch(
    daemon: &Arc<Daemon>,
    run_id: RunId,
    slug: String,
) -> Result<(), ErrorObject> {
    ask(daemon, run_id, |reply| Command::RenameBranch {
        slug,
        reply,
    })
    .await
}

/// `agent/resumeNow` (PLX-371): resumes a run waiting for its usage limit to reset now.
pub(crate) async fn resume_now(daemon: Arc<Daemon>, id: RunId) -> Result<AgentRun, ErrorObject> {
    ask(&daemon, id, |reply| Command::ResumeNow { reply }).await
}

/// `agent/autoResume` (PLX-371): sets or clears a run's auto-resume override.
pub(crate) async fn set_auto_resume(
    daemon: Arc<Daemon>,
    id: RunId,
    auto_resume: Option<bool>,
) -> Result<AgentRun, ErrorObject> {
    ask(&daemon, id, |reply| Command::AutoResume {
        auto_resume,
        reply,
    })
    .await
}

/// `project/fromThreads` (0042): moves run `id` into Project `project` as the child of its
/// coordinator `parent`, through the run's actor, so a live actor takes the new scope too.
pub(crate) async fn join(
    daemon: &Arc<Daemon>,
    id: RunId,
    project: ProjectId,
    parent: RunId,
) -> Result<AgentRun, ErrorObject> {
    ask(daemon, id, |reply| Command::Join {
        project,
        parent,
        reply,
    })
    .await
}

/// `agent/approve` (PLX-222): through the run's actor, which keeps its permission requests. The
/// caller has checked `params`.
pub(crate) async fn approve(
    daemon: Arc<Daemon>,
    params: AgentApproveParams,
) -> Result<AgentApproveResult, ErrorObject> {
    let run_id = params.run_id;
    ask(&daemon, run_id, |reply| Command::Approve { params, reply }).await
}

pub(super) fn approval_not_found(run: RunId, approval: ApprovalId) -> ErrorObject {
    ErrorObject::parallax(
        ErrorKind::ApprovalNotFound,
        format!("run {run} has no permission request {approval}"),
    )
}

/// `thread/delete`'s and `project/delete`'s part in the runner: deletes a run through its actor,
/// which stops a running CLI first and never races the run's own resume, commit, or accept. A
/// push or Open PR in flight refuses it (`gitRefused`), unless `wait`, which waits for it to
/// finish first, as `project/delete` does so it never stops with half its runs deleted (PLX-458).
pub(crate) async fn delete(
    daemon: &Arc<Daemon>,
    id: RunId,
    wait: bool,
    command_id: Option<Uuid>,
) -> Result<(), ErrorObject> {
    ask(daemon, id, |reply| Command::Delete {
        wait,
        command_id,
        reply,
    })
    .await
}

/// `agent/accept`: through the run's actor, so it never races the run's own CLI or commit.
pub(crate) async fn accept(
    daemon: Arc<Daemon>,
    params: AgentAcceptParams,
) -> Result<AgentAcceptResult, ErrorObject> {
    let AgentAcceptParams { run_id, id, commit } = params;
    let (run, merge) = ask(&daemon, run_id, |reply| Command::Accept {
        id,
        reviewed: commit,
        reply,
    })
    .await?;
    Ok(AgentAcceptResult { run, merge })
}

/// `agent/openPr`: through the run's actor, as `agent/accept` is (PLX-168).
pub(crate) async fn open_pr(
    daemon: Arc<Daemon>,
    run_id: RunId,
    title: String,
    body: String,
) -> Result<AgentOpenPrResult, ErrorObject> {
    let url = ask(&daemon, run_id, |reply| Command::OpenPr {
        title,
        body,
        reply,
    })
    .await?;
    Ok(AgentOpenPrResult { url })
}

/// `pr/view` (PLX-318): one of a run's linked pull requests, read with `gh`. Not through the
/// run's actor, so a slow GitHub never holds up a running agent.
pub(crate) async fn view_pr(
    daemon: Arc<Daemon>,
    params: PrViewParams,
) -> Result<PullRequest, ErrorObject> {
    let PrViewParams { run_id, url } = params;
    linked(&daemon, run_id, &url).await?;
    daemon
        .agents
        .worktrees
        .view_pr(&url)
        .await
        .map_err(|error| pr_error(&error))
}

/// `pr/diff` (PLX-328): one of a run's linked pull requests' unified diff, read with `gh` as
/// `pr/view` reads one.
pub(crate) async fn diff_pr(
    daemon: Arc<Daemon>,
    params: PrViewParams,
) -> Result<PrDiffResult, ErrorObject> {
    let PrViewParams { run_id, url } = params;
    linked(&daemon, run_id, &url).await?;
    daemon
        .agents
        .worktrees
        .diff_pr(&url)
        .await
        .map_err(|error| pr_error(&error))
}

/// `pr/act` (PLX-318): does an action to one of a run's linked pull requests with `gh`, as
/// `pr/view` reads one.
pub(crate) async fn act_pr(
    daemon: Arc<Daemon>,
    params: PrActParams,
) -> Result<PullRequest, ErrorObject> {
    let PrActParams {
        run_id,
        url,
        action,
    } = params;
    linked(&daemon, run_id, &url).await?;
    let acted = daemon
        .agents
        .worktrees
        .act_pr(&url, action)
        .await
        .map_err(|error| pr_error(&error))?;
    info!(run = %run_id, %url, ?action, "acted on a pull request");
    Ok(acted)
}

/// Refuses `url` unless it is linked to run `run_id`, so a client can't make plxd run `gh` on
/// any other argument.
async fn linked(daemon: &Daemon, run_id: RunId, url: &str) -> Result<(), ErrorObject> {
    let url = url.to_owned();
    store(daemon, move |db| {
        let row = db
            .get_run(run_id.into())
            .map_err(|e| store_error(&e))?
            .ok_or_else(|| run_not_found(run_id))?;
        if row.state.pull_requests.contains(&url) {
            Ok(())
        } else {
            Err(ErrorObject::invalid_params(format!(
                "{url} is not a pull request linked to run {run_id}"
            )))
        }
    })
    .await
}

/// A failed `gh` or push as the protocol's error.
pub(super) fn pr_error(error: &PrError) -> ErrorObject {
    let kind = match error {
        PrError::Push(_) => ErrorKind::PushFailed,
        PrError::GhUnavailable(_) => ErrorKind::GhUnavailable,
        PrError::Gh(_) => ErrorKind::PrFailed,
    };
    ErrorObject::parallax(kind, error.to_string())
}

/// `agent/gitStatus`, `agent/commit`, and `agent/push`: through the run's actor (PLX-298).
pub(crate) async fn git(
    daemon: Arc<Daemon>,
    run_id: RunId,
    action: GitAction,
) -> Result<GitStatus, ErrorObject> {
    ask(&daemon, run_id, |reply| Command::Git { action, reply }).await
}

/// Marks every run the store still has as `starting` or `running` as `interrupted`: plxd
/// stopped without recording how they ended, as after a crash. Then wakes each project's
/// coordinator for what it missed while plxd was stopped ([`wake::catch_up`], PLX-178), and
/// starts the timers of runs waiting for a usage limit to reset ([`resume::restore`], PLX-371).
/// Called once at startup, before any connection is accepted.
pub(crate) async fn recover(daemon: &Arc<Daemon>) {
    let open = store(daemon, |db| {
        db.run_ids_with_status(&[convert::STARTING, convert::RUNNING])
            .map_err(|e| store_error(&e))
    })
    .await;
    let open = open.unwrap_or_else(|error| {
        warn!(error = %error.message, "could not recover interrupted agent runs");
        Vec::new()
    });
    // A job per run, so one that fails leaves the others recovered.
    for id in open {
        let recovered = store(daemon, move |db| {
            let Some(row) = db.get_run(id).map_err(|e| store_error(&e))? else {
                return Ok(false);
            };
            let state = RunState {
                status: convert::INTERRUPTED.to_owned(),
                ..row.state
            };
            let row = db.update_run(id, &state).map_err(|e| store_error(&e))?;
            // Its last turn never ended, so its replies aren't searchable yet (PLX-487).
            if let Err(error) = db.index_run_text(id) {
                warn!(run = %id, %error, "could not index an interrupted run's text");
            }
            let worktree = db.get_worktree(id).map_err(|e| store_error(&e))?;
            let run = agent_run(&row, worktree.as_ref())?;
            for event in [
                ParallaxEvent::AgentFinished {
                    run_id: run.id,
                    outcome: AgentOutcome::Interrupted,
                },
                ParallaxEvent::AgentUpdated {
                    run_id: run.id,
                    state: convert::run_state(&row),
                },
            ] {
                db.stage(run.updated_at, Some(run.project), event);
            }
            Ok(true)
        })
        .await;
        match recovered {
            Ok(true) => info!(run = %id, "an agent run was interrupted when plxd last stopped"),
            // Deleted since the list was read.
            Ok(false) => {}
            Err(error) => {
                warn!(run = %id, error = %error.message, "could not recover an interrupted agent run");
            }
        }
    }
    wake::catch_up(daemon).await;
    resume::restore(daemon).await;
    placement::start(daemon);
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;
    use std::time::Duration;

    use std::path::Path;

    use parallax_protocol::{ErrorKind, RunId};
    use parallax_store::{ProjectFields, RunFields, RunState};
    use tokio::sync::{mpsc, oneshot};
    use uuid::Uuid;

    use super::actor::{Command, IDLE, QueueOp};
    use super::{child_header, in_mode, queue, record, store, store_error};
    use crate::context::memory::Start;
    use crate::server::Daemon;

    /// PLX-406 (0044): the brief, then the index, between the tools and the task, and neither
    /// when the Project has none.
    #[test]
    fn a_childs_header_carries_the_brief_then_the_index() {
        let start = Start {
            brief: Some("Ship v2.".to_owned()),
            index: "Memory:\n- you preference: Terse (memory/preference/terse.md)\n".to_owned(),
            over: false,
        };
        let header = child_header("app", &start);
        assert!(
            header.ends_with(
                ".\n\nThe Project's brief:\nShip v2.\n\nMemory:\n\
                 - you preference: Terse (memory/preference/terse.md)\n\nYour task:\n"
            ),
            "{header}"
        );
        let bare = child_header("app", &Start::default());
        assert!(bare.ends_with("memory_propose.\n\nYour task:\n"), "{bare}");
    }

    /// PLX-394 (0042): each built-in kind in each Project mode. Claude Code, Codex, and Cursor
    /// map both Auto and Bypass (0053: Cursor's Auto is the SDK's classifier). A run is never
    /// moved up to another mode.
    #[test]
    fn each_kind_runs_a_projects_mode_or_says_why_not() {
        use parallax_protocol::{AgentPermission, ProjectPermission};

        use crate::backend::claude::ClaudeBackend;
        use crate::backend::codex::CodexBackend;
        use crate::backend::process::{Environment, Launcher};
        use crate::paths::DataDir;

        let dir = tempfile::tempdir().unwrap();
        let launcher = Launcher::new(
            DataDir::new(dir.path().join("data")).unwrap(),
            Environment::default(),
        );
        let claude = ClaudeBackend::new(launcher.clone());
        let codex = CodexBackend::new(launcher.clone());
        let cursor = crate::providers::cursor_backend(launcher);
        let (auto, bypass) = (ProjectPermission::Auto, ProjectPermission::Bypass);
        for backend in [&claude as &dyn crate::backend::Backend, &codex, &cursor] {
            assert_eq!(in_mode(backend, auto).unwrap(), AgentPermission::Auto);
            assert_eq!(in_mode(backend, bypass).unwrap(), AgentPermission::Bypass);
        }
    }

    /// PLX-433 (0042): a model service runs Claude Code, which has Auto, but runs a Project's
    /// agents only in Bypass. Its threads keep Auto. One instance keeps its key as a secret and
    /// two don't, so both of plxd's backends for an instance are covered.
    #[tokio::test]
    async fn a_model_service_runs_a_project_only_in_bypass() {
        use parallax_protocol::{
            AgentPermission, ProjectPermission, ProviderEnvVar, ProviderInstance, ProviderKind,
        };

        use crate::backend::process::{Environment, Launcher};
        use crate::keystore::MemoryKeyStore;
        use crate::paths::DataDir;
        use crate::providers::Providers;
        use crate::routing::BackendRegistry;

        let dir = tempfile::tempdir().unwrap();
        let launcher = Launcher::new(
            DataDir::new(dir.path().join("data")).unwrap(),
            Environment::empty(),
        );
        let registry = BackendRegistry::new();
        let providers = Providers::load(
            dir.path(),
            Arc::new(MemoryKeyStore::new()),
            &launcher,
            &registry,
        );
        let kinds = [
            ("ollama-cloud", ProviderKind::OllamaCloud, true),
            ("openrouter", ProviderKind::OpenRouter, true),
            ("local-model", ProviderKind::LocalModel, false),
        ];
        for (id, kind, secret) in kinds {
            let instance = ProviderInstance {
                id: id.into(),
                kind,
                name: id.into(),
                enabled: true,
                program: None,
                home: None,
                args: Vec::new(),
                env: vec![ProviderEnvVar {
                    name: "ANTHROPIC_AUTH_TOKEN".into(),
                    value: Some("key".into()),
                    secret,
                }],
                models: Vec::new(),
                reserve: None,
            };
            providers.save(instance).await.unwrap();
            let (_, backend) = registry.by_backend_name(id).unwrap();
            assert!(backend.permissions().contains(&AgentPermission::Auto));
            assert_eq!(
                in_mode(backend.as_ref(), ProjectPermission::Bypass).unwrap(),
                AgentPermission::Bypass
            );
            let refused = in_mode(backend.as_ref(), ProjectPermission::Auto).unwrap_err();
            assert_eq!(
                refused.parallax_data().unwrap().kind,
                ErrorKind::UnsupportedOption
            );
            assert_eq!(
                refused.message,
                format!("{id} has no Auto in a Project. Set the Project to Bypass to use it.")
            );
        }
    }

    /// PLX-338: a worker start that read its Project before `project/delete` removed it records
    /// no run once the row is gone, so the delete leaves no orphan behind.
    #[tokio::test]
    async fn a_start_racing_a_project_delete_records_no_run() {
        let dir = tempfile::tempdir().unwrap();
        let daemon = Daemon::for_tests(dir.path(), 10, Duration::from_secs(90));
        let project = Uuid::now_v7();
        let fields = ProjectFields {
            name: "app".to_owned(),
            repo_path: "/src/app".to_owned(),
            icon: None,
            permission: "auto".to_owned(),
            autonomy: "routine".to_owned(),
            base_branch: None,
        };
        // The start's `prepare_run` saw the project; the delete then removed it.
        store(&daemon, move |db| {
            db.create_project(project, &fields)
                .map_err(|e| store_error(&e))?;
            db.delete_project(project).map_err(|e| store_error(&e))
        })
        .await
        .unwrap();

        let run_id = RunId::generate();
        let run = RunFields {
            project_id: project,
            prompt: "Build it.".to_owned(),
            requested_account: None,
            policy: super::WORKSPACE_WRITE.to_owned(),
            backend: "fake".to_owned(),
            coordinator_thread: None,
            parent: None,
            notify_parent: false,
            model: None,
            effort: None,
            permission: None,
            context_window: None,
            fast: None,
            approvals: false,
            checkout: false,
            explore: false,
        };
        let state = RunState::default();
        let lane = daemon.orchestrator.lane(run_id).await;
        let error = record(
            &daemon,
            &lane,
            run_id,
            (run, state),
            None,
            Path::new("/src/app"),
            None,
        )
        .await
        .unwrap_err();
        assert_eq!(
            error.parallax_data().map(|data| data.kind),
            Some(ErrorKind::ProjectNotFound)
        );
        let stored = store(&daemon, move |db| {
            db.get_run(run_id.into()).map_err(|e| store_error(&e))
        })
        .await
        .unwrap();
        assert_eq!(stored, None);
    }

    /// Recovery at start is a job per run (0052): a run whose row can't be read as a run doesn't
    /// roll back the others' `interrupted`, or their events.
    #[tokio::test]
    async fn a_run_that_fails_recovery_leaves_the_others_recovered() {
        let dir = tempfile::tempdir().unwrap();
        let daemon = Daemon::for_tests(dir.path(), 100, Duration::from_secs(90));
        let project = Uuid::now_v7();
        // Not a UUIDv7, so it fails conversion to a protocol run.
        let (corrupt, good) = (Uuid::from_u128(1), Uuid::now_v7());
        store(&daemon, move |db| {
            let fields = ProjectFields {
                name: "app".to_owned(),
                repo_path: "/src/app".to_owned(),
                icon: None,
                permission: "auto".to_owned(),
                autonomy: "routine".to_owned(),
                base_branch: None,
            };
            db.create_project(project, &fields)
                .map_err(|e| store_error(&e))?;
            let run = RunFields {
                project_id: project,
                prompt: "Build it.".to_owned(),
                requested_account: None,
                policy: super::WORKSPACE_WRITE.to_owned(),
                backend: "fake".to_owned(),
                coordinator_thread: None,
                parent: None,
                notify_parent: false,
                model: None,
                effort: None,
                permission: None,
                context_window: None,
                fast: None,
                approvals: false,
                checkout: false,
                explore: false,
            };
            let state = RunState {
                status: "running".to_owned(),
                ..RunState::default()
            };
            for id in [corrupt, good] {
                db.create_run(id, &run, &state)
                    .map_err(|e| store_error(&e))?;
            }
            Ok(())
        })
        .await
        .unwrap();

        super::recover(&daemon).await;

        let status = |id: Uuid| {
            let daemon = Arc::clone(&daemon);
            async move {
                store(&daemon, move |db| {
                    Ok(db.get_run(id).unwrap().unwrap().state.status)
                })
                .await
                .unwrap()
            }
        };
        assert_eq!(status(good).await, "interrupted");
        assert_eq!(status(corrupt).await, "running", "its job rolled back");
        let good = RunId::try_from(good).unwrap();
        let (logged, _) = daemon.log.run_events(good, 0, 10, usize::MAX).unwrap();
        assert!(
            logged.iter().any(|entry| entry.kind() == "agent.finished"),
            "{logged:?}"
        );
    }

    /// PLX-459: an idle actor leaves the map only once no command can reach it: not while one
    /// holds its sender, as `ask` does between `actor_for` and its send, nor while one waits in
    /// its channel.
    #[tokio::test]
    async fn an_actor_retires_only_once_no_command_can_reach_it() {
        let dir = tempfile::tempdir().unwrap();
        let daemon = Daemon::for_tests(dir.path(), 10, Duration::from_secs(90));
        let agents = &daemon.agents;
        let id = RunId::generate();
        let (sender, mut commands) = mpsc::channel(1);
        agents.actors.lock().unwrap().insert(id, sender);

        let racing = agents.actor(id).unwrap();
        assert!(!agents.retire(id, &commands), "a command holds a sender");
        assert!(
            racing
                .try_send(Command::Wake(String::new(), Vec::new()))
                .is_ok()
        );
        drop(racing);
        assert!(!agents.retire(id, &commands), "a command waits");
        assert!(commands.try_recv().is_ok());
        assert!(agents.retire(id, &commands));
        assert!(agents.actor(id).is_none());
        assert!(commands.recv().await.is_none(), "no sender is left");
    }

    /// PLX-459, on a paused clock: a run's actor stops after `IDLE` with nothing to do, but not
    /// while a command that found it before then can still send, and the next command starts a
    /// fresh one.
    #[tokio::test(start_paused = true)]
    async fn an_idle_actor_stops_and_the_next_command_starts_another() {
        let dir = tempfile::tempdir().unwrap();
        let daemon = Daemon::for_tests(dir.path(), 10, Duration::from_secs(90));
        let project = Uuid::now_v7();
        let fields = ProjectFields {
            name: "app".to_owned(),
            repo_path: "/src/app".to_owned(),
            icon: None,
            permission: "auto".to_owned(),
            autonomy: "routine".to_owned(),
            base_branch: None,
        };
        // A checkout thread that finished: no worktree, and nothing left to do.
        let id = RunId::generate();
        let run = RunFields {
            project_id: project,
            prompt: "Build it.".to_owned(),
            requested_account: None,
            policy: super::WORKSPACE_WRITE.to_owned(),
            backend: "fake".to_owned(),
            coordinator_thread: None,
            parent: None,
            notify_parent: false,
            model: None,
            effort: None,
            permission: None,
            context_window: None,
            fast: None,
            approvals: false,
            checkout: true,
            explore: false,
        };
        let state = RunState {
            status: super::convert::COMPLETED.to_owned(),
            ..RunState::default()
        };
        store(&daemon, move |db| {
            db.create_project(project, &fields)
                .map_err(|e| store_error(&e))?;
            db.create_run(id.into(), &run, &state)
                .map_err(|e| store_error(&e))
        })
        .await
        .unwrap();
        let list = || queue(Arc::clone(&daemon), id, QueueOp::List, None);

        list().await.unwrap();
        let racing = daemon
            .agents
            .actor(id)
            .expect("the command started an actor");
        tokio::time::sleep(IDLE * 2).await;
        let (reply, answer) = oneshot::channel();
        let command = Command::Queue {
            command_id: None,
            op: QueueOp::List,
            reply,
        };
        assert!(racing.send(command).await.is_ok(), "the actor kept running");
        answer.await.unwrap().unwrap();
        drop(racing);

        tokio::time::sleep(IDLE.saturating_sub(Duration::from_secs(1))).await;
        assert!(
            daemon.agents.actor(id).is_some(),
            "idle, but not for long enough"
        );
        tokio::time::sleep(Duration::from_secs(2)).await;
        assert!(daemon.agents.actor(id).is_none(), "an idle actor stops");

        list().await.unwrap();
        assert!(daemon.agents.actor(id).is_some(), "a fresh actor");
    }
}
