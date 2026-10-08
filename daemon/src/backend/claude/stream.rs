//! Turning Claude Code's `stream-json` output into [`Event`]s, one line at a time.
//!
//! The shapes follow the Agent SDK's types (0004 [14]) and the headless docs (0004 [11]). Fields
//! Parallax doesn't use are ignored, as 0004 asks, so a newer CLI that adds fields still parses.

use std::collections::HashSet;

use jiff::Timestamp;
use serde_json::{Map, Value};

use super::{
    BYPASS_PERMISSION_MODE, DEFAULT_PERMISSION_MODE, EXIT_PLAN_MODE, NO_WRITE_TOOLS,
    WORKER_MIN_VERSION, WORKER_TOOLS,
};
use crate::backend::event::{
    ApprovalRequest, Event, Failure, FailureKind, LimitStatus, LimitWindow,
    MAX_ALWAYS_ALLOW_RULE_BYTES, MAX_ALWAYS_ALLOW_RULES, ModelUsage, SubagentStatus, TodoItem,
    TodoStatus, ToolStatus, Usage, WarningKind,
};
use crate::backend::{ApprovalId, ToolPolicy};

/// A `major.minor.patch` version, for comparing. Anything after the patch number, such as a
/// pre-release tag, is ignored.
pub(crate) fn version(text: &str) -> Option<(u64, u64, u64)> {
    let mut parts = text.splitn(3, '.');
    let number = |part: Option<&str>| {
        let digits: String = part?.chars().take_while(char::is_ascii_digit).collect();
        digits.parse().ok()
    };
    Some((
        number(parts.next())?,
        number(parts.next())?,
        number(parts.next())?,
    ))
}

/// The tool that only ends the session, which `--tools` leaves in place (the CLI reference).
const END_CONVERSATION: &str = "EndConversation";

/// The provider `result.modelUsage` names for Anthropic's own API, which a subscription uses.
const FIRST_PARTY: &str = "firstParty";

/// `result` subtypes for limits the run set itself, which say nothing about the account.
const RUN_LIMITS: &[&str] = &[
    "error_max_turns",
    "error_max_budget_usd",
    "error_max_structured_output_retries",
];

/// Message types that carry nothing Parallax shows, and are skipped without a log line.
/// `command_lifecycle` tracks a queued message's fate, which `result` already reports.
const IGNORED_TYPES: &[&str] = &[
    "auth_status",
    "command_lifecycle",
    "conversation_reset",
    "keep_alive",
    "prompt_suggestion",
    "stream_event",
    "tool_progress",
    "tool_use_summary",
];

/// The longest failure message kept from the CLI's output.
const MAX_MESSAGE_CHARS: usize = 2000;

/// The modes a `system/init` may report besides the requested one once an `ExitPlanMode` was
/// approved (0031): `default` (Manual), the mode a CLI that started in plan mode leaves it for,
/// and [`DEFAULT_PERMISSION_MODE`], should a newer CLI pick Accept Edits. Anything else still
/// fails the run.
const LEFT_PLAN_MODES: &[&str] = &["default", DEFAULT_PERMISSION_MODE];

/// What one line of output asks the driver to do.
#[derive(Debug, PartialEq)]
pub(super) enum Step {
    /// Send an event.
    Emit(Event),
    /// A model's running total for the session, which becomes a usage delta.
    Total(ModelUsage),
    /// A `result`: a turn, or several the CLI folded into one, ended.
    TurnDone(TurnDone),
    /// The run broke its account or tool policy. The driver stops the CLI at once.
    Violation(Failure),
    /// A `can_use_tool` control request (PLX-222): the event to report, and what answering it
    /// needs. The CLI waits for the answer.
    Ask(ApprovalRequest, Ask),
    /// A `control_cancel_request`: the CLI no longer waits for the answer to this request id.
    Withdraw(String),
    /// A control request plxd doesn't serve, which the driver answers with this error, as the
    /// Agent SDK does, so the CLI never waits on it.
    Refuse {
        /// The request's id.
        request_id: String,
        /// Why.
        error: String,
    },
}

/// What answering a `can_use_tool` request needs (PLX-222).
#[derive(Debug, PartialEq)]
pub(super) struct Ask {
    /// The CLI's id for the request, which the answer repeats.
    pub request_id: String,
    /// The tool call's id, which the answer repeats as `toolUseID`.
    pub tool_use_id: Option<String>,
    /// The tool.
    pub tool_name: String,
    /// The tool's input, which an allow sends back as `updatedInput` unless the user edited it.
    pub input: Value,
    /// The request's allow rules, as `updatedPermissions` for an answer with `always`.
    pub updates: Vec<Value>,
}

