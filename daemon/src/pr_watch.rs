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
//! [`status`], `pr/status` (PLX-837), reads a pull request the same way, plus how far its head is
//! behind its base, and says whether it is ready to merge, so agents never read it with `gh`
//! themselves. Every read of a pull request, by any run's status, a watch, or the sweep, is shared
//! for [`SHARE`] (PLX-1018), so several agents asking about one pull request cost one read. A
//! shared read never answers ready: [`judged`] reads again first.
//!
//! [`merge_when_ready`], `pr/mergeWhenReady` (PLX-1022), records a merge in a watch. Each pass
//! that finds the pull request ready by [`blockers`] reads it again fresh and merges it, pinned to
//! that read's head, through `crate::pr_write`'s queue, then wakes the run and ends the watch.
//!
//! A watch ends when its pull request merges or closes, when its thread settles or is archived,
//! after [`WAKE_LIMIT`] comment-only wakes in a row, or after [`READ_FAILURE_LIMIT`] failed reads
//! in a row; a rate limit only delays it. A watch goes with its run.

use std::collections::{BTreeMap, HashMap};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};
use std::time::{Duration, Instant};

use jiff::Timestamp;
use parallax_protocol::jsonrpc::ErrorObject;
use parallax_protocol::{
    ParallaxEvent, PrCheck, PrCheckState, PrComment, PrCommentKind, PrCommit, PrFile, PrLabel,
    PrMergeMethod, PrMergeState, PrMergeWhenReadyParams, PrReview, PrReviewDecision, PrReviewState,
    PrReviewThread, PrState, PrStatusCheck, PrStatusFile, PrStatusResult, PrStatusThread,
    PrThreadComment, PrViewParams, PrWatchResult, PrWatchesParams, PrWatchesResult,
    PullRequest as PrView, RunId, ScopeId, TurnId,
};
use parallax_store::Store;
use serde::{Deserialize, Serialize};
use tokio::sync::Notify;
use tokio_util::sync::CancellationToken;
use tracing::{info, warn};
use uuid::Uuid;

use crate::pr_write::Refusal;
use crate::schedules::{To, Wake};
use crate::server::Daemon;
use crate::store::{Tx, store_error};
use crate::worktree::PrError;

/// Time between passes. Checks take minutes, so a faster pass mostly spends the user's GitHub
/// rate limit.
const SWEEP: Duration = Duration::from_mins(2);

/// How long a read of a pull request serves every later read of it.
const SHARE: Duration = Duration::from_secs(30);

/// Reads in a row that fail, other than for a rate limit, before a watch ends.
const READ_FAILURE_LIMIT: u32 = 8;

/// Wakes in a row that bring only comments before a watch ends. Check, conflict, or push news
/// resets the count, so this only stops a chatty bot looping an agent that replies to it.
const WAKE_LIMIT: u32 = 10;

/// Items listed per change in a wake, and the length of a comment's snippet.
const LISTED: usize = 10;
const SNIPPET: usize = 200;

/// One `gh api graphql` read: the viewer, the GraphQL quota left (for the `gh` shim, PLX-1023),
/// the repository's allowed merge methods, and the pull request's title, body, state, draft,
/// times, head and base, size, labels, review requests, commits, auto-merge, changed files, checks
/// with whether each is required and its Actions run and job, the head's check suites,
/// mergeability, merge state, whether the base has a merge queue, review decision, and its newest
/// comments, reviews, and review threads, resolved or not. It serves `pr/view` too (PLX-1151), at
/// about two points of the GraphQL quota.
// ponytail: reads the first 100 files, 20 labels and review requests, the newest 100 commits,
// comments, reviews, and threads, and each thread's first 50 comments per read; page them if a
// pull request ever gets more than that.
const QUERY: &str = "query($owner: String!, $name: String!, $number: Int!) {
  viewer { login }
  rateLimit { remaining resetAt }
  repository(owner: $owner, name: $name) {
    mergeCommitAllowed squashMergeAllowed rebaseMergeAllowed
    pullRequest(number: $number) {
      number
      url
      title
      body
      state
      isDraft
      createdAt
      updatedAt
      closedAt
      mergedAt
      mergedBy { login }
      mergeStateStatus
      reviewDecision
      author { login avatarUrl }
      baseRefName
      headRefName
      headRefOid
      headRepository { nameWithOwner }
      mergeable
      isMergeQueueEnabled
      additions
      deletions
      changedFiles
      autoMergeRequest { mergeMethod }
      labels(first: 20) { nodes { name color } }
      reviewRequests(first: 20) { nodes { requestedReviewer {
        ... on User { login } ... on Bot { login } ... on Mannequin { login } ... on Team { name }
      } } }
      files(first: 100) { nodes { path additions deletions } }
      history: commits(last: 100) { nodes { commit {
        oid messageHeadline committedDate author { name user { login } }
      } } }
      commits(last: 1) { nodes { commit {
        checkSuites(first: 50) {
          pageInfo { hasNextPage } nodes { status workflowRun { databaseId } }
        }
        statusCheckRollup { contexts(first: 100) { nodes {
        __typename
        ... on CheckRun {
          name status conclusion detailsUrl startedAt completedAt databaseId
          isRequired(pullRequestNumber: $number)
          checkSuite { workflowRun { databaseId workflow { name } } }
        }
        ... on StatusContext {
          context state targetUrl createdAt isRequired(pullRequestNumber: $number)
        }
      } } } } } }
      comments(last: 100) { nodes {
        id author { login avatarUrl } body createdAt lastEditedAt url
      } }
      reviews(last: 100) { nodes {
        id author { login avatarUrl } body state submittedAt lastEditedAt url
      } }
      reviewThreads(last: 100) { pageInfo { hasPreviousPage } nodes {
        id path line originalLine isOutdated isResolved comments(first: 50) {
          pageInfo { hasNextPage } nodes {
            id author { login avatarUrl } body createdAt lastEditedAt url diffHunk
          }
        }
      } }
    }
  }
}";

/// How far `$head` is behind `$base`, for [`status`].
const BEHIND: &str = "query($owner: String!, $name: String!, $base: String!, $head: String!) {
  repository(owner: $owner, name: $name) { ref(qualifiedName: $base) { compare(headRef: $head) {
    behindBy
  } } }
}";

/// The sweep's wake-up when the first watch starts, each pull request's failed reads in a row,
/// and its last read with when it was made. Both are kept in memory: a restart only delays the
/// end, or costs one read.
#[derive(Default)]
pub(crate) struct Watches {
    started: Notify,
    failures: Mutex<HashMap<String, u32>>,
    reads: Mutex<HashMap<String, (Instant, Detail)>>,
}

