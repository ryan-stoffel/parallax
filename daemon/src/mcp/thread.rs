//! `plxd mcp --thread <runId>`: a thread's host-wide Parallax tools (0041, PLX-373), a Project's
//! coordinator's included (PLX-380).
//!
//! plxd writes `--thread` into the thread's `--mcp-config` ([`crate::backend::ThreadTools`]), so
//! the server knows its caller and no tool takes the caller's id. The tools reach every thread on
//! the host, as the user can with clicks: list, read, launch, fork, message or steer, wait on,
//! interrupt, rename, settle, and archive them, and link pull requests to them. A launched or
//! forked thread records the caller as its `parent`, and a message or interrupt names the caller
//! in the target's transcript (`agent/send`'s and `agent/cancel`'s `from`). Framing, connections, errors, and size caps are
//! 0019's, from [`super`].
//!
//! A caller in a Project also gets [`CONTEXT_TOOLS`], the Project's shared context, and the
//! question tools for its role ([`super::question`], PLX-402), and its coordinator gets
//! [`super::land`]'s `land` (PLX-410). A Project's coordinator launches its children in its
//! Project, through `agent/start` with itself as their coordinator thread, so they show in the
//! Project's Agents panel, run as threads that ask through the inbox, in the Project's mode, and
//! `thread_list` lists its Project's runs, each once. Every caller also gets [`super::device`]'s
//! tools (PLX-640).

use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::time::Duration;

use parallax_protocol::methods::{
    AgentCancel, AgentEvents, AgentList, AgentSend, AgentStart, AgentWait, ContextList,
    ContextRead, ContextWrite, PrLink, PrUnlink, ProjectList, RepoAdd, ThreadArchive, ThreadFork,
    ThreadList, ThreadSearch, ThreadStart, ThreadUpdate,
};
use parallax_protocol::{
    AccountChoice, AccountId, AgentCancelParams, AgentDelivery, AgentEffort, AgentEventsParams,
    AgentListParams, AgentOutcome, AgentOutputItem, AgentPermission, AgentPolicy, AgentRun,
    AgentSendParams, AgentStartParams, AgentStatus, AgentToolStatus, AgentWaitParams,
    AgentWaitUntil, ContextListParams, ContextReadParams, ContextWriteId, ContextWriteParams,
    CoordinatorThreadId, ErrorKind, ParallaxEvent, PrViewParams, ProjectId, ProjectListParams,
    Repo, RepoAddParams, RepoId, RunId, Thread, ThreadArchiveParams, ThreadForkParams,
    ThreadListParams, ThreadListResult, ThreadSearchParams, ThreadStartParams, ThreadUpdateParams,
    TurnId,
};
use serde::Deserialize;
use serde_json::{Value, json};
use tokio::io::{AsyncRead, AsyncWrite};
use tokio::time::{Instant, sleep};
use uuid::Uuid;

use super::{
    MAX_CONTEXT_BYTES, MAX_PATH_BYTES, MAX_TEXT_BYTES, Plxd, Reply, Tools, check_text, clip,
    last_output, parse, pretty, tail,
};
use super::{device, land, question};

/// Every tool the server offers a thread outside a Project.
pub const TOOLS: &[&str] = &[
    "thread_list",
    "thread_read",
    "thread_search",
    "thread_launch",
    "thread_fork",
    "thread_send",
    "thread_wait",
    "thread_interrupt",
    "thread_update",
    "pr_link",
    "pr_unlink",
];

/// The tools a caller in a Project also gets: its shared context (0019).
pub const CONTEXT_TOOLS: &[&str] = &["read_context", "write_context"];

/// plxd's server as Claude Code names it in a thread's and a coordinator's `--allowedTools`, which
/// allows every tool the server offers, so they run without asking in every permission mode.
/// Claude Code's todo tools follow it there. The server offers each caller only its own role's
/// tools.
pub const ALLOWED_TOOLS: &[&str] = &["mcp__plxd"];

/// About how much transcript one `thread_read` page carries, in bytes. A page ends at an event,
/// so it can run over by one event's text, which [`ITEM_BYTES`] caps.
const PAGE_BYTES: usize = 64 * 1024;

/// The most of one message or tool output a page shows, in bytes.
const ITEM_BYTES: usize = 16 * 1024;

/// How much of a tool call's input or result a page shows, in bytes.
const TOOL_BYTES: usize = 300;

/// How much of a thread's prompt `thread_list` and the other summaries show.
const PROMPT_PREVIEW_BYTES: usize = 500;

/// How much of a thread's last output `thread_wait` shows: its end.
const LAST_OUTPUT_BYTES: usize = 8 * 1024;

/// How long `thread_wait` waits without a `timeoutSeconds`, and the most it takes.
const DEFAULT_WAIT: Duration = Duration::from_mins(5);
const MAX_WAIT: Duration = Duration::from_mins(30);

/// How often `thread_wait` checks the thread on a plxd without `agent/wait`, and how long it
/// pauses between connections.
const POLL: Duration = Duration::from_millis(500);

/// The longest one `agent/wait` waits: plxd's cap, under its connection idle timeout.
const MAX_AGENT_WAIT: Duration = Duration::from_mins(1);

/// What one server is bound to.
#[derive(Clone)]
pub struct Binding {
    /// The client of plxd every tool call shares.
    pub plxd: Plxd,
    /// The calling thread's run.
    pub run: RunId,
    /// plxd's data folder's `tmp/`, where the device tools keep the devices each thread has open
    /// (PLX-640).
    pub temp: PathBuf,
}

/// A bound server: its [`Binding`], and what the caller's run is.
struct Server {
    binding: Binding,
    /// The caller's Project, when its run is in one rather than in a repo entry.
    project: Option<ProjectId>,
    /// The caller is its Project's coordinator (0024), whose children start in the Project.
    coordinator: bool,
    /// The memory the caller reaches, if any (0044).
    memory: Option<super::memory::Memory>,
    /// The device tools, with the devices the caller has open (PLX-640).
    devices: device::Devices,
}

