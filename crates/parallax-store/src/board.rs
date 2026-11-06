use jiff::Timestamp;
use rusqlite::{OptionalExtension, params};
use uuid::Uuid;

use crate::Store;
use crate::error::StoreError;
use crate::timestamp;

/// The `host_settings` key prefix, before an orchestrator's id, that migration 49 sets for each
/// orchestrator the store had: plxd hasn't yet parsed its hand-written board into items (0081).
const BOARD_MIGRATION: &str = "board_migration:";

/// One item on an orchestrator's status board (0081, PLX-940). The daemon owns what `status`,
/// `section`, and `links` mean; this crate stores them as text.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BoardItem {
    pub id: i64,
    pub orchestrator_id: Uuid,
    pub text: String,
    pub status: String,
    pub section: String,
    /// The daemon's JSON.
    pub links: String,
    pub created_at: Timestamp,
    pub updated_at: Timestamp,
    /// When it was last marked done, while it is.
    pub done_at: Option<Timestamp>,
}

const COLUMNS: &str =
    "id, orchestrator_id, text, status, section, links, created_at, updated_at, done_at";

type Raw = (
    i64,
    String,
    String,
    String,
    String,
    String,
    String,
    String,
    Option<String>,
);

fn into_item(
    (id, orchestrator, text, status, section, links, created, updated, done): Raw,
) -> Result<BoardItem, StoreError> {
    Ok(BoardItem {
        id,
        orchestrator_id: Uuid::parse_str(&orchestrator)?,
        text,
        status,
        section,
        links,
        created_at: timestamp::parse(&created)?,
        updated_at: timestamp::parse(&updated)?,
        done_at: done.as_deref().map(timestamp::parse).transpose()?,
    })
}

impl Store {
    /// Adds `item` to its orchestrator's board, ignoring its `id`, and returns it with the new id.
    ///
    /// # Errors
    ///
    /// A database error, including a constraint error if its orchestrator doesn't exist.
    pub fn add_board_item(&self, item: &BoardItem) -> Result<BoardItem, StoreError> {
        self.conn.execute(
            "INSERT INTO board_items (orchestrator_id, text, status, section, links, created_at,
                 updated_at, done_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
            params![
                item.orchestrator_id.to_string(),
                item.text,
                item.status,
                item.section,
                item.links,
                timestamp::format(item.created_at),
                timestamp::format(item.updated_at),
                item.done_at.map(timestamp::format),
            ],
        )?;
        Ok(BoardItem {
            id: self.conn.last_insert_rowid(),
            ..item.clone()
        })
    }

    /// `orchestrator`'s item `id`, if it has one.
    ///
    /// # Errors
    ///
    /// A database error, or an error if a stored id or time is corrupt.
    pub fn board_item(&self, orchestrator: Uuid, id: i64) -> Result<Option<BoardItem>, StoreError> {
        self.conn
            .query_row(
                &format!(
                    "SELECT {COLUMNS} FROM board_items WHERE id = ?1 AND orchestrator_id = ?2"
                ),
                params![id, orchestrator.to_string()],
                |row| Raw::try_from(row),
            )
            .optional()?
            .map(into_item)
            .transpose()
    }

    /// `orchestrator`'s board items, oldest first.
    ///
    /// # Errors
    ///
    /// A database error, or an error if a stored id or time is corrupt.
    pub fn board_items(&self, orchestrator: Uuid) -> Result<Vec<BoardItem>, StoreError> {
        let mut statement = self.conn.prepare(&format!(
            "SELECT {COLUMNS} FROM board_items WHERE orchestrator_id = ?1 ORDER BY id"
        ))?;
        let rows = statement
            .query_map(params![orchestrator.to_string()], |row| Raw::try_from(row))?
            .collect::<Result<Vec<_>, _>>()?;
        rows.into_iter().map(into_item).collect()
    }

    /// Saves `item`'s text, status, section, links, and times over the stored row with its id
    /// and Orchestrator. Whether it exists.
    ///
    /// # Errors
    ///
    /// A database error.
    pub fn update_board_item(&self, item: &BoardItem) -> Result<bool, StoreError> {
        let changed = self.conn.execute(
            "UPDATE board_items SET text = ?3, status = ?4, section = ?5, links = ?6,
                 updated_at = ?7, done_at = ?8
             WHERE id = ?1 AND orchestrator_id = ?2",
            params![
                item.id,
                item.orchestrator_id.to_string(),
                item.text,
                item.status,
                item.section,
                item.links,
                timestamp::format(item.updated_at),
                item.done_at.map(timestamp::format),
            ],
        )?;
        Ok(changed > 0)
    }

    /// Removes `orchestrator`'s item `id`. Whether it existed.
    ///
    /// # Errors
    ///
    /// A database error.
    pub fn remove_board_item(&self, orchestrator: Uuid, id: i64) -> Result<bool, StoreError> {
        let changed = self.conn.execute(
            "DELETE FROM board_items WHERE id = ?1 AND orchestrator_id = ?2",
            params![id, orchestrator.to_string()],
        )?;
        Ok(changed > 0)
    }

    /// The Orchestrators whose hand-written boards plxd still has to parse into items (migration
    /// 49).
    ///
    /// # Errors
    ///
    /// A database error, or an error if a stored id is corrupt.
    pub fn board_migrations_pending(&self) -> Result<Vec<Uuid>, StoreError> {
        let mut statement = self.conn.prepare(&format!(
            "SELECT substr(key, {}) FROM host_settings WHERE key GLOB '{BOARD_MIGRATION}*'",
            BOARD_MIGRATION.len() + 1
        ))?;
        crate::ids(&mut statement, [])
    }

    /// Whether `orchestrator`'s board migration is still to do.
    ///
    /// # Errors
    ///
    /// A database error.
    pub fn board_migration_pending(&self, orchestrator: Uuid) -> Result<bool, StoreError> {
        Ok(self
            .text(&format!("{BOARD_MIGRATION}{orchestrator}"))?
            .is_some())
    }

    /// Marks `orchestrator`'s board for the migration, as migration 49 marks each orchestrator the
    /// store had.
    ///
    /// # Errors
    ///
    /// A database error.
    pub fn mark_board_migration(&self, orchestrator: Uuid) -> Result<(), StoreError> {
        self.set_text(&format!("{BOARD_MIGRATION}{orchestrator}"), Some("pending"))
    }

    /// Records that `orchestrator`'s board is now items.
    ///
    /// # Errors
    ///
    /// A database error.
    pub fn finish_board_migration(&self, orchestrator: Uuid) -> Result<(), StoreError> {
        self.set_text(&format!("{BOARD_MIGRATION}{orchestrator}"), None)
    }
}
