//! `pr/write` (PLX-1022, 0086): comments, reviews, title and body edits, and review-thread replies
//! and resolves on a GitHub pull request, and `merge_when_ready`'s merges ([`merge`]), all sent by
//! plxd through one queue per host, so agents writing in parallel don't trip GitHub's secondary
//! "submitted too quickly" limit.
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
use parallax_protocol::{PrMergeMethod, PrReviewEvent, PrWrite, PrWriteParams, PrWriteResult};
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
            send(gh, &args, deadline)
                .await
                .map_err(|error| match error {
                    // Only a reply then a resolve has a second step.
                    PrError::Gh(error) if step > 0 => PrError::Gh(format!(
                        "the reply posted, but resolving the thread failed; call \
                         reply_to_review_thread again with resolve and no body: {error}"
                    )),
                    error => error,
                })?;
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
    Ok(PrWriteResult { url })
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
        PrWrite::Unknown => Err("unknown pull request write".to_owned()),
    }
}

#[cfg(test)]
mod tests;
