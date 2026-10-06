//! `agent/diff` and `agent/file` (#157): what a reviewer sees of a run, read from git's objects
//! through the worktree's pinned git folder (#166). Both compare the run's latest commit, the one
//! `agent/accept` merges, with its worktree's base, so they never need the run's actor and never
//! touch the worktree's index or files while its agent runs.
//!
//! `agent/files` and `agent/file`'s `working` side (PLX-296) read the run's folder on disk
//! instead: its worktree, or a Current checkout thread's checkout. `agent/fileCreate`,
//! `agent/fileRename`, and `agent/fileDelete` (PLX-590) change entries there, for the Files view.
//! Each checks every folder on the way with `lstat`, so a symlink the agent leaves there can't
//! point them outside the folder.

use std::io::ErrorKind as IoErrorKind;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use parallax_protocol::jsonrpc::ErrorObject;
use parallax_protocol::{
    AgentDiffFile, AgentDiffResult, AgentDiffStats, AgentEntry, AgentEntryKind,
    AgentFileCreateParams, AgentFileDeleteParams, AgentFileParams, AgentFileRenameParams,
    AgentFileResult, AgentFileSide, AgentFileStatus, AgentFilesParams, AgentFilesResult, ErrorKind,
    RunId,
};
use parallax_store::{Run as RunRow, Worktree};
use tokio::io::AsyncReadExt as _;

use super::{convert, run_accepted, run_not_found, store, store_error};
use crate::server::Daemon;
use crate::worktree::{ChangeStatus, MAX_BLOB_BYTES, WorktreeError, validate_repo_path};

/// A run's row and worktree, if it can still be reviewed.
async fn reviewable(daemon: &Arc<Daemon>, id: RunId) -> Result<(RunRow, Worktree), ErrorObject> {
    let (row, worktree) = store(daemon, move |db| {
        let row = db
            .get_run(id.into())
            .map_err(|error| store_error(&error))?
            .ok_or_else(|| run_not_found(id))?;
        let worktree = db
            .get_worktree(id.into())
            .map_err(|error| store_error(&error))?;
        Ok((row, worktree))
    })
    .await?;
    if row.state.status == convert::ACCEPTED {
        return Err(run_accepted(id));
    }
    let Some(worktree) = worktree else {
        if row.fields.policy == convert::NO_WRITE {
            return Err(ErrorObject::invalid_params(format!(
                "run {id} is a project's coordinator, which changes no files to review"
            )));
        }
        return Err(ErrorObject::internal_error(format!(
            "run {id} has no recorded worktree"
        )));
    };
    if worktree.git_dir.is_empty() {
        return Err(ErrorObject::parallax(
            ErrorKind::WorktreeFailed,
            format!("run {id}'s worktree has no recorded git folder, so plxd can't read it safely"),
        ));
    }
    Ok((row, worktree))
}

fn worktree_failed(error: &WorktreeError) -> ErrorObject {
    ErrorObject::parallax(ErrorKind::WorktreeFailed, error.to_string())
}

fn file_status(status: &ChangeStatus) -> AgentFileStatus {
    match status {
        ChangeStatus::Added => AgentFileStatus::Added,
        ChangeStatus::Modified => AgentFileStatus::Modified,
        ChangeStatus::Deleted => AgentFileStatus::Deleted,
        ChangeStatus::Renamed => AgentFileStatus::Renamed,
        ChangeStatus::Copied => AgentFileStatus::Copied,
        ChangeStatus::TypeChanged => AgentFileStatus::TypeChanged,
        ChangeStatus::Unmerged | ChangeStatus::Unknown(_) => AgentFileStatus::Unknown,
    }
}

