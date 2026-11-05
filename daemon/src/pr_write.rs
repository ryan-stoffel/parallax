//! `pr/write` (PLX-1022, 0086): comments, reviews, title and body edits, review-thread replies and
//! resolves, pending-review comments and their submission, and Viewed files on a GitHub pull request, `merge_when_ready`'s merges ([`merge`]), and the app's
//! `pr/act` merges, branch updates and deletes, and check re-runs and cancels ([`act`], PLX-1151),
//! all sent by plxd through one queue per host, so writes in parallel don't trip GitHub's
//! secondary "submitted too quickly" limit.
//!
//! A write waits its turn in [`QUEUE`] at most [`QUEUE_WAIT`] and starts at least [`GAP`] after
//! the last write ended. It backs off a secondary limit with [`BACKOFF`] only while its
//! [`BUDGET`] lasts, and fails at once on a spent primary limit, naming when it resets from
//! `gh api rate_limit`, which doesn't count against it. plxd drops a connection silent for 90 s
//! and `plxd mcp` sends nothing while a call waits, so a call ends within [`BUDGET`].

use std::future::Future;
use std::io::Write as _;
use std::path::Path;
use std::time::Duration;

use parallax_protocol::jsonrpc::ErrorObject;
use parallax_protocol::{
    PrActParams, PrAction, PrDiffSide, PrMergeMethod, PrReviewEvent, PrWrite, PrWriteParams,
    PrWriteResult,
};
use tokio::sync::Mutex;
use tokio::time::Instant;
use tracing::warn;

use crate::pr_media::{Limit, limit};
use crate::server::Daemon;
use crate::worktree::{PrError, WorktreeManager, github_pr_urls};

/// The least time between one write's end and the next one's start.
const GAP: Duration = Duration::from_secs(1);

/// The longest a call takes, under the 60 s other long tools keep to, well inside plxd's 90 s
/// limit on a silent connection.
const BUDGET: Duration = Duration::from_secs(55);

/// The longest a write waits for its turn in [`QUEUE`].
const QUEUE_WAIT: Duration = Duration::from_secs(40);

/// Waits before each retry of a write GitHub refused for a secondary rate limit, each taken only
/// if it ends inside the write's [`BUDGET`].
const BACKOFF: [Duration; 2] = [Duration::from_secs(10), Duration::from_secs(20)];

/// The host's write queue: when the last write ended, held from a write's start to its end.
static QUEUE: Mutex<Option<Instant>> = Mutex::const_new(None);

/// `pr/write`: sends `params.write` to its pull request through [`QUEUE`], within [`BUDGET`].
pub(crate) async fn write(
    daemon: &Daemon,
    params: PrWriteParams,
) -> Result<PrWriteResult, ErrorObject> {
    let PrWriteParams { url, write } = params;
    // Only a pull request URL reaches gh's argv, never a flag.
    if github_pr_urls(&url) != [url.as_str()] {
        return Err(ErrorObject::invalid_params(format!(
            "{url:?} is not a GitHub pull request URL"
        )));
    }
    // Bodies go through a file, so a long one fits any platform's argument limit.
    let mut file = tempfile::NamedTempFile::new().map_err(ErrorObject::internal_error)?;
    if let PrWrite::ApplySuggestions {
        comment_ids,
        message,
        head_sha,
    } = &write
    {
        let deadline = Instant::now() + BUDGET;
        tokio::time::timeout_at(
            deadline,
            suggestions::apply(
                daemon,
                &url,
                comment_ids,
                message,
                head_sha,
                file.path(),
                deadline,
            ),
        )
        .await
        .unwrap_or_else(|_| {
            Err(PrError::Gh(format!(
                "GitHub didn't answer within {BUDGET:?}; the commit may have gone through, so \
                 look at the pull request before trying again"
            )))
        })
        .map_err(|error| crate::agents::pr_error(&error))?;
        crate::pr_watch::forget_read(daemon, &url);
        return Ok(PrWriteResult { url });
    }
    let (steps, body) = commands(&url, write, file.path()).map_err(ErrorObject::invalid_params)?;
    if let Some(body) = body {
        file.write_all(body.as_bytes())
            .and_then(|()| file.flush())
            .map_err(ErrorObject::internal_error)?;
    }
    let deadline = Instant::now() + BUDGET;
    let gh = daemon.agents.worktrees();
    let sent = async {
        for (step, args) in steps.iter().enumerate() {
            let args: Vec<&str> = args.iter().map(String::as_str).collect();
            let answer = send(gh, &args, deadline)
                .await
                .map_err(|error| match error {
                    // Only a reply then a resolve has a second step.
                    PrError::Gh(error) if step > 0 => PrError::Gh(format!(
                        "the reply posted, but resolving the thread failed; call \
                         reply_to_review_thread again with resolve and no body: {error}"
                    )),
                    error => error,
                })?;
            refusal(&answer).map_or(Ok(()), |why| Err(PrError::Gh(why)))?;
        }
        Ok(())
    };
    tokio::time::timeout_at(deadline, sent)
        .await
        .unwrap_or_else(|_| {
            Err(PrError::Gh(format!(
                "GitHub didn't answer within {BUDGET:?}; the write may have gone through, so \
                 check pull_request_status before calling again"
            )))
        })
        .map_err(|error| crate::agents::pr_error(&error))?;
    // The next read should show this write, not a read shared from before it.
    crate::pr_watch::forget_read(daemon, &url);
    Ok(PrWriteResult { url })
}

