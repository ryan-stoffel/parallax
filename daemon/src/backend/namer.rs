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

use super::commands::Parsed;
use super::process::{Output, Process};

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
        loop {
            match probe.process.next().await {
                Some(Output::Line(line)) => {
                    let parsed = serde_json::from_slice(&line).ok();
                    if let Some(answer) = parsed.as_ref().and_then(probe.parse) {
                        return answer;
                    }
                }
                Some(Output::Oversized { .. }) => {}
                Some(Output::Exited(exit)) => {
                    return Err(format!("it exited before answering: {}", exit.stderr_tail));
                }
                None => return Err("it exited before answering".to_owned()),
            }
        }
    };
    tokio::time::timeout(limit, read)
        .await
        .unwrap_or_else(|_| Err(format!("it didn't answer within {limit:?}")))
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

fn text(value: &Value) -> String {
    value
        .as_str()
        .map_or_else(|| value.to_string(), str::to_owned)
}

#[cfg(test)]
mod tests {
    use serde_json::Value;

    use super::{Name, Parsed, claude, codex};

    /// The first answer `parse` finds in a CLI's output, a JSON message a line.
    fn first(output: &str, parse: fn(&Value) -> Parsed<Name>) -> Result<Name, String> {
        output
            .lines()
            .find_map(|line| parse(&serde_json::from_str(line).unwrap()))
            .expect("a line holds the answer")
    }

    fn name(title: &str, branch: &str) -> Name {
        Name {
            title: title.to_owned(),
            branch: branch.to_owned(),
        }
    }

    // Trimmed from Claude Code 2.1.288's output on 2026-10-08.
    #[test]
    fn claude_answers_in_its_result_or_says_why_not() {
        let answered = r#"{"type":"result","subtype":"success","is_error":false,"result":"{\"title\":\"Empty password login crash\",\"branch\":\"login-empty-password-crash\"}","structured_output":{"title":"Empty password login crash","branch":"login-empty-password-crash"},"session_id":"e4cef995-2d42-4ff8-b30c-8aa72f7ea92b"}"#;
        assert_eq!(
            first(answered, claude),
            Ok(name(
                "Empty password login crash",
                "login-empty-password-crash"
            ))
        );
        let signed_out = r#"{"type":"result","subtype":"success","is_error":true,"result":"Not logged in · Please run /login","terminal_reason":"api_error"}"#;
        assert_eq!(
            first(signed_out, claude),
            Err("Not logged in · Please run /login".to_owned())
        );
    }

    // Trimmed from codex-cli 0.160.0's output on 2026-10-08.
    #[test]
    fn codex_answers_in_its_agent_message_or_says_why_not() {
        let answered = r#"{"type":"thread.started","thread_id":"01a11bfe-a945-7421-bef6-b8ae9b302447"}
{"type":"turn.started"}
{"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"{\"title\":\"Fix Login Crash with Empty Password\",\"branch\":\"empty-password-login-crash\"}"}}
{"type":"turn.completed","usage":{"input_tokens":20694,"output_tokens":30}}"#;
        assert_eq!(
            first(answered, codex),
            Ok(name(
                "Fix Login Crash with Empty Password",
                "empty-password-login-crash"
            ))
        );
        // A warning comes as an `error` item, before the turn that fails.
        let failed = r#"{"type":"thread.started","thread_id":"01a11c08-de05-7203-ad76-38062ff46942"}
{"type":"item.completed","item":{"id":"item_0","type":"error","message":"Model metadata for `no-such-model` not found."}}
{"type":"turn.started"}
{"type":"error","message":"The 'no-such-model' model is not supported when using Codex with a ChatGPT account."}
{"type":"turn.failed","error":{"message":"The 'no-such-model' model is not supported when using Codex with a ChatGPT account."}}"#;
        assert_eq!(
            first(failed, codex),
            Err(
                "The 'no-such-model' model is not supported when using Codex with a ChatGPT account."
                    .to_owned()
            )
        );
    }
}
