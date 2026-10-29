//! Opening a pull request from a run's branch (PLX-168).
//!
//! [`WorktreeManager::open_pr`] works in the user's own checkout, as the user. It pushes the run's
//! branch to `origin` with [`WorktreeManager::push`], setting its upstream. Then `gh`, with its own
//! sign-in, returns the branch's open pull request, or opens one against the GitHub repository's
//! default branch. `gh` is found on the same `PATH` as every other tool plxd runs.
//!
//! [`WorktreeManager::view_pr`] and [`WorktreeManager::act_pr`] read and change a run's linked pull
//! request by its URL (PLX-318), and [`WorktreeManager::diff_pr`] reads its diff (PLX-328), in
//! plxd's temp folder rather than any checkout, and [`github_pr_urls`] finds the pull requests an agent's `gh pr create` printed.
//! [`WorktreeManager::shared_diff`] reads a diff once per head for every run's `pull_request_diff`
//! (PLX-1021), and [`agent_diff`] cuts it to the paths the agent asked for.

use std::ffi::OsString;
use std::path::Path;
use std::sync::PoisonError;
use std::time::Duration;

use jiff::Timestamp;
use parallax_protocol::{
    PrAction, PrCheck, PrCheckState, PrComment, PrCommit, PrDiffResult, PrFile, PrMergeMethod,
    PrMergeState, PrReview, PrReviewState, PrState, PullRequest,
};
use serde::Deserialize;
use tokio::time::timeout;

use super::folder::NETWORK_TIMEOUT;
use super::{WorktreeManager, collect};
use crate::backend::process::{ProcessSpec, SpawnError, StdinMode};

/// `gh`'s exit code when it isn't signed in.
const GH_AUTH_REQUIRED: i32 = 4;

/// What `pr/view` asks `gh pr view` for: everything [`PullRequest`] has.
const VIEW_FIELDS: &str = "--json=number,title,url,state,isDraft,author,updatedAt,baseRefName,\
                           headRefName,changedFiles,additions,deletions,files,body,comments,reviews,\
                           reviewRequests,labels,statusCheckRollup,mergeStateStatus,\
                           autoMergeRequest,createdAt,closedAt,mergedAt,mergedBy,commits";

/// The most of a pull request's diff `pr/diff` returns, so its answer fits one frame.
const MAX_DIFF_BYTES: usize = 2 * 1024 * 1024;

/// The most diffs [`WorktreeManager::shared_diff`] keeps, so at most 32 MiB.
const SHARED_DIFFS: usize = 16;

