//! Scheduled tasks and pull request watches (0063), behind the `schedules` and `prWatch`
//! capabilities.
//!
//! A scheduled task sends its prompt on a trigger: every interval, at a time of day, or on each
//! request to its webhook. A task bound to a thread queues the prompt into it, one in a Project
//! sends it to the Project's coordinator, and any other launches a new thread per fire.
//! `schedule/save` creates or replaces one, `schedule/list` lists them, `schedule/run` fires one
//! now, and `schedule/delete` removes one.
//!
//! `pr/watch` has plxd check one of a run's linked pull requests every two minutes and wake the
//! run with a message when a check fails, the required checks pass, someone else comments, or the
//! branch starts to conflict. `pr/unwatch` stops it, and `pr/watches` lists a run's watches.

use jiff::Timestamp;
use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::{AccountChoice, AgentEffort, AgentPermission, ProjectId, RepoId, RunId};

/// What fires a scheduled task.
///
/// A newer plxd may send a trigger this version does not know; show it as unknown.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(
    tag = "type",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
pub enum Schedule {
    /// Every `everyMs` milliseconds, at least 60000. An overdue run catches up with one fire.
    Interval {
        /// The interval.
        every_ms: u64,
    },
    /// At a local time of day, on every day or on `weekdays`. A run missed by more than 10
    /// minutes, such as while the host slept, is skipped.
    FixedTime {
        /// `HH:MM`, 24-hour, in the host's time zone.
        time_of_day: String,
        /// 0 is Sunday and 6 Saturday. Empty means every day.
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        weekdays: Vec<u8>,
    },
    /// On each request to the task's webhook. The prompt may use `{{body.a.b}}`,
    /// `{{headers.name}}`, `{{query.name}}`, `{{body}}`, and `{{request}}`.
    Webhook {
        /// The signature each request must carry, if any.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        signature: Option<WebhookSignature>,
    },
    /// A trigger this version does not know yet.
    #[serde(other)]
    #[ts(skip)]
    Unknown,
}

/// An HMAC-SHA256 signature over a webhook request's raw body, as GitHub and most senders sign.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct WebhookSignature {
    /// The header that carries it, such as `x-hub-signature-256`.
    pub header: String,
    /// How the digest is written in the header.
    pub encoding: SignatureEncoding,
    /// Text before the digest, such as `sha256=`. Empty for none.
    pub prefix: String,
    /// The shared secret. Only `schedule/save` takes it, and omitting it there keeps the stored
    /// one. plxd never returns it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub secret: Option<String>,
}

/// How a webhook signature's digest is written.
///
/// A newer client may send an encoding this version does not know; plxd refuses it.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub enum SignatureEncoding {
    /// Lowercase or uppercase hexadecimal.
    Hex,
    /// Standard base64.
    Base64,
    /// An encoding this version does not know yet.
    #[serde(other)]
    #[ts(skip)]
    Unknown,
}

/// How a scheduled task's last fire went.
///
/// A newer plxd may send a status this version does not know; treat it as unknown.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Hash, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub enum ScheduleRunStatus {
    /// It has not fired.
    #[default]
    Never,
    /// Its prompt is on its way to the thread.
    Running,
    /// Its prompt reached the thread.
    Succeeded,
    /// Its prompt could not be sent; `lastRunError` says why.
    Failed,
    /// A status this version does not know yet.
    #[serde(other)]
    #[ts(skip)]
    Unknown,
}

/// Where a webhook task receives requests.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct ScheduleWebhook {
    /// `/api/hooks/<id>/<token>`. The token is the secret part, so share it only with the sender.
    pub path: String,
    /// The full URL on this host's LAN address, while remote access is on.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub url: Option<String>,
    /// Whether requests must carry a valid signature.
    pub has_secret: bool,
}

/// A scheduled task, as `schedule/save`, `schedule/list`, and `schedule/run` return it.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct ScheduledTask {
    /// Its id, a UUID.
    pub id: String,
    /// Its name, and the title of each thread it launches.
    pub title: String,
    /// What each fire sends. A webhook's placeholders are filled from the request.
    pub prompt: String,
    /// A paused task doesn't fire, except by `schedule/run`.
    pub enabled: bool,
    /// Its trigger.
    pub schedule: Schedule,
    /// The thread each fire queues its prompt into.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub thread: Option<RunId>,
    /// The Project whose coordinator each fire messages.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub project: Option<ProjectId>,
    /// Without `thread` or `project`: the repo entry each fire launches a thread in. Absent
    /// launches it with no repository.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub repo: Option<RepoId>,
    /// A launched thread's account. Absent uses the worker default.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub account: Option<AccountChoice>,
    /// A launched thread's model.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub model: Option<String>,
    /// A launched thread's effort.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub effort: Option<AgentEffort>,
    /// A launched thread's access.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub permission: Option<AgentPermission>,
    /// When it fires next. Absent for a webhook or a paused task.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub next_run_at: Option<Timestamp>,
    /// When it last fired.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub last_run_at: Option<Timestamp>,
    /// How its last fire went.
    pub last_run_status: ScheduleRunStatus,
    /// Why its last fire failed.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub last_run_error: Option<String>,
    /// How many times it has fired.
    pub run_count: u64,
    /// Where a webhook task receives requests.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub webhook: Option<ScheduleWebhook>,
    /// When it was created.
    pub created_at: Timestamp,
}

/// Params of `schedule/save`: a task to create, or with `id`, to replace.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct ScheduleSaveParams {
    /// The task to replace. Absent creates one.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub id: Option<String>,
    /// Its name.
    pub title: String,
    /// What each fire sends, at most 64 KiB.
    pub prompt: String,
    /// Whether it fires on its own.
    pub enabled: bool,
    /// Its trigger. An interval is at least 60000 ms.
    pub schedule: Schedule,
    /// The thread each fire queues into.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub thread: Option<RunId>,
    /// The Project whose coordinator each fire messages.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub project: Option<ProjectId>,
    /// The repo entry each fire launches a thread in.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub repo: Option<RepoId>,
    /// A launched thread's account.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub account: Option<AccountChoice>,
    /// A launched thread's model.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub model: Option<String>,
    /// A launched thread's effort.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub effort: Option<AgentEffort>,
    /// A launched thread's access.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub permission: Option<AgentPermission>,
}

/// Params of `schedule/list`.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct ScheduleListParams {}

/// Result of `schedule/list`: every task on the host, oldest first.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct ScheduleListResult {
    /// The tasks.
    pub tasks: Vec<ScheduledTask>,
}

/// Params of `schedule/run` and `schedule/delete`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct ScheduleIdParams {
    /// The task's id.
    pub id: String,
}

/// Result of `schedule/delete`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct ScheduleDeleteResult {
    /// False when no task had the id.
    pub deleted: bool,
}

/// Result of `pr/watch` and `pr/unwatch`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct PrWatchResult {
    /// The pull request's URL.
    pub url: String,
    /// Whether plxd watches it for the run now.
    pub watching: bool,
    /// Whether it did before the call.
    pub was_watching: bool,
}

/// Params of `pr/watches`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct PrWatchesParams {
    /// The run.
    pub run_id: RunId,
}

/// Result of `pr/watches`: the URLs of the run's linked pull requests that plxd watches.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct PrWatchesResult {
    /// The URLs.
    pub urls: Vec<String>,
}
