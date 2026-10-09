//! Turning `codex app-server` messages into [`Event`]s and driver steps, one line at a time.
//!
//! The shapes are app-server's v2 protocol as `codex app-server generate-ts` prints it for
//! codex-cli 0.159.3, checked against real runs (0035). Fields Parallax doesn't use are ignored, as
//! 0004 asks, so a newer CLI that adds fields still parses.

use std::collections::HashMap;

use serde_json::{Map, Value, json};

use super::super::classify;
use jiff::Timestamp;

use crate::backend::event::{
    ApprovalRequest, Event, Failure, FailureKind, LimitStatus, LimitWindow,
    MAX_ALWAYS_ALLOW_RULE_BYTES, TodoItem, ToolStatus, Usage, WarningKind, todo,
};
use crate::backend::{ApprovalId, Decision};

/// The longest failure message kept from the CLI's output.
const MAX_MESSAGE_CHARS: usize = 2000;

/// The JSON-RPC error code for a server request plxd doesn't serve.
const METHOD_NOT_FOUND: i64 = -32601;

/// What one line asks the driver to do.
#[derive(Debug, PartialEq)]
pub(super) enum Step {
    /// Send an event.
    Emit(Event),
    /// The thread's running usage total, which becomes a usage delta.
    Total(Usage),
    /// The answer to plxd's request `id`: its result, or the error's message.
    Reply {
        /// The request's id.
        id: u64,
        /// What it returned.
        result: Result<Value, String>,
    },
    /// A turn ended: with its final text when it succeeded, or why it failed.
    TurnDone {
        /// The last agent message's text.
        result: Option<String>,
        /// Why it failed, if it did. An interrupted turn didn't fail.
        failure: Option<Failure>,
    },
    /// An approval request: the event to report, and what answering it needs. Codex waits.
    Ask(ApprovalRequest, Ask),
    /// Codex no longer waits on its request with this JSON-RPC id (`serverRequest/resolved`).
    Resolved(Value),
    /// A server request plxd doesn't serve: the driver answers this error so Codex never waits.
    Refuse {
        /// The request's JSON-RPC id.
        id: Value,
        /// Why.
        message: String,
    },
}

/// What an approval request asks about, which decides its answer's shape.
#[derive(Clone, Debug, PartialEq)]
pub(super) enum AskKind {
    /// `item/commandExecution/requestApproval`.
    Command,
    /// `item/fileChange/requestApproval`.
    FileChange,
    /// `item/permissions/requestApproval`, with the permissions it asks for.
    Permissions(Value),
    /// `mcpServer/elicitation/request`.
    Elicitation,
}

/// What answering an approval request needs.
#[derive(Debug, PartialEq)]
pub(super) struct Ask {
    /// The request's JSON-RPC id, which the response repeats.
    pub id: Value,
    /// What it asks about.
    pub kind: AskKind,
    /// The input the request showed, which an edited answer must keep.
    pub input: Value,
}

/// The JSON-RPC result that answers `ask` with `decision`. Codex takes no edited input, so an allow
/// whose input differs from what Codex asked with is a denial, never a run of something else.
/// `always` allows the same command for the rest of the session (`acceptForSession`), and adds no
/// rule to the user's files, as 0031 asks.
pub(super) fn answer_response(ask: &Ask, decision: &Decision) -> Value {
    let allow = match decision {
        Decision::Allow {
            input: Some(input), ..
        } => *input == ask.input,
        Decision::Allow { .. } => true,
        Decision::Deny { .. } => false,
    };
    let always = matches!(*decision, Decision::Allow { always: true, .. });
    let interrupt = matches!(
        decision,
        Decision::Deny {
            interrupt: true,
            ..
        }
    );
    match &ask.kind {
        AskKind::Command | AskKind::FileChange => {
            let decision = match (allow, always, interrupt) {
                (true, true, _) => "acceptForSession",
                (true, false, _) => "accept",
                (false, _, true) => "cancel",
                (false, _, false) => "decline",
            };
            json!({ "decision": decision })
        }
        AskKind::Permissions(requested) => json!({
            "permissions": if allow { requested.clone() } else { json!({}) },
            "scope": "turn",
        }),
        AskKind::Elicitation => {
            let action = match (allow, interrupt) {
                (true, _) => "accept",
                (false, true) => "cancel",
                (false, false) => "decline",
            };
            json!({ "action": action, "content": null, "_meta": null })
        }
    }
}

