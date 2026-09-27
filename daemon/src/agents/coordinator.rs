//! The coordinator's planning loop (#196, decision 0020).
//!
//! Each project has one coordinator thread, stored with its vendor session. One actor task per
//! thread runs its turns, the way a run's actor runs a worker: every turn is one no-write CLI
//! process that resumes the thread's session, with wispd's tools attached (0019). Routing picks
//! the coordinator role's account, and `routing::snapshot` before the process and
//! `routing::check` after it are 0004's second check: a turn that changed the project's working
//! tree fails with `policyViolation`.
//!
//! What arrives while a turn runs waits for the next one: the user's messages, and wake-ups for
//! runs the coordinator started that have finished. The next turn delivers all of it at once, so
//! runs that finish together wake the coordinator once. Wake-ups with no message waiting are held
//! a short window first (`Config::coordinator_wake_batch`), whether they arrive while the thread
//! is idle or during a turn, for runs finishing close behind.
//!
//! Waiting messages and wake-ups live in memory: a restart loses those not yet delivered (#261).

use std::collections::HashMap;
use std::fmt::Write as _;
use std::path::{Path, PathBuf};
use std::sync::{Arc, PoisonError};

use tokio::sync::{mpsc, oneshot};
use tokio::time::{Instant, sleep_until};
use tokio_util::sync::CancellationToken;
use tracing::{info, warn};
use uuid::Uuid;
use wisp_protocol::jsonrpc::ErrorObject;
use wisp_protocol::{
    AgentFailureKind, AgentOutcome, AgentOutputItem, CoordinatorStatus, CoordinatorThread,
    CoordinatorThreadId, CoordinatorThreadState, DiffSummary, ErrorKind, ProjectId, Role, RunId,
    TurnId, WispEvent,
};
use wisp_store::CoordinatorState;

use super::convert::{self, item_bytes, output_item};
use super::worker::StoredKeyAccounts;
use super::{key_accounts, store, store_error};
use crate::backend::{
    AccountRef, CoordinatorTools, Credential, Event, EventStream, Outcome, Resume, Run, RunRequest,
    ToolPolicy,
};
use crate::routing::{self, Defaults, Resolved, TreeSnapshot};
use crate::server::Daemon;

const IDLE: &str = "idle";
const RUNNING: &str = "running";

/// A run the coordinator started that finished a CLI process, for its wake-up.
#[derive(Clone, Debug)]
pub(crate) struct Finished {
    pub run_id: RunId,
    pub prompt: String,
    pub outcome: AgentOutcome,
    /// The run's latest commit, if it has one.
    pub diff: Option<DiffSummary>,
}

pub(crate) enum Command {
    Send {
        turn_id: TurnId,
        text: String,
        reply: oneshot::Sender<Result<CoordinatorThread, ErrorObject>>,
    },
    Cancel {
        reply: oneshot::Sender<Result<CoordinatorThread, ErrorObject>>,
    },
    Wake(Finished),
}

struct Live {
    run: Arc<dyn Run>,
    events: EventStream,
    repo: PathBuf,
    before: TreeSnapshot,
}

#[derive(Default)]
struct Batch {
    items: Vec<AgentOutputItem>,
    bytes: usize,
    since: Option<Instant>,
}

struct Actor {
    daemon: Arc<Daemon>,
    id: CoordinatorThreadId,
    project: ProjectId,
    row: wisp_store::CoordinatorThread,
    live: Option<Live>,
    batch: Batch,
    /// Messages waiting for the next turn.
    messages: Vec<(TurnId, String)>,
    /// Finished runs waiting for the next turn.
    finished: Vec<Finished>,
    /// Messages turns have delivered, by turn id, for `coordinator/send`'s idempotency.
    sent: HashMap<TurnId, String>,
    /// Set by `coordinator/cancel`, a policy violation, or a turn that couldn't start: no turn
    /// starts on its own until the next `coordinator/send`.
    paused: bool,
    /// When a wake-up that arrived while idle starts its turn.
    wake_at: Option<Instant>,
    stopping: bool,
}

