//! Per-turn checkpoints' git calls (0062), after T3 Code's `GitVcsDriver` checkpoints: capture a
//! thread's folder into a ref, diff two refs, restore the folder to one, and delete refs.
//!
//! A capture never touches the folder's own index or branch. It copies the real index to a
//! temporary `GIT_INDEX_FILE`, so `add -A` reuses its stat data instead of hashing every file,
//! then writes that index's tree and a commit of it with no parent, and points the ref at it.
//! Writes are fsynced, as T3's are, since a torn ref under `refs/` breaks every later fetch.
//! Like every call in a run's folder, each runs pinned and hardened in a worktree (#166), and
//! hookless in a checkout ([`RunFolder`]).

use std::path::{Path, PathBuf};

use uuid::Uuid;

use super::folder::RunFolder;
use super::{GitOutput, WorktreeError, WorktreeManager, collect_capped};

/// `-c` overrides for a capture's writes: fsynced objects and refs, and no filesystem monitor,
/// which a checkout's own config could otherwise turn on.
const DURABLE: &[&str] = &[
    "-c",
    "core.fsync=objects,reference",
    "-c",
    "core.fsyncMethod=fsync",
    "-c",
    "core.fsmonitor=false",
];

/// The identity a checkpoint's commit is made as. It is never on a branch.
const IDENTITY: &[&str] = &[
    "-c",
    "user.name=Parallax",
    "-c",
    "user.email=parallax@localhost",
];

/// Prefixes that win over a repository's `diff.noprefix` or `diff.mnemonicPrefix`, so a patch's
/// paths always start `a/` and `b/`.
const PREFIXES: &[&str] = &["--src-prefix=a/", "--dst-prefix=b/"];

/// How [`WorktreeManager::diff_checkpoints`] reports a diff.
#[derive(Clone, Copy, Debug)]
pub enum DiffFormat {
    /// A unified patch, whitespace changes left out when `ignore_whitespace`.
    Patch {
        /// Whether whitespace-only changes are left out.
        ignore_whitespace: bool,
    },
    /// `--numstat -z`, for [`parse_numstat_z`].
    Numstat,
}

impl WorktreeManager {
    /// Captures `folder` as it is now into `reference`, replacing what it held.
    ///
    /// # Errors
    ///
    /// [`WorktreeError::GitFailed`], [`WorktreeError::Timeout`], [`WorktreeError::Spawn`], or
    /// [`WorktreeError::Io`] copying the index.
    pub async fn capture_checkpoint(
        &self,
        folder: RunFolder<'_>,
        reference: &str,
    ) -> Result<(), WorktreeError> {
        let index = self
            .folder_git_ok(
                folder,
                &["rev-parse", "--path-format=absolute", "--git-path", "index"],
            )
            .await?;
        let index = PathBuf::from(index.trim());
        let temp = index.with_file_name(format!("parallax-checkpoint-index-{}", Uuid::now_v7()));
        let captured = self.capture_with(folder, reference, &index, &temp).await;
        // A killed git can leave its lock beside the temporary index.
        for path in [temp.clone(), temp.with_extension("lock")] {
            let _ = tokio::fs::remove_file(path).await;
        }
        captured
    }

    async fn capture_with(
        &self,
        folder: RunFolder<'_>,
        reference: &str,
        index: &Path,
        temp: &Path,
    ) -> Result<(), WorktreeError> {
        copy_index(index, temp).await?;
        let with_index = |args: &[&str]| -> Vec<String> {
            DURABLE
                .iter()
                .chain(args)
                .map(|arg| (*arg).to_owned())
                .collect()
        };
        self.git_with_index(folder, temp, &with_index(&["add", "-A"]))
            .await?;
        let tree = self
            .git_with_index(folder, temp, &with_index(&["write-tree"]))
            .await?;
        let message = format!("parallax checkpoint {reference}");
        let mut commit = with_index(IDENTITY);
        commit.extend(
            ["commit-tree", tree.trim(), "-m", &message]
                .iter()
                .map(|arg| (*arg).to_owned()),
        );
        let commit = self.git_with_index(folder, temp, &commit).await?;
        let mut update: Vec<&str> = DURABLE.to_vec();
        update.extend(["update-ref", reference, commit.trim()]);
        self.folder_git_ok(folder, &update).await.map(drop)
    }

