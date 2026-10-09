//! The orchestrator (0059, phase 1): thread metadata changes as commands, and their side effects
//! as durable rows the effect worker runs.
//!
//! A [`Command`] has an id (the request's `commandId`, or a new one) and the thread whose lane it
//! runs in. [`Orchestrator::dispatch`] takes that lane, so one thread's commands run one at a
//! time while other threads' run alongside, and then runs one job on the store's writer: it looks
//! up the command's receipt, reads the thread's rows, `decide`s with no I/O, applies the decision
//! to the rows and stages its events tagged with the command, inserts the receipt, and enqueues
//! the effects, all in one transaction. A repeated command returns its stored outcome without
//! applying twice, and one aimed at another thread or of another type is `idConflict`. A rejected
//! command stores its error, which a repeat returns. Until phase 2 the projection is today's
//! `runs`, `worktrees`, and `threads` rows, and the actor still writes them while it runs turns,
//! so `decide` reads them in the same job, not on a read connection.
//!
//! The effect worker ([`work`]) runs effects after their command commits: each thread's one at
//! a time, oldest first, at most [`MAX_RUNNING`] at once, retrying a failure with a backoff of
//! 100 ms × 2ⁿ, capped at 30 s, for [`MAX_ATTEMPTS`] attempts. It sleeps until a commit wakes it
//! or a backoff ends, and never polls. A crash can leave an effect `pending` or `running`; at the
//! next start [`recover`] returns the replay-safe ones to `pending` and cancels the rest, before
//! the worker starts.

use std::collections::HashMap;
use std::path::Path;
use std::sync::{Arc, Mutex, PoisonError};
use std::time::Duration;

use jiff::Timestamp;
use parallax_protocol::jsonrpc::ErrorObject;
use parallax_protocol::{ErrorKind, ParallaxEvent, ProjectId, RepoId, RunId};
use parallax_store::{
    ClaimedEffect, EffectOutcome, NewEffect, OrchestrationReceipt, Run, RunFields, RunState,
    Thread, ThreadFields, ThreadUpdate, Worktree, WorktreeFields,
};
use serde::{Deserialize, Serialize};
use tokio::sync::{Notify, OwnedMutexGuard};
use tokio::task::JoinSet;
use tokio_util::sync::CancellationToken;
use tracing::{info, warn};
use uuid::Uuid;

use crate::server::Daemon;
use crate::store::{Tx, store_error};

/// How many effects run at once, host-wide, as T3's four workers.
const MAX_RUNNING: usize = 4;

/// Attempts an effect gets before it fails for good.
const MAX_ATTEMPTS: u32 = 5;

/// The first retry's delay, doubled for each one after, up to [`MAX_BACKOFF`].
const BACKOFF: Duration = Duration::from_millis(100);
const MAX_BACKOFF: Duration = Duration::from_secs(30);

const THREAD_CLEANUP: &str = "thread.cleanup";
const PROJECT_CLEANUP: &str = "project.cleanup";
const THREAD_WAKE: &str = "thread.wake";
const DELEGATED_TASKS_STOP: &str = "delegated-tasks.stop";
const SETTLE_SCRIPT: &str = "settle-script.run";

/// Effect kinds that may run again after a restart, since each does only what is left to do.
/// [`recover`] cancels an open effect of any other kind.
const REPLAY_SAFE: &[&str] = &[
    THREAD_CLEANUP,
    PROJECT_CLEANUP,
    THREAD_WAKE,
    DELEGATED_TASKS_STOP,
];

/// The lanes, and the effect worker's wake-up.
#[derive(Default)]
pub(crate) struct Orchestrator {
    lanes: Mutex<HashMap<Uuid, Arc<tokio::sync::Mutex<()>>>>,
    wake: Notify,
}

/// A held lane: no other command for its thread runs until it drops. Creating a run and
/// spawning its actor hold it too, so one run never gets two worktrees or two actors (#190).
pub(crate) struct Lane<'a> {
    orchestrator: &'a Orchestrator,
    id: Uuid,
    _lock: OwnedMutexGuard<()>,
}

