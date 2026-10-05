//! Cursor threads through the official Cursor SDK (0053).
//!
//! `@cursor/sdk` is a Node library, so plxd runs `sidecar/cursor` and speaks JSON lines with it.
//! Sign-in is the SDK's browser login, which mints a key into plxd's data folder. Ambient
//! `CURSOR_*` is dropped. A `CURSOR_API_KEY` set on the provider instance wins over the login, as
//! in T3 Code.

use std::collections::{HashMap, VecDeque};
use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, PoisonError};
use std::time::Duration;

use serde_json::{Value, json};
use tokio::io::AsyncWriteExt;
use tokio::sync::mpsc;

use crate::detect;

use super::acp::scrubbed;
use super::process::{
    CancelPolicy, Exit, Launcher, Output, Process, ProcessSpec, Signals, StdinMode, StdinPipe,
};
use super::{
    AgentPermission, Backend, CancelSwitch, Capabilities, EVENT_BUFFER, Event, EventSink, Failure,
    FailureKind, FollowUp, Held, ModelUsage, Outcome, RunHandle, RunRequest, StartError, Started,
    StreamClosed, TodoItem, TodoStatus, ToolStatus, TurnId, Usage, WarningKind,
};
use parallax_protocol::ProviderModel;

/// Edit, Plan, Auto, and Bypass. Auto is the SDK's classifier, which denies instead of asking.
const PERMISSIONS: &[AgentPermission] = &[
    AgentPermission::Edit,
    AgentPermission::Plan,
    AgentPermission::Auto,
    AgentPermission::Bypass,
];

/// The variable on a provider instance that stands in for the browser login.
pub(crate) const API_KEY: &str = "CURSOR_API_KEY";

/// The Cursor SDK sidecar plxd starts for one provider instance.
#[derive(Clone, Debug)]
pub struct CursorSdkBackend {
    launcher: Launcher,
    name: String,
    env: Vec<(OsString, OsString)>,
}

impl CursorSdkBackend {
    /// The built-in `cursor` instance.
    #[must_use]
    pub fn new(launcher: Launcher) -> Self {
        Self {
            launcher,
            name: "cursor".into(),
            env: Vec::new(),
        }
    }

    /// `overrides`' name and variables. Of those starting with `CURSOR_`, only `CURSOR_API_KEY`
    /// is kept.
    #[must_use]
    pub fn with_overrides(mut self, overrides: super::Overrides) -> Self {
        if let Some(name) = overrides.name {
            self.name = name;
        }
        self.env = overrides
            .env
            .into_iter()
            .filter(|(name, _)| name == API_KEY || !name.as_encoded_bytes().starts_with(b"CURSOR_"))
            .collect();
        self
    }
}

impl Backend for CursorSdkBackend {
    fn name(&self) -> &str {
        &self.name
    }

    fn capabilities(&self) -> Capabilities {
        Capabilities {
            follow_ups: true,
            resume: true,
            reports_cost: false,
            rate_limits: false,
            worker_sandbox: false,
            fork: false,
        }
    }

    fn permissions(&self) -> &[AgentPermission] {
        PERMISSIONS
    }

    fn full_thread(&self) -> bool {
        true
    }

    fn start(&self, request: RunRequest) -> Result<Started, StartError> {
        if request.resume.as_ref().is_some_and(|resume| resume.fork) {
            return Err(StartError::Unsupported(
                "Cursor can't fork a session".into(),
            ));
        }
        if request.prompt.is_empty() && request.images.is_empty() {
            return Err(StartError::Invalid("the prompt is empty".into()));
        }
        if request.effort.is_some() || request.fast.is_some() || request.context_window.is_some() {
            return Err(StartError::Unsupported(
                "Cursor takes no effort, fast mode, or context window".into(),
            ));
        }
        let permission = permission_name(request.permission)?;
        if let Some(model) = &request.model {
            super::check_argument("model", model)?;
        }
        if let Some(resume) = &request.resume {
            super::check_argument("session", &resume.session_id)?;
        }
        let mcp = mcp_servers(&request)?;
        let mut spec = command(&self.launcher, &self.name, "run", &request.cwd, &self.env)?;
        spec.stdin = StdinMode::Piped;
        let mut process = self.launcher.spawn(&spec)?;
        let switch = CancelSwitch::new();
        switch.arm(
            process.signals().clone(),
            CancelPolicy {
                group: true,
                ..CancelPolicy::default()
            },
        );
        let (handle, control) = RunHandle::new(request.run_id, true, switch.clone());
        let held = handle.held();
        let baseline = request
            .resume
            .as_ref()
            .map(|resume| resume.usage_totals.clone())
            .unwrap_or_default();
        let (sink, events) = EventSink::channel(EVENT_BUFFER, baseline);
        let stdin = process
            .take_stdin()
            .ok_or_else(|| StartError::Invalid("the Cursor SDK sidecar has no stdin".into()))?;
        let (lines, incoming) = mpsc::unbounded_channel();
        let writer = tokio::spawn(write_lines(stdin, incoming));
        let start = json!({
            "type": "start",
            "cwd": request.cwd,
            "model": request.model,
            "prompt": request.prompt,
            "agentId": request.resume.as_ref().map(|resume| &resume.session_id),
            "permission": permission,
            "name": request.run_id.to_string(),
            "images": images_of(&request.images),
            "mcp": mcp,
        });
        lines
            .send(serde_json::to_string(&start).unwrap_or_default())
            .map_err(|_| StartError::Invalid("couldn't write to the Cursor SDK sidecar".into()))?;
        let mut turns = VecDeque::new();
        turns.push_back(PendingTurn {
            id: request.turn_id,
            follow_up: false,
        });
        tokio::spawn(drive(Driver {
            process,
            control,
            held,
            sink,
            switch,
            stdin: Some(lines),
            writer: Some(writer),
            turns,
            open: None,
            failure: None,
            last_result: None,
            saw_session: false,
            idle: false,
        }));
        Ok(Started {
            run: Arc::new(handle),
            events,
        })
    }
}

