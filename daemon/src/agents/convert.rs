//! Mapping between the runner's inputs and outputs: backend events to the protocol's transcript
//! items, and store rows to the protocol's runs.

use jiff::Timestamp;
use parallax_protocol::jsonrpc::ErrorObject;
use parallax_protocol::{
    AgentApproveResult, AgentFailureKind, AgentMerge, AgentMergeKind, AgentOutcome,
    AgentOutputItem, AgentPolicy, AgentRun, AgentRunState, AgentStatus, ApprovalId,
    CoordinatorThreadId, DiffSummary, ProjectId, RunId,
};
use serde::Serialize;
use serde::de::DeserializeOwned;
use serde_json::{Value, json};
use tracing::error;

use crate::backend::event::{MAX_ALWAYS_ALLOW_RULE_BYTES, MAX_ALWAYS_ALLOW_RULES};
use crate::backend::{ApprovalRequest, Event, FailureKind, Outcome, TodoItem};
use crate::json::escaped_len;
use crate::worktree::MergeHow;

/// The longest tool output an `agent.output` item carries, in bytes. The rest is cut, since the
/// full output stays in the CLI's own session and 0007 caps a frame at 8 MiB.
pub(super) const MAX_TOOL_OUTPUT_BYTES: usize = 32 * 1024;

/// The largest tool input an `agent.output` item carries as JSON, in bytes. A larger one, such as
/// a `Write` of a big file, becomes `{"truncated": true, "bytes": n}`.
pub(super) const MAX_TOOL_INPUT_BYTES: usize = 32 * 1024;

/// The largest tool input an `approvalRequested` item carries as JSON, in bytes (PLX-222): more
/// than a tool call's, since the user has to see what they allow, such as a long plan.
pub(super) const MAX_APPROVAL_INPUT_BYTES: usize = 256 * 1024;

/// The longest free text field of any other `agent.output` item — `Text`, `TextDelta`,
/// `Reasoning`, `Notice.detail`, `Warning.detail`, `TurnFinished.result`, `TurnStarted.text` — in
/// bytes, at the same cap as a tool's output (#190 N8). Without this, one item near 0007's 8 MiB
/// frame would close every subscriber and then be replayed again on every reconnect.
pub(crate) const MAX_TEXT_ITEM_BYTES: usize = 32 * 1024;

/// The longest a short identifier gets to be, in bytes: `ToolCall`'s `call_id` and `name`,
/// `ToolResult`'s `call_id`, `SessionStarted`'s `session_id` and `model`, and every `message_id`.
/// These are meant to be short, vendor-assigned tokens; this is defense in depth against a vendor
/// bug or a hostile CLI reporting one that isn't (#190 review).
pub(super) const MAX_ID_BYTES: usize = 1024;

/// The longest one `TodoList` item's `text` gets to be, in bytes.
pub(super) const MAX_TODO_TEXT_BYTES: usize = 4 * 1024;

/// The most a `TodoList`'s items add up to, counted as JSON-escaped bytes rather than raw ones
/// (#190 review): a raw count could undercount a list whose text needs a lot of escaping, letting
/// the list's real JSON size run well past what the raw count suggested. Items past this are
/// dropped, not only their text, since even a short text per item adds up at an unbounded count.
pub(super) const MAX_TODO_LIST_BYTES: usize = 64 * 1024;

pub(crate) const STARTING: &str = "starting";
pub(crate) const RUNNING: &str = "running";
pub(super) const COMPLETED: &str = "completed";
pub(super) const FAILED: &str = "failed";
pub(super) const CANCELLED: &str = "cancelled";
pub(super) const INTERRUPTED: &str = "interrupted";
pub(crate) const WAITING: &str = "waiting";
pub(super) const ACCEPTED: &str = "accepted";

/// The store's text for the only policy `agent/start` takes.
pub(super) const WORKSPACE_WRITE: &str = "workspaceWrite";

/// The store's text for a project coordinator's policy (0024).
pub(crate) const NO_WRITE: &str = "noWrite";

/// The protocol's status for a run row's stored `status`.
pub(crate) fn status(text: &str) -> AgentStatus {
    match text {
        STARTING => AgentStatus::Starting,
        RUNNING => AgentStatus::Running,
        COMPLETED => AgentStatus::Completed,
        FAILED => AgentStatus::Failed,
        CANCELLED => AgentStatus::Cancelled,
        INTERRUPTED => AgentStatus::Interrupted,
        WAITING => AgentStatus::Waiting,
        ACCEPTED => AgentStatus::Accepted,
        _ => AgentStatus::Unknown,
    }
}

