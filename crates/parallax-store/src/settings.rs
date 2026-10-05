use rusqlite::{OptionalExtension, params};

use crate::Store;
use crate::error::StoreError;

/// The `host_settings` key for whether usage limits make runs wait and resume (decision 0049).
const AUTO_RESUME: &str = "auto_resume";

/// The `host_settings` key for whether plxd removes a settled thread's worktree once its pull
/// request merges (PLX-555).
const CLEAN_WORKTREES: &str = "clean_worktrees";

impl Store {
    /// Whether a run a usage limit stopped waits and resumes, unless the run overrides it
    /// (PLX-371, decision 0049). On when never set.
    ///
    /// # Errors
    ///
    /// A database error.
    pub fn auto_resume(&self) -> Result<bool, StoreError> {
        self.flag(AUTO_RESUME)
    }

    /// Sets the host's auto-resume setting.
    ///
    /// # Errors
    ///
    /// A database error.
    pub fn set_auto_resume(&self, on: bool) -> Result<(), StoreError> {
        self.set_flag(AUTO_RESUME, on)
    }

    /// Whether plxd removes a settled thread's worktree once its pull request merges (PLX-555).
    /// On when never set.
    ///
    /// # Errors
    ///
    /// A database error.
    pub fn clean_worktrees(&self) -> Result<bool, StoreError> {
        self.flag(CLEAN_WORKTREES)
    }

    /// Sets the host's worktree cleanup setting.
    ///
    /// # Errors
    ///
    /// A database error.
    pub fn set_clean_worktrees(&self, on: bool) -> Result<(), StoreError> {
        self.set_flag(CLEAN_WORKTREES, on)
    }

    /// A boolean host setting, on unless stored as `false`.
    fn flag(&self, key: &str) -> Result<bool, StoreError> {
        let value: Option<String> = self
            .conn
            .query_row(
                "SELECT value FROM host_settings WHERE key = ?1",
                params![key],
                |row| row.get(0),
            )
            .optional()?;
        Ok(value.is_none_or(|value| value != "false"))
    }

    fn set_flag(&self, key: &str, on: bool) -> Result<(), StoreError> {
        self.conn.execute(
            "INSERT INTO host_settings (key, value) VALUES (?1, ?2)
             ON CONFLICT (key) DO UPDATE SET value = ?2",
            params![key, on.to_string()],
        )?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use crate::Store;

    #[test]
    fn host_settings_are_on_until_set_off_and_independent() {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::open(dir.path().join("parallax.sqlite3")).unwrap();
        assert!(store.auto_resume().unwrap());
        assert!(store.clean_worktrees().unwrap());
        store.set_auto_resume(false).unwrap();
        assert!(!store.auto_resume().unwrap());
        assert!(store.clean_worktrees().unwrap());
        store.set_clean_worktrees(false).unwrap();
        assert!(!store.clean_worktrees().unwrap());
        store.set_auto_resume(true).unwrap();
        assert!(store.auto_resume().unwrap());
        assert!(!store.clean_worktrees().unwrap());
    }
}