/// `agent/diff`.
pub(crate) async fn diff(daemon: &Arc<Daemon>, id: RunId) -> Result<AgentDiffResult, ErrorObject> {
    let (row, worktree) = reviewable(daemon, id).await?;
    let head = row
        .state
        .commit_sha
        .clone()
        .unwrap_or_else(|| worktree.base.clone());
    let diff = daemon
        .agents
        .worktrees
        .diff_commits(
            Path::new(&worktree.path),
            Path::new(&worktree.git_dir),
            &worktree.base,
            &head,
        )
        .await
        .map_err(|error| worktree_failed(&error))?;
    let files = diff
        .files
        .into_iter()
        .map(|file| AgentDiffFile {
            status: file_status(&file.status),
            path: file.path,
            old_path: file.old_path,
            insertions: file.insertions,
            deletions: file.deletions,
            binary: file.binary,
            diff: file.diff,
            diff_truncated: file.diff_truncated,
        })
        .collect();
    Ok(AgentDiffResult {
        base: worktree.base,
        head,
        files,
        stats: AgentDiffStats {
            files: diff.stat.files,
            insertions: diff.stat.insertions,
            deletions: diff.stat.deletions,
        },
        truncated: diff.truncated,
    })
}

/// `agent/file`.
pub(crate) async fn file(
    daemon: &Arc<Daemon>,
    params: AgentFileParams,
) -> Result<AgentFileResult, ErrorObject> {
    let AgentFileParams {
        run_id,
        path,
        side,
        size_only,
    } = params;
    let size_only = size_only.unwrap_or(false);
    validate_repo_path(&path).map_err(ErrorObject::invalid_params)?;
    if side == AgentFileSide::Unknown {
        return Err(ErrorObject::invalid_params(
            "side must be base, head, or working",
        ));
    }
    if side == AgentFileSide::Working {
        let (root, _) = run_folder(daemon, run_id).await?;
        return read_working(&root, path, size_only).await;
    }
    let (row, worktree) = reviewable(daemon, run_id).await?;
    let commit = match side {
        AgentFileSide::Head => row
            .state
            .commit_sha
            .clone()
            .unwrap_or_else(|| worktree.base.clone()),
        _ => worktree.base.clone(),
    };
    let blob = daemon
        .agents
        .worktrees
        .read_blob(
            Path::new(&worktree.path),
            Path::new(&worktree.git_dir),
            &commit,
            &path,
            if size_only { 0 } else { MAX_BLOB_BYTES },
        )
        .await
        .map_err(|error| worktree_failed(&error))?;
    Ok(match blob {
        None => AgentFileResult {
            path,
            side,
            commit: Some(commit),
            exists: false,
            size: None,
            content: None,
            too_large: false,
        },
        Some(blob) => AgentFileResult {
            path,
            side,
            commit: Some(commit),
            exists: true,
            size: Some(blob.size),
            too_large: blob.size > MAX_BLOB_BYTES,
            content: blob.content.as_deref().filter(|_| !size_only).map(base64),
        },
    })
}

/// The most entries one `agent/files` answer lists: names are at most 255 bytes, so this stays
/// well inside 0007's 8 MiB frame.
const MAX_ENTRIES: usize = 5000;

