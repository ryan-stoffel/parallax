//! The project store, on a thread of its own, and the mapping between its rows and the
//! protocol's types.
//!
//! SQLite calls block, so one thread owns [`parallax_store::Store`]'s write connection and runs
//! the jobs that requests send it, one at a time. It is the only writer, of rows and events alike
//! (0052). Each job runs in one `BEGIN IMMEDIATE` … `COMMIT` and gets a [`Tx`], which reads and
//! writes rows and stages events: [`Tx::stage`] gives an event the next `seq` and inserts its row.
//! After `COMMIT`, the thread publishes the staged events to the event log's in-memory window, in
//! `seq` order, and then replies. A job that returns an error, fails to stage, or panics rolls
//! back: nothing is published, and the `seq` counter goes back to where it was. So a row and its
//! event are stored together or not at all, and subscribers never see an event that didn't commit.
//!
//! Lists and search run on a second handle, the daemon's `reader` (PLX-457): its own thread and a
//! `query_only` connection, which WAL lets read while the writer writes, so a slow search never
//! holds up a write. A list that clients subscribe after reads the event log's head before its
//! rows ([`StoreHandle::snapshot`]). A write's event is published only after its rows commit, so a
//! write the read misses has an event after that head, which `events/subscribe` replays. A write
//! the read already saw can be replayed too; the app's reducers are upserts, so that's harmless.
//!
//! A job whose request is cancelled is skipped if it hasn't started. Once it has started, it runs
//! to the end and the request gets its real result, so -32800 always means nothing was done.

use std::ops::{Deref, DerefMut};
use std::panic::{AssertUnwindSafe, catch_unwind};
use std::path::Path;
use std::sync::atomic::{AtomicU8, AtomicU64, Ordering};
use std::sync::mpsc;
use std::sync::{Arc, Mutex, PoisonError};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

use jiff::Timestamp;
use parallax_protocol::jsonrpc::ErrorObject;
use parallax_protocol::{
    AccountChoice, AccountId, ErrorKind, ImageMediaType, KeyAccount, ParallaxEvent, Project,
    ProjectAutonomy, ProjectCreateParams, ProjectIcon, ProjectId, ProjectPermission,
    ProjectUpdateParams, PromptImage, Provider, QueueStats, Role, RunId, StoreState,
};
use parallax_store::{
    AccountFields, ProjectEdit, ProjectFields, RoleDefault, Store, StoreError, StoredEvent,
    StoredImage,
};
use tokio::sync::oneshot;
use tokio_util::sync::CancellationToken;
use tracing::{error, info, warn};
use uuid::Uuid;

use crate::agents::convert::{option_name, option_value};
use crate::event_log::{Entry, EventLog, kind_of, run_of};
use crate::repo;

const QUEUED: u8 = 0;
const STARTED: u8 = 1;
const CANCELLED: u8 = 2;

type Job = Box<dyn FnOnce(&mut Tx) + Send>;

enum Message {
    /// A job and when it was sent.
    Job(Instant, Job),
    Stop,
}

/// Counts and times the jobs of a queue that one thread works through in order, for `host/health`
/// (PLX-445). The store and its reader each keep one.
#[derive(Default)]
pub(crate) struct QueueCounters {
    queued: AtomicU64,
    jobs: AtomicU64,
    max_wait: AtomicU64,
    total_wait: AtomicU64,
    max_run: AtomicU64,
    total_run: AtomicU64,
}

impl QueueCounters {
    /// Call before sending a job, so the thread can't start it before it is counted.
    pub fn sending(&self) {
        self.queued.fetch_add(1, Ordering::Relaxed);
    }

    /// Call when sending a job failed, so it never runs.
    pub fn unsent(&self) {
        self.queued.fetch_sub(1, Ordering::Relaxed);
    }

    /// Runs a job the thread took off the queue, sent at `sent`, and records its wait and run time.
    pub fn run<T>(&self, sent: Instant, job: impl FnOnce() -> T) -> T {
        let started = Instant::now();
        let wait = micros(started - sent);
        self.queued.fetch_sub(1, Ordering::Relaxed);
        self.jobs.fetch_add(1, Ordering::Relaxed);
        self.max_wait.fetch_max(wait, Ordering::Relaxed);
        self.total_wait.fetch_add(wait, Ordering::Relaxed);
        let result = job();
        let run = micros(started.elapsed());
        self.max_run.fetch_max(run, Ordering::Relaxed);
        self.total_run.fetch_add(run, Ordering::Relaxed);
        result
    }

    /// The figures now. Each is read on its own, so they can be a job apart.
    pub fn stats(&self) -> QueueStats {
        QueueStats {
            queued: self.queued.load(Ordering::Relaxed),
            jobs: self.jobs.load(Ordering::Relaxed),
            max_wait_micros: self.max_wait.load(Ordering::Relaxed),
            total_wait_micros: self.total_wait.load(Ordering::Relaxed),
            max_run_micros: self.max_run.load(Ordering::Relaxed),
            total_run_micros: self.total_run.load(Ordering::Relaxed),
        }
    }
}

fn micros(duration: Duration) -> u64 {
    u64::try_from(duration.as_micros()).unwrap_or(u64::MAX)
}

/// What a store job works with: the connection, through `Deref`, and [`Tx::stage`] for events.
/// Owned by the store's thread, which keeps it between jobs.
pub(crate) struct Tx {
    store: Store,
    /// The event log, on the writer. `None` on the reader, which never stages or opens a
    /// transaction.
    log: Option<Arc<EventLog>>,
    /// The newest `seq` staged, committed or not. Only this thread changes it.
    seq: u64,
    /// The `seq` before the open transaction, to go back to on rollback; `None` when none is open.
    begun: Option<u64>,
    staged: Vec<Entry>,
    /// Whether staging failed, which rolls the job back however it ends.
    failed: bool,
    /// The orchestrator command this job commits, which tags the events it stages (0059).
    pub command_id: Option<String>,
}

impl Deref for Tx {
    type Target = Store;

    fn deref(&self) -> &Store {
        &self.store
    }
}

impl DerefMut for Tx {
    fn deref_mut(&mut self) -> &mut Store {
        &mut self.store
    }
}