/// The state that reading one app-server's output needs.
#[derive(Debug, Default)]
pub(super) struct Translator {
    /// File change items' changes by item id, from `item/started`: Codex's approval request for
    /// one names only the item.
    changes: HashMap<String, Value>,
    /// The current turn's last agent message.
    last_message: Option<String>,
}

impl Translator {
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
        let params = message.get("params").and_then(Value::as_object);
        match (message.get("id"), text(&message, "method")) {
            (Some(id), Some(method)) => self.request(id.clone(), method, params),
            (Some(id), None) => reply(id, &message),
            (None, Some(method)) => match params {
                Some(params) => self.notification(method, params),
                None => vec![warning(format!("a {method} notification without params"))],
            },
            (None, None) => vec![warning("a message without an id or a method".into())],
        }
    }

    fn notification(&mut self, method: &str, params: &Map<String, Value>) -> Vec<Step> {
        match method {
            "item/started" | "item/completed" => {
                match params.get("item").and_then(Value::as_object) {
                    Some(item) => self.item(method == "item/completed", item),
                    None => vec![warning(format!("an {method} without an item"))],
                }
            }
            "item/agentMessage/delta" => match text(params, "delta") {
                Some(delta) if !delta.is_empty() => vec![Step::Emit(Event::TextDelta {
                    message_id: text(params, "itemId").map(str::to_owned),
                    text: delta.to_owned(),
                })],
                _ => Vec::new(),
            },
            "turn/plan/updated" => vec![Step::Emit(Event::TodoList {
                items: plan_items(params.get("plan")),
            })],
            "thread/tokenUsage/updated" => params
                .get("tokenUsage")
                .and_then(|usage| usage.get("total"))
                .map(|total| Step::Total(usage_total(total)))
                .into_iter()
                .collect(),
            "turn/completed" => {
                let turn = params.get("turn").and_then(Value::as_object);
                let status = turn.and_then(|turn| text(turn, "status"));
                let result = self.last_message.take();
                let failure = (status == Some("failed"))
                    .then(|| turn_failure(turn.and_then(|turn| turn.get("error"))));
                vec![Step::TurnDone {
                    result: if status == Some("completed") {
                        result
                    } else {
                        None
                    },
                    failure,
                }]
            }
            // A failure the turn may survive: Codex retries. A final one ends the turn, whose
            // `turn/completed` reports it.
            "error" if params.get("willRetry").and_then(Value::as_bool) == Some(true) => params
                .get("error")
                .and_then(|error| error.get("message"))
                .and_then(Value::as_str)
                .map(|detail| notice(detail.to_owned()))
                .into_iter()
                .collect(),
            "warning" | "guardianWarning" => text(params, "message")
                .map(|detail| notice(detail.to_owned()))
                .into_iter()
                .collect(),
            "configWarning" => text(params, "summary")
                .map(|detail| notice(detail.to_owned()))
                .into_iter()
                .collect(),
            "account/rateLimits/updated" => rate_limits(params),
            "serverRequest/resolved" => params
                .get("requestId")
                .map(|id| Step::Resolved(id.clone()))
                .into_iter()
                .collect(),
            _ => Vec::new(),
        }
    }

    fn item(&mut self, done: bool, item: &Map<String, Value>) -> Vec<Step> {
        let (Some(id), Some(kind)) = (text(item, "id"), text(item, "type")) else {
            return vec![warning("an item without an id or a type".into())];
        };
        match kind {
            "agentMessage" if done => {
                let Some(message) = text(item, "text").filter(|text| !text.is_empty()) else {
                    return Vec::new();
                };
                self.last_message = Some(message.to_owned());
                vec![Step::Emit(Event::Text {
                    message_id: Some(id.to_owned()),
                    text: message.to_owned(),
                })]
            }
            "reasoning" if done => {
                let parts: Vec<&str> = ["summary", "content"]
                    .iter()
                    .filter_map(|key| item.get(*key).and_then(Value::as_array))
                    .flatten()
                    .filter_map(Value::as_str)
                    .filter(|part| !part.trim().is_empty())
                    .collect();
                if parts.is_empty() {
                    return Vec::new();
                }
                vec![Step::Emit(Event::Reasoning {
                    message_id: Some(id.to_owned()),
                    text: parts.join("\n\n"),
                })]
            }
            // A `/compact`'s, or one Codex starts itself when the context fills (PLX-638).
            "contextCompaction" => vec![Step::Emit(Event::ContextCompaction { done })],
            "commandExecution" | "fileChange" | "mcpToolCall" | "webSearch" => {
                let (name, input) = tool(kind, item);
                if kind == "fileChange" {
                    if done {
                        self.changes.remove(id);
                    } else {
                        self.changes.insert(id.to_owned(), input.clone());
                    }
                }
                if !done {
                    return vec![Step::Emit(Event::ToolCall {
                        call_id: id.to_owned(),
                        name,
                        input,
                    })];
                }
                vec![Step::Emit(Event::ToolResult {
                    call_id: id.to_owned(),
                    status: tool_status(item),
                    output: tool_output(kind, item),
                    images: item
                        .get("result")
                        .and_then(|result| result.get("content"))
                        .map(crate::images::from_blocks)
                        .unwrap_or_default(),
                })]
            }
            _ => Vec::new(),
        }
    }

    /// A request from Codex: an approval to forward, or anything else to refuse.
    fn request(
        &mut self,
        id: Value,
        method: &str,
        params: Option<&Map<String, Value>>,
    ) -> Vec<Step> {
        let empty = Map::new();
        let params = params.unwrap_or(&empty);
        let call_id = text(params, "itemId").map(str::to_owned);
        let reason = text(params, "reason")
            .filter(|reason| !reason.trim().is_empty())
            .map(str::to_owned);
        let (tool_name, kind, input, always_allow, interactive) = match method {
            "item/commandExecution/requestApproval" => {
                let command = text(params, "command").unwrap_or_default();
                let always = (!command.is_empty() && command.len() <= MAX_ALWAYS_ALLOW_RULE_BYTES)
                    .then(|| command.to_owned());
                let input = json!({ "command": command, "cwd": params.get("cwd") });
                ("command_execution", AskKind::Command, input, always, false)
            }
            "item/fileChange/requestApproval" => {
                let changes = call_id
                    .as_ref()
                    .and_then(|item| self.changes.get(item))
                    .cloned()
                    .unwrap_or_else(|| json!({ "changes": [] }));
                ("file_change", AskKind::FileChange, changes, None, false)
            }
            "item/permissions/requestApproval" => {
                let permissions = params
                    .get("permissions")
                    .cloned()
                    .unwrap_or_else(|| json!({}));
                let input = json!({ "permissions": permissions, "cwd": params.get("cwd") });
                (
                    "permissions",
                    AskKind::Permissions(permissions),
                    input,
                    None,
                    false,
                )
            }
            "mcpServer/elicitation/request" => {
                let input = Value::Object(params.clone());
                ("mcp_elicitation", AskKind::Elicitation, input, None, true)
            }
            _ => {
                return vec![Step::Refuse {
                    id,
                    message: format!("plxd doesn't answer {method} requests"),
                }];
            }
        };
        let event = ApprovalRequest {
            approval_id: ApprovalId::generate(),
            tool_name: tool_name.to_owned(),
            input: input.clone(),
            call_id,
            reason,
            blocked_path: None,
            subagent: None,
            always_allow: always_allow.into_iter().collect(),
            interactive,
        };
        vec![Step::Ask(event, Ask { id, kind, input })]
    }
}