/// The folder a run's files are read from, and the pinned git folder to read it with: its
/// worktree, or for a Current checkout thread, its repo entry's checkout, which is the user's own
/// and has no pinned git folder. The folder itself must be a real folder, never a symlink; the
/// folders above it are the host's own, such as macOS's symlinked `/var`.
pub(crate) async fn run_folder(
    daemon: &Arc<Daemon>,
    id: RunId,
) -> Result<(PathBuf, Option<PathBuf>), ErrorObject> {
    let (root, git_dir) = store(daemon, move |db| {
        let row = db
            .get_run(id.into())
            .map_err(|error| store_error(&error))?
            .ok_or_else(|| run_not_found(id))?;
        if row.state.status == convert::ACCEPTED {
            return Err(run_accepted(id));
        }
        if let Some(worktree) = db
            .get_worktree(id.into())
            .map_err(|error| store_error(&error))?
        {
            if worktree.git_dir.is_empty() {
                return Err(ErrorObject::parallax(
                    ErrorKind::WorktreeFailed,
                    format!("run {id}'s worktree has no recorded git folder, so plxd can't read it safely"),
                ));
            }
            return Ok((worktree.path.into(), Some(worktree.git_dir.into())));
        }
        if row.fields.checkout
            && let Some(repo) = db
                .get_repo(row.fields.project_id)
                .map_err(|error| store_error(&error))?
        {
            return Ok((repo.fields.path.into(), None));
        }
        Err(ErrorObject::invalid_params(format!(
            "run {id} has no folder of files to browse"
        )))
    })
    .await?;
    let why = match tokio::fs::symlink_metadata(&root).await {
        Ok(meta) if meta.is_dir() => return Ok((root, git_dir)),
        Ok(_) => "isn't a folder",
        Err(error) if error.kind() == IoErrorKind::NotFound => "is gone",
        Err(error) => return Err(io_failed(&root, &error)),
    };
    Err(ErrorObject::parallax(
        ErrorKind::WorktreeFailed,
        format!("run {id}'s folder {} {why}", root.display()),
    ))
}

/// `path`, already checked by [`validate_repo_path`], under `root`, with every folder on the way
/// checked with `lstat` to be a real folder, so no symlink is followed, and whether one of them
/// holds a `.git`, as a submodule or a nested repository does. `None` when one is missing or isn't
/// a folder. The last component is left unchecked. On Windows, each component must also be one
/// plain name there ([`plain_on_windows`]).
async fn under(root: &Path, path: &str) -> Result<Option<(PathBuf, bool)>, ErrorObject> {
    let mut at = root.to_path_buf();
    let mut nested = false;
    let mut components = path.split('/').peekable();
    while let Some(component) = components.next() {
        if cfg!(windows) && !plain_on_windows(component) {
            return Err(ErrorObject::invalid_params(format!(
                "path {path:?} has a name Windows reads as something else"
            )));
        }
        at.push(component);
        if components.peek().is_none() {
            break;
        }
        match tokio::fs::symlink_metadata(&at).await {
            Ok(meta) if meta.is_dir() => {
                nested = nested || tokio::fs::symlink_metadata(at.join(".git")).await.is_ok();
            }
            Ok(meta) if meta.is_symlink() => {
                return Err(ErrorObject::invalid_params(format!(
                    "path {path:?} goes through a symlink"
                )));
            }
            Ok(_) => return Ok(None),
            Err(error) if error.kind() == IoErrorKind::NotFound => return Ok(None),
            Err(error) => return Err(io_failed(&at, &error)),
        }
    }
    Ok(Some((at, nested)))
}

/// Whether Windows reads `component` as the name it spells. A drive prefix such as `D:` or `C:x`
/// would replace the whole path when pushed, `:` also names an alternate data stream, and Windows
/// drops trailing dots and spaces, so `.git.` would reach `.git`.
fn plain_on_windows(component: &str) -> bool {
    !component.contains(':') && !component.ends_with(['.', ' '])
}

fn io_failed(path: &Path, error: &std::io::Error) -> ErrorObject {
    ErrorObject::internal_error(format!("could not read {}: {error}", path.display()))
}

