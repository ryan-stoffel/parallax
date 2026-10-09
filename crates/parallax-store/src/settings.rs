use rusqlite::{OptionalExtension, params};

use crate::Store;
use crate::error::StoreError;

/// The `host_settings` key for whether usage limits make runs wait and resume (decision 0049).
const AUTO_RESUME: &str = "auto_resume";

/// The `host_settings` key for whether a plain thread's turn a restart cut off continues once
/// plxd is up (decision 0060).
const CONTINUE_AFTER_RESTART: &str = "continue_after_restart";

/// The `host_settings` key for whether plxd removes a settled thread's worktree once its pull
/// request merges (PLX-555).
const CLEAN_WORKTREES: &str = "clean_worktrees";

/// The `host_settings` key for whether plxd listens on its Tailscale address (decision 0056).
const CONNECT: &str = "connect";

/// The `host_settings` key for this device's Parallax Connect nickname (decision 0056).
const DEVICE_NAME: &str = "device_name";

/// The `host_settings` key for this device's Parallax Connect icon (decision 0056).
const DEVICE_ICON: &str = "device_icon";

/// The `host_settings` key for whether plxd listens for remote clients (PLX-641, 0065).
const REMOTE: &str = "remote";

/// The `host_settings` key for whether the remote listener serves the web client (PLX-651).
const REMOTE_WEB: &str = "remote_web";

/// The `host_settings` key for the remote clients' sessions, as plxd's JSON (PLX-641).
const REMOTE_SESSIONS: &str = "remote_sessions";

/// The `host_settings` key prefix for a repository's scripts, before its path (PLX-650).
const REPO_SCRIPTS: &str = "repo_scripts:";

/// The `host_settings` key for the scripts that are running, which a restart interrupts.
const RUNNING_SCRIPTS: &str = "running_scripts";

impl Store {
    /// The durable rollback step for a thread, as the daemon's JSON.
    ///
    /// # Errors
    /// A database error.
    pub fn checkpoint_revert(&self, thread: uuid::Uuid) -> Result<Option<String>, StoreError> {
        self.text(&format!("checkpoint_revert:{thread}"))
    }

    /// Stores a rollback before provider mutation, or clears it with its completion receipt.
    ///
    /// # Errors
    /// A database error.
    pub fn set_checkpoint_revert(
        &self,
        thread: uuid::Uuid,
        pending: Option<&str>,
    ) -> Result<(), StoreError> {
        self.set_text(&format!("checkpoint_revert:{thread}"), pending)
    }

    /// Threads with an incomplete rollback, to resume their local steps after a restart.
    ///
    /// # Errors
    /// A database error.
    pub fn checkpoint_revert_threads(&self) -> Result<Vec<String>, StoreError> {
        Ok(self
            .conn
            .prepare(
                "SELECT substr(key, 19) FROM host_settings WHERE key GLOB 'checkpoint_revert:*'",
            )?
            .query_map([], |row| row.get(0))?
            .collect::<Result<Vec<_>, _>>()?)
    }

    /// Whether a run a usage limit stopped waits and resumes, unless the run overrides it
    /// (PLX-371, decision 0049). Off unless set on, as T3 Code's (0060).
    ///
    /// # Errors
    ///
    /// A database error.
    pub fn auto_resume(&self) -> Result<bool, StoreError> {
        Ok(self.text(AUTO_RESUME)?.is_some_and(|value| value == "true"))
    }

    /// Whether a plain thread's turn a restart cut off gets "Continue where you left off." once
    /// plxd is up (decision 0060). Off unless set on.
    ///
    /// # Errors
    ///
    /// A database error.
    pub fn continue_after_restart(&self) -> Result<bool, StoreError> {
        Ok(self
            .text(CONTINUE_AFTER_RESTART)?
            .is_some_and(|value| value == "true"))
    }

