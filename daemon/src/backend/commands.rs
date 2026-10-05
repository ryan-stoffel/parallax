//! A CLI's own slash commands and skills, for the composer's `/` menu (`agent/commands`,
//! PLX-359).
//!
//! [`Backend::commands`](super::Backend::commands) starts the CLI in a thread's folder with the
//! program and environment a thread on the user's own login gets, and [`list`] writes it a few
//! requests and reads its output until one line holds the list. Nothing reaches a model:
//!
//! - **Claude Code**: `claude -p` in stream-json, and an `initialize` control request, whose
//!   `control_response` lists every command headless Claude Code takes, skills and plugins'
//!   included. The user's `SessionStart` hooks run first. `clear` and the commands only
//!   Anthropic's server-launched sessions run are left out. MCP prompts, which a later `commands_changed` adds,
//!   aren't listed.
//! - **Codex**: `codex app-server`, `initialize`, `initialized`, and `skills/list` for the folder:
//!   the enabled skills, which a `$name` in a message loads. Codex's own slash commands belong
//!   to its TUI, which app-server doesn't take.
//! - **ACP agents** (Cursor Agent's `agent acp`, `OpenCode`, and the rest of 0040): `initialize`
//!   and `session/new`, after which the agent sends an `available_commands_update` with its
//!   commands and skills.

use std::time::Duration;

use parallax_protocol::AgentCommand;
use serde_json::Value;
use tokio::io::AsyncWriteExt;

use super::process::{Output, Process};

/// What one line of a CLI's output says: the answer, an error, or `None` for a line to skip.
pub type Parsed<T = Vec<AgentCommand>> = Option<Result<T, String>>;

/// A CLI started to answer one question, and how to ask it: [`Backend::commands`]'s command
/// list, or [`Backend::limits`]'s limit windows.
///
/// [`Backend::commands`]: super::Backend::commands
/// [`Backend::limits`]: super::Backend::limits
#[derive(Debug)]
pub struct Probe<T> {
    /// The CLI. Dropping it kills its process group.
    pub process: Process,
    /// The JSON messages to write it, a line each, all at once.
    pub input: Vec<Value>,
    /// Reads one line of its output.
    pub parse: fn(&Value) -> Parsed<T>,
}

/// The CLI [`Backend::commands`](super::Backend::commands) started.
pub type CommandsProbe = Probe<Vec<AgentCommand>>;

/// The JSON-RPC id of the request whose answer holds the list, for Codex and Cursor, and of
/// Codex's `account/rateLimits/read`.
pub const LIST_ID: u64 = 2;