/// `agent/file`'s `working` side: the file at `path` under `root` as it is now. A symlink's
/// content is its target, as git stores it, and is never followed.
async fn read_working(
    root: &Path,
    path: String,
    size_only: bool,
) -> Result<AgentFileResult, ErrorObject> {
    let missing = |path| AgentFileResult {
        path,
        side: AgentFileSide::Working,
        commit: None,
        exists: false,
        size: None,
        content: None,
        too_large: false,
    };
    let Some((at, _)) = under(root, &path).await? else {
        return Ok(missing(path));
    };
    let meta = match tokio::fs::symlink_metadata(&at).await {
        Ok(meta) => meta,
        Err(error) if error.kind() == IoErrorKind::NotFound => return Ok(missing(path)),
        Err(error) => return Err(io_failed(&at, &error)),
    };
    let not_a_file = || ErrorObject::invalid_params(format!("path {path:?} is not a file"));
    let (size, file) = if meta.is_symlink() {
        let target = tokio::fs::read_link(&at)
            .await
            .map_err(|error| io_failed(&at, &error))?;
        let target = target.to_string_lossy().into_owned().into_bytes();
        (target.len() as u64, Err(target))
    } else if meta.is_file() {
        // Checked again on the open handle: the agent can swap in a symlink or a FIFO meanwhile,
        // which this open refuses rather than follows, or doesn't block on.
        let mut options = tokio::fs::OpenOptions::new();
        options.read(true);
        #[cfg(unix)]
        options.custom_flags(
            (rustix::fs::OFlags::NOFOLLOW | rustix::fs::OFlags::NONBLOCK)
                .bits()
                .cast_signed(),
        );
        let file = options
            .open(&at)
            .await
            .map_err(|error| io_failed(&at, &error))?;
        let meta = file
            .metadata()
            .await
            .map_err(|error| io_failed(&at, &error))?;
        if !meta.is_file() {
            return Err(not_a_file());
        }
        (meta.len(), Ok(file))
    } else {
        return Err(not_a_file());
    };
    let too_large = size > MAX_BLOB_BYTES;
    let content = match file {
        _ if size_only || too_large => None,
        Err(target) => Some(target),
        Ok(file) => {
            let mut bytes = Vec::new();
            // The agent can grow the file meanwhile; never read past the cap.
            file.take(MAX_BLOB_BYTES + 1)
                .read_to_end(&mut bytes)
                .await
                .map_err(|error| io_failed(&at, &error))?;
            (bytes.len() as u64 <= MAX_BLOB_BYTES).then_some(bytes)
        }
    };
    Ok(AgentFileResult {
        path,
        side: AgentFileSide::Working,
        commit: None,
        exists: true,
        size: Some(size),
        too_large: too_large || (!size_only && content.is_none()),
        content: content.as_deref().map(base64),
    })
}

/// `agent/files`.
pub(crate) async fn files(
    daemon: &Arc<Daemon>,
    params: AgentFilesParams,
) -> Result<AgentFilesResult, ErrorObject> {
    let AgentFilesParams { run_id, path } = params;
    if let Some(path) = &path {
        validate_repo_path(path).map_err(ErrorObject::invalid_params)?;
    }
    let (root, git_dir) = run_folder(daemon, run_id).await?;
    let shown = path.as_deref().unwrap_or("");
    let not_a_folder = || ErrorObject::invalid_params(format!("path {shown:?} is not a folder"));
    let (dir, mut nested) = match &path {
        Some(path) => under(&root, path).await?.ok_or_else(not_a_folder)?,
        None => (root.clone(), false),
    };
    match tokio::fs::symlink_metadata(&dir).await {
        Ok(meta) if meta.is_dir() => {}
        Ok(meta) if meta.is_symlink() => {
            return Err(ErrorObject::invalid_params(format!(
                "path {shown:?} is a symlink"
            )));
        }
        Ok(_) => return Err(not_a_folder()),
        Err(error) if error.kind() == IoErrorKind::NotFound => return Err(not_a_folder()),
        Err(error) => return Err(io_failed(&dir, &error)),
    }

    let mut entries = Vec::new();
    let mut read_dir = tokio::fs::read_dir(&dir)
        .await
        .map_err(|error| io_failed(&dir, &error))?;
    while let Some(entry) = read_dir
        .next_entry()
        .await
        .map_err(|error| io_failed(&dir, &error))?
    {
        // ponytail: a name that isn't UTF-8 can't travel in the protocol's strings, so it's
        // left out; send it as bytes if a real repository needs one.
        let Ok(name) = entry.file_name().into_string() else {
            continue;
        };
        if name.eq_ignore_ascii_case(".git") {
            // Below the run's folder, a `.git` means a submodule or a nested repository.
            nested = nested || path.is_some();
            continue;
        }
        // `DirEntry::metadata` is `lstat`'s: a symlink stays a symlink.
        let Ok(meta) = entry.metadata().await else {
            continue;
        };
        let (kind, size) = if meta.is_symlink() {
            (AgentEntryKind::Symlink, None)
        } else if meta.is_dir() {
            (AgentEntryKind::Dir, None)
        } else if meta.is_file() {
            (AgentEntryKind::File, Some(meta.len()))
        } else {
            continue;
        };
        entries.push(AgentEntry { name, kind, size });
    }
    entries.sort_by(|a, b| a.name.cmp(&b.name));

    let relative = |name: &str| match &path {
        Some(path) => format!("{path}/{name}"),
        None => name.to_owned(),
    };
    // Inside a submodule, the run's repository can't say what's ignored (`check-ignore` fails
    // there), so its folders list everything.
    if !nested {
        let paths: Vec<String> = entries.iter().map(|entry| relative(&entry.name)).collect();
        let ignored = daemon
            .agents
            .worktrees
            .ignored(&root, git_dir.as_deref(), &paths)
            .await
            .map_err(|error| worktree_failed(&error))?;
        entries.retain(|entry| !ignored.contains(&relative(&entry.name)));
    }
    let truncated = entries.len() > MAX_ENTRIES;
    entries.truncate(MAX_ENTRIES);
    Ok(AgentFilesResult { entries, truncated })
}

