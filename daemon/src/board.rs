//! A Project's status board as items (PLX-940, decision 0081): `board/list`, `board/add`,
//! `board/update`, and `board/remove`, behind the `board` capability.
//!
//! plxd stores the items and renders the Project's `notes.md` and `archived.md` from them
//! ([`render`]) after every change, at start, and every [`RENDER_PERIOD`], so a done item moves to
//! `archived.md` once it is [`ARCHIVE_AFTER`] old. `context/write` refuses both files. Each line
//! ends with the item's id, which the coordinator's `board_update` and `board_remove` take.
//!
//! Migration 49 marks each Project the store had. At start, [`migrate`] parses each marked
//! Project's hand-written board ([`parse`]) into items once, keeping the originals as
//! [`LEGACY`]. plxd never renders a marked Project, so a migration that fails leaves its files as
//! they were for the next start to try again.

use std::sync::Arc;
use std::time::Duration;

use jiff::{SignedDuration, Timestamp};
use parallax_protocol::jsonrpc::ErrorObject;
use parallax_protocol::{
    BoardAddParams, BoardItem, BoardItemResult, BoardLinks, BoardListParams, BoardListResult,
    BoardRemoveParams, BoardRemoveResult, BoardSection, BoardStatus, BoardUpdateParams,
    ContextWriteId, ProjectId,
};
use parallax_store::{Store, StoreError};
use tokio::time::{self, MissedTickBehavior};
use tokio_util::sync::CancellationToken;
use tracing::{info, warn};
use uuid::Uuid;

use crate::methods::context::write_context_file;
use crate::server::Daemon;
use crate::store::store_error;
use crate::threads::store;

/// The board, rendered.
pub(crate) const NOTES: &str = "notes.md";

/// Done items older than [`ARCHIVE_AFTER`], rendered.
pub(crate) const ARCHIVED: &str = "archived.md";

/// The copies of `notes.md` and `archived.md` from before 0081 that the migration keeps. They
/// don't count toward the shared context cap, and `context/write` refuses them.
pub(crate) const LEGACY: [&str; 2] = ["notes.legacy.md", "archived.legacy.md"];

/// How long a done item stays in `notes.md`.
const ARCHIVE_AFTER: SignedDuration = SignedDuration::from_hours(7 * 24);

/// How often every Project's board is rendered again, so done items age out.
const RENDER_PERIOD: Duration = Duration::from_hours(1);

/// The longest an item's text, a link, or a file path may be, in bytes.
const MAX_TEXT_BYTES: usize = 2048;

/// The most threads or files one item links.
const MAX_LINKS: usize = 20;

/// The sections in the order the board shows them, with their headings.
const SECTIONS: [(BoardSection, &str); 3] = [
    (BoardSection::Now, "Now"),
    (BoardSection::Next, "Next"),
    (BoardSection::Risks, "Risks"),
];

/// Serializes renders, so one that read the items before another's change can't land last.
// ponytail: one lock for every Project's render; per-Project locks if boards change often.
static RENDER: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

fn status_key(status: BoardStatus) -> &'static str {
    if status == BoardStatus::Done {
        "done"
    } else {
        "open"
    }
}

fn section_key(section: BoardSection) -> &'static str {
    match section {
        BoardSection::Now => "now",
        BoardSection::Next => "next",
        BoardSection::Risks | BoardSection::Unknown => "risks",
    }
}

/// A stored row as the protocol's item.
fn entry(row: parallax_store::BoardItem) -> Result<BoardItem, ErrorObject> {
    let corrupt = || ErrorObject::internal_error(format!("board item {} is corrupt", row.id));
    Ok(BoardItem {
        id: u64::try_from(row.id).map_err(|_| corrupt())?,
        status: if row.status == "done" {
            BoardStatus::Done
        } else {
            BoardStatus::Open
        },
        section: match row.section.as_str() {
            "now" => BoardSection::Now,
            "next" => BoardSection::Next,
            _ => BoardSection::Risks,
        },
        links: serde_json::from_str(&row.links).map_err(|_| corrupt())?,
        text: row.text,
        created_at: row.created_at,
        updated_at: row.updated_at,
        done_at: row.done_at,
    })
}

