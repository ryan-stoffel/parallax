//! Delegation (0063, PLX-648), behind the `delegation` capability.
//!
//! `task/delegate` starts a thread in another thread's workspace, its worktree and branch: a task
//! that thread delegated, its child with lineage `subagent`, or with no `completionWake` a
//! top-level thread beside it. `task/status` reads a delegated task, and changes how its end
//! reaches its parent. `thread/mergeBack` hands a fork's or a child's new context to the thread
//! it came from, with its next message. `secret/request` asks the user for a secret through the
//! app (`request_secret`), and `secret/answer` is the app's answer.

use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::{AccountChoice, AgentEffort, AgentPermission, AgentRun, RunId, SecretStatus};

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

/// Params of `secret/request`: asks the user for a secret in run `runId`'s thread, or keeps
/// waiting on request `requestId` if it was asked already, for at most `waitMs`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct SecretRequestParams {
    /// The run that asks, which must be running a turn.
    pub run_id: RunId,
    /// The request's id, a UUID the caller makes. Reuse it to keep waiting.
    pub request_id: String,
    /// What it needs, shown as the card's title.
    pub label: String,
    /// What it is for, and where the user gets it.
    pub reason: String,
    /// A hint for the input.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub placeholder: Option<String>,
    /// How long to wait for an answer before answering `pending`, at most 50000.
    pub wait_ms: u32,
}

/// Result of `secret/request`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct SecretRequestResult {
    /// How the request stands.
    pub status: SecretStatus,
    /// With `saved`: `secret-ref:<id>`, which a tool such as `schedule/save` uses once, within
    /// 24 hours, for the thread that asked.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub secret_ref: Option<String>,
}

/// An answer to a secret request.
///
/// A newer client may send an answer this version does not know; plxd refuses it.
#[derive(Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum SecretChoice {
    /// The user's value, which plxd keeps in the host's keystore.
    Save {
        /// The secret.
        secret: String,
    },
    /// The user chose not to give one.
    Decline,
    /// The agent stopped waiting.
    Cancel,
    /// An answer this version does not know yet.
    #[serde(other)]
    #[ts(skip)]
    Unknown,
}

// Never print the value, whoever formats it.
impl std::fmt::Debug for SecretChoice {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(match self {
            Self::Save { .. } => "Save { .. }",
            Self::Decline => "Decline",
            Self::Cancel => "Cancel",
            Self::Unknown => "Unknown",
        })
    }
}

/// Params of `secret/answer`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct SecretAnswerParams {
    /// The run that asked.
    pub run_id: RunId,
    /// The request.
    pub request_id: String,
    /// The answer.
    pub answer: SecretChoice,
}

/// Result of `secret/answer`.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct SecretAnswerResult {}
