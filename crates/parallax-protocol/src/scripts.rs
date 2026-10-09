//! Setup and settle scripts (PLX-650), as T3 Code's project scripts: a repository's setup script
//! runs in a new worktree before or alongside the agent's first turn, and its settle script runs
//! in a thread's worktree when the thread settles. Behind the `setupScripts` capability.

use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::RepoId;

/// One script, in T3 Code's `ProjectScript` shape. A repository's first `runOnWorktreeCreate`
/// script is its setup script and its first `runOnSettle` one its settle script, as in T3.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct RepoScript {
    /// plxd's id for it, from its name, which its terminal is named after. Ignored in
    /// `repo/saveScripts`.
    #[serde(default)]
    pub id: String,
    /// Its name.
    pub name: String,
    /// The shell command, run in the user's shell in the worktree.
    pub command: String,
    /// Runs in each new thread's worktree once it's created.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub run_on_worktree_create: bool,
    /// Runs in the thread's worktree each time the thread settles.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub run_on_settle: bool,
    /// For a setup script: `false` holds the agent's first turn until it exits, and fails the
    /// run if it exits with an error. Absent or `true` starts the agent alongside it.
    #[serde(default, rename = "async", skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub run_async: Option<bool>,
}

/// Params of `repo/scripts`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct RepoScriptsParams {
    /// The repo entry.
    pub repo: RepoId,
}

/// Result of `repo/scripts` and `repo/saveScripts`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct RepoScriptsResult {
    /// The scripts plxd runs for the repository.
    pub scripts: Vec<RepoScript>,
    /// The scripts the repository's `parallax.json` declares, which plxd runs only once the user
    /// imports them, as T3 Code does with `t3.json`'s.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub file_scripts: Vec<RepoScript>,
    /// Why `parallax.json` was ignored, when it exists but isn't valid.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub file_error: Option<String>,
}

/// Params of `repo/saveScripts`: replaces the repository's scripts. Fails with `invalidParams`
/// for an empty name or command, or more than 50 scripts.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct RepoSaveScriptsParams {
    /// The repo entry.
    pub repo: RepoId,
    /// Its scripts, in order.
    pub scripts: Vec<RepoScript>,
}

/// When a script ran.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub enum ScriptTrigger {
    /// Its thread's worktree was created.
    Setup,
    /// Its thread settled.
    Settle,
}

/// Where a script is.
///
/// A newer plxd may send a status this version does not know; treat it as unknown.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub enum ScriptStatus {
    /// It runs.
    Running,
    /// It exited cleanly, and its terminal closed.
    Done,
    /// It exited with an error, or couldn't start. Its terminal stays open.
    Failed,
    /// A status this version does not know yet.
    #[serde(other)]
    #[ts(skip)]
    Unknown,
}
