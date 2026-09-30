//! One run's actor: the task that owns a run for as long as wispd runs.
//!
//! It takes commands (`agent/send`, `agent/cancel`, `agent/accept`, `agent/openPr`,
//! `thread/delete`) and the run's backend events in one loop, so nothing about a run needs a lock,
//! and events are logged in the order they happened.
//!
//! A project's coordinator (0024) differs in four places: it starts in a detached worktree of
//! the project's repository (RYA-171) with wispd's tools and no sandbox, that worktree is checked
//! after every turn (0004), it is never committed, and runs it started wake it when they finish
//! (RYA-42, [`super::wake`]).

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::Ordering;
use std::time::Duration;

use tokio::sync::{mpsc, oneshot};
use tokio::time::{Instant, sleep_until};
use tokio_util::sync::CancellationToken;
use tracing::{info, warn};
use uuid::Uuid;
use wisp_protocol::jsonrpc::ErrorObject;
use wisp_protocol::{AcceptId, AgentMerge};
use wisp_protocol::{
    AccountChoice, AccountId, AgentFailureKind, AgentOutcome, AgentOutputItem, AgentRun,
    CoordinatorThreadId, DiffSummary, ErrorKind, ImageId, ProjectId, PromptImage, Role, RunId,
    TurnId, WispEvent,
};
use wisp_store::{Run as RunRow, RunAccept, SessionModelUsage, StoredImage, Worktree};

use super::convert::{self, agent_run, item_bytes, option_name, option_value, output_item};
use super::wake::{self, Wakes};
use super::worker::{sandbox_path, worker_unavailable};
use super::{Place, Prepared, RunOptions, prepare, store, store_error};
use crate::backend::{
    AccountRef, CoordinatorTools, Credential, Event, EventStream, FollowUp, ModelUsage, Outcome,
    Resume, Run, RunRequest, SendError, Usage, WorkerSandbox,
    run_temp::{self, RunTemp},
};
use crate::routing;
use crate::server::Daemon;
use crate::worktree::PrError;

/// How long transcript items wait to be sent together as one `agent.output` (0007).
const COALESCE: Duration = Duration::from_millis(50);

/// An `agent.output` is sent early once its items reach about this many bytes.
const MAX_BATCH_BYTES: usize = 256 * 1024;

/// What an actor is asked to do.
pub(super) enum Command {
    /// `agent/send`.
    Send {
        turn_id: TurnId,
        text: String,
        /// The message's images, already checked (RYA-191).
        images: Vec<PromptImage>,
        /// A new model, effort, or permission for the run (RYA-161, RYA-163).
        options: RunOptions,
        reply: oneshot::Sender<Result<AgentRun, ErrorObject>>,
    },
    /// `agent/cancel`.
    Cancel {
        reply: oneshot::Sender<Result<AgentRun, ErrorObject>>,
    },
    /// `agent/accept`.
    Accept {
        id: AcceptId,
        reviewed: Option<String>,
        reply: oneshot::Sender<Result<(AgentRun, AgentMerge), ErrorObject>>,
    },
    /// `agent/openPr` (RYA-168).
    OpenPr {
        title: String,
        body: String,
        reply: oneshot::Sender<Result<String, ErrorObject>>,
    },
    /// `thread/delete` (#110): stops the run's CLI, waits for it to exit, and deletes the thread.
    Delete {
        reply: oneshot::Sender<Result<(), ErrorObject>>,
    },
    /// A run this coordinator started finished, as [`wake::summary`] tells it (RYA-42).
    Wake(String),
}

impl Command {
    /// Answers the command with `error` without running it.
    fn refuse(self, error: ErrorObject) {
        match self {
            Self::Send { reply, .. } | Self::Cancel { reply } => {
                let _ = reply.send(Err(error));
            }
            Self::Accept { reply, .. } => {
                let _ = reply.send(Err(error));
            }
            Self::OpenPr { reply, .. } => {
                let _ = reply.send(Err(error));
            }
            Self::Delete { reply } => {
                let _ = reply.send(Err(error));
            }
            Self::Wake(_) => {}
        }
    }
}

