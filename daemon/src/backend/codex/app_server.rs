//! A Codex thread (0017, 0035): the user's own `codex app-server`, as full Codex.
//!
//! # The command
//!
//! `codex app-server`, which speaks JSON-RPC over stdio, one message per line. It loads the
//! user's `config.toml`, rules, `AGENTS.md` files, skills, hooks, plugins, and MCP servers, as
//! `codex` in a terminal does. Every thread on one login shares one app-server ([`Server`], 0060),
//! started in the first thread's cwd, which sends `initialize` and `initialized` once. Each thread
//! then sends `thread/start` with its own cwd, or `thread/resume` with the earlier run's thread id
//! (`thread/fork` for a fork's first run, 0050), with the model, the context window as
//! `model_context_window`, the thread's `plxd mcp --thread` server as dotted `mcp_servers.plxd.*`
//! overrides that join the user's servers, its tools approved without asking (0041), fast mode as
//! the `priority` service tier, and the mode's approval policy and sandbox ([`mode`]). The prompt
//! is the first `turn/start`, as written, with its images as `localImage` files ([`write_images`])
//! and the effort. A turn that is exactly `/compact` ([`is_compact`], PLX-638) is
//! `thread/compact/start` instead, which Codex runs as a turn with a `contextCompaction` item.
//! Each follow-up is a later turn in the same process, sent once the turn before it has
//! completed. A steer (PLX-370) is `turn/steer` with the running turn's id, which
//! codex-cli 0.160.0 adds to that turn's input after its current item; if Codex refuses it, or no
//! turn runs, it is the next turn instead. Once no turn, steer, or approval request is outstanding
//! and plxd no longer holds the thread ([`Run::hold`](super::super::Run::hold)), the thread sends
//! `thread/unsubscribe`, which lets app-server unload it and stop its MCP servers, and the run
//! ends; `agent/send` then resumes the thread in a new run. app-server exits once its last thread
//! has left. If it exits first, every thread on it fails.
//!
//! # Approval requests
//!
//! Codex asks the client before what its approval policy doesn't allow: a command
//! (`item/commandExecution/requestApproval`), a patch (`item/fileChange/requestApproval`), more
//! sandbox permissions (`item/permissions/requestApproval`), or an MCP server's question
//! (`mcpServer/elicitation/request`). With [`RunRequest::approvals`], each is an
//! [`Event::ApprovalRequested`], and [`Run::answer`](super::super::Run::answer)'s answer is the
//! request's JSON-RPC response ([`translate::answer_response`]). `serverRequest/resolved` for a
//! request still waiting, or app-server exiting, withdraws it. Without `approvals`, the thread
//! runs with approval policy `never` inside the mode's sandbox, so its commands run sandboxed
//! without asking, and plxd declines any request that still comes. Codex's other requests get a
//! JSON-RPC error, so it never waits on plxd.
//!
//! # Credentials
//!
//! The run drops every inherited [`SCRUBBED_PREFIXES`] variable, and a subscription
//! gets only its account's `CODEX_HOME`, if it has one. app-server reads no API key from the
//! environment (checked with 0.159.3: `account/read` finds no account with `CODEX_API_KEY` or
//! `OPENAI_API_KEY` set), so a thread on an API key account is refused rather than billed to the
//! login.
//!
//! # Cancel
//!
//! Other threads share the process, so cancel sends `turn/interrupt` for the running turn and
//! leaves the thread at once. The thread keeps what it had written, so a later run resumes it.

#[cfg(all(test, unix))]
mod tests;
mod translate;

use std::collections::{HashMap, VecDeque};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, PoisonError, Weak};

use serde_json::{Map, Value, json};
use tempfile::TempDir;
use tokio::sync::{mpsc, watch};
use tokio_util::sync::{CancellationToken, DropGuard};

use self::translate::{Ask, Step, Translator, answer_response, refusal};
use super::{CONFIG_DIR_ENV, CONTEXT_WINDOWS, PROGRAM, effort_level, write_images};
use crate::backend::event::{Event, Failure, FailureKind, Outcome, WarningKind, exit_outcome};
use crate::backend::process::{
    Exit, Launcher, Output, Process, ProcessSpec, SpawnError, StdinMode, write_lines,
};
use crate::backend::{
    AgentPermission, Answer, ApprovalId, CancelSwitch, Credential, Decision, EVENT_BUFFER,
    EventSink, FollowUp, Held, Overrides, RunHandle, RunRequest, StartError, Started, TurnId,
    check_argument, is_compact,
};

/// The permissions a thread maps, in the picker's order (0027, 0054): Codex's own presets
/// ([`mode`]). Plan is Codex's experimental collaboration mode, which plxd doesn't run (0035).
pub const PERMISSIONS: &[AgentPermission] = &[
    AgentPermission::Manual,
    AgentPermission::Edit,
    AgentPermission::Auto,
    AgentPermission::Bypass,
];