/// The project's thread as the protocol has it.
fn thread(row: &wisp_store::CoordinatorThread) -> Result<CoordinatorThread, ErrorObject> {
    let corrupt = || {
        ErrorObject::internal_error(format!(
            "the stored coordinator thread {} has an invalid id",
            row.id
        ))
    };
    Ok(CoordinatorThread {
        id: CoordinatorThreadId::try_from(row.id).map_err(|_| corrupt())?,
        project: ProjectId::try_from(row.project_id).map_err(|_| corrupt())?,
        status: status(&row.state.status),
        backend: row.state.backend.clone(),
        account_id: row.state.account_id.clone(),
        session_id: row.state.session_id.clone(),
        error: row.state.error.clone(),
        created_at: row.created_at,
        updated_at: row.updated_at,
    })
}

fn status(text: &str) -> CoordinatorStatus {
    match text {
        IDLE => CoordinatorStatus::Idle,
        RUNNING => CoordinatorStatus::Running,
        _ => CoordinatorStatus::Unknown,
    }
}

fn state(row: &wisp_store::CoordinatorThread) -> CoordinatorThreadState {
    CoordinatorThreadState {
        status: status(&row.state.status),
        backend: row.state.backend.clone(),
        account_id: row.state.account_id.clone(),
        session_id: row.state.session_id.clone(),
        error: row.state.error.clone(),
        updated_at: row.updated_at,
    }
}

/// The thread's id as the event log's and usage's run column holds it (0020).
fn as_run(id: CoordinatorThreadId) -> RunId {
    RunId::try_from(Uuid::from(id)).expect("both are version 7 UUIDs")
}

impl Actor {
    fn snapshot(&self) -> Result<CoordinatorThread, ErrorObject> {
        thread(&self.row)
    }

    async fn run(mut self, mut commands: mpsc::Receiver<Command>, shutdown: CancellationToken) {
        loop {
            let flush_at = self.batch.since.map(|since| since + super::actor::COALESCE);
            tokio::select! {
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
                () = sleep_until(flush_at.unwrap_or_else(Instant::now)), if flush_at.is_some() => {
                    self.flush().await;
                }
                () = sleep_until(self.wake_at.unwrap_or_else(Instant::now)), if self.wake_at.is_some() => {
                    self.wake_at = None;
                    self.next_turn().await;
                }
                event = next_event(&mut self.live) => self.on_event(event).await,
            }
            if self.stopping && self.live.is_none() {
                self.flush().await;
                break;
            }
        }
    }

    async fn on_command(&mut self, command: Command) {
        match command {
            Command::Send {
                turn_id,
                text,
                reply,
            } => {
                let queued = self
                    .messages
                    .iter()
                    .find(|(queued, _)| *queued == turn_id)
                    .map(|(_, text)| text);
                let sent = self.sent.get(&turn_id);
                if let Some(known) = sent.or(queued)
                    && *known != text
                {
                    let conflict = ErrorObject::wisp(
                        ErrorKind::IdConflict,
                        format!("turn {turn_id} was already sent with a different text"),
                    );
                    let _ = reply.send(Err(conflict));
                    return;
                }
                // A retry of a delivered message changes nothing. A retry of a queued one tries
                // again, as after a turn that couldn't start.
                if sent.is_none() {
                    if queued.is_none() {
                        self.messages.push((turn_id, text));
                    }
                    self.paused = false;
                    self.next_turn().await;
                }
                let _ = reply.send(self.snapshot());
            }
            Command::Cancel { reply } => {
                if let Some(live) = &self.live {
                    info!(project = %self.project, "cancelling the coordinator's turn");
                    live.run.cancel();
                }
                self.paused = true;
                self.wake_at = None;
                let _ = reply.send(self.snapshot());
            }
            Command::Wake(finished) => {
                self.finished.push(finished);
                self.schedule().await;
            }
        }
    }

    /// Starts the next turn now for a waiting message, or once the batching window ends for
    /// waiting wake-ups only, so runs that finish close together wake the coordinator once.
    async fn schedule(&mut self) {
        if !self.messages.is_empty() {
            self.next_turn().await;
        } else if !self.finished.is_empty()
            && self.live.is_none()
            && !self.paused
            && self.wake_at.is_none()
        {
            self.wake_at = Some(Instant::now() + self.daemon.agents.wake_batch);
        }
    }