/// A `result` message, for the driver's turn bookkeeping.
#[derive(Debug, PartialEq)]
pub(super) struct TurnDone {
    /// The `uuid`s of the user messages the turn consumed, oldest first.
    pub uuids: Vec<String>,
    /// How many sent messages the CLI still had queued, when it says.
    pub queued: Option<u64>,
    /// The turn's final text, when it succeeded.
    pub result: Option<String>,
}

/// The state that reading one run's output needs.
#[derive(Debug)]
#[expect(
    clippy::struct_excessive_bools,
    reason = "independent facts about one run's output, not states of one thing"
)]
pub(super) struct Translator {
    policy: ToolPolicy,
    expected_key_source: &'static str,
    /// plxd's MCP tools were attached, so a no-write run is a coordinator: full Claude Code in
    /// its permission mode (0027), whose `system/init` may list any tool.
    coordinator_tools: bool,
    /// A normal thread's run: full Claude Code in every mode (0034), whose `system/init` may list
    /// any tool, as a bypass worker's may.
    thread: bool,
    /// The permission mode a worker or a coordinator asked for, which its `system/init` must
    /// report.
    permission_mode: &'static str,
    /// The CLI asks plxd before a tool call that would prompt (PLX-222), so its control
    /// requests are plxd's to answer.
    prompts: bool,
    /// A worker's `--tools` named `ExitPlanMode` too (PLX-243), so its `system/init` may list it.
    plan_exit: bool,
    /// The user approved an `ExitPlanMode`, so the CLI left plan mode for the mode it was in
    /// before, which later `system/init`s report.
    left_plan: bool,
    verified: bool,
    session_id: Option<String>,
    denied: HashSet<String>,
    /// The tool calls whose `task_started` named a subagent type, so their `task_notification`
    /// ends a subagent (PLX-382), not a background command.
    subagents: HashSet<String>,
    turn_error: Option<FailureKind>,
    limit_rejected: bool,
    /// How many `result`s arrived.
    pub results: usize,
    /// The last `result`'s failure, if it was one.
    pub last_failure: Option<Failure>,
    /// The last successful `result`'s text.
    pub last_result: Option<String>,
}

impl Translator {
    /// A translator for a run under `policy` whose `system/init` must report
    /// `expected_key_source` as its `apiKeySource`.
    pub fn new(policy: ToolPolicy, expected_key_source: &'static str) -> Self {
        Self {
            policy,
            expected_key_source,
            coordinator_tools: false,
            thread: false,
            permission_mode: DEFAULT_PERMISSION_MODE,
            prompts: false,
            plan_exit: false,
            left_plan: false,
            verified: false,
            session_id: None,
            denied: HashSet::new(),
            subagents: HashSet::new(),
            turn_error: None,
            limit_rejected: false,
            results: 0,
            last_failure: None,
            last_result: None,
        }
    }

    /// Checks `system/init` as a coordinator's when plxd's MCP tools were `attached` (0019, 0027).
    pub fn with_coordinator_tools(mut self, attached: bool) -> Self {
        self.coordinator_tools = attached;
        self
    }

    /// Checks `system/init` as a normal thread's, which may list any tool (0034).
    pub fn with_thread(mut self, thread: bool) -> Self {
        self.thread = thread;
        self
    }

    /// Expects a worker's or a coordinator's `system/init` to report `mode` instead of
    /// [`DEFAULT_PERMISSION_MODE`], for a run that asked for another permission (PLX-97, 0027).
    /// [`BYPASS_PERMISSION_MODE`] also lifts a worker's tool check: it runs as full Claude Code.
    pub fn with_permission_mode(mut self, mode: &'static str) -> Self {
        self.permission_mode = mode;
        self
    }

    /// Takes the CLI's permission requests when it was started with `--permission-prompt-tool
    /// stdio` (PLX-222). Otherwise its control requests are skipped, as before.
    pub fn with_prompts(mut self, prompts: bool) -> Self {
        self.prompts = prompts;
        self
    }

    /// Lets a worker's `system/init` list `ExitPlanMode` besides [`WORKER_TOOLS`], when its
    /// `--tools` named it (`hands_over_plans`, PLX-243).
    pub fn with_plan_exit(mut self, plan_exit: bool) -> Self {
        self.plan_exit = plan_exit;
        self
    }