impl Watches {
    fn failures(&self) -> MutexGuard<'_, HashMap<String, u32>> {
        self.failures.lock().unwrap_or_else(PoisonError::into_inner)
    }

    fn reads(&self) -> MutexGuard<'_, HashMap<String, (Instant, Detail)>> {
        self.reads.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// `url`'s last read, while it is under [`SHARE`] old at `now`.
    fn shared(&self, url: &str, now: Instant) -> Option<Detail> {
        self.reads()
            .get(url)
            .filter(|(at, _)| now.saturating_duration_since(*at) < SHARE)
            .map(|(_, detail)| detail.clone())
    }

    /// Keeps `detail` as `url`'s last read, started at `at`, unless a read that started later is
    /// kept already, and drops reads too old to share.
    fn share(&self, url: &str, at: Instant, detail: &Detail) {
        let mut reads = self.reads();
        reads.retain(|_, (read, _)| at.saturating_duration_since(*read) < SHARE);
        if reads.get(url).is_some_and(|(read, _)| *read > at) {
            return;
        }
        reads.insert(url.to_owned(), (at, detail.clone()));
    }

    /// Adds `compared`, how far `head` is behind the base or why GitHub couldn't say, to `url`'s
    /// last read while it is still of `head`, so a call served from it needs no second compare,
    /// even one that failed.
    fn compared(&self, url: &str, head: &str, compared: Result<u64, String>) {
        if let Some((_, detail)) = self.reads().get_mut(url)
            && detail.head_sha.as_deref() == Some(head)
        {
            detail.compared = Some(compared);
        }
    }
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
    /// The merge `merge_when_ready` asked for, until plxd makes it or GitHub refuses it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    merge: Option<PrMergeMethod>,
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
            merge: None,
        }
    }
}