    /// Starts a turn with everything waiting, unless one runs, the thread is paused, or nothing
    /// waits.
    async fn next_turn(&mut self) {
        if self.live.is_some()
            || self.paused
            || (self.messages.is_empty() && self.finished.is_empty())
        {
            return;
        }
        self.wake_at = None;
        let messages = std::mem::take(&mut self.messages);
        let finished = std::mem::take(&mut self.finished);
        let text = turn_text(&messages, &finished);
        let first_turn = messages.first().map(|(turn_id, _)| *turn_id);
        match self.launch(first_turn, &text).await {
            Ok(()) => {
                for (turn_id, message) in &messages {
                    self.record_turn(*turn_id, message.clone()).await;
                }
                self.append(WispEvent::CoordinatorTurnStarted {
                    thread_id: self.id,
                    turn_ids: messages.iter().map(|(turn_id, _)| *turn_id).collect(),
                    run_ids: finished.iter().map(|finished| finished.run_id).collect(),
                    text,
                })
                .await;
            }
            Err(message) => {
                // Nothing reached a CLI: keep it all for the user's next message.
                self.messages = messages;
                self.finished = finished;
                self.paused = true;
                self.failed_to_start(message).await;
            }
        }
    }

    async fn record_turn(&mut self, turn_id: TurnId, text: String) {
        self.sent.insert(turn_id, text.clone());
        let thread = Uuid::from(self.id);
        let stored = store(&self.daemon, move |db| {
            db.record_turn(thread, turn_id.into(), &text)
                .map_err(|error| store_error(&error))
        })
        .await;
        if let Err(error) = stored {
            warn!(project = %self.project, error = %error.message, "could not store a coordinator turn");
        }
    }

    /// Resolves the coordinator's account, takes the working tree's snapshot, and starts the
    /// turn's CLI with `text`. Returns why it couldn't.
    async fn launch(&mut self, first_turn: Option<TurnId>, text: &str) -> Result<(), String> {
        let project = self.project;
        let (repo, resolved, accounts) = self.route().await?;
        let backend = resolved.backend().name().to_owned();
        let account = resolved.account_id();
        let same_session = self.row.state.backend.as_deref() == Some(backend.as_str())
            && self.row.state.account_id.as_deref() == Some(account.as_str());
        let resume = match self.row.state.session_id.clone() {
            Some(session_id) if same_session => {
                let session = session_id.clone();
                let totals = store(&self.daemon, move |db| {
                    db.session_usage_totals(&session)
                        .map_err(|error| store_error(&error))
                })
                .await
                .map_err(|error| error.message)?;
                Some(Resume {
                    session_id,
                    usage_totals: totals.into_iter().map(super::actor::model_usage).collect(),
                })
            }
            _ => None,
        };
        let prompt = if resume.is_some() {
            text.to_owned()
        } else {
            format!("{}\n\n{text}", planning_prompt(&repo))
        };
        let before = routing::snapshot(&repo).await.map_err(|error| {
            format!("could not read the project's working tree before the turn: {error}")
        })?;
        let request = RunRequest {
            run_id: as_run(self.id),
            turn_id: first_turn,
            cwd: repo.clone(),
            prompt,
            policy: ToolPolicy::NoWrite,
            sandbox: None,
            account: AccountRef {
                id: account.clone(),
                credential: Credential::Subscription { config_home: None },
            },
            resume: resume.clone(),
            model: None,
            coordinator_tools: Some(CoordinatorTools {
                program: self.daemon.agents.program.clone(),
                data_dir: self.daemon.data_dir.root().to_owned(),
                project,
                thread: self.id,
            }),
        };
        let started = routing::start(Arc::clone(&self.daemon.keys), &accounts, resolved, request)
            .map_err(|error| error.to_string())?;
        info!(project = %project, backend, resumed = resume.is_some(), "started a coordinator turn");
        self.live = Some(Live {
            run: started.run,
            events: started.events,
            repo,
            before,
        });
        let state = &mut self.row.state;
        RUNNING.clone_into(&mut state.status);
        if resume.is_none() {
            state.session_id = None;
        }
        state.backend = Some(backend);
        state.account_id = Some(account);
        state.error = None;
        self.save().await;
        Ok(())
    }