struct Live {
    run: Arc<dyn Run>,
    events: EventStream,
    /// A worker's temp folder (RYA-130), removed once the CLI has exited: `events` ends only
    /// then.
    temp: Option<RunTemp>,
}

/// What a run's CLI starts with besides its account and prompt, from [`Actor::launch`].
struct Setup {
    cwd: PathBuf,
    sandbox: Option<WorkerSandbox>,
    temp: Option<RunTemp>,
    tools: Option<CoordinatorTools>,
}

#[derive(Default)]
struct Batch {
    items: Vec<AgentOutputItem>,
    bytes: usize,
    since: Option<Instant>,
}

pub(super) struct Actor {
    daemon: Arc<Daemon>,
    id: RunId,
    project: ProjectId,
    row: RunRow,
    /// The run's worktree, until `agent/accept` removes it.
    worktree: Option<Worktree>,
    live: Option<Live>,
    batch: Batch,
    /// Messages sent to the run, by turn id, reloaded from the store after a restart. They make
    /// `agent/send` idempotent across CLI processes and fill in the logged `TurnStarted.text`.
    turns: HashMap<TurnId, String>,
    /// The stored images of messages a CLI took, by turn id (`None` for the prompt's), until
    /// their `TurnStarted` lists them (RYA-191, decision 0026).
    images: HashMap<Option<TurnId>, Vec<ImageId>>,
    /// The latest prompt or message, for the commit message.
    last_message: String,
    stopping: bool,
    /// Set once `thread/delete` removed the run: the actor stops, refusing what is still queued.
    deleted: bool,
    /// A coordinator's wake-ups (RYA-42).
    wakes: Wakes,
}

impl Actor {
    /// `turns` is what a run already sent, from the store (#190): empty for a run just created by
    /// `agents::start`, and loaded by `actor_for` for a run whose actor is spawned fresh, so a
    /// restarted wispd still recognizes a retried `agent/send`.
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
            batch: Batch::default(),
            turns,
            images: HashMap::new(),
            last_message,
            stopping: false,
            deleted: false,
            wakes: Wakes::default(),
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

    pub async fn run(mut self, mut commands: mpsc::Receiver<Command>, shutdown: CancellationToken) {
        if self.is_coordinator() {
            self.load_wakes().await;
        }
        loop {
            let deadline = self.batch.since.map(|since| since + COALESCE);
            // A coordinator's turn in progress gets its wake-ups next, once its CLI has exited.
            let wake_at = self.wakes.due().filter(|_| self.live.is_none());
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
                () = shutdown.cancelled(), if !self.stopping => {
                    self.stopping = true;
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
                event = next_event(&mut self.live) => self.on_event(event).await,
            }
            if self.stopping && self.live.is_none() {
                self.flush().await;
                break;
            }
        }
        if self.deleted {
            commands.close();
            while let Ok(command) = commands.try_recv() {
                command.refuse(super::run_not_found(self.id));
            }
        }
    }

    async fn on_command(&mut self, command: Command) {
        match command {
            Command::Send {
                turn_id,
                text,
                images,
                options,
                reply,
            } => {
                let answer = self.send(turn_id, text, images, options).await;
                if answer.is_ok() && self.wakes.attended() {
                    self.save_wakes().await;
                }
                let _ = reply.send(answer);
            }
            Command::Cancel { reply } => {
                if let Some(live) = &self.live {
                    info!(run = %self.id, "cancelling an agent run");
                    live.run.cancel();
                }
                // Stop means stop: a run finishing a moment later doesn't start the coordinator
                // again before the user writes.
                if self.is_coordinator() {
                    self.pause_wakes().await;
                }
                let _ = reply.send(self.snapshot());
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
                let answer = self.open_pr(&title, &body).await;
                let _ = reply.send(answer);
            }
            Command::Delete { reply } => {
                let answer = self.delete().await;
                if answer.is_ok() {
                    self.deleted = true;
                    self.stopping = true;
                }
                let _ = reply.send(answer);
            }
            Command::Wake(summary) => {
                if self.is_coordinator() {
                    self.wakes.push(summary, Instant::now());
                }
            }
        }
    }