impl Drop for Lane<'_> {
    fn drop(&mut self) {
        self.orchestrator.release(self.id);
    }
}

impl Orchestrator {
    /// Waits for thread (or Project) `id`'s lane, waiting only on another holder of the same id.
    pub(crate) async fn lane(&self, id: impl Into<Uuid>) -> Lane<'_> {
        let id = id.into();
        Lane {
            orchestrator: self,
            id,
            _lock: self.entry(id).lock_owned().await,
        }
    }

    /// `id`'s lock, made by the first caller to ask for it. Also sweeps the entries nothing
    /// else holds: a waiter whose task was dropped while it queued never releases (#190 review).
    fn entry(&self, id: Uuid) -> Arc<tokio::sync::Mutex<()>> {
        let mut lanes = self.lanes.lock().unwrap_or_else(PoisonError::into_inner);
        lanes.retain(|_, lock| Arc::strong_count(lock) > 1);
        Arc::clone(lanes.entry(id).or_default())
    }

    /// Drops `id`'s entry unless a waiter still queues on it: its own guard and the map's clone
    /// make two. Removing it while one waits would let a new caller take a second lock for the
    /// same id (#190 review).
    fn release(&self, id: Uuid) {
        let mut lanes = self.lanes.lock().unwrap_or_else(PoisonError::into_inner);
        if lanes
            .get(&id)
            .is_some_and(|lock| Arc::strong_count(lock) <= 2)
        {
            lanes.remove(&id);
        }
    }

    /// Wakes the effect worker, after a job outside [`Self::commit`] enqueued an effect.
    pub(crate) fn notify(&self) {
        self.wake.notify_one();
    }

    /// Runs `command` in its thread's lane: see the module documentation.
    pub(crate) async fn dispatch(
        &self,
        daemon: &Daemon,
        command: Command,
    ) -> Result<Outcome, ErrorObject> {
        let lane = self.lane(command.thread).await;
        self.commit(daemon, &lane, command).await
    }

    /// Runs `command` in `lane`, which the caller already holds for `command`'s thread.
    pub(crate) async fn commit(
        &self,
        daemon: &Daemon,
        lane: &Lane<'_>,
        command: Command,
    ) -> Result<Outcome, ErrorObject> {
        debug_assert_eq!(lane.id, command.thread);
        let committed = daemon
            .store
            .run(&CancellationToken::new(), move |db| commit(db, command))
            .await?;
        match committed {
            Committed::Done { rows, effects } => {
                if effects {
                    self.wake.notify_one();
                }
                Ok(Outcome::Done(rows))
            }
            Committed::Busy(runs) => Ok(Outcome::Busy(runs)),
            Committed::Rejected(error) => Err(error),
        }
    }
}

/// A state change (0059).
#[derive(Debug)]
pub(crate) struct Command {
    pub id: String,
    /// The thread, or for `project.delete` the Project, whose lane it runs in.
    pub thread: Uuid,
    pub action: Action,
}

impl Command {
    /// A command with the request's `commandId`, or a new id when it has none.
    pub(crate) fn new(command_id: Option<Uuid>, thread: impl Into<Uuid>, action: Action) -> Self {
        Self {
            id: command_id
                .unwrap_or_else(Uuid::now_v7)
                .hyphenated()
                .to_string(),
            thread: thread.into(),
            action,
        }
    }
}

/// What a command asks for.
#[derive(Debug)]
pub(crate) enum Action {
    /// `thread.create`: a run's rows, and its thread's when it is one, for a workspace and
    /// account that were prepared before.
    Create(Box<NewRows>),
    /// `thread.archive`, or `thread.unarchive` with `false`.
    Archive(bool),
    /// `thread.metadata.update`: its title, settled flag, seen time, or snooze.
    Update(ThreadUpdate),
    /// `thread.delete`, once its CLI has exited, with the worktree its actor had.
    Delete { worktree: Option<Worktree> },
    /// `project.delete`, once it has no runs.
    DeleteProject,
}