/// A response to one of plxd's requests, whose ids are numbers.
fn reply(id: &Value, message: &Map<String, Value>) -> Vec<Step> {
    let Some(id) = id.as_u64() else {
        return vec![warning(format!("a response to an unknown request {id}"))];
    };
    let result = match (message.get("result"), message.get("error")) {
        (_, Some(error)) => Err(error
            .get("message")
            .and_then(Value::as_str)
            .unwrap_or("Codex answered with an error")
            .to_owned()),
        (Some(result), None) => Ok(result.clone()),
        (None, None) => Ok(Value::Null),
    };
    vec![Step::Reply { id, result }]
}

/// The JSON-RPC error that refuses a server request.
pub(super) fn refusal(message: &str) -> Value {
    json!({ "code": METHOD_NOT_FOUND, "message": message })
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

fn notice(detail: String) -> Step {
    Step::Emit(Event::Notice { detail })
}

/// A tool call item's name, in exec's naming so the app shows both alike, or the MCP tool as
/// `mcp__<server>__<tool>`, and its input.
fn tool(kind: &str, item: &Map<String, Value>) -> (String, Value) {
    let pick = |keys: &[&str]| -> Value {
        keys.iter()
            .filter_map(|key| Some(((*key).to_owned(), item.get(*key)?.clone())))
            .collect::<Map<_, _>>()
            .into()
    };
    match kind {
        "commandExecution" => ("command_execution".into(), pick(&["command", "cwd"])),
        "fileChange" => ("file_change".into(), pick(&["changes"])),
        "mcpToolCall" => {
            let name = format!(
                "mcp__{}__{}",
                text(item, "server").unwrap_or_default(),
                text(item, "tool").unwrap_or_default()
            );
            (name, item.get("arguments").cloned().unwrap_or(Value::Null))
        }
        _ => ("web_search".into(), pick(&["query", "action"])),
    }
}

/// How a finished tool call item ended. A command that ran and exited non-zero failed too.
fn tool_status(item: &Map<String, Value>) -> ToolStatus {
    match text(item, "status") {
        Some("completed") if item.get("exitCode").and_then(Value::as_i64).unwrap_or(0) == 0 => {
            ToolStatus::Ok
        }
        Some("completed" | "failed") => ToolStatus::Error,
        Some("declined") => ToolStatus::Denied,
        // A finished web search has no status.
        None => ToolStatus::Ok,
        Some(_) => ToolStatus::Unknown,
    }
}

/// What a finished tool call returned: a command's output, or an MCP tool's error or result.
fn tool_output(kind: &str, item: &Map<String, Value>) -> Option<String> {
    let output = match kind {
        "commandExecution" => text(item, "aggregatedOutput").map(str::to_owned),
        "mcpToolCall" => item
            .get("error")
            .and_then(|error| error.get("message"))
            .and_then(Value::as_str)
            .map(str::to_owned)
            .or_else(|| {
                item.get("result")
                    .filter(|r| !r.is_null())
                    .map(without_images)
            }),
        _ => None,
    };
    output.filter(|output| !output.is_empty())
}

/// An MCP tool's `result` as JSON text, with each image's base64 left out: the event's `images`
/// carry them.
fn without_images(result: &Value) -> String {
    let mut result = result.clone();
    if let Some(blocks) = result.get_mut("content").and_then(Value::as_array_mut) {
        for block in blocks {
            if block.get("type").and_then(Value::as_str) == Some("image")
                && let Some(block) = block.as_object_mut()
            {
                block.remove("data");
            }
        }
    }
    result.to_string()
}

/// `turn/plan/updated`'s steps.
fn plan_items(plan: Option<&Value>) -> Vec<TodoItem> {
    plan.and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|step| todo(step, "step"))
        .collect()
}

