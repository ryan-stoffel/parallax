//! A run's linked pull requests (PLX-318), behind the `pullRequests` capability.
//!
//! plxd links a pull request to a run when `agent/openPr` returns it, and when the run's agent
//! opens one itself with `gh pr create`; `AgentRun.pullRequests` lists them. `pr/view` reads one
//! from GitHub and `pr/act` merges, drafts, or closes it, each with `gh` on the host, as the user.
//! Behind the `prDiff` capability (PLX-328), `pr/diff` reads its unified diff. Each takes only a
//! URL linked to the run. Behind `threadTools` (0041), `pr/link` and `pr/unlink` add or remove a
//! GitHub pull request URL from a run's list, as a thread's Parallax tools do.
//!
//! Behind `prActions` (PLX-1151), `pr/view` serves plxd's shared GraphQL read (0086) with review
//! threads, readiness, and check ids, and `pr/act` also rebases, updates the branch, re-runs or
//! cancels checks, and deletes the head branch, each through plxd's paced write queue.

use jiff::Timestamp;
use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::RunId;

/// Params of `pr/view`, of `pr/diff`, and of `pr/link` and `pr/unlink`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct PrViewParams {
    /// The run.
    pub run_id: RunId,
    /// The pull request's web URL, as the run's `pullRequests` lists it.
    pub url: String,
}

/// What `pr/act` does to a pull request.
///
/// A newer client may send an action this version does not know; plxd refuses it.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub enum PrAction {
    /// Merges it now with a merge commit.
    Merge,
    /// Squashes it into one commit and merges that now.
    Squash,
    /// Rebases its commits onto the base branch now.
    Rebase,
    /// Turns on auto-merge once its requirements pass, with `method`, else a merge commit.
    AutoMerge,
    /// Turns auto-merge off.
    DisableAutoMerge,
    /// Turns it back into a draft.
    Draft,
    /// Marks a draft ready for review.
    Ready,
    /// Closes it without merging.
    Close,
    /// Brings the base branch's new commits into the head branch: by merge, or by rebase when
    /// `method` is `rebase`.
    UpdateBranch,
    /// Re-runs the failed jobs of GitHub Actions run `workflowRunId`.
    RerunFailed,
    /// Re-runs GitHub Actions job `jobId`.
    RerunJob,
    /// Cancels GitHub Actions run `workflowRunId`.
    CancelRun,
    /// Deletes its head branch. Refused while it is open.
    DeleteBranch,
    /// An action this version does not know yet.
    #[serde(other)]
    #[ts(skip)]
    Unknown,
}

/// Params of `pr/act`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct PrActParams {
    /// The run.
    pub run_id: RunId,
    /// The pull request's web URL, as the run's `pullRequests` lists it.
    pub url: String,
    /// What to do.
    pub action: PrAction,
    /// How `autoMerge` merges, and whether `updateBranch` rebases. Absent means a merge commit
    /// (PLX-1151).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub method: Option<PrMergeMethod>,
    /// Whether `merge`, `squash`, or `rebase` also deletes the head branch.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub delete_branch: bool,
    /// The head commit the user saw: `merge`, `squash`, and `rebase` merge only while the head is
    /// still this commit.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub head_sha: Option<String>,
    /// The GitHub Actions run for `rerunFailed` and `cancelRun`, as a check's `runId`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub workflow_run_id: Option<u64>,
    /// The GitHub Actions job for `rerunJob`, as a check's `jobId`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub job_id: Option<u64>,
}

/// Where a pull request is.
///
/// A newer plxd may send a state this version does not know; treat it as unknown.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub enum PrState {
    /// Open.
    Open,
    /// Closed without merging.
    Closed,
    /// Merged.
    Merged,
    /// A state this version does not know yet.
    #[serde(other)]
    #[ts(skip)]
    Unknown,
}

/// How a pull request merges.
///
/// A newer plxd may send a method this version does not know; treat it as unknown.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub enum PrMergeMethod {
    /// With a merge commit.
    Merge,
    /// Squashed into one commit.
    Squash,
    /// Rebased onto the base branch.
    Rebase,
    /// A method this version does not know yet.
    #[serde(other)]
    #[ts(skip)]
    Unknown,
}