/// `path` under `root`, for a change: checked by [`validate_repo_path`] and reached through real
/// folders only. The entry itself may be missing; its folder may not.
async fn editable(root: &Path, path: &str) -> Result<PathBuf, ErrorObject> {
    validate_repo_path(path).map_err(ErrorObject::invalid_params)?;
    Ok(under(root, path)
        .await?
        .ok_or_else(|| ErrorObject::invalid_params(format!("path {path:?}'s folder is missing")))?
        .0)
}

/// What a failed change of `path` tells the user.
fn edit_failed(path: &str, error: &std::io::Error) -> ErrorObject {
    match error.kind() {
        IoErrorKind::AlreadyExists => {
            ErrorObject::invalid_params(format!("{path:?} already exists"))
        }
        IoErrorKind::NotFound => ErrorObject::invalid_params(format!("{path:?} isn't there")),
        _ => ErrorObject::internal_error(format!("could not change {path:?}: {error}")),
    }
}

/// `agent/fileCreate`: an empty file or folder, never over an existing entry.
pub(crate) async fn create_entry(
    daemon: &Arc<Daemon>,
    params: AgentFileCreateParams,
) -> Result<(), ErrorObject> {
    let AgentFileCreateParams {
        run_id,
        path,
        folder,
    } = params;
    let (root, _) = run_folder(daemon, run_id).await?;
    let at = editable(&root, &path).await?;
    let created = if folder {
        tokio::fs::create_dir(&at).await
    } else {
        // `create_new` fails on any existing entry, a symlink included, rather than following it.
        tokio::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&at)
            .await
            .map(drop)
    };
    created.map_err(|error| edit_failed(&path, &error))
}

