use jiff::Timestamp;
use rusqlite::{Connection, OptionalExtension, Row, params};
use uuid::Uuid;

use crate::error::StoreError;
use crate::orchestrator::{icon_columns, icon_from_row};
use crate::runs::{delete_run_rows, insert_run};
use crate::worktree::insert_worktree;
use crate::{ChosenIcon, Run, RunFields, RunState, Store, Worktree, WorktreeFields, timestamp};

/// What registering a repo entry takes (#110).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RepoFields {
    pub name: String,
    /// The repository's canonical path. One entry per path.
    pub path: String,
    /// Whether this is plxd's scratch entry, for threads with no repo.
    pub scratch: bool,
    /// Whether this is a Project (0069): a named group of chats, backed by a repository plxd made.
    pub project: bool,
}

/// A repo entry row: a repository normal threads run in.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Repo {
    pub id: Uuid,
    pub fields: RepoFields,
    /// Its icon, in a project's shape (decision record 0033), stored as the client sent it.
    pub icon: Option<ChosenIcon>,
    pub created_at: Timestamp,
    /// A Project's instructions for every thread in it (decision record 0090).
    pub instructions: Option<String>,
    /// The files a Project gives every thread in it, as absolute paths (decision record 0090).
    pub files: Vec<String>,
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
    /// When the user last sent it a message: its newest turn the user wrote (PLX-937), or its
    /// creation. Wake-ups and other threads' messages don't move it (PLX-1012).
    pub last_user_prompt_at: Timestamp,
    /// The run that launched it: its run's [`RunFields::parent`] (decision record 0041).
    pub parent: Option<Uuid>,
    /// Its fork origin and title.
    pub fields: ThreadFields,
    /// Whether the user or an agent marked it settled: nothing left to do.
    pub settled: bool,
    /// When it was last unarchived, which the merge sweep counts as activity (PLX-795).
    pub unarchived_at: Option<Timestamp>,
    /// Whether the user pinned it to the top of the sidebar (PLX-789).
    pub pinned: bool,
    /// The Project the user added it to (0090), apart from `repo_id`.
    pub project_id: Option<Uuid>,
    /// The orchestrator whose orchestration it runs (0093), when it is an orchestrator thread.
    pub orchestrator_id: Option<Uuid>,
    /// Why it last un-archived itself, as the daemon's JSON (0093). Cleared when it is archived
    /// or un-archived by hand.
    pub wake_reason: Option<String>,
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
    /// Pins or unpins it (PLX-789).
    pub pinned: Option<bool>,
}

const REPO_COLUMNS: &str = "id, name, path, scratch, created_at, \
    icon_name, icon_color, icon_image_type, icon_image_data, project, instructions, files";
const THREAD_COLUMNS: &str = "id, repo_id, archived, created_at, seen_at, snoozed_until, \
    COALESCE((SELECT MAX(created_at) FROM turns WHERE turns.run_id = threads.id), created_at) \
    AS last_prompt_at, (SELECT parent FROM runs WHERE runs.id = threads.id), forked_from_run, \
    forked_from_turn, title, settled, unarchived_at, pinned, \
    COALESCE((SELECT MAX(created_at) FROM turns WHERE turns.run_id = threads.id AND from_user \
        AND substr(text, 1, 22) != 'Parallax, not the user'), created_at) AS last_user_prompt_at, \
    project_id, orchestrator_id, wake_reason";

/// A repo entry's columns as TEXT, before the fallible conversion to [`Repo`].
type RawRepo = (
    String,
    String,
    String,
    bool,
    String,
    Option<ChosenIcon>,
    bool,
    Option<String>,
    Option<String>,
);

fn repo_from_row(row: &Row<'_>) -> rusqlite::Result<RawRepo> {
    Ok((
        row.get(0)?,
        row.get(1)?,
        row.get(2)?,
        row.get(3)?,
        row.get(4)?,
        icon_from_row(row, 5)?,
        row.get(9)?,
        row.get(10)?,
        row.get(11)?,
    ))
}

