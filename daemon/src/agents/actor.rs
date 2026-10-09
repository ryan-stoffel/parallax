//! One run's actor: the task that owns a run for as long as plxd runs.
//!
//! It takes commands (`agent/send`, `agent/cancel`, `agent/approve`, `agent/accept`,
//! `agent/openPr`, the Git menu's in `git`, `thread/delete`) and the run's backend events in one
//! loop, so nothing about a run needs a lock, and events are logged in the order they happened.
//!
//! A push or Open PR, whose network steps can each take minutes, is the run's effect (PLX-458):
//! it runs in a task of its own, one at a time, and its result comes back into the loop, which
//! keeps taking commands meanwhile. While it runs, the run starts no CLI: a message waits in the
//! queue until it ends, and commit, push, Open PR, Accept, and delete refuse the run as busy. A
//! cancel lets it finish, since a push stopped halfway leaves `origin` in a state nobody knows.
//!
//! It also keeps the permission requests its CLI waits on (PLX-222, decision 0031): it logs each
//! one with when it expires, passes `agent/approve`'s answer to the CLI, denies one nobody
//! answered in time, and logs how each one ended, including when a cancel, a stop, or the CLI's
//! exit ends it first.
//!
//! A message sent while its CLI works on a turn waits in the run's queue (PLX-370, decision
//! 0048), stored so a restart keeps it, until the turn ends; then it goes to the same CLI, which
//! [`Run::hold`] keeps open for it. A message that changes what its CLI runs with (its model,
//! another run option, or account) can't reach a CLI that's running, so it waits, with every
//! message after it, until that CLI exits; then each goes to a new CLI process in turn. A new
//! account on another backend moves the run there: the session can't follow, so a new one starts
//! in the same place, told the conversation so far. Clients list, edit, reorder, and cancel what
//! waits, and a steer goes into the running turn instead, through the backend, or by cancelling
//! the CLI and resuming it with the message where the backend takes no messages while it runs.
//!
//! A project's coordinator (0024) differs in three places: it starts in a detached worktree at the
//! integration branch's tip, refreshed before each CLI process (0042), with a thread's Parallax
//! tools and no sandbox (PLX-380), it is never committed, and only the project's current one
//! wakes. Any run wakes when children it launched finish (PLX-42, PLX-380, [`super::wake`]).
//!
//! A thread in its repository's own checkout has no worktree: every launch, a resume included,
//! starts in the checkout, and it is never committed either.
//!
//! A run a usage limit stopped waits for the limit to reset and resumes itself (PLX-371,
//! [`waiting`]). A Project's child that waits to be placed starts with its first message once
//! [`super::placement`] finds it an account ([`placed`]).

use std::collections::{HashMap, HashSet, VecDeque};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::Ordering;
use std::time::Duration;

use parallax_protocol::jsonrpc::ErrorObject;
use parallax_protocol::{AcceptId, AgentMerge, CliKind};
use parallax_protocol::{
    AccountChoice, AccountId, AgentApprovalAnswer, AgentApprovalBy, AgentApprovalDecision,
    AgentApproveParams, AgentApproveResult, AgentFailureKind, AgentOutcome, AgentOutputItem,
    AgentRun, ApprovalId, DiffSummary, ErrorKind, GitStatus, ImageId, InboxKind, ParallaxEvent,
    ProjectId, PromptImage, QueueResult, QueuedMessage, Role, RunId, TurnId,
};
use parallax_store::{
    QueuedRow, Run as RunRow, RunAccept, SessionModelUsage, StoredImage, Worktree,
};
use serde::{Deserialize, Serialize};
use tokio::sync::{mpsc, oneshot};
use tokio::task::{JoinError, JoinHandle};
use tokio::time::{Instant, sleep_until};
use tokio_util::sync::CancellationToken;
use tracing::{debug, info, warn};
use uuid::Uuid;

use super::approvals::{self, Approvals, Lookup, ended};
use super::attached;
use super::convert::{
    self, WORKSPACE_WRITE, agent_run, item_bytes, option_name, option_value, output_item,
};
use super::handoff::{self, Budget, HandoffEvent};
use super::resume::Resumes;
use super::wake::{self, Wakes};
use super::worker::{sandbox_path, worker_unavailable};
use super::{Place, Prepared, RunOptions, prepare, store, store_error};
use crate::backend::{
    AccountRef, Answer, AnswerError, Backend, Credential, Decision, Event, EventStream, FollowUp,
    ModelUsage, Outcome, Resume, Run, RunRequest, SendError, ThreadTools, Usage, WorkerSandbox,
    is_compact,
    run_temp::{self, RunTemp},
};
use crate::routing;
use crate::server::Daemon;
use crate::store::Tx;
use crate::worktree::github_pr_urls;

mod git;
mod placed;
mod waiting;
pub(crate) use git::GitAction;

/// How long transcript items wait to be sent together as one `agent.output` (0007).
const COALESCE: Duration = Duration::from_millis(50);

/// How long an actor with nothing only it holds waits for a command before it stops (PLX-459).
/// The next command starts a fresh one from the store.
pub(super) const IDLE: Duration = Duration::from_mins(10);

/// An `agent.output` is sent early once its items reach about this many bytes.
const MAX_BATCH_BYTES: usize = 256 * 1024;

/// The inbox item a coordinator adds when its wake-ups pause (PLX-401, 0043).
const WAKEUPS_PAUSED: &str =
    "Wake-ups paused. Your next message to the coordinator lets them through.";

/// The inbox item for a child's CLI ending (PLX-401, 0043): `done` with its diff stats, or
/// `failed`. A cancelled or interrupted child adds none, since the user or plxd stopped it.
fn ended_item(run: &AgentRun, outcome: &AgentOutcome) -> Option<(InboxKind, String)> {
    match outcome {
        AgentOutcome::Completed { .. } => {
            let changes = run.diff.as_ref().map_or_else(
                || "no changes".to_owned(),
                |diff| {
                    format!(
                        "{} files (+{} -{})",
                        diff.files, diff.insertions, diff.deletions
                    )
                },
            );
            Some((
                InboxKind::Done,
                format!("{}: done, {changes}", wake::task(&run.prompt)),
            ))
        }
        AgentOutcome::Failed { message, .. } => {
            Some((InboxKind::Failed, failed_text(&run.prompt, message)))
        }
        _ => None,
    }
}

/// A `failed` inbox item's text: the child's task and what went wrong.
fn failed_text(prompt: &str, message: &str) -> String {
    format!(
        "{}: failed: {}",
        wake::task(prompt),
        wake::one_line(message, wake::EXCERPT_BYTES)
    )
}

/// What an actor is asked to do.
pub(super) enum Command {
    /// `agent/send` or `message.dispatch`, after the running turn, into it (PLX-370), or in
    /// place of it.
    Send {
        message: Queued,
        delivery: Delivery,
        reply: oneshot::Sender<Result<AgentRun, ErrorObject>>,
    },
    /// `queue/*` (PLX-370).
    Queue {
        op: QueueOp,
        command_id: Option<Uuid>,
        reply: oneshot::Sender<Result<QueueResult, ErrorObject>>,
    },
    /// `agent/cancel`.
    Cancel {
        /// The thread that stopped the run through its Parallax tools (0041).
        from: Option<RunId>,
        reply: oneshot::Sender<Result<AgentRun, ErrorObject>>,
    },
    /// `run.interrupt` (0059): stops the running turn and keeps the queue, held until
    /// `queue.resume` when `hold_queue`.
    Interrupt {
        hold_queue: bool,
        reply: oneshot::Sender<Result<AgentRun, ErrorObject>>,
    },
    /// `pr/link` or `pr/unlink` (0041), with a checked URL.
    LinkPr {
        url: String,
        linked: bool,
        reply: oneshot::Sender<Result<AgentRun, ErrorObject>>,
    },
    /// `agent/approve` (PLX-222), with its params checked.
    Approve {
        params: AgentApproveParams,
        reply: oneshot::Sender<Result<AgentApproveResult, ErrorObject>>,
    },
    /// `agent/accept`.
    Accept {
        id: AcceptId,
        reviewed: Option<String>,
        reply: oneshot::Sender<Result<(AgentRun, AgentMerge), ErrorObject>>,
    },
    /// `agent/openPr` (PLX-168).
    OpenPr {
        title: String,
        body: String,
        reply: oneshot::Sender<Result<String, ErrorObject>>,
    },
    /// `agent/gitStatus`, `agent/commit`, or `agent/push` (PLX-298).
    Git {
        action: GitAction,
        reply: oneshot::Sender<Result<GitStatus, ErrorObject>>,
    },
    /// `thread/delete` (#110) and `project/delete` (PLX-338): stops the run's CLI, waits for it to
    /// exit, and deletes the run. A push or Open PR in flight refuses it, unless `wait`.
    Delete {
        wait: bool,
        command_id: Option<Uuid>,
        reply: oneshot::Sender<Result<(), ErrorObject>>,
    },
    /// A child of this run finished, or a run started in this coordinator's Project, as
    /// [`wake::summary`] and [`wake::started`] tell it (PLX-42, PLX-380), with the ids of the
    /// questions it names (PLX-469).
    Wake(String, Vec<Uuid>),
    /// `agent/resumeNow` (PLX-371).
    ResumeNow {
        reply: oneshot::Sender<Result<AgentRun, ErrorObject>>,
    },
    /// `agent/autoResume` (PLX-371).
    AutoResume {
        auto_resume: Option<bool>,
        reply: oneshot::Sender<Result<AgentRun, ErrorObject>>,
    },
    /// Starts a Project's child that waited to be placed on `account` (PLX-413, 0046).
    Place {
        account: AccountChoice,
        pending: super::placement::Pending,
        reply: oneshot::Sender<Result<AgentRun, ErrorObject>>,
    },
    /// `project/fromThreads` (0042): the run joins Project `project` as `parent`'s child.
    Join {
        project: ProjectId,
        parent: RunId,
        reply: oneshot::Sender<Result<AgentRun, ErrorObject>>,
    },
    /// Names the run's worktree branch for `slug`, once its thread is named (0058).
    RenameBranch {
        slug: String,
        reply: oneshot::Sender<Result<(), ErrorObject>>,
    },
}

impl Command {
    /// Answers the command with `error` without running it.
    fn refuse(self, error: ErrorObject) {
        match self {
            Self::Send { reply, .. }
            | Self::Cancel { reply, .. }
            | Self::Interrupt { reply, .. }
            | Self::LinkPr { reply, .. }
            | Self::ResumeNow { reply }
            | Self::AutoResume { reply, .. }
            | Self::Place { reply, .. }
            | Self::Join { reply, .. } => {
                let _ = reply.send(Err(error));
            }
            Self::Accept { reply, .. } => {
                let _ = reply.send(Err(error));
            }
            Self::Approve { reply, .. } => {
                let _ = reply.send(Err(error));
            }
            Self::Queue { reply, .. } => {
                let _ = reply.send(Err(error));
            }
            Self::OpenPr { reply, .. } => {
                let _ = reply.send(Err(error));
            }
            Self::Git { reply, .. } => {
                let _ = reply.send(Err(error));
            }
            Self::Delete { reply, .. } | Self::RenameBranch { reply, .. } => {
                let _ = reply.send(Err(error));
            }
            Self::Wake(..) => {}
        }
    }
}

/// What `queue/*` and the queued-run commands ask of the run's queue (PLX-370, 0059). `Resume`
/// is `queue.resume`, which lets a queue held after a Stop go on.
pub(crate) enum QueueOp {
    List,
    Edit { id: TurnId, text: String },
    Reorder { ids: Vec<TurnId> },
    Cancel { id: TurnId },
    Steer { id: TurnId },
    Resume,
}

/// How a message reaches the run (0059's dispatch modes).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Delivery {
    /// After the running turn, or now when none runs.
    Queue,
    /// Into the running turn, or by stopping and resuming it where the backend can't take it.
    Steer,
    /// By stopping the running turn and resuming the run with it, whatever the backend.
    Restart,
}

/// A message waiting for the run's CLI: one sent during a turn, one that changes what the CLI
/// runs with, or one sent after either. Stored, so a restart keeps it (PLX-370).
#[derive(Clone)]
pub(super) struct Queued {
    pub turn_id: TurnId,
    pub text: String,
    /// Its images, already checked (PLX-191).
    pub images: Vec<PromptImage>,
    /// The threads attached to it, already checked (PLX-372).
    pub threads: Vec<RunId>,
    /// New options for the run (PLX-161, PLX-163).
    pub options: RunOptions,
    /// A new account for the run, perhaps on another backend.
    pub account: Option<AccountChoice>,
    /// The thread that sent it through its Parallax tools (0041).
    pub from: Option<RunId>,
}

/// What a stored [`Queued`] keeps beside its text, as its row's JSON. `held` is the queue's:
/// every row of a held queue has it (0059).
#[derive(Default, Serialize, Deserialize)]
#[serde(default)]
struct QueuedExtra {
    images: Vec<PromptImage>,
    threads: Vec<RunId>,
    options: RunOptions,
    account: Option<AccountChoice>,
    from: Option<RunId>,
    held: bool,
}

impl Queued {
    fn row(&self, held: bool) -> QueuedRow {
        let extra = QueuedExtra {
            images: self.images.clone(),
            threads: self.threads.clone(),
            options: self.options.clone(),
            account: self.account.clone(),
            from: self.from,
            held,
        };
        QueuedRow {
            turn_id: self.turn_id.into(),
            text: self.text.clone(),
            // Plain data, which serializes.
            extra: serde_json::to_string(&extra).unwrap_or_default(),
        }
    }

    /// `row` as it was stored, and whether its queue was held, or `None` if it's corrupt.
    fn from_row(row: QueuedRow) -> Option<(Self, bool)> {
        let turn_id = TurnId::try_from(row.turn_id).ok()?;
        let extra: QueuedExtra = serde_json::from_str(&row.extra).ok()?;
        Some((
            Self {
                turn_id,
                text: row.text,
                images: extra.images,
                threads: extra.threads,
                options: extra.options,
                account: extra.account,
                from: extra.from,
            },
            extra.held,
        ))
    }

    /// It, for the live CLI as its next turn, after the summaries of the threads attached to it
    /// (PLX-372).
    async fn follow_up(
        &self,
        daemon: &Daemon,
        target: RunId,
    ) -> Result<(FollowUp, Vec<(Uuid, u64)>), ErrorObject> {
        let prompt = attached::prompt(daemon, target, &self.threads, &self.text).await?;
        Ok((
            FollowUp {
                turn_id: self.turn_id,
                text: prompt.text,
                images: self.images.clone(),
                steer: false,
            },
            prompt.seen,
        ))
    }

    fn message(&self) -> QueuedMessage {
        QueuedMessage {
            id: self.turn_id,
            text: self.text.clone(),
            images: u32::try_from(self.images.len()).unwrap_or(u32::MAX),
            threads: self.threads.clone(),
        }
    }
}

/// Where a request's answer goes.
type Reply<T> = oneshot::Sender<Result<T, ErrorObject>>;

/// What a run's effect returns to its actor (PLX-458): its result, with the reply of the request
/// that started it.
enum Finished {
    Push(Result<GitStatus, ErrorObject>, Reply<GitStatus>),
    OpenPr(Result<String, ErrorObject>, Reply<String>),
}

struct Live {
    run: Arc<dyn Run>,
    events: EventStream,
    /// A worker's temp folder (PLX-130), removed once the CLI has exited: `events` ends only
    /// then.
    temp: Option<RunTemp>,
}

/// plxd's own executable, which serves `plxd mcp` to a run's CLI.
fn plxd_program() -> Result<PathBuf, String> {
    std::env::current_exe()
        .map_err(|error| format!("could not find plxd's own executable: {error}"))
}

/// What a run's CLI starts with besides its account and prompt, from [`Actor::launch`].
struct Setup {
    cwd: PathBuf,
    sandbox: Option<WorkerSandbox>,
    temp: Option<RunTemp>,
    tools: Option<ThreadTools>,
    thread_tools: Option<ThreadTools>,
    thread: bool,
}

#[derive(Default)]
struct Batch {
    items: Vec<AgentOutputItem>,
    bytes: usize,
    since: Option<Instant>,
}

