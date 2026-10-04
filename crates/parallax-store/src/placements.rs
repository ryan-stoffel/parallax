use rusqlite::params;
use uuid::Uuid;

use crate::Store;
use crate::error::StoreError;
use crate::timestamp;

/// A Project's child waiting to be placed on an account (PLX-413, decision 0046). `extra` is the
/// daemon's own JSON for the rest of what its first message needs, which this crate stores as it
/// is.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Placement {
    pub run_id: Uuid,
    pub project_id: Uuid,
    /// The child's first message, with its attached threads, before the child header.
    pub prompt: String,
    pub extra: String,
}

impl Store {
    /// Puts run `placement.run_id` at the back of the placement queue. Adding it again keeps it
    /// where it is.
    ///
    /// # Errors
    ///
    /// A database error.
    pub fn add_placement(&self, placement: &Placement) -> Result<(), StoreError> {
        self.conn.execute(
            "INSERT INTO placements (run_id, project_id, prompt, extra, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5)
             ON CONFLICT (run_id) DO NOTHING",
            params![
                placement.run_id.to_string(),
                placement.project_id.to_string(),
                placement.prompt,
                placement.extra,
                timestamp::now()
            ],
        )?;
        Ok(())
    }

    /// Every child waiting to be placed, oldest first.
    ///
    /// # Errors
    ///
    /// A database error, or an error if a stored id is corrupt.
    pub fn placements(&self) -> Result<Vec<Placement>, StoreError> {
        let mut stmt = self.conn.prepare(
            "SELECT run_id, project_id, prompt, extra FROM placements
             ORDER BY created_at, rowid",
        )?;
        let rows = stmt.query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get(2)?,
                row.get(3)?,
            ))
        })?;
        let mut placements = Vec::new();
        for row in rows {
            let (run, project, prompt, extra) = row?;
            placements.push(Placement {
                run_id: Uuid::parse_str(&run)?,
                project_id: Uuid::parse_str(&project)?,
                prompt,
                extra,
            });
        }
        Ok(placements)
    }

    /// Takes run `run_id` out of the placement queue. Returns whether it was there.
    ///
    /// # Errors
    ///
    /// A database error.
    pub fn remove_placement(&self, run_id: Uuid) -> Result<bool, StoreError> {
        let changed = self.conn.execute(
            "DELETE FROM placements WHERE run_id = ?1",
            params![run_id.to_string()],
        )?;
        Ok(changed > 0)
    }
}