/// The stored row for `item` in `project`.
fn row(project: Uuid, item: &BoardItem) -> parallax_store::BoardItem {
    parallax_store::BoardItem {
        id: i64::try_from(item.id).unwrap_or(i64::MAX),
        project_id: project,
        text: item.text.clone(),
        status: status_key(item.status).to_owned(),
        section: section_key(item.section).to_owned(),
        links: serde_json::to_string(&item.links).unwrap_or_else(|_| "{}".to_owned()),
        created_at: item.created_at,
        updated_at: item.updated_at,
        done_at: item.done_at,
    }
}

fn check_line(what: &str, text: &str) -> Result<(), ErrorObject> {
    if text.trim().is_empty() || text.len() > MAX_TEXT_BYTES || text.contains(['\n', '\r']) {
        return Err(ErrorObject::invalid_params(format!(
            "{what} must be one non-empty line of at most {MAX_TEXT_BYTES} bytes"
        )));
    }
    Ok(())
}

fn check_text(text: &str) -> Result<String, ErrorObject> {
    check_line("text", text)?;
    Ok(text.trim().to_owned())
}

fn check_links(links: &BoardLinks) -> Result<(), ErrorObject> {
    if links.threads.len() > MAX_LINKS || links.files.len() > MAX_LINKS {
        return Err(ErrorObject::invalid_params(format!(
            "an item links at most {MAX_LINKS} threads and {MAX_LINKS} files"
        )));
    }
    if let Some(url) = &links.pull_request {
        check_line("pullRequest", url)?;
        if !url.starts_with("https://") || url.contains(char::is_whitespace) {
            return Err(ErrorObject::invalid_params(
                "pullRequest must be an https:// URL",
            ));
        }
    }
    for file in &links.files {
        check_line("a file", file)?;
    }
    Ok(())
}

fn check_section(section: BoardSection) -> Result<BoardSection, ErrorObject> {
    if section == BoardSection::Unknown {
        return Err(ErrorObject::invalid_params(
            "section must be now, next, or risks",
        ));
    }
    Ok(section)
}

fn check_status(status: BoardStatus) -> Result<BoardStatus, ErrorObject> {
    if status == BoardStatus::Unknown {
        return Err(ErrorObject::invalid_params("status must be open or done"));
    }
    Ok(status)
}

fn ensure_project(db: &Store, project: ProjectId) -> Result<(), ErrorObject> {
    let id: Uuid = project.into();
    if db.get_project(id).map_err(|e| store_error(&e))?.is_none() {
        return Err(store_error(&StoreError::NotFound { id }));
    }
    Ok(())
}

fn not_found(id: u64) -> ErrorObject {
    ErrorObject::invalid_params(format!("this Project's board has no item {id}"))
}

/// `project`'s items, oldest first.
fn items(db: &Store, project: ProjectId) -> Result<Vec<BoardItem>, ErrorObject> {
    db.board_items(project.into())
        .map_err(|e| store_error(&e))?
        .into_iter()
        .map(entry)
        .collect()
}

/// `board/list`.
pub(crate) async fn list(
    daemon: &Arc<Daemon>,
    params: BoardListParams,
) -> Result<BoardListResult, ErrorObject> {
    let project = params.project;
    let items = store(daemon, move |db| {
        ensure_project(db, project)?;
        items(db, project)
    })
    .await?;
    Ok(BoardListResult { items })
}

/// `board/add`.
pub(crate) async fn add(
    daemon: &Arc<Daemon>,
    params: BoardAddParams,
) -> Result<BoardItemResult, ErrorObject> {
    let BoardAddParams {
        project,
        text,
        section,
        status,
        links,
    } = params;
    let text = check_text(&text)?;
    let section = check_section(section)?;
    let status = check_status(status.unwrap_or(BoardStatus::Open))?;
    let links = links.unwrap_or_default();
    check_links(&links)?;
    let now = Timestamp::now();
    let item = BoardItem {
        id: 0,
        text,
        status,
        section,
        links,
        created_at: now,
        updated_at: now,
        done_at: (status == BoardStatus::Done).then_some(now),
    };
    let item = store(daemon, move |db| {
        ensure_project(db, project)?;
        let saved = db
            .add_board_item(&row(project.into(), &item))
            .map_err(|e| store_error(&e))?;
        entry(saved)
    })
    .await?;
    publish(daemon, project).await;
    Ok(BoardItemResult { item })
}