/// A store row and its worktree as the protocol's run.
///
/// plxd writes only version 7 ids, so a row with another kind of id was written by something
/// else, and the request fails rather than hide the row.
pub(crate) fn agent_run(
    row: &parallax_store::Run,
    worktree: Option<&parallax_store::Worktree>,
) -> Result<AgentRun, ErrorObject> {
    let corrupt = |what: &str| {
        error!(run = %row.id, what, "a stored run has an invalid id");
        ErrorObject::internal_error(format!("the stored run {} has an invalid {what}", row.id))
    };
    let id = RunId::try_from(row.id).map_err(|_| corrupt("id"))?;
    let project = ProjectId::try_from(row.fields.project_id).map_err(|_| corrupt("project id"))?;
    let state = &row.state;
    Ok(AgentRun {
        id,
        project,
        prompt: row.fields.prompt.clone(),
        policy: match row.fields.policy.as_str() {
            WORKSPACE_WRITE => AgentPolicy::WorkspaceWrite,
            NO_WRITE => AgentPolicy::NoWrite,
            _ => AgentPolicy::Unknown,
        },
        status: status(&state.status),
        backend: row.fields.backend.clone(),
        account_id: state.account_id.clone(),
        branch: worktree.map(|worktree| worktree.branch.clone()),
        worktree_path: worktree.map(|worktree| worktree.path.clone()),
        base_dirty: worktree.is_some_and(|worktree| worktree.base_dirty),
        session_id: state.session_id.clone(),
        error: state.error.clone(),
        diff: diff(state),
        coordinator_thread: row
            .fields
            .coordinator_thread
            .map(CoordinatorThreadId::try_from)
            .transpose()
            .map_err(|_| corrupt("coordinator thread id"))?,
        model: row.fields.model.clone(),
        effort: row.fields.effort.as_deref().and_then(option_value),
        permission: row.fields.permission.as_deref().and_then(option_value),
        context_window: row.fields.context_window,
        fast: row.fields.fast,
        approvals: row.fields.approvals,
        checkout: row.fields.checkout,
        explore: row.fields.explore,
        pull_requests: state.pull_requests.clone(),
        resume_at: state.resume_at,
        auto_resume: state.auto_resume,
        created_at: row.created_at,
        updated_at: row.updated_at,
    })
}

/// An effort's or a permission's protocol name, such as `high`, as the runs table stores it.
pub(crate) fn option_name(value: impl Serialize) -> Option<String> {
    serde_json::to_value(value)
        .ok()?
        .as_str()
        .map(str::to_owned)
}

/// A stored effort or permission, back from its protocol name: `Unknown` for a name this version
/// doesn't know.
pub(crate) fn option_value<T: DeserializeOwned>(name: &str) -> Option<T> {
    serde_json::from_value(Value::String(name.to_owned())).ok()
}

/// The part of a stored run that `agent.updated` reports.
pub(super) fn run_state(row: &parallax_store::Run) -> AgentRunState {
    let state = &row.state;
    AgentRunState {
        status: status(&state.status),
        account_id: state.account_id.clone(),
        backend: Some(row.fields.backend.clone()),
        session_id: state.session_id.clone(),
        error: state.error.clone(),
        diff: diff(state),
        model: row.fields.model.clone(),
        effort: row.fields.effort.as_deref().and_then(option_value),
        permission: row.fields.permission.as_deref().and_then(option_value),
        context_window: row.fields.context_window,
        fast: row.fields.fast,
        pull_requests: state.pull_requests.clone(),
        resume_at: state.resume_at,
        auto_resume: state.auto_resume,
        branch: None,
        updated_at: row.updated_at,
    }
}

/// The store's text for how `agent/accept` merged a run.
pub(super) fn merge_how_text(how: MergeHow) -> &'static str {
    match how {
        MergeHow::FastForward => "fastForward",
        MergeHow::Merge => "merge",
        MergeHow::UpToDate => "upToDate",
    }
}

/// A stored accept as the protocol's merge.
pub(super) fn merge(accept: &parallax_store::RunAccept) -> AgentMerge {
    AgentMerge {
        commit: accept.commit.clone(),
        into: accept.into.clone(),
        how: match accept.how.as_str() {
            "fastForward" => AgentMergeKind::FastForward,
            "merge" => AgentMergeKind::Merge,
            "upToDate" => AgentMergeKind::UpToDate,
            _ => AgentMergeKind::Unknown,
        },
    }
}

