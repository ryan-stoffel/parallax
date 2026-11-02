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
//! A run whose client started it with `approvals`, and every run in an orchestrator, its
//! orchestrator included, lets its CLI ask before a tool call (PLX-222, decisions 0031 and 0042).
//! It logs the request and takes `agent/approve`'s answer, waiting as long as it takes
//! ([`approvals`]). Every launch of the run, a resume included, keeps the flag.
//!
//! A run outlives its CLI processes: `agent/send` to a run whose CLI has ended resumes the
//! vendor session in the same worktree. When plxd stops, running CLIs are cancelled and their
//! runs recorded `interrupted`; a run still `starting` or `running` in the store when plxd
//! starts (a crash) is marked `interrupted` too. Either kind resumes through `agent/send`, and
//! either wakes the parent that launched it once plxd starts again ([`wake::catch_up`]).
//!
//! An orchestrator (0024) is a run too, started by [`orchestrator::start`] instead, with no
//! recorded worktree; the same actor runs it. Children wake the run that launched them when they
//! finish, an orchestrator or any thread, and a run started in an orchestrator wakes its
//! orchestrator ([`wake`]).
//!
//! Every run in an orchestrator, its orchestrator included, runs in the orchestrator's permission
//! mode, Auto or Bypass (0042), whatever its request or a later `agent/send` asks for. Each new CLI
//! process reads the mode again, so one `orchestrator/update` changed applies from the run's next
//! process. A backend that doesn't map the mode is refused ([`in_mode`]), never moved to another
//! mode.
//!
//! An orchestrator's child starts on the account [`placement`]'s fixed rules pick (0046), or waits,
//! recorded as `waiting`, until one has room.
//!
//! A normal thread's run is full Claude Code in every mode, with no worker sandbox, when its client
//! answers permission requests, and its first message is the user's own (0034). An orchestrator's
//! children run the same way, through `agent/start`: always with `approvals`, and with a short
//! header naming the orchestrator and its tools, then its brief and memory index (0044), before the
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
pub(crate) mod handoff;
pub(crate) mod orchestrator;
pub(crate) mod packet;
mod placement;
mod resume;
pub(crate) mod review;
pub(crate) mod wait;
pub(crate) mod wake;
pub(crate) mod worker;

use std::collections::{HashMap, VecDeque};
use std::fmt::Write as _;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, Mutex, PoisonError};
use std::time::Duration;

use parallax_protocol::jsonrpc::ErrorObject;
use parallax_protocol::{
    AccountChoice, AgentAcceptParams, AgentAcceptResult, AgentApproveParams, AgentApproveResult,
    AgentAttachParams, AgentAttachResult, AgentBackgroundTask, AgentDelivery, AgentEffort,
    AgentFailureKind, AgentImageParams, AgentOpenPrResult, AgentOutcome, AgentOutputItem,
    AgentPermission, AgentRun, AgentSendParams, AgentStartParams, ApprovalId, CliKind, ErrorKind,
    GitStatus, ImageId, ImageMediaType, OrchestratorPermission, OrchestratorThreadId,
    ParallaxEvent, PrActParams, PrDiffResult, PrState, PrViewParams, PromptImage, PullRequest,
    QueueResult, Role, RunId, ScopeId, TurnId,
};
use parallax_store::{RunFields, RunState, StoreError, ThreadFields, WorktreeFields};
use tokio::sync::{mpsc, oneshot};
use tokio_util::sync::CancellationToken;
use tokio_util::task::TaskTracker;
use tracing::{error, info, warn};
use uuid::Uuid;

use self::actor::{Actor, Command, Queued};
pub(crate) use self::actor::{Delivery, GitAction, QueueOp, logged_events, session_account};
pub(crate) use self::convert::NO_WRITE;
pub(crate) use self::convert::agent_run as snapshot;
use self::convert::{
    COMPLETED, RUNNING, STARTING, WORKSPACE_WRITE, agent_run, option_name, option_value,
};
pub(crate) use self::resume::Timing as ResumeTiming;
use self::worker::{StoredKeyAccounts, sandbox_path, worker_unavailable};
use crate::backend::{Backend, ToolPolicy, check_argument};
use crate::context::memory;
use crate::dispatcher::{self, Lane};
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
    /// When a run a usage limit stopped resumes (PLX-371).
    resume_timing: ResumeTiming,
    /// Wakes the dispatcher of children waiting to be placed (PLX-413, [`placement`]).
    pub(crate) placement: tokio::sync::Notify,
    /// Held from placing an orchestrator's child until it counts as running or waiting, so two at
    /// once never both take an orchestrator's last free slot (0046).
    placing: tokio::sync::Mutex<()>,
    /// The runs whose live sessions are idle (0060).
    pub(super) idle: IdleSessions,
    /// The slots for turns of threads in shared worktrees (0063).
    pub(crate) shared_slots: crate::delegation::Slots,
    /// Each live run's background tasks running now, as its last `backgroundTasks` item says,
    /// for a thread's snapshot (PLX-777). A run without any has no entry.
    background: Mutex<HashMap<RunId, Vec<AgentBackgroundTask>>>,
}

/// The most idle live sessions a host keeps (0060). Past it, the least recently used is released.
/// T3 Code has no cap; Parallax's Orchestrators fan out to many threads, each of whose idle CLI
/// holds hundreds of MiB.
pub(super) const MAX_IDLE_SESSIONS: usize = 5;

/// The runs whose live sessions are idle, least recently used first. A running turn is never here,
/// nor a session with open work such as a background command (PLX-725), so the cap never releases
/// one.
#[derive(Default)]
pub(super) struct IdleSessions(Mutex<VecDeque<RunId>>);

impl IdleSessions {
    /// Run `id`'s session went idle: the least recently used run to release, if that took the
    /// count past [`MAX_IDLE_SESSIONS`].
    pub(super) fn push(&self, id: RunId) -> Option<RunId> {
        let mut idle = self.0.lock().unwrap_or_else(PoisonError::into_inner);
        idle.retain(|&run| run != id);
        idle.push_back(id);
        (idle.len() > MAX_IDLE_SESSIONS)
            .then(|| idle.pop_front())
            .flatten()
    }

