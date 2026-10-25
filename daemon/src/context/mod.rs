//! Shared context: a folder per scope, outside any git repository, that agents and the editor
//! read and write (decision records 0005 and 0044, #155, PLX-405).
//!
//! Layout: [`crate::paths::DataDir::context_dir`] under the data folder for a Project or a repo
//! entry, and [`you_dir`] for the user's own memory. A path is relative to that folder: one file
//! name, or a file in one of 0044's [`FOLDERS`], `memory/<kind>/`, `knowledge/`, `history/`, and
//! `proposals/` (a plain thread's memory proposals, waiting for the user), or a file of any type
//! under `artifacts/<thread>/` (PLX-941), at its path in the child's folder, which plxd copies
//! there from a child's `present_files`. Every component is a normal name with no `..`, `\`, `:`,
//! or leading `/`, and none is hidden but an artifact's own folders, such as `.screenshots/`.
//! Outside `artifacts/` the file ends in `.md`, `.markdown`, or `.txt`, and nothing else nests, so
//! those folders stay a fixed, shallow set.
//!
//! Two caps hold: Markdown and text total at most [`MAX_PROJECT_BYTES`], and the bulk folders,
//! `history/`, `artifacts/`, and `.versions/`, at most [`MAX_BULK_BYTES`] apart from that, the
//! oldest artifacts pruned to make room ([`make_room`]).
//!
//! Three more defenses hold even when a path passes that check:
//!
//! - Each folder between the scope's folder and the file must be a real folder, never a symlink
//!   ([`parent_dir`]), so a planted link can't send a read or write outside the scope.
//! - Reads open with `O_NOFOLLOW` (the same technique `server::setup` uses for the lock file and
//!   socket), so a symlink swapped in after validation is refused atomically, with no race.
//! - Writes go to a temporary file in the same folder, then `rename` it over the target
//!   ([`tempfile::NamedTempFile::persist`]). `rename` never follows a symlink at the destination,
//!   so even a swapped-in symlink can't be written through; plxd also rejects an existing
//!   symlink outright first, for a clear error in the common, non-racing case.
//!
//! [`ContextIndex`] remembers, in memory, the last writer and content hash plxd has seen for
//! each file. It resets on restart, the same trade-off the M1 event log makes (0007, 0009): the
//! file on disk is 0005's durable source of truth, and this is only bookkeeping for idempotent
//! retries and the `lastWriter` display field.

pub(crate) mod corrections;
pub(crate) mod history;
pub(crate) mod memory;
pub(crate) mod stale;
pub(crate) mod watcher;
pub(crate) mod you_sync;

use std::collections::HashMap;
use std::io::{self, Read};
#[cfg(unix)]
use std::os::unix::fs::OpenOptionsExt as _;
#[cfg(windows)]
use std::os::windows::fs::{MetadataExt as _, OpenOptionsExt as _};
use std::path::{Component, Path, PathBuf};
use std::sync::{Mutex, PoisonError};

use jiff::Timestamp;
use parallax_protocol::jsonrpc::ErrorObject;
use parallax_protocol::{ContextFile, ContextWriteId, ErrorKind, ProjectId};

use crate::paths::DataDir;

/// True if `error` is [`symlink_error`]. `std::io::ErrorKind` has no stable variant for it
/// (`io_error_more` is still unstable), so this compares the raw OS error code instead.
fn is_symlink_error(error: &io::Error) -> bool {
    error.raw_os_error() == symlink_error().raw_os_error()
}

/// The error for a final path component that is a symlink: `ELOOP`, "too many levels of symbolic
/// links", which `O_NOFOLLOW` produces. Windows has no such flag, so there plxd refuses the
/// reparse point itself, with `ERROR_STOPPED_ON_SYMLINK`.
fn symlink_error() -> io::Error {
    #[cfg(unix)]
    let code = rustix::io::Errno::LOOP.raw_os_error();
    #[cfg(windows)]
    let code = windows_sys::Win32::Foundation::ERROR_STOPPED_ON_SYMLINK.cast_signed();
    io::Error::from_raw_os_error(code)
}

/// The largest a single shared context file may be: 1 MiB.
pub(crate) const MAX_FILE_BYTES: u64 = 1024 * 1024;

/// The largest a project's shared context folder may total: 20 MiB, apart from the bulk folders
/// ([`is_bulk`]).
pub(crate) const MAX_PROJECT_BYTES: u64 = 20 * MAX_FILE_BYTES;

/// The largest a project's `history/`, `artifacts/`, and `.versions/` may total: 2 GiB.
pub(crate) const MAX_BULK_BYTES: u64 = 2048 * MAX_FILE_BYTES;

const ALLOWED_EXTENSIONS: [&str; 3] = ["md", "markdown", "txt"];

/// Creates a project's shared context folder if it does not exist yet, private like the data
/// folder itself. Safe to call on every access: `project/create` calls it eagerly and best
/// effort, and every `context/*` call calls it again lazily, so an existing project that predates
/// this feature still gets one.
pub(crate) fn ensure_dir(data_dir: &DataDir, project: ProjectId) -> io::Result<PathBuf> {
    ensure(data_dir.context_dir(project))
}

/// The user's own scope, You (0044): preferences across every Project and thread.
pub(crate) fn you_dir(data_dir: &DataDir) -> PathBuf {
    data_dir.context_root().join("you")
}

/// Creates `dir`, a scope's context folder, if it does not exist yet, private like the data
/// folder itself.
pub(crate) fn ensure(dir: PathBuf) -> io::Result<PathBuf> {
    std::fs::create_dir_all(&dir)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt as _;
        std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o700))?;
    }
    Ok(dir)
}

/// The folders a path may name before its file name (0044).
const FOLDERS: [&[&str]; 7] = [
    &["memory", "preference"],
    &["memory", "convention"],
    &["memory", "decision"],
    &["memory", "gotcha"],
    &["knowledge"],
    &["history"],
    &["proposals"],
];