/// Whether the sidecar script is in the repo or beside `plxd`.
#[must_use]
pub(crate) fn script_present() -> bool {
    script_path().is_file()
}

/// What a status probe found. `installed` is true when the sidecar is there, even if Node is not.
#[derive(Clone, Debug, Default)]
pub(crate) struct Report {
    pub installed: bool,
    pub path: Option<String>,
    pub version: Option<String>,
    pub signed_in: Option<bool>,
    pub email: Option<String>,
    pub note: Option<String>,
    pub models: Vec<ProviderModel>,
}

/// Runs the sidecar's `status`, and `models` when that says the user is signed in.
pub(crate) async fn inspect(
    launcher: &Launcher,
    instance: &str,
    env: &[(OsString, OsString)],
    timeout: Duration,
) -> Report {
    if override_program(launcher).is_none() && !script_present() {
        return Report::default();
    }
    if override_program(launcher).is_none() && detect::resolve(launcher, "node").is_none() {
        return Report {
            installed: true,
            path: Some(script_path().display().to_string()),
            note: Some("Node.js 22.13 or newer is required".into()),
            ..Report::default()
        };
    }
    let cwd = launcher.data_dir().root().to_owned();
    let spec = match command(launcher, instance, "status", &cwd, env) {
        Ok(spec) => spec,
        Err(error) => {
            return Report {
                installed: true,
                note: Some(error.to_string()),
                ..Report::default()
            };
        }
    };
    let path = spec.program.to_string_lossy().into_owned();
    let value = match run_json(launcher, spec, timeout).await {
        Ok(value) => value,
        Err(note) => {
            return Report {
                installed: true,
                path: Some(path),
                note: Some(note),
                ..Report::default()
            };
        }
    };
    if value.get("type").and_then(Value::as_str) == Some("error") {
        return Report {
            installed: true,
            path: Some(path),
            note: Some(message_of(&value)),
            ..Report::default()
        };
    }
    let signed_in = value.get("signedIn").and_then(Value::as_bool);
    let note = str_of(&value, "message").map(str::to_owned);
    let mut report = Report {
        installed: true,
        path: Some(path),
        version: value
            .get("version")
            .and_then(Value::as_str)
            .map(str::to_owned),
        signed_in,
        email: value
            .get("email")
            .and_then(Value::as_str)
            .map(str::to_owned),
        note,
        models: Vec::new(),
    };
    if signed_in == Some(true)
        && let Ok(models) = command(launcher, instance, "models", &cwd, env)
        && let Ok(listed) = run_json(launcher, models, timeout).await
    {
        report.models = listed
            .get("models")
            .and_then(Value::as_array)
            .map(|models| {
                models
                    .iter()
                    .filter_map(|model| {
                        Some(ProviderModel {
                            id: model.get("id")?.as_str()?.to_owned(),
                            name: model
                                .get("name")
                                .and_then(Value::as_str)
                                .unwrap_or("model")
                                .to_owned(),
                        })
                    })
                    .collect()
            })
            .unwrap_or_default();
    }
    report
}

/// What Settings shows when a browser login fails, T3 Code's wording.
const SIGN_IN_FAILED: &str = "Cursor sign-in failed or expired. Start sign-in again.";

/// A Cursor account login in the browser, one at a time per daemon.
pub struct CursorAuth {
    launcher: Launcher,
    pending: Arc<Mutex<Option<Arc<Signals>>>>,
    /// Instances whose last login failed after its URL went out, until the next one starts.
    failed: Arc<Mutex<HashMap<String, String>>>,
}

impl CursorAuth {
    /// Sign-in for the sidecar `launcher` starts.
    #[must_use]
    pub fn new(launcher: Launcher) -> Self {
        Self {
            launcher,
            pending: Arc::default(),
            failed: Arc::default(),
        }
    }

