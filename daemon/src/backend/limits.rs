//! A subscription's limit windows, read live from its CLI for `usage/limits` (PLX-541).
//!
//! [`Backend::limits`](super::Backend::limits) starts the CLI the way
//! [`Backend::commands`](super::Backend::commands) does, and [`commands::list`] asks it once:
//!
//! - **Claude Code**: `claude -p` in stream-json with hooks off, and a `get_usage` control request
//!   with `skip_behaviors`, whose answer holds the plan's windows from the claude.ai usage
//!   endpoint. Experimental in the Agent SDK, so a window it stops sending is simply left out.
//! - **Codex**: `codex app-server`, `initialize`, `initialized`, and `account/rateLimits/read`.
//!
//! [`commands::list`]: super::commands::list

use jiff::Timestamp;
use parallax_protocol::UsageLimitWindow;
use serde_json::Value;

use super::commands::{LIST_ID, Parsed, Probe, text};

/// The CLI [`Backend::limits`](super::Backend::limits) started.
pub type LimitsProbe = Probe<Vec<UsageLimitWindow>>;

/// The `request_id` of Claude Code's `get_usage`.
pub const CLAUDE_REQUEST_ID: &str = "limits";

/// Claude Code's named windows, in the order they show.
const CLAUDE_WINDOWS: &[&str] = &[
    "five_hour",
    "seven_day",
    "seven_day_opus",
    "seven_day_sonnet",
];

/// Claude Code's answer to `get_usage`: its named windows, then each per-model weekly window as
/// `seven_day_<model>`, such as `seven_day_fable`. None for a login without plan limits.
#[must_use]
pub fn claude(message: &Value) -> Parsed<Vec<UsageLimitWindow>> {
    let response = &message["response"];
    if message["type"] != "control_response" || response["request_id"] != CLAUDE_REQUEST_ID {
        return None;
    }
    if response["subtype"] == "error" {
        return Some(Err(text(&response["error"])));
    }
    let limits = response.pointer("/response/rate_limits")?;
    let now = Timestamp::now();
    let window = |name: String, entry: &Value| {
        entry.is_object().then(|| UsageLimitWindow {
            window: name,
            used_percent: entry["utilization"].as_f64(),
            resets_at: entry["resets_at"].as_str().and_then(|at| at.parse().ok()),
            captured_at: now,
        })
    };
    let named = CLAUDE_WINDOWS
        .iter()
        .filter_map(|name| window((*name).to_owned(), &limits[name]));
    let scoped = limits["model_scoped"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|entry| {
            let model = entry["display_name"]
                .as_str()?
                .to_lowercase()
                .replace(' ', "_");
            window(format!("seven_day_{model}"), entry)
        });
    Some(Ok(named.chain(scoped).collect()))
}

/// Codex's answer to `account/rateLimits/read`: its `primary` and `secondary` windows, named
/// `five_hour` and `seven_day` when they last that long, as Claude's are.
#[must_use]
pub fn codex(message: &Value) -> Parsed<Vec<UsageLimitWindow>> {
    if message["id"] != LIST_ID {
        return None;
    }
    if !message["error"].is_null() {
        return Some(Err(text(&message["error"]["message"])));
    }
    let limits = message.pointer("/result/rateLimits")?;
    let now = Timestamp::now();
    Some(Ok(["primary", "secondary"]
        .into_iter()
        .filter_map(|slot| {
            let entry = limits.get(slot).filter(|entry| entry.is_object())?;
            let name = match entry["windowDurationMins"].as_u64() {
                Some(300) => "five_hour",
                Some(10_080) => "seven_day",
                _ => slot,
            };
            Some(UsageLimitWindow {
                window: name.to_owned(),
                used_percent: entry["usedPercent"].as_f64(),
                resets_at: entry["resetsAt"]
                    .as_i64()
                    .and_then(|seconds| Timestamp::from_second(seconds).ok()),
                captured_at: now,
            })
        })
        .collect()))
}

#[cfg(test)]
mod tests {}
