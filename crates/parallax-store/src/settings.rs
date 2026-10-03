use rusqlite::{OptionalExtension, params};

use crate::Store;
use crate::error::StoreError;

/// The `host_settings` key for whether usage limits make runs wait and resume (decision 0049).
const AUTO_RESUME: &str = "auto_resume";

impl Store {
    /// Whether a run a usage limit stopped waits and resumes, unless the run overrides it
    /// (PLX-371, decision 0049). On when never set.
    ///
    /// # Errors
    ///
    /// A database error.
    pub fn auto_resume(&self) -> Result<bool, StoreError> {
        let value: Option<String> = self
            .conn
            .query_row(
                "SELECT value FROM host_settings WHERE key = ?1",
                params![AUTO_RESUME],
                |row| row.get(0),
            )
            .optional()?;
        Ok(value.is_none_or(|value| value != "false"))
    }

    /// Sets the host's auto-resume setting.
    ///
    /// # Errors
    ///
    /// A database error.
    pub fn set_auto_resume(&self, on: bool) -> Result<(), StoreError> {
        self.conn.execute(
            "INSERT INTO host_settings (key, value) VALUES (?1, ?2)
             ON CONFLICT (key) DO UPDATE SET value = ?2",
            params![AUTO_RESUME, on.to_string()],
        )?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use crate::Store;

    #[test]
    fn auto_resume_is_on_until_set_off() {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::open(dir.path().join("parallax.sqlite3")).unwrap();
        assert!(store.auto_resume().unwrap());
        store.set_auto_resume(false).unwrap();
        assert!(!store.auto_resume().unwrap());
        store.set_auto_resume(true).unwrap();
        assert!(store.auto_resume().unwrap());
    }
}
