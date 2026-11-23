//! Guest links (0108): one thread shown to one browser for 24 hours, behind the `guestLinks`
//! capability. The owner makes, lists, and ends them with `guest/create`, `guest/list`, and
//! `guest/revoke`, from a full-access session. A guest suggests a message with `guest/suggest`
//! while its link allows it, and the owner sends or dismisses it with `guest/send` and
//! `guest/dismiss`.

use jiff::Timestamp;
use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::{AgentStatus, AgentToolStatus, RunId, SubscriptionId, TurnId};

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

/// Params of `guest/subscribe`: the guest's thread, from its snapshot, or from after `afterSeq`
/// when that gap is short enough to replay.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct GuestSubscribeParams {
    /// The link's thread.
    pub thread_id: RunId,
    /// The last `seq` the guest has.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub after_seq: Option<u64>,
}

/// Result of `guest/subscribe`. `guest/event` notifications follow for the subscription.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct GuestSubscribeResult {
    /// The subscription, for `events/unsubscribe`.
    pub subscription: SubscriptionId,
    /// The thread as it stands. Absent when the gap after `afterSeq` replays instead.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub snapshot: Option<GuestSnapshot>,
}

/// A guest's thread at a `seq`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct GuestSnapshot {
    /// The event log's `seq` it stands at. Events after it follow.
    pub seq: u64,
    /// The thread.
    pub thread: GuestThread,
    /// Its newest transcript entries, oldest first, up to `seq`.
    pub entries: Vec<GuestEntry>,
    /// Whether older entries remain, for `guest/history` before the first one.
    pub more: bool,
}

/// The thread a guest link shows: only what its header needs.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct GuestThread {
    /// Its run id.
    pub id: RunId,
    /// Its title, if it has one.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub title: Option<String>,
    /// Whether it's working, waiting, or done.
    pub status: AgentStatus,
    /// When it was made.
    pub created_at: Timestamp,
}

/// Params of `guest/history`: the page of entries before `before`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct GuestHistoryParams {
    /// The link's thread.
    pub thread_id: RunId,
    /// The page is the entries before this `seq`: the first one the guest has.
    pub before: u64,
}

/// Result of `guest/history`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct GuestHistoryResult {
    /// The entries, oldest first.
    pub entries: Vec<GuestEntry>,
    /// Whether older ones remain.
    pub more: bool,
}

/// What one event of the thread's log shows a guest: built for the guest from the event, with
/// only what a transcript needs.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct GuestEntry {
    /// The event's `seq`.
    pub seq: u64,
    /// When it happened.
    pub time: Timestamp,
    /// What it shows, in order. Never empty.
    pub items: Vec<GuestItem>,
}

/// One thing in a guest's transcript, by `kind`.
///
/// A newer plxd may send kinds that are not listed here; skip them.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum GuestItem {
    /// A turn started with the user's message.
    TurnStarted {
        /// The turn's id.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        turn_id: Option<TurnId>,
        /// The message.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        text: Option<String>,
    },
    /// Part of the agent's reply as it streams.
    TextDelta {
        /// The reply it belongs to.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        message_id: Option<String>,
        /// The new text.
        text: String,
    },
    /// The agent's reply.
    Text {
        /// The reply's id.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        message_id: Option<String>,
        /// Its text.
        text: String,
    },
    /// The agent called a tool.
    ToolCall {
        /// The call's id, which its result names.
        call_id: String,
        /// The tool.
        name: String,
        /// Its input, as the thread has it.
        input: serde_json::Value,
    },
    /// A tool call's result.
    ToolResult {
        /// The call it answers.
        call_id: String,
        /// How it ended.
        status: AgentToolStatus,
        /// What it printed.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        output: Option<String>,
    },
    /// A turn ended.
    TurnFinished {
        /// The turn's id.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        turn_id: Option<TurnId>,
        /// The agent's final answer, when its CLI gives one.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        result: Option<String>,
    },
    /// The thread's status changed.
    Status {
        /// The new status.
        status: AgentStatus,
    },
    /// The owner rewound the thread: these turns are gone from it.
    Reverted {
        /// The turns.
        turns: Vec<TurnId>,
    },
    /// A kind this version does not know yet.
    #[serde(other)]
    #[ts(skip)]
    Unknown,
}

/// Params of `guest/event`: one entry of a guest's subscription.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct GuestEventParams {
    /// The subscription.
    pub subscription: SubscriptionId,
    /// The entry.
    pub entry: GuestEntry,
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
