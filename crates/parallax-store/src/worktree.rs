use jiff::Timestamp;
use rusqlite::{Connection, OptionalExtension, Row, params};
use uuid::Uuid;

use crate::Store;
use crate::error::StoreError;
use crate::timestamp;

/// The fields of a worktree that a caller supplies. `id` is the run it was created for: a
/// worktree is created for exactly one run (#154).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WorktreeFields {
    pub repo_path: String,
    pub path: String,
    pub branch: String,
    pub base: String,
    /// The linked worktree's own private git directory, resolved once when it was created
    /// (#166). Every later git call pins it instead of trusting the worktree's `.git` file, which
    /// a worker can rewrite, so it is stored rather than derived again after a restart.
    pub git_dir: String,
    /// Whether the repository's tracked files had uncommitted changes when `base` was resolved
    /// from `HEAD` (#257). Always `false` for an explicit `base`.
    pub base_dirty: bool,
}

/// A worktree row.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Worktree {
    pub id: Uuid,
    pub repo_path: String,
    pub path: String,
    pub branch: String,
    pub base: String,
    /// See [`WorktreeFields::git_dir`]. Empty for a row written before the column existed.
    pub git_dir: String,
    /// See [`WorktreeFields::base_dirty`]. `false` for a row written before the column existed.
    pub base_dirty: bool,
    pub created_at: Timestamp,
}

/// A worktree row with its id and timestamp still as the TEXT SQLite stored them, before the
/// fallible conversion to [`Worktree`].
pub(crate) struct RawWorktree {
    id: String,
    repo_path: String,
    path: String,
    branch: String,
    base: String,
    git_dir: String,
    base_dirty: bool,
    created_at: String,
}

impl RawWorktree {
    fn from_row(row: &Row<'_>) -> rusqlite::Result<Self> {
        Self::at(row, 0)
    }

    /// Reads the columns `fetch_raw` selects, in its order, starting at column `start`.
    pub(crate) fn at(row: &Row<'_>, start: usize) -> rusqlite::Result<Self> {
        Ok(Self {
            id: row.get(start)?,
            repo_path: row.get(start + 1)?,
            path: row.get(start + 2)?,
            branch: row.get(start + 3)?,
            base: row.get(start + 4)?,
            git_dir: row.get(start + 5)?,
            base_dirty: row.get(start + 6)?,
            created_at: row.get(start + 7)?,
        })
    }

    pub(crate) fn into_worktree(self) -> Result<Worktree, StoreError> {
        Ok(Worktree {
            id: Uuid::parse_str(&self.id)?,
            repo_path: self.repo_path,
            path: self.path,
            branch: self.branch,
            base: self.base,
            git_dir: self.git_dir,
            base_dirty: self.base_dirty,
            created_at: timestamp::parse(&self.created_at)?,
        })
    }
}

fn fetch_raw(conn: &Connection, id_text: &str) -> Result<Option<RawWorktree>, StoreError> {
    Ok(conn
        .query_row(
            "SELECT id, repo_path, path, branch, base, git_dir, base_dirty, created_at
             FROM worktrees WHERE id = ?1",
            params![id_text],
            RawWorktree::from_row,
        )
        .optional()?)
}

impl Store {
    /// Reads a worktree by its run id.
    ///
    /// # Errors
    ///
    /// Returns a database error, or an error if the stored id or timestamp is corrupt.
    pub fn get_worktree(&self, id: Uuid) -> Result<Option<Worktree>, StoreError> {
        fetch_raw(&self.conn, &id.to_string())?
            .map(RawWorktree::into_worktree)
            .transpose()
    }

    /// Whether a run other than `id` has a worktree row at `path`: a folder threads share, which
    /// a checkpoint restore must not touch (0062).
    ///
    /// # Errors
    ///
    /// Returns a database error.
    pub fn worktree_shared(&self, id: Uuid, path: &str) -> Result<bool, StoreError> {
        Ok(self
            .conn
            .prepare_cached("SELECT 1 FROM worktrees WHERE path = ?2 AND id != ?1 LIMIT 1")?
            .query_row(params![id.to_string(), path], |_| Ok(()))
            .optional()?
            .is_some())
    }

    /// Records that run `id`'s worktree branch was renamed to `branch` (decision record 0058).
    ///
    /// # Errors
    ///
    /// Returns [`StoreError::NotFound`] if the run has no worktree, or a database error.
    pub fn set_worktree_branch(&self, id: Uuid, branch: &str) -> Result<(), StoreError> {
        let changed = self.conn.execute(
            "UPDATE worktrees SET branch = ?2 WHERE id = ?1",
            params![id.to_string(), branch],
        )?;
        if changed == 0 {
            return Err(StoreError::NotFound { id });
        }
        Ok(())
    }
}

/// Inserts a new worktree row for run `id`, failing with [`StoreError::IdConflict`] if one
/// exists. For a caller that creates the row inside its own transaction.
pub(crate) fn insert_worktree(
    conn: &Connection,
    id: Uuid,
    fields: &WorktreeFields,
) -> Result<Worktree, StoreError> {
    let id_text = id.to_string();
    let inserted = conn.execute(
        "INSERT INTO worktrees (id, repo_path, path, branch, base, git_dir, base_dirty, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
         ON CONFLICT (id) DO NOTHING",
        params![
            id_text,
            fields.repo_path,
            fields.path,
            fields.branch,
            fields.base,
            fields.git_dir,
            fields.base_dirty,
            timestamp::now()
        ],
    )?;
    if inserted == 0 {
        return Err(StoreError::IdConflict { id });
    }
    fetch_raw(conn, &id_text)?
        .ok_or(StoreError::NotFound { id })?
        .into_worktree()
}