/// `thread/tokenUsage/updated`'s `total`: the thread's running totals, which a resumed thread
/// carries over. `OpenAI` counts cached input inside `inputTokens` and reasoning inside
/// `outputTokens`; Parallax's input excludes cache reads.
fn usage_total(total: &Value) -> Usage {
    let count = |key| total.get(key).and_then(Value::as_u64).unwrap_or(0);
    let cached = count("cachedInputTokens");
    Usage {
        input_tokens: count("inputTokens").saturating_sub(cached),
        output_tokens: count("outputTokens"),
        cache_read_tokens: cached,
        cache_write_tokens: count("cacheWriteInputTokens"),
        cost_usd_micros: None,
    }
}

/// `account/rateLimits/updated`'s `primary` and `secondary` windows, each refused once it is
/// fully used, with when it resets (PLX-371): what auto-resume waits for (decision 0049).
fn rate_limits(params: &Map<String, Value>) -> Vec<Step> {
    let Some(limits) = params.get("rateLimits") else {
        return Vec::new();
    };
    ["primary", "secondary"]
        .into_iter()
        .filter_map(|window| {
            let limit = limits.get(window).filter(|limit| limit.is_object())?;
            let used_percent = limit.get("usedPercent").and_then(Value::as_f64);
            Some(Step::Emit(Event::RateLimit(LimitWindow {
                window: window.to_owned(),
                duration_minutes: limit
                    .get("windowDurationMins")
                    .and_then(Value::as_u64)
                    .and_then(|minutes| u32::try_from(minutes).ok()),
                used_percent,
                status: match used_percent {
                    Some(used) if used >= 100.0 => LimitStatus::Rejected,
                    Some(_) => LimitStatus::Allowed,
                    None => LimitStatus::Unknown,
                },
                resets_at: limit
                    .get("resetsAt")
                    .and_then(Value::as_i64)
                    .and_then(|seconds| Timestamp::from_second(seconds).ok()),
            })))
        })
        .collect()
}

