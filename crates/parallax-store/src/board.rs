use jiff::Timestamp;
use rusqlite::{OptionalExtension, Row, params};
use uuid::Uuid;

use crate::Store;
use crate::error::StoreError;
use crate::timestamp;

/// The `host_settings` key prefix, before a Project's id, that migration 49 sets for each Project
/// the store had: plxd hasn't yet parsed its hand-written board into items (0081).
const BOARD_MIGRATION: &str = "board_migration:";

/// One item on a Project's status board (0081, PLX-940). The daemon owns what `status`,
/// `section`, and `links` mean; this crate stores them as text.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BoardItem {
    pub id: i64,
    pub project_id: Uuid,
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
    "id, project_id, text, status, section, links, created_at, updated_at, done_at";

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

fn from_row(row: &Row<'_>) -> rusqlite::Result<Raw> {
    Ok((
        row.get(0)?,
        row.get(1)?,
        row.get(2)?,
        row.get(3)?,
        row.get(4)?,
        row.get(5)?,
        row.get(6)?,
        row.get(7)?,
        row.get(8)?,
    ))
}

fn into_item(
    (id, project, text, status, section, links, created, updated, done): Raw,
) -> Result<BoardItem, StoreError> {
    Ok(BoardItem {
        id,
        project_id: Uuid::parse_str(&project)?,
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
    /// Adds `item` to its Project's board, ignoring its `id`, and returns it with the new id.
    ///
    /// # Errors
    ///
    /// A database error, including a constraint error if its Project doesn't exist.
    pub fn add_board_item(&self, item: &BoardItem) -> Result<BoardItem, StoreError> {
        self.conn.execute(
            "INSERT INTO board_items (project_id, text, status, section, links, created_at,
                 updated_at, done_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
            params![
                item.project_id.to_string(),
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

    /// `project`'s item `id`, if it has one.
    ///
    /// # Errors
    ///
    /// A database error, or an error if a stored id or time is corrupt.
    pub fn board_item(&self, project: Uuid, id: i64) -> Result<Option<BoardItem>, StoreError> {
        self.conn
            .query_row(
                &format!("SELECT {COLUMNS} FROM board_items WHERE id = ?1 AND project_id = ?2"),
                params![id, project.to_string()],
                from_row,
            )
            .optional()?
            .map(into_item)
            .transpose()
    }

    /// `project`'s board items, oldest first.
    ///
    /// # Errors
    ///
    /// A database error, or an error if a stored id or time is corrupt.
    pub fn board_items(&self, project: Uuid) -> Result<Vec<BoardItem>, StoreError> {
        let mut statement = self.conn.prepare(&format!(
            "SELECT {COLUMNS} FROM board_items WHERE project_id = ?1 ORDER BY id"
        ))?;
        let rows = statement
            .query_map(params![project.to_string()], from_row)?
            .collect::<Result<Vec<_>, _>>()?;
        rows.into_iter().map(into_item).collect()
    }

    /// Saves `item`'s text, status, section, links, and times over the stored row with its id
    /// and Project. Whether it exists.
    ///
    /// # Errors
    ///
    /// A database error.
    pub fn update_board_item(&self, item: &BoardItem) -> Result<bool, StoreError> {
        let changed = self.conn.execute(
            "UPDATE board_items SET text = ?3, status = ?4, section = ?5, links = ?6,
                 updated_at = ?7, done_at = ?8
             WHERE id = ?1 AND project_id = ?2",
            params![
                item.id,
                item.project_id.to_string(),
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

    /// Removes `project`'s item `id`. Whether it existed.
    ///
    /// # Errors
    ///
    /// A database error.
    pub fn remove_board_item(&self, project: Uuid, id: i64) -> Result<bool, StoreError> {
        let changed = self.conn.execute(
            "DELETE FROM board_items WHERE id = ?1 AND project_id = ?2",
            params![id, project.to_string()],
        )?;
        Ok(changed > 0)
    }

    /// The Projects whose hand-written boards plxd still has to parse into items (migration 49).
    ///
    /// # Errors
    ///
    /// A database error, or an error if a stored id is corrupt.
    pub fn board_migrations_pending(&self) -> Result<Vec<Uuid>, StoreError> {
        let mut statement = self.conn.prepare(&format!(
            "SELECT substr(key, {}) FROM host_settings WHERE key GLOB '{BOARD_MIGRATION}*'",
            BOARD_MIGRATION.len() + 1
        ))?;
        let ids = statement
            .query_map([], |row| row.get::<_, String>(0))?
            .collect::<Result<Vec<_>, _>>()?;
        ids.iter()
            .map(|id| Uuid::parse_str(id).map_err(Into::into))
            .collect()
    }

    /// Whether `project`'s board migration is still to do.
    ///
    /// # Errors
    ///
    /// A database error.
    pub fn board_migration_pending(&self, project: Uuid) -> Result<bool, StoreError> {
        Ok(self.text(&format!("{BOARD_MIGRATION}{project}"))?.is_some())
    }

    /// Marks `project`'s board for the migration, as migration 49 marks each Project the store
    /// had.
    ///
    /// # Errors
    ///
    /// A database error.
    pub fn mark_board_migration(&self, project: Uuid) -> Result<(), StoreError> {
        self.set_text(&format!("{BOARD_MIGRATION}{project}"), Some("pending"))
    }

    /// Records that `project`'s board is now items.
    ///
    /// # Errors
    ///
    /// A database error.
    pub fn finish_board_migration(&self, project: Uuid) -> Result<(), StoreError> {
        self.set_text(&format!("{BOARD_MIGRATION}{project}"), None)
    }
}