/// The longest [`WorktreeManager::shared_diff`] waits on GitHub, well under the 90 s plxd lets a
/// connection sit idle.
const SHARED_DIFF_TIMEOUT: Duration = Duration::from_mins(1);

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

    /// Pull request `url` as GitHub has it now.
    ///
    /// # Errors
    ///
    /// [`PrError`]: `gh` is missing, not signed in, or failed, or its answer can't be read.
    pub async fn view_pr(&self, url: &str) -> Result<PullRequest, PrError> {
        let viewed = self
            .gh(&std::env::temp_dir(), &["pr", "view", url, VIEW_FIELDS])
            .await?;
        parse_view(&viewed)
    }

    /// Pull request `url`'s state alone, a lighter read than [`Self::view_pr`] for the merge
    /// sweep (PLX-839).
    ///
    /// # Errors
    ///
    /// [`PrError`]: `gh` is missing, not signed in, or failed.
    pub async fn pr_state(&self, url: &str) -> Result<PrState, PrError> {
        let viewed = self
            .gh(
                &std::env::temp_dir(),
                &["pr", "view", url, "--json=state", "--jq=.state"],
            )
            .await?;
        Ok(pr_state(viewed.trim()))
    }

    /// Pull request `url`'s unified diff, cut at a line's end at [`MAX_DIFF_BYTES`].
    ///
    /// # Errors
    ///
    /// [`PrError`]: `gh` is missing, not signed in, or failed.
    pub async fn diff_pr(&self, url: &str) -> Result<PrDiffResult, PrError> {
        let diff = self
            .gh(&std::env::temp_dir(), &["pr", "diff", url, "--color=never"])
            .await?;
        Ok(cap_diff(diff, MAX_DIFF_BYTES))
    }

    /// Pull request `url`'s diff as [`Self::diff_pr`] reads it, shared by every caller while its
    /// head stays the same: a call for a head already read costs one `gh pr view` of the head,
    /// not a second `gh pr diff`.
    ///
    /// # Errors
    ///
    /// [`PrError`]: `gh` is missing, not signed in, or failed, or GitHub took longer than
    /// [`SHARED_DIFF_TIMEOUT`].
    // ponytail: reads the head with its own call; take it from pr_watch's shared read (PLX-1018)
    // once that lands, so a hit costs nothing.
    pub async fn shared_diff(&self, url: &str) -> Result<PrDiffResult, PrError> {
        timeout(SHARED_DIFF_TIMEOUT, async {
            let head = self
                .gh(
                    &std::env::temp_dir(),
                    &["pr", "view", url, "--json=headRefOid", "--jq=.headRefOid"],
                )
                .await?;
            let key = format!("{url}@{}", head.trim());
            let diffs = || self.pr_diffs.lock().unwrap_or_else(PoisonError::into_inner);
            if let Some((_, diff)) = diffs().iter().find(|(read, _)| *read == key) {
                return Ok(diff.clone());
            }
            // A push between the head's read and this one keeps the newer head's diff under the
            // older head. Only a caller that still sees the older head is served it, and the
            // next read of the newer head misses and reads its own.
            let diff = self.diff_pr(url).await?;
            let mut kept = diffs();
            if kept.len() >= SHARED_DIFFS {
                kept.pop_front();
            }
            kept.push_back((key, diff.clone()));
            Ok(diff)
        })
        .await
        .unwrap_or_else(|_| {
            Err(PrError::Gh(format!(
                "GitHub didn't send the pull request's diff within {}s; try again",
                SHARED_DIFF_TIMEOUT.as_secs()
            )))
        })
    }

    /// Does `action` to pull request `url` and returns it as it is after.
    ///
    /// # Errors
    ///
    /// [`PrError`]: `gh` is missing, not signed in, or failed, such as for a merge GitHub
    /// refuses.
    pub async fn act_pr(&self, url: &str, action: PrAction) -> Result<PullRequest, PrError> {
        let args: &[&str] = match action {
            PrAction::Merge => &["pr", "merge", url, "--merge"],
            PrAction::Squash => &["pr", "merge", url, "--squash"],
            PrAction::AutoMerge => &["pr", "merge", url, "--auto", "--merge"],
            PrAction::DisableAutoMerge => &["pr", "merge", url, "--disable-auto"],
            PrAction::Draft => &["pr", "ready", url, "--undo"],
            PrAction::Ready => &["pr", "ready", url],
            PrAction::Close => &["pr", "close", url],
            PrAction::Unknown => return Err(PrError::Gh("unknown pull request action".to_owned())),
        };
        self.gh(&std::env::temp_dir(), args).await?;
        self.view_pr(url).await
    }

    /// Runs `git args` in `cwd` for the pull request media gist (PLX-1137) and returns its stdout,
    /// with the network timeout and `gh auth git-credential` as gist.github.com's only credential
    /// helper, so a clone or push uses gh's sign-in and never prompts. A non-zero exit is a
    /// [`PrError`].
    pub(crate) async fn gist_git(&self, cwd: &Path, args: &[&str]) -> Result<String, PrError> {
        const HELPER: &str = "credential.https://gist.github.com.helper";
        let reset = format!("{HELPER}=");
        let gh = format!("{HELPER}=!gh auth git-credential");
        let all: Vec<&str> = ["-c", &reset, "-c", &gh]
            .into_iter()
            .chain(args.iter().copied())
            .collect();
        self.run_git_for(cwd, &all, NETWORK_TIMEOUT)
            .await
            .and_then(|output| output.ok(cwd, &all))
            .map_err(|error| PrError::Gh(error.to_string()))
    }

    /// Runs `gh args` in `repo_root` and returns its stdout, turning a missing `gh`, a sign-in
    /// it needs, and any other failure into a [`PrError`].
    pub(crate) async fn gh(&self, repo_root: &Path, args: &[&str]) -> Result<String, PrError> {
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
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Listed {
    url: String,
    is_cross_repository: bool,
}

/// Every `https://github.com/<owner>/<repo>/pull/<n>` in `text`, in order, such as the one
/// `gh pr create` prints.
#[must_use]
pub fn github_pr_urls(text: &str) -> Vec<String> {
    const PREFIX: &str = "https://github.com/";
    let name = |part: &str| {
        !part.is_empty()
            && part
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'))
    };
    text.match_indices(PREFIX)
        .filter_map(|(at, _)| {
            let mut parts = text[at + PREFIX.len()..].splitn(4, '/');
            let (owner, repo) = (parts.next()?, parts.next()?);
            if parts.next()? != "pull" {
                return None;
            }
            let tail = parts.next()?;
            let digits = tail
                .find(|c: char| !c.is_ascii_digit())
                .unwrap_or(tail.len());
            let ends = !tail[digits..].starts_with(|c: char| c.is_ascii_alphanumeric());
            (name(owner) && name(repo) && digits > 0 && ends)
                .then(|| format!("{PREFIX}{owner}/{repo}/pull/{}", &tail[..digits]))
        })
        .collect()
}

/// `gh pr view --json`'s answer, with only what [`PullRequest`] needs.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Viewed {
    number: u64,
    title: String,
    url: String,
    state: String,
    is_draft: bool,
    author: Option<Login>,
    updated_at: Timestamp,
    base_ref_name: String,
    head_ref_name: String,
    changed_files: u64,
    additions: u64,
    deletions: u64,
    #[serde(default)]
    files: Vec<PrFile>,
    body: String,
    #[serde(default)]
    comments: Vec<Comment>,
    #[serde(default)]
    reviews: Vec<Review>,
    #[serde(default)]
    review_requests: Vec<Requested>,
    #[serde(default)]
    labels: Vec<Label>,
    #[serde(default)]
    status_check_rollup: Option<Vec<Check>>,
    merge_state_status: String,
    auto_merge_request: Option<AutoMerge>,
    created_at: Option<Timestamp>,
    closed_at: Option<Timestamp>,
    merged_at: Option<Timestamp>,
    merged_by: Option<Login>,
    #[serde(default)]
    commits: Vec<Commit>,
}

