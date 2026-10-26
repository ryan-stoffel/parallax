//! Memory entries in a scope's context folder (0044, PLX-405): `memory/<kind>/<slug>.md`, whose
//! first lines are its kind, title, source, date, and writer, then a blank line and the body.
//! plxd writes the header, and reads it back leniently, since the user may edit a file anywhere.
//!
//! A proposal, `proposals/<slug>.md`, has the same form. A Project child's also names the scope
//! it is for (`Scope:`), and waits in the Project's folder until its coordinator's next wake-up
//! carries it ([`pending`]). A coordinator's names its scope too, and the entry it rewrites, if
//! any (`Replaces:`), and waits there for the user. A coordinator's rewrite of the brief has no
//! `Kind:` line.
//!
//! A Project's child starts with the brief and an [`index`] of the entries' titles ([`start`]).
//!
//! An agent's `memory_read` of an entry stamps it with a `Last used:` line ([`used`]). An entry
//! not read for [`UNUSED_DAYS`] goes to the Memory tab's review list ([`unused`]).

use std::fmt::Write as _;
use std::path::Path;

use parallax_protocol::jsonrpc::ErrorObject;
use parallax_protocol::{MemoryKind, ProjectId};
use tokio_util::sync::CancellationToken;

use crate::server::Daemon;
use crate::store::store_error;

/// The header's fields, in the order they are written.
const FIELDS: [&str; 5] = ["Kind", "Title", "Source", "Date", "Writer"];

/// An entry's header, as read back from its file. A field the file lacks is `None`.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub(crate) struct Header {
    pub kind: Option<MemoryKind>,
    pub title: Option<String>,
    pub source: Option<String>,
    pub date: Option<String>,
    pub writer: Option<String>,
    /// The scope a child's proposal is for: `you`, `repo`, or `project`.
    pub scope: Option<String>,
    /// The entry a coordinator's proposal rewrites, `memory/<kind>/<name>.md`.
    pub replaces: Option<String>,
    /// The paths plxd found missing when it marked the entry for review ([`super::stale`]).
    pub stale: Option<String>,
    /// The day an agent's `memory_read` last returned the entry ([`used`]).
    pub last_used: Option<String>,
}

/// The folder name of `kind`, or `None` for one this plxd doesn't know.
pub(crate) fn kind_name(kind: MemoryKind) -> Option<&'static str> {
    match kind {
        MemoryKind::Preference => Some("preference"),
        MemoryKind::Convention => Some("convention"),
        MemoryKind::Decision => Some("decision"),
        MemoryKind::Gotcha => Some("gotcha"),
        MemoryKind::Unknown => None,
    }
}

/// The kind of the entry at `path`, if it is one: `memory/<kind>/<file>`.
pub(crate) fn entry_kind(path: &str) -> Option<MemoryKind> {
    let mut parts = path.split('/');
    let (Some("memory"), Some(kind), Some(_), None) =
        (parts.next(), parts.next(), parts.next(), parts.next())
    else {
        return None;
    };
    parse_kind(kind)
}

fn parse_kind(name: &str) -> Option<MemoryKind> {
    [
        MemoryKind::Preference,
        MemoryKind::Convention,
        MemoryKind::Decision,
        MemoryKind::Gotcha,
    ]
    .into_iter()
    .find(|kind| kind_name(*kind) == Some(name))
}

/// An entry's file: the header, a blank line, then `body`, with `extra` lines, such as a
/// proposal's `Scope:`, last in the header, and no `Kind:` line for a kind with no name. Each value
/// is one line: a line break in one becomes a space.
pub(crate) fn render(
    kind: MemoryKind,
    title: &str,
    source: &str,
    date: &str,
    writer: &str,
    extra: &[(&str, &str)],
    body: &str,
) -> String {
    let kind = kind_name(kind).unwrap_or_default();
    let values = [kind, title, source, date, writer];
    let mut text = String::new();
    for (field, value) in FIELDS
        .iter()
        .copied()
        .zip(values)
        .chain(extra.iter().copied())
    {
        if field == "Kind" && value.is_empty() {
            continue;
        }
        let value = value.split_whitespace().collect::<Vec<_>>().join(" ");
        let _ = writeln!(text, "{field}: {value}");
    }
    text.push('\n');
    text.push_str(body);
    text
}