impl Tx {
    fn new(store: Store, log: Option<Arc<EventLog>>) -> Self {
        let seq = log.as_ref().map_or(0, |log| log.head());
        Self {
            store,
            log,
            seq,
            begun: None,
            staged: Vec::new(),
            failed: false,
            command_id: None,
        }
    }

    /// Stores `event` in this job's transaction with the next `seq`, and returns it. The event is
    /// published once the job commits. If it can't be stored, the job rolls back and fails. It is
    /// serialized once, here: the row, the in-memory window, and every subscriber's frame use
    /// that JSON (0059).
    pub fn stage(
        &mut self,
        time: Timestamp,
        project: Option<ProjectId>,
        event: ParallaxEvent,
    ) -> u64 {
        let Some(log) = &self.log else {
            error!("a job on the store's reader tried to stage an event");
            self.failed = true;
            return 0;
        };
        self.seq += 1;
        let seq = self.seq;
        let run_id = run_of(&event);
        let json = match serde_json::value::to_raw_value(&event) {
            Ok(json) => json,
            Err(error) => {
                error!(seq, %error, "could not serialize an event; its job rolls back");
                self.failed = true;
                return seq;
            }
        };
        let stored = StoredEvent {
            seq,
            time,
            project_id: project.map(Uuid::from),
            thread_id: run_id.map(Uuid::from),
            kind: kind_of(json.get()).to_owned(),
            payload: json.get().to_owned(),
            command_id: self.command_id.clone(),
        };
        match self.store.append_event(&stored) {
            Err(error) => {
                error!(seq, %error, "could not store an event; its job rolls back");
                self.failed = true;
            }
            // Only a host or project event can grow past the retention this way (#187). Pruning
            // is housekeeping, so its failure doesn't fail the write.
            Ok(()) if run_id.is_none() => {
                if let Err(error) = self.store.prune_host_events(log.host_retention()) {
                    warn!(%error, "could not prune host and project events");
                }
            }
            Ok(()) => {}
        }
        self.staged.push(Entry {
            seq,
            time,
            project,
            event,
            json,
            compacted_from: None,
        });
        seq
    }

    /// The newest `seq` this job staged, if it staged any.
    pub fn last_staged(&self) -> Option<u64> {
        self.staged.last().map(|entry| entry.seq)
    }

    /// Runs `job` in one transaction on the writer, and publishes what it staged once that
    /// commits. On the reader it just runs `job`.
    fn write<T>(
        &mut self,
        job: impl FnOnce(&mut Self) -> Result<T, ErrorObject>,
    ) -> Result<T, ErrorObject> {
        if self.log.is_none() {
            return job(self);
        }
        if let Err(error) = self.store.begin() {
            return Err(failed(&error));
        }
        self.begun = Some(self.seq);
        let result = match job(self) {
            Ok(_) if self.failed => Err(ErrorObject::internal_error(
                "the project store could not store an event",
            )),
            Ok(value) => match self.store.commit() {
                Ok(()) => {
                    self.begun = None;
                    self.command_id = None;
                    let staged = std::mem::take(&mut self.staged);
                    if let Some(log) = &self.log {
                        log.publish(staged);
                    }
                    return Ok(value);
                }
                Err(error) => Err(failed(&error)),
            },
            Err(error) => Err(error),
        };
        self.roll_back();
        result
    }

    /// Rolls back a transaction a job left open, by an error or a panic: drops what it staged and
    /// puts the `seq` counter back.
    fn roll_back(&mut self) {
        if let Some(seq) = self.begun.take() {
            self.seq = seq;
        }
        self.staged.clear();
        self.failed = false;
        self.command_id = None;
        if let Err(error) = self.store.rollback() {
            error!(%error, "could not roll back a store job");
        }
    }
}

fn failed(error: &StoreError) -> ErrorObject {
    error!(%error, "the project store failed");
    ErrorObject::internal_error(format!("the project store failed: {error}"))
}

pub(crate) struct StoreHandle {
    state: State,
    counters: Arc<QueueCounters>,
    /// The event log the writer stages into, which lives in memory only when the store is
    /// unavailable.
    log: Arc<EventLog>,
}

enum State {
    Open {
        jobs: mpsc::Sender<Message>,
        thread: Mutex<Option<JoinHandle<()>>>,
    },
    Unavailable,
}

impl StoreHandle {
    /// Opens the store at `path`, loads its event log (see [`EventLog::load`] for the bounds), and
    /// starts its thread. If it can't be opened, plxd keeps running without it: `host/health` says
    /// so, project methods fail, and the event log runs in memory only, with a new `logId`.
    pub fn open(path: &Path, retention: usize, max_bytes: usize, host_retention: usize) -> Self {
        // Opening applies pending migrations first, which can take seconds on a large store:
        // migration 36 indexes every message logged so far (PLX-487).
        info!(path = %path.display(), "opening the project store and applying any migrations");
        let started = Instant::now();
        let store = Store::open(path);
        info!(
            elapsed_ms = started.elapsed().as_millis(),
            "applied the project store's migrations"
        );
        let opened = store.and_then(|store| {
            let log = EventLog::load(&store, path, retention, max_bytes, host_retention)?;
            Ok((store, Arc::new(log)))
        });
        let memory = || Arc::new(EventLog::new_bounded(retention, max_bytes));
        match opened {
            Ok((store, log)) => Self::start(
                path,
                Tx::new(store, Some(Arc::clone(&log))),
                "plxd-store",
                log,
            )
            .unwrap_or_else(|| Self::unavailable(memory())),
            Err(error) => {
                error!(path = %path.display(), %error, "could not open the project store; keeping events in memory only");
                Self::unavailable(memory())
            }
        }
    }

    /// Opens a read-only connection to this store's file at `path`, on a thread of its own: the
    /// daemon's `reader`, for lists, search, and other pure reads. Unavailable when this store is, so a database this
    /// build can't migrate (a newer schema, say) is never read either.
    // ponytail: one read thread, so reads queue behind each other; a pool if that shows up.
    pub fn open_reader(&self, path: &Path) -> Self {
        let log = Arc::clone(&self.log);
        if self.state() != StoreState::Ok {
            return Self::unavailable(log);
        }
        match Store::open_read_only(path) {
            Ok(store) => Self::start(
                path,
                Tx::new(store, None),
                "plxd-store-read",
                Arc::clone(&log),
            )
            .unwrap_or_else(|| Self::unavailable(log)),
            Err(error) => {
                error!(path = %path.display(), %error, "could not open the project store's reader");
                Self::unavailable(log)
            }
        }
    }