/// Rejects `path` unless it is one normal, non-hidden file name ending in `.md`, `.markdown`, or
/// `.txt`, alone or under one of [`FOLDERS`], or a file of any type under `artifacts/<thread>/`,
/// separated by `/`. This alone rejects `..`, a leading `/`, and any other folder, since each
/// component must be a [`Component::Normal`] name.
///
/// Returns the same string back, borrowed, so a caller can use it as the file name without
/// re-deriving it from the path.
pub(crate) fn validate_relative_path(path: &str) -> Result<&str, ErrorObject> {
    let invalid = || {
        ErrorObject::invalid_params(
            "path must be a relative file name ending in .md, .markdown, or .txt, alone or under \
             memory/<preference|convention|decision|gotcha>/, knowledge/, history/, or \
             proposals/, or any file under artifacts/<thread>/, with no \"..\", no leading \"/\", \
             and no hidden (dot) name but an artifact's folders",
        )
    };
    // Control characters and line separators would let a file name break a line where plxd
    // shows it, such as a child's memory index.
    let breaks = |c: char| c.is_control() || matches!(c, '\u{2028}' | '\u{2029}');
    if path.is_empty() || path.len() > 255 || path.contains(['\\', ':']) || path.contains(breaks) {
        return Err(invalid());
    }
    let parts: Vec<&str> = path.split('/').collect();
    let Some((name, folders)) = parts.split_last() else {
        return Err(invalid());
    };
    let artifact = matches!(folders, ["artifacts", _, ..]);
    if !folders.is_empty() && !artifact && !FOLDERS.contains(&folders) {
        return Err(invalid());
    }
    // `Component::Normal` only guarantees no separator survives; comparing back to the original
    // keeps out a name that doesn't round-trip losslessly.
    let normal = |part: &str| {
        let mut components = Path::new(part).components();
        matches!(components.next(), Some(Component::Normal(one)) if one.to_str() == Some(part))
            && components.next().is_none()
    };
    // An artifact keeps its folders from the child's folder, which may be hidden, such as
    // `.screenshots/`. Its thread and file name may not be.
    let may_hide = |index: usize| artifact && index >= 2 && index < folders.len();
    let hidden = |(index, part): (usize, &&str)| part.starts_with('.') && !may_hide(index);
    if !parts.iter().all(|part| normal(part)) || parts.iter().enumerate().any(hidden) {
        return Err(invalid());
    }
    let extension = Path::new(name).extension().and_then(|ext| ext.to_str());
    if !artifact && !extension.is_some_and(|ext| ALLOWED_EXTENSIONS.contains(&ext)) {
        return Err(invalid());
    }
    Ok(path)
}

/// The folder that holds `name` in `dir`, checking that each folder between them is a real
/// folder, not a symlink (or on Windows another reparse point), and creating missing ones when
/// `create` is set. `name` must already have passed [`validate_relative_path`].
///
/// # Errors
///
/// [`io::ErrorKind::NotFound`] for a missing folder when `create` isn't set, a [`symlink_error`]
/// for a symlinked one, or another [`io::Error`] from creating one.
// ponytail: checks each folder, then uses the path, so a folder swapped for a symlink in between
// is followed; openat with O_NOFOLLOW per folder if an agent that can write the folder matters.
fn parent_dir(dir: &Path, name: &str, create: bool) -> io::Result<PathBuf> {
    let mut parent = dir.to_owned();
    let Some((folders, _)) = name.rsplit_once('/') else {
        return Ok(parent);
    };
    for folder in folders.split('/') {
        parent.push(folder);
        match std::fs::symlink_metadata(&parent) {
            Ok(metadata) if is_link(&metadata) => return Err(symlink_error()),
            Ok(metadata) if metadata.is_dir() => {}
            Ok(_) => return Err(io::Error::from(io::ErrorKind::NotFound)),
            Err(error) if error.kind() == io::ErrorKind::NotFound && create => {
                if let Err(error) = std::fs::create_dir(&parent)
                    && error.kind() != io::ErrorKind::AlreadyExists
                {
                    return Err(error);
                }
                if is_link(&std::fs::symlink_metadata(&parent)?) {
                    return Err(symlink_error());
                }
            }
            Err(error) => return Err(error),
        }
    }
    Ok(parent)
}

/// Whether `metadata`, from [`std::fs::symlink_metadata`], is a symlink, or on Windows any reparse
/// point, such as a junction.
fn is_link(metadata: &std::fs::Metadata) -> bool {
    #[cfg(windows)]
    if metadata.file_attributes()
        & windows_sys::Win32::Storage::FileSystem::FILE_ATTRIBUTE_REPARSE_POINT
        != 0
    {
        return true;
    }
    metadata.file_type().is_symlink()
}

/// The last component of a validated path: its file name.
fn file_name(name: &str) -> &str {
    name.rsplit_once('/').map_or(name, |(_, file)| file)
}

/// Reads a shared context file's content and metadata.
///
/// Opens with `O_NOFOLLOW`, so a symlink at `name` is refused rather than followed, whether or not
/// it was already there when the caller last checked. Windows opens the reparse point itself
/// (`FILE_FLAG_OPEN_REPARSE_POINT`) and refuses it.
///
/// # Errors
///
/// An [`io::Error`] of kind [`io::ErrorKind::NotFound`] if there is no such file (also raised for
/// a directory, so one can't be read as though it were content), or an `ELOOP` error (see
/// [`is_symlink_error`]) if it or a folder on its way is a symlink.
pub(crate) fn read_file(dir: &Path, name: &str) -> io::Result<(Vec<u8>, std::fs::Metadata)> {
    let (mut file, metadata) = open_file(dir, name)?;
    let mut content = Vec::with_capacity(usize::try_from(metadata.len()).unwrap_or(0));
    file.read_to_end(&mut content)?;
    Ok((content, metadata))
}