/// `board/update`.
pub(crate) async fn update(
    daemon: &Arc<Daemon>,
    params: BoardUpdateParams,
) -> Result<BoardItemResult, ErrorObject> {
    let BoardUpdateParams {
        project,
        id,
        text,
        section,
        status,
        links,
    } = params;
    let text = text.as_deref().map(check_text).transpose()?;
    let section = section.map(check_section).transpose()?;
    let status = status.map(check_status).transpose()?;
    if let Some(links) = &links {
        check_links(links)?;
    }
    let item = store(daemon, move |db| {
        ensure_project(db, project)?;
        let key = i64::try_from(id).map_err(|_| not_found(id))?;
        let before = db
            .board_item(project.into(), key)
            .map_err(|e| store_error(&e))?
            .ok_or_else(|| not_found(id))?;
        let mut item = entry(before)?;
        let was_done = item.status == BoardStatus::Done;
        item.text = text.unwrap_or(item.text);
        item.section = section.unwrap_or(item.section);
        item.status = status.unwrap_or(item.status);
        item.links = links.unwrap_or(item.links);
        let now = Timestamp::now();
        item.updated_at = now;
        item.done_at = match (was_done, item.status == BoardStatus::Done) {
            (_, false) => None,
            (false, true) => Some(now),
            (true, true) => item.done_at,
        };
        db.update_board_item(&row(project.into(), &item))
            .map_err(|e| store_error(&e))?;
        Ok(item)
    })
    .await?;
    publish(daemon, project).await;
    Ok(BoardItemResult { item })
}

/// `board/remove`.
pub(crate) async fn remove(
    daemon: &Arc<Daemon>,
    params: BoardRemoveParams,
) -> Result<BoardRemoveResult, ErrorObject> {
    let BoardRemoveParams { project, id } = params;
    let removed = store(daemon, move |db| {
        ensure_project(db, project)?;
        let Ok(key) = i64::try_from(id) else {
            return Ok(false);
        };
        db.remove_board_item(project.into(), key)
            .map_err(|e| store_error(&e))
    })
    .await?;
    if removed {
        publish(daemon, project).await;
    }
    Ok(BoardRemoveResult { removed })
}

/// One item as a board line: its checkbox, its text, then its id and links.
fn line(item: &BoardItem) -> String {
    let check = if item.status == BoardStatus::Done {
        'x'
    } else {
        ' '
    };
    let mut tags = vec![format!("id {}", item.id)];
    if let Some(url) = &item.links.pull_request {
        tags.push(format!("[pull request]({url})"));
    }
    tags.extend(item.links.threads.iter().map(|run| format!("thread {run}")));
    tags.extend(item.links.files.iter().map(|file| format!("`{file}`")));
    format!("- [{check}] {} ({})", item.text, tags.join(", "))
}

/// `items` under their `##` headings, leaving out a section with none.
fn sections(items: &[&BoardItem]) -> Vec<String> {
    SECTIONS
        .iter()
        .filter_map(|(section, heading)| {
            let lines: Vec<String> = items
                .iter()
                .filter(|item| item.section == *section)
                .map(|item| line(item))
                .collect();
            (!lines.is_empty()).then(|| format!("## {heading}\n\n{}", lines.join("\n")))
        })
        .collect()
}

fn joined(parts: &[String]) -> String {
    if parts.is_empty() {
        String::new()
    } else {
        format!("{}\n", parts.join("\n\n"))
    }
}

