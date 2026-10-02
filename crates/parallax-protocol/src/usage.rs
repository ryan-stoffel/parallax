use jiff::Timestamp;
use serde::{Deserialize, Serialize};
use ts_rs::TS;

/// Params of `usage/get`.
///
/// Empty: plxd has no account registry yet (#114, #117, #118 are still open, and #113's
/// `AccountRef` is already just a caller-supplied string), so it reports every account id it has
/// recorded usage or limits for.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct UsageGetParams {}

/// Result of `usage/get`.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct UsageGetResult {
    /// Every account plxd has recorded usage or limits for, in no particular order.
    pub accounts: Vec<AccountUsage>,
}

/// One account's usage and latest limit windows.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct AccountUsage {
    /// plxd's id for the account (#114, #117).
    pub account_id: String,
    /// Tokens and cost used today, local time on this host.
    pub today: UsagePeriod,
    /// Tokens and cost used this week (Monday to now), local time on this host.
    pub week: UsagePeriod,
    /// The account's limit windows, as last reported. Empty when the vendor reports none (0004:
    /// Cursor's headless output has no usage API).
    pub limits: Vec<UsageLimitWindow>,
}

/// Tokens and cost over a period.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct UsagePeriod {
    /// Input tokens, not counting cache reads and writes.
    pub input_tokens: u64,
    /// Output tokens, including reasoning.
    pub output_tokens: u64,
    /// Input tokens read from the prompt cache.
    pub cache_read_tokens: u64,
    /// Input tokens written to the prompt cache.
    pub cache_write_tokens: u64,
    /// The cost, when the vendor reports one for this account in the period. Absent, not zero,
    /// when it never does (0004: Codex and Cursor report no cost).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub cost_usd_micros: Option<u64>,
}

/// One of an account's limit windows, as a vendor last reported it (0004's `rate_limit_event` and
/// Codex's `account/rateLimits/read`).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct UsageLimitWindow {
    /// The vendor's name for the window, such as `five_hour`, `seven_day`, `primary`, or
    /// `secondary`.
    pub window: String,
    /// How much of the window is used, from 0 to 100, when the vendor says.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub used_percent: Option<f64>,
    /// When the window resets, when the vendor says.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub resets_at: Option<Timestamp>,
    /// When plxd captured this snapshot.
    pub captured_at: Timestamp,
}

/// Params of `usage/history`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct UsageHistoryParams {
    /// The start of the range, inclusive. The range ends now.
    pub since: Timestamp,
}

/// Result of `usage/history`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct UsageHistoryResult {
    /// Usage summed per UTC hour, account, and model, oldest hour first. Hours with no usage are
    /// left out.
    pub hours: Vec<UsageHour>,
    /// How many runs each account used in the range. Accounts with none are left out.
    pub runs: Vec<AccountRuns>,
}

/// One account's usage of one model within one UTC hour.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct UsageHour {
    /// The start of the UTC hour, such as `2026-09-29T19:00:00Z`.
    pub hour: Timestamp,
    /// plxd's id for the account (#114, #117).
    pub account_id: String,
    /// The model, when the vendor named one.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub model: Option<String>,
    /// Input tokens, not counting cache reads and writes.
    pub input_tokens: u64,
    /// Output tokens, including reasoning.
    pub output_tokens: u64,
    /// Input tokens read from the prompt cache.
    pub cache_read_tokens: u64,
    /// Input tokens written to the prompt cache.
    pub cache_write_tokens: u64,
    /// The cost, when the vendor reported one in this hour. Absent, not zero, when it did not
    /// (0004: Codex and Cursor report no cost).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub cost_usd_micros: Option<u64>,
}

/// How many distinct runs used an account in a range.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct AccountRuns {
    /// plxd's id for the account (#114, #117).
    pub account_id: String,
    /// Runs with at least one usage delta in the range.
    pub runs: u32,
}