/// `name` in `dir` as UTF-8 text, read as [`read_file`] does, or `None` when it can't be.
pub(crate) fn read_text(dir: &Path, name: &str) -> Option<String> {
    let (bytes, _) = read_file(dir, name).ok()?;
    String::from_utf8(bytes).ok()
}

/// Up to `length` bytes of `name` in `dir` from `offset`, empty past the end, and its metadata,
/// for `context/readBytes`. Opens it as [`read_file`] does, with the same errors.
pub(crate) fn read_slice(
    dir: &Path,
    name: &str,
    offset: u64,
    length: u64,
) -> io::Result<(Vec<u8>, std::fs::Metadata)> {
    use std::io::{Seek as _, SeekFrom};
    let (mut file, metadata) = open_file(dir, name)?;
    let mut content = Vec::new();
    // Past the end is empty, however far: a seek to 2^63 or more fails.
    if offset < metadata.len() {
        file.seek(SeekFrom::Start(offset))?;
        file.take(length).read_to_end(&mut content)?;
    }
    Ok((content, metadata))
}

/// Opens `name` in `dir`, refusing a symlink, a folder, or a FIFO or other special file, for
/// [`read_file`], [`read_slice`], and `context/saveArtifact`'s read of a child's file.
pub(crate) fn open_file(dir: &Path, name: &str) -> io::Result<(std::fs::File, std::fs::Metadata)> {
    let path = parent_dir(dir, name, false)?.join(file_name(name));
    let mut options = std::fs::OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    // Non-blocking, so a FIFO planted in a child's folder opens and is refused below rather than
    // hanging the open. It changes nothing for a regular file.
    options.custom_flags(
        (rustix::fs::OFlags::NOFOLLOW | rustix::fs::OFlags::NONBLOCK)
            .bits()
            .cast_signed(),
    );
    #[cfg(windows)]
    options.custom_flags(windows_sys::Win32::Storage::FileSystem::FILE_FLAG_OPEN_REPARSE_POINT);
    let file = match options.open(&path) {
        Ok(file) => file,
        // Windows can't open a folder as a file, and says so as access denied.
        #[cfg(windows)]
        Err(error) if error.kind() == io::ErrorKind::PermissionDenied && path.is_dir() => {
            return Err(io::Error::from(io::ErrorKind::NotFound));
        }
        Err(error) => return Err(error),
    };
    let metadata = file.metadata()?;
    #[cfg(windows)]
    if metadata.file_attributes()
        & windows_sys::Win32::Storage::FileSystem::FILE_ATTRIBUTE_REPARSE_POINT
        != 0
    {
        return Err(symlink_error());
    }
    if !metadata.is_file() {
        return Err(io::Error::from(io::ErrorKind::NotFound));
    }
    Ok((file, metadata))
}

/// Writes `content` to `name` in `dir`, replacing it in full, and creates the folders it names.
///
/// Writes to a temporary file in the same folder first, then renames it over `name`
/// ([`tempfile::NamedTempFile::persist`]). `rename` replaces whatever is at the destination
/// without following it, so even a symlink swapped in after an earlier check is never written
/// through; a symlink already there is rejected outright first, for a clearer error in the
/// ordinary case where nothing is racing this call.
///
/// # Errors
///
/// A [`symlink_error`] if `name` or a folder on its way is already a symlink, or another
/// [`io::Error`] from creating a folder or creating or renaming the temporary file.
pub(crate) fn write_file(dir: &Path, name: &str, content: &[u8]) -> io::Result<std::fs::Metadata> {
    write(dir, name, content, content.len() as u64, None)
}

/// [`write_file`], keeping the file's modified time at `modified`, for a change that isn't an
/// edit, such as a memory entry's `Last used:` stamp (PLX-943).
pub(crate) fn write_file_keeping(
    dir: &Path,
    name: &str,
    content: &[u8],
    modified: std::time::SystemTime,
) -> io::Result<std::fs::Metadata> {
    write(dir, name, content, content.len() as u64, Some(modified))
}

/// [`write_file`] from a reader, for an artifact too large to hold in memory. Reads at most `max`
/// bytes, and fails with [`io::ErrorKind::FileTooLarge`], leaving `name` as it was, when there
/// are more, such as from a file that grew since its size was checked.
pub(crate) fn copy_file(
    dir: &Path,
    name: &str,
    source: impl Read,
    max: u64,
) -> io::Result<std::fs::Metadata> {
    write(dir, name, source, max, None)
}

/// [`write_file`], [`write_file_keeping`], and [`copy_file`]'s work: at most `max` bytes of
/// `source` into `name`, with its modified time set to `modified` when given.
fn write(
    dir: &Path,
    name: &str,
    source: impl Read,
    max: u64,
    modified: Option<std::time::SystemTime>,
) -> io::Result<std::fs::Metadata> {
    let parent = parent_dir(dir, name, true)?;
    let target = parent.join(file_name(name));
    if let Ok(metadata) = std::fs::symlink_metadata(&target)
        && metadata.file_type().is_symlink()
    {
        return Err(symlink_error());
    }
    let mut temp = tempfile::Builder::new()
        .prefix(".parallax-context-")
        .tempfile_in(&parent)?;
    if io::copy(&mut source.take(max + 1), &mut temp)? > max {
        return Err(io::Error::from(io::ErrorKind::FileTooLarge));
    }
    // Set before the rename, which keeps it, so the file never shows a new time.
    if let Some(modified) = modified {
        temp.as_file().set_modified(modified)?;
    }
    temp.as_file().sync_all()?;
    let file = temp.persist(&target).map_err(|error| error.error)?;
    file.metadata()
}

