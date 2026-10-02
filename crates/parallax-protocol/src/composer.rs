//! What the composer's `/` and `@` menus list (PLX-359), behind the `composerMenus` capability:
//! `agent/commands`, a CLI's own slash commands and skills, and `repo/files`, a thread's files.
//!
//! Each runs in a thread's folder: the run's, else the repo entry's checkout, else (for
//! `agent/commands` only) the host's home folder.

use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::{RepoId, RunId};

/// Params of `agent/commands`: lists what a thread on `backend` takes as a command, by asking the
/// CLI itself, started as a thread on the user's own login would be. Fails with an internal error
/// when the CLI can't start or doesn't answer in time.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct AgentCommandsParams {
    /// The backend, such as `claude`, `codex`, or `cursor`.
    pub backend: String,
    /// The repo entry whose checkout the CLI runs in, without `runId`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub repo: Option<RepoId>,
    /// The run whose folder the CLI runs in.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub run_id: Option<RunId>,
}

/// Result of `agent/commands`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct AgentCommandsResult {
    /// In the CLI's own order. Empty for a backend that lists none.
    pub commands: Vec<AgentCommand>,
}

/// One command or skill a CLI takes in a message.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct AgentCommand {
    /// What goes in the message to run it: `/name` for Claude Code and Cursor, `$name` for Codex.
    pub text: String,
    /// Its name, without the `/` or `$`.
    pub name: String,
    /// What it does, possibly empty.
    pub description: String,
    /// What its arguments look like, such as `[lite|full|ultra]`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub argument_hint: Option<String>,
}

/// Params of `repo/files`: a thread's tracked and untracked files that git doesn't ignore, from
/// the run's folder, else the repo entry's checkout. Fails with `worktreeFailed` when git fails
/// there, such as outside a repository.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct RepoFilesParams {
    /// The repo entry, without `runId`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub repo: Option<RepoId>,
    /// The run.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub run_id: Option<RunId>,
}

/// Result of `repo/files`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct RepoFilesResult {
    /// Paths relative to the folder, with `/` separators, in git's order, up to a cap.
    pub files: Vec<String>,
    /// Whether there were more than the cap.
    pub truncated: bool,
}
