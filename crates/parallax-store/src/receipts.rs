use rusqlite::{OptionalExtension, params};

use crate::Store;
use crate::error::StoreError;
use crate::timestamp;

/// How long a finished receipt is kept (0052). Each insert deletes older rows.
pub const RECEIPT_RETENTION_SECS: i64 = 7 * 24 * 60 * 60;

/// A row in `command_receipts` (0052, PLX-482).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CommandReceipt {
    pub command_id: String,
    pub method: String,
    pub params_hash: String,
    pub run_id: Option<String>,
    pub effect_id: Option<i64>,
    /// JSON result or error object; `None` until the command ends.
    pub result: Option<String>,
    pub created_at: String,
    pub finished_at: Option<String>,
}

impl Store {
    /// Inserts a claim with no result, or returns the row already stored for `command_id`.
    /// The `bool` is whether this call inserted the row. Deletes receipts older than
    /// [`RECEIPT_RETENTION_SECS`] first.
    ///
    /// # Errors
    ///
    /// A database error.
    pub fn claim_command(
        &self,
        command_id: &str,
        method: &str,
        params_hash: &str,
        run_id: Option<&str>,
    ) -> Result<(bool, CommandReceipt), StoreError> {
        self.prune_old_receipts()?;
        let created_at = timestamp::now();
        let inserted = self.conn.execute(
            "INSERT INTO command_receipts
                (command_id, method, params_hash, run_id, effect_id, result, created_at, finished_at)
             VALUES (?1, ?2, ?3, ?4, NULL, NULL, ?5, NULL)
             ON CONFLICT (command_id) DO NOTHING",
            params![command_id, method, params_hash, run_id, created_at],
        )? > 0;
        let Some(row) = self.command_receipt(command_id)? else {
            return Err(StoreError::Sqlite(rusqlite::Error::QueryReturnedNoRows));
        };
        Ok((inserted, row))
    }

    /// The receipt for `command_id`, if any.
    ///
    /// # Errors
    ///
    /// A database error.
    pub fn command_receipt(&self, command_id: &str) -> Result<Option<CommandReceipt>, StoreError> {
        self.conn
            .query_row(
                "SELECT command_id, method, params_hash, run_id, effect_id, result,
                        created_at, finished_at
                 FROM command_receipts WHERE command_id = ?1",
                params![command_id],
                |row| {
                    Ok(CommandReceipt {
                        command_id: row.get(0)?,
                        method: row.get(1)?,
                        params_hash: row.get(2)?,
                        run_id: row.get(3)?,
                        effect_id: row.get(4)?,
                        result: row.get(5)?,
                        created_at: row.get(6)?,
                        finished_at: row.get(7)?,
                    })
                },
            )
            .optional()
            .map_err(StoreError::from)
    }

    /// Writes `result` and `finished_at` on an existing claim. Leaves `effect_id` as it is
    /// (PLX-483 fills it).
    ///
    /// # Errors
    ///
    /// A database error.
    pub fn fill_command_receipt(&self, command_id: &str, result: &str) -> Result<bool, StoreError> {
        let finished_at = timestamp::now();
        let changed = self.conn.execute(
            "UPDATE command_receipts
             SET result = ?2, finished_at = ?3
             WHERE command_id = ?1",
            params![command_id, result, finished_at],
        )?;
        Ok(changed > 0)
    }

    /// Deletes a claim, so a retry can run again.
    ///
    /// # Errors
    ///
    /// A database error.
    pub fn delete_command_claim(&self, command_id: &str) -> Result<bool, StoreError> {
        let changed = self.conn.execute(
            "DELETE FROM command_receipts WHERE command_id = ?1",
            params![command_id],
        )?;
        Ok(changed > 0)
    }

    /// Deletes claims that never finished and never enqueued an effect, as at start (0052).
    ///
    /// # Errors
    ///
    /// A database error.
    pub fn delete_incomplete_claims(&self) -> Result<usize, StoreError> {
        let changed = self.conn.execute(
            "DELETE FROM command_receipts WHERE result IS NULL AND effect_id IS NULL",
            [],
        )?;
        Ok(changed)
    }

