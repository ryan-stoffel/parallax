//! Turning `codex exec --json` output into [`Event`]s, one line at a time.
//!
//! The shapes are `ThreadEvent` in `codex-rs/exec/src/exec_events.rs` at `rust-v0.157.1`, checked
//! against real runs (0013). Fields wisp doesn't use are ignored, as 0004 asks, so a newer CLI
//! that adds fields still parses.

use std::collections::HashSet;

use serde_json::{Map, Value};

use crate::backend::event::{
    Event, Failure, FailureKind, TodoItem, TodoStatus, ToolStatus, Usage, WarningKind,
};

/// Item types a worker never has: MCP tools (including `ChatGPT` apps) and subagents (0013).
const FORBIDDEN_ITEMS: &[&str] = &["mcp_tool_call", "collab_tool_call"];

/// The longest failure message kept from the CLI's output.
const MAX_MESSAGE_CHARS: usize = 2000;

/// What one line of output asks the driver to do.
#[derive(Debug, PartialEq)]
pub(super) enum Step {
    /// Send an event.
    Emit(Event),
    /// The thread's running usage total, which becomes a usage delta.
    Total(Usage),
    /// The turn ended, with its final text when it succeeded.
    TurnDone(Option<String>),
    /// The run broke the worker's tool policy. The driver stops the CLI at once.
    Violation(Failure),
}

/// The state that reading one run's output needs.
#[derive(Debug)]
pub(super) struct Translator {
    /// Prefixes item ids, which restart at `item_0` in every process, so a resumed session's
    /// tool calls don't share ids with the ones before it.
    id_prefix: String,
    /// Items whose `item.started` was already reported as a tool call.
    started: HashSet<String>,
    last_message: Option<String>,
    /// A `turn.completed` arrived.
    pub completed: bool,
    /// The last turn's failure, from `turn.failed`.
    pub failure: Option<Failure>,
    /// The last successful turn's final text.
    pub last_result: Option<String>,
}

impl Translator {
    /// A translator whose tool call ids start with `id_prefix`.
    pub fn new(id_prefix: String) -> Self {
        Self {
            id_prefix,
            started: HashSet::new(),
            last_message: None,
            completed: false,
            failure: None,
            last_result: None,
        }
    }

    /// Reads one line of stdout.
    pub fn line(&mut self, line: &[u8]) -> Vec<Step> {
        if line.iter().all(u8::is_ascii_whitespace) {
            return Vec::new();
        }
        let message = match serde_json::from_slice::<Value>(line) {
            Ok(Value::Object(message)) => message,
            Ok(_) => return vec![warning("a line that is not a JSON object".into())],
            Err(error) => return vec![warning(error.to_string())],
        };
        match text(&message, "type") {
            Some("thread.started") => match text(&message, "thread_id") {
                Some(id) => vec![Step::Emit(Event::SessionStarted {
                    session_id: id.to_owned(),
                    model: None,
                    api_key_source: None,
                })],
                None => vec![warning("a thread.started without a thread_id".into())],
            },
            Some(phase @ ("item.started" | "item.updated" | "item.completed")) => {
                match message.get("item").and_then(Value::as_object) {
                    Some(item) => self.item(phase, item),
                    None => vec![warning(format!("an {phase} without an item"))],
                }
            }
            Some("turn.completed") => {
                self.completed = true;
                self.failure = None;
                self.last_result = self.last_message.take();
                let mut steps = Vec::new();
                if let Some(usage) = message.get("usage") {
                    steps.push(Step::Total(usage_total(usage)));
                }
                steps.push(Step::TurnDone(self.last_result.clone()));
                steps
            }
            Some("turn.failed") => {
                let detail = message
                    .get("error")
                    .and_then(|error| error.get("message"))
                    .and_then(Value::as_str)
                    .unwrap_or("Codex ended the turn with an error");
                self.failure = Some(failure(classify(detail), truncate(detail)));
                self.last_result = None;
                self.last_message = None;
                vec![Step::TurnDone(None)]
            }
            // Retries and other errors the turn may survive; `turn.failed` says if it didn't.
            Some("error") => match text(&message, "message") {
                Some(detail) => vec![Step::Emit(Event::Notice {
                    detail: detail.to_owned(),
                })],
                None => Vec::new(),
            },
            Some("turn.started") => Vec::new(),
            Some(kind) => {
                tracing::debug!(kind, "skipped a Codex event of an unknown type");
                Vec::new()
            }
            None => vec![warning("an event without a type".into())],
        }
    }

