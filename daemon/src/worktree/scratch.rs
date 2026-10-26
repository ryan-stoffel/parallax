//! Scratch repositories for normal threads with no repo (#110, decision 0017).
//!
//! Each such thread gets its own repository, made here, so the runner treats it like any other:
//! a worktree cut from its first commit, and plxd's commit when the CLI ends. The repository
//! is plxd's, not the user's, so it gets a local identity for those commits.

use std::path::Path;

use super::{WorktreeError, WorktreeManager};

/// The branch a scratch repository starts on.
const BRANCH: &str = "main";

/// The identity of commits in a scratch repository.
const NAME: &str = "parallax";
const EMAIL: &str = "parallax@localhost";

impl WorktreeManager {
    /// Makes `path` a git repository with one empty commit on `main`, unless it already is one
    /// with a commit, as after a retried `thread/start`.
    ///
    /// # Errors
    ///
    /// [`WorktreeError::Io`] creating the folder, or [`WorktreeError::GitFailed`],
    /// [`WorktreeError::Timeout`], or [`WorktreeError::Spawn`] from running git.
    pub async fn init_scratch(&self, path: &Path) -> Result<(), WorktreeError> {
        super::create_dir_all(path).await?;
        if path.join(".git").is_dir()
            && self
                .run_git(path, &["rev-parse", "--verify", "--quiet", "HEAD"])
                .await?
                .success()
        {
            return Ok(());
        }
        let head = format!("refs/heads/{BRANCH}");
        self.run_git_ok(path, &["init", "--quiet"]).await?;
        self.run_git_ok(path, &["symbolic-ref", "HEAD", &head])
            .await?;
        self.run_git_ok(path, &["config", "user.name", NAME])
            .await?;
        self.run_git_ok(path, &["config", "user.email", EMAIL])
            .await?;
        self.run_git_ok(
            path,
            &[
                "-c",
                super::NO_HOOKS,
                "commit",
                "--quiet",
                "--allow-empty",
                "--no-gpg-sign",
                "-m",
                "Start a parallax scratch folder",
            ],
        )
        .await
        .map(drop)
    }

    /// Fetches `commit` and what it needs from the repository at `from` into the scratch
    /// repository at `path`, so a fork of a thread with no repo can cut its worktree from its
    /// parent's latest commit (0050).
    ///
    /// # Errors
    ///
    /// [`WorktreeError::GitFailed`], [`WorktreeError::Timeout`], or [`WorktreeError::Spawn`]
    /// from running git.
    pub async fn fetch_commit(
        &self,
        path: &Path,
        from: &Path,
        commit: &str,
    ) -> Result<(), WorktreeError> {
        let from = from.to_string_lossy();
        self.run_git_ok(
            path,
            &["fetch", "--quiet", "--no-tags", "--", &from, commit],
        )
        .await
        .map(drop)
    }
}
