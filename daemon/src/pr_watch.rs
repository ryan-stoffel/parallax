//! Pull request watches (0063), as T3 Code's `PullRequestWatchReactor` and `pullRequestWatch`:
//! `pr/watch` has plxd read one of a run's linked pull requests every two minutes and wake the run
//! when a check newly fails, the required checks (else all) pass, someone comments or reviews, or
//! the branch starts to conflict. A remark by the account plxd reads as, or by the author when
//! that account is unknown, never wakes.
//!
//! A watch is a row of `pr_watches`: what its run was last told, as JSON. [`run`] sweeps every
//! [`SWEEP`] while a watch exists, and sets no timer while none does. Each pass reads each watched
//! pull request once, with one `gh api graphql` call, for every run that watches it. A run's new
//! watch state and its wake commit together, in its lane and only while the same watch is on, so
//! an unwatch during the read wins. The wake is a `thread.wake` effect, sent with `agent/send`
//! queued behind the run's turn ([`crate::schedules::deliver`]).
//!
//! A watch ends when its pull request merges or closes, when its thread settles or is archived,
//! after [`WAKE_LIMIT`] comment-only wakes in a row, or after [`READ_FAILURE_LIMIT`] failed reads
//! in a row; a rate limit only delays it. A watch goes with its run.

use std::collections::{BTreeMap, HashMap};
use std::sync::{Arc, Mutex, PoisonError};
use std::time::Duration;

use jiff::Timestamp;
use parallax_protocol::jsonrpc::ErrorObject;
use parallax_protocol::{
    PrViewParams, PrWatchResult, PrWatchesParams, PrWatchesResult, RunId, TurnId,
};
use serde::{Deserialize, Serialize};
use tokio::sync::Notify;
use tokio_util::sync::CancellationToken;
use tracing::{info, warn};
use uuid::Uuid;

use crate::schedules::{To, Wake};
use crate::server::Daemon;
use crate::store::{Tx, store_error};
use crate::worktree::PrError;

/// Time between passes. Checks take minutes, so a faster pass mostly spends the user's GitHub
/// rate limit.
const SWEEP: Duration = Duration::from_mins(2);

/// Reads in a row that fail, other than for a rate limit, before a watch ends.
const READ_FAILURE_LIMIT: u32 = 8;

/// Wakes in a row that bring only comments before a watch ends. Check, conflict, or push news
/// resets the count, so this only stops a chatty bot looping an agent that replies to it.
const WAKE_LIMIT: u32 = 10;

/// Items listed per change in a wake, and the length of a comment's snippet.
const LISTED: usize = 10;
const SNIPPET: usize = 200;

/// One `gh api graphql` read: the viewer, and the pull request's state, head, checks with
/// whether each is required, mergeability, and its newest comments, reviews, and review-thread
/// comments.
// ponytail: reads the newest 50 comments, reviews, and threads (20 comments each) per pass;
// page them if a pull request ever gets more than that between two passes.
const QUERY: &str = "query($owner: String!, $name: String!, $number: Int!) {
  viewer { login }
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      state
      author { login }
      baseRefName
      headRefOid
      mergeable
      commits(last: 1) { nodes { commit { statusCheckRollup { contexts(first: 100) { nodes {
        __typename
        ... on CheckRun { name status conclusion detailsUrl isRequired(pullRequestNumber: $number) }
        ... on StatusContext { context state targetUrl isRequired(pullRequestNumber: $number) }
      } } } } } }
      comments(last: 50) { nodes { id author { login } body createdAt lastEditedAt url } }
      reviews(last: 50) { nodes { id author { login } body state submittedAt lastEditedAt url } }
      reviewThreads(last: 50) { nodes { path comments(last: 20) { nodes {
        id author { login } body createdAt lastEditedAt url
      } } } }
    }
  }
}";

/// The sweep's wake-up when the first watch starts, and each pull request's failed reads in a
/// row. The count is kept in memory: a restart only delays the end.
#[derive(Default)]
pub(crate) struct Watches {
    started: Notify,
    failures: Mutex<HashMap<String, u32>>,
}

