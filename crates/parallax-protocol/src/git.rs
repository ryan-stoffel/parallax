//! A run's git actions (PLX-298), behind the `git` capability: `agent/gitStatus` reads the git
//! state of the folder a run works in (its worktree, or a Current checkout thread's checkout),
//! `agent/commit` stages and commits everything there, and `agent/push` pushes its branch to
//! `origin`, setting the upstream. Commit and push refuse a running run.

use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::RunId;

/// Params of `agent/gitStatus`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct AgentGitStatusParams {
    /// The run.
    pub run_id: RunId,
}

/// Params of `agent/commit`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct AgentCommitParams {
    /// The run. It must not be running.
    pub run_id: RunId,
    /// The commit message, at most 64 KiB, not blank.
    pub message: String,
}

/// Params of `agent/push`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct AgentPushParams {
    /// The run. It must not be running, and its folder must have a branch checked out.
    pub run_id: RunId,
}

/// The git state of a run's folder: the result of `agent/gitStatus`, and of `agent/commit` and
/// `agent/push` after they ran.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct GitStatus {
    /// The branch checked out, or null on a detached HEAD.
    pub branch: Option<String>,
    /// How many paths have uncommitted changes, untracked ones included.
    pub changes: u32,
    /// The branch's upstream, such as `origin/main`, or null when it has none.
    pub upstream: Option<String>,
    /// Commits not on the upstream, or with no upstream, not on any of `origin`'s branches.
    pub ahead: u32,
    /// Whether the repository has an `origin` remote to push to.
    pub origin: bool,
}
