//! Tasks and notifying threads on the user's other computers (0101). plxd follows each open row
//! until its run ends there, across restarts. The daemon owns what `status`, `delivery`, and
//! `completion_wake` mean; this crate stores them as text.

use jiff::Timestamp;
use rusqlite::{OptionalExtension, Row, params};
use uuid::Uuid;

use crate::error::StoreError;
use crate::{Store, timestamp};

/// One remote run's row.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RemoteRun {
    /// Its run id on the other computer.
    pub id: Uuid,
    /// The computer's relay id.
    pub host_id: String,
    /// The computer's name when the run started.
    pub host_name: String,
    /// The run here that started it, which its end wakes.
    pub parent: Uuid,
    pub title: String,
    /// Whether `delegate_task` started it, rather than `thread_launch`.
    pub task: bool,
    pub completion_wake: String,
    pub delivery: String,
    pub status: String,
    /// The end of its last output, once it ended.
    pub summary: Option<String>,
    /// Why plxd ended it, when the computer refused or left.
    pub reason: Option<String>,
    /// When plxd saw it end. `None` while it's open.
    pub ended_at: Option<Timestamp>,
    /// When plxd recorded it, just before asking the computer to start it.
    pub created_at: Timestamp,
}

const COLUMNS: &str = "id, host_id, host_name, parent, title, task, completion_wake, delivery, \
                       status, summary, reason, ended_at, created_at";

/// A row's columns that need parsing: its id, parent, end, and creation.
type Unparsed = (String, String, Option<String>, String);

fn from_row(row: &Row<'_>) -> rusqlite::Result<(RemoteRun, Unparsed)> {
    Ok((
        RemoteRun {
            id: Uuid::nil(),
            host_id: row.get(1)?,
            host_name: row.get(2)?,
            parent: Uuid::nil(),
            title: row.get(4)?,
            task: row.get(5)?,
            completion_wake: row.get(6)?,
            delivery: row.get(7)?,
            status: row.get(8)?,
            summary: row.get(9)?,
            reason: row.get(10)?,
            ended_at: None,
            created_at: Timestamp::UNIX_EPOCH,
        },
        (row.get(0)?, row.get(3)?, row.get(11)?, row.get(12)?),
    ))
}

fn parsed(
    (mut run, (id, parent, ended_at, created_at)): (RemoteRun, Unparsed),
) -> Result<RemoteRun, StoreError> {
    run.id = Uuid::parse_str(&id)?;
    run.parent = Uuid::parse_str(&parent)?;
    run.ended_at = ended_at.as_deref().map(timestamp::parse).transpose()?;
    run.created_at = timestamp::parse(&created_at)?;
    Ok(run)
}

impl Store {
    /// Adds `run`, unless a retry already did, and answers whether this added it. The row's
    /// `ended_at` starts empty.
    ///
    /// # Errors
    ///
    /// A database error.
    pub fn add_remote_run(&self, run: &RemoteRun) -> Result<bool, StoreError> {
        let added = self
            .conn
            .prepare_cached(
                "INSERT INTO remote_runs (id, host_id, host_name, parent, title, task,
                     completion_wake, delivery, status, created_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
                 ON CONFLICT (id) DO NOTHING",
            )?
            .execute(params![
                run.id.to_string(),
                run.host_id,
                run.host_name,
                run.parent.to_string(),
                run.title,
                run.task,
                run.completion_wake,
                run.delivery,
                run.status,
                timestamp::format(run.created_at),
            ])?;
        Ok(added > 0)
    }

    /// Run `id`'s row, if it has one.
    ///
    /// # Errors
    ///
    /// A database error, or an error if a stored id or time is corrupt.
    pub fn remote_run(&self, id: Uuid) -> Result<Option<RemoteRun>, StoreError> {
        self.conn
            .prepare_cached(&format!("SELECT {COLUMNS} FROM remote_runs WHERE id = ?1"))?
            .query_row(params![id.to_string()], from_row)
            .optional()?
            .map(parsed)
            .transpose()
    }

    /// The rows plxd follows: those with no end yet.
    ///
    /// # Errors
    ///
    /// A database error, or an error if a stored id or time is corrupt.
    pub fn open_remote_runs(&self) -> Result<Vec<RemoteRun>, StoreError> {
        self.remote_runs_where("ended_at IS NULL")
    }

    /// The rows that ended with a result still to deliver: for waking parents after a restart.
    ///
    /// # Errors
    ///
    /// A database error, or an error if a stored id or time is corrupt.
    pub fn undelivered_remote_runs(&self) -> Result<Vec<RemoteRun>, StoreError> {
        self.remote_runs_where("ended_at IS NOT NULL AND delivery = 'pending'")
    }

    fn remote_runs_where(&self, filter: &str) -> Result<Vec<RemoteRun>, StoreError> {
        let mut statement = self.conn.prepare_cached(&format!(
            "SELECT {COLUMNS} FROM remote_runs WHERE {filter} ORDER BY created_at"
        ))?;
        let rows = statement.query_map([], from_row)?;
        rows.map(|row| parsed(row?)).collect()
    }

