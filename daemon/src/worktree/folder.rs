//! Git in the folder a run works in (PLX-298): the status `agent/gitStatus` reads, the commit
//! `agent/commit` makes, the push `agent/push` and `agent/openPr` make, the files
//! `repo/files` lists (PLX-359), and the lines `repo/grep` finds (PLX-993).
//!
//! A run's folder is its worktree, which every call reaches pinned and hardened (#166), or a
//! Current checkout thread's checkout, the user's own, which calls reach through the hookless
//! [`WorktreeManager::run_git`], as Accept does. A push always runs in the user's checkout.

use std::path::Path;
use std::time::Duration;

use parallax_protocol::{GitStatus, GrepMatch};

use super::{
    Commit, DEFAULT_TIMEOUT, GitOutput, WorktreeError, WorktreeManager, collect_capped,
    describe_failure, owned_args,
};
use crate::backend::process::ProcessSpec;

/// How long a push may take: it goes over the network and can carry a large branch.
pub(super) const NETWORK_TIMEOUT: Duration = Duration::from_secs(300);

/// The most characters of a line `repo/grep` returns.
const MAX_GREP_TEXT: usize = 300;

/// Where a run's git calls run.
#[derive(Clone, Copy, Debug)]
pub enum RunFolder<'a> {
    /// A run's worktree, with the git folder [`super::CreatedWorktree::git_dir`] pinned for it.
    Worktree {
        /// The worktree.
        path: &'a Path,
        /// Its private git folder.
        git_dir: &'a Path,
    },
    /// A Current checkout thread's checkout: the repository's own working tree.
    Checkout(&'a Path),
}

/// Why [`WorktreeManager::push`] failed: the repository has no `origin`, or the push failed. The
/// message says which, with git's stderr.
#[derive(Debug, thiserror::Error)]
#[error("{0}")]
pub struct PushError(pub String);

impl WorktreeManager {
    /// The git state of `folder`: its branch, its uncommitted changes, untracked files included,
    /// and how far it is ahead of its upstream. It takes no optional locks, so a turn's own git
    /// calls never trip over it.
    ///
    /// # Errors
    ///
    /// [`WorktreeError::NotAGitRepo`] for an invalid checkout, [`WorktreeError::Io`] preparing
    /// the temporary index, or [`WorktreeError::GitFailed`], [`WorktreeError::Timeout`],
    /// or [`WorktreeError::Spawn`].
    pub async fn status(&self, folder: RunFolder<'_>) -> Result<GitStatus, WorktreeError> {
        if let RunFolder::Checkout(path) = folder {
            crate::repo::check(path).map_err(|error| WorktreeError::NotAGitRepo {
                path: path.to_owned(),
                detail: error.to_string(),
            })?;
        }
        let porcelain = self
            .folder_git_ok(
                folder,
                &[
                    "--no-optional-locks",
                    "status",
                    "--porcelain=v2",
                    "--branch",
                    // Counted whatever the repository's `status.showUntrackedFiles` says.
                    "--untracked-files=normal",
                ],
            )
            .await?;
        let mut status = GitStatus {
            branch: None,
            changes: 0,
            insertions: 0,
            deletions: 0,
            upstream: None,
            ahead: 0,
            origin: self
                .folder_git(folder, &["remote", "get-url", "origin"])
                .await?
                .success(),
        };
        let mut ahead = None;
        for line in porcelain.lines() {
            if let Some(head) = line.strip_prefix("# branch.head ") {
                status.branch = (head != "(detached)").then(|| head.to_owned());
            } else if let Some(upstream) = line.strip_prefix("# branch.upstream ") {
                status.upstream = Some(upstream.to_owned());
            } else if let Some(counts) = line.strip_prefix("# branch.ab +") {
                ahead = counts.split(' ').next().and_then(|n| n.parse().ok());
            } else if !line.starts_with('#') {
                status.changes += 1;
            }
        }
        // With no upstream, or one that's gone, what a push would add to `origin`. An unborn
        // branch fails, with nothing to push.
        if let Some(ahead) = ahead {
            status.ahead = ahead;
        } else {
            let output = self
                .folder_git(
                    folder,
                    &["rev-list", "--count", "HEAD", "--not", "--remotes=origin"],
                )
                .await?;
            status.ahead = output.stdout.trim().parse().unwrap_or(0);
        }
        (status.insertions, status.deletions) = self.uncommitted_lines(folder).await?;
        Ok(status)
    }