    /// Accepts [`LEFT_PLAN_MODES`] as well in later `system/init`s: the user approved an
    /// `ExitPlanMode`, and Claude Code then runs in the mode it was in before plan mode, `default`
    /// when it started in plan mode.
    pub fn left_plan_mode(&mut self) {
        self.left_plan = true;
    }

    /// Reads one line of stdout.
    pub fn line(&mut self, line: &[u8]) -> Vec<Step> {
        if line.iter().all(u8::is_ascii_whitespace) {
            return Vec::new();
        }
        let value: Value = match serde_json::from_slice(line) {
            Ok(value) => value,
            Err(error) => return vec![warning(WarningKind::MalformedLine, error.to_string())],
        };
        let Value::Object(message) = value else {
            return vec![warning(
                WarningKind::MalformedLine,
                "a line that is not a JSON object".into(),
            )];
        };
        match text(&message, "type") {
            Some("system") => self.system(&message),
            Some("assistant") => self.assistant(&message),
            Some("user") => self.user(&message),
            Some("result") => self.result(&message),
            Some("rate_limit_event") => self.rate_limit(&message),
            Some("control_request") if self.prompts => self.control_request(&message),
            Some("control_cancel_request") if self.prompts => text(&message, "request_id")
                .map(|id| Step::Withdraw(id.to_owned()))
                .into_iter()
                .collect(),
            Some(kind) if IGNORED_TYPES.contains(&kind) => Vec::new(),
            // A newer CLI's unknown message types stay out of the chat, in the spirit of 0004's
            // "ignore unknown fields". Runs still end and fail through `result` and the exit code.
            Some(kind) => {
                tracing::debug!(kind, "skipped a Claude Code message of an unknown type");
                Vec::new()
            }
            None => vec![warning(
                WarningKind::MalformedLine,
                "a message without a type".into(),
            )],
        }
    }

    fn system(&mut self, message: &Map<String, Value>) -> Vec<Step> {
        match text(message, "subtype") {
            Some("init") => self.init(message),
            Some("permission_denied") => {
                if let Some(id) = text(message, "tool_use_id") {
                    self.denied.insert(id.to_owned());
                }
                Vec::new()
            }
            Some("task_started") => {
                if let (Some(id), Some(_)) =
                    (text(message, "tool_use_id"), text(message, "subagent_type"))
                {
                    self.subagents.insert(id.to_owned());
                }
                Vec::new()
            }
            Some("task_notification") => {
                let Some(call_id) = text(message, "tool_use_id") else {
                    return Vec::new();
                };
                if !self.subagents.remove(call_id) {
                    return Vec::new();
                }
                let status = match text(message, "status") {
                    Some("completed") => SubagentStatus::Completed,
                    Some("failed") => SubagentStatus::Failed,
                    Some("stopped") => SubagentStatus::Stopped,
                    _ => SubagentStatus::Unknown,
                };
                vec![Step::Emit(Event::SubagentFinished {
                    call_id: call_id.to_owned(),
                    status,
                    summary: text(message, "summary")
                        .filter(|summary| !summary.is_empty())
                        .map(str::to_owned),
                })]
            }
            Some("status") if text(message, "status") == Some("compacting") => {
                vec![Step::Emit(Event::ContextCompaction { done: false })]
            }
            Some("compact_boundary") => vec![Step::Emit(Event::ContextCompaction { done: true })],
            Some("api_retry") => {
                let error = text(message, "error").unwrap_or("unknown");
                self.turn_error = Some(api_error_kind(error));
                let attempt = message.get("attempt").and_then(Value::as_u64);
                let max = message.get("max_retries").and_then(Value::as_u64);
                let detail = match (attempt, max) {
                    (Some(attempt), Some(max)) => format!(
                        "Claude Code is retrying a request after an error ({error}), attempt {attempt} of {max}"
                    ),
                    _ => format!("Claude Code is retrying a request after an error ({error})"),
                };
                vec![Step::Emit(Event::Notice { detail })]
            }
            _ => Vec::new(),
        }
    }