/// `notes.md` and `archived.md` for `items` at `now`: done items older than [`ARCHIVE_AFTER`] go
/// to the second, and the first then ends with a link to it.
pub(crate) fn render(items: &[BoardItem], now: Timestamp) -> (String, String) {
    let cutoff = now - ARCHIVE_AFTER;
    let archived = |item: &&BoardItem| {
        item.status == BoardStatus::Done && item.done_at.is_some_and(|done| done <= cutoff)
    };
    let (old, current): (Vec<&BoardItem>, Vec<&BoardItem>) = items.iter().partition(archived);
    let mut notes = sections(&current);
    let old = sections(&old);
    if !old.is_empty() {
        notes.push(format!("Older items: [archived]({ARCHIVED})"));
    }
    (joined(&notes), joined(&old))
}

/// One item [`parse`] found in a hand-written board.
#[derive(Debug, PartialEq, Eq)]
pub(crate) struct Parsed {
    pub text: String,
    pub done: bool,
    pub section: BoardSection,
}

/// The items in a board written in the format `coordinator.md` described before 0081: `- [ ]` and
/// `- [x]` lines under `## Now`, `## Next`, and `## Risks`. A checkbox line under another heading
/// or none goes to Risks, keeping its status. Any other line that isn't blank, a heading, or the
/// `Older items:` link becomes an open Risks item as it is, so nothing is dropped.
pub(crate) fn parse(markdown: &str) -> Vec<Parsed> {
    let mut section = None;
    let mut parsed = Vec::new();
    for line in markdown.lines().map(str::trim) {
        if line.is_empty() || line.starts_with("Older items:") {
            continue;
        }
        let heading = line.trim_start_matches('#');
        if heading.len() < line.len() && (heading.is_empty() || heading.starts_with(' ')) {
            let heading = heading.trim();
            section = SECTIONS
                .iter()
                .find(|(_, name)| name.eq_ignore_ascii_case(heading))
                .map(|(section, _)| *section);
            continue;
        }
        let item = match checkbox(line) {
            Some((done, text)) => Parsed {
                text: text.to_owned(),
                done,
                section: section.unwrap_or(BoardSection::Risks),
            },
            None => Parsed {
                text: line.to_owned(),
                done: false,
                section: BoardSection::Risks,
            },
        };
        parsed.push(item);
    }
    parsed
}

/// A task list line's status and text: `- [ ] text`, `* [x] text`, or `- [X] text`.
fn checkbox(line: &str) -> Option<(bool, &str)> {
    let rest = line
        .strip_prefix("- ")
        .or_else(|| line.strip_prefix("* "))?;
    let done = match rest.get(..3)? {
        "[ ]" => false,
        "[x]" | "[X]" => true,
        _ => return None,
    };
    let text = rest.get(3..)?.trim();
    (!text.is_empty()).then_some((done, text))
}

/// Renders `project`'s board to its context folder, writing each file only when it changed,
/// unless its board migration is still to do. A failure is logged: the items are saved, and the
/// next render writes the files.
pub(crate) async fn publish(daemon: &Arc<Daemon>, project: ProjectId) {
    let _render = RENDER.lock().await;
    let listed = store(daemon, move |db| {
        if db
            .board_migration_pending(project.into())
            .map_err(|e| store_error(&e))?
        {
            return Ok(None);
        }
        items(db, project).map(Some)
    })
    .await;
    let items = match listed {
        Ok(Some(items)) => items,
        Ok(None) => {
            warn!(%project, "not rendering a board whose migration is still to do");
            return;
        }
        Err(error) => {
            warn!(%project, error = error.message, "could not read the board to render it");
            return;
        }
    };
    let daemon = Arc::clone(daemon);
    let written = tokio::task::spawn_blocking(move || {
        let (notes, archived) = render(&items, Timestamp::now());
        write_if_changed(&daemon, project, NOTES, &notes)?;
        write_if_changed(&daemon, project, ARCHIVED, &archived)
    })
    .await;
    match written {
        Ok(Ok(())) => {}
        Ok(Err(error)) => warn!(%project, error = error.message, "could not render the board"),
        Err(error) => warn!(%project, %error, "the board's render task failed"),
    }
}

