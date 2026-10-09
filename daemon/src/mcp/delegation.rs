//! A thread's delegation tools (0063, PLX-648), with T3 Code's names and inputs:
//! `orchestrator_capabilities`, `delegate_task`, `task_status`, `task_cancel`, and
//! `create_threads` through `task/delegate`, `task/status`, and `orchestration/dispatch`, and
//! `thread_merge_back` through `thread/mergeBack`. Every caller gets them; plxd refuses a
//! Project's runs, which start children through their coordinator.
//!
//! A task is a child thread in the caller's worktree. Its id is its thread's run id. An async
//! task wakes the caller when it ends (`completionWake: always`); `wait` blocks for its result
//! and wakes the caller only if its turn ended first (`settled_only`), or after the wait times
//! out (`always` again), as T3's.

use std::collections::HashMap;
use std::sync::{Mutex, PoisonError};
use std::time::Duration;

use parallax_protocol::methods::{
    OrchestrationDispatch, ProvidersList, TaskDelegate, TaskStatus, ThreadMergeBack,
};
use parallax_protocol::{
    AccountChoice, AgentEffort, AgentPermission, AgentRun, AgentStatus, CompletionWake,
    DelegatedTask, OrchestrationCommand, ProvidersListParams, RunId, TaskDelegateParams,
    TaskStatusParams, ThreadMergeBackParams,
};
use serde::Deserialize;
use serde_json::{Value, json};
use tokio::time::{Instant, sleep};

use super::thread::{Binding, MAX_AGENT_WAIT, POLL, agent_wait, find_run, running};
use super::{MAX_TEXT_BYTES, Plxd, check_text, last_output, parse, pretty, tail};

/// The tools this module serves, in [`definitions`]' order.
pub const TOOLS: &[&str] = &[
    "orchestrator_capabilities",
    "delegate_task",
    "task_status",
    "task_cancel",
    "create_threads",
    "thread_merge_back",
];

/// How long `delegate_task`'s `wait` blocks without a `timeoutMs`, and the most it takes, as T3's.
const DEFAULT_WAIT: Duration = Duration::from_mins(10);
const MAX_WAIT: Duration = Duration::from_mins(60);

/// The most threads one `create_threads` makes, as T3's.
const MAX_BATCH: usize = 20;

/// How much of a task's last output its status carries.
const SUMMARY_BYTES: usize = 8 * 1024;