    /// `system/init`, which stream-json input repeats at the start of every turn.
    fn init(&mut self, message: &Map<String, Value>) -> Vec<Step> {
        let Some(session_id) = text(message, "session_id") else {
            return vec![warning(
                WarningKind::MalformedLine,
                "an init message without a session id".into(),
            )];
        };
        let source = text(message, "apiKeySource");
        let mut steps = Vec::new();
        if self.session_id.as_deref() != Some(session_id) {
            self.session_id = Some(session_id.to_owned());
            steps.push(Step::Emit(Event::SessionStarted {
                session_id: session_id.to_owned(),
                model: text(message, "model").map(str::to_owned),
                api_key_source: source.map(str::to_owned),
            }));
        }
        if source != Some(self.expected_key_source) {
            let message = match source {
                Some(source) => format!(
                    "Claude Code took its credentials from {source:?} instead of the account's \
                     ({:?}), so Parallax stopped it before it could bill that",
                    self.expected_key_source
                ),
                None => "Claude Code did not say where it took its credentials from, so Parallax \
                         stopped it"
                    .to_owned(),
            };
            steps.push(violation(FailureKind::UnexpectedApiKey, message));
            return steps;
        }
        let coordinator = self.policy == ToolPolicy::NoWrite && self.coordinator_tools;
        let unsandboxed = self.policy == ToolPolicy::WorkspaceWrite
            && (self.thread || self.permission_mode == BYPASS_PERMISSION_MODE);
        let (allowed, run) = match self.policy {
            ToolPolicy::NoWrite if coordinator => (&[][..], "a coordinator run"),
            ToolPolicy::NoWrite => (NO_WRITE_TOOLS, "a no-write run"),
            ToolPolicy::WorkspaceWrite => (WORKER_TOOLS, "a worker run"),
        };
        let tools = message.get("tools").and_then(Value::as_array);
        let Some(tools) = tools else {
            let message = format!("Claude Code did not list its tools in {run}");
            steps.push(violation(FailureKind::PolicyViolation, message));
            return steps;
        };
        // A coordinator, a thread, and a bypass worker are full Claude Code, whose tools are
        // whatever its configuration loads (0027, 0034).
        let offered: Vec<&str> = tools
            .iter()
            .map(|tool| tool.as_str().unwrap_or("<not a string>"))
            .filter(|tool| !allowed.contains(tool) && !self.also_allowed(tool))
            .collect();
        if !coordinator && !unsandboxed && !offered.is_empty() {
            let message = format!(
                "Claude Code offered tools beyond {} in {run}: {}",
                allowed.join(", "),
                offered.join(", ")
            );
            steps.push(violation(FailureKind::PolicyViolation, message));
            return steps;
        }
        if self.policy == ToolPolicy::WorkspaceWrite {
            let reported = text(message, "claude_code_version");
            if reported.and_then(version) < version(WORKER_MIN_VERSION) {
                let message = format!(
                    "Claude Code {} can't sandbox a worker; {WORKER_MIN_VERSION} or later can",
                    reported.unwrap_or("of an unknown version")
                );
                steps.push(violation(FailureKind::PolicyViolation, message));
                return steps;
            }
        }
        // Claude Code writes init before its first request, so this stops the run before any
        // tool runs.
        let mode = text(message, "permissionMode");
        let left_plan = self.left_plan && mode.is_some_and(|mode| LEFT_PLAN_MODES.contains(&mode));
        if (self.policy == ToolPolicy::WorkspaceWrite || coordinator)
            && mode != Some(self.permission_mode)
            && !left_plan
        {
            let reported = match mode {
                Some(mode) => format!("permission mode {mode:?}"),
                None => "no permission mode".to_owned(),
            };
            let danger = if coordinator {
                ""
            } else {
                ", which on Linux lets a worker's commands write all of /home, /tmp, /var, /opt, \
                 /run, /mnt, and /root"
            };
            let message = format!(
                "Claude Code reported {reported} in {run} instead of {expected:?}. It forces \
                 \"default\" when CLAUDE_CODE_SUBPROCESS_ENV_SCRUB is on{danger}. plxd doesn't \
                 set it for this run, so check the env block of Claude Code's managed settings",
                expected = self.permission_mode,
            );
            steps.push(violation(FailureKind::PolicyViolation, message));
            return steps;
        }
        self.verified = true;
        steps
    }

    /// Whether `system/init` may list `tool` whatever the run's policy allows: `EndConversation`,
    /// which `--tools` leaves in place, and `ExitPlanMode` when a worker's `--tools` named it.
    fn also_allowed(&self, tool: &str) -> bool {
        tool == END_CONVERSATION || (self.plan_exit && tool == EXIT_PLAN_MODE)
    }

