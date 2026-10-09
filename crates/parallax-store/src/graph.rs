//! The thread graph's projection rows (0059 phase 2): runs, their attempts, execution nodes, and
//! runtime requests. The daemon folds a thread's events into them in each event's own
//! transaction, and owns what their statuses and payloads mean; this crate stores them as text.
//! Every statement the fold runs per event is cached.

use rusqlite::{OptionalExtension, Row, params};
use uuid::Uuid;

use crate::Store;
use crate::error::StoreError;

/// One run (T3's Run): a counted turn of a thread, or a message queued to become one.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GraphRun {
    pub id: Uuid,
    pub thread_id: Uuid,
    /// Its place among the thread's runs, from 1, once it starts. `None` while queued.
    pub ordinal: Option<u32>,
    pub status: String,
    /// Its place in the queue while queued, first to be sent first.
    pub position: Option<u32>,
    /// The `seq` of the event that started it.
    pub first_seq: Option<u64>,
    /// Its active attempt's ordinal, from 1.
    pub attempt: Option<u32>,
    pub payload: String,
}

impl GraphRun {
    /// A row's ids as text, which [`run`] parses, and the rest.
    fn from_row(row: &Row<'_>) -> rusqlite::Result<(String, String, Self)> {
        Ok((
            row.get(0)?,
            row.get(1)?,
            Self {
                id: Uuid::nil(),
                thread_id: Uuid::nil(),
                ordinal: row.get(2)?,
                status: row.get(3)?,
                position: row.get(4)?,
                first_seq: row.get(5)?,
                attempt: row.get(6)?,
                payload: row.get(7)?,
            },
        ))
    }
}

const RUN_COLUMNS: &str = "id, thread_id, ordinal, status, position, first_seq, attempt, payload";

fn run(row: (String, String, GraphRun)) -> Result<GraphRun, StoreError> {
    let (id, thread_id, run) = row;
    Ok(GraphRun {
        id: Uuid::parse_str(&id)?,
        thread_id: Uuid::parse_str(&thread_id)?,
        ..run
    })
}

/// An execution node: the root turn, a tool call, an approval, a user-input request, or a
/// subagent.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GraphNode {
    pub id: String,
    pub thread_id: Uuid,
    pub run_id: Option<Uuid>,
    pub parent_id: Option<String>,
    pub kind: String,
    pub status: String,
    pub payload: String,
}

/// A provider callback that waits for an answer: a permission request.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RuntimeRequest {
    pub id: Uuid,
    pub thread_id: Uuid,
    pub node_id: Option<String>,
    pub status: String,
    pub payload: String,
}

impl Store {
    /// The thread's runs in progress: those `starting`, `running`, or `waiting`, oldest first.
    /// A follow-up's turn can start before the one it follows ends, so there can be two.
    ///
    /// # Errors
    ///
    /// A database error, or an error if a stored id is corrupt.
    pub fn open_graph_runs(&self, thread_id: Uuid) -> Result<Vec<GraphRun>, StoreError> {
        let mut stmt = self.conn.prepare_cached(&format!(
            "SELECT {RUN_COLUMNS} FROM thread_runs
             WHERE thread_id = ?1 AND status IN ('starting', 'running', 'waiting')
             ORDER BY ordinal"
        ))?;
        let rows = stmt.query_map(params![thread_id.to_string()], GraphRun::from_row)?;
        rows.map(|row| run(row?)).collect()
    }

    /// Thread `thread_id`'s run `id`, if it exists. A fork's copied runs keep their ids.
    ///
    /// # Errors
    ///
    /// A database error, or an error if a stored id is corrupt.
    pub fn graph_run(&self, thread_id: Uuid, id: Uuid) -> Result<Option<GraphRun>, StoreError> {
        self.conn
            .prepare_cached(&format!(
                "SELECT {RUN_COLUMNS} FROM thread_runs WHERE thread_id = ?1 AND id = ?2"
            ))?
            .query_row(
                params![thread_id.to_string(), id.to_string()],
                GraphRun::from_row,
            )
            .optional()?
            .map(run)
            .transpose()
    }

    /// The thread's runs: those that started, by ordinal, then the queued ones, first to be sent
    /// first.
    ///
    /// # Errors
    ///
    /// A database error, or an error if a stored id is corrupt.
    pub fn graph_runs(&self, thread_id: Uuid) -> Result<Vec<GraphRun>, StoreError> {
        let mut stmt = self.conn.prepare_cached(&format!(
            "SELECT {RUN_COLUMNS} FROM thread_runs WHERE thread_id = ?1
             ORDER BY ordinal IS NULL, ordinal, position"
        ))?;
        let rows = stmt.query_map(params![thread_id.to_string()], GraphRun::from_row)?;
        rows.map(|row| run(row?)).collect()
    }

