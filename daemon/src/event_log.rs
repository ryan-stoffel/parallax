//! The event log: every change on this host, numbered by a daemon-wide `seq` (0007).
//!
//! The log lives in SQLite, in the store's own database (#156, decision 0014). Events are written
//! by the store's thread, inside the job that writes their rows (0052): a job stages each event
//! (`crate::store::Tx::stage`), which gives it the next `seq` and inserts its row, and once the
//! job's transaction commits, the store's thread publishes the staged events here, in `seq` order.
//! A job that rolls back publishes nothing. So `head` and the in-memory window only ever hold
//! committed events, and a row and its event are stored together or not at all.
//!
//! On start the log reloads its id, its head `seq`, and the newest events, so `logId` and `seq`
//! survive a restart, and `agent/events` pages through a run's whole history on a read-only
//! connection of its own. The newest `retention` events are also kept in memory, which is what
//! `events/subscribe` replays from; older ones need a resync. If the database can't be opened,
//! the log runs in memory only, starting over with a new `logId` on every start, as it did in M1.
//!
//! The table is compacted on a retention policy (#187, decision 0016): an agent run's events stay
//! as long as its run row does, while host and project events with no `run_id` —
//! `project.created`, `context.changed` — are pruned to the newest `host_retention` whenever one
//! is staged. `host_retention` is always at least `retention` (`EventLog::with` enforces it): a
//! restart only ever reloads the newest `retention` events, and by pigeonhole every host or
//! project event in that reload is among the newest `retention` host and project events too, so
//! keeping at least that many never lets pruning remove one a reload still needs. The in-memory
//! window is bounded by both count (`retention`) and bytes (`max_bytes`), evicting from the front
//! once either is exceeded, on every publish and once more on load.
//!
//! Subscribers don't get their own queues. Each subscription is a cursor that reads the log (see
//! `methods::events::Cursors`), so a slow subscriber costs nothing until it reads, and whoever
//! writes never waits for one.
//!
//! `head`, the newest published `seq`, lives in [`Inner`] under the same lock as the window, so a
//! subscriber's cursor (`check`/`next`) never sees a `head` whose entry isn't in the window yet. A
//! separate `watch::Sender` only wakes subscribers to go re-check.

use std::collections::VecDeque;
use std::path::Path;
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};

use jiff::Timestamp;
use parallax_protocol::{LogId, ParallaxEvent, ProjectId, RunId};
use parallax_store::{Store, StoreError, StoredEvent};
use tokio::sync::watch;
use tracing::{info, warn};

/// One entry in the log.
#[derive(Debug)]
pub(crate) struct Entry {
    pub seq: u64,
    pub time: Timestamp,
    pub project: Option<ProjectId>,
    pub event: ParallaxEvent,
    /// The event's JSON size, for the in-memory replay window's byte bound.
    pub bytes: usize,
}

/// Why the events after a `seq` can't be replayed.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Gone {
    /// Some of them were dropped to keep the log within its retention.
    Dropped,
    /// The `seq` is past the newest event, so it came from another log.
    Unknown {
        /// The newest event's `seq`.
        head: u64,
    },
}

pub(crate) struct EventLog {
    retention: usize,
    /// The in-memory replay window's byte bound (#187): even within `retention`, evicts older
    /// events once their JSON exceeds this many bytes.
    max_bytes: usize,
    /// How many of the newest host and project events (no `run_id`) the stored log keeps; older
    /// ones are pruned whenever one is staged. Irrelevant for a log with no database.
    host_retention: usize,
    /// The in-memory replay window and `head`, together, so a reader never sees `head` reflect a
    /// `seq` whose entry isn't in `events` yet.
    inner: Mutex<Inner>,
    /// A read-only connection for `run_events`, so paging a run's history never waits on the
    /// store's thread, or `None` for a log with no database.
    reader: Option<Mutex<Store>>,
    id: LogId,
    /// Wakes a subscriber to go re-check `inner`; not itself a source of truth for `head`.
    head_watch: watch::Sender<u64>,
}

struct Inner {
    events: VecDeque<Arc<Entry>>,
    /// The sum of `events`' sizes, kept alongside for O(1) eviction decisions.
    bytes: usize,
    /// The newest published `seq`, or 0 before the first.
    head: u64,
    /// The oldest `seq` that can still be replayed. Eviction moves it on; [`EventLog::purge_run`]
    /// doesn't, since the events it removes are gone on purpose, not dropped.
    floor: u64,
}