/// A failed turn's [`Failure`]: `codexErrorInfo` says when routing should fall back (0012), and
/// the message says the rest ([`classify`]).
fn turn_failure(error: Option<&Value>) -> Failure {
    let message = error
        .and_then(|error| error.get("message"))
        .and_then(Value::as_str)
        .unwrap_or("Codex ended the turn with an error");
    let failure = match error
        .and_then(|error| error.get("codexErrorInfo"))
        .and_then(Value::as_str)
    {
        Some("unauthorized") => FailureKind::NotSignedIn,
        Some("usageLimitExceeded" | "rateLimitExceeded") => FailureKind::RateLimited,
        _ => classify(message),
    };
    let message = match message.char_indices().nth(MAX_MESSAGE_CHARS) {
        Some((end, _)) => format!("{}...", &message[..end]),
        None => message.to_owned(),
    };
    Failure::new(failure, message)
}

#[cfg(test)]
mod tests {
    use parallax_protocol::{ImageMediaType, PromptImage};
    use serde_json::json;

    use super::{Ask, AskKind, Step, Translator, answer_response};
    use crate::backend::Decision;
    use crate::backend::event::{
        Event, FailureKind, LimitStatus, LimitWindow, TodoItem, TodoStatus, ToolStatus, Usage,
    };

    fn translate(fixture: &str) -> Vec<Step> {
        let mut translator = Translator::default();
        fixture
            .lines()
            .flat_map(|line| translator.line(line.as_bytes()))
            .collect()
    }

    fn events(steps: &[Step]) -> Vec<&Event> {
        steps
            .iter()
            .filter_map(|step| match step {
                Step::Emit(event) => Some(event),
                _ => None,
            })
            .collect()
    }