    /// Net working-file changes relative to HEAD, plus untracked files, without changing the index.
    async fn uncommitted_lines(&self, folder: RunFolder<'_>) -> Result<(u64, u64), WorktreeError> {
        // Diff HEAD against the working files, so staged/unstaged edits to the same line
        // count once. An unborn checkout uses Git's empty tree in its object format.
        let head = self
            .folder_git(folder, &["rev-parse", "--verify", "HEAD"])
            .await?;
        let base = if head.success() {
            head.stdout
        } else {
            self.folder_git_ok(folder, &["hash-object", "-t", "tree", "--stdin"])
                .await?
        };
        // Seed from HEAD rather than the user's index: a staged deletion may already
        // have been recreated in the working tree.
        let temp = tempfile::tempdir().map_err(|source| WorktreeError::Io {
            path: std::env::temp_dir(),
            source,
        })?;
        let index = temp.path().join("index");
        self.git_with_index(folder, &index, &["read-tree".into(), base.trim().into()])
            .await?;
        let diff = self
            .git_with_index(
                folder,
                &index,
                &[
                    "diff",
                    "--numstat",
                    "--no-ext-diff",
                    "--no-textconv",
                    base.trim(),
                    "--",
                ]
                .map(str::to_owned),
            )
            .await?;
        let counts = super::parse_numstat(&diff);
        let mut insertions = counts.insertions;
        let mut deletions = counts.deletions;
        let untracked = self
            .git_with_index(
                folder,
                &index,
                &["ls-files", "--others", "--exclude-standard", "-z"].map(str::to_owned),
            )
            .await?;
        // Real-index additions remain tracked even if ignore rules hide them from the HEAD index.
        let tracked = self
            .folder_git_ok(folder, &["ls-files", "--cached", "-z"])
            .await?;
        let head_paths = self
            .git_with_index(
                folder,
                &index,
                &["ls-files", "--cached", "-z"].map(str::to_owned),
            )
            .await?;
        let head_paths: std::collections::HashSet<_> = head_paths.split('\0').collect();
        let new_paths: std::collections::HashSet<_> = untracked
            .split('\0')
            .chain(
                tracked
                    .split('\0')
                    .filter(|name| !head_paths.contains(name)),
            )
            .filter(|name| {
                !name.is_empty()
                    && folder
                        .path()
                        .join(name)
                        .symlink_metadata()
                        .is_ok_and(|metadata| !metadata.is_dir())
            })
            .collect();
        for name in new_paths {
            let args = [
                "diff",
                "--no-index",
                "--numstat",
                "--no-ext-diff",
                "--no-textconv",
                "--",
                super::NULL_DEVICE,
                name,
            ];
            let diff = self.folder_git(folder, &args).await?;
            // `--no-index` exits 1 when files differ, including binary files.
            if !diff.success() && diff.exit.info.code != Some(1) {
                return Err(diff.failure(folder.path(), &args));
            }
            let counts = super::parse_numstat(&diff.stdout);
            insertions += counts.insertions;
            deletions += counts.deletions;
        }
        Ok((insertions, deletions))
    }

    /// The full hash of `folder`'s `HEAD` commit.
    ///
    /// # Errors
    ///
    /// [`WorktreeError::GitFailed`], [`WorktreeError::Timeout`], or [`WorktreeError::Spawn`].
    pub async fn head(&self, folder: RunFolder<'_>) -> Result<String, WorktreeError> {
        let head = self.folder_git_ok(folder, &["rev-parse", "HEAD"]).await?;
        Ok(head.trim().to_owned())
    }

