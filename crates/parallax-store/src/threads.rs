use jiff::Timestamp;
use rusqlite::{Connection, OptionalExtension, Row, TransactionBehavior, params};
use uuid::Uuid;

use crate::error::StoreError;
use crate::project::{icon_columns, icon_from_row};
use crate::runs::{delete_run_rows, insert_run};
use crate::worktree::insert_worktree;
use crate::{ProjectIcon, Run, RunFields, RunState, Store, Worktree, WorktreeFields, timestamp};

/// What registering a repo entry takes (#110).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RepoFields {
    pub name: String,
    /// The repository's canonical path. One entry per path.
    pub path: String,
    /// Whether this is plxd's scratch entry, for threads with no repo.
    pub scratch: bool,
}

/// A repo entry row: a repository normal threads run in.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Repo {
    pub id: Uuid,
    pub fields: RepoFields,
    /// Its icon, in a project's shape (decision record 0033), stored as the client sent it.
    pub icon: Option<ProjectIcon>,
    pub created_at: Timestamp,
}

/// A normal thread row, keyed by its run's id.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Thread {
    pub id: Uuid,
    pub repo_id: Uuid,
    pub archived: bool,
    pub created_at: Timestamp,
    /// When the user last saw it (decision record 0033).
    pub seen_at: Option<Timestamp>,
    /// Until when the user snoozed it. A time in the past means it isn't snoozed.
    pub snoozed_until: Option<Timestamp>,
    /// When its newest message was sent: its newest recorded turn, or its creation.
    pub last_prompt_at: Timestamp,
    /// The run that launched it: its run's [`RunFields::parent`] (decision record 0041).
    pub parent: Option<Uuid>,
    /// Its fork origin and title.
    pub fields: ThreadFields,
    /// Whether the user or an agent marked it settled: nothing left to do.
    pub settled: bool,
}

/// The run and turn a thread was forked from (decision record 0041).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ForkedFrom {
    pub run: Uuid,
    pub turn: Uuid,
}

/// A thread's fork origin and title (decision record 0041), as a new thread records them.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ThreadFields {
    /// Where it was forked from. Cleared when that run is deleted.
    pub forked_from: Option<ForkedFrom>,
    /// Its title. `None` leaves it to the client, which shows its prompt's first line.
    pub title: Option<String>,
}

/// What [`Store::update_thread`] changes. Each `None` leaves its field alone.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ThreadUpdate {
    /// Marks it seen now (decision record 0033).
    pub seen: bool,
    /// Replaces its snooze.
    pub snoozed_until: Option<Timestamp>,
    /// Replaces its title, where `Some(None)` clears it.
    pub title: Option<Option<String>>,
    pub settled: Option<bool>,
}

const REPO_COLUMNS: &str = "id, name, path, scratch, created_at, \
    icon_name, icon_color, icon_image_type, icon_image_data";
const THREAD_COLUMNS: &str = "id, repo_id, archived, created_at, seen_at, snoozed_until, \
    COALESCE((SELECT MAX(created_at) FROM turns WHERE turns.run_id = threads.id), created_at), \
    (SELECT parent FROM runs WHERE runs.id = threads.id), forked_from_run, forked_from_turn, \
    title, settled";

/// A repo entry's columns as TEXT, before the fallible conversion to [`Repo`].
type RawRepo = (String, String, String, bool, String, Option<ProjectIcon>);

fn repo_from_row(row: &Row<'_>) -> rusqlite::Result<RawRepo> {
    Ok((
        row.get(0)?,
        row.get(1)?,
        row.get(2)?,
        row.get(3)?,
        row.get(4)?,
        icon_from_row(row, 5)?,
    ))
}

fn into_repo(raw: RawRepo) -> Result<Repo, StoreError> {
    let (id, name, path, scratch, created_at, icon) = raw;
    Ok(Repo {
        id: Uuid::parse_str(&id)?,
        fields: RepoFields {
            name,
            path,
            scratch,
        },
        icon,
        created_at: timestamp::parse(&created_at)?,
    })
}