    /// Starts a login and returns the URL the app should open. A login already running is stopped.
    ///
    /// # Errors
    ///
    /// When the sidecar cannot start, or it ends without a URL.
    pub async fn sign_in(&self, instance: &str) -> Result<String, String> {
        self.cancel();
        self.failed
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .remove(instance);
        let cwd = self.launcher.data_dir().root().to_owned();
        let spec = command(&self.launcher, instance, "login", &cwd, &[])
            .map_err(|error| error.to_string())?;
        let mut process = self
            .launcher
            .spawn(&spec)
            .map_err(|error| error.to_string())?;
        let signals = process.signals().clone();
        let url = tokio::time::timeout(Duration::from_secs(30), async {
            while let Some(output) = process.next().await {
                match output {
                    Output::Line(line) => {
                        let text = String::from_utf8_lossy(&line);
                        let Ok(value) = serde_json::from_str::<Value>(&text) else {
                            continue;
                        };
                        match value.get("type").and_then(Value::as_str) {
                            Some("url") => {
                                return value
                                    .get("url")
                                    .and_then(Value::as_str)
                                    .map(str::to_owned)
                                    .ok_or_else(|| "the sign-in didn't include a URL".to_owned());
                            }
                            Some("error") => {
                                return Err(message_of(&value));
                            }
                            _ => {}
                        }
                    }
                    Output::Exited(exit) => return Err(exit_message(exit)),
                    Output::Oversized { .. } => {}
                }
            }
            Err("sign-in ended before a URL".into())
        })
        .await
        .map_err(|_| "timed out waiting for the sign-in URL".to_owned())??;
        let signals = Arc::new(signals);
        *self.pending.lock().unwrap_or_else(PoisonError::into_inner) = Some(signals.clone());
        let (pending, failed, instance) = (
            self.pending.clone(),
            self.failed.clone(),
            instance.to_owned(),
        );
        // The login ends when the browser finishes or it times out. A failure is kept for
        // `providers/list` unless the login was cancelled or replaced.
        tokio::spawn(async move {
            let mut success = false;
            while let Some(output) = process.next().await {
                if let Output::Exited(exit) = output {
                    success = exit.info.success();
                }
            }
            let mut pending = pending.lock().unwrap_or_else(PoisonError::into_inner);
            if pending.as_ref().is_some_and(|p| Arc::ptr_eq(p, &signals)) {
                pending.take();
                if !success {
                    failed
                        .lock()
                        .unwrap_or_else(PoisonError::into_inner)
                        .insert(instance, SIGN_IN_FAILED.to_owned());
                }
            }
        });
        Ok(url)
    }

    /// Why `instance`'s last browser login failed, if it did.
    #[must_use]
    pub fn failure(&self, instance: &str) -> Option<String> {
        self.failed
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .get(instance)
            .cloned()
    }

    /// Stops a login that is still waiting on the browser.
    pub fn cancel(&self) {
        if let Some(signals) = self
            .pending
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .take()
        {
            signals.cancel(CancelPolicy {
                group: true,
                ..CancelPolicy::default()
            });
        }
    }

    /// Forgets the stored login for `instance`.
    ///
    /// # Errors
    ///
    /// When the sidecar cannot start or does not exit.
    pub async fn sign_out(&self, instance: &str) -> Result<(), String> {
        self.cancel();
        let cwd = self.launcher.data_dir().root().to_owned();
        let spec = command(&self.launcher, instance, "logout", &cwd, &[])
            .map_err(|error| error.to_string())?;
        let mut process = self
            .launcher
            .spawn(&spec)
            .map_err(|error| error.to_string())?;
        let exit = tokio::time::timeout(Duration::from_secs(20), async {
            while let Some(output) = process.next().await {
                if let Output::Exited(exit) = output {
                    return Ok(exit);
                }
            }
            Err("sign-out ended without exiting".to_owned())
        })
        .await
        .map_err(|_| "timed out signing out of Cursor".to_owned())??;
        if exit.info.success() {
            Ok(())
        } else {
            Err(exit_message(exit))
        }
    }
}

struct PendingTurn {
    id: Option<TurnId>,
    follow_up: bool,
}

/// A turn the sidecar has started. `id` is the caller's turn when plxd started it.
struct OpenTurn {
    id: Option<TurnId>,
}

struct Driver {
    process: Process,
    control: mpsc::UnboundedReceiver<FollowUp>,
    held: Held,
    sink: EventSink,
    switch: CancelSwitch,
    stdin: Option<mpsc::UnboundedSender<String>>,
    writer: Option<tokio::task::JoinHandle<()>>,
    turns: VecDeque<PendingTurn>,
    open: Option<OpenTurn>,
    failure: Option<Failure>,
    last_result: Option<String>,
    saw_session: bool,
    idle: bool,
}

