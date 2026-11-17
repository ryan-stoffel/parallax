//! Issue trackers (0107, PLX-1594): the Linear and Jira accounts `issue/connect` saved. Only who
//! and where are here. The token is in the host's keystore under the id.

use jiff::Timestamp;
use rusqlite::{OptionalExtension, Row, params};
use uuid::Uuid;

use crate::error::StoreError;
use crate::{Store, timestamp};

/// A saved tracker account's row.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct IssueConnectionRow {
    pub id: Uuid,
    /// `linear` or `jira`.
    pub provider: String,
    /// A Linear user's name, or a Jira account's email.
    pub account: String,
    /// A Linear workspace's name, or a Jira site's host.
    pub site: String,
    pub created_at: Timestamp,
}

const COLUMNS: &str = "id, provider, account, site, created_at";

type Columns = (String, String, String, String, String);

fn columns(row: &Row<'_>) -> rusqlite::Result<Columns> {
    Ok((
        row.get(0)?,
        row.get(1)?,
        row.get(2)?,
        row.get(3)?,
        row.get(4)?,
    ))
}

fn parse(
    (id, provider, account, site, created): Columns,
) -> Result<IssueConnectionRow, StoreError> {
    Ok(IssueConnectionRow {
        id: Uuid::parse_str(&id)?,
        provider,
        account,
        site,
        created_at: timestamp::parse(&created)?,
    })
}

impl Store {
    /// Saves the account `identity` names on `provider` as connection `id`, shown as `account`
    /// at `site`. One already saved keeps its id and takes the new names. Answers the id it is
    /// saved under, `id` or the earlier one's.
    ///
    /// # Errors
    ///
    /// A database error, or an error if a stored id is corrupt.
    pub fn save_issue_connection(
        &self,
        id: Uuid,
        provider: &str,
        identity: &str,
        account: &str,
        site: &str,
    ) -> Result<Uuid, StoreError> {
        let kept: String = self
            .conn
            .prepare_cached(
                "INSERT INTO issue_connections (id, provider, identity, account, site, created_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6)
                 ON CONFLICT (provider, identity)
                 DO UPDATE SET account = excluded.account, site = excluded.site
                 RETURNING id",
            )?
            .query_row(
                params![
                    id.to_string(),
                    provider,
                    identity,
                    account,
                    site,
                    timestamp::now()
                ],
                |row| row.get(0),
            )?;
        Ok(Uuid::parse_str(&kept)?)
    }

    /// Every saved tracker account, oldest first.
    ///
    /// # Errors
    ///
    /// A database error, or an error if a stored id or time is corrupt.
    pub fn issue_connections(&self) -> Result<Vec<IssueConnectionRow>, StoreError> {
        let mut stmt = self.conn.prepare_cached(&format!(
            "SELECT {COLUMNS} FROM issue_connections ORDER BY created_at, id"
        ))?;
        let rows = stmt.query_map([], columns)?;
        rows.map(|row| parse(row?)).collect()
    }

    /// Saved tracker account `id`, if there is one.
    ///
    /// # Errors
    ///
    /// A database error, or an error if a stored id or time is corrupt.
    pub fn issue_connection(&self, id: Uuid) -> Result<Option<IssueConnectionRow>, StoreError> {
        self.conn
            .prepare_cached(&format!(
                "SELECT {COLUMNS} FROM issue_connections WHERE id = ?1"
            ))?
            .query_row(params![id.to_string()], columns)
            .optional()?
            .map(parse)
            .transpose()
    }

    /// Removes saved tracker account `id`: whether it was there.
    ///
    /// # Errors
    ///
    /// A database error.
    pub fn delete_issue_connection(&self, id: Uuid) -> Result<bool, StoreError> {
        Ok(self
            .conn
            .prepare_cached("DELETE FROM issue_connections WHERE id = ?1")?
            .execute(params![id.to_string()])?
            > 0)
    }
}

#[cfg(test)]
mod tests {
    use uuid::Uuid;

    use crate::Store;

    /// Saving an account again keeps its first id and takes its new names; another account
    /// with the same names is another connection; a deleted one is gone.
    #[test]
    fn an_issue_connection_is_saved_once_per_identity_and_deleted() {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::open(dir.path().join("parallax.sqlite3")).unwrap();
        let (first, again, other) = (Uuid::now_v7(), Uuid::now_v7(), Uuid::now_v7());
        let save = |id, identity, account| {
            store
                .save_issue_connection(id, "linear", identity, account, "Acme")
                .unwrap()
        };
        assert_eq!(save(first, "org-1/user-1", "Ada"), first);
        assert_eq!(save(again, "org-1/user-1", "Ada Lovelace"), first);
        assert_eq!(save(other, "org-2/user-9", "Ada Lovelace"), other);
        let saved: Vec<_> = store
            .issue_connections()
            .unwrap()
            .into_iter()
            .map(|row| (row.id, row.account))
            .collect();
        assert_eq!(
            saved,
            [
                (first, "Ada Lovelace".to_owned()),
                (other, "Ada Lovelace".to_owned())
            ]
        );
        assert_eq!(store.issue_connection(first).unwrap().unwrap().site, "Acme");
        assert!(store.issue_connection(again).unwrap().is_none());
        assert!(store.delete_issue_connection(first).unwrap());
        assert!(!store.delete_issue_connection(first).unwrap());
        assert!(store.issue_connection(first).unwrap().is_none());
    }
}
