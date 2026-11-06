//! `CLIProxyAPI` hubs (0089): `hubs/*`.
//!
//! A hub is a `CLIProxyAPI` server that keeps many Claude and Codex sign-ins and serves them as one
//! endpoint. A host keeps its hubs, and each enabled one adds two provider instances, one that
//! runs Claude Code through it and one that runs Codex through it, which `providers/list` lists
//! with `hub` set. Its keys are kept in the host's keychain and never sent back. With a management
//! key, `hubs/accounts/*` signs accounts in to it, turns them on and off, and removes them
//! (PLX-1070).

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
    /// The hub's id for it, its auth file's name, which `hubs/accounts/setEnabled` and
    /// `hubs/accounts/remove` take.
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

/// A service a hub signs accounts in to (PLX-1070).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub enum HubService {
    /// Claude, through Claude Code's sign-in.
    Claude,
    /// Codex, through `ChatGPT`'s sign-in.
    Codex,
}

/// Params of `hubs/accounts/signIn`: starts signing an account in to a hub.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct HubSignInParams {
    /// The hub's id.
    pub hub: String,
    /// Which service to sign in to.
    pub service: HubService,
}

/// Result of `hubs/accounts/signIn`: the page to open in a browser, and the sign-in's state,
/// which names it in the other `hubs/accounts/*` sign-in calls.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct HubSignIn {
    /// The service's `https` sign-in page.
    pub url: String,
    /// The sign-in's OAuth state.
    pub state: String,
}

/// Params of `hubs/accounts/callback`: the address the browser was sent to after signing in, for
/// a browser on another computer than the hub.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct HubSignInCallbackParams {
    /// The hub's id.
    pub hub: String,
    /// The sign-in's state, which the address's `state` must match.
    pub state: String,
    /// The `http://localhost` address, with its `code` and `state`.
    pub redirect_url: String,
}

/// Params of `hubs/accounts/status` and `hubs/accounts/cancel`: one sign-in on a hub.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct HubSignInStateParams {
    /// The hub's id.
    pub hub: String,
    /// The sign-in's state.
    pub state: String,
}

/// Where a sign-in on a hub is.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub enum HubSignInState {
    /// The hub waits for the browser's redirect.
    Waiting,
    /// The hub keeps the new account.
    Done,
    /// The sign-in ended without an account.
    Failed,
    /// The sign-in was cancelled.
    Cancelled,
}

/// Result of `hubs/accounts/status`, `hubs/accounts/callback`, and `hubs/accounts/cancel`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct HubSignInStatus {
    /// Where the sign-in is.
    pub status: HubSignInState,
    /// Why it failed, for people, in plxd's words and never the hub's.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub problem: Option<String>,
}

/// Params of `hubs/accounts/setEnabled`: turns a hub's account on or off.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct HubAccountSetEnabledParams {
    /// The hub's id.
    pub hub: String,
    /// The account's id, a [`HubAccount`]'s.
    pub account: String,
    /// Whether the hub uses it.
    pub enabled: bool,
}

/// Params of `hubs/accounts/remove`: deletes a hub's account and its sign-in.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct HubAccountRemoveParams {
    /// The hub's id.
    pub hub: String,
    /// The account's id, a [`HubAccount`]'s.
    pub account: String,
}
