use jiff::Timestamp;
use rusqlite::{OptionalExtension, Row, params};
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
    /// When it was last queued: the queue lands the oldest first.
    pub queued_at: Timestamp,
}

const COLUMNS: &str = "run_id, project_id, status, conflicts, queued_at";

type Raw = (String, String, String, u32, String);

fn from_row(row: &Row<'_>) -> rusqlite::Result<Raw> {
    Ok((
        row.get(0)?,
        row.get(1)?,
        row.get(2)?,
        row.get(3)?,
        row.get(4)?,
    ))
}

fn into_landing((run, project, status, conflicts, queued): Raw) -> Result<Landing, StoreError> {
    Ok(Landing {
        run_id: Uuid::parse_str(&run)?,
        project_id: Uuid::parse_str(&project)?,
        status,
        conflicts,
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
                from_row,
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
                "INSERT INTO landings ({COLUMNS}) VALUES (?1, ?2, ?3, ?4, ?5)
                 ON CONFLICT (run_id) DO UPDATE SET project_id = ?2, status = ?3, conflicts = ?4,
                     queued_at = ?5"
            ),
            params![
                landing.run_id.to_string(),
                landing.project_id.to_string(),
                landing.status,
                landing.conflicts,
                timestamp::format(landing.queued_at),
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
                from_row,
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
        let ids = statement
            .query_map(params![status], |row| row.get::<_, String>(0))?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(ids
            .iter()
            .map(|id| Uuid::parse_str(id))
            .collect::<Result<_, _>>()?)
    }
}

#[cfg(test)]
mod tests {
    use jiff::Timestamp;
    use uuid::Uuid;

    use super::Landing;
    use crate::Store;

    #[test]
    fn the_oldest_landing_of_a_status_comes_first_and_deletes_go_with_their_run_or_project() {
        let dir = tempfile::tempdir().unwrap();
        let mut store = Store::open(dir.path().join("parallax.sqlite3")).unwrap();
        let project = Uuid::now_v7();
        let landing = |status: &str, at: &str| Landing {
            run_id: Uuid::now_v7(),
            project_id: project,
            status: status.to_owned(),
            conflicts: 0,
            queued_at: at.parse::<Timestamp>().unwrap(),
        };
        let later = landing("queued", "2026-10-04T12:00:00Z");
        let first = landing("queued", "2026-10-04T11:00:00Z");
        let waiting = landing("waiting", "2026-10-04T10:00:00Z");
        for landing in [&later, &first, &waiting] {
            store.put_landing(landing).unwrap();
        }
        assert_eq!(
            store.first_landing(project, "queued").unwrap(),
            Some(first.clone())
        );
        assert_eq!(store.landing_projects("queued").unwrap(), [project]);
        assert!(store.landing_projects("sentBack").unwrap().is_empty());

        let replaced = Landing {
            status: "sentBack".to_owned(),
            conflicts: 1,
            ..first.clone()
        };
        store.put_landing(&replaced).unwrap();
        assert_eq!(store.landing(first.run_id).unwrap(), Some(replaced));
        assert_eq!(
            store.first_landing(project, "queued").unwrap(),
            Some(later.clone())
        );

        store.delete_run(later.run_id).unwrap();
        assert_eq!(store.landing(later.run_id).unwrap(), None);
        store.delete_project(project).unwrap();
        assert_eq!(store.landing(waiting.run_id).unwrap(), None);
    }
}