/// Writes `content` to `name` unless it's already there. A missing file counts as empty.
fn write_if_changed(
    daemon: &Daemon,
    project: ProjectId,
    name: &str,
    content: &str,
) -> Result<(), ErrorObject> {
    let dir = crate::context::ensure_dir(&daemon.data_dir, project)
        .map_err(|e| crate::context::io_error(name, &e))?;
    let current = crate::context::read_file(&dir, name).map(|(bytes, _)| bytes);
    let same = match &current {
        Ok(bytes) => bytes == content.as_bytes(),
        Err(error) => error.kind() == std::io::ErrorKind::NotFound && content.is_empty(),
    };
    if same {
        return Ok(());
    }
    write_context_file(
        daemon,
        project,
        name,
        content,
        Some("plxd".to_owned()),
        ContextWriteId::generate(),
    )?;
    Ok(())
}

/// Parses each marked Project's hand-written board into items once, before plxd serves anything.
/// A Project that fails stays marked, and the next start tries it again. See [`migrate_project`].
pub(crate) async fn migrate(daemon: &Arc<Daemon>) {
    let pending = store(daemon, |db| {
        db.board_migrations_pending().map_err(|e| store_error(&e))
    })
    .await;
    let projects = match pending {
        Ok(projects) => projects,
        Err(error) => {
            warn!(error = error.message, "could not start the board migration");
            return;
        }
    };
    for project in projects {
        let Ok(project) = ProjectId::try_from(project) else {
            continue;
        };
        if let Err(error) = migrate_project(daemon, project).await {
            warn!(%project, error = error.message, "could not migrate a Project's board");
        }
    }
}

/// Keeps `project`'s `notes.md` and `archived.md` as [`LEGACY`], adds what [`parse`] finds in the
/// copies as items and clears its mark in one transaction, then renders the board. Until that
/// transaction the board isn't rendered, so a failure at any step leaves the originals for the
/// next run. A Project deleted since it was marked just loses its mark, and one not marked is
/// left alone.
async fn migrate_project(daemon: &Arc<Daemon>, project: ProjectId) -> Result<(), ErrorObject> {
    let due = store(daemon, move |db| {
        if !db
            .board_migration_pending(project.into())
            .map_err(|e| store_error(&e))?
        {
            return Ok(false);
        }
        let exists = db
            .get_project(project.into())
            .map_err(|e| store_error(&e))?
            .is_some();
        if !exists {
            db.finish_board_migration(project.into())
                .map_err(|e| store_error(&e))?;
        }
        Ok(exists)
    })
    .await?;
    if !due {
        return Ok(());
    }
    let copied = {
        let daemon = Arc::clone(daemon);
        tokio::task::spawn_blocking(move || keep_originals(&daemon, project))
            .await
            .map_err(|e| {
                ErrorObject::internal_error(format!("the board migration failed: {e}"))
            })??
    };
    let now = Timestamp::now();
    let added = store(daemon, move |db| {
        let mut added = 0;
        for (content, archived_at) in copied {
            for parsed in parse(&content) {
                let done_at = parsed.done.then_some(archived_at.unwrap_or(now));
                let item = BoardItem {
                    id: 0,
                    text: parsed.text,
                    status: if parsed.done {
                        BoardStatus::Done
                    } else {
                        BoardStatus::Open
                    },
                    section: parsed.section,
                    links: BoardLinks::default(),
                    created_at: now,
                    updated_at: now,
                    done_at,
                };
                db.add_board_item(&row(project.into(), &item))
                    .map_err(|e| store_error(&e))?;
                added += 1;
            }
        }
        db.finish_board_migration(project.into())
            .map_err(|e| store_error(&e))?;
        Ok(added)
    })
    .await?;
    info!(%project, added, "moved a Project's board to items");
    publish(daemon, project).await;
    Ok(())
}

