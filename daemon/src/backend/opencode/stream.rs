//! Turning `OpenCode`'s `/event` stream into [`Event`]s, one server-sent event at a time.
//!
//! The shapes are `opencode serve` 1.18.34's, read from real runs (PLX-559). A server's stream
//! carries every session in its folder, so only the thread's session counts, and the sessions
//! its `task` tool starts, for their permission requests. Fields Parallax doesn't use are
//! ignored, as 0004 asks.

use std::collections::{HashMap, HashSet};

use serde_json::{Map, Value, json};

use crate::backend::event::{ApprovalRequest, Event, ModelUsage, ToolStatus, Usage, todo};
use crate::backend::{AgentPermission, ApprovalId};

/// The answer to every question `OpenCode` asks, since the app can't show one.
pub(super) const QUESTION_ANSWER: &str =
    "Parallax can't show this question. Ask it in your reply instead, and go on.";

/// What one event asks the driver to do.
#[derive(Debug, PartialEq)]
pub(super) enum Step {
    /// Send an event.
    Emit(Event),
    /// `OpenCode` asks and waits: report the request, and keep the ask for its answer.
    Ask(ApprovalRequest, Ask),
    /// Answer `OpenCode` at once: `POST path` with `body`.
    Post { path: String, body: Value },
    /// `OpenCode` no longer waits on the permission request with this id: it was answered, by
    /// plxd, another client, or `OpenCode` itself, which rejects a session's other requests
    /// when one is rejected.
    Replied { id: String, rejected: bool },
    /// The session went idle after a prompt: the turn in flight ended.
    Idle,
    /// The turn failed, with `OpenCode`'s message.
    Failed(String),
}

/// A permission request `OpenCode` waits on, as the driver keeps it until the user answers.
#[derive(Debug, PartialEq)]
pub(super) struct Ask {
    /// `OpenCode`'s id for the request.
    pub id: String,
    /// Where the answer goes: `/permission/<id>/reply`.
    pub path: String,
    /// The tool call it is about.
    pub call_id: Option<String>,
}

/// A text or reasoning part of the agent's reply, and what of it was sent.
#[derive(Debug)]
struct Part {
    reasoning: bool,
    /// The text sent so far: a text part's deltas, or a finished reasoning part's whole text.
    sent: String,
}

/// One tool call, as its updates have described it so far.
#[derive(Debug, Default)]
struct Call {
    name: String,
    input: Value,
    reported: bool,
    finished: bool,
}

/// The state that reading one run's events needs.
#[derive(Debug, Default)]
pub(super) struct Translator {
    /// The thread's session.
    pub session: String,
    /// The client answers permission requests (`RunRequest::approvals`). Without it, plxd rejects
    /// each one the run's level doesn't allow.
    pub asks: bool,
    /// The run's level, which answers requests first (0054): Full access allows every one, and
    /// Auto-accept edits allows `edit`.
    pub permission: Option<AgentPermission>,
    /// A prompt is in flight and the session went busy for it, so the next idle ends it. An idle
    /// before that is left over from the turn before.
    pub busy: bool,
    /// Calls the user (or plxd) rejected, which end in an error all the same.
    pub denied: HashSet<String>,
    /// Sessions the thread's `task` tool started.
    children: HashSet<String>,
    /// The user's own messages, whose text parts are the prompt, not the reply.
    prompts: HashSet<String>,
    parts: HashMap<String, Part>,
    /// `step-finish` parts already counted.
    steps: HashSet<String>,
    calls: HashMap<String, Call>,
    /// The agent's text since the turn's last tool call, the turn's result.
    text: String,
}