    /// The project's canonical repository, and the coordinator role's route (0012): refuses a
    /// backend that can't coordinate.
    async fn route(&self) -> Result<(PathBuf, Resolved, StoredKeyAccounts), String> {
        let project = self.project;
        let (repo, defaults, accounts) = store(&self.daemon, move |db| {
            let project = db
                .get_project(project.into())
                .map_err(|error| store_error(&error))?
                .ok_or_else(|| project_not_found(project))?;
            let defaults = crate::methods::read_defaults(db)?;
            Ok((project.repo_path, defaults, key_accounts(db)?))
        })
        .await
        .map_err(|error| error.message)?;
        let defaults = Defaults {
            coordinator: defaults.coordinator,
            worker: defaults.worker,
        };
        let resolved = routing::resolve(
            &self.daemon.agents.backends,
            &accounts,
            &defaults,
            Role::Coordinator,
            None,
            ToolPolicy::NoWrite,
        )
        .map_err(|error| match error {
            routing::RoutingError::NoAccount { .. } => {
                "the coordinator role has no default account; set one with accounts/defaults/set"
                    .to_owned()
            }
            error => error.to_string(),
        })?;
        if !resolved.backend().capabilities().coordinator {
            return Err(format!(
                "the {} backend can't run the coordinator (decision 0004); choose a Claude \
                 Code account for the coordinator role",
                resolved.backend().name()
            ));
        }
        let repo = Path::new(&repo).canonicalize().map_err(|error| {
            format!("could not resolve the project's repository {repo}: {error}")
        })?;
        Ok((repo, resolved, accounts))
    }

    async fn failed_to_start(&mut self, message: String) {
        warn!(project = %self.project, %message, "a coordinator turn could not start");
        self.append(WispEvent::CoordinatorFinished {
            thread_id: self.id,
            outcome: AgentOutcome::Failed {
                failure: AgentFailureKind::SpawnFailed,
                message: message.clone(),
            },
        })
        .await;
        IDLE.clone_into(&mut self.row.state.status);
        self.row.state.error = Some(message);
        self.save().await;
    }