    /// Records that run `id` ended, and answers its row and when, or `None` for a row that's gone
    /// or already ended.
    ///
    /// # Errors
    ///
    /// A database error, or an error if a stored id or time is corrupt.
    pub fn end_remote_run(
        &self,
        id: Uuid,
        status: &str,
        summary: Option<&str>,
        reason: Option<&str>,
    ) -> Result<Option<RemoteRun>, StoreError> {
        let changed = self
            .conn
            .prepare_cached(
                "UPDATE remote_runs SET status = ?2, summary = ?3, reason = ?4, ended_at = ?5
                 WHERE id = ?1 AND ended_at IS NULL",
            )?
            .execute(params![
                id.to_string(),
                status,
                summary,
                reason,
                timestamp::now()
            ])?;
        if changed == 0 {
            return Ok(None);
        }
        self.remote_run(id)
    }

    /// Follows run `id` again, as a message went to it. Whether a thread's ended row reopened: a
    /// task stays ended, since a new round is a new task.
    ///
    /// # Errors
    ///
    /// A database error.
    pub fn reopen_remote_run(&self, id: Uuid, status: &str) -> Result<bool, StoreError> {
        let changed = self
            .conn
            .prepare_cached(
                "UPDATE remote_runs SET status = ?2, summary = NULL, reason = NULL, ended_at = NULL
                 WHERE id = ?1 AND ended_at IS NOT NULL AND task = 0",
            )?
            .execute(params![id.to_string(), status])?;
        Ok(changed > 0)
    }

    /// Sets how run `id`'s end reaches its parent.
    ///
    /// # Errors
    ///
    /// A database error.
    pub fn set_remote_run_delivery(
        &self,
        id: Uuid,
        delivery: &str,
        completion_wake: &str,
    ) -> Result<(), StoreError> {
        self.conn
            .prepare_cached(
                "UPDATE remote_runs SET delivery = ?2, completion_wake = ?3 WHERE id = ?1",
            )?
            .execute(params![id.to_string(), delivery, completion_wake])?;
        Ok(())
    }

    /// Forgets run `id`, which the computer refused to start.
    ///
    /// # Errors
    ///
    /// A database error.
    pub fn delete_remote_run(&self, id: Uuid) -> Result<(), StoreError> {
        self.conn
            .prepare_cached("DELETE FROM remote_runs WHERE id = ?1")?
            .execute(params![id.to_string()])?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use uuid::Uuid;

    use super::RemoteRun;
    use crate::Store;

    fn open_row(parent: Uuid, task: bool) -> RemoteRun {
        RemoteRun {
            id: Uuid::now_v7(),
            host_id: "host".to_owned(),
            host_name: "Mac".to_owned(),
            parent,
            title: "Fix it".to_owned(),
            task,
            completion_wake: "always".to_owned(),
            delivery: "pending".to_owned(),
            status: "running".to_owned(),
            summary: None,
            reason: None,
            ended_at: None,
            created_at: jiff::Timestamp::now(),
        }
    }

    #[test]
    fn a_row_stays_open_until_it_ends_and_only_a_threads_reopens() {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::open(dir.path().join("plxd.sqlite3")).unwrap();
        // Rows hang off a run, which this table doesn't need for what it stores.
        store
            .conn
            .execute_batch("PRAGMA foreign_keys = OFF;")
            .unwrap();
        let (thread, task) = (
            open_row(Uuid::now_v7(), false),
            open_row(Uuid::now_v7(), true),
        );
        assert!(store.add_remote_run(&thread).unwrap());
        assert!(
            !store.add_remote_run(&thread).unwrap(),
            "a retry adds nothing"
        );
        store.add_remote_run(&task).unwrap();
        assert_eq!(store.open_remote_runs().unwrap().len(), 2);

        let ended = store
            .end_remote_run(thread.id, "completed", Some("done"), None)
            .unwrap()
            .unwrap();
        assert_eq!(ended.summary.as_deref(), Some("done"));
        assert!(ended.ended_at.is_some());
        assert!(
            store
                .end_remote_run(thread.id, "failed", None, None)
                .unwrap()
                .is_none(),
            "an ended row keeps its first end"
        );
        store
            .end_remote_run(task.id, "completed", None, None)
            .unwrap();
        assert_eq!(store.undelivered_remote_runs().unwrap().len(), 2);

        assert!(store.reopen_remote_run(thread.id, "running").unwrap());
        assert!(!store.reopen_remote_run(task.id, "running").unwrap());
        assert_eq!(store.open_remote_runs().unwrap().len(), 1);

        store
            .set_remote_run_delivery(task.id, "acknowledged", "always")
            .unwrap();
        assert!(store.undelivered_remote_runs().unwrap().is_empty());
    }
}
