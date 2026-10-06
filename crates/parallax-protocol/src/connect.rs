use serde::{Deserialize, Serialize};
use ts_rs::TS;

/// The device icons `host/settings/set` accepts as `deviceIcon` (decision 0056).
pub const DEVICE_ICONS: [&str; 4] = ["laptop", "desktop", "mini", "server"];

/// The longest `deviceName`, in characters.
pub const MAX_DEVICE_NAME_CHARS: usize = 64;

/// The TCP port plxd listens on, on its own Tailscale IPv4, while `connect` is on (0056).
pub const CONNECT_PORT: u16 = 7340;

/// Params of `connect/devices`.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct ConnectDevicesParams {}

/// Result of `connect/devices`: this node and the tailnet's other nodes of this node's
/// Tailscale user (0056).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct ConnectDevicesResult {
    /// Whether Tailscale runs on this host.
    pub tailscale: TailscaleState,
    /// The port plxd listens on while `connect` is on.
    pub port: u16,
    /// Whether this plxd's tailnet listener is bound now.
    pub listening: bool,
    /// This node. Absent unless Tailscale is running.
    #[serde(rename = "self", default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub self_device: Option<TailnetDevice>,
    /// The other nodes of this node's user, by host name. Tagged and shared nodes are left out.
    pub devices: Vec<TailnetDevice>,
}

/// Whether Tailscale runs on a host.
///
/// A newer plxd may send states that are not listed here. Treat those as unknown.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub enum TailscaleState {
    /// Tailscale is connected to its tailnet.
    Running,
    /// The Tailscale CLI is installed, but Tailscale isn't connected or doesn't answer.
    Stopped,
    /// No Tailscale CLI was found.
    Missing,
    /// A state this version does not know yet.
    #[serde(other)]
    #[ts(skip)]
    Unknown,
}

/// A node on the tailnet.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct TailnetDevice {
    /// The node's stable ID, such as `nZi1Lj6Rrb11CNTRL`.
    pub id: String,
    /// The node's host name.
    pub host_name: String,
    /// The node's `MagicDNS` name, without the trailing dot.
    pub dns_name: String,
    /// The OS as Tailscale reports it, such as `macOS`, `windows`, `linux`, or `iOS`.
    pub os: String,
    /// The node's first Tailscale IPv4 address.
    pub ip: String,
    /// Whether Tailscale sees the node online.
    pub online: bool,
    /// Whether plxd answered on the node's port. Only checked when it is online.
    pub parallax: bool,
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::TailscaleState;

    #[test]
    fn unknown_tailscale_states_decode_as_unknown() {
        assert_eq!(
            serde_json::from_value::<TailscaleState>(json!("needsLogin")).unwrap(),
            TailscaleState::Unknown
        );
        assert_eq!(
            serde_json::to_value(TailscaleState::Missing).unwrap(),
            json!("missing")
        );
    }
}