impl Action {
    fn kind(&self) -> &'static str {
        match self {
            Self::Create(_) => "thread.create",
            Self::Archive(true) => "thread.archive",
            Self::Archive(false) => "thread.unarchive",
            Self::Update(_) => "thread.metadata.update",
            Self::Delete { .. } => "thread.delete",
            Self::DeleteProject => "project.delete",
        }
    }
}

/// A new run's rows.
#[derive(Debug, PartialEq)]
pub(crate) struct NewRows {
    pub fields: RunFields,
    pub state: RunState,
    pub worktree: Option<WorktreeFields>,
    /// Its thread's fork origin and title, when it is a thread.
    pub thread: Option<ThreadFields>,
}

/// How a command ended.
#[derive(Debug)]
pub(crate) enum Outcome {
    /// Applied now or before: its thread's rows after it.
    Done(Box<ThreadRows>),
    /// `project.delete` found these runs still in the Project, and changed nothing.
    Busy(Vec<Uuid>),
}

impl Outcome {
    /// The rows after a command that can't be busy.
    pub(crate) fn rows(self) -> Result<ThreadRows, ErrorObject> {
        match self {
            Self::Done(rows) => Ok(*rows),
            Self::Busy(_) => Err(ErrorObject::internal_error("the command was busy")),
        }
    }
}

/// A thread's rows as the projection has them, read in the command's job.
#[derive(Debug, Default)]
pub(crate) struct ThreadRows {
    pub run: Option<Run>,
    pub worktree: Option<Worktree>,
    pub thread: Option<Thread>,
}

/// What `decide` reads besides the thread's rows.
#[derive(Debug, Default)]
struct Rows {
    thread: ThreadRows,
    /// For `thread.create`: whether its scope, a Project or repo entry, exists.
    scope: bool,
    /// For `thread.delete`: whether the thread is in the scratch entry, and the threads whose
    /// parent or fork origin it is.
    scratch: bool,
    children: Vec<Uuid>,
    /// For `project.delete`: its repository, if it exists, and its runs, coordinators first.
    project: Option<String>,
    runs: Vec<Uuid>,
}

/// A decided change, applied to the rows in the command's job.
#[derive(Debug, PartialEq)]
enum Change {
    Create(Box<NewRows>),
    Archive(bool),
    Update(ThreadUpdate),
    /// Deletes the run, and its thread row from repo entry `repo` when it has one, and updates
    /// the threads that pointed at it.
    Delete {
        repo: Option<Uuid>,
        children: Vec<Uuid>,
    },
    DeleteProject,
}

/// What a command does: its changes and the effects to run once they commit.
#[derive(Debug, Default, PartialEq)]
struct Decision {
    changes: Vec<Change>,
    effects: Vec<Effect>,
}

/// Why `decide` applied nothing.
#[derive(Debug, PartialEq)]
enum Refusal {
    /// A rejection, stored with the receipt.
    Rejected(ErrorObject),
    /// Not yet: `project.delete` with runs left, which it deletes first. Stores nothing.
    Busy(Vec<Uuid>),
}

/// A side effect, stored as a row until it has run.
#[derive(Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all_fields = "camelCase")]
enum Effect {
    /// A deleted thread's worktree and branch, and a thread with no repo's scratch repository
    /// and context folder.
    #[serde(rename = "thread.cleanup")]
    ThreadCleanup {
        worktree: Option<Removal>,
        scratch: bool,
    },
    /// A deleted Project's integration and coordinator worktrees and its context folder.
    #[serde(rename = "project.cleanup")]
    ProjectCleanup { repo_path: String },
    /// A scheduled task's fire or a pull request watch's news, sent to a thread (0063).
    #[serde(rename = "thread.wake")]
    Wake(crate::schedules::Wake),
    /// A Stop's cascade (T3 Code's `delegated-tasks.stop`): stops the threads a stopped thread
    /// started, each with its queue held and its own children after it.
    #[serde(rename = "delegated-tasks.stop")]
    DelegatedTasksStop { children: Vec<RunId> },
    /// A thread settled: its repository's settle script runs in its worktree (PLX-650).
    #[serde(rename = "settle-script.run")]
    SettleScript,
}

