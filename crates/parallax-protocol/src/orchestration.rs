//! The orchestrator's thread graph and subscriptions (0059 phase 2, PLX-644), behind the
//! `orchestration` capability.
//!
//! - `orchestration/dispatch` runs one [`OrchestrationCommand`] on a thread: a message with its
//!   dispatch mode, a change to the queued runs, or an interrupt. It is idempotent on the
//!   request's `commandId`.
//! - `orchestration/subscribeShell` answers with a [`ShellSnapshot`] at its `seq`, then sends
//!   what a sidebar shows: host events and every scope's events with each `agent.output` cut
//!   down to its permission requests, as `events/subscribe`'s `shell` filter does (PLX-454).
//! - `orchestration/subscribeThread` answers with a [`ThreadSnapshot`] at its `seq`, then sends
//!   that thread's events, as `events/subscribe`'s `run` filter does.
//! - With `afterSeq`, either one replays the events after it instead, when there are at most
//!   [`MAX_REPLAY_EVENTS`] of them and [`MAX_REPLAY_BYTES`] of JSON still in plxd's window, and
//!   answers with a fresh snapshot otherwise (T3 Code's `decideThreadResume`).
//! - `orchestration/threadHistory` pages a thread's older events.
//!
//! Events arrive as `events/event` notifications, a subscription that falls behind ends with
//! `events/resync`, and `events/unsubscribe` ends one, as for `events/subscribe`.

use jiff::Timestamp;
use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::{
    AccountChoice, AgentEffort, AgentPermission, AgentRun, LoggedEvent, Project, PromptImage, Repo,
    RunId, SubscriptionId, Thread, TurnId,
};

/// The most events a resume replays before it sends a snapshot instead.
pub const MAX_REPLAY_EVENTS: usize = 128;

/// The most event JSON, in bytes, a resume replays before it sends a snapshot instead.
pub const MAX_REPLAY_BYTES: usize = 1024 * 1024;

/// Where a run is.
///
/// A newer plxd may send a status this version does not know; treat it as unknown.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub enum ThreadRunStatus {
    /// Waiting in the thread's queue for the turn before it to end.
    Queued,
    /// Its turn failed on one account and starts again on another.
    Starting,
    /// Its turn is under way.
    Running,
    /// Its turn waits for the answer to a permission request.
    Waiting,
    /// Its turn finished.
    Completed,
    /// plxd stopped while it ran.
    Interrupted,
    /// Its turn failed.
    Failed,
    /// It was stopped, or never sent.
    Cancelled,
    /// A status this version does not know yet.
    #[serde(other)]
    #[ts(skip)]
    Unknown,
}

/// One run of a thread (T3 Code's Run): a message the user, plxd, or another thread sent, and the
/// turn it became. A thread's first run is its prompt's.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct ThreadRun {
    /// The message's turn id, or one plxd made for a turn that had none.
    pub id: TurnId,
    /// Where it is.
    pub status: ThreadRunStatus,
    /// Its place among the thread's runs that started, from 1. Absent while queued.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub ordinal: Option<u32>,
    /// Its place in the queue, from 0, while queued.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub position: Option<u32>,
    /// Its current attempt, from 1. A turn retried on another account after a usage limit or a
    /// sign-out has another. Absent while queued.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub attempt: Option<u32>,
    /// The message. Absent for a first run, whose text is the thread's prompt, and a turn
    /// plxd's log didn't record the text of.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub text: Option<String>,
    /// How many images went with it.
    #[serde(default, skip_serializing_if = "is_zero")]
    pub images: u32,
    /// The threads attached to it as context.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub threads: Vec<RunId>,
    /// The thread that sent it with its Parallax tools, not the user.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub from: Option<RunId>,
    /// True for a turn plxd sent itself: a wake-up or a resume after a usage limit.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub wake: bool,
    /// True for a queued run held after a Stop: it waits for `queue.resume`.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub queue_held: bool,
    /// When its turn started.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub started_at: Option<Timestamp>,
    /// When it ended.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub completed_at: Option<Timestamp>,
}

#[expect(
    clippy::trivially_copy_pass_by_ref,
    reason = "serde passes a reference"
)]
fn is_zero(n: &u32) -> bool {
    *n == 0
}

/// A run's dispatch mode (T3 Code's).
///
/// A newer peer may send a mode this version does not know; plxd refuses it.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(
    tag = "type",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