/// A pull request as one read saw it.
#[derive(Clone, Debug, Default)]
struct Detail {
    title: String,
    body: String,
    state: String,
    draft: bool,
    head_sha: Option<String>,
    head_branch: String,
    base_branch: String,
    /// How far the head is behind the base, or why GitHub couldn't compare them, once
    /// [`behind_of`] has asked.
    compared: Option<Result<u64, String>>,
    files: Vec<PrStatusFile>,
    checks: Vec<Check>,
    /// `MERGEABLE`, `CONFLICTING`, or `UNKNOWN` while GitHub works it out.
    mergeable: String,
    merge_state: String,
    /// The base branch has a merge queue, so a merge joins it rather than merging.
    merge_queue: bool,
    /// Why the head's check suites hold a merge: a GitHub Actions workflow hasn't finished, or
    /// the suites couldn't all be read. Jobs behind `needs:` aren't checks until they start, so
    /// the checks alone can look green mid-run.
    actions_hold: Option<String>,
    review_decision: Option<String>,
    /// Review threads nobody has resolved, by their first comment.
    unresolved: Vec<PrStatusThread>,
    /// The account plxd reads as, whose own remarks never wake.
    viewer: Option<String>,
    author: Option<String>,
    remarks: Vec<Remark>,
    /// The head branch's repository, as `owner/name`. Absent once a fork is deleted.
    head_repo: Option<String>,
    /// The pull request as `pr/view` serves it, but for what [`view`] adds. Absent when GitHub's
    /// answer left out what it needs.
    view: Option<PrView>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct Check {
    name: String,
    state: CheckState,
    required: bool,
    url: Option<String>,
    /// Its GitHub Actions workflow run.
    run_id: Option<u64>,
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
    ChecksPassed {
        count: usize,
        required: bool,
    },
    Remarks(Vec<Remark>),
    Conflicting,
    /// What became of the merge `merge_when_ready` asked for.
    Merge(String),
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
    let detail = read(daemon, &url)
        .await
        .map_err(|error| crate::agents::pr_error(&error))?;
    if detail.state != "OPEN" {
        return Err(ErrorObject::invalid_params(format!(
            "the pull request is {}, so there is nothing to watch",
            detail.state.to_lowercase()
        )));
    }
    debug_assert!(run.pull_requests.contains(&url));
    let _lane = daemon.dispatcher.lane(id).await;
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
            stage_watches(db, id)?;
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

/// `pr/mergeWhenReady`: watches the pull request as [`watch`] does, and records `method` in the
/// watch for a pass to merge it with once it is ready. Returns at once.
pub(crate) async fn merge_when_ready(
    daemon: &Arc<Daemon>,
    params: PrMergeWhenReadyParams,
) -> Result<PrWatchResult, ErrorObject> {
    let PrMergeWhenReadyParams {
        run_id,
        url,
        method,
    } = params;
    if method == PrMergeMethod::Unknown {
        return Err(ErrorObject::invalid_params(
            "method must be merge, squash, or rebase",
        ));
    }
    let watching = watch(
        daemon,
        PrViewParams {
            run_id,
            url: url.clone(),
        },
    )
    .await?;
    let id = Uuid::from(run_id);
    let _lane = daemon.dispatcher.lane(id).await;
    daemon
        .store
        .run(&CancellationToken::new(), move |db| {
            let payload = db.pr_watch(id, &url).map_err(|e| store_error(&e))?;
            let Some(mut watch) =
                payload.and_then(|payload| serde_json::from_str::<Watch>(&payload).ok())
            else {
                return Err(ErrorObject::internal_error(
                    "the watch ended before the merge was recorded; call merge_when_ready again",
                ));
            };
            watch.merge = Some(method);
            let payload = serde_json::to_string(&watch).map_err(ErrorObject::internal_error)?;
            db.put_pr_watch(id, &url, &payload)
                .map_err(|e| store_error(&e))
        })
        .await?;
    Ok(watching)
}

/// Why `merge_when_ready` can't merge `detail` yet: [`verdict`]'s reasons, but for being behind
/// its base, a GitHub Actions workflow still running, and GitHub's merge state unless that is
/// `CLEAN` or `HAS_HOOKS`. GitHub says `BEHIND` only when the base requires branches to be up to
/// date, so behind holds a merge only then.
fn blockers(url: &str, detail: &Detail) -> Vec<String> {
    let mut reasons = verdict(url.to_owned(), detail.clone(), 0, false).reasons;
    reasons.extend(detail.actions_hold.clone());
    if reasons.is_empty() && !matches!(detail.merge_state.as_str(), "CLEAN" | "HAS_HOOKS") {
        reasons.push(match detail.merge_state.as_str() {
            "BEHIND" => format!("{} requires it to be up to date", detail.base_branch),
            "BLOCKED" => "GitHub's branch rules block it, such as for a required review".to_owned(),
            state => format!("GitHub's merge state is {state:?}"),
        });
    }
    reasons
}

/// What a pass did about a watch's merge.
#[derive(Debug, PartialEq, Eq)]
enum Merging {
    /// It isn't ready, for these reasons.
    Waiting(Vec<String>),
    /// Merged at this head.
    Merged(String),
    /// Added to the base's merge queue at this head.
    Queued(String),
    /// Someone merged it already, such as another run's `merge_when_ready`.
    AlreadyMerged,
    /// Not this pass: a rate limit, a busy queue, a failed read, or a head that moved.
    Later,
    /// GitHub refused it, saying this.
    Refused(String),
}

/// Merges a pull request `shared`, a read that may be shared, shows ready by [`blockers`], once a
/// fresh read by `fetch` agrees, with `merge` pinned to the fresh read's head. A shared read can
/// predate a push, so only a read made for this merge decides it. A merge that ran out of time
/// may have gone through, so another fresh read tells.
async fn try_merge<Fetch, Merge>(
    url: &str,
    shared: &Detail,
    fetch: impl Fn() -> Fetch,
    merge: impl FnOnce(String) -> Merge,
) -> Merging
where
    Fetch: Future<Output = Result<Detail, PrError>>,
    Merge: Future<Output = Result<(), Refusal>>,
{
    let reasons = blockers(url, shared);
    if !reasons.is_empty() {
        return Merging::Waiting(reasons);
    }
    let Ok(fresh) = fetch().await else {
        return Merging::Later;
    };
    if fresh.state == "MERGED" {
        return Merging::AlreadyMerged;
    }
    let reasons = blockers(url, &fresh);
    let Some(head) = fresh.head_sha.filter(|_| reasons.is_empty()) else {
        return Merging::Waiting(reasons);
    };
    match merge(head.clone()).await {
        Ok(()) if fresh.merge_queue => Merging::Queued(head),
        Ok(()) => Merging::Merged(head),
        Err(Refusal::Later(why)) => {
            info!(%url, %why, "merging again next pass");
            Merging::Later
        }
        Err(Refusal::Unsure(why)) => match fetch().await {
            Ok(after) if after.state == "MERGED" => Merging::Merged(head),
            _ => {
                info!(%url, %why, "a merge ran out of time unmerged; merging again next pass");
                Merging::Later
            }
        },
        Err(Refusal::Final(why)) if why.contains("already merged") => Merging::AlreadyMerged,
        Err(Refusal::Final(why)) => Merging::Refused(why),
    }
}

/// `pr/status`: takes the shared read of `url` or reads it as a pass does, plus how far its head
/// is behind its base, and judges it with [`verdict`] through [`judged`]. The pull request needn't
/// be linked.
pub(crate) async fn status(
    daemon: &Daemon,
    params: PrViewParams,
) -> Result<PrStatusResult, ErrorObject> {
    let PrViewParams { run_id, url } = params;
    let id = Uuid::from(run_id);
    let watched = daemon
        .reader
        .run(&CancellationToken::new(), move |db| urls(db, id))
        .await?;
    let watching = watched.contains(&url);
    let unreadable = |error: PrError| {
        ErrorObject::invalid_params(format!("could not read the pull request: {error}"))
    };
    let shared = daemon.pr_watches.shared(&url, Instant::now());
    let url = &url;
    let fresh = move || async move { fetch(daemon, url).await.map_err(unreadable) };
    let judge = move |detail: Detail| async move {
        let behind_by = behind_of(daemon, url, &detail).await.map_err(unreadable)?;
        Ok(verdict(url.clone(), detail, behind_by, watching))
    };
    judged(shared, fresh, judge).await
}

/// How far `detail`'s head is behind its base: 0 unless it is open, else from the read, or from
/// one compare kept on the shared read, failed or not, for every later caller of the same head.
async fn behind_of(daemon: &Daemon, url: &str, detail: &Detail) -> Result<u64, PrError> {
    match (detail.state.as_str(), &detail.head_sha, &detail.compared) {
        ("OPEN", Some(_), Some(compared)) => compared.clone().map_err(PrError::Gh),
        ("OPEN", Some(head), None) => {
            let compared = behind(daemon, url, &detail.base_branch, head)
                .await
                .map_err(|error| error.to_string());
            daemon.pr_watches.compared(url, head, compared.clone());
            compared.map_err(PrError::Gh)
        }
        _ => Ok(0),
    }
}

/// `pr/view` (PLX-1151): pull request `url` from the shared read, or a fresh one with `fresh`,
/// with how far it is behind its base and [`verdict`]'s readiness. Unlike `pr/status`, a ready
/// answer may come from a shared read: the app pins its merge to the head it shows.
pub(crate) async fn view(daemon: &Daemon, url: &str, fresh: bool) -> Result<PrView, PrError> {
    let detail = if fresh {
        fetch(daemon, url).await?
    } else {
        read(daemon, url).await?
    };
    // A base branch that is gone can't be compared; the rest still shows.
    let behind_by = behind_of(daemon, url, &detail)
        .await
        .inspect_err(|error| warn!(%url, %error, "could not compare a pull request with its base"))
        .ok();
    viewed(url, detail, behind_by)
}

/// `detail`'s pull request with `behind_by` and [`verdict`]'s readiness added. An open one whose
/// compare failed (`behind_by` absent) isn't ready, with that as a reason.
fn viewed(url: &str, detail: Detail, behind_by: Option<u64>) -> Result<PrView, PrError> {
    let open = detail.state == "OPEN";
    let mut pr = detail.view.clone().ok_or_else(|| {
        PrError::Gh("GitHub's answer left out the pull request's details".to_owned())
    })?;
    let uncompared = open && behind_by.is_none();
    let base = detail.base_branch.clone();
    let mut reasons = verdict(url.to_owned(), detail, behind_by.unwrap_or(0), false).reasons;
    if uncompared {
        reasons.push(format!("couldn't tell how far it is behind {base}"));
    }
    pr.behind_by = behind_by.filter(|_| open);
    pr.ready = Some(reasons.is_empty());
    pr.reasons = reasons;
    Ok(pr)
}

/// The head branch and its repository (`owner/name`) of `url`, read fresh, for deleting the
/// branch: refused while the pull request is open, or once its fork is gone.
pub(crate) async fn head_to_delete(
    daemon: &Daemon,
    url: &str,
) -> Result<(String, String), PrError> {
    let detail = fetch(daemon, url).await?;
    if detail.state == "OPEN" {
        return Err(PrError::Gh(
            "the pull request is still open; merge or close it before deleting its branch"
                .to_owned(),
        ));
    }
    let repo = detail
        .head_repo
        .ok_or_else(|| PrError::Gh("the head branch's repository is gone".to_owned()))?;
    Ok((repo, detail.head_branch))
}

/// Judges a pull request with `judge`, from `shared`, its shared read, while that isn't ready, and
/// otherwise from a fresh read by `fetch`. A shared read can predate a push, so ready only ever
/// comes from a read made for this call: at most one extra read per ready answer.
async fn judged<E, Fetch, Judge>(
    shared: Option<Detail>,
    fetch: impl FnOnce() -> Fetch,
    judge: impl Fn(Detail) -> Judge,
) -> Result<PrStatusResult, E>
where
    Fetch: Future<Output = Result<Detail, E>>,
    Judge: Future<Output = Result<PrStatusResult, E>>,
{
    if let Some(detail) = shared {
        let result = judge(detail).await?;
        if !result.ready {
            return Ok(result);
        }
    }
    judge(fetch().await?).await
}

/// Judges a pull request as `pr_status.py` does: ready when it is open, not a draft, doesn't
/// conflict, isn't behind its base, every check on its head passed, no review thread is
/// unresolved, and no change is requested. Each miss is a reason.
fn verdict(url: String, detail: Detail, behind_by: u64, watching: bool) -> PrStatusResult {
    let mut failing = Vec::new();
    let mut pending = Vec::new();
    let mut passed = Vec::new();
    let mut checks = Vec::new();
    for check in detail.checks {
        let how = match check.state {
            CheckState::Passed => "passed",
            CheckState::Pending => "pending",
            CheckState::Failed(how) => how,
        };
        let entry = PrStatusCheck {
            name: check.name.clone(),
            how: how.to_owned(),
            required: check.required,
            url: check.url,
            run_id: check.run_id,
        };
        match check.state {
            CheckState::Passed => passed.push(check.name),
            CheckState::Pending => pending.push(check.name),
            CheckState::Failed(_) => failing.push(entry.clone()),
        }
        checks.push(entry);
    }
    failing.sort_by(|a, b| a.name.cmp(&b.name));
    checks.sort_by(|a, b| a.name.cmp(&b.name));
    pending.sort();
    passed.sort();
    let open = detail.state == "OPEN";
    let base = &detail.base_branch;
    let plural = |count: usize, one: &str, many: &str| {
        format!("{count} {}", if count == 1 { one } else { many })
    };
    let mut reasons = Vec::new();
    if !open {
        reasons.push(format!("it is {}", detail.state.to_lowercase()));
    }
    if detail.draft {
        reasons.push("it is a draft".to_owned());
    }
    match detail.mergeable.as_str() {
        "CONFLICTING" if open => reasons.push(format!("it conflicts with {base}")),
        "UNKNOWN" if open => {
            reasons.push("GitHub is still working out whether it conflicts".to_owned());
        }
        _ => {}
    }
    if behind_by > 0 {
        let count = usize::try_from(behind_by).unwrap_or(usize::MAX);
        reasons.push(format!(
            "{} behind {base}",
            plural(count, "commit", "commits")
        ));
    }
    if failing.is_empty() && pending.is_empty() && passed.is_empty() {
        reasons.push("no checks have reported on its head yet".to_owned());
    }
    if !failing.is_empty() {
        let names: Vec<&str> = failing.iter().map(|check| check.name.as_str()).collect();
        reasons.push(format!("failing: {}", names.join(", ")));
    }
    if !pending.is_empty() {
        reasons.push(format!("pending: {}", pending.join(", ")));
    }
    if !detail.unresolved.is_empty() {
        let threads = plural(
            detail.unresolved.len(),
            "unresolved review thread",
            "unresolved review threads",
        );
        reasons.push(threads);
    }
    if detail.review_decision.as_deref() == Some("CHANGES_REQUESTED") {
        reasons.push("changes requested".to_owned());
    }
    PrStatusResult {
        url,
        title: Some(detail.title),
        body: Some(detail.body).filter(|body| !body.is_empty()),
        state: detail.state,
        draft: detail.draft,
        head_sha: detail.head_sha,
        head_branch: Some(detail.head_branch),
        base_branch: detail.base_branch,
        files: detail.files,
        behind_by,
        mergeable: detail.mergeable,
        merge_state: detail.merge_state,
        review_decision: detail.review_decision,
        failing,
        pending,
        passed,
        checks,
        unresolved_threads: detail.unresolved,
        watching,
        ready: reasons.is_empty(),
        reasons,
    }
}

/// `pr/unwatch`: stops watching; the pull request stays linked.
pub(crate) async fn unwatch(
    daemon: &Daemon,
    params: PrViewParams,
) -> Result<PrWatchResult, ErrorObject> {
    let PrViewParams { run_id, url } = params;
    let id = Uuid::from(run_id);
    let _lane = daemon.dispatcher.lane(id).await;
    let key = url.clone();
    let was_watching = daemon
        .store
        .run(&CancellationToken::new(), move |db| {
            let deleted = db.delete_pr_watch(id, &key).map_err(|e| store_error(&e))?;
            if deleted {
                stage_watches(db, id)?;
            }
            Ok(deleted)
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
    let urls = daemon
        .reader
        .run(&CancellationToken::new(), move |db| urls(db, id))
        .await?;
    Ok(PrWatchesResult { urls })
}

/// The URLs run `run` watches, as `pr/watches` lists them.
pub(crate) fn urls(db: &Store, run: Uuid) -> Result<Vec<String>, ErrorObject> {
    Ok(db
        .pr_watches()
        .map_err(|e| store_error(&e))?
        .into_iter()
        .filter(|(watcher, _, _)| *watcher == run)
        .map(|(_, url, _)| url)
        .collect())
}

/// Stages `pr.watches` with run `run`'s watches as `db` has them now (PLX-777), in the job that
/// changed them.
fn stage_watches(db: &mut Tx, run: Uuid) -> Result<(), ErrorObject> {
    let row = db
        .get_run(run)
        .map_err(|e| store_error(&e))?
        .ok_or_else(|| ErrorObject::internal_error(format!("run {run} is gone")))?;
    let project = ScopeId::try_from(row.fields.project_id)
        .map_err(|_| ErrorObject::internal_error("a stored project id is not a UUIDv7"))?;
    let run_id = run_id(run)?;
    let urls = urls(db, run)?;
    db.stage(
        Timestamp::now(),
        Some(project),
        ParallaxEvent::PrWatches { run_id, urls },
    );
    Ok(())
}

fn run_id(run: Uuid) -> Result<RunId, ErrorObject> {
    RunId::try_from(run)
        .map_err(|_| ErrorObject::internal_error(format!("run {run} has an invalid id")))
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
        .failures()
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
                let mut failures = daemon.pr_watches.failures();
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
                daemon.pr_watches.failures().remove(url);
            }
            return;
        }
    };
    daemon.pr_watches.failures().remove(url);
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
                let text = target.watch.merge.map(|_| {
                    format!(
                        "Pull request {url} was merged, so Parallax has no merge left to make \
                         and stopped watching it."
                    )
                });
                record(daemon, url, target, None, text, "merged").await;
            }
            return;
        }
    }
    for target in targets {
        let mut report = evaluate(&target.watch, &detail);
        if let Some(method) = target.watch.merge
            && let Some(text) = merge_step(daemon, url, &detail, method, &mut report).await
        {
            record(daemon, url, target, None, Some(text), "merged").await;
            continue;
        }
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

/// Acts on a watch's merge with `method` after a pass read `detail`: adds what became of it to
/// `report`, or returns the wake that ends the watch once the pull request is merged.
async fn merge_step(
    daemon: &Daemon,
    url: &str,
    detail: &Detail,
    method: PrMergeMethod,
    report: &mut Report,
) -> Option<String> {
    let gh = daemon.agents.worktrees();
    let merge = |head: String| async move { crate::pr_write::merge(gh, url, method, &head).await };
    let how = format!("{method:?}").to_lowercase();
    let short = |head: &str| head[..head.len().min(7)].to_owned();
    match try_merge(url, detail, || fetch(daemon, url), merge).await {
        Merging::Merged(head) => {
            return Some(format!(
                "Parallax merged pull request {url} ({how}) at {}, as merge_when_ready asked, \
                 and stopped watching it.",
                short(&head)
            ));
        }
        Merging::AlreadyMerged => {
            return Some(format!(
                "Pull request {url} is already merged, so Parallax has no merge left to make and \
                 stopped watching it."
            ));
        }
        Merging::Queued(head) => {
            report.next.merge = None;
            report.changes.push(Change::Merge(format!(
                "Parallax queued it for merge at {}: {} uses a merge queue, which merges it. \
                 Parallax keeps watching it.",
                short(&head),
                detail.base_branch
            )));
        }
        Merging::Refused(why) => {
            report.next.merge = None;
            report.changes.push(Change::Merge(format!(
                "Parallax could not merge it: {why}. Call merge_when_ready again once that is \
                 fixed."
            )));
        }
        Merging::Waiting(reasons) if !report.changes.is_empty() => {
            report.changes.push(Change::Merge(format!(
                "Parallax merges it ({how}) once it is ready, which it isn't yet: {}.",
                reasons.join("; ")
            )));
        }
        Merging::Waiting(_) | Merging::Later => {}
    }
    None
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
    let (started_at, seen_merge) = (target.watch.started_at, target.watch.merge);
    let key = url.to_owned();
    let _lane = daemon.dispatcher.lane(run).await;
    let recorded = daemon
        .store
        .run(&CancellationToken::new(), move |db| {
            record_job(db, run, &key, (started_at, seen_merge), next, text)
        })
        .await;
    match recorded {
        Ok(true) => {
            daemon.dispatcher.notify();
            if !ended.is_empty() {
                info!(%run, %url, reason = ended, "a pull request watch ended");
            }
        }
        Ok(false) => {}
        Err(error) => warn!(%run, %url, error = %error.message, "could not record a watch"),
    }
}

/// [`record`]'s job, for the watch the pass saw, by when it started and the merge it held. Says
/// whether it changed anything.
fn record_job(
    db: &mut Tx,
    run: Uuid,
    url: &str,
    (started_at, seen_merge): (Timestamp, Option<PrMergeMethod>),
    next: Option<Watch>,
    text: Option<String>,
) -> Result<bool, ErrorObject> {
    let current = db.pr_watch(run, url).map_err(|e| store_error(&e))?;
    let Some(current) = current
        .and_then(|payload| serde_json::from_str::<Watch>(&payload).ok())
        .filter(|watch| watch.started_at == started_at)
    else {
        return Ok(false);
    };
    let ends = next.is_none();
    match next {
        Some(mut next) => {
            // A merge_when_ready since the pass read the watch wins over what the pass made of it.
            if current.merge != seen_merge {
                next.merge = current.merge;
            }
            let payload = serde_json::to_string(&next).map_err(ErrorObject::internal_error)?;
            db.put_pr_watch(run, url, &payload)
        }
        None => db.delete_pr_watch(run, url).map(drop),
    }
    .map_err(|e| store_error(&e))?;
    if ends {
        stage_watches(db, run)?;
    }
    if let Some(text) = text {
        let run_id = run_id(run)?;
        let command_id = format!("pr-watch:{run}:{}", Uuid::now_v7());
        let wake = Wake {
            task: None,
            to: To::Thread {
                run_id,
                turn_id: TurnId::generate(),
            },
            text,
        };
        crate::dispatcher::enqueue_wake(db, &command_id, run, wake)?;
    }
    Ok(true)
}

/// Compares a watched pull request with what its run was last told, as T3's
/// `evaluatePullRequestWatch`. Each check is told as soon as it fails, so one that never finishes
/// can't hold the news back. "Passed" is told once the required checks all pass, or all checks
/// where none is required. A remark counts when someone other than the viewer or the author wrote
/// or edited it since.
fn evaluate(watch: &Watch, detail: &Detail) -> Report {
    let mut changes = Vec::new();
    let head_moved = detail.head_sha != watch.head_sha;
    let checks = checks_news(watch, detail, head_moved, &mut changes);
    let remarks = remarks_news(watch, detail, &mut changes);

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
            failed_checks: checks.failed_checks,
            passed: checks.passed,
            passed_checks: checks.passed_checks,
            remarks_through: remarks.remarks_through,
            remark_ids: remarks.remark_ids,
            conflicting,
            wakes,
            merge: watch.merge,
        },
        exhausted: comments_only && wakes >= WAKE_LIMIT,
    }
}