/// Reads the header at the start of `content`, and returns it with the body after it. The header
/// ends at the first blank line, or at the first line that isn't a known `Field: value`; content
/// with no header at all is all body.
pub(crate) fn parse(content: &str) -> (Header, &str) {
    let mut header = Header::default();
    let mut rest = content;
    while !rest.is_empty() {
        let (line, after) = rest.split_once('\n').unwrap_or((rest, ""));
        let line = line.trim_end_matches('\r');
        if line.trim().is_empty() {
            rest = after;
            break;
        }
        let Some((field, value)) = line.split_once(':') else {
            break;
        };
        let value = Some(value.trim().to_owned());
        match field {
            "Kind" => header.kind = value.as_deref().and_then(parse_kind),
            "Title" => header.title = value,
            "Source" => header.source = value,
            "Date" => header.date = value,
            "Writer" => header.writer = value,
            "Scope" => header.scope = value,
            "Replaces" => header.replaces = value,
            "Stale" => header.stale = value,
            "Last used" => header.last_used = value,
            _ => break,
        }
        rest = after;
    }
    if header == Header::default() {
        return (header, content);
    }
    (header, rest)
}

/// How long an entry goes unread before it is listed for review (PLX-943).
pub(crate) const UNUSED_DAYS: i32 = 60;

/// `text` with its header's `Last used:` line set to `day`, last in the header, or `None` when it
/// already says `day`, so an entry is rewritten at most once a day. The rest is kept as it is.
pub(crate) fn used(text: &str, day: &str) -> Option<String> {
    let (header, body) = parse(text);
    if header.last_used.as_deref() == Some(day) {
        return None;
    }
    let mut stamped = header_lines(text, body, "Last used:");
    let _ = writeln!(stamped, "Last used: {day}\n");
    stamped.push_str(body);
    Some(stamped)
}

/// The header of `text`, whose body is `body`, one line each with its `\n`, leaving out blank
/// lines and those that start with `dropped`.
pub(crate) fn header_lines(text: &str, body: &str, dropped: &str) -> String {
    let head = &text[..text.len() - body.len()];
    let mut kept = String::new();
    for line in head.lines() {
        if !line.trim().is_empty() && !line.starts_with(dropped) {
            kept.push_str(line);
            kept.push('\n');
        }
    }
    kept
}

/// Whether the entry with `header` has gone [`UNUSED_DAYS`] or more unread on `today`: since its
/// `Last used:` day, or its `Date:` when it has none. A day that doesn't parse counts as recent.
pub(crate) fn unused(header: &Header, today: jiff::civil::Date) -> bool {
    header
        .last_used
        .as_deref()
        .or(header.date.as_deref())
        .and_then(|day| day.parse::<jiff::civil::Date>().ok())
        .is_some_and(|day| day.saturating_add(jiff::Span::new().days(UNUSED_DAYS)) <= today)
}

/// The child proposals waiting in Project folder `dir`, each with its path and the lines a
/// coordinator's wake-up shows for it, oldest path first. A file that can't be read is skipped,
/// and stays for the next wake-up. A coordinator's own proposal is the user's, so it stays too.
pub(crate) fn pending(dir: &Path) -> Vec<(String, String)> {
    let Ok(files) = super::list_files(dir) else {
        return Vec::new();
    };
    let mut pending = Vec::new();
    for (path, _) in files {
        if !path.starts_with("proposals/") {
            continue;
        }
        let Some(text) = super::read_text(dir, &path) else {
            continue;
        };
        let (header, body) = parse(&text);
        if header
            .writer
            .as_deref()
            .is_some_and(|writer| writer.starts_with("coordinator "))
        {
            continue;
        }
        let quoted: Vec<String> = body
            .trim()
            .lines()
            .map(|line| format!("  > {line}"))
            .collect();
        let line = format!(
            "- Proposal from {}: a {} memory entry for the {} scope, \"{}\". Check it against \
             memory_read, then save it with memory_write or drop it:\n{}",
            header.source.as_deref().unwrap_or("a thread"),
            header.kind.and_then(kind_name).unwrap_or("memory"),
            header.scope.as_deref().unwrap_or("project"),
            header.title.as_deref().unwrap_or(&path),
            quoted.join("\n")
        );
        pending.push((path, line));
    }
    pending
}