/// `agent/fileRename`: moves an entry, a symlink itself rather than its target, never over
/// another entry or into itself.
pub(crate) async fn rename_entry(
    daemon: &Arc<Daemon>,
    params: AgentFileRenameParams,
) -> Result<(), ErrorObject> {
    let AgentFileRenameParams { run_id, from, to } = params;
    if to == from || to.starts_with(&format!("{from}/")) {
        return Err(ErrorObject::invalid_params(format!(
            "{from:?} can't move into itself"
        )));
    }
    let (root, _) = run_folder(daemon, run_id).await?;
    let source = editable(&root, &from).await?;
    let target = editable(&root, &to).await?;
    let source_meta = tokio::fs::symlink_metadata(&source)
        .await
        .map_err(|error| edit_failed(&from, &error))?;
    // ponytail: checked, then renamed, so an entry the agent makes at `to` in between is
    // replaced; PLX-594 moves this and `under`'s checks to opened folders.
    match tokio::fs::symlink_metadata(&target).await {
        Ok(meta) if !same_entry(&source_meta, &meta, &from, &to) => {
            return Err(ErrorObject::invalid_params(format!(
                "{to:?} already exists"
            )));
        }
        Ok(_) => {}
        Err(error) if error.kind() == IoErrorKind::NotFound => {}
        Err(error) => return Err(edit_failed(&to, &error)),
    }
    tokio::fs::rename(&source, &target)
        .await
        .map_err(|error| edit_failed(&from, &error))
}

/// Whether `to` names the entry `from` does, as a change of case does on a case-insensitive file
/// system, so a rename that only changes case isn't refused.
#[cfg(unix)]
fn same_entry(a: &std::fs::Metadata, b: &std::fs::Metadata, _: &str, _: &str) -> bool {
    use std::os::unix::fs::MetadataExt as _;
    (a.dev(), a.ino()) == (b.dev(), b.ino())
}

#[cfg(not(unix))]
fn same_entry(_: &std::fs::Metadata, _: &std::fs::Metadata, from: &str, to: &str) -> bool {
    from.eq_ignore_ascii_case(to)
}

/// `agent/fileDelete`: removes a file, a symlink itself, or a folder with everything in it.
pub(crate) async fn delete_entry(
    daemon: &Arc<Daemon>,
    params: AgentFileDeleteParams,
) -> Result<(), ErrorObject> {
    let AgentFileDeleteParams { run_id, path } = params;
    let (root, _) = run_folder(daemon, run_id).await?;
    let at = editable(&root, &path).await?;
    let meta = tokio::fs::symlink_metadata(&at)
        .await
        .map_err(|error| edit_failed(&path, &error))?;
    // `remove_dir_all` removes symlinks inside the folder without following them.
    let removed = if meta.is_dir() {
        tokio::fs::remove_dir_all(&at).await
    } else {
        tokio::fs::remove_file(&at).await
    };
    removed.map_err(|error| edit_failed(&path, &error))
}

/// Standard base64, with padding.
fn base64(bytes: &[u8]) -> String {
    const ALPHABET: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let b = [
            chunk[0],
            chunk.get(1).copied().unwrap_or(0),
            chunk.get(2).copied().unwrap_or(0),
        ];
        let n = (u32::from(b[0]) << 16) | (u32::from(b[1]) << 8) | u32::from(b[2]);
        for (index, shift) in [18, 12, 6, 0].into_iter().enumerate() {
            if index <= chunk.len() {
                out.push(char::from(ALPHABET[((n >> shift) & 63) as usize]));
            } else {
                out.push('=');
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::{base64, plain_on_windows};

    #[test]
    fn windows_refuses_drives_streams_and_trailing_dots_or_spaces() {
        for name in [
            "D:",
            "C:x",
            "a:b",
            "file.txt:stream",
            ".git.",
            ".git ",
            "x.",
            "x ",
        ] {
            assert!(!plain_on_windows(name), "{name:?}");
        }
        for name in [".gitignore", "src", "a.b", ".env", "notes.md"] {
            assert!(plain_on_windows(name), "{name:?}");
        }
    }

    #[test]
    fn base64_matches_rfc_4648_vectors() {
        for (input, output) in [
            ("", ""),
            ("f", "Zg=="),
            ("fo", "Zm8="),
            ("foo", "Zm9v"),
            ("foob", "Zm9vYg=="),
            ("fooba", "Zm9vYmE="),
            ("foobar", "Zm9vYmFy"),
        ] {
            assert_eq!(base64(input.as_bytes()), output, "{input}");
        }
        assert_eq!(base64(&[0xff, 0xfe, 0x00]), "//4A");
    }
}