    fn start(path: &Path, tx: Tx, name: &str, log: Arc<EventLog>) -> Option<Self> {
        let (jobs, queue) = mpsc::channel();
        let counters = Arc::new(QueueCounters::default());
        let thread_counters = Arc::clone(&counters);
        let spawned = thread::Builder::new()
            .name(name.to_owned())
            .spawn(move || run(tx, &queue, &thread_counters));
        match spawned {
            Ok(thread) => {
                info!(path = %path.display(), name, "opened the project store");
                Some(Self {
                    state: State::Open {
                        jobs,
                        thread: Mutex::new(Some(thread)),
                    },
                    counters,
                    log,
                })
            }
            Err(error) => {
                error!(%error, name, "could not start the project store's thread");
                None
            }
        }
    }

    fn unavailable(log: Arc<EventLog>) -> Self {
        Self {
            state: State::Unavailable,
            counters: Arc::default(),
            log,
        }
    }

    /// The event log this store writes.
    pub fn log(&self) -> Arc<EventLog> {
        Arc::clone(&self.log)
    }

    /// The job queue's figures for `host/health`, all zero for a store that is unavailable.
    pub fn queue_stats(&self) -> QueueStats {
        self.counters.stats()
    }

    pub fn state(&self) -> StoreState {
        let State::Open { thread, .. } = &self.state else {
            return StoreState::Unavailable;
        };
        let running = thread
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .as_ref()
            .is_some_and(|thread| !thread.is_finished());
        if running {
            StoreState::Ok
        } else {
            StoreState::Unavailable
        }
    }

    /// Runs `job` on the store's thread, in one transaction, and returns its result, or an error
    /// for a request that was cancelled before the job started, or a store that is unavailable.
    pub async fn run<T: Send + 'static>(
        &self,
        cancel: &CancellationToken,
        job: impl FnOnce(&mut Tx) -> Result<T, ErrorObject> + Send + 'static,
    ) -> Result<T, ErrorObject> {
        let State::Open { jobs, .. } = &self.state else {
            return Err(unavailable());
        };
        let status = Arc::new(AtomicU8::new(QUEUED));
        let (reply, mut result) = oneshot::channel();
        let job_status = Arc::clone(&status);
        let job_cancel = cancel.clone();
        // The job checks the token itself too, so it is skipped even when the request's task
        // was aborted and nobody is waiting for it.
        let job: Job = Box::new(move |tx| {
            if job_cancel.is_cancelled() {
                job_status.store(CANCELLED, Ordering::Release);
                return;
            }
            if job_status
                .compare_exchange(QUEUED, STARTED, Ordering::AcqRel, Ordering::Acquire)
                .is_ok()
            {
                let _ = reply.send(tx.write(job));
            }
        });
        self.counters.sending();
        if jobs.send(Message::Job(Instant::now(), job)).is_err() {
            self.counters.unsent();
            return Err(unavailable());
        }
        let finished = tokio::select! {
            biased;
            finished = &mut result => finished,
            () = cancel.cancelled() => {
                match status.compare_exchange(QUEUED, CANCELLED, Ordering::AcqRel, Ordering::Acquire) {
                    Ok(_) | Err(CANCELLED) => return Err(ErrorObject::request_cancelled()),
                    Err(_) => (&mut result).await,
                }
            }
        };
        finished.unwrap_or_else(|_| {
            if status.load(Ordering::Acquire) == CANCELLED {
                Err(ErrorObject::request_cancelled())
            } else {
                Err(unavailable())
            }
        })
    }

    /// Stores and publishes one event in a job of its own, and returns its `seq`. With the store
    /// unavailable, the event goes to the in-memory log. An event that can't be stored is logged
    /// and dropped, and the head is returned. For tests: plxd's own events go in their rows' jobs.
    #[cfg(test)]
    pub async fn append(
        &self,
        time: Timestamp,
        project: Option<ProjectId>,
        event: ParallaxEvent,
    ) -> u64 {
        if matches!(self.state, State::Unavailable) {
            return self.log.append_in_memory(time, project, event);
        }
        let appended = self
            .run(&CancellationToken::new(), move |tx| {
                Ok(tx.stage(time, project, event))
            })
            .await;
        appended.unwrap_or_else(|error| {
            warn!(error = %error.message, "could not append an event; it was dropped");
            self.log.head()
        })
    }

    /// Stores and publishes one event that has no row, in a job of its own, and returns its `seq`,
    /// for a caller with no tokio runtime context: the shared-context `notify` watcher's callback
    /// thread, and `context/write`'s blocking task. Blocks the calling thread until the job
    /// finishes. With the store unavailable, the event goes to the in-memory log. An event that
    /// can't be stored is logged and dropped, and the head is returned.
    pub fn append_blocking(
        &self,
        time: Timestamp,
        project: Option<ProjectId>,
        event: ParallaxEvent,
    ) -> u64 {
        if matches!(self.state, State::Unavailable) {
            return self.log.append_in_memory(time, project, event);
        }
        self.run_blocking(move |tx| Ok(tx.stage(time, project, event)))
            .unwrap_or_else(|error| {
                warn!(error = %error.message, "could not append an event; it was dropped");
                self.log.head()
            })
    }

    /// [`StoreHandle::run`] for a caller with no tokio runtime context, such as a blocking task.
    /// Blocks the calling thread until the job finishes. It can't be cancelled.
    pub fn run_blocking<T: Send + 'static>(
        &self,
        job: impl FnOnce(&mut Tx) -> Result<T, ErrorObject> + Send + 'static,
    ) -> Result<T, ErrorObject> {
        let State::Open { jobs, .. } = &self.state else {
            return Err(unavailable());
        };
        let (reply, result) = oneshot::channel();
        let job: Job = Box::new(move |tx| {
            let _ = reply.send(tx.write(job));
        });
        self.counters.sending();
        if jobs.send(Message::Job(Instant::now(), job)).is_err() {
            self.counters.unsent();
            return Err(unavailable());
        }
        result
            .blocking_recv()
            .unwrap_or_else(|_| Err(unavailable()))
    }

    /// [`StoreHandle::run`] for a list that clients subscribe after: returns `job`'s rows with the
    /// event log's head, read before the rows. A write that lands during the read then has its
    /// event after that `seq`, so a subscriber replays it.
    pub async fn snapshot<T: Send + 'static>(
        &self,
        cancel: &CancellationToken,
        job: impl FnOnce(&mut Tx) -> Result<T, ErrorObject> + Send + 'static,
    ) -> Result<(T, u64), ErrorObject> {
        let log = Arc::clone(&self.log);
        self.run(cancel, move |store| {
            let seq = log.head();
            Ok((job(store)?, seq))
        })
        .await
    }

    /// Stops the thread after the job it is running, and closes the database.
    pub async fn stop(&self) {
        let State::Open { jobs, thread } = &self.state else {
            return;
        };
        let _ = jobs.send(Message::Stop);
        let thread = thread.lock().unwrap_or_else(PoisonError::into_inner).take();
        if let Some(thread) = thread {
            let _ = tokio::task::spawn_blocking(move || thread.join()).await;
        }
    }
}