/// Checks that the bound run exists, then serves MCP on `input` and `output` until `input` ends.
///
/// # Errors
///
/// When plxd can't be reached or doesn't know the run, when a line is longer than
/// [`super::MAX_MESSAGE_BYTES`], or when reading or writing fails.
pub async fn run(
    binding: &Binding,
    input: impl AsyncRead + Unpin,
    output: impl AsyncWrite + Unpin,
) -> Result<(), String> {
    let plxd = &binding.plxd;
    let caller = find_run(plxd, binding.run).await?;
    let projects = plxd.call::<ProjectList>(ProjectListParams {}).await?;
    let in_project = projects
        .projects
        .iter()
        .find(|project| project.id == caller.project);
    let coordinator = in_project.is_some() && caller.policy == AgentPolicy::NoWrite;
    let memory = super::memory::Memory::of(plxd, &caller, in_project, coordinator).await?;
    let server = Server {
        binding: binding.clone(),
        project: in_project.map(|project| project.id),
        coordinator,
        memory,
        devices: device::Devices::new(&binding.temp, binding.run),
    };
    super::serve(&server, input, output).await
}

impl Tools for Server {
    fn names(&self) -> Vec<&'static str> {
        let tools = if self.project.is_some() {
            [
                TOOLS,
                CONTEXT_TOOLS,
                question::tools(self.coordinator),
                land::tools(self.coordinator),
            ]
            .concat()
        } else {
            TOOLS.to_vec()
        };
        let memory = self
            .memory
            .as_ref()
            .map_or(&[][..], |memory| memory.names());
        [&tools[..], memory, device::TOOLS].concat()
    }

    fn definitions(&self) -> Value {
        let mut tools = definitions(self.project.is_some());
        if let Some(list) = tools.as_array_mut() {
            if self.project.is_some() {
                list.extend(question::definitions(self.coordinator));
                list.extend(land::definitions(self.coordinator));
            }
            if let Some(memory) = &self.memory {
                list.extend(memory.definitions());
            }
            list.extend(device::definitions());
        }
        tools
    }

    async fn call(&self, name: &str, arguments: Value) -> Result<Reply, String> {
        if name.starts_with("device_") {
            return self.devices.call(name, arguments).await;
        }
        if name.starts_with("memory_") {
            return memory_tool(self, name, arguments).await.map(Reply::from);
        }
        call_tool(self, name, arguments).await.map(Reply::from)
    }
}