/// Lists the shared context files in `dir`, and in the [`FOLDERS`] and `artifacts/` under it,
/// ordered by path.
///
/// A hidden (dot) entry (including plxd's own temporary files while a write is in progress), a
/// symlink, or a name with a disallowed extension or in another folder is skipped rather than
/// listed: [`std::fs::DirEntry::file_type`] does not follow a symlink, so one is reported as a
/// symlink, never as whatever it points to, and a symlinked folder is never walked.
pub(crate) fn list_files(dir: &Path) -> io::Result<Vec<(String, std::fs::Metadata)>> {
    let mut files = Vec::new();
    walk(dir, "", &mut files)?;
    files.sort_by(|(a, _), (b, _)| a.cmp(b));
    Ok(files)
}

/// Adds the files in `dir`'s folder `folder` (`""` for `dir` itself) to `files`, and walks those
/// of its folders that lead to one of [`FOLDERS`] or are in `artifacts/`.
fn walk(dir: &Path, folder: &str, files: &mut Vec<(String, std::fs::Metadata)>) -> io::Result<()> {
    let entries = match std::fs::read_dir(dir.join(folder)) {
        Ok(entries) => entries,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(error),
    };
    for entry in entries {
        let entry = entry?;
        let Ok(name) = entry.file_name().into_string() else {
            continue;
        };
        let path = if folder.is_empty() {
            name
        } else {
            format!("{folder}/{name}")
        };
        let file_type = entry.file_type()?;
        if file_type.is_dir() {
            let prefix: Vec<&str> = path.split('/').collect();
            let artifacts = matches!(prefix[..], ["artifacts", ..]);
            if artifacts || FOLDERS.iter().any(|allowed| allowed.starts_with(&prefix)) {
                walk(dir, &path, files)?;
            }
        } else if file_type.is_file() && validate_relative_path(&path).is_ok() {
            files.push((path, entry.metadata()?));
        }
    }
    Ok(())
}

/// Deletes `name` in `dir`: the file, or a symlink itself, never what it points to.
///
/// # Errors
///
/// [`io::ErrorKind::NotFound`] if there is no such file, a [`symlink_error`] if a folder on its
/// way is a symlink, or another [`io::Error`] from removing it.
pub(crate) fn delete_file(dir: &Path, name: &str) -> io::Result<()> {
    let path = parent_dir(dir, name, false)?.join(file_name(name));
    if std::fs::symlink_metadata(&path)?.is_dir() {
        return Err(io::Error::from(io::ErrorKind::NotFound));
    }
    std::fs::remove_file(path)
}

/// Whether `path` is in `history/` or `artifacts/`, which count toward [`MAX_BULK_BYTES`] rather
/// than [`MAX_PROJECT_BYTES`]. `.versions/` does too, but is hidden, so it is never listed.
pub(crate) fn is_bulk(path: &str) -> bool {
    path.starts_with("history/") || path.starts_with("artifacts/")
}

/// The total size of a project's shared context outside the bulk folders ([`is_bulk`]), in bytes,
/// apart from `except`'s own current size, if it exists. Used to check [`MAX_PROJECT_BYTES`]
/// before a write, without counting the file the write is about to replace against itself.
/// plxd's copies of a hand-written board ([`crate::board::LEGACY`]) don't count either, so
/// keeping them can't fail on the cap or crowd out other files.
pub(crate) fn other_files_total(dir: &Path, except: &str) -> io::Result<u64> {
    let mut total = 0_u64;
    for (name, metadata) in list_files(dir)? {
        if name != except && !is_bulk(&name) && !crate::board::LEGACY.contains(&name.as_str()) {
            total += metadata.len();
        }
    }
    Ok(total)
}

/// Makes room for `needed` more bytes in `dir`'s bulk folders under [`MAX_BULK_BYTES`], not
/// counting `except`, which the write replaces, by deleting the oldest artifacts first. Returns
/// the paths it deleted, or `None`, deleting nothing, when even deleting every artifact would not
/// make room.
pub(crate) fn make_room(dir: &Path, except: &str, needed: u64) -> io::Result<Option<Vec<String>>> {
    make_room_under(dir, except, needed, MAX_BULK_BYTES)
}

/// [`make_room`] under `cap`, so a test needn't write gigabytes.
fn make_room_under(
    dir: &Path,
    except: &str,
    needed: u64,
    cap: u64,
) -> io::Result<Option<Vec<String>>> {
    let mut total = needed + tree_size(&dir.join(".versions"))?;
    let mut artifacts = Vec::new();
    for (path, metadata) in list_files(dir)? {
        if path == except || !is_bulk(&path) {
            continue;
        }
        total += metadata.len();
        if path.starts_with("artifacts/") {
            artifacts.push((modified_at(&metadata), path, metadata.len()));
        }
    }
    let prunable: u64 = artifacts.iter().map(|(_, _, size)| size).sum();
    if total - prunable > cap {
        return Ok(None);
    }
    artifacts.sort();
    let mut pruned = Vec::new();
    for (_, path, size) in artifacts {
        if total <= cap {
            break;
        }
        match delete_file(dir, &path) {
            Ok(()) => pruned.push(path.clone()),
            // Another save racing this one deleted it, and reports it: the space is free all the
            // same.
            Err(error) if error.kind() == io::ErrorKind::NotFound => {}
            Err(error) => return Err(error),
        }
        // Drops its folders up to the thread's once they're empty; one still holding files stays.
        let mut folder = path.as_str();
        while let Some((parent, _)) = folder.rsplit_once('/')
            && parent.contains('/')
            && std::fs::remove_dir(dir.join(parent)).is_ok()
        {
            folder = parent;
        }
        total -= size;
    }
    Ok(Some(pruned))
}