impl Effect {
    fn kind(&self) -> &'static str {
        match self {
            Self::ThreadCleanup { .. } => THREAD_CLEANUP,
            Self::ProjectCleanup { .. } => PROJECT_CLEANUP,
            Self::Wake(_) => THREAD_WAKE,
            Self::DelegatedTasksStop { .. } => DELEGATED_TASKS_STOP,
            Self::SettleScript => SETTLE_SCRIPT,
        }
    }
}

/// Enqueues `wake` as command `command_id`'s one effect, in `thread`'s lane and `db`'s
/// transaction (0063). Call [`Orchestrator::notify`] once the job commits.
pub(crate) fn enqueue_wake(
    db: &Tx,
    command_id: &str,
    thread: Uuid,
    wake: crate::schedules::Wake,
) -> Result<(), ErrorObject> {
    let effect = Effect::Wake(wake);
    db.enqueue_effect(&NewEffect {
        id: format!("{command_id}/0"),
        command_id: command_id.to_owned(),
        thread_id: thread,
        kind: effect.kind().to_owned(),
        payload: serde_json::to_string(&effect).map_err(ErrorObject::internal_error)?,
    })
    .map_err(|e| store_error(&e))
}

/// A worktree to remove, with its branch.
#[derive(Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Removal {
    repo_path: String,
    path: String,
    branch: String,
}

/// What the commit job did.
enum Committed {
    Done {
        rows: Box<ThreadRows>,
        effects: bool,
    },
    Busy(Vec<Uuid>),
    Rejected(ErrorObject),
}

/// The command's job on the writer: see the module documentation.
fn commit(db: &mut Tx, command: Command) -> Result<Committed, ErrorObject> {
    let Command { id, thread, action } = command;
    let kind = action.kind();
    if let Some(receipt) = db.orchestration_receipt(&id).map_err(|e| store_error(&e))? {
        return replay(db, &receipt, thread, kind);
    }
    let rows = read(db, thread, &action)?;
    let decision = match decide(thread, action, rows) {
        Ok(decision) => decision,
        Err(Refusal::Busy(runs)) => return Ok(Committed::Busy(runs)),
        Err(Refusal::Rejected(error)) => {
            let stored = serde_json::to_string(&error).map_err(ErrorObject::internal_error)?;
            db.insert_orchestration_receipt(&OrchestrationReceipt {
                command_id: id,
                thread_id: thread,
                kind: kind.to_owned(),
                result_seq: None,
                error: Some(stored),
            })
            .map_err(|e| store_error(&e))?;
            return Ok(Committed::Rejected(error));
        }
    };
    db.command_id = Some(id.clone());
    for change in decision.changes {
        apply(db, thread, change)?;
    }
    db.insert_orchestration_receipt(&OrchestrationReceipt {
        command_id: id.clone(),
        thread_id: thread,
        kind: kind.to_owned(),
        result_seq: db.last_staged(),
        error: None,
    })
    .map_err(|e| store_error(&e))?;
    for (index, effect) in decision.effects.iter().enumerate() {
        db.enqueue_effect(&NewEffect {
            id: format!("{id}/{index}"),
            command_id: id.clone(),
            thread_id: thread,
            kind: effect.kind().to_owned(),
            payload: serde_json::to_string(effect).map_err(ErrorObject::internal_error)?,
        })
        .map_err(|e| store_error(&e))?;
    }
    Ok(Committed::Done {
        rows: Box::new(thread_rows(db, thread)?),
        effects: !decision.effects.is_empty(),
    })
}

/// A command whose receipt exists: its stored rejection, or the thread's rows now.
fn replay(
    db: &Tx,
    receipt: &OrchestrationReceipt,
    thread: Uuid,
    kind: &str,
) -> Result<Committed, ErrorObject> {
    if receipt.thread_id != thread || receipt.kind != kind {
        return Err(ErrorObject::parallax(
            ErrorKind::IdConflict,
            format!(
                "command {} was already used for {} on {}",
                receipt.command_id, receipt.kind, receipt.thread_id
            ),
        ));
    }
    if let Some(error) = &receipt.error {
        return Ok(Committed::Rejected(
            serde_json::from_str(error).map_err(ErrorObject::internal_error)?,
        ));
    }
    Ok(Committed::Done {
        rows: Box::new(thread_rows(db, thread)?),
        effects: false,
    })
}