/// Whether a pull request can merge, as GitHub's `mergeStateStatus` says.
///
/// A newer plxd may send a state this version does not know; treat it as unknown.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub enum PrMergeState {
    /// It can merge.
    Clean,
    /// It can merge, but a check that isn't required failed.
    Unstable,
    /// It can merge, and the repository has pre-receive hooks.
    HasHooks,
    /// Its head branch is behind the base branch.
    Behind,
    /// A requirement blocks it, such as a review or a required check.
    Blocked,
    /// It conflicts with the base branch.
    Dirty,
    /// It is a draft.
    Draft,
    /// A state this version does not know yet.
    #[serde(other)]
    #[ts(skip)]
    Unknown,
}

/// Where a check is, or all of a pull request's checks together.
///
/// A newer plxd may send a state this version does not know; treat it as unknown.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub enum PrCheckState {
    /// Queued or running.
    Pending,
    /// It passed, or ended neutral.
    Passed,
    /// It failed, was cancelled, or timed out.
    Failed,
    /// It was skipped.
    Skipped,
    /// A state this version does not know yet.
    #[serde(other)]
    #[ts(skip)]
    Unknown,
}

/// One check on a pull request's head commit: a GitHub Actions job or another CI's status.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct PrCheck {
    /// Its name.
    pub name: String,
    /// Where it is.
    pub state: PrCheckState,
    /// How it ended, as GitHub says it in lowercase, such as `success`, `failure`, or
    /// `timed_out`. Absent while it is pending.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub conclusion: Option<String>,
    /// Its page, when it has one.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub url: Option<String>,
    /// The GitHub Actions workflow it is a job of. Absent for another CI's status.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub workflow: Option<String>,
    /// When it started. Absent when GitHub doesn't say.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub started_at: Option<Timestamp>,
    /// When it finished. Absent while it runs.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub completed_at: Option<Timestamp>,
    /// Whether branch protection requires it (PLX-1151).
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub required: bool,
    /// Its GitHub Actions workflow run, for `rerunFailed` and `cancelRun`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub run_id: Option<u64>,
    /// Its GitHub Actions job, for `rerunJob`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub job_id: Option<u64>,
}

/// A comment on a pull request, or a review's text.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct PrComment {
    /// Its author's login.
    pub author: String,
    /// Its Markdown.
    pub body: String,
    /// When it was written, in RFC 3339 UTC.
    pub created_at: Timestamp,
    /// Its GitHub node id (PLX-1151).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub id: Option<String>,
    /// Its web URL.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub url: Option<String>,
    /// Whether it is a comment or a review's text.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub kind: Option<PrCommentKind>,
    /// Its author's avatar image.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub avatar_url: Option<String>,
}

/// What a [`PrComment`] is.
///
/// A newer plxd may send a kind this version does not know; treat it as unknown.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub enum PrCommentKind {
    /// A comment on the conversation.
    Comment,
    /// A submitted review's text.
    Review,
    /// A kind this version does not know yet.
    #[serde(other)]
    #[ts(skip)]
    Unknown,
}

/// A pull request's review decision, as GitHub's `reviewDecision` says.
///
/// A newer plxd may send a decision this version does not know; treat it as unknown.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub enum PrReviewDecision {
    /// Approved by the reviews the repository requires.
    Approved,
    /// A reviewer asked for changes.
    ChangesRequested,
    /// The repository requires a review it doesn't have yet.
    ReviewRequired,
    /// A decision this version does not know yet.
    #[serde(other)]
    #[ts(skip)]
    Unknown,
}

/// A label and its color.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct PrLabel {
    /// Its name.
    pub name: String,
    /// Its color, as six hex digits without `#`.
    pub color: String,
}

