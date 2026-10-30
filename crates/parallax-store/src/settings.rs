use rusqlite::{OptionalExtension, params};

use crate::Store;
use crate::error::StoreError;

/// The `host_settings` key prefix for a thread's rollback in progress, before its id.
const CHECKPOINT_REVERT: &str = "checkpoint_revert:";

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

/// The `host_settings` key for whether plxd keeps a connection to Parallax Relay (PLX-652, 0068).
const RELAY: &str = "relay";

/// The `host_settings` key for the remote clients' sessions, as plxd's JSON (PLX-641).
const REMOTE_SESSIONS: &str = "remote_sessions";

/// The `host_settings` key for the Clerk user id this host registered with the relay under (0091).
const RELAY_ACCOUNT: &str = "relay_account";

/// The `host_settings` key for the account's approved and removed client keys and approved host
/// ids, as plxd's JSON (0091).
const ACCOUNT_ACCESS: &str = "account_access";

/// The `host_settings` key for the Claude Remote Control sessions plxd's sync already imported
/// or found imported, as a JSON array of their ids (PLX-1140).
const REMOTE_CONTROL_SYNCED: &str = "remote_control_synced";

/// The `host_settings` key prefix for a repository's scripts, before its path (PLX-650).
const REPO_SCRIPTS: &str = "repo_scripts:";

/// The `host_settings` key for the scripts that are running, which a restart interrupts.
const RUNNING_SCRIPTS: &str = "running_scripts";

/// The `host_settings` key migration 43 sets: plxd hasn't yet wiped the freed pages where a plxd
/// before PLX-648 may have left a webhook secret (0063).
const WIPE_FREED_PAGES: &str = "wipe_freed_pages";

/// The `host_settings` key for the keystore entries of replaced or deleted webhook secrets that
/// plxd couldn't remove yet, as plxd's JSON (PLX-648).
const UNUSED_SECRET_KEYS: &str = "unused_secret_keys";

impl Store {
    /// The durable rollback step for a thread, as the daemon's JSON.
    ///
    /// # Errors
    /// A database error.
    pub fn checkpoint_revert(&self, thread: uuid::Uuid) -> Result<Option<String>, StoreError> {
        self.text(&format!("{CHECKPOINT_REVERT}{thread}"))
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
        self.set_text(&format!("{CHECKPOINT_REVERT}{thread}"), pending)
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
        self.flag_default_off(AUTO_RESUME)
    }

    /// Whether a plain thread's turn a restart cut off gets "Continue where you left off." once
    /// plxd is up (decision 0060). Off unless set on.
    ///
    /// # Errors
    ///
    /// A database error.
    pub fn continue_after_restart(&self) -> Result<bool, StoreError> {
        self.flag_default_off(CONTINUE_AFTER_RESTART)
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
        self.flag_default_on(CLEAN_WORKTREES)
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
        self.flag_default_off(CONNECT)
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
        self.flag_default_off(REMOTE)
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
        self.flag_default_off(REMOTE_WEB)
    }

    /// Sets the host's web client setting.
    ///
    /// # Errors
    ///
    /// A database error.
    pub fn set_remote_web(&self, on: bool) -> Result<(), StoreError> {
        self.set_flag(REMOTE_WEB, on)
    }

    /// Whether plxd keeps a connection to Parallax Relay (PLX-652, 0068), for pushes and webhooks,
    /// and for streams while `remote` is on too (PLX-1146). Off unless set on.
    ///
    /// # Errors
    ///
    /// A database error.
    pub fn relay(&self) -> Result<bool, StoreError> {
        self.flag_default_off(RELAY)
    }

    /// Sets the host's relay setting.
    ///
    /// # Errors
    ///
    /// A database error.
    pub fn set_relay(&self, on: bool) -> Result<(), StoreError> {
        self.set_flag(RELAY, on)
    }