/// The approval policy, sandbox mode, and approvals reviewer a thread in `permission` runs with:
///
/// | Parallax | `approvalPolicy` | `sandbox` | `approvalsReviewer` |
/// | --- | --- | --- | --- |
/// | Manual | `untrusted` | `workspace-write` | |
/// | Accept Edits (the default) | `on-request` | `workspace-write` | |
/// | Auto | `on-request` | `workspace-write` | `auto_review` |
/// | Bypass Permissions | `never` | `danger-full-access` | |
///
/// # Errors
///
/// [`StartError::Unsupported`] for Plan or a permission this version doesn't know.
pub fn mode(
    permission: Option<AgentPermission>,
) -> Result<(&'static str, &'static str, Option<&'static str>), StartError> {
    match permission {
        None | Some(AgentPermission::Edit) => Ok(("on-request", "workspace-write", None)),
        Some(AgentPermission::Manual) => Ok(("untrusted", "workspace-write", None)),
        Some(AgentPermission::Auto) => Ok(("on-request", "workspace-write", Some("auto_review"))),
        Some(AgentPermission::Bypass) => Ok(("never", "danger-full-access", None)),
        Some(AgentPermission::Plan | AgentPermission::Unknown) => Err(StartError::Unsupported(
            "a Codex thread has no plan mode (decision 0035)".into(),
        )),
    }
}

/// Starts `request`, a thread's run, on `launcher`'s `codex app-server`.
///
/// # Errors
///
/// [`StartError::Unsupported`] for an API key account, a permission [`mode`] doesn't map, or an
/// effort or context window Codex doesn't know; [`StartError::Invalid`] for an empty message or a
/// model or resume id that can't be an argument; and the spawn's error.
pub(super) fn start(
    launcher: &Launcher,
    overrides: &Overrides,
    servers: &Servers,
    request: RunRequest,
) -> Result<Started, StartError> {
    if request.prompt.is_empty() && request.images.is_empty() {
        return Err(StartError::Invalid("the prompt is empty".into()));
    }
    let Credential::Subscription { .. } = &request.account.credential else {
        return Err(StartError::Unsupported(
            "a Codex thread runs on a Codex login; app-server can't take an API key (decision \
             0035)"
                .into(),
        ));
    };
    let (thread_method, thread) = thread_params(&request)?;
    let effort = request.effort.map(effort_level).transpose()?;
    let temp_dir = launcher.data_dir().temp_dir();
    let (images, image_paths) = write_images(&temp_dir, &request.images)
        .map_err(SpawnError::Io)?
        .unzip();

    let home = overrides.config_home(&request.account.credential);
    let (server, inbox, key) = Server::join(launcher, overrides, servers, home)?;

    // A cancel interrupts this thread's turn on the shared app-server, not the process.
    let switch = CancelSwitch::new();
    let (handle, control) = RunHandle::new(request.run_id, true, switch.clone());
    let (handle, answers) = handle.with_answers();
    let held = handle.held();
    let baseline = request
        .resume
        .map(|resume| resume.usage_totals)
        .unwrap_or_default();
    let (sink, events) = EventSink::channel(EVENT_BUFFER, baseline);
    let first = Turn {
        id: request.turn_id,
        input: input(&request.prompt, image_paths.as_deref().unwrap_or_default()),
        compact: is_compact(&request.prompt, &request.images),
    };
    let ready = server.ready.subscribe();
    let driver = Driver {
        server,
        inbox,
        key,
        ready,
        closing: false,
        control,
        answers,
        held,
        sink,
        switch,
        translator: Translator::default(),
        approvals: request.approvals,
        effort,
        thread: Some((thread_method, thread)),
        thread_id: None,
        requests: HashMap::new(),
        running: None,
        queued: VecDeque::from([first]),
        started_any: false,
        asks: HashMap::new(),
        temp_dir,
        images: images.into_iter().collect(),
        failure: None,
        last_result: None,
        turns_done: 0,
    };
    tokio::spawn(driver.run());
    Ok(Started {
        run: Arc::new(handle),
        events,
    })
}

/// `codex app-server` in `cwd`, as a thread on the subscription whose configuration folder is
/// `config_home` (the default one when absent) runs it: the inherited [`SCRUBBED_PREFIXES`]
/// variables dropped, the instance's `overrides` applied, and stdin piped.
pub(super) fn spec(
    launcher: &Launcher,
    overrides: &Overrides,
    cwd: &Path,
    config_home: Option<&Path>,
) -> ProcessSpec {
    let mut spec = ProcessSpec::new(PROGRAM, cwd);
    spec.args = vec!["app-server".into()];
    spec.scrub = launcher.base().starting_with(super::SCRUBBED_PREFIXES);
    if let Some(home) = config_home {
        spec.inject.set(CONFIG_DIR_ENV, home);
    }
    spec.stdin = StdinMode::Piped;
    spec.record = Some("codex");
    overrides.apply(&mut spec);
    spec
}