/// A review thread on a pull request's diff, resolved or not.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct PrReviewThread {
    /// Its GitHub node id, for `pr/write`'s `replyToThread`.
    pub id: String,
    /// The file it is on.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub path: Option<String>,
    /// The line it is on, or was on when written once it is outdated. Absent for a thread on the
    /// whole file.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub line: Option<u64>,
    /// The diff down to its line, from its first comment.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub diff_hunk: Option<String>,
    /// Whether the code it is on changed since.
    pub is_outdated: bool,
    /// Whether someone resolved it.
    pub is_resolved: bool,
    /// Its comments, oldest first.
    pub comments: Vec<PrThreadComment>,
}

/// A comment in a [`PrReviewThread`].
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct PrThreadComment {
    /// Its GitHub node id.
    pub id: String,
    /// Its web URL.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub url: Option<String>,
    /// Its author's login, `ghost` for a deleted account.
    pub author: String,
    /// Its author's avatar image.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub avatar_url: Option<String>,
    /// Its Markdown.
    pub body: String,
    /// When it was written, in RFC 3339 UTC.
    pub created_at: Timestamp,
}

/// A review's verdict.
///
/// A newer plxd may send a verdict this version does not know; treat it as unknown.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub enum PrReviewState {
    /// Approved.
    Approved,
    /// Asked for changes.
    ChangesRequested,
    /// Commented without a verdict.
    Commented,
    /// Dismissed.
    Dismissed,
    /// A verdict this version does not know yet.
    #[serde(other)]
    #[ts(skip)]
    Unknown,
}

/// A submitted review: who, what verdict, and when. Its text, if any, is also in `comments`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct PrReview {
    /// Its author's login.
    pub author: String,
    /// Its verdict.
    pub state: PrReviewState,
    /// When it was submitted, in RFC 3339 UTC.
    pub submitted_at: Timestamp,
}

/// A commit on a pull request.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct PrCommit {
    /// Its full hash.
    pub oid: String,
    /// Its message's first line.
    pub headline: String,
    /// Its first author's login, or name when they have no GitHub account.
    pub author: String,
    /// When it was committed, in RFC 3339 UTC.
    pub committed_at: Timestamp,
}

/// One file a pull request changes, with its lines added and removed.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct PrFile {
    /// Its path in the repository.
    pub path: String,
    /// Lines added.
    pub additions: u64,
    /// Lines removed.
    pub deletions: u64,
}

/// Result of `pr/diff`: a pull request's changes as one unified diff, as `gh pr diff` prints it.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct PrDiffResult {
    /// Its unified diff, a `diff --git` section per file.
    pub diff: String,
    /// Whether `diff` was cut short, at a line's end, at plxd's size cap.
    pub truncated: bool,
}

