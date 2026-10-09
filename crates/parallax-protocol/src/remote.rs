use serde::{Deserialize, Serialize};
use ts_rs::TS;

/// Params of `remote/pair`.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct RemotePairParams {}

/// Result of `remote/pair`: a one-time pairing code another computer on this network enters
/// (PLX-641, 0065).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct RemotePairResult {
    /// Such as `7KQ-4M2`. It works once, until `expiresAt`, and locks after 5 wrong tries. A
    /// newer code replaces it.
    pub code: String,
    /// When the code stops working, in RFC 3339.
    pub expires_at: String,
    /// The name this host advertises over mDNS while the code waits.
    pub name: String,
    /// Where another computer can reach this one, best first, for when mDNS can't find it: its
    /// LAN address, then its Tailscale address. Each is an IP, with `:port` when plxd listens on
    /// another port than 7341.
    pub addresses: Vec<String>,
}

/// Params of `remote/sessions`.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct RemoteSessionsParams {}

/// Result of `remote/sessions` and `remote/revoke`: the paired clients' sessions, oldest first.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct RemoteSessionsResult {
    /// The sessions.
    pub sessions: Vec<RemoteSession>,
    /// Whether plxd is listening for paired clients now.
    pub listening: bool,
    /// Whether a pairing code is waiting, so plxd advertises itself over mDNS. False once the
    /// code is used, locked, or expired.
    pub pairing: bool,
    /// Why it isn't while `remote` is on, such as the port being in use by another program.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub problem: Option<String>,
}

/// A paired client's session.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct RemoteSession {
    /// Its id, which `remote/revoke` takes.
    pub id: String,
    /// The name the client gave while pairing.
    pub name: String,
    /// When it paired, in RFC 3339.
    pub created_at: String,
}

/// Params of `remote/revoke`: ends a session and closes its connections.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct RemoteRevokeParams {
    /// The session's id, from `remote/sessions`.
    pub id: String,
}
