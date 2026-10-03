//! Turning an ACP agent's stdout into [`Event`]s, one JSON-RPC message at a time.
//!
//! The shapes are Agent Client Protocol 1 as Cursor Agent 2026.10.01-14929f9 and the other agents
//! of 0040 write it, read from real runs (0036), with Cursor's own requests (`cursor/update_todos`, `cursor/create_plan`,
//! `cursor/ask_question`). Fields Parallax doesn't use are ignored, as 0004 asks.

use std::collections::{HashMap, HashSet};

use serde_json::{Map, Value, json};

use crate::backend::ApprovalId;
use crate::backend::event::{
    ApprovalRequest, Event, TodoItem, TodoStatus, ToolStatus, WarningKind,
};

/// The tool name a plan reaches the app under: Claude Code's, whose request the app already shows
/// as a proposed plan with Approve and Keep planning (0031).
pub(super) const PLAN_TOOL: &str = "ExitPlanMode";

/// JSON-RPC's "method not found", for a request plxd doesn't serve.
const METHOD_NOT_FOUND: i64 = -32601;

/// What one message asks the driver to do.
#[derive(Debug, PartialEq)]
pub(super) enum Step {
    /// Send an event.
    Emit(Event),
    /// The answer to plxd's request `id`: its result, or the error's message.
    Response {
        id: u64,
        result: Result<Value, String>,
    },
    /// The CLI asks and waits: report the request, and keep the ask for its answer.
    Ask(ApprovalRequest, Ask),
    /// A message to write back at once: plxd's answer to a request it serves itself.
    Reply(Value),
}

/// A request the CLI waits on, as the driver keeps it until the user answers.
#[derive(Debug, PartialEq)]
pub(super) struct Ask {
    /// The CLI's id for the request, which the answer repeats.
    pub id: Value,
    /// The tool call it is about.
    pub call_id: Option<String>,
    pub kind: AskKind,
}

#[derive(Debug, PartialEq)]
pub(super) enum AskKind {
    /// `session/request_permission`, answered with one of its options, or `cancelled` without one.
    Permission {
        allow: Option<String>,
        reject: Option<String>,
    },
    /// `cursor/create_plan`, answered `accepted` or `rejected` with the user's reason.
    Plan { plan: String },
}

/// One tool call, as its updates have described it so far.
#[derive(Debug, Default)]
struct Call {
    kind: String,
    title: String,
    input: Map<String, Value>,
    /// Its `ToolCall` event was sent.
    reported: bool,
    /// Its `ToolResult` event was sent.
    finished: bool,
}

/// The state that reading one run's output needs.
#[derive(Debug, Default)]
pub(super) struct Translator {
    /// `session/load` replays the session's history as updates before it answers. Those are
    /// already in the run's log, so they are dropped while this is set.
    pub replaying: bool,
    /// What messages call the agent, such as `Cursor Agent`.
    pub label: String,
    /// The client answers permission requests (`RunRequest::approvals`). Without it, plxd rejects
    /// each one at once, as headless Claude Code denies what would prompt (0031).
    pub asks: bool,
    calls: HashMap<String, Call>,
    /// Calls the user (or plxd, without `asks`) rejected, which end `completed` all the same.
    pub denied: HashSet<String>,
    /// Thinking not yet sent: chunks join into one `Reasoning` until something else arrives.
    thinking: String,
    /// The agent's text since the turn's last tool call, the turn's result.
    text: String,
    /// The todo list, by id, in order, as `cursor/update_todos` merges into it.
    todos: Vec<(String, TodoItem)>,
}

impl Translator {
    /// Reads one line of stdout.
    pub fn line(&mut self, line: &[u8]) -> Vec<Step> {
        if line.iter().all(u8::is_ascii_whitespace) {
            return Vec::new();
        }
        let message = match serde_json::from_slice::<Value>(line) {
            Ok(Value::Object(message)) => message,
            Ok(_) => {
                return vec![warning(
                    WarningKind::MalformedLine,
                    "a line that is not a JSON object",
                )];
            }
            Err(error) => return vec![warning(WarningKind::MalformedLine, &error.to_string())],
        };
        let method = message.get("method").and_then(Value::as_str);
        let update = message
            .get("params")
            .and_then(|params| params.get("update"))
            .filter(|_| method == Some("session/update"));
        if update.is_some_and(|update| kind(update) == Some("agent_thought_chunk")) {
            if !self.replaying {
                self.thinking
                    .push_str(chunk_text(update.unwrap_or(&Value::Null)));
            }
            return Vec::new();
        }
        let mut steps: Vec<Step> = self.flush().into_iter().collect();
        match (method, message.get("id")) {
            (Some("session/update"), None) => {
                if let Some(update) = update.filter(|_| !self.replaying) {
                    steps.extend(self.update(update));
                }
            }
            (Some(method), Some(id)) => {
                let params = message.get("params").unwrap_or(&Value::Null);
                steps.extend(self.request(method, id.clone(), params));
            }
            (Some(_), None) => {}
            (None, Some(id)) => match id.as_u64() {
                Some(id) => {
                    let result = match message.get("error") {
                        Some(error) => {
                            Err(error.get("message").and_then(Value::as_str).map_or_else(
                                || format!("{} returned an error", self.label),
                                str::to_owned,
                            ))
                        }
                        None => Ok(message.get("result").cloned().unwrap_or(Value::Null)),
                    };
                    steps.push(Step::Response { id, result });
                }
                None => steps.push(warning(
                    WarningKind::MalformedLine,
                    "a response to an id plxd never sent",
                )),
            },
            (None, None) => steps.push(warning(
                WarningKind::MalformedLine,
                "a message that is neither a request nor a response",
            )),
        }
        steps
    }