fn thread_rows(db: &Tx, id: Uuid) -> Result<ThreadRows, ErrorObject> {
    let error = |error| store_error(&error);
    Ok(ThreadRows {
        run: db.get_run(id).map_err(error)?,
        worktree: db.get_worktree(id).map_err(error)?,
        thread: db.get_thread(id).map_err(error)?,
    })
}

/// Reads what `decide` needs for `action` on `thread`.
fn read(db: &Tx, thread: Uuid, action: &Action) -> Result<Rows, ErrorObject> {
    let error = |error| store_error(&error);
    let mut rows = Rows::default();
    match action {
        Action::Create(new) => {
            let scope = new.fields.project_id;
            rows.thread.run = db.get_run(thread).map_err(error)?;
            rows.scope = db.get_project(scope).map_err(error)?.is_some()
                || db.get_repo(scope).map_err(error)?.is_some();
        }
        Action::Archive(_) | Action::Update(_) => {
            rows.thread.thread = db.get_thread(thread).map_err(error)?;
        }
        Action::Delete { .. } => {
            rows.thread.run = db.get_run(thread).map_err(error)?;
            rows.thread.thread = db.get_thread(thread).map_err(error)?;
            if let Some(row) = &rows.thread.thread {
                rows.scratch = db
                    .get_repo(row.repo_id)
                    .map_err(error)?
                    .is_some_and(|repo| repo.fields.scratch);
            }
            rows.children = db
                .list_threads()
                .map_err(error)?
                .into_iter()
                .filter(|row| {
                    row.parent == Some(thread)
                        || row
                            .fields
                            .forked_from
                            .is_some_and(|from| from.run == thread)
                })
                .map(|row| row.id)
                .collect();
        }
        Action::DeleteProject => {
            rows.project = db
                .get_project(thread)
                .map_err(error)?
                .map(|project| project.repo_path);
            let mut runs = db.list_runs(Some(thread)).map_err(error)?;
            // A coordinator's thread is its own run (0024): it goes first, so it starts no more.
            runs.sort_by_key(|run| run.fields.coordinator_thread != Some(run.id));
            rows.runs = runs.into_iter().map(|run| run.id).collect();
        }
    }
    Ok(rows)
}

/// Decides what `action` does to `thread`, from `rows` alone.
fn decide(thread: Uuid, action: Action, rows: Rows) -> Result<Decision, Refusal> {
    let rejected = |kind, message: String| Refusal::Rejected(ErrorObject::parallax(kind, message));
    let thread_not_found = || {
        rejected(
            ErrorKind::ThreadNotFound,
            format!("no thread has run id {thread}"),
        )
    };
    let change = |change| Decision {
        changes: vec![change],
        effects: Vec::new(),
    };
    match action {
        Action::Create(new) => {
            if rows.thread.run.is_some() {
                return Err(rejected(
                    ErrorKind::IdConflict,
                    format!("run {thread} exists"),
                ));
            }
            if !rows.scope {
                let scope = new.fields.project_id;
                return Err(rejected(
                    ErrorKind::ProjectNotFound,
                    format!("no project has id {scope}"),
                ));
            }
            Ok(change(Change::Create(new)))
        }
        Action::Archive(archived) => {
            let row = rows.thread.thread.ok_or_else(thread_not_found)?;
            if row.archived == archived {
                return Ok(Decision::default());
            }
            Ok(change(Change::Archive(archived)))
        }
        Action::Update(update) => {
            let row = rows.thread.thread.ok_or_else(thread_not_found)?;
            let update = ThreadUpdate {
                seen: update.seen,
                snoozed_until: update
                    .snoozed_until
                    .filter(|until| row.snoozed_until != Some(*until)),
                title: update.title.filter(|title| *title != row.fields.title),
                settled: update.settled.filter(|settled| *settled != row.settled),
            };
            if update == ThreadUpdate::default() {
                return Ok(Decision::default());
            }
            let settled = update.settled == Some(true);
            let mut decision = change(Change::Update(update));
            // A thread that settles runs its settle script (PLX-650).
            decision
                .effects
                .extend(settled.then_some(Effect::SettleScript));
            Ok(decision)
        }
        Action::Delete { worktree } => {
            if rows.thread.run.is_none() && rows.thread.thread.is_none() {
                return Err(rejected(
                    ErrorKind::RunNotFound,
                    format!("no run has id {thread}"),
                ));
            }
            let worktree = worktree.map(|worktree| Removal {
                repo_path: worktree.repo_path,
                path: worktree.path,
                branch: worktree.branch,
            });
            let effects = if worktree.is_some() || rows.scratch {
                vec![Effect::ThreadCleanup {
                    worktree,
                    scratch: rows.scratch,
                }]
            } else {
                Vec::new()
            };
            Ok(Decision {
                changes: vec![Change::Delete {
                    repo: rows.thread.thread.map(|row| row.repo_id),
                    children: rows.children,
                }],
                effects,
            })
        }
        Action::DeleteProject => {
            let Some(repo_path) = rows.project else {
                return Err(rejected(
                    ErrorKind::ProjectNotFound,
                    format!("no project has id {thread}"),
                ));
            };
            if !rows.runs.is_empty() {
                return Err(Refusal::Busy(rows.runs));
            }
            Ok(Decision {
                changes: vec![Change::DeleteProject],
                effects: vec![Effect::ProjectCleanup { repo_path }],
            })
        }
    }
}