/// The run an event belongs to, for `agent/events` and `events/subscribe`'s `run`.
pub(crate) fn run_of(event: &ParallaxEvent) -> Option<RunId> {
    match event {
        ParallaxEvent::AgentStarted { run_id, .. }
        | ParallaxEvent::AgentUpdated { run_id, .. }
        | ParallaxEvent::AgentOutput { run_id, .. }
        | ParallaxEvent::AgentAccountFallback { run_id, .. }
        | ParallaxEvent::AgentFinished { run_id, .. }
        | ParallaxEvent::AgentDiffReady { run_id, .. }
        | ParallaxEvent::AgentAccepted { run_id, .. }
        | ParallaxEvent::AgentWakeupsPaused { run_id }
        | ParallaxEvent::QueueUpdated { run_id, .. } => Some(*run_id),
        ParallaxEvent::ProjectCreated { .. }
        | ParallaxEvent::ProjectUpdated { .. }
        | ParallaxEvent::ProjectDeleted { .. }
        | ParallaxEvent::ContextChanged { .. }
        | ParallaxEvent::InboxAdded { .. }
        | ParallaxEvent::RepoAdded { .. }
        | ParallaxEvent::RepoUpdated { .. }
        | ParallaxEvent::ThreadStarted { .. }
        | ParallaxEvent::ThreadUpdated { .. }
        | ParallaxEvent::ThreadDeleted { .. }
        | ParallaxEvent::Unknown => None,
    }
}

pub(crate) fn kind_of(event: &ParallaxEvent) -> String {
    serde_json::to_value(event)
        .ok()
        .and_then(|value| value.get("kind")?.as_str().map(str::to_owned))
        .unwrap_or_default()
}

/// Evicts from the front of `events` until it is within both `retention` and `max_bytes`,
/// keeping `bytes` (the sum of what remains) in sync. Always leaves at least one event, so a
/// single one over `max_bytes` on its own is never dropped outright. Shared by construction and
/// by every publish, so the bound holds the same way whichever put the log over it.
fn evict(
    events: &mut VecDeque<Arc<Entry>>,
    bytes: &mut usize,
    floor: &mut u64,
    retention: usize,
    max_bytes: usize,
) {
    while events.len() > 1 && (events.len() > retention || *bytes > max_bytes) {
        if let Some(evicted) = events.pop_front() {
            *bytes = bytes.saturating_sub(evicted.bytes);
            *floor = evicted.seq + 1;
        }
    }
}

// The index of the first event after `after`. `seq`s increase but may have gaps: a deleted run's
// events are gone from a log reloaded after a restart, and `purge_run` (#110) removes them from
// the middle of the window on purpose. Reads `head`,
// `floor`, and `events` from the same locked `inner`, so all three are always consistent with
// each other (#190): `head` never says a `seq` exists that `events` hasn't published yet.
fn start(inner: &Inner, after: u64) -> Result<usize, Gone> {
    let head = inner.head;
    if after > head {
        return Err(Gone::Unknown { head });
    }
    if after + 1 < inner.floor {
        return Err(Gone::Dropped);
    }
    Ok(inner.events.partition_point(|event| event.seq <= after))
}

impl EventLog {
    /// An empty log in memory only, which keeps the newest `retention` events with no byte bound.
    #[cfg(test)]
    pub fn new(retention: usize) -> Self {
        Self::new_bounded(retention, usize::MAX)
    }

    /// An empty log in memory only, which keeps the newest `retention` events and evicts once
    /// their JSON passes `max_bytes`, whichever comes first.
    pub fn new_bounded(retention: usize, max_bytes: usize) -> Self {
        Self::with(
            LogId::generate(),
            retention,
            max_bytes,
            usize::MAX,
            VecDeque::new(),
            0,
            None,
        )
    }

