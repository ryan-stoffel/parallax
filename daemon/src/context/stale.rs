//! Stale memory entries (0044, PLX-407). [`check`] reads the paths each entry of a Project's
//! folder and its repository's names in backticks, and marks an entry naming one its integration
//! branch doesn't have for review: a `Stale:` line first in its header, naming the missing paths,
//! which `memory/list` reports as `stale`. Rewriting the entry drops the line, and so does the
//! next check once every path it names is back.

use std::collections::HashSet;
use std::fmt::Write as _;
use std::path::Path;

use parallax_protocol::ProjectId;
use tokio_util::sync::CancellationToken;
use tracing::warn;

use super::memory;
use crate::server::Daemon;
use crate::store::store_error;

/// Checks the entries of `project`'s folder and its repository's against the Project's
/// integration branch, marking and unmarking them. Called after each child's end, and after each
/// landing (PLX-410). Does nothing for a Project with no integration branch yet; a failure is
/// logged.
pub(crate) async fn check(daemon: &Daemon, project: ProjectId) {
    let found = daemon
        .store
        .run(&CancellationToken::new(), move |db| {
            let row = db
                .get_project(project.into())
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
    let Some(branch) = row.integration_branch else {
        return;
    };
    let files = daemon
        .agents
        .worktrees()
        .branch_files(Path::new(&row.repo_path), &branch)
        .await;
    let files: HashSet<String> = match files {
        Ok(files) => files.into_iter().collect(),
        Err(error) => {
            warn!(%project, %error, "could not list the integration branch's files");
            return;
        }
    };
    let data_dir = daemon.data_dir.clone();
    let checked = tokio::task::spawn_blocking(move || {
        mark_folder(&data_dir.context_dir(project), &files);
        if let Some(dir) = memory::repo_dir(&data_dir, &row.repo_path, &repos) {
            mark_folder(&dir, &files);
        }
    })
    .await;
    if let Err(error) = checked {
        warn!(%project, %error, "could not check memory for stale entries");
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
        let Some(text) = super::read_file(dir, &path)
            .ok()
            .and_then(|(bytes, _)| String::from_utf8(bytes).ok())
        else {
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
    let head = &text[..text.len() - body.len()];
    let mut marked = String::new();
    if let Some(missing) = missing {
        let _ = writeln!(marked, "Stale: {missing}");
    }
    for line in head.lines() {
        if !line.trim().is_empty() && !line.starts_with("Stale:") {
            marked.push_str(line);
            marked.push('\n');
        }
    }
    if !marked.is_empty() {
        marked.push('\n');
    }
    marked.push_str(body);
    marked
}

#[cfg(test)]
mod tests {
    use std::collections::HashSet;

    use parallax_protocol::MemoryKind;

    use super::{mark, mark_folder, paths};
    use crate::context::memory::{parse, render};

    #[test]
    fn only_relative_paths_with_a_folder_count() {
        let text = "Use `src/main.rs:12` and `./docs/` and `.github/workflows/ci.yml`, not \
                    `origin/main`, `Cargo.toml`, `cargo test`, `/etc/hosts`, `../x/y.rs`, \
                    `https://x.dev/a.md`, or `Vec<u8>`.\n```\nsrc/fenced.rs\n```";
        assert_eq!(
            paths(text).collect::<Vec<_>>(),
            ["src/main.rs", "docs/", ".github/workflows/ci.yml"]
        );
    }

    #[test]
    fn a_mark_comes_and_goes_and_keeps_the_rest_of_the_file() {
        let entry = render(
            MemoryKind::Gotcha,
            "T",
            "s",
            "d",
            "w",
            None,
            "See `a/b.rs`.\n",
        );
        let marked = mark(&entry, Some("a/b.rs"));
        assert_eq!(marked, format!("Stale: a/b.rs\n{entry}"));
        assert_eq!(parse(&marked).0.stale.as_deref(), Some("a/b.rs"));
        assert_eq!(parse(&marked).0.title.as_deref(), Some("T"));
        assert_eq!(mark(&marked, None), entry);

        // A file the user wrote without a header gets one line of its own.
        let plain = "# Notes\nSee `a/b.rs`.\n";
        let marked = mark(plain, Some("a/b.rs"));
        assert_eq!(marked, format!("Stale: a/b.rs\n\n{plain}"));
        assert_eq!(parse(&marked).1, plain);
        assert_eq!(mark(&marked, None), plain);
    }

    #[test]
    fn a_folder_marks_entries_naming_missing_paths_and_unmarks_found_ones() {
        let dir = tempfile::tempdir().unwrap();
        let write = |path: &str, body: &str| {
            let file = dir.path().join(path);
            std::fs::create_dir_all(file.parent().unwrap()).unwrap();
            let text = render(MemoryKind::Convention, "T", "s", "d", "w", None, body);
            std::fs::write(file, text).unwrap();
        };
        write(
            "memory/convention/gone.md",
            "Tests in `src/old.rs` and `src/lib.rs`.",
        );
        write(
            "memory/convention/here.md",
            "Tests in `src/` and `src/lib.rs`.",
        );
        write("knowledge/k.md", "Not an entry: `src/old.rs`.");
        let read = |path: &str| std::fs::read_to_string(dir.path().join(path)).unwrap();
        let here = read("memory/convention/here.md");
        let files: HashSet<String> = ["src/lib.rs".to_owned()].into();

        mark_folder(dir.path(), &files);
        let gone = read("memory/convention/gone.md");
        assert_eq!(parse(&gone).0.stale.as_deref(), Some("src/old.rs"));
        assert_eq!(read("memory/convention/here.md"), here);
        assert!(!read("knowledge/k.md").starts_with("Stale:"));

        let files: HashSet<String> = ["src/lib.rs".to_owned(), "src/old.rs".to_owned()].into();
        mark_folder(dir.path(), &files);
        assert_eq!(parse(&read("memory/convention/gone.md")).0.stale, None);
    }
}