async fn drive(mut driver: Driver) {
    loop {
        tokio::select! {
            biased;
            output = driver.process.next() => {
                match output {
                    None => {
                        driver.finish(None).await;
                        return;
                    }
                    Some(Output::Exited(exit)) => {
                        driver.finish(Some(exit)).await;
                        return;
                    }
                    Some(Output::Oversized { bytes }) => {
                        if driver.warn(format!("skipped a line of {bytes} bytes")).await.is_err() {
                            driver.switch.cancel();
                            return;
                        }
                    }
                    Some(Output::Line(line)) => {
                        if driver.line(&line).await.is_err() {
                            driver.switch.cancel();
                            return;
                        }
                    }
                }
            }
            message = driver.control.recv(), if driver.stdin.is_some() => {
                if let Some(follow) = message
                    && driver.send_follow_up(&follow).is_err()
                {
                    driver.switch.cancel();
                }
            }
            () = driver.held.changed(), if driver.idle && driver.stdin.is_some() => {
                driver.close_if_idle();
            }
        }
    }
}

impl Driver {
    async fn line(&mut self, bytes: &[u8]) -> Result<(), StreamClosed> {
        let text = String::from_utf8_lossy(bytes);
        let value: Value = match serde_json::from_str(&text) {
            Ok(value) => value,
            Err(error) => return self.warn(format!("skipped a line: {error}")).await,
        };
        match value.get("type").and_then(Value::as_str) {
            Some("session") => self.on_session(&value).await,
            Some("turnStarted") => self.on_turn_started().await,
            Some("text") => self.on_text(&value).await,
            Some("reasoning") => self.on_reasoning(&value).await,
            Some("tool") => self.on_tool(&value).await,
            Some("toolResult") => self.on_tool_result(&value).await,
            Some("todo") => self.on_todo(&value).await,
            Some("usage") => self.on_usage(&value).await,
            Some("turnFinished") => self.on_turn_finished(&value).await,
            Some("idle") => {
                self.idle = true;
                self.close_if_idle();
                Ok(())
            }
            Some("error") => self.on_error(&value).await,
            _ => Ok(()),
        }
    }

    async fn on_session(&mut self, value: &Value) -> Result<(), StreamClosed> {
        if self.saw_session {
            return Ok(());
        }
        self.saw_session = true;
        self.sink
            .emit(Event::SessionStarted {
                session_id: str_of(value, "agentId").unwrap_or("cursor").to_owned(),
                model: str_of(value, "model").map(str::to_owned),
                api_key_source: None,
            })
            .await
    }

    async fn on_turn_started(&mut self) -> Result<(), StreamClosed> {
        let id = self.turns.pop_front().and_then(|turn| turn.id);
        self.open = Some(OpenTurn { id });
        self.idle = false;
        self.sink.emit(Event::TurnStarted { turn_id: id }).await
    }

    async fn on_text(&mut self, value: &Value) -> Result<(), StreamClosed> {
        self.sink
            .emit(Event::TextDelta {
                message_id: None,
                text: str_of(value, "text").unwrap_or("").to_owned(),
            })
            .await
    }

    async fn on_reasoning(&mut self, value: &Value) -> Result<(), StreamClosed> {
        self.sink
            .emit(Event::Reasoning {
                message_id: None,
                text: str_of(value, "text").unwrap_or("").to_owned(),
            })
            .await
    }

    async fn on_tool(&mut self, value: &Value) -> Result<(), StreamClosed> {
        self.sink
            .emit(Event::ToolCall {
                call_id: str_of(value, "callId").unwrap_or("tool").to_owned(),
                name: str_of(value, "name").unwrap_or("tool").to_owned(),
                input: value.get("input").cloned().unwrap_or(Value::Null),
            })
            .await
    }

    async fn on_tool_result(&mut self, value: &Value) -> Result<(), StreamClosed> {
        let status = match str_of(value, "status") {
            Some("error") => ToolStatus::Error,
            Some("denied") => ToolStatus::Denied,
            _ => ToolStatus::Ok,
        };
        self.sink
            .emit(Event::ToolResult {
                call_id: str_of(value, "callId").unwrap_or("tool").to_owned(),
                status,
                output: str_of(value, "output").map(str::to_owned),
            })
            .await
    }

    async fn on_todo(&mut self, value: &Value) -> Result<(), StreamClosed> {
        let items = value
            .get("items")
            .and_then(Value::as_array)
            .map(|items| {
                items
                    .iter()
                    .map(|item| TodoItem {
                        text: str_of(item, "text").unwrap_or("").to_owned(),
                        status: match str_of(item, "status") {
                            Some("inProgress") => TodoStatus::InProgress,
                            Some("completed") => TodoStatus::Completed,
                            Some("pending") => TodoStatus::Pending,
                            _ => TodoStatus::Other,
                        },
                    })
                    .collect()
            })
            .unwrap_or_default();
        self.sink.emit(Event::TodoList { items }).await
    }