/// What a watch's run was last told, as T3's `ThreadPullRequestWatch`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Watch {
    started_at: Timestamp,
    head_sha: Option<String>,
    failed_checks: Vec<String>,
    passed: bool,
    passed_checks: Vec<String>,
    /// Remarks active at or before it were told, but for those at it, only `remark_ids`.
    remarks_through: Timestamp,
    remark_ids: Vec<String>,
    conflicting: bool,
    wakes: u32,
}

impl Watch {
    fn new(now: Timestamp) -> Self {
        Self {
            started_at: now,
            head_sha: None,
            failed_checks: Vec::new(),
            passed: false,
            passed_checks: Vec::new(),
            remarks_through: now,
            remark_ids: Vec::new(),
            conflicting: false,
            wakes: 0,
        }
    }
}

/// A pull request as one read saw it.
#[derive(Debug, Default)]
struct Detail {
    state: String,
    head_sha: Option<String>,
    base_branch: String,
    checks: Vec<Check>,
    /// `MERGEABLE`, `CONFLICTING`, or `UNKNOWN` while GitHub works it out.
    mergeable: String,
    /// The account plxd reads as, whose own remarks never wake.
    viewer: Option<String>,
    author: Option<String>,
    remarks: Vec<Remark>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct Check {
    name: String,
    state: CheckState,
    required: bool,
    url: Option<String>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum CheckState {
    Pending,
    Passed,
    /// Failed, cancelled, timed out, or waiting on someone, with how, in lowercase.
    Failed(&'static str),
}

/// A comment, a review, or a review-thread comment.
#[derive(Clone, Debug, PartialEq, Eq)]
struct Remark {
    id: String,
    author: Option<String>,
    body: String,
    /// When it was written, or last edited, which counts as new activity.
    at: Timestamp,
    url: Option<String>,
    /// The file of a review-thread comment.
    path: Option<String>,
    /// A review's verdict.
    review: Option<String>,
}

/// News a run hasn't been told.
#[derive(Debug, PartialEq, Eq)]
enum Change {
    ChecksFailed(Vec<Check>),
    ChecksPassed { count: usize, required: bool },
    Remarks(Vec<Remark>),
    Conflicting,
}

/// A pass's verdict on one watch.
#[derive(Debug, PartialEq, Eq)]
struct Report {
    /// Empty means no wake.
    changes: Vec<Change>,
    /// The watch to record, wake or not.
    next: Watch,
    /// This wake spends the last comment-only wake, so the watch ends after it.
    exhausted: bool,
}

/// `pr/watch`: links the pull request if it isn't, refuses one that isn't open or a thread that
/// is settled or archived, and starts watching it.
pub(crate) async fn watch(
    daemon: &Arc<Daemon>,
    params: PrViewParams,
) -> Result<PrWatchResult, ErrorObject> {
    let PrViewParams { run_id, url } = params;
    let run = crate::agents::link_pr(Arc::clone(daemon), run_id, url.clone(), true).await?;
    let id = Uuid::from(run_id);
    let thread = daemon
        .reader
        .run(&CancellationToken::new(), move |db| {
            db.get_thread(id).map_err(|e| store_error(&e))
        })
        .await?;
    if thread.is_some_and(|thread| thread.settled || thread.archived) {
        return Err(ErrorObject::invalid_params(
            "the thread is settled or archived; unsettle it before watching a pull request",
        ));
    }
    let detail = read(daemon, &url).await.map_err(|error| {
        ErrorObject::invalid_params(format!("could not read the pull request: {error}"))
    })?;
    if detail.state != "OPEN" {
        return Err(ErrorObject::invalid_params(format!(
            "the pull request is {}, so there is nothing to watch",
            detail.state.to_lowercase()
        )));
    }
    debug_assert!(run.pull_requests.contains(&url));
    let _lane = daemon.orchestrator.lane(id).await;
    let key = url.clone();
    let was_watching = daemon
        .store
        .run(&CancellationToken::new(), move |db| {
            if db
                .pr_watch(id, &key)
                .map_err(|e| store_error(&e))?
                .is_some()
            {
                return Ok(true);
            }
            let watch = serde_json::to_string(&Watch::new(Timestamp::now()))
                .map_err(ErrorObject::internal_error)?;
            db.put_pr_watch(id, &key, &watch)
                .map_err(|e| store_error(&e))?;
            Ok(false)
        })
        .await?;
    daemon.pr_watches.started.notify_one();
    Ok(PrWatchResult {
        url,
        watching: true,
        was_watching,
    })
}

/// `pr/unwatch`: stops watching; the pull request stays linked.
pub(crate) async fn unwatch(
    daemon: &Daemon,
    params: PrViewParams,
) -> Result<PrWatchResult, ErrorObject> {
    let PrViewParams { run_id, url } = params;
    let id = Uuid::from(run_id);
    let _lane = daemon.orchestrator.lane(id).await;
    let key = url.clone();
    let was_watching = daemon
        .store
        .run(&CancellationToken::new(), move |db| {
            db.delete_pr_watch(id, &key).map_err(|e| store_error(&e))
        })
        .await?;
    Ok(PrWatchResult {
        url,
        watching: false,
        was_watching,
    })
}

/// `pr/watches`.
pub(crate) async fn watches(
    daemon: &Daemon,
    params: PrWatchesParams,
) -> Result<PrWatchesResult, ErrorObject> {
    let id = Uuid::from(params.run_id);
    let watches = daemon
        .reader
        .run(&CancellationToken::new(), |db| {
            db.pr_watches().map_err(|e| store_error(&e))
        })
        .await?;
    Ok(PrWatchesResult {
        urls: watches
            .into_iter()
            .filter(|(run, _, _)| *run == id)
            .map(|(_, url, _)| url)
            .collect(),
    })
}

/// The sweep: see the module documentation. Returns when `stop` is cancelled.
pub(crate) async fn run(daemon: Arc<Daemon>, stop: CancellationToken) {
    loop {
        let any = daemon
            .reader
            .run(&CancellationToken::new(), |db| {
                db.any_pr_watch().map_err(|e| store_error(&e))
            })
            .await
            .unwrap_or_else(|error| {
                warn!(error = %error.message, "could not read whether a pull request is watched");
                true
            });
        if !any {
            tokio::select! {
                () = stop.cancelled() => return,
                () = daemon.pr_watches.started.notified() => continue,
            }
        }
        tokio::select! {
            () = stop.cancelled() => return,
            () = tokio::time::sleep(SWEEP) => sweep(&daemon).await,
        }
    }
}

/// One watch as the sweep found it.
struct Target {
    run: Uuid,
    watch: Watch,
    /// Its thread settled or was archived since.
    ended: bool,
}

/// One pass over every watched pull request.
async fn sweep(daemon: &Daemon) {
    let found = daemon
        .reader
        .run(&CancellationToken::new(), |db| {
            let mut found: BTreeMap<String, Vec<Target>> = BTreeMap::new();
            for (run, url, payload) in db.pr_watches().map_err(|e| store_error(&e))? {
                let Ok(watch) = serde_json::from_str(&payload) else {
                    warn!(%run, %url, "a stored pull request watch can't be read; skipping it");
                    continue;
                };
                let ended = db
                    .get_thread(run)
                    .map_err(|e| store_error(&e))?
                    .is_some_and(|thread| thread.settled || thread.archived);
                found
                    .entry(url)
                    .or_default()
                    .push(Target { run, watch, ended });
            }
            Ok(found)
        })
        .await;
    let found = match found {
        Ok(found) => found,
        Err(error) => return warn!(error = %error.message, "could not read the watches"),
    };
    daemon
        .pr_watches
        .failures
        .lock()
        .unwrap_or_else(PoisonError::into_inner)
        .retain(|url, _| found.contains_key(url));
    for (url, targets) in found {
        let (ended, targets): (Vec<_>, Vec<_>) =
            targets.into_iter().partition(|target| target.ended);
        for target in ended {
            record(daemon, &url, &target, None, None, "settled").await;
        }
        if !targets.is_empty() {
            pass(daemon, &url, &targets).await;
        }
    }
}

/// Reads `url` once for `targets`, and records what each should hear.
async fn pass(daemon: &Daemon, url: &str, targets: &[Target]) {
    let detail = match read(daemon, url).await {
        Ok(detail) => detail,
        Err(error) if error.to_string().to_lowercase().contains("rate limit") => {
            return info!(%url, "GitHub is rate limiting reads; watching again next pass");
        }
        Err(error) => {
            let failures = {
                let mut failures = daemon
                    .pr_watches
                    .failures
                    .lock()
                    .unwrap_or_else(PoisonError::into_inner);
                let count = failures.entry(url.to_owned()).or_default();
                *count += 1;
                *count
            };
            warn!(%url, failures, %error, "could not read a watched pull request");
            if failures >= READ_FAILURE_LIMIT {
                let text = format!(
                    "Parallax stopped watching pull request {url} because it failed to read it \
                     from GitHub {READ_FAILURE_LIMIT} times in a row. Check it yourself, and call \
                     watch_pull_request to watch it again."
                );
                for target in targets {
                    record(daemon, url, target, None, Some(text.clone()), "unreadable").await;
                }
                daemon
                    .pr_watches
                    .failures
                    .lock()
                    .unwrap_or_else(PoisonError::into_inner)
                    .remove(url);
            }
            return;
        }
    };
    daemon
        .pr_watches
        .failures
        .lock()
        .unwrap_or_else(PoisonError::into_inner)
        .remove(url);
    match detail.state.as_str() {
        "OPEN" => {}
        "CLOSED" => {
            let text = format!(
                "Pull request {url} was closed, so Parallax stopped watching it. Call \
                 watch_pull_request if it reopens."
            );
            for target in targets {
                record(daemon, url, target, None, Some(text.clone()), "closed").await;
            }
            return;
        }
        _ => {
            for target in targets {
                record(daemon, url, target, None, None, "merged").await;
            }
            return;
        }
    }
    for target in targets {
        let report = evaluate(&target.watch, &detail);
        if !report.changes.is_empty() {
            let text = message(url, &detail, &report);
            let next = (!report.exhausted).then_some(report.next);
            let ended = if next.is_none() { "comment-limit" } else { "" };
            record(daemon, url, target, next, Some(text), ended).await;
        } else if report.next != target.watch {
            record(daemon, url, target, Some(report.next), None, "").await;
        }
    }
}

/// Records `target`'s next watch, or ends it with `None`, and wakes its run with `text`, in its
/// lane and only while the same watch is on. `ended` names why a watch ends, for the log.
async fn record(
    daemon: &Daemon,
    url: &str,
    target: &Target,
    next: Option<Watch>,
    text: Option<String>,
    ended: &str,
) {
    let run = target.run;
    let started_at = target.watch.started_at;
    let key = url.to_owned();
    let _lane = daemon.orchestrator.lane(run).await;
    let recorded = daemon
        .store
        .run(&CancellationToken::new(), move |db| {
            record_job(db, run, &key, started_at, next.as_ref(), text)
        })
        .await;
    match recorded {
        Ok(true) => {
            daemon.orchestrator.notify();
            if !ended.is_empty() {
                info!(%run, %url, reason = ended, "a pull request watch ended");
            }
        }
        Ok(false) => {}
        Err(error) => warn!(%run, %url, error = %error.message, "could not record a watch"),
    }
}

/// [`record`]'s job. Says whether it changed anything.
fn record_job(
    db: &Tx,
    run: Uuid,
    url: &str,
    started_at: Timestamp,
    next: Option<&Watch>,
    text: Option<String>,
) -> Result<bool, ErrorObject> {
    let current = db.pr_watch(run, url).map_err(|e| store_error(&e))?;
    let same = current
        .and_then(|payload| serde_json::from_str::<Watch>(&payload).ok())
        .is_some_and(|watch| watch.started_at == started_at);
    if !same {
        return Ok(false);
    }
    match next {
        Some(next) => {
            let payload = serde_json::to_string(next).map_err(ErrorObject::internal_error)?;
            db.put_pr_watch(run, url, &payload)
        }
        None => db.delete_pr_watch(run, url).map(drop),
    }
    .map_err(|e| store_error(&e))?;
    if let Some(text) = text {
        let run_id = RunId::try_from(run)
            .map_err(|_| ErrorObject::internal_error(format!("run {run} has an invalid id")))?;
        let command_id = format!("pr-watch:{run}:{}", Uuid::now_v7());
        let wake = Wake {
            task: None,
            to: To::Thread {
                run_id,
                turn_id: TurnId::generate(),
            },
            text,
        };
        crate::orchestrator::enqueue_wake(db, &command_id, run, wake)?;
    }
    Ok(true)
}

/// Compares a watched pull request with what its run was last told, as T3's
/// `evaluatePullRequestWatch`. Each check is told as soon as it fails, so one that never finishes
/// can't hold the news back. "Passed" is told once the required checks all pass, or all checks
/// where none is required. A remark counts when someone other than the viewer or the author wrote
/// or edited it since.
#[expect(
    clippy::too_many_lines,
    reason = "T3's evaluatePullRequestWatch, step by step"
)]
fn evaluate(watch: &Watch, detail: &Detail) -> Report {
    let mut changes = Vec::new();
    let head_moved = detail.head_sha != watch.head_sha;
    // An empty list keeps the last state: GitHub can answer with one when its check read fails.
    let mut failed_checks = if head_moved {
        Vec::new()
    } else {
        watch.failed_checks.clone()
    };
    let mut passed = !head_moved && watch.passed;
    let mut passed_checks = if head_moved {
        Vec::new()
    } else {
        watch.passed_checks.clone()
    };
    if !detail.checks.is_empty() {
        let failed: Vec<&Check> = detail
            .checks
            .iter()
            .filter(|check| matches!(check.state, CheckState::Failed(_)))
            .collect();
        let newly: Vec<Check> = failed
            .iter()
            .filter(|check| !failed_checks.contains(&check.name))
            .map(|check| (*check).clone())
            .collect();
        if !newly.is_empty() {
            changes.push(Change::ChecksFailed(newly));
        }
        // A check that runs again leaves the list, so a rerun that fails again is told.
        failed_checks = failed.iter().map(|check| check.name.clone()).collect();

        let required: Vec<&Check> = detail
            .checks
            .iter()
            .filter(|check| check.required)
            .collect();
        let gate: Vec<&Check> = if required.is_empty() {
            detail.checks.iter().collect()
        } else {
            required.clone()
        };
        let passed_now = gate.iter().all(|check| check.state == CheckState::Passed);
        let names: Vec<String> = gate.iter().map(|check| check.name.clone()).collect();
        // A required check created and finished between two passes is never seen pending.
        let gate_grew =
            !required.is_empty() && names.iter().any(|name| !passed_checks.contains(name));
        if passed_now && (!passed || gate_grew) {
            changes.push(Change::ChecksPassed {
                count: gate.len(),
                required: !required.is_empty(),
            });
        }
        passed = passed_now;
        passed_checks = if passed_now { names } else { Vec::new() };
    }

    let own = detail
        .viewer
        .as_deref()
        .or(detail.author.as_deref())
        .map(str::to_lowercase);
    let fresh: Vec<Remark> = detail
        .remarks
        .iter()
        .filter(|remark| {
            (remark.at > watch.remarks_through
                || (remark.at == watch.remarks_through && !watch.remark_ids.contains(&remark.id)))
                && remark.author.as_deref().map(str::to_lowercase) != own
        })
        .cloned()
        .collect();
    let latest = fresh
        .iter()
        .map(|remark| remark.at)
        .max()
        .map_or(watch.remarks_through, |at| at.max(watch.remarks_through));
    let mut remark_ids = if latest == watch.remarks_through {
        watch.remark_ids.clone()
    } else {
        Vec::new()
    };
    remark_ids.extend(
        fresh
            .iter()
            .filter(|remark| remark.at == latest)
            .map(|remark| remark.id.clone()),
    );
    if !fresh.is_empty() {
        changes.push(Change::Remarks(fresh));
    }

    if detail.mergeable == "CONFLICTING" && !watch.conflicting {
        changes.push(Change::Conflicting);
    }
    // `UNKNOWN` is GitHub still working it out after a push; only a clean answer clears it.
    let conflicting = if detail.mergeable == "UNKNOWN" {
        watch.conflicting
    } else {
        detail.mergeable == "CONFLICTING"
    };

    let comments_only = !changes.is_empty()
        && changes
            .iter()
            .all(|change| matches!(change, Change::Remarks(_)));
    let progress = head_moved || (!changes.is_empty() && !comments_only);
    let wakes = if progress { 0 } else { watch.wakes } + u32::from(comments_only);
    Report {
        changes,
        next: Watch {
            started_at: watch.started_at,
            head_sha: detail.head_sha.clone(),
            failed_checks,
            passed,
            passed_checks,
            remarks_through: latest,
            remark_ids,
            conflicting,
            wakes,
        },
        exhausted: comments_only && wakes >= WAKE_LIMIT,
    }
}

/// The wake the run reads, as T3's `pullRequestWatchMessage`.
fn message(url: &str, detail: &Detail, report: &Report) -> String {
    let commit = detail
        .head_sha
        .as_deref()
        .map(|sha| format!(" on {}", &sha[..sha.len().min(7)]))
        .unwrap_or_default();
    let mut lines = vec![format!(
        "Update on pull request {url}, which Parallax is watching for you:"
    )];
    for change in &report.changes {
        match change {
            Change::ChecksFailed(failed) => {
                lines.push(format!("- Checks failed{commit}:"));
                listed(&mut lines, failed, |check| {
                    let how = match check.state {
                        CheckState::Failed(how) if how != "failure" => format!(" ({how})"),
                        _ => String::new(),
                    };
                    let link = check
                        .url
                        .as_ref()
                        .map(|url| format!(" {url}"))
                        .unwrap_or_default();
                    format!("  - {}{how}{link}", check.name)
                });
            }
            Change::ChecksPassed { count, required } => {
                let required = if *required { "required " } else { "" };
                let checks = if *count == 1 { "check" } else { "checks" };
                lines.push(format!("- All {count} {required}{checks} passed{commit}."));
            }
            Change::Remarks(remarks) => {
                let comments = if remarks.len() == 1 {
                    "comment"
                } else {
                    "comments"
                };
                lines.push(format!("- {} new {comments}:", remarks.len()));
                listed(&mut lines, remarks, |remark| {
                    let who = remark.author.as_deref().unwrap_or("someone");
                    let on = remark
                        .path
                        .as_ref()
                        .map(|path| format!(" on {path}"))
                        .unwrap_or_default();
                    let body = snippet(&remark.body);
                    let said = if body.is_empty() {
                        remark
                            .review
                            .as_deref()
                            .unwrap_or("reviewed")
                            .to_lowercase()
                    } else {
                        format!("\"{body}\"")
                    };
                    let link = remark
                        .url
                        .as_ref()
                        .map(|url| format!(" {url}"))
                        .unwrap_or_default();
                    format!("  - {who}{on}: {said}{link}")
                });
            }
            Change::Conflicting => {
                lines.push(format!(
                    "- The branch now conflicts with {}.",
                    detail.base_branch
                ));
            }
        }
    }
    lines.push(String::new());
    lines.push(if report.exhausted {
        format!(
            "Parallax stopped watching after {WAKE_LIMIT} comment-only updates in a row. Call \
             watch_pull_request to watch it again."
        )
    } else {
        "Look into each item and act on it as your task requires. Parallax keeps watching and \
         wakes you on the next change, so end your turn when you are done. When you hand the \
         work back to the user, call unwatch_pull_request first."
            .to_owned()
    });
    lines.join("\n")
}

fn listed<T>(lines: &mut Vec<String>, items: &[T], line: impl Fn(&T) -> String) {
    lines.extend(items.iter().take(LISTED).map(line));
    if items.len() > LISTED {
        lines.push(format!("  - and {} more", items.len() - LISTED));
    }
}

/// A remark's text on one line, without HTML comments, at most [`SNIPPET`] characters.
fn snippet(body: &str) -> String {
    let mut text = String::with_capacity(body.len());
    let mut rest = body;
    while let Some(start) = rest.find("<!--") {
        text.push_str(&rest[..start]);
        text.push(' ');
        rest = rest[start..]
            .find("-->")
            .map_or("", |end| &rest[start + end + 3..]);
    }
    text.push_str(rest);
    let text = text.split_whitespace().collect::<Vec<_>>().join(" ");
    if text.chars().count() <= SNIPPET {
        return text;
    }
    let cut: String = text.chars().take(SNIPPET - 3).collect();
    format!("{cut}...")
}

/// Reads pull request `url` with one `gh api graphql` call.
async fn read(daemon: &Daemon, url: &str) -> Result<Detail, PrError> {
    let (owner, name, number) = parts(url)
        .ok_or_else(|| PrError::Gh(format!("{url:?} is not a GitHub pull request URL")))?;
    let args = [
        "api".to_owned(),
        "graphql".to_owned(),
        "-f".to_owned(),
        format!("query={QUERY}"),
        "-f".to_owned(),
        format!("owner={owner}"),
        "-f".to_owned(),
        format!("name={name}"),
        "-F".to_owned(),
        format!("number={number}"),
    ];
    let args: Vec<&str> = args.iter().map(String::as_str).collect();
    let answer = daemon
        .agents
        .worktrees()
        .gh(&std::env::temp_dir(), &args)
        .await?;
    parse(&answer)
}

/// `https://github.com/<owner>/<name>/pull/<number>`'s parts.
fn parts(url: &str) -> Option<(&str, &str, u64)> {
    let mut parts = url.strip_prefix("https://github.com/")?.split('/');
    let (owner, name) = (parts.next()?, parts.next()?);
    (parts.next()? == "pull").then_some(())?;
    Some((owner, name, parts.next()?.parse().ok()?))
}

/// `gh api graphql`'s answer to [`QUERY`].
fn parse(answer: &str) -> Result<Detail, PrError> {
    let answer: Answer = serde_json::from_str(answer)
        .map_err(|error| PrError::Gh(format!("could not read GitHub's answer: {error}")))?;
    if let Some(error) = answer.errors.first() {
        return Err(PrError::Gh(error.message.clone()));
    }
    let data = answer
        .data
        .ok_or_else(|| PrError::Gh("GitHub answered with no data".to_owned()))?;
    let pr = data
        .repository
        .and_then(|repository| repository.pull_request)
        .ok_or_else(|| PrError::Gh("GitHub has no such pull request".to_owned()))?;
    let checks = pr
        .commits
        .nodes
        .into_iter()
        .flatten()
        .filter_map(|node| node.commit.status_check_rollup)
        .flat_map(|rollup| rollup.contexts.nodes.into_iter().flatten())
        .map(|context| Check {
            state: check_state(&context),
            name: context.name.or(context.context).unwrap_or_default(),
            required: context.is_required,
            url: context.details_url.or(context.target_url),
        })
        .collect();
    let mut remarks: Vec<Remark> = pr
        .comments
        .nodes
        .into_iter()
        .flatten()
        .filter_map(|comment| remark(comment, None, None))
        .collect();
    remarks.extend(pr.reviews.nodes.into_iter().flatten().filter_map(|review| {
        let state = review.state.clone().unwrap_or_default();
        // A pending review isn't sent, and an empty COMMENTED one only holds thread comments.
        if state == "PENDING" || (state == "COMMENTED" && review.body.trim().is_empty()) {
            return None;
        }
        remark(review, None, Some(state))
    }));
    for thread in pr.review_threads.nodes.into_iter().flatten() {
        let path = thread.path;
        remarks.extend(
            thread
                .comments
                .nodes
                .into_iter()
                .flatten()
                .filter_map(|comment| remark(comment, path.clone(), None)),
        );
    }
    remarks.sort_by_key(|remark| remark.at);
    Ok(Detail {
        state: pr.state,
        head_sha: pr.head_ref_oid,
        base_branch: pr.base_ref_name,
        checks,
        mergeable: pr.mergeable,
        viewer: data.viewer.map(|viewer| viewer.login),
        author: pr.author.map(|author| author.login),
        remarks,
    })
}

fn check_state(context: &RollupNode) -> CheckState {
    let failed = |how: &str| -> CheckState {
        CheckState::Failed(match how {
            "CANCELLED" => "cancelled",
            "TIMED_OUT" => "timed out",
            "ACTION_REQUIRED" => "action required",
            "STARTUP_FAILURE" => "startup failure",
            "ERROR" => "error",
            _ => "failure",
        })
    };
    match (
        context.status.as_deref(),
        context.conclusion.as_deref(),
        context.state.as_deref(),
    ) {
        // A check run is done once completed; a commit status has only a state.
        (Some("COMPLETED"), Some("SUCCESS" | "NEUTRAL" | "SKIPPED" | "STALE"), _)
        | (None, _, Some("SUCCESS")) => CheckState::Passed,
        (Some("COMPLETED"), Some(how), _) | (None, _, Some(how @ ("FAILURE" | "ERROR"))) => {
            failed(how)
        }
        _ => CheckState::Pending,
    }
}

fn remark(comment: Comment, path: Option<String>, review: Option<String>) -> Option<Remark> {
    let at = comment
        .last_edited_at
        .or(comment.created_at)
        .or(comment.submitted_at)?;
    Some(Remark {
        id: comment.id,
        author: comment.author.map(|author| author.login),
        body: comment.body,
        at,
        url: comment.url,
        path,
        review,
    })
}

#[derive(Deserialize)]
struct Answer {
    data: Option<Data>,
    #[serde(default)]
    errors: Vec<GraphqlError>,
}

#[derive(Deserialize)]
struct GraphqlError {
    message: String,
}

#[derive(Deserialize)]
struct Data {
    viewer: Option<Login>,
    repository: Option<Repository>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Repository {
    pull_request: Option<PullRequest>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PullRequest {
    state: String,
    author: Option<Login>,
    base_ref_name: String,
    head_ref_oid: Option<String>,
    mergeable: String,
    commits: Nodes<CommitNode>,
    comments: Nodes<Comment>,
    reviews: Nodes<Comment>,
    review_threads: Nodes<Thread>,
}

#[derive(Deserialize)]
struct Login {
    login: String,
}

/// A connection's `nodes`, any of which GitHub may answer as null.
#[derive(Deserialize)]
struct Nodes<T> {
    nodes: Vec<Option<T>>,
}

#[derive(Deserialize)]
struct CommitNode {
    commit: Commit,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Commit {
    status_check_rollup: Option<Rollup>,
}

#[derive(Deserialize)]
struct Rollup {
    contexts: Nodes<RollupNode>,
}

/// A check run (`name`, `status`, `conclusion`, `detailsUrl`) or a commit status (`context`,
/// `state`, `targetUrl`).
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RollupNode {
    name: Option<String>,
    status: Option<String>,
    conclusion: Option<String>,
    details_url: Option<String>,
    context: Option<String>,
    state: Option<String>,
    target_url: Option<String>,
    #[serde(default)]
    is_required: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Comment {
    id: String,
    author: Option<Login>,
    #[serde(default)]
    body: String,
    created_at: Option<Timestamp>,
    submitted_at: Option<Timestamp>,
    last_edited_at: Option<Timestamp>,
    url: Option<String>,
    state: Option<String>,
}

#[derive(Deserialize)]
struct Thread {
    path: Option<String>,
    comments: Nodes<Comment>,
}

#[cfg(test)]
mod tests;
