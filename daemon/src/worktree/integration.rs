//! A Project's integration branch and its worktree (PLX-409, decision 0045).
//!
//! Each Project has one integration branch, `parallax/<project slug>`, cut from its base branch.
//! plxd keeps it checked out in a worktree of its own, `<data dir>/integration/<project id>`,
//! outside [`WorktreeManager::root`] so `gc_orphans` never takes it for a run's. Only the landing
//! queue (PLX-410) writes there. A child's worktree is cut from the branch's tip.

use std::io;
use std::path::{Path, PathBuf};

use parallax_protocol::ProjectId;
use tracing::warn;

use super::{WorktreeError, WorktreeManager, short_hash, valid_branch_slug};

impl WorktreeManager {
    /// The folder of `project`'s integration worktree.
    #[must_use]
    pub fn integration_path(&self, project: ProjectId) -> PathBuf {
        self.integration_root.join(project.to_string())
    }

    /// The repository's default branch: the one `origin/HEAD` names, or with no `origin/HEAD`,
    /// the branch checked out.
    ///
    /// # Errors
    ///
    /// [`WorktreeError::UnknownRevision`] when there is neither, or a git failure.
    pub async fn default_branch(&self, repo_path: &Path) -> Result<String, WorktreeError> {
        let refs = self.refs(repo_path).await?;
        refs.iter()
            .find(|r| r.default)
            .or_else(|| refs.iter().find(|r| r.current))
            .map(|r| r.name.clone())
            .ok_or_else(|| WorktreeError::UnknownRevision {
                repo: repo_path.to_owned(),
                reference: "the default branch".to_owned(),
                detail: "there is no origin/HEAD, and HEAD is detached".to_owned(),
            })
    }

    /// Makes sure `project`'s integration worktree exists on its branch, and returns the branch.
    ///
    /// A worktree already in place keeps the branch it has out, or `branch` while the landing
    /// queue has it detached for the checks (PLX-411). Otherwise the branch is `branch`
    /// when plxd recorded one, or a new `parallax/<slug of name>`, with the project id's short
    /// hash after it when another branch has that name. A branch that exists is checked out as it
    /// is, and a missing one is cut from `base`, which must be a local or remote-tracking branch.
    /// A checkout that fails removes the worktree again and keeps the branch.
    ///
    /// # Errors
    ///
    /// [`WorktreeError::NotAGitRepo`], [`WorktreeError::UnknownRevision`] when `base` isn't a
    /// branch, or a git or filesystem failure.
    pub async fn ensure_integration(
        &self,
        repo_path: &Path,
        project: ProjectId,
        branch: Option<&str>,
        name: &str,
        base: &str,
    ) -> Result<String, WorktreeError> {
        let repo_root = self.repo_root(repo_path).await?;
        let path = self.integration_path(project);
        let guard = self.lock_repo(&repo_root).await;
        if path.join(".git").is_file() {
            let head = self
                .run_git(&path, &["symbolic-ref", "--quiet", "--short", "HEAD"])
                .await?;
            if head.success() {
                return Ok(head.stdout.trim().to_owned());
            }
            // Detached at a merge whose checks are running (PLX-411): the branch is still there.
            if let Some(branch) = branch
                && self
                    .has_ref(&repo_root, &format!("refs/heads/{branch}"))
                    .await?
            {
                return Ok(branch.to_owned());
            }
        }
        // A folder that isn't a worktree on a branch is plxd's own leftover.
        remove_folder(&path).await?;
        self.run_git_ok(&repo_root, &["worktree", "prune"]).await?;
        if let Some(parent) = path.parent() {
            tokio::fs::create_dir_all(parent)
                .await
                .map_err(|source| WorktreeError::Io {
                    path: parent.to_owned(),
                    source,
                })?;
        }

        let branch = if let Some(branch) = branch {
            branch.to_owned()
        } else {
            let named = format!("parallax/{}", slug(name));
            if self
                .has_ref(&repo_root, &format!("refs/heads/{named}"))
                .await?
            {
                format!("{named}-{}", short_hash(&project.to_string()))
            } else {
                named
            }
        };
        let path_arg = path.to_string_lossy().into_owned();
        if self
            .has_ref(&repo_root, &format!("refs/heads/{branch}"))
            .await?
        {
            self.run_git_ok(
                &repo_root,
                &["worktree", "add", "--no-checkout", &path_arg, &branch],
            )
            .await?;
        } else {
            // A sha, a tag, or `HEAD~1` isn't a base a PR can target (0045).
            if !self
                .has_ref(&repo_root, &format!("refs/heads/{base}"))
                .await?
                && !self
                    .has_ref(&repo_root, &format!("refs/remotes/{base}"))
                    .await?
            {
                return Err(WorktreeError::UnknownRevision {
                    repo: repo_root,
                    reference: base.to_owned(),
                    detail: "it is not a local or remote-tracking branch".to_owned(),
                });
            }
            let commit = self.resolve_commit(&repo_root, base).await?;
            self.run_git_ok(
                &repo_root,
                &[
                    "worktree",
                    "add",
                    "--no-checkout",
                    "-b",
                    &branch,
                    &path_arg,
                    &commit,
                ],
            )
            .await?;
        }
        // The checkout, the slow part, runs outside the repo lock, as a run's does.
        drop(guard);
        if let Err(error) = self
            .run_git_ok(&path, &["reset", "--hard", "--quiet"])
            .await
        {
            if let Err(cleanup) = self.remove_integration(&repo_root, project).await {
                warn!(path = %path.display(), %cleanup, "could not remove an integration worktree whose checkout failed");
            }
            return Err(error);
        }
        Ok(branch)
    }

