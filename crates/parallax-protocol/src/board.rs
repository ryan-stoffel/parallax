//! A Project's status board as items (PLX-940, decision 0081), behind the `board` capability.
//!
//! plxd stores each item and renders the Project's `notes.md` and `archived.md` from them after
//! every change, so a change appends `context.changed` for the files it rewrote. Done items older
//! than seven days go to `archived.md`. `context/write` refuses both files.

use jiff::Timestamp;
use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::{ProjectId, RunId};

/// Whether a board item is still to do.
///
/// A newer plxd may send a status this version does not know; treat it as open.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub enum BoardStatus {
    /// Still to do.
    Open,
    /// Done.
    Done,
    /// A status this version does not know yet.
    #[serde(other)]
    #[ts(skip)]
    Unknown,
}

/// The board section an item is in, in the order the board shows them.
///
/// A newer plxd may send a section this version does not know; treat it as `risks`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub enum BoardSection {
    /// Work under way.
    Now,
    /// What's planned.
    Next,
    /// Blockers and open questions.
    Risks,
    /// A section this version does not know yet.
    #[serde(other)]
    #[ts(skip)]
    Unknown,
}

/// What a board item links to.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct BoardLinks {
    /// Threads doing or tracking the work, by run id.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub threads: Vec<RunId>,
    /// The item's pull request, an `https://` URL.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub pull_request: Option<String>,
    /// Files it concerns: repository paths or shared context files.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub files: Vec<String>,
}

/// One item on a Project's status board.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct BoardItem {
    /// The item's id, unique on the host. plxd assigns it.
    pub id: u64,
    /// One line of Markdown, such as `**Search command**: one subagent adds it`.
    pub text: String,
    /// Whether it is still to do.
    pub status: BoardStatus,
    /// Its section.
    pub section: BoardSection,
    /// What it links to.
    pub links: BoardLinks,
    /// When it was added, in RFC 3339 UTC.
    pub created_at: Timestamp,
    /// When it last changed, in RFC 3339 UTC.
    pub updated_at: Timestamp,
    /// When it was marked done, while it is. Seven days later it moves to `archived.md`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub done_at: Option<Timestamp>,
}

/// Params of `board/list`. Fails with `projectNotFound` for an unknown Project.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct BoardListParams {
    /// The Project.
    pub project: ProjectId,
}

/// Result of `board/list`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct BoardListResult {
    /// Every item, archived ones included, oldest first.
    pub items: Vec<BoardItem>,
}

/// Params of `board/add`: adds an item. Not idempotent: a retry adds a second item. Fails with
/// `projectNotFound` for an unknown Project, and `invalidParams` for empty or multi-line text
/// over 2 KiB, or links that aren't valid.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct BoardAddParams {
    /// The Project.
    pub project: ProjectId,
    /// One line of Markdown.
    pub text: String,
    /// Its section.
    pub section: BoardSection,
    /// Its status. Absent means `open`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub status: Option<BoardStatus>,
    /// What it links to.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub links: Option<BoardLinks>,
}

/// Params of `board/update`: changes what it names of one item, replacing `links` whole. Fails
/// with `invalidParams` for an item the Project doesn't have, or a value `board/add` refuses.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct BoardUpdateParams {
    /// The Project.
    pub project: ProjectId,
    /// The item.
    pub id: u64,
    /// Its new text.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub text: Option<String>,
    /// Its new section.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub section: Option<BoardSection>,
    /// Its new status.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub status: Option<BoardStatus>,
    /// Its new links, replacing the old ones.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub links: Option<BoardLinks>,
}

/// Result of `board/add` and `board/update`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct BoardItemResult {
    /// The item as it stands.
    pub item: BoardItem,
}

/// Params of `board/remove`: removes one item. Removing one the Project doesn't have succeeds
/// with `removed` false.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct BoardRemoveParams {
    /// The Project.
    pub project: ProjectId,
    /// The item.
    pub id: u64,
}

/// Result of `board/remove`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct BoardRemoveResult {
    /// Whether the item existed.
    pub removed: bool,
}