/// The total size of the files under `path`, never following a symlink. 0 when it's missing or
/// isn't a real folder.
fn tree_size(path: &Path) -> io::Result<u64> {
    match std::fs::symlink_metadata(path) {
        Ok(metadata) if metadata.is_dir() && !is_link(&metadata) => {}
        Ok(_) => return Ok(0),
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(0),
        Err(error) => return Err(error),
    }
    let mut total = 0;
    for entry in std::fs::read_dir(path)? {
        let entry = entry?;
        let kind = entry.file_type()?;
        if kind.is_dir() {
            total += tree_size(&entry.path())?;
        } else if kind.is_file() {
            total += entry.metadata()?.len();
        }
    }
    Ok(total)
}

/// `metadata`'s modification time as the protocol reports it, or the epoch if the OS can't say.
pub(crate) fn modified_at(metadata: &std::fs::Metadata) -> Timestamp {
    metadata
        .modified()
        .ok()
        .and_then(|modified| Timestamp::try_from(modified).ok())
        .unwrap_or(Timestamp::UNIX_EPOCH)
}

fn hash_content(content: &[u8]) -> u64 {
    use std::hash::{Hash as _, Hasher as _};
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    content.hash(&mut hasher);
    hasher.finish()
}

/// What [`ContextIndex`] remembers about the last write to one file.
#[derive(Clone, Debug, PartialEq, Eq)]
struct Record {
    /// The write that produced the current content, if it came through `context/write`. `None`
    /// for a write an agent made directly on disk.
    write_id: Option<ContextWriteId>,
    hash: u64,
    writer: Option<String>,
}

/// What an idempotent `context/write` found already recorded for its path.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Existing {
    /// No earlier write recorded, or the last one used a different id: proceed as a new write.
    New,
    /// The last write used this same id and had the same content and writer: a retry. Return the
    /// current file instead of writing again.
    SameRetry,
    /// The last write used this same id but different content or a different writer: `idConflict`.
    Conflict,
}

/// In-memory bookkeeping for shared context writes (see the module docs for why it is not
/// persisted). Keyed by project and path; safe to call from the watcher's own thread and from the
/// async method handlers alike, like [`crate::event_log::EventLog`].
#[derive(Default)]
pub(crate) struct ContextIndex {
    records: Mutex<HashMap<(ProjectId, String), Record>>,
}

impl ContextIndex {
    /// Whether `write_id` for `project`/`path` is a fresh write, a matching retry, or a conflict
    /// with different content or a different writer.
    pub fn check(
        &self,
        project: ProjectId,
        path: &str,
        write_id: ContextWriteId,
        content: &[u8],
        writer: Option<&str>,
    ) -> Existing {
        let records = self.lock();
        let Some(record) = records.get(&(project, path.to_owned())) else {
            return Existing::New;
        };
        if record.write_id != Some(write_id) {
            return Existing::New;
        }
        if record.hash == hash_content(content) && record.writer.as_deref() == writer {
            Existing::SameRetry
        } else {
            Existing::Conflict
        }
    }

    /// Puts a `context/write`'s `content` on disk with `write`, then records it, holding the
    /// index the whole time.
    ///
    /// The watcher checks the index for every change it sees, and inotify reports the rename at
    /// once, so recording after letting go would let the watcher take plxd's own write for an
    /// agent's. Holding it also orders racing writes: the last one recorded is the one on disk.
    ///
    /// # Errors
    ///
    /// `write`'s, in which case nothing is recorded.
    pub fn write_protocol<T>(
        &self,
        project: ProjectId,
        path: &str,
        write_id: ContextWriteId,
        writer: Option<String>,
        content: &[u8],
        write: impl FnOnce() -> io::Result<T>,
    ) -> io::Result<T> {
        // ponytail: one lock for every project's index, held across the write's fsync, so all
        // context writes and watcher checks queue behind it. Per-path locks if write volume grows.
        let mut records = self.lock();
        let written = write()?;
        records.insert(
            (project, path.to_owned()),
            Record {
                write_id: Some(write_id),
                hash: hash_content(content),
                writer,
            },
        );
        Ok(written)
    }

    /// Reads a file the watcher saw change with `read`, and records it as a write with no
    /// `context/write` behind it, unless its content matches the last write recorded for this
    /// path. Returns whether it was new: `false` when it matched or `read` failed.
    ///
    /// A change that matches carries no new information and should not be reported: it is either
    /// the echo of plxd's own write (which the OS can report more than once for a single rename,
    /// so this checks content rather than consuming a one-shot flag), or a rewrite of a file with
    /// the content it already had. The index is held from the read to the record, as
    /// [`ContextIndex::write_protocol`] holds it, so a `context/write` can't land in between and
    /// get its content taken for an agent's.
    pub fn record_disk_write(
        &self,
        project: ProjectId,
        path: &str,
        read: impl FnOnce() -> Option<Vec<u8>>,
    ) -> bool {
        let mut records = self.lock();
        let Some(content) = read() else {
            return false;
        };
        let hash = hash_content(&content);
        let key = (project, path.to_owned());
        if records.get(&key).is_some_and(|record| record.hash == hash) {
            return false;
        }
        records.insert(
            key,
            Record {
                write_id: None,
                hash,
                writer: None,
            },
        );
        true
    }