    async fn on_event(&mut self, event: Option<Event>) {
        let Some(event) = event else {
            self.live = None;
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
                self.append(WispEvent::CoordinatorAccountFallback {
                    thread_id: self.id,
                    from_account: from_account.clone(),
                    to_account: to_account.clone(),
                    reason: convert::failure_kind(*reason),
                })
                .await;
                self.row.state.account_id = Some(to_account.clone());
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
                if let Some(live) = self.live.take() {
                    self.finish(&outcome, &live).await;
                }
            }
            _ => {
                if let Some(item) = output_item(&event) {
                    self.push(item).await;
                }
            }
        }
    }

    async fn record_usage(&self, event: Event) {
        let Some(session) = self.row.state.session_id.clone() else {
            return;
        };
        let account = self.row.state.account_id.clone().unwrap_or_default();
        let run = as_run(self.id);
        let recorded = store(&self.daemon, move |db| {
            crate::usage::record_event(db, run, &account, &session, &event)
                .map_err(|error| store_error(&error))
        })
        .await;
        if let Err(error) = recorded {
            warn!(project = %self.project, error = %error.message, "could not record the coordinator's usage");
        }
    }

    /// Records how a turn's CLI ended, after 0004's second check: a turn that changed the working
    /// tree fails with `policyViolation` and pauses the thread. Then schedules the next turn if
    /// anything waits.
    async fn finish(&mut self, outcome: &Outcome, live: &Live) {
        self.flush().await;
        if self.stopping && matches!(outcome, Outcome::Cancelled) {
            self.append(WispEvent::CoordinatorFinished {
                thread_id: self.id,
                outcome: AgentOutcome::Interrupted,
            })
            .await;
            IDLE.clone_into(&mut self.row.state.status);
            self.row.state.error = Some(INTERRUPTED.to_owned());
            self.save().await;
            return;
        }
        let (mut outcome, _, mut error) = convert::outcome(outcome);
        let violation = match routing::check(&live.repo, &live.before).await {
            Ok(violation) => violation.map(|failure| failure.message),
            Err(error) => Some(format!(
                "could not check the project's working tree after the coordinator's turn, so \
                 wispd can't tell whether it wrote anything: {error}"
            )),
        };
        if let Some(message) = violation {
            warn!(project = %self.project, %message, "the coordinator's turn broke its no-write policy");
            outcome = AgentOutcome::Failed {
                failure: AgentFailureKind::PolicyViolation,
                message: message.clone(),
            };
            error = Some(message);
        }
        if matches!(
            outcome,
            AgentOutcome::Failed {
                failure: AgentFailureKind::PolicyViolation,
                ..
            }
        ) {
            self.paused = true;
        }
        self.append(WispEvent::CoordinatorFinished {
            thread_id: self.id,
            outcome,
        })
        .await;
        IDLE.clone_into(&mut self.row.state.status);
        self.row.state.error = error;
        self.save().await;
        self.schedule().await;
    }

    async fn push(&mut self, item: AgentOutputItem) {
        self.batch.bytes += item_bytes(&item);
        self.batch.items.push(item);
        self.batch.since.get_or_insert_with(Instant::now);
        if self.batch.bytes >= super::actor::MAX_BATCH_BYTES {
            self.flush().await;
        }
    }

    async fn flush(&mut self) {
        let batch = std::mem::take(&mut self.batch);
        if !batch.items.is_empty() {
            self.append(WispEvent::CoordinatorOutput {
                thread_id: self.id,
                items: batch.items,
            })
            .await;
        }
    }

    async fn append(&self, event: WispEvent) -> u64 {
        self.daemon
            .log
            .append(jiff::Timestamp::now(), Some(self.project), event)
            .await
    }

    async fn save(&mut self) {
        self.flush().await;
        let (id, stored) = (self.row.id, self.row.state.clone());
        let saved = store(&self.daemon, move |db| {
            db.update_coordinator_thread(id, &stored)
                .map_err(|error| store_error(&error))
        })
        .await;
        match saved {
            Ok(row) => self.row = row,
            Err(error) => {
                warn!(project = %self.project, error = %error.message, "could not store the coordinator thread");
            }
        }
        self.append(WispEvent::CoordinatorUpdated {
            thread_id: self.id,
            state: state(&self.row),
        })
        .await;
    }
}

const INTERRUPTED: &str = "wispd stopped during the coordinator's turn";

async fn next_event(live: &mut Option<Live>) -> Option<Event> {
    match live {
        Some(live) => live.events.next().await,
        None => std::future::pending().await,
    }
}

fn project_not_found(project: ProjectId) -> ErrorObject {
    ErrorObject::wisp(
        ErrorKind::ProjectNotFound,
        format!("no project has id {project}"),
    )
}

/// The planning instructions a new session's first message starts with.
pub(crate) fn planning_prompt(repo: &Path) -> String {
    format!(
        "You are the coordinator of a wisp project. You plan the work and delegate it to \
         subagents; you never change files yourself. Your working directory is the project's \
         repository at {repo}: your tools can read it but not change it.\n\
         \n\
         How to work:\n\
         1. Plan first. Read what you need, then break the request into tasks that can run \
         independently and in parallel. Give each a clear spec (what to change and where) and \
         done-criteria (the tests that must pass or the behavior to check).\n\
         2. Record the plan in shared context with write_context, for example in plan.md: the \
         tasks, their specs and done-criteria, and which run works on each. Keep it current.\n\
         3. Start the tasks with spawn_agent, independent ones together. Each subagent works in \
         its own git worktree and sees only the prompt you give it, so put the whole spec and \
         its done-criteria in the prompt.\n\
         4. Once the work is started, end your turn. wisp wakes you with a message when your \
         subagents finish, saying which run finished, how it ended, and its diff stats. Then \
         review with agent_status and agent_diff, ask for changes with message_agent, or start \
         more work.\n\
         5. Report back to the user: what was done and by which runs, and what is left or needs \
         their decision. The user reviews and accepts each run's changes; you don't merge them.\n\
         \n\
         A question you can answer by reading the repository needs no subagent.",
        repo = repo.display(),
    )
}