    fn item(&mut self, phase: &str, item: &Map<String, Value>) -> Vec<Step> {
        let (Some(id), Some(kind)) = (text(item, "id"), text(item, "type")) else {
            return vec![warning("an item without an id or a type".into())];
        };
        if FORBIDDEN_ITEMS.contains(&kind) {
            let what = match (text(item, "server"), text(item, "tool")) {
                (Some(server), Some(tool)) => format!("the MCP tool {server}/{tool}"),
                _ => format!("a {kind}"),
            };
            return vec![Step::Violation(failure(
                FailureKind::PolicyViolation,
                format!("Codex called {what}, which a worker may not have (decision 0013)"),
            ))];
        }
        let done = phase == "item.completed";
        let call_id = format!("{}-{id}", self.id_prefix);
        match kind {
            "agent_message" if done => {
                let Some(message) = text(item, "text").filter(|text| !text.is_empty()) else {
                    return Vec::new();
                };
                self.last_message = Some(message.to_owned());
                vec![Step::Emit(Event::Text {
                    message_id: None,
                    text: message.to_owned(),
                })]
            }
            "reasoning" if done => text(item, "text")
                .filter(|text| !text.is_empty())
                .map(|text| {
                    Step::Emit(Event::Reasoning {
                        message_id: None,
                        text: text.to_owned(),
                    })
                })
                .into_iter()
                .collect(),
            "command_execution" | "file_change" | "web_search" => {
                let mut steps = Vec::new();
                if self.started.insert(call_id.clone()) {
                    steps.push(Step::Emit(Event::ToolCall {
                        call_id: call_id.clone(),
                        name: kind.to_owned(),
                        input: tool_input(kind, item),
                    }));
                }
                if done {
                    self.started.remove(&call_id);
                    steps.push(Step::Emit(Event::ToolResult {
                        call_id,
                        status: tool_status(item),
                        output: text(item, "aggregated_output")
                            .filter(|output| !output.is_empty())
                            .map(str::to_owned),
                    }));
                }
                steps
            }
            "todo_list" => vec![Step::Emit(Event::TodoList {
                items: todo_items(item),
            })],
            "error" if done => text(item, "message")
                .map(|detail| {
                    Step::Emit(Event::Notice {
                        detail: detail.to_owned(),
                    })
                })
                .into_iter()
                .collect(),
            _ => Vec::new(),
        }
    }
}

fn text<'a>(object: &'a Map<String, Value>, key: &str) -> Option<&'a str> {
    object.get(key).and_then(Value::as_str)
}

fn warning(detail: String) -> Step {
    Step::Emit(Event::Warning {
        warning: WarningKind::MalformedLine,
        detail,
    })
}

fn failure(failure: FailureKind, message: String) -> Failure {
    Failure {
        failure,
        message,
        exit: None,
        stderr_tail: None,
    }
}

/// What a tool call item's input was: the command, the changed files, or the search.
fn tool_input(kind: &str, item: &Map<String, Value>) -> Value {
    let keys: &[&str] = match kind {
        "command_execution" => &["command"],
        "file_change" => &["changes"],
        _ => &["query", "action"],
    };
    keys.iter()
        .filter_map(|key| Some(((*key).to_owned(), item.get(*key)?.clone())))
        .collect::<Map<_, _>>()
        .into()
}

