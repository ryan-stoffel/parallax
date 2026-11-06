use jiff::Timestamp;
use rusqlite::{OptionalExtension, params};
use uuid::Uuid;

use crate::error::StoreError;
use crate::{Store, timestamp};

/// An orchestrator's wake-ups as they survive a restart (PLX-178, decision 0025): how many turns
/// they have taken since the user last wrote, whether they are paused, and the newest stored end
/// of a child that a wake-up turn carried to its CLI (PLX-936).
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct WakeState {
    pub in_a_row: u32,
    pub paused: bool,
    pub woken: Option<Timestamp>,
}

impl Store {
    /// Orchestrator `run_id`'s wake-up state, the default if none was stored.
    ///
    /// # Errors
    ///
    /// A database error.
    pub fn wake_state(&self, run_id: Uuid) -> Result<WakeState, StoreError> {
        let state = self
            .conn
            .query_row(
                "SELECT in_a_row, paused, woken_at FROM wakes WHERE run_id = ?1",
                params![run_id.to_string()],
                |row| {
                    Ok((
                        row.get::<_, u32>(0)?,
                        row.get::<_, bool>(1)?,
                        row.get::<_, Option<String>>(2)?,
                    ))
                },
            )
            .optional()?;
        let Some((in_a_row, paused, woken)) = state else {
            return Ok(WakeState::default());
        };
        Ok(WakeState {
            in_a_row,
            paused,
            woken: woken.as_deref().map(timestamp::parse).transpose()?,
        })
    }

    /// Replaces orchestrator `run_id`'s wake-up state.
    ///
    /// # Errors
    ///
    /// A database error.
    pub fn set_wake_state(&self, run_id: Uuid, state: WakeState) -> Result<(), StoreError> {
        self.conn.execute(
            "INSERT INTO wakes (run_id, in_a_row, paused, woken_at) VALUES (?1, ?2, ?3, ?4)
             ON CONFLICT (run_id) DO UPDATE SET in_a_row = ?2, paused = ?3, woken_at = ?4",
            params![
                run_id.to_string(),
                state.in_a_row,
                state.paused,
                state.woken.map(timestamp::format)
            ],
        )?;
        Ok(())
    }
}