/// A turn's message: the user's messages, then a note on each finished run.
pub(crate) fn turn_text(messages: &[(TurnId, String)], finished: &[Finished]) -> String {
    let mut parts: Vec<String> = messages.iter().map(|(_, text)| text.clone()).collect();
    if !finished.is_empty() {
        let mut note = if finished.len() == 1 {
            "wisp: a subagent you started has finished.\n".to_owned()
        } else {
            format!(
                "wisp: {} subagents you started have finished.\n",
                finished.len()
            )
        };
        for run in finished {
            let _ = writeln!(
                note,
                "- Run {}: {}. {}. Its task began: {}",
                run.run_id,
                outcome_text(&run.outcome),
                diff_text(run.diff.as_ref()),
                first_line(&run.prompt, 120),
            );
        }
        note.push_str(
            "Review their work with agent_status and agent_diff, ask for changes with \
             message_agent, or start more work with spawn_agent. When everything is done, update \
             the plan in shared context and report back to the user.",
        );
        parts.push(note);
    }
    parts.join("\n\n")
}

fn outcome_text(outcome: &AgentOutcome) -> String {
    match outcome {
        AgentOutcome::Completed {
            result: Some(result),
        } => {
            format!("completed, saying: {}", first_line(result, 300))
        }
        AgentOutcome::Completed { result: None } => "completed".to_owned(),
        AgentOutcome::Cancelled => "cancelled".to_owned(),
        AgentOutcome::Failed { failure, message } => {
            let kind = serde_json::to_value(failure)
                .ok()
                .and_then(|kind| kind.as_str().map(str::to_owned))
                .unwrap_or_default();
            format!("failed ({kind}): {}", first_line(message, 300))
        }
        AgentOutcome::Interrupted => "interrupted".to_owned(),
        AgentOutcome::Unknown => "ended".to_owned(),
    }
}

fn diff_text(diff: Option<&DiffSummary>) -> String {
    match diff {
        Some(diff) => format!(
            "Its branch changes {} files, +{} -{}, at commit {}",
            diff.files,
            diff.insertions,
            diff.deletions,
            diff.commit.get(..12).unwrap_or(&diff.commit)
        ),
        None => "It has committed no changes".to_owned(),
    }
}

/// `text`'s first non-empty line, cut to `max` characters.
fn first_line(text: &str, max: usize) -> String {
    let line = text
        .lines()
        .map(str::trim)
        .find(|line| !line.is_empty())
        .unwrap_or("");
    if line.chars().count() > max {
        line.chars().take(max).collect::<String>() + "..."
    } else {
        line.to_owned()
    }
}

/// The project's coordinator thread, made on first use (and announced with
/// `coordinator.started`). A repo entry, or an id that is no project's, is `projectNotFound`.
async fn ensure(
    daemon: &Arc<Daemon>,
    project: ProjectId,
) -> Result<wisp_store::CoordinatorThread, ErrorObject> {
    let (row, made) = store(daemon, move |db| {
        if db
            .get_project(project.into())
            .map_err(|error| store_error(&error))?
            .is_none()
        {
            return Err(project_not_found(project));
        }
        db.ensure_coordinator_thread(project.into(), CoordinatorThreadId::generate().into())
            .map_err(|error| store_error(&error))
    })
    .await?;
    if made {
        let snapshot = thread(&row)?;
        daemon
            .log
            .append(
                snapshot.created_at,
                Some(project),
                WispEvent::CoordinatorStarted {
                    thread_id: snapshot.id,
                    thread: snapshot,
                },
            )
            .await;
    }
    Ok(row)
}

/// `coordinator/get`.
pub(crate) async fn get(
    daemon: &Arc<Daemon>,
    project: ProjectId,
) -> Result<CoordinatorThread, ErrorObject> {
    thread(&ensure(daemon, project).await?)
}