    fn assistant(&mut self, message: &Map<String, Value>) -> Vec<Step> {
        if !self.verified {
            return vec![unverified()];
        }
        if let Some(error) = text(message, "error") {
            self.turn_error = Some(api_error_kind(error));
        }
        let Some(inner) = message.get("message").and_then(Value::as_object) else {
            return vec![warning(
                WarningKind::MalformedLine,
                "an assistant message without a message".into(),
            )];
        };
        let message_id = text(inner, "id").map(str::to_owned);
        let blocks = inner.get("content").and_then(Value::as_array);
        let mut steps = Vec::new();
        for block in blocks.into_iter().flatten().filter_map(Value::as_object) {
            match text(block, "type") {
                Some("text") => {
                    if let Some(text) = text(block, "text").filter(|text| !text.is_empty()) {
                        steps.push(Step::Emit(Event::Text {
                            message_id: message_id.clone(),
                            text: text.to_owned(),
                        }));
                    }
                }
                Some("thinking") => {
                    if let Some(text) = text(block, "thinking").filter(|text| !text.is_empty()) {
                        steps.push(Step::Emit(Event::Reasoning {
                            message_id: message_id.clone(),
                            text: text.to_owned(),
                        }));
                    }
                }
                Some("tool_use") => {
                    let (Some(id), Some(name)) = (text(block, "id"), text(block, "name")) else {
                        steps.push(warning(
                            WarningKind::MalformedLine,
                            "a tool call without an id or a name".into(),
                        ));
                        continue;
                    };
                    let input = block.get("input").cloned().unwrap_or(Value::Null);
                    let todos = (name == "TodoWrite").then(|| todo_list(&input)).flatten();
                    steps.push(Step::Emit(Event::ToolCall {
                        call_id: id.to_owned(),
                        name: name.to_owned(),
                        input,
                    }));
                    if let Some(items) = todos {
                        steps.push(Step::Emit(Event::TodoList { items }));
                    }
                }
                _ => {}
            }
        }
        in_subagent(message, text(inner, "model"), steps)
    }

    fn user(&mut self, message: &Map<String, Value>) -> Vec<Step> {
        let blocks = message
            .get("message")
            .and_then(|inner| inner.get("content"))
            .and_then(Value::as_array);
        let mut steps = Vec::new();
        for block in blocks.into_iter().flatten().filter_map(Value::as_object) {
            if text(block, "type") != Some("tool_result") {
                continue;
            }
            let Some(call_id) = text(block, "tool_use_id") else {
                steps.push(warning(
                    WarningKind::MalformedLine,
                    "a tool result without a tool_use_id".into(),
                ));
                continue;
            };
            let status = if self.denied.remove(call_id) {
                ToolStatus::Denied
            } else if block.get("is_error").and_then(Value::as_bool) == Some(true) {
                ToolStatus::Error
            } else {
                ToolStatus::Ok
            };
            steps.push(Step::Emit(Event::ToolResult {
                call_id: call_id.to_owned(),
                status,
                output: block.get("content").and_then(tool_output),
            }));
        }
        in_subagent(message, None, steps)
    }

    fn result(&mut self, message: &Map<String, Value>) -> Vec<Step> {
        let subtype = text(message, "subtype").unwrap_or_default();
        let failed =
            subtype != "success" || message.get("is_error").and_then(Value::as_bool) == Some(true);
        if !self.verified && !failed {
            return vec![unverified()];
        }
        let totals = message.get("modelUsage").and_then(Value::as_object);
        let providers: Vec<&str> = totals
            .into_iter()
            .flatten()
            .filter_map(|(_, usage)| usage.get("provider").and_then(Value::as_str))
            .filter(|provider| *provider != FIRST_PARTY)
            .collect();
        if !providers.is_empty() {
            let message = format!(
                "Claude Code used the model through {} instead of Anthropic's API, so the run was \
                 not charged to the account",
                providers.join(", ")
            );
            return vec![violation(FailureKind::UnexpectedApiKey, message)];
        }
        self.results += 1;
        let result = text(message, "result").map(str::to_owned);
        let mut steps = Vec::new();
        for (model, usage) in totals.into_iter().flatten() {
            let usage = model_usage(usage);
            if !is_zero(&usage) {
                steps.push(Step::Total(ModelUsage {
                    model: Some(model.clone()),
                    usage,
                }));
            }
        }
        if failed {
            let failure = if RUN_LIMITS.contains(&subtype) {
                FailureKind::VendorError
            } else if self.limit_rejected {
                FailureKind::RateLimited
            } else if let Some(kind) = self.turn_error {
                kind
            } else if result.as_deref().is_some_and(signed_out) {
                FailureKind::NotSignedIn
            } else {
                FailureKind::VendorError
            };
            let errors: Vec<&str> = message
                .get("errors")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
                .filter_map(Value::as_str)
                .collect();
            let text = match (&result, errors.is_empty()) {
                (Some(result), _) if !result.is_empty() => result.clone(),
                (_, false) => errors.join("; "),
                _ => format!("Claude Code ended the turn with {subtype:?}"),
            };
            self.last_failure = Some(Failure::new(failure, truncate(&text)));
            self.last_result = None;
        } else {
            self.last_failure = None;
            self.last_result.clone_from(&result);
        }
        self.turn_error = None;
        self.limit_rejected = false;
        let uuids = match message.get("user_message_uuids").and_then(Value::as_array) {
            Some(uuids) => uuids
                .iter()
                .filter_map(Value::as_str)
                .map(str::to_owned)
                .collect(),
            None => text(message, "user_message_uuid")
                .map(str::to_owned)
                .into_iter()
                .collect(),
        };
        steps.push(Step::TurnDone(TurnDone {
            uuids,
            queued: message.get("queued_turn_count").and_then(Value::as_u64),
            result: if failed { None } else { result },
        }));
        steps
    }