#[expect(
    clippy::too_many_lines,
    reason = "one schema per tool, read side by side"
)]
fn definitions(project: bool) -> Value {
    let run_id = |what: &str| json!({"type": "string", "description": what});
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
    let target = run_id("The thread's run id, from thread_list or thread_launch.");
    let threads = json!({
        "type": "array",
        "items": {"type": "string"},
        "maxItems": 8,
        "description": "Run ids of threads whose summaries to attach to the message as context, at most 8.",
    });
    let mine = run_id("The thread's run id, from thread_list. Omit it for your own thread.");
    let mut tools = json!([
        tool(
            "thread_list",
            "List the threads on this host, newest first: each one's run id, title, status, backend, model, mode, repository, branch, parent, and whether it is settled. Yours has \"you\": true.",
            object(
                json!({
                    "includeArchived": {"type": "boolean", "description": "Also list archived threads. Default false."},
                }),
                &[]
            ),
            true,
        ),
        tool(
            "thread_read",
            "Read a thread's transcript, oldest first, about 64 KiB a page: its messages with who sent them and their turn ids, the agent's replies, tool calls, and how its runs ended. A longer one ends with the `after` to pass for the next page.",
            object(
                json!({
                    "runId": target,
                    "after": {"type": "integer", "minimum": 0, "description": "Read the events after this one, from the last page's note. Default 0, the start."},
                }),
                &["runId"]
            ),
            true,
        ),
        tool(
            "thread_search",
            "Find threads whose messages or replies contain some text, not counting tool calls, the one with the newest message first. Case-insensitive for ASCII letters.",
            object(
                json!({
                    "query": {"type": "string", "description": "The text to find."},
                    "limit": {"type": "integer", "minimum": 1, "maximum": 100, "description": "The most threads to return. Default 20."},
                }),
                &["query"]
            ),
            true,
        ),
        tool(
            "thread_launch",
            "Start a new thread as your child, on any backend, model, and mode, and return it at once. It runs on its own: use thread_wait to wait for it and thread_read to read what it did. Without a workspace it works in a new worktree of your repository, or with no repository if you have none.",
            object(
                json!({
                    "prompt": {"type": "string", "description": "The first message, at most 64 KiB. Make it self-contained."},
                    "threads": threads,
                    "title": {"type": "string", "description": "Its title in the sidebar, at most 256 bytes."},
                    "backend": {"type": "string", "description": "The CLI to run it on with the user's own login, such as claude, codex, or cursor. Omit it for the user's default."},
                    "account": {"type": "string", "description": "A key account's id to run it on instead of a backend's login."},
                    "model": {"type": "string", "description": "The model, such as claude-sonnet-4-6. Omit it for the CLI's default."},
                    "effort": {"type": "string", "enum": ["low", "medium", "high", "xhigh", "max"]},
                    "mode": {"type": "string", "enum": ["auto", "manual", "edit", "plan", "bypass"], "description": "Its permission mode. Omit it for yours, on the same backend."},
                    "workspace": {"type": "string", "enum": ["worktree", "checkout", "none"], "description": "worktree: a new git worktree of the repository; checkout: the repository's own checkout, whose changes stay uncommitted there; none: no repository."},
                    "repo": {"type": "string", "description": "The repository, by absolute path or thread_list's repo id. Default: yours."},
                    "base": {"type": "string", "description": "With worktree, the ref it starts from, such as origin/develop. Default HEAD."},
                    "branch": {"type": "string", "description": "With checkout, the branch to switch the checkout to first."},
                    "notify": {"type": "boolean", "description": "Wake you with a message from Parallax each time it finishes or stops, so you needn't wait on it. Default true."},
                }),
                &["prompt"]
            ),
            false,
        ),
        tool(
            "thread_fork",
            "Fork a thread at one of its turns as your child: a new thread, in the same kind of workspace, whose conversation is the original's up to the end of that turn. It runs in the original's mode and starts nothing until you thread_send it a message. A turn the thread is still running can't be forked.",
            object(
                json!({
                    "runId": target,
                    "turnId": {"type": "string", "description": "The turn to fork at, from thread_read: a message's turn id, or the thread's run id for its first message. Default: its latest turn."},
                    "backend": {"type": "string", "description": "The CLI to continue on with the user's own login, such as claude, codex, or cursor. Default: the original's."},
                    "account": {"type": "string", "description": "A key account's id to continue on instead of a backend's login."},
                    "model": {"type": "string", "description": "The model. Default: the original's, on the same backend, or else the CLI's default."},
                }),
                &["runId"]
            ),
            false,
        ),
        tool(
            "thread_send",
            "Send a thread a message, marked in its transcript as from you. A running thread gets it after its current turn, or within it with steer; a stopped one resumes with it.",
            object(
                json!({
                    "runId": target,
                    "text": {"type": "string", "description": "The message, at most 64 KiB."},
                    "threads": threads,
                    "steer": {"type": "boolean", "description": "Send it into the turn the thread is running now, ahead of anything waiting, rather than after it. Only for a running thread. Default false."},
                }),
                &["runId", "text"]
            ),
            false,
        ),
        tool(
            "thread_wait",
            "Wait until a thread is idle, its turn finished or stopped, or until a timeout, then return its status and the end of its last output.",
            object(
                json!({
                    "runId": target,
                    "timeoutSeconds": {"type": "integer", "minimum": 1, "maximum": MAX_WAIT.as_secs(), "description": "How long to wait. Default 300."},
                }),
                &["runId"]
            ),
            true,
        ),
        tool(
            "thread_interrupt",
            "Stop a thread's running turn, marked in its transcript as stopped by you. What it changed so far stays.",
            object(json!({"runId": target}), &["runId"]),
            false,
        ),
        tool(
            "thread_update",
            "Rename a thread, mark it settled (nothing left to do) or not, or archive it or bring it back.",
            object(
                json!({
                    "runId": mine,
                    "title": {"type": "string", "description": "Its new title, at most 256 bytes. Empty clears it."},
                    "settled": {"type": "boolean"},
                    "archived": {"type": "boolean"},
                }),
                &[]
            ),
            false,
        ),
        tool(
            "pr_link",
            "Link a GitHub pull request to a thread, so the app shows it there.",
            object(
                json!({
                    "url": {"type": "string", "description": "The pull request's URL, such as https://github.com/owner/repo/pull/1."},
                    "runId": mine,
                }),
                &["url"]
            ),
            false,
        ),
        tool(
            "pr_unlink",
            "Remove a pull request from a thread's links.",
            object(
                json!({
                    "url": {"type": "string", "description": "The pull request's URL, as the thread lists it."},
                    "runId": mine,
                }),
                &["url"]
            ),
            false,
        ),
    ]);
    if project {
        let context = [
            tool(
                "read_context",
                "Read your Project's shared context: one file's content by path, or the list of files without a path.",
                object(
                    json!({
                        "path": {"type": "string", "description": "A file name such as plan.md. Omit it to list the files."},
                    }),
                    &[],
                ),
                true,
            ),
            tool(
                "write_context",
                "Write a file in your Project's shared context, replacing it. Only .md, .markdown, and .txt names, with no folders.",
                object(
                    json!({
                        "path": {"type": "string", "description": "A file name such as plan.md."},
                        "content": {"type": "string", "description": "The whole new content, at most 1 MiB."},
                    }),
                    &["path", "content"],
                ),
                false,
            ),
        ];
        if let Some(list) = tools.as_array_mut() {
            list.extend(context);
        }
    }
    tools
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct ListArgs {
    #[serde(default)]
    include_archived: bool,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct ReadArgs {
    run_id: RunId,
    #[serde(default)]
    after: u64,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct SearchArgs {
    query: String,
    #[serde(default)]
    limit: Option<u32>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
enum Workspace {
    Worktree,
    Checkout,
    None,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct LaunchArgs {
    prompt: String,
    #[serde(default)]
    threads: Vec<RunId>,
    #[serde(default)]
    title: Option<String>,
    #[serde(default)]
    backend: Option<String>,
    #[serde(default)]
    account: Option<AccountId>,
    #[serde(default)]
    model: Option<String>,
    #[serde(default)]
    effort: Option<AgentEffort>,
    #[serde(default)]
    mode: Option<AgentPermission>,
    #[serde(default)]
    workspace: Option<Workspace>,
    #[serde(default)]
    repo: Option<String>,
    #[serde(default)]
    base: Option<String>,
    #[serde(default)]
    branch: Option<String>,
    #[serde(default)]
    notify: Option<bool>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ReadContextArgs {
    #[serde(default)]
    path: Option<String>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct WriteContextArgs {
    path: String,
    content: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct SendArgs {
    run_id: RunId,
    text: String,
    #[serde(default)]
    threads: Vec<RunId>,
    #[serde(default)]
    steer: bool,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct ForkArgs {
    run_id: RunId,
    #[serde(default)]
    turn_id: Option<TurnId>,
    #[serde(default)]
    backend: Option<String>,
    #[serde(default)]
    account: Option<AccountId>,
    #[serde(default)]
    model: Option<String>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct WaitArgs {
    run_id: RunId,
    #[serde(default)]
    timeout_seconds: Option<u64>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct TargetArgs {
    run_id: RunId,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct UpdateArgs {
    #[serde(default)]
    run_id: Option<RunId>,
    #[serde(default)]
    title: Option<String>,
    #[serde(default)]
    settled: Option<bool>,
    #[serde(default)]
    archived: Option<bool>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct PrArgs {
    url: String,
    #[serde(default)]
    run_id: Option<RunId>,
}

/// `thread_list`: the host's threads, newest first, after the caller's Project's runs. A
/// Project's runs are listed from `agent/list`, since only those `thread/start` made with
/// `project` have thread rows (PLX-398). Those rows are left out of the host's threads, so no run
/// is listed twice.
async fn list(server: &Server, args: ListArgs) -> Result<String, String> {
    let caller = server.binding.run;
    let plxd = &server.binding.plxd;
    let mut listed = Vec::new();
    let mut in_project = HashSet::new();
    if let Some(project) = server.project {
        let runs = plxd
            .call::<AgentList>(AgentListParams {
                project: Some(project),
            })
            .await?
            .runs;
        in_project.extend(runs.iter().map(|run| run.id));
        listed.extend(
            runs.iter()
                .rev()
                .filter(|run| run.id != caller)
                .map(|run| describe(run, None, &[], caller)),
        );
    }
    let mut threads = plxd.call::<ThreadList>(ThreadListParams {}).await?.threads;
    threads.reverse();
    threads.retain(|thread| {
        (args.include_archived || !thread.archived) && !in_project.contains(&thread.id)
    });
    listed.extend(described(plxd, &threads, caller).await?);
    Ok(pretty(&json!({"threads": listed})))
}

async fn call_tool(server: &Server, name: &str, arguments: Value) -> Result<String, String> {
    let binding = &server.binding;
    let caller = binding.run;
    match name {
        "thread_list" => list(server, parse(arguments)?).await,
        "thread_read" => {
            let ReadArgs { run_id, after } = parse(arguments)?;
            let plxd = &binding.plxd;
            find_run(plxd, run_id).await?;
            read(plxd, run_id, after).await
        }
        "thread_search" => {
            let SearchArgs { query, limit } = parse(arguments)?;
            let plxd = &binding.plxd;
            let found = plxd
                .call::<ThreadSearch>(ThreadSearchParams { query, limit })
                .await?;
            let threads = described(plxd, &found.threads, caller).await?;
            Ok(pretty(&json!({"threads": threads})))
        }
        "thread_launch" if server.coordinator => launch_child(server, parse(arguments)?).await,
        "thread_launch" => launch(binding, parse(arguments)?).await,
        "thread_fork" => fork(binding, parse(arguments)?).await,
        "thread_send" => send(binding, parse(arguments)?).await,
        "thread_wait" => {
            let WaitArgs {
                run_id,
                timeout_seconds,
            } = parse(arguments)?;
            not_yourself(caller, run_id, "wait on")?;
            let timeout = timeout_seconds.map_or(DEFAULT_WAIT, Duration::from_secs);
            wait(&binding.plxd, run_id, timeout.min(MAX_WAIT), caller).await
        }
        "thread_interrupt" => {
            let TargetArgs { run_id } = parse(arguments)?;
            not_yourself(caller, run_id, "interrupt")?;
            let plxd = &binding.plxd;
            let run = plxd
                .call::<AgentCancel>(AgentCancelParams {
                    run_id,
                    from: Some(caller),
                })
                .await?
                .run;
            Ok(pretty(&describe(&run, None, &[], caller)))
        }
        "thread_update" => update(binding, parse(arguments)?).await,
        "pr_link" | "pr_unlink" => {
            let PrArgs { url, run_id } = parse(arguments)?;
            let params = PrViewParams {
                run_id: run_id.unwrap_or(caller),
                url,
            };
            let plxd = &binding.plxd;
            let run = if name == "pr_link" {
                plxd.call::<PrLink>(params).await?.run
            } else {
                plxd.call::<PrUnlink>(params).await?.run
            };
            Ok(pretty(
                &json!({"runId": run.id, "pullRequests": run.pull_requests}),
            ))
        }
        "read_context" | "write_context" => {
            let project = server
                .project
                .ok_or("your thread isn't in a Project, so it has no shared context")?;
            context_tool(server, project, name, arguments).await
        }
        "ask" | "answer" | "escalate" => question::call(binding, name, arguments).await,
        "land" => {
            land::call(
                binding,
                server.project.filter(|_| server.coordinator),
                arguments,
            )
            .await
        }
        "checks_propose" => {
            land::propose(
                binding,
                server.project.filter(|_| server.coordinator),
                arguments,
            )
            .await
        }
        other => Err(format!("no tool is named {other:?}")),
    }
}

/// A memory tool, which only a caller with memory is offered (0044).
async fn memory_tool(server: &Server, name: &str, arguments: Value) -> Result<String, String> {
    let memory = server.memory.as_ref().ok_or("your thread has no memory")?;
    let binding = &server.binding;
    memory
        .call(&binding.plxd, binding.run, name, arguments)
        .await
}

/// `read_context` and `write_context`, on the caller's Project's shared context.
async fn context_tool(
    server: &Server,
    project: ProjectId,
    name: &str,
    arguments: Value,
) -> Result<String, String> {
    let plxd = &server.binding.plxd;
    if name == "read_context" {
        let ReadContextArgs { path } = parse(arguments)?;
        let Some(path) = path else {
            let files = plxd
                .call::<ContextList>(ContextListParams { project })
                .await?
                .files;
            return Ok(pretty(&json!({"files": files})));
        };
        check_text("path", &path, MAX_PATH_BYTES)?;
        let read = plxd
            .call::<ContextRead>(ContextReadParams { project, path })
            .await?;
        return Ok(read.content);
    }
    let WriteContextArgs { path, content } = parse(arguments)?;
    check_text("path", &path, MAX_PATH_BYTES)?;
    if content.len() > MAX_CONTEXT_BYTES {
        return Err(format!("content must be at most {MAX_CONTEXT_BYTES} bytes"));
    }
    let writer = if server.coordinator {
        "coordinator".to_owned()
    } else {
        format!("thread {}", server.binding.run)
    };
    let file = plxd
        .call::<ContextWrite>(ContextWriteParams {
            id: ContextWriteId::generate(),
            project,
            path,
            content,
            writer: Some(writer),
        })
        .await?
        .file;
    Ok(pretty(&file))
}

/// Each of `threads` with its run, in their order.
async fn described(plxd: &Plxd, threads: &[Thread], caller: RunId) -> Result<Vec<Value>, String> {
    let (listed, runs) = host(plxd).await?;
    Ok(threads
        .iter()
        .filter_map(|thread| {
            let run = runs.iter().find(|run| run.id == thread.id)?;
            Some(describe(run, Some(thread), &listed.repos, caller))
        })
        .collect())
}

/// Refuses a tool that would act on the caller itself: a thread can't wait on, message, or stop
/// its own turn from inside it.
fn not_yourself(caller: RunId, target: RunId, what: &str) -> Result<(), String> {
    if caller == target {
        return Err(format!("a thread can't {what} itself"));
    }
    Ok(())
}

/// Whether `run`'s CLI is starting or working on a turn.
fn running(run: &AgentRun) -> bool {
    matches!(run.status, AgentStatus::Starting | AgentStatus::Running)
}

/// Every thread and repo entry, and every run on the host.
async fn host(plxd: &Plxd) -> Result<(ThreadListResult, Vec<AgentRun>), String> {
    let listed = plxd.call::<ThreadList>(ThreadListParams {}).await?;
    let runs = plxd
        .call::<AgentList>(AgentListParams { project: None })
        .await?
        .runs;
    Ok((listed, runs))
}

/// The run `run_id`, a thread's or any other on the host: read alone by an `agent/wait` that
/// doesn't wait, or found in every run on a plxd without `agent/wait`.
async fn find_run(plxd: &Plxd, run_id: RunId) -> Result<AgentRun, String> {
    if plxd.agent_wait().await? {
        return agent_wait(plxd, run_id, Duration::ZERO).await?;
    }
    plxd.call::<AgentList>(AgentListParams { project: None })
        .await?
        .runs
        .into_iter()
        .find(|run| run.id == run_id)
        .ok_or_else(|| missing(run_id))
}

/// `run_id` once it is idle, or as it stands after `timeout`, from `agent/wait`. The outer `Err`
/// is the connection failing first, the inner one plxd's error.
async fn agent_wait(
    plxd: &Plxd,
    run_id: RunId,
    timeout: Duration,
) -> Result<Result<AgentRun, String>, String> {
    let waited = plxd
        .request::<AgentWait>(AgentWaitParams {
            run_ids: vec![run_id],
            until: AgentWaitUntil::Any,
            timeout_ms: u32::try_from(timeout.as_millis()).unwrap_or(u32::MAX),
        })
        .await?;
    Ok(match waited {
        Ok(waited) => waited
            .runs
            .into_iter()
            .next()
            .ok_or_else(|| missing(run_id)),
        Err(error)
            if error
                .parallax_data()
                .is_some_and(|data| data.kind == ErrorKind::RunNotFound) =>
        {
            Err(missing(run_id))
        }
        Err(error) => Err(error.message),
    })
}

fn missing(run_id: RunId) -> String {
    format!("no thread has run id {run_id}")
}

/// What the model sees of a run, and of its thread when it is one.
fn describe(run: &AgentRun, thread: Option<&Thread>, repos: &[Repo], caller: RunId) -> Value {
    let repo = thread
        .and_then(|thread| repos.iter().find(|repo| repo.id == thread.repo))
        .filter(|repo| !repo.scratch);
    let mut value = json!({
        "runId": run.id,
        "you": run.id == caller,
        "status": run.status,
        "backend": run.backend,
        "model": run.model,
        "mode": run.permission,
        "prompt": clip(&run.prompt, PROMPT_PREVIEW_BYTES),
        "branch": run.branch,
        "worktreePath": run.worktree_path,
        "checkout": run.checkout,
        "error": run.error,
        "pullRequests": run.pull_requests,
        "createdAt": run.created_at,
        "updatedAt": run.updated_at,
    });
    if let Some(thread) = thread {
        value["title"] = json!(thread.title);
        value["repo"] = json!(repo.map(|repo| json!({"id": repo.id, "path": repo.path})));
        value["parent"] = json!(thread.parent);
        value["settled"] = json!(thread.settled);
        value["archived"] = json!(thread.archived);
    } else if run.policy == AgentPolicy::WorkspaceWrite {
        // A Project's run: its coordinator's thread is its parent's run id (0024).
        value["parent"] = json!(run.coordinator_thread);
    }
    value
}

/// One page of `run_id`'s transcript after event `after`, rendered for the model.
async fn read(plxd: &Plxd, run_id: RunId, after: u64) -> Result<String, String> {
    let mut page = String::new();
    let mut render = Render::default();
    let mut cursor = after;
    loop {
        let events = plxd
            .call::<AgentEvents>(AgentEventsParams {
                before: None,
                run_id,
                after: cursor,
                limit: Some(1000),
            })
            .await?;
        for logged in &events.events {
            let text = render.event(&logged.event);
            if !page.is_empty() && page.len() + text.len() > PAGE_BYTES {
                return Ok(format!(
                    "{page}\n[more: call thread_read with after={cursor} for the next page]\n"
                ));
            }
            page.push_str(&text);
            cursor = logged.seq;
        }
        if !events.more || events.events.is_empty() {
            if page.is_empty() {
                page.push_str("[nothing after this point yet]\n");
            }
            return Ok(page);
        }
    }
}

/// Renders a run's logged events as a transcript, one at a time.
#[derive(Default)]
struct Render {
    /// The agent's last message, which a turn's result often repeats.
    last_reply: String,
}

impl Render {
    fn event(&mut self, event: &ParallaxEvent) -> String {
        match event {
            ParallaxEvent::AgentStarted { run: Some(run), .. } => {
                format!(
                    "First message:\n{}\n\n",
                    clip(run.prompt.trim(), ITEM_BYTES)
                )
            }
            ParallaxEvent::AgentOutput { items, .. } => {
                items.iter().map(|item| self.item(item)).collect()
            }
            ParallaxEvent::AgentFinished { outcome, .. } => {
                let how = match outcome {
                    AgentOutcome::Completed { .. } => "completed".to_owned(),
                    AgentOutcome::Cancelled => "stopped".to_owned(),
                    AgentOutcome::Failed { message, .. } => {
                        format!("failed: {}", clip(message, TOOL_BYTES))
                    }
                    AgentOutcome::Interrupted => "interrupted by a plxd restart".to_owned(),
                    AgentOutcome::Unknown => "ended".to_owned(),
                };
                format!("[run {how}]\n\n")
            }
            _ => String::new(),
        }
    }

    fn item(&mut self, item: &AgentOutputItem) -> String {
        match item {
            AgentOutputItem::TurnStarted {
                turn_id,
                text: Some(text),
                wake,
                from,
                ..
            } => {
                let who = match from {
                    _ if *wake => "Parallax".to_owned(),
                    Some(from) => format!("Thread {from}"),
                    None => "User".to_owned(),
                };
                // The turn id is what thread_fork takes.
                let turn = turn_id.map(|id| format!(", turn {id}")).unwrap_or_default();
                format!("{who}{turn}:\n{}\n\n", clip(text.trim(), ITEM_BYTES))
            }
            AgentOutputItem::Text { text, .. } if !text.trim().is_empty() => {
                text.trim().clone_into(&mut self.last_reply);
                format!("Agent:\n{}\n\n", clip(&self.last_reply, ITEM_BYTES))
            }
            AgentOutputItem::TurnFinished {
                result: Some(result),
                ..
            } if !result.trim().is_empty() && result.trim() != self.last_reply => {
                result.trim().clone_into(&mut self.last_reply);
                format!("Agent:\n{}\n\n", clip(&self.last_reply, ITEM_BYTES))
            }
            AgentOutputItem::ToolCall { name, input, .. } => {
                format!("[tool {name}: {}]\n", clip(&input.to_string(), TOOL_BYTES))
            }
            AgentOutputItem::ToolResult { status, output, .. } => {
                let status = match status {
                    AgentToolStatus::Ok => "ok",
                    AgentToolStatus::Error => "error",
                    AgentToolStatus::Denied => "denied",
                    AgentToolStatus::Unknown => "ended",
                };
                match output {
                    Some(output) => format!("[result {status}: {}]\n", clip(output, TOOL_BYTES)),
                    None => format!("[result {status}]\n"),
                }
            }
            AgentOutputItem::Interrupted { from } => format!("[stopped by thread {from}]\n"),
            AgentOutputItem::Notice { detail } | AgentOutputItem::Warning { detail } => {
                format!("[{}]\n", clip(detail, TOOL_BYTES))
            }
            AgentOutputItem::FollowUpDropped { .. } => {
                "[a message never reached the agent]\n".to_owned()
            }
            AgentOutputItem::ApprovalRequested { tool_name, .. } => {
                format!("[asks the user to allow {tool_name}]\n")
            }
            _ => String::new(),
        }
    }
}

/// `thread_launch`: a new thread whose parent is the caller.
async fn launch(binding: &Binding, args: LaunchArgs) -> Result<String, String> {
    let LaunchArgs {
        prompt,
        threads,
        title,
        backend,
        account,
        model,
        effort,
        mode,
        workspace,
        repo,
        base,
        branch,
        notify,
    } = args;
    check_text("prompt", &prompt, MAX_TEXT_BYTES)?;
    let account = account_choice(backend, account)?;
    let plxd = &binding.plxd;
    let (listed, runs) = host(plxd).await?;
    let caller = runs
        .iter()
        .find(|run| run.id == binding.run)
        .ok_or("your thread is no longer on this host")?;
    // The caller's own repository, unless it has none.
    let own_repo = listed
        .threads
        .iter()
        .find(|thread| thread.id == binding.run)
        .and_then(|thread| listed.repos.iter().find(|repo| repo.id == thread.repo))
        .filter(|repo| !repo.scratch)
        .map(|repo| repo.id);
    let repo = match repo {
        Some(repo) => Some(resolve_repo(plxd, &listed.repos, &repo).await?),
        None => own_repo,
    };
    let workspace = workspace.unwrap_or(if repo.is_some() {
        Workspace::Worktree
    } else {
        Workspace::None
    });
    let (repo, checkout) = match workspace {
        Workspace::None if base.is_some() || branch.is_some() => {
            return Err("base and branch need a repository's workspace".to_owned());
        }
        Workspace::None => (None, false),
        Workspace::Worktree if branch.is_some() => {
            return Err("branch goes with workspace checkout; use base for a worktree".to_owned());
        }
        Workspace::Checkout if base.is_some() => {
            return Err("base goes with workspace worktree; use branch for a checkout".to_owned());
        }
        Workspace::Worktree | Workspace::Checkout => {
            let repo = repo.ok_or("you have no repository; name one in repo")?;
            (Some(repo), matches!(workspace, Workspace::Checkout))
        }
    };
    // The caller's mode, as a coordinator's subagents get its (0027), when the child runs on the
    // same backend, which maps it.
    let same_backend = match &account {
        None => true,
        Some(AccountChoice::Subscription { backend }) => caller.backend == *backend,
        Some(_) => false,
    };
    let permission = mode.or_else(|| same_backend.then_some(caller.permission).flatten());
    check_mode(caller.permission, permission)?;
    let started = plxd
        .call::<ThreadStart>(ThreadStartParams {
            run_id: RunId::generate(),
            repo,
            project: None,
            parent: Some(binding.run),
            notify,
            title,
            prompt,
            account,
            model,
            effort,
            permission,
            context_window: None,
            fast: None,
            branch_slug: None,
            images: Vec::new(),
            threads,
            // As a thread the user starts: full Claude Code, asking the app (0034).
            approvals: true,
            checkout,
            base,
            checkout_ref: branch,
            naming: None,
        })
        .await?;
    let (listed, _) = host(plxd).await?;
    Ok(pretty(&describe(
        &started.run,
        Some(&started.thread),
        &listed.repos,
        binding.run,
    )))
}

/// `thread_send`: `agent/send` from the caller, queued behind the target's running turn, or into
/// it with `steer` (0048).
async fn send(binding: &Binding, args: SendArgs) -> Result<String, String> {
    let caller = binding.run;
    let SendArgs {
        run_id,
        text,
        threads,
        steer,
    } = args;
    not_yourself(caller, run_id, "send a message to")?;
    check_text("text", &text, MAX_TEXT_BYTES)?;
    let plxd = &binding.plxd;
    // plxd resumes an idle run with a steer, as with any message, so refuse it here.
    // ponytail: the target can still end between this check and the send, and then resumes with
    // the message as an ordinary one.
    if steer && !running(&find_run(plxd, run_id).await?) {
        return Err(format!(
            "thread {run_id} isn't running a turn, so there is nothing to steer; send without \
             steer to start its next turn"
        ));
    }
    let run = plxd
        .call::<AgentSend>(AgentSendParams {
            run_id,
            turn_id: TurnId::generate(),
            text,
            model: None,
            effort: None,
            permission: None,
            context_window: None,
            fast: None,
            account: None,
            images: Vec::new(),
            threads,
            from: Some(caller),
            delivery: steer.then_some(AgentDelivery::Steer),
        })
        .await?
        .run;
    Ok(pretty(&describe(&run, None, &[], caller)))
}

/// `thread_fork`: `thread/fork` with the caller as the fork's parent. The fork runs in its
/// original's mode, so that mode must be within the caller's, as a launched child's is (0041).
/// plxd's refusals, such as a turn still running or one a fork copied, are the tool's errors.
async fn fork(binding: &Binding, args: ForkArgs) -> Result<String, String> {
    let ForkArgs {
        run_id,
        turn_id,
        backend,
        account,
        model,
    } = args;
    let account = account_choice(backend, account)?;
    let plxd = &binding.plxd;
    let (_, runs) = host(plxd).await?;
    let find = |id: RunId| runs.iter().find(|run| run.id == id);
    let caller = find(binding.run).ok_or("your thread is no longer on this host")?;
    let original = find(run_id).ok_or_else(|| format!("no thread has run id {run_id}"))?;
    check_mode(caller.permission, original.permission)?;
    let forked = plxd
        .call::<ThreadFork>(ThreadForkParams {
            run_id,
            new_run_id: RunId::generate(),
            turn_id,
            account,
            model,
            parent: Some(binding.run),
        })
        .await?;
    let (listed, _) = host(plxd).await?;
    Ok(pretty(&describe(
        &forked.run,
        Some(&forked.thread),
        &listed.repos,
        binding.run,
    )))
}

/// `thread_launch`'s and `thread_fork`'s account: a backend's login or a key account, or the
/// default.
fn account_choice(
    backend: Option<String>,
    account: Option<AccountId>,
) -> Result<Option<AccountChoice>, String> {
    match (backend, account) {
        (Some(_), Some(_)) => Err("give a backend or an account, not both".to_owned()),
        (Some(backend), None) => Ok(Some(AccountChoice::Subscription { backend })),
        (None, Some(id)) => Ok(Some(AccountChoice::Key { id })),
        (None, None) => Ok(None),
    }
}

/// `thread_launch` for a Project's coordinator: a child in its Project, through `agent/start` with
/// the caller as its coordinator thread, so its parent is the caller (0041). It works in a new
/// worktree of the Project's repository as a thread asking through the inbox, and plxd runs
/// it in the Project's mode (0042), so the options that pick a workspace, a mode, or a title are
/// refused.
async fn launch_child(server: &Server, args: LaunchArgs) -> Result<String, String> {
    let LaunchArgs {
        prompt,
        threads,
        title,
        backend,
        account,
        model,
        effort,
        mode,
        workspace,
        repo,
        base,
        branch,
        notify,
    } = args;
    let fixed = [
        ("title", title.is_some()),
        ("mode", mode.is_some()),
        ("workspace", workspace.is_some()),
        ("repo", repo.is_some()),
        ("base", base.is_some()),
        ("branch", branch.is_some()),
    ];
    if let Some((name, _)) = fixed.iter().find(|(_, given)| *given) {
        return Err(format!(
            "a Project's child runs in a new worktree of the Project's repository, in the \
             Project's mode, with no title; leave out {name}"
        ));
    }
    check_text("prompt", &prompt, MAX_TEXT_BYTES)?;
    let account = account_choice(backend, account)?;
    let caller = server.binding.run;
    let project = server.project.ok_or("your thread isn't in a Project")?;
    let thread = CoordinatorThreadId::try_from(Uuid::from(caller))
        .map_err(|_| format!("run {caller} can't be a coordinator thread"))?;
    let plxd = &server.binding.plxd;
    let run = plxd
        .call::<AgentStart>(AgentStartParams {
            run_id: RunId::generate(),
            project,
            prompt,
            policy: AgentPolicy::WorkspaceWrite,
            account,
            coordinator_thread: Some(thread),
            notify,
            model,
            effort,
            context_window: None,
            fast: None,
            // The Project's mode, whatever is asked (0042).
            permission: None,
            images: Vec::new(),
            // plxd turns them on for every run in a Project (0042).
            approvals: false,
            threads,
            explore: false,
        })
        .await?
        .run;
    Ok(pretty(&describe(&run, None, &[], caller)))
}

/// Refuses a child `mode`, launched or forked, that needs less approval than the caller's `theirs`
/// (0041). No mode means Edit.
fn check_mode(
    theirs: Option<AgentPermission>,
    mode: Option<AgentPermission>,
) -> Result<(), String> {
    let theirs = theirs.unwrap_or(AgentPermission::Edit);
    let child = mode.unwrap_or(AgentPermission::Edit);
    if reach(child).is_some_and(|child| reach(theirs) >= Some(child)) {
        return Ok(());
    }
    let name = |mode| crate::agents::convert::option_name(mode).unwrap_or_default();
    Err(format!(
        "you run in {} mode, so a thread you launch or fork can't run in {}, which needs less \
         approval",
        name(theirs),
        name(child)
    ))
}

/// How much `mode` lets a run do without asking, least first, or `None` for a mode this plxd
/// doesn't know.
fn reach(mode: AgentPermission) -> Option<u8> {
    match mode {
        AgentPermission::Plan => Some(0),
        AgentPermission::Manual => Some(1),
        AgentPermission::Edit => Some(2),
        AgentPermission::Auto => Some(3),
        AgentPermission::Bypass => Some(4),
        AgentPermission::Unknown => None,
    }
}

/// The repo entry `repo` names, by id or by path, registering a repository on the host that has
/// none yet, as adding it in the app does.
async fn resolve_repo(plxd: &Plxd, repos: &[Repo], repo: &str) -> Result<RepoId, String> {
    if let Some(found) = repos
        .iter()
        .find(|entry| !entry.scratch && entry.id.to_string() == repo)
    {
        return Ok(found.id);
    }
    let path = Path::new(repo);
    if !path.is_absolute() {
        return Err(format!(
            "repo {repo:?} is neither a repo id from thread_list nor an absolute path"
        ));
    }
    let canonical = std::fs::canonicalize(path).unwrap_or_else(|_| path.to_owned());
    if let Some(found) = repos
        .iter()
        .find(|entry| !entry.scratch && Path::new(&entry.path) == canonical)
    {
        return Ok(found.id);
    }
    let added = plxd
        .call::<RepoAdd>(RepoAddParams {
            id: RepoId::generate(),
            path: canonical.to_string_lossy().into_owned(),
        })
        .await?;
    Ok(added.repo.id)
}

/// `thread_wait`: waits until `run_id` is idle or `timeout` passes, in `agent/wait` calls of at
/// most [`MAX_AGENT_WAIT`], or on a plxd without `agent/wait` by checking it every [`POLL`]. A
/// connection that can't be opened, or an `agent/wait` whose connection fails, is tried again
/// after [`POLL`] on a new connection, so a plxd restart meanwhile doesn't end the wait. Without
/// `agent/wait`, a connection that fails during a check ends it.
async fn wait(
    plxd: &Plxd,
    run_id: RunId,
    timeout: Duration,
    caller: RunId,
) -> Result<String, String> {
    let deadline = Instant::now() + timeout;
    loop {
        let checked = match plxd.agent_wait().await {
            Ok(true) => {
                let left = deadline.saturating_duration_since(Instant::now());
                agent_wait(plxd, run_id, left.min(MAX_AGENT_WAIT)).await
            }
            Ok(false) => Ok(find_run(plxd, run_id).await),
            Err(error) => Err(error),
        };
        let failed = match checked {
            Ok(run) => {
                let run = run?;
                let idle = !running(&run);
                if idle || Instant::now() >= deadline {
                    let output = last_output(plxd, run_id).await?;
                    return Ok(pretty(&json!({
                        "idle": idle,
                        "timedOut": !idle,
                        "thread": describe(&run, None, &[], caller),
                        "lastOutput": output.map(|text| tail(&text, LAST_OUTPUT_BYTES)),
                    })));
                }
                None
            }
            Err(error) => Some(error),
        };
        if let Some(error) = failed
            && Instant::now() >= deadline
        {
            return Err(error);
        }
        // plxd may be restarting: try again until the deadline.
        sleep(POLL).await;
    }
}

/// `thread_update`: `thread/update` for a title or settled, then `thread/archive`.
async fn update(binding: &Binding, args: UpdateArgs) -> Result<String, String> {
    let UpdateArgs {
        run_id,
        title,
        settled,
        archived,
    } = args;
    if title.is_none() && settled.is_none() && archived.is_none() {
        return Err("give a title, settled, or archived".to_owned());
    }
    let run_id = run_id.unwrap_or(binding.run);
    let plxd = &binding.plxd;
    let mut thread = None;
    if title.is_some() || settled.is_some() {
        let updated = plxd
            .call::<ThreadUpdate>(ThreadUpdateParams {
                run_id,
                seen: false,
                snoozed_until: None,
                title,
                settled,
            })
            .await?;
        thread = Some(updated.thread);
    }
    if let Some(archived) = archived {
        let updated = plxd
            .call::<ThreadArchive>(ThreadArchiveParams { run_id, archived })
            .await?;
        thread = Some(updated.thread);
    }
    Ok(pretty(&thread))
}

#[cfg(test)]
mod tests {
    use super::{ALLOWED_TOOLS, CONTEXT_TOOLS, TOOLS, definitions};
    use crate::mcp::{SERVER, device, land, question};

    #[test]
    fn the_allowlist_is_the_servers_name_and_each_role_lists_its_tools() {
        assert_eq!(ALLOWED_TOOLS, [format!("mcp__{SERVER}")]);
        for (project, tools) in [
            (false, TOOLS.to_vec()),
            (true, [TOOLS, CONTEXT_TOOLS].concat()),
        ] {
            let listed: Vec<String> = definitions(project)
                .as_array()
                .unwrap()
                .iter()
                .map(|tool| tool["name"].as_str().unwrap().to_owned())
                .collect();
            assert_eq!(listed, tools);
        }
        for coordinator in [false, true] {
            let tools = [
                question::definitions(coordinator),
                land::definitions(coordinator),
            ]
            .concat();
            let listed: Vec<&str> = tools
                .iter()
                .map(|tool| tool["name"].as_str().unwrap())
                .collect();
            assert_eq!(
                listed,
                [question::tools(coordinator), land::tools(coordinator)].concat()
            );
        }
    }

    #[test]
    fn the_coordinators_instructions_name_only_real_tools() {
        let instructions = include_str!("../agents/coordinator.md");
        // Every `snake_case` span between backticks.
        for name in instructions.split('`').skip(1).step_by(2) {
            if name.contains('_') && name.chars().all(|c| c.is_ascii_lowercase() || c == '_') {
                assert!(
                    [TOOLS, CONTEXT_TOOLS, crate::mcp::memory::COORDINATOR_TOOLS]
                        .concat()
                        .contains(&name)
                        || land::TOOLS.contains(&name),
                    "coordinator.md names `{name}`, not a tool"
                );
            }
        }
    }

    /// The caller is bound by `--thread`: no tool takes it, so only a target may be named.
    #[test]
    fn no_tool_takes_the_callers_id_or_unknown_fields() {
        let mut tools = definitions(true).as_array().unwrap().clone();
        tools.extend(question::definitions(false));
        tools.extend(question::definitions(true));
        tools.extend(land::definitions(true));
        tools.extend(device::definitions());
        for tool in &tools {
            let schema = &tool["inputSchema"];
            assert_eq!(schema["additionalProperties"], false, "{tool}");
            let properties = schema["properties"].as_object().unwrap();
            for name in properties.keys() {
                let name = name.to_lowercase();
                assert!(
                    !["caller", "from", "parent", "self"].contains(&name.as_str()),
                    "{} takes {name}",
                    tool["name"]
                );
            }
        }
    }
}