/// The project's coordinator thread, if it has one yet, for `coordinator/events`.
pub(crate) async fn existing(
    daemon: &Arc<Daemon>,
    project: ProjectId,
) -> Result<Option<RunId>, ErrorObject> {
    let row = store(daemon, move |db| {
        if db
            .get_project(project.into())
            .map_err(|error| store_error(&error))?
            .is_none()
        {
            return Err(project_not_found(project));
        }
        db.project_coordinator_thread(project.into())
            .map_err(|error| store_error(&error))
    })
    .await?;
    row.map(|row| {
        CoordinatorThreadId::try_from(row.id)
            .map(as_run)
            .map_err(|_| ErrorObject::internal_error("a stored coordinator thread id is invalid"))
    })
    .transpose()
}

/// The command channel of the project's thread's actor, spawning it on first use.
async fn actor_for(
    daemon: &Arc<Daemon>,
    project: ProjectId,
) -> Result<mpsc::Sender<Command>, ErrorObject> {
    let agents = &daemon.agents;
    let _spawning = agents.coordinator_spawn.lock().await;
    if let Some(actor) = agents.coordinator(project) {
        return Ok(actor);
    }
    let row = ensure(daemon, project).await?;
    let id = CoordinatorThreadId::try_from(row.id)
        .map_err(|_| ErrorObject::internal_error("a stored coordinator thread id is invalid"))?;
    let sent = store(daemon, move |db| {
        db.run_turns(row.id).map_err(|error| store_error(&error))
    })
    .await?
    .into_iter()
    .filter_map(|(turn_id, text)| Some((TurnId::try_from(turn_id).ok()?, text)))
    .collect();
    let actor = Actor {
        daemon: Arc::clone(daemon),
        id,
        project,
        row,
        live: None,
        batch: Batch::default(),
        messages: Vec::new(),
        finished: Vec::new(),
        sent,
        paused: false,
        wake_at: None,
        stopping: false,
    };
    let (commands, receiver) = mpsc::channel(16);
    agents
        .coordinators
        .lock()
        .unwrap_or_else(PoisonError::into_inner)
        .insert(project, commands.clone());
    agents
        .tracker
        .spawn(actor.run(receiver, agents.shutdown.clone()));
    Ok(commands)
}

async fn ask(
    daemon: &Arc<Daemon>,
    project: ProjectId,
    command: impl FnOnce(oneshot::Sender<Result<CoordinatorThread, ErrorObject>>) -> Command,
) -> Result<CoordinatorThread, ErrorObject> {
    let (reply, answer) = oneshot::channel();
    let stopping = || ErrorObject::internal_error("wispd is stopping");
    actor_for(daemon, project)
        .await?
        .send(command(reply))
        .await
        .map_err(|_| stopping())?;
    answer.await.map_err(|_| stopping())?
}

/// `coordinator/send`.
pub(crate) async fn send(
    daemon: Arc<Daemon>,
    project: ProjectId,
    turn_id: TurnId,
    text: String,
) -> Result<CoordinatorThread, ErrorObject> {
    ask(&daemon, project, |reply| Command::Send {
        turn_id,
        text,
        reply,
    })
    .await
}

/// `coordinator/cancel`.
pub(crate) async fn cancel(
    daemon: Arc<Daemon>,
    project: ProjectId,
) -> Result<CoordinatorThread, ErrorObject> {
    ask(&daemon, project, |reply| Command::Cancel { reply }).await
}

/// Tells the project's coordinator that a run it started finished. Never waits on the
/// coordinator: the run's actor calls this from its own loop.
pub(crate) fn wake(daemon: &Arc<Daemon>, project: ProjectId, finished: Finished) {
    let daemon = Arc::clone(daemon);
    daemon.agents.tracker.clone().spawn(async move {
        let run = finished.run_id;
        let sent = match actor_for(&daemon, project).await {
            Ok(actor) => actor.send(Command::Wake(finished)).await.is_ok(),
            Err(_) => false,
        };
        if !sent {
            warn!(%run, %project, "could not wake the coordinator for a finished run");
        }
    });
}