pub enum DispatchMode {
    /// Starts now, or waits in the queue behind the turn under way. `thread/start` prepares a
    /// thread's workspace before its first message, so this is `start_immediately`.
    DeferStart,
    /// Goes into run `targetRunId`'s turn under way, or with none, the thread's newest. A
    /// backend that takes no messages while it runs is stopped and resumed with it. Once that
    /// turn has ended, it starts as its own.
    SteerActive {
        /// The run under way. Absent means the thread's newest.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        target_run_id: Option<TurnId>,
    },
    /// Stops run `targetRunId`'s turn, or with none the thread's newest, and resumes the thread
    /// with it, whatever the backend.
    RestartActive {
        /// The run under way. Absent means the thread's newest.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        target_run_id: Option<TurnId>,
    },
    /// Waits in the queue behind the turn under way, or starts now if there is none.
    QueueAfterActive,
    /// Starts now, or waits in the queue behind the turn under way.
    StartImmediately,
    /// A mode this version does not know yet.
    #[serde(other)]
    #[ts(skip)]
    Unknown,
}

/// A command for `orchestration/dispatch` (0059), by `type`.
///
/// A newer peer may send a type this version does not know; plxd refuses it.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(tag = "type", rename_all_fields = "camelCase")]
pub enum OrchestrationCommand {
    /// Sends a message to a thread as a new run, as `dispatchMode` says. The message's options
    /// change the thread's model, effort, access, or account from then on, as `agent/send`'s do.
    #[serde(rename = "message.dispatch")]
    MessageDispatch {
        /// The thread.
        thread_id: RunId,
        /// The new run's id, which is the message's turn id. Reuse it to retry.
        message_id: TurnId,
        /// The message.
        text: String,
        /// Images sent with it, as `agent/send`'s.
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        images: Vec<PromptImage>,
        /// Threads attached to it as context, as `agent/send`'s.
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        threads: Vec<RunId>,
        /// A new model, as `agent/send`'s.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        model: Option<String>,
        /// A new effort, as `agent/send`'s.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        effort: Option<AgentEffort>,
        /// A new access, as `agent/send`'s.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        permission: Option<AgentPermission>,
        /// A new context window, as `agent/send`'s.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        context_window: Option<u32>,
        /// Fast mode on or off, as `agent/send`'s.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        fast: Option<bool>,
        /// A new account, as `agent/send`'s.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        account: Option<AccountChoice>,
        /// How it starts.
        dispatch_mode: DispatchMode,
    },
    /// Puts the thread's queued runs in a new order, listing each once.
    #[serde(rename = "queued-run.reorder")]
    QueuedRunReorder {
        /// The thread.
        thread_id: RunId,
        /// Its queued runs, first to be sent first.
        run_ids: Vec<TurnId>,
    },
    /// Replaces a queued run's text.
    #[serde(rename = "queued-run.edit")]
    QueuedRunEdit {
        /// The thread.
        thread_id: RunId,
        /// The queued run.
        run_id: TurnId,
        /// Its new text.
        text: String,
    },
    /// Drops a queued run, which is never sent.
    #[serde(rename = "queued-run.cancel")]
    QueuedRunCancel {
        /// The thread.
        thread_id: RunId,
        /// The queued run.
        run_id: TurnId,
    },
    /// Sends a queued run into the turn under way, as `steer_active` does.
    #[serde(rename = "queued-message.promote-to-steer")]
    QueuedMessagePromoteToSteer {
        /// The thread.
        thread_id: RunId,
        /// The queued run.
        run_id: TurnId,
    },
    /// Lets a queue held after a Stop go on: its next run starts once no turn is under way.
    #[serde(rename = "queue.resume")]
    QueueResume {
        /// The thread.
        thread_id: RunId,
    },
    /// Stops the thread's turn under way (Stop). With `holdQueue`, its queued runs wait for
    /// `queue.resume`, and the threads it started stop too. A Project's coordinator stops only
    /// its own turn, with its queue going on, so its children keep working.
    #[serde(rename = "run.interrupt")]
    RunInterrupt {
        /// The thread.
        thread_id: RunId,
        /// Whether its queue waits for `queue.resume`.
        #[serde(default, skip_serializing_if = "std::ops::Not::not")]
        hold_queue: bool,
    },
    /// A type this version does not know yet.
    #[serde(other)]
    #[ts(skip)]
    Unknown,
}