/// The JSON-RPC `initialize` params plxd sends app-server.
pub(super) fn initialize_params() -> Value {
    let client = json!({"name": "plxd", "title": "Parallax", "version": env!("CARGO_PKG_VERSION")});
    json!({"clientInfo": client, "capabilities": null})
}

/// `thread/start`, `thread/resume` for a run that resumes a thread, or `thread/fork` for a fork's
/// first run, and its params: the cwd,
/// the mode ([`mode`]), the model, the context window, the Parallax MCP server, and fast mode.
fn thread_params(request: &RunRequest) -> Result<(&'static str, Value), StartError> {
    let (mut approval_policy, sandbox, mut reviewer) = mode(request.permission)?;
    // A client that can't show a request: Codex's own sandbox holds the thread, and nothing asks,
    // as a Claude thread without `approvals` keeps its sandbox (0034).
    if !request.approvals {
        (approval_policy, reviewer) = ("never", None);
    }
    if let Some(model) = &request.model {
        check_argument("model", model)?;
    }
    let mut thread = json!({
        "cwd": request.cwd,
        "approvalPolicy": approval_policy,
        "sandbox": sandbox,
        "model": request.model,
    });
    if let Some(reviewer) = reviewer {
        thread["approvalsReviewer"] = reviewer.into();
    }
    let mut config = serde_json::Map::new();
    if (request.approvals || request.permission == Some(AgentPermission::Bypass))
        && let Some(tools) = request.full_agent_tools()
    {
        let server = &tools.mcp_config()?["mcpServers"][crate::mcp::SERVER];
        // Dotted overrides merge into the user's MCP map rather than replacing it.
        for field in ["command", "args"] {
            config.insert(
                format!("mcp_servers.{}.{field}", crate::mcp::SERVER),
                server[field].clone(),
            );
        }
        config.insert(
            format!(
                "mcp_servers.{}.default_tools_approval_mode",
                crate::mcp::SERVER
            ),
            "approve".into(),
        );
    }
    if let Some(tokens) = request.context_window {
        if !CONTEXT_WINDOWS.contains(&tokens) {
            return Err(StartError::Unsupported(format!(
                "Codex has no {tokens}-token context window"
            )));
        }
        config.insert("model_context_window".into(), tokens.into());
    }
    if !config.is_empty() {
        thread["config"] = config.into();
    }
    if let Some(fast) = request.fast {
        // The catalog's tier named "Fast" is `priority`.
        thread["serviceTier"] = if fast { "priority" } else { "default" }.into();
    }
    let thread_method = match &request.resume {
        Some(resume) => {
            check_argument("resume id", &resume.session_id)?;
            thread["threadId"] = resume.session_id.clone().into();
            thread["excludeTurns"] = true.into();
            // A fork's first run continues a copy of the thread under a new id (0050).
            if resume.fork {
                "thread/fork"
            } else {
                "thread/resume"
            }
        }
        None => "thread/start",
    };
    Ok((thread_method, thread))
}

/// A turn's `input`: its images as `localImage` files, then its text, if any.
fn input(text: &str, images: &[PathBuf]) -> Value {
    let images = images
        .iter()
        .map(|path| json!({"type": "localImage", "path": path}));
    let text = (!text.trim().is_empty())
        .then(|| json!({"type": "text", "text": text, "text_elements": []}));
    images.chain(text).collect()
}

/// A turn to start: the caller's id for it and its input, or a `/compact` (PLX-638), which
/// compacts the thread instead.
#[derive(Debug)]
struct Turn {
    id: Option<TurnId>,
    input: Value,
    compact: bool,
}

/// The turn Codex is running: its caller's id, if it has one, Codex's own once `turn/start` has
/// answered, and the messages steered into it, whose turns end with it.
#[derive(Debug)]
struct Running {
    turn_id: Option<TurnId>,
    codex_id: Option<String>,
    steered: Vec<TurnId>,
}

/// What one of plxd's requests was, to read its response.
#[derive(Debug)]
enum Request {
    Thread,
    Turn,
    /// A `turn/steer` with the message it carries, which becomes the next turn if Codex refuses.
    Steer(Turn),
}

/// The app-servers a backend's threads share, one per login's configuration folder (0060). A
/// server lives while a thread holds it.
pub(super) type Servers = Arc<Mutex<HashMap<Option<PathBuf>, Weak<Server>>>>;

