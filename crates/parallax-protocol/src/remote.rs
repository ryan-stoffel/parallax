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

/// Params of `relay/register`: registers a host with Parallax Relay under the signed-in user.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct RelayRegisterParams {
    /// The user's Clerk session token. plxd sends it to the relay once and keeps nothing of it.
    pub token: String,
    /// Another computer's registration, from its `relay/sign` over this token's hash, to post in
    /// its place (PLX-1146). Absent registers this host.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub signed: Option<RelaySignResult>,
}

/// Params of `relay/sign` (PLX-1146): signs this host's relay registration for a token that stays
/// on another computer.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct RelaySignParams {
    /// The token's SHA-256, in base64url without padding.
    pub token_hash: String,
    /// The token's Clerk user id (`sub`), which this host records as its account (0091). Only a
    /// trusted connection's caller sets it, never the relay.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub user_id: Option<String>,
}

/// Result of `relay/sign`: what `relay/register`'s `signed` takes.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct RelaySignResult {
    /// Its relay id: its host key's JWK thumbprint.
    pub host_id: String,
    /// Its host key's P-256 public x coordinate, in base64url.
    pub x: String,
    /// Its y coordinate.
    pub y: String,
    /// Its name.
    pub name: String,
    /// Its ES256 signature over the registration message, in base64url.
    pub signature: String,
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

/// Params of `relay/id`.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct RelayIdParams {}

/// Result of `relay/id` (0091): this host's relay id, the JWK thumbprint of its host key, which an
/// `account:` connection pins, and its current routes, so a client can refresh them.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct RelayIdResult {
    /// Its relay id.
    pub host_id: String,
    /// Where the host can be reached now, best first, as its `/.well-known/parallax` descriptor
    /// lists them: its LAN address, its Tailscale address, then `relay:<hostId>` while plxd is
    /// connected to the relay. Each address is an IP, with `:port` when plxd listens on another
    /// port than 7341. An older plxd leaves it out.
    #[serde(default)]
    #[ts(as = "Option<Vec<String>>", optional)]
    pub routes: Vec<String>,
}

/// Params of `access/get`.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct AccessGetParams {
    /// A `version` the caller already has: the answer waits until the state changes from it, or
    /// the connection closes. Absent answers at once.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub after: Option<u64>,
}

/// Who may sign in to this host with its account (0091), and what waits for the user.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct AccessState {
    /// Changes whenever anything below does, for `access/get`'s `after`.
    pub version: u64,
    /// The Clerk user id this host registered with the relay under, if it has.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub account: Option<String>,
    /// The `DPoP` key thumbprints of the approved clients.
    pub approved_clients: Vec<String>,
    /// The thumbprints of removed clients, which are never approved again.
    pub removed_clients: Vec<String>,
    /// The relay ids of the account's approved hosts.
    pub approved_hosts: Vec<String>,
    /// A new device's request, while it waits.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub pending: Option<AccessRequest>,
    /// The name of the device the latest `access/setupCode` code approved, once one has.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub setup_approved: Option<String>,
}

/// A new device's request to sign in, which one of the user's approved devices approves once
/// both show the same code.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct AccessRequest {
    /// Its id, which `access/approve` and `access/deny` take.
    pub id: String,
    /// The name the device gave.
    pub name: String,
    /// The device's `DPoP` key thumbprint.
    pub thumbprint: String,
    /// Its 6 digits, once the device sent its random value. Until then it can't be approved.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub code: Option<String>,
    /// When it lapses, in RFC 3339.
    pub expires_at: String,
}

/// Params of `access/merge`: lists another host keeps, merged into this one's. A removed key
/// stays removed and leaves the approved list.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct AccessMergeParams {
    /// Approved client thumbprints.
    #[serde(default)]
    pub approved_clients: Vec<String>,
    /// Removed client thumbprints.
    #[serde(default)]
    pub removed_clients: Vec<String>,
    /// Approved host ids.
    #[serde(default)]
    pub approved_hosts: Vec<String>,
}

/// Params of `access/approve` and `access/deny`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct AccessRequestParams {
    /// The request's id.
    pub request: String,
}

/// Params of `access/remove`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct AccessRemoveParams {
    /// The client's `DPoP` key thumbprint.
    pub thumbprint: String,
}

/// Params of `access/setupCode`.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct AccessSetupCodeParams {}

/// Result of `access/setupCode`: the code a new computer shows for a signed-in client to type
/// (0091).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct AccessSetupCodeResult {
    /// 6 digits. A client that types it runs SPAKE2 pairing with it once.
    pub code: String,
    /// When it stops working, in RFC 3339.
    pub expires_at: String,
}