    /// The log stored in the database at `path`, read through `db`, the store's write connection,
    /// before its thread starts: the log's id, its head, and the newest `retention` events
    /// (evicting sooner if they pass `max_bytes`). The newest `host_retention` host and project
    /// events are kept in the table. Sets `db` to `synchronous = NORMAL` (0052).
    pub fn load(
        db: &Store,
        path: &Path,
        retention: usize,
        max_bytes: usize,
        host_retention: usize,
    ) -> Result<Self, StoreError> {
        db.relax_sync()?;
        let stored_id = db.event_log_id(LogId::generate().into())?;
        let id = LogId::try_from(stored_id).unwrap_or_else(|_| {
            warn!(id = %stored_id, "the stored event log id is not a UUIDv7");
            LogId::generate()
        });
        let head = db.event_head()?;
        let events = db
            .latest_events(retention.max(1), max_bytes)?
            .into_iter()
            .map(|stored| Arc::new(entry(&stored)))
            .collect();
        let reader = match Store::open_read_only(path) {
            Ok(reader) => Some(reader),
            Err(error) => {
                warn!(path = %path.display(), %error, "could not open a connection for the event log's reads; agent/events falls back to memory");
                None
            }
        };
        info!(log_id = %id, head, "opened the event log");
        Ok(Self::with(
            id,
            retention,
            max_bytes,
            host_retention,
            events,
            head,
            reader,
        ))
    }

    fn with(
        id: LogId,
        retention: usize,
        max_bytes: usize,
        host_retention: usize,
        mut events: VecDeque<Arc<Entry>>,
        head: u64,
        reader: Option<Store>,
    ) -> Self {
        let retention = retention.max(1);
        let max_bytes = max_bytes.max(1);
        // `host_retention` must be at least `retention`: a reload only ever pulls the newest
        // `retention` events, and every host or project event among them is, by pigeonhole, among
        // the newest `retention` host and project events, so keeping at least that many host
        // events never lets a restart's window skip one (0016).
        let host_retention = host_retention.max(retention);
        let mut bytes = events.iter().map(|entry| entry.bytes).sum();
        let mut floor = events.front().map_or(head + 1, |entry| entry.seq);
        evict(&mut events, &mut bytes, &mut floor, retention, max_bytes);
        Self {
            retention,
            max_bytes,
            host_retention,
            inner: Mutex::new(Inner {
                events,
                bytes,
                head,
                floor,
            }),
            reader: reader.map(Mutex::new),
            id,
            head_watch: watch::Sender::new(head),
        }
    }

    pub fn id(&self) -> LogId {
        self.id
    }

    /// How many host and project events the stored log keeps.
    pub fn host_retention(&self) -> usize {
        self.host_retention
    }

    /// The newest event's `seq`, or 0 before the first.
    pub fn head(&self) -> u64 {
        self.inner().head
    }

    /// A receiver that wakes after every publish.
    pub fn watch(&self) -> watch::Receiver<u64> {
        self.head_watch.subscribe()
    }

    /// Adds committed `entries`, oldest first, to the window and moves `head` to the last, in one
    /// critical section, then wakes watchers. Only the store's thread calls it, after a commit,
    /// except for a log with no database.
    pub fn publish(&self, entries: Vec<Entry>) {
        let Some(last) = entries.last().map(|entry| entry.seq) else {
            return;
        };
        let mut inner = self.inner();
        let Inner {
            events,
            bytes,
            head,
            floor,
        } = &mut *inner;
        for entry in entries {
            *bytes += entry.bytes;
            events.push_back(Arc::new(entry));
        }
        *head = last;
        evict(events, bytes, floor, self.retention, self.max_bytes);
        self.head_watch.send_replace(last);
    }

    /// Appends an event to a log with no database: a store that couldn't open, and tests.
    pub fn append_in_memory(
        &self,
        time: Timestamp,
        project: Option<ProjectId>,
        event: ParallaxEvent,
    ) -> u64 {
        let bytes = serde_json::to_string(&event).map_or(0, |json| json.len());
        // One lock for reading `head` and publishing, so two callers can't take the same `seq`.
        let mut inner = self.inner();
        let seq = inner.head + 1;
        let Inner {
            events,
            bytes: total,
            head,
            floor,
        } = &mut *inner;
        events.push_back(Arc::new(Entry {
            seq,
            time,
            project,
            event,
            bytes,
        }));
        *total += bytes;
        *head = seq;
        evict(events, total, floor, self.retention, self.max_bytes);
        self.head_watch.send_replace(seq);
        seq
    }