/// One `codex app-server` that every thread on a login shares, as T3 Code runs one per provider
/// instance (0060). It sends `initialize` itself, and routes each line it reads to its thread:
/// a response by its request's id, a notification or server request by its `threadId`. A
/// notification for no thread, such as `account/rateLimits/updated`, goes to every thread. Once
/// the last thread leaves, dropping it closes stdin, and app-server exits.
pub(super) struct Server {
    /// Writes lines to stdin in order, off the threads' loops, so an app-server that stops
    /// reading can't keep a thread from reading.
    stdin: mpsc::UnboundedSender<String>,
    next_id: AtomicU64,
    routes: Mutex<Routes>,
    /// `initialize`'s answer, once it came: threads start once it's `Ok`.
    ready: watch::Sender<Option<Result<(), String>>>,
    /// app-server exited, so no new thread joins it.
    dead: AtomicBool,
    /// Tells the reader the last thread left, even while app-server writes nothing.
    _left: DropGuard,
}

/// Where a line goes.
#[derive(Default)]
struct Routes {
    next_key: u64,
    /// Each thread's inbox, by plxd's key for it.
    inboxes: HashMap<u64, mpsc::UnboundedSender<Inbound>>,
    /// Codex's thread ids, once `thread/start` answered.
    native: HashMap<String, u64>,
    /// Requests waiting for their answers.
    requests: HashMap<u64, u64>,
}

impl Routes {
    /// A new thread's inbox, and its key.
    fn add(&mut self, inbox: mpsc::UnboundedSender<Inbound>) -> u64 {
        self.next_key += 1;
        self.inboxes.insert(self.next_key, inbox);
        self.next_key
    }
}

/// What reaches a thread from its app-server.
enum Inbound {
    Line(Vec<u8>),
    Oversized(usize),
    /// app-server exited, as it did if it did.
    Exited(Option<Exit>),
}

/// How a thread left its server.
enum End {
    /// It was done, or cancelled.
    Left,
    /// app-server exited, as it did if it could tell.
    Exited(Option<Exit>),
}

/// `initialize`'s id: the first request a server sends.
const INITIALIZE: u64 = 1;

impl Server {
    /// The running server for `home` in `servers`, or a new one started in `cwd`, with a new
    /// thread's inbox and key.
    fn join(
        launcher: &Launcher,
        overrides: &Overrides,
        servers: &Servers,
        home: Option<PathBuf>,
    ) -> Result<(Arc<Self>, mpsc::UnboundedReceiver<Inbound>, u64), SpawnError> {
        let mut servers = servers.lock().unwrap_or_else(PoisonError::into_inner);
        servers.retain(|_, server| server.strong_count() > 0);
        let (inbox, receiver) = mpsc::unbounded_channel();
        if let Some(server) = servers.get(&home).and_then(Weak::upgrade) {
            // Checked under the routes' lock, which the reader holds as it marks the server dead
            // and tells its threads, so a thread joins before that or not at all.
            let mut routes = server.routes();
            if !server.dead.load(Ordering::Acquire) {
                let key = routes.add(inbox);
                drop(routes);
                return Ok((server, receiver, key));
            }
        }
        let server = Self::spawn(launcher, overrides, home.as_deref())?;
        servers.insert(home, Arc::downgrade(&server));
        let key = server.routes().add(inbox);
        Ok((server, receiver, key))
    }

    /// Starts app-server in plxd's data folder, which no thread's Accept or delete removes; each
    /// thread names its own cwd in `thread/start`.
    fn spawn(
        launcher: &Launcher,
        overrides: &Overrides,
        home: Option<&Path>,
    ) -> Result<Arc<Self>, SpawnError> {
        let cwd = launcher.data_dir().root().to_owned();
        std::fs::create_dir_all(&cwd).map_err(SpawnError::Io)?;
        let mut process = launcher.spawn(&spec(launcher, overrides, &cwd, home))?;
        let (stdin, lines) = mpsc::unbounded_channel();
        if let Some(pipe) = process.take_stdin() {
            tokio::spawn(write_lines(pipe, lines));
        }
        let left = CancellationToken::new();
        let server = Arc::new(Self {
            stdin,
            next_id: AtomicU64::new(INITIALIZE),
            routes: Mutex::default(),
            ready: watch::Sender::new(None),
            dead: AtomicBool::new(false),
            _left: left.clone().drop_guard(),
        });
        server.send(
            &json!({"id": INITIALIZE, "method": "initialize", "params": initialize_params()}),
        );
        tokio::spawn(read(Arc::downgrade(&server), process, left));
        Ok(server)
    }

    fn send(&self, message: &Value) {
        let _ = self.stdin.send(format!("{message}\n"));
    }

    /// Sends request `method` for thread `key`, whose answer goes to it, and returns its id.
    /// With no `key`, nothing reads the answer.
    fn request(&self, key: Option<u64>, method: &str, params: &Value) -> u64 {
        let id = self.next_id.fetch_add(1, Ordering::Relaxed) + 1;
        if let Some(key) = key {
            self.routes().requests.insert(id, key);
        }
        self.send(&json!({"id": id, "method": method, "params": params}));
        id
    }

    /// Codex's thread `native` is thread `key`'s.
    fn bind(&self, key: u64, native: String) {
        self.routes().native.insert(native, key);
    }

