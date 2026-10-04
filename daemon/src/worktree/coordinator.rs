//! A Project's coordinator's worktree (PLX-397, decision 0042): a detached worktree of the
//! Project's repository at `<data dir>/coordinators/<project id>`, which plxd moves to the
//! integration branch's tip before each of the coordinator's CLI processes, as PLX-171's was
//! moved to `HEAD` (0024). It is never committed, so nothing the coordinator writes there reaches
//! the user's checkout or the integration branch.
//!
//! The coordinator runs in Auto or Bypass Permissions, so it can rewrite the folder's `.git` file
//! as it can run any command as the user (0027, 0042). Refreshing it trusts that file no more
//! than the coordinator could already act.

use std::path::{Path, PathBuf};

use parallax_protocol::ProjectId;
use tracing::warn;

use super::{WorktreeError, WorktreeManager, is_real_dir};

impl WorktreeManager {
    /// The folder of `project`'s coordinator's worktree.
    #[must_use]
    pub fn coordinator_path(&self, project: ProjectId) -> PathBuf {
        self.coordinator_root.join(project.to_string())
    }

    /// Makes `project`'s coordinator's worktree a detached checkout of `reference`'s commit in
    /// `repo_path`, and returns the folder. An existing worktree is checked out again with
    /// `--force`, and every untracked and ignored file is removed. When that can't be done in
    /// place, because the folder has no `.git` file (so git would look above it for a repository)
    /// or git fails there, the folder is removed and added again. A symlink is refused, never
    /// followed.
    ///
    /// # Errors
    ///
    /// [`WorktreeError::NotAGitRepo`], [`WorktreeError::UnknownRevision`] when `reference` names
    /// no commit, or a git or filesystem failure adding it.
    pub async fn refresh_coordinator(
        &self,
        repo_path: &Path,
        project: ProjectId,
        reference: &str,
    ) -> Result<PathBuf, WorktreeError> {
        let path = self.coordinator_path(project);
        let repo_root = self.repo_root(repo_path).await?;
        let _guard = self.lock_repo(&repo_root).await;
        let commit = self.resolve_commit(&repo_root, reference).await?;
        if is_real_dir(&path).await
            && tokio::fs::symlink_metadata(path.join(".git"))
                .await
                .is_ok_and(|meta| meta.is_file())
        {
            let refreshed = async {
                self.run_git_ok(
                    &path,
                    &["checkout", "--quiet", "--force", "--detach", &commit],
                )
                .await?;
                self.run_git_ok(&path, &["clean", "-ffdxq"]).await
            }
            .await;
            match refreshed {
                Ok(_) => return Ok(path),
                Err(error) => {
                    warn!(path = %path.display(), %error, "could not refresh a coordinator's worktree; adding it again");
                }
            }
        }
        if tokio::fs::symlink_metadata(&path).await.is_ok() {
            self.remove_orphan(&path).await?;
        }
        tokio::fs::create_dir_all(&self.coordinator_root)
            .await
            .map_err(|source| WorktreeError::Io {
                path: self.coordinator_root.clone(),
                source,
            })?;
        let path_arg = path.to_string_lossy().into_owned();
        // `--force`: a removed folder can still be registered, with a stale `index.lock`.
        self.run_git_ok(
            &repo_root,
            &[
                "worktree", "add", "--quiet", "--force", "--detach", &path_arg, &commit,
            ],
        )
        .await?;
        Ok(path)
    }

    /// Removes `project`'s coordinator's worktree. A repository that is gone leaves only the
    /// folder to remove.
    ///
    /// # Errors
    ///
    /// A filesystem failure removing the folder.
    pub async fn remove_coordinator(
        &self,
        repo_path: &Path,
        project: ProjectId,
    ) -> Result<(), WorktreeError> {
        self.remove_linked(repo_path, &self.coordinator_path(project))
            .await
    }
}
