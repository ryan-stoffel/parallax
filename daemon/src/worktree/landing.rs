//! The git side of landing a Project's children on its integration branch (PLX-410, decision
//! 0045). The queue itself is [`crate::methods::land`].
//!
//! A merge is built in the object store with `git merge-tree --write-tree` and committed with
//! `git commit-tree`, so a conflict changes neither the branch nor its worktree. Only a clean
//! result moves the branch, with `reset --hard` in the integration worktree, which only the
//! landing queue writes. Every call runs with hooks off, as all of plxd's git calls do.

use std::path::Path;
use std::time::Duration;

use parallax_protocol::ProjectId;
use tracing::warn;

use super::review::z_tokens;
use super::{WorktreeError, WorktreeManager, describe_failure, owned_args};

/// How long fetching the base branch may take.
const FETCH_TIMEOUT: Duration = Duration::from_mins(2);

/// How merging into an integration branch went.
#[derive(Debug, PartialEq, Eq)]
pub enum Merged {
    /// The branch moved to this commit.
    Commit(String),
    /// The branch already had all of it, so nothing changed.
    Unchanged,
    /// These paths conflict, so nothing changed.
    Conflict(Vec<String>),
}

impl WorktreeManager {
    /// Puts `project`'s integration worktree back on its branch's tip, dropping whatever a
    /// landing that plxd's stop interrupted left behind, and returns the tip.
    ///
    /// # Errors
    ///
    /// A git failure.
    pub async fn integration_tip(&self, project: ProjectId) -> Result<String, WorktreeError> {
        let path = self.integration_path(project);
        self.run_git_ok(&path, &["reset", "--hard", "--quiet", "HEAD"])
            .await?;
        self.run_git_ok(&path, &["clean", "-fd", "--quiet"]).await?;
        let tip = self.run_git_ok(&path, &["rev-parse", "HEAD"]).await?;
        Ok(tip.trim().to_owned())
    }

    /// The commit `base` names in `repo_path`'s repository, after fetching it when it is a
    /// remote-tracking branch such as `origin/main`. A fetch that fails, as offline, is logged,
    /// and the last fetched commit is used.
    ///
    /// # Errors
    ///
    /// [`WorktreeError::UnknownRevision`] when `base` names nothing, or a git failure.
    pub async fn fetch_base(&self, repo_path: &Path, base: &str) -> Result<String, WorktreeError> {
        let repo_root = self.repo_root(repo_path).await?;
        if !self
            .has_ref(&repo_root, &format!("refs/heads/{base}"))
            .await?
            && self
                .has_ref(&repo_root, &format!("refs/remotes/{base}"))
                .await?
            && let Some((remote, branch)) = base.split_once('/')
        {
            let refspec = format!("+refs/heads/{branch}:refs/remotes/{remote}/{branch}");
            let args = ["fetch", "--quiet", "--no-tags", "--", remote, &refspec];
            match self.run_git_for(&repo_root, &args, FETCH_TIMEOUT).await {
                Ok(output) if output.success() => {}
                Ok(output) => {
                    warn!(base, detail = %describe_failure(&output), "could not fetch a Project's base branch");
                }
                Err(error) => warn!(base, %error, "could not fetch a Project's base branch"),
            }
        }
        self.resolve_commit(&repo_root, base).await
    }

    /// Whether `commit` is already in the history of `project`'s integration branch at `tip`.
    ///
    /// # Errors
    ///
    /// A git failure.
    pub async fn integration_has(
        &self,
        project: ProjectId,
        tip: &str,
        commit: &str,
    ) -> Result<bool, WorktreeError> {
        self.is_ancestor(&self.integration_path(project), commit, tip)
            .await
    }