    /// Who last wrote `path` in `project`, if plxd has seen a write to it since it started.
    pub fn writer_of(&self, project: ProjectId, path: &str) -> Option<String> {
        self.lock()
            .get(&(project, path.to_owned()))
            .and_then(|record| record.writer.clone())
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, HashMap<(ProjectId, String), Record>> {
        self.records.lock().unwrap_or_else(PoisonError::into_inner)
    }
}

/// `metadata` and `writer` as the protocol's [`ContextFile`].
pub(crate) fn context_file(
    path: &str,
    metadata: &std::fs::Metadata,
    writer: Option<String>,
) -> ContextFile {
    ContextFile {
        path: path.to_owned(),
        size: metadata.len(),
        modified_at: modified_at(metadata),
        last_writer: writer,
    }
}

/// The protocol error for a shared context I/O failure.
pub(crate) fn io_error(path: &str, error: &io::Error) -> ErrorObject {
    if error.kind() == io::ErrorKind::NotFound {
        return ErrorObject::parallax(
            ErrorKind::ContextNotFound,
            format!("no shared context file has path {path}"),
        );
    }
    if is_symlink_error(error) {
        return ErrorObject::invalid_params(format!("{path} is a symlink, which is not allowed"));
    }
    ErrorObject::internal_error(format!("shared context I/O failed: {error}"))
}

#[cfg(test)]
mod tests {
    #[cfg(unix)]
    use std::os::unix::fs::symlink;

    use parallax_protocol::jsonrpc::INVALID_PARAMS;

    use super::{
        ContextIndex, Existing, MAX_FILE_BYTES, delete_file, ensure_dir, list_files,
        make_room_under, other_files_total, read_file, read_slice, validate_relative_path,
        write_file,
    };
    use crate::paths::DataDir;

    #[test]
    fn only_a_normal_markdown_or_text_name_alone_or_in_a_memory_folder_is_valid() {
        for good in [
            "notes.md",
            "research.markdown",
            "todo.txt",
            "brief.md",
            "memory/preference/tabs.md",
            "memory/convention/naming.md",
            "memory/decision/use-vitest.md",
            "memory/gotcha/flaky-ci.md",
            "knowledge/auth.md",
            "history/run.md",
            "proposals/idea.md",
            "artifacts/0190a1b2/shot.png",
            "artifacts/0190a1b2/report",
            "artifacts/0190a1b2/out/deeper/shot.png",
            "artifacts/0190a1b2/.screenshots/shot.png",
        ] {
            assert_eq!(validate_relative_path(good), Ok(good), "{good}");
        }
        for bad in [
            "",
            "../notes.md",
            "/etc/notes.md",
            "sub/notes.md",
            ".hidden.md",
            "notes",
            "notes.png",
            "..",
            ".",
            "memory/notes.md",
            "memory/other/notes.md",
            "memory/decision/deeper/notes.md",
            "knowledge/../notes.md",
            "knowledge/./notes.md",
            "knowledge//notes.md",
            "knowledge/.hidden.md",
            "knowledge/",
            "knowledge\\notes.md",
            "c:notes.md",
            "/knowledge/notes.md",
            "nul\0.md",
            "memory/decision/a\nb.md",
            "knowledge/a\rb.md",
            "knowledge/a\u{1b}b.md",
            "knowledge/a\u{2028}b.md",
            "knowledge/a\u{85}b.md",
            "artifacts/shot.png",
            "artifacts/.run/shot.png",
            "artifacts/run/.shot.png",
            "artifacts/run/out/.shot.png",
            "artifacts/../shot.png",
            "artifacts/run/../shot.png",
            "artifacts/run/./shot.png",
            ".artifacts/run/shot.png",
        ] {
            let error = validate_relative_path(bad).unwrap_err();
            assert_eq!(error.code, INVALID_PARAMS, "{bad}");
        }
    }

    #[test]
    fn a_context_dir_is_created_private_and_ensuring_it_again_is_a_no_op() {
        let temp = tempfile::tempdir().unwrap();
        let data_dir = DataDir::new(temp.path()).unwrap();
        let project = parallax_protocol::ProjectId::generate();
        let dir = ensure_dir(&data_dir, project).unwrap();
        assert!(dir.is_dir());
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt as _;

            let mode = std::fs::metadata(&dir).unwrap().permissions().mode();
            assert_eq!(mode & 0o777, 0o700);
        }
        assert_eq!(ensure_dir(&data_dir, project).unwrap(), dir);
    }

    #[test]
    fn write_then_read_round_trips_and_list_finds_it() {
        let dir = tempfile::tempdir().unwrap();
        write_file(dir.path(), "notes.md", b"hello").unwrap();
        let (content, metadata) = read_file(dir.path(), "notes.md").unwrap();
        assert_eq!(content, b"hello");
        assert_eq!(metadata.len(), 5);
        let files = list_files(dir.path()).unwrap();
        assert_eq!(files.len(), 1);
        assert_eq!(files[0].0, "notes.md");
    }

    #[test]
    fn nested_files_are_written_read_listed_and_deleted() {
        let dir = tempfile::tempdir().unwrap();
        write_file(dir.path(), "memory/decision/vitest.md", b"Use Vitest").unwrap();
        write_file(dir.path(), "knowledge/auth.md", b"How auth works").unwrap();
        write_file(dir.path(), "notes.md", b"Board").unwrap();
        std::fs::create_dir_all(dir.path().join("elsewhere")).unwrap();
        std::fs::write(dir.path().join("elsewhere/x.md"), "not listed").unwrap();
        let (content, _) = read_file(dir.path(), "memory/decision/vitest.md").unwrap();
        assert_eq!(content, b"Use Vitest");
        let listed: Vec<String> = list_files(dir.path())
            .unwrap()
            .into_iter()
            .map(|(path, _)| path)
            .collect();
        assert_eq!(
            listed,
            ["knowledge/auth.md", "memory/decision/vitest.md", "notes.md"]
        );
        delete_file(dir.path(), "knowledge/auth.md").unwrap();
        let error = read_file(dir.path(), "knowledge/auth.md").unwrap_err();
        assert_eq!(error.kind(), std::io::ErrorKind::NotFound);
        let error = delete_file(dir.path(), "knowledge/auth.md").unwrap_err();
        assert_eq!(error.kind(), std::io::ErrorKind::NotFound);
        let error = read_file(dir.path(), "history/none.md").unwrap_err();
        assert_eq!(error.kind(), std::io::ErrorKind::NotFound);
    }