fn diff(state: &parallax_store::RunState) -> Option<DiffSummary> {
    match (
        &state.commit_sha,
        state.files_changed,
        state.insertions,
        state.deletions,
    ) {
        (Some(commit), Some(files), Some(insertions), Some(deletions)) => Some(DiffSummary {
            commit: commit.clone(),
            files,
            insertions,
            deletions,
        }),
        _ => None,
    }
}

pub(super) fn failure_kind(kind: FailureKind) -> AgentFailureKind {
    match kind {
        FailureKind::NotSignedIn => AgentFailureKind::NotSignedIn,
        FailureKind::RateLimited => AgentFailureKind::RateLimited,
        FailureKind::PolicyViolation => AgentFailureKind::PolicyViolation,
        FailureKind::UnexpectedApiKey => AgentFailureKind::UnexpectedApiKey,
        FailureKind::VendorError | FailureKind::SessionNotFound => AgentFailureKind::VendorError,
        FailureKind::Crashed => AgentFailureKind::Crashed,
        FailureKind::SpawnFailed => AgentFailureKind::SpawnFailed,
        FailureKind::Internal | FailureKind::Other => AgentFailureKind::Internal,
    }
}

/// A backend outcome as the protocol's, and the run status it leaves the run in.
pub(super) fn outcome(outcome: &Outcome) -> (AgentOutcome, &'static str, Option<String>) {
    match outcome {
        Outcome::Completed { result } => (
            AgentOutcome::Completed {
                result: result.clone(),
            },
            COMPLETED,
            None,
        ),
        Outcome::Cancelled => (AgentOutcome::Cancelled, CANCELLED, None),
        Outcome::Failed(failure) => (
            AgentOutcome::Failed {
                failure: failure_kind(failure.failure),
                message: failure.message.clone(),
            },
            FAILED,
            Some(failure.message.clone()),
        ),
        Outcome::Unknown => {
            let message = "the run ended in a way this plxd does not know".to_owned();
            (
                AgentOutcome::Failed {
                    failure: AgentFailureKind::Internal,
                    message: message.clone(),
                },
                FAILED,
                Some(message),
            )
        }
    }
}

/// `text` cut to at most `max` bytes on a character boundary, with a note when it was cut.
pub(crate) fn truncate(text: &str, max: usize) -> String {
    if text.len() <= max {
        return text.to_owned();
    }
    let mut end = max;
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    format!("{}\n... ({} bytes cut)", &text[..end], text.len() - end)
}

/// A vendor-reported `message_id`, capped like any other identifier (#190 review).
fn id(message_id: Option<&str>) -> Option<String> {
    message_id.map(|id| truncate(id, MAX_ID_BYTES))
}

fn tool_input(input: &Value) -> Value {
    capped_input(input, MAX_TOOL_INPUT_BYTES)
}

/// `input`, or `{"truncated": true, "bytes": n}` when its JSON is over `max` bytes.
fn capped_input(input: &Value, max: usize) -> Value {
    let bytes = serde_json::to_string(input).map_or(0, |json| json.len());
    if bytes > max {
        json!({"truncated": true, "bytes": bytes})
    } else {
        input.clone()
    }
}

/// `items`, each truncated to `MAX_TODO_TEXT_BYTES`, kept only while the list's running total
/// stays within `MAX_TODO_LIST_BYTES` (#190 review): the total is counted in JSON-escaped bytes
/// (`escaped_len`, as `serde_json` writes a string), not raw ones, so text that needs a lot of
/// escaping can't make the list's real JSON size exceed the cap. Always keeps at least one item,
/// matching how the log's own paging never returns an empty, non-progressing page.
fn capped_todo_items(items: &[TodoItem]) -> Vec<TodoItem> {
    let mut capped = Vec::new();
    let mut bytes = 0;
    for item in items {
        let text = truncate(&item.text, MAX_TODO_TEXT_BYTES);
        // + 2 for the quotes JSON puts around the string; a rough but conservative stand-in for
        // the rest of the item's own JSON (the status field, braces, and separators).
        let size = escaped_len(&text) + 2;
        if !capped.is_empty() && bytes + size > MAX_TODO_LIST_BYTES {
            break;
        }
        bytes += size;
        capped.push(TodoItem {
            text,
            status: item.status,
        });
    }
    capped
}