/// `pr/act` (PLX-1151): does `params.action` to its pull request with `gh`, through [`QUEUE`],
/// within [`BUDGET`]. Deleting the head branch reads the pull request fresh first.
pub(crate) async fn act(daemon: &Daemon, params: &PrActParams) -> Result<(), ErrorObject> {
    let url = params.url.as_str();
    if github_pr_urls(url) != [url] {
        return Err(ErrorObject::invalid_params(format!(
            "{url:?} is not a GitHub pull request URL"
        )));
    }
    let head = if params.action == PrAction::DeleteBranch {
        Some(
            crate::pr_watch::head_to_delete(daemon, url)
                .await
                .map_err(|error| crate::agents::pr_error(&error))?,
        )
    } else {
        None
    };
    let args = act_args(params, head).map_err(ErrorObject::invalid_params)?;
    let args: Vec<&str> = args.iter().map(String::as_str).collect();
    let deadline = Instant::now() + BUDGET;
    let gh = daemon.agents.worktrees();
    tokio::time::timeout_at(deadline, send(gh, &args, deadline))
        .await
        .unwrap_or_else(|_| {
            Err(PrError::Gh(format!(
                "GitHub didn't answer within {BUDGET:?}; it may have gone through, so look at the \
                 pull request before trying again"
            )))
        })
        .map(drop)
        .map_err(|error| crate::agents::pr_error(&error))
}