    #[test]
    fn a_real_turn_maps_to_events() {
        let steps = translate(include_str!("../fixtures/app-server-turn.jsonl"));
        let events = events(&steps);
        assert!(events.contains(&&Event::TextDelta {
            message_id: Some("msg_1".into()),
            text: "I’ll".into()
        }));
        assert!(events.contains(&&Event::Text {
            message_id: Some("msg_2".into()),
            text: "42ed0b6".into()
        }));
        assert!(events.iter().any(|event| matches!(
            event,
            Event::ToolCall { call_id, name, input }
                if call_id == "exec-1" && name == "command_execution"
                    && input["command"] == "/bin/zsh -lc 'git add -A && git commit -m probe'"
        )));
        assert!(events.iter().any(|event| matches!(
            event,
            Event::ToolResult { call_id, status: ToolStatus::Ok, output: Some(output), .. }
                if call_id == "exec-1" && output.starts_with("[main 42ed0b6] probe")
        )));
        assert!(events.iter().any(|event| matches!(
            event,
            Event::ToolCall { name, input, .. }
                if name == "file_change" && input["changes"][0]["path"] == "/repo/README.md"
        )));
        assert!(events.contains(&&Event::TodoList {
            items: vec![
                TodoItem {
                    text: "Edit README".into(),
                    status: TodoStatus::Completed
                },
                TodoItem {
                    text: "Commit".into(),
                    status: TodoStatus::InProgress
                },
            ]
        }));
        assert!(events.contains(&&Event::Reasoning {
            message_id: Some("rs_1".into()),
            text: "Checking the repo".into()
        }));
        let totals: Vec<&Usage> = steps
            .iter()
            .filter_map(|step| match step {
                Step::Total(total) => Some(total),
                _ => None,
            })
            .collect();
        assert_eq!(
            totals
                .last()
                .map(|total| (total.input_tokens, total.cache_read_tokens)),
            Some((44515 - 33792, 33792))
        );
        assert_eq!(
            steps.last(),
            Some(&Step::TurnDone {
                result: Some("42ed0b6".into()),
                failure: None
            })
        );
    }