/// Marks a thread still `running` in the store as idle: wispd stopped during its turn. Called
/// once at startup, with the runs' recovery.
pub(crate) async fn recover(daemon: &Arc<Daemon>) {
    let recovered = store(daemon, |db| {
        let mut recovered = Vec::new();
        for row in db
            .list_coordinator_threads()
            .map_err(|error| store_error(&error))?
        {
            if row.state.status != RUNNING {
                continue;
            }
            let state = CoordinatorState {
                status: IDLE.to_owned(),
                error: Some(INTERRUPTED.to_owned()),
                ..row.state.clone()
            };
            recovered.push(
                db.update_coordinator_thread(row.id, &state)
                    .map_err(|error| store_error(&error))?,
            );
        }
        Ok(recovered)
    })
    .await;
    let rows = match recovered {
        Ok(rows) => rows,
        Err(error) => {
            warn!(error = %error.message, "could not recover interrupted coordinator turns");
            return;
        }
    };
    for row in rows {
        let Ok(snapshot) = thread(&row) else {
            continue;
        };
        info!(project = %snapshot.project, "a coordinator turn was interrupted when wispd last stopped");
        for event in [
            WispEvent::CoordinatorFinished {
                thread_id: snapshot.id,
                outcome: AgentOutcome::Interrupted,
            },
            WispEvent::CoordinatorUpdated {
                thread_id: snapshot.id,
                state: state(&row),
            },
        ] {
            daemon
                .log
                .append(snapshot.updated_at, Some(snapshot.project), event)
                .await;
        }
    }
}

#[cfg(test)]
mod tests {
    use std::path::Path;

    use wisp_protocol::{AgentFailureKind, AgentOutcome, DiffSummary, RunId, TurnId};

    use super::{Finished, planning_prompt, turn_text};

    #[test]
    fn a_wake_up_names_each_run_its_outcome_and_its_diff_stats() {
        let (done, broke) = (RunId::generate(), RunId::generate());
        let finished = [
            Finished {
                run_id: done,
                prompt: "Add a README\nwith details".to_owned(),
                outcome: AgentOutcome::Completed {
                    result: Some("Added it.".to_owned()),
                },
                diff: Some(DiffSummary {
                    commit: "0123456789abcdef0123".to_owned(),
                    files: 2,
                    insertions: 10,
                    deletions: 3,
                }),
            },
            Finished {
                run_id: broke,
                prompt: "Fix the tests".to_owned(),
                outcome: AgentOutcome::Failed {
                    failure: AgentFailureKind::Crashed,
                    message: "the CLI exited with code 1".to_owned(),
                },
                diff: None,
            },
        ];
        let text = turn_text(
            &[(TurnId::generate(), "Also check CI.".to_owned())],
            &finished,
        );
        assert!(
            text.starts_with("Also check CI.\n\nwisp: 2 subagents"),
            "{text}"
        );
        assert!(
            text.contains(&format!("- Run {done}: completed, saying: Added it.")),
            "{text}"
        );
        assert!(
            text.contains("changes 2 files, +10 -3, at commit 0123456789ab"),
            "{text}"
        );
        assert!(text.contains("Its task began: Add a README\n"), "{text}");
        assert!(
            text.contains(&format!(
                "- Run {broke}: failed (crashed): the CLI exited with code 1. It has committed no \
                 changes."
            )),
            "{text}"
        );
        assert!(turn_text(&[], &finished[..1]).starts_with("wisp: a subagent you started"));
        assert_eq!(
            turn_text(&[(TurnId::generate(), "Hi".to_owned())], &[]),
            "Hi"
        );
    }

    #[test]
    fn the_planning_prompt_asks_for_a_plan_specs_and_the_tools() {
        let prompt = planning_prompt(Path::new("/src/app"));
        for needed in [
            "/src/app",
            "Plan first",
            "done-criteria",
            "write_context",
            "spawn_agent",
            "agent_diff",
            "message_agent",
            "Report back",
        ] {
            assert!(prompt.contains(needed), "{needed}: {prompt}");
        }
    }
}