/// The `gh` command that does `params.action`, given the head branch's repository and name for
/// `deleteBranch`. Values go as `--flag=value` or in a path, so none is read as a flag.
fn act_args(params: &PrActParams, head: Option<(String, String)>) -> Result<Vec<String>, String> {
    let url = params.url.as_str();
    // `https://github.com/<owner>/<name>/pull/<n>`, checked by the caller.
    let repo = url.split('/').skip(3).take(2).collect::<Vec<_>>().join("/");
    let flag = |method: PrMergeMethod| match method {
        PrMergeMethod::Merge => Ok("--merge"),
        PrMergeMethod::Squash => Ok("--squash"),
        PrMergeMethod::Rebase => Ok("--rebase"),
        PrMergeMethod::Unknown => Err("method must be merge, squash, or rebase".to_owned()),
    };
    let pinned = params
        .head_sha
        .as_ref()
        .map(|head| format!("--match-head-commit={head}"));
    let merge = |method| -> Result<Vec<String>, String> {
        let mut args = vec!["pr".to_owned(), "merge".to_owned(), url.to_owned()];
        args.push(flag(method)?.to_owned());
        args.extend(pinned.clone());
        if params.delete_branch {
            args.push("--delete-branch".to_owned());
        }
        Ok(args)
    };
    let post = |path: String| ["api", "-X", "POST", &path].map(str::to_owned).to_vec();
    let run = || {
        params
            .workflow_run_id
            .ok_or_else(|| "workflowRunId is required".to_owned())
    };
    let gh = |args: &[&str]| args.iter().map(|arg| (*arg).to_owned()).collect();
    Ok(match params.action {
        PrAction::Merge => merge(PrMergeMethod::Merge)?,
        PrAction::Squash => merge(PrMergeMethod::Squash)?,
        PrAction::Rebase => merge(PrMergeMethod::Rebase)?,
        PrAction::AutoMerge => {
            let method = flag(params.method.unwrap_or(PrMergeMethod::Merge))?;
            let mut args: Vec<String> = gh(&["pr", "merge", url, "--auto", method]);
            args.extend(pinned);
            args
        }
        PrAction::DisableAutoMerge => gh(&["pr", "merge", url, "--disable-auto"]),
        PrAction::Draft => gh(&["pr", "ready", url, "--undo"]),
        PrAction::Ready => gh(&["pr", "ready", url]),
        PrAction::Close => gh(&["pr", "close", url]),
        PrAction::UpdateBranch if params.method == Some(PrMergeMethod::Rebase) => {
            gh(&["pr", "update-branch", url, "--rebase"])
        }
        PrAction::UpdateBranch => gh(&["pr", "update-branch", url]),
        PrAction::RerunFailed => post(format!(
            "repos/{repo}/actions/runs/{}/rerun-failed-jobs",
            run()?
        )),
        PrAction::RerunJob => {
            let job = params
                .job_id
                .ok_or_else(|| "jobId is required".to_owned())?;
            post(format!("repos/{repo}/actions/jobs/{job}/rerun"))
        }
        PrAction::CancelRun => post(format!("repos/{repo}/actions/runs/{}/cancel", run()?)),
        PrAction::DeleteBranch => {
            let (head_repo, branch) =
                head.ok_or_else(|| "the head branch isn't known".to_owned())?;
            let branch = escape_path(&branch);
            gh(&[
                "api",
                "-X",
                "DELETE",
                &format!("repos/{head_repo}/git/refs/heads/{branch}"),
            ])
        }
        PrAction::Unknown => return Err("unknown pull request action".to_owned()),
    })
}

/// `branch` with each byte but letters, digits, `-`, `.`, `_`, and `/` percent-encoded, for a
/// REST path.
fn escape_path(branch: &str) -> String {
    branch
        .bytes()
        .map(|byte| match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'.' | b'_' | b'/' => {
                char::from(byte).to_string()
            }
            byte => format!("%{byte:02X}"),
        })
        .collect()
}

/// Why [`merge`] didn't merge.
#[derive(Debug)]
pub(crate) enum Refusal {
    /// A rate limit, a busy queue, or a head that moved since it was judged: worth trying again
    /// on the next pass.
    Later(String),
    /// `gh` didn't answer within [`BUDGET`], so the merge may have gone through.
    Unsure(String),
    /// GitHub, or `gh`, refused the merge itself.
    Final(String),
}

/// Merges pull request `url` with `method`, only while its head is still `head`, through
/// [`QUEUE`]. It runs in the watch sweep, not a call, but still gives up after [`BUDGET`], so it
/// never holds the queue longer than a call would.
pub(crate) async fn merge(
    gh: &WorktreeManager,
    url: &str,
    method: PrMergeMethod,
    head: &str,
) -> Result<(), Refusal> {
    let method = match method {
        PrMergeMethod::Merge => "--merge",
        PrMergeMethod::Squash => "--squash",
        PrMergeMethod::Rebase => "--rebase",
        PrMergeMethod::Unknown => return Err(Refusal::Final("unknown merge method".to_owned())),
    };
    let head = format!("--match-head-commit={head}");
    let args = ["pr", "merge", url, method, &head];
    let temp = std::env::temp_dir();
    let merged = tokio::time::timeout(
        BUDGET,
        paced(&QUEUE, Instant::now() + BUDGET, || gh.gh(&temp, &args)),
    )
    .await;
    let Ok(merged) = merged else {
        return Err(Refusal::Unsure(format!(
            "gh pr merge didn't answer within {BUDGET:?}"
        )));
    };
    match merged {
        Ok(_) => Ok(()),
        Err(Failed::Gh(PrError::Gh(error)))
            if limit(&error).is_some() || error.contains("Head branch was modified") =>
        {
            Err(Refusal::Later(error))
        }
        Err(Failed::Gh(error)) => Err(Refusal::Final(error.to_string())),
        Err(Failed::Busy) => Err(Refusal::Later("the write queue is busy".to_owned())),
        Err(Failed::Secondary(error)) => Err(Refusal::Later(error)),
    }
}