/// The tools' definitions, in [`TOOLS`]' order.
#[must_use]
#[expect(
    clippy::too_many_lines,
    reason = "one schema per tool, read side by side"
)]
pub fn definitions() -> Vec<Value> {
    let object = |properties: Value, required: &[&str]| {
        json!({
            "type": "object",
            "properties": properties,
            "required": required,
            "additionalProperties": false,
        })
    };
    let tool = |name: &str, description: &str, schema: Value, read_only: bool| {
        json!({
            "name": name,
            "description": description,
            "inputSchema": schema,
            "annotations": {"readOnlyHint": read_only, "destructiveHint": false},
        })
    };
    let target = json!({
        "type": "object",
        "description": "Where the child runs. Omit for your own provider and model.",
        "properties": {
            "providerInstanceId": {"type": "string", "description": "A provider instance id from orchestrator_capabilities, such as claude or codex."},
            "model": {"type": "string", "description": "A model id that provider advertises."},
            "effort": {"type": "string", "enum": ["low", "medium", "high", "xhigh", "max"]},
        },
        "additionalProperties": false,
    });
    let runtime_mode = json!({
        "type": "string",
        "enum": ["inherit", "plan", "manual", "edit", "auto", "bypass"],
        "description": "Its permission mode, never one that needs less approval than yours. Default inherit.",
    });
    let task_id = json!({"type": "string", "description": "The taskId delegate_task returned."});
    let client_request_id =
        json!({"type": "string", "description": "Reuse it to retry a call that lost its result."});
    vec![
        tool(
            "orchestrator_capabilities",
            "List the provider instances and their models that a delegated task or a new thread can run on, your own provider, model, and mode, which children inherit, and the orchestration features available to you. For a separate thread in its own worktree, use thread_launch.",
            object(json!({}), &[]),
            true,
        ),
        tool(
            "delegate_task",
            "Delegate one task to a Parallax-owned child agent of THIS thread, working in your worktree and branch, and run it with only the task prompt, without your conversation. Choose a provider and model from orchestrator_capabilities; this is how to use another provider or a model your native subagents lack. Provider, model, effort, and mode inherit unless target or runtimeMode overrides them. Prefer mode='async' for long work: its end wakes this thread with a message once your turn is over, so end your turn instead of polling, and use task_status only when you need the result mid-turn. mode='wait' blocks until it ends or timeoutMs passes; waitTimedOut=true means the wait ended, not the task, and its end then wakes you. For each review round, delegate again with the full context and a new clientRequestId, rather than messaging the child.",
            object(
                json!({
                    "task": {"type": "string", "description": "The self-contained task, at most 64 KiB."},
                    "target": target,
                    "title": {"type": "string", "description": "Its title in the sidebar."},
                    "role": {"type": "string", "enum": ["implementation", "research", "review", "design", "test", "general"]},
                    "mode": {"type": "string", "enum": ["async", "wait"], "description": "Default async."},
                    "timeoutMs": {"type": "integer", "minimum": 1, "description": "With wait: how long to block. Default 600000 (10 minutes), at most 3600000. It doesn't cancel the task."},
                    "clientRequestId": client_request_id,
                    "runtimeMode": runtime_mode,
                }),
                &["task"],
            ),
            false,
        ),
        tool(
            "task_status",
            "Read a task this thread delegated: status (queued, running, waiting, completed, failed, cancelled, interrupted), workState (working or result_available), and summary, its last output, once it has ended. Reading an ended task's result means its end no longer wakes you.",
            object(json!({"taskId": task_id}), &["taskId"]),
            false,
        ),
        tool(
            "task_cancel",
            "Stop a task this thread delegated, as the user's Stop does: its running turn is interrupted, its queued messages are held, and the tasks it delegated stop too. Its end no longer wakes you. An ended task keeps its status and result, and any later turn of its thread stops too.",
            object(
                json!({
                    "taskId": task_id,
                    "reason": {"type": "string", "description": "Why, for the record."},
                    "clientRequestId": client_request_id,
                }),
                &["taskId"],
            ),
            false,
        ),
        tool(
            "create_threads",
            "Create 1 to 20 ORDINARY top-level threads that work in your worktree and branch. This is not delegation: they aren't your children and don't wake you. Use it only when the user asks for separate threads. For delegated work use delegate_task; for a thread in its own worktree use thread_launch. Each entry may set its provider, model, effort, and mode; the rest inherit.",
            object(
                json!({
                    "threads": {
                        "type": "array",
                        "minItems": 1,
                        "maxItems": MAX_BATCH,
                        "items": object(
                            json!({
                                "prompt": {"type": "string", "description": "Its first message, at most 64 KiB."},
                                "title": {"type": "string"},
                                "target": target,
                                "runtimeMode": runtime_mode,
                            }),
                            &["prompt"],
                        ),
                    },
                    "clientRequestId": client_request_id,
                }),
                &["threads"],
            ),
            false,
        ),
        tool(
            "thread_merge_back",
            "Merge a fork's or a child's new context back into the thread it came from: what was said in it since it forked, or all of it for a child, without tool calls. It goes with that thread's next message. Omit sourceThreadId to merge this thread back.",
            object(
                json!({
                    "sourceThreadId": {"type": "string", "description": "The fork or child's run id. Default: this thread."},
                    "targetThreadId": {"type": "string", "description": "The run id of the thread it forked from, or its parent."},
                }),
                &["targetThreadId"],
            ),
            false,
        ),
    ]
}