/// Applies `change` to `thread`'s rows and stages its events.
fn apply(db: &mut Tx, thread: Uuid, change: Change) -> Result<(), ErrorObject> {
    let error = |error| store_error(&error);
    match change {
        Change::Create(new) => {
            let NewRows {
                fields,
                state,
                worktree,
                thread: fields_of_thread,
            } = *new;
            let (run, worktree, row) = if let Some(thread_fields) = &fields_of_thread {
                let (row, run, worktree) = db
                    .create_thread_run(
                        thread,
                        fields.project_id,
                        &fields,
                        &state,
                        worktree.as_ref(),
                        thread_fields,
                    )
                    .map_err(error)?;
                (run, worktree, Some(row))
            } else {
                let worktree = worktree
                    .ok_or_else(|| ErrorObject::internal_error("a worker has no worktree"))?;
                let (run, worktree) = db
                    .create_run_with_worktree(thread, &fields, &state, &worktree)
                    .map_err(error)?;
                (run, Some(worktree), None)
            };
            crate::agents::stage_started(db, &run, worktree.as_ref())?;
            if let Some(row) = &row {
                crate::threads::stage_started(db, row)?;
            }
        }
        Change::Archive(archived) => {
            let row = db.set_thread_archived(thread, archived).map_err(error)?;
            stage_updated(db, &row)?;
        }
        Change::Update(update) => {
            let (row, _) = db.update_thread(thread, &update).map_err(error)?;
            stage_updated(db, &row)?;
        }
        Change::Delete { repo, children } => {
            if let Some(repo) = repo {
                db.delete_thread(thread).map_err(error)?;
                let run_id = RunId::try_from(thread).map_err(|_| corrupt(thread))?;
                let repo = RepoId::try_from(repo).map_err(|_| corrupt(thread))?;
                db.stage(
                    Timestamp::now(),
                    None,
                    ParallaxEvent::ThreadDeleted { run_id, repo },
                );
            } else {
                db.delete_run(thread).map_err(error)?;
            }
            for child in children {
                if let Some(row) = db.get_thread(child).map_err(error)? {
                    stage_updated(db, &row)?;
                }
            }
        }
        Change::DeleteProject => {
            db.delete_project(thread).map_err(error)?;
            let project = ProjectId::try_from(thread).map_err(|_| corrupt(thread))?;
            db.stage(
                Timestamp::now(),
                None,
                ParallaxEvent::ProjectDeleted { project },
            );
        }
    }
    Ok(())
}