    /// Merges `theirs` into `project`'s integration branch at `tip`, with `message`. A squash
    /// commits the result with `tip` as its only parent; otherwise it is a merge commit of both.
    ///
    /// # Errors
    ///
    /// [`WorktreeError::MissingIdentity`] when the repository has no `user.name` and
    /// `user.email`, or a git failure.
    pub async fn merge_into_integration(
        &self,
        project: ProjectId,
        tip: &str,
        theirs: &str,
        message: &str,
        squash: bool,
    ) -> Result<Merged, WorktreeError> {
        let path = self.integration_path(project);
        let args = [
            "merge-tree",
            "--write-tree",
            "--name-only",
            "--no-messages",
            "-z",
            tip,
            theirs,
        ];
        let merged = self.run_git(&path, &args).await?;
        match merged.exit.info.code {
            Some(0) => {}
            Some(1) => {
                let mut paths: Vec<String> = z_tokens(&merged.stdout)
                    .skip(1)
                    .map(str::to_owned)
                    .collect();
                paths.dedup();
                return Ok(Merged::Conflict(paths));
            }
            _ => {
                return Err(WorktreeError::GitFailed {
                    cwd: path,
                    args: owned_args(&args),
                    detail: describe_failure(&merged),
                });
            }
        }
        let tree = z_tokens(&merged.stdout)
            .next()
            .unwrap_or_default()
            .trim()
            .to_owned();
        let tip_tree = self
            .run_git_ok(&path, &["rev-parse", &format!("{tip}^{{tree}}")])
            .await?;
        if tree == tip_tree.trim() {
            return Ok(Merged::Unchanged);
        }
        // The identity the user's checkout configures, passed explicitly, as a run's commit is.
        let Some((name, email)) = self.resolve_identity(&path).await? else {
            return Err(WorktreeError::MissingIdentity { repo: path });
        };
        let (name, email) = (format!("user.name={name}"), format!("user.email={email}"));
        let mut commit_args = vec![
            "-c",
            &name,
            "-c",
            &email,
            "commit-tree",
            "--no-gpg-sign",
            &tree,
            "-p",
            tip,
        ];
        if !squash {
            commit_args.extend(["-p", theirs]);
        }
        commit_args.extend(["-m", message]);
        let commit = self.run_git_ok(&path, &commit_args).await?;
        let commit = commit.trim().to_owned();
        self.run_git_ok(&path, &["reset", "--hard", "--quiet", &commit])
            .await?;
        Ok(Merged::Commit(commit))
    }

    /// The lines `theirs` adds since its merge base with `tip` that hold a leftover conflict
    /// marker, as `path:line`, from `git diff --check` in `project`'s integration worktree, when
    /// `theirs` has a merge commit `tip` lacks, as a child that resolved a conflict by merging an
    /// integration tip has. Otherwise none: a marker-like line is ordinary text in a child that
    /// never merged. Whitespace errors `git diff --check` also reports are ignored.
    ///
    /// # Errors
    ///
    /// A git failure.
    pub async fn conflict_markers(
        &self,
        project: ProjectId,
        tip: &str,
        theirs: &str,
    ) -> Result<Vec<String>, WorktreeError> {
        let path = self.integration_path(project);
        let since = format!("{tip}..{theirs}");
        let merges = self
            .run_git_ok(&path, &["rev-list", "--merges", "--max-count=1", &since])
            .await?;
        if merges.trim().is_empty() {
            return Ok(Vec::new());
        }
        // From the merge base, so what other children landed on `tip` isn't counted.
        let range = format!("{tip}...{theirs}");
        let args = ["diff", "--check", "--no-ext-diff", "--no-textconv", &range];
        let checked = self.run_git(&path, &args).await?;
        // A problem found exits non-zero with it on stdout; a git failure prints nothing there.
        if !checked.success() && checked.stdout.trim().is_empty() {
            return Err(WorktreeError::GitFailed {
                cwd: path,
                args: owned_args(&args),
                detail: describe_failure(&checked),
            });
        }
        Ok(checked
            .stdout
            .lines()
            .filter_map(|line| line.strip_suffix(": leftover conflict marker"))
            .map(str::to_owned)
            .collect())
    }

    /// Starts merging `tip` into a child's worktree, leaving conflict markers in its files for it
    /// to resolve, so it edits files and never runs git, as a child is told. The merge stays in
    /// progress, so the commit plxd makes when its turn ends ([`WorktreeManager::commit_all`])
    /// concludes it. Runs through #166's hardened worktree calls.
    ///
    /// # Errors
    ///
    /// A git failure, or git refusing to start the merge, as when the child's uncommitted
    /// changes touch the files it would change, or a merge of anything but `tip` in progress.
    pub async fn start_merge(
        &self,
        worktree_path: &Path,
        git_dir: &Path,
        tip: &str,
    ) -> Result<(), WorktreeError> {
        let args = ["merge", "--no-ff", "--no-commit", tip];
        let merged = self.run_worktree_git(worktree_path, git_dir, &args).await?;
        let started = self
            .run_worktree_git(
                worktree_path,
                git_dir,
                &["rev-parse", "--quiet", "--verify", "MERGE_HEAD"],
            )
            .await?;
        if started.stdout.trim() != tip {
            return Err(WorktreeError::GitFailed {
                cwd: worktree_path.to_owned(),
                args: owned_args(&args),
                detail: describe_failure(&merged),
            });
        }
        Ok(())
    }

    /// Aborts the merge [`WorktreeManager::start_merge`] started in a child's worktree.
    ///
    /// # Errors
    ///
    /// A git failure.
    pub async fn abort_merge(
        &self,
        worktree_path: &Path,
        git_dir: &Path,
    ) -> Result<(), WorktreeError> {
        self.run_worktree_git_ok(worktree_path, git_dir, &["merge", "--abort"])
            .await?;
        Ok(())
    }
}