/// What a watch's checks were told: [`Watch`]'s fields of the same names.
struct ChecksTold {
    failed_checks: Vec<String>,
    passed: bool,
    passed_checks: Vec<String>,
}

/// [`evaluate`]'s checks: adds the checks that newly failed and a newly passed gate to `changes`,
/// and returns what the watch records of them.
fn checks_news(
    watch: &Watch,
    detail: &Detail,
    head_moved: bool,
    changes: &mut Vec<Change>,
) -> ChecksTold {
    // An empty list keeps the last state: GitHub can answer with one when its check read fails.
    let mut told = if head_moved {
        ChecksTold {
            failed_checks: Vec::new(),
            passed: false,
            passed_checks: Vec::new(),
        }
    } else {
        ChecksTold {
            failed_checks: watch.failed_checks.clone(),
            passed: watch.passed,
            passed_checks: watch.passed_checks.clone(),
        }
    };
    if detail.checks.is_empty() {
        return told;
    }
    let failed: Vec<&Check> = detail
        .checks
        .iter()
        .filter(|check| matches!(check.state, CheckState::Failed(_)))
        .collect();
    let newly: Vec<Check> = failed
        .iter()
        .filter(|check| !told.failed_checks.contains(&check.name))
        .map(|check| (*check).clone())
        .collect();
    if !newly.is_empty() {
        changes.push(Change::ChecksFailed(newly));
    }
    // A check that runs again leaves the list, so a rerun that fails again is told.
    told.failed_checks = failed.iter().map(|check| check.name.clone()).collect();

    let required: Vec<&Check> = detail
        .checks
        .iter()
        .filter(|check| check.required)
        .collect();
    let any_required = !required.is_empty();
    let gate: Vec<&Check> = if any_required {
        required
    } else {
        detail.checks.iter().collect()
    };
    let passed_now = gate.iter().all(|check| check.state == CheckState::Passed);
    let names: Vec<String> = gate.iter().map(|check| check.name.clone()).collect();
    // A required check created and finished between two passes is never seen pending.
    let gate_grew = any_required && names.iter().any(|name| !told.passed_checks.contains(name));
    if passed_now && (!told.passed || gate_grew) {
        changes.push(Change::ChecksPassed {
            count: gate.len(),
            required: any_required,
        });
    }
    told.passed = passed_now;
    told.passed_checks = if passed_now { names } else { Vec::new() };
    told
}