    /// Runs `git args` in `folder` with `index` as its index, and returns its stdout.
    async fn git_with_index(
        &self,
        folder: RunFolder<'_>,
        index: &Path,
        args: &[String],
    ) -> Result<String, WorktreeError> {
        let args: Vec<&str> = args.iter().map(String::as_str).collect();
        let mut spec = self.folder_spec(folder, &args).await?;
        spec.inject
            .set("GIT_INDEX_FILE", index.to_string_lossy().into_owned());
        let cwd = folder.path();
        let (stdout, exit) = self.exec(&spec, cwd, &args, super::DEFAULT_TIMEOUT).await?;
        GitOutput {
            stdout: String::from_utf8_lossy(&stdout).into_owned(),
            exit,
        }
        .ok(cwd, &args)
    }

    /// Points `reference` at `commit`, which holds a folder's files already: a new worktree's
    /// base, which is all a worktree has before its first turn.
    ///
    /// # Errors
    ///
    /// [`WorktreeError::GitFailed`], [`WorktreeError::Timeout`], or [`WorktreeError::Spawn`].
    pub async fn point_checkpoint(
        &self,
        folder: RunFolder<'_>,
        reference: &str,
        commit: &str,
    ) -> Result<(), WorktreeError> {
        let mut args: Vec<&str> = DURABLE.to_vec();
        args.extend(["update-ref", reference, commit]);
        self.folder_git_ok(folder, &args).await.map(drop)
    }

    /// Whether `reference` names a commit in `folder`'s repository.
    ///
    /// # Errors
    ///
    /// [`WorktreeError::Timeout`] or [`WorktreeError::Spawn`].
    pub async fn has_checkpoint(
        &self,
        folder: RunFolder<'_>,
        reference: &str,
    ) -> Result<bool, WorktreeError> {
        let commit = format!("{reference}^{{commit}}");
        let output = self
            .folder_git(folder, &["rev-parse", "--verify", "--quiet", &commit])
            .await?;
        Ok(output.success())
    }

    /// The diff from checkpoint `from` to `to`, cut at `max_bytes`, and whether it was cut.
    ///
    /// # Errors
    ///
    /// [`WorktreeError::GitFailed`] when either ref is missing, [`WorktreeError::Timeout`], or
    /// [`WorktreeError::Spawn`].
    pub async fn diff_checkpoints(
        &self,
        folder: RunFolder<'_>,
        from: &str,
        to: &str,
        format: DiffFormat,
        max_bytes: usize,
    ) -> Result<(String, bool), WorktreeError> {
        let (from, to) = (format!("{from}^{{commit}}"), format!("{to}^{{commit}}"));
        let mut args = vec!["diff", "--no-color", "--no-ext-diff", "--no-textconv"];
        match format {
            DiffFormat::Patch { ignore_whitespace } => {
                args.push("--patch");
                args.extend_from_slice(PREFIXES);
                if ignore_whitespace {
                    args.push("--ignore-all-space");
                }
            }
            DiffFormat::Numstat => args.extend(["--numstat", "-z"]),
        }
        args.extend([from.as_str(), to.as_str()]);
        let spec = self.folder_spec(folder, &args).await?;
        let cwd = folder.path();
        let process = self.launcher.spawn(&spec)?;
        let (stdout, exit, truncated) = tokio::time::timeout(
            super::DEFAULT_TIMEOUT,
            collect_capped(process, cwd, &args, max_bytes),
        )
        .await
        .map_err(|_| WorktreeError::Timeout {
            cwd: cwd.to_owned(),
            args: super::owned_args(&args),
            timeout: super::DEFAULT_TIMEOUT,
        })??;
        let stdout = String::from_utf8_lossy(&stdout).into_owned();
        // A cut diff's git was killed, so only a whole one's exit says anything.
        match exit {
            Some(exit) if !truncated => GitOutput { stdout, exit }
                .ok(cwd, &args)
                .map(|stdout| (stdout, false)),
            _ => Ok((stdout, truncated)),
        }
    }