/// Runs `gh args` through [`QUEUE`] by `deadline`, turning a busy queue and a rate limit into an
/// error that says when to call again.
async fn send(gh: &WorktreeManager, args: &[&str], deadline: Instant) -> Result<String, PrError> {
    let temp = std::env::temp_dir();
    match paced(&QUEUE, deadline, || gh.gh(&temp, args)).await {
        Ok(answer) => Ok(answer),
        Err(Failed::Busy) => Err(PrError::Gh(format!(
            "pull request writes are busy: other writes have held the host's write queue for \
             {QUEUE_WAIT:?}; call again"
        ))),
        Err(Failed::Secondary(error)) => Err(PrError::Gh(format!(
            "GitHub's secondary rate limit is on; call again in a minute: {error}"
        ))),
        Err(Failed::Gh(PrError::Gh(error))) if limit(&error) == Some(Limit::Primary) => {
            let reset = gh
                .gh(&temp, &["api", "rate_limit"])
                .await
                .ok()
                .and_then(|answer| crate::ci_logs::spent_until(&answer));
            let when = reset.map_or_else(
                || "GitHub didn't say when it resets".to_owned(),
                |reset| format!("it resets at {reset}"),
            );
            Err(PrError::Gh(format!(
                "GitHub's API rate limit is spent; {when}. Call again after that, not with gh: \
                 {error}"
            )))
        }
        Err(Failed::Gh(error)) => Err(error),
    }
}

/// Why [`paced`] failed.
#[derive(Debug)]
enum Failed {
    /// Its turn didn't come within [`QUEUE_WAIT`] or the deadline.
    Busy,
    /// GitHub's secondary rate limit outlasted the backoff.
    Secondary(String),
    /// `gh` failed otherwise.
    Gh(PrError),
}

/// Runs `attempt` in its turn in `queue`, at least [`GAP`] after the last write ended, and again
/// after each of [`BACKOFF`] that ends before `deadline` while it fails for a secondary rate
/// limit.
async fn paced<F, Fut>(
    queue: &Mutex<Option<Instant>>,
    deadline: Instant,
    mut attempt: F,
) -> Result<String, Failed>
where
    F: FnMut() -> Fut,
    Fut: Future<Output = Result<String, PrError>>,
{
    let turn = deadline.min(Instant::now() + QUEUE_WAIT);
    let Ok(mut last) = tokio::time::timeout_at(turn, queue.lock()).await else {
        return Err(Failed::Busy);
    };
    if let Some(last) = *last {
        tokio::time::sleep_until(last + GAP).await;
    }
    let mut waits = BACKOFF.into_iter();
    let answer = loop {
        match attempt().await {
            Err(PrError::Gh(error)) if limit(&error) == Some(Limit::Secondary) => {
                let Some(wait) = waits
                    .next()
                    .filter(|wait| Instant::now() + *wait < deadline)
                else {
                    break Err(Failed::Secondary(error));
                };
                warn!(%error, ?wait, "GitHub is rate limiting pull request writes");
                tokio::time::sleep(wait).await;
            }
            answer => break answer.map_err(Failed::Gh),
        }
    };
    *last = Some(Instant::now());
    answer
}

