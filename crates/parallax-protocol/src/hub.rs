//! `CLIProxyAPI` hubs (0089): `hubs/*`.
//!
//! A hub is a `CLIProxyAPI` server that keeps many Claude and Codex sign-ins and serves them as one
//! endpoint. A host keeps its hubs, and each enabled one adds two provider instances, one that
//! runs Claude Code through it and one that runs Codex through it, which `providers/list` lists
//! with `hub` set. Its keys are kept in the host's keychain and never sent back.

use jiff::Timestamp;
use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::{ProviderModel, UsageLimitWindow};

/// A hub as `hubs/list` reports it: its settings, without its keys, and what it last answered.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct Hub {
    /// A stable id: 1 to 48 lowercase letters, digits, and `-`.
    pub id: String,
    /// What people see. Its two instances are named after it.
    pub name: String,
    /// The hub's address, such as `https://hub.tailnet.ts.net:8317`, without a trailing `/`.
    pub url: String,
    /// Whether its instances run threads. A disabled hub keeps its settings and keys.
    pub enabled: bool,
    /// Whether a management key is kept, which lists its accounts.
    pub has_management_key: bool,
    /// The id of the instance that runs Claude Code through it.
    pub claude: String,
    /// The id of the instance that runs Codex through it.
    pub codex: String,
    /// Whether `/v1/models` answered with the access key.
    pub reachable: bool,
    /// Why it didn't, for people: the kind of failure and an HTTP status, never a response body.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub problem: Option<String>,
    /// The Claude models it serves, which run through Claude Code.
    pub claude_models: Vec<ProviderModel>,
    /// Every other model it serves, which runs through Codex.
    pub codex_models: Vec<ProviderModel>,
    /// Its accounts, from its management API. Empty without a management key.
    pub accounts: Vec<HubAccount>,
    /// Why its accounts couldn't be listed, for people.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub accounts_problem: Option<String>,
    /// When plxd last asked it.
    pub checked_at: Timestamp,
}

/// One account a hub keeps signed in: one of its auth files.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct HubAccount {
    /// The hub's id for it, its auth file's.
    pub id: String,
    /// Which service it signs in to, as the hub names it: `claude`, `codex`, or another.
    pub provider: String,
    /// The account's email, when the hub knows it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub email: Option<String>,
    /// Its plan, such as `pro`, when the service says.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub plan: Option<String>,
    /// Whether the hub keeps it out of rotation.
    pub disabled: bool,
    /// Its limit windows, read through the hub: `five_hour`, `seven_day`, and
    /// `seven_day_<model>`, as `usage/limits` names them. Empty for a disabled account and for a
    /// service plxd doesn't read limits for.
    pub limits: Vec<UsageLimitWindow>,
    /// Why its limits couldn't be read, for people.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub problem: Option<String>,
}

/// Params of `hubs/list`.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct HubsListParams {
    /// Ask every hub again instead of answering from plxd's cache.
    #[serde(default)]
    pub refresh: bool,
}

/// Result of `hubs/list`, and of `hubs/save` and `hubs/remove`.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct HubsListResult {
    /// Every hub, in the order they were added.
    pub hubs: Vec<Hub>,
}

/// Params of `hubs/save`: adds a hub, or replaces the one with its id.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct HubsSaveParams {
    /// The hub's id.
    pub id: String,
    /// What people see.
    pub name: String,
    /// The hub's `http` or `https` address.
    pub url: String,
    /// Whether its instances run threads.
    pub enabled: bool,
    /// One of the hub's `api-keys`, which its instances run with. Required for a new hub;
    /// absent keeps the stored one.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub access_key: Option<String>,
    /// Its management key, which lists its accounts. Absent keeps the stored one; empty removes
    /// it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub management_key: Option<String>,
}

/// Params of `hubs/remove`: removes a hub, its keys, and its two instances.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct HubsRemoveParams {
    /// The hub's id.
    pub id: String,
}