/// A thread's columns as TEXT, before the fallible conversion to [`Thread`].
struct RawThread {
    id: String,
    repo_id: String,
    archived: bool,
    created_at: String,
    seen_at: Option<String>,
    snoozed_until: Option<String>,
    last_prompt_at: String,
    parent: Option<String>,
    forked_from_run: Option<String>,
    forked_from_turn: Option<String>,
    title: Option<String>,
    settled: bool,
}

fn thread_from_row(row: &Row<'_>) -> rusqlite::Result<RawThread> {
    Ok(RawThread {
        id: row.get(0)?,
        repo_id: row.get(1)?,
        archived: row.get(2)?,
        created_at: row.get(3)?,
        seen_at: row.get(4)?,
        snoozed_until: row.get(5)?,
        last_prompt_at: row.get(6)?,
        parent: row.get(7)?,
        forked_from_run: row.get(8)?,
        forked_from_turn: row.get(9)?,
        title: row.get(10)?,
        settled: row.get(11)?,
    })
}

fn into_thread(raw: RawThread) -> Result<Thread, StoreError> {
    let uuid = |text: Option<String>| text.as_deref().map(Uuid::parse_str).transpose();
    let forked_from = match (uuid(raw.forked_from_run)?, uuid(raw.forked_from_turn)?) {
        (Some(run), Some(turn)) => Some(ForkedFrom { run, turn }),
        _ => None,
    };
    Ok(Thread {
        id: Uuid::parse_str(&raw.id)?,
        repo_id: Uuid::parse_str(&raw.repo_id)?,
        archived: raw.archived,
        created_at: timestamp::parse(&raw.created_at)?,
        seen_at: raw.seen_at.as_deref().map(timestamp::parse).transpose()?,
        snoozed_until: raw
            .snoozed_until
            .as_deref()
            .map(timestamp::parse)
            .transpose()?,
        last_prompt_at: timestamp::parse(&raw.last_prompt_at)?,
        parent: uuid(raw.parent)?,
        fields: ThreadFields {
            forked_from,
            title: raw.title,
        },
        settled: raw.settled,
    })
}

fn fetch_repo(conn: &Connection, sql_where: &str, key: &str) -> Result<Option<Repo>, StoreError> {
    conn.query_row(
        &format!("SELECT {REPO_COLUMNS} FROM repos WHERE {sql_where}"),
        params![key],
        repo_from_row,
    )
    .optional()?
    .map(into_repo)
    .transpose()
}

fn fetch_thread(conn: &Connection, id: Uuid) -> Result<Option<Thread>, StoreError> {
    conn.query_row(
        &format!("SELECT {THREAD_COLUMNS} FROM threads WHERE id = ?1"),
        params![id.to_string()],
        thread_from_row,
    )
    .optional()?
    .map(into_thread)
    .transpose()
}

impl Store {
    /// Registers a repo entry `id` for `fields.path`, or returns the entry that already has that
    /// path, whatever its id.
    ///
    /// # Errors
    ///
    /// [`StoreError::IdConflict`] if `id` is taken by an entry with another path, or a database
    /// error.
    pub fn add_repo(&mut self, id: Uuid, fields: &RepoFields) -> Result<Repo, StoreError> {
        let tx = self
            .conn
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        if let Some(existing) = fetch_repo(&tx, "path = ?1", &fields.path)? {
            return Ok(existing);
        }
        if fetch_repo(&tx, "id = ?1", &id.to_string())?.is_some() {
            return Err(StoreError::IdConflict { id });
        }
        tx.execute(
            "INSERT INTO repos (id, name, path, scratch, created_at) VALUES (?1, ?2, ?3, ?4, ?5)",
            params![
                id.to_string(),
                fields.name,
                fields.path,
                fields.scratch,
                timestamp::now()
            ],
        )?;
        let repo =
            fetch_repo(&tx, "id = ?1", &id.to_string())?.ok_or(StoreError::NotFound { id })?;
        tx.commit()?;
        Ok(repo)
    }