    /// A `control_request` from a CLI started with `--permission-prompt-tool stdio`: a
    /// `can_use_tool` asks whether a tool call may run, and any other subtype is refused.
    fn control_request(&self, message: &Map<String, Value>) -> Vec<Step> {
        let Some(request_id) = text(message, "request_id") else {
            return vec![warning(
                WarningKind::MalformedLine,
                "a control request without a request_id".into(),
            )];
        };
        let refuse = |error: String| Step::Refuse {
            request_id: request_id.to_owned(),
            error,
        };
        let request = message.get("request").and_then(Value::as_object);
        let subtype = request.and_then(|request| text(request, "subtype"));
        let (Some(request), Some("can_use_tool")) = (request, subtype) else {
            let subtype = subtype.unwrap_or("untyped");
            return vec![refuse(format!(
                "plxd doesn't answer {subtype} control requests"
            ))];
        };
        // A permission request follows the model's turn, so it can't come before init.
        if !self.verified {
            return vec![unverified()];
        }
        let Some(tool_name) = text(request, "tool_name") else {
            return vec![refuse("a can_use_tool request without a tool_name".into())];
        };
        let input = request
            .get("input")
            .cloned()
            .unwrap_or_else(|| Value::Object(Map::new()));
        let suppressed = request
            .get("suppress_always_allow_rule")
            .and_then(Value::as_bool)
            == Some(true);
        let (updates, rules) = if suppressed {
            (Vec::new(), Vec::new())
        } else {
            allow_rules(request.get("permission_suggestions"))
        };
        let tool_use_id = text(request, "tool_use_id").map(str::to_owned);
        let event = ApprovalRequest {
            approval_id: ApprovalId::generate(),
            tool_name: tool_name.to_owned(),
            input: input.clone(),
            call_id: tool_use_id.clone(),
            reason: text(request, "decision_reason")
                .map(plain)
                .filter(|reason| !reason.trim().is_empty()),
            blocked_path: text(request, "blocked_path").map(str::to_owned),
            subagent: text(request, "agent_id").map(str::to_owned),
            always_allow: rules,
            interactive: request
                .get("requires_user_interaction")
                .and_then(Value::as_bool)
                == Some(true),
        };
        let ask = Ask {
            request_id: request_id.to_owned(),
            tool_use_id,
            tool_name: tool_name.to_owned(),
            input,
            updates,
        };
        vec![Step::Ask(event, ask)]
    }

    fn rate_limit(&mut self, message: &Map<String, Value>) -> Vec<Step> {
        let Some(info) = message.get("rate_limit_info").and_then(Value::as_object) else {
            return vec![warning(
                WarningKind::MalformedLine,
                "a rate limit event without rate_limit_info".into(),
            )];
        };
        let status = match text(info, "status") {
            Some("allowed") => LimitStatus::Allowed,
            Some("allowed_warning") => LimitStatus::Warning,
            Some("rejected") => LimitStatus::Rejected,
            _ => LimitStatus::Unknown,
        };
        self.limit_rejected |= status == LimitStatus::Rejected;
        let window = text(info, "rateLimitType").unwrap_or("unknown");
        let duration_minutes = match window {
            "five_hour" => Some(5 * 60),
            window if window.starts_with("seven_day") => Some(7 * 24 * 60),
            _ => None,
        };
        vec![Step::Emit(Event::RateLimit(LimitWindow {
            window: window.to_owned(),
            duration_minutes,
            used_percent: info.get("utilization").and_then(Value::as_f64).map(percent),
            status,
            resets_at: info.get("resetsAt").and_then(timestamp),
        }))]
    }
}

