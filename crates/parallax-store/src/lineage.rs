//! Delegation (0063, PLX-648): threads that work in another thread's workspace, the tasks among
//! them that a thread delegated, `merge_back` context transfers, and `request_secret`'s one-time
//! refs. The daemon owns what a lineage's payload means; this crate stores it as text.

use jiff::Timestamp;
use rusqlite::{OptionalExtension, params};
use uuid::Uuid;

use crate::error::StoreError;
use crate::{Store, timestamp};

/// A thread's lineage row.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Lineage {
    /// `subagent` for a delegated task, `None` for a top-level thread that only shares a
    /// workspace.
    pub relationship: Option<String>,
    /// The thread whose workspace it works in.
    pub workspace_of: Option<Uuid>,
    pub payload: String,
}

impl Store {
    /// Thread `thread`'s lineage, if it has one.
    ///
    /// # Errors
    ///
    /// A database error, or an error if a stored id is corrupt.
    pub fn lineage(&self, thread: Uuid) -> Result<Option<Lineage>, StoreError> {
        let row = self
            .conn
            .prepare_cached(
                "SELECT relationship, workspace_of, payload FROM thread_lineage
                 WHERE thread_id = ?1",
            )?
            .query_row(params![thread.to_string()], |row| {
                Ok((
                    row.get::<_, Option<String>>(0)?,
                    row.get::<_, Option<String>>(1)?,
                    row.get::<_, String>(2)?,
                ))
            })
            .optional()?;
        row.map(|(relationship, workspace_of, payload)| {
            Ok(Lineage {
                relationship,
                workspace_of: workspace_of.as_deref().map(Uuid::parse_str).transpose()?,
                payload,
            })
        })
        .transpose()
    }

    /// Inserts or replaces thread `thread`'s lineage.
    ///
    /// # Errors
    ///
    /// A database error.
    pub fn put_lineage(&self, thread: Uuid, lineage: &Lineage) -> Result<(), StoreError> {
        self.conn
            .prepare_cached(
                "INSERT INTO thread_lineage (thread_id, relationship, workspace_of, payload)
                 VALUES (?1, ?2, ?3, ?4)
                 ON CONFLICT (thread_id) DO UPDATE SET relationship = ?2, workspace_of = ?3,
                     payload = ?4",
            )?
            .execute(params![
                thread.to_string(),
                lineage.relationship,
                lineage.workspace_of.map(|id| id.to_string()),
                lineage.payload,
            ])?;
        Ok(())
    }

    /// Deletes thread `thread`'s lineage, as when the thread it was made for was never created.
    ///
    /// # Errors
    ///
    /// A database error.
    pub fn delete_lineage(&self, thread: Uuid) -> Result<(), StoreError> {
        self.conn
            .prepare_cached("DELETE FROM thread_lineage WHERE thread_id = ?1")?
            .execute(params![thread.to_string()])?;
        Ok(())
    }

