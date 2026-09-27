use jiff::Timestamp;
use rusqlite::{OptionalExtension, Row, params};
use uuid::Uuid;

use crate::error::StoreError;
use crate::{Store, timestamp};

/// A coordinator thread's state, which changes as its turns run (#196).
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct CoordinatorState {
    /// `idle` or `running`.
    pub status: String,
    /// The backend its session runs on, once a turn started.
    pub backend: Option<String>,
    /// The account its turns are charged to, once a turn started.
    pub account_id: Option<String>,
    /// The vendor's session id, which the next turn resumes.
    pub session_id: Option<String>,
    /// Why the last turn failed, for people.
    pub error: Option<String>,
}

/// A project's coordinator thread row.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CoordinatorThread {
    pub id: Uuid,
    pub project_id: Uuid,
    pub state: CoordinatorState,
    pub created_at: Timestamp,
    pub updated_at: Timestamp,
}

const COLUMNS: &str =
    "id, project_id, status, backend, account_id, session_id, error, created_at, updated_at";

struct Raw {
    id: String,
    project_id: String,
    state: CoordinatorState,
    created_at: String,
    updated_at: String,
}

fn from_row(row: &Row<'_>) -> rusqlite::Result<Raw> {
    Ok(Raw {
        id: row.get(0)?,
        project_id: row.get(1)?,
        state: CoordinatorState {
            status: row.get(2)?,
            backend: row.get(3)?,
            account_id: row.get(4)?,
            session_id: row.get(5)?,
            error: row.get(6)?,
        },
        created_at: row.get(7)?,
        updated_at: row.get(8)?,
    })
}

fn into_thread(raw: Raw) -> Result<CoordinatorThread, StoreError> {
    Ok(CoordinatorThread {
        id: Uuid::parse_str(&raw.id)?,
        project_id: Uuid::parse_str(&raw.project_id)?,
        state: raw.state,
        created_at: timestamp::parse(&raw.created_at)?,
        updated_at: timestamp::parse(&raw.updated_at)?,
    })
}

impl Store {
    /// `project_id`'s coordinator thread, making it with id `new_id` and status `idle` if the
    /// project has none yet. The flag says whether it was made by this call.
    ///
    /// # Errors
    ///
    /// A database error, or a corrupt stored row.
    pub fn ensure_coordinator_thread(
        &self,
        project_id: Uuid,
        new_id: Uuid,
    ) -> Result<(CoordinatorThread, bool), StoreError> {
        let now = timestamp::now();
        let made = self.conn.execute(
            "INSERT INTO coordinator_threads (id, project_id, status, created_at, updated_at)
             VALUES (?1, ?2, 'idle', ?3, ?3) ON CONFLICT (project_id) DO NOTHING",
            params![new_id.to_string(), project_id.to_string(), now],
        )? == 1;
        let thread = self
            .project_coordinator_thread(project_id)?
            .ok_or(StoreError::NotFound { id: project_id })?;
        Ok((thread, made))
    }

    /// `project_id`'s coordinator thread, if it has one.
    ///
    /// # Errors
    ///
    /// A database error, or a corrupt stored row.
    pub fn project_coordinator_thread(
        &self,
        project_id: Uuid,
    ) -> Result<Option<CoordinatorThread>, StoreError> {
        self.coordinator_thread_where("project_id", project_id)
    }

    /// The coordinator thread with id `id`, if it exists.
    ///
    /// # Errors
    ///
    /// A database error, or a corrupt stored row.
    pub fn get_coordinator_thread(
        &self,
        id: Uuid,
    ) -> Result<Option<CoordinatorThread>, StoreError> {
        self.coordinator_thread_where("id", id)
    }

    /// Every coordinator thread, for startup's recovery.
    ///
    /// # Errors
    ///
    /// A database error, or a corrupt stored row.
    pub fn list_coordinator_threads(&self) -> Result<Vec<CoordinatorThread>, StoreError> {
        let mut stmt = self
            .conn
            .prepare(&format!("SELECT {COLUMNS} FROM coordinator_threads"))?;
        let rows = stmt.query_map([], from_row)?;
        rows.map(|row| into_thread(row?)).collect()
    }

    /// Stores thread `id`'s state and returns the row.
    ///
    /// # Errors
    ///
    /// A database error, or [`StoreError::NotFound`] if the thread doesn't exist.
    pub fn update_coordinator_thread(
        &self,
        id: Uuid,
        state: &CoordinatorState,
    ) -> Result<CoordinatorThread, StoreError> {
        self.conn.execute(
            "UPDATE coordinator_threads SET status = ?2, backend = ?3, account_id = ?4,
             session_id = ?5, error = ?6, updated_at = ?7 WHERE id = ?1",
            params![
                id.to_string(),
                state.status,
                state.backend,
                state.account_id,
                state.session_id,
                state.error,
                timestamp::now()
            ],
        )?;
        self.get_coordinator_thread(id)?
            .ok_or(StoreError::NotFound { id })
    }

    fn coordinator_thread_where(
        &self,
        column: &str,
        value: Uuid,
    ) -> Result<Option<CoordinatorThread>, StoreError> {
        let raw = self
            .conn
            .query_row(
                &format!("SELECT {COLUMNS} FROM coordinator_threads WHERE {column} = ?1"),
                params![value.to_string()],
                from_row,
            )
            .optional()?;
        raw.map(into_thread).transpose()
    }
}

#[cfg(test)]
mod tests {
    use uuid::Uuid;

    use crate::{CoordinatorState, Store};

    #[test]
    fn a_project_gets_one_thread_whose_state_is_stored() {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::open(dir.path().join("wisp.sqlite3")).unwrap();
        let project = Uuid::now_v7();
        let (thread, made) = store
            .ensure_coordinator_thread(project, Uuid::now_v7())
            .unwrap();
        assert!(made);
        assert_eq!(thread.state.status, "idle");
        let (again, made) = store
            .ensure_coordinator_thread(project, Uuid::now_v7())
            .unwrap();
        assert!(!made, "one thread per project");
        assert_eq!(again.id, thread.id);

        let state = CoordinatorState {
            status: "running".to_owned(),
            backend: Some("claude".to_owned()),
            account_id: Some("claude".to_owned()),
            session_id: Some("s-1".to_owned()),
            error: None,
        };
        let updated = store.update_coordinator_thread(thread.id, &state).unwrap();
        assert_eq!(updated.state, state);
        assert_eq!(
            store.get_coordinator_thread(thread.id).unwrap(),
            Some(updated.clone())
        );
        assert_eq!(store.list_coordinator_threads().unwrap(), [updated]);
        assert_eq!(
            store.project_coordinator_thread(Uuid::now_v7()).unwrap(),
            None
        );
    }
}