#[expect(
    clippy::struct_excessive_bools,
    reason = "independent facts about a run's actor, not states of one thing"
)]
pub(super) struct Actor {
    daemon: Arc<Daemon>,
    id: RunId,
    project: ProjectId,
    row: RunRow,
    /// The run's worktree, until `agent/accept` removes it.
    worktree: Option<Worktree>,
    live: Option<Live>,
    /// The push or Open PR running for the run, off this loop (PLX-458).
    effect: Option<JoinHandle<Finished>>,
    batch: Batch,
    /// Messages sent to the run, by turn id, reloaded from the store after a restart. They make
    /// `agent/send` idempotent across CLI processes and fill in the logged `TurnStarted.text`.
    turns: HashMap<TurnId, String>,
    /// The stored images of messages a CLI took, by turn id (`None` for the prompt's), until
    /// their `TurnStarted` lists them (PLX-191, decision 0026).
    images: HashMap<Option<TurnId>, Vec<ImageId>>,
    /// The threads attached to messages a CLI took, by turn id as `images`, until their
    /// `TurnStarted` lists them (PLX-372).
    attached: HashMap<Option<TurnId>, Vec<RunId>>,
    /// The latest prompt or message, for the commit message.
    last_message: String,
    /// Messages waiting for the run's CLI, first to be sent first (PLX-370).
    queued: VecDeque<Queued>,
    /// Whether a Stop holds `queued` until `queue.resume` (0059). Stored with each queued row.
    queue_held: bool,
    /// Turns the live CLI has been given and hasn't finished: while there are any, a queued
    /// message waits.
    in_flight: usize,
    /// What [`Run::hold`] last told the live CLI.
    held: bool,
    /// Messages the live CLI took and hasn't started a turn for: one it drops instead, as a CLI
    /// that exits first does, waits again for the next CLI.
    handed: Vec<Queued>,
    stopping: bool,
    /// Set once `thread/delete` or `project/delete` removed the run: the actor stops, refusing
    /// what is still queued.
    deleted: bool,
    /// The run's wake-ups, as a parent (PLX-42, PLX-380).
    wakes: Wakes,
    /// What a usage limit's resume needs (PLX-371).
    resumes: Resumes,
    /// The permission requests its CLIs asked (PLX-222).
    approvals: Approvals,
    /// The tool calls running `gh pr create`, by call id, until their results link the pull
    /// requests they print (PLX-318).
    pr_calls: HashSet<String>,
    /// The threads that sent messages through their Parallax tools, by turn id, until the
    /// messages' `TurnStarted` names them or they're dropped (0041). A waiting message's sender is
    /// stored with it (PLX-370), and [`Self::load_queue`] puts it back here.
    senders: HashMap<TurnId, RunId>,
}

impl Actor {
    /// `turns` is what a run already sent, from the store (#190): empty for a run just created by
    /// `agents::start`, and loaded by `actor_for` for a run whose actor is spawned fresh, so a
    /// restarted plxd still recognizes a retried `agent/send`.
    pub fn new(
        daemon: Arc<Daemon>,
        row: RunRow,
        worktree: Option<Worktree>,
        turns: HashMap<TurnId, String>,
    ) -> Self {
        let id = RunId::try_from(row.id).unwrap_or_else(|_| RunId::generate());
        let project = ProjectId::try_from(row.fields.project_id).unwrap_or_else(|_| {
            warn!(run = %row.id, "a stored run's project id is not a UUIDv7");
            ProjectId::generate()
        });
        let last_message = row.fields.prompt.clone();
        Self {
            daemon,
            id,
            project,
            row,
            worktree,
            live: None,
            effect: None,
            batch: Batch::default(),
            turns,
            images: HashMap::new(),
            attached: HashMap::new(),
            last_message,
            queued: VecDeque::new(),
            queue_held: false,
            in_flight: 0,
            held: false,
            handed: Vec::new(),
            stopping: false,
            deleted: false,
            wakes: Wakes::default(),
            resumes: Resumes::default(),
            approvals: Approvals::default(),
            pr_calls: HashSet::new(),
            senders: HashMap::new(),
        }
    }

    pub fn id(&self) -> RunId {
        self.id
    }

    pub fn snapshot(&self) -> Result<AgentRun, ErrorObject> {
        agent_run(&self.row, self.worktree.as_ref())
    }

    fn accepted(&self) -> bool {
        self.row.state.status == convert::ACCEPTED
    }

    /// Whether this is a project's coordinator (0024) rather than a worker or a thread.
    fn is_coordinator(&self) -> bool {
        self.row.fields.policy == convert::NO_WRITE
    }

    /// Whether this is one of a Project's children (0042): any run in a Project but its
    /// coordinator, whether the coordinator launched it or the user started it with
    /// `thread/start`'s `project` or `agent/start`. A store error counts as not a child.
    async fn is_child(&self) -> bool {
        !self.is_coordinator()
            && matches!(
                super::project_mode(&self.daemon, self.project).await,
                Ok(Some(_))
            )
    }

    /// Adds an item about this run to its project's inbox (PLX-401, 0043).
    async fn inbox(&self, kind: InboxKind, text: String) {
        crate::methods::inbox::add(&self.daemon, self.project, self.id, kind, text).await;
    }

    /// Adds a child's permission request for `tool` to its project's inbox as `needsYou` (0031).
    async fn inbox_approval(&self, tool: &str) {
        if self.is_child().await {
            let task = wake::task(&self.row.fields.prompt);
            let text = format!("{task}: waiting for permission to use {tool}");
            self.inbox(InboxKind::NeedsYou, text).await;
        }
    }

    pub async fn run(mut self, mut commands: mpsc::Receiver<Command>, shutdown: CancellationToken) {
        self.load_wakes().await;
        self.load_queue().await;
        let mut active = Instant::now();
        loop {
            self.deliver().await;
            let deadline = self.batch.since.map(|since| since + COALESCE);
            // A turn in progress gets its wake-ups next, once its CLI has exited, and a push or
            // Open PR once it's done.
            let wake_at = self
                .wakes
                .due()
                .filter(|_| self.live.is_none() && self.effect.is_none());
            let expire_at = self.approvals.due();
            let resume_at = self.resume_due();
            let idle_at = (!self.stopping && self.idle()).then_some(active + IDLE);
            tokio::select! {
                // Shutdown, then a command, then the due flush, and only then another backend
                // event (#190 N6): while a CLI keeps its stream busy, that event branch is
                // otherwise always ready, and `biased` would starve `agent/cancel` and the
                // coalescing flush for as long as the flood lasts, rather than just until the
                // next iteration. Side effect (#190 review, non-blocking): a command can now run
                // before a backend event still buffered ahead of it, so `agent/accept` can see a
                // transient `mergeRefused` for a run whose CLI has already exited but whose
                // `Finished` hasn't been drained yet. `send` already copes with the equivalent
                // case (`SendError::Finished`); a caller of `accept` just retries.
                biased;
                // What waits stays stored, for the next plxd to send.
                () = shutdown.cancelled(), if !self.stopping => {
                    self.stopping = true;
                    self.stop_approvals(AgentApprovalBy::Stop).await;
                    if let Some(live) = &self.live {
                        live.run.cancel();
                    }
                }
                command = commands.recv(), if !self.stopping => match command {
                    Some(command) => self.on_command(command).await,
                    None => self.stopping = true,
                },
                () = sleep_until(deadline.unwrap_or_else(Instant::now)), if deadline.is_some() => {
                    self.flush().await;
                }
                () = sleep_until(wake_at.unwrap_or_else(Instant::now)), if wake_at.is_some() => {
                    self.wake().await;
                }
                () = sleep_until(expire_at.unwrap_or_else(Instant::now)), if expire_at.is_some() => {
                    self.expire_approvals().await;
                }
                () = sleep_until(resume_at.unwrap_or_else(Instant::now)), if resume_at.is_some() => {
                    self.check_resume().await;
                }
                // Stopping frees what the actor holds, its `turns` above all (PLX-459).
                () = sleep_until(idle_at.unwrap_or_else(Instant::now)), if idle_at.is_some() => {
                    if self.daemon.agents.retire(self.id, &commands) {
                        debug!(run = %self.id, "stopped an idle run's actor");
                        return;
                    }
                }
                finished = effect_done(&mut self.effect) => self.finish_effect(finished).await,
                event = next_event(&mut self.live) => self.on_event(event).await,
            }
            // A stop waits for a push or Open PR too, so its request gets its answer.
            if self.stopping && self.live.is_none() && self.effect.is_none() {
                self.flush().await;
                break;
            }
            active = Instant::now();
        }
        if self.deleted {
            commands.close();
            while let Ok(command) = commands.try_recv() {
                command.refuse(super::run_not_found(self.id));
            }
        }
    }

    /// Whether the actor holds nothing that only memory keeps (PLX-459): no CLI, push or Open
    /// PR, unsent output, waiting message, wake-up, permission request, or resume timer. A fresh
    /// actor reloads `turns`, the wake-up count, and the run from the store, and what the rest
    /// keep for a CLI's messages until their turns start has no CLI left to start them.
    fn idle(&self) -> bool {
        self.live.is_none()
            && self.effect.is_none()
            && self.batch.items.is_empty()
            && (self.queued.is_empty() || self.queue_held)
            && self.handed.is_empty()
            && self.wakes.is_empty()
            && self.approvals.due().is_none()
            && self.resume_due().is_none()
    }

    #[expect(clippy::too_many_lines, reason = "one arm per command")]
    async fn on_command(&mut self, command: Command) {
        match command {
            Command::Send {
                message,
                delivery,
                reply,
            } => {
                let (turn_id, from) = (message.turn_id, message.from);
                if let Some(from) = from {
                    self.senders.insert(turn_id, from);
                }
                let answer = self.send(message, delivery).await;
                if answer.is_err() && from.is_some() {
                    self.senders.remove(&turn_id);
                }
                // Only the user's own message resets the count and ends a pause (0025): a child's
                // `thread_send` (with `from`) leaves them, so a loop still reaches the cap.
                if answer.is_ok() && from.is_none() && self.wakes.attended() {
                    self.save_wakes().await;
                }
                let _ = reply.send(answer);
            }
            Command::Cancel { from, reply } => {
                self.cancel(from).await;
                let _ = reply.send(self.snapshot());
            }
            Command::Interrupt { hold_queue, reply } => {
                self.interrupt(hold_queue).await;
                let _ = reply.send(self.snapshot());
            }
            Command::Approve { params, reply } => {
                let answer = self.approve(params).await;
                let _ = reply.send(answer);
            }
            Command::Queue {
                op,
                command_id,
                reply,
            } => {
                let answer = self.queue_op(op, command_id).await;
                let _ = reply.send(answer);
            }
            Command::Accept {
                id,
                reviewed,
                reply,
            } => {
                let answer = self.accept(id, reviewed).await;
                let _ = reply.send(answer);
            }
            Command::OpenPr { title, body, reply } => {
                let effect = self.open_pr(title, body).await;
                self.start_effect(effect, reply, Finished::OpenPr);
            }
            Command::LinkPr { url, linked, reply } => {
                if linked {
                    self.link_pr(url).await;
                } else {
                    self.unlink_pr(&url).await;
                }
                let _ = reply.send(self.snapshot());
            }
            Command::Git { action, reply } => self.on_git(action, reply).await,
            Command::Delete {
                wait,
                command_id,
                reply,
            } => {
                let answer = self.delete(wait, command_id).await;
                if answer.is_ok() {
                    self.deleted = true;
                    self.stopping = true;
                }
                let _ = reply.send(answer);
            }
            Command::Wake(summary, questions) => {
                self.wakes.push(summary, questions, Instant::now());
            }
            Command::ResumeNow { reply } => {
                let _ = reply.send(self.resume_now().await);
            }
            Command::AutoResume { auto_resume, reply } => {
                let _ = reply.send(self.set_auto_resume(auto_resume).await);
            }
            Command::Place {
                account,
                pending,
                reply,
            } => {
                let _ = reply.send(self.place(account, pending).await);
            }
            Command::Join {
                project,
                parent,
                reply,
            } => {
                let _ = reply.send(self.join(project, parent).await);
            }
            Command::RenameBranch { slug, reply } => {
                let _ = reply.send(self.rename_branch(&slug).await);
            }
        }
    }

    /// Renames the run's worktree branch for `slug` (0058), in git, its row, and here, and reports
    /// it in `agent.updated`. Nothing changes for a run with no worktree, one whose push or Open
    /// PR is running, or a branch with an upstream ([`WorktreeManager::rename_branch`]).
    /// Running in the actor keeps it from racing the run's own commits.
    ///
    /// [`WorktreeManager::rename_branch`]: crate::worktree::WorktreeManager::rename_branch
    async fn rename_branch(&mut self, slug: &str) -> Result<(), ErrorObject> {
        let Some(worktree) = &self.worktree else {
            return Ok(());
        };
        if self.effect.is_some() {
            return Ok(());
        }
        let (repo, old) = (PathBuf::from(&worktree.repo_path), worktree.branch.clone());
        let renamed = self
            .daemon
            .agents
            .worktrees
            .rename_branch(&repo, self.id, &old, slug)
            .await
            .map_err(|error| ErrorObject::parallax(ErrorKind::WorktreeFailed, error.to_string()))?;
        let Some(branch) = renamed else {
            return Ok(());
        };
        let (id, run_id, project, row) = (self.row.id, self.id, self.project, self.row.clone());
        let stored = branch.clone();
        let written = self
            .write(move |db, now| {
                db.set_worktree_branch(id, &stored)
                    .map_err(|error| store_error(&error))?;
                let mut state = convert::run_state(&row);
                state.branch = Some(stored);
                db.stage(
                    now,
                    Some(project),
                    ParallaxEvent::AgentUpdated { run_id, state },
                );
                Ok(())
            })
            .await;
        // The row keeps the old name, so git takes it back: Open PR, Accept, and cleanup all
        // name the branch from the row.
        if let Err(error) = written {
            let worktrees = &self.daemon.agents.worktrees;
            if let Err(undo) = worktrees.rename_back(&repo, &branch, &old).await {
                warn!(run = %self.id, %undo, %branch, "could not name a branch back after its rename wasn't stored");
            }
            return Err(error);
        }
        info!(run = %self.id, %branch, "renamed a named thread's branch");
        if let Some(worktree) = &mut self.worktree {
            worktree.branch = branch;
        }
        Ok(())
    }

    /// Moves the run into Project `project` as `parent`'s child (0042). Its mode, inbox, wake-ups,
    /// and Project tools all follow its scope, so it runs as a child from its next CLI process,
    /// and a live CLI keeps what it started with. Joining the Project it is in changes nothing.
    async fn join(&mut self, project: ProjectId, parent: RunId) -> Result<AgentRun, ErrorObject> {
        if self.project != project {
            let id = self.row.id;
            // Only its fields: its state may be newer here than in the store.
            // Its new parent is reported as `thread.updated` in the same job.
            self.row.fields = store(&self.daemon, move |db| {
                let row = db
                    .join_project(id, project.into(), parent.into())
                    .map_err(|error| store_error(&error))?;
                crate::threads::prompted(db, id)?;
                Ok(row)
            })
            .await?
            .fields;
            self.project = project;
            info!(run = %self.id, %project, "a thread joined a Project");
        }
        self.snapshot()
    }

    /// `agent/cancel`, by the user or by thread `from` through its Parallax tools (0041). A push
    /// or Open PR still running finishes.
    async fn cancel(&mut self, from: Option<RunId>) {
        if self.live.is_some() {
            info!(run = %self.id, ?from, "cancelling an agent run");
            if let Some(from) = from {
                self.push(AgentOutputItem::Interrupted { from }).await;
            }
            self.stop_approvals(AgentApprovalBy::Cancel).await;
        }
        // Stop means stop: what waited for this turn to end doesn't start another, nor does what
        // the CLI took and drops as it stops, and a run waiting for its usage limit doesn't
        // resume.
        self.handed.clear();
        self.drop_queued().await;
        self.cancel_waiting().await;
        if let Some(live) = &self.live {
            live.run.cancel();
        }
        // Stop means stop: a child finishing a moment later doesn't start its parent again before
        // the user writes.
        if self.is_coordinator() || self.has_children().await {
            self.pause_wakes(false).await;
        }
    }

    /// `run.interrupt` (0059): stops the running turn as `cancel` does, but keeps what waits.
    /// With `hold_queue` it waits for `queue.resume`, with what the CLI took and hasn't started
    /// first; without, the next message starts once the CLI has exited, after what the CLI drops
    /// as it stops ([`Self::track_turns`]).
    async fn interrupt(&mut self, hold_queue: bool) {
        if self.live.is_some() {
            info!(run = %self.id, hold_queue, "interrupting an agent run");
            self.stop_approvals(AgentApprovalBy::Cancel).await;
        }
        if hold_queue {
            // What the CLI took and hasn't started waits again, first, with the rest.
            for queued in self.handed.drain(..).rev() {
                self.queued.push_front(queued);
            }
            if !self.queued.is_empty() {
                self.queue_held = true;
                self.save_queue().await;
            }
        }
        self.cancel_waiting().await;
        if let Some(live) = &self.live {
            live.run.cancel();
        }
        if self.is_coordinator() || self.has_children().await {
            self.pause_wakes(false).await;
        }
    }

    /// Whether any run wakes this one when it finishes (PLX-380). A run with none has no
    /// wake-ups to pause.
    async fn has_children(&self) -> bool {
        let id = self.row.id;
        let found = store(&self.daemon, move |db| {
            db.has_notifying_children(id)
                .map_err(|error| store_error(&error))
        })
        .await;
        // A store that can't answer pauses them anyway, as a failed wake-up check does.
        found.unwrap_or(true)
    }