    /// Sends what is waiting as the coordinator's next turn, through the same resume as
    /// `agent/send` (RYA-42). Pauses wake-ups at the cap, or when this fails, keeping what is
    /// waiting. Only the project's current coordinator wakes: a replaced one drops them, so a
    /// project never has two live (0024).
    async fn wake(&mut self) {
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
                self.pause_wakes().await;
                return;
            }
        }
        let Some((turn_id, text)) = self.wakes.next() else {
            self.pause_wakes().await;
            return;
        };
        info!(run = %self.id, "waking a coordinator: runs it started finished");
        match self
            .resume(turn_id, text, Vec::new(), RunOptions::default())
            .await
        {
            Ok(_) if self.live.is_some() => {
                self.wakes.delivered();
                self.save_wakes().await;
            }
            Ok(_) => self.pause_wakes().await,
            Err(error) => {
                warn!(run = %self.id, error = %error.message, "could not wake a coordinator");
                self.pause_wakes().await;
            }
        }
    }

    /// Stops waking the coordinator until the user writes, and says so once (RYA-42).
    async fn pause_wakes(&mut self) {
        if self.wakes.pause() {
            info!(run = %self.id, "pausing a coordinator's wake-ups until the user writes");
            self.save_wakes().await;
            self.append(WispEvent::AgentWakeupsPaused { run_id: self.id })
                .await;
        }
    }

    /// Takes up the coordinator's wake-up count and pause where the last wispd left them
    /// (RYA-178). If they can't be read, pauses wake-ups, as a failed check does.
    async fn load_wakes(&mut self) {
        let id = self.row.id;
        let stored = store(&self.daemon, move |db| {
            db.wake_state(id).map_err(|error| store_error(&error))
        })
        .await;
        match stored {
            Ok(state) => self.wakes.restore(state),
            Err(error) => {
                warn!(run = %self.id, error = %error.message, "could not read a coordinator's wake-ups");
                self.pause_wakes().await;
            }
        }
    }

    /// Stores the coordinator's wake-up count and pause, so a restart keeps them (RYA-178).
    async fn save_wakes(&self) {
        let (id, state) = (self.row.id, self.wakes.state());
        let saved = store(&self.daemon, move |db| {
            db.set_wake_state(id, state)
                .map_err(|error| store_error(&error))
        })
        .await;
        if let Err(error) = saved {
            warn!(run = %self.id, error = %error.message, "could not store a coordinator's wake-ups");
        }
    }

    /// `thread/delete`: cancels a running CLI and waits for it to exit and its changes to be
    /// committed, then deletes the thread's rows, events, worktree, and scratch folders, and
    /// drops this actor from the map. Running here, between commands, it never races a resume
    /// or an accept.
    async fn delete(&mut self) -> Result<(), ErrorObject> {
        if let Some(live) = &self.live {
            info!(run = %self.id, "cancelling an agent run to delete its thread");
            live.run.cancel();
            while self.live.is_some() {
                let event = next_event(&mut self.live).await;
                self.on_event(event).await;
            }
        }
        self.flush().await;
        // Holds off a concurrent create/actor_for retry for this exact run id while its rows are
        // deleted and this actor is dropped (#110); an unrelated run's own lock is untouched.
        let _creating = self.daemon.agents.start_guard(self.id).await;
        crate::threads::purge(&self.daemon, self.id, self.worktree.clone()).await?;
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
        let refused = |why: String| ErrorObject::wisp(ErrorKind::MergeRefused, why);
        if self.live.is_some() {
            return Err(refused(format!(
                "run {} is still running; wait for it to finish, or cancel it, then accept",
                self.id
            )));
        }
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
        self.row.state.accept = Some(accept.clone());
        let (row_id, state) = (self.row.id, self.row.state.clone());
        let saved = store(&self.daemon, move |db| {
            db.accept_run(row_id, &state)
                .map_err(|error| store_error(&error))
        })
        .await;
        match saved {
            Ok(row) => self.row = row,
            Err(error) => {
                warn!(run = %self.id, error = %error.message, "could not store an accepted run");
            }
        }
        self.worktree = None;
        let merge = convert::merge(&accept);
        self.flush().await;
        self.append(WispEvent::AgentAccepted {
            run_id: self.id,
            merge: merge.clone(),
        })
        .await;
        self.append(WispEvent::AgentUpdated {
            run_id: self.id,
            state: convert::run_state(&self.row),
        })
        .await;
        Ok((self.snapshot()?, merge))
    }

    /// `agent/openPr`: pushes the run's branch to its repository's `origin` and returns the URL
    /// of its pull request, opening one if none is open (RYA-168). Running here, between commands,
    /// it never races a turn or its commit.
    async fn open_pr(&self, title: &str, body: &str) -> Result<String, ErrorObject> {
        if self.accepted() {
            return Err(super::run_accepted(self.id));
        }
        let refused = |why: String| ErrorObject::wisp(ErrorKind::PrRefused, why);
        if self.live.is_some() {
            return Err(refused(format!(
                "run {} is still running; open a pull request once it has finished",
                self.id
            )));
        }
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
        let url = self
            .daemon
            .agents
            .worktrees
            .open_pr(
                Path::new(&worktree.repo_path),
                &worktree.branch,
                title,
                body,
            )
            .await
            .map_err(|error| {
                let kind = match &error {
                    PrError::Push(_) => ErrorKind::PushFailed,
                    PrError::GhUnavailable(_) => ErrorKind::GhUnavailable,
                    PrError::Gh(_) => ErrorKind::PrFailed,
                };
                ErrorObject::wisp(kind, error.to_string())
            })?;
        info!(run = %self.id, %url, "opened a pull request for an agent run");
        Ok(url)
    }

    async fn send(
        &mut self,
        turn_id: TurnId,
        text: String,
        images: Vec<PromptImage>,
        options: RunOptions,
    ) -> Result<AgentRun, ErrorObject> {
        if text.trim().is_empty() && images.is_empty() {
            return Err(ErrorObject::invalid_params("text must not be empty"));
        }
        if self.accepted() {
            return Err(super::run_accepted(self.id));
        }
        if let Some(sent) = self.turns.get(&turn_id) {
            return if *sent == text {
                self.snapshot()
            } else {
                Err(ErrorObject::wisp(
                    ErrorKind::IdConflict,
                    format!("turn {turn_id} was already sent with a different text"),
                ))
            };
        }
        // Only a model, effort, or permission that differs from the run's changes anything.
        let fields = &self.row.fields;
        let changes = RunOptions {
            model: options.model.filter(|m| Some(m) != fields.model.as_ref()),
            effort: options.effort.filter(|&e| option_name(e) != fields.effort),
            permission: options
                .permission
                .filter(|&p| option_name(p) != fields.permission),
        };
        let changing = changes != RunOptions::default();
        if changing && self.live.is_some() {
            return Err(ErrorObject::wisp(
                ErrorKind::UnsupportedOption,
                "the model, effort, and access can't change while the run is working; send the \
                 message again once it has finished",
            ));
        }
        if let Some(live) = &self.live {
            let follow_up = FollowUp {
                turn_id,
                text: text.clone(),
                images: images.clone(),
            };
            match live.run.send(follow_up) {
                Ok(()) => {
                    self.record_turn(turn_id, text.clone()).await;
                    self.keep_images(Some(turn_id), images).await;
                    self.last_message = text;
                    return self.snapshot();
                }
                Err(SendError::IdConflict) => {
                    return Err(ErrorObject::wisp(
                        ErrorKind::IdConflict,
                        format!("turn {turn_id} was already sent with a different text"),
                    ));
                }
                Err(SendError::Unsupported) => {
                    return Err(ErrorObject::wisp(
                        ErrorKind::RunNotResumable,
                        "this run's backend takes no messages while it runs; send it again \
                         once the run has finished",
                    ));
                }
                // The CLI is exiting: let the run finish, then resume it with the message.
                Err(SendError::Finished) => {
                    while self.live.is_some() {
                        let event = next_event(&mut self.live).await;
                        self.on_event(event).await;
                    }
                }
            }
        }
        self.resume(turn_id, text, images, changes).await
    }

    /// Starts a new CLI process for the run, resuming its vendor session with `text` and
    /// `images`, after storing `changes` to its model, effort, and permission, which the new
    /// process runs with.
    async fn resume(
        &mut self,
        turn_id: TurnId,
        text: String,
        images: Vec<PromptImage>,
        changes: RunOptions,
    ) -> Result<AgentRun, ErrorObject> {
        let Some(session_id) = self.row.state.session_id.clone() else {
            return Err(ErrorObject::wisp(
                ErrorKind::RunNotResumable,
                format!(
                    "run {} ended before its CLI reported a session, so it can't be resumed",
                    self.id
                ),
            ));
        };
        // The session belongs to the account the run was on when it ended, after any fallback,
        // not to whatever the worker role's default is now.
        let account = session_account(&self.row.state.account_id);
        let not_resumable = |why: String| {
            ErrorObject::wisp(
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
        let (prepared, _) =
            match prepare(&self.daemon, self.project, self.id, Some(account), role).await {
                Ok(prepared) => prepared,
                Err(error)
                    if error
                        .wisp_data()
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
        if backend != self.row.fields.backend {
            return Err(not_resumable(format!(
                "its session ran on {}, but its account now runs on {backend}",
                self.row.fields.backend
            )));
        }
        if changes != RunOptions::default() {
            changes.check(prepared.resolved.backend())?;
            let (id, fields) = (self.row.id, &self.row.fields);
            let model = changes.model.clone().or(fields.model.clone());
            let effort = changes
                .effort
                .and_then(option_name)
                .or(fields.effort.clone());
            let permission = changes
                .permission
                .and_then(option_name)
                .or(fields.permission.clone());
            let row = store(&self.daemon, move |db| {
                db.set_run_options(
                    id,
                    model.as_deref(),
                    effort.as_deref(),
                    permission.as_deref(),
                )
                .map_err(|error| store_error(&error))
            })
            .await?;
            self.row.fields = row.fields;
        }
        let session = session_id.clone();
        let totals = store(&self.daemon, move |db| {
            db.session_usage_totals(&session)
                .map_err(|error| store_error(&error))
        })
        .await?;
        let resume = Resume {
            session_id,
            usage_totals: totals.into_iter().map(model_usage).collect(),
        };
        info!(run = %self.id, "resuming an agent run's session");
        let message = text.clone();
        if self
            .launch(prepared, text, images, Some(turn_id), Some(resume), None)
            .await
        {
            // Only a turn that reached a CLI counts as sent: a retry after a failed start
            // tries again.
            self.record_turn(turn_id, message.clone()).await;
            self.last_message = message;
        }
        self.snapshot()
    }

    /// Records that `turn_id` was sent with `text`, in memory and in the store, so a retry of
    /// `agent/send` stays idempotent across a wispd restart, not only across a resumed CLI
    /// process within the same wispd (#190).
    /// Runs after the CLI has already accepted the turn (`live.run.send`'s `Ok`, or a successful
    /// `launch` in `resume`), so a crash between the two makes a retried `agent/send` after a
    /// restart send the message again: at-least-once, not exactly-once (#190 review non-blocking
    /// note). That's the same failure mode #190 was fixing in the other direction (a restart
    /// forgetting a turn was ever sent), and strictly better: a duplicate is visible in the
    /// transcript, a lost retry silently drops the user's message.
    async fn record_turn(&mut self, turn_id: TurnId, text: String) {
        self.turns.insert(turn_id, text.clone());
        let (run_id, id) = (self.row.id, self.id);
        let stored = store(&self.daemon, move |db| {
            db.record_turn(run_id, turn_id.into(), &text)
                .map_err(|error| store_error(&error))
        })
        .await;
        if let Err(error) = stored {
            warn!(run = %id, error = %error.message, "could not store a sent turn");
        }
    }

    /// Stores the images of `turn_id`'s message, which its CLI has now taken, for its
    /// `TurnStarted` to list (RYA-191, decision 0026). If they can't be stored, the CLI still has
    /// them, and the transcript shows the message without them.
    async fn keep_images(&mut self, turn_id: Option<TurnId>, images: Vec<PromptImage>) {
        if images.is_empty() {
            return;
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
            Ok(()) => {
                self.images.insert(turn_id, ids);
            }
            Err(error) => {
                warn!(run = %self.id, error = %error.message, "could not store a message's images");
            }
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
            } => self.worker_setup(&home, &data_dir, &context, paths).await,
            Place::Coordinator { repo } => self.coordinator_setup(repo),
        };
        let Setup {
            cwd,
            sandbox,
            temp,
            tools,
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
            coordinator_tools: tools,
        };
        match routing::start(Arc::clone(&self.daemon.keys), &accounts, resolved, request) {
            Ok(started) => {
                self.live = Some(Live {
                    run: started.run,
                    events: started.events,
                    temp,
                });
                self.daemon.agents.running.fetch_add(1, Ordering::Relaxed);
                convert::RUNNING.clone_into(&mut self.row.state.status);
                self.row.state.account_id = account_id;
                self.row.state.error = None;
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

    /// A worker's worktree and sandbox, with a new temp folder for its CLI.
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
        let sandbox =
            WorkerSandbox::for_worktree(home, data_dir, &cwd, &git_common_dir, context, &temp_path);
        Ok(Setup {
            cwd,
            sandbox: Some(sandbox),
            temp: Some(temp),
            tools: None,
        })
    }

    /// A coordinator runs in the project's repository (0027), with its wisp tools, bound to its
    /// project and to its own thread (0019).
    fn coordinator_setup(&mut self, repo: PathBuf) -> Result<Setup, String> {
        let program = std::env::current_exe()
            .map_err(|error| format!("could not find wispd's own executable: {error}"))?;
        let thread = self
            .row
            .fields
            .coordinator_thread
            .and_then(|id| CoordinatorThreadId::try_from(id).ok())
            .ok_or_else(|| format!("coordinator run {} has no thread id", self.id))?;
        let tools = CoordinatorTools {
            program,
            data_dir: self.daemon.data_dir.root().to_owned(),
            project: self.project,
            thread,
        };
        Ok(Setup {
            cwd: repo,
            sandbox: None,
            temp: None,
            tools: Some(tools),
        })
    }

    /// A new temp folder for the run's CLI (RYA-130), a resumed run's too, and its canonical
    /// path for the sandbox.
    fn run_temp(&self) -> Result<(RunTemp, PathBuf), ErrorObject> {
        let temp = run_temp::create(&self.daemon.data_dir).map_err(|error| {
            worker_unavailable(format!("could not make the run's temp folder: {error}"))
        })?;
        let path = sandbox_path(temp.path(), "the run's temp folder")?;
        Ok((temp, path))
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
            .map_err(|error| ErrorObject::wisp(ErrorKind::WorktreeFailed, error.to_string()))?;
        let git_dir = sandbox_path(&git_dir, "the repository's git folder")?;
        Ok((cwd, git_dir))
    }

    async fn failed_to_start(&mut self, message: String) {
        warn!(run = %self.id, %message, "an agent run's CLI could not start");
        self.append(WispEvent::AgentFinished {
            run_id: self.id,
            outcome: AgentOutcome::Failed {
                failure: AgentFailureKind::SpawnFailed,
                message: message.clone(),
            },
        })
        .await;
        convert::FAILED.clone_into(&mut self.row.state.status);
        self.row.state.error = Some(message);
        self.save().await;
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
                self.append(WispEvent::AgentAccountFallback {
                    run_id: self.id,
                    from_account: from_account.clone(),
                    to_account: to_account.clone(),
                    reason: convert::failure_kind(*reason),
                })
                .await;
                self.row.state.account_id.clone_from(to_account);
                self.save().await;
            }
            Event::Usage(_) | Event::RateLimit(_) => {
                self.record_usage(event.clone()).await;
                if let Some(item) = output_item(&event) {
                    self.push(item).await;
                }
            }
            Event::Finished { outcome, .. } => {
                let outcome = outcome.clone();
                self.record_usage(event).await;
                self.clear_live();
                self.finish(&outcome).await;
            }
            _ => {
                if let Some(mut item) = output_item(&event) {
                    // A follow-up's text, which `send` recorded before its CLI could report the
                    // turn, so a transcript rebuilt from the log shows it (RYA-92), capped like
                    // every other text item, and the ids of any message's images (RYA-191).
                    if let AgentOutputItem::TurnStarted {
                        turn_id,
                        text,
                        wake,
                        images,
                    } = &mut item
                    {
                        *images = self.images.remove(turn_id).unwrap_or_default();
                        if let Some(turn_id) = turn_id {
                            *wake = self.wakes.was_sent(*turn_id);
                            *text = self
                                .turns
                                .get(turn_id)
                                .map(|sent| convert::truncate(sent, convert::MAX_TEXT_ITEM_BYTES));
                        }
                    }
                    self.push(item).await;
                }
            }
        }
    }

    fn clear_live(&mut self) {
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

    /// Records how a CLI process ended. Unless wispd stopped it, commits a worker's changes first,
    /// through #166's hardened commit, and reports the commit, then wakes the coordinator that
    /// started the run.
    async fn finish(&mut self, outcome: &Outcome) {
        self.flush().await;
        if self.stopping && matches!(outcome, Outcome::Cancelled) {
            info!(run = %self.id, "an agent run was interrupted because wispd is stopping");
            self.append(WispEvent::AgentFinished {
                run_id: self.id,
                outcome: AgentOutcome::Interrupted,
            })
            .await;
            convert::INTERRUPTED.clone_into(&mut self.row.state.status);
            self.save().await;
            return;
        }
        let (mut outcome, mut status, mut error) = convert::outcome(outcome);
        let committed = if self.is_coordinator() {
            Ok(None)
        } else {
            self.commit().await
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
        self.append(WispEvent::AgentFinished {
            run_id: self.id,
            outcome: outcome.clone(),
        })
        .await;
        if let Some(diff) = diff {
            self.row.state.commit_sha = Some(diff.commit.clone());
            self.row.state.files_changed = Some(diff.files);
            self.row.state.insertions = Some(diff.insertions);
            self.row.state.deletions = Some(diff.deletions);
            self.append(WispEvent::AgentDiffReady {
                run_id: self.id,
                diff,
            })
            .await;
        }
        status.clone_into(&mut self.row.state.status);
        self.row.state.error = error;
        info!(run = %self.id, status, "an agent run's CLI finished");
        self.save().await;
        if let Some(thread) = self.row.fields.coordinator_thread
            && !self.is_coordinator()
            && let Ok(run) = self.snapshot()
        {
            wake::notify(&self.daemon, thread, wake::summary(&run, &outcome));
        }
    }

    /// Commits whatever the run changed in its worktree, on its branch, and measures the branch
    /// against the worktree's base. `None` when there was nothing new to commit.
    async fn commit(&self) -> Result<Option<DiffSummary>, String> {
        let Some(worktree) = &self.worktree else {
            return Err("the run was accepted, and its worktree is gone".to_owned());
        };
        if worktree.git_dir.is_empty() {
            return Err(
                "the run's worktree has no recorded git folder, so wispd can't commit it safely"
                    .to_owned(),
            );
        }
        let worktrees = &self.daemon.agents.worktrees;
        let path = Path::new(&worktree.path);
        let git_dir = Path::new(&worktree.git_dir);
        let message = commit_message(&self.last_message, self.id);
        let commit = worktrees
            .commit_all(path, git_dir, Path::new(&worktree.repo_path), &message)
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

    async fn push(&mut self, item: AgentOutputItem) {
        self.batch.bytes += item_bytes(&item);
        self.batch.items.push(item);
        self.batch.since.get_or_insert_with(Instant::now);
        if self.batch.bytes >= MAX_BATCH_BYTES {
            self.flush().await;
        }
    }

    async fn flush(&mut self) {
        let batch = std::mem::take(&mut self.batch);
        if !batch.items.is_empty() {
            self.append(WispEvent::AgentOutput {
                run_id: self.id,
                items: batch.items,
            })
            .await;
        }
    }

    /// From a tokio task: the event log's own writer thread does the SQLite work, so awaiting it
    /// here yields this actor's worker thread to other work instead of blocking it (#190).
    async fn append(&self, event: WispEvent) -> u64 {
        self.daemon
            .log
            .append(jiff::Timestamp::now(), Some(self.project), event)
            .await
    }

    /// Stores the run's state and reports it as `agent.updated`, after any transcript items
    /// waiting to be sent.
    async fn save(&mut self) {
        self.flush().await;
        let (id, state) = (self.row.id, self.row.state.clone());
        let saved = store(&self.daemon, move |db| {
            db.update_run(id, &state)
                .map_err(|error| store_error(&error))
        })
        .await;
        match saved {
            Ok(row) => self.row = row,
            Err(error) => {
                warn!(run = %self.id, error = %error.message, "could not store an agent run's state");
            }
        }
        self.append(WispEvent::AgentUpdated {
            run_id: self.id,
            state: convert::run_state(&self.row),
        })
        .await;
    }
}

/// The account a run's session belongs to, as routing takes it: a key account's id, or else a
/// backend's name for its subscription (0012).
fn session_account(account_id: &str) -> AccountChoice {
    match account_id.parse::<AccountId>() {
        Ok(id) => AccountChoice::Key { id },
        Err(_) => AccountChoice::Subscription {
            backend: account_id.to_owned(),
        },
    }
}

async fn next_event(live: &mut Option<Live>) -> Option<Event> {
    match live {
        Some(live) => live.events.next().await,
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

/// The merge commit's message, when accepting a run needs one: `Merge wisp run: <the task's first
/// line>`, cut to 72 characters, then the run and its branch.
fn merge_message(prompt: &str, run: RunId, branch: &str) -> String {
    let first = prompt
        .lines()
        .find(|line| !line.trim().is_empty())
        .unwrap_or("agent run");
    let mut subject: String = format!("Merge wisp run: {}", first.trim());
    if subject.chars().count() > 72 {
        subject = subject.chars().take(69).collect::<String>() + "...";
    }
    format!("{subject}\n\nAccepted in wisp: agent run {run}, branch {branch}.\n")
}

fn accept_error(error: &crate::worktree::AcceptError) -> ErrorObject {
    use crate::worktree::AcceptError;
    match error {
        AcceptError::Refused(message) => ErrorObject::wisp(ErrorKind::MergeRefused, message),
        AcceptError::Conflict { .. } => {
            ErrorObject::wisp(ErrorKind::MergeConflict, error.to_string())
        }
        AcceptError::Git(error) => ErrorObject::wisp(ErrorKind::MergeRefused, error.to_string()),
    }
}

/// `wisp: <the message's first line>`, cut to 72 characters, then the run it belongs to.
fn commit_message(message: &str, run: RunId) -> String {
    let first = message
        .lines()
        .find(|line| !line.trim().is_empty())
        .unwrap_or("agent run");
    let mut subject: String = format!("wisp: {}", first.trim());
    if subject.chars().count() > 72 {
        subject = subject.chars().take(69).collect::<String>() + "...";
    }
    format!("{subject}\n\nCommitted by wisp for agent run {run}.\n")
}

#[cfg(test)]
mod tests {
    use std::collections::HashMap;
    use std::sync::Arc;
    use std::time::Duration;

    use tokio::sync::{mpsc, oneshot};
    use tokio_util::sync::CancellationToken;
    use wisp_protocol::{AccountChoice, AccountId, ProjectId, RunId};
    use wisp_store::{Run as RunRow, RunFields, RunState, Worktree};

    use super::{Actor, Command, Live, commit_message, session_account};
    use crate::backend::{Event, EventSink, FollowUp, Run, SendError};
    use crate::server::Daemon;

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
        assert!(message.starts_with("wisp: Add a README\n\n"), "{message}");
        assert!(message.contains(&run.to_string()));
        let long = commit_message(&"x".repeat(200), run);
        assert_eq!(long.lines().next().unwrap().chars().count(), 72);
        assert!(commit_message("", run).starts_with("wisp: agent run"));
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
                model: None,
                effort: None,
                permission: None,
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
            branch: "wisp/run".to_owned(),
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
            .send(Command::Cancel { reply })
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
}