/// Result of `orchestration/dispatch`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct DispatchResult {
    /// The event log's `seq` once the command was applied: its events are at or before it.
    pub seq: u64,
}

/// Params of `orchestration/subscribeShell`.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct SubscribeShellParams {
    /// Resume after this `seq`: the last one received.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub after_seq: Option<u64>,
}

/// Result of `orchestration/subscribeShell`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct SubscribeShellResult {
    /// The new subscription, which its `events/event` notifications name.
    pub subscription: SubscriptionId,
    /// The shell to start from, with the events after its `seq` to follow. Absent when the
    /// events after `afterSeq` follow instead.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub snapshot: Option<ShellSnapshot>,
}

/// What a sidebar shows of a host.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct ShellSnapshot {
    /// The event log's `seq` it stands at. Events after it follow.
    pub seq: u64,
    /// Every project.
    pub projects: Vec<Project>,
    /// Every repo entry.
    pub repos: Vec<Repo>,
    /// Every normal thread.
    pub threads: Vec<Thread>,
    /// Every agent run: each thread's, and each Project's coordinators' and children's.
    pub runs: Vec<AgentRun>,
    /// The permission requests runs wait on, oldest first, each as an `agent.output` with its one
    /// `approvalRequested` item, at the `seq` it was logged at.
    pub requests: Vec<LoggedEvent>,
}

/// Params of `orchestration/subscribeThread`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct SubscribeThreadParams {
    /// The thread: its run id.
    pub thread_id: RunId,
    /// Resume after this `seq`: the last one received.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub after_seq: Option<u64>,
}

/// Result of `orchestration/subscribeThread`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct SubscribeThreadResult {
    /// The new subscription, which its `events/event` notifications name.
    pub subscription: SubscriptionId,
    /// The thread to start from, with the events after its `seq` to follow. Absent when the
    /// events after `afterSeq` follow instead.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub snapshot: Option<ThreadSnapshot>,
}

/// One thread as it stands.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct ThreadSnapshot {
    /// The event log's `seq` it stands at. Events after it follow.
    pub seq: u64,
    /// The thread's run, as `agent/list` has it.
    pub thread: AgentRun,
    /// Its runs: those that started, oldest first, then the queued ones, first to be sent first.
    pub runs: Vec<ThreadRun>,
    /// Its newest events, oldest first, up to `seq`. A finished turn that left plxd's window is
    /// one compacted `agent.output` (0052).
    pub events: Vec<LoggedEvent>,
    /// Whether older events remain, for `orchestration/threadHistory` before the first one.
    pub more: bool,
    /// The permission requests it waits on, as [`ShellSnapshot::requests`], for those older
    /// than `events`.
    pub requests: Vec<LoggedEvent>,
}

/// Params of `orchestration/threadHistory`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct ThreadHistoryParams {
    /// The thread: its run id.
    pub thread_id: RunId,
    /// The page is the events before this `seq`: the first one the client has.
    pub before: u64,
}

/// Result of `orchestration/threadHistory`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct ThreadHistoryResult {
    /// The events, oldest first.
    pub events: Vec<LoggedEvent>,
    /// Whether older ones remain.
    pub more: bool,
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::{DispatchMode, OrchestrationCommand};

    #[test]
    fn commands_and_modes_are_tagged_by_type() {
        let command: OrchestrationCommand = serde_json::from_value(json!({
            "type": "message.dispatch",
            "threadId": "01a0d360-1a2b-7c3d-8e4f-5a6b7c8d9e01",
            "messageId": "01a0d360-1a2b-7c3d-8e4f-5a6b7c8d9e02",
            "text": "Go on",
            "dispatchMode": {"type": "steer_active", "targetRunId": "01a0d360-1a2b-7c3d-8e4f-5a6b7c8d9e03"}
        }))
        .unwrap();
        let OrchestrationCommand::MessageDispatch { dispatch_mode, .. } = command else {
            panic!("{command:?}");
        };
        assert!(matches!(dispatch_mode, DispatchMode::SteerActive { .. }));
        let unknown: OrchestrationCommand =
            serde_json::from_value(json!({"type": "thread.fork"})).unwrap();
        assert_eq!(unknown, OrchestrationCommand::Unknown);
    }
}