/// The transcript item for a backend event, or `None` for an event that isn't part of the
/// transcript: limits, fallbacks, and the run's end, which the runner reports on their own.
pub(super) fn output_item(event: &Event) -> Option<AgentOutputItem> {
    Some(match event {
        Event::SessionStarted {
            session_id, model, ..
        } => AgentOutputItem::SessionStarted {
            session_id: truncate(session_id, MAX_ID_BYTES),
            model: model.as_deref().map(|model| truncate(model, MAX_ID_BYTES)),
        },
        // The backend knows only the id; the run's actor adds a follow-up's text (PLX-92), marks
        // a coordinator's wake-up (PLX-42), and lists the message's images (PLX-191) and
        // attached threads (PLX-372).
        Event::TurnStarted { turn_id } => AgentOutputItem::TurnStarted {
            turn_id: *turn_id,
            text: None,
            wake: false,
            from: None,
            images: Vec::new(),
            threads: Vec::new(),
        },
        Event::TextDelta { message_id, text } => AgentOutputItem::TextDelta {
            message_id: id(message_id.as_deref()),
            text: truncate(text, MAX_TEXT_ITEM_BYTES),
        },
        Event::Text { message_id, text } => AgentOutputItem::Text {
            message_id: id(message_id.as_deref()),
            text: truncate(text, MAX_TEXT_ITEM_BYTES),
        },
        Event::ToolCall {
            call_id,
            name,
            input,
        } => AgentOutputItem::ToolCall {
            call_id: truncate(call_id, MAX_ID_BYTES),
            name: truncate(name, MAX_ID_BYTES),
            input: tool_input(input),
        },
        Event::ToolResult {
            call_id,
            status,
            output,
            ..
        } => AgentOutputItem::ToolResult {
            call_id: truncate(call_id, MAX_ID_BYTES),
            status: *status,
            output: output
                .as_deref()
                .map(|output| truncate(output, MAX_TOOL_OUTPUT_BYTES)),
            // The actor stores the images and fills in their ids.
            images: Vec::new(),
        },
        Event::Reasoning { message_id, text } => AgentOutputItem::Reasoning {
            message_id: id(message_id.as_deref()),
            text: truncate(text, MAX_TEXT_ITEM_BYTES),
        },
        Event::TodoList { items } => AgentOutputItem::TodoList {
            items: capped_todo_items(items),
        },
        Event::Notice { detail } => AgentOutputItem::Notice {
            detail: truncate(detail, MAX_TEXT_ITEM_BYTES),
        },
        Event::ContextCompaction { done } => AgentOutputItem::ContextCompaction { done: *done },
        Event::Usage(delta) => AgentOutputItem::Usage {
            model: delta.model.clone(),
            input_tokens: delta.usage.input_tokens,
            output_tokens: delta.usage.output_tokens,
            cache_read_tokens: delta.usage.cache_read_tokens,
            cache_write_tokens: delta.usage.cache_write_tokens,
            cost_usd_micros: delta.usage.cost_usd_micros,
        },
        Event::TurnFinished {
            turn_id, result, ..
        } => AgentOutputItem::TurnFinished {
            turn_id: *turn_id,
            result: result
                .as_deref()
                .map(|result| truncate(result, MAX_TEXT_ITEM_BYTES)),
            // The run's actor fills them from the turn's `TurnCursor`, which comes just before.
            cursor: None,
            session_id: None,
        },
        Event::FollowUpDropped { turn_id } => {
            AgentOutputItem::FollowUpDropped { turn_id: *turn_id }
        }
        Event::Warning { detail, .. } => AgentOutputItem::Warning {
            detail: truncate(detail, MAX_TEXT_ITEM_BYTES),
        },
        Event::Subagent { .. } | Event::SubagentFinished { .. } => return subagent_item(event),
        // The run's actor reports permission requests and how they end.
        Event::ApprovalRequested(_)
        | Event::ApprovalWithdrawn { .. }
        | Event::RequestUsage(_)
        | Event::TurnCursor { .. }
        | Event::RateLimit(_)
        | Event::AccountFallback { .. }
        | Event::BackgroundTasks { .. }
        | Event::Finished { .. }
        | Event::Unknown => return None,
    })
}