/// Replies to a review thread, with `$thread` and `$body`.
const REPLY: &str = "mutation($thread: ID!, $body: String!) { \
    addPullRequestReviewThreadReply(input: {pullRequestReviewThreadId: $thread, body: $body}) { \
    comment { id } } }";

/// Resolves a review thread, `$thread`.
const RESOLVE: &str =
    "mutation($thread: ID!) { resolveReviewThread(input: {threadId: $thread}) { thread { id } } }";

/// Adds a comment to the viewer's pending review, starting one if need be. No `$line` comments on
/// the whole file, as `$subject` says.
const ADD_REVIEW_COMMENT: &str = "mutation($pr: ID!, $path: String!, $body: String!, $line: Int, \
    $startLine: Int, $side: DiffSide, $startSide: DiffSide, \
    $subject: PullRequestReviewThreadSubjectType) { \
    addPullRequestReviewThread(input: {pullRequestId: $pr, path: $path, body: $body, line: $line, \
    startLine: $startLine, side: $side, startSide: $startSide, subjectType: $subject}) { \
    thread { id } } }";

/// A new `$body` for review comment `$comment`.
const EDIT_REVIEW_COMMENT: &str = "mutation($comment: ID!, $body: String!) { \
    updatePullRequestReviewComment(input: {pullRequestReviewCommentId: $comment, body: $body}) { \
    pullRequestReviewComment { id } } }";

/// Deletes review comment `$comment`.
const DELETE_REVIEW_COMMENT: &str = "mutation($comment: ID!) { \
    deletePullRequestReviewComment(input: {id: $comment}) { pullRequestReview { id } } }";

/// Sends pending review `$review` as `$event`, with `$body`.
const SUBMIT_REVIEW: &str = "mutation($review: ID!, $event: PullRequestReviewEvent!, \
    $body: String) { submitPullRequestReview(input: {pullRequestReviewId: $review, event: $event, \
    body: $body}) { pullRequestReview { id } } }";

/// Deletes pending review `$review`.
const DISCARD_REVIEW: &str = "mutation($review: ID!) { \
    deletePullRequestReview(input: {pullRequestReviewId: $review}) { pullRequestReview { id } } }";

/// Marks `$path` viewed on pull request `$pr`.
const MARK_VIEWED: &str = "mutation($pr: ID!, $path: String!) { \
    markFileAsViewed(input: {pullRequestId: $pr, path: $path}) { clientMutationId } }";

/// Takes back marking `$path` viewed on pull request `$pr`.
const UNMARK_VIEWED: &str = "mutation($pr: ID!, $path: String!) { \
    unmarkFileAsViewed(input: {pullRequestId: $pr, path: $path}) { clientMutationId } }";

/// Why GitHub refused a write its answer calls a success: a comment on a line outside the diff
/// comes back as a null thread and no error.
fn refusal(answer: &str) -> Option<String> {
    let answer: serde_json::Value = serde_json::from_str(answer).ok()?;
    let thread = answer.pointer("/data/addPullRequestReviewThread/thread")?;
    thread.is_null().then(|| {
        "GitHub didn't take the comment: its lines aren't in this pull request's diff, or the \
         diff changed. Refresh and try again"
            .to_owned()
    })
}

/// `side` as GraphQL and REST spell it.
fn side_name(side: Option<PrDiffSide>) -> &'static str {
    match side {
        Some(PrDiffSide::Left) => "LEFT",
        _ => "RIGHT",
    }
}