    /// Removes `project`'s integration worktree, keeping its branch. A repository that is gone
    /// leaves only the folder to remove.
    ///
    /// # Errors
    ///
    /// A filesystem failure removing the folder.
    pub async fn remove_integration(
        &self,
        repo_path: &Path,
        project: ProjectId,
    ) -> Result<(), WorktreeError> {
        self.remove_linked(repo_path, &self.integration_path(project))
            .await
    }

    /// Removes the worktree of `repo_path` at `path`, an integration or a coordinator worktree,
    /// keeping any branch. A repository that is gone leaves only the folder to remove.
    pub(super) async fn remove_linked(
        &self,
        repo_path: &Path,
        path: &Path,
    ) -> Result<(), WorktreeError> {
        if let Ok(repo_root) = self.repo_root(repo_path).await {
            let _guard = self.lock_repo(&repo_root).await;
            let path_arg = path.to_string_lossy().into_owned();
            if let Err(error) = self
                .run_git_ok(&repo_root, &["worktree", "remove", "--force", &path_arg])
                .await
                && path.exists()
            {
                warn!(path = %path.display(), %error, "could not remove a worktree with git");
            }
            remove_folder(path).await?;
            let _ = self.run_git(&repo_root, &["worktree", "prune"]).await;
        } else {
            remove_folder(path).await?;
        }
        Ok(())
    }
}

/// Removes `path` and everything in it, if it exists.
async fn remove_folder(path: &Path) -> Result<(), WorktreeError> {
    match tokio::fs::remove_dir_all(path).await {
        Err(source) if source.kind() != io::ErrorKind::NotFound => Err(WorktreeError::Io {
            path: path.to_owned(),
            source,
        }),
        _ => Ok(()),
    }
}

/// A project name as a branch slug ([`valid_branch_slug`]): lowercase letters and digits, with
/// one hyphen for each run of anything else, cut to 40 characters. `project` when nothing is left.
pub(super) fn slug(name: &str) -> String {
    let mut slug = String::new();
    for c in name.chars() {
        if c.is_ascii_alphanumeric() {
            slug.push(c.to_ascii_lowercase());
        } else if !slug.is_empty() && !slug.ends_with('-') {
            slug.push('-');
        }
    }
    slug.truncate(40);
    let slug = slug.trim_end_matches('-');
    if valid_branch_slug(slug) {
        slug.to_owned()
    } else {
        "project".to_owned()
    }
}