    /// Thread `key` is done: lines for it are dropped from now on.
    fn leave(&self, key: u64) {
        let mut routes = self.routes();
        routes.inboxes.remove(&key);
        routes.native.retain(|_, owner| *owner != key);
        routes.requests.retain(|_, owner| *owner != key);
    }

    fn routes(&self) -> std::sync::MutexGuard<'_, Routes> {
        self.routes.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// Sends `line` where it goes.
    fn route(&self, line: Vec<u8>) {
        let Ok(Value::Object(message)) = serde_json::from_slice::<Value>(&line) else {
            // Every thread's translator warns about it.
            return self.broadcast(|| Inbound::Line(line.clone()));
        };
        let thread = message
            .get("params")
            .and_then(|params| params.get("threadId"))
            .and_then(Value::as_str);
        let id = message.get("id");
        let routes = self.routes();
        let key = match (id, message.get("method"), thread) {
            (Some(id), None, _) => {
                let id = id.as_u64();
                if id == Some(INITIALIZE) {
                    drop(routes);
                    return self.initialized(&message);
                }
                id.and_then(|id| routes.requests.get(&id).copied())
            }
            (id, Some(method), Some(thread)) => {
                let key = routes.native.get(thread).copied();
                // A request for a thread none of plxd's is, such as a subagent's child thread's
                // approval, gets an error, so Codex never waits on it, as T3 Code answers one.
                if key.is_none()
                    && let Some(id) = id
                {
                    let message = format!("plxd has no thread {thread} for {method}");
                    self.send(&json!({"id": id, "error": refusal(&message)}));
                    return;
                }
                key
            }
            // A server request for no thread gets one answer, from any thread.
            (Some(_), Some(_), None) => routes.inboxes.keys().next().copied(),
            (None, Some(_), None) => {
                drop(routes);
                return self.broadcast(|| Inbound::Line(line.clone()));
            }
            (None, None, _) => None,
        };
        if let Some(inbox) = key.and_then(|key| routes.inboxes.get(&key)) {
            let _ = inbox.send(Inbound::Line(line));
        }
    }

    /// `initialize` answered: sends `initialized`, and lets the threads start.
    fn initialized(&self, message: &Map<String, Value>) {
        let ready = match message.get("error") {
            None => {
                self.send(&json!({"method": "initialized"}));
                Ok(())
            }
            Some(error) => Err(error
                .get("message")
                .and_then(Value::as_str)
                .unwrap_or("app-server refused to initialize")
                .to_owned()),
        };
        self.ready.send_replace(Some(ready));
    }

    fn broadcast(&self, inbound: impl Fn() -> Inbound) {
        for inbox in self.routes().inboxes.values() {
            let _ = inbox.send(inbound());
        }
    }
}

/// Reads `process`'s output for `server` until it exits, then tells every thread.
async fn read(server: Weak<Server>, mut process: Process, left: CancellationToken) {
    loop {
        let output = tokio::select! {
            output = process.next() => output,
            () = left.cancelled() => {
                // The last thread left, which closed stdin: app-server exits, or after a grace
                // period dropping `process` kills it, however stuck.
                let exited = async {
                    while !matches!(process.next().await, Some(Output::Exited(_)) | None) {}
                };
                let _ = tokio::time::timeout(EXIT_GRACE, exited).await;
                return;
            }
        };
        let Some(server) = server.upgrade() else {
            continue;
        };
        match output {
            Some(Output::Line(line)) => server.route(line),
            Some(Output::Oversized { bytes }) => server.broadcast(|| Inbound::Oversized(bytes)),
            exited => {
                let exit = match exited {
                    Some(Output::Exited(exit)) => Some(exit),
                    _ => None,
                };
                let routes = server.routes();
                server.dead.store(true, Ordering::Release);
                for inbox in routes.inboxes.values() {
                    let _ = inbox.send(Inbound::Exited(exit.clone()));
                }
                return;
            }
        }
    }
}

/// How long app-server gets to exit once its last thread has left.
const EXIT_GRACE: std::time::Duration = std::time::Duration::from_secs(5);

