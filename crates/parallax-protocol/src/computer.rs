//! Computer use (PLX-897, decision 0077): a thread's `computer_*` tools operate the host's desktop
//! apps. `plxd mcp` asks with `computer/ask` before a thread first uses an app, and the app's
//! Settings reads and changes what is allowed with `computer/status` and `computer/forget`.
//! Behind the `computerUse` capability, which only a macOS plxd advertises.

use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::RunId;

/// Params of `computer/ask`: may thread `runId` use `app`? An app the user always allows answers
/// at once. Otherwise the run's transcript gets an `approvalRequested` item whose tool is
/// `computer_use`, whose input is `{"app": app}`, and whose `alwaysAllow` is `[app]`, and the call
/// waits up to `waitMs` for its `agent/approve`. Asking again for the same app while that request
/// waits keeps waiting on it, so a caller asks again after each `pending`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct ComputerAskParams {
    /// The thread asking.
    pub run_id: RunId,
    /// The app's name, as `computer_list_apps` shows it, such as `Notes`.
    pub app: String,
    /// How long to wait for the user before answering `pending`, at most 50000, under plxd's
    /// idle timeout.
    pub wait_ms: u32,
}

/// Result of `computer/ask`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct ComputerAskResult {
    /// Where the request stands.
    pub status: ComputerAnswer,
}

/// Where a `computer/ask` stands.
///
/// A newer plxd may send a value this version does not know; treat it as not allowed.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub enum ComputerAnswer {
    /// The user hasn't answered yet: ask again to keep waiting.
    Pending,
    /// The thread may use the app.
    Allowed,
    /// Every thread may use the app: the user always allows it.
    Always,
    /// The user said no.
    Denied,
    /// The run stopped, or its turn ended, before the user answered.
    Stopped,
    /// A value this version does not know yet.
    #[serde(other)]
    #[ts(skip)]
    Unknown,
}

/// Params of `computer/status`.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct ComputerStatusParams {
    /// Ask macOS for the permissions plxd lacks first, which shows its prompts.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub request: bool,
}

/// Result of `computer/status` and `computer/forget`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct ComputerStatus {
    /// plxd may read other apps' windows and act in them: macOS's Accessibility permission.
    pub accessibility: bool,
    /// plxd may capture other apps' windows: macOS's Screen Recording permission.
    pub screen_recording: bool,
    /// The program macOS lists under both permissions, such as `plxd`.
    pub program: String,
    /// The apps every thread may use without asking, by name, sorted.
    pub apps: Vec<String>,
}

/// Params of `computer/forget`: ask again before a thread uses `app`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct ComputerForgetParams {
    /// The app, as `computer/status` lists it.
    pub app: String,
}
