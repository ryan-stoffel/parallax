use jiff::Timestamp;
use rusqlite::{OptionalExtension, Row, params};
use uuid::Uuid;

use crate::Store;
use crate::error::StoreError;
use crate::timestamp;

/// One entry of 0007's event log, as stored (#156). The daemon owns what `kind` and `payload`
/// mean; this crate stores them as text.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StoredEvent {
    /// The daemon-wide sequence number, starting at 1.
    pub seq: u64,
    pub time: Timestamp,
    /// The project it belongs to, or `None` for a host-level event.
    pub project_id: Option<Uuid>,
    /// The agent run it belongs to, if any.
    pub run_id: Option<Uuid>,
    /// The event's `kind`, such as `agent.output`.
    pub kind: String,
    /// The event's JSON.
    pub payload: String,
}

struct RawEvent {
    seq: u64,
    time: String,
    project_id: Option<String>,
    run_id: Option<String>,
    kind: String,
    payload: String,
}

impl RawEvent {
    fn from_row(row: &Row<'_>) -> rusqlite::Result<Self> {
        Ok(Self {
            seq: row.get(0)?,
            time: row.get(1)?,
            project_id: row.get(2)?,
            run_id: row.get(3)?,
            kind: row.get(4)?,
            payload: row.get(5)?,
        })
    }

    fn into_event(self) -> Result<StoredEvent, StoreError> {
        let uuid = |text: Option<String>| -> Result<Option<Uuid>, StoreError> {
            text.map(|text| Uuid::parse_str(&text))
                .transpose()
                .map_err(Into::into)
        };
        Ok(StoredEvent {
            seq: self.seq,
            time: timestamp::parse(&self.time)?,
            project_id: uuid(self.project_id)?,
            run_id: uuid(self.run_id)?,
            kind: self.kind,
            payload: self.payload,
        })
    }
}

const COLUMNS: &str = "seq, time, project_id, run_id, kind, payload";

/// A finished turn whose last `agent.output` is older than the in-memory window (0052).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CompactableTurn {
    /// The run the turn belongs to.
    pub run_id: Uuid,
    /// The turn's first `agent.output` `seq`.
    pub from: u64,
    /// The last batch's `seq`, reused by the rewritten row.
    pub last: u64,
}

impl Store {
    /// The event log's id: the stored one, or `new_id`, stored now, for a log that has none yet.
    ///
    /// # Errors
    ///
    /// A database error, or an error if the stored id is corrupt.
    pub fn event_log_id(&self, new_id: Uuid) -> Result<Uuid, StoreError> {
        self.conn.execute(
            "INSERT INTO log_meta (id, log_id) VALUES (1, ?1) ON CONFLICT (id) DO NOTHING",
            params![new_id.to_string()],
        )?;
        let text: String =
            self.conn
                .query_row("SELECT log_id FROM log_meta WHERE id = 1", [], |row| {
                    row.get(0)
                })?;
        Ok(Uuid::parse_str(&text)?)
    }

    /// Makes this connection's commits durable against a crash of the process but not of the
    /// machine (`synchronous = NORMAL`, which SQLite recommends with WAL). plxd's one write
    /// connection uses it, since it commits once per `agent.output` batch (0052).
    ///
    /// # Errors
    ///
    /// A database error.
    pub fn relax_sync(&self) -> Result<(), StoreError> {
        self.conn.pragma_update(None, "synchronous", "NORMAL")?;
        Ok(())
    }