    /// `run`'s events after `after`, oldest first, from the database, or from memory for a log
    /// that has none: at most `limit` of them and about `max_bytes` of event JSON, but always at
    /// least one when any exists, so a page fits in a frame and paging always moves on. The
    /// flag says whether more follow. Reads through its own connection (`reader`), so a slow page
    /// never blocks the store's thread or vice versa (#190).
    pub fn run_events(
        &self,
        run: RunId,
        after: u64,
        limit: usize,
        max_bytes: usize,
    ) -> Result<(Vec<Arc<Entry>>, bool), StoreError> {
        if let Some(reader) = &self.reader {
            let db = reader.lock().unwrap_or_else(PoisonError::into_inner);
            let (stored, more) = db.run_events(run.into(), after, limit, max_bytes)?;
            let entries = stored
                .iter()
                .map(|stored| Arc::new(entry(stored)))
                .collect();
            return Ok((entries, more));
        }
        let inner = self.inner();
        let mut entries = Vec::new();
        let mut bytes = 0;
        for entry in inner
            .events
            .iter()
            .filter(|entry| entry.seq > after && run_of(&entry.event) == Some(run))
        {
            let size = serde_json::to_string(&entry.event).map_or(0, |json| json.len());
            if entries.len() >= limit.max(1) || (!entries.is_empty() && bytes + size > max_bytes) {
                return Ok((entries, true));
            }
            bytes += size;
            entries.push(Arc::clone(entry));
        }
        Ok((entries, false))
    }

    /// `run`'s events before `before`, newest first, paged as [`EventLog::run_events`] pages
    /// (PLX-372, PLX-490): the flag says whether older ones remain.
    pub fn run_events_before(
        &self,
        run: RunId,
        before: u64,
        limit: usize,
        max_bytes: usize,
    ) -> Result<(Vec<Arc<Entry>>, bool), StoreError> {
        if let Some(reader) = &self.reader {
            let db = reader.lock().unwrap_or_else(PoisonError::into_inner);
            let (stored, more) = db.run_events_before(run.into(), before, limit, max_bytes)?;
            let entries = stored
                .iter()
                .map(|stored| Arc::new(entry(stored)))
                .collect();
            return Ok((entries, more));
        }
        let inner = self.inner();
        let mut entries = Vec::new();
        let mut bytes = 0;
        for entry in inner
            .events
            .iter()
            .rev()
            .filter(|entry| entry.seq < before && run_of(&entry.event) == Some(run))
        {
            let size = serde_json::to_string(&entry.event).map_or(0, |json| json.len());
            if entries.len() >= limit.max(1) || (!entries.is_empty() && bytes + size > max_bytes) {
                return Ok((entries, true));
            }
            bytes += size;
            entries.push(Arc::clone(entry));
        }
        Ok((entries, false))
    }

    /// Removes `run`'s events from the in-memory replay window, for a deleted thread (#110), so
    /// `events/subscribe` stops replaying them. The stored ones go with the run's rows.
    pub fn purge_run(&self, run: RunId) {
        let mut inner = self.inner();
        let Inner { events, bytes, .. } = &mut *inner;
        events.retain(|entry| {
            let keep = run_of(&entry.event) != Some(run);
            if !keep {
                *bytes = bytes.saturating_sub(entry.bytes);
            }
            keep
        });
    }

    /// Whether the events after `after` can all still be replayed.
    pub fn check(&self, after: u64) -> Result<(), Gone> {
        start(&self.inner(), after).map(|_| ())
    }

    /// The first event after `after` that belongs to `project`, where `None` means host-level
    /// events, and that `keep` accepts.
    ///
    /// The `seq` returned with it is where to continue from: the event's own, or the head's when
    /// no such event exists yet.
    pub fn next(
        &self,
        after: u64,
        project: Option<ProjectId>,
        keep: impl Fn(&ParallaxEvent) -> bool,
    ) -> Result<(Option<Arc<Entry>>, u64), Gone> {
        let inner = self.inner();
        let index = start(&inner, after)?;
        match inner
            .events
            .range(index..)
            .find(|event| event.project == project && keep(&event.event))
        {
            Some(event) => Ok((Some(Arc::clone(event)), event.seq)),
            None => Ok((None, inner.head)),
        }
    }

