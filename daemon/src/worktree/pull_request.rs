//! Opening a pull request from a run's branch (RYA-168).
//!
//! [`WorktreeManager::open_pr`] works in the user's own checkout, as the user. It pushes the run's
//! branch to `origin` through [`WorktreeManager::run_git`], so git uses the user's own
//! configuration and credential helpers, runs no hooks, and never prompts. Then `gh`, with its own
//! sign-in, returns the branch's open pull request, or opens one against the GitHub repository's
//! default branch. `gh` is found on the same `PATH` as every other tool wispd runs.

use std::ffi::OsString;
use std::path::Path;
use std::time::Duration;

use tokio::time::timeout;

use super::{WorktreeManager, collect, describe_failure};
use crate::backend::process::{ProcessSpec, SpawnError, StdinMode};

/// How long the push, and each `gh` call, may take: both go over the network, and a push can
/// carry a large branch.
const NETWORK_TIMEOUT: Duration = Duration::from_secs(300);

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
        let push_error = |error: super::WorktreeError| PrError::Push(error.to_string());
        let repo_root = self.repo_root(repo_path).await.map_err(push_error)?;
        let origin = self
            .run_git(&repo_root, &["remote", "get-url", "origin"])
            .await
            .map_err(push_error)?;
        if !origin.success() {
            return Err(PrError::Push(format!(
                "{} has no origin to push to: {}",
                repo_root.display(),
                describe_failure(&origin)
            )));
        }
        let origin = origin.stdout.trim().to_owned();
        let refspec = format!("refs/heads/{branch}:refs/heads/{branch}");
        let push = self
            .run_git_for(&repo_root, &["push", "origin", &refspec], NETWORK_TIMEOUT)
            .await
            .map_err(push_error)?;
        if !push.success() {
            return Err(PrError::Push(format!(
                "could not push {branch} to origin: {}",
                describe_failure(&push)
            )));
        }

        // `--flag=value`, so a value is never read as a flag.
        let repo = format!("--repo={origin}");
        let head = format!("--head={branch}");
        let open = self
            .gh(
                &repo_root,
                &["pr", "list", &repo, &head, "--state=open", "--json=url"],
            )
            .await?;
        let open: Vec<Listed> = serde_json::from_str(&open)
            .map_err(|error| PrError::Gh(format!("could not read gh pr list's answer: {error}")))?;
        if let Some(listed) = open.into_iter().next() {
            return Ok(listed.url);
        }
        let title = format!("--title={title}");
        let body = format!("--body={body}");
        let created = self
            .gh(&repo_root, &["pr", "create", &repo, &head, &title, &body])
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

/// One pull request in `gh pr list --json=url`.
#[derive(serde::Deserialize)]
struct Listed {
    url: String,
}