    /// Sends what is waiting as the run's next turn, through the same resume as `agent/send`
    /// (PLX-42, PLX-380). Pauses wake-ups at the cap, or when this fails, keeping what is
    /// waiting. Only a project's current coordinator wakes: a replaced one drops them, so a
    /// project never has two live (0024).
    async fn wake(&mut self) {
        if self.is_coordinator() {
            let project = self.project.into();
            let current = store(&self.daemon, move |db| {
                super::coordinator::coordinator_of(db, project)
            })
            .await;
            match current {
                Ok(Some(current)) if current == self.id => {}
                Ok(_) => {
                    self.wakes.clear();
                    return;
                }
                Err(error) => {
                    warn!(run = %self.id, error = %error.message, "could not check a coordinator before waking it");
                    self.pause_wakes(true).await;
                    return;
                }
            }
        }
        // A coordinator's wake-up carries its children's memory proposals (0044).
        let proposals = if self.is_coordinator() {
            super::wake::proposals(&self.daemon, self.project).await
        } else {
            Vec::new()
        };
        let (paths, mut lines): (Vec<String>, Vec<String>) = proposals.into_iter().unzip();
        // And, while its memory index is over the cap, a request to merge entries (0044).
        if self.is_coordinator()
            && crate::context::memory::start(&self.daemon, self.project)
                .await
                .is_ok_and(|start| start.over)
        {
            lines.push(crate::context::memory::MERGE.to_owned());
        }
        let Some((turn_id, text)) = self.wakes.next(&lines) else {
            self.pause_wakes(true).await;
            return;
        };
        info!(run = %self.id, "waking a parent: threads it launched finished");
        match self
            .resume(
                turn_id,
                text,
                Vec::new(),
                Vec::new(),
                RunOptions::default(),
                None,
            )
            .await
        {
            Ok(_) if self.live.is_some() => {
                let questions = self.wakes.delivered();
                self.save_wakes().await;
                super::wake::delivered_proposals(&self.daemon, self.project, paths).await;
                wake::deliver(&self.daemon, self.id, questions).await;
            }
            Ok(_) => self.pause_wakes(true).await,
            Err(error) => {
                warn!(run = %self.id, error = %error.message, "could not wake a parent");
                self.pause_wakes(true).await;
            }
        }
    }

    /// Stops waking the run until the user writes, and says so once (PLX-42). A pause plxd makes
    /// on its own, `notify`, also adds a `needsYou` item to a coordinator's Project's inbox
    /// (PLX-401); the user's own Stop doesn't.
    async fn pause_wakes(&mut self, notify: bool) {
        if self.wakes.pause() {
            info!(run = %self.id, "pausing a run's wake-ups until the user writes");
            let (id, state) = (self.row.id, self.wakes.state());
            let (run_id, project) = (self.id, self.project);
            let saved = self
                .write(move |db, now| {
                    db.set_wake_state(id, state)
                        .map_err(|error| store_error(&error))?;
                    db.stage(
                        now,
                        Some(project),
                        ParallaxEvent::AgentWakeupsPaused { run_id },
                    );
                    Ok(())
                })
                .await;
            if let Err(error) = saved {
                warn!(run = %self.id, error = %error.message, "could not store a run's wake-ups");
            }
            if notify && self.is_coordinator() {
                self.inbox(InboxKind::NeedsYou, WAKEUPS_PAUSED.to_owned())
                    .await;
            }
        }
    }

    /// Takes up the run's wake-up count and pause where the last plxd left them (PLX-178). If
    /// they can't be read, pauses wake-ups, as a failed check does.
    async fn load_wakes(&mut self) {
        let id = self.row.id;
        let stored = store(&self.daemon, move |db| {
            db.wake_state(id).map_err(|error| store_error(&error))
        })
        .await;
        match stored {
            Ok(state) => self.wakes.restore(state),
            Err(error) => {
                warn!(run = %self.id, error = %error.message, "could not read a run's wake-ups");
                self.pause_wakes(true).await;
            }
        }
    }

    /// Stores the run's wake-up count and pause, so a restart keeps them (PLX-178).
    async fn save_wakes(&self) {
        let (id, state) = (self.row.id, self.wakes.state());
        let saved = store(&self.daemon, move |db| {
            db.set_wake_state(id, state)
                .map_err(|error| store_error(&error))
        })
        .await;
        if let Err(error) = saved {
            warn!(run = %self.id, error = %error.message, "could not store a run's wake-ups");
        }
    }

    /// `thread/delete` and `project/delete`: cancels a running CLI and waits for it to exit and
    /// its changes to be committed, then deletes the run's rows, events, worktree, and a thread's
    /// scratch folders ([`crate::threads::purge`]), and drops this actor from the map. Running
    /// here, between commands, it never races a resume or an accept. A push or Open PR, which
    /// works in the run's folder, makes it wait for the effect to finish with `wait`, and
    /// otherwise refuses it (`gitRefused`).
    async fn delete(&mut self, wait: bool, command_id: Option<Uuid>) -> Result<(), ErrorObject> {
        if wait && let Some(effect) = &mut self.effect {
            let finished = effect.await;
            self.finish_effect(finished).await;
        }
        self.effect_busy(ErrorKind::GitRefused)?;
        if self.live.is_some() {
            self.stop_approvals(AgentApprovalBy::Cancel).await;
        }
        if let Some(live) = &self.live {
            info!(run = %self.id, "cancelling an agent run to delete it");
            live.run.cancel();
            while self.live.is_some() {
                let event = next_event(&mut self.live).await;
                self.on_event(event).await;
            }
        }
        self.flush().await;
        // The thread's lane (0059) holds off a concurrent create/actor_for retry for this run id
        // while its rows are deleted and this actor is dropped (#110).
        let lane = self.daemon.orchestrator.lane(self.id).await;
        crate::threads::purge(
            &self.daemon,
            &lane,
            self.id,
            self.worktree.clone(),
            command_id,
        )
        .await?;
        self.worktree = None;
        self.daemon.agents.forget(self.id);
        Ok(())
    }

    /// `agent/accept`: merges the run's latest commit into the project's current branch, removes
    /// its worktree and branch, and records it `accepted` (#157, #68).
    async fn accept(
        &mut self,
        id: AcceptId,
        reviewed: Option<String>,
    ) -> Result<(AgentRun, AgentMerge), ErrorObject> {
        if let Some(accept) = &self.row.state.accept {
            if accept.id == Uuid::from(id) {
                return Ok((self.snapshot()?, convert::merge(accept)));
            }
            return Err(super::run_accepted(self.id));
        }
        let refused = |why: String| ErrorObject::parallax(ErrorKind::MergeRefused, why);
        if self.live.is_some() {
            return Err(refused(format!(
                "run {} is still running; wait for it to finish, or cancel it, then accept",
                self.id
            )));
        }
        self.effect_busy(ErrorKind::MergeRefused)?;
        let Some(commit) = self.row.state.commit_sha.clone() else {
            return Err(refused(format!(
                "run {} has no committed changes to accept",
                self.id
            )));
        };
        if let Some(reviewed) = reviewed
            && reviewed != commit
        {
            return Err(refused(format!(
                "run {} has committed new changes since {reviewed}, the commit you reviewed; \
                 review {commit} before accepting",
                self.id
            )));
        }
        let Some(worktree) = self.worktree.clone() else {
            return Err(ErrorObject::internal_error(format!(
                "run {} has no recorded worktree",
                self.id
            )));
        };
        let worktrees = &self.daemon.agents.worktrees;
        let repo = Path::new(&worktree.repo_path);
        let message = merge_message(&self.row.fields.prompt, self.id, &worktree.branch);
        let accepted = worktrees
            .accept(repo, &commit, &message)
            .await
            .map_err(|error| accept_error(&error))?;
        info!(run = %self.id, into = %accepted.into, commit = %accepted.commit, "accepted an agent run");
        if let Err(error) = worktrees
            .remove(repo, Path::new(&worktree.path), &worktree.branch)
            .await
        {
            warn!(run = %self.id, %error, "could not remove an accepted run's worktree");
        }

        let accept = RunAccept {
            id: id.into(),
            commit: accepted.commit,
            into: accepted.into,
            how: convert::merge_how_text(accepted.how).to_owned(),
        };
        convert::ACCEPTED.clone_into(&mut self.row.state.status);
        self.row.state.error = None;
        self.row.state.resume_at = None;
        self.row.state.accept = Some(accept.clone());
        let (row_id, state) = (self.row.id, self.row.state.clone());
        let (run_id, project) = (self.id, self.project);
        let merge = convert::merge(&accept);
        let accepted_merge = merge.clone();
        let saved = self
            .write(move |db, now| {
                let row = db
                    .accept_run(row_id, &state)
                    .map_err(|error| store_error(&error))?;
                db.stage(
                    now,
                    Some(project),
                    ParallaxEvent::AgentAccepted {
                        run_id,
                        merge: accepted_merge,
                    },
                );
                let state = convert::run_state(&row);
                db.stage(
                    now,
                    Some(project),
                    ParallaxEvent::AgentUpdated { run_id, state },
                );
                Ok(row)
            })
            .await;
        match saved {
            Ok(row) => self.row = row,
            Err(error) => {
                warn!(run = %self.id, error = %error.message, "could not store an accepted run");
            }
        }
        self.worktree = None;
        Ok((self.snapshot()?, merge))
    }

    /// `agent/openPr`: checks the run can open a pull request, and returns the actor's effect
    /// that pushes its branch to its repository's `origin` and returns the URL of its pull
    /// request, opening one if none is open (PLX-168). Checked here, between commands, and run
    /// while no CLI does, it never races a turn or its commit.
    async fn open_pr(
        &self,
        title: String,
        body: String,
    ) -> Result<impl Future<Output = Result<String, ErrorObject>> + Send + 'static, ErrorObject>
    {
        if self.accepted() {
            return Err(super::run_accepted(self.id));
        }
        let refused = |why: String| ErrorObject::parallax(ErrorKind::PrRefused, why);
        if self.live.is_some() {
            return Err(refused(format!(
                "run {} is still running; open a pull request once it has finished",
                self.id
            )));
        }
        self.effect_busy(ErrorKind::PrRefused)?;
        // A Current checkout thread pushes the branch its checkout has out (PLX-298).
        let (repo, branch) = if self.row.fields.checkout {
            let repo = self.checkout_path().await?;
            let worktrees = &self.daemon.agents.worktrees;
            let branch = worktrees
                .current_branch(&repo)
                .await
                .map_err(|error| ErrorObject::parallax(ErrorKind::PushFailed, error.to_string()))?
                .ok_or_else(|| {
                    refused(format!(
                        "run {}'s checkout has a detached HEAD; check out a branch to open a pull \
                         request",
                        self.id
                    ))
                })?;
            (repo, branch)
        } else {
            if self.row.state.commit_sha.is_none() {
                return Err(refused(format!(
                    "run {} has no committed changes to open a pull request for",
                    self.id
                )));
            }
            let project = self.project;
            if store(&self.daemon, move |db| {
                crate::threads::is_scratch(db, project)
            })
            .await?
            {
                return Err(refused(format!(
                    "run {} is a thread with no repository, so it has no origin to push to",
                    self.id
                )));
            }
            let Some(worktree) = &self.worktree else {
                return Err(ErrorObject::internal_error(format!(
                    "run {} has no recorded worktree",
                    self.id
                )));
            };
            (PathBuf::from(&worktree.repo_path), worktree.branch.clone())
        };
        let (daemon, run) = (Arc::clone(&self.daemon), self.id);
        Ok(async move {
            let url = daemon
                .agents
                .worktrees
                .open_pr(&repo, &branch, &title, &body)
                .await
                .map_err(|error| super::pr_error(&error))?;
            info!(%run, %url, "opened a pull request for an agent run");
            Ok(url)
        })
    }

