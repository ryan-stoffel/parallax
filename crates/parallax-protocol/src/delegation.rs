//! Delegation (0063, PLX-648), behind the `delegation` capability.
//!
//! `task/delegate` starts a thread in another thread's workspace, its worktree and branch: a task
//! that thread delegated, its child with lineage `subagent`, or with no `completionWake` a
//! top-level thread beside it. `task/status` reads a delegated task, and changes how its end
//! reaches its parent. `thread/mergeBack` hands a fork's or a child's new context to the thread
//! it came from, with its next message.

use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::{AccountChoice, AgentEffort, AgentPermission, AgentRun, RunId};

/// When a delegated task's end wakes its parent, as T3 Code's `completionWake`.
///
/// A newer peer may send a policy this version does not know; plxd refuses it.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
pub enum CompletionWake {
    /// Every time it ends.
    Always,
    /// Only when the parent isn't running a turn, which is waiting on it with `delegate_task`'s
    /// `wait`.
    SettledOnly,
    /// A policy this version does not know yet.
    #[serde(other)]
    #[ts(skip)]
    Unknown,
}

/// Whether a delegated task's end still wakes its parent.
///
/// A newer plxd may send a state this version does not know; treat it as unknown.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Hash, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub enum TaskDelivery {
    /// Its end wakes the parent.
    #[default]
    Pending,
    /// The parent read its result with `task/status`, so nothing wakes it.
    Acknowledged,
    /// The parent cancelled it, so nothing wakes it.
    Disposed,
    /// A state this version does not know yet.
    #[serde(other)]
    #[ts(skip)]
    Unknown,
}

/// Params of `task/delegate`. Idempotent on `runId`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct TaskDelegateParams {
    /// The new thread's run id, which the client makes. Reuse it to retry.
    pub run_id: RunId,
    /// The thread whose workspace it works in: a thread in a repo entry, running a turn. With
    /// `completionWake`, also its parent.
    pub owner: RunId,
    /// Its first message.
    pub prompt: String,
    /// Its title in the sidebar.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub title: Option<String>,
    /// Where it runs. Absent: the owner's account.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub account: Option<AccountChoice>,
    /// Its model. Absent: the owner's on the same backend, else the backend's default.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub model: Option<String>,
    /// Its effort. Absent: the owner's on the same backend.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub effort: Option<AgentEffort>,
    /// Its mode, which can't need less approval than the owner's. Absent: the owner's.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub permission: Option<AgentPermission>,
    /// Set for a delegated task, the owner's child. Absent: a top-level thread.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub completion_wake: Option<CompletionWake>,
}

/// Params of `task/status`: reads a task `parent` delegated, after the changes asked for.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct TaskStatusParams {
    /// The thread that delegated it.
    pub parent: RunId,
    /// The task: its thread's run id.
    pub task_id: RunId,
    /// Marks its result read, if it has ended, so its end no longer wakes the parent.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub acknowledge: bool,
    /// Its new wake policy.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub completion_wake: Option<CompletionWake>,
    /// Its end no longer wakes the parent, as when the parent cancels it.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub dispose: bool,
}

/// A delegated task, as `task/status` returns it.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct DelegatedTask {
    /// Its thread's run id.
    pub task_id: RunId,
    /// The thread that delegated it.
    pub parent: RunId,
    /// When its end wakes the parent.
    pub completion_wake: CompletionWake,
    /// Whether its end still wakes the parent.
    pub delivery: TaskDelivery,
    /// Its run, as it stands.
    pub run: AgentRun,
}

/// Params of `thread/mergeBack`: `source`'s context since it forked from `target`, or for
/// `target`'s child, all of it, goes with `target`'s next message.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct ThreadMergeBackParams {
    /// The fork or child.
    pub source: RunId,
    /// The thread it forked from, or its parent.
    pub target: RunId,
}

/// Result of `thread/mergeBack`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct ThreadMergeBackResult {
    /// The transfer's id, a UUID.
    pub transfer_id: String,
}