#[derive(Deserialize)]
struct Login {
    login: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Comment {
    author: Option<Login>,
    body: String,
    created_at: Option<Timestamp>,
}

/// A review: its text, verdict, and `submittedAt`, absent while it is pending.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Review {
    author: Option<Login>,
    body: String,
    state: String,
    submitted_at: Option<Timestamp>,
}

/// A commit's hash, first line, authors, and time.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Commit {
    oid: String,
    message_headline: String,
    #[serde(default)]
    authors: Vec<CommitAuthor>,
    committed_date: Timestamp,
}

/// A commit's author: a GitHub `login` when git's email matches an account, else just a `name`.
#[derive(Deserialize)]
struct CommitAuthor {
    #[serde(default)]
    login: String,
    #[serde(default)]
    name: String,
}

/// A user, by `login`, or a team, by `name`.
#[derive(Deserialize)]
struct Requested {
    login: Option<String>,
    name: Option<String>,
}

#[derive(Deserialize)]
struct Label {
    name: String,
}

/// A GitHub Actions job (`name`, `status`, `conclusion`, `detailsUrl`) or another CI's status
/// (`context`, `state`, `targetUrl`).
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Check {
    name: Option<String>,
    context: Option<String>,
    status: Option<String>,
    conclusion: Option<String>,
    state: Option<String>,
    details_url: Option<String>,
    target_url: Option<String>,
    workflow_name: Option<String>,
    started_at: Option<String>,
    completed_at: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct AutoMerge {
    merge_method: String,
}

/// A deleted account is GitHub's `ghost`.
fn login(author: Option<Login>) -> String {
    author.map_or_else(|| "ghost".to_owned(), |a| a.login)
}

/// The comments and review texts that say something, and the reviews' verdicts, each oldest
/// first. A pending review has no `submittedAt`, so it is left out of both.
fn discussion(comments: Vec<Comment>, reviews: Vec<Review>) -> (Vec<PrComment>, Vec<PrReview>) {
    let mut said: Vec<PrComment> = comments
        .into_iter()
        .filter_map(|comment| {
            Some(PrComment {
                created_at: comment.created_at?,
                author: login(comment.author),
                body: comment.body,
            })
        })
        .collect();
    let mut verdicts = Vec::new();
    for review in reviews {
        let Some(submitted_at) = review.submitted_at else {
            continue;
        };
        let author = login(review.author);
        said.push(PrComment {
            author: author.clone(),
            body: review.body,
            created_at: submitted_at,
        });
        verdicts.push(PrReview {
            author,
            state: match review.state.as_str() {
                "APPROVED" => PrReviewState::Approved,
                "CHANGES_REQUESTED" => PrReviewState::ChangesRequested,
                "COMMENTED" => PrReviewState::Commented,
                "DISMISSED" => PrReviewState::Dismissed,
                _ => PrReviewState::Unknown,
            },
            submitted_at,
        });
    }
    said.retain(|comment| !comment.body.trim().is_empty());
    said.sort_by_key(|comment| comment.created_at);
    verdicts.sort_by_key(|review| review.submitted_at);
    (said, verdicts)
}

/// `gh`'s name for a pull request's state as a [`PrState`].
fn pr_state(state: &str) -> PrState {
    match state {
        "OPEN" => PrState::Open,
        "CLOSED" => PrState::Closed,
        "MERGED" => PrState::Merged,
        _ => PrState::Unknown,
    }
}

/// `gh pr view --json`'s answer as a [`PullRequest`].
fn parse_view(json: &str) -> Result<PullRequest, PrError> {
    let viewed: Viewed = serde_json::from_str(json)
        .map_err(|error| PrError::Gh(format!("could not read gh pr view's answer: {error}")))?;
    let (comments, reviews) = discussion(viewed.comments, viewed.reviews);
    let checks: Vec<PrCheck> = viewed
        .status_check_rollup
        .unwrap_or_default()
        .into_iter()
        .map(check)
        .collect();
    let any = |state| checks.iter().any(|check| check.state == state);
    let checks_state = (!checks.is_empty()).then(|| {
        if any(PrCheckState::Failed) {
            PrCheckState::Failed
        } else if any(PrCheckState::Pending) {
            PrCheckState::Pending
        } else {
            PrCheckState::Passed
        }
    });
    Ok(PullRequest {
        number: viewed.number,
        title: viewed.title,
        // `https://github.com/<owner>/<name>/pull/<n>`.
        repo: viewed
            .url
            .split('/')
            .skip(3)
            .take(2)
            .collect::<Vec<_>>()
            .join("/"),
        url: viewed.url,
        state: pr_state(&viewed.state),
        draft: viewed.is_draft,
        author: login(viewed.author),
        updated_at: viewed.updated_at,
        base_branch: viewed.base_ref_name,
        head_branch: viewed.head_ref_name,
        changed_files: viewed.changed_files,
        additions: viewed.additions,
        deletions: viewed.deletions,
        files: viewed.files,
        body: viewed.body,
        comments,
        review_requests: viewed
            .review_requests
            .into_iter()
            .filter_map(|requested| requested.login.or(requested.name))
            .collect(),
        labels: viewed.labels.into_iter().map(|label| label.name).collect(),
        checks,
        checks_state,
        created_at: viewed.created_at,
        closed_at: viewed.closed_at,
        merged_at: viewed.merged_at,
        merged_by: viewed.merged_by.map(|by| by.login),
        commits: viewed.commits.into_iter().map(commit).collect(),
        reviews,
        merge_state: match viewed.merge_state_status.as_str() {
            "CLEAN" => Some(PrMergeState::Clean),
            "UNSTABLE" => Some(PrMergeState::Unstable),
            "HAS_HOOKS" => Some(PrMergeState::HasHooks),
            "BEHIND" => Some(PrMergeState::Behind),
            "BLOCKED" => Some(PrMergeState::Blocked),
            "DIRTY" => Some(PrMergeState::Dirty),
            "DRAFT" => Some(PrMergeState::Draft),
            _ => None,
        },
        auto_merge: viewed
            .auto_merge_request
            .map(|auto| match auto.merge_method.as_str() {
                "MERGE" => PrMergeMethod::Merge,
                "SQUASH" => PrMergeMethod::Squash,
                "REBASE" => PrMergeMethod::Rebase,
                _ => PrMergeMethod::Unknown,
            }),
    })
}

/// One of `commits`, by its first author.
fn commit(commit: Commit) -> PrCommit {
    PrCommit {
        author: commit
            .authors
            .into_iter()
            .next()
            .map(|a| if a.login.is_empty() { a.name } else { a.login })
            .unwrap_or_default(),
        oid: commit.oid,
        headline: commit.message_headline,
        committed_at: commit.committed_date,
    }
}

/// One of `statusCheckRollup`'s checks. A job is done once its `status` is `COMPLETED`, and a
/// status once its `state` isn't `PENDING` or `EXPECTED`; until then it has no conclusion.
fn check(check: Check) -> PrCheck {
    let done = match (&check.status, &check.state) {
        (Some(status), _) => status == "COMPLETED",
        (None, Some(state)) => !matches!(state.as_str(), "PENDING" | "EXPECTED"),
        (None, None) => false,
    };
    let conclusion = done
        .then(|| check.conclusion.filter(|c| !c.is_empty()).or(check.state))
        .flatten()
        .map(|conclusion| conclusion.to_lowercase());
    PrCheck {
        name: check.name.or(check.context).unwrap_or_default(),
        state: match conclusion.as_deref() {
            None => PrCheckState::Pending,
            Some("success" | "neutral") => PrCheckState::Passed,
            Some("skipped") => PrCheckState::Skipped,
            Some(_) => PrCheckState::Failed,
        },
        conclusion,
        url: check
            .details_url
            .or(check.target_url)
            .filter(|url| !url.is_empty()),
        workflow: check.workflow_name.filter(|name| !name.is_empty()),
        started_at: time(check.started_at),
        completed_at: time(check.completed_at),
    }
}

/// A check's time. GitHub sends `0001-01-01T00:00:00Z` for one it doesn't have yet.
fn time(time: Option<String>) -> Option<Timestamp> {
    time.and_then(|time| time.parse::<Timestamp>().ok())
        .filter(|time| time.as_second() > 0)
}

/// `diff` cut to at most `max` bytes, at the end of a line.
fn cap_diff(mut diff: String, max: usize) -> PrDiffResult {
    if diff.len() <= max {
        return PrDiffResult {
            diff,
            truncated: false,
        };
    }
    let cut = diff.as_bytes()[..max]
        .iter()
        .rposition(|&b| b == b'\n')
        .map_or(0, |at| at + 1);
    diff.truncate(cut);
    PrDiffResult {
        diff,
        truncated: true,
    }
}

/// What `pull_request_diff` shows of `read`: only the files at or under `paths` when there are
/// any, cut at a line's end at `max` bytes, with a note for whatever is missing.
pub(crate) fn agent_diff(read: PrDiffResult, paths: &[String], max: usize) -> String {
    let diff = if paths.is_empty() {
        read.diff
    } else {
        of_paths(&read.diff, paths)
    };
    let total = diff.len();
    // Room for the notes.
    let shown = cap_diff(diff, max.saturating_sub(256));
    let mut notes = Vec::new();
    if total == 0 && !paths.is_empty() {
        notes.push("[No file in the diff matches those paths.]\n".to_owned());
    }
    if shown.truncated {
        notes.push(format!(
            "[Cut: {} of {total} bytes shown. Pass paths to read the rest.]\n",
            shown.diff.len()
        ));
    }
    if read.truncated {
        notes.push(format!(
            "[GitHub's diff was cut at {} MiB; files after the cut are missing.]\n",
            MAX_DIFF_BYTES / 1024 / 1024
        ));
    }
    shown.diff + &notes.concat()
}

/// The `diff --git` sections of `diff` whose old or new path is one of `paths` or under it, by
/// whole path components.
fn of_paths(diff: &str, paths: &[String]) -> String {
    let paths: Vec<&str> = paths
        .iter()
        .map(|path| path.trim_start_matches("./").trim_matches('/'))
        .filter(|path| !path.is_empty())
        .collect();
    let wanted = |file: &str| {
        paths.iter().any(|path| {
            file.strip_prefix(path)
                .is_some_and(|rest| rest.is_empty() || rest.starts_with('/'))
        })
    };
    let mut sections: Vec<String> = Vec::new();
    for line in diff.split_inclusive('\n') {
        match sections.last_mut() {
            Some(section) if !line.starts_with("diff --git ") => section.push_str(line),
            _ => sections.push(line.to_owned()),
        }
    }
    sections
        .into_iter()
        .filter(|section| files(section).any(wanted))
        .collect()
}

/// The paths a `diff --git` section names: both sides of its header when they are the same path,
/// and its `---`, `+++`, rename, and copy lines before its first hunk.
fn files(section: &str) -> impl Iterator<Item = &str> {
    let mut lines = section.lines();
    // `a/X b/Y` is ambiguous when a path holds " b/", but not when X is Y.
    let header = lines
        .next()
        .and_then(|header| header.strip_prefix("diff --git a/"))
        .and_then(|sides| {
            let half = sides.len().checked_sub(3)? / 2;
            let (old, new) = (sides.get(..half)?, sides.get(half..)?);
            (new.strip_prefix(" b/")? == old).then_some(old)
        });
    let named = lines
        .take_while(|line| !line.starts_with("@@"))
        .filter_map(|line| {
            ["--- a/", "+++ b/", "rename from ", "rename to ", "copy from ", "copy to "]
                .iter()
                .find_map(|prefix| line.strip_prefix(prefix))
                // git ends a path holding a space with a tab on `---` and `+++` lines.
                .map(|file| file.trim_end_matches('\t'))
        });
    header.into_iter().chain(named)
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
    use parallax_protocol::{
        PrCheckState, PrDiffResult, PrMergeMethod, PrMergeState, PrReviewState, PrState,
    };
    use serde_json::json;

    use super::{agent_diff, parse_view, without_userinfo};

    /// An open draft's `gh pr view --json` answer, with every kind of comment and check.
    fn answer() -> serde_json::Value {
        json!({
            "number": 42,
            "title": "Add a README",
            "url": "https://github.com/me/app/pull/42",
            "state": "OPEN",
            "isDraft": true,
            "author": {"id": "U_1", "is_bot": false, "login": "me", "name": "Me"},
            "updatedAt": "2026-10-02T12:10:00Z",
            "baseRefName": "main",
            "headRefName": "parallax/add-readme",
            "changedFiles": 1,
            "additions": 12,
            "deletions": 2,
            "files": [{"path": "README.md", "additions": 12, "deletions": 2, "changeType": "MODIFIED"}],
            "body": "Explains the build.",
            "comments": [
                {"author": {"login": "bot"}, "body": "Deployed.", "createdAt": "2026-10-02T12:09:00Z"},
                {"author": null, "body": "First!", "createdAt": "2026-10-02T12:01:00Z"}
            ],
            "reviews": [
                {"author": {"login": "rev"}, "body": "Mention Node.", "state": "COMMENTED",
                 "submittedAt": "2026-10-02T12:05:00Z"},
                {"author": {"login": "rev"}, "body": "", "state": "APPROVED",
                 "submittedAt": "2026-10-02T12:06:00Z"},
                {"author": {"login": "rev"}, "body": "Draft note", "state": "PENDING",
                 "submittedAt": null}
            ],
            "reviewRequests": [
                {"__typename": "User", "login": "rev"},
                {"__typename": "Team", "name": "docs", "slug": "me/docs"}
            ],
            "labels": [{"id": "L_1", "name": "docs", "color": "0075ca", "description": ""}],
            "statusCheckRollup": [
                {"__typename": "CheckRun", "name": "build", "status": "COMPLETED",
                 "conclusion": "SUCCESS", "detailsUrl": "https://github.com/me/app/runs/1",
                 "workflowName": "CI", "startedAt": "2026-10-02T12:01:00Z",
                 "completedAt": "2026-10-02T12:04:00Z"},
                {"__typename": "CheckRun", "name": "test", "status": "IN_PROGRESS",
                 "conclusion": "", "detailsUrl": "", "workflowName": "CI",
                 "startedAt": "2026-10-02T12:02:00Z", "completedAt": "0001-01-01T00:00:00Z"},
                {"__typename": "CheckRun", "name": "lint", "status": "COMPLETED",
                 "conclusion": "SKIPPED", "detailsUrl": ""},
                {"__typename": "StatusContext", "context": "deploy", "state": "FAILURE",
                 "targetUrl": "https://deploy.example/1"}
            ],
            "mergeStateStatus": "BLOCKED",
            "autoMergeRequest": {"mergeMethod": "SQUASH", "enabledBy": {"login": "me"}},
            "createdAt": "2026-10-02T12:00:00Z",
            "closedAt": null,
            "mergedAt": null,
            "mergedBy": null,
            "commits": [
                {"oid": "abc123", "messageHeadline": "docs: add a README",
                 "messageBody": "", "committedDate": "2026-10-02T11:58:00Z",
                 "authoredDate": "2026-10-02T11:58:00Z",
                 "authors": [{"email": "me@example.com", "id": "U_1", "login": "me", "name": "Me"}]},
                {"oid": "def456", "messageHeadline": "docs: mention Node",
                 "messageBody": "", "committedDate": "2026-10-02T12:07:00Z",
                 "authoredDate": "2026-10-02T12:07:00Z",
                 "authors": [{"email": "a@example.com", "id": "", "login": "", "name": "Ann"}]}
            ]
        })
    }

    #[test]
    fn gh_pr_view_s_answer_becomes_a_pull_request() {
        let pr = parse_view(&answer().to_string()).unwrap();
        assert_eq!(pr.repo, "me/app");
        assert_eq!(pr.state, PrState::Open);
        assert!(pr.draft);
        assert_eq!(pr.author, "me");
        assert_eq!(
            (pr.base_branch.as_str(), pr.head_branch.as_str()),
            ("main", "parallax/add-readme")
        );
        assert_eq!((pr.changed_files, pr.additions, pr.deletions), (1, 12, 2));
        let comments: Vec<_> = pr
            .comments
            .iter()
            .map(|c| (c.author.as_str(), c.body.as_str()))
            .collect();
        assert_eq!(
            comments,
            [
                ("ghost", "First!"),
                ("rev", "Mention Node."),
                ("bot", "Deployed.")
            ],
            "oldest first, with reviews that say something and aren't pending"
        );
        assert_eq!(pr.review_requests, ["rev", "docs"]);
        assert_eq!(pr.labels, ["docs"]);
        let checks: Vec<_> = pr
            .checks
            .iter()
            .map(|c| {
                (
                    c.name.as_str(),
                    c.state,
                    c.conclusion.as_deref(),
                    c.url.as_deref(),
                )
            })
            .collect();
        assert_eq!(
            checks,
            [
                (
                    "build",
                    PrCheckState::Passed,
                    Some("success"),
                    Some("https://github.com/me/app/runs/1")
                ),
                ("test", PrCheckState::Pending, None, None),
                ("lint", PrCheckState::Skipped, Some("skipped"), None),
                (
                    "deploy",
                    PrCheckState::Failed,
                    Some("failure"),
                    Some("https://deploy.example/1")
                ),
            ]
        );
        assert_eq!(pr.checks_state, Some(PrCheckState::Failed));
        let test = &pr.checks[1];
        assert_eq!(test.workflow.as_deref(), Some("CI"));
        assert_eq!(
            test.started_at,
            Some("2026-10-02T12:02:00Z".parse().unwrap())
        );
        assert_eq!(test.completed_at, None, "GitHub's zero time is no time");
        assert_eq!(
            pr.checks[0].completed_at,
            Some("2026-10-02T12:04:00Z".parse().unwrap())
        );
        assert_eq!(pr.checks[3].workflow, None);
        assert_eq!(pr.merge_state, Some(PrMergeState::Blocked));
        assert_eq!(pr.auto_merge, Some(PrMergeMethod::Squash));
        assert_eq!(pr.created_at, Some("2026-10-02T12:00:00Z".parse().unwrap()));
        let reviews: Vec<_> = pr
            .reviews
            .iter()
            .map(|r| (r.author.as_str(), r.state))
            .collect();
        assert_eq!(
            reviews,
            [
                ("rev", PrReviewState::Commented),
                ("rev", PrReviewState::Approved)
            ],
            "every submitted verdict, even with no text, and no pending one"
        );
        let commits: Vec<_> = pr
            .commits
            .iter()
            .map(|c| (c.oid.as_str(), c.headline.as_str(), c.author.as_str()))
            .collect();
        assert_eq!(
            commits,
            [
                ("abc123", "docs: add a README", "me"),
                ("def456", "docs: mention Node", "Ann")
            ],
            "by login, or by name without a GitHub account"
        );
    }

    #[test]
    fn an_agent_reads_only_the_paths_it_asks_for() {
        let section = |old: &str, new: &str| {
            format!("diff --git a/{old} b/{new}\n--- a/{old}\n+++ b/{new}\n@@ -1 +1 @@\n-x\n+y\n")
        };
        let (main, docs, renamed) = (
            section("src/main.rs", "src/main.rs"),
            section("docs/a b.md", "docs/a b.md"),
            section("old.rs", "src/new.rs"),
        );
        let read = PrDiffResult {
            diff: format!("{main}{docs}{renamed}"),
            truncated: false,
        };
        let paths = |paths: &[&str]| {
            paths
                .iter()
                .map(|path| (*path).to_owned())
                .collect::<Vec<_>>()
        };
        let shown = |asked: &[&str]| agent_diff(read.clone(), &paths(asked), 1024 * 1024);
        assert_eq!(shown(&[]), read.diff, "no paths is the whole diff");
        assert_eq!(shown(&["src/main.rs"]), main, "a file");
        assert_eq!(shown(&["docs/"]), docs, "a folder, a path with a space");
        assert_eq!(shown(&["old.rs"]), renamed, "a rename by its old path");
        assert_eq!(
            shown(&["src"]),
            format!("{main}{renamed}"),
            "by its new path"
        );
        assert_eq!(
            shown(&["src/main"]),
            "[No file in the diff matches those paths.]\n"
        );
        assert_eq!(
            shown(&["docs/a"]),
            "[No file in the diff matches those paths.]\n",
            "whole path components only"
        );

        let cut = agent_diff(read.clone(), &[], 256 + main.len() + 1);
        assert!(cut.starts_with(&main) && !cut.contains("docs/"), "{cut}");
        assert!(cut.ends_with("Pass paths to read the rest.]\n"), "{cut}");
    }

    /// A second read of a head already read runs only `gh pr view`, never a second `gh pr diff`.
    #[cfg(unix)]
    #[tokio::test]
    async fn a_head_already_read_shares_its_diff() {
        use std::os::unix::fs::PermissionsExt;

        use crate::backend::process::{Environment, Launcher};
        use crate::paths::DataDir;
        use crate::worktree::WorktreeManager;

        let bin = tempfile::tempdir().unwrap();
        let log = bin.path().join("calls");
        let gh = bin.path().join("gh");
        std::fs::write(
            &gh,
            format!(
                "#!/bin/sh\necho \"$1 $2\" >> '{}'\nif [ \"$2\" = view ]; then cat '{}'; else echo 'diff --git a/x b/x'; fi\n",
                log.display(),
                bin.path().join("head").display()
            ),
        )
        .unwrap();
        std::fs::set_permissions(&gh, std::fs::Permissions::from_mode(0o755)).unwrap();
        let head = |sha: &str| std::fs::write(bin.path().join("head"), format!("{sha}\n")).unwrap();
        let data = tempfile::tempdir().unwrap();
        let path = format!(
            "{}:{}",
            bin.path().display(),
            std::env::var("PATH").unwrap()
        );
        let env: Environment = [("PATH", path.as_str())].into_iter().collect();
        let manager = WorktreeManager::new(
            Launcher::new(DataDir::new(data.path()).unwrap(), env),
            data.path(),
        );
        let url = "https://github.com/me/app/pull/42";

        head("abc");
        let first = manager.shared_diff(url).await.unwrap();
        assert_eq!(manager.shared_diff(url).await.unwrap(), first);
        head("def");
        manager.shared_diff(url).await.unwrap();
        let calls = std::fs::read_to_string(&log).unwrap();
        assert_eq!(
            calls, "pr view\npr diff\npr view\npr view\npr diff\n",
            "a new head reads its diff again"
        );
    }

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