    /// A folder on the way that is a symlink is refused, for reads, writes, and deletes, so a
    /// planted link can't reach outside the scope's folder.
    #[cfg(unix)]
    #[test]
    fn a_symlinked_folder_is_never_followed() {
        let dir = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        std::fs::write(outside.path().join("secret.md"), "secret").unwrap();
        symlink(outside.path(), dir.path().join("knowledge")).unwrap();

        let error = read_file(dir.path(), "knowledge/secret.md").unwrap_err();
        assert!(super::is_symlink_error(&error));
        let error = write_file(dir.path(), "knowledge/new.md", b"x").unwrap_err();
        assert!(super::is_symlink_error(&error));
        let error = delete_file(dir.path(), "knowledge/secret.md").unwrap_err();
        assert!(super::is_symlink_error(&error));
        assert!(list_files(dir.path()).unwrap().is_empty());
        assert!(!outside.path().join("new.md").exists());
        assert!(outside.path().join("secret.md").exists());
    }

    #[test]
    fn reading_a_missing_file_is_not_found() {
        let dir = tempfile::tempdir().unwrap();
        let error = read_file(dir.path(), "missing.md").unwrap_err();
        assert_eq!(error.kind(), std::io::ErrorKind::NotFound);
    }

    #[cfg(unix)]
    #[test]
    fn a_symlinked_target_is_refused_for_both_read_and_write() {
        let dir = tempfile::tempdir().unwrap();
        let outside = dir.path().join("outside.md");
        std::fs::write(&outside, "secret").unwrap();
        let link = dir.path().join("notes.md");
        symlink(&outside, &link).unwrap();

        let read_error = read_file(dir.path(), "notes.md").unwrap_err();
        assert!(super::is_symlink_error(&read_error));

        let write_error = write_file(dir.path(), "notes.md", b"clobbered").unwrap_err();
        assert!(super::is_symlink_error(&write_error));
        assert_eq!(std::fs::read_to_string(&outside).unwrap(), "secret");
    }

    /// The TOCTOU scenario from the acceptance criteria: a path checks out clean, then something
    /// swaps a symlink in before the write actually happens. The rename-based write must not
    /// write through the swapped-in link even when it isn't rejected outright first.
    #[cfg(unix)]
    #[test]
    fn a_symlink_swapped_in_after_validation_is_never_written_through() {
        let dir = tempfile::tempdir().unwrap();
        let outside = dir.path().join("outside.md");
        std::fs::write(&outside, "secret").unwrap();
        assert!(
            validate_relative_path("notes.md").is_ok(),
            "passes the check"
        );
        // The swap happens here, between the check above and the write below.
        symlink(&outside, dir.path().join("notes.md")).unwrap();

        let error = write_file(dir.path(), "notes.md", b"clobbered").unwrap_err();
        assert!(super::is_symlink_error(&error));
        assert_eq!(
            std::fs::read_to_string(&outside).unwrap(),
            "secret",
            "the symlink's target must be untouched"
        );
    }

    #[test]
    fn a_second_write_replaces_the_first_in_full() {
        let dir = tempfile::tempdir().unwrap();
        write_file(dir.path(), "notes.md", b"first, and then some").unwrap();
        write_file(dir.path(), "notes.md", b"second").unwrap();
        let (content, _) = read_file(dir.path(), "notes.md").unwrap();
        assert_eq!(content, b"second");
    }

    #[test]
    fn temporary_files_are_never_listed() {
        let dir = tempfile::tempdir().unwrap();
        write_file(dir.path(), "notes.md", b"hello").unwrap();
        let leftover = tempfile::Builder::new()
            .prefix(".parallax-context-")
            .tempfile_in(dir.path())
            .unwrap();
        leftover.keep().unwrap();
        let files = list_files(dir.path()).unwrap();
        assert_eq!(files.len(), 1);
        assert_eq!(files[0].0, "notes.md");
    }

    #[test]
    fn other_files_total_excludes_the_named_file_and_the_bulk_folders() {
        let dir = tempfile::tempdir().unwrap();
        write_file(dir.path(), "a.md", &[b'a'; 100]).unwrap();
        write_file(dir.path(), "b.md", &[b'b'; 50]).unwrap();
        write_file(dir.path(), "history/run.md", &[b'h'; 1000]).unwrap();
        write_file(dir.path(), "artifacts/run/shot.png", &[b'p'; 1000]).unwrap();
        assert_eq!(other_files_total(dir.path(), "a.md").unwrap(), 50);
        assert_eq!(other_files_total(dir.path(), "b.md").unwrap(), 100);
        assert_eq!(other_files_total(dir.path(), "c.md").unwrap(), 150);
    }

    #[test]
    fn a_copy_past_its_limit_leaves_the_target_as_it_was() {
        let dir = tempfile::tempdir().unwrap();
        write_file(dir.path(), "artifacts/run/shot.png", b"old").unwrap();
        let error = super::copy_file(dir.path(), "artifacts/run/shot.png", &b"grown"[..], 4);
        assert_eq!(error.unwrap_err().kind(), std::io::ErrorKind::FileTooLarge);
        let (content, _) = read_file(dir.path(), "artifacts/run/shot.png").unwrap();
        assert_eq!(content, b"old");
    }