/// What a watch's remarks were told: [`Watch`]'s fields of the same names.
struct RemarksTold {
    remarks_through: Timestamp,
    remark_ids: Vec<String>,
}

/// [`evaluate`]'s remarks: adds those someone other than the viewer or the author wrote or edited
/// since to `changes`, and returns what the watch records of them.
fn remarks_news(watch: &Watch, detail: &Detail, changes: &mut Vec<Change>) -> RemarksTold {
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
    RemarksTold {
        remarks_through: latest,
        remark_ids,
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
                    format!("  - {}{how}{}", check.name, link(check.url.as_deref()))
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
                    format!("  - {who}{on}: {said}{}", link(remark.url.as_deref()))
                });
            }
            Change::Conflicting => {
                lines.push(format!(
                    "- The branch now conflicts with {}.",
                    detail.base_branch
                ));
            }
            Change::Merge(line) => lines.push(format!("- {line}")),
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

/// ` <url>` after a listed item, or nothing without one.
fn link(url: Option<&str>) -> String {
    url.map(|url| format!(" {url}")).unwrap_or_default()
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

/// Reads pull request `url` with one `gh api graphql` call, or takes the last read of it while
/// that is under [`SHARE`] old.
// ponytail: two reads that start together both call GitHub; share the call in flight if that
// shows up in the rate limit.
async fn read(daemon: &Daemon, url: &str) -> Result<Detail, PrError> {
    match daemon.pr_watches.shared(url, Instant::now()) {
        Some(detail) => Ok(detail),
        None => fetch(daemon, url).await,
    }
}

/// Reads pull request `url` from GitHub with one `gh api graphql` call, and shares the read.
async fn fetch(daemon: &Daemon, url: &str) -> Result<Detail, PrError> {
    let started = Instant::now();
    let (owner, name, number) = parts(url)?;
    let answer = graphql(
        daemon,
        QUERY,
        &[
            ("-f", format!("owner={owner}")),
            ("-f", format!("name={name}")),
            ("-F", format!("number={number}")),
        ],
    )
    .await?;
    crate::gh_shim::record_graphql(&daemon.data_dir, &answer);
    let detail = parse(&answer)?;
    daemon.pr_watches.share(url, started, &detail);
    Ok(detail)
}

/// How many commits `base` has that `head` doesn't, in `url`'s repository.
async fn behind(daemon: &Daemon, url: &str, base: &str, head: &str) -> Result<u64, PrError> {
    let (owner, name, _) = parts(url)?;
    let answer = graphql(
        daemon,
        BEHIND,
        &[
            ("-f", format!("owner={owner}")),
            ("-f", format!("name={name}")),
            ("-f", format!("base=refs/heads/{base}")),
            ("-f", format!("head={head}")),
        ],
    )
    .await?;
    let answer: serde_json::Value = serde_json::from_str(&answer)
        .map_err(|error| PrError::Gh(format!("could not read GitHub's answer: {error}")))?;
    if let Some(message) = answer["errors"][0]["message"].as_str() {
        return Err(PrError::Gh(message.to_owned()));
    }
    // A base branch that is gone answers `ref: null`, which must not read as up to date.
    answer["data"]["repository"]["ref"]["compare"]["behindBy"]
        .as_u64()
        .ok_or_else(|| PrError::Gh(format!("GitHub can't compare {head} with {base}")))
}

/// Runs `gh api graphql` with `query` and `fields`, each a flag (`-f` for text, `-F` for a
/// number) and its `key=value`, in plxd's temp folder.
async fn graphql(
    daemon: &Daemon,
    query: &str,
    fields: &[(&str, String)],
) -> Result<String, PrError> {
    let query = format!("query={query}");
    let mut args = vec!["api", "graphql", "-f", query.as_str()];
    for (flag, field) in fields {
        args.extend([*flag, field.as_str()]);
    }
    daemon
        .agents
        .worktrees()
        .gh(&std::env::temp_dir(), &args)
        .await
}

/// `https://github.com/<owner>/<name>/pull/<number>`'s parts.
fn parts(url: &str) -> Result<(&str, &str, u64), PrError> {
    let found = || {
        let mut parts = url.strip_prefix("https://github.com/")?.split('/');
        let (owner, name) = (parts.next()?, parts.next()?);
        (parts.next()? == "pull").then_some(())?;
        Some((owner, name, parts.next()?.parse().ok()?))
    };
    found().ok_or_else(|| PrError::Gh(format!("{url:?} is not a GitHub pull request URL")))
}

/// `gh api graphql`'s answer to [`QUERY`].
fn parse(answer: &str) -> Result<Detail, PrError> {
    let answer: Answer = serde_json::from_str(answer)
        .map_err(|error| PrError::Gh(format!("could not read GitHub's answer: {error}")))?;
    let error = answer.errors.first().map(|error| error.message.clone());
    let Some(Data { viewer, repository }) = answer.data else {
        return Err(PrError::Gh(
            error.unwrap_or_else(|| "GitHub answered with no data".to_owned()),
        ));
    };
    let merge_methods = repository
        .as_ref()
        .map(Repository::merge_methods)
        .unwrap_or_default();
    let Some(pr) = repository.and_then(|repository| repository.pull_request) else {
        return Err(PrError::Gh(
            error.unwrap_or_else(|| "GitHub has no such pull request".to_owned()),
        ));
    };
    // A field GitHub can't answer, such as a workflow run for a token without Actions access, is
    // null with an error, and the rest of the pull request still reads.
    if let Some(error) = error {
        warn!(%error, "GitHub left part of a pull request out");
    }
    let pr_checks = pr
        .commits
        .iter()
        .flat_map(|node| node.commit.pr_checks())
        .collect();
    let view = pr_view(&pr, merge_methods, pr_checks);
    let commits: Vec<Commit> = pr
        .commits
        .nodes
        .into_iter()
        .flatten()
        .map(|node| node.commit)
        .collect();
    let actions_hold = commits.iter().find_map(Commit::actions_hold);
    let checks = commits.into_iter().flat_map(Commit::checks).collect();
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
    let mut unresolved = Vec::new();
    for thread in pr.review_threads.nodes.into_iter().flatten() {
        let path = thread.path;
        if !thread.is_resolved
            && let Some(first) = thread.comments.nodes.iter().flatten().next()
        {
            unresolved.push(PrStatusThread {
                id: Some(thread.id.clone()),
                path: path.clone(),
                author: first.author.as_ref().map(|author| author.login.clone()),
                body: snippet(&first.body),
                url: first.url.clone(),
            });
        }
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
        title: pr.title,
        body: pr.body,
        state: pr.state,
        draft: pr.is_draft,
        head_sha: pr.head_ref_oid,
        head_branch: pr.head_ref_name,
        base_branch: pr.base_ref_name,
        compared: None,
        files: pr
            .files
            .map(|files| files.nodes.into_iter().flatten().collect())
            .unwrap_or_default(),
        checks,
        mergeable: pr.mergeable,
        merge_state: pr.merge_state_status,
        merge_queue: pr.is_merge_queue_enabled,
        actions_hold,
        review_decision: pr.review_decision,
        unresolved,
        viewer: viewer.map(|viewer| viewer.login),
        author: pr.author.map(|author| author.login),
        remarks,
        head_repo: pr.head_repository.map(|repo| repo.name_with_owner),
        view,
    })
}