    /// The ordinal the thread's next run starts with.
    ///
    /// # Errors
    ///
    /// A database error.
    pub fn next_run_ordinal(&self, thread_id: Uuid) -> Result<u32, StoreError> {
        let last: Option<u32> = self
            .conn
            .prepare_cached("SELECT MAX(ordinal) FROM thread_runs WHERE thread_id = ?1")?
            .query_row(params![thread_id.to_string()], |row| row.get(0))?;
        Ok(last.unwrap_or(0) + 1)
    }

    /// Inserts `run`, or replaces the row with its id.
    ///
    /// # Errors
    ///
    /// A database error.
    pub fn put_graph_run(&self, run: &GraphRun) -> Result<(), StoreError> {
        self.conn
            .prepare_cached(&format!(
                "INSERT OR REPLACE INTO thread_runs ({RUN_COLUMNS})
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)"
            ))?
            .execute(params![
                run.id.to_string(),
                run.thread_id.to_string(),
                run.ordinal,
                run.status,
                run.position,
                run.first_seq,
                run.attempt,
                run.payload,
            ])?;
        Ok(())
    }

    /// Replaces the thread's queued runs with `queued`, which hold their own positions. A run
    /// that left the queue was sent or cancelled: the one sent comes back when it starts.
    ///
    /// # Errors
    ///
    /// A database error.
    pub fn replace_queued_runs(
        &self,
        thread_id: Uuid,
        queued: &[GraphRun],
    ) -> Result<(), StoreError> {
        self.conn
            .prepare_cached("DELETE FROM thread_runs WHERE thread_id = ?1 AND status = 'queued'")?
            .execute(params![thread_id.to_string()])?;
        for run in queued {
            self.put_graph_run(run)?;
        }
        Ok(())
    }

    /// Inserts attempt `ordinal` of run `run_id`, or replaces it.
    ///
    /// # Errors
    ///
    /// A database error.
    pub fn put_run_attempt(
        &self,
        run_id: Uuid,
        ordinal: u32,
        thread_id: Uuid,
        reason: &str,
        status: &str,
    ) -> Result<(), StoreError> {
        self.conn
            .prepare_cached(
                "INSERT OR REPLACE INTO run_attempts (run_id, ordinal, thread_id, reason, status)
                 VALUES (?1, ?2, ?3, ?4, ?5)",
            )?
            .execute(params![
                run_id.to_string(),
                ordinal,
                thread_id.to_string(),
                reason,
                status
            ])?;
        Ok(())
    }

    /// Sets attempt `ordinal` of run `run_id`'s status. One that doesn't exist is left alone.
    ///
    /// # Errors
    ///
    /// A database error.
    pub fn set_attempt_status(
        &self,
        thread_id: Uuid,
        run_id: Uuid,
        ordinal: u32,
        status: &str,
    ) -> Result<(), StoreError> {
        self.conn
            .prepare_cached(
                "UPDATE run_attempts SET status = ?4
                 WHERE thread_id = ?1 AND run_id = ?2 AND ordinal = ?3",
            )?
            .execute(params![
                thread_id.to_string(),
                run_id.to_string(),
                ordinal,
                status
            ])?;
        Ok(())
    }

    /// Run `run_id`'s attempts as `(ordinal, reason, status)`, oldest first.
    ///
    /// # Errors
    ///
    /// A database error.
    pub fn run_attempts(
        &self,
        thread_id: Uuid,
        run_id: Uuid,
    ) -> Result<Vec<(u32, String, String)>, StoreError> {
        let mut stmt = self.conn.prepare_cached(
            "SELECT ordinal, reason, status FROM run_attempts
             WHERE thread_id = ?1 AND run_id = ?2 ORDER BY ordinal",
        )?;
        let rows = stmt.query_map(params![thread_id.to_string(), run_id.to_string()], |row| {
            Ok((row.get(0)?, row.get(1)?, row.get(2)?))
        })?;
        Ok(rows.collect::<Result<_, _>>()?)
    }

    /// Inserts `node`, or replaces the row with its id.
    ///
    /// # Errors
    ///
    /// A database error.
    pub fn put_node(&self, node: &GraphNode) -> Result<(), StoreError> {
        self.conn
            .prepare_cached(
                "INSERT OR REPLACE INTO nodes
                    (id, thread_id, run_id, parent_id, kind, status, payload)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            )?
            .execute(params![
                node.id,
                node.thread_id.to_string(),
                node.run_id.map(|id| id.to_string()),
                node.parent_id,
                node.kind,
                node.status,
                node.payload,
            ])?;
        Ok(())
    }

    /// Node `id`'s kind and status, if it exists.
    ///
    /// # Errors
    ///
    /// A database error.
    pub fn node_status(
        &self,
        thread_id: Uuid,
        id: &str,
    ) -> Result<Option<(String, String)>, StoreError> {
        Ok(self
            .conn
            .prepare_cached("SELECT kind, status FROM nodes WHERE thread_id = ?1 AND id = ?2")?
            .query_row(params![thread_id.to_string(), id], |row| {
                Ok((row.get(0)?, row.get(1)?))
            })
            .optional()?)
    }

    /// Sets node `id`'s status. A node that doesn't exist is left alone.
    ///
    /// # Errors
    ///
    /// A database error.
    pub fn set_node_status(
        &self,
        thread_id: Uuid,
        id: &str,
        status: &str,
    ) -> Result<(), StoreError> {
        self.conn
            .prepare_cached("UPDATE nodes SET status = ?3 WHERE thread_id = ?1 AND id = ?2")?
            .execute(params![thread_id.to_string(), id, status])?;
        Ok(())
    }

    /// Ends every node of the thread's that is still `running` or `waiting` with `status`: what
    /// a CLI that exited left open.
    ///
    /// # Errors
    ///
    /// A database error.
    pub fn end_open_nodes(&self, thread_id: Uuid, status: &str) -> Result<(), StoreError> {
        self.conn
            .prepare_cached(
                "UPDATE nodes SET status = ?2
                 WHERE thread_id = ?1 AND status IN ('running', 'waiting')",
            )?
            .execute(params![thread_id.to_string(), status])?;
        Ok(())
    }

    /// Run `run_id`'s nodes, in the order they were made.
    ///
    /// # Errors
    ///
    /// A database error, or an error if a stored id is corrupt.
    pub fn run_nodes(&self, thread_id: Uuid, run_id: Uuid) -> Result<Vec<GraphNode>, StoreError> {
        let mut stmt = self.conn.prepare_cached(
            "SELECT id, parent_id, kind, status, payload FROM nodes
             WHERE thread_id = ?1 AND run_id = ?2 ORDER BY rowid",
        )?;
        let rows = stmt.query_map(params![thread_id.to_string(), run_id.to_string()], |row| {
            Ok(GraphNode {
                id: row.get(0)?,
                thread_id,
                run_id: Some(run_id),
                parent_id: row.get(1)?,
                kind: row.get(2)?,
                status: row.get(3)?,
                payload: row.get(4)?,
            })
        })?;
        Ok(rows.collect::<Result<_, _>>()?)
    }

    /// Inserts `request`, or replaces the row with its id.
    ///
    /// # Errors
    ///
    /// A database error.
    pub fn put_runtime_request(&self, request: &RuntimeRequest) -> Result<(), StoreError> {
        self.conn
            .prepare_cached(
                "INSERT OR REPLACE INTO runtime_requests (id, thread_id, node_id, status, payload)
                 VALUES (?1, ?2, ?3, ?4, ?5)",
            )?
            .execute(params![
                request.id.to_string(),
                request.thread_id.to_string(),
                request.node_id,
                request.status,
                request.payload,
            ])?;
        Ok(())
    }

    /// Request `id`'s node, if the request exists.
    ///
    /// # Errors
    ///
    /// A database error.
    pub fn runtime_request_node(
        &self,
        thread_id: Uuid,
        id: Uuid,
    ) -> Result<Option<Option<String>>, StoreError> {
        Ok(self
            .conn
            .prepare_cached(
                "SELECT node_id FROM runtime_requests WHERE thread_id = ?1 AND id = ?2",
            )?
            .query_row(params![thread_id.to_string(), id.to_string()], |row| {
                row.get(0)
            })
            .optional()?)
    }

    /// Sets request `id`'s status. A request that doesn't exist is left alone.
    ///
    /// # Errors
    ///
    /// A database error.
    pub fn set_runtime_request_status(
        &self,
        thread_id: Uuid,
        id: Uuid,
        status: &str,
    ) -> Result<(), StoreError> {
        self.conn
            .prepare_cached(
                "UPDATE runtime_requests SET status = ?3 WHERE thread_id = ?1 AND id = ?2",
            )?
            .execute(params![thread_id.to_string(), id.to_string(), status])?;
        Ok(())
    }

    /// Ends the thread's pending requests with `status`.
    ///
    /// # Errors
    ///
    /// A database error.
    pub fn end_pending_requests(&self, thread_id: Uuid, status: &str) -> Result<(), StoreError> {
        self.conn
            .prepare_cached(
                "UPDATE runtime_requests SET status = ?2
                 WHERE thread_id = ?1 AND status = 'pending'",
            )?
            .execute(params![thread_id.to_string(), status])?;
        Ok(())
    }

    /// The pending requests of thread `thread_id`, or of every thread, oldest first.
    ///
    /// # Errors
    ///
    /// A database error, or an error if a stored id is corrupt.
    pub fn pending_requests(
        &self,
        thread_id: Option<Uuid>,
    ) -> Result<Vec<RuntimeRequest>, StoreError> {
        let mut stmt = self.conn.prepare_cached(
            "SELECT id, thread_id, node_id, payload FROM runtime_requests
             WHERE status = 'pending' AND (?1 IS NULL OR thread_id = ?1) ORDER BY rowid",
        )?;
        let rows = stmt.query_map(params![thread_id.map(|id| id.to_string())], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get(2)?,
                row.get(3)?,
            ))
        })?;
        rows.map(|row| {
            let (id, thread_id, node_id, payload) = row?;
            Ok(RuntimeRequest {
                id: Uuid::parse_str(&id)?,
                thread_id: Uuid::parse_str(&thread_id)?,
                node_id,
                status: "pending".to_owned(),
                payload,
            })
        })
        .collect()
    }

    /// Whether thread `thread_id`'s stored events are folded into the graph.
    ///
    /// # Errors
    ///
    /// A database error.
    pub fn graph_imported(&self, thread_id: Uuid) -> Result<bool, StoreError> {
        Ok(self
            .conn
            .prepare_cached("SELECT 1 FROM graph_imports WHERE thread_id = ?1")?
            .query_row(params![thread_id.to_string()], |_| Ok(()))
            .optional()?
            .is_some())
    }

    /// Records that thread `thread_id`'s stored events are folded into the graph.
    ///
    /// # Errors
    ///
    /// A database error.
    pub fn mark_graph_imported(&self, thread_id: Uuid) -> Result<(), StoreError> {
        self.conn
            .prepare_cached("INSERT OR IGNORE INTO graph_imports (thread_id) VALUES (?1)")?
            .execute(params![thread_id.to_string()])?;
        Ok(())
    }

    /// The threads whose stored events aren't folded into the graph yet, newest first.
    ///
    /// # Errors
    ///
    /// A database error, or an error if a stored id is corrupt.
    pub fn threads_to_import(&self) -> Result<Vec<Uuid>, StoreError> {
        let mut stmt = self.conn.prepare(
            "SELECT id FROM runs WHERE id NOT IN (SELECT thread_id FROM graph_imports)
             ORDER BY created_at DESC",
        )?;
        let ids = stmt.query_map([], |row| row.get::<_, String>(0))?;
        ids.map(|id| Ok(Uuid::parse_str(&id?)?)).collect()
    }

    /// Sets the run (turn) that event `seq` belongs to, which an import learns after the event
    /// was stored.
    ///
    /// # Errors
    ///
    /// A database error.
    pub fn set_event_run(&self, seq: u64, run_id: Uuid) -> Result<(), StoreError> {
        self.conn
            .prepare_cached("UPDATE events SET run_id = ?2 WHERE seq = ?1")?
            .execute(params![seq, run_id.to_string()])?;
        Ok(())
    }
}

/// Deletes thread `id`'s graph rows, with its other rows.
pub(crate) fn delete_graph_rows(conn: &rusqlite::Connection, id: Uuid) -> Result<(), StoreError> {
    let key = id.to_string();
    for table in ["thread_runs", "run_attempts", "nodes", "runtime_requests"] {
        conn.execute(
            &format!("DELETE FROM {table} WHERE thread_id = ?1"),
            params![key],
        )?;
    }
    conn.execute(
        "DELETE FROM graph_imports WHERE thread_id = ?1",
        params![key],
    )?;
    Ok(())
}