    async fn on_usage(&mut self, value: &Value) -> Result<(), StreamClosed> {
        let Some(usage) = value.get("usage") else {
            return Ok(());
        };
        let usage = Usage {
            input_tokens: tokens(usage, "inputTokens"),
            output_tokens: tokens(usage, "outputTokens"),
            cache_read_tokens: tokens(usage, "cacheReadTokens"),
            cache_write_tokens: tokens(usage, "cacheWriteTokens"),
            cost_usd_micros: None,
        };
        if usage.is_zero() {
            return Ok(());
        }
        self.sink
            .emit(Event::Usage(ModelUsage { model: None, usage }))
            .await
    }

    async fn on_turn_finished(&mut self, value: &Value) -> Result<(), StreamClosed> {
        let turn_id = self.open.take().and_then(|turn| turn.id);
        self.last_result = str_of(value, "result").map(str::to_owned);
        self.sink
            .emit(Event::TurnFinished {
                turn_id,
                result: self.last_result.clone(),
            })
            .await
    }

    async fn on_error(&mut self, value: &Value) -> Result<(), StreamClosed> {
        let message = message_of(value);
        match str_of(value, "failure") {
            Some("notSignedIn") => {
                self.failure = Some(Failure {
                    failure: FailureKind::NotSignedIn,
                    message,
                    exit: None,
                    stderr_tail: None,
                });
                Ok(())
            }
            Some("rateLimited") => {
                self.failure = Some(Failure {
                    failure: FailureKind::RateLimited,
                    message,
                    exit: None,
                    stderr_tail: None,
                });
                Ok(())
            }
            _ => self.sink.emit(Event::Notice { detail: message }).await,
        }
    }

    fn send_follow_up(&mut self, follow: &FollowUp) -> Result<(), ()> {
        self.turns.push_back(PendingTurn {
            id: Some(follow.turn_id),
            follow_up: true,
        });
        self.idle = false;
        self.write(&json!({
            "type": "send",
            "text": follow.text,
            "steer": follow.steer,
            "images": images_of(&follow.images),
        }))
    }

    fn write(&mut self, value: &Value) -> Result<(), ()> {
        let Some(stdin) = &self.stdin else {
            return Err(());
        };
        stdin
            .send(serde_json::to_string(value).unwrap_or_default())
            .map_err(|_| ())
    }

    /// Closes the sidecar's stdin once it is idle with no turn plxd sent still to start, so a
    /// follow-up written just before `idle` isn't cancelled by the close.
    fn close_if_idle(&mut self) {
        if !self.idle || self.held.now() || !self.turns.is_empty() {
            return;
        }
        if let Ok(follow) = self.control.try_recv() {
            self.idle = false;
            let _ = self.send_follow_up(&follow);
            return;
        }
        self.stdin.take();
        self.writer.take();
    }

    async fn warn(&mut self, detail: String) -> Result<(), StreamClosed> {
        self.sink
            .emit(Event::Warning {
                warning: WarningKind::MalformedLine,
                detail,
            })
            .await
    }

    async fn finish(&mut self, exit: Option<Exit>) {
        self.stdin.take();
        while let Some(turn) = self.turns.pop_front() {
            if turn.follow_up
                && let Some(turn_id) = turn.id
            {
                let _ = self.sink.emit(Event::FollowUpDropped { turn_id }).await;
            }
        }
        let outcome = if self.switch.is_cancelled() {
            Outcome::Cancelled
        } else if let Some(failure) = self.failure.take() {
            Outcome::Failed(failure)
        } else if exit.as_ref().is_some_and(|exit| !exit.info.success()) {
            Outcome::Failed(Failure {
                failure: FailureKind::Crashed,
                message: "the Cursor SDK sidecar exited".into(),
                exit: exit.as_ref().map(|exit| exit.info),
                stderr_tail: exit
                    .and_then(|exit| (!exit.stderr_tail.is_empty()).then_some(exit.stderr_tail)),
            })
        } else {
            Outcome::Completed {
                result: self.last_result.clone(),
            }
        };
        let _ = self.sink.finish(outcome).await;
    }
}

async fn write_lines(mut stdin: StdinPipe, mut lines: mpsc::UnboundedReceiver<String>) {
    while let Some(line) = lines.recv().await {
        if stdin.write_all(line.as_bytes()).await.is_err() || stdin.write_all(b"\n").await.is_err()
        {
            break;
        }
        if stdin.flush().await.is_err() {
            break;
        }
    }
}