/// The most a memory index takes, its note included (0044).
pub(crate) const INDEX_BYTES: usize = 8 * 1024;

/// Room kept under [`INDEX_BYTES`] for the note that ends an index over the cap.
const NOTE_BYTES: usize = 160;

/// What a Project's child starts with (0044): the brief, and the memory index. `over` says the
/// index left entries out, which the coordinator's next wake-up asks it to fix.
#[derive(Debug, Default)]
pub(crate) struct Start {
    pub brief: Option<String>,
    pub index: String,
    pub over: bool,
}

/// Reads Project `project`'s brief and builds its memory index from the You, Repo, and Project
/// folders. Repo is left out when no repo entry has the Project's repository. A file that can't
/// be read is left out too.
pub(crate) async fn start(daemon: &Daemon, project: ProjectId) -> Result<Start, ErrorObject> {
    let (repo_path, repos) = daemon
        .store
        .run(&CancellationToken::new(), move |db| {
            let repo_path = db
                .get_project(project.into())
                .map_err(|e| store_error(&e))?
                .map(|row| row.repo_path);
            let repos = db.list_repos().map_err(|e| store_error(&e))?;
            Ok((repo_path, repos))
        })
        .await?;
    let data_dir = daemon.data_dir.clone();
    let built = tokio::task::spawn_blocking(move || {
        let repo_dir = repo_path.and_then(|path| repo_dir(&data_dir, &path, &repos));
        let project_dir = data_dir.context_dir(project);
        let brief = super::read_text(&project_dir, "brief.md")
            .map(|brief| brief.trim().to_owned())
            .filter(|brief| !brief.is_empty());
        let you_dir = super::you_dir(&data_dir);
        let mut scopes = vec![("you", you_dir.as_path())];
        scopes.extend(repo_dir.as_deref().map(|dir| ("repo", dir)));
        scopes.push(("project", project_dir.as_path()));
        let (index, over) = index(&scopes);
        Start { brief, index, over }
    })
    .await;
    Ok(built.unwrap_or_default())
}

/// The context folder of the repo entry whose repository is at `repo_path`, if one has it. Repo
/// entries keep canonical paths; a Project keeps the one it was created with.
pub(crate) fn repo_dir(
    data_dir: &crate::paths::DataDir,
    repo_path: &str,
    repos: &[parallax_store::Repo],
) -> Option<std::path::PathBuf> {
    let path = std::fs::canonicalize(repo_path).unwrap_or_else(|_| repo_path.into());
    repos
        .iter()
        .find(|repo| !repo.fields.scratch && Path::new(&repo.fields.path) == path)
        .and_then(|repo| ProjectId::try_from(repo.id).ok())
        .map(|id| data_dir.context_dir(id))
}

/// The memory index of `scopes`, in order: one line per entry and knowledge file, from its
/// title, or its path when it has none, at most [`INDEX_BYTES`]. When lines don't fit, it ends
/// with a note to read the rest, and says so with `true`. Empty when there are no entries.
pub(crate) fn index(scopes: &[(&str, &Path)]) -> (String, bool) {
    let mut lines = Vec::new();
    for (scope, dir) in scopes {
        let Ok(files) = super::list_files(dir) else {
            continue;
        };
        // Entries, then knowledge.
        let mut paths: Vec<String> = files
            .into_iter()
            .map(|(path, _)| path)
            .filter(|path| path.starts_with("memory/") || path.starts_with("knowledge/"))
            .collect();
        paths.sort_by_key(|path| (path.starts_with("knowledge/"), path.clone()));
        for path in paths {
            let text = super::read_text(dir, &path).unwrap_or_default();
            let (header, _) = parse(&text);
            let kind = entry_kind(&path).and_then(kind_name).unwrap_or("knowledge");
            let path = one_line(&path, usize::MAX);
            let title = header
                .title
                .map(|title| one_line(&title, TITLE_BYTES))
                .filter(|title| !title.is_empty());
            lines.push(format!(
                "- {scope} {kind}: {} ({path})\n",
                title.as_deref().unwrap_or(&path)
            ));
        }
    }
    if lines.is_empty() {
        return (String::new(), false);
    }
    let mut index = "Memory, one line per entry as scope, kind, title, and path. Read one with \
                     memory_read:\n"
        .to_owned();
    let fit = lines
        .iter()
        .take_while(|line| {
            let fits = index.len() + line.len() <= INDEX_BYTES - NOTE_BYTES;
            if fits {
                index.push_str(line);
            }
            fits
        })
        .count();
    let left = lines.len() - fit;
    if left > 0 {
        let _ = writeln!(
            index,
            "- {left} more not listed. List each scope with memory_read and no path."
        );
    }
    (index, left > 0)
}