/// The transcript item for one of the agent's own subagents' events (PLX-382). Its own item is
/// capped as the agent's would be, and left out where the agent's would be.
fn subagent_item(event: &Event) -> Option<AgentOutputItem> {
    Some(match event {
        Event::Subagent {
            call_id,
            agent_type,
            model,
            event,
        } => AgentOutputItem::Subagent {
            call_id: truncate(call_id, MAX_ID_BYTES),
            agent_type: agent_type
                .as_deref()
                .map(|kind| truncate(kind, MAX_ID_BYTES)),
            model: model.as_deref().map(|model| truncate(model, MAX_ID_BYTES)),
            item: Box::new(output_item(event)?),
        },
        Event::SubagentFinished {
            call_id,
            status,
            summary,
        } => AgentOutputItem::SubagentFinished {
            call_id: truncate(call_id, MAX_ID_BYTES),
            status: *status,
            summary: summary
                .as_deref()
                .map(|summary| truncate(summary, MAX_TEXT_ITEM_BYTES)),
        },
        _ => return None,
    })
}

/// The transcript item for a permission request (PLX-222). It waits for an answer with no timer
/// (PLX-726), so `expiresAt` is the latest time there is.
pub(super) fn approval_requested(request: &ApprovalRequest) -> AgentOutputItem {
    let capped = |text: Option<&str>| text.map(|text| truncate(text, MAX_TEXT_ITEM_BYTES));
    AgentOutputItem::ApprovalRequested {
        approval_id: request.approval_id,
        tool_name: truncate(&request.tool_name, MAX_ID_BYTES),
        input: capped_input(&request.input, MAX_APPROVAL_INPUT_BYTES),
        call_id: id(request.call_id.as_deref()),
        reason: capped(request.reason.as_deref()),
        blocked_path: capped(request.blocked_path.as_deref()),
        subagent: id(request.subagent.as_deref()),
        always_allow: request
            .always_allow
            .iter()
            .take(MAX_ALWAYS_ALLOW_RULES)
            .map(|rule| truncate(rule, MAX_ALWAYS_ALLOW_RULE_BYTES))
            .collect(),
        interactive: request.interactive,
        expires_at: Timestamp::MAX,
    }
}

/// The transcript item for how a permission request ended (PLX-222).
pub(super) fn approval_resolved(
    approval_id: ApprovalId,
    resolution: &AgentApproveResult,
) -> AgentOutputItem {
    AgentOutputItem::ApprovalResolved {
        approval_id,
        decision: resolution.decision,
        by: resolution.by,
        always: resolution.always,
        message: resolution
            .message
            .as_deref()
            .map(|message| truncate(message, MAX_TEXT_ITEM_BYTES)),
    }
}

/// About how many bytes `item` adds to an `agent.output` event.
pub(super) fn item_bytes(item: &AgentOutputItem) -> usize {
    serde_json::to_string(item).map_or(0, |json| json.len())
}

#[cfg(test)]
mod tests {
    use parallax_protocol::{AgentOutputItem, AgentToolStatus};
    use serde_json::json;

    use super::{MAX_TOOL_INPUT_BYTES, MAX_TOOL_OUTPUT_BYTES, output_item, truncate};
    use crate::backend::{Event, ToolStatus};

    #[test]
    fn large_tool_inputs_and_outputs_are_cut() {
        let big = "x".repeat(MAX_TOOL_INPUT_BYTES + 1);
        let call = Event::ToolCall {
            call_id: "c".into(),
            name: "Write".into(),
            input: json!({"content": big}),
        };
        let Some(AgentOutputItem::ToolCall { input, .. }) = output_item(&call) else {
            panic!("a tool call");
        };
        assert_eq!(input["truncated"], true);

        let result = Event::ToolResult {
            call_id: "c".into(),
            status: ToolStatus::Ok,
            output: Some("é".repeat(MAX_TOOL_OUTPUT_BYTES)),
            images: Vec::new(),
        };
        let Some(AgentOutputItem::ToolResult { output, status, .. }) = output_item(&result) else {
            panic!("a tool result");
        };
        assert_eq!(status, AgentToolStatus::Ok);
        let output = output.unwrap();
        assert!(
            output.len() < MAX_TOOL_OUTPUT_BYTES + 64,
            "{}",
            output.len()
        );
        assert!(output.ends_with("bytes cut)"));
        assert_eq!(truncate("short", 10), "short");
    }
}