fn stage_updated(db: &mut Tx, row: &Thread) -> Result<(), ErrorObject> {
    let thread = crate::threads::thread_entry(row)?;
    db.stage(
        Timestamp::now(),
        None,
        ParallaxEvent::ThreadUpdated { thread },
    );
    Ok(())
}

fn corrupt(id: Uuid) -> ErrorObject {
    ErrorObject::internal_error(format!("the stored id {id} is not a UUIDv7"))
}

/// A `thread/delete` or `project/delete` retry whose command committed already: `true` when it
/// was accepted, its stored error when rejected, and `idConflict` when the id was used for
/// another thread or type. Read before the method asks an actor anything.
pub(crate) async fn replayed(
    daemon: &Daemon,
    command_id: Option<Uuid>,
    thread: impl Into<Uuid>,
    kind: &'static str,
) -> Result<bool, ErrorObject> {
    let Some(command_id) = command_id else {
        return Ok(false);
    };
    let thread = thread.into();
    let id = command_id.hyphenated().to_string();
    let receipt = daemon
        .reader
        .run(&CancellationToken::new(), move |db| {
            db.orchestration_receipt(&id).map_err(|e| store_error(&e))
        })
        .await?;
    let Some(receipt) = receipt else {
        return Ok(false);
    };
    if receipt.thread_id != thread || receipt.kind != kind {
        return Err(ErrorObject::parallax(
            ErrorKind::IdConflict,
            format!(
                "command {command_id} was already used for {} on {}",
                receipt.kind, receipt.thread_id
            ),
        ));
    }
    match receipt.error {
        Some(error) => Err(serde_json::from_str(&error).map_err(ErrorObject::internal_error)?),
        None => Ok(true),
    }
}

/// The receipt type of `thread/delete`'s command, for [`replayed`].
pub(crate) const THREAD_DELETE: &str = "thread.delete";

/// The receipt type of `project/delete`'s command, for [`replayed`].
pub(crate) const PROJECT_DELETE: &str = "project.delete";

/// Start-up recovery, before the worker starts: see the module documentation.
pub(crate) async fn recover(daemon: &Daemon) -> Result<(), ErrorObject> {
    let (requeued, cancelled) = daemon
        .store
        .run(&CancellationToken::new(), |db| {
            db.recover_effects(REPLAY_SAFE).map_err(|e| store_error(&e))
        })
        .await?;
    if requeued + cancelled > 0 {
        info!(
            requeued,
            cancelled, "recovered the effects a restart interrupted"
        );
    }
    Ok(())
}

/// The effect worker: see the module documentation. Returns when `stop` is cancelled, leaving
/// the effects it was running for the next start to replay.
pub(crate) async fn work(daemon: Arc<Daemon>, stop: CancellationToken) {
    let mut running = JoinSet::new();
    loop {
        let free = MAX_RUNNING - running.len();
        let claimed = daemon
            .store
            .run(&CancellationToken::new(), move |db| {
                let claimed = db
                    .claim_effects(Timestamp::now(), free)
                    .map_err(|e| store_error(&e))?;
                let next = db.next_effect_at().map_err(|e| store_error(&e))?;
                Ok((claimed, next))
            })
            .await;
        let mut wait = None;
        match claimed {
            Ok((claimed, next)) => {
                for effect in claimed {
                    running.spawn(run_one(Arc::clone(&daemon), effect));
                }
                // With every slot taken, the next available effect waits for one to end.
                if running.len() < MAX_RUNNING {
                    wait = next.map(|at| {
                        Duration::try_from(at.duration_since(Timestamp::now())).unwrap_or_default()
                    });
                }
            }
            Err(error) => warn!(error = %error.message, "could not claim effects"),
        }
        tokio::select! {
            () = stop.cancelled() => return,
            () = daemon.orchestrator.wake.notified() => {}
            Some(_) = running.join_next(), if !running.is_empty() => {}
            () = tokio::time::sleep(wait.unwrap_or_default()), if wait.is_some() => {}
        }
    }
}