    /// Runs `effect` in a task on the runs' tracker, off this loop, which gets its result back,
    /// wrapped by `finished` with `reply`, in [`Self::finish_effect`] (PLX-458). A request its
    /// checks refused is answered now.
    fn start_effect<T: Send + 'static>(
        &mut self,
        effect: Result<impl Future<Output = Result<T, ErrorObject>> + Send + 'static, ErrorObject>,
        reply: Reply<T>,
        finished: fn(Result<T, ErrorObject>, Reply<T>) -> Finished,
    ) {
        match effect {
            Ok(effect) => {
                let task = async move { finished(effect.await, reply) };
                self.effect = Some(self.daemon.agents.tracker.spawn(task));
            }
            Err(error) => {
                let _ = reply.send(Err(error));
            }
        }
    }

    /// The run's push or Open PR ended: links the pull request it opened, and answers its
    /// request.
    async fn finish_effect(&mut self, finished: Result<Finished, JoinError>) {
        self.effect = None;
        match finished {
            Ok(Finished::Push(answer, reply)) => {
                let _ = reply.send(answer);
            }
            Ok(Finished::OpenPr(answer, reply)) => {
                if let Ok(url) = &answer {
                    self.link_pr(url.clone()).await;
                }
                let _ = reply.send(answer);
            }
            // Its reply went with it, so its request fails as for an actor that's gone.
            Err(error) => warn!(run = %self.id, %error, "a push or Open PR failed"),
        }
    }

    /// Refuses, as `kind`, what can't run beside the run's push or Open PR (PLX-458).
    fn effect_busy(&self, kind: ErrorKind) -> Result<(), ErrorObject> {
        if self.effect.is_none() {
            return Ok(());
        }
        Err(ErrorObject::parallax(
            kind,
            format!(
                "run {} is pushing its branch or opening a pull request; try again once that's \
                 done",
                self.id
            ),
        ))
    }

    /// Links pull request `url` to the run, unless it already is, and reports it as
    /// `agent.updated` (PLX-318).
    async fn link_pr(&mut self, url: String) {
        if self.row.state.pull_requests.contains(&url) {
            return;
        }
        info!(run = %self.id, %url, "linked a pull request to an agent run");
        self.row.state.pull_requests.push(url);
        self.save().await;
    }

    /// Removes pull request `url` from the run's links, if it is there, and reports it as
    /// `agent.updated` (0041).
    async fn unlink_pr(&mut self, url: &str) {
        let before = self.row.state.pull_requests.len();
        self.row.state.pull_requests.retain(|linked| linked != url);
        if self.row.state.pull_requests.len() != before {
            info!(run = %self.id, %url, "unlinked a pull request from an agent run");
            self.save().await;
        }
    }

    /// The pull requests a finished `gh pr create` tool call printed, whatever the backend: its
    /// call is told by its input's JSON text, not by the tool's name, and remembered until its
    /// result.
    fn created_prs(&mut self, event: &Event) -> Vec<String> {
        // A subagent's `gh pr create` opens the thread's pull request too (PLX-382).
        let event = match event {
            Event::Subagent { event, .. } => event,
            event => event,
        };
        match event {
            Event::ToolCall { call_id, input, .. }
                if input.to_string().contains("gh pr create") =>
            {
                self.pr_calls.insert(call_id.clone());
                Vec::new()
            }
            Event::ToolResult {
                call_id, output, ..
            } if self.pr_calls.remove(call_id) => {
                output.as_deref().map(github_pr_urls).unwrap_or_default()
            }
            _ => Vec::new(),
        }
    }

    /// `agent/approve` (PLX-222): passes the user's answer to the CLI and logs it as the
    /// request's resolution. A request that already ended answers with how it ended.
    async fn approve(
        &mut self,
        params: AgentApproveParams,
    ) -> Result<AgentApproveResult, ErrorObject> {
        let AgentApproveParams {
            approval_id,
            decision,
            input,
            always,
            message,
            ..
        } = params;
        match self.approvals.lookup(approval_id) {
            Lookup::Resolved(resolution) => return Ok(resolution),
            Lookup::Unknown => return Err(super::approval_not_found(self.id, approval_id)),
            Lookup::Pending { offers_always, .. } if always && !offers_always => {
                return Err(ErrorObject::invalid_params(format!(
                    "permission request {approval_id} offers no rules to always allow"
                )));
            }
            // Claude Code may not hold an edited input to its worker's confinement (0031).
            Lookup::Pending { paths, .. }
                if self.row.fields.policy == WORKSPACE_WRITE
                    && input
                        .as_ref()
                        .is_some_and(|edited| approvals::moves_paths(&paths, edited)) =>
            {
                return Err(ErrorObject::invalid_params(format!(
                    "an edit to permission request {approval_id} must keep its {}, and may \
                     leave out its {} but not change it",
                    approvals::PATH_FIELDS.join(", "),
                    approvals::PLAN_PATH_FIELD,
                )));
            }
            Lookup::Pending { .. } => {}
        }
        let allow = decision == AgentApprovalAnswer::Allow;
        let answer = Answer {
            approval_id,
            decision: if allow {
                Decision::Allow { input, always }
            } else {
                Decision::Deny {
                    message: message
                        .clone()
                        .unwrap_or_else(|| approvals::DENIED.to_owned()),
                    interrupt: false,
                }
            },
        };
        let sent = match &self.live {
            Some(live) => live.run.answer(answer),
            None => Err(AnswerError::Finished),
        };
        if sent.is_ok() {
            let resolution = if allow {
                AgentApproveResult {
                    decision: AgentApprovalDecision::Allowed,
                    by: AgentApprovalBy::User,
                    always,
                    message: None,
                }
            } else {
                AgentApproveResult {
                    decision: AgentApprovalDecision::Denied,
                    by: AgentApprovalBy::User,
                    always: false,
                    message,
                }
            };
            self.resolve_approval(approval_id, resolution.clone()).await;
            self.flush().await;
            return Ok(resolution);
        }
        // The CLI that asked no longer waits: it exited, perhaps with a fallback attempt running
        // in its place (#119), so the request ends as the CLI's exit ends it. Waiting for the
        // run's end here would hold up this actor for the fallback attempt's whole run.
        let withdrawn = ended(AgentApprovalDecision::Withdrawn, AgentApprovalBy::Agent);
        self.resolve_approval(approval_id, withdrawn).await;
        self.flush().await;
        match self.approvals.lookup(approval_id) {
            Lookup::Resolved(resolution) => Ok(resolution),
            Lookup::Pending { .. } | Lookup::Unknown => Err(ErrorObject::internal_error(format!(
                "permission request {approval_id} was left unresolved"
            ))),
        }
    }

    /// Denies every permission request nobody answered in time (PLX-222).
    async fn expire_approvals(&mut self) {
        for approval_id in self.approvals.expired(Instant::now()) {
            info!(run = %self.id, approval = %approval_id, "a permission request expired");
            if let Some(live) = &self.live {
                let decision = Decision::Deny {
                    message: approvals::EXPIRED.to_owned(),
                    interrupt: false,
                };
                let _ = live.run.answer(Answer {
                    approval_id,
                    decision,
                });
            }
            let expired = ended(AgentApprovalDecision::Expired, AgentApprovalBy::Timeout);
            self.resolve_approval(approval_id, expired).await;
        }
    }

    /// Denies every waiting permission request, ending the CLI's turn as well, because `by` is
    /// stopping the run.
    async fn stop_approvals(&mut self, by: AgentApprovalBy) {
        for approval_id in self.approvals.pending() {
            if let Some(live) = &self.live {
                let decision = Decision::Deny {
                    message: approvals::STOPPED.to_owned(),
                    interrupt: true,
                };
                let _ = live.run.answer(Answer {
                    approval_id,
                    decision,
                });
            }
            let stopped = ended(AgentApprovalDecision::Denied, by);
            self.resolve_approval(approval_id, stopped).await;
        }
    }

    /// Records how a waiting permission request ended, and logs it as `approvalResolved`. Does
    /// nothing to one that already ended.
    async fn resolve_approval(&mut self, approval_id: ApprovalId, resolution: AgentApproveResult) {
        let item = convert::approval_resolved(approval_id, &resolution);
        if self.approvals.resolve(approval_id, resolution) {
            self.push(item).await;
        }
    }

    /// `agent/send`: `queued` goes into the running turn with `steer`, and otherwise as the
    /// run's next turn, waiting for it if it must.
    async fn send(
        &mut self,
        mut queued: Queued,
        delivery: Delivery,
    ) -> Result<AgentRun, ErrorObject> {
        if queued.text.trim().is_empty() && queued.images.is_empty() {
            return Err(ErrorObject::invalid_params("text must not be empty"));
        }
        self.check_compact(&queued)?;
        // A run in a Project runs in its mode, so a message can't change it (0042).
        if queued.options.permission.is_some()
            && super::project_mode(&self.daemon, self.project)
                .await?
                .is_some()
        {
            queued.options.permission = None;
        }
        let (turn_id, text) = (queued.turn_id, &queued.text);
        if self.accepted() {
            return Err(super::run_accepted(self.id));
        }
        let waiting = self.queued.iter().find(|queued| queued.turn_id == turn_id);
        if let Some(sent) = self
            .turns
            .get(&turn_id)
            .or(waiting.map(|queued| &queued.text))
        {
            return if sent == text {
                self.snapshot()
            } else {
                Err(id_conflict(turn_id))
            };
        }
        // No CLI starts while a push or Open PR runs (PLX-458). A steer waits too: no turn runs
        // for it to go into.
        if self.effect.is_some() {
            return self.queue(queued).await;
        }
        if delivery != Delivery::Queue {
            return self.steer(queued, delivery == Delivery::Restart).await;
        }
        // A running CLI can't change what it runs with, a turn in progress finishes before the
        // next starts, and what's sent after a message that waits waits too, so the messages keep
        // their order.
        if self.live.is_some()
            && (self.changing(&queued) || self.in_flight > 0 || !self.queued.is_empty())
        {
            return self.queue(queued).await;
        }
        if self.live.is_some() {
            match self.hand_over(&queued).await? {
                Ok(seen) => {
                    self.handed_over(queued, seen).await;
                    return self.snapshot();
                }
                Err(SendError::IdConflict) => return Err(id_conflict(turn_id)),
                // A backend that takes no messages while it runs gets this one once it's done.
                Err(SendError::Unsupported) => return self.queue(queued).await,
                // The CLI is exiting: let the run finish, then resume it with the message.
                Err(SendError::Finished) => self.drain().await,
            }
        }
        let Queued {
            turn_id,
            text,
            images,
            threads,
            options,
            account,
            from: _,
        } = queued;
        let changes = self.changes(options);
        self.resume(turn_id, text, images, threads, changes, account)
            .await
    }

    /// `agent/send` with `delivery: steer`, and `queue/steer`: `queued` goes into the turn running
    /// now (PLX-370). A backend that takes no messages while it runs is cancelled and resumed
    /// with it, as every backend is with `restart` (0059's `restart_active`), and a run with no
    /// CLI running resumes with it at once.
    async fn steer(&mut self, queued: Queued, restart: bool) -> Result<AgentRun, ErrorObject> {
        if is_compact(&queued.text, &queued.images) {
            return Err(ErrorObject::parallax(
                ErrorKind::UnsupportedOption,
                "/compact runs as a turn of its own, so it can't go into the running turn; queue \
                 it instead",
            ));
        }
        if self.changing(&queued) {
            return Err(ErrorObject::parallax(
                ErrorKind::UnsupportedOption,
                "a steer goes into the running turn, which can't change the run's model, \
                 options, or account; queue the message instead",
            ));
        }
        let (mut steer, seen) = queued.follow_up(&self.daemon, self.id).await?;
        steer.steer = true;
        let sent = self.live.as_ref().map(|live| {
            if restart {
                Err(SendError::Unsupported)
            } else {
                live.run.send(steer)
            }
        });
        match sent {
            Some(Ok(())) => {
                info!(run = %self.id, turn = %queued.turn_id, "steering a running turn");
                self.handed_over(queued, seen).await;
                return self.snapshot();
            }
            Some(Err(SendError::IdConflict)) => return Err(id_conflict(queued.turn_id)),
            Some(Err(SendError::Unsupported)) => {
                info!(run = %self.id, turn = %queued.turn_id, "interrupting a run to steer it");
                self.stop_approvals(AgentApprovalBy::Cancel).await;
                if let Some(live) = &self.live {
                    live.run.cancel();
                }
                self.drain().await;
            }
            Some(Err(SendError::Finished)) => self.drain().await,
            None => self.effect_busy(ErrorKind::RunNotResumable)?,
        }
        let Queued {
            turn_id,
            text,
            images,
            threads,
            ..
        } = queued;
        self.resume(turn_id, text, images, threads, RunOptions::default(), None)
            .await
    }

    /// Refuses a `/compact` (PLX-638) on a backend that can't compact its context: only Claude
    /// Code and Codex can, as T3 Code's adapters. A backend this host no longer has passes, since
    /// the message can't start anywhere.
    fn check_compact(&self, queued: &Queued) -> Result<(), ErrorObject> {
        if !is_compact(&queued.text, &queued.images) {
            return Ok(());
        }
        let name = &self.row.fields.backend;
        let compacts = self
            .daemon
            .agents
            .backends
            .by_backend_name(name)
            .is_none_or(|(_, backend)| {
                matches!(backend.cli(), Some(CliKind::Claude | CliKind::Codex))
            });
        if compacts {
            return Ok(());
        }
        Err(ErrorObject::parallax(
            ErrorKind::UnsupportedOption,
            format!("{} can't compact its context", backend_name(name)),
        ))
    }

    /// Hands `queued` to the live CLI as its next turn.
    async fn hand_over(
        &self,
        queued: &Queued,
    ) -> Result<Result<Vec<(Uuid, u64)>, SendError>, ErrorObject> {
        let (follow_up, seen) = queued.follow_up(&self.daemon, self.id).await?;
        Ok(match &self.live {
            Some(live) => live.run.send(follow_up).map(|()| seen),
            None => Err(SendError::Finished),
        })
    }

    /// Records `queued`, which the live CLI has taken.
    async fn handed_over(&mut self, queued: Queued, seen: Vec<(Uuid, u64)>) {
        self.in_flight += 1;
        self.handed.push(queued.clone());
        self.record_turn(queued.turn_id, queued.text.clone(), seen)
            .await;
        self.keep_images(Some(queued.turn_id), queued.images).await;
        self.attach(Some(queued.turn_id), queued.threads);
        self.last_message = queued.text;
    }

    /// Lets the live CLI, which is exiting or was cancelled, finish.
    async fn drain(&mut self) {
        while self.live.is_some() {
            let event = next_event(&mut self.live).await;
            self.on_event(event).await;
        }
    }

    /// Whether `queued` changes what the run's CLI runs with, so it waits for the CLI to exit.
    fn changing(&self, queued: &Queued) -> bool {
        self.changes(queued.options.clone()) != RunOptions::default()
            || self.moves(queued.account.as_ref())
    }

    /// Of `options`, those that differ from the run's.
    fn changes(&self, options: RunOptions) -> RunOptions {
        let fields = &self.row.fields;
        RunOptions {
            model: options.model.filter(|m| Some(m) != fields.model.as_ref()),
            effort: options.effort.filter(|&e| option_name(e) != fields.effort),
            permission: options
                .permission
                .filter(|&p| option_name(p) != fields.permission),
            context_window: options
                .context_window
                .filter(|&w| Some(w) != fields.context_window),
            fast: options.fast.filter(|&f| Some(f) != fields.fast),
        }
    }

    /// Whether `account` is another account than the one the run's session is on.
    fn moves(&self, account: Option<&AccountChoice>) -> bool {
        account.is_some_and(|account| *account != session_account(&self.row.state.account_id))
    }

    /// Keeps a message until the run's CLI can take it.
    async fn queue(&mut self, queued: Queued) -> Result<AgentRun, ErrorObject> {
        info!(run = %self.id, turn = %queued.turn_id, "a message waits for the run's CLI");
        self.queued.push_back(queued);
        // A message plxd couldn't store must not look queued.
        if let Err(error) = self.store_queue(&self.queued.clone(), None).await {
            self.queued.pop_back();
            return Err(error);
        }
        self.snapshot()
    }

    /// Sends what waits as far as the run can take it now: while no CLI runs, the next message
    /// to a new CLI process, once no push or Open PR runs either; while the live CLI has no turn
    /// in progress, the next message that doesn't change what it runs with, as its next turn.
    /// Holds the CLI open while that waits.
    async fn deliver(&mut self) {
        if self.stopping || self.queue_held {
            return;
        }
        if self.live.is_none() && self.effect.is_none() {
            self.send_queued().await;
        }
        while self.in_flight == 0 && self.live.is_some() {
            let Some(next) = self.queued.front().cloned() else {
                break;
            };
            if self.changing(&next) {
                break;
            }
            // At least once (0048): the CLI gets the message before its stored row is deleted,
            // so a crash between the two resends it once after a restart, as `record_turn` does,
            // rather than losing it.
            let handed = match self.hand_over(&next).await {
                Ok(handed) => handed,
                Err(error) => {
                    self.queued.pop_front();
                    self.dropped(next.turn_id, &error.message).await;
                    self.save_queue().await;
                    continue;
                }
            };
            match handed {
                Ok(seen) => {
                    self.queued.pop_front();
                    self.handed_over(next, seen).await;
                    self.save_queue().await;
                }
                Err(SendError::IdConflict) => {
                    self.queued.pop_front();
                    self.dropped(next.turn_id, "its turn id was already used")
                        .await;
                    self.save_queue().await;
                }
                // It goes once the CLI has exited.
                Err(SendError::Unsupported | SendError::Finished) => break,
            }
        }
        let hold =
            self.live.is_some() && self.queued.front().is_some_and(|next| !self.changing(next));
        if let Some(live) = &self.live
            && hold != self.held
        {
            live.run.hold(hold);
            self.held = hold;
        }
    }

    /// Sends the next waiting message, now that no CLI runs, to a new CLI process with its
    /// changes; those after it wait for that process in turn. A message that can't be sent is
    /// dropped, and the transcript says why, and the next is tried.
    async fn send_queued(&mut self) {
        while self.live.is_none() {
            let Some(next) = self.queued.pop_front() else {
                return;
            };
            let Queued {
                turn_id,
                text,
                images,
                threads,
                options,
                account,
                from: _,
            } = next;
            let changes = self.changes(options);
            let why = match self
                .resume(turn_id, text, images, threads, changes, account)
                .await
            {
                Ok(_) if self.live.is_some() => None,
                Ok(_) => Some(
                    self.row
                        .state
                        .error
                        .clone()
                        .unwrap_or_else(|| "its CLI didn't start".to_owned()),
                ),
                Err(error) => Some(error.message),
            };
            if let Some(why) = why {
                self.dropped(turn_id, &why).await;
            }
            self.save_queue().await;
        }
    }

    /// Logs that waiting message `turn_id` couldn't be sent, and why.
    async fn dropped(&mut self, turn_id: TurnId, why: &str) {
        warn!(run = %self.id, turn = %turn_id, %why, "a waiting message couldn't be sent");
        self.push(AgentOutputItem::Warning {
            detail: format!("A message couldn't be sent: {why}"),
        })
        .await;
        self.senders.remove(&turn_id);
        self.push(AgentOutputItem::FollowUpDropped { turn_id })
            .await;
        self.flush().await;
    }

    /// Drops every waiting message, which never reached a CLI, as a stopped run's follow-ups are.
    async fn drop_queued(&mut self) {
        if self.queued.is_empty() {
            return;
        }
        while let Some(queued) = self.queued.pop_front() {
            info!(run = %self.id, turn = %queued.turn_id, "dropping a waiting message");
            let turn_id = queued.turn_id;
            self.senders.remove(&turn_id);
            self.push(AgentOutputItem::FollowUpDropped { turn_id })
                .await;
        }
        self.save_queue().await;
    }

    /// `queue/*` (PLX-370): reads or changes the waiting messages, and answers with them as they
    /// are after.
    async fn queue_op(
        &mut self,
        op: QueueOp,
        command_id: Option<Uuid>,
    ) -> Result<QueueResult, ErrorObject> {
        match op {
            QueueOp::List => {}
            QueueOp::Edit { id, text } => {
                let at = self.position(id)?;
                if text.trim().is_empty() && self.queued[at].images.is_empty() {
                    return Err(ErrorObject::invalid_params("text must not be empty"));
                }
                let mut edited = self.queued.clone();
                edited[at].text = text;
                self.store_queue(&edited, None).await?;
                self.queued = edited;
            }
            QueueOp::Reorder { ids } => {
                let mut rest = self.queued.clone();
                let mut reordered = VecDeque::with_capacity(rest.len());
                for id in ids {
                    let at = rest.iter().position(|queued| queued.turn_id == id);
                    let Some(queued) = at.and_then(|at| rest.remove(at)) else {
                        return Err(ErrorObject::invalid_params(format!(
                            "ids must list each waiting message once, and {id} isn't one or is \
                             listed twice"
                        )));
                    };
                    reordered.push_back(queued);
                }
                if !rest.is_empty() {
                    return Err(ErrorObject::invalid_params(format!(
                        "ids must list each waiting message once, and leave out {}",
                        rest.len()
                    )));
                }
                self.store_queue(&reordered, None).await?;
                self.queued = reordered;
            }
            QueueOp::Cancel { id } => {
                let at = self.position(id)?;
                let mut remaining = self.queued.clone();
                remaining.remove(at);
                info!(run = %self.id, turn = %id, "cancelling a waiting message");
                // Staged in the same job as the queue, so the two commit together.
                self.push(AgentOutputItem::FollowUpDropped { turn_id: id })
                    .await;
                self.store_queue(&remaining, command_id).await?;
                self.queued = remaining;
                self.senders.remove(&id);
            }
            QueueOp::Resume => {
                if self.queue_held {
                    info!(run = %self.id, "resuming a held queue");
                    self.queue_held = false;
                    if let Err(error) = self.store_queue(&self.queued.clone(), command_id).await {
                        self.queue_held = true;
                        return Err(error);
                    }
                }
            }
            QueueOp::Steer { id } => {
                let at = self.position(id)?;
                let queued = self.queued[at].clone();
                if self.changing(&queued) {
                    // `steer` refuses it; the message keeps its place.
                    self.steer(queued, false).await?;
                } else {
                    self.queued.remove(at);
                    let steered = self.steer(queued.clone(), false).await;
                    if let Err(error) = steered {
                        let at = at.min(self.queued.len());
                        self.queued.insert(at, queued);
                        return Err(error);
                    }
                    if let Err(error) = self.store_queue(&self.queued.clone(), command_id).await {
                        // Delivery already happened. Remove its durable queue entry without the
                        // failing receipt update, and retain the error even if persistence fails.
                        let reconciled = self.store_queue(&self.queued.clone(), None).await;
                        let error = match reconciled {
                            Ok(()) => error,
                            Err(reconcile) => ErrorObject::internal_error(format!(
                                "{}; could not reconcile the steered queue: {}",
                                error.message, reconcile.message
                            )),
                        };
                        if let Some(id) = command_id {
                            self.daemon.commands.applied_error(id, error.clone());
                        }
                        return Err(error);
                    }
                }
            }
        }
        Ok(QueueResult {
            messages: self.messages(),
            held: self.queue_held,
        })
    }

    /// Where waiting message `id` is in the queue.
    fn position(&self, id: TurnId) -> Result<usize, ErrorObject> {
        self.queued
            .iter()
            .position(|queued| queued.turn_id == id)
            .ok_or_else(|| {
                ErrorObject::parallax(
                    ErrorKind::QueuedMessageNotFound,
                    format!("run {} has no waiting message {id}", self.id),
                )
            })
    }

    fn messages(&self) -> Vec<QueuedMessage> {
        self.queued.iter().map(Queued::message).collect()
    }

    /// Takes up the waiting messages the store has for the run, which a plxd before this one
    /// left (PLX-370). One that can't be read is left out, with a warning.
    async fn load_queue(&mut self) {
        let id = self.row.id;
        let stored = store(&self.daemon, move |db| {
            db.queue(id).map_err(|error| store_error(&error))
        })
        .await;
        match stored {
            Ok(rows) => {
                for row in rows {
                    match Queued::from_row(row) {
                        Some((queued, held)) => {
                            if let Some(from) = queued.from {
                                self.senders.insert(queued.turn_id, from);
                            }
                            self.queue_held |= held;
                            self.queued.push_back(queued);
                        }
                        None => {
                            warn!(run = %self.id, "a stored waiting message is corrupt; leaving it out");
                        }
                    }
                }
            }
            Err(error) => {
                warn!(run = %self.id, error = %error.message, "could not read a run's waiting messages");
            }
        }
    }

    /// Stores the waiting messages as they are now, and reports them as `queue.updated`.
    async fn save_queue(&mut self) {
        if let Err(error) = self.store_queue(&self.queued.clone(), None).await {
            warn!(run = %self.id, error = %error.message, "could not store a run's waiting messages");
        }
    }

    /// Stores `queued`, often a proposed queue before the actor applies it, completes
    /// `command_id`'s receipt, and reports it as `queue.updated`, in one job after any transcript
    /// items waiting to be sent. An empty queue is no longer held.
    async fn store_queue(
        &mut self,
        queued: &VecDeque<Queued>,
        command_id: Option<Uuid>,
    ) -> Result<(), ErrorObject> {
        let id = self.row.id;
        let (run_id, project) = (self.id, self.project);
        let held = self.queue_held && !queued.is_empty();
        let rows: Vec<QueuedRow> = queued.iter().map(|queued| queued.row(held)).collect();
        let messages: Vec<QueuedMessage> = queued.iter().map(Queued::message).collect();
        self.write(move |db, now| {
            db.set_queue(id, &rows)
                .map_err(|error| store_error(&error))?;
            crate::commands::complete(
                db,
                command_id,
                &QueueResult {
                    messages: messages.clone(),
                    held,
                },
            )?;
            db.stage(
                now,
                Some(project),
                ParallaxEvent::QueueUpdated {
                    run_id,
                    messages,
                    held,
                },
            );
            Ok(())
        })
        .await?;
        self.queue_held = held;
        Ok(())
    }

    /// Starts a new CLI process for the run with `text`, after the summaries of `threads`, and
    /// `images`, after storing `changes` to its options, which the new process runs with. It
    /// resumes the run's vendor session, on `account` if that's another of the same backend's. On
    /// another backend's account, or with no session to resume, a new session starts, told the
    /// conversation so far. A fork's first message forks its parent's session instead, when
    /// [`Actor::fork_source`] finds one (0050).
    async fn resume(
        &mut self,
        turn_id: TurnId,
        text: String,
        images: Vec<PromptImage>,
        threads: Vec<RunId>,
        changes: RunOptions,
        account: Option<AccountChoice>,
    ) -> Result<AgentRun, ErrorObject> {
        let moving = self.moves(account.as_ref());
        let session_id = self.row.state.session_id.clone();
        // The session belongs to the account the run was on when it ended, after any fallback,
        // not to whatever the worker role's default is now.
        let account = match account {
            Some(account) if moving => account,
            _ => session_account(&self.row.state.account_id),
        };
        let not_resumable = |why: String| {
            ErrorObject::parallax(
                ErrorKind::RunNotResumable,
                format!("run {} can't be resumed: {why}", self.id),
            )
        };
        let role = if self.is_coordinator() {
            // A replaced coordinator stays stopped: a project has one live coordinator (0024).
            let project = self.project;
            let current = store(&self.daemon, move |db| {
                super::coordinator::coordinator_of(db, project.into())
            })
            .await?;
            if let Some(current) = current.filter(|current| *current != self.id) {
                return Err(not_resumable(format!(
                    "project {project}'s coordinator is now run {current}"
                )));
            }
            Role::Coordinator
        } else {
            Role::Worker
        };
        let (prepared, repo_path) =
            match prepare(&self.daemon, self.project, self.id, Some(account), role).await {
                Ok(prepared) => prepared,
                Err(error)
                    if !moving
                        && error
                            .parallax_data()
                            .is_some_and(|data| data.kind == ErrorKind::AccountNotFound) =>
                {
                    return Err(not_resumable(format!(
                        "its session's account {} no longer exists",
                        self.row.state.account_id
                    )));
                }
                Err(error) => return Err(error),
            };
        let backend = prepared.resolved.backend().name();
        let from = self.row.fields.backend.clone();
        if backend != from && !moving {
            return Err(not_resumable(format!(
                "its session ran on {from}, but its account now runs on {backend}"
            )));
        }
        let session_id = session_id.filter(|_| backend == from);
        let paths = self.checkout_paths(&repo_path).await?;
        let attached = attached::prompt(&self.daemon, self.id, &threads, &text).await?;
        let (sent, seen) = (attached.text, attached.seen);
        // The run's fields before it moves, to move it back if its new CLI doesn't start.
        let moved_from = self
            .store_options(prepared.resolved.backend(), changes)
            .await?;
        let message = text;
        let opening = self.opening(session_id, from, sent, &prepared).await;
        let (prompt, resume, from) = match opening {
            Ok(opening) => opening,
            Err(error) => {
                self.move_back(moved_from).await;
                return Err(error);
            }
        };
        let fresh = resume.is_none();
        let to = backend.to_owned();
        // The old session, if any, is another CLI's, so the new CLI's start never stores it.
        let old_session = if fresh {
            self.row.state.session_id.take()
        } else {
            None
        };
        if self
            .launch(prepared, prompt, images, Some(turn_id), resume, paths)
            .await
        {
            if fresh {
                self.push(AgentOutputItem::Notice {
                    detail: handoff_notice(&from, &to),
                })
                .await;
            }
            // Only a turn that reached a CLI counts as sent: a retry after a failed start
            // tries again.
            self.record_turn(turn_id, message.clone(), seen).await;
            self.attach(Some(turn_id), threads);
            self.last_message = message;
        } else {
            self.row.state.session_id = old_session;
            self.move_back(moved_from).await;
        }
        self.snapshot()
    }

    /// Stores `changes` to the run's options, checked against `backend`. When `backend` isn't the
    /// run's, moves the run to it, where another vendor's model can't carry over but the other
    /// options can if `backend` maps them, and returns the run's fields from before the move. A
    /// run in a Project takes the Project's mode as it is now, which `project/update` may have
    /// changed since the run's last process (0042).
    async fn store_options(
        &mut self,
        backend: &dyn Backend,
        mut changes: RunOptions,
    ) -> Result<Option<parallax_store::RunFields>, ErrorObject> {
        if let Some(mode) = super::project_mode(&self.daemon, self.project).await? {
            let permission = super::in_mode(backend, mode)?;
            changes.permission =
                Some(permission).filter(|&p| option_name(p) != self.row.fields.permission);
        }
        let fields = &self.row.fields;
        let moving = backend.name() != fields.backend;
        let updated = if moving {
            let effort = fields.effort.as_deref().and_then(option_value);
            let permission = fields.permission.as_deref().and_then(option_value);
            let options = RunOptions {
                model: changes.model,
                effort: changes
                    .effort
                    .or(effort.filter(|effort| backend.efforts().contains(effort))),
                permission: changes
                    .permission
                    .or(permission.filter(|permission| backend.permissions().contains(permission))),
                context_window: changes.context_window.or(fields
                    .context_window
                    .filter(|tokens| backend.context_windows().contains(tokens))),
                fast: changes.fast.or(fields.fast.filter(|_| backend.fast_mode())),
            };
            options.check(backend)?;
            parallax_store::RunFields {
                backend: backend.name().to_owned(),
                model: options.model,
                effort: options.effort.and_then(option_name),
                permission: options.permission.and_then(option_name),
                context_window: options.context_window,
                fast: options.fast,
                ..fields.clone()
            }
        } else {
            if changes == RunOptions::default() {
                return Ok(None);
            }
            changes.check(backend)?;
            parallax_store::RunFields {
                model: changes.model.or(fields.model.clone()),
                effort: changes
                    .effort
                    .and_then(option_name)
                    .or(fields.effort.clone()),
                permission: changes
                    .permission
                    .and_then(option_name)
                    .or(fields.permission.clone()),
                context_window: changes.context_window.or(fields.context_window),
                fast: changes.fast.or(fields.fast),
                ..fields.clone()
            }
        };
        let id = self.row.id;
        let row = store(&self.daemon, move |db| {
            db.set_run_options(id, &updated)
                .map_err(|error| store_error(&error))
        })
        .await?;
        let before = std::mem::replace(&mut self.row.fields, row.fields);
        Ok(moving.then_some(before))
    }

    /// What a CLI needs to resume `session_id`: it, and the usage it has reported so far.
    async fn resume_of(&self, session_id: String) -> Result<Resume, ErrorObject> {
        let session = session_id.clone();
        let totals = store(&self.daemon, move |db| {
            db.session_usage_totals(&session)
                .map_err(|error| store_error(&error))
        })
        .await?;
        Ok(Resume {
            session_id,
            usage_totals: totals.into_iter().map(model_usage).collect(),
            fork: false,
        })
    }

    /// The first message and the session of the run's next CLI, on `prepared`'s backend, and the
    /// backend the conversation so far ran on: `text` with the run's session `session_id` to
    /// resume, or with a fork's parent session to fork ([`Actor::fork_source`]), or else a new
    /// session told the conversation so far, which ran on `from`, or for a fork's first message
    /// on its parent's backend.
    async fn opening(
        &mut self,
        session_id: Option<String>,
        mut from: String,
        text: String,
        prepared: &Prepared,
    ) -> Result<(String, Option<Resume>, String), ErrorObject> {
        if let Some(session_id) = session_id {
            info!(run = %self.id, "resuming an agent run's session");
            return Ok((text, Some(self.resume_of(session_id).await?), from));
        }
        if let Some(source) = self.fork_source(&prepared.resolved).await? {
            from = source.backend;
            if let Some(session_id) = source.session_id {
                info!(run = %self.id, "forking the parent thread's session");
                let resume = Resume {
                    fork: true,
                    ..self.resume_of(session_id).await?
                };
                return Ok((text, Some(resume), from));
            }
        }
        let to = prepared.resolved.backend().name();
        info!(run = %self.id, from, to, "starting a new session for an agent run");
        let prompt = self.handoff_prompt(&from, &text, &prepared.place).await?;
        Ok((prompt, None, from))
    }

    /// The parent of a fork that has sent nothing yet (0050), for its first CLI on `resolved`'s
    /// backend and account: the backend its conversation ran on, which for a parent that is a
    /// fork with no session yet is that of its nearest forked-from thread with one, and its
    /// session to continue a copy of when the backend can fork and the parent still runs on that
    /// backend and account, isn't running, and has had no turn since the one the fork was made
    /// at. With no session the fork takes a handoff (0014) from its own log, which starts with
    /// the parent's transcript up to that turn.
    async fn fork_source(
        &self,
        resolved: &routing::Resolved,
    ) -> Result<Option<ForkSource>, ErrorObject> {
        if !self.turns.is_empty() {
            return Ok(None);
        }
        let backend = resolved.backend();
        let (id, can_fork, backend, account_id) = (
            self.row.id,
            backend.capabilities().fork,
            backend.name().to_owned(),
            resolved.account_id(),
        );
        store(&self.daemon, move |db| {
            let error = |error| store_error(&error);
            let Some(from) = db
                .get_thread(id)
                .map_err(error)?
                .and_then(|thread| thread.fields.forked_from)
            else {
                return Ok(None);
            };
            let Some(parent) = db.get_run(from.run).map_err(error)? else {
                return Ok(None);
            };
            let latest = db.latest_turn(from.run).map_err(error)?;
            let idle =
                ![convert::RUNNING, convert::STARTING].contains(&parent.state.status.as_str());
            let same = parent.fields.backend == backend && parent.state.account_id == account_id;
            let unmoved = latest.unwrap_or(from.run) == from.turn;
            // Fork origins only point at older runs, so this ends.
            let mut ran = parent.clone();
            while ran.state.session_id.is_none()
                && let Some(from) = db
                    .get_thread(ran.id)
                    .map_err(error)?
                    .and_then(|t| t.fields.forked_from)
                && let Some(run) = db.get_run(from.run).map_err(error)?
            {
                ran = run;
            }
            Ok(Some(ForkSource {
                session_id: parent
                    .state
                    .session_id
                    .filter(|_| can_fork && idle && same && unmoved),
                backend: ran.fields.backend,
            }))
        })
        .await
    }

    /// Moves the run back to the backend and options it had, `fields`, after its move to another
    /// backend failed before a CLI started there.
    async fn move_back(&mut self, fields: Option<parallax_store::RunFields>) {
        let Some(fields) = fields else {
            return;
        };
        let id = self.row.id;
        let moved = store(&self.daemon, move |db| {
            db.set_run_options(id, &fields)
                .map_err(|error| store_error(&error))
        })
        .await;
        match moved {
            Ok(row) => {
                self.row.fields = row.fields;
                self.save().await;
            }
            Err(error) => {
                warn!(run = %self.id, error = %error.message, "could not move a run back to its backend");
            }
        }
    }

    /// The first message of a new session that takes over the run from one on `from`: what the
    /// run's first message says about where the agent is and what it may do, if anything, then
    /// the conversation so far, then `text`.
    async fn handoff_prompt(
        &mut self,
        from: &str,
        text: &str,
        place: &Place,
    ) -> Result<String, ErrorObject> {
        // What the agent said last is logged before the conversation is read.
        self.flush().await;
        let events = logged_events(&self.daemon, self.id).await?;
        let conversation = handoff::handoff(
            &events,
            Budget::Summary {
                cap: handoff::HANDOFF_BYTES,
            },
        );
        let message = handoff_message(from, &conversation, text);
        match place {
            Place::Coordinator { repo } => {
                let project = self.project.into();
                let autonomy = store(&self.daemon, move |db| {
                    crate::methods::question::autonomy_of(db, project)
                })
                .await?;
                Ok(super::coordinator::first_message(
                    &message,
                    &repo.to_string_lossy(),
                    autonomy,
                ))
            }
            Place::Worker { .. } => super::first_prompt(&message, place),
        }
    }

    /// A first attachment counts as seen only after its prompt reaches a CLI.
    pub(super) async fn record_initial_seen(&mut self, seen: Vec<(Uuid, u64)>) {
        if seen.is_empty() {
            return;
        }
        let run_id = self.row.id;
        let stored = self
            .write(move |db, _| {
                db.record_attached_seen(run_id, &seen)
                    .map_err(|error| store_error(&error))
            })
            .await;
        if let Err(error) = stored {
            warn!(run = %self.id, error = %error.message, "could not store initial attachment cursors");
        }
    }

    /// Records that `turn_id` was sent with `text`, in memory and in the store, so a retry of
    /// `agent/send` stays idempotent across a plxd restart, not only across a resumed CLI
    /// process within the same plxd (#190).
    /// Runs after the CLI has already accepted the turn (`live.run.send`'s `Ok`, or a successful
    /// `launch` in `resume`), so a crash between the two makes a retried `agent/send` after a
    /// restart send the message again: at-least-once, not exactly-once (#190 review non-blocking
    /// note). That's the same failure mode #190 was fixing in the other direction (a restart
    /// forgetting a turn was ever sent), and strictly better: a duplicate is visible in the
    /// transcript, a lost retry silently drops the user's message.
    async fn record_turn(&mut self, turn_id: TurnId, text: String, seen: Vec<(Uuid, u64)>) {
        self.turns.insert(turn_id, text.clone());
        let (run_id, id) = (self.row.id, self.id);
        let stored = store(&self.daemon, move |db| {
            db.record_turn(run_id, turn_id.into(), &text)
                .map_err(|error| store_error(&error))?;
            db.record_attached_seen(run_id, &seen)
                .map_err(|error| store_error(&error))?;
            crate::threads::prompted(db, run_id)
        })
        .await;
        if let Err(error) = stored {
            warn!(run = %id, error = %error.message, "could not store a sent turn");
        }
    }

    /// Logs the pending batch and, in the same job, indexes what the run said since the last turn
    /// for `thread/search` (PLX-487). Runs when a turn ends and when the CLI exits. An index that
    /// fails is logged, and the batch commits anyway.
    async fn index_text(&mut self) {
        let (id, run_id) = (self.id, self.row.id);
        let logged = self
            .with_output(false, move |db, _| {
                if let Err(error) = db.index_run_text(run_id) {
                    warn!(run = %id, %error, "could not index a turn's text");
                }
                Ok(())
            })
            .await;
        if let Err(error) = logged {
            warn!(run = %id, error = %error.message, "could not store a run's output; it was dropped");
        }
    }

    /// Stores the images of `turn_id`'s message, which its CLI has now taken, for its
    /// `TurnStarted` to list (PLX-191, decision 0026). If they can't be stored, the CLI still has
    /// them, and the transcript shows the message without them.
    async fn keep_images(&mut self, turn_id: Option<TurnId>, images: Vec<PromptImage>) {
        let ids = self.store_images(images).await;
        if !ids.is_empty() {
            self.images.insert(turn_id, ids);
        }
    }

    /// Stores `images` for `agent/image` and returns their ids, or none when there are none or
    /// they can't be stored.
    async fn store_images(&self, images: Vec<PromptImage>) -> Vec<ImageId> {
        if images.is_empty() {
            return Vec::new();
        }
        let ids: Vec<ImageId> = images.iter().map(|_| ImageId::generate()).collect();
        let rows: Vec<_> = ids
            .iter()
            .zip(images)
            .map(|(&id, image)| {
                let stored = StoredImage {
                    media_type: option_name(image.media_type).unwrap_or_default(),
                    data: image.data,
                };
                (Uuid::from(id), stored)
            })
            .collect();
        let run = self.row.id;
        let stored = store(&self.daemon, move |db| {
            db.add_images(run, &rows)
                .map_err(|error| store_error(&error))
        })
        .await;
        match stored {
            Ok(()) => ids,
            Err(error) => {
                warn!(run = %self.id, error = %error.message, "could not store images");
                Vec::new()
            }
        }
    }

    /// Stores the images a tool returned (PLX-640) and lists them on its `ToolResult`, when
    /// they pass a message's checks; the transcript shows the result without any that don't.
    async fn keep_tool_images(&self, event: &Event, item: &mut AgentOutputItem) {
        let (Event::ToolResult { images, .. }, AgentOutputItem::ToolResult { images: ids, .. }) =
            (event, item)
        else {
            return;
        };
        if let Err(error) = crate::images::check(images) {
            warn!(run = %self.id, error = %error.message, "dropped a tool's images");
            return;
        }
        *ids = self.store_images(images.clone()).await;
    }

    /// Keeps the threads attached to `turn_id`'s message, which its CLI has now taken, for its
    /// `TurnStarted` to list (PLX-372).
    pub(super) fn attach(&mut self, turn_id: Option<TurnId>, threads: Vec<RunId>) {
        if !threads.is_empty() {
            self.attached.insert(turn_id, threads);
        }
    }

    /// Starts the run's CLI with `prompt` and `images` and records the result: `running`, or
    /// `failed` with why. `paths` are a worker's worktree's and repository git folder's canonical
    /// paths, when the caller already has them. Returns whether the CLI started.
    pub async fn launch(
        &mut self,
        prepared: Prepared,
        prompt: String,
        images: Vec<PromptImage>,
        turn_id: Option<TurnId>,
        resume: Option<Resume>,
        paths: Option<(PathBuf, PathBuf)>,
    ) -> bool {
        let Prepared {
            resolved,
            accounts,
            place,
        } = prepared;
        let setup = match place {
            Place::Worker {
                home,
                data_dir,
                context,
                ..
            } => self.worker_setup(&home, &data_dir, &context, paths).await,
            Place::Coordinator { repo } => self.coordinator_setup(&repo).await,
        };
        let Setup {
            cwd,
            sandbox,
            temp,
            tools,
            thread_tools,
            thread,
        } = match setup {
            Ok(setup) => setup,
            Err(message) => {
                self.failed_to_start(message).await;
                return false;
            }
        };
        let account_id = resolved.account_id();
        let request = RunRequest {
            run_id: self.id,
            turn_id,
            cwd,
            prompt,
            images: images.clone(),
            policy: resolved.policy(),
            sandbox,
            account: AccountRef {
                id: account_id.clone(),
                credential: Credential::Subscription { config_home: None },
            },
            resume,
            model: self.row.fields.model.clone(),
            effort: self.row.fields.effort.as_deref().and_then(option_value),
            permission: self.row.fields.permission.as_deref().and_then(option_value),
            context_window: self.row.fields.context_window,
            fast: self.row.fields.fast,
            coordinator_tools: tools,
            thread_tools,
            approvals: self.row.fields.approvals,
            thread,
        };
        match routing::start(Arc::clone(&self.daemon.keys), &accounts, resolved, request) {
            Ok(started) => {
                self.live = Some(Live {
                    run: started.run,
                    events: started.events,
                    temp,
                });
                self.daemon.agents.running.fetch_add(1, Ordering::Relaxed);
                // The prompt's turn.
                self.in_flight = 1;
                self.held = false;
                convert::RUNNING.clone_into(&mut self.row.state.status);
                self.row.state.account_id = account_id;
                self.row.state.error = None;
                self.row.state.resume_at = None;
                self.save().await;
                self.keep_images(turn_id, images).await;
                true
            }
            Err(error) => {
                self.failed_to_start(error.to_string()).await;
                false
            }
        }
    }

    /// A thread's worktree, its own host-wide tools, bound to its run (0041), and a new temp
    /// folder for its CLI, with the worker sandbox Claude Code keeps for a thread without
    /// `approvals` (0013).
    async fn worker_setup(
        &self,
        home: &Path,
        data_dir: &Path,
        context: &Path,
        paths: Option<(PathBuf, PathBuf)>,
    ) -> Result<Setup, String> {
        let (cwd, git_common_dir) = match paths {
            Some(paths) => paths,
            None => self.worker_paths().await.map_err(|error| error.message)?,
        };
        let (temp, temp_path) = self.run_temp().map_err(|error| error.message)?;
        let mut sandbox =
            WorkerSandbox::for_worktree(home, data_dir, &cwd, &git_common_dir, context, &temp_path);
        // A thread, a Project's child or a plain one, reaches memory only through the tools, so
        // the shared context folder isn't an allowed directory for it, and stays as unreadable as
        // the rest of plxd's data folder in the sandbox (0044, PLX-468).
        sandbox.writable.clear();
        let thread_tools = ThreadTools {
            program: plxd_program()?,
            data_dir: self.daemon.data_dir.root().to_owned(),
            run: self.id,
        };
        Ok(Setup {
            cwd,
            sandbox: Some(sandbox),
            temp: Some(temp),
            tools: None,
            thread_tools: Some(thread_tools),
            thread: true,
        })
    }

    /// A coordinator runs in its detached worktree, moved to the integration branch's tip first,
    /// and cut with the branch if either is missing (0042, 0045), with a thread's Parallax tools
    /// bound to its own run (0041, PLX-380).
    async fn coordinator_setup(&mut self, repo: &Path) -> Result<Setup, String> {
        let branch = super::integration(&self.daemon, self.project)
            .await
            .map_err(|error| error.message)?
            .and_then(|row| row.integration_branch)
            .ok_or_else(|| "the coordinator's Project has no integration branch".to_owned())?;
        let cwd = self
            .daemon
            .agents
            .worktrees
            .refresh_coordinator(repo, self.project, &branch)
            .await
            .map_err(|error| format!("could not prepare the coordinator's worktree: {error}"))?;
        let tools = ThreadTools {
            program: plxd_program()?,
            data_dir: self.daemon.data_dir.root().to_owned(),
            run: self.id,
        };
        Ok(Setup {
            cwd,
            sandbox: None,
            temp: None,
            tools: Some(tools),
            thread_tools: None,
            thread: false,
        })
    }

    /// A new temp folder for the run's CLI (PLX-130), a resumed run's too, and its canonical
    /// path for the sandbox.
    fn run_temp(&self) -> Result<(RunTemp, PathBuf), ErrorObject> {
        let temp = run_temp::create(&self.daemon.data_dir).map_err(|error| {
            worker_unavailable(format!("could not make the run's temp folder: {error}"))
        })?;
        let path = sandbox_path(temp.path(), "the run's temp folder")?;
        Ok((temp, path))
    }

    /// For a thread in its repository's own checkout, the paths it starts in: `repo_path`'s.
    /// `None` for any other run, whose worktree [`Self::worker_paths`] finds.
    async fn checkout_paths(
        &self,
        repo_path: &str,
    ) -> Result<Option<(PathBuf, PathBuf)>, ErrorObject> {
        if !self.row.fields.checkout {
            return Ok(None);
        }
        super::checkout_paths(&self.daemon.agents, Path::new(repo_path))
            .await
            .map(Some)
    }

    async fn worker_paths(&self) -> Result<(PathBuf, PathBuf), ErrorObject> {
        let Some(worktree) = &self.worktree else {
            return Err(super::run_accepted(self.id));
        };
        let cwd = sandbox_path(Path::new(&worktree.path), "the run's worktree")?;
        let git_dir = self
            .daemon
            .agents
            .worktrees
            .git_common_dir(Path::new(&worktree.repo_path))
            .await
            .map_err(|error| ErrorObject::parallax(ErrorKind::WorktreeFailed, error.to_string()))?;
        let git_dir = sandbox_path(&git_dir, "the repository's git folder")?;
        Ok((cwd, git_dir))
    }

    async fn failed_to_start(&mut self, message: String) {
        self.ended_before_start(AgentOutcome::Failed {
            failure: AgentFailureKind::SpawnFailed,
            message,
        })
        .await;
    }

    /// Ends a run whose CLI never started with `outcome`: failed, or cancelled, as when its
    /// blocking setup script failed or the user stopped it (PLX-650).
    pub(super) async fn ended_before_start(&mut self, outcome: AgentOutcome) {
        let message = if let AgentOutcome::Failed { message, .. } = &outcome {
            Some(message.clone())
        } else {
            None
        };
        if let Some(message) = &message {
            warn!(run = %self.id, %message, "an agent run's CLI could not start");
        } else {
            info!(run = %self.id, "an agent run was stopped before its CLI started");
        }
        let status = if message.is_some() {
            convert::FAILED
        } else {
            convert::CANCELLED
        };
        let finished = ParallaxEvent::AgentFinished {
            run_id: self.id,
            outcome,
        };
        status.clone_into(&mut self.row.state.status);
        self.row.state.error.clone_from(&message);
        self.row.state.resume_at = None;
        self.save_with(vec![finished]).await;
        if let Some(message) = message
            && self.is_child().await
        {
            let text = failed_text(&self.row.fields.prompt, &message);
            self.inbox(InboxKind::Failed, text).await;
        }
    }

    /// Fills in a `TurnStarted` what only the actor knows: a follow-up's text, which `send`
    /// recorded before its CLI could report the turn, so a transcript rebuilt from the log shows
    /// it (PLX-92), capped like every other text item, the ids of any message's images (PLX-191),
    /// the threads attached to it (PLX-372), and who sent it. Leaves any other item alone.
    fn fill_turn_started(&mut self, item: &mut AgentOutputItem) {
        let AgentOutputItem::TurnStarted {
            turn_id,
            text,
            wake,
            from,
            images,
            threads,
        } = item
        else {
            return;
        };
        *images = self.images.remove(turn_id).unwrap_or_default();
        *threads = self.attached.remove(turn_id).unwrap_or_default();
        if let Some(turn_id) = turn_id {
            // A coordinator's wake-up or a usage limit's resume: plxd's own turn.
            *wake = self.wakes.was_sent(*turn_id) || self.resumes.was_sent(*turn_id);
            *from = self.senders.remove(turn_id);
            *text = self
                .turns
                .get(turn_id)
                .map(|sent| convert::truncate(sent, convert::MAX_TEXT_ITEM_BYTES));
        }
    }

    async fn on_event(&mut self, event: Option<Event>) {
        let Some(event) = event else {
            // An `EventStream` always ends with `Finished`, which clears `live` first.
            self.clear_live();
            return;
        };
        match &event {
            Event::SessionStarted { session_id, .. } => {
                if let Some(item) = output_item(&event) {
                    self.push(item).await;
                }
                self.row.state.session_id = Some(session_id.clone());
                self.save().await;
            }
            Event::AccountFallback {
                from_account,
                to_account,
                reason,
            } => {
                self.flush().await;
                self.append(ParallaxEvent::AgentAccountFallback {
                    run_id: self.id,
                    from_account: from_account.clone(),
                    to_account: to_account.clone(),
                    reason: convert::failure_kind(*reason),
                })
                .await;
                self.row.state.account_id.clone_from(to_account);
                // The first account's limits don't bind the account the run moved to.
                self.resumes.take_reset();
                self.save().await;
            }
            Event::Usage(_) | Event::RateLimit(_) => {
                if let Event::RateLimit(window) = &event {
                    self.resumes.saw(window);
                }
                self.record_usage(event.clone()).await;
                if let Some(item) = output_item(&event) {
                    self.push(item).await;
                }
            }
            Event::ApprovalRequested(request) => {
                let timeout = self.daemon.agents.approval_timeout();
                let offers_always = !request.always_allow.is_empty();
                let deadline = Instant::now() + timeout;
                self.approvals
                    .add(request.approval_id, deadline, offers_always, &request.input);
                let expires_at = jiff::SignedDuration::try_from(timeout)
                    .ok()
                    .and_then(|timeout| jiff::Timestamp::now().checked_add(timeout).ok())
                    .unwrap_or(jiff::Timestamp::MAX);
                self.push(convert::approval_requested(request, expires_at))
                    .await;
                self.inbox_approval(&request.tool_name).await;
            }
            Event::ApprovalWithdrawn { approval_id } => {
                let withdrawn = ended(AgentApprovalDecision::Withdrawn, AgentApprovalBy::Agent);
                self.resolve_approval(*approval_id, withdrawn).await;
            }
            Event::Finished { outcome, .. } => {
                let outcome = outcome.clone();
                self.record_usage(event).await;
                self.clear_live();
                // The CLI exited while they waited, so nothing can answer them now.
                for approval_id in self.approvals.pending() {
                    let gone = ended(AgentApprovalDecision::Withdrawn, AgentApprovalBy::Agent);
                    self.resolve_approval(approval_id, gone).await;
                }
                self.index_text().await;
                self.finish(&outcome).await;
            }
            _ => {
                if self.track_turns(&event).await {
                    return;
                }
                let created = self.created_prs(&event);
                if let Some(mut item) = output_item(&event) {
                    self.fill_turn_started(&mut item);
                    self.keep_tool_images(&event, &mut item).await;
                    self.push(item).await;
                }
                for url in created {
                    self.link_pr(url).await;
                }
                if matches!(event, Event::TurnFinished { .. }) {
                    self.index_text().await;
                }
            }
        }
    }

    /// Counts the live CLI's turns in flight, and puts a message it took but drops as it exits
    /// back first in the queue, for the next CLI (PLX-370). Returns whether that happened, so the
    /// message isn't logged dropped.
    async fn track_turns(&mut self, event: &Event) -> bool {
        if matches!(
            event,
            Event::TurnFinished { .. } | Event::FollowUpDropped { .. }
        ) {
            self.in_flight = self.in_flight.saturating_sub(1);
        }
        match event {
            Event::TurnStarted {
                turn_id: Some(turn_id),
            } => {
                self.handed.retain(|queued| queued.turn_id != *turn_id);
                // A held interrupt put it back in the queue, but the CLI started it first.
                if let Some(at) = self.queued.iter().position(|q| q.turn_id == *turn_id) {
                    self.queued.remove(at);
                    self.save_queue().await;
                }
            }
            Event::FollowUpDropped { turn_id } => {
                if let Some(at) = self.handed.iter().position(|q| q.turn_id == *turn_id) {
                    let queued = self.handed.remove(at);
                    self.queued.push_front(queued);
                    self.save_queue().await;
                    return true;
                }
                // A held interrupt put it back in the queue already.
                return self.queued.iter().any(|q| q.turn_id == *turn_id);
            }
            _ => {}
        }
        false
    }

    fn clear_live(&mut self) {
        self.in_flight = 0;
        self.held = false;
        self.handed.clear();
        if let Some(live) = self.live.take() {
            self.daemon.agents.running.fetch_sub(1, Ordering::Relaxed);
            // A worker's temp can hold a whole package store, so it goes off this task's thread.
            tokio::task::spawn_blocking(move || drop(live.temp));
        }
    }

    async fn record_usage(&self, event: Event) {
        let session = self.row.state.session_id.clone();
        if matches!(event, Event::Finished { .. }) && session.is_none() {
            return;
        }
        let (id, account) = (self.id, self.row.state.account_id.clone());
        let recorded = store(&self.daemon, move |db| {
            crate::usage::record_event(db, id, &account, session.as_deref().unwrap_or(""), &event)
                .map_err(|error| store_error(&error))
        })
        .await;
        if let Err(error) = recorded {
            warn!(run = %self.id, error = %error.message, "could not record an agent run's usage");
        }
    }

    /// Records how a CLI process ended. Unless plxd stopped it, commits a worker's changes first,
    /// through #166's hardened commit, and reports the commit. A Project's child then writes its
    /// history (0044). Last it wakes the run's parent unless
    /// it was launched with `notify: false` (PLX-380).
    async fn finish(&mut self, outcome: &Outcome) {
        self.flush().await;
        if self.stopping && matches!(outcome, Outcome::Cancelled) {
            info!(run = %self.id, "an agent run was interrupted because plxd is stopping");
            convert::INTERRUPTED.clone_into(&mut self.row.state.status);
            self.save_with(vec![ParallaxEvent::AgentFinished {
                run_id: self.id,
                outcome: AgentOutcome::Interrupted,
            }])
            .await;
            return;
        }
        let (mut outcome, mut status, mut error) = convert::outcome(outcome);
        // A coordinator's worktree and a thread's checkout are never committed.
        let committed = if self.is_coordinator() || self.row.fields.checkout {
            Ok(None)
        } else {
            self.commit(&commit_message(&self.last_message, self.id))
                .await
        };
        let diff = match committed {
            Ok(diff) => diff,
            Err(message) => {
                warn!(run = %self.id, %message, "could not commit an agent run's changes");
                if matches!(outcome, AgentOutcome::Completed { .. }) {
                    outcome = AgentOutcome::Failed {
                        failure: AgentFailureKind::CommitFailed,
                        message: message.clone(),
                    };
                }
                status = convert::FAILED;
                error = Some(message);
                None
            }
        };
        let events = vec![ParallaxEvent::AgentFinished {
            run_id: self.id,
            outcome: outcome.clone(),
        }];
        if let Some(diff) = diff {
            self.record_diff(diff);
        }
        status.clone_into(&mut self.row.state.status);
        self.row.state.error = error;
        self.after_limit(&outcome).await;
        info!(run = %self.id, status = %self.row.state.status, "an agent run's CLI finished");
        self.save_with(events).await;
        let Ok(run) = self.snapshot() else {
            return;
        };
        if self.is_child().await {
            if let Some((kind, text)) = ended_item(&run, &outcome) {
                self.inbox(kind, text).await;
            }
            crate::context::history::write(&self.daemon, self.project, &run, &outcome).await;
        }
        if let Some(parent) = self.row.fields.parent
            && self.row.fields.notify_parent
        {
            wake::notify(&self.daemon, parent, wake::summary(&run, &outcome));
        }
        // A child sent back from landing goes back in its Project's queue once a turn completes
        // (PLX-410).
        if self.worktree.is_some() && matches!(outcome, AgentOutcome::Completed { .. }) {
            crate::methods::land::turn_ended(&self.daemon, self.id);
        }
        // A child that ended may free a slot or an account for one waiting (0046).
        self.daemon.agents.placement.notify_one();
    }

    /// Records the run's new commit and its diff in its state. The caller's save reports it in
    /// `agent.updated`.
    fn record_diff(&mut self, diff: DiffSummary) {
        self.row.state.commit_sha = Some(diff.commit);
        self.row.state.files_changed = Some(diff.files);
        self.row.state.insertions = Some(diff.insertions);
        self.row.state.deletions = Some(diff.deletions);
    }

    /// Commits whatever the run changed in its worktree, on its branch, with `message`, and
    /// measures the branch against the worktree's base. `None` when there was nothing new to
    /// commit.
    async fn commit(&self, message: &str) -> Result<Option<DiffSummary>, String> {
        let Some(worktree) = &self.worktree else {
            return Err("the run was accepted, and its worktree is gone".to_owned());
        };
        if worktree.git_dir.is_empty() {
            return Err(
                "the run's worktree has no recorded git folder, so plxd can't commit it safely"
                    .to_owned(),
            );
        }
        let worktrees = &self.daemon.agents.worktrees;
        let path = Path::new(&worktree.path);
        let git_dir = Path::new(&worktree.git_dir);
        let commit = worktrees
            .commit_all(path, git_dir, Path::new(&worktree.repo_path), message)
            .await
            .map_err(|error| error.to_string())?;
        let Some(commit) = commit else {
            return Ok(None);
        };
        let stat = worktrees
            .diff_stat(path, git_dir, &worktree.base)
            .await
            .map_err(|error| error.to_string())?;
        Ok(Some(DiffSummary {
            commit: commit.sha,
            files: stat.files,
            insertions: stat.insertions,
            deletions: stat.deletions,
        }))
    }

    /// Adds `item` to the pending batch. A `TextDelta` right after one for the same message joins
    /// it, up to the text cap, so a streamed reply is one item per message per batch (PLX-449).
    /// The byte count still adds the whole item, which only flushes a merged batch a little early.
    async fn push(&mut self, item: AgentOutputItem) {
        self.batch.bytes += item_bytes(&item);
        match (&item, self.batch.items.last_mut()) {
            (
                AgentOutputItem::TextDelta { message_id, text },
                Some(AgentOutputItem::TextDelta {
                    message_id: last_id,
                    text: last,
                }),
            ) if last_id == message_id
                && last.len() + text.len() <= convert::MAX_TEXT_ITEM_BYTES =>
            {
                last.push_str(text);
            }
            _ => self.batch.items.push(item),
        }
        self.batch.since.get_or_insert_with(Instant::now);
        if self.batch.bytes >= MAX_BATCH_BYTES {
            self.flush().await;
        }
    }

    /// Sends the transcript items waiting to be sent, as one `agent.output` in a store job.
    async fn flush(&mut self) {
        if self.batch.items.is_empty() {
            self.batch = Batch::default();
            return;
        }
        // A batch that fails on its own is dropped (0052), so a store that keeps failing can't
        // grow it without bound.
        if let Err(error) = self.with_output(false, |_, _| Ok(())).await {
            warn!(run = %self.id, error = %error.message, "could not store a run's output; it was dropped");
        }
    }

    /// Runs `job` as one store job, after staging the transcript items waiting to be sent, so
    /// they, the rows `job` writes, and the events it stages commit together or not at all
    /// (0052). `job` gets the time to stage its events at. If the job fails, the items wait for
    /// the next write, so a failed row write doesn't lose the turn's output.
    async fn write<T: Send + 'static>(
        &mut self,
        job: impl FnOnce(&mut Tx, jiff::Timestamp) -> Result<T, ErrorObject> + Send + 'static,
    ) -> Result<T, ErrorObject> {
        self.with_output(true, job).await
    }

    /// [`Actor::write`], keeping the items for the next write on failure only when `keep`.
    async fn with_output<T: Send + 'static>(
        &mut self,
        keep: bool,
        job: impl FnOnce(&mut Tx, jiff::Timestamp) -> Result<T, ErrorObject> + Send + 'static,
    ) -> Result<T, ErrorObject> {
        let batch = std::mem::take(&mut self.batch);
        let kept = (keep && !batch.items.is_empty()).then(|| batch.items.clone());
        let items = batch.items;
        let (run_id, project, now) = (self.id, self.project, jiff::Timestamp::now());
        let written = store(&self.daemon, move |db| {
            if !items.is_empty() {
                db.stage(
                    now,
                    Some(project),
                    ParallaxEvent::AgentOutput {
                        run_id,
                        items,
                        compacted: None,
                    },
                );
            }
            job(db, now)
        })
        .await;
        if written.is_err()
            && let Some(items) = kept
        {
            self.batch = Batch {
                items,
                bytes: batch.bytes,
                since: batch.since,
            };
        }
        written
    }

    /// Stores `event` on the run's project, after any transcript items waiting to be sent.
    async fn append(&mut self, event: ParallaxEvent) {
        let project = self.project;
        let appended = self
            .write(move |db, now| {
                db.stage(now, Some(project), event);
                Ok(())
            })
            .await;
        if let Err(error) = appended {
            warn!(run = %self.id, error = %error.message, "could not store a run's event; it was dropped");
        }
    }

    /// Stores the run's state and reports it as `agent.updated`, in one job after any transcript
    /// items waiting to be sent.
    async fn save(&mut self) {
        self.save_with(Vec::new()).await;
    }

    /// [`Actor::save`], staging `events` before `agent.updated` in the same job, so an
    /// `agent.finished` commits with the state it reports: a crash can't
    /// leave the event without the row, and a restart then report the run interrupted after it.
    async fn save_with(&mut self, events: Vec<ParallaxEvent>) {
        let (id, state) = (self.row.id, self.row.state.clone());
        let (run_id, project) = (self.id, self.project);
        let saved = self
            .write(move |db, now| {
                let row = db
                    .update_run(id, &state)
                    .map_err(|error| store_error(&error))?;
                for event in events {
                    db.stage(now, Some(project), event);
                }
                let state = convert::run_state(&row);
                db.stage(
                    now,
                    Some(project),
                    ParallaxEvent::AgentUpdated { run_id, state },
                );
                Ok(row)
            })
            .await;
        match saved {
            Ok(row) => self.row = row,
            Err(error) => {
                warn!(run = %self.id, error = %error.message, "could not store an agent run's state");
            }
        }
    }
}