    /// The thinking held back so far, as one event.
    pub fn flush(&mut self) -> Option<Step> {
        (!self.thinking.is_empty()).then(|| {
            Step::Emit(Event::Reasoning {
                message_id: None,
                text: std::mem::take(&mut self.thinking),
            })
        })
    }

    /// A failed result for every call reported but never finished, at the end of a turn: some
    /// agents leave a call pending (Hermes Agent's denied edit), and the app would wait on it.
    pub fn unfinished(&mut self) -> Vec<Event> {
        let mut events = Vec::new();
        for (id, call) in &mut self.calls {
            if call.reported && !call.finished {
                call.finished = true;
                let status = if self.denied.contains(id) {
                    ToolStatus::Denied
                } else {
                    ToolStatus::Error
                };
                events.push(Event::ToolResult {
                    call_id: id.clone(),
                    status,
                    output: None,
                });
            }
        }
        events
    }

    /// The turn's result, its text since the last tool call, and starts the next turn's.
    pub fn take_text(&mut self) -> Option<String> {
        let text = std::mem::take(&mut self.text);
        (!text.trim().is_empty()).then_some(text)
    }

    fn update(&mut self, update: &Value) -> Vec<Step> {
        match kind(update) {
            Some("agent_message_chunk") => {
                let text = chunk_text(update);
                if text.is_empty() {
                    return Vec::new();
                }
                self.text.push_str(text);
                vec![Step::Emit(Event::TextDelta {
                    message_id: None,
                    text: text.to_owned(),
                })]
            }
            Some("tool_call" | "tool_call_update") => self.tool_call(update),
            Some("plan") => {
                let items = update
                    .get("entries")
                    .and_then(Value::as_array)
                    .into_iter()
                    .flatten()
                    .filter_map(todo)
                    .collect();
                vec![Step::Emit(Event::TodoList { items })]
            }
            // Agents' own bookkeeping (a turn's tokens come on its answer instead), and the user's
            // own message echoed in a replay.
            Some(
                "available_commands_update"
                | "session_info_update"
                | "current_mode_update"
                | "config_option_update"
                | "usage_update"
                | "user_message_chunk"
                | "subagent_spawned"
                | "subagent_state_update",
            ) => Vec::new(),
            other => vec![warning(
                WarningKind::UnknownEvent,
                &format!("a session update of kind {}", other.unwrap_or("(none)")),
            )],
        }
    }

    fn tool_call(&mut self, update: &Value) -> Vec<Step> {
        let Some(id) = update.get("toolCallId").and_then(Value::as_str) else {
            return vec![warning(
                WarningKind::MalformedLine,
                "a tool call without a toolCallId",
            )];
        };
        if kind(update) == Some("tool_call") {
            self.text.clear();
        }
        let call = self.calls.entry(id.to_owned()).or_default();
        if let Some(kind) = update.get("kind").and_then(Value::as_str) {
            kind.clone_into(&mut call.kind);
        }
        if let Some(title) = update.get("title").and_then(Value::as_str) {
            title.clone_into(&mut call.title);
        }
        if let Some(Value::Object(input)) = update.get("rawInput") {
            call.input.clone_from(input);
        }
        let mut steps = Vec::new();
        let status = update.get("status").and_then(Value::as_str);
        if matches!(status, Some("in_progress" | "completed" | "failed")) {
            steps.extend(self.report(id));
        }
        if let Some(status @ ("completed" | "failed")) = status
            && let Some(call) = self.calls.get_mut(id)
            && call.reported
        {
            call.finished = true;
            let output = update.get("rawOutput");
            let failed = status == "failed"
                || output
                    .and_then(|output| output.get("exitCode"))
                    .and_then(Value::as_i64)
                    .is_some_and(|code| code != 0);
            let status = if self.denied.contains(id) {
                ToolStatus::Denied
            } else if failed {
                ToolStatus::Error
            } else {
                ToolStatus::Ok
            };
            steps.push(Step::Emit(Event::ToolResult {
                call_id: id.to_owned(),
                status,
                output: output.and_then(output_text),
            }));
        }
        steps
    }