/// How a finished tool call item ended. A command that ran and exited non-zero failed too.
fn tool_status(item: &Map<String, Value>) -> ToolStatus {
    match text(item, "status") {
        Some("completed") if item.get("exit_code").and_then(Value::as_i64).unwrap_or(0) == 0 => {
            ToolStatus::Ok
        }
        Some("completed" | "failed") => ToolStatus::Error,
        Some("declined") => ToolStatus::Denied,
        // A finished web search has no status.
        None => ToolStatus::Ok,
        Some(_) => ToolStatus::Other,
    }
}

/// A `todo_list` item's steps. Codex only says whether each is done.
fn todo_items(item: &Map<String, Value>) -> Vec<TodoItem> {
    item.get("items")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|todo| {
            Some(TodoItem {
                text: todo.get("text")?.as_str()?.to_owned(),
                status: if todo.get("completed").and_then(Value::as_bool) == Some(true) {
                    TodoStatus::Completed
                } else {
                    TodoStatus::Pending
                },
            })
        })
        .collect()
}

/// `turn.completed.usage`: the thread's running totals. `OpenAI` counts cached input inside
/// `input_tokens` and reasoning inside `output_tokens`; wisp's input excludes cache reads.
fn usage_total(usage: &Value) -> Usage {
    let count = |key| usage.get(key).and_then(Value::as_u64).unwrap_or(0);
    let cached = count("cached_input_tokens");
    Usage {
        input_tokens: count("input_tokens").saturating_sub(cached),
        output_tokens: count("output_tokens"),
        cache_read_tokens: cached,
        cache_write_tokens: count("cache_write_input_tokens"),
        cost_usd_micros: None,
    }
}

/// The failure a `turn.failed` message points to. Exec reports only the message, so routing's
/// fallback (0012) depends on these phrases: an HTTP 401, or a login that has to be made again,
/// is [`FailureKind::NotSignedIn`]; a usage limit, quota, or rate limit, or a plain HTTP 429
/// that outlasted Codex's retries ("exceeded retry limit, last status: 429 Too Many Requests"),
/// is [`FailureKind::RateLimited`]. A plan that doesn't include Codex ("upgrade to Plus") stays a
/// [`FailureKind::VendorError`], so it isn't quietly billed to a paid key instead (0013).
pub(super) fn classify(message: &str) -> FailureKind {
    let lower = message.to_lowercase();
    let any = |phrases: &[&str]| phrases.iter().any(|phrase| lower.contains(phrase));
    if any(&[
        "401 unauthorized",
        "not logged in",
        "sign in again",
        "signing in again",
    ]) {
        FailureKind::NotSignedIn
    } else if any(&[
        "usage limit",
        "rate limit",
        "too many requests",
        "quota exceeded",
        "out of credits",
        "spend cap",
    ]) {
        FailureKind::RateLimited
    } else {
        FailureKind::VendorError
    }
}

fn truncate(text: &str) -> String {
    match text.char_indices().nth(MAX_MESSAGE_CHARS) {
        Some((end, _)) => format!("{}...", &text[..end]),
        None => text.to_owned(),
    }
}

#[cfg(test)]
mod tests {
    use super::{Step, Translator, classify};
    use crate::backend::TurnId;
    use crate::backend::event::{
        Event, FailureKind, TodoItem, TodoStatus, ToolStatus, WarningKind,
    };

    fn translate(lines: &[&str]) -> Vec<Step> {
        let mut translator = Translator::new("t".into());
        lines
            .iter()
            .flat_map(|line| translator.line(line.as_bytes()))
            .collect()
    }

    #[test]
    fn turn_failures_say_when_routing_should_fall_back() {
        for (message, kind) in [
            (
                "unexpected status 401 Unauthorized: Missing bearer or basic authentication in header",
                FailureKind::NotSignedIn,
            ),
            (
                "Your access token could not be refreshed because your refresh token has expired. \
                 Please log out and sign in again.",
                FailureKind::NotSignedIn,
            ),
            (
                "You’ve hit your usage limit. Try again later.",
                FailureKind::RateLimited,
            ),
            (
                "Quota exceeded. Check your plan and billing details.",
                FailureKind::RateLimited,
            ),
            ("rate limit exceeded: slow down", FailureKind::RateLimited),
            (
                "exceeded retry limit, last status: 429 Too Many Requests, request id: req_1",
                FailureKind::RateLimited,
            ),
            (
                "exceeded retry limit, last status: 500 Internal Server Error",
                FailureKind::VendorError,
            ),
            (
                "To use Codex with your ChatGPT plan, upgrade to Plus: \
             https://chatgpt.com/explore/plus.",
                FailureKind::VendorError,
            ),
            (
                "stream disconnected before completion: reset",
                FailureKind::VendorError,
            ),
        ] {
            assert_eq!(classify(message), kind, "{message}");
        }
    }