fn run(mut tx: Tx, queue: &mpsc::Receiver<Message>, counters: &QueueCounters) {
    while let Ok(Message::Job(sent, job)) = queue.recv() {
        // A panicking job drops its reply, which fails only its own request, and rolls back.
        let ran = counters.run(sent, || catch_unwind(AssertUnwindSafe(|| job(&mut tx))));
        if ran.is_err() {
            error!("a project store job panicked; rolling it back");
            if tx.log.is_some() {
                tx.roll_back();
            }
        }
    }
}

fn unavailable() -> ErrorObject {
    ErrorObject::internal_error("the project store is unavailable")
}

/// The protocol error for a store error.
pub(crate) fn store_error(error: &StoreError) -> ErrorObject {
    match error {
        StoreError::IdConflict { id } => ErrorObject::parallax(
            ErrorKind::IdConflict,
            format!("project {id} exists with a different name, repository, or icon"),
        ),
        StoreError::NotFound { id } => ErrorObject::parallax(
            ErrorKind::ProjectNotFound,
            format!("no project has id {id}"),
        ),
        other => {
            error!(error = %other, "the project store failed");
            ErrorObject::internal_error(format!("the project store failed: {other}"))
        }
    }
}

/// The store's id and fields for a `project/create`.
pub(crate) fn fields(params: ProjectCreateParams) -> (Uuid, ProjectFields) {
    (
        params.id.into(),
        ProjectFields {
            name: params.name,
            repo_path: params.repo_path,
            icon: params.icon.map(stored_icon),
            permission: stored_permission(params.permission.unwrap_or(ProjectPermission::Auto)),
            autonomy: option_name(params.autonomy.unwrap_or(ProjectAutonomy::Routine))
                .unwrap_or_default(),
            base_branch: params.base_branch,
        },
    )
}

/// The store's id and edit for a `project/update` (PLX-227).
pub(crate) fn edit(params: ProjectUpdateParams) -> (Uuid, ProjectEdit) {
    (
        params.project.into(),
        ProjectEdit {
            name: params.name,
            icon: params.icon.map(stored_icon),
            permission: params.permission.map(stored_permission),
            autonomy: params.autonomy.and_then(option_name),
            base_branch: params.base_branch,
            auto_land: params.auto_land,
            max_children: params.max_children,
            allow_api_keys: params.allow_api_keys,
            checks: params.checks,
            proposed_checks: params.proposed_checks,
        },
    )
}

/// A project's permission mode as the `projects.permission` column keeps it (0042).
fn stored_permission(permission: ProjectPermission) -> String {
    option_name(permission).unwrap_or_default()
}

/// A stored permission mode as the protocol's, [`ProjectPermission::Unknown`] for one this build
/// doesn't know.
pub(crate) fn project_permission(stored: &str) -> ProjectPermission {
    option_value(stored).unwrap_or(ProjectPermission::Unknown)
}

/// A stored autonomy level as the protocol's, [`ProjectAutonomy::Unknown`] for one this build
/// doesn't know (0043).
pub(crate) fn project_autonomy(stored: &str) -> ProjectAutonomy {
    option_value(stored).unwrap_or(ProjectAutonomy::Unknown)
}

/// A protocol icon as the store keeps it, a project's or a repo entry's alike.
pub(crate) fn stored_icon(icon: ProjectIcon) -> parallax_store::ProjectIcon {
    parallax_store::ProjectIcon {
        name: icon.name,
        color: icon.color,
        image: icon.image.map(|image| StoredImage {
            media_type: option_name(image.media_type).unwrap_or_default(),
            data: image.data,
        }),
    }
}

/// A stored icon as the protocol's, a project's or a repo entry's alike.
pub(crate) fn protocol_icon(icon: parallax_store::ProjectIcon) -> ProjectIcon {
    ProjectIcon {
        name: icon.name,
        color: icon.color,
        image: icon.image.map(|image| PromptImage {
            media_type: option_value(&image.media_type).unwrap_or(ImageMediaType::Unknown),
            data: image.data,
        }),
    }
}

/// A store row as the protocol's project, with the branch its repository has checked out now and
/// its coordinator run, if it has one (0024).
///
/// plxd writes only version 7 ids, so a row with another kind of id was written by something
/// else, and the request fails rather than hide the row.
pub(crate) fn project(
    row: parallax_store::Project,
    coordinator: Option<RunId>,
) -> Result<Project, ErrorObject> {
    let id = ProjectId::try_from(row.id).map_err(|_| {
        error!(id = %row.id, "a stored project's id is not a UUIDv7");
        ErrorObject::internal_error(format!("the stored project {} has an invalid id", row.id))
    })?;
    Ok(Project {
        id,
        name: row.name,
        icon: row.icon.map(protocol_icon),
        permission: Some(project_permission(&row.permission)),
        autonomy: Some(project_autonomy(&row.autonomy)),
        branch: repo::branch(Path::new(&row.repo_path)),
        repo_path: row.repo_path,
        coordinator,
        base_branch: row.base_branch,
        integration_branch: row.integration_branch,
        auto_land: row.auto_land,
        max_children: Some(row.max_children),
        allow_api_keys: Some(row.allow_api_keys),
        checks: row.checks,
        proposed_checks: row.proposed_checks,
        created_at: row.created_at,
        updated_at: row.updated_at,
    })
}