/// [`QUERY`]'s pull request `pr` as `pr/view` serves it, but for what [`viewed`] adds, with the
/// repository's `merge_methods` and the head's `checks`. `None` when GitHub's answer lacks its
/// number, URL, or last change.
fn pr_view(
    pr: &PullRequest,
    merge_methods: Vec<PrMergeMethod>,
    checks: Vec<PrCheck>,
) -> Option<PrView> {
    let (number, url, updated_at) = (pr.number?, pr.url.clone()?, pr.updated_at?);
    let any = |state| checks.iter().any(|check: &PrCheck| check.state == state);
    let checks_state = (!checks.is_empty()).then(|| {
        if any(PrCheckState::Failed) {
            PrCheckState::Failed
        } else if any(PrCheckState::Pending) {
            PrCheckState::Pending
        } else {
            PrCheckState::Passed
        }
    });
    let (comments, reviews) = discussion(pr);
    let labels: Vec<PrLabel> = pr
        .labels
        .iter()
        .flat_map(Nodes::iter)
        .map(|label| PrLabel {
            name: label.name.clone(),
            color: label.color.clone(),
        })
        .collect();
    Some(PrView {
        number,
        title: pr.title.clone(),
        // `https://github.com/<owner>/<name>/pull/<n>`.
        repo: url.split('/').skip(3).take(2).collect::<Vec<_>>().join("/"),
        url,
        state: match pr.state.as_str() {
            "OPEN" => PrState::Open,
            "CLOSED" => PrState::Closed,
            "MERGED" => PrState::Merged,
            _ => PrState::Unknown,
        },
        draft: pr.is_draft,
        author: login(pr.author.as_ref()),
        updated_at,
        base_branch: pr.base_ref_name.clone(),
        head_branch: pr.head_ref_name.clone(),
        changed_files: pr.changed_files,
        additions: pr.additions,
        deletions: pr.deletions,
        files: pr
            .files
            .iter()
            .flat_map(Nodes::iter)
            .map(|file| PrFile {
                path: file.path.clone(),
                additions: file.additions,
                deletions: file.deletions,
            })
            .collect(),
        body: pr.body.clone(),
        comments,
        review_requests: pr
            .review_requests
            .iter()
            .flat_map(Nodes::iter)
            .filter_map(|request| request.requested_reviewer.as_ref())
            .filter_map(|reviewer| reviewer.login.clone().or_else(|| reviewer.name.clone()))
            .collect(),
        labels: labels.iter().map(|label| label.name.clone()).collect(),
        checks,
        checks_state,
        created_at: pr.created_at,
        closed_at: pr.closed_at,
        merged_at: pr.merged_at,
        merged_by: pr.merged_by.as_ref().map(|by| by.login.clone()),
        commits: history(pr),
        reviews,
        merge_state: merge_state(&pr.merge_state_status),
        auto_merge: pr
            .auto_merge_request
            .as_ref()
            .map(|auto| merge_method(&auto.merge_method)),
        review_decision: pr
            .review_decision
            .as_deref()
            .map(|decision| match decision {
                "APPROVED" => PrReviewDecision::Approved,
                "CHANGES_REQUESTED" => PrReviewDecision::ChangesRequested,
                "REVIEW_REQUIRED" => PrReviewDecision::ReviewRequired,
                _ => PrReviewDecision::Unknown,
            }),
        mergeable: match pr.mergeable.as_str() {
            "MERGEABLE" => Some(true),
            "CONFLICTING" => Some(false),
            _ => None,
        },
        behind_by: None,
        ready: None,
        reasons: Vec::new(),
        head_sha: pr.head_ref_oid.clone(),
        merge_methods,
        label_colors: labels,
        review_threads: pr.review_threads.iter().map(review_thread).collect(),
        review_threads_truncated: pr.review_threads.cut(),
    })
}