    /// Run `id`'s session is busy again, released, or gone.
    pub(super) fn remove(&self, id: RunId) {
        let mut idle = self.0.lock().unwrap_or_else(PoisonError::into_inner);
        idle.retain(|&run| run != id);
    }
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
    /// A thread, in its worktree or its repo entry's checkout: a normal thread, or an
    /// orchestrator's child (0042). With `approvals` it runs as the full CLI (0034). Without,
    /// Claude Code keeps the worker sandbox (0013), which needs these folders. A child's first
    /// message starts with `header`.
    Worker {
        home: PathBuf,
        data_dir: PathBuf,
        context: PathBuf,
        header: Option<String>,
    },
    /// An orchestrator, with no sandbox (0024), in a detached worktree of `repo` that the
    /// actor moves to the integration branch's tip before each CLI process (0042), or in its
    /// own empty folder when it has no repo (0093).
    Orchestrator { repo: Option<PathBuf> },
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
            resume_timing: ResumeTiming::default(),
            placement: tokio::sync::Notify::new(),
            placing: tokio::sync::Mutex::new(()),
            idle: IdleSessions::default(),
            shared_slots: crate::delegation::Slots::default(),
            background: Mutex::default(),
        }
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

    /// How many runs have a turn running, for `host/health`. An idle session doesn't count.
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
        let (commands, receiver) = self.register(actor.id());
        self.run(actor, receiver);
        commands
    }

    /// Runs `actor` on its channel from [`Self::register`].
    fn run(&self, actor: Actor, commands: mpsc::Receiver<Command>) {
        self.tracker
            .spawn(actor.run(commands, self.shutdown.clone()));
    }

    /// Puts run `id`'s command channel in the map, for its actor to run on.
    fn register(&self, id: RunId) -> (mpsc::Sender<Command>, mpsc::Receiver<Command>) {
        let (commands, receiver) = mpsc::channel(16);
        self.actors
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .insert(id, commands.clone());
        (commands, receiver)
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
    let (value, effects) = daemon
        .store
        .run(&CancellationToken::new(), move |db| {
            let value = job(db)?;
            Ok((value, db.effects))
        })
        .await?;
    // A turn that ended enqueued its checkpoint's capture (0062).
    if effects {
        daemon.dispatcher.notify();
    }
    Ok(value)
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

/// The error for a run that should have a worktree row and has none.
pub(super) fn no_worktree(id: RunId) -> ErrorObject {
    ErrorObject::internal_error(format!("run {id} has no recorded worktree"))
}

/// Fails with `runNotFound` unless run `id` is in the store.
fn require_run(db: &parallax_store::Store, id: RunId) -> Result<(), ErrorObject> {
    match db.get_run(id.into()).map_err(|e| store_error(&e))? {
        Some(_) => Ok(()),
        None => Err(run_not_found(id)),
    }
}

fn requested_account(account: Option<&AccountChoice>) -> Option<String> {
    account.and_then(|account| serde_json::to_string(account).ok())
}

/// Whether the worker run `fields` describe is full Claude Code if it runs on Claude, with no
/// worker sandbox ([`crate::backend::claude::unsandboxed`]). `changed` is the permission a
/// message changes to, which the new process runs with instead of the stored one. Every worker
/// run is a thread to its backend.
pub(super) fn full_claude_code(fields: &RunFields, changed: Option<AgentPermission>) -> bool {
    let permission = changed.or_else(|| fields.permission.as_deref().and_then(option_value));
    crate::backend::claude::runs_unsandboxed(true, fields.approvals, permission)
}

/// The project's repository, the routing inputs, and the paths run `run` of `project` needs,
/// checked: everything that can refuse a worker, or an orchestrator when `role` is one, before
/// anything is created. `full_claude` is [`full_claude_code`] of the run's fields. For a run that
/// exists already, or one that isn't a thread.
pub(super) async fn prepare(
    daemon: &Arc<Daemon>,
    project: ScopeId,
    run: RunId,
    requested: Option<AccountChoice>,
    role: Role,
    full_claude: bool,
) -> Result<(Prepared, Option<String>), ErrorObject> {
    prepare_run(daemon, project, run, requested, role, full_claude, false).await
}

/// [`prepare`], where `new_thread` says the run being created is a normal thread's
/// (`thread/start`), whose thread row doesn't exist yet. The path is the scope's repository, `None`
/// for an orchestrator with no repo (0093).
#[expect(clippy::too_many_lines, reason = "one check after another, in order")]
async fn prepare_run(
    daemon: &Arc<Daemon>,
    project: ScopeId,
    run: RunId,
    requested: Option<AccountChoice>,
    role: Role,
    full_claude: bool,
    new_thread: bool,
) -> Result<(Prepared, Option<String>), ErrorObject> {
    let (repo_path, context_scope, orchestrator_row, thread_run, defaults, mut accounts) =
        store(daemon, move |db| {
            // A thread sharing another's workspace works in its worktree (0063).
            let repo_path = crate::delegation::workdir_repo(db, project, run.into())?;
            // A run whose scope is an orchestrator, not a repo entry, is its orchestrator or one of
            // its children (0042).
            let orchestrator_row = db
                .get_orchestrator(project.into())
                .map_err(|e| store_error(&e))?;
            // The run itself is a thread: one `thread/start` made, or an orchestrator's child, not
            // any run on a repo entry, such as one `agent/start` made there.
            let thread_run = new_thread
                || orchestrator_row.is_some()
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
                orchestrator_row,
                thread_run,
                defaults,
                StoredKeyAccounts(accounts),
            ))
        })
        .await?;
    let chosen = requested.as_ref().or(defaults.worker.as_ref());
    placement::api_keys(role, orchestrator_row.as_ref(), chosen, &mut accounts)?;
    let defaults = Defaults {
        orchestrator: defaults.orchestrator,
        worker: defaults.worker,
    };
    let policy = match role {
        Role::Orchestrator => ToolPolicy::NoWrite,
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
    if role == Role::Orchestrator {
        let place = Place::Orchestrator {
            repo: repo_path.as_ref().map(PathBuf::from),
        };
        let prepared = Prepared {
            resolved,
            accounts,
            place,
        };
        return Ok((prepared, repo_path));
    }
    // A Codex or Cursor thread is full Codex or Cursor Agent, and they run nothing else, even on a
    // repo entry. A Claude run with approvals or in Bypass is full Claude Code. None has a worker
    // sandbox to check, on any OS (0035, 0036, 0034, 0027, PLX-959).
    let full_claude = full_claude && resolved.backend().cli() == Some(CliKind::Claude);
    if !(full_claude || thread_run && resolved.backend().full_thread()) {
        worker::check_backend(resolved.backend())?;
    }
    // Only a CLI plxd detects has its version checked before a worker starts.
    if let Some(cli) = resolved.backend().cli() {
        // Only this CLI's status: a full probe also waits on the slowest of the others.
        let mut detected = daemon.cli_detector.get(cli).await;
        if worker::check_version(cli, Some(&detected)).is_err() {
            // The user may have just updated the CLI: look again before refusing.
            detected = daemon.cli_detector.refresh_one(cli).await;
            worker::check_version(cli, Some(&detected))?;
        }
        #[cfg(target_os = "linux")]
        if cli == CliKind::Claude && !full_claude {
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
    if let Some(repo_path) = &repo_path {
        sandbox_path(Path::new(repo_path), "the project's repository")?;
    }
    let header = match orchestrator_row.map(|row| row.name) {
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
    project: ScopeId,
    repo_path: &Path,
    reference: &str,
) -> Result<(), ErrorObject> {
    let busy = store(daemon, move |db| {
        for run in db
            .list_runs(Some(project.into()))
            .map_err(|e| store_error(&e))?
        {
            if run.fields.checkout
                && [STARTING, RUNNING].contains(&run.state.status.as_str())
                && crate::delegation::workdir(db, project, run.id)?
                    == crate::threads::scope_path(db, project)?
            {
                return Ok(true);
            }
        }
        Ok(false)
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
                 orchestrator thread, parent, notify, model, effort, permission, context window, \
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
        Ok::<_, ErrorObject>((worktree, git_common_dir(agents, repo_path).await?))
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
    Ok((cwd, git_common_dir(agents, repo_path).await?))
}

/// `repo_path`'s shared git folder, canonical and checked for the sandbox.
pub(super) async fn git_common_dir(
    agents: &Agents,
    repo_path: &Path,
) -> Result<PathBuf, ErrorObject> {
    let common = agents
        .worktrees
        .git_common_dir(repo_path)
        .await
        .map_err(|error| worktree_failed(&error))?;
    sandbox_path(&common, "the repository's git folder")
}

/// Records run `run_id` through the dispatcher's `thread.create` (0059), in `lane`, which the
/// caller holds: its run row, its worktree's when it has one, and its thread's when it is one, with
/// `agent.started` and `thread.started`, in one transaction. `prepare_run` read the scope in an
/// earlier job, so an orchestrator that `orchestrator/delete` removed since gets no run (PLX-338).
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
    let command = dispatcher::Command::new(
        None,
        run_id,
        dispatcher::Action::Create(Box::new(dispatcher::NewRows {
            fields,
            state,
            worktree,
            thread,
        })),
    );
    let recorded = daemon
        .dispatcher
        .commit(daemon, lane, command)
        .await
        .and_then(dispatcher::Outcome::rows)
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

/// The permission mode every run in `scope` runs in (0042): its orchestrator's, or `None` when
/// `scope` is a repo entry, whose threads keep their own.
pub(super) async fn orchestrator_mode(
    daemon: &Arc<Daemon>,
    scope: ScopeId,
) -> Result<Option<OrchestratorPermission>, ErrorObject> {
    store(daemon, move |db| {
        let row = db
            .get_orchestrator(scope.into())
            .map_err(|e| store_error(&e))?;
        Ok(row.map(|row| crate::store::orchestrator_permission(&row.permission)))
    })
    .await
}

/// Cuts Orchestrator `scope`'s integration branch and its worktree when either is missing (0045),
/// and returns the project row as it stands, with its integration branch. `None` when `scope` is a
/// repo entry, not an orchestrator. An orchestrator with no repo has no integration branch (0093),
/// and is returned as it is.
pub(crate) async fn integration(
    daemon: &Arc<Daemon>,
    scope: ScopeId,
) -> Result<Option<parallax_store::Orchestrator>, ErrorObject> {
    let Some(mut row) = store(daemon, move |db| {
        db.get_orchestrator(scope.into())
            .map_err(|e| store_error(&e))
    })
    .await?
    else {
        return Ok(None);
    };
    let worktrees = &daemon.agents.worktrees;
    let Some(repo) = row.repo_path.as_deref().map(Path::new) else {
        return Ok(Some(row));
    };
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

/// The orchestrator's `mode` as a run on `backend` takes it, from its
/// [`Backend::orchestrator_permissions`], or `unsupportedOption` saying why it can't: a run in an
/// orchestrator is never moved to another mode (0042).
pub(super) fn in_mode(
    backend: &dyn Backend,
    mode: OrchestratorPermission,
) -> Result<AgentPermission, ErrorObject> {
    let name = actor::backend_name(backend.name());
    let maps = |mode: OrchestratorPermission| {
        mode.agent()
            .filter(|permission| backend.orchestrator_permissions().contains(permission))
    };
    let (label, other, other_label) = match mode {
        OrchestratorPermission::Auto => ("Auto", OrchestratorPermission::Bypass, "Bypass"),
        OrchestratorPermission::Bypass => {
            ("Bypass Permissions", OrchestratorPermission::Auto, "Auto")
        }
        OrchestratorPermission::Unknown => {
            return Err(ErrorObject::parallax(
                ErrorKind::UnsupportedOption,
                "the orchestrator's permission mode is one this plxd doesn't know",
            ));
        }
    };
    if let Some(permission) = maps(mode) {
        return Ok(permission);
    }
    let detail = if maps(other).is_some() {
        // A model service has Auto in its threads but not in an orchestrator.
        let scope = if mode
            .agent()
            .is_some_and(|permission| backend.permissions().contains(&permission))
        {
            " in an orchestrator"
        } else {
            ""
        };
        format!("{name} has no {label}{scope}. Set the orchestrator to {other_label} to use it.")
    } else {
        format!(
            "{name} has neither Auto nor Bypass Permissions, so it can't run in an orchestrator."
        )
    };
    Err(ErrorObject::parallax(ErrorKind::UnsupportedOption, detail))
}

/// `orchestrator/fromThreads`' check that a run on backend `name` can run in Orchestrator mode
/// `mode`. A backend this host no longer has passes, since its run can't start anywhere.
pub(crate) fn fits_mode(
    daemon: &Daemon,
    name: &str,
    mode: OrchestratorPermission,
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
        orchestrator_thread,
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
        orchestrator_thread,
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
    pub scope: ScopeId,
    pub prompt: String,
    /// The prompt's images (PLX-191), already checked.
    pub images: Vec<PromptImage>,
    /// The threads attached to the prompt (PLX-372), already checked.
    pub threads: Vec<RunId>,
    pub account: Option<AccountChoice>,
    /// The orchestrator thread starting the run through `plxd mcp` (#195).
    pub orchestrator_thread: Option<OrchestratorThreadId>,
    /// The run wakes its parent, if it has one, when a CLI process of its ends (PLX-380, 0025).
    pub notify: bool,
    pub options: RunOptions,
    /// The client answers the run's permission requests (PLX-222, 0031).
    pub approvals: bool,
    /// An orchestrator's exploration child, which never lands (0045).
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

/// A new run's parent (0041): the one its thread names, or the orchestrator that starts it, whose
/// subagents are its children.
fn parent(thread: Option<&NewThread>, orchestrator: Option<OrchestratorThreadId>) -> Option<Uuid> {
    thread
        .and_then(|thread| thread.parent)
        .map(Uuid::from)
        .or(orchestrator.map(Uuid::from))
}

/// A new fork's run, recorded with no CLI (0050): logs the parent's transcript up to the fork
/// point as the fork's own, after its `agent.started`, in one job. Its first `agent/send` starts a
/// CLI. The copy is its own job, after the one that records the run, since a long transcript
/// shouldn't hold that one up: a crash between the two leaves the fork with none of it.
async fn fork_created(
    daemon: &Daemon,
    project: ScopeId,
    run_id: RunId,
    fork: NewFork,
    row: &parallax_store::Run,
    worktree: Option<parallax_store::Worktree>,
    thread: Option<parallax_store::Thread>,
) -> Result<CreatedRun, ErrorObject> {
    let at = row.created_at;
    let copied = store(daemon, move |db| {
        db.copying = true;
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
    let lane = daemon.dispatcher.lane(new.run_id).await;
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
        orchestrator_thread,
        notify,
        mut options,
        mut approvals,
        explore,
        mut thread,
    } = new;
    let fork = thread.as_mut().and_then(|thread| thread.fork.take());
    // A run in an orchestrator runs in its mode, whatever the request asked for, and asks through
    // the inbox, whoever started it (0042). ponytail: a retry after `orchestrator/update` changed
    // the mode gets idConflict; compare the stored mode instead if that bites.
    let mode = orchestrator_mode(&daemon, project).await?;
    if let Some(mode) = mode {
        options.permission = mode.agent();
        approvals = true;
    }
    // What the request asks for, as the runs table stores it. Routing fills in the backend below.
    let parent = parent(thread.as_ref(), orchestrator_thread);
    let mut fields = RunFields {
        project_id: project.into(),
        prompt: prompt.clone(),
        requested_account: requested_account(account.as_ref()),
        policy: WORKSPACE_WRITE.to_owned(),
        backend: String::new(),
        orchestrator_thread: orchestrator_thread.map(Uuid::from),
        parent,
        notify_parent: notify && parent.is_some(),
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
    // An orchestrator's child goes where its rules say, or waits (0046).
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
        full_claude_code(&fields, None),
        thread.is_some(),
    )
    .await?;
    if let Some(mode) = mode {
        in_mode(prepared.resolved.backend(), mode)?;
    }
    options.fork_onto(fork.as_ref(), prepared.resolved.backend(), &mut fields);
    options.check(prepared.resolved.backend())?;
    // A child of an orchestrator with no repo gets a scratch repository, as a thread with no
    // repo does (0093).
    let scratch = match thread.as_ref().and_then(|thread| thread.scratch.clone()) {
        Some(scratch) => Some(scratch),
        None if scope_path.is_none() => Some(crate::threads::child_scratch(&daemon, run_id).await?),
        None => None,
    };
    let repo_path = match (scratch, scope_path) {
        (Some(scratch), _) => scratch.to_string_lossy().into_owned(),
        (None, Some(path)) => path,
        (None, None) => return Err(ErrorObject::internal_error("the run has no repository")),
    };
    let (created, (cwd, git_common_dir)) = workspace(
        &daemon,
        project,
        run_id,
        Path::new(&repo_path),
        thread.as_ref(),
        fields.checkout,
        mode.is_some(),
    )
    .await?;

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
        if orchestrator_thread.is_none() {
            wake::started(&daemon, &run);
        }
        return Ok(CreatedRun {
            run,
            thread: thread_row,
        });
    }

    // A new worktree's setup script starts now, and one that isn't async holds the first turn
    // (PLX-650).
    let setup = match created {
        Some(_) => {
            crate::setup_scripts::worktree_created(&daemon, run_id, project, &repo_path, &cwd).await
        }
        None => None,
    };
    // A run just created here has no sent turns yet.
    let mut actor = Actor::new(Arc::clone(&daemon), row, worktree, HashMap::new());
    let task = first_prompt(&sent, &prepared.place)?;
    let paths = Some((cwd, git_common_dir));
    actor.attach(None, threads);
    let launch = async move |actor: &mut Actor| {
        if actor
            .launch(prepared, task, images, None, None, paths)
            .await
        {
            actor.record_initial_seen(seen).await;
        }
    };
    let run = if let Some(setup) = setup {
        // Its commands wait in its channel until the script ends and its CLI starts or fails.
        let run = actor.snapshot();
        let (_, commands) = agents.register(run_id);
        let daemon = Arc::clone(&daemon);
        agents.tracker.spawn(async move {
            // A run plxd stops under is recovered at the next start, as any other.
            let setup = tokio::select! {
                ended = setup => ended,
                () = daemon.agents.shutdown.cancelled() => return,
            };
            match setup {
                Ok(()) => launch(&mut actor).await,
                Err(Some(message)) => {
                    let failure = AgentFailureKind::SetupFailed;
                    actor
                        .ended_before_start(AgentOutcome::Failed { failure, message })
                        .await;
                }
                Err(None) => actor.ended_before_start(AgentOutcome::Cancelled).await,
            }
            daemon.agents.run(actor, commands);
        });
        run?
    } else {
        launch(&mut actor).await;
        // The actor owns a live CLI from here on, so it is spawned whatever the snapshot says.
        let run = actor.snapshot();
        agents.spawn(actor);
        run?
    };
    // A run started in an orchestrator wakes its orchestrator, unless the orchestrator launched it
    // (0043).
    if mode.is_some() && orchestrator_thread.is_none() {
        wake::started(&daemon, &run);
    }
    Ok(CreatedRun {
        run,
        thread: thread_row,
    })
}

/// Where new run `run_id` works, and its canonical cwd and git folder: for a `checkout` thread,
/// `repo_path`'s own checkout, switched to the thread's ref first, or else a new worktree of
/// `repo_path`, cut from the orchestrator's integration branch's tip when `in_orchestrator` (0045).
async fn workspace(
    daemon: &Arc<Daemon>,
    project: ScopeId,
    run_id: RunId,
    repo_path: &Path,
    thread: Option<&NewThread>,
    checkout: bool,
    in_orchestrator: bool,
) -> Result<(Option<CreatedWorktree>, (PathBuf, PathBuf)), ErrorObject> {
    let agents = &daemon.agents;
    if checkout {
        if let Some(reference) = thread.and_then(|thread| thread.git_ref.as_deref()) {
            switch_checkout(daemon, project, repo_path, reference).await?;
        }
        return Ok((None, checkout_paths(agents, repo_path).await?));
    }
    let base = if in_orchestrator {
        integration(daemon, project)
            .await?
            .and_then(|row| row.integration_branch)
    } else {
        None
    };
    let (created, worktree_path, git_common_dir) =
        create_worktree(agents, repo_path, run_id, thread, base.as_deref()).await?;
    Ok((Some(created), (worktree_path, git_common_dir)))
}

/// A new thread's first message: `prompt` as the user or the orchestrator wrote it, as in Claude
/// Code (0034), after an orchestrator child's header (0042).
pub(super) fn first_prompt(prompt: &str, place: &Place) -> Result<String, ErrorObject> {
    match place {
        Place::Worker { header, .. } => Ok(format!("{}{prompt}", header.as_deref().unwrap_or(""))),
        Place::Orchestrator { .. } => Err(ErrorObject::internal_error(
            "a thread was prepared as an orchestrator",
        )),
    }
}

/// The start of an orchestrator child's first message (0042): the orchestrator's name, the plxd
/// tools every kind gives a child, which always runs with `approvals` (0041), and then the brief
/// and memory index when there are any (0044). The task follows it.
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
        "You are working on a task in the Parallax Orchestrator \"{project}\".\n\
         Your Parallax tools are on the plxd MCP server: {tools}.\n\n"
    );
    if let Some(brief) = &start.brief {
        let _ = write!(header, "The orchestrator's brief:\n{brief}\n\n");
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
    let _lane = daemon.dispatcher.lane(id).await;
    if let Some(actor) = agents.actor(id) {
        return Ok(actor);
    }
    let (row, worktree, turns) = store(daemon, move |db| {
        let row = db
            .get_run(id.into())
            .map_err(|e| store_error(&e))?
            .ok_or_else(|| run_not_found(id))?;
        let worktree = db.get_worktree(id.into()).map_err(|e| store_error(&e))?;
        // Only an accepted run has lost its worktree, and an orchestrator or a checkout thread
        // never had one (0024).
        if worktree.is_none()
            && row.state.status != convert::ACCEPTED
            && row.fields.policy != convert::NO_WRITE
            && !row.fields.checkout
        {
            return Err(no_worktree(id));
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
    // An actor that `thread/delete` or `orchestrator/delete` just stopped has closed its channel:
    // look the run up again, which then finds it gone.
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
    let delivery = delivery_of(&params)?;
    send_with(daemon, params, delivery).await
}

/// `agent/send` of plxd's own message, such as a scheduled task's, which isn't the user's
/// (PLX-937): its text reaches the CLI as it is.
pub(crate) async fn send_from_parallax(
    daemon: Arc<Daemon>,
    params: AgentSendParams,
) -> Result<AgentRun, ErrorObject> {
    let delivery = delivery_of(&params)?;
    deliver(daemon, params, delivery, true).await
}

/// How `params` asks to be delivered.
fn delivery_of(params: &AgentSendParams) -> Result<Delivery, ErrorObject> {
    match params.delivery.unwrap_or_default() {
        AgentDelivery::Queue => Ok(Delivery::Queue),
        AgentDelivery::Steer => Ok(Delivery::Steer),
        AgentDelivery::Unknown => Err(ErrorObject::invalid_params(
            "delivery must be queue or steer",
        )),
    }
}

/// `agent/send` with `delivery`, which its params' `delivery` can't say for a restart (0059).
pub(crate) async fn send_with(
    daemon: Arc<Daemon>,
    params: AgentSendParams,
    delivery: Delivery,
) -> Result<AgentRun, ErrorObject> {
    deliver(daemon, params, delivery, false).await
}

/// [`send_with`], saying whether the message is plxd's own ([`Queued::parallax`]).
async fn deliver(
    daemon: Arc<Daemon>,
    params: AgentSendParams,
    delivery: Delivery,
    parallax: bool,
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
        parallax,
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
    // A blocking setup script would hold the command until it ends (PLX-650).
    crate::setup_scripts::release(daemon, id);
    ask(daemon, id, |reply| Command::Interrupt { hold_queue, reply }).await
}

/// `checkpoint.rollback` (0062): through the run's actor, which holds off its turns meanwhile.
pub(crate) async fn revert(
    daemon: Arc<Daemon>,
    id: RunId,
    command_id: Uuid,
    ordinal: u32,
    restore_files: bool,
) -> Result<AgentRun, ErrorObject> {
    ask(&daemon, id, |reply| Command::Revert {
        command_id,
        ordinal,
        restore_files,
        reply,
    })
    .await
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

/// Starts the actor of every run with waiting messages, so an orchestrator's and children's are
/// sent, as before (PLX-370), since nobody may be watching an Auto Orchestrator. A plain thread's
/// [`recover`] held, so its actor waits for `queue.resume`. With the host's `continueAfterRestart`,
/// a plain thread in `cut`, whose turn the restart cut off, then gets [`CONTINUE`] on its session,
/// ahead of its held queue, once a slot is free for a thread in a shared worktree (0063). An
/// orchestrator's cut runs go on through its orchestrator's restart wake-up instead
/// ([`wake::catch_up`], PLX-178), which placement's slots (0046) also hold to. Called once at
/// startup, after [`recover`].
pub(crate) async fn deliver_queued(daemon: &Arc<Daemon>, cut: Vec<RunId>) {
    let pending = store(daemon, |db| {
        db.checkpoint_revert_threads().map_err(|e| store_error(&e))
    })
    .await;
    match pending {
        Ok(threads) => {
            for thread in threads {
                if let Some(id) = Uuid::parse_str(&thread)
                    .ok()
                    .and_then(|id| RunId::try_from(id).ok())
                    && let Err(error) = actor_for(daemon, id).await
                {
                    warn!(run = %id, %error.message, "could not resume pending checkpoint revert");
                }
            }
        }
        Err(error) => warn!(%error.message, "could not list pending checkpoint reverts"),
    }
    for id in queued_runs(daemon).await {
        if let Err(error) = actor_for(daemon, id).await {
            warn!(run = %id, error = %error.message, "could not send a run's waiting messages");
        }
    }
    let on = store(daemon, |db| {
        db.continue_after_restart().map_err(|e| store_error(&e))
    })
    .await
    .unwrap_or_default();
    for id in cut.into_iter().filter(|_| on) {
        // A plain thread with a session to continue, and whether it shares a worktree.
        let plain = store(daemon, move |db| {
            let Some(row) = db.get_run(id.into()).map_err(|e| store_error(&e))? else {
                return Ok(None);
            };
            let project = db
                .get_orchestrator(row.fields.project_id)
                .map_err(|e| store_error(&e))?;
            let shared = db
                .lineage(id.into())
                .map_err(|e| store_error(&e))?
                .is_some_and(|lineage| lineage.workspace_of.is_some());
            Ok((project.is_none() && row.state.session_id.is_some()).then_some(shared))
        })
        .await;
        let Ok(Some(shared)) = plain else {
            continue;
        };
        if !shared {
            continue_cut(daemon, id).await;
            continue;
        }
        // A shared thread's turn waits in line for a slot rather than being refused (0063).
        let waiting = Arc::clone(daemon);
        daemon.agents.background(async move {
            let slot = waiting.agents.shared_slots.wait().await;
            waiting.agents.shared_slots.reserve(id, slot);
            continue_cut(&waiting, id).await;
            waiting.agents.shared_slots.unreserve(id);
        });
    }
}

/// Sends [`CONTINUE`] to run `id`, whose turn a restart cut off.
async fn continue_cut(daemon: &Arc<Daemon>, id: RunId) {
    info!(run = %id, "continuing a turn a restart cut off");
    let params = AgentSendParams {
        run_id: id,
        turn_id: TurnId::generate(),
        text: CONTINUE.to_owned(),
        model: None,
        effort: None,
        permission: None,
        context_window: None,
        fast: None,
        account: None,
        images: Vec::new(),
        threads: Vec::new(),
        from: None,
        delivery: None,
    };
    // As a steer, which starts its own turn with none running, so it goes ahead of the held
    // queue rather than waiting at its end (0060).
    if let Err(error) = deliver(Arc::clone(daemon), params, Delivery::Steer, true).await {
        warn!(run = %id, error = %error.message, "could not continue a run after a restart");
    }
}

/// The message a turn a restart cut off continues with, as T3 Code's.
pub(crate) const CONTINUE: &str = "Continue where you left off.";

/// The runs with stored waiting messages, which a plxd before this one left.
async fn queued_runs(daemon: &Arc<Daemon>) -> Vec<RunId> {
    let runs = store(daemon, |db| db.queued_runs().map_err(|e| store_error(&e))).await;
    let runs = runs.unwrap_or_else(|error| {
        warn!(error = %error.message, "could not read which runs have waiting messages");
        Vec::new()
    });
    runs.into_iter()
        .filter_map(|run| {
            let id = RunId::try_from(run).ok();
            if id.is_none() {
                warn!(%run, "a run with waiting messages has an id that is not a UUIDv7");
            }
            id
        })
        .collect()
}

/// Holds every plain thread's stored queue until `queue.resume`, as T3 Code holds it (0060),
/// before any actor can load one and send from it.
async fn hold_queues(daemon: &Arc<Daemon>) {
    for id in queued_runs(daemon).await {
        match store(daemon, move |db| hold_queue(db, id)).await {
            Ok(true) => info!(run = %id, "holding a thread's queue after a restart"),
            Ok(false) => {}
            Err(error) => {
                warn!(run = %id, error = %error.message, "could not hold a thread's queue");
            }
        }
    }
}

/// Holds run `id`'s stored queue when it is a plain thread's, and reports it held. Whether it
/// did: an orchestrator's run, or one gone since, is left as it is.
fn hold_queue(db: &mut crate::store::Tx, id: RunId) -> Result<bool, ErrorObject> {
    let Some(row) = db.get_run(id.into()).map_err(|e| store_error(&e))? else {
        return Ok(false);
    };
    let project = row.fields.project_id;
    if db
        .get_orchestrator(project)
        .map_err(|e| store_error(&e))?
        .is_some()
    {
        return Ok(false);
    }
    let queue = db.queue(id.into()).map_err(|e| store_error(&e))?;
    let (rows, messages) = actor::held(queue);
    db.set_queue(id.into(), &rows)
        .map_err(|e| store_error(&e))?;
    let project = ScopeId::try_from(project)
        .map_err(|_| ErrorObject::internal_error("a stored project id is not a UUIDv7"))?;
    db.stage(
        jiff::Timestamp::now(),
        Some(project),
        ParallaxEvent::QueueUpdated {
            run_id: id,
            messages,
            held: true,
        },
    );
    Ok(true)
}

/// `provider-session.detach` (0060): releases run `id`'s live session. A run with no actor has
/// none.
pub(crate) async fn detach(daemon: &Daemon, id: RunId) {
    if let Some(actor) = daemon.agents.actor(id) {
        let _ = actor.send(Command::Detach).await;
    }
}

/// `agent/image`: one of a run's stored images (PLX-191, decision 0026).
pub(crate) async fn image(
    daemon: &Arc<Daemon>,
    params: AgentImageParams,
) -> Result<PromptImage, ErrorObject> {
    let AgentImageParams { run_id, image_id } = params;
    let stored = store(daemon, move |db| {
        require_run(db, run_id)?;
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
        require_run(db, run_id)?;
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
    // A blocking setup script would hold the command until it ends (PLX-650).
    crate::setup_scripts::release(&daemon, id);
    ask(&daemon, id, |reply| Command::Cancel { from, reply }).await
}

/// Fails with `runNotFound` unless `from`, the thread a message or interrupt comes from (0041), is
/// a run on the host.
async fn sender_exists(daemon: &Daemon, from: RunId) -> Result<(), ErrorObject> {
    store(daemon, move |db| require_run(db, from)).await
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

/// Run `id`'s background tasks running now (PLX-777), for its thread's snapshot.
pub(crate) fn background(daemon: &Daemon, id: RunId) -> Vec<AgentBackgroundTask> {
    let background = daemon
        .agents
        .background
        .lock()
        .unwrap_or_else(PoisonError::into_inner);
    background.get(&id).cloned().unwrap_or_default()
}

/// Every live run's background tasks running now (PLX-777), for the shell's snapshot.
pub(crate) fn backgrounds(daemon: &Daemon) -> HashMap<RunId, Vec<AgentBackgroundTask>> {
    daemon
        .agents
        .background
        .lock()
        .unwrap_or_else(PoisonError::into_inner)
        .clone()
}

/// `agent/stopTask` (PLX-777): stops one of run `id`'s background tasks through its live CLI.
pub(crate) async fn stop_task(
    daemon: &Arc<Daemon>,
    id: RunId,
    task_id: String,
) -> Result<(), ErrorObject> {
    ask(daemon, id, |reply| Command::StopTask { task_id, reply }).await
}

/// `agent/setPermission`: moves run `id`'s live CLI to `permission` now.
pub(crate) async fn set_permission(
    daemon: &Arc<Daemon>,
    id: RunId,
    permission: AgentPermission,
) -> Result<AgentRun, ErrorObject> {
    ask(daemon, id, |reply| {
        Command::SetPermission(permission, reply)
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

/// `orchestrator/fromThreads` (0042): moves run `id` into Orchestrator `project` as the child of
/// its orchestrator `parent`, through the run's actor, so a live actor takes the new scope too.
pub(crate) async fn join(
    daemon: &Arc<Daemon>,
    id: RunId,
    project: ScopeId,
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

/// `computer/ask` (PLX-897): asks the user in run `id`'s transcript whether it may use `app`, or
/// keeps waiting on the request already asking, for at most `wait`.
pub(crate) async fn computer_ask(
    daemon: Arc<Daemon>,
    id: RunId,
    app: String,
    wait: Duration,
) -> Result<parallax_protocol::ComputerAskResult, ErrorObject> {
    use parallax_protocol::{AgentApprovalBy, AgentApprovalDecision, ComputerAnswer};
    let answered = ask(&daemon, id, |reply| Command::ComputerAsk { app, reply }).await?;
    let status = match tokio::time::timeout(wait, answered).await {
        Err(_) => ComputerAnswer::Pending,
        Ok(Err(_)) => return Err(ErrorObject::internal_error("plxd is stopping")),
        Ok(Ok(resolution)) => match (resolution.decision, resolution.by) {
            (AgentApprovalDecision::Allowed, _) if resolution.always => ComputerAnswer::Always,
            (AgentApprovalDecision::Allowed, _) => ComputerAnswer::Allowed,
            (_, AgentApprovalBy::User) => ComputerAnswer::Denied,
            _ => ComputerAnswer::Stopped,
        },
    };
    Ok(parallax_protocol::ComputerAskResult { status })
}

pub(super) fn approval_not_found(run: RunId, approval: ApprovalId) -> ErrorObject {
    ErrorObject::parallax(
        ErrorKind::ApprovalNotFound,
        format!("run {run} has no permission request {approval}"),
    )
}

/// `thread/delete`'s and `orchestrator/delete`'s part in the runner: deletes a run through its
/// actor, which stops a running CLI first and never races the run's own resume, commit, or accept.
/// A push or Open PR in flight refuses it (`gitRefused`), unless `wait`, which waits for it to
/// finish first, as `orchestrator/delete` does so it never stops with half its runs deleted
/// (PLX-458).
pub(crate) async fn delete(
    daemon: &Arc<Daemon>,
    id: RunId,
    wait: bool,
    command_id: Option<Uuid>,
) -> Result<(), ErrorObject> {
    // A blocking setup script would hold the command until it ends (PLX-650).
    crate::setup_scripts::release(daemon, id);
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

/// `pr/view` (PLX-318): one of a run's linked pull requests, from the read every window, agent,
/// and watch shares (0086, PLX-1151). Not through the run's actor, so a slow GitHub never holds
/// up a running agent.
pub(crate) async fn view_pr(
    daemon: Arc<Daemon>,
    params: PrViewParams,
) -> Result<PullRequest, ErrorObject> {
    let PrViewParams { run_id, url } = params;
    linked(&daemon, run_id, &url).await?;
    crate::pr_watch::view(&daemon, &url, false)
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

/// `pr/sharedDiff` (PLX-1021): any GitHub pull request's unified diff, read as `pr/diff` reads
/// one, once per head for every run.
pub(crate) async fn shared_diff(
    daemon: Arc<Daemon>,
    params: PrViewParams,
) -> Result<PrDiffResult, ErrorObject> {
    let url = params.url;
    // Only a pull request URL reaches gh's argv, never a flag.
    if crate::worktree::github_pr_urls(&url) != [url.as_str()] {
        return Err(ErrorObject::invalid_params(format!(
            "{url:?} is not a GitHub pull request URL"
        )));
    }
    daemon
        .agents
        .worktrees
        .shared_diff(&url)
        .await
        .map_err(|error| pr_error(&error))
}

/// `pr/act` (PLX-318): does an action to one of a run's linked pull requests through plxd's paced
/// write queue (PLX-1151), then reads it fresh, as `pr/view` serves it.
pub(crate) async fn act_pr(
    daemon: Arc<Daemon>,
    params: PrActParams,
) -> Result<PullRequest, ErrorObject> {
    linked(&daemon, params.run_id, &params.url).await?;
    crate::pr_write::act(&daemon, &params).await?;
    let PrActParams {
        run_id,
        url,
        action,
        ..
    } = params;
    let acted = crate::pr_watch::view(&daemon, &url, true)
        .await
        .map_err(|error| pr_error(&error))?;
    info!(run = %run_id, %url, ?action, "acted on a pull request");
    if acted.state == PrState::Merged {
        daemon.merged.notify_one();
    }
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

/// Marks every run the store still has as `starting` or `running` as `interrupted`: plxd stopped
/// without recording how they ended, as after a crash. Then holds plain threads' queues (0060),
/// wakes each orchestrator for what it missed while plxd was stopped ([`wake::catch_up`], PLX-178),
/// and starts the timers of runs waiting for a usage limit to reset ([`resume::restore`], PLX-371).
/// Returns the runs it interrupted, for [`deliver_queued`]. Called once at startup, before any
/// connection is accepted.
pub(crate) async fn recover(daemon: &Arc<Daemon>) -> Vec<RunId> {
    let open = store(daemon, |db| {
        db.run_ids_with_status(&[convert::STARTING, convert::RUNNING])
            .map_err(|e| store_error(&e))
    })
    .await;
    let open = open.unwrap_or_else(|error| {
        warn!(error = %error.message, "could not recover interrupted agent runs");
        Vec::new()
    });
    let mut cut = Vec::new();
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
            Ok(true) => {
                info!(run = %id, "an agent run was interrupted when plxd last stopped");
                cut.extend(RunId::try_from(id).ok());
            }
            // Deleted since the list was read.
            Ok(false) => {}
            Err(error) => {
                warn!(run = %id, error = %error.message, "could not recover an interrupted agent run");
            }
        }
    }
    // Before any actor starts and could send from a queue.
    hold_queues(daemon).await;
    wake::catch_up(daemon).await;
    resume::restore(daemon).await;
    placement::start(daemon);
    cut
}

#[cfg(test)]
mod tests {

    use std::time::Duration;

    use std::path::Path;

    use parallax_protocol::{ErrorKind, RunId};
    use parallax_store::{OrchestratorFields, RunFields, RunState};
    use tokio::sync::mpsc;
    use uuid::Uuid;

    use super::actor::Command;
    use super::{record, store, store_error};

    use crate::server::Daemon;

    /// An orchestrator's fields, for a test that stores one.
    pub(super) fn orchestrator_fields() -> OrchestratorFields {
        OrchestratorFields {
            name: "app".to_owned(),
            repo_path: Some("/src/app".to_owned()),
            icon: None,
            permission: "auto".to_owned(),
            autonomy: "routine".to_owned(),
            base_branch: None,
        }
    }

    /// A worker run's fields in `project`, on the fake backend, with every option at its default.
    pub(super) fn run_fields(project: Uuid) -> RunFields {
        RunFields {
            project_id: project,
            prompt: "Build it.".to_owned(),
            requested_account: None,
            policy: super::WORKSPACE_WRITE.to_owned(),
            backend: "fake".to_owned(),
            orchestrator_thread: None,
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
        }
    }

    /// PLX-959: a run with approvals or in Bypass is full Claude Code, and skips the worker
    /// sandbox checks on every OS. A message's permission change decides for the new process.
    #[test]
    fn only_full_claude_code_skips_the_sandbox_checks() {
        use parallax_protocol::AgentPermission::{Bypass, Manual};

        let fields = |approvals: bool, permission: Option<&str>| RunFields {
            prompt: "p".to_owned(),
            backend: "claude".to_owned(),
            permission: permission.map(str::to_owned),
            approvals,
            ..run_fields(Uuid::nil())
        };
        assert!(super::full_claude_code(&fields(true, None), None));
        assert!(super::full_claude_code(
            &fields(false, Some("bypass")),
            None
        ));
        assert!(!super::full_claude_code(&fields(false, None), None));
        assert!(!super::full_claude_code(
            &fields(false, Some("manual")),
            None
        ));
        assert!(super::full_claude_code(&fields(false, None), Some(Bypass)));
        assert!(!super::full_claude_code(
            &fields(false, Some("bypass")),
            Some(Manual)
        ));
    }

    /// PLX-338: a worker start that read its orchestrator before `orchestrator/delete` removed it
    /// records no run once the row is gone, so the delete leaves no orphan behind.
    #[tokio::test]
    async fn a_start_racing_a_orchestrator_delete_records_no_run() {
        let dir = tempfile::tempdir().unwrap();
        let daemon = Daemon::for_tests(dir.path(), 10, Duration::from_secs(90));
        let project = Uuid::now_v7();
        // The start's `prepare_run` saw the project; the delete then removed it.
        store(&daemon, move |db| {
            db.create_orchestrator(project, &orchestrator_fields())
                .map_err(|e| store_error(&e))?;
            db.delete_orchestrator(project).map_err(|e| store_error(&e))
        })
        .await
        .unwrap();

        let run_id = RunId::generate();
        let run = run_fields(project);
        let state = RunState::default();
        let lane = daemon.dispatcher.lane(run_id).await;
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
            Some(ErrorKind::OrchestratorNotFound)
        );
        let stored = store(&daemon, move |db| {
            db.get_run(run_id.into()).map_err(|e| store_error(&e))
        })
        .await
        .unwrap();
        assert_eq!(stored, None);
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
                .try_send(Command::Wake(String::new(), Vec::new(), None, None))
                .is_ok()
        );
        drop(racing);
        assert!(!agents.retire(id, &commands), "a command waits");
        assert!(commands.try_recv().is_ok());
        assert!(agents.retire(id, &commands));
        assert!(agents.actor(id).is_none());
        assert!(commands.recv().await.is_none(), "no sender is left");
    }
}