    /// Stages every change in `folder` and commits it with `message`, as the identity
    /// `repo_root`'s configuration gives (see [`WorktreeManager::resolve_identity`]). Returns
    /// `None`, committing nothing, if there is nothing to commit.
    ///
    /// Runs with `--no-verify` and `--no-gpg-sign`, and with no hooks at all: hooks and
    /// interactive signing assume a person is at the keyboard, and a headless commit that
    /// triggers either must not hang plxd.
    ///
    /// # Errors
    ///
    /// [`WorktreeError::MissingIdentity`] if there is something to commit but `repo_root` has no
    /// configured identity, or [`WorktreeError::GitFailed`], [`WorktreeError::Timeout`], or
    /// [`WorktreeError::Spawn`].
    pub async fn commit(
        &self,
        folder: RunFolder<'_>,
        repo_root: &Path,
        message: &str,
    ) -> Result<Option<Commit>, WorktreeError> {
        self.folder_git_ok(folder, &["add", "-A"]).await?;
        let staged = self
            .folder_git_ok(folder, &["diff", "--cached", "--name-only"])
            .await?;
        if staged.trim().is_empty() {
            return Ok(None);
        }
        let Some((name, email)) = self.resolve_identity(repo_root).await? else {
            return Err(WorktreeError::MissingIdentity {
                repo: repo_root.to_owned(),
            });
        };
        let name = format!("user.name={name}");
        let email = format!("user.email={email}");
        self.folder_git_ok(
            folder,
            &[
                "-c",
                &name,
                "-c",
                &email,
                "commit",
                "--no-verify",
                "--no-gpg-sign",
                "--message",
                message,
            ],
        )
        .await?;
        let sha = self.folder_git_ok(folder, &["rev-parse", "HEAD"]).await?;
        Ok(Some(Commit {
            sha: sha.trim().to_owned(),
        }))
    }

    /// The files in `folder` that git tracks, or that are untracked and not ignored, as paths
    /// relative to it, in git's order: for `repo/files` (PLX-359).
    ///
    /// # Errors
    ///
    /// [`WorktreeError::GitFailed`], [`WorktreeError::Timeout`], or [`WorktreeError::Spawn`].
    pub async fn files(&self, folder: RunFolder<'_>) -> Result<Vec<String>, WorktreeError> {
        let output = self
            .folder_git_ok(
                folder,
                &[
                    "ls-files",
                    "-z",
                    "--cached",
                    "--others",
                    "--exclude-standard",
                ],
            )
            .await?;
        // `-z` paths are NUL-separated and never quoted; the run's output ends with a newline.
        Ok(output
            .trim_end_matches('\n')
            .split('\0')
            .filter(|path| !path.is_empty())
            .map(str::to_owned)
            .collect())
    }

    /// The lines of `folder`'s files that contain `query`, ignoring case, from `git grep` over
    /// tracked and untracked files that git doesn't ignore, binary ones skipped, in git's order:
    /// for `repo/grep` (PLX-993). Reads at most `max_bytes` of git's output and says whether it
    /// stopped there. No match is an empty list.
    ///
    /// # Errors
    ///
    /// [`WorktreeError::GitFailed`], [`WorktreeError::Timeout`], or [`WorktreeError::Spawn`].
    pub async fn grep(
        &self,
        folder: RunFolder<'_>,
        query: &str,
        max_bytes: usize,
    ) -> Result<(Vec<GrepMatch>, bool), WorktreeError> {
        let args = [
            "grep",
            "--null",
            "--line-number",
            "-I",
            "--ignore-case",
            "--fixed-strings",
            "--untracked",
            "--no-color",
            "-e",
            query,
        ];
        let spec = self.folder_spec(folder, &args).await?;
        let cwd = folder.path();
        let process = self.launcher.spawn(&spec)?;
        let (stdout, exit, truncated) = tokio::time::timeout(
            DEFAULT_TIMEOUT,
            collect_capped(process, cwd, &args, max_bytes),
        )
        .await
        .map_err(|_| WorktreeError::Timeout {
            cwd: cwd.to_owned(),
            args: owned_args(&args),
            timeout: DEFAULT_TIMEOUT,
        })??;
        let stdout = String::from_utf8_lossy(&stdout).into_owned();
        // git grep exits 1 when nothing matches; a cut run was killed, so its exit says nothing.
        if let Some(exit) = exit
            && !matches!(exit.info.code, Some(0 | 1))
        {
            return Err(GitOutput { stdout, exit }.failure(cwd, &args));
        }
        // Each line is `path NUL number NUL text`. A cut run's last line may be partial.
        let mut lines: Vec<&str> = stdout.lines().collect();
        if truncated {
            lines.pop();
        }
        let matches = lines
            .into_iter()
            .filter_map(|line| {
                let mut parts = line.splitn(3, '\0');
                let path = parts.next()?;
                let number = parts.next()?.parse().ok()?;
                let text: String = parts.next()?.trim().chars().take(MAX_GREP_TEXT).collect();
                Some(GrepMatch {
                    path: path.to_owned(),
                    line: number,
                    text,
                })
            })
            .collect();
        Ok((matches, truncated))
    }