fn command(
    launcher: &Launcher,
    instance: &str,
    command: &str,
    cwd: &Path,
    env: &[(OsString, OsString)],
) -> Result<ProcessSpec, StartError> {
    let (auth, store) = instance_paths(launcher, instance);
    std::fs::create_dir_all(&store).map_err(|error| {
        StartError::Invalid(format!(
            "couldn't create the Cursor SDK folder {}: {error}",
            store.display()
        ))
    })?;
    let (program, mut args) = if let Some(program) = override_program(launcher) {
        (program, Vec::new())
    } else {
        (node_for(launcher)?, vec![script_path().into()])
    };
    args.extend([
        command.into(),
        "--auth".into(),
        auth.into(),
        "--store".into(),
        store.into(),
        "--name".into(),
        instance.into(),
    ]);
    let mut spec = ProcessSpec::new(program, cwd);
    spec.args = args;
    spec.scrub = scrubbed(launcher.base(), &["CURSOR_".into()]);
    for (name, value) in env {
        spec.inject.set(name, value);
    }
    Ok(spec)
}

fn instance_paths(launcher: &Launcher, instance: &str) -> (PathBuf, PathBuf) {
    let mut safe = instance
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || *c == '-' || *c == '_')
        .collect::<String>();
    if safe.is_empty() {
        safe.push_str("cursor");
    }
    let dir = launcher.data_dir().root().join("cursor-sdk").join(safe);
    (dir.join("auth.json"), dir.join("agents"))
}

fn script_path() -> PathBuf {
    if let Ok(exe) = std::env::current_exe()
        && let Some(dir) = exe.parent()
    {
        let bundled = dir.join("cursor-sdk").join("main.mjs");
        if bundled.is_file() {
            return bundled;
        }
    }
    PathBuf::from(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../sidecar/cursor/src/main.mjs"
    ))
}

fn override_program(launcher: &Launcher) -> Option<PathBuf> {
    let raw = launcher.base().get("PLXD_CURSOR_SDK")?;
    let path = PathBuf::from(raw);
    path.is_file().then_some(path)
}

fn permission_name(permission: Option<AgentPermission>) -> Result<&'static str, StartError> {
    match permission.unwrap_or(AgentPermission::Edit) {
        AgentPermission::Edit => Ok("edit"),
        AgentPermission::Plan => Ok("plan"),
        AgentPermission::Auto => Ok("auto"),
        AgentPermission::Bypass => Ok("bypass"),
        AgentPermission::Manual => Err(StartError::Unsupported(
            "Cursor has no Manual. Choose Edit, Plan, Auto, or Bypass.".into(),
        )),
        AgentPermission::Unknown => Err(StartError::Unsupported(
            "Cursor doesn't know this permission mode".into(),
        )),
    }
}

fn mcp_servers(request: &RunRequest) -> Result<Option<Value>, StartError> {
    let config = if let Some(tools) = &request.thread_tools {
        Some(tools.mcp_config()?)
    } else if let Some(tools) = &request.coordinator_tools {
        Some(tools.mcp_config()?)
    } else {
        None
    };
    Ok(config.and_then(|value| value.get("mcpServers").cloned()))
}

fn images_of(images: &[super::PromptImage]) -> Vec<Value> {
    images
        .iter()
        .map(|image| {
            json!({
                "mediaType": image.media_type,
                "data": image.data,
            })
        })
        .collect()
}

fn tokens(value: &Value, name: &str) -> u64 {
    value
        .get(name)
        .and_then(|token| {
            token
                .as_u64()
                .or_else(|| token.as_i64().and_then(|n| u64::try_from(n).ok()))
        })
        .unwrap_or(0)
}

fn str_of<'a>(value: &'a Value, name: &str) -> Option<&'a str> {
    value.get(name).and_then(Value::as_str)
}

fn node_for(launcher: &Launcher) -> Result<PathBuf, StartError> {
    if !script_present() {
        return Err(StartError::Unsupported(
            "the Cursor SDK sidecar is not installed".into(),
        ));
    }
    detect::resolve(launcher, "node").ok_or_else(|| {
        StartError::Unsupported("Node.js 22.13 or newer is required to run Cursor".into())
    })
}

fn message_of(value: &Value) -> String {
    value
        .get("message")
        .and_then(Value::as_str)
        .unwrap_or("the Cursor SDK failed")
        .to_owned()
}

fn exit_message(exit: Exit) -> String {
    if exit.stderr_tail.is_empty() {
        "the Cursor SDK sidecar exited".into()
    } else {
        exit.stderr_tail
    }
}

