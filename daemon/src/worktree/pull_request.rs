//! Opening a pull request from a run's branch (RYA-168).
//!
//! [`WorktreeManager::open_pr`] works in the user's own checkout, as the user. It pushes the run's
//! branch to `origin` with [`WorktreeManager::push`], setting its upstream. Then `gh`, with its own
//! sign-in, returns the branch's open pull request, or opens one against the GitHub repository's
//! default branch. `gh` is found on the same `PATH` as every other tool plxd runs.

use std::ffi::OsString;
use std::path::Path;

use tokio::time::timeout;

use super::folder::NETWORK_TIMEOUT;
use super::{WorktreeManager, collect};
use crate::backend::process::{ProcessSpec, SpawnError, StdinMode};

/// `gh`'s exit code when it isn't signed in.
const GH_AUTH_REQUIRED: i32 = 4;

/// Why [`WorktreeManager::open_pr`] failed. Each message says what to do, with the command's
/// stderr.
#[derive(Debug, thiserror::Error)]
pub enum PrError {
    /// The repository has no `origin`, or pushing to it failed.
    #[error("{0}")]
    Push(String),
    /// `gh` isn't installed, or isn't signed in.
    #[error("{0}")]
    GhUnavailable(String),
    /// `gh` failed otherwise.
    #[error("{0}")]
    Gh(String),
}

impl WorktreeManager {
    /// Pushes `branch` from `repo_path`'s repository to its `origin`, then returns the URL of the
    /// branch's open pull request there, opening one with `title` and `body` if it has none.
    ///
    /// # Errors
    ///
    /// [`PrError`]: the push failed, or `gh` is missing, not signed in, or failed.
    pub async fn open_pr(
        &self,
        repo_path: &Path,
        branch: &str,
        title: &str,
        body: &str,
    ) -> Result<String, PrError> {
        let origin = self
            .push(repo_path, branch)
            .await
            .map_err(|error| PrError::Push(error.0))?;
        // `--flag=value`, so a value is never read as a flag.
        let repo = format!("--repo={}", without_userinfo(&origin));
        let head = format!("--head={branch}");
        let open = self
            .gh(
                repo_path,
                &[
                    "pr",
                    "list",
                    &repo,
                    &head,
                    "--state=open",
                    "--json=url,isCrossRepository",
                ],
            )
            .await?;
        let open: Vec<Listed> = serde_json::from_str(&open)
            .map_err(|error| PrError::Gh(format!("could not read gh pr list's answer: {error}")))?;
        // A fork's pull request from a branch of the same name isn't this branch's.
        if let Some(listed) = open.into_iter().find(|pr| !pr.is_cross_repository) {
            return Ok(listed.url);
        }
        let title = format!("--title={title}");
        let body = format!("--body={body}");
        let created = self
            .gh(repo_path, &["pr", "create", &repo, &head, &title, &body])
            .await?;
        // gh prints the new pull request's URL last, on stdout.
        created
            .lines()
            .map(str::trim)
            .rfind(|line| line.starts_with("https://"))
            .map(str::to_owned)
            .ok_or_else(|| PrError::Gh("gh pr create printed no pull request URL".to_owned()))
    }

    /// Runs `gh args` in `repo_root` and returns its stdout, turning a missing `gh`, a sign-in
    /// it needs, and any other failure into a [`PrError`].
    async fn gh(&self, repo_root: &Path, args: &[&str]) -> Result<String, PrError> {
        let mut spec = ProcessSpec::new("gh", repo_root);
        spec.args = args.iter().map(OsString::from).collect();
        spec.inject.set("GH_PROMPT_DISABLED", "1");
        spec.stdin = StdinMode::Null;
        let process = match self.launcher.spawn(&spec) {
            Ok(process) => process,
            Err(error @ SpawnError::NotFound { .. }) => {
                return Err(PrError::GhUnavailable(format!(
                    "GitHub CLI isn't installed on the host: {error}. Install gh, then run \
                     `gh auth login`"
                )));
            }
            Err(error) => return Err(PrError::Gh(format!("could not run gh: {error}"))),
        };
        // Such as `gh pr create`, without the values.
        let command = format!("gh {}", args.get(..2).unwrap_or(args).join(" "));
        let Ok(collected) = timeout(NETWORK_TIMEOUT, collect(process, repo_root, args)).await
        else {
            return Err(PrError::Gh(format!(
                "`{command}` timed out after {NETWORK_TIMEOUT:?}"
            )));
        };
        let (stdout, exit) = collected.map_err(|error| PrError::Gh(error.to_string()))?;
        if exit.info.code == Some(GH_AUTH_REQUIRED) {
            return Err(PrError::GhUnavailable(format!(
                "GitHub CLI isn't signed in on the host; run `gh auth login` there: {}",
                exit.stderr_tail
            )));
        }
        if !exit.info.success() {
            let why = if exit.stderr_tail.is_empty() {
                format!("it exited {:?} with no stderr", exit.info)
            } else {
                exit.stderr_tail
            };
            return Err(PrError::Gh(format!("`{command}` failed: {why}")));
        }
        Ok(String::from_utf8_lossy(&stdout).into_owned())
    }
}

/// One pull request in `gh pr list --json=url,isCrossRepository`.
#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct Listed {
    url: String,
    is_cross_repository: bool,
}

/// `url` without its userinfo (`https://user:token@host/path` becomes `https://host/path`), so a
/// credential kept in the remote's URL never reaches `gh`'s argv. An scp-like `git@host:path`
/// stays as it is: it can't hold a password.
fn without_userinfo(url: &str) -> String {
    let Some((scheme, rest)) = url.split_once("://") else {
        return url.to_owned();
    };
    let authority = &rest[..rest.find('/').unwrap_or(rest.len())];
    match authority.rfind('@') {
        Some(at) => format!("{scheme}://{}", &rest[at + 1..]),
        None => url.to_owned(),
    }
}

#[cfg(test)]
mod tests {
    use super::without_userinfo;

    #[test]
    fn a_remote_url_loses_its_userinfo() {
        assert_eq!(
            without_userinfo("https://me:ghp_secret@github.com/me/app.git"),
            "https://github.com/me/app.git"
        );
        assert_eq!(
            without_userinfo("ssh://git@github.com/me/app.git"),
            "ssh://github.com/me/app.git"
        );
        for kept in [
            "https://github.com/me/app.git",
            "https://github.com/me/a@b.git",
            "git@github.com:me/app.git",
            "/srv/git/app.git",
        ] {
            assert_eq!(without_userinfo(kept), kept);
        }
    }
}
