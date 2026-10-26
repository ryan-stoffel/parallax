use jiff::Timestamp;
use rusqlite::{OptionalExtension, params};
use uuid::Uuid;

use crate::Store;
use crate::error::StoreError;
use crate::timestamp;

/// A child in its Project's landing queue (PLX-410, decision 0045). The daemon owns what
/// `status` means; this crate stores it as text.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Landing {
    pub run_id: Uuid,
    pub project_id: Uuid,
    pub status: String,
    /// How many times landing it conflicted since it last landed.
    pub conflicts: u32,
    /// How many times it failed the Project's checks since it was queued (PLX-411).
    pub failures: u32,
    /// When it was last queued: the queue lands the oldest first.
    pub queued_at: Timestamp,
}

const COLUMNS: &str = "run_id, project_id, status, conflicts, queued_at, failures";

type Raw = (String, String, String, u32, String, u32);

fn into_landing(
    (run, project, status, conflicts, queued, failures): Raw,
) -> Result<Landing, StoreError> {
    Ok(Landing {
        run_id: Uuid::parse_str(&run)?,
        project_id: Uuid::parse_str(&project)?,
        status,
        conflicts,
        failures,
        queued_at: timestamp::parse(&queued)?,
    })
}

impl Store {
    /// `run_id`'s landing, if it was ever queued.
    ///
    /// # Errors
    ///
    /// A database error, or an error if a stored id or time is corrupt.
    pub fn landing(&self, run_id: Uuid) -> Result<Option<Landing>, StoreError> {
        self.conn
            .query_row(
                &format!("SELECT {COLUMNS} FROM landings WHERE run_id = ?1"),
                params![run_id.to_string()],
                |row| Raw::try_from(row),
            )
            .optional()?
            .map(into_landing)
            .transpose()
    }

    /// Adds `landing`, or replaces its run's.
    ///
    /// # Errors
    ///
    /// A database error.
    pub fn put_landing(&self, landing: &Landing) -> Result<(), StoreError> {
        self.conn.execute(
            &format!(
                "INSERT INTO landings ({COLUMNS}) VALUES (?1, ?2, ?3, ?4, ?5, ?6)
                 ON CONFLICT (run_id) DO UPDATE SET project_id = ?2, status = ?3, conflicts = ?4,
                     queued_at = ?5, failures = ?6"
            ),
            params![
                landing.run_id.to_string(),
                landing.project_id.to_string(),
                landing.status,
                landing.conflicts,
                timestamp::format(landing.queued_at),
                landing.failures,
            ],
        )?;
        Ok(())
    }

    /// `project`'s oldest landing whose status is `status`.
    ///
    /// # Errors
    ///
    /// A database error, or an error if a stored id or time is corrupt.
    pub fn first_landing(
        &self,
        project: Uuid,
        status: &str,
    ) -> Result<Option<Landing>, StoreError> {
        self.conn
            .query_row(
                &format!(
                    "SELECT {COLUMNS} FROM landings WHERE project_id = ?1 AND status = ?2
                     ORDER BY queued_at, run_id LIMIT 1"
                ),
                params![project.to_string(), status],
                |row| Raw::try_from(row),
            )
            .optional()?
            .map(into_landing)
            .transpose()
    }

    /// The projects with a landing whose status is `status`, for picking a queue back up after a
    /// restart.
    ///
    /// # Errors
    ///
    /// A database error, or an error if a stored id is corrupt.
    pub fn landing_projects(&self, status: &str) -> Result<Vec<Uuid>, StoreError> {
        let mut statement = self
            .conn
            .prepare("SELECT DISTINCT project_id FROM landings WHERE status = ?1")?;
        crate::ids(&mut statement, params![status])
    }
}