/// A pull request as GitHub has it now: the result of `pr/view` and `pr/act`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct PullRequest {
    /// Its number in its repository.
    pub number: u64,
    /// Its title.
    pub title: String,
    /// Its web URL.
    pub url: String,
    /// Its repository, as `owner/name`.
    pub repo: String,
    /// Where it is.
    pub state: PrState,
    /// Whether it is a draft.
    pub draft: bool,
    /// Its author's login.
    pub author: String,
    /// When it last changed, in RFC 3339 UTC.
    pub updated_at: Timestamp,
    /// The branch it merges into.
    pub base_branch: String,
    /// The branch it merges from.
    pub head_branch: String,
    /// Files changed.
    pub changed_files: u64,
    /// Lines added.
    pub additions: u64,
    /// Lines removed.
    pub deletions: u64,
    /// The files it changes, as GitHub lists them: at most its first 100. Absent means none, or a
    /// plxd without them.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub files: Vec<PrFile>,
    /// Its description, in Markdown.
    pub body: String,
    /// Its comments and the text of its reviews, oldest first.
    pub comments: Vec<PrComment>,
    /// Who is asked to review it: users' logins and teams' names.
    pub review_requests: Vec<String>,
    /// Its labels' names.
    pub labels: Vec<String>,
    /// The checks on its head commit.
    pub checks: Vec<PrCheck>,
    /// All its checks together: failed if any failed, else pending if any is, else passed.
    /// Absent when it has none.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub checks_state: Option<PrCheckState>,
    /// When it was opened, in RFC 3339 UTC. Absent from a plxd without `prDiff`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub created_at: Option<Timestamp>,
    /// When it was closed or merged, in RFC 3339 UTC. Absent while it is open.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub closed_at: Option<Timestamp>,
    /// When it was merged, in RFC 3339 UTC. Absent unless it is merged.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub merged_at: Option<Timestamp>,
    /// Who merged it. Absent unless it is merged.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub merged_by: Option<String>,
    /// Its commits, oldest first. Absent means none, or a plxd without `prDiff`.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub commits: Vec<PrCommit>,
    /// Its submitted reviews, oldest first. Absent means none, or a plxd without `prDiff`.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub reviews: Vec<PrReview>,
    /// Whether it can merge. Absent while GitHub is still working it out.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub merge_state: Option<PrMergeState>,
    /// How it merges once its requirements pass, when auto-merge is on. Absent means off.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub auto_merge: Option<PrMergeMethod>,
    /// Its review decision, when the repository asks for reviews (PLX-1151). This field and the
    /// rest below are absent from a plxd without `prActions`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub review_decision: Option<PrReviewDecision>,
    /// Whether it merges without conflicts. Absent while GitHub works it out.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub mergeable: Option<bool>,
    /// Commits on the base branch its head doesn't have. Absent once it isn't open.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub behind_by: Option<u64>,
    /// Open, not a draft, no conflict, not behind, every check passed, no unresolved thread, and
    /// no change request, as `pr/status` judges it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub ready: Option<bool>,
    /// Why it isn't ready, one line each. Absent when it is.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub reasons: Vec<String>,
    /// Its head commit.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub head_sha: Option<String>,
    /// The merge methods its repository allows.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub merge_methods: Vec<PrMergeMethod>,
    /// Its labels with their colors, in `labels`' order.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub label_colors: Vec<PrLabel>,
    /// Its review threads, resolved ones included, oldest first.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub review_threads: Vec<PrReviewThread>,
}

/// Params of `pr/write` (PLX-1022): one write to a GitHub pull request, sent through plxd's
/// paced write queue. It needn't be linked.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct PrWriteParams {
    /// The pull request's web URL.
    pub url: String,
    /// What to write.
    pub write: PrWrite,
}

/// A write to a pull request.
///
/// A newer client may send a write this version does not know; plxd refuses it.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum PrWrite {
    /// A comment on the conversation.
    Comment {
        /// The comment, in Markdown.
        body: String,
    },
    /// A review.
    Review {
        /// Its verdict.
        event: PrReviewEvent,
        /// The review's text, in Markdown.
        body: String,
    },
    /// A new title, body, or both.
    Edit {
        /// The new title.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        title: Option<String>,
        /// The new body, in Markdown.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        body: Option<String>,
    },
    /// A reply to a review thread, resolving it too, or resolving it alone.
    ReplyToThread {
        /// The review thread's id, as `pr/status` lists it.
        review_thread_id: String,
        /// The reply, in Markdown. Absent resolves without replying.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        body: Option<String>,
        /// Whether to resolve the thread, after the reply.
        #[serde(default, skip_serializing_if = "std::ops::Not::not")]
        resolve: bool,
    },
    /// A write this version does not know yet.
    #[serde(other)]
    #[ts(skip)]
    Unknown,
}

/// A review's verdict.
///
/// A newer client may send one this version does not know; plxd refuses it.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub enum PrReviewEvent {
    /// Comments without a verdict.
    Comment,
    /// Approves.
    Approve,
    /// Requests changes.
    RequestChanges,
    /// A verdict this version does not know yet.
    #[serde(other)]
    #[ts(skip)]
    Unknown,
}

/// Result of `pr/write`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct PrWriteResult {
    /// The pull request's URL.
    pub url: String,
}

/// Params of `pr/mergeWhenReady` (PLX-1022).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct PrMergeWhenReadyParams {
    /// The run to wake with the result.
    pub run_id: RunId,
    /// The pull request's web URL.
    pub url: String,
    /// How to merge it.
    pub method: PrMergeMethod,
}