/// The protocol error for an accounts-table store error.
///
/// Unlike [`store_error`], a missing row is `accountNotFound`, not `projectNotFound`: the two
/// tables share [`StoreError`], but not its meaning.
pub(crate) fn account_store_error(error: &StoreError) -> ErrorObject {
    match error {
        StoreError::IdConflict { id } => ErrorObject::parallax(
            ErrorKind::IdConflict,
            format!("key account {id} exists with a different provider, label, or key"),
        ),
        StoreError::NotFound { id } => ErrorObject::parallax(
            ErrorKind::AccountNotFound,
            format!("no key account has id {id}"),
        ),
        other => {
            error!(error = %other, "the project store failed");
            ErrorObject::internal_error(format!("the project store failed: {other}"))
        }
    }
}

/// `provider`'s text for the `accounts.provider` column.
pub(crate) fn provider_text(provider: Provider) -> &'static str {
    match provider {
        Provider::Anthropic => "anthropic",
        Provider::Openai => "openai",
        Provider::Cursor => "cursor",
        Provider::Unknown => "unknown",
    }
}

/// A stored provider string as the protocol's [`Provider`]. Anything this build does not
/// recognize decodes as [`Provider::Unknown`], the same forward-compatibility rule the protocol
/// itself uses.
fn provider_from_text(text: &str) -> Provider {
    match text {
        "anthropic" => Provider::Anthropic,
        "openai" => Provider::Openai,
        "cursor" => Provider::Cursor,
        _ => Provider::Unknown,
    }
}

/// The store's fields for an `accounts/keys/add`, with `provider` as its stored text.
pub(crate) fn account_fields(
    provider: Provider,
    label: String,
    masked_key: String,
) -> AccountFields {
    AccountFields {
        provider: provider_text(provider).to_owned(),
        label,
        masked_key,
    }
}

/// `role`'s text for the `role_defaults.role` column.
pub(crate) fn role_text(role: Role) -> &'static str {
    match role {
        Role::Coordinator => "coordinator",
        Role::Worker => "worker",
    }
}

/// A stored [`RoleDefault`] as the protocol's [`AccountChoice`].
///
/// plxd writes only version 7 ids, so a row with another kind of id was written by something
/// else, and the request fails rather than hide the row.
pub(crate) fn account_choice(default: RoleDefault) -> Result<AccountChoice, ErrorObject> {
    match default {
        RoleDefault::Subscription { backend } => Ok(AccountChoice::Subscription { backend }),
        RoleDefault::Key { account_id } => {
            let id = AccountId::try_from(account_id).map_err(|_| {
                error!(id = %account_id, "a stored role default's key account id is not a UUIDv7");
                ErrorObject::internal_error(format!(
                    "the stored default account {account_id} has an invalid id"
                ))
            })?;
            Ok(AccountChoice::Key { id })
        }
    }
}

/// Vendor CLIs plxd ships or plans an adapter for (0004), ahead of #170's real detection of which
/// are actually installed and signed in (#114). `role_default` checks a `Subscription` choice's
/// backend name against this fixed list; #170 replaces it with something plxd has actually
/// probed.
const KNOWN_BACKENDS: &[&str] = &["claude", "codex", "cursor"];

/// An `accounts/defaults/set` choice as the store's [`RoleDefault`], checked against `db_store`
/// first: a `Key` must be a real row in `accounts` (#117), and a `Subscription`'s backend must be
/// one of [`KNOWN_BACKENDS`]. Unvalidated, a typo or a removed key account would only surface
/// later, as a `RoutingError` when a task tries to start (#119).
///
/// # Errors
///
/// `invalidParams`, naming the missing account or backend, or an internal error if the check
/// itself fails.
pub(crate) fn role_default(
    db_store: &parallax_store::Store,
    choice: &AccountChoice,
) -> Result<RoleDefault, ErrorObject> {
    match choice {
        AccountChoice::Subscription { backend } => {
            // The app's end-to-end tests make the fake backend the default (PLX-16).
            let fake = cfg!(feature = "fake-backend") && backend == "fake";
            if fake || KNOWN_BACKENDS.contains(&backend.as_str()) {
                Ok(RoleDefault::Subscription {
                    backend: backend.clone(),
                })
            } else {
                Err(ErrorObject::invalid_params(format!(
                    "{backend:?} is not a backend plxd knows"
                )))
            }
        }
        AccountChoice::Key { id } => {
            let uuid = (*id).into();
            let exists = db_store
                .get_account(uuid)
                .map_err(|error| {
                    error!(error = %error, "the project store failed checking a key account");
                    ErrorObject::internal_error(format!("the project store failed: {error}"))
                })?
                .is_some();
            if exists {
                Ok(RoleDefault::Key { account_id: uuid })
            } else {
                Err(ErrorObject::invalid_params(format!(
                    "no key account {id} exists"
                )))
            }
        }
        AccountChoice::Unknown => Err(ErrorObject::invalid_params(
            "account must be a subscription or a key",
        )),
    }
}

/// A store row as the protocol's key account.
///
/// plxd writes only version 7 ids, so a row with another kind of id was written by something
/// else, and the request fails rather than hide the row.
pub(crate) fn key_account(row: parallax_store::Account) -> Result<KeyAccount, ErrorObject> {
    let id = AccountId::try_from(row.id).map_err(|_| {
        error!(id = %row.id, "a stored key account's id is not a UUIDv7");
        ErrorObject::internal_error(format!(
            "the stored key account {} has an invalid id",
            row.id
        ))
    })?;
    Ok(KeyAccount {
        id,
        provider: provider_from_text(&row.provider),
        label: row.label,
        created_at: row.created_at,
        masked_key: row.masked_key,
    })
}

#[cfg(test)]
mod tests {
    use parallax_protocol::jsonrpc::ErrorObject;
    use std::time::Duration;