    /// Restores `folder`'s files to checkpoint `reference`, as T3 Code does: the checkpoint's
    /// files back, files it doesn't have removed (ignored ones stay), and the index back to
    /// `HEAD`, so the restored state shows as uncommitted changes.
    ///
    /// # Errors
    ///
    /// [`WorktreeError::GitFailed`], [`WorktreeError::Timeout`], or [`WorktreeError::Spawn`].
    pub async fn restore_checkpoint(
        &self,
        folder: RunFolder<'_>,
        reference: &str,
    ) -> Result<(), WorktreeError> {
        let commit = self
            .folder_git_ok(
                folder,
                &["rev-parse", "--verify", &format!("{reference}^{{commit}}")],
            )
            .await?;
        let commit = commit.trim();
        let with_tree = format!("--with-tree={commit}");
        let tracked = self
            .folder_git_ok(folder, &["ls-files", "--cached", &with_tree, "-z"])
            .await?;
        // An empty index and checkpoint have nothing for restore's pathspec to match.
        if !tracked.trim().is_empty() {
            self.folder_git_ok(
                folder,
                &[
                    "restore",
                    "--source",
                    commit,
                    "--worktree",
                    "--staged",
                    "--",
                    ".",
                ],
            )
            .await?;
        }
        self.folder_git_ok(folder, &["clean", "-fd", "--", "."])
            .await?;
        if self
            .folder_git(folder, &["rev-parse", "--verify", "--quiet", "HEAD"])
            .await?
            .success()
        {
            self.folder_git_ok(folder, &["reset", "--quiet", "--", "."])
                .await?;
        }
        Ok(())
    }

    /// The refs under `prefix` in `folder`'s repository.
    ///
    /// # Errors
    ///
    /// [`WorktreeError::GitFailed`], [`WorktreeError::Timeout`], or [`WorktreeError::Spawn`].
    pub async fn list_refs(
        &self,
        folder: RunFolder<'_>,
        prefix: &str,
    ) -> Result<Vec<String>, WorktreeError> {
        let refs = self
            .folder_git_ok(folder, &["for-each-ref", "--format=%(refname)", prefix])
            .await?;
        Ok(refs.lines().map(str::to_owned).collect())
    }

    /// Deletes `reference`. One already gone is deleted.
    ///
    /// # Errors
    ///
    /// [`WorktreeError::GitFailed`], [`WorktreeError::Timeout`], or [`WorktreeError::Spawn`].
    pub async fn delete_ref(
        &self,
        folder: RunFolder<'_>,
        reference: &str,
    ) -> Result<(), WorktreeError> {
        self.folder_git_ok(folder, &["update-ref", "-d", reference])
            .await
            .map(drop)
    }
}

/// Copies the real index to `temp` with its modification time, so git's racy-clean check
/// trusts the same entries in the copy as in the original. A repository with no index yet
/// starts from an empty one.
async fn copy_index(index: &Path, temp: &Path) -> Result<(), WorktreeError> {
    let io = |source| WorktreeError::Io {
        path: index.to_owned(),
        source,
    };
    let modified = match tokio::fs::metadata(index).await {
        Ok(metadata) => metadata.modified().map_err(io)?,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(io(error)),
    };
    tokio::fs::copy(index, temp).await.map_err(io)?;
    let temp = temp.to_owned();
    tokio::task::spawn_blocking(move || {
        std::fs::File::options()
            .write(true)
            .open(&temp)?
            .set_modified(modified)
    })
    .await
    .map_err(|error| io(std::io::Error::other(error)))?
    .map_err(io)
}

/// Reads `git diff --numstat -z`: each file's added and removed lines, a binary file's as 0, by
/// path, with a rename under its new path.
#[must_use]
pub fn parse_numstat_z(output: &str) -> Vec<(String, u32, u32)> {
    let mut records = output.trim_end_matches('\n').split('\0');
    let mut files = Vec::new();
    while let Some(record) = records.next() {
        let mut fields = record.splitn(3, '\t');
        let (Some(added), Some(removed), Some(path)) =
            (fields.next(), fields.next(), fields.next())
        else {
            continue;
        };
        // A rename's record has no path: its old and new paths are the next two.
        let path = if path.is_empty() {
            records.next();
            records.next().unwrap_or_default()
        } else {
            path
        };
        if path.is_empty() {
            continue;
        }
        let count = |n: &str| n.parse().unwrap_or(0);
        files.push((path.to_owned(), count(added), count(removed)));
    }
    files.sort();
    files
}

#[cfg(test)]
mod tests {
    use super::parse_numstat_z;

    #[test]
    fn numstat_z_reads_plain_binary_and_renamed_files() {
        let output = "3\t1\tsrc/b.rs\0-\t-\tlogo.png\x000\t0\t\0old.rs\0new.rs\0";
        assert_eq!(
            parse_numstat_z(output),
            vec![
                ("logo.png".to_owned(), 0, 0),
                ("new.rs".to_owned(), 0, 0),
                ("src/b.rs".to_owned(), 3, 1),
            ]
        );
    }
}