    /// The threads that work in `owner`'s workspace, with each one's run status.
    ///
    /// # Errors
    ///
    /// A database error, or an error if a stored id is corrupt.
    pub fn shared_users(&self, owner: Uuid) -> Result<Vec<(Uuid, String)>, StoreError> {
        let mut stmt = self.conn.prepare_cached(
            "SELECT l.thread_id, r.status FROM thread_lineage AS l
             JOIN runs AS r ON r.id = l.thread_id WHERE l.workspace_of = ?1",
        )?;
        let rows = stmt.query_map(params![owner.to_string()], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })?;
        rows.map(|row| {
            let (id, status) = row?;
            Ok((Uuid::parse_str(&id)?, status))
        })
        .collect()
    }

    /// The delegated tasks (lineage `subagent`) whose parent is `parent`.
    ///
    /// # Errors
    ///
    /// A database error, or an error if a stored id is corrupt.
    pub fn tasks_of(&self, parent: Uuid) -> Result<Vec<Uuid>, StoreError> {
        let mut stmt = self.conn.prepare_cached(
            "SELECT l.thread_id FROM thread_lineage AS l JOIN runs AS r ON r.id = l.thread_id
             WHERE r.parent = ?1 AND l.relationship = 'subagent'",
        )?;
        let rows = stmt.query_map(params![parent.to_string()], |row| row.get::<_, String>(0))?;
        rows.map(|id| Ok(Uuid::parse_str(&id?)?)).collect()
    }

    /// How many threads in another's workspace are starting, running, or reserved before their
    /// run is created, host-wide. Counting reservations keeps concurrent claims within the cap.
    ///
    /// # Errors
    ///
    /// A database error.
    pub fn running_shared_threads(&self) -> Result<u64, StoreError> {
        Ok(self
            .conn
            .prepare_cached(
                "SELECT COUNT(*) FROM thread_lineage AS l LEFT JOIN runs AS r ON r.id = l.thread_id
             WHERE r.id IS NULL OR r.status IN ('starting', 'running')",
            )?
            .query_row([], |row| row.get(0))?)
    }

    /// Records a pending context transfer `id` of `kind` from `source`, through its `seq`, to
    /// `target`'s next message.
    ///
    /// # Errors
    ///
    /// A database error.
    pub fn add_context_transfer(
        &self,
        id: Uuid,
        kind: &str,
        source: Uuid,
        target: Uuid,
        seq: u64,
        at: Timestamp,
    ) -> Result<(), StoreError> {
        self.conn
            .prepare_cached(
                "INSERT INTO context_transfers (id, type, source, target, seq, status, created_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, 'pending', ?6)",
            )?
            .execute(params![
                id.to_string(),
                kind,
                source.to_string(),
                target.to_string(),
                seq,
                timestamp::format(at)
            ])?;
        Ok(())
    }

    /// The sources of `target`'s pending context transfers, oldest first, each once.
    ///
    /// # Errors
    ///
    /// A database error, or an error if a stored id is corrupt.
    pub fn pending_transfer_sources(&self, target: Uuid) -> Result<Vec<Uuid>, StoreError> {
        let mut stmt = self.conn.prepare_cached(
            "SELECT source FROM context_transfers WHERE target = ?1 AND status = 'pending'
             GROUP BY source ORDER BY MIN(created_at)",
        )?;
        let rows = stmt.query_map(params![target.to_string()], |row| row.get::<_, String>(0))?;
        rows.map(|id| Ok(Uuid::parse_str(&id?)?)).collect()
    }

    /// Records one-time secret ref `id`, which thread `thread` asked for, until `expires_at`.
    ///
    /// # Errors
    ///
    /// A database error.
    pub fn add_secret_ref(
        &self,
        id: Uuid,
        thread: Uuid,
        expires_at: Timestamp,
    ) -> Result<(), StoreError> {
        self.conn
            .prepare_cached(
                "INSERT INTO secret_refs (id, thread_id, expires_at) VALUES (?1, ?2, ?3)",
            )?
            .execute(params![
                id.to_string(),
                thread.to_string(),
                timestamp::format(expires_at)
            ])?;
        Ok(())
    }

    /// Removes secret ref `id`, so it is never used again, and returns the thread that asked
    /// for it and when it expires, if it was there.
    ///
    /// # Errors
    ///
    /// A database error, or an error if a stored id or time is corrupt.
    pub fn take_secret_ref(&self, id: Uuid) -> Result<Option<(Uuid, Timestamp)>, StoreError> {
        let row = self
            .conn
            .prepare_cached(
                "DELETE FROM secret_refs WHERE id = ?1 RETURNING thread_id, expires_at",
            )?
            .query_row(params![id.to_string()], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })
            .optional()?;
        row.map(|(thread, at)| Ok((Uuid::parse_str(&thread)?, timestamp::parse(&at)?)))
            .transpose()
    }

    /// The secret refs that expired by `now`, and when the next one expires.
    ///
    /// # Errors
    ///
    /// A database error, or an error if a stored id or time is corrupt.
    pub fn secret_ref_expiry(
        &self,
        now: Timestamp,
    ) -> Result<(Vec<Uuid>, Option<Timestamp>), StoreError> {
        let mut stmt = self
            .conn
            .prepare_cached("SELECT id, expires_at FROM secret_refs ORDER BY expires_at")?;
        let rows = stmt.query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })?;
        let mut expired = Vec::new();
        for row in rows {
            let (id, at) = row?;
            let at = timestamp::parse(&at)?;
            if at > now {
                return Ok((expired, Some(at)));
            }
            expired.push(Uuid::parse_str(&id)?);
        }
        Ok((expired, None))
    }
}