/// One thread on its shared app-server: forwards its events, runs its turns one at a time,
/// relays approval requests, and decides the outcome when it leaves.
struct Driver {
    server: Arc<Server>,
    /// The lines app-server sends this thread.
    inbox: mpsc::UnboundedReceiver<Inbound>,
    /// The server's key for this thread.
    key: u64,
    ready: watch::Receiver<Option<Result<(), String>>>,
    /// The thread is done: it leaves its server.
    closing: bool,
    control: mpsc::UnboundedReceiver<FollowUp>,
    answers: mpsc::UnboundedReceiver<Answer>,
    /// While held, plxd keeps the thread loaded for its next turn (0060).
    held: Held,
    sink: EventSink,
    switch: CancelSwitch,
    translator: Translator,
    approvals: bool,
    effort: Option<&'static str>,
    /// `thread/start` or `thread/resume` and its params, until it is sent.
    thread: Option<(&'static str, Value)>,
    /// Codex's thread id, once `thread/start` or `thread/resume` answered.
    thread_id: Option<String>,
    requests: HashMap<u64, Request>,
    /// The turn Codex is running.
    running: Option<Running>,
    /// Turns waiting for the one running, oldest first. The first is the prompt's.
    queued: VecDeque<Turn>,
    /// A turn was sent: the prompt's.
    started_any: bool,
    /// Approval requests Codex waits on.
    asks: HashMap<ApprovalId, Ask>,
    /// Where follow-ups' images go.
    temp_dir: PathBuf,
    /// The turns' image folders, deleted once app-server has exited.
    images: Vec<TempDir>,
    /// Why the last turn, or the thread's start, failed.
    failure: Option<Failure>,
    last_result: Option<String>,
    turns_done: usize,
}

impl Driver {
    async fn run(mut self) {
        let first = self.queued.front().map(|turn| turn.id);
        if let Some(turn_id) = first {
            self.emit(Event::TurnStarted { turn_id }).await;
        }
        self.on_ready();
        let mut control_open = true;
        let mut answers_open = true;
        let exit = loop {
            tokio::select! {
                biased;
                inbound = self.inbox.recv() => match inbound {
                    Some(Inbound::Line(line)) => {
                        for step in self.translator.line(&line) {
                            self.apply(step).await;
                        }
                    }
                    Some(Inbound::Oversized(bytes)) => {
                        self.emit(Event::Warning {
                            warning: WarningKind::OversizedLine,
                            detail: format!("skipped a {bytes}-byte line"),
                        })
                        .await;
                    }
                    Some(Inbound::Exited(exit)) => break End::Exited(exit),
                    None => break End::Exited(None),
                },
                changed = self.ready.changed(), if self.thread.is_some() => {
                    if changed.is_err() {
                        self.fail_to_start("Codex's app-server went away".into());
                    } else {
                        self.on_ready();
                    }
                }
                () = self.switch.cancelled(), if !self.closing => {
                    self.interrupt();
                    self.closing = true;
                }
                // Answers before follow-ups: Codex is waiting on them.
                answer = self.answers.recv(), if answers_open => match answer {
                    Some(answer) => self.answer(&answer),
                    None => answers_open = false,
                },
                follow_up = self.control.recv(), if control_open => match follow_up {
                    Some(follow_up) => self.follow_up(follow_up).await,
                    None => control_open = false,
                },
                () = self.sink.closed(), if !self.switch.is_cancelled() => {
                    self.switch.cancel();
                }
                () = self.held.changed() => {}
            }
            self.close_when_idle();
            if self.closing {
                break End::Left;
            }
        };
        self.leave(matches!(exit, End::Exited(_)));
        self.drop_undelivered().await;
        for approval_id in std::mem::take(&mut self.asks).into_keys() {
            self.emit(Event::ApprovalWithdrawn { approval_id }).await;
        }
        self.images.clear();
        let outcome = self.outcome(exit);
        let _ = self.sink.finish(outcome).await;
    }

    fn request(&mut self, kind: Request, method: &str, params: &Value) {
        let id = self.server.request(Some(self.key), method, params);
        self.requests.insert(id, kind);
    }

    /// Starts the thread once its server is initialized, or fails it if the server refused.
    fn on_ready(&mut self) {
        let ready = self.ready.borrow_and_update().clone();
        match ready {
            Some(Ok(())) => {
                if let Some((method, params)) = self.thread.take() {
                    self.request(Request::Thread, method, &params);
                }
            }
            Some(Err(message)) => {
                self.thread = None;
                self.fail_to_start(message);
            }
            None => {}
        }
    }

    /// A cancel: interrupts the running turn, which the thread leaves next.
    fn interrupt(&mut self) {
        if let (Some(thread_id), Some(turn_id)) = (
            &self.thread_id,
            self.running
                .as_ref()
                .and_then(|running| running.codex_id.as_ref()),
        ) {
            let params = json!({"threadId": thread_id, "turnId": turn_id});
            self.server.request(None, "turn/interrupt", &params);
        }
    }

    /// Leaves the server: unloads the thread with `thread/unsubscribe` unless app-server
    /// `exited`, which stops its MCP servers (0060).
    fn leave(&mut self, exited: bool) {
        self.control.close();
        self.server.leave(self.key);
        if !exited && let Some(thread_id) = &self.thread_id {
            let params = json!({"threadId": thread_id});
            self.server.request(None, "thread/unsubscribe", &params);
        }
    }

