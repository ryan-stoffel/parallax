//! Agents working across the user's computers (0101), behind the `agentWork` capability. These
//! methods are for `plxd mcp` on plxd's local socket: plxd refuses them from any other connection,
//! so a session from another computer can't go on to a third.

use serde::{Deserialize, Serialize};
use serde_json::Value;
use ts_rs::TS;

use crate::delegation::{CompletionWake, TaskDelivery};
use crate::host::HostLoad;
use crate::{
    AccountChoice, AgentEffort, AgentPermission, AgentRun, AgentStatus, RepoId, RunId, Thread,
};

/// A thread on another computer attached to a message as a reference, which the agent reads with
/// `thread_read` when it needs it (0101).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct RemoteThreadRef {
    /// The computer's relay id.
    pub computer: String,
    /// The thread's run id on that computer.
    pub run_id: RunId,
    /// Its title, as the user picked it.
    #[serde(default)]
    pub title: String,
}

/// Params of `peer/computers`.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct PeerComputersParams {}

/// Result of `peer/computers`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct PeerComputersResult {
    /// The account's computers on the relay, this one included.
    pub computers: Vec<LinkedComputer>,
}

/// One of the account's computers, as `linked_computers` shows it.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct LinkedComputer {
    /// Its relay id.
    pub id: String,
    /// Its name.
    pub name: String,
    /// Whether it is connected to the relay now.
    pub online: bool,
    /// Whether it is the computer that answered.
    pub this_computer: bool,
    /// Whether agents here can work on it now.
    pub takes_agent_work: bool,
    /// Why they can't, for people and agents.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub why_not: Option<String>,
    /// Its agents with a turn running, when it could be asked.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub running_agents: Option<u32>,
    /// How busy it is, when it could be asked.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub load: Option<HostLoad>,
}

/// Params of `peer/call`: one request forwarded to another computer's plxd. Only the methods the
/// thread tools use are allowed.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct PeerCallParams {
    /// The computer: its relay id, or its name when one computer has it.
    pub computer: String,
    /// The method, such as `agent/events`.
    pub method: String,
    /// The method's params.
    #[ts(type = "unknown")]
    pub params: Value,
}

/// Result of `peer/call`: the method's own result. An error from the other computer comes back
/// as it was, with its data.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(transparent)]
pub struct PeerCallResult(#[ts(type = "unknown")] pub Value);

/// Which workspace a thread on another computer gets.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub enum PeerWorkspace {
    /// A new worktree of the repository.
    #[default]
    Worktree,
    /// The repository's own checkout.
    Checkout,
    /// No repository.
    None,
}

/// Params of `peer/start`: starts a thread on another computer for run `parent` here. Idempotent
/// on `runId`. plxd refuses a mode that needs less approval than the parent's.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct PeerStartParams {
    /// The computer: its relay id, or its name when one computer has it.
    pub computer: String,
    /// The new thread's run id.
    pub run_id: RunId,
    /// The run that starts it.
    pub parent: RunId,
    /// Its first message, which plxd opens by naming this computer and the parent.
    pub prompt: String,
    /// Its title.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub title: Option<String>,
    /// The account it runs on. Absent with `completionWake` means the parent's backend, and
    /// without it the other computer's default.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub account: Option<AccountChoice>,
    /// The model.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub model: Option<String>,
    /// The effort.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub effort: Option<AgentEffort>,
    /// Its mode. Absent is the parent's.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub permission: Option<AgentPermission>,
    /// The workspace it gets.
    #[serde(default)]
    pub workspace: PeerWorkspace,
    /// The repo entry on the other computer. Absent is the one `repo/match` finds there for the
    /// parent's `origin`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub repo: Option<RepoId>,
    /// The ref a new worktree starts from. Absent is `origin`'s default branch there.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub base: Option<String>,
    /// With a checkout, the branch to switch to first.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub checkout_ref: Option<String>,
    /// Threads on the other computer to attach to the first message.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub threads: Vec<RunId>,
    /// Whether its end wakes the parent. A task always does, by its `completionWake`.
    #[serde(default)]
    pub notify: bool,
    /// Present for a delegated task: how its end wakes the parent.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub completion_wake: Option<CompletionWake>,
}

/// Result of `peer/start`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct PeerStartResult {
    /// The computer's relay id.
    pub computer: String,
    /// The computer's name.
    pub computer_name: String,
    /// The thread on it.
    pub thread: Thread,
    /// The thread's run, as it stands.
    pub run: AgentRun,
}

/// Params of `peer/task`: reads a task run `parent` delegated to another computer, as `task/status`
/// reads a local one, and records what the parent did with it.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct PeerTaskParams {
    /// The run that delegated it.
    pub parent: RunId,
    /// The task.
    pub task_id: RunId,
    /// Counts an ended task's result as read, so its end no longer wakes the parent.
    #[serde(default)]
    pub acknowledge: bool,
    /// A new wake policy.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub completion_wake: Option<CompletionWake>,
    /// Stops its end waking the parent, as `task_cancel` does.
    #[serde(default)]
    pub dispose: bool,
}

/// Result of `peer/task`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct PeerTaskResult {
    /// The task, or absent when `parent` delegated no such task to another computer.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub task: Option<RemoteTask>,
}

/// A task on another computer, as plxd last knew it.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct RemoteTask {
    /// The task, which is its thread's run id on that computer.
    pub task_id: RunId,
    /// The computer's relay id.
    pub computer: String,
    /// The computer's name, when plxd could read it.
    pub computer_name: String,
    /// Its title.
    pub title: String,
    /// Its status, `running` until its end was seen.
    pub status: AgentStatus,
    /// The end of its last output, once it ended.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub summary: Option<String>,
    /// Why it ended, when plxd ended it because the computer refused or left.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub reason: Option<String>,
    /// How its end reaches the parent.
    pub completion_wake: CompletionWake,
    /// Whether its end was delivered, read, or dropped.
    pub delivery: TaskDelivery,
}