#[cfg(test)]
mod tests {
    use jiff::Timestamp;
    use uuid::Uuid;

    use super::Lineage;
    use crate::Store;

    /// A ref is taken once, and the expiry lists it once it's due.
    #[test]
    fn a_secret_ref_is_taken_once_and_expires() {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::open(dir.path().join("parallax.sqlite3")).unwrap();
        let (id, thread) = (Uuid::now_v7(), Uuid::now_v7());
        let at = Timestamp::from_second(2_000_000_000).unwrap();
        store.add_secret_ref(id, thread, at).unwrap();
        assert_eq!(
            store.secret_ref_expiry(Timestamp::UNIX_EPOCH).unwrap(),
            (vec![], Some(at))
        );
        assert_eq!(store.secret_ref_expiry(at).unwrap(), (vec![id], None));
        assert_eq!(store.take_secret_ref(id).unwrap(), Some((thread, at)));
        assert_eq!(store.take_secret_ref(id).unwrap(), None, "one use");
    }

    #[test]
    fn a_lineage_reads_back_and_replaces() {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::open(dir.path().join("parallax.sqlite3")).unwrap();
        let (child, parent) = (Uuid::now_v7(), Uuid::now_v7());
        assert_eq!(store.lineage(child).unwrap(), None);
        let mut lineage = Lineage {
            relationship: Some("subagent".to_owned()),
            workspace_of: Some(parent),
            payload: "{}".to_owned(),
        };
        store.put_lineage(child, &lineage).unwrap();
        assert_eq!(store.lineage(child).unwrap().as_ref(), Some(&lineage));
        assert_eq!(
            store.running_shared_threads().unwrap(),
            1,
            "a reserved slot counts before creating its run"
        );
        lineage.payload = r#"{"delivery":"acknowledged"}"#.to_owned();
        store.put_lineage(child, &lineage).unwrap();
        assert_eq!(store.lineage(child).unwrap(), Some(lineage));
        store.delete_lineage(child).unwrap();
        assert_eq!(store.lineage(child).unwrap(), None);
        assert_eq!(store.running_shared_threads().unwrap(), 0);
    }

    /// A transfer stays pending until the target's attached cursor for its source reaches its
    /// `seq`.
    #[test]
    fn reading_a_source_through_its_seq_consumes_its_transfers() {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::open(dir.path().join("parallax.sqlite3")).unwrap();
        let (target, source) = (Uuid::now_v7(), Uuid::now_v7());
        let now = Timestamp::now();
        store
            .add_context_transfer(Uuid::now_v7(), "merge_back", source, target, 10, now)
            .unwrap();
        store
            .add_context_transfer(Uuid::now_v7(), "merge_back", source, target, 20, now)
            .unwrap();
        assert_eq!(store.pending_transfer_sources(target).unwrap(), [source]);
        store.record_attached_seen(target, &[(source, 15)]).unwrap();
        assert_eq!(
            store.pending_transfer_sources(target).unwrap(),
            [source],
            "the newer one is still owed"
        );
        store.record_attached_seen(target, &[(source, 20)]).unwrap();
        assert!(store.pending_transfer_sources(target).unwrap().is_empty());
    }
}