    /// Whether an event after `after` matches `matches`, or may have: one that was dropped from
    /// the window can't be checked, so that counts as a match. For `agent/wait` (PLX-451).
    pub fn any_after(&self, after: u64, matches: impl Fn(&ParallaxEvent) -> bool) -> bool {
        let inner = self.inner();
        start(&inner, after).map_or(true, |index| {
            inner
                .events
                .range(index..)
                .any(|entry| matches(&entry.event))
        })
    }

    fn inner(&self) -> MutexGuard<'_, Inner> {
        self.inner.lock().unwrap_or_else(PoisonError::into_inner)
    }
}

/// A stored event as a log entry. A payload this build can't read, such as a newer plxd's kind,
/// comes back as `ParallaxEvent::Unknown`, keeping its place in the sequence.
fn entry(stored: &StoredEvent) -> Entry {
    Entry {
        seq: stored.seq,
        time: stored.time,
        project: stored
            .project_id
            .and_then(|id| ProjectId::try_from(id).ok()),
        bytes: stored.payload.len(),
        event: serde_json::from_str(&stored.payload).unwrap_or(ParallaxEvent::Unknown),
    }
}

#[cfg(test)]
mod tests {
    use std::path::Path;
    use std::sync::Arc;
    use std::time::Duration;

    use parallax_protocol::{AgentOutcome, AgentOutputItem, ParallaxEvent, ProjectId, RunId};
    use tokio_util::sync::CancellationToken;

    use super::{EventLog, Gone};
    use crate::store::StoreHandle;

    fn append(log: &EventLog, project: Option<ProjectId>) -> u64 {
        log.append_in_memory(jiff::Timestamp::now(), project, ParallaxEvent::Unknown)
    }

    /// Stores `event` through `store`'s thread, as plxd does.
    fn put(store: &StoreHandle, project: Option<ProjectId>, event: ParallaxEvent) -> u64 {
        store.append_blocking(jiff::Timestamp::now(), project, event)
    }

    fn finished(run_id: RunId) -> ParallaxEvent {
        ParallaxEvent::AgentFinished {
            run_id,
            outcome: AgentOutcome::Cancelled,
        }
    }

    /// A stored log with no byte bound and no host-event pruning, for tests that only care about
    /// `retention`.
    fn open(path: &Path, retention: usize) -> StoreHandle {
        StoreHandle::open(path, retention, usize::MAX, usize::MAX)
    }

    #[test]
    fn seq_starts_at_1_and_counts_every_event() {
        let log = EventLog::new(10);
        assert_eq!(log.head(), 0);
        assert_eq!(append(&log, None), 1);
        assert_eq!(append(&log, Some(ProjectId::generate())), 2);
        assert_eq!(log.head(), 2);
    }

    #[test]
    fn next_skips_other_projects_and_reports_where_it_stopped() {
        let log = EventLog::new(10);
        let project = ProjectId::generate();
        append(&log, Some(project));
        append(&log, None);
        append(&log, Some(project));

        let (event, seq) = log.next(0, None, |_| true).unwrap();
        assert_eq!(event.unwrap().seq, 2);
        assert_eq!(seq, 2);
        assert_eq!(
            log.next(2, None, |_| true)
                .unwrap()
                .0
                .map(|event| event.seq),
            None
        );
        assert_eq!(log.next(2, None, |_| true).unwrap().1, 3);

        let (event, _) = log.next(1, Some(project), |_| true).unwrap();
        assert_eq!(event.unwrap().seq, 3);
        assert_eq!(log.next(3, Some(project), |_| true).unwrap().1, 3);
    }

    #[test]
    fn purging_a_run_removes_only_its_events_and_drops_nothing_else() {
        let log = EventLog::new(10);
        let project = ProjectId::generate();
        let (gone, kept) = (RunId::generate(), RunId::generate());
        log.append_in_memory(jiff::Timestamp::now(), Some(project), finished(gone));
        log.append_in_memory(jiff::Timestamp::now(), Some(project), finished(kept));
        log.append_in_memory(jiff::Timestamp::now(), Some(project), finished(gone));

        log.purge_run(gone);

        assert_eq!(log.check(0), Ok(()));
        let (event, seq) = log.next(0, Some(project), |_| true).unwrap();
        assert_eq!((event.unwrap().seq, seq), (2, 2));
        let (event, seq) = log.next(2, Some(project), |_| true).unwrap();
        assert!(event.is_none());
        assert_eq!(seq, 3);
    }