/// `steps`, with each event wrapped as a subagent's when `message` came from one of the agent's
/// own subagents (PLX-382): it names the tool call that started it as `parent_tool_use_id`, and
/// its type as `subagent_type`. `model` is the model that wrote an assistant message.
fn in_subagent(message: &Map<String, Value>, model: Option<&str>, steps: Vec<Step>) -> Vec<Step> {
    let Some(call_id) = text(message, "parent_tool_use_id") else {
        return steps;
    };
    let agent_type = text(message, "subagent_type");
    steps
        .into_iter()
        .map(|step| match step {
            Step::Emit(event @ Event::Warning { .. }) => Step::Emit(event),
            Step::Emit(event) => Step::Emit(Event::Subagent {
                call_id: call_id.to_owned(),
                agent_type: agent_type.map(str::to_owned),
                model: model.map(str::to_owned),
                event: Box::new(event),
            }),
            step => step,
        })
        .collect()
}

fn text<'a>(object: &'a Map<String, Value>, key: &str) -> Option<&'a str> {
    object.get(key).and_then(Value::as_str)
}

fn warning(warning: WarningKind, detail: String) -> Step {
    Step::Emit(Event::Warning { warning, detail })
}

fn violation(failure: FailureKind, message: String) -> Step {
    Step::Violation(Failure::new(failure, message))
}

/// Output before a `system/init` passed the credential check: the CLI may already be using
/// credentials nobody checked.
fn unverified() -> Step {
    violation(
        FailureKind::UnexpectedApiKey,
        "Claude Code answered before it reported its credentials, so Parallax stopped it".into(),
    )
}

/// The failure an `assistant` message's `error` points to.
fn api_error_kind(error: &str) -> FailureKind {
    match error {
        "authentication_failed" | "oauth_org_not_allowed" => FailureKind::NotSignedIn,
        "rate_limit" => FailureKind::RateLimited,
        _ => FailureKind::VendorError,
    }
}

/// Whether a failed turn's text says the CLI isn't signed in, which the headless docs say is
/// reported as the result (0004 [11]).
fn signed_out(result: &str) -> bool {
    let result = result.to_ascii_lowercase();
    result.contains("not logged in") || result.contains("/login")
}

/// The allow rules among a `can_use_tool` request's `permission_suggestions`, as updates that
/// last the rest of the CLI process, and as `Tool(content)` for people (PLX-222). Their own
/// destination, often a settings file, is replaced with `session`. Every other suggestion, such
/// as a mode or an added directory, is dropped: an added directory would let a worker's file
/// tools out of its worktree. Only the rules `approvalRequested` shows whole are kept, at most
/// [`MAX_ALWAYS_ALLOW_RULES`], so an answer with `always` adds nothing the user didn't see.
fn allow_rules(suggestions: Option<&Value>) -> (Vec<Value>, Vec<String>) {
    let mut updates = Vec::new();
    let mut names = Vec::new();
    for suggestion in suggestions.and_then(Value::as_array).into_iter().flatten() {
        if suggestion.get("type").and_then(Value::as_str) != Some("addRules")
            || suggestion.get("behavior").and_then(Value::as_str) != Some("allow")
        {
            continue;
        }
        let mut rules = Vec::new();
        for rule in suggestion
            .get("rules")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
        {
            let Some(tool) = rule.get("toolName").and_then(Value::as_str) else {
                continue;
            };
            let name = match rule.get("ruleContent").and_then(Value::as_str) {
                Some(content) => format!("{tool}({content})"),
                None => tool.to_owned(),
            };
            if name.len() <= MAX_ALWAYS_ALLOW_RULE_BYTES && names.len() < MAX_ALWAYS_ALLOW_RULES {
                names.push(name);
                rules.push(rule);
            }
        }
        if rules.is_empty() {
            continue;
        }
        updates.push(serde_json::json!({
            "type": "addRules",
            "rules": rules,
            "behavior": "allow",
            "destination": "session",
        }));
    }
    (updates, names)
}

/// `text` without terminal escape sequences or control characters other than line breaks and
/// tabs, which a `decision_reason` may carry (the Agent SDK's types).
fn plain(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut chars = text.chars();
    while let Some(c) = chars.next() {
        if c == '\u{1b}' {
            skip_escape(&mut chars);
        } else if !c.is_control() || c == '\n' || c == '\t' {
            out.push(c);
        }
    }
    out
}