/// The hand-written `notes.md` and `archived.md` of `project` to parse, each with the time to
/// call its done items done: now for `notes.md`, and for `archived.md` at least
/// [`ARCHIVE_AFTER`] ago, so they stay archived. Reads each from its [`LEGACY`] copy when there
/// is one, and otherwise copies the original there first.
fn keep_originals(
    daemon: &Daemon,
    project: ProjectId,
) -> Result<Vec<(String, Option<Timestamp>)>, ErrorObject> {
    let dir = crate::context::ensure_dir(&daemon.data_dir, project)
        .map_err(|e| crate::context::io_error("", &e))?;
    let read = |name: &str| match crate::context::read_file(&dir, name) {
        Ok(read) => Ok(Some(read)),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(crate::context::io_error(name, &error)),
    };
    let mut originals = Vec::new();
    for (name, legacy) in [(NOTES, LEGACY[0]), (ARCHIVED, LEGACY[1])] {
        let (bytes, metadata) = if let Some(kept) = read(legacy)? {
            kept
        } else if let Some((bytes, metadata)) = read(name)? {
            write_context_file(
                daemon,
                project,
                legacy,
                &String::from_utf8_lossy(&bytes),
                Some("plxd".to_owned()),
                ContextWriteId::generate(),
            )?;
            (bytes, metadata)
        } else {
            continue;
        };
        let archived_at = (name == ARCHIVED)
            .then(|| crate::context::modified_at(&metadata).min(Timestamp::now() - ARCHIVE_AFTER));
        originals.push((String::from_utf8_lossy(&bytes).into_owned(), archived_at));
    }
    Ok(originals)
}

/// Renders every Project's board every [`RENDER_PERIOD`] until `stop`, so done items move to
/// `archived.md` as they age.
pub(crate) async fn run(daemon: Arc<Daemon>, stop: CancellationToken) {
    let mut interval = time::interval(RENDER_PERIOD);
    interval.set_missed_tick_behavior(MissedTickBehavior::Delay);
    loop {
        tokio::select! {
            biased;
            () = stop.cancelled() => break,
            _ = interval.tick() => {}
        }
        let projects = store(&daemon, |db| {
            Ok(db
                .list_projects()
                .map_err(|e| store_error(&e))?
                .into_iter()
                .filter_map(|project| ProjectId::try_from(project.id).ok())
                .collect::<Vec<_>>())
        })
        .await
        .unwrap_or_default();
        for project in projects {
            publish(&daemon, project).await;
        }
    }
}

#[cfg(test)]
mod tests {
    use jiff::{SignedDuration, Timestamp};
    use parallax_protocol::{
        BoardItem, BoardLinks, BoardSection, BoardStatus, ProjectCreateParams, ProjectId, RunId,
    };

    use super::{ARCHIVE_AFTER, Parsed, migrate, parse, publish, render};
    use crate::server::Daemon;
    use crate::store::{fields, store_error};
    use crate::threads::store;

    fn item(id: u64, text: &str, section: BoardSection, done_at: Option<Timestamp>) -> BoardItem {
        let at = "2026-10-01T12:00:00Z".parse().unwrap();
        BoardItem {
            id,
            text: text.to_owned(),
            status: if done_at.is_some() {
                BoardStatus::Done
            } else {
                BoardStatus::Open
            },
            section,
            links: BoardLinks::default(),
            created_at: at,
            updated_at: at,
            done_at,
        }
    }

    fn parsed(text: &str, done: bool, section: BoardSection) -> Parsed {
        Parsed {
            text: text.to_owned(),
            done,
            section,
        }
    }

    #[test]
    fn checkbox_lines_become_items_in_their_section_and_other_lines_risks() {
        let board = "# Board\n\n## Now\n\n- [ ] **Search**: adds it\n- [x] **Login**: done\n\n\
                     ## Next\n* [X] Docs\n\n## Later\n- [ ] Someday\n\nA loose note\n  - indented \
                     detail\n\nOlder items: [archived](archived.md)\n";
        assert_eq!(
            parse(board),
            [
                parsed("**Search**: adds it", false, BoardSection::Now),
                parsed("**Login**: done", true, BoardSection::Now),
                parsed("Docs", true, BoardSection::Next),
                parsed("Someday", false, BoardSection::Risks),
                parsed("A loose note", false, BoardSection::Risks),
                parsed("- indented detail", false, BoardSection::Risks),
            ]
        );
    }