    #[test]
    fn events_past_the_retention_are_gone() {
        let log = EventLog::new(2);
        for _ in 0..4 {
            append(&log, None);
        }
        assert_eq!(log.check(1), Err(Gone::Dropped));
        assert_eq!(log.next(1, None, |_| true).unwrap_err(), Gone::Dropped);
        assert_eq!(log.check(2), Ok(()));
        assert_eq!(log.next(2, None, |_| true).unwrap().0.unwrap().seq, 3);
        assert_eq!(log.check(4), Ok(()));
    }

    /// `any_after` (PLX-451) checks only the events after `after`, and counts events dropped
    /// from the window as a match, since it can't tell what they were.
    #[test]
    fn any_after_matches_new_events_and_any_that_were_dropped() {
        let log = EventLog::new(2);
        let run = RunId::generate();
        log.append_in_memory(jiff::Timestamp::now(), None, finished(run));
        for _ in 0..3 {
            append(&log, None);
        }
        let is_finished =
            |event: &ParallaxEvent| matches!(event, ParallaxEvent::AgentFinished { .. });
        assert!(log.any_after(0, is_finished), "seq 1 was dropped");
        assert!(!log.any_after(2, is_finished));
        log.append_in_memory(jiff::Timestamp::now(), None, finished(run));
        assert!(log.any_after(4, is_finished));
        assert!(!log.any_after(5, is_finished));
    }

    #[test]
    fn a_seq_past_the_head_is_unknown() {
        let log = EventLog::new(2);
        assert_eq!(log.check(0), Ok(()));
        assert_eq!(log.check(1), Err(Gone::Unknown { head: 0 }));
        append(&log, None);
        assert_eq!(log.check(u64::MAX), Err(Gone::Unknown { head: 1 }));
    }

    #[test]
    fn a_stored_log_keeps_its_id_seq_and_events_across_a_reopen() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("plxd.sqlite3");
        let project = ProjectId::generate();
        let run = RunId::generate();
        let first = open(&path, 2);
        put(&first, None, ParallaxEvent::Unknown);
        put(&first, Some(project), finished(run));
        put(&first, Some(project), ParallaxEvent::Unknown);
        let id = first.log().id();
        drop(first);

