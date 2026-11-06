//! Scheduled tasks and pull request watches (0063). The daemon owns what their payloads mean;
//! this crate stores them as text, with the columns the timer and the sweep look up.

use jiff::Timestamp;
use rusqlite::{OptionalExtension, params};
use uuid::Uuid;

use crate::error::StoreError;
use crate::{Store, timestamp};

impl Store {
    /// Every scheduled task's id and payload, oldest id first.
    ///
    /// # Errors
    ///
    /// A database error, or an error if a stored id is corrupt.
    pub fn scheduled_tasks(&self) -> Result<Vec<(Uuid, String)>, StoreError> {
        let mut stmt = self
            .conn
            .prepare_cached("SELECT id, payload FROM scheduled_tasks ORDER BY id")?;
        let rows = stmt.query_map([], |row| Ok((row.get::<_, String>(0)?, row.get(1)?)))?;
        rows.map(|row| {
            let (id, payload) = row?;
            Ok((Uuid::parse_str(&id)?, payload))
        })
        .collect()
    }

    /// Scheduled task `id`'s payload, if it exists.
    ///
    /// # Errors
    ///
    /// A database error.
    pub fn scheduled_task(&self, id: Uuid) -> Result<Option<String>, StoreError> {
        Ok(self
            .conn
            .prepare_cached("SELECT payload FROM scheduled_tasks WHERE id = ?1")?
            .query_row(params![id.to_string()], |row| row.get(0))
            .optional()?)
    }

    /// Inserts or replaces scheduled task `id`, due at `next_run_at` if it has a next run.
    ///
    /// # Errors
    ///
    /// A database error.
    pub fn put_scheduled_task(
        &self,
        id: Uuid,
        next_run_at: Option<Timestamp>,
        payload: &str,
    ) -> Result<(), StoreError> {
        self.conn
            .prepare_cached(
                "INSERT INTO scheduled_tasks (id, next_run_at, payload) VALUES (?1, ?2, ?3)
                 ON CONFLICT (id) DO UPDATE SET next_run_at = ?2, payload = ?3",
            )?
            .execute(params![
                id.to_string(),
                next_run_at.map(timestamp::format),
                payload
            ])?;
        Ok(())
    }

    /// Moves scheduled task `id`'s next run to `at`, leaving its payload, which may be unreadable,
    /// as it is.
    ///
    /// # Errors
    ///
    /// A database error.
    pub fn postpone_scheduled_task(&self, id: Uuid, at: Timestamp) -> Result<(), StoreError> {
        self.conn
            .prepare_cached("UPDATE scheduled_tasks SET next_run_at = ?2 WHERE id = ?1")?
            .execute(params![id.to_string(), timestamp::format(at)])?;
        Ok(())
    }

    /// Deletes scheduled task `id`, and says whether it existed.
    ///
    /// # Errors
    ///
    /// A database error.
    pub fn delete_scheduled_task(&self, id: Uuid) -> Result<bool, StoreError> {
        Ok(self
            .conn
            .prepare_cached("DELETE FROM scheduled_tasks WHERE id = ?1")?
            .execute(params![id.to_string()])?
            > 0)
    }

    /// The earliest next run of any scheduled task, if one has a next run.
    ///
    /// # Errors
    ///
    /// A database error, or an error if the stored time is corrupt.
    pub fn next_scheduled_at(&self) -> Result<Option<Timestamp>, StoreError> {
        let next: Option<String> = self
            .conn
            .prepare_cached(
                "SELECT MIN(next_run_at) FROM scheduled_tasks WHERE next_run_at IS NOT NULL",
            )?
            .query_row([], |row| row.get(0))?;
        next.as_deref().map(timestamp::parse).transpose()
    }

    /// The ids of the scheduled tasks due at `now`, earliest first.
    ///
    /// # Errors
    ///
    /// A database error, or an error if a stored id is corrupt.
    pub fn due_scheduled_tasks(&self, now: Timestamp) -> Result<Vec<Uuid>, StoreError> {
        let mut stmt = self.conn.prepare_cached(
            "SELECT id FROM scheduled_tasks
             WHERE next_run_at IS NOT NULL AND next_run_at <= ?1 ORDER BY next_run_at",
        )?;
        crate::ids(&mut stmt, params![timestamp::format(now)])
    }

    /// How many of `thread_id`'s effects are pending or running.
    ///
    /// # Errors
    ///
    /// A database error.
    pub fn open_effects(&self, thread_id: Uuid) -> Result<usize, StoreError> {
        let count: i64 = self
            .conn
            .prepare_cached(
                "SELECT COUNT(*) FROM effects
                 WHERE thread_id = ?1 AND status IN ('pending', 'running')",
            )?
            .query_row(params![thread_id.to_string()], |row| row.get(0))?;
        Ok(usize::try_from(count).unwrap_or_default())
    }

    /// Every pull request watch: its run, URL, and payload.
    ///
    /// # Errors
    ///
    /// A database error, or an error if a stored run id is corrupt.
    pub fn pr_watches(&self) -> Result<Vec<(Uuid, String, String)>, StoreError> {
        let mut stmt = self
            .conn
            .prepare_cached("SELECT run_id, url, payload FROM pr_watches ORDER BY url, run_id")?;
        let rows = stmt.query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get(1)?, row.get(2)?))
        })?;
        rows.map(|row| {
            let (run, url, payload) = row?;
            Ok((Uuid::parse_str(&run)?, url, payload))
        })
        .collect()
    }

    /// Whether any pull request is watched.
    ///
    /// # Errors
    ///
    /// A database error.
    pub fn any_pr_watch(&self) -> Result<bool, StoreError> {
        Ok(self
            .conn
            .prepare_cached("SELECT EXISTS(SELECT 1 FROM pr_watches)")?
            .query_row([], |row| row.get(0))?)
    }

    /// Run `run_id`'s watch of `url`'s payload, if it is watched.
    ///
    /// # Errors
    ///
    /// A database error.
    pub fn pr_watch(&self, run_id: Uuid, url: &str) -> Result<Option<String>, StoreError> {
        Ok(self
            .conn
            .prepare_cached("SELECT payload FROM pr_watches WHERE run_id = ?1 AND url = ?2")?
            .query_row(params![run_id.to_string(), url], |row| row.get(0))
            .optional()?)
    }

    /// Inserts or replaces run `run_id`'s watch of `url`.
    ///
    /// # Errors
    ///
    /// A database error, including a foreign key error for a run that doesn't exist.
    pub fn put_pr_watch(&self, run_id: Uuid, url: &str, payload: &str) -> Result<(), StoreError> {
        self.conn
            .prepare_cached(
                "INSERT INTO pr_watches (run_id, url, payload) VALUES (?1, ?2, ?3)
                 ON CONFLICT (run_id, url) DO UPDATE SET payload = ?3",
            )?
            .execute(params![run_id.to_string(), url, payload])?;
        Ok(())
    }

    /// Ends run `run_id`'s watch of `url`, and says whether it was watched.
    ///
    /// # Errors
    ///
    /// A database error.
    pub fn delete_pr_watch(&self, run_id: Uuid, url: &str) -> Result<bool, StoreError> {
        Ok(self
            .conn
            .prepare_cached("DELETE FROM pr_watches WHERE run_id = ?1 AND url = ?2")?
            .execute(params![run_id.to_string(), url])?
            > 0)
    }
}