    #[test]
    fn items_map_by_their_documented_shapes() {
        let steps = translate(&[
            // Real: a command the sandbox's proxy refused (codex-cli 0.157.1).
            r#"{"type":"item.completed","item":{"id":"item_1","type":"command_execution","command":"/bin/zsh -lc 'curl -fsS -m 5 http://127.0.0.1:38765/'","aggregated_output":"curl: (22) The requested URL returned error: 403\n","exit_code":-1,"status":"failed"}}"#,
            // The rest in exec_events.rs's shapes at rust-v0.157.1.
            r#"{"type":"item.completed","item":{"id":"item_2","type":"command_execution","command":"rm -rf /","aggregated_output":"","exit_code":null,"status":"declined"}}"#,
            r#"{"type":"item.completed","item":{"id":"item_3","type":"reasoning","text":"Checking the tests"}}"#,
            r#"{"type":"item.updated","item":{"id":"item_4","type":"todo_list","items":[{"text":"Read","completed":true},{"text":"Fix","completed":false}]}}"#,
            r#"{"type":"item.started","item":{"id":"item_5","type":"web_search","query":"tokio select","action":{"type":"search","query":"tokio select"}}}"#,
            r#"{"type":"item.completed","item":{"id":"item_6","type":"error","message":"model rerouted"}}"#,
            r#"{"type":"turn.bogus"}"#,
            "not json",
        ]);
        let events: Vec<&Event> = steps
            .iter()
            .filter_map(|step| match step {
                Step::Emit(event) => Some(event),
                _ => None,
            })
            .collect();
        let statuses: Vec<ToolStatus> = events
            .iter()
            .filter_map(|event| match event {
                Event::ToolResult { status, .. } => Some(*status),
                _ => None,
            })
            .collect();
        assert_eq!(statuses, [ToolStatus::Error, ToolStatus::Denied]);
        assert!(events.contains(&&Event::Reasoning {
            message_id: None,
            text: "Checking the tests".into()
        }));
        assert!(events.contains(&&Event::TodoList {
            items: vec![
                TodoItem {
                    text: "Read".into(),
                    status: TodoStatus::Completed
                },
                TodoItem {
                    text: "Fix".into(),
                    status: TodoStatus::Pending
                },
            ]
        }));
        assert!(events.iter().any(|event| matches!(
            event,
            Event::ToolCall { name, input, .. }
                if name == "web_search" && input["query"] == "tokio select"
        )));
        assert!(events.contains(&&Event::Notice {
            detail: "model rerouted".into()
        }));
        assert!(matches!(
            events.last(),
            Some(Event::Warning {
                warning: WarningKind::MalformedLine,
                ..
            })
        ));
    }

    #[test]
    fn tool_call_ids_differ_between_a_thread_s_processes() {
        let line = r#"{"type":"item.started","item":{"id":"item_1","type":"command_execution","command":"ls","aggregated_output":"","exit_code":null,"status":"in_progress"}}"#;
        let ids: Vec<String> = [TurnId::generate(), TurnId::generate()]
            .into_iter()
            .flat_map(|turn| Translator::new(turn.to_string()).line(line.as_bytes()))
            .filter_map(|step| match step {
                Step::Emit(Event::ToolCall { call_id, .. }) => Some(call_id),
                _ => None,
            })
            .collect();
        assert_eq!(ids.len(), 2);
        assert_ne!(ids[0], ids[1]);
    }
}