    #[test]
    fn render_puts_old_done_items_in_archived_and_links_to_it() {
        let now: Timestamp = "2026-10-23T12:00:00Z".parse().unwrap();
        let mut linked = item(1, "**Search**: adds it", BoardSection::Now, None);
        let run = RunId::generate();
        linked.links = BoardLinks {
            threads: vec![run],
            pull_request: Some("https://github.com/o/r/pull/1".to_owned()),
            files: vec!["plan.md".to_owned()],
        };
        let hour_ago = now - SignedDuration::from_hours(1);
        let recent = item(2, "Recent", BoardSection::Now, Some(hour_ago));
        let old = item(3, "Old", BoardSection::Next, Some(now - ARCHIVE_AFTER));
        let risk = item(4, "Flaky CI", BoardSection::Risks, None);

        let (notes, archived) = render(&[linked, recent, old, risk], now);
        assert_eq!(
            notes,
            format!(
                "## Now\n\n- [ ] **Search**: adds it (id 1, [pull request](https://github.com/o/r/pull/1), thread {run}, `plan.md`)\n\
                 - [x] Recent (id 2)\n\n## Risks\n\n- [ ] Flaky CI (id 4)\n\n\
                 Older items: [archived](archived.md)\n"
            )
        );
        assert_eq!(archived, "## Next\n\n- [x] Old (id 3)\n");
        assert_eq!(render(&[], now), (String::new(), String::new()));
    }

    #[tokio::test]
    async fn a_migration_that_fails_partway_leaves_the_board_for_the_next_start() {
        let dir = tempfile::tempdir().unwrap();
        let daemon = Daemon::for_tests(dir.path(), 10, std::time::Duration::from_secs(90));
        let params = ProjectCreateParams {
            id: ProjectId::generate(),
            name: "n".to_owned(),
            repo_path: "/r".to_owned(),
            icon: None,
            permission: None,
            autonomy: None,
            base_branch: None,
        };
        let project = params.id;
        store(&daemon, move |db| {
            let (id, fields) = fields(params);
            db.create_project(id, &fields)
                .map_err(|error| store_error(&error))?;
            db.mark_board_migration(id)
                .map_err(|error| store_error(&error))
        })
        .await
        .unwrap();
        let context = crate::context::ensure_dir(&daemon.data_dir, project).unwrap();
        let notes = "## Now\n\n- [ ] **Search**: adds it\n- [x] Login\n\nStray line\n";
        let archived = "- [x] Shipped long ago\n";
        std::fs::write(context.join("notes.md"), notes).unwrap();
        std::fs::write(context.join("archived.md"), archived).unwrap();
        // A folder where `archived.legacy.md` goes makes the second copy fail.
        let blocker = context.join("archived.legacy.md");
        std::fs::create_dir(&blocker).unwrap();
        std::fs::write(blocker.join("x"), "x").unwrap();
        let read = |name: &str| std::fs::read_to_string(context.join(name)).unwrap();

        migrate(&daemon).await;
        assert_eq!(read("notes.legacy.md"), notes);
        // The hourly render and a board change leave the unmigrated board alone.
        publish(&daemon, project).await;
        assert_eq!(read("notes.md"), notes);
        assert_eq!(read("archived.md"), archived);
        // Whatever happens to notes.md now, the next start parses the copy.
        std::fs::write(context.join("notes.md"), "").unwrap();

        std::fs::remove_dir_all(&blocker).unwrap();
        migrate(&daemon).await;
        // Once done, a later start leaves it alone.
        migrate(&daemon).await;

        assert_eq!(read("notes.legacy.md"), notes);
        assert_eq!(read("archived.legacy.md"), archived);
        assert_eq!(
            read("notes.md"),
            "## Now\n\n- [ ] **Search**: adds it (id 1)\n- [x] Login (id 2)\n\n\
             ## Risks\n\n- [ ] Stray line (id 3)\n\nOlder items: [archived](archived.md)\n"
        );
        assert_eq!(
            read("archived.md"),
            "## Risks\n\n- [x] Shipped long ago (id 4)\n"
        );
    }
}