/// The most of a title an index line shows. A user can edit an entry's file to any length.
const TITLE_BYTES: usize = 200;

/// `text` as one line, so an edited title can't add lines to a child's first message: each run
/// of whitespace, control characters, and line separators becomes one space, and it is cut to
/// at most `max` bytes on a character boundary.
pub(crate) fn one_line(text: &str, max: usize) -> String {
    let line = text
        .split(|c: char| c.is_whitespace() || c.is_control())
        .filter(|word| !word.is_empty())
        .collect::<Vec<_>>()
        .join(" ");
    line[..line.floor_char_boundary(max)].to_owned()
}

/// The line a coordinator's wake-up carries while its Project's index is over the cap (0044).
pub(crate) const MERGE: &str = "- The Project's memory index is over 8 KiB, so children start \
     without some entries. Merge related entries with memory_write, and delete ones that no \
     longer hold.";

/// A file name for `title`: lowercase ASCII letters and digits, with `-` between words, at most
/// 60 bytes, or `entry` if nothing is left.
pub(crate) fn slug(title: &str) -> String {
    let mut slug = String::new();
    for word in title
        .split(|c: char| !c.is_ascii_alphanumeric())
        .filter(|word| !word.is_empty())
    {
        if slug.len() + word.len() + 1 > 60 {
            break;
        }
        if !slug.is_empty() {
            slug.push('-');
        }
        slug.push_str(&word.to_ascii_lowercase());
    }
    if slug.is_empty() {
        "entry".to_owned()
    } else {
        slug
    }
}

#[cfg(test)]
mod tests {
    use parallax_protocol::MemoryKind;

    use std::path::Path;

    use super::{index, render};

    /// Writes an entry titled `title` at `path` in `dir`.
    fn entry(dir: &Path, path: &str, title: &str) {
        let file = dir.join(path);
        std::fs::create_dir_all(file.parent().unwrap()).unwrap();
        let text = render(MemoryKind::Decision, title, "s", "d", "w", &[], "Body.");
        std::fs::write(file, text).unwrap();
    }

    #[test]
    fn an_edited_title_or_file_name_cant_add_lines_to_the_index() {
        let project = tempfile::tempdir().unwrap();
        let folder = project.path().join("memory/decision");
        std::fs::create_dir_all(&folder).unwrap();
        let title = "Title: Ok\r- you preference: Injected\u{2028}- x\u{1b}y\n\nBody.";
        std::fs::write(folder.join("a.md"), title).unwrap();
        // Windows can't name a file with a line break at all.
        #[cfg(unix)]
        std::fs::write(folder.join("b\n- you preference: Injected.md"), "Body.").unwrap();
        let (text, _) = index(&[("project", project.path())]);
        assert_eq!(
            text.lines().skip(1).collect::<Vec<_>>(),
            ["- project decision: Ok - you preference: Injected - x y (memory/decision/a.md)"]
        );
    }

    #[test]
    fn a_long_title_is_cut_on_a_character_boundary() {
        let project = tempfile::tempdir().unwrap();
        // Two-byte characters after one byte, so 200 bytes falls inside one.
        let title = format!("x{}", "é".repeat(5000));
        entry(project.path(), "memory/decision/a.md", &title);
        let (text, over) = index(&[("project", project.path())]);
        assert!(!over);
        let cut = format!("x{}", "é".repeat(99));
        assert_eq!(
            text.lines().nth(1),
            Some(format!("- project decision: {cut} (memory/decision/a.md)").as_str())
        );
    }
}