/// A fork's parent, as its first message continues it: see [`Actor::fork_source`].
struct ForkSource {
    backend: String,
    session_id: Option<String>,
}

fn id_conflict(turn_id: TurnId) -> ErrorObject {
    ErrorObject::parallax(
        ErrorKind::IdConflict,
        format!("turn {turn_id} was already sent with a different text"),
    )
}

/// The account a run's session belongs to, as routing takes it: a key account's id, or else a
/// backend's name for its subscription (0012).
pub(crate) fn session_account(account_id: &str) -> AccountChoice {
    match account_id.parse::<AccountId>() {
        Ok(id) => AccountChoice::Key { id },
        Err(_) => AccountChoice::Subscription {
            backend: account_id.to_owned(),
        },
    }
}

/// Every event run `run` logged, oldest first: what a handoff (0014) and a fork (0050) read.
/// Pages run inside one read transaction so a compact sweep cannot land between them (0052).
pub(crate) async fn logged_events(
    daemon: &Daemon,
    run: RunId,
) -> Result<Vec<HandoffEvent>, ErrorObject> {
    let log = Arc::clone(&daemon.log);
    tokio::task::spawn_blocking(move || {
        if let Some(events) = log.with_stored_read(|db| collect_run_events(db, run))? {
            return Ok(events);
        }
        let (page, _) = log.run_events(run, 0, usize::MAX, usize::MAX)?;
        Ok(page
            .iter()
            .map(|entry| HandoffEvent::from_entry(entry))
            .collect())
    })
    .await
    .map_err(ErrorObject::internal_error)?
    .map_err(|error| store_error(&error))
}