/// `pr`'s newest commits, oldest first, each by its author's login, or name without a GitHub
/// account.
fn history(pr: &PullRequest) -> Vec<PrCommit> {
    pr.history
        .iter()
        .flat_map(Nodes::iter)
        .filter_map(|node| {
            let commit = &node.commit;
            let author = commit.author.as_ref();
            Some(PrCommit {
                oid: commit.oid.clone(),
                headline: commit.message_headline.clone(),
                author: author
                    .and_then(|author| author.user.as_ref().map(|user| user.login.clone()))
                    .or_else(|| author.and_then(|author| author.name.clone()))
                    .unwrap_or_default(),
                committed_at: commit.committed_date?,
            })
        })
        .collect()
}

/// GitHub's `mergeStateStatus` as a [`PrMergeState`], `None` while it is `UNKNOWN`.
fn merge_state(state: &str) -> Option<PrMergeState> {
    match state {
        "CLEAN" => Some(PrMergeState::Clean),
        "UNSTABLE" => Some(PrMergeState::Unstable),
        "HAS_HOOKS" => Some(PrMergeState::HasHooks),
        "BEHIND" => Some(PrMergeState::Behind),
        "BLOCKED" => Some(PrMergeState::Blocked),
        "DIRTY" => Some(PrMergeState::Dirty),
        "DRAFT" => Some(PrMergeState::Draft),
        _ => None,
    }
}

/// GitHub's name for a merge method as a [`PrMergeMethod`].
fn merge_method(method: &str) -> PrMergeMethod {
    match method {
        "MERGE" => PrMergeMethod::Merge,
        "SQUASH" => PrMergeMethod::Squash,
        "REBASE" => PrMergeMethod::Rebase,
        _ => PrMergeMethod::Unknown,
    }
}

/// A deleted account is GitHub's `ghost`.
fn login(author: Option<&Login>) -> String {
    author.map_or_else(|| "ghost".to_owned(), |author| author.login.clone())
}

/// `pr`'s comments and the texts of its reviews that say something, and its reviews' verdicts,
/// each oldest first. A pending review has no `submittedAt`, so it is left out of both.
fn discussion(pr: &PullRequest) -> (Vec<PrComment>, Vec<PrReview>) {
    let said = |comment: &Comment, created_at, kind| PrComment {
        author: login(comment.author.as_ref()),
        body: comment.body.clone(),
        created_at,
        id: Some(comment.id.clone()),
        url: comment.url.clone(),
        kind: Some(kind),
        avatar_url: comment.avatar_url(),
    };
    let mut comments: Vec<PrComment> = pr
        .comments
        .iter()
        .filter_map(|comment| Some(said(comment, comment.created_at?, PrCommentKind::Comment)))
        .collect();
    let mut reviews = Vec::new();
    for review in pr.reviews.iter() {
        let Some(submitted_at) = review.submitted_at else {
            continue;
        };
        comments.push(said(review, submitted_at, PrCommentKind::Review));
        reviews.push(PrReview {
            author: login(review.author.as_ref()),
            state: match review.state.as_deref() {
                Some("APPROVED") => PrReviewState::Approved,
                Some("CHANGES_REQUESTED") => PrReviewState::ChangesRequested,
                Some("COMMENTED") => PrReviewState::Commented,
                Some("DISMISSED") => PrReviewState::Dismissed,
                _ => PrReviewState::Unknown,
            },
            submitted_at,
        });
    }
    comments.retain(|comment| !comment.body.trim().is_empty());
    comments.sort_by_key(|comment| comment.created_at);
    reviews.sort_by_key(|review| review.submitted_at);
    (comments, reviews)
}

/// A review thread as `pr/view` serves it. Its line is where it was written once it is outdated.
fn review_thread(thread: &Thread) -> PrReviewThread {
    PrReviewThread {
        id: thread.id.clone(),
        path: thread.path.clone(),
        line: thread.line.or(thread.original_line),
        diff_hunk: thread
            .comments
            .iter()
            .next()
            .and_then(|first| first.diff_hunk.clone()),
        is_outdated: thread.is_outdated,
        is_resolved: thread.is_resolved,
        comments: thread
            .comments
            .iter()
            .filter_map(|comment| {
                Some(PrThreadComment {
                    id: comment.id.clone(),
                    url: comment.url.clone(),
                    author: login(comment.author.as_ref()),
                    avatar_url: comment.avatar_url(),
                    body: comment.body.clone(),
                    created_at: comment.created_at?,
                })
            })
            .collect(),
        truncated: thread.comments.cut(),
    }
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
    #[serde(default)]
    merge_commit_allowed: bool,
    #[serde(default)]
    squash_merge_allowed: bool,
    #[serde(default)]
    rebase_merge_allowed: bool,
    pull_request: Option<PullRequest>,
}

impl Repository {
    /// The merge methods it allows.
    fn merge_methods(&self) -> Vec<PrMergeMethod> {
        [
            (self.merge_commit_allowed, PrMergeMethod::Merge),
            (self.squash_merge_allowed, PrMergeMethod::Squash),
            (self.rebase_merge_allowed, PrMergeMethod::Rebase),
        ]
        .into_iter()
        .filter_map(|(allowed, method)| allowed.then_some(method))
        .collect()
    }
}

