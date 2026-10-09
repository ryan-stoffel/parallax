use rusqlite::{OptionalExtension, params};
use uuid::Uuid;

use crate::Store;
use crate::error::StoreError;

/// The newest source `seq` a target run's attached-thread summary already covered (0052, PLX-486).
impl Store {
    /// The `seq` target `target` last read from source `source`, or `None` if it hasn't.
    ///
    /// # Errors
    ///
    /// A database error.
    pub fn attached_seen(&self, target: Uuid, source: Uuid) -> Result<Option<u64>, StoreError> {
        self.conn
            .query_row(
                "SELECT seq FROM attached_seen WHERE target_run = ?1 AND source_run = ?2",
                params![target.to_string(), source.to_string()],
                |row| row.get(0),
            )
            .optional()
            .map_err(Into::into)
    }

    /// Records that target `target` has read each source through the given `seq`, replacing a
    /// row it already had. A pending context transfer from that source through that `seq` is
    /// consumed (PLX-648).
    ///
    /// # Errors
    ///
    /// A database error.
    pub fn record_attached_seen(
        &self,
        target: Uuid,
        seen: &[(Uuid, u64)],
    ) -> Result<(), StoreError> {
        for &(source, seq) in seen {
            self.conn.execute(
                "INSERT INTO attached_seen (target_run, source_run, seq)
                 VALUES (?1, ?2, ?3)
                 ON CONFLICT (target_run, source_run) DO UPDATE SET seq = excluded.seq",
                params![target.to_string(), source.to_string(), seq],
            )?;
            self.conn
                .prepare_cached(
                    "UPDATE context_transfers SET status = 'consumed'
                     WHERE target = ?1 AND source = ?2 AND status = 'pending' AND seq <= ?3",
                )?
                .execute(params![target.to_string(), source.to_string(), seq])?;
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use uuid::Uuid;

    use crate::Store;

    #[test]
    fn an_attached_cursor_reads_back_and_replaces() {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::open(dir.path().join("parallax.sqlite3")).unwrap();
        let (target, source) = (Uuid::now_v7(), Uuid::now_v7());
        assert_eq!(store.attached_seen(target, source).unwrap(), None);

        store.record_attached_seen(target, &[(source, 12)]).unwrap();
        assert_eq!(store.attached_seen(target, source).unwrap(), Some(12));
        store.record_attached_seen(target, &[(source, 40)]).unwrap();
        assert_eq!(store.attached_seen(target, source).unwrap(), Some(40));
        assert_eq!(store.attached_seen(source, target).unwrap(), None);
    }
}