    /// The call's `ToolCall` event, once: named for the tool the app already draws, with its
    /// input. Cursor's todo tool is reported as `TodoList` events instead.
    fn report(&mut self, id: &str) -> Option<Step> {
        let call = self.calls.get_mut(id)?;
        if call.reported {
            return None;
        }
        let tool = call.input.get("_toolName").and_then(Value::as_str);
        if tool == Some("updateTodos") {
            return None;
        }
        call.reported = true;
        let mut input = call.input.clone();
        input.remove("_toolName");
        let name = if tool == Some("createPlan") {
            // The plan's Markdown, as `ExitPlanMode`'s input carries it.
            let plan = input.remove("plan").unwrap_or_else(|| Value::from(""));
            input = Map::from_iter([("plan".to_owned(), plan)]);
            PLAN_TOOL.to_owned()
        } else {
            tool_name(call)
        };
        Some(Step::Emit(Event::ToolCall {
            call_id: id.to_owned(),
            name,
            input: Value::Object(input),
        }))
    }

    fn request(&mut self, method: &str, id: Value, params: &Value) -> Vec<Step> {
        match method {
            "session/request_permission" => self.permission(id, params),
            "cursor/create_plan" => {
                let plan = params
                    .get("plan")
                    .and_then(Value::as_str)
                    .unwrap_or_default();
                let call_id = params
                    .get("toolCallId")
                    .and_then(Value::as_str)
                    .map(str::to_owned);
                if !self.asks {
                    // Cursor then saves the plan itself, as it does for a client without plans.
                    return vec![Step::Reply(error(&id, "plxd's client takes no plans"))];
                }
                let request = ApprovalRequest {
                    approval_id: ApprovalId::generate(),
                    tool_name: PLAN_TOOL.to_owned(),
                    input: json!({"plan": plan}),
                    call_id: call_id.clone(),
                    reason: None,
                    blocked_path: None,
                    subagent: None,
                    always_allow: Vec::new(),
                    interactive: true,
                };
                let kind = AskKind::Plan {
                    plan: plan.to_owned(),
                };
                vec![Step::Ask(request, Ask { id, call_id, kind })]
            }
            "cursor/update_todos" => {
                let todos = params.get("todos").and_then(Value::as_array);
                if params.get("merge").and_then(Value::as_bool) != Some(true) {
                    self.todos.clear();
                }
                for entry in todos.into_iter().flatten() {
                    let (Some(key), Some(item)) =
                        (entry.get("id").and_then(Value::as_str), todo(entry))
                    else {
                        continue;
                    };
                    match self.todos.iter_mut().find(|(id, _)| id == key) {
                        Some((_, old)) => *old = item,
                        None => self.todos.push((key.to_owned(), item)),
                    }
                }
                let items = self.todos.iter().map(|(_, item)| item.clone()).collect();
                vec![
                    Step::Emit(Event::TodoList { items }),
                    Step::Reply(json!({"jsonrpc": "2.0", "id": id, "result": {}})),
                ]
            }
            // The app has no card for multiple-choice questions, so the agent is told to ask in
            // its reply instead.
            "cursor/ask_question" => vec![Step::Reply(json!({
                "jsonrpc": "2.0", "id": id,
                "result": {"outcome": {"outcome": "skipped",
                    "reason": "Parallax can't show this question. Ask it in your reply instead."}},
            }))],
            other => vec![Step::Reply(error(
                &id,
                &format!("plxd doesn't serve {other}"),
            ))],
        }
    }