/// The `gh` command that adds a review comment: posted at once with `head_sha`, by REST, which has
/// nothing to do with a pending review, else to the pending review, by GraphQL.
#[allow(clippy::too_many_arguments)]
fn review_comment(
    url: &str,
    pull_request_id: &str,
    path: &str,
    line: Option<u64>,
    start_line: Option<u64>,
    side: Option<PrDiffSide>,
    head_sha: Option<&str>,
    body_file: &str,
) -> Vec<String> {
    let side = side_name(side);
    let range = |line_name: &str, start_name: &str, start_side_name: &str| {
        let mut args = Vec::new();
        if let Some(line) = line {
            args.extend(["-F".to_owned(), format!("{line_name}={line}")]);
            args.extend(["-f".to_owned(), format!("side={side}")]);
        }
        if let Some(start) = start_line {
            args.extend(["-F".to_owned(), format!("{start_name}={start}")]);
            args.extend(["-f".to_owned(), format!("{start_side_name}={side}")]);
        }
        args
    };
    let mut args: Vec<String> = ["api"].map(str::to_owned).to_vec();
    if let Some(head) = head_sha {
        // `https://github.com/<owner>/<name>/pull/<n>`, checked by the caller.
        let parts: Vec<_> = url.split('/').collect();
        let endpoint = format!(
            "repos/{}/{}/pulls/{}/comments",
            parts[3], parts[4], parts[6]
        );
        args.extend(["-X", "POST", &endpoint].map(str::to_owned));
        args.extend(["-f".to_owned(), format!("commit_id={head}")]);
        args.extend(["-f".to_owned(), format!("path={path}")]);
        args.extend(["-F".to_owned(), format!("body=@{body_file}")]);
        if line.is_none() {
            args.extend(["-f".to_owned(), "subject_type=file".to_owned()]);
        }
        args.extend(range("line", "start_line", "start_side"));
    } else {
        args.extend(["graphql", "-f"].map(str::to_owned));
        args.push(format!("query={ADD_REVIEW_COMMENT}"));
        args.extend(["-f".to_owned(), format!("pr={pull_request_id}")]);
        args.extend(["-f".to_owned(), format!("path={path}")]);
        args.extend(["-F".to_owned(), format!("body=@{body_file}")]);
        let subject = if line.is_some() { "LINE" } else { "FILE" };
        args.extend(["-f".to_owned(), format!("subject={subject}")]);
        args.extend(range("line", "startLine", "startSide"));
    }
    args
}

/// The `gh` commands that make `write` to `url`, each a step run after the one before, and the
/// body to put in `body_file`, which they read it from. Other values go as `--flag=value` or
/// GraphQL variables, so none is read as a flag.
fn commands(
    url: &str,
    write: PrWrite,
    body_file: &Path,
) -> Result<(Vec<Vec<String>>, Option<String>), String> {
    let file = body_file.display().to_string();
    let from_file = format!("--body-file={file}");
    let gh = |args: &[&str]| args.iter().map(|arg| (*arg).to_owned()).collect::<Vec<_>>();
    let empty = |text: &str| text.trim().is_empty();
    match write {
        PrWrite::Comment { body } => {
            if empty(&body) {
                return Err("body must not be empty".to_owned());
            }
            Ok((vec![gh(&["pr", "comment", url, &from_file])], Some(body)))
        }
        PrWrite::Review { event, body } => {
            let event = match event {
                PrReviewEvent::Approve => "--approve",
                PrReviewEvent::Comment | PrReviewEvent::RequestChanges if empty(&body) => {
                    return Err("body must not be empty to comment or request changes".to_owned());
                }
                PrReviewEvent::Comment => "--comment",
                PrReviewEvent::RequestChanges => "--request-changes",
                PrReviewEvent::Unknown => {
                    return Err("event must be comment, approve, or requestChanges".to_owned());
                }
            };
            if empty(&body) {
                return Ok((vec![gh(&["pr", "review", url, event])], None));
            }
            let step = gh(&["pr", "review", url, event, &from_file]);
            Ok((vec![step], Some(body)))
        }
        PrWrite::Edit { title, body } => {
            if title.is_none() && body.is_none() {
                return Err("pass a title, a body, or both".to_owned());
            }
            if title.as_deref().is_some_and(empty) {
                return Err("title must not be empty".to_owned());
            }
            let mut step = gh(&["pr", "edit", url]);
            step.extend(title.map(|title| format!("--title={title}")));
            if body.is_some() {
                step.push(from_file);
            }
            Ok((vec![step], body))
        }
        PrWrite::ReplyToThread {
            review_thread_id,
            body,
            resolve,
        } => {
            if body.as_deref().is_some_and(empty) {
                return Err("body must not be empty; omit it to only resolve".to_owned());
            }
            let thread = format!("thread={review_thread_id}");
            let mut steps = Vec::new();
            if body.is_some() {
                let (query, body) = (format!("query={REPLY}"), format!("body=@{file}"));
                steps.push(gh(&[
                    "api", "graphql", "-f", &query, "-f", &thread, "-F", &body,
                ]));
            }
            if resolve {
                let query = format!("query={RESOLVE}");
                steps.push(gh(&["api", "graphql", "-f", &query, "-f", &thread]));
            }
            if steps.is_empty() {
                return Err("pass a body, resolve, or both".to_owned());
            }
            Ok((steps, body))
        }
        PrWrite::SetFileViewed {
            pull_request_id,
            path,
            viewed,
        } => {
            let query = format!("query={}", if viewed { MARK_VIEWED } else { UNMARK_VIEWED });
            let (pr, path) = (format!("pr={pull_request_id}"), format!("path={path}"));
            let step = gh(&["api", "graphql", "-f", &query, "-f", &pr, "-f", &path]);
            Ok((vec![step], None))
        }
        PrWrite::Unknown => Err("unknown pull request write".to_owned()),
        write => review_commands(url, write, &file),
    }
}

