//! Memory (decision 0044, PLX-405), behind the `memory` capability: the brief, entries, and
//! knowledge in a scope's context folder. `memory/list`, `memory/read`, `memory/write`, and
//! `memory/delete` are the app's, which writes as the user. A thread's Parallax tools also use
//! `memory/write` with `from`, which only a Project's coordinator may, and `memory/propose`.
//!
//! A path is relative to the scope's folder: `brief.md`, `memory/<kind>/<slug>.md`,
//! `knowledge/<slug>.md`, or a plain thread's proposal, `proposals/<slug>.md`. An entry's file
//! starts with its kind, title, source, date, and writer, one `Field: value` line each, then a
//! blank line and the body. plxd writes that header, and reports it from the file as it stands.

use jiff::Timestamp;
use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::{ProjectId, RepoId, RunId};

/// Whose memory: the user's own, a repository's, or a Project's (0044).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, TS)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum MemoryScope {
    /// Preferences across every Project and thread, in `context/you`.
    You,
    /// Facts about one codebase, shared by its Projects and threads. Fails with `repoNotFound`
    /// unless `id` is a repo entry with a repository.
    Repo {
        /// The repo entry.
        id: RepoId,
    },
    /// A Project's brief, decisions, and knowledge. Fails with `projectNotFound` for an unknown
    /// Project.
    Project {
        /// The Project.
        id: ProjectId,
    },
}

/// A scope's name, as a proposal's file names the scope it is for.
///
/// A newer plxd may send a value this version does not know; treat it as unknown.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub enum MemoryScopeKind {
    /// The user's own.
    You,
    /// The repository's of the folder's Project, or the folder's own repository.
    Repo,
    /// The Project's.
    Project,
    /// A value this version does not know yet.
    #[serde(other)]
    #[ts(skip)]
    Unknown,
}

/// What an entry records (0044).
///
/// A newer plxd may send a kind this version does not know; treat it as unknown.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub enum MemoryKind {
    /// How the user likes things done.
    Preference,
    /// How the codebase does things.
    Convention,
    /// A choice made, and why.
    Decision,
    /// A trap to avoid.
    Gotcha,
    /// A kind this version does not know yet.
    #[serde(other)]
    #[ts(skip)]
    Unknown,
}

/// One memory file, without its body. The header fields are read from an entry's file, and are
/// absent for one that lacks them, such as the brief or knowledge.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct MemoryFile {
    /// The file's path in the scope's folder.
    pub path: String,
    /// Its size in bytes.
    pub size: u64,
    /// When it was last modified, in RFC 3339 UTC.
    pub modified_at: Timestamp,
    /// An entry's or proposal's kind.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub kind: Option<MemoryKind>,
    /// Its title.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub title: Option<String>,
    /// The run or message it came from.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub source: Option<String>,
    /// The day it was written, as its file says, such as `2026-10-04`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub date: Option<String>,
    /// Who wrote it: `user`, or `coordinator <run id>`, or for a proposal `thread <run id>` or
    /// `coordinator <run id>`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub writer: Option<String>,
    /// For a proposal in a Project's folder, the scope it is for: a child's, which its
    /// coordinator curates, or a coordinator's, which the user saves there.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub for_scope: Option<MemoryScopeKind>,
    /// For a coordinator's proposal, the entry it rewrites, `memory/<kind>/<name>.md` at
    /// `for_scope`, which saving it replaces.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub replaces: Option<String>,
    /// An entry plxd marked for review because a path it names in backticks is missing from its
    /// branch: the integration branch for a Project entry, the base branch for a repo entry
    /// (0044, PLX-407). Rewriting the entry clears it.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    #[ts(as = "Option<bool>", optional)]
    pub stale: bool,
}

/// Params of `memory/list`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct MemoryListParams {
    /// The scope.
    pub scope: MemoryScope,
}

/// Result of `memory/list`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct MemoryListResult {
    /// The brief, entries, knowledge, and proposals, ordered by path.
    pub files: Vec<MemoryFile>,
}

/// Params of `memory/read`. Fails with `contextNotFound` if there is no such file.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct MemoryReadParams {
    /// The scope.
    pub scope: MemoryScope,
    /// The file's path.
    pub path: String,
}

/// Result of `memory/read`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct MemoryReadResult {
    /// The file, with its header's fields.
    pub file: MemoryFile,
    /// Its body: an entry's or proposal's text after its header, or the whole of any other file.
    pub content: String,
}

/// Params of `memory/write`: replaces `brief.md`, `knowledge/<slug>.md`, or an entry,
/// `memory/<kind>/<slug>.md`, in full. For an entry, plxd writes the header from `title`, which it
/// then needs, `source`, today's UTC date, and the writer. Fails with `contextTooLarge` over the
/// shared context caps. Only the user writes the brief: a coordinator proposes it.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct MemoryWriteParams {
    /// The scope.
    pub scope: MemoryScope,
    /// The file's path.
    pub path: String,
    /// The new content: an entry's body, or the whole file.
    pub content: String,
    /// An entry's title, one line.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub title: Option<String>,
    /// The run or message an entry came from. Absent: `user`, or the writing run.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub source: Option<String>,
    /// The run writing, for a thread's Parallax tools. It must be its Project's current
    /// coordinator, or the write fails with `invalidParams`, and the write adds a `learned` item to
    /// that Project's inbox. Absent: the user writes.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub from: Option<RunId>,
}

/// Result of `memory/write`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct MemoryWriteResult {
    /// The file as written.
    pub file: MemoryFile,
}

/// Params of `memory/delete`: deletes the brief, an entry, knowledge, or a proposal. Fails with
/// `contextNotFound` if there is no such file.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct MemoryDeleteParams {
    /// The scope.
    pub scope: MemoryScope,
    /// The file's path.
    pub path: String,
}

/// Result of `memory/delete`.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct MemoryDeleteResult {}

/// Params of `memory/propose`, for a thread's Parallax tools: run `from` proposes an entry, saved
/// as `proposals/<slug>.md`. A Project's child's is saved in the Project's folder, with a `Scope:`
/// line naming `scope`, and its coordinator's next wake-up carries it, then removes it; it
/// doesn't wake the coordinator. A coordinator's is saved the same way, for the user, and no
/// wake-up carries it. A plain thread's, only at its own repository's scope, is saved there for
/// the user. Any other run's fails with `invalidParams`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct MemoryProposeParams {
    /// The run proposing.
    pub from: RunId,
    /// The scope the entry belongs in.
    pub scope: MemoryScope,
    /// Its kind. Absent: a rewrite of the Project's brief, which only its coordinator proposes,
    /// at the Project's scope. Its proposal has no kind.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub kind: Option<MemoryKind>,
    /// Its title, one line.
    pub title: String,
    /// Its body.
    pub content: String,
    /// The entry it rewrites, `memory/<kind>/<name>.md` of the same kind at `scope`, which must
    /// exist. Only a coordinator names one; its proposal records it as `replaces`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub replaces: Option<String>,
}

/// Who a proposal went to.
///
/// A newer plxd may send a value this version does not know; treat it as unknown.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub enum MemoryProposalTo {
    /// The Project's coordinator, at its next wake-up.
    Coordinator,
    /// The user, in the Memory tab.
    User,
    /// A value this version does not know yet.
    #[serde(other)]
    #[ts(skip)]
    Unknown,
}

/// Result of `memory/propose`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct MemoryProposeResult {
    /// Who it went to.
    pub to: MemoryProposalTo,
    /// The proposal's file. Absent only from an older plxd.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub file: Option<MemoryFile>,
}
