use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::ProtocolRange;

/// Params of `host/health`.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct HostHealthParams {}

/// Result of `host/health`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct HostHealthResult {
    /// Seconds since plxd started.
    pub uptime_seconds: u64,
    /// Whether plxd can read and write its project store.
    pub store: StoreState,
    /// Agents running on this host. Always 0 before M3.
    pub running_agents: u32,
}

/// The state of plxd's project store.
///
/// A newer plxd may send states that are not listed here. Treat those as unknown, so a `switch`
/// over this type must not end in an exhaustiveness assertion.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub enum StoreState {
    /// The store works.
    Ok,
    /// The store cannot be read or written, so project methods fail.
    Unavailable,
    /// A state this version does not know yet.
    #[serde(other)]
    #[ts(skip)]
    Unknown,
}

/// Params of `host/version`.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct HostVersionParams {}

/// Result of `host/version`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct HostVersionResult {
    /// plxd's release version.
    pub plxd: String,
    /// The protocol versions plxd speaks.
    pub protocol: ProtocolRange,
    /// The operating system and its version, such as `macOS 27.0`.
    pub os: String,
    /// The CPU architecture, such as `aarch64`.
    pub arch: String,
}

/// Params of `host/settings/get`.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct HostSettingsGetParams {}

/// Params of `host/settings/set`: changes the settings it names and leaves the rest.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct HostSettingsSetParams {
    /// The new `autoResume`. Absent leaves it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub auto_resume: Option<bool>,
}

/// This host's settings, the result of `host/settings/get` and `host/settings/set`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct HostSettings {
    /// Whether a run a usage limit stopped waits for the limit to reset and then resumes
    /// (PLX-371, decision 0049). On by default. A run's own `autoResume` overrides it. Turning it
    /// off stops a waiting run from resuming when its timer fires.
    pub auto_resume: bool,
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::{HostHealthParams, StoreState};

    #[test]
    fn unknown_store_states_decode_as_unknown() {
        assert_eq!(
            serde_json::from_value::<StoreState>(json!("migrating")).unwrap(),
            StoreState::Unknown
        );
        assert_eq!(serde_json::to_value(StoreState::Ok).unwrap(), json!("ok"));
    }

    #[test]
    fn empty_params_accept_future_options() {
        assert_eq!(
            serde_json::from_value::<HostHealthParams>(json!({"verbose": true})).unwrap(),
            HostHealthParams {}
        );
        assert_eq!(
            serde_json::to_value(HostHealthParams {}).unwrap(),
            json!({})
        );
    }
}