    fn permission(&mut self, id: Value, params: &Value) -> Vec<Step> {
        let call = params.get("toolCall").unwrap_or(&Value::Null);
        let call_id = call
            .get("toolCallId")
            .and_then(Value::as_str)
            .map(str::to_owned);
        let mut steps = Vec::new();
        if let Some(call_id) = &call_id {
            // A request can describe a call no update has: take its kind and title too.
            let _ = self.tool_call(call);
            steps.extend(self.report(call_id));
        }
        let option = |kinds: &[&str]| {
            let options = params.get("options").and_then(Value::as_array)?;
            kinds.iter().find_map(|wanted| {
                options
                    .iter()
                    .find(|option| option.get("kind").and_then(Value::as_str) == Some(wanted))
                    .and_then(|option| option.get("optionId").and_then(Value::as_str))
                    .map(str::to_owned)
            })
        };
        let reject = option(&["reject_once", "reject_always"]);
        if !self.asks {
            if let Some(call_id) = &call_id {
                self.denied.insert(call_id.clone());
            }
            steps.push(Step::Reply(permission_answer(&id, reject.as_deref())));
            return steps;
        }
        let kind = AskKind::Permission {
            allow: option(&["allow_once", "allow_always"]),
            reject,
        };
        let (name, input) = match call_id.as_deref().and_then(|id| self.calls.get(id)) {
            Some(call) => {
                let mut input = call.input.clone();
                input.remove("_toolName");
                (tool_name(call), Value::Object(input))
            }
            None => ("Tool".to_owned(), Value::Object(Map::new())),
        };
        let reason = call
            .get("content")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(|item| item.get("content")?.get("text")?.as_str())
            .collect::<Vec<_>>()
            .join("\n");
        let request = ApprovalRequest {
            approval_id: ApprovalId::generate(),
            tool_name: name,
            input,
            call_id: call_id.clone(),
            reason: (!reason.is_empty()).then_some(reason),
            blocked_path: None,
            subagent: None,
            always_allow: Vec::new(),
            interactive: false,
        };
        steps.push(Step::Ask(request, Ask { id, call_id, kind }));
        steps
    }
}

/// A call's name: by its ACP kind, as the Claude Code tool the app already draws for it, or else
/// Cursor's own name for the tool, its title, or its kind.
fn tool_name(call: &Call) -> String {
    let name = match call.kind.as_str() {
        "execute" => "Bash",
        "read" => "Read",
        "edit" => "Edit",
        "search" => "Grep",
        "fetch" => "WebFetch",
        kind => match call.input.get("_toolName").and_then(Value::as_str) {
            Some(tool) => tool,
            None if !call.title.is_empty() => &call.title,
            None => kind,
        },
    };
    name.to_owned()
}

/// The answer to a `session/request_permission`: `option`, or `cancelled` when there is none.
pub(super) fn permission_answer(id: &Value, option: Option<&str>) -> Value {
    let outcome = match option {
        Some(option) => json!({"outcome": "selected", "optionId": option}),
        None => json!({"outcome": "cancelled"}),
    };
    json!({"jsonrpc": "2.0", "id": id, "result": {"outcome": outcome}})
}

fn error(id: &Value, message: &str) -> Value {
    json!({"jsonrpc": "2.0", "id": id, "error": {"code": METHOD_NOT_FOUND, "message": message}})
}

fn kind(update: &Value) -> Option<&str> {
    update.get("sessionUpdate").and_then(Value::as_str)
}

fn chunk_text(update: &Value) -> &str {
    update
        .get("content")
        .filter(|content| content.get("type").and_then(Value::as_str) == Some("text"))
        .and_then(|content| content.get("text"))
        .and_then(Value::as_str)
        .unwrap_or_default()
}

/// A todo or plan entry: `content` and a `status` in either of Cursor's spellings.
fn todo(entry: &Value) -> Option<TodoItem> {
    let text = entry.get("content").and_then(Value::as_str)?.to_owned();
    let status = match entry.get("status").and_then(Value::as_str) {
        Some("pending" | "TODO_STATUS_PENDING") => TodoStatus::Pending,
        Some("in_progress" | "TODO_STATUS_IN_PROGRESS") => TodoStatus::InProgress,
        Some("completed" | "TODO_STATUS_COMPLETED") => TodoStatus::Completed,
        _ => TodoStatus::Other,
    };
    Some(TodoItem { text, status })
}

/// What a tool returned: a command's stdout and stderr, a read's `content`, or the whole
/// `rawOutput` as JSON.
fn output_text(output: &Value) -> Option<String> {
    let Value::Object(fields) = output else {
        return None;
    };
    if fields.contains_key("stdout") || fields.contains_key("stderr") {
        let text: Vec<&str> = ["stdout", "stderr"]
            .iter()
            .filter_map(|name| fields.get(*name)?.as_str())
            .filter(|text| !text.is_empty())
            .collect();
        return (!text.is_empty()).then(|| text.join("\n"));
    }
    if let Some(content) = fields.get("content").and_then(Value::as_str) {
        return Some(content.to_owned());
    }
    (!fields.is_empty()).then(|| output.to_string())
}

fn warning(warning: WarningKind, detail: &str) -> Step {
    Step::Emit(Event::Warning {
        warning,
        detail: detail.to_owned(),
    })
}