/// Runs one claimed effect, then records how it ended in its thread's lane. A failure that used
/// its last attempt is logged and stays as a `failed` row.
async fn run_one(daemon: Arc<Daemon>, claimed: ClaimedEffect) {
    let ran = match serde_json::from_str::<Effect>(&claimed.payload) {
        Ok(effect) => perform(&daemon, &claimed.id, claimed.thread_id, effect).await,
        Err(error) => Err((format!("plxd can't read this effect: {error}"), true)),
    };
    let outcome = match ran {
        Ok(()) => EffectOutcome::Succeeded,
        Err((error, last)) if last || claimed.attempts >= MAX_ATTEMPTS => {
            warn!(effect = %claimed.id, kind = %claimed.kind, %error, "an effect failed");
            EffectOutcome::Failed { error }
        }
        Err((error, _)) => {
            let delay = BACKOFF
                .saturating_mul(1 << (claimed.attempts - 1).min(16))
                .min(MAX_BACKOFF);
            EffectOutcome::Retry {
                error,
                at: Timestamp::now() + delay,
            }
        }
    };
    let _lane = daemon.orchestrator.lane(claimed.thread_id).await;
    let id = claimed.id;
    let finished = daemon
        .store
        .run(&CancellationToken::new(), move |db| {
            db.finish_effect(&id, &outcome).map_err(|e| store_error(&e))
        })
        .await;
    if let Err(error) = finished {
        warn!(error = %error.message, "could not record how an effect ended");
    }
}

/// Does `effect`, effect `id`, for `thread`. An error says whether it is final; any other is
/// retried.
async fn perform(
    daemon: &Arc<Daemon>,
    id: &str,
    thread: Uuid,
    effect: Effect,
) -> Result<(), (String, bool)> {
    match effect {
        Effect::ThreadCleanup { worktree, scratch } => {
            if let Some(Removal {
                repo_path,
                path,
                branch,
            }) = worktree
            {
                let removed = daemon
                    .agents
                    .worktrees()
                    .remove(Path::new(&repo_path), Path::new(&path), &branch)
                    .await;
                // A replay after the folder went has nothing left to remove.
                if let Err(error) = removed
                    && Path::new(&path).exists()
                {
                    return Err((format!("could not remove the worktree: {error}"), false));
                }
            }
            if scratch {
                let run_id =
                    RunId::try_from(thread).map_err(|_| (corrupt(thread).message, true))?;
                crate::threads::remove_scratch_and_context(daemon, run_id);
            }
            Ok(())
        }
        Effect::ProjectCleanup { repo_path } => {
            let project =
                ProjectId::try_from(thread).map_err(|_| (corrupt(thread).message, true))?;
            let worktrees = daemon.agents.worktrees();
            worktrees
                .remove_integration(Path::new(&repo_path), project)
                .await
                .map_err(|error| {
                    (
                        format!("could not remove the integration worktree: {error}"),
                        false,
                    )
                })?;
            worktrees
                .remove_coordinator(Path::new(&repo_path), project)
                .await
                .map_err(|error| {
                    (
                        format!("could not remove the coordinator's worktree: {error}"),
                        false,
                    )
                })?;
            crate::threads::remove_context(daemon, project);
            Ok(())
        }
        Effect::Wake(wake) => {
            crate::schedules::deliver(daemon, wake).await;
            Ok(())
        }
        Effect::SettleScript => {
            crate::setup_scripts::settled(daemon, thread).await;
            Ok(())
        }
        Effect::DelegatedTasksStop { children } => {
            for child in children {
                // A thread gone since, or one that stopped already, is stopped.
                let Ok(cascade) = dispatch::stop(daemon, child, true).await else {
                    continue;
                };
                let Some(grandchildren) = cascade else {
                    continue;
                };
                let effect = dispatch::stop_effect(&format!("{id}/{child}"), child, grandchildren)
                    .map_err(|error| (error.message, true))?;
                daemon
                    .store
                    .run(&CancellationToken::new(), move |db| {
                        db.enqueue_effect(&effect).map_err(|e| store_error(&e))
                    })
                    .await
                    .map_err(|error| (error.message, false))?;
                daemon.orchestrator.notify();
            }
            Ok(())
        }
    }
}

mod dispatch;
pub(crate) use dispatch::dispatch as dispatch_command;

#[cfg(test)]
mod tests;
