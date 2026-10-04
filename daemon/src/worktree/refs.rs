//! A repository's branches, for `repo/refs`, and switching the user's checkout to one before a
//! Current checkout thread starts (`thread/start`'s `checkoutRef`).

use std::path::Path;

use parallax_protocol::RepoRef;

use super::{WorktreeError, WorktreeManager, describe_failure, owned_args};

impl WorktreeManager {
    /// The local and remote-tracking branches of `repo_path`'s repository, from one
    /// `git for-each-ref`: the default branch first, then the most recently committed first.
    /// `origin/HEAD` names the default branch and isn't listed itself.
    ///
    /// # Errors
    ///
    /// [`WorktreeError::NotAGitRepo`], or [`WorktreeError::GitFailed`],
    /// [`WorktreeError::Timeout`], or [`WorktreeError::Spawn`].
    pub async fn refs(&self, repo_path: &Path) -> Result<Vec<RepoRef>, WorktreeError> {
        let repo_root = self.repo_root(repo_path).await?;
        // A ref name has no spaces, so a space ends every field but the last, a worktree's path.
        let output = self
            .run_git_ok(
                &repo_root,
                &[
                    "for-each-ref",
                    "--sort=-committerdate",
                    "--format=%(HEAD)%(refname) %(symref) %(worktreepath)",
                    "refs/heads",
                    "refs/remotes",
                ],
            )
            .await?;
        Ok(parse_refs(&output))
    }

    /// Switches `repo_path`'s checkout to `reference` with `git switch`, never forced: git refuses
    /// rather than overwrite local changes or take a branch another worktree has out. A
    /// remote-tracking ref such as `origin/foo` switches to the local `foo`, made to track it
    /// when missing. Switching to the branch already out changes nothing.
    ///
    /// # Errors
    ///
    /// [`WorktreeError::GitFailed`] with git's reason when it refuses, or
    /// [`WorktreeError::NotAGitRepo`], [`WorktreeError::Timeout`], or [`WorktreeError::Spawn`].
    pub async fn switch(&self, repo_path: &Path, reference: &str) -> Result<(), WorktreeError> {
        let repo_root = self.repo_root(repo_path).await?;
        let _guard = self.lock_repo(&repo_root).await;
        let root = repo_root.as_path();
        let mut args = vec!["switch", reference];
        // ponytail: the local name is what follows the first slash, so a remote whose name has a
        // slash maps wrong; read the remote's fetch refspec if one turns up.
        if !self
            .has_ref(root, &format!("refs/heads/{reference}"))
            .await?
            && self
                .has_ref(root, &format!("refs/remotes/{reference}"))
                .await?
            && let Some((_, local)) = reference.split_once('/')
        {
            args = if self.has_ref(root, &format!("refs/heads/{local}")).await? {
                vec!["switch", local]
            } else {
                vec!["switch", "--track", reference]
            };
        }
        // A switch rewrites the working tree, which can take as long as Accept's checkout.
        let output = self
            .run_git_for(&repo_root, &args, self.merge_timeout)
            .await?;
        if !output.success() {
            return Err(WorktreeError::GitFailed {
                cwd: repo_root,
                args: owned_args(&args),
                detail: describe_failure(&output),
            });
        }
        Ok(())
    }

    /// Whether `name`, a full ref name, exists in `repo_root`.
    pub(super) async fn has_ref(
        &self,
        repo_root: &Path,
        name: &str,
    ) -> Result<bool, WorktreeError> {
        let args = ["show-ref", "--verify", "--quiet", name];
        Ok(self.run_git(repo_root, &args).await?.success())
    }
}

/// Parses `for-each-ref`'s `%(HEAD)%(refname) %(symref) %(worktreepath)` lines, in their order,
/// with the default branch moved first.
fn parse_refs(output: &str) -> Vec<RepoRef> {
    let mut default = None;
    let mut refs = Vec::new();
    for line in output.lines() {
        let Some((head, rest)) = line.split_at_checked(1) else {
            continue;
        };
        let mut fields = rest.splitn(3, ' ');
        let (Some(full), Some(symref)) = (fields.next(), fields.next()) else {
            continue;
        };
        let checked_out = !fields.next().unwrap_or_default().is_empty();
        let (name, remote) = if let Some(name) = full.strip_prefix("refs/heads/") {
            (name, false)
        } else if let Some(name) = full.strip_prefix("refs/remotes/") {
            // A remote's HEAD only points at its default branch.
            if !symref.is_empty() {
                if name == "origin/HEAD" {
                    default = symref.strip_prefix("refs/remotes/");
                }
                continue;
            }
            (name, true)
        } else {
            continue;
        };
        let current = head == "*";
        refs.push(RepoRef {
            name: name.to_owned(),
            remote,
            default: false,
            current,
            worktree: checked_out && !current,
        });
    }
    // The local branch of `origin/HEAD`'s, or the remote-tracking one when there is none.
    let local = default
        .and_then(|remote| remote.split_once('/'))
        .map(|(_, local)| local);
    let found = refs
        .iter()
        .position(|r| !r.remote && Some(r.name.as_str()) == local)
        .or_else(|| refs.iter().position(|r| Some(r.name.as_str()) == default));
    if let Some(i) = found {
        let mut first = refs.remove(i);
        first.default = true;
        refs.insert(0, first);
    }
    refs
}