/// The calls whose `clientRequestId` already made a thread, so a retry doesn't make another.
// ponytail: kept for this server's life, which is its CLI session's; store them if a retry ever
// needs to outlive a restart.
#[derive(Default)]
pub(super) struct Delegation {
    requests: Mutex<HashMap<String, RunId>>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct Target {
    #[serde(default)]
    provider_instance_id: Option<String>,
    #[serde(default)]
    model: Option<String>,
    #[serde(default)]
    effort: Option<AgentEffort>,
}

#[derive(Deserialize)]
#[serde(rename_all = "snake_case")]
enum Role {
    Implementation,
    Research,
    Review,
    Design,
    Test,
    General,
}

#[derive(Deserialize, PartialEq)]
#[serde(rename_all = "snake_case")]
enum Mode {
    Async,
    Wait,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct DelegateArgs {
    task: String,
    #[serde(default)]
    target: Option<Target>,
    #[serde(default)]
    title: Option<String>,
    #[serde(default)]
    role: Option<Role>,
    #[serde(default)]
    mode: Option<Mode>,
    #[serde(default)]
    timeout_ms: Option<u64>,
    #[serde(default)]
    client_request_id: Option<String>,
    #[serde(default)]
    runtime_mode: Option<String>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct TaskArgs {
    task_id: RunId,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct CancelArgs {
    task_id: RunId,
    #[serde(default)]
    #[expect(
        dead_code,
        reason = "T3's input, which Parallax's Stop has no place for"
    )]
    reason: Option<String>,
    #[serde(default)]
    #[expect(
        dead_code,
        reason = "a second Stop changes nothing, so a retry needs no id"
    )]
    client_request_id: Option<String>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct NewThreadArgs {
    prompt: String,
    #[serde(default)]
    title: Option<String>,
    #[serde(default)]
    target: Option<Target>,
    #[serde(default)]
    runtime_mode: Option<String>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct CreateArgs {
    threads: Vec<NewThreadArgs>,
    #[serde(default)]
    client_request_id: Option<String>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct MergeBackArgs {
    #[serde(default)]
    source_thread_id: Option<RunId>,
    target_thread_id: RunId,
}

impl Delegation {
    /// Runs tool `name`, one of [`TOOLS`], for the caller bound in `binding`.
    pub(super) async fn call(
        &self,
        binding: &Binding,
        name: &str,
        arguments: Value,
    ) -> Result<String, String> {
        let plxd = &binding.plxd;
        let caller = binding.run;
        match name {
            "orchestrator_capabilities" => capabilities(plxd, caller).await,
            "delegate_task" => self.delegate(plxd, caller, parse(arguments)?).await,
            "task_status" => {
                let TaskArgs { task_id } = parse(arguments)?;
                let task = status(plxd, caller, task_id, true, None, false).await?;
                Ok(pretty(&shown(plxd, &task, false).await?))
            }
            "task_cancel" => {
                let CancelArgs { task_id, .. } = parse(arguments)?;
                cancel(plxd, caller, task_id).await
            }
            "create_threads" => self.create(plxd, caller, parse(arguments)?).await,
            "thread_merge_back" => {
                let MergeBackArgs {
                    source_thread_id,
                    target_thread_id,
                } = parse(arguments)?;
                let source = source_thread_id.unwrap_or(caller);
                let result = plxd
                    .call::<ThreadMergeBack>(ThreadMergeBackParams {
                        source,
                        target: target_thread_id,
                    })
                    .await?;
                Ok(pretty(&json!({
                    "transferId": result.transfer_id,
                    "sourceThreadId": source,
                    "targetThreadId": target_thread_id,
                    "status": "pending",
                })))
            }
            other => Err(format!("no tool is named {other:?}")),
        }
    }

    /// The run id a call with `request` makes: a new one, or the one its first try made.
    fn run_id(&self, request: Option<String>) -> RunId {
        let Some(request) = request else {
            return RunId::generate();
        };
        *self
            .requests
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .entry(request)
            .or_insert_with(RunId::generate)
    }

    /// `delegate_task`: see the module documentation.
    async fn delegate(
        &self,
        plxd: &Plxd,
        caller: RunId,
        args: DelegateArgs,
    ) -> Result<String, String> {
        let DelegateArgs {
            task,
            target,
            title,
            role,
            mode,
            timeout_ms,
            client_request_id,
            runtime_mode,
        } = args;
        check_text("task", &task, MAX_TEXT_BYTES)?;
        let prompt = match role {
            None | Some(Role::General) => task,
            Some(role) => format!(
                "Act as the {} sub-agent for this task.\n\n{task}",
                role_name(&role)
            ),
        };
        let wait = mode == Some(Mode::Wait);
        let completion_wake = if wait {
            CompletionWake::SettledOnly
        } else {
            CompletionWake::Always
        };
        let started = plxd
            .call::<TaskDelegate>(params(
                self.run_id(client_request_id),
                caller,
                prompt,
                title,
                target,
                runtime_mode.as_deref(),
                Some(completion_wake),
            )?)
            .await?;
        let task_id = started.run.id;
        if !wait {
            let task = status(plxd, caller, task_id, false, None, false).await?;
            return Ok(pretty(&shown(plxd, &task, false).await?));
        }
        let timeout = timeout_ms
            .map_or(DEFAULT_WAIT, Duration::from_millis)
            .clamp(Duration::from_millis(1), MAX_WAIT);
        if wait_for(plxd, task_id, timeout).await? {
            let task = status(plxd, caller, task_id, true, None, false).await?;
            return Ok(pretty(&shown(plxd, &task, false).await?));
        }
        // The wait no longer delivers its end, so its end wakes this thread.
        let task = status(
            plxd,
            caller,
            task_id,
            false,
            Some(CompletionWake::Always),
            false,
        )
        .await?;
        Ok(pretty(&shown(plxd, &task, true).await?))
    }

    /// `create_threads`: each entry through `task/delegate` with no `completionWake`, in order,
    /// stopping at the first that fails.
    async fn create(&self, plxd: &Plxd, caller: RunId, args: CreateArgs) -> Result<String, String> {
        let CreateArgs {
            threads,
            client_request_id,
        } = args;
        if threads.is_empty() || threads.len() > MAX_BATCH {
            return Err(format!("threads must list 1 to {MAX_BATCH} threads"));
        }
        let mut created = Vec::with_capacity(threads.len());
        for (index, thread) in threads.into_iter().enumerate() {
            let NewThreadArgs {
                prompt,
                title,
                target,
                runtime_mode,
            } = thread;
            check_text("prompt", &prompt, MAX_TEXT_BYTES)?;
            let request = client_request_id
                .as_ref()
                .map(|request| format!("{request}/{index}"));
            let started = plxd
                .call::<TaskDelegate>(params(
                    self.run_id(request),
                    caller,
                    prompt,
                    title,
                    target,
                    runtime_mode.as_deref(),
                    None,
                )?)
                .await?;
            let run = &started.run;
            created.push(json!({
                "threadId": run.id,
                "status": status_name(run.status),
                "title": started.thread.title,
                "providerInstanceId": run.backend,
                "model": run.model,
            }));
        }
        Ok(pretty(&json!({"threads": created})))
    }
}

fn role_name(role: &Role) -> &'static str {
    match role {
        Role::Implementation => "implementation",
        Role::Research => "research",
        Role::Review => "review",
        Role::Design => "design",
        Role::Test => "test",
        Role::General => "general",
    }
}

/// `task/delegate`'s params for a thread in `caller`'s worktree.
fn params(
    run_id: RunId,
    caller: RunId,
    prompt: String,
    title: Option<String>,
    target: Option<Target>,
    runtime_mode: Option<&str>,
    completion_wake: Option<CompletionWake>,
) -> Result<TaskDelegateParams, String> {
    let target = target.unwrap_or(Target {
        provider_instance_id: None,
        model: None,
        effort: None,
    });
    let permission = match runtime_mode {
        None | Some("inherit") => None,
        Some(mode) => Some(
            serde_json::from_value::<AgentPermission>(json!(mode))
                .ok()
                .filter(|mode| *mode != AgentPermission::Unknown)
                .ok_or_else(|| format!("runtimeMode {mode:?} is not a mode"))?,
        ),
    };
    Ok(TaskDelegateParams {
        run_id,
        owner: caller,
        prompt,
        title,
        account: target
            .provider_instance_id
            .map(|backend| AccountChoice::Subscription { backend }),
        model: target.model,
        effort: target.effort,
        permission,
        completion_wake,
    })
}

/// `task/status` for `caller`'s task `task_id`.
async fn status(
    plxd: &Plxd,
    caller: RunId,
    task_id: RunId,
    acknowledge: bool,
    completion_wake: Option<CompletionWake>,
    dispose: bool,
) -> Result<DelegatedTask, String> {
    plxd.call::<TaskStatus>(TaskStatusParams {
        parent: caller,
        task_id,
        acknowledge,
        completion_wake,
        dispose,
    })
    .await
}

/// Waits until `task` has ended a turn, or `timeout` passes: whether it ended.
async fn wait_for(plxd: &Plxd, task: RunId, timeout: Duration) -> Result<bool, String> {
    let deadline = Instant::now() + timeout;
    loop {
        let left = deadline.saturating_duration_since(Instant::now());
        match agent_wait(plxd, task, left.min(MAX_AGENT_WAIT)).await {
            Ok(run) => {
                let run = run?;
                if !running(&run) && !waiting(&run) {
                    return Ok(true);
                }
                // A usage limit holds it until its reset, which `agent/wait` counts as idle.
                if waiting(&run) {
                    sleep(POLL).await;
                }
            }
            // plxd may be restarting: try again until the deadline.
            Err(error) if Instant::now() >= deadline => return Err(error),
            Err(_) => sleep(POLL).await,
        }
        if Instant::now() >= deadline {
            return Ok(false);
        }
    }
}

/// Whether `run` waits to resume past a usage limit (0049): it hasn't ended.
fn waiting(run: &AgentRun) -> bool {
    run.status == AgentStatus::Waiting
}

/// A task as T3's tools show one.
async fn shown(plxd: &Plxd, task: &DelegatedTask, wait_timed_out: bool) -> Result<Value, String> {
    let run = &task.run;
    let ended = !running(run) && !waiting(run);
    let summary = if ended {
        last_output(plxd, run.id)
            .await?
            .map(|text| tail(&text, SUMMARY_BYTES))
    } else {
        None
    };
    Ok(json!({
        "taskId": task.task_id,
        "childThreadId": task.task_id,
        "status": status_name(run.status),
        "workState": if ended { "result_available" } else { "working" },
        "providerInstanceId": run.backend,
        "model": run.model,
        "mode": run.permission,
        "branch": run.branch,
        "summary": summary,
        "error": run.error,
        "waitTimedOut": wait_timed_out,
    }))
}

/// T3's name for a task's status.
fn status_name(status: AgentStatus) -> &'static str {
    match status {
        AgentStatus::Starting | AgentStatus::Running => "running",
        AgentStatus::Waiting => "queued",
        AgentStatus::Completed | AgentStatus::Accepted => "completed",
        AgentStatus::Failed => "failed",
        AgentStatus::Cancelled => "cancelled",
        AgentStatus::Interrupted => "interrupted",
        AgentStatus::Unknown => "unknown",
    }
}

/// `task_cancel`: Stop on the task's thread, with its queue held and the cascade (0063), then its
/// end no longer wakes the caller. A task whose mode the user raised above the caller's since is
/// refused, as T3 refuses it.
async fn cancel(plxd: &Plxd, caller: RunId, task_id: RunId) -> Result<String, String> {
    let task = status(plxd, caller, task_id, false, None, false).await?;
    let mine = find_run(plxd, caller).await?;
    crate::delegation::check_mode(mine.permission, task.run.permission).map_err(|_| {
        format!("task {task_id} now runs in a mode above yours, so you can't stop it")
    })?;
    let ended = !running(&task.run) && !waiting(&task.run);
    plxd.call::<OrchestrationDispatch>(OrchestrationCommand::RunInterrupt {
        thread_id: task_id,
        hold_queue: true,
    })
    .await?;
    status(plxd, caller, task_id, false, None, true).await?;
    let status = if ended {
        status_name(task.run.status)
    } else {
        "cancel_requested"
    };
    Ok(pretty(&json!({"taskId": task_id, "status": status})))
}

/// `orchestrator_capabilities`: the provider instances a child can run on, and what it
/// inherits from `caller`.
async fn capabilities(plxd: &Plxd, caller: RunId) -> Result<String, String> {
    let run = find_run(plxd, caller).await?;
    let listed = plxd
        .call::<ProvidersList>(ProvidersListParams { refresh: false })
        .await?;
    let providers: Vec<Value> = listed
        .providers
        .iter()
        .map(|info| {
            let instance = &info.instance;
            let mut constraints = Vec::new();
            if !instance.enabled {
                constraints.push("disabled in Settings");
            }
            if !info.installed {
                constraints.push("not installed on this host");
            }
            if info.signed_in == Some(false) {
                constraints.push("not signed in");
            }
            let models: Vec<Value> = info
                .models
                .iter()
                .chain(&instance.models)
                .map(|model| json!({"id": model.id, "label": model.name}))
                .collect();
            json!({
                "providerInstanceId": instance.id,
                "driverKind": instance.kind,
                "displayName": instance.name,
                "models": models,
                "modes": info.permissions,
                "efforts": info.efforts,
                "canRunChildTask": constraints.is_empty(),
                "canRunCrossProviderChildTask": constraints.is_empty(),
                "constraints": constraints,
            })
        })
        .collect();
    Ok(pretty(&json!({
        "parentThreadId": caller,
        "inheritedProviderInstanceId": run.backend,
        "inheritedModel": run.model,
        "runtimeMode": run.permission,
        "providers": providers,
        "features": {
            "appOwnedSubagents": true,
            "asyncPolling": true,
            "cancellation": true,
            "batchThreadCreation": true,
            "threadManagement": true,
            "incrementalThreadRead": true,
            "scheduledTasks": true,
            "maxBatchThreads": MAX_BATCH,
        },
    })))
}

#[cfg(test)]
mod tests {
    use parallax_protocol::{AgentPermission, CompletionWake, RunId};

    use super::{TOOLS, definitions, params};

    #[test]
    fn the_definitions_list_every_tool_in_order() {
        let listed: Vec<String> = definitions()
            .iter()
            .map(|tool| tool["name"].as_str().unwrap().to_owned())
            .collect();
        assert_eq!(listed, TOOLS);
    }

    #[test]
    fn a_runtime_mode_is_inherit_or_a_parallax_mode() {
        let (run, caller) = (RunId::generate(), RunId::generate());
        let made = |mode: Option<&str>| {
            params(
                run,
                caller,
                "x".to_owned(),
                None,
                None,
                mode,
                Some(CompletionWake::Always),
            )
        };
        assert_eq!(made(None).unwrap().permission, None);
        assert_eq!(made(Some("inherit")).unwrap().permission, None);
        assert_eq!(
            made(Some("plan")).unwrap().permission,
            Some(AgentPermission::Plan)
        );
        assert!(made(Some("full-access")).is_err());
        assert_eq!(made(None).unwrap().owner, caller);
    }
}
