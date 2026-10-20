//! Importing past sessions from the Claude, Codex, and Cursor desktop apps (PLX-881), behind the
//! `threadImport` capability.
//!
//! `thread/importable` lists the sessions each app keeps on the host. `thread/import` makes one an
//! archived thread: its conversation, the user's messages and the agent's replies, logged as the
//! thread's own, at rest with no CLI running, as a fork is (0050). Its first follow-up continues
//! the app's own session when the thread's CLI can, and otherwise tells a new session the
//! conversation.

use jiff::Timestamp;
use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::{AccountChoice, RunId};

/// The desktop app a session comes from.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub enum ImportSource {
    /// The Claude desktop app's Claude Code sessions.
    Claude,
    /// The Codex desktop app.
    Codex,
    /// Cursor's agent chats.
    Cursor,
}

/// A session `thread/import` can import.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct ImportableSession {
    /// The app it comes from.
    pub source: ImportSource,
    /// The app's id for it.
    pub id: String,
    /// Its title in the app, or else its first message, cut short.
    pub title: String,
    /// The folder it worked in, when the app records one.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub cwd: Option<String>,
    /// When it was last active.
    pub updated_at: Timestamp,
    /// The thread it was imported as. Absent until it is.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub thread: Option<RunId>,
}

/// Params of `thread/importable`.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct ThreadImportableParams {}

/// Result of `thread/importable`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct ThreadImportableResult {
    /// Every app's sessions on the host, the most recently active first. An app that isn't
    /// installed, or whose files can't be read, adds none.
    pub sessions: Vec<ImportableSession>,
}

/// Params of `thread/import`: makes a session an archived thread, in its folder's own checkout
/// when that folder is a repository, else with no repo. Idempotent: a session already imported returns its
/// thread. Fails with `invalidParams` for a session the app no longer has, or one with no
/// messages. Answers with `thread/start`'s result.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct ThreadImportParams {
    /// The app it comes from.
    pub source: ImportSource,
    /// The app's id for it, as `thread/importable` listed it.
    pub id: String,
    /// The account the thread's follow-ups run on. Absent means the built-in agent of the
    /// session's app: `claude`, `codex`, or `cursor`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub account: Option<AccountChoice>,
}
