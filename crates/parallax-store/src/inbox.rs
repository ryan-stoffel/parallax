use jiff::Timestamp;
use rusqlite::params;
use uuid::Uuid;

use crate::Store;
use crate::error::StoreError;
use crate::timestamp;

/// One item of a Project's inbox (PLX-401, decision 0043). The daemon owns what `kind` means;
/// this crate stores it as text.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct InboxItem {
    pub id: Uuid,
    pub project_id: Uuid,
    /// The run it is about: a child, or the coordinator for paused wake-ups.
    pub run_id: Uuid,
    pub kind: String,
    pub text: String,
    pub created_at: Timestamp,
    pub seen_at: Option<Timestamp>,
}

const COLUMNS: &str = "id, project_id, run_id, kind, text, created_at, seen_at";

/// A row as SQLite stored it, before the fallible conversion to [`InboxItem`].
type Raw = (
    String,
    String,
    String,
    String,
    String,
    String,
    Option<String>,
);

fn into_item((id, project, run, kind, text, created, seen): Raw) -> Result<InboxItem, StoreError> {
    Ok(InboxItem {
        id: Uuid::parse_str(&id)?,
        project_id: Uuid::parse_str(&project)?,
        run_id: Uuid::parse_str(&run)?,
        kind,
        text,
        created_at: timestamp::parse(&created)?,
        seen_at: seen.as_deref().map(timestamp::parse).transpose()?,
    })
}

impl Store {
    /// Adds `item` to its project's inbox.
    ///
    /// # Errors
    ///
    /// A database error, including a constraint error if its id is taken.
    pub fn add_inbox_item(&self, item: &InboxItem) -> Result<(), StoreError> {
        self.conn.execute(
            &format!("INSERT INTO inbox ({COLUMNS}) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)"),
            params![
                item.id.to_string(),
                item.project_id.to_string(),
                item.run_id.to_string(),
                item.kind,
                item.text,
                timestamp::format(item.created_at),
                item.seen_at.map(timestamp::format),
            ],
        )?;
        Ok(())
    }

    /// `project`'s inbox, oldest first.
    ///
    /// # Errors
    ///
    /// A database error, or an error if a stored id or time is corrupt.
    pub fn inbox(&self, project: Uuid) -> Result<Vec<InboxItem>, StoreError> {
        let mut statement = self.conn.prepare(&format!(
            "SELECT {COLUMNS} FROM inbox WHERE project_id = ?1 ORDER BY created_at, id"
        ))?;
        let rows = statement
            .query_map(params![project.to_string()], |row| Raw::try_from(row))?
            .collect::<Result<Vec<_>, _>>()?;
        rows.into_iter().map(into_item).collect()
    }

    /// Marks `items` of `project`'s inbox seen at `at`, keeping the time of any already seen, and
    /// returns them as they stand, oldest first. Ids not in `project`'s inbox are skipped.
    ///
    /// # Errors
    ///
    /// A database error.
    pub fn mark_inbox_seen(
        &mut self,
        project: Uuid,
        items: &[Uuid],
        at: Timestamp,
    ) -> Result<Vec<InboxItem>, StoreError> {
        let tx = self.conn.savepoint()?;
        for id in items {
            tx.execute(
                "UPDATE inbox SET seen_at = ?3
                 WHERE id = ?1 AND project_id = ?2 AND seen_at IS NULL",
                params![id.to_string(), project.to_string(), timestamp::format(at)],
            )?;
        }
        tx.commit()?;
        Ok(self
            .inbox(project)?
            .into_iter()
            .filter(|item| items.contains(&item.id))
            .collect())
    }
}
