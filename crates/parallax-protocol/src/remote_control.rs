//! Claude Remote Control threads (PLX-1140), behind the `claudeRemoteControl` capability.
//!
//! A thread imported from a Claude Code session `claude remote-control` serves on another
//! computer keeps that session: its run's `sessionId` is `claude.ai`'s, starting with
//! `session_`, and each message goes to the session there, whose reply and work the thread
//! follows. plxd also imports new Remote Control sessions on its own. `thread/remoteControl`
//! reads what the app shows about one: where it works and what it's doing now.

use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::RunId;

/// What a Claude Remote Control session is doing.
///
/// A newer plxd may send a state this version does not know; treat it as unknown.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub enum RemoteControlState {
    /// Claude is working on a turn.
    Running,
    /// Claude has finished and waits for a message.
    Idle,
    /// Claude waits for the user to answer a prompt, such as a permission request, which only
    /// Claude's own apps can answer.
    Waiting,
    /// A message was sent and nothing has answered it: the session's computer isn't serving it
    /// now, so the message waits there until it is.
    Offline,
    /// The session is archived and takes no more messages.
    Archived,
    /// A state this version does not know yet.
    #[serde(other)]
    #[ts(skip)]
    Unknown,
}

/// A Claude Remote Control session, as plxd last saw it.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct RemoteControlSession {
    /// `claude.ai`'s id for it, starting with `session_`.
    pub session_id: String,
    /// Where it opens in Claude: `https://claude.ai/code/<sessionId>`.
    pub url: String,
    /// The GitHub repository it works in, `owner/name`, when it has one.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub repository: Option<String>,
    /// The branch it works on, when `claude.ai` names one.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub branch: Option<String>,
    /// What it's doing. Absent until plxd has read it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub state: Option<RemoteControlState>,
}

/// Params of `thread/remoteControl`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct ThreadRemoteControlParams {
    /// The thread's run.
    pub run_id: RunId,
}

/// Result of `thread/remoteControl`: answered at once from what plxd last read, which it reads
/// again in the background once it's half a minute old.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct ThreadRemoteControlResult {
    /// The thread's session. Absent for a thread that isn't a Claude Remote Control thread.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub session: Option<RemoteControlSession>,
}