async fn run_json(
    launcher: &Launcher,
    spec: ProcessSpec,
    timeout: Duration,
) -> Result<Value, String> {
    let mut process = launcher.spawn(&spec).map_err(|error| error.to_string())?;
    let mut stdout = String::new();
    let exit = tokio::time::timeout(timeout, async {
        while let Some(output) = process.next().await {
            match output {
                Output::Line(line) => {
                    stdout.push_str(&String::from_utf8_lossy(&line));
                    stdout.push('\n');
                }
                Output::Exited(exit) => return Ok(exit),
                Output::Oversized { .. } => {}
            }
        }
        Err("the Cursor SDK sidecar ended without exiting".to_owned())
    })
    .await
    .map_err(|_| "timed out talking to the Cursor SDK".to_owned())??;
    stdout
        .lines()
        .rev()
        .find_map(|line| serde_json::from_str::<Value>(line).ok())
        .ok_or_else(|| {
            if exit.stderr_tail.is_empty() {
                format!(
                    "the Cursor SDK sidecar wrote nothing usable ({})",
                    exit.info.code.unwrap_or(-1)
                )
            } else {
                exit.stderr_tail
            }
        })
}

#[cfg(all(test, unix))]
mod tests {
    use std::fs;
    use std::os::unix::fs::PermissionsExt;
    use std::time::Duration;

    use serde_json::Value;

    use super::CursorSdkBackend;
    use crate::backend::process::{Environment, Launcher};
    use crate::backend::{
        AccountRef, Backend, Credential, Event, FollowUp, Outcome, Overrides, RunRequest,
        ToolPolicy, TurnId,
    };
    use crate::paths::DataDir;

    const FAKE: &str = r#"#!/bin/sh
cmd="$1"
dir="${FAKE_CURSOR_DIR:?}"
printf '%s\n' "$cmd" >> "$dir/commands"
env | grep '^CURSOR_' >> "$dir/cursor-env" || true
case "$cmd" in
  run)
    while IFS= read -r line; do
      printf '%s\n' "$line" >> "$dir/stdin"
      printf '%s\n' '{"type":"session","agentId":"agent-1","model":"auto"}'
      printf '%s\n' '{"type":"turnStarted"}'
      printf '%s\n' '{"type":"text","text":"hello"}'
      printf '%s\n' '{"type":"turnFinished","result":"hello"}'
      printf '%s\n' '{"type":"idle"}'
      break
    done
    while IFS= read -r line; do
      printf '%s\n' "$line" >> "$dir/stdin"
    done
    ;;