    /// Sets the host's continue-after-restart setting.
    ///
    /// # Errors
    ///
    /// A database error.
    pub fn set_continue_after_restart(&self, on: bool) -> Result<(), StoreError> {
        self.set_flag(CONTINUE_AFTER_RESTART, on)
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

    /// Whether plxd listens for this user's other devices on its Tailscale address (decision
    /// 0056). Off unless set on.
    ///
    /// # Errors
    ///
    /// A database error.
    pub fn connect(&self) -> Result<bool, StoreError> {
        Ok(self.text(CONNECT)?.is_some_and(|value| value == "true"))
    }

    /// Sets the host's Parallax Connect setting.
    ///
    /// # Errors
    ///
    /// A database error.
    pub fn set_connect(&self, on: bool) -> Result<(), StoreError> {
        self.set_flag(CONNECT, on)
    }

    /// This device's Parallax Connect nickname, if one is set.
    ///
    /// # Errors
    ///
    /// A database error.
    pub fn device_name(&self) -> Result<Option<String>, StoreError> {
        self.text(DEVICE_NAME)
    }

    /// Sets this device's nickname, or clears it with `None`. The caller checks it.
    ///
    /// # Errors
    ///
    /// A database error.
    pub fn set_device_name(&self, name: Option<&str>) -> Result<(), StoreError> {
        self.set_text(DEVICE_NAME, name)
    }

    /// This device's Parallax Connect icon, if one is set.
    ///
    /// # Errors
    ///
    /// A database error.
    pub fn device_icon(&self) -> Result<Option<String>, StoreError> {
        self.text(DEVICE_ICON)
    }

    /// Sets this device's icon, or clears it with `None`. The caller checks it.
    ///
    /// # Errors
    ///
    /// A database error.
    pub fn set_device_icon(&self, icon: Option<&str>) -> Result<(), StoreError> {
        self.set_text(DEVICE_ICON, icon)
    }

    /// Whether plxd listens for remote clients (PLX-641, 0065). Off unless set on.
    ///
    /// # Errors
    ///
    /// A database error.
    pub fn remote(&self) -> Result<bool, StoreError> {
        Ok(self.text(REMOTE)?.is_some_and(|value| value == "true"))
    }

    /// Sets the host's remote setting.
    ///
    /// # Errors
    ///
    /// A database error.
    pub fn set_remote(&self, on: bool) -> Result<(), StoreError> {
        self.set_flag(REMOTE, on)
    }

    /// Whether the remote listener serves the web client and pairs browsers (PLX-651). Off unless
    /// set on.
    ///
    /// # Errors
    ///
    /// A database error.
    pub fn remote_web(&self) -> Result<bool, StoreError> {
        Ok(self.text(REMOTE_WEB)?.is_some_and(|value| value == "true"))
    }

    /// Sets the host's web client setting.
    ///
    /// # Errors
    ///
    /// A database error.
    pub fn set_remote_web(&self, on: bool) -> Result<(), StoreError> {
        self.set_flag(REMOTE_WEB, on)
    }

    /// The remote clients' sessions, as plxd stored them, if any.
    ///
    /// # Errors
    ///
    /// A database error.
    pub fn remote_sessions(&self) -> Result<Option<String>, StoreError> {
        self.text(REMOTE_SESSIONS)
    }

    /// Stores the remote clients' sessions, or forgets them all with `None`.
    ///
    /// # Errors
    ///
    /// A database error.
    pub fn set_remote_sessions(&self, sessions: Option<&str>) -> Result<(), StoreError> {
        self.set_text(REMOTE_SESSIONS, sessions)
    }

    /// The setup and settle scripts of the repository at `path`, as plxd's JSON, if any
    /// (PLX-650).
    ///
    /// # Errors
    ///
    /// A database error.
    pub fn repo_scripts(&self, path: &str) -> Result<Option<String>, StoreError> {
        self.text(&format!("{REPO_SCRIPTS}{path}"))
    }

    /// Stores the scripts of the repository at `path`, or forgets them with `None`.
    ///
    /// # Errors
    ///
    /// A database error.
    pub fn set_repo_scripts(&self, path: &str, scripts: Option<&str>) -> Result<(), StoreError> {
        self.set_text(&format!("{REPO_SCRIPTS}{path}"), scripts)
    }

    /// The setup and settle scripts that started and haven't ended, as plxd's JSON (PLX-650).
    ///
    /// # Errors
    ///
    /// A database error.
    pub fn running_scripts(&self) -> Result<Option<String>, StoreError> {
        self.text(RUNNING_SCRIPTS)
    }

    /// Stores the scripts that are running, or none with `None`.
    ///
    /// # Errors
    ///
    /// A database error.
    pub fn set_running_scripts(&self, scripts: Option<&str>) -> Result<(), StoreError> {
        self.set_text(RUNNING_SCRIPTS, scripts)
    }

    /// A boolean host setting, on unless stored as `false`.
    fn flag(&self, key: &str) -> Result<bool, StoreError> {
        Ok(self.text(key)?.is_none_or(|value| value != "false"))
    }

    fn set_flag(&self, key: &str, on: bool) -> Result<(), StoreError> {
        self.set_text(key, Some(&on.to_string()))
    }

    fn text(&self, key: &str) -> Result<Option<String>, StoreError> {
        Ok(self
            .conn
            .query_row(
                "SELECT value FROM host_settings WHERE key = ?1",
                params![key],
                |row| row.get(0),
            )
            .optional()?)
    }

    /// Stores `value` under `key`, or removes the key for `None`.
    fn set_text(&self, key: &str, value: Option<&str>) -> Result<(), StoreError> {
        match value {
            Some(value) => self.conn.execute(
                "INSERT INTO host_settings (key, value) VALUES (?1, ?2)
                 ON CONFLICT (key) DO UPDATE SET value = ?2",
                params![key, value],
            )?,
            None => self
                .conn
                .execute("DELETE FROM host_settings WHERE key = ?1", params![key])?,
        };
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use crate::Store;

    #[test]
    fn host_settings_keep_their_defaults_until_set_and_are_independent() {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::open(dir.path().join("parallax.sqlite3")).unwrap();
        // Off by default (0060), as is continuing after a restart; cleanup is on.
        assert!(!store.auto_resume().unwrap());
        assert!(!store.continue_after_restart().unwrap());
        assert!(store.clean_worktrees().unwrap());
        store.set_auto_resume(true).unwrap();
        assert!(store.auto_resume().unwrap());
        assert!(store.clean_worktrees().unwrap());
        store.set_clean_worktrees(false).unwrap();
        assert!(!store.clean_worktrees().unwrap());
        store.set_continue_after_restart(true).unwrap();
        assert!(store.continue_after_restart().unwrap());
        store.set_auto_resume(false).unwrap();
        assert!(!store.auto_resume().unwrap());
        assert!(!store.clean_worktrees().unwrap());
        assert!(store.continue_after_restart().unwrap());
    }

    #[test]
    fn connect_is_off_until_set_on_and_device_details_clear() {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::open(dir.path().join("parallax.sqlite3")).unwrap();
        assert!(!store.connect().unwrap());
        assert!(!store.remote().unwrap());
        store.set_remote(true).unwrap();
        assert!(store.remote().unwrap());
        assert!(!store.connect().unwrap());
        store.set_connect(true).unwrap();
        assert!(store.connect().unwrap());
        store.set_connect(false).unwrap();
        assert!(!store.connect().unwrap());

        assert_eq!(store.device_name().unwrap(), None);
        store.set_device_name(Some("Studio")).unwrap();
        store.set_device_icon(Some("mini")).unwrap();
        assert_eq!(store.device_name().unwrap().as_deref(), Some("Studio"));
        assert_eq!(store.device_icon().unwrap().as_deref(), Some("mini"));
        store.set_device_name(None).unwrap();
        assert_eq!(store.device_name().unwrap(), None);
        assert_eq!(store.device_icon().unwrap().as_deref(), Some("mini"));
    }
}
