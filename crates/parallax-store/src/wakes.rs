use rusqlite::{OptionalExtension, params};
use uuid::Uuid;

use crate::Store;
use crate::error::StoreError;

/// A coordinator's wake-ups as they survive a restart (RYA-178, decision 0025): how many turns
/// they have taken since the user last wrote, and whether they are paused.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct WakeState {
    pub in_a_row: u32,
    pub paused: bool,
}

impl Store {
    /// Coordinator `run_id`'s wake-up state, the default if none was stored.
    ///
    /// # Errors
    ///
    /// A database error.
    pub fn wake_state(&self, run_id: Uuid) -> Result<WakeState, StoreError> {
        let state = self
            .conn
            .query_row(
                "SELECT in_a_row, paused FROM wakes WHERE run_id = ?1",
                params![run_id.to_string()],
                |row| {
                    Ok(WakeState {
                        in_a_row: row.get(0)?,
                        paused: row.get(1)?,
                    })
                },
            )
            .optional()?;
        Ok(state.unwrap_or_default())
    }

    /// Replaces coordinator `run_id`'s wake-up state.
    ///
    /// # Errors
    ///
    /// A database error.
    pub fn set_wake_state(&self, run_id: Uuid, state: WakeState) -> Result<(), StoreError> {
        self.conn.execute(
            "INSERT INTO wakes (run_id, in_a_row, paused) VALUES (?1, ?2, ?3)
             ON CONFLICT (run_id) DO UPDATE SET in_a_row = ?2, paused = ?3",
            params![run_id.to_string(), state.in_a_row, state.paused],
        )?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use uuid::Uuid;

    use super::WakeState;
    use crate::Store;

    #[test]
    fn a_wake_state_reads_back_as_stored_and_defaults_to_none() {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::open(dir.path().join("parallax.sqlite3")).unwrap();
        let run = Uuid::now_v7();
        assert_eq!(store.wake_state(run).unwrap(), WakeState::default());

        let paused = WakeState {
            in_a_row: 10,
            paused: true,
        };
        store.set_wake_state(run, paused).unwrap();
        assert_eq!(store.wake_state(run).unwrap(), paused);
        store.set_wake_state(run, WakeState::default()).unwrap();
        assert_eq!(store.wake_state(run).unwrap(), WakeState::default());
    }
}
