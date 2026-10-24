use rusqlite::{OptionalExtension, params};
use uuid::Uuid;

use crate::error::StoreError;
use crate::{Store, timestamp};

/// Why a coordinator's epoch ended, when a new session took over without the end being recorded
/// first: its session couldn't be resumed (PLX-937, decision 0079).
pub const NOT_RESUMABLE: &str = "not-resumable";

impl Store {
    /// Records that coordinator `run_id`'s CLI reported `session_id`. The same session as the
    /// open epoch's changes nothing. Any other starts the run's next epoch, ending the open one
    /// first as [`NOT_RESUMABLE`]. Returns the new epoch's number, and whether it ended an open
    /// one.
    ///
    /// # Errors
    ///
    /// A database error.
    pub fn begin_coordinator_session(
        &self,
        run_id: Uuid,
        session_id: &str,
    ) -> Result<Option<(u32, bool)>, StoreError> {
        let run = run_id.to_string();
        let open: Option<String> = self
            .conn
            .query_row(
                "SELECT session_id FROM coordinator_sessions WHERE run_id = ?1 AND ended_at IS NULL",
                params![run],
                |row| row.get(0),
            )
            .optional()?;
        if open.as_deref() == Some(session_id) {
            return Ok(None);
        }
        let ended = self
            .end_coordinator_session(run_id, NOT_RESUMABLE)?
            .is_some();
        let epoch: u32 = self.conn.query_row(
            "SELECT COALESCE(MAX(epoch), 0) + 1 FROM coordinator_sessions WHERE run_id = ?1",
            params![run],
            |row| row.get(0),
        )?;
        self.conn.execute(
            "INSERT INTO coordinator_sessions (run_id, epoch, session_id, started_at)
             VALUES (?1, ?2, ?3, ?4)",
            params![run, epoch, session_id, timestamp::now()],
        )?;
        Ok(Some((epoch, ended)))
    }

    /// Ends coordinator `run_id`'s open epoch for `reason`. Returns the number of the epoch that
    /// follows it, or `None` when none was open.
    ///
    /// # Errors
    ///
    /// A database error.
    pub fn end_coordinator_session(
        &self,
        run_id: Uuid,
        reason: &str,
    ) -> Result<Option<u32>, StoreError> {
        let ended: Option<u32> = self
            .conn
            .query_row(
                "UPDATE coordinator_sessions SET ended_at = ?2, end_reason = ?3
                 WHERE run_id = ?1 AND ended_at IS NULL RETURNING epoch",
                params![run_id.to_string(), timestamp::now(), reason],
                |row| row.get(0),
            )
            .optional()?;
        Ok(ended.map(|epoch| epoch + 1))
    }

    /// Coordinator `run_id`'s epochs, oldest first: each one's session id and end reason, `None`
    /// for the open one.
    ///
    /// # Errors
    ///
    /// A database error.
    pub fn coordinator_sessions(
        &self,
        run_id: Uuid,
    ) -> Result<Vec<(String, Option<String>)>, StoreError> {
        let mut statement = self.conn.prepare(
            "SELECT session_id, end_reason FROM coordinator_sessions WHERE run_id = ?1
             ORDER BY epoch",
        )?;
        let rows = statement
            .query_map(params![run_id.to_string()], |row| {
                Ok((row.get(0)?, row.get(1)?))
            })?
            .collect::<Result<_, _>>()?;
        Ok(rows)
    }
}
