use std::collections::BTreeSet;

use rusqlite::params;
use uuid::Uuid;

use crate::Store;
use crate::error::StoreError;
use crate::timestamp;

/// A message waiting in a run's queue (PLX-370, decision 0048). `extra` is the daemon's own JSON
/// for the rest of it, which this crate stores as it is.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct QueuedRow {
    pub turn_id: Uuid,
    pub text: String,
    pub extra: String,
}

impl Store {
    /// `run_id`'s waiting messages, first to be sent first.
    ///
    /// # Errors
    ///
    /// A database error, or an error if a stored id is corrupt.
    pub fn queue(&self, run_id: Uuid) -> Result<Vec<QueuedRow>, StoreError> {
        let mut stmt = self.conn.prepare(
            "SELECT turn_id, text, extra FROM queued WHERE run_id = ?1 ORDER BY position",
        )?;
        let rows = stmt.query_map(params![run_id.to_string()], |row| {
            Ok((row.get::<_, String>(0)?, row.get(1)?, row.get(2)?))
        })?;
        rows.map(|row| {
            let (turn_id, text, extra) = row?;
            Ok(QueuedRow {
                turn_id: Uuid::parse_str(&turn_id)?,
                text,
                extra,
            })
        })
        .collect()
    }

    /// Replaces `run_id`'s queue with `queue`, in one transaction.
    ///
    /// # Errors
    ///
    /// A database error, including a turn id `queue` holds twice.
    pub fn set_queue(&mut self, run_id: Uuid, queue: &[QueuedRow]) -> Result<(), StoreError> {
        let tx = self.conn.savepoint()?;
        let run = run_id.to_string();
        tx.execute("DELETE FROM queued WHERE run_id = ?1", params![run])?;
        let now = timestamp::now();
        for (position, row) in queue.iter().enumerate() {
            tx.execute(
                "INSERT INTO queued (run_id, turn_id, position, text, extra, created_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                params![
                    run,
                    row.turn_id.to_string(),
                    i64::try_from(position).unwrap_or(i64::MAX),
                    row.text,
                    row.extra,
                    now
                ],
            )?;
        }
        tx.commit()?;
        Ok(())
    }

    /// Every run with a waiting message: what a starting plxd sends.
    ///
    /// # Errors
    ///
    /// A database error, or an error if a stored id is corrupt.
    pub fn queued_runs(&self) -> Result<Vec<Uuid>, StoreError> {
        let mut stmt = self.conn.prepare("SELECT DISTINCT run_id FROM queued")?;
        let ids = stmt
            .query_map([], |row| row.get::<_, String>(0))?
            .collect::<Result<BTreeSet<_>, _>>()?;
        ids.iter()
            .map(|id| Uuid::parse_str(id).map_err(StoreError::from))
            .collect()
    }
}