    /// Appends `event` to the log. The statement is cached, since the writer runs it for every
    /// event.
    ///
    /// # Errors
    ///
    /// A database error, including a constraint error if its `seq` is taken.
    pub fn append_event(&self, event: &StoredEvent) -> Result<(), StoreError> {
        self.conn
            .prepare_cached(
                "INSERT INTO events (seq, time, project_id, run_id, kind, payload)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            )?
            .execute(params![
                event.seq,
                timestamp::format(event.time),
                event.project_id.map(|id| id.to_string()),
                event.run_id.map(|id| id.to_string()),
                event.kind,
                event.payload,
            ])?;
        Ok(())
    }

    /// The newest event's `seq`, or 0 for an empty log.
    ///
    /// # Errors
    ///
    /// A database error.
    pub fn event_head(&self) -> Result<u64, StoreError> {
        let head: Option<u64> = self
            .conn
            .query_row("SELECT MAX(seq) FROM events", [], |row| row.get(0))
            .optional()?
            .flatten();
        Ok(head.unwrap_or(0))
    }

    /// The newest events, oldest first, each passed through `map` as it is read: at most `limit`
    /// of them, and no more than `max_bytes` of payload, but always at least one when any exist.
    /// Rows come back newest first and are read one at a time, so this never reads past the row
    /// that puts it over budget, and a `map` that drops the payload never holds all of them.
    ///
    /// # Errors
    ///
    /// A database error, or an error if a stored id or timestamp is corrupt.
    pub fn latest_events<T>(
        &self,
        limit: usize,
        max_bytes: usize,
        mut map: impl FnMut(StoredEvent) -> T,
    ) -> Result<Vec<T>, StoreError> {
        let mut stmt = self.conn.prepare(&format!(
            "SELECT {COLUMNS} FROM events ORDER BY seq DESC LIMIT ?1"
        ))?;
        let limit = i64::try_from(limit.max(1)).unwrap_or(i64::MAX);
        let rows = stmt.query_map(params![limit], RawEvent::from_row)?;
        let mut events = Vec::new();
        let mut bytes = 0_usize;
        for row in rows {
            let event = row?.into_event()?;
            if !events.is_empty() && bytes + event.payload.len() > max_bytes {
                break;
            }
            bytes += event.payload.len();
            events.push(map(event));
        }
        events.reverse();
        Ok(events)
    }

    /// Run `run_id`'s events after `after`, oldest first: at most `limit` of them, and no more
    /// than `max_bytes` of payload, but always at least one when any exists. The flag says
    /// whether more events follow the last one returned.
    ///
    /// Rows are read one at a time, so a page never loads more than it returns plus one.
    ///
    /// # Errors
    ///
    /// A database error, or an error if a stored id or timestamp is corrupt.
    pub fn run_events(
        &self,
        run_id: Uuid,
        after: u64,
        limit: usize,
        max_bytes: usize,
    ) -> Result<(Vec<StoredEvent>, bool), StoreError> {
        let mut stmt = self.conn.prepare(&format!(
            "SELECT {COLUMNS} FROM events WHERE run_id = ?1 AND seq > ?2 ORDER BY seq ASC"
        ))?;
        let rows = stmt.query_map(params![run_id.to_string(), after], RawEvent::from_row)?;
        let mut events = Vec::new();
        let mut bytes = 0_usize;
        for row in rows {
            let event = row?.into_event()?;
            let full = events.len() >= limit.max(1)
                || (!events.is_empty() && bytes + event.payload.len() > max_bytes);
            if full {
                return Ok((events, true));
            }
            bytes += event.payload.len();
            events.push(event);
        }
        Ok((events, false))
    }

    /// Run `run_id`'s events before `before`, newest first: at most `limit` of them and about
    /// `max_bytes` of payload, but always at least one when any exists, as [`Store::run_events`]
    /// pages. The flag says whether older ones remain (PLX-372, PLX-490). Rows are read one at a
    /// time, so a reader that only wants the latest few never loads the rest. A page whose
    /// `before` sits inside a compacted turn also carries that turn's rewritten row (0052).
    ///
    /// # Errors
    ///
    /// A database error, or an error if a stored id or timestamp is corrupt.
    pub fn run_events_before(
        &self,
        run_id: Uuid,
        before: u64,
        limit: usize,
        max_bytes: usize,
    ) -> Result<(Vec<StoredEvent>, bool), StoreError> {
        let (mut events, more) = {
            let mut stmt = self.conn.prepare(&format!(
                "SELECT {COLUMNS} FROM events WHERE run_id = ?1 AND seq < ?2 ORDER BY seq DESC"
            ))?;
            let cursor = i64::try_from(before).unwrap_or(i64::MAX);
            let rows = stmt.query_map(params![run_id.to_string(), cursor], RawEvent::from_row)?;
            let mut events = Vec::new();
            let mut bytes = 0_usize;
            let mut more = false;
            for row in rows {
                let event = row?.into_event()?;
                let full = events.len() >= limit.max(1)
                    || (!events.is_empty() && bytes + event.payload.len() > max_bytes);
                if full {
                    more = true;
                    break;
                }
                bytes += event.payload.len();
                events.push(event);
            }
            (events, more)
        };
        if let Some(compacted) = self.compacted_covering(run_id, before)? {
            events.insert(0, compacted);
        }
        Ok((events, more))
    }

    /// The run's compacted `agent.output` whose `from` is before `before` and whose `seq` is at
    /// or after it, if there is one (0052): a newest-first page whose cursor sits inside that
    /// turn still needs the rewritten row. Compaction deletes the turn's other batches, so only
    /// the run's first `agent.output` at or after `before` can be that row, and only it is parsed.
    ///
    /// # Errors
    ///
    /// A database error, or an error if a stored id or timestamp is corrupt.
    pub fn compacted_covering(
        &self,
        run_id: Uuid,
        before: u64,
    ) -> Result<Option<StoredEvent>, StoreError> {
        let before = i64::try_from(before).unwrap_or(i64::MAX);
        let event = self
            .conn
            .query_row(
                &format!(
                    "SELECT {COLUMNS} FROM events
                     WHERE seq = (
                         SELECT MIN(seq) FROM events
                         WHERE run_id = ?1 AND kind = 'agent.output' AND seq >= ?2
                     )
                       AND json_valid(payload)
                       AND json_extract(payload, '$.compacted.from') < ?2"
                ),
                params![run_id.to_string(), before],
                RawEvent::from_row,
            )
            .optional()?
            .map(RawEvent::into_event)
            .transpose()?;
        Ok(event)
    }

    /// The oldest finished turn whose last `agent.output` is after `after`, older than `floor`, and
    /// not rewritten yet (0052).
    ///
    /// # Errors
    ///
    /// A database error, or an error if a stored id is corrupt.
    pub fn find_compactable_turn(
        &self,
        floor: u64,
        after: u64,
    ) -> Result<Option<CompactableTurn>, StoreError> {
        let floor = i64::try_from(floor).unwrap_or(i64::MAX);
        let after = i64::try_from(after).unwrap_or(i64::MAX);
        let Some((last, run)) = self
            .conn
            .query_row(
                "SELECT seq, run_id FROM events
                 WHERE kind = 'agent.output'
                   AND seq < ?1
                   AND seq > ?2
                   AND run_id IS NOT NULL
                   AND json_valid(payload)
                   AND json_extract(payload, '$.compacted') IS NULL
                   AND EXISTS (
                       SELECT 1 FROM json_each(events.payload, '$.items') AS item
                       WHERE json_extract(item.value, '$.kind') = 'turnFinished'
                   )
                 ORDER BY seq ASC
                 LIMIT 1",
                params![floor, after],
                |row| {
                    let seq: u64 = row.get(0)?;
                    let run_id: String = row.get(1)?;
                    Ok((seq, run_id))
                },
            )
            .optional()?
        else {
            return Ok(None);
        };
        let run_id = Uuid::parse_str(&run)?;
        let prev: Option<u64> = self
            .conn
            .query_row(
                "SELECT MAX(seq) FROM events
                 WHERE run_id = ?1
                   AND kind = 'agent.output'
                   AND seq < ?2
                   AND json_valid(payload)
                   AND EXISTS (
                       SELECT 1 FROM json_each(payload, '$.items') AS item
                       WHERE json_extract(item.value, '$.kind') = 'turnFinished'
                   )",
                params![run_id.to_string(), last],
                |row| row.get(0),
            )
            .optional()?
            .flatten();
        let from: u64 = self.conn.query_row(
            "SELECT MIN(seq) FROM events
             WHERE run_id = ?1 AND kind = 'agent.output' AND seq > ?2 AND seq <= ?3",
            params![run_id.to_string(), prev.unwrap_or(0), last],
            |row| row.get(0),
        )?;
        Ok(Some(CompactableTurn { run_id, from, last }))
    }

    /// `run_id`'s `agent.output` rows from `from` through `last`, oldest first.
    ///
    /// # Errors
    ///
    /// A database error, or an error if a stored id or timestamp is corrupt.
    pub fn output_events_in(
        &self,
        run_id: Uuid,
        from: u64,
        last: u64,
    ) -> Result<Vec<StoredEvent>, StoreError> {
        let mut stmt = self.conn.prepare(&format!(
            "SELECT {COLUMNS} FROM events
             WHERE run_id = ?1 AND kind = 'agent.output' AND seq >= ?2 AND seq <= ?3
             ORDER BY seq ASC"
        ))?;
        let rows = stmt.query_map(params![run_id.to_string(), from, last], RawEvent::from_row)?;
        let mut events = Vec::new();
        for row in rows {
            events.push(row?.into_event()?);
        }
        Ok(events)
    }

    /// Replaces the payload of the event at `seq`.
    ///
    /// # Errors
    ///
    /// A database error.
    pub fn update_event_payload(&self, seq: u64, payload: &str) -> Result<(), StoreError> {
        self.conn.execute(
            "UPDATE events SET payload = ?2 WHERE seq = ?1",
            params![seq, payload],
        )?;
        Ok(())
    }

    /// Deletes the events at `seqs`.
    ///
    /// # Errors
    ///
    /// A database error.
    pub fn delete_events(&self, seqs: &[u64]) -> Result<usize, StoreError> {
        if seqs.is_empty() {
            return Ok(0);
        }
        // A long streamed turn can exceed SQLite's bound-variable limit.
        let mut deleted = 0;
        for chunk in seqs.chunks(900) {
            let marks = chunk.iter().map(|_| "?").collect::<Vec<_>>().join(", ");
            let mut stmt = self
                .conn
                .prepare(&format!("DELETE FROM events WHERE seq IN ({marks})"))?;
            let params = rusqlite::params_from_iter(chunk.iter().copied());
            deleted += stmt.execute(params)?;
        }
        Ok(deleted)
    }

    /// Deletes host and project events (those with no `run_id`, such as `project.created` and
    /// `context.changed`) beyond the newest `keep`, to bound the table's growth (#187). An agent
    /// run's events are never touched here: they stay as long as the run's own row does, and
    /// nothing removes a run's row yet. Returns how many rows were deleted.
    ///
    /// # Errors
    ///
    /// A database error.
    pub fn prune_host_events(&self, keep: usize) -> Result<usize, StoreError> {
        let keep = i64::try_from(keep).unwrap_or(i64::MAX);
        // The cutoff is the `seq` of the (keep + 1)-th newest host event, found by `OFFSET`
        // rather than by collecting the newest `keep` into a list: on a table with many run
        // events mixed in, this measures at about a tenth of the cost. With fewer than `keep`
        // host events, the subquery has no row, its `seq` reads as `NULL`, and `seq <= NULL` is
        // never true, so nothing is deleted.
        let deleted = self
            .conn
            .prepare_cached(
                "DELETE FROM events
                 WHERE run_id IS NULL
                   AND seq <= (
                       SELECT seq FROM events WHERE run_id IS NULL ORDER BY seq DESC LIMIT 1 OFFSET ?1
                   )",
            )?
            .execute(params![keep])?;
        Ok(deleted)
    }
}