    use jiff::Timestamp;
    use parallax_protocol::jsonrpc::{INTERNAL_ERROR, PLX_ERROR, REQUEST_CANCELLED};
    use parallax_protocol::{
        AccountId, ErrorKind, ImageMediaType, ParallaxEvent, ProjectAutonomy, ProjectCreateParams,
        ProjectIcon, ProjectId, ProjectPermission, ProjectUpdateParams, PromptImage, Provider,
        StoreState,
    };
    use parallax_store::StoreError;
    use tokio_util::sync::CancellationToken;
    use uuid::Uuid;

    use super::{
        StoreHandle, account_fields, account_store_error, edit, fields, key_account, project,
        store_error,
    };

    fn open(path: &std::path::Path) -> StoreHandle {
        StoreHandle::open(path, 10, usize::MAX, usize::MAX)
    }

    fn new_project() -> ProjectCreateParams {
        ProjectCreateParams {
            id: ProjectId::generate(),
            name: "n".to_owned(),
            repo_path: "/r".to_owned(),
            icon: None,
            permission: None,
            autonomy: None,
            base_branch: None,
        }
    }

    /// How many projects the database has, and its events' `seq`s, read on a connection of their
    /// own.
    fn stored(path: &std::path::Path) -> (i64, Vec<i64>) {
        let raw = rusqlite::Connection::open(path).unwrap();
        let projects = raw
            .query_row("SELECT COUNT(*) FROM projects", [], |row| row.get(0))
            .unwrap();
        let seqs = raw
            .prepare("SELECT seq FROM events ORDER BY seq")
            .unwrap()
            .query_map([], |row| row.get(0))
            .unwrap()
            .collect::<Result<_, _>>()
            .unwrap();
        (projects, seqs)
    }

    /// A job writes a row and stages its event in one transaction (0052): one that fails after
    /// staging, or panics between the row and the event, as a crash would cut it, leaves neither
    /// row nor event, publishes nothing, and gives the next event the `seq` it would have had.
    #[tokio::test]
    async fn a_job_that_fails_or_panics_leaves_neither_its_row_nor_its_event() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("plxd.sqlite3");
        let store = open(&path);
        let log = store.log();
        let cancel = CancellationToken::new();
        let watch = log.watch();

        let failed = store
            .run(&cancel, |db| {
                let (id, fields) = fields(new_project());
                db.create_project(id, &fields)
                    .map_err(|error| store_error(&error))?;
                db.stage(Timestamp::now(), None, ParallaxEvent::Unknown);
                Err::<(), _>(ErrorObject::internal_error("injected"))
            })
            .await;
        assert_eq!(failed.unwrap_err().message, "Internal error: injected");
        let panicked = store
            .run(&cancel, |db| {
                let (id, fields) = fields(new_project());
                db.create_project(id, &fields)
                    .map_err(|error| store_error(&error))?;
                assert!(id.is_nil(), "injected between the row and its event");
                Ok(db.stage(Timestamp::now(), None, ParallaxEvent::Unknown))
            })
            .await;
        assert_eq!(panicked.unwrap_err().code, INTERNAL_ERROR);
        assert_eq!(stored(&path), (0, vec![]), "neither the rows nor the event");
        assert_eq!(log.head(), 0, "nothing was published");
        assert!(!watch.has_changed().unwrap());