    /// Reads a repo entry.
    ///
    /// # Errors
    ///
    /// A database error, or an error if a stored id or timestamp is corrupt.
    pub fn get_repo(&self, id: Uuid) -> Result<Option<Repo>, StoreError> {
        fetch_repo(&self.conn, "id = ?1", &id.to_string())
    }

    /// plxd's scratch entry, once it made one.
    ///
    /// # Errors
    ///
    /// A database error, or an error if a stored id or timestamp is corrupt.
    pub fn scratch_repo(&self) -> Result<Option<Repo>, StoreError> {
        self.conn
            .query_row(
                &format!(
                    "SELECT {REPO_COLUMNS} FROM repos WHERE scratch = 1 \
                     ORDER BY created_at ASC, id ASC LIMIT 1"
                ),
                [],
                repo_from_row,
            )
            .optional()?
            .map(into_repo)
            .transpose()
    }

    /// Every repo entry, oldest first.
    ///
    /// # Errors
    ///
    /// A database error, or an error if a stored id or timestamp is corrupt.
    pub fn list_repos(&self) -> Result<Vec<Repo>, StoreError> {
        let mut stmt = self.conn.prepare(&format!(
            "SELECT {REPO_COLUMNS} FROM repos ORDER BY created_at ASC, id ASC"
        ))?;
        let rows = stmt.query_map([], repo_from_row)?;
        let mut repos = Vec::new();
        for row in rows {
            repos.push(into_repo(row?)?);
        }
        Ok(repos)
    }