fn into_repo(raw: RawRepo) -> Result<Repo, StoreError> {
    let (id, name, path, scratch, created_at, icon, project, instructions, files) = raw;
    Ok(Repo {
        id: Uuid::parse_str(&id)?,
        fields: RepoFields {
            name,
            path,
            scratch,
            project,
        },
        icon,
        created_at: timestamp::parse(&created_at)?,
        instructions,
        files: files
            .map(|files| files.lines().map(str::to_owned).collect())
            .unwrap_or_default(),
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
    unarchived_at: Option<String>,
    pinned: bool,
    last_user_prompt_at: String,
    project_id: Option<String>,
    orchestrator_id: Option<String>,
    wake_reason: Option<String>,
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
        unarchived_at: row.get(12)?,
        pinned: row.get(13)?,
        last_user_prompt_at: row.get(14)?,
        project_id: row.get(15)?,
        orchestrator_id: row.get(16)?,
        wake_reason: row.get(17)?,
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
        last_user_prompt_at: timestamp::parse(&raw.last_user_prompt_at)?,
        parent: uuid(raw.parent)?,
        fields: ThreadFields {
            forked_from,
            title: raw.title,
        },
        settled: raw.settled,
        unarchived_at: raw
            .unarchived_at
            .as_deref()
            .map(timestamp::parse)
            .transpose()?,
        pinned: raw.pinned,
        project_id: uuid(raw.project_id)?,
        orchestrator_id: uuid(raw.orchestrator_id)?,
        wake_reason: raw.wake_reason,
    })
}

/// A `LIKE` pattern, escaped with `\`, that matches `text` anywhere.
fn like_pattern(text: &str) -> String {
    let mut pattern = String::with_capacity(text.len() + 2);
    pattern.push('%');
    for c in text.chars() {
        if matches!(c, '%' | '_' | '\\') {
            pattern.push('\\');
        }
        pattern.push(c);
    }
    pattern.push('%');
    pattern
}

/// `query` as an FTS5 query for [`Store::search_threads`]: every word of it, each as a prefix.
/// Each word is quoted, its own quotes doubled, so nothing in it is an operator. A word with no
/// letter or digit is dropped, as the tokenizer would drop it; with none left, the query is
/// `""`, which matches nothing. A NUL, which FTS5 takes as the query's end, separates words.
fn match_query(query: &str) -> String {
    let words: Vec<String> = query
        .split(|c: char| c.is_whitespace() || c == '\0')
        .filter(|word| word.chars().any(char::is_alphanumeric))
        .map(|word| format!("\"{}\"*", word.replace('"', "\"\"")))
        .collect();
    if words.is_empty() {
        "\"\"".to_owned()
    } else {
        words.join(" ")
    }
}

/// The longest snippet [`Store::search_snippets`] returns, in characters.
const SNIPPET_CHARS: usize = 120;

/// What [`Store::search_snippets`]' `snippet()` marks a matched word's start and end with.
const MATCH_START: char = '\u{2}';
const MATCH_END: char = '\u{3}';