    #[test]
    fn artifacts_are_listed_and_read_in_slices() {
        let dir = tempfile::tempdir().unwrap();
        write_file(dir.path(), "artifacts/run/shot.png", b"0123456789").unwrap();
        let listed: Vec<String> = list_files(dir.path())
            .unwrap()
            .into_iter()
            .map(|(path, _)| path)
            .collect();
        assert_eq!(listed, ["artifacts/run/shot.png"]);
        let (slice, metadata) = read_slice(dir.path(), "artifacts/run/shot.png", 2, 3).unwrap();
        assert_eq!((slice.as_slice(), metadata.len()), (&b"234"[..], 10));
        let (tail, _) = read_slice(dir.path(), "artifacts/run/shot.png", 8, 5).unwrap();
        assert_eq!(tail, b"89");
        let (past, _) = read_slice(dir.path(), "artifacts/run/shot.png", u64::MAX, 5).unwrap();
        assert!(past.is_empty());
    }

    /// The bulk cap counts history, artifacts, and `.versions/`, and deletes the oldest artifacts
    /// first, never history, Markdown elsewhere, or the file being replaced.
    #[test]
    fn making_room_deletes_the_oldest_artifacts_first() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path();
        let at =
            |seconds| std::time::SystemTime::UNIX_EPOCH + std::time::Duration::from_secs(seconds);
        for (name, seconds) in [
            ("artifacts/a/old.png", 1),
            ("artifacts/b/mid.png", 2),
            ("artifacts/a/new.png", 3),
        ] {
            let metadata = write_file(path, name, &[0; 100]).unwrap();
            assert_eq!(metadata.len(), 100);
            let file = std::fs::File::options()
                .write(true)
                .open(path.join(name))
                .unwrap();
            file.set_modified(at(seconds)).unwrap();
        }
        write_file(path, "history/run.md", &[0; 100]).unwrap();
        write_file(path, "notes.md", &[0; 1000]).unwrap();
        std::fs::create_dir_all(path.join(".versions/notes.md")).unwrap();
        std::fs::write(path.join(".versions/notes.md/1"), [0; 100]).unwrap();

        // 500 in the bulk folders: room for 100 more under 600 deletes nothing.
        assert_eq!(make_room_under(path, "", 100, 600).unwrap(), Some(vec![]));
        // Replacing old.png with 300 bytes leaves 400 counted: two artifacts go, oldest first.
        let pruned = make_room_under(path, "artifacts/a/old.png", 300, 500).unwrap();
        assert_eq!(
            pruned,
            Some(vec![
                "artifacts/b/mid.png".to_owned(),
                "artifacts/a/new.png".to_owned()
            ])
        );
        assert!(
            !path.join("artifacts/b").exists(),
            "an empty thread folder goes too"
        );
        assert!(path.join("artifacts/a/old.png").exists());
        // History and versions alone are over: nothing is deleted.
        assert_eq!(make_room_under(path, "", 1, 200).unwrap(), None);
        assert!(path.join("artifacts/a/old.png").exists());
    }

    #[test]
    fn listing_a_context_dir_that_does_not_exist_yet_is_empty() {
        let dir = tempfile::tempdir().unwrap();
        assert!(list_files(&dir.path().join("nope")).unwrap().is_empty());
    }

    #[test]
    fn a_file_at_exactly_the_cap_is_a_boundary_a_caller_can_check() {
        assert_eq!(MAX_FILE_BYTES, 1024 * 1024);
    }

    #[test]
    fn the_index_tells_new_writes_from_retries_and_conflicts() {
        let index = ContextIndex::default();
        let project = parallax_protocol::ProjectId::generate();
        let id = parallax_protocol::ContextWriteId::generate();
        assert_eq!(
            index.check(project, "notes.md", id, b"hello", None),
            Existing::New
        );

        index
            .write_protocol(
                project,
                "notes.md",
                id,
                Some("editor".to_owned()),
                b"hello",
                || Ok(()),
            )
            .unwrap();
        assert_eq!(
            index.check(project, "notes.md", id, b"hello", Some("editor")),
            Existing::SameRetry
        );
        assert_eq!(
            index.check(project, "notes.md", id, b"different", Some("editor")),
            Existing::Conflict
        );
        assert_eq!(
            index.check(project, "notes.md", id, b"hello", None),
            Existing::Conflict,
            "a different writer with the same id and content is still a conflict"
        );

        let other_id = parallax_protocol::ContextWriteId::generate();
        assert_eq!(
            index.check(project, "notes.md", other_id, b"anything", None),
            Existing::New,
            "a fresh id is always a new write, never a conflict"
        );
    }

    #[test]
    fn matching_content_is_recognized_no_matter_how_many_times_it_is_observed() {
        let index = ContextIndex::default();
        let project = parallax_protocol::ProjectId::generate();
        let id = parallax_protocol::ContextWriteId::generate();
        index
            .write_protocol(project, "notes.md", id, None, b"hello", || Ok(()))
            .unwrap();
        // The OS can report more than one filesystem event for a single atomic write (a rename
        // touches both the temporary name and the target); every one of them must still count as
        // the same already-known write, not just the first.
        let observe = |content: &[u8]| {
            index.record_disk_write(project, "notes.md", || Some(content.to_vec()))
        };
        assert!(!observe(b"hello"));
        assert!(!observe(b"hello"));
        assert!(
            observe(b"something else"),
            "different content is new information, not an echo"
        );
        assert!(!observe(b"something else"), "and is recorded");
    }

    #[test]
    fn writer_of_reports_the_last_recorded_writer() {
        let index = ContextIndex::default();
        let project = parallax_protocol::ProjectId::generate();
        assert_eq!(index.writer_of(project, "notes.md"), None);
        index.record_disk_write(project, "notes.md", || Some(b"from disk".to_vec()));
        assert_eq!(index.writer_of(project, "notes.md"), None);
        let id = parallax_protocol::ContextWriteId::generate();
        index
            .write_protocol(
                project,
                "notes.md",
                id,
                Some("editor".to_owned()),
                b"hi",
                || Ok(()),
            )
            .unwrap();
        assert_eq!(
            index.writer_of(project, "notes.md"),
            Some("editor".to_owned())
        );
    }
}