fn collect_run_events(
    db: &parallax_store::Store,
    run: RunId,
) -> Result<Vec<HandoffEvent>, parallax_store::StoreError> {
    let mut events = Vec::new();
    let mut after = 0;
    loop {
        let (page, more) = db.run_events(run.into(), after, 1000, 4 * 1024 * 1024)?;
        after = page.last().map_or(after, |entry| entry.seq);
        events.extend(page.iter().map(|stored| {
            let event = serde_json::from_str(&stored.payload).unwrap_or(ParallaxEvent::Unknown);
            let compacted_from = match &event {
                ParallaxEvent::AgentOutput {
                    compacted: Some(compacted),
                    ..
                } => Some(compacted.from),
                _ => None,
            };
            HandoffEvent {
                seq: stored.seq,
                event,
                compacted_from,
            }
        }));
        if !more || page.is_empty() {
            return Ok(events);
        }
    }
}

/// The message a new session on another backend gets in place of the user's `message`: that it
/// takes over from an agent on `from`, and what was said so far.
fn handoff_message(from: &str, conversation: &str, message: &str) -> String {
    format!(
        "This conversation began with another agent, on {from}, and the user has handed it to \
         you. Its work so far is in your working folder. Here is the conversation, oldest \
         first:\n\n<conversation>\n{conversation}\n</conversation>\n\nThe user's new message, \
         which is yours to answer:\n{message}",
        from = backend_name(from),
    )
}

