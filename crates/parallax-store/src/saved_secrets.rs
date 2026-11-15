//! Saved secrets (0106, PLX-1558): secrets the user saved in Settings for every thread, by name.
//! Only the name and times are here. The value is in the host's keystore under the id.

use jiff::Timestamp;
use rusqlite::{OptionalExtension, Row, params};
use uuid::Uuid;

use crate::error::StoreError;
use crate::{Store, timestamp};

/// A saved secret's row.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SavedSecret {
    pub id: Uuid,
    pub name: String,
    pub created_at: Timestamp,
    /// `None` keeps it until the user deletes it.
    pub expires_at: Option<Timestamp>,
}

const COLUMNS: &str = "id, name, created_at, expires_at";

fn saved_secret(row: &Row<'_>) -> rusqlite::Result<(String, String, String, Option<String>)> {
    Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?))
}

fn parse(
    (id, name, created, expires): (String, String, String, Option<String>),
) -> Result<SavedSecret, StoreError> {
    Ok(SavedSecret {
        id: Uuid::parse_str(&id)?,
        name,
        created_at: timestamp::parse(&created)?,
        expires_at: expires.as_deref().map(timestamp::parse).transpose()?,
    })
}

impl Store {
    /// Saves secret `id` as `name` until `expires_at`, replacing the one already saved as `name`:
    /// that one's id, whose value the caller removes from the keystore.
    ///
    /// # Errors
    ///
    /// A database error, or an error if a stored id is corrupt.
    pub fn save_secret(
        &self,
        id: Uuid,
        name: &str,
        expires_at: Option<Timestamp>,
    ) -> Result<Option<Uuid>, StoreError> {
        let replaced = self
            .conn
            .prepare_cached("DELETE FROM saved_secrets WHERE name = ?1 RETURNING id")?
            .query_row(params![name], |row| row.get::<_, String>(0))
            .optional()?;
        self.conn
            .prepare_cached(
                "INSERT INTO saved_secrets (id, name, created_at, expires_at)
                 VALUES (?1, ?2, ?3, ?4)",
            )?
            .execute(params![
                id.to_string(),
                name,
                timestamp::now(),
                expires_at.map(timestamp::format)
            ])?;
        Ok(replaced.map(|id| Uuid::parse_str(&id)).transpose()?)
    }

    /// Every saved secret, by name, expired ones included until the expiry timer removes them.
    ///
    /// # Errors
    ///
    /// A database error, or an error if a stored id or time is corrupt.
    pub fn saved_secrets(&self) -> Result<Vec<SavedSecret>, StoreError> {
        let mut stmt = self.conn.prepare_cached(&format!(
            "SELECT {COLUMNS} FROM saved_secrets ORDER BY name"
        ))?;
        let rows = stmt.query_map([], saved_secret)?;
        rows.map(|row| parse(row?)).collect()
    }

    /// The secret saved as `name`, if there is one.
    ///
    /// # Errors
    ///
    /// A database error, or an error if a stored id or time is corrupt.
    pub fn saved_secret(&self, name: &str) -> Result<Option<SavedSecret>, StoreError> {
        self.conn
            .prepare_cached(&format!(
                "SELECT {COLUMNS} FROM saved_secrets WHERE name = ?1"
            ))?
            .query_row(params![name], saved_secret)
            .optional()?
            .map(parse)
            .transpose()
    }

    /// Removes saved secret `id`: whether it was there.
    ///
    /// # Errors
    ///
    /// A database error.
    pub fn delete_saved_secret(&self, id: Uuid) -> Result<bool, StoreError> {
        Ok(self
            .conn
            .prepare_cached("DELETE FROM saved_secrets WHERE id = ?1")?
            .execute(params![id.to_string()])?
            > 0)
    }

    /// Removes the saved secrets that expired by `now`: their ids, and when the next one expires.
    ///
    /// # Errors
    ///
    /// A database error, or an error if a stored id or time is corrupt.
    pub fn take_expired_saved_secrets(
        &self,
        now: Timestamp,
    ) -> Result<(Vec<Uuid>, Option<Timestamp>), StoreError> {
        let now = timestamp::format(now);
        let mut stmt = self
            .conn
            .prepare_cached("DELETE FROM saved_secrets WHERE expires_at <= ?1 RETURNING id")?;
        let expired = stmt
            .query_map(params![now], |row| row.get::<_, String>(0))?
            .map(|id| Ok(Uuid::parse_str(&id?)?))
            .collect::<Result<Vec<_>, StoreError>>()?;
        let next = self
            .conn
            .prepare_cached("SELECT MIN(expires_at) FROM saved_secrets")?
            .query_row([], |row| row.get::<_, Option<String>>(0))?
            .as_deref()
            .map(timestamp::parse)
            .transpose()?;
        Ok((expired, next))
    }
}

#[cfg(test)]
mod tests {
    use jiff::{SignedDuration, Timestamp};
    use uuid::Uuid;

    use crate::Store;

    /// Saving a name again replaces it and returns the old id; an expired one goes, a lasting one
    /// stays.
    #[test]
    fn a_saved_secret_is_replaced_by_name_and_removed_when_it_expires() {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::open(dir.path().join("parallax.sqlite3")).unwrap();
        let at = Timestamp::from_second(2_000_000_000).unwrap();
        let (first, second, lasting) = (Uuid::now_v7(), Uuid::now_v7(), Uuid::now_v7());
        assert_eq!(store.save_secret(first, "sudo", None).unwrap(), None);
        assert_eq!(
            store.save_secret(second, "sudo", Some(at)).unwrap(),
            Some(first)
        );
        store.save_secret(lasting, "api key", None).unwrap();
        let names: Vec<_> = store
            .saved_secrets()
            .unwrap()
            .into_iter()
            .map(|s| s.name)
            .collect();
        assert_eq!(names, ["api key", "sudo"]);
        assert_eq!(store.saved_secret("sudo").unwrap().unwrap().id, second);

        let before = at - SignedDuration::from_secs(1);
        assert_eq!(
            store.take_expired_saved_secrets(before).unwrap(),
            (vec![], Some(at))
        );
        assert_eq!(
            store.take_expired_saved_secrets(at).unwrap(),
            (vec![second], None)
        );
        assert!(store.saved_secret("sudo").unwrap().is_none());
        assert!(store.delete_saved_secret(lasting).unwrap());
        assert!(!store.delete_saved_secret(lasting).unwrap());
    }
}