        let store = open(&path, 2);
        let reopened = store.log();
        assert_eq!(reopened.id(), id, "the log did not start over");
        assert_eq!(reopened.head(), 3);
        assert_eq!(
            reopened.check(0),
            Err(Gone::Dropped),
            "only 2 are in memory"
        );
        let (event, _) = reopened.next(1, Some(project), |_| true).unwrap();
        assert_eq!(event.unwrap().event, finished(run));
        assert_eq!(put(&store, None, ParallaxEvent::Unknown), 4);
        let (entries, more) = reopened.run_events(run, 0, 10, usize::MAX).unwrap();
        let seqs: Vec<u64> = entries.iter().map(|entry| entry.seq).collect();
        assert_eq!(seqs, [2]);
        assert!(!more);
        assert!(
            reopened
                .run_events(run, 2, 10, usize::MAX)
                .unwrap()
                .0
                .is_empty()
        );
    }

    #[test]
    fn a_log_whose_database_cannot_open_runs_in_memory() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("file");
        std::fs::write(&file, "").unwrap();
        let store = open(&file.join("nested.sqlite3"), 10);
        let log = store.log();
        let run = RunId::generate();
        put(&store, None, finished(run));
        assert_eq!(log.head(), 1);
        put(&store, None, finished(run));
        assert_eq!(log.run_events(run, 0, 10, usize::MAX).unwrap().0.len(), 2);
        let (page, more) = log.run_events(run, 0, 10, 1).unwrap();
        assert_eq!(
            (page.len(), more),
            (1, true),
            "the byte budget applies in memory too"
        );
    }

    #[test]
    fn replay_skips_nothing_across_a_gap_in_seq() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("plxd.sqlite3");
        let first = open(&path, 10);
        for _ in 0..4 {
            put(&first, None, ParallaxEvent::Unknown);
        }
        let id = first.log().id();
        drop(first);
        // A hole, as a run's events purged with its thread leave.
        let db = rusqlite::Connection::open(&path).unwrap();
        db.execute("DELETE FROM events WHERE seq = 2", []).unwrap();
        drop(db);

        let reopened = open(&path, 10).log();
        assert_eq!(reopened.id(), id);
        let mut delivered = Vec::new();
        let mut after = 0;
        while let (Some(entry), seq) = reopened.next(after, None, |_| true).unwrap() {
            delivered.push(entry.seq);
            after = seq;
        }
        assert_eq!(delivered, [1, 3, 4]);
        assert_eq!(reopened.next(2, None, |_| true).unwrap().0.unwrap().seq, 3);
    }

    #[test]
    fn appends_wake_watchers() {
        let log = EventLog::new(2);
        let mut watcher = log.watch();
        assert!(!watcher.has_changed().unwrap());
        append(&log, None);
        assert!(watcher.has_changed().unwrap());
        assert_eq!(*watcher.borrow_and_update(), 1);
    }

    fn big_output(run_id: RunId, text: &str) -> ParallaxEvent {
        ParallaxEvent::AgentOutput {
            run_id,
            items: vec![AgentOutputItem::TextDelta {
                message_id: None,
                text: text.to_owned(),
            }],
        }
    }

    #[test]
    fn the_in_memory_window_evicts_on_bytes_before_it_would_on_count() {
        let run = RunId::generate();
        let one = serde_json::to_string(&big_output(run, &"a".repeat(80)))
            .unwrap()
            .len();
        // Room for a little more than one event, so a second one evicts the first even though
        // `retention` (1000) is nowhere close.
        let log = EventLog::new_bounded(1000, one + 10);
        log.append_in_memory(
            jiff::Timestamp::now(),
            None,
            big_output(run, &"a".repeat(80)),
        );
        log.append_in_memory(
            jiff::Timestamp::now(),
            None,
            big_output(run, &"b".repeat(80)),
        );
        log.append_in_memory(
            jiff::Timestamp::now(),
            None,
            big_output(run, &"c".repeat(80)),
        );

        assert_eq!(
            log.check(0),
            Err(Gone::Dropped),
            "the byte bound evicted seq 1 well before the count bound would"
        );
        assert_eq!(log.check(2), Ok(()));
        assert_eq!(log.next(2, None, |_| true).unwrap().0.unwrap().seq, 3);
    }

    #[test]
    fn host_retention_below_the_in_memory_retention_is_clamped_up() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("plxd.sqlite3");
        let run = RunId::generate();
        // Ask for host_retention 1 with retention 3: without the clamp in `EventLog::with`,
        // pruning would keep only the single newest host event, taking seq 3 and 4 down with
        // seq 1 even though they're inside what a restart still reloads.
        let store = StoreHandle::open(&path, 3, usize::MAX, 1);
        put(&store, None, ParallaxEvent::Unknown); // seq 1: host
        put(&store, None, finished(run)); // seq 2: run, never pruned
        put(&store, None, ParallaxEvent::Unknown); // seq 3: host
        put(&store, None, ParallaxEvent::Unknown); // seq 4: host
        put(&store, None, ParallaxEvent::Unknown); // seq 5: host, old enough to prune seq 1
        let id = store.log().id();
        drop(store);

        let reopened = StoreHandle::open(&path, 3, usize::MAX, 1).log();
        assert_eq!(reopened.id(), id, "the log did not start over");
        assert_eq!(reopened.head(), 5);

        // The clamp made the effective host_retention 3, so only seq 1 (older than every host
        // event the newest-3 window could ever need) was pruned; seq 3 and 4 survived.
        assert_eq!(
            reopened.check(2),
            Ok(()),
            "no silent gap: everything the newest-3 window owes seq 2 is still there"
        );
        let mut seqs = Vec::new();
        let mut after = 2;
        while let (Some(entry), seq) = reopened.next(after, None, |_| true).unwrap() {
            seqs.push(entry.seq);
            after = seq;
        }
        assert_eq!(seqs, [3, 4, 5], "no hole between the reloaded events");

        // seq 1 is genuinely gone (it's outside the reloaded window entirely), so a client that
        // saw it still correctly needs a resync.
        assert_eq!(reopened.check(0), Err(Gone::Dropped));
    }

    #[test]
    fn reopening_with_a_small_byte_bound_trims_the_reloaded_window() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("plxd.sqlite3");
        let run = RunId::generate();
        let one = serde_json::to_string(&big_output(run, &"a".repeat(80)))
            .unwrap()
            .len();
        let store = StoreHandle::open(&path, 1000, usize::MAX, 1000);
        for text in ["a", "b", "c"] {
            put(&store, None, big_output(run, &text.repeat(80)));
        }
        drop(store);

        // `retention` (1000) is nowhere close to 3, so only the byte bound should trim this on
        // reload, before any append ever runs against the reopened log.
        let reopened = StoreHandle::open(&path, 1000, one + 10, 1000).log();
        assert_eq!(
            reopened.check(0),
            Err(Gone::Dropped),
            "the byte bound trimmed what was reloaded, not just what a later append would evict"
        );
        assert_eq!(reopened.check(2), Ok(()));
        assert_eq!(reopened.next(2, None, |_| true).unwrap().0.unwrap().seq, 3);
    }

    /// #190 N2: `run_events` reads through its own connection, so a page held open doesn't wait
    /// on, or make wait, a concurrent append.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn an_append_is_not_blocked_by_a_long_page_read() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("plxd.sqlite3");
        let store = open(&path, 10);
        let log = store.log();
        let (started_tx, started_rx) = std::sync::mpsc::channel();
        let (release_tx, release_rx) = std::sync::mpsc::channel::<()>();
        let reading = std::thread::spawn(move || {
            let reader = log
                .reader
                .as_ref()
                .expect("a stored log has its own read connection");
            let _guard = reader.lock().unwrap();
            started_tx.send(()).unwrap();
            // Held "reading" until the test says otherwise, standing in for a slow page.
            release_rx.recv().unwrap();
        });
        started_rx.recv().unwrap();

        let seq = tokio::time::timeout(
            Duration::from_secs(5),
            store.append(jiff::Timestamp::now(), None, ParallaxEvent::Unknown),
        )
        .await
        .expect("an append waited on a concurrent page read");
        assert_eq!(seq, 1);

        release_tx.send(()).unwrap();
        reading.join().unwrap();
    }

    /// #190 review: an append whose caller is dropped mid-wait still runs, so the next one gets
    /// the next `seq` and the database agrees with memory.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn an_aborted_appends_job_still_publishes_so_the_next_one_does_not_collide() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("plxd.sqlite3");
        let store = Arc::new(open(&path, 10));

        // Occupies the store's thread, so the append below is still queued when it's aborted.
        let (started_tx, started_rx) = std::sync::mpsc::channel::<()>();
        let (release_tx, release_rx) = std::sync::mpsc::channel::<()>();
        let occupied = tokio::spawn({
            let store = Arc::clone(&store);
            async move {
                store
                    .run(&CancellationToken::new(), move |_| {
                        started_tx.send(()).unwrap();
                        release_rx.recv().unwrap();
                        Ok(())
                    })
                    .await
            }
        });
        tokio::task::spawn_blocking(move || started_rx.recv().unwrap())
            .await
            .unwrap();

        let aborted = tokio::spawn({
            let store = Arc::clone(&store);
            async move {
                store
                    .append(jiff::Timestamp::now(), None, ParallaxEvent::Unknown)
                    .await
            }
        });
        tokio::time::sleep(Duration::from_millis(50)).await;
        aborted.abort();
        let _ = aborted.await;
        release_tx.send(()).unwrap();
        occupied.await.unwrap().unwrap();

        let seq = store
            .append(jiff::Timestamp::now(), None, ParallaxEvent::Unknown)
            .await;
        assert_eq!(
            seq, 2,
            "the next append must not reuse the aborted append's seq"
        );
        assert_eq!(store.log().head(), 2);

        let raw = rusqlite::Connection::open(&path).unwrap();
        let seqs: Vec<i64> = raw
            .prepare("SELECT seq FROM events ORDER BY seq")
            .unwrap()
            .query_map([], |row| row.get(0))
            .unwrap()
            .collect::<Result<_, _>>()
            .unwrap();
        assert_eq!(
            seqs,
            [1, 2],
            "both events are stored under distinct seqs, agreeing with memory"
        );
    }
}
