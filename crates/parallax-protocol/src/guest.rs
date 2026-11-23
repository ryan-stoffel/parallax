//! Guest links (0108): one thread shown to one browser for 24 hours, behind the `guestLinks`
//! capability. The owner makes, lists, and ends them with `guest/create`, `guest/list`, and
//! `guest/revoke`, from a full-access session. A guest suggests a message with `guest/suggest`
//! while its link allows it, and the owner sends or dismisses it with `guest/send` and
//! `guest/dismiss`.

use jiff::Timestamp;
use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::{RunId, TurnId};

/// Params of `guest/create`: a new link to `threadId`, which ends the thread's live one.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct GuestCreateParams {
    /// The thread: its run id.
    pub thread_id: RunId,
    /// The guest may suggest messages, which wait for the owner. Off when absent.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    #[ts(as = "Option<bool>", optional)]
    pub can_suggest: bool,
}

/// Result of `guest/create`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct GuestCreateResult {
    /// The new link.
    pub link: GuestLink,
    /// The link's URL fragment, `<hostId>.<linkId>.<secret>` in base64url, which goes after
    /// `#` in the hosted client's `/g` page. Only this answer carries the secret.
    pub fragment: String,
}

/// A live guest link, without its secret.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct GuestLink {
    /// The link's id, 16 bytes in base64url.
    pub id: String,
    /// The thread it shows.
    pub thread_id: RunId,
    /// When it was made.
    pub created_at: Timestamp,
    /// When it ends.
    pub expires_at: Timestamp,
    /// The guest may suggest messages.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    #[ts(as = "Option<bool>", optional)]
    pub can_suggest: bool,
    /// When a browser's key bound it, if one has. Absent means nobody opened it yet.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub bound_at: Option<Timestamp>,
    /// The guest's messages waiting for the owner, oldest first.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    #[ts(as = "Option<Vec<GuestSuggestion>>", optional)]
    pub suggestions: Vec<GuestSuggestion>,
}

/// A guest's message waiting for the owner to send or dismiss it.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct GuestSuggestion {
    /// Its id, which the message's turn keeps once the owner sends it.
    pub id: TurnId,
    /// The message.
    pub text: String,
    /// When the guest sent it.
    pub at: Timestamp,
}

/// Params of `guest/list`.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct GuestListParams {}

/// Result of `guest/list`, `guest/revoke`, `guest/send`, and `guest/dismiss`: the live links.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct GuestListResult {
    /// The live links, oldest first.
    pub links: Vec<GuestLink>,
}

/// Params of `guest/revoke`: Stop sharing.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct GuestRevokeParams {
    /// The link's id.
    pub link: String,
}

/// Params of `guest/suggest`, from a guest whose link allows it.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct GuestSuggestParams {
    /// The link's thread.
    pub thread_id: RunId,
    /// The message.
    pub text: String,
}

/// Result of `guest/suggest`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct GuestSuggestResult {
    /// The waiting message.
    pub suggestion: GuestSuggestion,
}

/// Params of `guest/send` and `guest/dismiss`: the owner's answer to a waiting message.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct GuestSuggestionParams {
    /// The link's id.
    pub link: String,
    /// The message's id.
    pub suggestion: TurnId,
}
