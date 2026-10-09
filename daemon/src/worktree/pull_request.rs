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

use std::ffi::OsString;
use std::path::Path;

use jiff::Timestamp;
use parallax_protocol::{
    PrAction, PrCheck, PrCheckState, PrComment, PrCommit, PrDiffResult, PrMergeMethod,
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
                           headRefName,changedFiles,additions,deletions,body,comments,reviews,\
                           reviewRequests,labels,statusCheckRollup,mergeStateStatus,\
                           autoMergeRequest,createdAt,closedAt,mergedAt,mergedBy,commits";

/// The most of a pull request's diff `pr/diff` returns, so its answer fits one frame.
const MAX_DIFF_BYTES: usize = 2 * 1024 * 1024;

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
#[derive(serde::Deserialize)]
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
        state: match viewed.state.as_str() {
            "OPEN" => PrState::Open,
            "CLOSED" => PrState::Closed,
            "MERGED" => PrState::Merged,
            _ => PrState::Unknown,
        },
        draft: viewed.is_draft,
        author: login(viewed.author),
        updated_at: viewed.updated_at,
        base_branch: viewed.base_ref_name,
        head_branch: viewed.head_ref_name,
        changed_files: viewed.changed_files,
        additions: viewed.additions,
        deletions: viewed.deletions,
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
    }
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
    use parallax_protocol::{PrCheckState, PrMergeMethod, PrMergeState, PrReviewState, PrState};
    use serde_json::json;

    use super::{cap_diff, github_pr_urls, parse_view, without_userinfo};

    #[test]
    fn pull_request_urls_are_found_in_what_gh_printed() {
        assert_eq!(
            github_pr_urls(
                "Creating pull request for x into main in me/app\n\n\
                 https://github.com/me/app/pull/12\n\
                 already exists: https://github.com/my-org/app.js/pull/7/files, and \
                 (https://github.com/me/app/pull/3)."
            ),
            [
                "https://github.com/me/app/pull/12",
                "https://github.com/my-org/app.js/pull/7",
                "https://github.com/me/app/pull/3",
            ]
        );
        for none in [
            "https://github.com/me/app/issues/12",
            "https://github.com/me/app/pull/",
            "https://github.com/me/app/pull/12abc",
            "https://github.com/me/a pp/pull/12",
            "https://gitlab.com/me/app/pull/12",
        ] {
            assert!(github_pr_urls(none).is_empty(), "{none}");
        }
    }

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
                 "workflowName": "CI"},
                {"__typename": "CheckRun", "name": "test", "status": "IN_PROGRESS",
                 "conclusion": "", "detailsUrl": ""},
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
    fn a_merged_pull_request_with_no_checks_has_no_rolled_up_or_merge_state() {
        let mut merged = answer();
        merged["state"] = json!("MERGED");
        merged["statusCheckRollup"] = json!(null);
        merged["mergeStateStatus"] = json!("UNKNOWN");
        merged["autoMergeRequest"] = json!(null);
        merged["mergedAt"] = json!("2026-10-02T13:00:00Z");
        merged["closedAt"] = json!("2026-10-02T13:00:00Z");
        merged["mergedBy"] = json!({"login": "rev"});
        let pr = parse_view(&merged.to_string()).unwrap();
        assert_eq!(pr.state, PrState::Merged);
        assert_eq!(pr.merged_by.as_deref(), Some("rev"));
        assert_eq!(pr.merged_at, Some("2026-10-02T13:00:00Z".parse().unwrap()));
        assert_eq!(
            (pr.checks_state, pr.merge_state, pr.auto_merge),
            (None, None, None)
        );
    }

    #[test]
    fn a_long_diff_is_cut_at_a_line_s_end() {
        let short = cap_diff("+a\n+b\n".to_owned(), 6);
        assert_eq!((short.diff.as_str(), short.truncated), ("+a\n+b\n", false));
        let cut = cap_diff("+a\n+bcd\n".to_owned(), 5);
        assert_eq!((cut.diff.as_str(), cut.truncated), ("+a\n", true));
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
