use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use ts_rs::TS;

/// Params of `terminal/open`. A terminal is named by its thread and its own id; `threadId` is
/// empty for one that belongs to no thread, such as a repository checkout's.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct TerminalOpenParams {
    /// The thread it belongs to, whose archive or delete closes it.
    pub thread_id: String,
    /// The client's name for it, unique within the thread.
    pub terminal_id: String,
    /// The absolute folder a new terminal starts in. Absent, or `~`, is the home folder.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub cwd: Option<String>,
    /// What a new terminal runs instead of the login shell. It ends when the connection that
    /// opened it closes, where a shell outlives it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub command: Option<TerminalCommand>,
    /// Its size in character cells.
    pub cols: u16,
    /// Its height in character cells.
    pub rows: u16,
}

/// A program a terminal runs, found on `PATH` unless it's a path.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct TerminalCommand {
    /// The program.
    pub program: String,
    /// Its arguments.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub args: Vec<String>,
    /// Variables it gets besides plxd's own.
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub env: BTreeMap<String, String>,
}

/// Result of `terminal/open` and `terminal/close`.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct TerminalResult {}

/// A terminal's name: its thread and its own id.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct TerminalKey {
    /// Its thread, or empty.
    pub thread_id: String,
    /// Its id within the thread.
    pub terminal_id: String,
}

/// Params of `terminal/list`.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct TerminalListParams {
    /// Only this thread's terminals. Absent lists every one.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub thread_id: Option<String>,
}

/// Result of `terminal/list`: the terminals that are running.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct TerminalListResult {
    /// Each running terminal.
    pub terminals: Vec<TerminalKey>,
}

/// Params of `terminal/write`: what's typed into a terminal.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct TerminalWriteParams {
    /// Its thread, or empty.
    pub thread_id: String,
    /// Its id within the thread.
    pub terminal_id: String,
    /// The input.
    pub data: String,
}

/// Params of `terminal/resize`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct TerminalResizeParams {
    /// Its thread, or empty.
    pub thread_id: String,
    /// Its id within the thread.
    pub terminal_id: String,
    /// Its width in character cells.
    pub cols: u16,
    /// Its height in character cells.
    pub rows: u16,
}

/// Params of `terminal/output`: what a terminal printed.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct TerminalOutputParams {
    /// Its thread, or empty.
    pub thread_id: String,
    /// Its id within the thread.
    pub terminal_id: String,
    /// The output.
    pub data: String,
    /// The start of its kept output, which replaces whatever the client shows.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub replay: bool,
}

/// Params of `terminal/exit`: what a terminal ran exited, and the terminal closed.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct TerminalExitParams {
    /// Its thread, or empty.
    pub thread_id: String,
    /// Its id within the thread.
    pub terminal_id: String,
    /// The program's exit code, or -1 if it has none.
    pub exit_code: i32,
}