    /// PLX-371: the windows' reset times are what auto-resume waits for, and a fully used one is
    /// refused.
    #[test]
    fn an_mcp_tools_images_are_its_events_images_and_left_out_of_its_output() {
        let line = r#"{"method":"item/completed","params":{"item":{"type":"mcpToolCall","id":"mcp-1","server":"plxd","tool":"device_screenshot","status":"completed","arguments":{},"result":{"content":[{"type":"text","text":"{}"},{"type":"image","data":"iVBORw0KGgo=","mimeType":"image/png"}]}}}}"#;
        let steps = translate(line);
        let [Event::ToolResult { output, images, .. }] = events(&steps)[..] else {
            panic!("one tool result: {steps:?}");
        };
        assert_eq!(
            images,
            &[PromptImage {
                media_type: ImageMediaType::Png,
                data: "iVBORw0KGgo=".to_owned(),
            }]
        );
        let output = output.as_deref().unwrap();
        assert!(!output.contains("iVBORw0KGgo="), "{output}");
        assert!(output.contains(r#""mimeType":"image/png""#), "{output}");
    }

    #[test]
    fn rate_limit_updates_are_limit_windows() {
        let steps = translate(include_str!("../fixtures/app-server-turn.jsonl"));
        let windows: Vec<&LimitWindow> = events(&steps)
            .into_iter()
            .filter_map(|event| match event {
                Event::RateLimit(window) => Some(window),
                _ => None,
            })
            .collect();
        assert_eq!(
            windows,
            [
                &LimitWindow {
                    window: "primary".into(),
                    duration_minutes: Some(300),
                    used_percent: Some(78.0),
                    status: LimitStatus::Allowed,
                    resets_at: Some(jiff::Timestamp::from_second(1_790_923_590).unwrap()),
                },
                &LimitWindow {
                    window: "secondary".into(),
                    duration_minutes: Some(10080),
                    used_percent: Some(65.0),
                    status: LimitStatus::Allowed,
                    resets_at: Some(jiff::Timestamp::from_second(1_791_077_219).unwrap()),
                },
            ]
        );

        let full = json!({"method": "account/rateLimits/updated", "params": {"rateLimits": {
            "primary": {"usedPercent": 100, "windowDurationMins": 300, "resetsAt": 1_790_923_590},
            "secondary": null,
        }}});
        let steps = translate(&full.to_string());
        assert!(matches!(
            events(&steps)[..],
            [Event::RateLimit(LimitWindow {
                status: LimitStatus::Rejected,
                ..
            })]
        ));
    }

    #[test]
    fn approval_requests_carry_what_the_card_shows() {
        let steps = translate(include_str!("../fixtures/app-server-approvals.jsonl"));
        let asks: Vec<_> = steps
            .iter()
            .filter_map(|step| match step {
                Step::Ask(request, ask) => Some((request, ask)),
                _ => None,
            })
            .collect();
        assert_eq!(asks.len(), 2);
        let (command, ask) = asks[0];
        assert_eq!(command.tool_name, "command_execution");
        assert_eq!(command.call_id.as_deref(), Some("exec-c"));
        assert_eq!(
            command.input["command"],
            "/bin/zsh -lc 'git commit -m probe'"
        );
        assert_eq!(
            command.reason.as_deref(),
            Some("Allow Git to write the repository metadata?")
        );
        assert_eq!(command.always_allow, ["/bin/zsh -lc 'git commit -m probe'"]);
        assert_eq!((ask.id.clone(), &ask.kind), (json!(0), &AskKind::Command));
        let (patch, ask) = asks[1];
        assert_eq!(patch.tool_name, "file_change");
        assert_eq!(
            patch.input["changes"][0]["diff"], "one\n",
            "from the item that started"
        );
        assert_eq!(ask.kind, AskKind::FileChange);
        assert!(steps.contains(&Step::Resolved(json!(1))));
        assert!(steps.contains(&Step::Refuse {
            id: json!(2),
            message: "plxd doesn't answer item/tool/call requests".into()
        }));
    }

    #[test]
    fn answers_map_to_codex_decisions() {
        let command = Ask {
            id: json!(0),
            kind: AskKind::Command,
            input: json!({"command": "ls"}),
        };
        let answer = |decision| answer_response(&command, &decision)["decision"].clone();
        let allow = |always| Decision::Allow {
            input: None,
            always,
        };
        let deny = |interrupt| Decision::Deny {
            message: "no".into(),
            interrupt,
        };
        assert_eq!(answer(allow(false)), "accept");
        assert_eq!(answer(allow(true)), "acceptForSession");
        assert_eq!(answer(deny(false)), "decline");
        assert_eq!(answer(deny(true)), "cancel");
        let edited = Decision::Allow {
            input: Some(json!({"command": "rm -rf /"})),
            always: false,
        };
        assert_eq!(
            answer(edited),
            "decline",
            "Codex can't run an edited command"
        );
        let permissions = Ask {
            id: json!(1),
            kind: AskKind::Permissions(json!({"network": {"enabled": true}})),
            input: json!({}),
        };
        assert_eq!(
            answer_response(&permissions, &allow(false)),
            json!({"permissions": {"network": {"enabled": true}}, "scope": "turn"})
        );
        assert_eq!(
            answer_response(&permissions, &deny(false)),
            json!({"permissions": {}, "scope": "turn"})
        );
    }

    #[test]
    fn failed_turns_say_when_routing_should_fall_back() {
        let failed = |info: &str, message: &str| {
            let line = json!({"method": "turn/completed", "params": {"threadId": "t", "turn": {
                "id": "u", "status": "failed",
                "error": {"message": message, "codexErrorInfo": info},
            }}});
            match Translator::default()
                .line(line.to_string().as_bytes())
                .pop()
            {
                Some(Step::TurnDone {
                    failure: Some(failure),
                    result: None,
                }) => failure.failure,
                other => panic!("{other:?}"),
            }
        };
        assert_eq!(failed("unauthorized", "401"), FailureKind::NotSignedIn);
        assert_eq!(
            failed("usageLimitExceeded", "limit"),
            FailureKind::RateLimited
        );
        assert_eq!(
            failed("other", "You've hit your usage limit."),
            FailureKind::RateLimited
        );
        assert_eq!(
            failed("internalServerError", "boom"),
            FailureKind::VendorError
        );
    }
}