esac
"#;

    fn launcher(dir: &std::path::Path, program: &std::path::Path) -> Launcher {
        let mut env = Environment::empty();
        env.set("PATH", "/usr/bin:/bin");
        env.set("PLXD_CURSOR_SDK", program);
        env.set("FAKE_CURSOR_DIR", dir);
        env.set("CURSOR_API_KEY", "should-not-pass");
        Launcher::new(DataDir::new(dir.join("data")).unwrap(), env)
    }

    fn request(cwd: std::path::PathBuf) -> RunRequest {
        RunRequest {
            run_id: crate::backend::RunId::generate(),
            turn_id: None,
            cwd,
            prompt: "Say hello".into(),
            images: Vec::new(),
            policy: ToolPolicy::WorkspaceWrite,
            sandbox: None,
            account: AccountRef {
                id: "cursor".into(),
                credential: Credential::Subscription { config_home: None },
            },
            resume: None,
            model: Some("auto".into()),
            effort: None,
            permission: None,
            context_window: None,
            fast: None,
            coordinator_tools: None,
            thread_tools: None,
            approvals: false,
            thread: true,
        }
    }

    #[tokio::test]
    async fn a_turn_streams_text_and_the_sidecar_never_sees_cursor_env() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().canonicalize().unwrap();
        let program = root.join("fake-cursor");
        fs::write(&program, FAKE).unwrap();
        fs::set_permissions(&program, fs::Permissions::from_mode(0o755)).unwrap();
        let backend = CursorSdkBackend::new(launcher(&root, &program));
        let started = backend.start(request(root.clone())).unwrap();
        let mut events = started.events;
        let mut kinds = Vec::new();
        let mut text = String::new();
        while let Some(event) = tokio::time::timeout(Duration::from_secs(5), events.next())
            .await
            .unwrap()
        {
            if let Event::TextDelta { text: delta, .. } = &event {
                text.push_str(delta);
            }
            let done = matches!(event, Event::Finished { .. });
            kinds.push(event);
            if done {
                break;
            }
        }
        assert_eq!(text, "hello");
        assert!(matches!(
            kinds.last(),
            Some(Event::Finished {
                outcome: Outcome::Completed { result: Some(result) },
                ..
            }) if result == "hello"
        ));
        let stdin = fs::read_to_string(root.join("stdin")).unwrap();
        let start: Value = serde_json::from_str(stdin.lines().next().unwrap()).unwrap();
        assert_eq!(start["permission"], "edit");
        assert_eq!(start["model"], "auto");
        let leaked = fs::read_to_string(root.join("cursor-env")).unwrap_or_default();
        assert!(
            leaked.trim().is_empty(),
            "CURSOR_* reached the sidecar: {leaked}"
        );
    }

    /// A login that fails after its URL went out is kept for `providers/list`, as T3 Code's
    /// "failed" phase, and the next sign-in clears it.
    #[tokio::test]
    async fn a_login_that_fails_in_the_browser_is_reported() {
        const FAILS: &str = "#!/bin/sh\n\
            printf '%s\\n' '{\"type\":\"url\",\"url\":\"https://cursor.com/login\"}'\n\
            sleep 0.2\n\
            printf '%s\\n' '{\"type\":\"error\",\"failure\":\"failed\",\"message\":\"denied\"}'\n\
            exit 1\n";
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().canonicalize().unwrap();
        let program = root.join("fake-cursor");
        fs::write(&program, FAILS).unwrap();
        fs::set_permissions(&program, fs::Permissions::from_mode(0o755)).unwrap();
        let auth = super::CursorAuth::new(launcher(&root, &program));
        assert_eq!(
            auth.sign_in("cursor").await.unwrap(),
            "https://cursor.com/login"
        );
        assert_eq!(auth.failure("cursor"), None, "still waiting on the browser");
        let deadline = std::time::Instant::now() + Duration::from_secs(5);
        while auth.failure("cursor").is_none() {
            assert!(std::time::Instant::now() < deadline, "never reported");
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        assert_eq!(auth.failure("other"), None);
        let _ = auth.sign_in("cursor").await;
        assert_eq!(auth.failure("cursor"), None, "a new sign-in clears it");
        auth.cancel();
    }

    /// A follow-up plxd wrote before the sidecar said `idle` keeps stdin open: closing it would
    /// cancel that turn in the sidecar.
    #[tokio::test]
    async fn a_follow_up_sent_before_idle_keeps_stdin_open() {
        const LATE_IDLE: &str = r#"#!/bin/sh
dir="${FAKE_CURSOR_DIR:?}"
read -r start
read -r follow
printf '%s\n' "$follow" >> "$dir/stdin"
printf '%s\n' '{"type":"session","agentId":"agent-1","model":"auto"}'
printf '%s\n' '{"type":"turnStarted"}' '{"type":"turnFinished","result":"one"}' '{"type":"idle"}'
exec 3<&0
{ while read -r _ <&3; do :; done; touch "$dir/eof"; } &
sleep 1
[ -f "$dir/eof" ] && touch "$dir/closed-early"
printf '%s\n' '{"type":"turnStarted"}' '{"type":"turnFinished","result":"two"}' '{"type":"idle"}'
wait
"#;
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().canonicalize().unwrap();
        let program = root.join("fake-cursor");
        fs::write(&program, LATE_IDLE).unwrap();
        fs::set_permissions(&program, fs::Permissions::from_mode(0o755)).unwrap();
        let mut env = Environment::empty();
        env.set("PATH", "/usr/bin:/bin");
        env.set("PLXD_CURSOR_SDK", &program);
        env.set("FAKE_CURSOR_DIR", &root);
        let launcher = Launcher::new(DataDir::new(root.join("data")).unwrap(), env);
        let started = CursorSdkBackend::new(launcher)
            .start(request(root.clone()))
            .unwrap();
        started
            .run
            .send(FollowUp {
                turn_id: TurnId::generate(),
                text: "and the tests".into(),
                images: Vec::new(),
                steer: false,
            })
            .unwrap();
        let mut events = started.events;
        while let Some(event) = tokio::time::timeout(Duration::from_secs(5), events.next())
            .await
            .unwrap()
        {
            if matches!(event, Event::Finished { .. }) {
                break;
            }
        }
        assert!(
            fs::read_to_string(root.join("stdin"))
                .unwrap()
                .contains("and the tests")
        );
        assert!(
            !root.join("closed-early").exists(),
            "stdin closed with a turn still to start"
        );
    }

    /// As in T3 Code, the instance's own `CURSOR_API_KEY` reaches the SDK. The ambient one and
    /// any other `CURSOR_*` the instance sets do not.
    #[tokio::test]
    async fn only_the_instances_cursor_api_key_reaches_the_sidecar() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().canonicalize().unwrap();
        let program = root.join("fake-cursor");
        fs::write(&program, FAKE).unwrap();
        fs::set_permissions(&program, fs::Permissions::from_mode(0o755)).unwrap();
        let backend = CursorSdkBackend::new(launcher(&root, &program)).with_overrides(Overrides {
            env: vec![
                ("CURSOR_API_KEY".into(), "instance-key".into()),
                ("CURSOR_OTHER".into(), "dropped".into()),
            ],
            ..Overrides::default()
        });
        let mut events = backend.start(request(root.clone())).unwrap().events;
        while let Some(event) = tokio::time::timeout(Duration::from_secs(5), events.next())
            .await
            .unwrap()
        {
            if matches!(event, Event::Finished { .. }) {
                break;
            }
        }
        let seen = fs::read_to_string(root.join("cursor-env")).unwrap();
        assert_eq!(seen.trim(), "CURSOR_API_KEY=instance-key");
    }
}