impl Translator {
    /// Reads one event, the JSON of a `data:` line.
    pub fn event(&mut self, event: &Value) -> Vec<Step> {
        let properties = &event["properties"];
        let session = properties["sessionID"]
            .as_str()
            .or_else(|| properties["part"]["sessionID"].as_str())
            .unwrap_or_default();
        let kind = event["type"].as_str().unwrap_or_default();
        if kind == "session.created" {
            let info = &properties["info"];
            if let (Some(parent), Some(id)) = (info["parentID"].as_str(), info["id"].as_str())
                && (parent == self.session || self.children.contains(parent))
            {
                self.children.insert(id.to_owned());
            }
            return Vec::new();
        }
        if session != self.session && !self.children.contains(session) {
            return Vec::new();
        }
        match kind {
            "permission.asked" => return self.permission(properties),
            "question.asked" => return question(properties),
            "permission.replied" => {
                return properties["requestID"]
                    .as_str()
                    .map(|id| Step::Replied {
                        id: id.to_owned(),
                        rejected: properties["reply"] == "reject",
                    })
                    .into_iter()
                    .collect();
            }
            // A subagent's own events stay out of the thread's transcript.
            _ if session != self.session => return Vec::new(),
            _ => {}
        }
        match kind {
            "message.updated" => {
                let info = &properties["info"];
                if info["role"] == "user"
                    && let Some(id) = info["id"].as_str()
                {
                    self.prompts.insert(id.to_owned());
                }
                Vec::new()
            }
            "message.part.updated" => self.part(&properties["part"]),
            "message.part.delta" => self.delta(properties),
            "todo.updated" => {
                let items = properties["todos"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .filter_map(|entry| todo(entry, "content"))
                    .collect();
                vec![Step::Emit(Event::TodoList { items })]
            }
            "session.status" => match properties["status"]["type"].as_str() {
                Some("busy") => {
                    self.busy = true;
                    Vec::new()
                }
                Some("retry") => properties["status"]["message"]
                    .as_str()
                    .map(|message| {
                        Step::Emit(Event::Notice {
                            detail: message.to_owned(),
                        })
                    })
                    .into_iter()
                    .collect(),
                _ => Vec::new(),
            },
            "session.idle" if self.busy => {
                self.busy = false;
                vec![Step::Idle]
            }
            // An abort, plxd's own or another client's, ends the turn with the idle after it.
            "session.error" if properties["error"]["name"] == "MessageAbortedError" => Vec::new(),
            "session.error" => {
                let error = &properties["error"];
                let message = error["data"]["message"]
                    .as_str()
                    .or_else(|| error["name"].as_str())
                    .unwrap_or("OpenCode failed the turn");
                // A stack trace follows the first line.
                let message = message.lines().next().unwrap_or(message).to_owned();
                vec![Step::Failed(message)]
            }
            _ => Vec::new(),
        }
    }

    /// A failed result for every call reported but never finished, at the end of a turn: an
    /// aborted turn leaves its calls running, and the app would wait on them.
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

    fn part(&mut self, part: &Value) -> Vec<Step> {
        let (Some(id), Some(message)) = (part["id"].as_str(), part["messageID"].as_str()) else {
            return Vec::new();
        };
        if self.prompts.contains(message) {
            return Vec::new();
        }
        match part["type"].as_str() {
            Some("text") if part["synthetic"] != true => {
                let full = part["text"].as_str().unwrap_or_default();
                let sent = &mut self
                    .parts
                    .entry(id.to_owned())
                    .or_insert(Part {
                        reasoning: false,
                        sent: String::new(),
                    })
                    .sent;
                // What the deltas didn't bring, for a server that sends the whole part.
                match full.strip_prefix(sent.as_str()) {
                    Some(rest) if !rest.is_empty() => {
                        let rest = rest.to_owned();
                        sent.push_str(&rest);
                        self.text.push_str(&rest);
                        vec![Step::Emit(Event::TextDelta {
                            message_id: None,
                            text: rest,
                        })]
                    }
                    _ => Vec::new(),
                }
            }
            // Reasoning goes as one event once its part ends.
            Some("reasoning") => {
                let part_state = self.parts.entry(id.to_owned()).or_insert(Part {
                    reasoning: true,
                    sent: String::new(),
                });
                let text = part["text"].as_str().unwrap_or_default();
                if part["time"]["end"].is_null() || !part_state.sent.is_empty() || text.is_empty() {
                    return Vec::new();
                }
                text.clone_into(&mut part_state.sent);
                vec![Step::Emit(Event::Reasoning {
                    message_id: None,
                    text: text.to_owned(),
                })]
            }
            Some("tool") => self.tool(part),
            Some("step-finish") if self.steps.insert(id.to_owned()) => {
                let tokens = &part["tokens"];
                let count = |value: &Value| value.as_u64().unwrap_or_default();
                let usage = Usage {
                    input_tokens: count(&tokens["input"]),
                    output_tokens: count(&tokens["output"]) + count(&tokens["reasoning"]),
                    cache_read_tokens: count(&tokens["cache"]["read"]),
                    cache_write_tokens: count(&tokens["cache"]["write"]),
                    cost_usd_micros: None,
                };
                (usage != Usage::default())
                    .then_some(Step::Emit(Event::Usage(ModelUsage { model: None, usage })))
                    .into_iter()
                    .collect()
            }
            _ => Vec::new(),
        }
    }

    fn delta(&mut self, properties: &Value) -> Vec<Step> {
        let (Some(id), Some(delta)) = (properties["partID"].as_str(), properties["delta"].as_str())
        else {
            return Vec::new();
        };
        // Reasoning's deltas, and a part never announced (the prompt's own), are skipped.
        let Some(part) = self.parts.get_mut(id).filter(|part| !part.reasoning) else {
            return Vec::new();
        };
        if properties["field"] != "text" || delta.is_empty() {
            return Vec::new();
        }
        part.sent.push_str(delta);
        self.text.push_str(delta);
        vec![Step::Emit(Event::TextDelta {
            message_id: None,
            text: delta.to_owned(),
        })]
    }

    fn tool(&mut self, part: &Value) -> Vec<Step> {
        let (Some(id), Some(tool)) = (part["callID"].as_str(), part["tool"].as_str()) else {
            return Vec::new();
        };
        // `todo.updated` brings the list.
        if matches!(tool, "todowrite" | "todoread") {
            return Vec::new();
        }
        let state = &part["state"];
        if !self.calls.contains_key(id) {
            self.text.clear();
        }
        let call = self.calls.entry(id.to_owned()).or_default();
        call.name = tool_name(tool);
        if state["input"]
            .as_object()
            .is_some_and(|input| !input.is_empty())
        {
            call.input = snake_case(&state["input"]);
        }
        let status = state["status"].as_str();
        let mut steps = Vec::new();
        if matches!(status, Some("running" | "completed" | "error")) && !call.reported {
            call.reported = true;
            steps.push(Step::Emit(Event::ToolCall {
                call_id: id.to_owned(),
                name: call.name.clone(),
                input: call.input.clone(),
            }));
        }
        if matches!(status, Some("completed" | "error")) && !call.finished {
            call.finished = true;
            let (status, output) = if self.denied.contains(id) {
                (ToolStatus::Denied, &state["error"])
            } else if status == Some("error") {
                (ToolStatus::Error, &state["error"])
            } else {
                (ToolStatus::Ok, &state["output"])
            };
            steps.push(Step::Emit(Event::ToolResult {
                call_id: id.to_owned(),
                status,
                output: output.as_str().map(str::to_owned),
            }));
        }
        steps
    }

    fn permission(&mut self, properties: &Value) -> Vec<Step> {
        let Some(id) = properties["id"].as_str() else {
            return Vec::new();
        };
        let path = format!("/permission/{id}/reply");
        let permission = properties["permission"].as_str().unwrap_or_default();
        let call_id = properties["tool"]["callID"].as_str().map(str::to_owned);
        let mut steps = Vec::new();
        // The request can come before the call's running update: the call goes first, with
        // what the request says it does.
        if let Some(id) = &call_id
            && let Some(call) = self.calls.get_mut(id)
        {
            if call.input.is_null() {
                call.input = snake_case(&properties["metadata"]);
            }
            if !call.reported {
                call.reported = true;
                steps.push(Step::Emit(Event::ToolCall {
                    call_id: id.clone(),
                    name: call.name.clone(),
                    input: call.input.clone(),
                }));
            }
        }
        let allowed = match self.permission {
            Some(AgentPermission::Bypass) => true,
            Some(AgentPermission::Edit) => permission == "edit",
            _ => false,
        };
        if allowed {
            let body = json!({"reply": "once"});
            steps.push(Step::Post { path, body });
            return steps;
        }
        if !self.asks {
            if let Some(call_id) = &call_id {
                self.denied.insert(call_id.clone());
            }
            // With a message, `OpenCode` tells the agent and goes on; without, it ends the turn.
            let message = "Parallax denied this: nobody can approve it in this thread.";
            let body = json!({"reply": "reject", "message": message});
            steps.push(Step::Post { path, body });
            return steps;
        }
        let call = call_id.as_deref().and_then(|id| self.calls.get(id));
        let (tool_name, input) = match call {
            Some(call) => (call.name.clone(), call.input.clone()),
            None => (tool_name(permission), snake_case(&properties["metadata"])),
        };
        // OpenCode's own name for what it asks, when the tool alone doesn't say it, such as
        // `external_directory` for a read outside the folder.
        let reason = (call.is_some() && !matches!(permission, "bash" | "edit"))
            .then(|| format!("OpenCode asks for {permission}"));
        let request = ApprovalRequest {
            approval_id: ApprovalId::generate(),
            tool_name,
            input,
            call_id: call_id.clone(),
            reason,
            blocked_path: None,
            subagent: None,
            always_allow: Vec::new(),
            interactive: false,
        };
        let id = id.to_owned();
        steps.push(Step::Ask(request, Ask { id, path, call_id }));
        steps
    }
}

/// The answer to a `question.asked`. The `question` and `plan_exit` tools are denied, but another
/// tool, such as a plugin's, can still ask. The app has no card for a question, so each gets
/// [`QUESTION_ANSWER`], and the agent goes on, where a rejection would end the turn.
fn question(properties: &Value) -> Vec<Step> {
    let answers: Vec<Value> = properties["questions"]
        .as_array()
        .into_iter()
        .flatten()
        .map(|_| json!([QUESTION_ANSWER]))
        .collect();
    properties["id"]
        .as_str()
        .map(|id| Step::Post {
            path: format!("/question/{id}/reply"),
            body: json!({"answers": answers}),
        })
        .into_iter()
        .collect()
}

/// A tool's name as the Claude Code tool the app already draws for it, or `OpenCode`'s own.
fn tool_name(tool: &str) -> String {
    match tool {
        "bash" => "Bash",
        "read" => "Read",
        "edit" | "patch" | "apply_patch" | "multiedit" => "Edit",
        "write" => "Write",
        "grep" => "Grep",
        "glob" => "Glob",
        "list" => "LS",
        "webfetch" => "WebFetch",
        "websearch" => "WebSearch",
        "task" => "Task",
        other => other,
    }
    .to_owned()
}

/// `input` with its keys in Claude Code's snake case, such as `file_path` for `OpenCode`'s
/// `filePath`, which the app reads.
fn snake_case(input: &Value) -> Value {
    let Value::Object(fields) = input else {
        return input.clone();
    };
    let fields: Map<String, Value> = fields
        .iter()
        .map(|(key, value)| {
            let mut snake = String::with_capacity(key.len() + 2);
            for c in key.chars() {
                if c.is_ascii_uppercase() {
                    snake.push('_');
                    snake.push(c.to_ascii_lowercase());
                } else {
                    snake.push(c);
                }
            }
            (snake, value.clone())
        })
        .collect();
    Value::Object(fields)
}
