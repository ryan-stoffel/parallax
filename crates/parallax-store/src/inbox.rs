use jiff::Timestamp;
use rusqlite::params;
use uuid::Uuid;

use crate::Store;
use crate::error::StoreError;
use crate::timestamp;

/// One item of an orchestrator's inbox (PLX-401, decision 0043). The daemon owns what `kind` means;
/// this crate stores it as text.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct InboxItem {
    pub id: Uuid,
    pub orchestrator_id: Uuid,
    /// The run it is about: a child, or the orchestrator for paused wake-ups.
    pub run_id: Uuid,
    pub kind: String,
    pub text: String,
    pub created_at: Timestamp,
    pub seen_at: Option<Timestamp>,
}

const COLUMNS: &str = "id, orchestrator_id, run_id, kind, text, created_at, seen_at";

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

fn into_item(
    (id, orchestrator, run, kind, text, created, seen): Raw,
) -> Result<InboxItem, StoreError> {
    Ok(InboxItem {
        id: Uuid::parse_str(&id)?,
        orchestrator_id: Uuid::parse_str(&orchestrator)?,
        run_id: Uuid::parse_str(&run)?,
        kind,
        text,
        created_at: timestamp::parse(&created)?,
        seen_at: seen.as_deref().map(timestamp::parse).transpose()?,
    })
}

impl Store {
    /// Adds `item` to its orchestrator's inbox.
    ///
    /// # Errors
    ///
    /// A database error, including a constraint error if its id is taken.
    pub fn add_inbox_item(&self, item: &InboxItem) -> Result<(), StoreError> {
        self.conn.execute(
            &format!("INSERT INTO inbox ({COLUMNS}) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)"),
            params![
                item.id.to_string(),
                item.orchestrator_id.to_string(),
                item.run_id.to_string(),
                item.kind,
                item.text,
                timestamp::format(item.created_at),
                item.seen_at.map(timestamp::format),
            ],
        )?;
        Ok(())
    }

    /// `orchestrator`'s inbox, oldest first.
    ///
    /// # Errors
    ///
    /// A database error, or an error if a stored id or time is corrupt.
    pub fn inbox(&self, orchestrator: Uuid) -> Result<Vec<InboxItem>, StoreError> {
        let mut statement = self.conn.prepare(&format!(
            "SELECT {COLUMNS} FROM inbox WHERE orchestrator_id = ?1 ORDER BY created_at, id"
        ))?;
        let rows = statement
            .query_map(params![orchestrator.to_string()], |row| Raw::try_from(row))?
            .collect::<Result<Vec<_>, _>>()?;
        rows.into_iter().map(into_item).collect()
    }

    /// Marks `items` of `orchestrator`'s inbox seen at `at`, keeping the time of any already seen,
    /// and returns them as they stand, oldest first. Ids not in `orchestrator`'s inbox are skipped.
    ///
    /// # Errors
    ///
    /// A database error.
    pub fn mark_inbox_seen(
        &mut self,
        orchestrator: Uuid,
        items: &[Uuid],
        at: Timestamp,
    ) -> Result<Vec<InboxItem>, StoreError> {
        let tx = self.conn.savepoint()?;
        for id in items {
            tx.execute(
                "UPDATE inbox SET seen_at = ?3
                 WHERE id = ?1 AND orchestrator_id = ?2 AND seen_at IS NULL",
                params![
                    id.to_string(),
                    orchestrator.to_string(),
                    timestamp::format(at)
                ],
            )?;
        }
        tx.commit()?;
        Ok(self
            .inbox(orchestrator)?
            .into_iter()
            .filter(|item| items.contains(&item.id))
            .collect())
    }
}