/// [`QUERY`]'s pull request. What only `pr/view` reads is optional, so an answer without it still
/// serves `pr/status` and the watches.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PullRequest {
    number: Option<u64>,
    url: Option<String>,
    #[serde(default)]
    title: String,
    #[serde(default)]
    body: String,
    state: String,
    #[serde(default)]
    is_draft: bool,
    created_at: Option<Timestamp>,
    updated_at: Option<Timestamp>,
    closed_at: Option<Timestamp>,
    merged_at: Option<Timestamp>,
    merged_by: Option<Login>,
    #[serde(default)]
    merge_state_status: String,
    review_decision: Option<String>,
    author: Option<Login>,
    base_ref_name: String,
    #[serde(default)]
    head_ref_name: String,
    head_ref_oid: Option<String>,
    head_repository: Option<HeadRepository>,
    mergeable: String,
    #[serde(default)]
    is_merge_queue_enabled: bool,
    #[serde(default)]
    additions: u64,
    #[serde(default)]
    deletions: u64,
    #[serde(default)]
    changed_files: u64,
    auto_merge_request: Option<AutoMerge>,
    labels: Option<Nodes<Label>>,
    review_requests: Option<Nodes<ReviewRequest>>,
    /// Null when GitHub can't list them, such as for a huge diff.
    #[serde(default)]
    files: Option<Nodes<PrStatusFile>>,
    /// Its newest commits, for `pr/view`; `commits` holds only the head, for its checks.
    history: Option<Nodes<HistoryNode>>,
    commits: Nodes<CommitNode>,
    comments: Nodes<Comment>,
    reviews: Nodes<Comment>,
    review_threads: Nodes<Thread>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Login {
    login: String,
    avatar_url: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct HeadRepository {
    name_with_owner: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct AutoMerge {
    merge_method: String,
}

#[derive(Deserialize)]
struct Label {
    name: String,
    color: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ReviewRequest {
    requested_reviewer: Option<Reviewer>,
}

/// A user, bot, or mannequin, by `login`, or a team, by `name`.
#[derive(Deserialize)]
struct Reviewer {
    login: Option<String>,
    name: Option<String>,
}

#[derive(Deserialize)]
struct HistoryNode {
    commit: HistoryCommit,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct HistoryCommit {
    oid: String,
    #[serde(default)]
    message_headline: String,
    committed_date: Option<Timestamp>,
    author: Option<GitActor>,
}

/// A commit's author: a GitHub `user` when git's email matches an account, else just a `name`.
#[derive(Deserialize)]
struct GitActor {
    name: Option<String>,
    user: Option<Login>,
}

/// A connection's `nodes`, any of which GitHub may answer as null, and its `pageInfo` where
/// [`QUERY`] asks for it.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Nodes<T> {
    nodes: Vec<Option<T>>,
    #[serde(default)]
    page_info: Option<PageInfo>,
}

impl<T> Nodes<T> {
    /// GitHub has more of them than this page holds, before or after it.
    fn cut(&self) -> bool {
        self.page_info
            .as_ref()
            .is_some_and(|page| page.has_next_page || page.has_previous_page)
    }

    /// Its nodes that aren't null.
    fn iter(&self) -> impl Iterator<Item = &T> {
        self.nodes.iter().flatten()
    }
}

#[derive(Deserialize)]
struct CommitNode {
    commit: Commit,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Commit {
    status_check_rollup: Option<Rollup>,
    #[serde(default)]
    check_suites: Option<Suites>,
}

impl Commit {
    /// Its checks, from its rollup.
    fn checks(self) -> impl Iterator<Item = Check> {
        self.status_check_rollup
            .into_iter()
            .flat_map(|rollup| rollup.contexts.nodes.into_iter().flatten())
            .map(|context| Check {
                state: check_state(&context),
                name: context.name.or(context.context).unwrap_or_default(),
                required: context.is_required,
                url: context.details_url.or(context.target_url),
                run_id: context
                    .check_suite
                    .and_then(|suite| suite.workflow_run)
                    .and_then(|run| run.database_id),
            })
    }

    /// Its checks as `pr/view` serves them. A GitHub Actions check run is a job, whose id is the
    /// check run's.
    fn pr_checks(&self) -> impl Iterator<Item = PrCheck> {
        self.status_check_rollup
            .iter()
            .flat_map(|rollup| rollup.contexts.iter())
            .map(|context| {
                let state = check_state(context);
                let conclusion = (state != CheckState::Pending)
                    .then(|| context.conclusion.as_deref().or(context.state.as_deref()))
                    .flatten()
                    .map(str::to_lowercase);
                let run = context
                    .check_suite
                    .as_ref()
                    .and_then(|suite| suite.workflow_run.as_ref());
                let run_id = run.and_then(|run| run.database_id);
                PrCheck {
                    name: context
                        .name
                        .clone()
                        .or_else(|| context.context.clone())
                        .unwrap_or_default(),
                    state: match state {
                        CheckState::Pending => PrCheckState::Pending,
                        CheckState::Failed(_) => PrCheckState::Failed,
                        CheckState::Passed if conclusion.as_deref() == Some("skipped") => {
                            PrCheckState::Skipped
                        }
                        CheckState::Passed => PrCheckState::Passed,
                    },
                    conclusion,
                    url: context
                        .details_url
                        .clone()
                        .or_else(|| context.target_url.clone())
                        .filter(|url| !url.is_empty()),
                    workflow: run
                        .and_then(|run| run.workflow.as_ref())
                        .map(|workflow| workflow.name.clone()),
                    started_at: context.started_at.or(context.created_at),
                    completed_at: context.completed_at,
                    required: context.is_required,
                    run_id,
                    job_id: run_id.and(context.database_id),
                }
            })
    }

    /// Why its check suites hold a merge, failing closed: a GitHub Actions workflow run hasn't
    /// finished, GitHub left the suites out, or there are more than one page of them. A suite
    /// without a workflow run belongs to an app, which can leave it queued for good.
    fn actions_hold(&self) -> Option<String> {
        let Some(suites) = &self.check_suites else {
            return Some("GitHub didn't list its head's check suites".to_owned());
        };
        if suites
            .page_info
            .as_ref()
            .is_some_and(|page| page.has_next_page)
            || suites.nodes.len() >= SUITES
        {
            return Some(format!(
                "its head has more than {SUITES} check suites, more than Parallax reads"
            ));
        }
        suites
            .nodes
            .iter()
            .flatten()
            .any(|suite| {
                suite.workflow_run.is_some() && suite.status.as_deref() != Some("COMPLETED")
            })
            .then(|| "a GitHub Actions workflow on its head is still running".to_owned())
    }
}

/// The check suites [`QUERY`] reads, `checkSuites(first: 50)`.
const SUITES: usize = 50;

/// A page of the head's check suites.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Suites {
    page_info: Option<PageInfo>,
    nodes: Vec<Option<Suite>>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PageInfo {
    #[serde(default)]
    has_next_page: bool,
    #[serde(default)]
    has_previous_page: bool,
}

/// A check suite on the head: one per app, and one per GitHub Actions workflow run.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Suite {
    status: Option<String>,
    workflow_run: Option<WorkflowRun>,
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
    check_suite: Option<CheckSuite>,
    /// A check run's id: its job's, for a GitHub Actions one.
    database_id: Option<u64>,
    started_at: Option<Timestamp>,
    completed_at: Option<Timestamp>,
    /// When a commit status was first set.
    created_at: Option<Timestamp>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CheckSuite {
    workflow_run: Option<WorkflowRun>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct WorkflowRun {
    database_id: Option<u64>,
    workflow: Option<Workflow>,
}

#[derive(Deserialize)]
struct Workflow {
    name: String,
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
    /// A review-thread comment's diff, down to its line.
    diff_hunk: Option<String>,
}

impl Comment {
    fn avatar_url(&self) -> Option<String> {
        self.author
            .as_ref()
            .and_then(|author| author.avatar_url.clone())
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Thread {
    id: String,
    path: Option<String>,
    /// Null once the thread is outdated, or for a thread on the whole file.
    line: Option<u64>,
    original_line: Option<u64>,
    #[serde(default)]
    is_outdated: bool,
    #[serde(default)]
    is_resolved: bool,
    comments: Nodes<Comment>,
}

#[cfg(test)]
mod tests;