/// Skips the rest of a terminal escape sequence whose ESC `chars` just read.
fn skip_escape(chars: &mut std::str::Chars<'_>) {
    match chars.next() {
        // A CSI sequence ends at its final byte, from `@` to `~`.
        Some('[') => {
            for c in chars.by_ref() {
                if ('@'..='~').contains(&c) {
                    return;
                }
            }
        }
        // An OSC sequence ends at BEL, or at ESC and `\`.
        Some(']') => {
            let mut escaped = false;
            for c in chars.by_ref() {
                if c == '\u{7}' || (escaped && c == '\\') {
                    return;
                }
                escaped = c == '\u{1b}';
            }
        }
        _ => {}
    }
}

/// A `tool_result`'s content: a string, or text blocks.
fn tool_output(content: &Value) -> Option<String> {
    let text = match content {
        Value::String(text) => text.clone(),
        Value::Array(blocks) => blocks
            .iter()
            .filter_map(|block| block.get("text").and_then(Value::as_str))
            .collect::<Vec<_>>()
            .join("\n"),
        _ => return None,
    };
    (!text.is_empty()).then_some(text)
}

/// `TodoWrite`'s `todos`, as a checklist.
fn todo_list(input: &Value) -> Option<Vec<TodoItem>> {
    let todos = input.get("todos")?.as_array()?;
    Some(
        todos
            .iter()
            .filter_map(|todo| {
                Some(TodoItem {
                    text: todo.get("content")?.as_str()?.to_owned(),
                    status: match todo.get("status").and_then(Value::as_str) {
                        Some("pending") => TodoStatus::Pending,
                        Some("in_progress") => TodoStatus::InProgress,
                        Some("completed") => TodoStatus::Completed,
                        _ => TodoStatus::Unknown,
                    },
                })
            })
            .collect(),
    )
}

/// One entry of `result.modelUsage`.
fn model_usage(usage: &Value) -> Usage {
    let count = |key| usage.get(key).and_then(Value::as_u64).unwrap_or(0);
    Usage {
        input_tokens: count("inputTokens"),
        output_tokens: count("outputTokens"),
        cache_read_tokens: count("cacheReadInputTokens"),
        cache_write_tokens: count("cacheCreationInputTokens"),
        cost_usd_micros: usage
            .get("costUSD")
            .and_then(Value::as_f64)
            .and_then(micros),
    }
}

/// Whether a total counts nothing. A result after a crash can carry zeroed totals (0004 [15]);
/// taking those as the session's totals would count everything again on the next resume.
fn is_zero(usage: &Usage) -> bool {
    usage.input_tokens == 0
        && usage.output_tokens == 0
        && usage.cache_read_tokens == 0
        && usage.cache_write_tokens == 0
        && usage.cost_usd_micros.unwrap_or(0) == 0
}

#[expect(
    clippy::cast_possible_truncation,
    clippy::cast_sign_loss,
    reason = "a finite, non-negative cost in dollars fits in u64 micros"
)]
pub(crate) fn micros(usd: f64) -> Option<u64> {
    (usd.is_finite() && usd >= 0.0).then(|| (usd * 1_000_000.0).round() as u64)
}

/// `utilization` as a percentage. The SDK types don't say its scale; `get_usage` reports 0 to
/// 100, while the rate limit event is taken to be a fraction from 0 to 1. Until a recorded
/// transcript settles it (#124), a value above 1 is read as a percentage already.
fn percent(utilization: f64) -> f64 {
    if utilization <= 1.0 {
        utilization * 100.0
    } else {
        utilization
    }
}

/// Epoch seconds, whole or fractional, to millisecond precision.
#[expect(
    clippy::cast_possible_truncation,
    reason = "a finite number of milliseconds since 1970 fits in i64 for any date jiff accepts"
)]
fn timestamp(seconds: &Value) -> Option<Timestamp> {
    if let Some(seconds) = seconds.as_i64() {
        return Timestamp::from_second(seconds).ok();
    }
    let seconds = seconds.as_f64().filter(|seconds| seconds.is_finite())?;
    Timestamp::from_millisecond((seconds * 1000.0).round() as i64).ok()
}

fn truncate(text: &str) -> String {
    match text.char_indices().nth(MAX_MESSAGE_CHARS) {
        Some((end, _)) => format!("{}...", &text[..end]),
        None => text.to_owned(),
    }
}