    async fn apply(&mut self, step: Step) {
        match step {
            Step::Emit(event) => self.emit(event).await,
            Step::Total(total) => {
                if self.sink.observe_total(None, total).await.is_err() {
                    self.switch.cancel();
                }
            }
            Step::Reply { id, result } => self.reply(id, result).await,
            Step::TurnDone { result, failure } => {
                self.turns_done += 1;
                self.last_result.clone_from(&result);
                self.failure = failure;
                self.finish_running(result).await;
                self.next_turn().await;
            }
            Step::Ask(request, ask) => {
                if self.approvals {
                    self.asks.insert(request.approval_id, ask);
                    self.emit(Event::ApprovalRequested(request)).await;
                } else {
                    let deny = Decision::Deny {
                        message: String::new(),
                        interrupt: false,
                    };
                    let result = answer_response(&ask, &deny);
                    self.server.send(&json!({"id": ask.id, "result": result}));
                }
            }
            Step::Resolved(id) => {
                let resolved = self
                    .asks
                    .iter()
                    .find(|(_, ask)| ask.id == id)
                    .map(|(&approval_id, _)| approval_id);
                if let Some(approval_id) = resolved {
                    self.asks.remove(&approval_id);
                    self.emit(Event::ApprovalWithdrawn { approval_id }).await;
                }
            }
            Step::Refuse { id, message } => {
                self.server
                    .send(&json!({"id": id, "error": refusal(&message)}));
            }
        }
    }

    /// Reads the response to one of plxd's requests.
    async fn reply(&mut self, id: u64, result: Result<Value, String>) {
        let Some(kind) = self.requests.remove(&id) else {
            return;
        };
        match (kind, result) {
            (Request::Thread, Ok(result)) => {
                let thread_id = result
                    .pointer("/thread/id")
                    .and_then(Value::as_str)
                    .map(str::to_owned);
                let Some(thread_id) = thread_id else {
                    self.fail_to_start("Codex started a thread without an id".into());
                    return;
                };
                let model = result
                    .get("model")
                    .and_then(Value::as_str)
                    .map(str::to_owned);
                self.emit(Event::SessionStarted {
                    session_id: thread_id.clone(),
                    model,
                    api_key_source: None,
                })
                .await;
                self.server.bind(self.key, thread_id.clone());
                self.thread_id = Some(thread_id);
                self.next_turn().await;
            }
            (Request::Thread, Err(message)) => self.fail_to_start(message),
            (Request::Turn, Ok(result)) => {
                if let Some(running) = &mut self.running {
                    running.codex_id = result
                        .pointer("/turn/id")
                        .and_then(Value::as_str)
                        .map(str::to_owned);
                }
            }
            // The turn never ran.
            (Request::Turn, Err(message)) => {
                self.failure = Some(Failure::new(super::classify(&message), message));
                self.finish_running(None).await;
                self.next_turn().await;
            }
            (Request::Steer(turn), Ok(_)) => {
                self.emit(Event::TurnStarted { turn_id: turn.id }).await;
                match (&mut self.running, turn.id) {
                    (Some(running), Some(turn_id)) => running.steered.push(turn_id),
                    // The turn it joined has already completed.
                    (_, turn_id) => {
                        let result = None;
                        let failed = false;
                        self.emit(Event::TurnFinished {
                            turn_id,
                            result,
                            failed,
                        })
                        .await;
                    }
                }
            }
            // Codex wouldn't take it into the turn, which may have just ended: it goes next.
            (Request::Steer(turn), Err(message)) => {
                self.emit(Event::Notice {
                    detail: format!("Codex took the message as the next turn: {message}"),
                })
                .await;
                self.queued.push_front(turn);
                self.next_turn().await;
            }
        }
    }

    /// Ends the running turn, and the turns of the messages steered into it, with `result`.
    async fn finish_running(&mut self, result: Option<String>) {
        let failed = self.failure.is_some();
        let Some(running) = self.running.take() else {
            let turn_id = None;
            self.emit(Event::TurnFinished {
                turn_id,
                result,
                failed,
            })
            .await;
            return;
        };
        let turns = std::iter::once(running.turn_id).chain(running.steered.into_iter().map(Some));
        for turn_id in turns {
            let result = result.clone();
            self.emit(Event::TurnFinished {
                turn_id,
                result,
                failed,
            })
            .await;
        }
    }

    /// The thread couldn't start, so no turn runs: the run fails and leaves its server.
    fn fail_to_start(&mut self, message: String) {
        self.failure = Some(Failure::new(super::classify(&message), message));
        self.closing = true;
    }