    fn prune_old_receipts(&self) -> Result<(), StoreError> {
        let cutoff = timestamp::format(
            jiff::Timestamp::now() - jiff::SignedDuration::from_secs(RECEIPT_RETENTION_SECS),
        );
        self.conn.execute(
            "DELETE FROM command_receipts WHERE created_at < ?1",
            params![cutoff],
        )?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::{RECEIPT_RETENTION_SECS, Store};
    use crate::timestamp;

    fn open() -> (tempfile::TempDir, Store) {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::open(dir.path().join("parallax.sqlite3")).unwrap();
        (dir, store)
    }

    #[test]
    fn a_claim_inserts_once_and_a_repeat_returns_the_row() {
        let (_dir, store) = open();
        let (inserted, first) = store
            .claim_command("cmd-1", "project/delete", "hash-a", None)
            .unwrap();
        assert!(inserted);
        assert_eq!(first.method, "project/delete");
        assert_eq!(first.params_hash, "hash-a");
        assert!(first.result.is_none());
        assert!(first.effect_id.is_none());

        let (again_new, again) = store
            .claim_command("cmd-1", "project/delete", "hash-a", None)
            .unwrap();
        assert!(!again_new);
        assert_eq!(again.created_at, first.created_at);
        assert_eq!(again.method, first.method);
    }

    #[test]
    fn filling_a_receipt_stores_the_result_and_delete_removes_it() {
        let (_dir, store) = open();
        store
            .claim_command("cmd-2", "thread/delete", "hash-b", Some("run-1"))
            .unwrap();
        assert!(
            store
                .fill_command_receipt("cmd-2", "{\"ok\":true}")
                .unwrap()
        );
        let filled = store.command_receipt("cmd-2").unwrap().unwrap();
        assert_eq!(filled.result.as_deref(), Some("{\"ok\":true}"));
        assert!(filled.finished_at.is_some());
        assert_eq!(filled.run_id.as_deref(), Some("run-1"));

        assert!(store.delete_command_claim("cmd-2").unwrap());
        assert!(store.command_receipt("cmd-2").unwrap().is_none());
    }

    #[test]
    fn incomplete_claims_are_deleted_and_finished_ones_stay() {
        let (_dir, store) = open();
        store
            .claim_command("open", "project/delete", "h1", None)
            .unwrap();
        store
            .claim_command("done", "project/delete", "h2", None)
            .unwrap();
        store.fill_command_receipt("done", "{}").unwrap();
        store
            .conn
            .execute(
                "INSERT INTO command_receipts
                    (command_id, method, params_hash, run_id, effect_id, result, created_at)
                 VALUES ('effect', 'agent/push', 'h3', 'run', 1, NULL, ?1)",
                rusqlite::params![timestamp::now()],
            )
            .unwrap();

        assert_eq!(store.delete_incomplete_claims().unwrap(), 1);
        assert!(store.command_receipt("open").unwrap().is_none());
        assert!(store.command_receipt("done").unwrap().is_some());
        assert!(store.command_receipt("effect").unwrap().is_some());
    }

    #[test]
    fn an_insert_deletes_receipts_older_than_seven_days() {
        let (_dir, store) = open();
        let old = timestamp::format(
            jiff::Timestamp::now() - jiff::SignedDuration::from_secs(RECEIPT_RETENTION_SECS + 60),
        );
        store
            .conn
            .execute(
                "INSERT INTO command_receipts
                    (command_id, method, params_hash, result, created_at, finished_at)
                 VALUES ('old', 'project/delete', 'h', '{}', ?1, ?1)",
                rusqlite::params![old],
            )
            .unwrap();
        store
            .claim_command("new", "project/delete", "h", None)
            .unwrap();
        assert!(store.command_receipt("old").unwrap().is_none());
        assert!(store.command_receipt("new").unwrap().is_some());
    }
}
