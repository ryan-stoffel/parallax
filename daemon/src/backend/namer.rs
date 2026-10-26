//! A thread's name from the user's own model (0058): [`Backend::namer`](super::Backend::namer)
//! starts the CLI with no tools in an empty folder, [`ask`] writes it the prompt on stdin and
//! reads its output until one line holds the answer, a JSON object in [`schema`]'s shape:
//!
//! - **Claude Code**: `claude -p --output-format json --json-schema <schema>`, whose one line is
//!   the `result` message, with the answer as its `structured_output`.
//! - **Codex**: `codex exec --json --output-schema <file>`, whose events are a line each; the
//!   answer is the text of the `agent_message` item.

use std::time::Duration;

use serde::Deserialize;
use serde_json::{Value, json};
use tokio::io::AsyncWriteExt;

use super::commands::{Parsed, read_answer, text, within};
use super::process::Process;

/// The file in the CLI's folder that holds [`schema`], for a CLI that reads it from a file.
pub const SCHEMA_FILE: &str = "schema.json";

/// What the model answers.
#[derive(Clone, Debug, PartialEq, Eq, Deserialize)]
pub struct Name {
    /// The thread's title.
    pub title: String,
    /// Its branch's name, which the caller makes a branch slug.
    pub branch: String,
}

/// A CLI started to name a thread.
#[derive(Debug)]
pub struct NameProbe {
    /// The CLI. Dropping it kills its process group.
    pub process: Process,
    /// Reads one line of its output.
    pub parse: fn(&Value) -> Parsed<Name>,
}

/// The JSON schema of [`Name`], which both CLIs hold the answer to.
#[must_use]
pub fn schema() -> Value {
    json!({
        "type": "object",
        "properties": {"title": {"type": "string"}, "branch": {"type": "string"}},
        "required": ["title", "branch"],
        "additionalProperties": false,
    })
}

/// Writes `prompt` to `probe`'s stdin, closes it, and reads lines until one holds the answer, for
/// at most `limit`. The CLI is killed with its process group once this returns.
///
/// # Errors
///
/// What the CLI answered instead, or that it exited or ran out of time first.
pub async fn ask(mut probe: NameProbe, prompt: &str, limit: Duration) -> Result<Name, String> {
    let stdin = probe.process.take_stdin();
    let read = async {
        if let Some(mut pipe) = stdin {
            // A failed write means the CLI exited, which the output says. Dropping the pipe
            // closes stdin, which ends the prompt.
            let _ = pipe.write_all(prompt.as_bytes()).await;
        }
        read_answer(&mut probe.process, probe.parse).await
    };
    within(limit, read).await
}

/// Claude Code's `result` message: its `structured_output`, or its `result` text when it failed.
#[must_use]
pub fn claude(message: &Value) -> Parsed<Name> {
    if message["type"] != "result" {
        return None;
    }
    if message["is_error"] == true {
        return Some(Err(text(&message["result"])));
    }
    Some(serde_json::from_value(message["structured_output"].clone()).map_err(|e| e.to_string()))
}

/// Codex's `agent_message` item, whose text is the answer, or its failed turn.
#[must_use]
pub fn codex(message: &Value) -> Parsed<Name> {
    match message["type"].as_str()? {
        "item.completed" if message["item"]["type"] == "agent_message" => {
            let answer = message["item"]["text"].as_str().unwrap_or_default();
            Some(serde_json::from_str(answer).map_err(|e| e.to_string()))
        }
        "turn.failed" => Some(Err(text(&message["error"]["message"]))),
        _ => None,
    }
}