        let seq = store
            .run(&cancel, |db| {
                let (id, fields) = fields(new_project());
                db.create_project(id, &fields)
                    .map_err(|error| store_error(&error))?;
                Ok(db.stage(Timestamp::now(), None, ParallaxEvent::Unknown))
            })
            .await
            .unwrap();
        assert_eq!(seq, 1, "the rolled-back event gave its seq back");
        assert_eq!(stored(&path), (1, vec![1]));
        assert_eq!(log.head(), 1);
        assert!(watch.has_changed().unwrap());
        store.stop().await;
    }

    /// An event that can't be stored fails its job: the row written before it rolls back too.
    #[tokio::test]
    async fn an_event_that_cannot_be_stored_rolls_back_its_job() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("plxd.sqlite3");
        let store = open(&path);
        // A row already holding the next `seq` makes the insert fail.
        rusqlite::Connection::open(&path)
            .unwrap()
            .execute(
                "INSERT INTO events (seq, time, type, payload) \
                 VALUES (1, '2026-09-25T12:00:00Z', 'x', '{}')",
                [],
            )
            .unwrap();
        let failed = store
            .run(&CancellationToken::new(), |db| {
                let (id, fields) = fields(new_project());
                db.create_project(id, &fields)
                    .map_err(|error| store_error(&error))?;
                Ok(db.stage(Timestamp::now(), None, ParallaxEvent::Unknown))
            })
            .await;
        assert_eq!(failed.unwrap_err().code, INTERNAL_ERROR);
        assert_eq!(stored(&path), (0, vec![1]), "only the event that was there");
        assert_eq!(store.log().head(), 0);
        store.stop().await;
    }

    fn row(id: Uuid) -> parallax_store::Project {
        parallax_store::Project {
            id,
            name: "parallax".to_owned(),
            repo_path: "/src/parallax".to_owned(),
            icon: Some(parallax_store::ProjectIcon {
                name: "rocket".to_owned(),
                color: Some("green".to_owned()),
                image: Some(parallax_store::StoredImage {
                    media_type: "image/webp".to_owned(),
                    data: "UklGRg==".to_owned(),
                }),
            }),
            permission: "bypass".to_owned(),
            autonomy: "ask".to_owned(),
            created_at: "2026-09-24T12:00:00.5Z".parse().unwrap(),
            updated_at: "2026-09-24T12:00:01Z".parse().unwrap(),
            base_branch: None,
            integration_branch: None,
            auto_land: false,
            allow_api_keys: false,
            max_children: 10,
            checks: None,
            proposed_checks: None,
        }
    }

    #[test]
    fn rows_map_to_protocol_projects_field_for_field() {
        let id = ProjectId::generate();
        let mapped = project(row(id.into()), None).unwrap();
        assert_eq!(mapped.id, id);
        assert_eq!(mapped.name, "parallax");
        assert_eq!(mapped.repo_path, "/src/parallax");
        assert_eq!(
            mapped.icon,
            Some(ProjectIcon {
                name: "rocket".to_owned(),
                color: Some("green".to_owned()),
                image: Some(PromptImage {
                    media_type: ImageMediaType::Webp,
                    data: "UklGRg==".to_owned(),
                }),
            })
        );
        assert_eq!(mapped.permission, Some(ProjectPermission::Bypass));
        assert_eq!(mapped.autonomy, Some(ProjectAutonomy::Ask));
        assert_eq!(mapped.created_at, row(id.into()).created_at);
        assert_eq!(mapped.updated_at, row(id.into()).updated_at);

        let icon = ProjectIcon {
            name: "star".to_owned(),
            color: None,
            image: Some(PromptImage {
                media_type: ImageMediaType::Png,
                data: "iVBORw==".to_owned(),
            }),
        };
        let params = ProjectCreateParams {
            id,
            name: "n".to_owned(),
            repo_path: "/r".to_owned(),
            icon: Some(icon.clone()),
            permission: None,
            autonomy: None,
            base_branch: None,
        };
        let (uuid, fields) = fields(params);
        assert_eq!(uuid, Uuid::from(id));
        assert_eq!(
            (fields.name.as_str(), fields.repo_path.as_str()),
            ("n", "/r")
        );
        let stored = parallax_store::ProjectIcon {
            name: "star".to_owned(),
            color: None,
            image: Some(parallax_store::StoredImage {
                media_type: "image/png".to_owned(),
                data: "iVBORw==".to_owned(),
            }),
        };
        assert_eq!(fields.icon.as_ref(), Some(&stored));
        assert_eq!(fields.permission, "auto", "an absent mode is Auto");
        assert_eq!(fields.autonomy, "routine", "an absent level is Routine");

        let (uuid, edit) = edit(ProjectUpdateParams {
            project: id,
            name: None,
            icon: Some(icon),
            permission: Some(ProjectPermission::Bypass),
            autonomy: Some(ProjectAutonomy::Full),
            base_branch: None,
            auto_land: None,
            allow_api_keys: None,
            max_children: None,
            checks: None,
            proposed_checks: None,
        });
        assert_eq!(uuid, Uuid::from(id));
        assert_eq!(edit.name, None);
        assert_eq!(edit.icon, Some(stored));
        assert_eq!(edit.permission.as_deref(), Some("bypass"));
        assert_eq!(edit.autonomy.as_deref(), Some("full"));
    }

    #[test]
    fn a_row_whose_id_is_not_v7_is_an_internal_error() {
        let error = project(row(Uuid::nil()), None).unwrap_err();
        assert_eq!(error.code, INTERNAL_ERROR);
    }

    #[test]
    fn conflicts_and_missing_projects_are_parallax_errors() {
        let id = Uuid::now_v7();
        let conflict = store_error(&StoreError::IdConflict { id });
        assert_eq!(conflict.code, PLX_ERROR);
        assert_eq!(
            conflict.parallax_data().unwrap().kind,
            ErrorKind::IdConflict
        );
        let missing = store_error(&StoreError::NotFound { id });
        assert_eq!(
            missing.parallax_data().unwrap().kind,
            ErrorKind::ProjectNotFound
        );
        let other = store_error(&StoreError::JournalMode("delete".to_owned()));
        assert_eq!(other.code, INTERNAL_ERROR);
    }

    fn account_row(id: Uuid) -> parallax_store::Account {
        parallax_store::Account {
            id,
            provider: "anthropic".to_owned(),
            label: "Personal".to_owned(),
            masked_key: "sk-ant-...abcd".to_owned(),
            created_at: "2026-09-24T12:00:00.5Z".parse().unwrap(),
        }
    }

    #[test]
    fn account_rows_map_to_protocol_key_accounts_field_for_field() {
        let id = AccountId::generate();
        let mapped = key_account(account_row(id.into())).unwrap();
        assert_eq!(mapped.id, id);
        assert_eq!(mapped.provider, Provider::Anthropic);
        assert_eq!(mapped.label, "Personal");
        assert_eq!(mapped.masked_key, "sk-ant-...abcd");
        assert_eq!(mapped.created_at, account_row(id.into()).created_at);

        let fields = account_fields(
            Provider::Openai,
            "Work".to_owned(),
            "sk-proj-...wxyz".to_owned(),
        );
        assert_eq!(fields.provider, "openai");
        assert_eq!(fields.label, "Work");
        assert_eq!(fields.masked_key, "sk-proj-...wxyz");
    }

    #[test]
    fn an_account_row_whose_id_is_not_v7_is_an_internal_error() {
        let error = key_account(account_row(Uuid::nil())).unwrap_err();
        assert_eq!(error.code, INTERNAL_ERROR);
    }

    #[test]
    fn an_unrecognized_stored_provider_decodes_as_unknown() {
        let mut row = account_row(Uuid::now_v7());
        row.provider = "gemini".to_owned();
        let mapped = key_account(row).unwrap();
        assert_eq!(mapped.provider, Provider::Unknown);
    }

    #[test]
    fn missing_accounts_are_account_not_found_not_project_not_found() {
        let id = Uuid::now_v7();
        let conflict = account_store_error(&StoreError::IdConflict { id });
        assert_eq!(
            conflict.parallax_data().unwrap().kind,
            ErrorKind::IdConflict
        );
        let missing = account_store_error(&StoreError::NotFound { id });
        assert_eq!(
            missing.parallax_data().unwrap().kind,
            ErrorKind::AccountNotFound
        );
    }

    #[tokio::test]
    async fn a_store_that_cannot_open_is_unavailable() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("file");
        std::fs::write(&file, "").unwrap();
        let store = open(&file.join("nested.sqlite3"));
        assert_eq!(store.state(), StoreState::Unavailable);
        let error = store
            .run(&CancellationToken::new(), |_| Ok(()))
            .await
            .unwrap_err();
        assert_eq!(error.code, INTERNAL_ERROR);
        assert_eq!(
            error.message,
            "Internal error: the project store is unavailable"
        );
    }

    #[tokio::test]
    async fn a_queued_job_is_skipped_when_cancelled_and_a_started_one_finishes() {
        let dir = tempfile::tempdir().unwrap();
        let store = open(&dir.path().join("plxd.sqlite3"));
        assert_eq!(store.state(), StoreState::Ok);

        let (started_tx, started_rx) = std::sync::mpsc::channel();
        let (release_tx, release_rx) = std::sync::mpsc::channel::<()>();
        let first_cancel = CancellationToken::new();
        let second_cancel = CancellationToken::new();
        let first = store.run(&first_cancel, move |_| {
            started_tx.send(()).unwrap();
            release_rx.recv().unwrap();
            Ok("first")
        });
        let second = store.run(&second_cancel, |_| Ok("second"));
        let driver = async {
            tokio::task::spawn_blocking(move || started_rx.recv().unwrap())
                .await
                .unwrap();
            first_cancel.cancel();
            second_cancel.cancel();
            tokio::time::sleep(Duration::from_millis(50)).await;
            release_tx.send(()).unwrap();
        };
        let (first, second, ()) = tokio::join!(first, second, driver);
        assert_eq!(first, Ok("first"), "a started job returns its result");
        assert_eq!(second.unwrap_err().code, REQUEST_CANCELLED);
        store.stop().await;
        assert_eq!(store.state(), StoreState::Unavailable);
    }

    #[tokio::test]
    async fn a_job_queued_behind_a_blocked_one_raises_the_wait_figures() {
        let dir = tempfile::tempdir().unwrap();
        let store = open(&dir.path().join("plxd.sqlite3"));
        let (started_tx, started_rx) = std::sync::mpsc::channel();
        let (release_tx, release_rx) = std::sync::mpsc::channel::<()>();
        let cancel = CancellationToken::new();
        let blocked = store.run(&cancel, move |_| {
            started_tx.send(()).unwrap();
            release_rx.recv().unwrap();
            Ok(())
        });
        let behind = store.run(&cancel, |_| Ok(()));
        let driver = async {
            tokio::task::spawn_blocking(move || started_rx.recv().unwrap())
                .await
                .unwrap();
            tokio::time::sleep(Duration::from_millis(50)).await;
            assert_eq!(store.queue_stats().queued, 1, "the second job is waiting");
            release_tx.send(()).unwrap();
        };
        let (blocked, behind, ()) = tokio::join!(blocked, behind, driver);
        assert_eq!((blocked, behind), (Ok(()), Ok(())));

        let stats = store.queue_stats();
        assert_eq!((stats.queued, stats.jobs), (0, 2));
        assert!(stats.max_wait_micros >= 50_000, "{stats:?}");
        assert!(stats.total_wait_micros >= stats.max_wait_micros);
        assert!(stats.max_run_micros >= 50_000, "{stats:?}");
        store.stop().await;
    }

    /// A project written while a snapshot on the reader is reading: the snapshot's `seq` is from
    /// before the write's event, so a subscriber after it replays the event, even though the rows
    /// already have the project (PLX-457).
    #[tokio::test]
    async fn a_write_during_a_snapshot_has_its_event_after_the_snapshots_seq() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("plxd.sqlite3");
        let store = open(&path);
        let reader = store.open_reader(&path);
        let (started_tx, started_rx) = std::sync::mpsc::channel();
        let (release_tx, release_rx) = std::sync::mpsc::channel::<()>();
        let cancel = CancellationToken::new();
        let snapshot = reader.snapshot(&cancel, move |db| {
            started_tx.send(()).unwrap();
            release_rx.recv().unwrap();
            db.list_projects().map_err(|error| store_error(&error))
        });
        let write = async {
            tokio::task::spawn_blocking(move || started_rx.recv().unwrap())
                .await
                .unwrap();
            let seq = store
                .run(&cancel, move |db| {
                    let (id, fields) = fields(ProjectCreateParams {
                        id: ProjectId::generate(),
                        name: "n".to_owned(),
                        repo_path: "/r".to_owned(),
                        icon: None,
                        permission: None,
                        autonomy: None,
                        base_branch: None,
                    });
                    db.create_project(id, &fields)
                        .map_err(|error| store_error(&error))?;
                    Ok(db.stage(Timestamp::now(), None, ParallaxEvent::Unknown))
                })
                .await
                .unwrap();
            release_tx.send(()).unwrap();
            seq
        };
        let (snapshot, written) = tokio::join!(snapshot, write);
        let (projects, seq) = snapshot.unwrap();
        assert_eq!(projects.len(), 1, "the read sees the committed row");
        assert!(
            written > seq,
            "event {written} replays after snapshot {seq}"
        );
        store.stop().await;
        reader.stop().await;
    }

    /// A database from a newer build: the writer won't open it, so the reader doesn't either and
    /// lists fail as unavailable instead of reading a schema this build doesn't know.
    #[tokio::test]
    async fn the_reader_is_unavailable_when_the_writer_is() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("plxd.sqlite3");
        let first = open(&path);
        first.stop().await;
        rusqlite::Connection::open(&path)
            .unwrap()
            .execute(
                "INSERT INTO schema_version (version, applied_at) VALUES (1000000, 'now')",
                [],
            )
            .unwrap();

        let store = open(&path);
        let reader = store.open_reader(&path);
        assert_eq!(store.state(), StoreState::Unavailable);
        assert_eq!(reader.state(), StoreState::Unavailable);
        let error = reader
            .run(&CancellationToken::new(), |db| {
                db.list_projects().map_err(|error| store_error(&error))
            })
            .await
            .unwrap_err();
        assert_eq!(
            error.message,
            "Internal error: the project store is unavailable"
        );
    }

    #[tokio::test]
    async fn the_reader_refuses_writes() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("plxd.sqlite3");
        let store = open(&path);
        let reader = store.open_reader(&path);
        let (id, fields) = fields(ProjectCreateParams {
            id: ProjectId::generate(),
            name: "n".to_owned(),
            repo_path: "/r".to_owned(),
            icon: None,
            permission: None,
            autonomy: None,
            base_branch: None,
        });
        let refused = reader
            .run(&CancellationToken::new(), move |db| {
                db.create_project(id, &fields)
                    .map_err(|error| store_error(&error))
            })
            .await;
        assert_eq!(refused.unwrap_err().code, INTERNAL_ERROR);
        store.stop().await;
        reader.stop().await;
    }
}