    /// Starts the next queued turn, if the thread is ready and no turn is running.
    async fn next_turn(&mut self) {
        let Some(thread_id) = self.thread_id.clone() else {
            return;
        };
        if self.running.is_some() {
            return;
        }
        let Some(turn) = self.queued.pop_front() else {
            return;
        };
        // The prompt's TurnStarted went out when the run started.
        if std::mem::replace(&mut self.started_any, true) {
            self.emit(Event::TurnStarted { turn_id: turn.id }).await;
        }
        self.running = Some(Running {
            turn_id: turn.id,
            codex_id: None,
            steered: Vec::new(),
        });
        // Codex runs a compaction as a turn of its own, with a `contextCompaction` item.
        let (method, params) = if turn.compact {
            ("thread/compact/start", json!({"threadId": thread_id}))
        } else {
            let mut params = json!({"threadId": thread_id, "input": turn.input});
            if let Some(effort) = self.effort {
                params["effort"] = effort.into();
            }
            ("turn/start", params)
        };
        self.request(Request::Turn, method, &params);
    }

    async fn follow_up(&mut self, follow_up: FollowUp) {
        let paths = match write_images(&self.temp_dir, &follow_up.images) {
            Ok(Some((folder, paths))) => {
                self.images.push(folder);
                paths
            }
            Ok(None) => Vec::new(),
            Err(error) => {
                self.emit(Event::Warning {
                    warning: WarningKind::Other,
                    detail: format!("could not write a message's images: {error}"),
                })
                .await;
                Vec::new()
            }
        };
        let turn = Turn {
            id: Some(follow_up.turn_id),
            input: input(&follow_up.text, &paths),
            compact: is_compact(&follow_up.text, &follow_up.images),
        };
        if !follow_up.steer {
            self.queued.push_back(turn);
        } else if let (Some(thread_id), Some(codex_id)) = (
            &self.thread_id,
            self.running
                .as_ref()
                .and_then(|running| running.codex_id.as_ref()),
        ) {
            let params =
                json!({"threadId": thread_id, "expectedTurnId": codex_id, "input": turn.input});
            self.request(Request::Steer(turn), "turn/steer", &params);
            return;
        } else {
            // No turn to steer into yet: it goes before anything else waiting, but after the
            // prompt.
            let at = usize::from(!self.started_any).min(self.queued.len());
            self.queued.insert(at, turn);
        }
        self.next_turn().await;
    }

    /// Writes `answer` to Codex, if it still waits on the request.
    fn answer(&mut self, answer: &Answer) {
        let Some(ask) = self.asks.remove(&answer.approval_id) else {
            return;
        };
        let result = answer_response(&ask, &answer.decision);
        self.server.send(&json!({"id": ask.id, "result": result}));
    }

    /// Leaves the server once no turn runs or waits, no steer or request waits on an answer, and
    /// plxd no longer holds the thread (0060).
    fn close_when_idle(&mut self) {
        let started = self.thread_id.is_some();
        let steering = self
            .requests
            .values()
            .any(|request| matches!(request, Request::Steer(_)));
        if started
            && self.running.is_none()
            && self.queued.is_empty()
            && self.asks.is_empty()
            && !steering
            && self.control.is_empty()
            && !self.held.now()
        {
            self.closing = true;
        }
    }

    async fn emit(&mut self, event: Event) {
        if self.sink.emit(event).await.is_err() {
            self.switch.cancel();
        }
    }

    /// After app-server exited: reports every follow-up that never started a turn as dropped.
    async fn drop_undelivered(&mut self) {
        self.control.close();
        // The prompt, if it never ran, isn't a follow-up.
        if !self.started_any {
            self.queued.pop_front();
        }
        let mut dropped: Vec<TurnId> = self.queued.drain(..).filter_map(|turn| turn.id).collect();
        for request in std::mem::take(&mut self.requests).into_values() {
            if let Request::Steer(Turn {
                id: Some(turn_id), ..
            }) = request
            {
                dropped.push(turn_id);
            }
        }
        while let Ok(follow_up) = self.control.try_recv() {
            dropped.push(follow_up.turn_id);
        }
        for turn_id in dropped {
            self.emit(Event::FollowUpDropped { turn_id }).await;
        }
    }

    /// How the thread ended, from how it left its server.
    fn outcome(&mut self, end: End) -> Outcome {
        if self.switch.is_cancelled() {
            return Outcome::Cancelled;
        }
        let exited = match end {
            End::Left => None,
            End::Exited(exit) => Some(exit),
        };
        let exit = exited.clone().flatten();
        if let Some(failure) = self.failure.take() {
            return failure.ended(exit.as_ref());
        }
        let done = self.turns_done > 0 && self.running.is_none();
        let Some(exited) = exited else {
            return if done {
                Outcome::Completed {
                    result: self.last_result.take(),
                }
            } else {
                Failure::new(
                    FailureKind::VendorError,
                    "Codex left a turn unfinished".into(),
                )
                .ended(None)
            };
        };
        let Some(exit) = exited else {
            return Failure::new(FailureKind::Internal, "lost track of the process".into())
                .ended(None);
        };
        if exit.info.success() && done {
            return Outcome::Completed {
                result: self.last_result.take(),
            };
        }
        let signed_out = super::classify(&exit.stderr_tail) == FailureKind::NotSignedIn;
        exit_outcome("Codex", signed_out, &exit)
    }
}
