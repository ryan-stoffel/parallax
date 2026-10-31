//! Stale memory entries (0044, PLX-407). [`check`] reads the paths each entry of an orchestrator's
//! folder and its repository's names in backticks, and marks an entry naming one its branch
//! doesn't have for review: a `Stale:` line first in its header, naming the missing paths, which
//! `memory/list` reports as `stale`. Rewriting the entry drops the line, and so does the
//! next check once every path it names is back.

use std::collections::HashSet;
use std::fmt::Write as _;
use std::path::Path;

use parallax_protocol::ScopeId;
use tokio_util::sync::CancellationToken;
use tracing::warn;

use super::memory;
use crate::server::Daemon;
use crate::store::store_error;

/// Checks the entries of `project`'s folder against its integration branch, and its repository's
/// folder against its base branch, which every orchestrator of that repository shares, marking and
/// unmarking them. Called after each landing (PLX-410). Does nothing before plxd cuts the
/// integration branch, which records both; a failure is logged.
pub(crate) async fn check(daemon: &Daemon, project: ScopeId) {
    let found = daemon
        .store
        .run(&CancellationToken::new(), move |db| {
            let row = db
                .get_orchestrator(project.into())
                .map_err(|e| store_error(&e))?;
            let repos = db.list_repos().map_err(|e| store_error(&e))?;
            Ok(row.map(|row| (row, repos)))
        })
        .await;
    let (row, repos) = match found {
        Ok(Some(found)) => found,
        Ok(None) => return,
        Err(error) => {
            warn!(%project, error = %error.message, "could not check memory for stale entries");
            return;
        }
    };
    let (Some(integration), Some(base)) = (row.integration_branch, row.base_branch) else {
        return;
    };
    let data_dir = &daemon.data_dir;
    let mut folders = vec![(data_dir.context_dir(project), integration)];
    if let Some(dir) = memory::repo_dir(data_dir, &row.repo_path, &repos) {
        folders.push((dir, base));
    }
    for (dir, branch) in folders {
        let files = daemon
            .agents
            .worktrees()
            .branch_files(Path::new(&row.repo_path), &branch)
            .await;
        let files: HashSet<String> = match files {
            Ok(files) => files.into_iter().collect(),
            Err(error) => {
                warn!(%project, branch, %error, "could not list a branch's files");
                continue;
            }
        };
        let checked = tokio::task::spawn_blocking(move || mark_folder(&dir, &files)).await;
        if let Err(error) = checked {
            warn!(%project, %error, "could not check memory for stale entries");
        }
    }
}

/// Marks each entry in scope folder `dir` that names a path missing from `files`, and unmarks
/// each that no longer does. Only an entry whose mark changes is rewritten.
pub(crate) fn mark_folder(dir: &Path, files: &HashSet<String>) {
    let Ok(listed) = super::list_files(dir) else {
        return;
    };
    for (path, _) in listed {
        if memory::entry_kind(&path).is_none() {
            continue;
        }
        let Some(text) = super::read_text(dir, &path) else {
            continue;
        };
        let missing: Vec<&str> = paths(&text).filter(|named| !exists(named, files)).collect();
        let want = (!missing.is_empty()).then(|| missing.join(", "));
        if memory::parse(&text).0.stale == want {
            continue;
        }
        let marked = mark(&text, want.as_deref());
        if let Err(error) = super::write_file(dir, &path, marked.as_bytes()) {
            warn!(path, %error, "could not mark a memory entry stale");
        }
    }
}

/// The repository paths `text` names in backticks, in order. A span counts as a path when it is
/// relative, has a `/`, and either ends in `/` or its last part has a `.`, such as
/// `src/main.rs` or `docs/`; a `:<line>` after it is dropped.
// ponytail: a name with no `/`, such as `Cargo.toml`, isn't checked, since `process.env` looks
// the same; check one only if it is a file at the root of some branch, if that matters.
fn paths(text: &str) -> impl Iterator<Item = &str> {
    text.split('`').skip(1).step_by(2).filter_map(|span| {
        let span = span.strip_prefix("./").unwrap_or(span);
        let span = match span.rsplit_once(':') {
            Some((path, line)) if !line.is_empty() && line.bytes().all(|b| b.is_ascii_digit()) => {
                path
            }
            _ => span,
        };
        let plain = span
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || "._-/@+".contains(c));
        let last = span.trim_end_matches('/').rsplit('/').next().unwrap_or("");
        let looks = span.contains('/')
            && !span.starts_with('/')
            && !span.split('/').any(|part| part == "..")
            && !last.is_empty()
            && (span.ends_with('/') || last.contains('.'));
        (plain && looks).then_some(span)
    })
}

/// Whether `path`, a file or a folder, is on the branch whose files are `files`.
// ponytail: a folder scans every file; index folders too if a branch's file count makes it slow.
fn exists(path: &str, files: &HashSet<String>) -> bool {
    let path = path.trim_end_matches('/');
    files.contains(path)
        || files.iter().any(|file| {
            file.strip_prefix(path)
                .is_some_and(|rest| rest.starts_with('/'))
        })
}

/// `text` with its header's `Stale:` line set to `missing`, first, or dropped for `None`. The rest
/// of the header and the body are kept as they are.
fn mark(text: &str, missing: Option<&str>) -> String {
    let (_, body) = memory::parse(text);
    let mut marked = String::new();
    if let Some(missing) = missing {
        let _ = writeln!(marked, "Stale: {missing}");
    }
    marked.push_str(&memory::header_lines(text, body, "Stale:"));
    if !marked.is_empty() {
        marked.push('\n');
    }
    marked.push_str(body);
    marked
}