/// Writes `probe`'s input and reads lines until one holds the answer, for at most `limit`. The
/// CLI is killed with its process group once this returns.
///
/// # Errors
///
/// What the CLI answered instead, or that it exited or ran out of time first.
pub async fn list<T>(mut probe: Probe<T>, limit: Duration) -> Result<T, String> {
    // Held open until the list comes, so the CLI doesn't take a closed stdin as the end.
    let mut stdin = probe.process.take_stdin();
    let input: String = probe.input.iter().map(|m| m.to_string() + "\n").collect();
    let read = async {
        if let Some(pipe) = &mut stdin {
            // A failed write means the CLI exited, which the output says.
            let _ = pipe.write_all(input.as_bytes()).await;
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

/// Claude Code's answer to `initialize`: every command [`shown`] keeps.
#[must_use]
pub fn claude(message: &Value) -> Parsed {
    if message["type"] != "control_response" {
        return None;
    }
    let response = &message["response"];
    if response["subtype"] == "error" {
        return Some(Err(text(&response["error"])));
    }
    let commands = response.pointer("/response/commands")?.as_array()?;
    Some(Ok(commands
        .iter()
        .filter(|c| c["name"].as_str().is_some_and(shown))
        .filter_map(|c| command("/", c))
        .collect()))
}

/// Whether a Claude Code command belongs in the menu: not `clear`, which would start a session
/// plxd doesn't track, and not one only Anthropic's own server-launched sessions run (`__` names,
/// `workflow-launch-exec`).
fn shown(name: &str) -> bool {
    name != "clear" && name != "workflow-launch-exec" && !name.starts_with("__")
}

/// One JSON-RPC request, for Codex's and Cursor's input.
#[must_use]
pub fn request(id: u64, method: &str, params: &Value) -> Value {
    serde_json::json!({"jsonrpc": "2.0", "id": id, "method": method, "params": params})
}

/// Codex's answer to `skills/list`: the enabled skills.
#[must_use]
pub fn codex(message: &Value) -> Parsed {
    if message["id"] != LIST_ID {
        return None;
    }
    if !message["error"].is_null() {
        return Some(Err(text(&message["error"]["message"])));
    }
    let skills = message.pointer("/result/data/0/skills")?.as_array()?;
    Some(Ok(skills
        .iter()
        .filter(|s| s["enabled"] == true)
        .filter_map(|s| command("$", s))
        .collect()))
}

/// An ACP agent's `available_commands_update`, or its refusal of `session/new`.
#[must_use]
pub fn acp(message: &Value) -> Parsed {
    if message["id"] == LIST_ID && !message["error"].is_null() {
        return Some(Err(text(&message["error"]["message"])));
    }
    let update = message.pointer("/params/update")?;
    if update["sessionUpdate"] != "available_commands_update" {
        return None;
    }
    let commands = update["availableCommands"].as_array()?;
    Some(Ok(commands
        .iter()
        .filter_map(|c| command("/", c))
        .collect()))
}

/// One entry with its `name`, `description`, and `argumentHint`, typed as `prefix` and its name.
fn command(prefix: &str, entry: &Value) -> Option<AgentCommand> {
    let name = entry["name"].as_str().filter(|name| !name.is_empty())?;
    Some(AgentCommand {
        text: format!("{prefix}{name}"),
        name: name.to_owned(),
        description: entry["description"].as_str().unwrap_or_default().to_owned(),
        argument_hint: entry["argumentHint"]
            .as_str()
            .filter(|hint| !hint.is_empty())
            .map(str::to_owned),
    })
}

fn text(value: &Value) -> String {
    value
        .as_str()
        .map_or_else(|| value.to_string(), str::to_owned)
}

#[cfg(test)]
mod tests {
    use parallax_protocol::AgentCommand;
    use serde_json::Value;

    use super::{Parsed, acp, claude, codex};

    /// The first answer `parse` finds in a recorded output.
    fn first(fixture: &str, parse: fn(&Value) -> Parsed) -> Result<Vec<AgentCommand>, String> {
        fixture
            .lines()
            .find_map(|line| parse(&serde_json::from_str(line).unwrap()))
            .expect("a line holds the list")
    }

    fn texts(commands: &[AgentCommand]) -> Vec<&str> {
        commands.iter().map(|c| c.text.as_str()).collect()
    }

    #[test]
    fn claude_lists_its_initialize_answer_without_clear_or_internal_commands() {
        let commands = first(include_str!("commands/fixtures/claude.jsonl"), claude).unwrap();
        // The fixture also has `clear`, `__remote-workflow`, and `workflow-launch-exec`.
        assert_eq!(
            texts(&commands),
            [
                "/ponytail:ponytail",
                "/ponytail:ponytail-help",
                "/compact",
                "/model"
            ]
        );
        assert_eq!(
            commands[0].argument_hint.as_deref(),
            Some("[lite|full|ultra]")
        );
        assert_eq!(commands[1].argument_hint, None, "an empty hint is none");
        assert!(
            commands[1]
                .description
                .starts_with("(ponytail) Quick-reference")
        );
    }

    #[test]
    fn codex_lists_enabled_skills_as_mentions() {
        let commands = first(include_str!("commands/fixtures/codex.jsonl"), codex).unwrap();
        // The fixture's `review-bugbot` is disabled.
        assert_eq!(
            texts(&commands),
            ["$ponytail:ponytail-help", "$create-rule"]
        );
        assert_eq!(commands[1].name, "create-rule");
    }

    #[test]
    fn cursor_lists_its_available_commands() {
        let commands = first(include_str!("commands/fixtures/cursor.jsonl"), acp).unwrap();
        assert_eq!(texts(&commands), ["/simplify", "/create-rule", "/review"]);
        assert_eq!(
            commands[0].description,
            "Find low-info comments, one-off helpers, perf issues, and reuse opportunities. (global)"
        );
    }

    /// A fake CLI that answers `initialize` only once it has read it, and then keeps running.
    #[cfg(unix)]
    #[tokio::test]
    async fn list_writes_the_input_and_reads_the_answer() {
        use std::time::Duration;

        use super::{CommandsProbe, list};
        use crate::backend::process::{Environment, Launcher, ProcessSpec, StdinMode};
        use crate::paths::DataDir;

        let data = tempfile::tempdir().unwrap();
        let base: Environment = [("PATH", "/usr/bin:/bin")].into_iter().collect();
        let launcher = Launcher::new(DataDir::new(data.path()).unwrap(), base);
        let fake = |script: &str| {
            let mut spec = ProcessSpec::new("sh", "/");
            spec.args = vec!["-c".into(), script.into()];
            spec.stdin = StdinMode::Piped;
            CommandsProbe {
                process: launcher.spawn(&spec).unwrap(),
                input: vec![serde_json::json!({"type": "control_request"})],
                parse: claude,
            }
        };
        let answers = r#"read line; echo noise; echo '{"type":"control_response","response":{"subtype":"success","response":{"commands":[{"name":"compact"}]}}}'; sleep 30"#;
        let listed = list(fake(answers), Duration::from_secs(5)).await.unwrap();
        assert_eq!(texts(&listed), ["/compact"]);

        let silent = list(fake("sleep 30"), Duration::from_millis(200)).await;
        assert_eq!(silent, Err("it didn't answer within 200ms".to_owned()));
    }

    #[test]
    fn a_refusal_is_an_error() {
        let refused = r#"{"jsonrpc":"2.0","id":2,"error":{"code":-32603,"message":"no session"}}"#;
        let refused: Value = serde_json::from_str(refused).unwrap();
        assert_eq!(acp(&refused), Some(Err("no session".to_owned())));
        assert_eq!(codex(&refused), Some(Err("no session".to_owned())));
    }
}
