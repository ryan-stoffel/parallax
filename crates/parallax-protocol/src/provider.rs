//! Provider instances (0040): `providers/*`.
//!
//! A provider instance is one configured way to run agents on a host: a built-in agent CLI
//! (Claude Code, Codex, Cursor), an agent added from a preset (`OpenCode`, Antigravity, Pi, ...),
//! an ACP agent from the registry or entered by hand, or a model service run through an agent
//! (Ollama Cloud, `OpenRouter`, a local model). Its id is the backend name a subscription
//! `AccountChoice` names, so a thread starts on an instance the way it started on `claude`.

use jiff::Timestamp;
use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::AgentPermission;

/// What runs an instance, and the defaults it starts from.
///
/// A newer plxd may send kinds that are not listed here. Treat those as unknown, so a `switch`
/// over this type must not end in an exhaustiveness assertion.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub enum ProviderKind {
    /// Claude Code, `claude`.
    Claude,
    /// Codex, `codex app-server`.
    Codex,
    /// Cursor Agent, `agent acp`.
    Cursor,
    /// Google Antigravity, `agy`.
    Antigravity,
    /// `OpenCode`, `opencode acp`.
    Opencode,
    /// Pi, through its ACP adapter.
    Pi,
    /// Grok Build, `grok agent stdio`.
    GrokBuild,
    /// Hermes Agent on Nous Portal, `hermes acp`.
    Hermes,
    /// Ollama Cloud's models through an agent.
    OllamaCloud,
    /// `OpenRouter`'s models through an agent.
    OpenRouter,
    /// A model served on this host or the network, through an agent.
    LocalModel,
    /// Any other ACP agent: one from the ACP registry, or entered by hand.
    Acp,
    /// A kind this version does not know yet.
    #[serde(other)]
    #[ts(skip)]
    Unknown,
}

/// One environment variable an instance's runs get.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct ProviderEnvVar {
    /// The variable's name.
    pub name: String,
    /// Its value. plxd never sends a secret's value back: a listed secret has none, and an
    /// update that leaves it out keeps the stored one.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub value: Option<String>,
    /// Kept in the host's keychain instead of plxd's settings, such as an API key.
    #[serde(default)]
    pub secret: bool,
}

/// A model an instance offers.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct ProviderModel {
    /// What the agent takes, sent as `thread/start`'s `model`.
    pub id: String,
    /// What people see.
    pub name: String,
}

/// An instance's settings, as the user sees and edits them.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct ProviderInstance {
    /// A stable id: lowercase letters, digits, and `-`. The built-in instances are `claude`,
    /// `codex`, and `cursor`.
    pub id: String,
    /// What runs it.
    pub kind: ProviderKind,
    /// What people see, such as `Codex` or `Work Codex`.
    pub name: String,
    /// Whether threads may start on it. A disabled instance keeps its settings.
    pub enabled: bool,
    /// The program, a name on the host's `PATH` or an absolute path. Absent: the kind's own.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub program: Option<String>,
    /// The agent's home or configuration folder, such as `CODEX_HOME`, for a kind that has one.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub home: Option<String>,
    /// Arguments added after the kind's own. For an `acp` instance, every argument.
    #[serde(default)]
    pub args: Vec<String>,
    /// Variables its runs get, set last.
    #[serde(default)]
    pub env: Vec<ProviderEnvVar>,
    /// Models the user added, offered beside the ones plxd finds.
    #[serde(default)]
    pub models: Vec<ProviderModel>,
    /// The percent of each limit window that a Project's children leave for the user, from 0 to
    /// 100 (0046). At or past its limit minus this, it takes no new children. Absent means none.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub reserve: Option<u8>,
}

/// An instance's detected state, and what it offers.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct ProviderInfo {
    /// Its settings.
    pub instance: ProviderInstance,
    /// Whether its program resolves on the host.
    pub installed: bool,
    /// The program's resolved path, when installed.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub path: Option<String>,
    /// The agent's version, when plxd could read it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub version: Option<String>,
    /// Whether it is signed in, or `null` when plxd can't tell.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub signed_in: Option<bool>,
    /// Who it is signed in as, or the plan, where the agent says.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub account: Option<String>,
    /// Why something above is missing or uncertain.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub note: Option<String>,
    /// The models plxd found for it, without the user's own.
    #[serde(default)]
    pub models: Vec<ProviderModel>,
    /// The permissions a thread on it may ask for.
    pub permissions: Vec<AgentPermission>,
    /// Whether it takes `thread/start`'s `effort`.
    pub efforts: bool,
    /// Whether it can run a Project's coordinator.
    pub coordinator: bool,
    /// The command that signs it in, run in a terminal on the host, if it has one.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub login: Option<Vec<String>>,
    /// Variables the sign-in command runs with, none of them secret: the agent's own and the
    /// instance's, and for an ACP agent its home folder's.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub login_env: Vec<ProviderEnvVar>,
}

/// Params of `providers/list`.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct ProvidersListParams {
    /// Probe every instance again instead of answering from plxd's cache.
    #[serde(default)]
    pub refresh: bool,
}

/// Result of `providers/list`, and of `providers/save` and `providers/remove`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct ProvidersListResult {
    /// Every instance, the built-in ones first, then in the order they were added.
    pub providers: Vec<ProviderInfo>,
    /// When the slowest of these was probed.
    pub checked_at: Timestamp,
}

/// Params of `providers/save`: adds an instance, or replaces the one with its id.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct ProvidersSaveParams {
    /// The instance as it should be.
    pub instance: ProviderInstance,
}

/// Params of `providers/remove`. A built-in instance can't be removed, only disabled.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct ProvidersRemoveParams {
    /// The instance's id.
    pub id: String,
}