/// The transcript's line where a new session took over the run from one on `from`.
fn handoff_notice(from: &str, to: &str) -> String {
    if from == to {
        "A new session picks up this conversation from what was said so far.".to_owned()
    } else {
        format!(
            "Moved from {} to {}: a new session picks up this conversation from what was said \
             so far.",
            backend_name(from),
            backend_name(to),
        )
    }
}

/// A backend's name for people.
pub(super) fn backend_name(backend: &str) -> &str {
    match backend {
        "claude" => "Claude Code",
        "codex" => "Codex",
        "cursor" => "Cursor",
        other => other,
    }
}

async fn next_event(live: &mut Option<Live>) -> Option<Event> {
    match live {
        Some(live) => live.events.next().await,
        None => std::future::pending().await,
    }
}

/// The run's push or Open PR, once it ends; never while there is none.
async fn effect_done(effect: &mut Option<JoinHandle<Finished>>) -> Result<Finished, JoinError> {
    match effect {
        Some(task) => task.await,
        None => std::future::pending().await,
    }
}

fn model_usage(total: SessionModelUsage) -> ModelUsage {
    ModelUsage {
        model: total.model,
        usage: Usage {
            input_tokens: total.input_tokens,
            output_tokens: total.output_tokens,
            cache_read_tokens: total.cache_read_tokens,
            cache_write_tokens: total.cache_write_tokens,
            cost_usd_micros: total.cost_usd_micros,
        },
    }
}

/// The merge commit's message, when accepting a run needs one: `Merge Parallax run: <the task's first
/// line>`, cut to 72 characters, then the run and its branch.
fn merge_message(prompt: &str, run: RunId, branch: &str) -> String {
    let first = prompt
        .lines()
        .find(|line| !line.trim().is_empty())
        .unwrap_or("agent run");
    let mut subject: String = format!("Merge Parallax run: {}", first.trim());
    if subject.chars().count() > 72 {
        subject = subject.chars().take(69).collect::<String>() + "...";
    }
    format!("{subject}\n\nAccepted in parallax: agent run {run}, branch {branch}.\n")
}

fn accept_error(error: &crate::worktree::AcceptError) -> ErrorObject {
    use crate::worktree::AcceptError;
    match error {
        AcceptError::Refused(message) => ErrorObject::parallax(ErrorKind::MergeRefused, message),
        AcceptError::Conflict { .. } => {
            ErrorObject::parallax(ErrorKind::MergeConflict, error.to_string())
        }
        AcceptError::Git(error) => {
            ErrorObject::parallax(ErrorKind::MergeRefused, error.to_string())
        }
    }
}

/// `parallax: <the message's first line>`, cut to 72 characters, then the run it belongs to.
fn commit_message(message: &str, run: RunId) -> String {
    let first = message
        .lines()
        .find(|line| !line.trim().is_empty())
        .unwrap_or("agent run");
    let mut subject: String = format!("parallax: {}", first.trim());
    if subject.chars().count() > 72 {
        subject = subject.chars().take(69).collect::<String>() + "...";
    }
    format!("{subject}\n\nCommitted by Parallax for agent run {run}.\n")
}

#[cfg(test)]
mod tests {
    use std::collections::HashMap;
    use std::sync::Arc;
    use std::time::Duration;

    use parallax_protocol::{
        AccountChoice, AccountId, AgentApprovalAnswer, AgentApprovalBy, AgentApprovalDecision,
        AgentApproveParams, AgentOutcome, AgentOutputItem, ApprovalId, ErrorKind, ParallaxEvent,
        ProjectId, RunId, TurnId,
    };
    use parallax_store::{Run as RunRow, RunFields, RunState, Worktree};
    use tokio::sync::{mpsc, oneshot};
    use tokio_util::sync::CancellationToken;

    use super::{
        Actor, Command, Delivery, Live, QueueOp, Queued, commit_message, handoff_message,
        handoff_notice, session_account,
    };
    use crate::agents::RunOptions;
    use crate::backend::{
        Answer, AnswerError, ApprovalRequest, Event, EventSink, FollowUp, Run, SendError,
    };
    use crate::server::Daemon;

    /// A message for [`Actor::send`].
    fn message(turn_id: TurnId, text: &str, options: RunOptions) -> Queued {
        Queued {
            turn_id,
            text: text.to_owned(),
            images: Vec::new(),
            threads: Vec::new(),
            options,
            account: None,
            from: None,
        }
    }

    #[test]
    fn a_session_resumes_on_the_account_it_ended_on() {
        let key = AccountId::generate();
        assert_eq!(
            session_account(&key.to_string()),
            AccountChoice::Key { id: key },
            "after a fallback, the key account"
        );
        assert_eq!(
            session_account("claude"),
            AccountChoice::Subscription {
                backend: "claude".to_owned()
            }
        );
    }

    #[test]
    fn commit_messages_are_one_short_subject_and_the_run() {
        let run = RunId::generate();
        let message = commit_message("\n  Add a README\nwith details", run);
        assert!(
            message.starts_with("parallax: Add a README\n\n"),
            "{message}"
        );
        assert!(message.contains(&run.to_string()));
        let long = commit_message(&"x".repeat(200), run);
        assert_eq!(long.lines().next().unwrap().chars().count(), 72);
        assert!(commit_message("", run).starts_with("parallax: agent run"));
    }

    struct NoopRun;

    impl Run for NoopRun {
        fn id(&self) -> RunId {
            RunId::generate()
        }

        fn send(&self, _: FollowUp) -> Result<(), SendError> {
            Err(SendError::Unsupported)
        }

        fn cancel(&self) {}
    }

    /// A run row and worktree that never touch the store: enough for a `Command::Cancel`, which
    /// only signals `live.run` and replies with a snapshot.
    fn fake_row_and_worktree() -> (RunRow, Worktree) {
        let now = jiff::Timestamp::now();
        let id = uuid::Uuid::from(RunId::generate());
        let row = RunRow {
            id,
            fields: RunFields {
                project_id: ProjectId::generate().into(),
                prompt: "flood".to_owned(),
                requested_account: None,
                policy: "workspaceWrite".to_owned(),
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
            },
            state: RunState {
                status: "running".to_owned(),
                account_id: "fake".to_owned(),
                ..RunState::default()
            },
            created_at: now,
            updated_at: now,
        };
        let worktree = Worktree {
            id,
            repo_path: "/tmp".to_owned(),
            path: "/tmp".to_owned(),
            branch: "parallax/run".to_owned(),
            base: "0".repeat(40),
            git_dir: String::new(),
            base_dirty: false,
            created_at: now,
        };
        (row, worktree)
    }