/// [`commands`] for a write to a pending review.
fn review_commands(
    url: &str,
    write: PrWrite,
    file: &str,
) -> Result<(Vec<Vec<String>>, Option<String>), String> {
    let gh = |args: &[&str]| args.iter().map(|arg| (*arg).to_owned()).collect::<Vec<_>>();
    let empty = |text: &str| text.trim().is_empty();
    match write {
        PrWrite::AddReviewComment {
            pull_request_id,
            path,
            body,
            line,
            start_line,
            side,
            head_sha,
        } => {
            if empty(&body) {
                return Err("body must not be empty".to_owned());
            }
            if start_line.is_some() && line.is_none() {
                return Err("a range needs its last line".to_owned());
            }
            let step = review_comment(
                url,
                &pull_request_id,
                &path,
                line,
                start_line,
                side,
                head_sha.as_deref(),
                file,
            );
            Ok((vec![step], Some(body)))
        }
        PrWrite::EditReviewComment { comment_id, body } => {
            if empty(&body) {
                return Err("body must not be empty".to_owned());
            }
            let query = format!("query={EDIT_REVIEW_COMMENT}");
            let (comment, body_arg) = (format!("comment={comment_id}"), format!("body=@{file}"));
            let step = gh(&[
                "api", "graphql", "-f", &query, "-f", &comment, "-F", &body_arg,
            ]);
            Ok((vec![step], Some(body)))
        }
        PrWrite::DeleteReviewComment { comment_id } => {
            let query = format!("query={DELETE_REVIEW_COMMENT}");
            let comment = format!("comment={comment_id}");
            Ok((
                vec![gh(&["api", "graphql", "-f", &query, "-f", &comment])],
                None,
            ))
        }
        PrWrite::SubmitReview {
            review_id,
            event,
            body,
        } => {
            let event = match event {
                PrReviewEvent::Comment => "COMMENT",
                PrReviewEvent::Approve => "APPROVE",
                PrReviewEvent::RequestChanges => "REQUEST_CHANGES",
                PrReviewEvent::Unknown => {
                    return Err("event must be comment, approve, or requestChanges".to_owned());
                }
            };
            let query = format!("query={SUBMIT_REVIEW}");
            let (review, event) = (format!("review={review_id}"), format!("event={event}"));
            let body_arg = format!("body=@{file}");
            let step = gh(&[
                "api", "graphql", "-f", &query, "-f", &review, "-f", &event, "-F", &body_arg,
            ]);
            Ok((vec![step], Some(body)))
        }
        PrWrite::DiscardReview { review_id } => {
            let query = format!("query={DISCARD_REVIEW}");
            let review = format!("review={review_id}");
            Ok((
                vec![gh(&["api", "graphql", "-f", &query, "-f", &review])],
                None,
            ))
        }
        _ => Err("unknown pull request write".to_owned()),
    }
}

mod suggestions;

#[cfg(test)]
mod tests;