/// A snippet on one line: its whitespace runs collapsed to single spaces and its match marks
/// removed. Longer than [`SNIPPET_CHARS`], it is cut to a window that starts a third of the way
/// before its first match, with `…` on each side that was cut.
fn one_line(snippet: &str) -> String {
    let line = snippet.split_whitespace().collect::<Vec<_>>().join(" ");
    let at = line
        .chars()
        .position(|c| c == MATCH_START)
        .unwrap_or_default();
    let chars: Vec<char> = line
        .chars()
        .filter(|c| *c != MATCH_START && *c != MATCH_END)
        .collect();
    if chars.len() <= SNIPPET_CHARS {
        return chars.into_iter().collect();
    }
    let room = SNIPPET_CHARS - 2;
    let start = at.saturating_sub(room / 3).min(chars.len() - room);
    let end = start + room;
    let mut cut = String::new();
    if start > 0 {
        cut.push('…');
    }
    cut.extend(&chars[start..end]);
    if end < chars.len() {
        cut.push('…');
    }
    cut
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

/// Repo entry `id`, or [`StoreError::NotFound`] if there is none.
fn existing_repo(conn: &Connection, id: Uuid) -> Result<Repo, StoreError> {
    fetch_repo(conn, "id = ?1", &id.to_string())?.ok_or(StoreError::NotFound { id })
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
        let tx = self.conn.savepoint()?;
        if let Some(existing) = fetch_repo(&tx, "path = ?1", &fields.path)? {
            return Ok(existing);
        }
        if fetch_repo(&tx, "id = ?1", &id.to_string())?.is_some() {
            return Err(StoreError::IdConflict { id });
        }
        tx.execute(
            "INSERT INTO repos (id, name, path, scratch, project, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![
                id.to_string(),
                fields.name,
                fields.path,
                fields.scratch,
                fields.project,
                timestamp::now()
            ],
        )?;
        let repo = existing_repo(&tx, id)?;
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
        stmt.query_map([], repo_from_row)?
            .map(|row| into_repo(row?))
            .collect()
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
        let tx = self.conn.savepoint()?;
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
        stmt.query_map([], thread_from_row)?
            .map(|row| into_thread(row?))
            .collect()
    }

    /// The threads whose title contains `query` or whose messages hold every word of it, at most
    /// `limit` (PLX-372, PLX-487). A message is the run's prompt, a sent turn's text, or the
    /// agent's reply, as migration 36's triggers and [`Store::index_run_text`] indexed them; tool
    /// calls and their output don't count. A word matches any word it starts, ignoring case and
    /// accents, and punctuation is ignored. Title matches come first, then the one with the
    /// newest message, as the thread list orders them.
    ///
    /// # Errors
    ///
    /// A database error, or an error if a stored id or timestamp is corrupt.
    pub fn search_threads(&self, query: &str, limit: usize) -> Result<Vec<Thread>, StoreError> {
        let mut stmt = self.conn.prepare(&format!(
            "SELECT {THREAD_COLUMNS} FROM threads
             WHERE title LIKE ?2 ESCAPE '\\' OR threads.id IN (
                SELECT run_id FROM thread_text WHERE thread_text.id IN (
                    SELECT rowid FROM thread_text_fts WHERE thread_text_fts MATCH ?1))
             ORDER BY title LIKE ?2 ESCAPE '\\' DESC, last_prompt_at DESC, id DESC
             LIMIT ?3"
        ))?;
        let limit = i64::try_from(limit).unwrap_or(i64::MAX);
        stmt.query_map(
            params![match_query(query), like_pattern(query), limit],
            thread_from_row,
        )?
        .map(|row| into_thread(row?))
        .collect()
    }

    /// For each of `threads`, one line of its message that best matches `query`, as
    /// [`Store::search_threads`] matches it: the window FTS5's `snippet()` picks, kept around
    /// its first highlighted word and cut to 120 characters, with `…` where it was cut (PLX-789).
    /// A thread none of whose messages match has none. In `threads`' order, with one query.
    ///
    /// # Errors
    ///
    /// A database error, or an error if a stored id is corrupt.
    pub fn search_snippets(
        &self,
        query: &str,
        threads: &[Uuid],
    ) -> Result<Vec<(Uuid, String)>, StoreError> {
        let ids = threads
            .iter()
            .map(|id| format!("\"{id}\""))
            .collect::<Vec<_>>()
            .join(",");
        let mut stmt = self.conn.prepare(
            "SELECT thread_text.run_id, snippet(thread_text_fts, 0, char(2), char(3), '…', 16)
             FROM thread_text_fts JOIN thread_text ON thread_text.id = thread_text_fts.rowid
             WHERE thread_text_fts MATCH ?1
                AND thread_text.run_id IN (SELECT value FROM json_each(?2))
             ORDER BY rank",
        )?;
        let rows = stmt.query_map(params![match_query(query), format!("[{ids}]")], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })?;
        // Rows come best first, so a thread's first row is its best.
        let mut best = std::collections::HashMap::new();
        for row in rows {
            let (run, text) = row?;
            best.entry(Uuid::parse_str(&run)?).or_insert(text);
        }
        Ok(threads
            .iter()
            .filter_map(|id| best.remove(id).map(|text| (*id, one_line(&text))))
            .collect())
    }

    /// Indexes the agent's replies in `run_id`'s `agent.output` events logged since its newest
    /// indexed reply, for [`Store::search_threads`] (PLX-487), as one row: the events' `text`
    /// items. Its prompt and sent turns are indexed as they're stored. Called when a turn ends,
    /// and for a run plxd stopped mid-turn, so a turn is one row however many batches it
    /// streamed in, and compacting the turn later (decision record 0052) leaves the row alone.
    /// Does nothing if nothing is new.
    ///
    /// # Errors
    ///
    /// A database error.
    pub fn index_run_text(&self, run_id: Uuid) -> Result<(), StoreError> {
        self.conn.execute(
            "INSERT INTO thread_text (run_id, seq, text)
             SELECT ?1, MAX(events.seq), group_concat(json_extract(item.value, '$.text'), char(10))
             FROM events, json_each(events.payload, '$.items') AS item
             WHERE events.thread_id = ?1 AND events.type = 'agent.output'
                AND events.seq > (SELECT COALESCE(MAX(seq), 0) FROM thread_text
                    WHERE run_id = ?1)
                AND json_extract(item.value, '$.kind') = 'text'
                AND json_extract(item.value, '$.text') IS NOT NULL
             HAVING COUNT(*) > 0",
            params![run_id.to_string()],
        )?;
        Ok(())
    }

    /// Archives thread `id` or brings it back, recording when it came back, and returns it. Either
    /// clears its wake reason, since the user moved it.
    ///
    /// # Errors
    ///
    /// [`StoreError::NotFound`] if no thread has `id`, or a database error.
    pub fn set_thread_archived(&self, id: Uuid, archived: bool) -> Result<Thread, StoreError> {
        let changed = self.conn.execute(
            "UPDATE threads SET archived = ?2, wake_reason = NULL, \
             unarchived_at = CASE WHEN ?2 THEN unarchived_at ELSE ?3 END WHERE id = ?1",
            params![id.to_string(), archived, timestamp::now()],
        )?;
        if changed == 0 {
            return Err(StoreError::NotFound { id });
        }
        fetch_thread(&self.conn, id)?.ok_or(StoreError::NotFound { id })
    }

    /// Makes run `id`, which must exist, orchestrator `orchestrator`'s thread (0093): a thread row
    /// in the orchestrator, as its children's are, with orchestration on. The thread that had it,
    /// from a run this one replaces, keeps its row with orchestration off, and gives the new one
    /// its Project and pin. Returns the new thread, and the old one when there was one.
    ///
    /// # Errors
    ///
    /// A database error.
    pub fn create_orchestrator_thread(
        &mut self,
        id: Uuid,
        orchestrator: Uuid,
    ) -> Result<(Thread, Option<Thread>), StoreError> {
        let tx = self.conn.savepoint()?;
        let before = tx
            .query_row(
                "SELECT id FROM threads WHERE orchestrator_id = ?1 AND id != ?2",
                params![orchestrator.to_string(), id.to_string()],
                |row| row.get::<_, String>(0),
            )
            .optional()?;
        let (project, pinned) = match &before {
            Some(old) => tx.query_row(
                "SELECT project_id, pinned FROM threads WHERE id = ?1",
                params![old],
                |row| Ok((row.get::<_, Option<String>>(0)?, row.get::<_, bool>(1)?)),
            )?,
            None => (None, false),
        };
        if let Some(old) = &before {
            tx.execute(
                "UPDATE threads SET orchestrator_id = NULL WHERE id = ?1",
                params![old],
            )?;
        }
        let now = timestamp::now();
        tx.execute(
            "INSERT INTO threads (id, repo_id, archived, created_at, seen_at, orchestrator_id,
                                  project_id, pinned)
             VALUES (?1, ?2, 0, ?3, ?3, ?2, ?4, ?5)
             ON CONFLICT (id) DO UPDATE SET orchestrator_id = excluded.orchestrator_id",
            params![
                id.to_string(),
                orchestrator.to_string(),
                now,
                project,
                pinned
            ],
        )?;
        let thread = fetch_thread(&tx, id)?.ok_or(StoreError::NotFound { id })?;
        let before = before
            .map(|old| fetch_thread(&tx, Uuid::parse_str(&old)?))
            .transpose()?
            .flatten();
        tx.commit()?;
        Ok((thread, before))
    }

    /// Orchestrator `orchestrator`'s thread (0093), once its first run started.
    ///
    /// # Errors
    ///
    /// A database error, or an error if a stored id or timestamp is corrupt.
    pub fn orchestrator_thread(&self, orchestrator: Uuid) -> Result<Option<Thread>, StoreError> {
        self.conn
            .query_row(
                &format!("SELECT {THREAD_COLUMNS} FROM threads WHERE orchestrator_id = ?1"),
                params![orchestrator.to_string()],
                thread_from_row,
            )
            .optional()?
            .map(into_thread)
            .transpose()
    }

    /// Brings orchestrator thread `id` back into the list because of `reason`, plxd's JSON (0093):
    /// un-archives and un-settles it and records why. Only an archived or settled orchestrator
    /// thread wakes, so this returns the thread when it changed and `None` otherwise.
    ///
    /// # Errors
    ///
    /// A database error, or an error if a stored id or timestamp is corrupt.
    pub fn wake_thread(&self, id: Uuid, reason: &str) -> Result<Option<Thread>, StoreError> {
        let changed = self.conn.execute(
            "UPDATE threads SET archived = 0, settled = 0, wake_reason = ?2, unarchived_at = ?3
             WHERE id = ?1 AND orchestrator_id IS NOT NULL AND (archived OR settled)",
            params![id.to_string(), reason, timestamp::now()],
        )?;
        if changed == 0 {
            return Ok(None);
        }
        fetch_thread(&self.conn, id)
    }

    /// Applies `update` to thread `id`: marks it seen now, snoozes it (decision record 0033), or
    /// sets its title or settled flag (decision record 0041), or pins it (PLX-789). Returns the
    /// thread and whether anything changed.
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
            pinned,
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
        if let Some(pinned) = pinned {
            changed += self.conn.execute(
                "UPDATE threads SET pinned = ?2 WHERE id = ?1 AND pinned IS NOT ?2",
                params![key, pinned],
            )?;
        }
        let thread = fetch_thread(&self.conn, id)?.ok_or(StoreError::NotFound { id })?;
        Ok((thread, changed > 0))
    }

    /// Adds thread `id` to Project `project`, or with `None` takes it out of its Project (0090). Returns
    /// the thread and whether it changed.
    ///
    /// # Errors
    ///
    /// [`StoreError::NotFound`] if no thread has `id`, or a database error.
    pub fn set_thread_project(
        &self,
        id: Uuid,
        project: Option<Uuid>,
    ) -> Result<(Thread, bool), StoreError> {
        let changed = self.conn.execute(
            "UPDATE threads SET project_id = ?2 WHERE id = ?1 AND project_id IS NOT ?2",
            params![id.to_string(), project.map(|project| project.to_string())],
        )?;
        let thread = fetch_thread(&self.conn, id)?.ok_or(StoreError::NotFound { id })?;
        Ok((thread, changed > 0))
    }

    /// Sets repo entry `id`'s icon, replacing the whole icon. Returns the entry and whether it
    /// changed.
    ///
    /// # Errors
    ///
    /// [`StoreError::NotFound`] if no entry has `id`, or a database error.
    pub fn set_repo_icon(&self, id: Uuid, icon: &ChosenIcon) -> Result<(Repo, bool), StoreError> {
        let before = existing_repo(&self.conn, id)?;
        if before.icon.as_ref() == Some(icon) {
            return Ok((before, false));
        }
        let (name, color, image_type, image_data) = icon_columns(Some(icon));
        self.conn.execute(
            "UPDATE repos SET icon_name = ?2, icon_color = ?3, icon_image_type = ?4, \
             icon_image_data = ?5 WHERE id = ?1",
            params![id.to_string(), name, color, image_type, image_data],
        )?;
        Ok((existing_repo(&self.conn, id)?, true))
    }

    /// Renames repo entry `id`. Returns the entry and whether the name changed.
    ///
    /// # Errors
    ///
    /// [`StoreError::NotFound`] if no entry has `id`, or a database error.
    pub fn rename_repo(&self, id: Uuid, name: &str) -> Result<(Repo, bool), StoreError> {
        let before = existing_repo(&self.conn, id)?;
        if before.fields.name == name {
            return Ok((before, false));
        }
        self.conn.execute(
            "UPDATE repos SET name = ?2 WHERE id = ?1",
            params![id.to_string(), name],
        )?;
        Ok((existing_repo(&self.conn, id)?, true))
    }

    /// Sets a Project's instructions and files, each when given, `None` or empty instructions and
    /// an empty list clearing them. A file path holds no newline, since the paths are stored one
    /// per line. Returns the entry and whether it changed.
    ///
    /// # Errors
    ///
    /// [`StoreError::NotFound`] if no entry has `id`, or a database error.
    pub fn set_project_context(
        &self,
        id: Uuid,
        instructions: Option<&str>,
        files: Option<&[String]>,
    ) -> Result<(Repo, bool), StoreError> {
        let before = existing_repo(&self.conn, id)?;
        let instructions = instructions.map(|text| (!text.is_empty()).then_some(text));
        let same_instructions =
            instructions.is_none_or(|text| text == before.instructions.as_deref());
        let same_files = files.is_none_or(|files| files == before.files.as_slice());
        if same_instructions && same_files {
            return Ok((before, false));
        }
        if let Some(text) = instructions {
            self.conn.execute(
                "UPDATE repos SET instructions = ?2 WHERE id = ?1",
                params![id.to_string(), text],
            )?;
        }
        if let Some(files) = files {
            let joined = (!files.is_empty()).then(|| files.join("\n"));
            self.conn.execute(
                "UPDATE repos SET files = ?2 WHERE id = ?1",
                params![id.to_string(), joined],
            )?;
        }
        Ok((existing_repo(&self.conn, id)?, true))
    }

    /// Deletes repo entry `id`, once its threads are deleted. Returns whether it existed.
    ///
    /// # Errors
    ///
    /// A database error.
    pub fn delete_repo(&self, id: Uuid) -> Result<bool, StoreError> {
        Ok(self
            .conn
            .execute("DELETE FROM repos WHERE id = ?1", params![id.to_string()])?
            > 0)
    }

    /// Deletes thread `id` with its run and every row [`Store::delete_run`] deletes (#190,
    /// PLX-191), in one transaction. Returns whether the thread existed.
    ///
    /// # Errors
    ///
    /// A database error.
    pub fn delete_thread(&mut self, id: Uuid) -> Result<bool, StoreError> {
        let tx = self.conn.savepoint()?;
        let existed = tx.execute("DELETE FROM threads WHERE id = ?1", params![id.to_string()])? > 0;
        delete_run_rows(&tx, id)?;
        tx.commit()?;
        Ok(existed)
    }
}