    /// Whether the host's relay setting was ever set, on or off, so registering turns it on only
    /// for a host whose user never chose (PLX-1146).
    ///
    /// # Errors
    ///
    /// A database error.
    pub fn relay_chosen(&self) -> Result<bool, StoreError> {
        Ok(self.text(RELAY)?.is_some())
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

    /// The Clerk user id this host registered with the relay under, if it has (0091).
    ///
    /// # Errors
    ///
    /// A database error.
    pub fn relay_account(&self) -> Result<Option<String>, StoreError> {
        self.text(RELAY_ACCOUNT)
    }

    /// Records the Clerk user id this host registered under.
    ///
    /// # Errors
    ///
    /// A database error.
    pub fn set_relay_account(&self, user: &str) -> Result<(), StoreError> {
        self.set_text(RELAY_ACCOUNT, Some(user))
    }

    /// Who may sign in with the account, as plxd's JSON, if anyone was approved or removed (0091).
    ///
    /// # Errors
    ///
    /// A database error.
    pub fn account_access(&self) -> Result<Option<String>, StoreError> {
        self.text(ACCOUNT_ACCESS)
    }

    /// Stores who may sign in with the account.
    ///
    /// # Errors
    ///
    /// A database error.
    pub fn set_account_access(&self, access: &str) -> Result<(), StoreError> {
        self.set_text(ACCOUNT_ACCESS, Some(access))
    }

    /// The Claude Remote Control sessions plxd's sync already took, as plxd's JSON, if any
    /// (PLX-1140).
    ///
    /// # Errors
    ///
    /// A database error.
    pub fn remote_control_synced(&self) -> Result<Option<String>, StoreError> {
        self.text(REMOTE_CONTROL_SYNCED)
    }

    /// Stores the Claude Remote Control sessions plxd's sync took.
    ///
    /// # Errors
    ///
    /// A database error.
    pub fn set_remote_control_synced(&self, sessions: &str) -> Result<(), StoreError> {
        self.set_text(REMOTE_CONTROL_SYNCED, Some(sessions))
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

    /// Whether plxd still has to wipe the store's freed pages once (PLX-648).
    ///
    /// # Errors
    ///
    /// A database error.
    pub fn wipe_freed_pages(&self) -> Result<bool, StoreError> {
        Ok(self.text(WIPE_FREED_PAGES)?.is_some())
    }

    /// Records whether plxd still has to wipe the store's freed pages.
    ///
    /// # Errors
    ///
    /// A database error.
    pub fn set_wipe_freed_pages(&self, on: bool) -> Result<(), StoreError> {
        self.set_text(WIPE_FREED_PAGES, on.then_some("true"))
    }

    /// The keystore entries plxd still has to remove, as plxd's JSON (PLX-648).
    ///
    /// # Errors
    ///
    /// A database error.
    pub fn unused_secret_keys(&self) -> Result<Option<String>, StoreError> {
        self.text(UNUSED_SECRET_KEYS)
    }

    /// Stores the keystore entries plxd still has to remove, or none with `None`.
    ///
    /// # Errors
    ///
    /// A database error.
    pub fn set_unused_secret_keys(&self, keys: Option<&str>) -> Result<(), StoreError> {
        self.set_text(UNUSED_SECRET_KEYS, keys)
    }

    /// A boolean host setting, on unless stored as `false`.
    fn flag_default_on(&self, key: &str) -> Result<bool, StoreError> {
        Ok(self.text(key)?.is_none_or(|value| value != "false"))
    }

    /// A boolean host setting, off unless stored as `true`.
    fn flag_default_off(&self, key: &str) -> Result<bool, StoreError> {
        Ok(self.text(key)?.is_some_and(|value| value == "true"))
    }

    fn set_flag(&self, key: &str, on: bool) -> Result<(), StoreError> {
        self.set_text(key, Some(&on.to_string()))
    }

    pub(crate) fn text(&self, key: &str) -> Result<Option<String>, StoreError> {
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
    pub(crate) fn set_text(&self, key: &str, value: Option<&str>) -> Result<(), StoreError> {
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

    /// A fresh install has auto-resume (0060), continuing after a restart, remote access, and
    /// Parallax Connect off, and worktree cleanup on. Each setting changes alone.
    #[test]
    fn host_settings_start_safe_and_change_independently() {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::open(dir.path().join("parallax.sqlite3")).unwrap();
        assert!(!store.auto_resume().unwrap());
        assert!(!store.continue_after_restart().unwrap());
        assert!(!store.remote().unwrap());
        assert!(!store.connect().unwrap());
        assert!(store.clean_worktrees().unwrap());

        store.set_auto_resume(true).unwrap();
        store.set_remote(true).unwrap();
        assert!(store.auto_resume().unwrap());
        assert!(store.remote().unwrap());
        assert!(!store.connect().unwrap());
        assert!(!store.continue_after_restart().unwrap());
        assert!(store.clean_worktrees().unwrap());

        store.set_clean_worktrees(false).unwrap();
        store.set_connect(true).unwrap();
        store.set_continue_after_restart(true).unwrap();
        store.set_auto_resume(false).unwrap();
        assert!(!store.clean_worktrees().unwrap());
        assert!(store.connect().unwrap());
        assert!(store.continue_after_restart().unwrap());
        assert!(!store.auto_resume().unwrap());
        assert!(store.remote().unwrap());
    }
}