    /// Records a normal thread in repo entry `repo_id`, with its run and the run's worktree, in
    /// one transaction, so none exists without the others. The run's `project_id` must be
    /// `repo_id`. A run in the repository's own checkout ([`RunFields::checkout`]) has no
    /// worktree, so `worktree` is `None` for it. `thread` is its fork origin and title.
    ///
    /// # Errors
    ///
    /// [`StoreError::IdConflict`] if a run, a worktree, or a thread with `id` exists, in which
    /// case nothing is written, or a database error.
    pub fn create_thread_run(
        &mut self,
        id: Uuid,
        repo_id: Uuid,
        fields: &RunFields,
        state: &RunState,
        worktree: Option<&WorktreeFields>,
        thread: &ThreadFields,
    ) -> Result<(Thread, Run, Option<Worktree>), StoreError> {
        let tx = self
            .conn
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let worktree = worktree
            .map(|worktree| insert_worktree(&tx, id, worktree))
            .transpose()?;
        let run = insert_run(&tx, id, fields, state)?;
        let inserted = tx.execute(
            "INSERT INTO threads (id, repo_id, archived, created_at, forked_from_run,
                                  forked_from_turn, title)
             VALUES (?1, ?2, 0, ?3, ?4, ?5, ?6)
             ON CONFLICT (id) DO NOTHING",
            params![
                id.to_string(),
                repo_id.to_string(),
                timestamp::now(),
                thread.forked_from.map(|from| from.run.to_string()),
                thread.forked_from.map(|from| from.turn.to_string()),
                thread.title,
            ],
        )?;
        if inserted == 0 {
            return Err(StoreError::IdConflict { id });
        }
        let thread = fetch_thread(&tx, id)?.ok_or(StoreError::NotFound { id })?;
        tx.commit()?;
        Ok((thread, run, worktree))
    }

    /// Reads a thread.
    ///
    /// # Errors
    ///
    /// A database error, or an error if a stored id or timestamp is corrupt.
    pub fn get_thread(&self, id: Uuid) -> Result<Option<Thread>, StoreError> {
        fetch_thread(&self.conn, id)
    }

    /// Every thread, oldest first.
    ///
    /// # Errors
    ///
    /// A database error, or an error if a stored id or timestamp is corrupt.
    pub fn list_threads(&self) -> Result<Vec<Thread>, StoreError> {
        let mut stmt = self.conn.prepare(&format!(
            "SELECT {THREAD_COLUMNS} FROM threads ORDER BY created_at ASC, id ASC"
        ))?;
        let rows = stmt.query_map([], thread_from_row)?;
        let mut threads = Vec::new();
        for row in rows {
            threads.push(into_thread(row?)?);
        }
        Ok(threads)
    }

    /// Archives thread `id` or brings it back, and returns it.
    ///
    /// # Errors
    ///
    /// [`StoreError::NotFound`] if no thread has `id`, or a database error.
    pub fn set_thread_archived(&self, id: Uuid, archived: bool) -> Result<Thread, StoreError> {
        let changed = self.conn.execute(
            "UPDATE threads SET archived = ?2 WHERE id = ?1",
            params![id.to_string(), archived],
        )?;
        if changed == 0 {
            return Err(StoreError::NotFound { id });
        }
        fetch_thread(&self.conn, id)?.ok_or(StoreError::NotFound { id })
    }

    /// Applies `update` to thread `id`: marks it seen now, snoozes it (decision record 0033), or
    /// sets its title or settled flag (decision record 0041). Returns the thread and whether
    /// anything changed.
    ///
    /// # Errors
    ///
    /// [`StoreError::NotFound`] if no thread has `id`, or a database error.
    pub fn update_thread(
        &self,
        id: Uuid,
        update: &ThreadUpdate,
    ) -> Result<(Thread, bool), StoreError> {
        let ThreadUpdate {
            seen,
            snoozed_until,
            title,
            settled,
        } = update;
        let key = id.to_string();
        let mut changed = 0;
        if *seen {
            changed += self.conn.execute(
                "UPDATE threads SET seen_at = ?2 WHERE id = ?1",
                params![key, timestamp::now()],
            )?;
        }
        if let Some(until) = snoozed_until {
            changed += self.conn.execute(
                "UPDATE threads SET snoozed_until = ?2 WHERE id = ?1 \
                 AND snoozed_until IS NOT ?2",
                params![key, timestamp::format(*until)],
            )?;
        }
        if let Some(title) = title {
            changed += self.conn.execute(
                "UPDATE threads SET title = ?2 WHERE id = ?1 AND title IS NOT ?2",
                params![key, title],
            )?;
        }
        if let Some(settled) = settled {
            changed += self.conn.execute(
                "UPDATE threads SET settled = ?2 WHERE id = ?1 AND settled IS NOT ?2",
                params![key, settled],
            )?;
        }
        let thread = fetch_thread(&self.conn, id)?.ok_or(StoreError::NotFound { id })?;
        Ok((thread, changed > 0))
    }

    /// Sets repo entry `id`'s icon, replacing the whole icon. Returns the entry and whether it
    /// changed.
    ///
    /// # Errors
    ///
    /// [`StoreError::NotFound`] if no entry has `id`, or a database error.
    pub fn set_repo_icon(&self, id: Uuid, icon: &ProjectIcon) -> Result<(Repo, bool), StoreError> {
        let key = id.to_string();
        let before = fetch_repo(&self.conn, "id = ?1", &key)?.ok_or(StoreError::NotFound { id })?;
        if before.icon.as_ref() == Some(icon) {
            return Ok((before, false));
        }
        let (name, color, image_type, image_data) = icon_columns(Some(icon));
        self.conn.execute(
            "UPDATE repos SET icon_name = ?2, icon_color = ?3, icon_image_type = ?4, \
             icon_image_data = ?5 WHERE id = ?1",
            params![key, name, color, image_type, image_data],
        )?;
        let repo = fetch_repo(&self.conn, "id = ?1", &key)?.ok_or(StoreError::NotFound { id })?;
        Ok((repo, true))
    }

    /// Deletes thread `id` with its run and every row [`Store::delete_run`] deletes (#190,
    /// RYA-191), in one transaction. Returns whether the thread existed.
    ///
    /// # Errors
    ///
    /// A database error.
    pub fn delete_thread(&mut self, id: Uuid) -> Result<bool, StoreError> {
        let tx = self
            .conn
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let existed = tx.execute("DELETE FROM threads WHERE id = ?1", params![id.to_string()])? > 0;
        delete_run_rows(&tx, id)?;
        tx.commit()?;
        Ok(existed)
    }
}
