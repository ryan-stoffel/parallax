//! Pull request guides (0095). The daemon owns what a payload means; this crate stores the
//! newest one per pull request as text.

use rusqlite::{OptionalExtension, params};

use crate::Store;
use crate::error::StoreError;

impl Store {
    /// The guide payload kept for pull request `number` of `repo` (`owner/name`), if any.
    ///
    /// # Errors
    ///
    /// A database error.
    pub fn pr_guide(&self, repo: &str, number: u64) -> Result<Option<String>, StoreError> {
        Ok(self
            .conn
            .prepare_cached("SELECT payload FROM pr_guides WHERE repo = ?1 AND number = ?2")?
            .query_row(params![repo, number], |row| row.get(0))
            .optional()?)
    }

    /// Keeps `payload` as pull request `number` of `repo`'s guide, replacing the one before.
    ///
    /// # Errors
    ///
    /// A database error.
    pub fn put_pr_guide(&self, repo: &str, number: u64, payload: &str) -> Result<(), StoreError> {
        self.conn
            .prepare_cached(
                "INSERT INTO pr_guides (repo, number, payload) VALUES (?1, ?2, ?3)
                 ON CONFLICT (repo, number) DO UPDATE SET payload = ?3",
            )?
            .execute(params![repo, number, payload])?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use crate::Store;

    #[test]
    fn a_newer_guide_replaces_the_one_before_and_survives_a_restart() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("plxd.sqlite3");
        {
            let store = Store::open(&path).unwrap();
            assert_eq!(store.pr_guide("o/r", 7).unwrap(), None);
            store.put_pr_guide("o/r", 7, "old").unwrap();
            store.put_pr_guide("o/r", 7, "new").unwrap();
            store.put_pr_guide("o/r", 8, "other").unwrap();
        }
        let store = Store::open(&path).unwrap();
        assert_eq!(store.pr_guide("o/r", 7).unwrap().as_deref(), Some("new"));
        assert_eq!(store.pr_guide("o/r", 8).unwrap().as_deref(), Some("other"));
    }
}