    /// The branch `repo_path`'s checkout has out, or `None` on a detached HEAD.
    ///
    /// # Errors
    ///
    /// [`WorktreeError::NotAGitRepo`], [`WorktreeError::Timeout`], or [`WorktreeError::Spawn`].
    pub async fn current_branch(&self, repo_path: &Path) -> Result<Option<String>, WorktreeError> {
        let repo_root = self.repo_root(repo_path).await?;
        let output = self
            .run_git(&repo_root, &["symbolic-ref", "--quiet", "--short", "HEAD"])
            .await?;
        let branch = output.stdout.trim();
        Ok((output.success() && !branch.is_empty()).then(|| branch.to_owned()))
    }

    /// Pushes `branch` from `repo_path`'s repository to its `origin`, setting it as the branch's
    /// upstream, and returns `origin`'s URL. It runs in the user's checkout, as the user, so git
    /// uses the user's own configuration and credential helpers; it runs no hooks and never
    /// prompts.
    ///
    /// # Errors
    ///
    /// [`PushError`]: the repository has no `origin`, or the push failed.
    pub async fn push(&self, repo_path: &Path, branch: &str) -> Result<String, PushError> {
        let failed = |error: WorktreeError| PushError(error.to_string());
        let repo_root = self.repo_root(repo_path).await.map_err(failed)?;
        let origin = self
            .run_git(&repo_root, &["remote", "get-url", "origin"])
            .await
            .map_err(failed)?;
        if !origin.success() {
            return Err(PushError(format!(
                "{} has no origin to push to: {}",
                repo_root.display(),
                describe_failure(&origin)
            )));
        }
        let refspec = format!("refs/heads/{branch}:refs/heads/{branch}");
        let push = self
            .run_git_for(
                &repo_root,
                &["push", "--set-upstream", "origin", &refspec],
                NETWORK_TIMEOUT,
            )
            .await
            .map_err(failed)?;
        if !push.success() {
            return Err(PushError(format!(
                "could not push {branch} to origin: {}",
                describe_failure(&push)
            )));
        }
        Ok(origin.stdout.trim().to_owned())
    }

    pub(super) async fn folder_git(
        &self,
        folder: RunFolder<'_>,
        args: &[&str],
    ) -> Result<GitOutput, WorktreeError> {
        match folder {
            RunFolder::Worktree { path, git_dir } => {
                self.run_worktree_git(path, git_dir, args).await
            }
            RunFolder::Checkout(path) => self.run_git(path, args).await,
        }
    }

    pub(super) async fn folder_git_ok(
        &self,
        folder: RunFolder<'_>,
        args: &[&str],
    ) -> Result<String, WorktreeError> {
        match folder {
            RunFolder::Worktree { path, git_dir } => {
                self.run_worktree_git_ok(path, git_dir, args).await
            }
            RunFolder::Checkout(path) => self.run_git_ok(path, args).await,
        }
    }

    /// The process spec for `git args` in `folder`, as [`Self::folder_git`] runs it.
    pub(super) async fn folder_spec(
        &self,
        folder: RunFolder<'_>,
        args: &[&str],
    ) -> Result<ProcessSpec, WorktreeError> {
        Ok(match folder {
            RunFolder::Worktree { path, git_dir } => {
                let mut spec = self.worktree_spec(path, git_dir, args).await?;
                spec.limits.max_line_bytes = self.max_git_line_bytes;
                spec
            }
            RunFolder::Checkout(path) => self.git_spec(path, args),
        })
    }
}

impl RunFolder<'_> {
    /// The folder itself.
    #[must_use]
    pub fn path(&self) -> &Path {
        match self {
            Self::Worktree { path, .. } | Self::Checkout(path) => path,
        }
    }
}
