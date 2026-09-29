//! Each worker run's own temp folder (RYA-130), whichever backend runs it.
//!
//! A vendor CLI's default temp is shared: Claude Code's `/tmp/claude-<uid>` holds what every
//! session of the user leaves there. So wispd makes a new, owner-only folder for each worker's
//! CLI in [`DataDir::run_temp_roots`] before the CLI starts, and removes it when the CLI exits.
//! The backend points the vendor's temp setting at it through
//! [`WorkerSandbox::temp`](super::WorkerSandbox), and the sandbox hides every other run's. A root goes with its last run's folder, and `serve`
//! sweeps what a crash left at startup.
//!
//! The roots are in `/tmp`, which every user can write, so a root must be a folder this user
//! owns that nobody else can enter. One someone else made first refuses the worker instead.

use std::io;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, PoisonError};

use tempfile::TempDir;
use tracing::warn;

use crate::paths::DataDir;

/// Held while a run's folder is made or a root removed, so a run that ends can't remove the
/// root another is making its folder in. Only one wispd uses a data folder's roots.
static ROOTS: Mutex<()> = Mutex::new(());

/// A worker run's temp folder. Dropping it removes the folder, and its root if no other run's
/// folder is left there.
#[derive(Debug)]
pub struct RunTemp(PathBuf);

impl RunTemp {
    /// The folder, as made: `/tmp/wisp-<hash>/<6 characters>`, not canonical on macOS.
    #[must_use]
    pub fn path(&self) -> &Path {
        &self.0
    }
}

impl Drop for RunTemp {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
        let _roots = ROOTS.lock().unwrap_or_else(PoisonError::into_inner);
        if let Some(root) = self.0.parent() {
            // Fails, as it should, while another run's folder is in it.
            let _ = std::fs::remove_dir(root);
        }
    }
}

/// Makes a new temp folder for a worker run: 0700, with a random 6-character name, in the first
/// of [`DataDir::run_temp_roots`] this process may write. The root is made 0700 if it is
/// missing.
///
/// # Errors
///
/// If the root isn't a folder this user owns and alone can enter, or a folder can't be made.
pub fn create(data_dir: &DataDir) -> io::Result<RunTemp> {
    let _roots = ROOTS.lock().unwrap_or_else(PoisonError::into_inner);
    let mut made = Err(io::ErrorKind::NotFound.into());
    for root in data_dir.run_temp_roots() {
        made = make_private(&root).and_then(|()| new_folder(&root));
        // Linux's worker sandbox mounts `/` read-only, macOS's refuses: try the next root.
        match &made {
            Err(error)
                if matches!(
                    error.kind(),
                    io::ErrorKind::PermissionDenied | io::ErrorKind::ReadOnlyFilesystem
                ) => {}
            _ => break,
        }
    }
    made.map(|folder| RunTemp(folder.keep()))
}

/// Removes every run's temp folder, with the roots, and the data folder's `tmp/`, which holds
/// files such as a Claude worker's `CLAUDE_ENV_FILE` (RYA-126). For `serve` at startup, when its
/// instance lock means none of them is in use. A root someone else owns is left alone.
pub fn sweep(data_dir: &DataDir) {
    let roots = data_dir
        .run_temp_roots()
        .into_iter()
        .filter(|root| check_private(root).is_ok());
    for dir in roots.chain([data_dir.temp_dir()]) {
        if let Err(error) = std::fs::remove_dir_all(&dir)
            && error.kind() != io::ErrorKind::NotFound
        {
            warn!(%error, dir = %dir.display(), "could not remove what earlier runs left behind");
        }
    }
}

/// Makes `root` 0700 if it is missing, then checks it with [`check_private`].
fn make_private(root: &Path) -> io::Result<()> {
    #[cfg(unix)]
    let made =
        std::os::unix::fs::DirBuilderExt::mode(&mut std::fs::DirBuilder::new(), 0o700).create(root);
    #[cfg(not(unix))]
    let made = std::fs::create_dir(root);
    match made {
        Err(error) if error.kind() != io::ErrorKind::AlreadyExists => Err(io::Error::new(
            error.kind(),
            format!("could not make {}: {error}", root.display()),
        )),
        _ => check_private(root),
    }
}

/// Checks that `root` is a folder, not a link, that this user owns with mode 0700, so nobody
/// else may enter it.
fn check_private(root: &Path) -> io::Result<()> {
    let metadata = std::fs::symlink_metadata(root)?;
    #[cfg(unix)]
    let private = {
        use std::os::unix::fs::MetadataExt as _;
        metadata.uid() == rustix::process::getuid().as_raw() && metadata.mode() & 0o777 == 0o700
    };
    #[cfg(windows)]
    let private = true;
    if metadata.is_dir() && private {
        Ok(())
    } else {
        Err(io::Error::other(format!(
            "{} isn't a folder that only this user can open, so it can't hold workers' temp \
             folders; remove it",
            root.display()
        )))
    }
}

/// A new 0700 folder in `root`, with a random 6-character name.
fn new_folder(root: &Path) -> io::Result<TempDir> {
    let mut builder = tempfile::Builder::new();
    builder.prefix("").rand_bytes(6);
    #[cfg(unix)]
    builder.permissions(std::os::unix::fs::PermissionsExt::from_mode(0o700));
    builder.tempdir_in(root)
}

#[cfg(all(test, unix))]
mod tests {
    use std::fs;
    use std::os::unix::fs::PermissionsExt;

    use super::{create, sweep};
    use crate::paths::DataDir;

    /// A data folder whose roots are fresh, and removed with it.
    fn data_dir() -> (tempfile::TempDir, DataDir) {
        let dir = tempfile::tempdir().unwrap();
        let data = DataDir::new(dir.path()).unwrap();
        (dir, data)
    }

    #[test]
    fn a_run_gets_a_private_folder_that_goes_with_it_and_the_sweep_takes_the_rest() {
        let (_dir, data) = data_dir();
        let run = create(&data).unwrap();
        let other = create(&data).unwrap();
        // `/tmp`'s, unless this runs in a sandbox that can't write it.
        let root = run.path().parent().unwrap().to_owned();
        assert!(data.run_temp_roots().contains(&root));
        assert_eq!(run.path().file_name().unwrap().len(), 6);
        for folder in [root.as_path(), run.path()] {
            let mode = fs::metadata(folder).unwrap().permissions().mode();
            assert_eq!(mode & 0o777, 0o700, "{}", folder.display());
        }
        let path = run.path().to_owned();
        drop(run);
        assert!(!path.exists());
        assert!(root.exists(), "another run's folder is still in it");
        drop(other);
        assert!(!root.exists());

        // What a crash leaves behind.
        let left = create(&data).unwrap();
        fs::write(left.path().join("file"), "").unwrap();
        std::mem::forget(left);
        fs::create_dir_all(data.temp_dir()).unwrap();
        fs::write(data.temp_dir().join("claude-env-x.sh"), "").unwrap();
        sweep(&data);
        assert!(!root.exists());
        assert!(!data.temp_dir().exists());
    }

    #[test]
    fn a_root_others_can_enter_is_refused_and_left_alone() {
        let (_dir, data) = data_dir();
        let run = create(&data).unwrap();
        let root = run.path().parent().unwrap().to_owned();
        fs::set_permissions(&root, fs::Permissions::from_mode(0o777)).unwrap();
        let error = create(&data).unwrap_err();
        assert!(error.to_string().contains("only this user"), "{error}");
        sweep(&data);
        assert!(run.path().exists());
        drop(run);
        assert!(!root.exists());
    }
}
