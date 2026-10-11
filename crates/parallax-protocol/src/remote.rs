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
    /// The SHA-256 fingerprint of the listener's certificate, in hex, while it listens: what a
    /// browser shows for it, to check before trusting it (PLX-651).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub fingerprint: Option<String>,
    /// Why it isn't while `remote` is on, such as the port being in use by another program.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub problem: Option<String>,
    /// The relay connection while `relay` is on (PLX-652, 0068). An older plxd leaves it out.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub relay: Option<RelayStatus>,
}

/// plxd's connection to Parallax Relay (PLX-652, 0068).
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct RelayStatus {
    /// Whether plxd is connected and the relay accepted its host key.
    pub connected: bool,
    /// Where webhooks reach this host through the relay, to be followed by `/<hookId>/<token>`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub hook_url: Option<String>,
    /// Why it isn't connected, such as this host not being registered yet.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub problem: Option<String>,
}

/// Params of `relay/hosts`: the hosts the signed-in user has on Parallax Relay.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct RelayHostsParams {
    /// The user's Clerk session token. plxd sends it to the relay and keeps nothing of it.
    pub token: String,
}

/// Params of `relay/remove`: removes one of the signed-in user's hosts from Parallax Relay,
/// which frees its place: an account holds 10.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct RelayRemoveParams {
    /// The user's Clerk session token.
    pub token: String,
    /// The host's relay id.
    pub host_id: String,
}

/// Result of `relay/hosts` and `relay/remove`.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct RelayHostsResult {
    /// The user's hosts on the relay.
    pub hosts: Vec<RelayHost>,
}

/// A host the signed-in user has on Parallax Relay.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct RelayHost {
    /// Its relay id.
    pub host_id: String,
    /// Its name, as it registered.
    pub name: String,
    /// Whether it is connected to the relay now.
    pub online: bool,
    /// Whether it is the plxd that answered: this computer.
    pub this_computer: bool,
}

/// Params of `relay/register`: registers this host with Parallax Relay under the signed-in user.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct RelayRegisterParams {
    /// The user's Clerk session token. plxd sends it to the relay once and keeps nothing of it.
    pub token: String,
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