    /// #190 N6 / review item 5: `Actor::run`'s select order lets a queued `agent/cancel` through
    /// promptly even while the backend keeps producing output, instead of only once its stream
    /// goes quiet. Deterministic, on a `current_thread` runtime: the whole flood is buffered in
    /// the channel *before* the actor's loop ever runs, so the event branch of its `select!` is
    /// synchronously ready on every iteration without needing a producer task to keep pace with
    /// the consumer — nothing here depends on real concurrency or timing. `Command::Cancel` is
    /// likewise queued before the loop starts, so on its very first iteration both branches are
    /// ready and only the `select!`'s order decides which one runs. Under the old, event-first
    /// order this drains the whole flood — appending it as `agent.output` — before ever reaching
    /// the command; confirmed by temporarily restoring that order and observing this test fail on
    /// the `head()` assertion below, well past the timeout.
    #[tokio::test]
    async fn a_cancel_is_answered_promptly_while_output_floods_in() {
        const FLOOD: usize = 10_000;
        let dir = tempfile::tempdir().unwrap();
        let daemon = Daemon::for_tests(dir.path(), 100_000, Duration::from_secs(90));
        let (row, worktree) = fake_row_and_worktree();
        let mut actor = Actor::new(Arc::clone(&daemon), row, Some(worktree), HashMap::new());

        let (mut sink, events) = EventSink::channel(FLOOD, Vec::new());
        for _ in 0..FLOOD {
            sink.emit(Event::Text {
                message_id: None,
                text: "x".repeat(16),
            })
            .await
            .expect("the channel holds the whole flood");
        }
        actor.live = Some(Live {
            run: Arc::new(NoopRun),
            events,
            temp: Some(crate::backend::run_temp::create(&daemon.data_dir).unwrap()),
        });

        let (commands, receiver) = mpsc::channel(4);
        let (reply, answer) = oneshot::channel();
        commands
            .send(Command::Cancel { from: None, reply })
            .await
            .expect("the actor's command channel is open");

        let run_task = tokio::spawn(actor.run(receiver, CancellationToken::new()));

        tokio::time::timeout(Duration::from_secs(5), answer)
            .await
            .expect("a cancel command was never answered while output flooded in")
            .expect("the actor answered")
            .expect("cancelling a live run always succeeds");

        // Nothing but the one `Cancel` command has been processed: no event, and so nothing
        // appended to the log. The old order would have drained (and appended) some or all of
        // the 10,000-item flood by now.
        assert_eq!(
            daemon.log.head(),
            0,
            "the cancel was answered only after events were appended, not before"
        );

        drop(sink);
        drop(commands);
        run_task.abort();
    }

    /// The first attempt of a run whose account fell back (#119): its CLI exited, so it takes no
    /// more answers.
    struct ExitedRun;

    impl Run for ExitedRun {
        fn id(&self) -> RunId {
            RunId::generate()
        }

        fn send(&self, _: FollowUp) -> Result<(), SendError> {
            Err(SendError::Unsupported)
        }

        fn cancel(&self) {}

        fn answer(&self, _: Answer) -> Result<(), AnswerError> {
            Err(AnswerError::Finished)
        }
    }

    /// PLX-222: a request still pending when its attempt ended, answered while a fallback attempt
    /// runs in its place, is withdrawn at once. Waiting for the run's end would hold up the actor,
    /// and every command and expiry with it, for the fallback attempt's whole run.
    #[tokio::test]
    async fn an_answer_to_a_request_whose_attempt_ended_resolves_it_while_a_fallback_runs() {
        let dir = tempfile::tempdir().unwrap();
        let daemon = Daemon::for_tests(dir.path(), 100_000, Duration::from_secs(90));
        let (row, worktree) = fake_row_and_worktree();
        let mut actor = Actor::new(Arc::clone(&daemon), row, Some(worktree), HashMap::new());
        // The fallback attempt's events: open and quiet for as long as the test runs.
        let (_fallback, events) = EventSink::channel(4, Vec::new());
        actor.live = Some(Live {
            run: Arc::new(ExitedRun),
            events,
            temp: None,
        });
        let approval_id = ApprovalId::generate();
        let request = ApprovalRequest {
            approval_id,
            tool_name: "Bash".to_owned(),
            input: serde_json::json!({"command": "pnpm test"}),
            call_id: None,
            reason: None,
            blocked_path: None,
            subagent: None,
            always_allow: Vec::new(),
            interactive: false,
        };
        actor
            .on_event(Some(Event::ApprovalRequested(request)))
            .await;

        let allow = AgentApproveParams {
            run_id: actor.id,
            approval_id,
            decision: AgentApprovalAnswer::Allow,
            input: None,
            always: false,
            message: None,
        };
        let resolved = tokio::time::timeout(Duration::from_secs(5), actor.approve(allow))
            .await
            .expect("the answer waited for the fallback attempt to end")
            .unwrap();
        assert_eq!(resolved.decision, AgentApprovalDecision::Withdrawn);
        assert_eq!(resolved.by, AgentApprovalBy::Agent);
    }

    #[test]
    fn a_handoff_names_where_the_conversation_began() {
        let message = handoff_message("claude", "User:\nHi", "Carry on");
        assert!(
            message.contains("another agent, on Claude Code"),
            "{message}"
        );
        assert!(message.contains("<conversation>\nUser:\nHi\n</conversation>"));
        assert!(message.ends_with("The user's new message, which is yours to answer:\nCarry on"));
        assert_eq!(
            handoff_notice("claude", "codex"),
            "Moved from Claude Code to Codex: a new session picks up this conversation from what \
             was said so far."
        );
    }

    /// A message that changes the model can't reach a running CLI, so it waits, as does every
    /// message after it, a retry of it is the same message, and Stop drops them all.
    #[tokio::test]
    async fn messages_wait_for_a_running_cli_and_stop_drops_them() {
        let dir = tempfile::tempdir().unwrap();
        let daemon = Daemon::for_tests(dir.path(), 100_000, Duration::from_secs(90));
        let (row, worktree) = fake_row_and_worktree();
        let mut actor = Actor::new(Arc::clone(&daemon), row, Some(worktree), HashMap::new());
        let (_sink, events) = EventSink::channel(4, Vec::new());
        actor.live = Some(Live {
            run: Arc::new(NoopRun),
            events,
            temp: None,
        });

        let sonnet = RunOptions {
            model: Some("sonnet".to_owned()),
            ..RunOptions::default()
        };
        let (first, second) = (TurnId::generate(), TurnId::generate());
        let run = actor
            .send(message(first, "Hurry up", sonnet.clone()), Delivery::Queue)
            .await
            .unwrap();
        assert_eq!(run.model, None, "nothing changes until the CLI exits");
        actor
            .send(
                message(second, "And then", RunOptions::default()),
                Delivery::Queue,
            )
            .await
            .unwrap();
        actor
            .send(message(first, "Hurry up", sonnet.clone()), Delivery::Queue)
            .await
            .unwrap();
        let conflict = actor
            .send(message(first, "Other", sonnet), Delivery::Queue)
            .await
            .unwrap_err();
        assert_eq!(
            conflict.parallax_data().unwrap().kind,
            ErrorKind::IdConflict
        );
        let waiting: Vec<_> = actor.queued.iter().map(|queued| queued.turn_id).collect();
        assert_eq!(waiting, [first, second]);

        let (reply, answer) = oneshot::channel();
        actor
            .on_command(Command::Cancel { from: None, reply })
            .await;
        answer.await.unwrap().unwrap();
        assert!(actor.queued.is_empty());
        actor.flush().await;
        let (logged, _) = daemon.log.run_events(actor.id, 0, 100, usize::MAX).unwrap();
        let dropped: Vec<_> = logged
            .iter()
            .filter_map(|entry| match entry.event().into_owned() {
                ParallaxEvent::AgentOutput { items, .. } => Some(items),
                _ => None,
            })
            .flatten()
            .filter_map(|item| match item {
                AgentOutputItem::FollowUpDropped { turn_id } => Some(turn_id),
                _ => None,
            })
            .collect();
        assert_eq!(dropped, [first, second]);
    }

    /// A held interrupt (0059's Stop) keeps what waits instead of dropping it: the queue reports
    /// itself held, nothing is sent from it once the CLI has exited, and `queue.resume` lets it
    /// go on.
    #[tokio::test]
    async fn a_held_interrupt_keeps_the_queue_until_it_resumes() {
        let dir = tempfile::tempdir().unwrap();
        let daemon = Daemon::for_tests(dir.path(), 100_000, Duration::from_secs(90));
        let (row, worktree) = fake_row_and_worktree();
        let mut actor = Actor::new(Arc::clone(&daemon), row, Some(worktree), HashMap::new());
        let (_sink, events) = EventSink::channel(4, Vec::new());
        actor.live = Some(Live {
            run: Arc::new(NoopRun),
            events,
            temp: None,
        });
        let sonnet = RunOptions {
            model: Some("sonnet".to_owned()),
            ..RunOptions::default()
        };
        let (first, second) = (TurnId::generate(), TurnId::generate());
        actor
            .send(message(first, "Next", sonnet), Delivery::Queue)
            .await
            .unwrap();
        actor
            .send(
                message(second, "After", RunOptions::default()),
                Delivery::Queue,
            )
            .await
            .unwrap();

        let (reply, answer) = oneshot::channel();
        actor
            .on_command(Command::Interrupt {
                hold_queue: true,
                reply,
            })
            .await;
        answer.await.unwrap().unwrap();
        let waiting: Vec<_> = actor.queued.iter().map(|queued| queued.turn_id).collect();
        assert_eq!(waiting, [first, second], "a held Stop drops nothing");
        assert!(actor.queue_held);
        // The CLI has exited: a held queue still sends nothing.
        actor.live = None;
        actor.deliver().await;
        assert_eq!(actor.queued.len(), 2);

        let (logged, _) = daemon.log.run_events(actor.id, 0, 100, usize::MAX).unwrap();
        let last_held = |logged: &[Arc<crate::event_log::Entry>]| {
            logged
                .iter()
                .filter_map(|entry| match entry.event().into_owned() {
                    ParallaxEvent::QueueUpdated { held, .. } => Some(held),
                    _ => None,
                })
                .next_back()
        };
        assert_eq!(last_held(&logged), Some(true));

        let resumed = actor.queue_op(QueueOp::Resume, None).await.unwrap();
        assert!(!resumed.held);
        assert_eq!(resumed.messages.len(), 2);
        let (logged, _) = daemon.log.run_events(actor.id, 0, 100, usize::MAX).unwrap();
        assert_eq!(last_held(&logged), Some(false));
    }

    /// Codex-style deltas in one batch join while they follow one another for the same message,
    /// never across another item or message, so each message's text reads the same (PLX-449).
    #[tokio::test]
    async fn adjacent_text_deltas_of_a_message_join_in_a_batch() {
        let dir = tempfile::tempdir().unwrap();
        let daemon = Daemon::for_tests(dir.path(), 100_000, Duration::from_secs(90));
        let (row, worktree) = fake_row_and_worktree();
        let mut actor = Actor::new(Arc::clone(&daemon), row, Some(worktree), HashMap::new());
        let delta = |id: Option<&str>, text: &str| AgentOutputItem::TextDelta {
            message_id: id.map(str::to_owned),
            text: text.to_owned(),
        };
        let call = AgentOutputItem::ToolCall {
            call_id: "call_1".to_owned(),
            name: "command_execution".to_owned(),
            input: serde_json::json!({}),
        };
        for item in [
            delta(Some("msg_1"), "I’ll"),
            delta(Some("msg_1"), " look"),
            delta(Some("msg_1"), "."),
            delta(Some("msg_2"), "Found"),
            call.clone(),
            delta(Some("msg_2"), " it"),
            delta(None, "a"),
            delta(None, "b"),
        ] {
            actor.push(item).await;
        }
        actor.flush().await;

        let (logged, _) = daemon.log.run_events(actor.id, 0, 100, usize::MAX).unwrap();
        let batches: Vec<_> = logged
            .iter()
            .filter_map(|entry| match entry.event().into_owned() {
                ParallaxEvent::AgentOutput { items, .. } => Some(items),
                _ => None,
            })
            .collect();
        assert_eq!(
            batches,
            [vec![
                delta(Some("msg_1"), "I’ll look."),
                delta(Some("msg_2"), "Found"),
                call,
                delta(Some("msg_2"), " it"),
                delta(None, "ab"),
            ]]
        );
    }

    /// The kinds of `run`'s logged events, in order.
    fn logged_kinds(daemon: &Daemon, run: RunId) -> Vec<String> {
        let (logged, _) = daemon.log.run_events(run, 0, 100, usize::MAX).unwrap();
        logged.iter().map(|entry| entry.kind().to_owned()).collect()
    }

    /// A row write that fails keeps the turn's pending output for the next write, rather than
    /// dropping it with the rolled-back job (0052).
    #[tokio::test]
    async fn a_failed_save_keeps_the_pending_output_for_the_next_write() {
        let dir = tempfile::tempdir().unwrap();
        let daemon = Daemon::for_tests(dir.path(), 100, Duration::from_secs(90));
        // Not in the store, so saving it fails.
        let (row, worktree) = fake_row_and_worktree();
        let mut actor = Actor::new(Arc::clone(&daemon), row, Some(worktree), HashMap::new());
        let text = AgentOutputItem::Text {
            message_id: None,
            text: "Reading the code.".to_owned(),
        };
        actor.push(text.clone()).await;

        actor.save().await;
        assert!(logged_kinds(&daemon, actor.id).is_empty());
        actor.flush().await;

        let (logged, _) = daemon.log.run_events(actor.id, 0, 100, usize::MAX).unwrap();
        let events: Vec<_> = logged
            .iter()
            .map(|entry| entry.event().into_owned())
            .collect();
        assert_eq!(
            events,
            [ParallaxEvent::AgentOutput {
                run_id: actor.id,
                items: vec![text],
                compacted: None,
            }]
        );
    }

    /// `agent.finished` commits with the state it reports, in `save`'s job: a save that fails
    /// publishes neither it nor `agent.updated`, and one that commits publishes it before
    /// `agent.updated`, so a restart can't find the run running after its finish.
    #[tokio::test]
    async fn a_finish_commits_with_the_runs_state_or_not_at_all() {
        let dir = tempfile::tempdir().unwrap();
        let daemon = Daemon::for_tests(dir.path(), 100, Duration::from_secs(90));
        let (row, worktree) = fake_row_and_worktree();
        let finished = ParallaxEvent::AgentFinished {
            run_id: RunId::try_from(row.id).unwrap(),
            outcome: AgentOutcome::Interrupted,
        };
        let mut actor = Actor::new(
            Arc::clone(&daemon),
            row.clone(),
            Some(worktree),
            HashMap::new(),
        );
        actor.row.state.status = "interrupted".to_owned();
        actor.save_with(vec![finished.clone()]).await;
        assert!(
            logged_kinds(&daemon, actor.id).is_empty(),
            "no finish without its row"
        );

        crate::agents::store(&daemon, move |db| {
            let project = parallax_store::ProjectFields {
                name: "app".to_owned(),
                repo_path: "/src/app".to_owned(),
                icon: None,
                permission: "auto".to_owned(),
                autonomy: "routine".to_owned(),
                base_branch: None,
            };
            db.create_project(row.fields.project_id, &project).unwrap();
            db.create_run(row.id, &row.fields, &row.state).unwrap();
            Ok(())
        })
        .await
        .unwrap();
        actor.save_with(vec![finished]).await;
        assert_eq!(
            logged_kinds(&daemon, actor.id),
            ["agent.finished", "agent.updated"]
        );
        let id = actor.row.id;
        let status = crate::agents::store(&daemon, move |db| {
            Ok(db.get_run(id).unwrap().unwrap().state.status)
        })
        .await
        .unwrap();
        assert_eq!(status, "interrupted");
    }

    /// A backend that takes no messages while it runs gets one once its CLI exits, rather than
    /// refusing it.
    #[tokio::test]
    async fn a_message_a_running_cli_cant_take_waits_for_it() {
        let dir = tempfile::tempdir().unwrap();
        let daemon = Daemon::for_tests(dir.path(), 100_000, Duration::from_secs(90));
        let (row, worktree) = fake_row_and_worktree();
        let mut actor = Actor::new(Arc::clone(&daemon), row, Some(worktree), HashMap::new());
        let (_sink, events) = EventSink::channel(4, Vec::new());
        actor.live = Some(Live {
            run: Arc::new(NoopRun),
            events,
            temp: None,
        });
        let turn = TurnId::generate();
        actor
            .send(
                message(turn, "Also this", RunOptions::default()),
                Delivery::Queue,
            )
            .await
            .unwrap();
        assert_eq!(
            actor.queued.front().map(|queued| queued.turn_id),
            Some(turn)
        );
    }
}
