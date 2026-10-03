//! The ACP backend: runs any agent that speaks the Agent Client Protocol (ACP) as a thread's
//! full agent, the way Claude threads run full Claude Code (0034, 0036, 0040). Cursor Agent
//! (`agent acp`) was the first; OpenCode, OMP, Hermes Agent, Grok Build, and the agents in the
//! ACP registry run the same way, each described by an [`AcpAgent`].
//!
//! # The command
//!
//! Every run is the agent's program with its [`AcpAgent::args`] in the run's cwd, after any model
//! or bypass flags the agent takes: JSON-RPC 2.0 as one JSON object per line on stdin and stdout.
//! The driver sends `initialize`, then `session/new`, or `session/load` with the session to
//! resume, whose replayed history it drops ([`stream::Translator::replaying`]). A model the agent
//! takes over ACP is `session/set_config_option` for its model option, or else `session/set_model`;
//! Plan, and Bypass for an agent with a bypass mode, are `session/set_mode`. Then each message is
//! a `session/prompt`, the first one the user's message as written, with its images as image
//! blocks before its text. A follow-up sent during a turn waits for that turn's response, then
//! goes into the same session. Once no turn is outstanding and no request waits, stdin closes,
//! the agent exits, and the run ends; a later message resumes the session in a new run.
//!
//! Only threads run on ACP agents (`RunRequest::thread`): none has a worker sandbox plxd can
//! check, and 0004 keeps the coordinator on Claude Code, so anything else is
//! [`StartError::Unsupported`].
//!
//! # Credentials and configuration
//!
//! Nothing is scrubbed from the agent's own configuration: its login, rules, skills, MCP servers,
//! and allowlist load as in a terminal. Every run drops inherited variables starting with the
//! agent's [`AcpAgent::scrub`] prefixes, which could pick another key or endpoint, then sets the
//! provider instance's own [`AcpAgent::env`] (0040). Only the agent's own sign-in runs, never a
//! plxd key account.
//!
//! # Permission requests
//!
//! `session/request_permission` becomes [`Event::ApprovalRequested`], and [`Run::answer`]'s answer
//! selects its allow-once or reject-once option. ACP carries no message with a rejection, and no
//! edited input. Cursor hands a plan over as `cursor/create_plan`, which the app sees as an
//! interactive `ExitPlanMode` request. Allowing it accepts the plan, switches the session to the
//! agent's [`AcpAgent::edit_mode`], and sends [`BUILD_PLAN`] as the same turn, as Claude Code goes
//! on to build an approved plan in its turn. Denying it rejects the plan with the user's message,
//! and Cursor keeps planning. Without `approvals`, plxd rejects every request and declines plans.
//!
//! # Events
//!
//! Message chunks are text deltas; thinking chunks join into one `Reasoning`; tool calls are named
//! for the Claude Code tools the app draws (`Bash`, `Read`, `Edit`, `Grep`, `WebFetch`); todo and
//! plan updates are todo lists. ACP reports no token usage, so an ACP run has none.
//!
//! # Cancel
//!
//! Cancel sends `SIGINT`, which ends Cursor's `agent acp` at once, and closes stdin, and kills the
//! process group if it is still running after the grace period.

mod stream;
#[cfg(all(test, unix))]
mod tests;

use std::collections::{HashMap, VecDeque};
use std::ffi::{OsStr, OsString};
use std::path::Path;
use std::sync::Arc;
use std::time::Duration;

use serde_json::{Value, json};
use tokio::io::AsyncWriteExt;
use tokio::sync::{Notify, mpsc};

use self::stream::{Ask, AskKind, Step, Translator, permission_answer};
use super::commands::{self, CommandsProbe};
use super::event::{Event, Failure, FailureKind, Outcome, WarningKind};
use super::process::{
    CancelPolicy, Environment, Exit, Launcher, Output, Process, ProcessSpec, StdinMode, StdinPipe,
};
use super::{
    AgentPermission, Answer, AnswerError, ApprovalId, Backend, CancelSwitch, Capabilities,
    Credential, Decision, EVENT_BUFFER, EventSink, FollowUp, PromptImage, Run, RunHandle, RunId,
    RunRequest, SendError, StartError, Started, TurnId, check_argument,
};

/// The message that goes on with an approved plan in the same turn.
pub const BUILD_PLAN: &str = "The user approved the plan. Build it.";

/// One ACP agent: how to start it and what its sessions take. A provider instance (0040) builds
/// one from its preset and its user's settings.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AcpAgent {
    /// The backend's name, the provider instance's id, which a subscription `AccountChoice` names.
    pub name: String,
    /// What messages call it, such as `Cursor Agent`.
    pub label: String,
    /// The program, looked up on the launcher's `PATH`, or an absolute path.
    pub program: OsString,
    /// The arguments that start its ACP server, last on the command line, such as `["acp"]`.
    pub args: Vec<OsString>,
    /// Variables the run gets, set last: the instance's environment.
    pub env: Vec<(OsString, OsString)>,
    /// Prefixes of inherited variables no run gets, such as `CURSOR_`.
    pub scrub: Vec<String>,
    /// The flag that picks the model on the command line, such as Cursor's `--model`. `None`
    /// sets it over ACP once the session starts.
    pub model_flag: Option<String>,
    /// The flag that runs every tool without asking, such as Cursor's `--force`.
    pub bypass_flag: Option<String>,
    /// The session mode Bypass sets, for an agent with one instead of a flag.
    pub bypass_mode: Option<String>,
    /// The session mode Plan sets, such as `plan`. `None`: the agent offers no Plan.
    pub plan_mode: Option<String>,
    /// The session mode an approved plan switches back to, such as Cursor's `agent`.
    pub edit_mode: Option<String>,
}

impl AcpAgent {
    /// An agent with no flags or modes beyond ACP's own: `program args`, named `name`.
    #[must_use]
    pub fn new(name: &str, label: &str, program: impl Into<OsString>, args: &[&str]) -> Self {
        Self {
            name: name.to_owned(),
            label: label.to_owned(),
            program: program.into(),
            args: args.iter().map(OsString::from).collect(),
            env: Vec::new(),
            scrub: Vec::new(),
            model_flag: None,
            bypass_flag: None,
            bypass_mode: None,
            plan_mode: None,
            edit_mode: None,
        }
    }

    /// The permissions it maps: Edit always, Plan with a plan mode, and Bypass with a flag or mode.
    #[must_use]
    pub fn permissions(&self) -> Vec<AgentPermission> {
        let mut permissions = vec![AgentPermission::Edit];
        if self.plan_mode.is_some() {
            permissions.push(AgentPermission::Plan);
        }
        if self.bypass_flag.is_some() || self.bypass_mode.is_some() {
            permissions.push(AgentPermission::Bypass);
        }
        permissions
    }
}

/// A [`Backend`] that runs one ACP agent.
#[derive(Clone, Debug)]
pub struct AcpBackend {
    launcher: Launcher,
    agent: Arc<AcpAgent>,
    /// [`AcpAgent::permissions`].
    permissions: Vec<AgentPermission>,
}

impl AcpBackend {
    /// A backend that starts `agent` through `launcher`.
    #[must_use]
    pub fn new(launcher: Launcher, agent: AcpAgent) -> Self {
        let permissions = agent.permissions();
        Self {
            launcher,
            agent: Arc::new(agent),
            permissions,
        }
    }

    /// The agent this backend runs.
    #[must_use]
    pub fn agent(&self) -> &AcpAgent {
        &self.agent
    }

    /// The agent in `cwd` with no arguments yet, the inherited [`AcpAgent::scrub`] variables
    /// dropped, its environment set, and stdin piped.
    fn spec(&self, cwd: &Path) -> ProcessSpec {
        let mut spec = ProcessSpec::new(&self.agent.program, cwd);
        spec.scrub = scrubbed(self.launcher.base(), &self.agent.scrub);
        spec.inject = self.agent.env.iter().cloned().collect();
        spec.stdin = StdinMode::Piped;
        spec
    }
}

/// The ACP `initialize` params plxd sends: a client with no file system or terminal of its own.
pub fn initialize_params() -> Value {
    json!({
        "protocolVersion": 1,
        "clientCapabilities": {"fs": {"readTextFile": false, "writeTextFile": false}, "terminal": false},
        "clientInfo": {"name": "plxd", "version": crate::version()},
    })
}

/// `agent`'s arguments for `request`.
///
/// # Errors
///
/// [`StartError::Unsupported`] for a run that isn't a thread, a key account or another account
/// folder, an effort, context window, or fast mode, or a permission the agent doesn't map, and
/// [`StartError::Invalid`] for a model that could be read as an option.
pub fn arguments(agent: &AcpAgent, request: &RunRequest) -> Result<Vec<OsString>, StartError> {
    let label = &agent.label;
    if !request.thread {
        return Err(StartError::Unsupported(format!(
            "plxd runs only threads on {label}: it has no worker sandbox, and no coordinator (0036)"
        )));
    }
    match &request.account.credential {
        Credential::Subscription { config_home: None } => {}
        Credential::Subscription {
            config_home: Some(_),
        } => {
            return Err(StartError::Unsupported(format!(
                "{label} takes its folder from the provider's settings, not the account"
            )));
        }
        Credential::ApiKey(_) => {
            return Err(StartError::Unsupported(format!(
                "{label} runs only on its own sign-in, never a plxd API key (0004)"
            )));
        }
    }
    if request.effort.is_some() || request.context_window.is_some() || request.fast.is_some() {
        return Err(StartError::Unsupported(format!(
            "{label}'s effort, context window, and speed are part of its model"
        )));
    }
    let mut args: Vec<OsString> = Vec::new();
    if let Some(model) = &request.model {
        check_argument("model", model)?;
        if let Some(flag) = &agent.model_flag {
            args.extend([flag.into(), model.into()]);
        }
    }
    let permission = request.permission.unwrap_or(AgentPermission::Edit);
    if !agent.permissions().contains(&permission) {
        return Err(StartError::Unsupported(format!(
            "{label} has no mode for this permission"
        )));
    }
    if permission == AgentPermission::Bypass
        && let Some(flag) = &agent.bypass_flag
    {
        args.push(flag.into());
    }
    args.extend(agent.args.iter().cloned());
    Ok(args)
}

/// The variables of `base` that no run gets: those starting with one of `prefixes`.
#[must_use]
pub fn scrubbed(base: &Environment, prefixes: &[String]) -> Vec<OsString> {
    base.names()
        .filter(|name| {
            prefixes
                .iter()
                .any(|prefix| name.as_encoded_bytes().starts_with(prefix.as_bytes()))
        })
        .map(OsStr::to_owned)
        .collect()
}

impl Backend for AcpBackend {
    fn name(&self) -> &str {
        &self.agent.name
    }

    fn capabilities(&self) -> Capabilities {
        Capabilities {
            follow_ups: true,
            resume: true,
            coordinator: false,
            reports_cost: false,
            rate_limits: false,
            worker_sandbox: false,
        }
    }

    fn permissions(&self) -> &[AgentPermission] {
        &self.permissions
    }

    fn full_thread(&self) -> bool {
        true
    }

    /// The agent, with a new session for `cwd` ([`commands::acp`]).
    fn commands(&self, cwd: &Path) -> Result<Option<CommandsProbe>, StartError> {
        let mut spec = self.spec(cwd);
        spec.args.clone_from(&self.agent.args);
        Ok(Some(CommandsProbe {
            process: self.launcher.spawn(&spec)?,
            input: vec![
                commands::request(1, "initialize", &initialize_params()),
                commands::request(
                    commands::LIST_ID,
                    "session/new",
                    &json!({"cwd": cwd, "mcpServers": []}),
                ),
            ],
            parse: commands::acp,
        }))
    }

    fn start(&self, request: RunRequest) -> Result<Started, StartError> {
        if request.prompt.is_empty() && request.images.is_empty() {
            return Err(StartError::Invalid("the prompt is empty".into()));
        }
        let mut spec = self.spec(&request.cwd);
        spec.args = arguments(&self.agent, &request)?;
        let mut process = self.launcher.spawn(&spec)?;

        let switch = CancelSwitch::new();
        switch.arm(process.signals().clone(), CancelPolicy::default());
        let (handle, control) = RunHandle::new(request.run_id, true, switch.clone());
        let (handle, answers) = handle.with_answers();
        let stop = Arc::new(Notify::new());
        let baseline = request
            .resume
            .as_ref()
            .map(|resume| resume.usage_totals.clone())
            .unwrap_or_default();
        let (sink, events) = EventSink::channel(EVENT_BUFFER, baseline);
        let (stdin, lines) = mpsc::unbounded_channel();
        let writer = process
            .take_stdin()
            .map(|pipe| tokio::spawn(write_lines(pipe, lines)));
        let mut translator = Translator::default();
        translator.asks = request.approvals;
        translator.label.clone_from(&self.agent.label);
        let permission = request.permission.unwrap_or(AgentPermission::Edit);
        // The model goes over ACP unless a flag already picked it.
        let model = request
            .model
            .clone()
            .filter(|_| self.agent.model_flag.is_none());
        let mode = match permission {
            AgentPermission::Plan => self.agent.plan_mode.clone(),
            AgentPermission::Bypass if self.agent.bypass_flag.is_none() => {
                self.agent.bypass_mode.clone()
            }
            _ => None,
        };
        let driver = Driver {
            agent: Arc::clone(&self.agent),
            process,
            control,
            answers,
            sink,
            switch,
            stop: Arc::clone(&stop),
            translator,
            stdin: Some(stdin),
            writer,
            next_id: 0,
            requests: HashMap::new(),
            cwd: request.cwd.to_string_lossy().into_owned(),
            resume: request.resume.map(|resume| resume.session_id),
            mode,
            model,
            session: None,
            modes_pending: 0,
            prompts: VecDeque::from([Prompt::new(
                request.turn_id,
                &request.prompt,
                &request.images,
                false,
            )]),
            in_flight: None,
            build: None,
            asks: HashMap::new(),
            failure: None,
            results: 0,
            last_result: None,
        };
        tokio::spawn(driver.run());
        Ok(Started {
            run: Arc::new(AcpRun { handle, stop }),
            events,
        })
    }
}

/// The run's handle: [`RunHandle`], plus closing stdin on cancel.
struct AcpRun {
    handle: RunHandle,
    stop: Arc<Notify>,
}

impl Run for AcpRun {
    fn id(&self) -> RunId {
        self.handle.id()
    }

    fn send(&self, message: FollowUp) -> Result<(), SendError> {
        self.handle.send(message)
    }

    fn cancel(&self) {
        self.handle.cancel();
        self.stop.notify_one();
    }

    fn answer(&self, answer: Answer) -> Result<(), AnswerError> {
        self.handle.answer(answer)
    }
}

/// A message for `session/prompt`.
#[derive(Debug)]
struct Prompt {
    turn_id: Option<TurnId>,
    content: Vec<Value>,
    /// A follow-up, which is reported dropped if the CLI exits before taking it.
    follow_up: bool,
    /// Its `TurnStarted` was already sent: an approved plan's build, which goes on its turn.
    started: bool,
}

impl Prompt {
    /// `text` as a text block, after `images` as ACP image blocks. Images alone have no text block.
    fn new(turn_id: Option<TurnId>, text: &str, images: &[PromptImage], follow_up: bool) -> Self {
        let images = images.iter().map(
            |image| json!({"type": "image", "mimeType": image.media_type, "data": image.data}),
        );
        let text = (!text.trim().is_empty()).then(|| json!({"type": "text", "text": text}));
        Self {
            turn_id,
            content: images.chain(text).collect(),
            follow_up,
            started: false,
        }
    }
}

/// What one of plxd's requests was, for its response.
#[derive(Debug)]
enum Request {
    Initialize,
    Session,
    Mode,
    Prompt(Prompt),
}

/// Writes lines to stdin in order, off the driver's loop, and closes it once every sender is gone.
async fn write_lines(mut stdin: StdinPipe, mut lines: mpsc::UnboundedReceiver<String>) {
    while let Some(line) = lines.recv().await {
        if stdin.write_all(line.as_bytes()).await.is_err() {
            break;
        }
    }
}

/// One run: speaks ACP with the CLI, delivers follow-ups and answers, and decides the outcome
/// when the CLI exits.
struct Driver {
    agent: Arc<AcpAgent>,
    process: Process,
    control: mpsc::UnboundedReceiver<FollowUp>,
    answers: mpsc::UnboundedReceiver<Answer>,
    sink: EventSink,
    switch: CancelSwitch,
    stop: Arc<Notify>,
    translator: Translator,
    /// Lines for [`write_lines`]; `None` once stdin is closed.
    stdin: Option<mpsc::UnboundedSender<String>>,
    writer: Option<tokio::task::JoinHandle<()>>,
    next_id: u64,
    /// plxd's requests that haven't been answered, by id.
    requests: HashMap<u64, Request>,
    cwd: String,
    resume: Option<String>,
    /// The session mode the permission sets once the session starts: Plan's, or Bypass's.
    mode: Option<String>,
    /// The model to set over ACP once the session starts.
    model: Option<String>,
    /// The session's id, once `session/new` or `session/load` answered.
    session: Option<String>,
    /// `session/set_mode` and model requests not yet answered; prompts wait for them.
    modes_pending: usize,
    /// Messages waiting for the session, or for the turn before them to end.
    prompts: VecDeque<Prompt>,
    /// The id of the `session/prompt` the CLI is working on.
    in_flight: Option<u64>,
    /// An approved plan's build, which goes on the plan's turn once the CLI ends it.
    build: Option<String>,
    /// Requests the CLI waits on.
    asks: HashMap<ApprovalId, Ask>,
    failure: Option<Failure>,
    results: usize,
    last_result: Option<String>,
}

impl Driver {
    async fn run(mut self) {
        self.request("initialize", &initialize_params(), Request::Initialize);
        let mut control_open = true;
        let mut answers_open = true;
        let exit = loop {
            tokio::select! {
                output = self.process.next() => match output {
                    Some(Output::Line(line)) => {
                        let steps = self.translator.line(&line);
                        self.apply(steps).await;
                    }
                    Some(Output::Oversized { bytes }) => {
                        self.emit(Event::Warning {
                            warning: WarningKind::OversizedLine,
                            detail: format!("skipped a {bytes}-byte line"),
                        })
                        .await;
                    }
                    Some(Output::Exited(exit)) => break Some(exit),
                    None => break None,
                },
                answer = self.answers.recv(), if answers_open => match answer {
                    Some(answer) => self.answer(answer).await,
                    None => answers_open = false,
                },
                follow_up = self.control.recv(), if control_open => match follow_up {
                    Some(follow_up) => {
                        let prompt = Prompt::new(Some(follow_up.turn_id), &follow_up.text, &follow_up.images, true);
                        self.prompts.push_back(prompt);
                    }
                    None => control_open = false,
                },
                () = self.stop.notified(), if self.stdin.is_some() => self.close(),
                () = self.sink.closed(), if !self.switch.is_cancelled() => {
                    self.switch.cancel();
                    self.close();
                }
            }
            self.next_prompt().await;
            if self.stdin.is_some()
                && self.session.is_some()
                && self.in_flight.is_none()
                && self.prompts.is_empty()
                && self.asks.is_empty()
                && self.build.is_none()
            {
                self.close();
            }
        };

        if let Some(step) = self.translator.flush() {
            self.apply(vec![step]).await;
        }
        self.drop_undelivered().await;
        for approval_id in std::mem::take(&mut self.asks).into_keys() {
            self.emit(Event::ApprovalWithdrawn { approval_id }).await;
        }
        let outcome = self.outcome(exit);
        let _ = self.sink.finish(outcome).await;
    }

    /// Sends a JSON-RPC request, and remembers what it was for its response.
    fn request(&mut self, method: &str, params: &Value, kind: Request) -> u64 {
        self.next_id += 1;
        let id = self.next_id;
        self.write(&json!({"jsonrpc": "2.0", "id": id, "method": method, "params": params}));
        self.requests.insert(id, kind);
        id
    }

    fn write(&mut self, message: &Value) {
        if let Some(stdin) = &self.stdin {
            let _ = stdin.send(format!("{message}\n"));
        }
    }

    /// Closes stdin once what is queued is written, so the CLI exits after its turn; no more
    /// follow-ups are taken.
    fn close(&mut self) {
        self.stdin = None;
        self.control.close();
    }

    /// Sends the next message once the session is ready and no turn is in flight.
    async fn next_prompt(&mut self) {
        let Some(session) = self.session.clone() else {
            return;
        };
        if self.in_flight.is_some() || self.modes_pending > 0 || self.stdin.is_none() {
            return;
        }
        let Some(prompt) = self.prompts.pop_front() else {
            return;
        };
        let (turn_id, started) = (prompt.turn_id, prompt.started);
        let params = json!({"sessionId": session, "prompt": prompt.content});
        self.in_flight = Some(self.request("session/prompt", &params, Request::Prompt(prompt)));
        if !started {
            self.emit(Event::TurnStarted { turn_id }).await;
        }
    }

    async fn apply(&mut self, steps: Vec<Step>) {
        for step in steps {
            match step {
                Step::Emit(event) => self.emit(event).await,
                Step::Reply(message) => self.write(&message),
                Step::Ask(request, ask) => {
                    self.asks.insert(request.approval_id, ask);
                    self.emit(Event::ApprovalRequested(request)).await;
                }
                Step::Response { id, result } => self.response(id, result).await,
            }
        }
    }

    async fn response(&mut self, id: u64, result: Result<Value, String>) {
        let Some(request) = self.requests.remove(&id) else {
            return;
        };
        let value = match result {
            Ok(value) => value,
            Err(message) => {
                if matches!(request, Request::Mode) {
                    self.modes_pending = self.modes_pending.saturating_sub(1);
                    self.emit(Event::Notice { detail: message }).await;
                    return;
                }
                // The session or a turn failed: the run ends with it. Every prompt's turn has
                // started by now, an approved plan's build on the plan's turn.
                if let Request::Prompt(prompt) = &request {
                    let result = None;
                    let turn_id = prompt.turn_id;
                    self.emit(Event::TurnFinished { turn_id, result }).await;
                }
                self.failure = Some(failure(classify(&message), message));
                self.in_flight = None;
                self.close();
                return;
            }
        };
        match request {
            Request::Initialize => {
                let params = json!({"cwd": self.cwd, "mcpServers": []});
                match self.resume.clone() {
                    Some(session) => {
                        self.translator.replaying = true;
                        let params =
                            json!({"sessionId": session, "cwd": self.cwd, "mcpServers": []});
                        self.request("session/load", &params, Request::Session);
                    }
                    None => {
                        self.request("session/new", &params, Request::Session);
                    }
                }
            }
            Request::Session => {
                self.translator.replaying = false;
                let session = value
                    .get("sessionId")
                    .and_then(Value::as_str)
                    .map(str::to_owned)
                    .or_else(|| self.resume.clone());
                let Some(session) = session else {
                    self.failure = Some(failure(
                        FailureKind::VendorError,
                        format!("{} started no session", self.agent.label),
                    ));
                    self.close();
                    return;
                };
                let current = value
                    .pointer("/models/currentModelId")
                    .and_then(Value::as_str)
                    .map(str::to_owned);
                let model = self.model.take();
                self.emit(Event::SessionStarted {
                    session_id: session.clone(),
                    model: model.clone().or(current),
                    api_key_source: None,
                })
                .await;
                if let Some(model) = model {
                    self.set_model(&session, &value, &model);
                }
                if let Some(mode) = self.mode.take() {
                    self.set_mode(&session, &mode);
                }
                self.session = Some(session);
            }
            Request::Mode => self.modes_pending = self.modes_pending.saturating_sub(1),
            Request::Prompt(prompt) => {
                self.in_flight = None;
                if value.get("stopReason").and_then(Value::as_str) == Some("cancelled") {
                    self.build = None;
                }
                if let Some(text) = self.build.take() {
                    // The approved plan's build goes on as this turn.
                    self.prompts.push_front(Prompt {
                        turn_id: prompt.turn_id,
                        content: vec![json!({"type": "text", "text": text})],
                        follow_up: false,
                        started: true,
                    });
                    return;
                }
                self.results += 1;
                let result = self.translator.take_text();
                self.last_result.clone_from(&result);
                let turn_id = prompt.turn_id;
                self.emit(Event::TurnFinished { turn_id, result }).await;
            }
        }
    }

    /// Picks `model` for the session: through its model config option when `session`'s answer
    /// lists one, else with `session/set_model`.
    fn set_model(&mut self, session: &str, answer: &Value, model: &str) {
        self.modes_pending += 1;
        let option = answer
            .get("configOptions")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .find(|option| option.get("category").and_then(Value::as_str) == Some("model"))
            .and_then(|option| option.get("id").and_then(Value::as_str));
        match option {
            Some(id) => {
                let params = json!({"sessionId": session, "configId": id, "value": model});
                self.request("session/set_config_option", &params, Request::Mode);
            }
            None => {
                let params = json!({"sessionId": session, "modelId": model});
                self.request("session/set_model", &params, Request::Mode);
            }
        }
    }

    fn set_mode(&mut self, session: &str, mode: &str) {
        self.modes_pending += 1;
        let params = json!({"sessionId": session, "modeId": mode});
        self.request("session/set_mode", &params, Request::Mode);
    }

    /// Writes `answer` to the CLI, if it still waits on the request. A denial that interrupts
    /// also cancels the turn, and withdraws every other request it waits on, answered `cancelled`
    /// as ACP has a client do after `session/cancel`.
    async fn answer(&mut self, answer: Answer) {
        let Some(ask) = self.asks.remove(&answer.approval_id) else {
            return;
        };
        let interrupt = matches!(
            answer.decision,
            Decision::Deny {
                interrupt: true,
                ..
            }
        );
        let leaves_plan = matches!(
            (&ask.kind, &answer.decision),
            (AskKind::Plan { .. }, Decision::Allow { .. })
        );
        let reply = match (ask.kind, answer.decision) {
            (AskKind::Permission { allow, .. }, Decision::Allow { .. }) => {
                permission_answer(&ask.id, allow.as_deref())
            }
            (AskKind::Permission { reject, .. }, Decision::Deny { .. }) => {
                if let Some(call_id) = ask.call_id {
                    self.translator.denied.insert(call_id);
                }
                permission_answer(&ask.id, reject.as_deref())
            }
            (AskKind::Plan { plan }, Decision::Allow { input, .. }) => {
                // An edited plan is the user's own: the build says so, since Cursor's answer has
                // no field for it.
                let edited = input
                    .as_ref()
                    .and_then(|input| input.get("plan"))
                    .and_then(Value::as_str)
                    .filter(|edited| *edited != plan);
                self.build = Some(match edited {
                    Some(edited) => format!("{BUILD_PLAN} Use this version of it:\n\n{edited}"),
                    None => BUILD_PLAN.to_owned(),
                });
                json!({"jsonrpc": "2.0", "id": ask.id, "result": {"outcome": {"outcome": "accepted"}}})
            }
            (AskKind::Plan { .. }, Decision::Deny { message, .. }) => {
                if let Some(call_id) = ask.call_id {
                    self.translator.denied.insert(call_id);
                }
                let mut outcome = json!({"outcome": "rejected"});
                if !message.trim().is_empty() {
                    outcome["reason"] = Value::from(message);
                }
                json!({"jsonrpc": "2.0", "id": ask.id, "result": {"outcome": outcome}})
            }
        };
        self.write(&reply);
        // Out of plan mode, after the answer, for the build.
        if leaves_plan
            && let Some(session) = self.session.clone()
            && let Some(mode) = self.agent.edit_mode.clone()
        {
            self.set_mode(&session, &mode);
        }
        if interrupt && let Some(session) = self.session.clone() {
            self.write(&json!({"jsonrpc": "2.0", "method": "session/cancel", "params": {"sessionId": session}}));
            for (approval_id, ask) in std::mem::take(&mut self.asks) {
                let outcome = json!({"outcome": "cancelled"});
                self.write(
                    &json!({"jsonrpc": "2.0", "id": ask.id, "result": {"outcome": outcome}}),
                );
                self.emit(Event::ApprovalWithdrawn { approval_id }).await;
            }
        }
    }

    async fn emit(&mut self, event: Event) {
        if self.sink.emit(event).await.is_err() {
            self.switch.cancel();
        }
    }

    /// After the CLI exited: reports every follow-up that never started a turn as dropped.
    async fn drop_undelivered(&mut self) {
        self.close();
        let mut dropped: Vec<TurnId> = std::mem::take(&mut self.prompts)
            .into_iter()
            .filter(|prompt| prompt.follow_up)
            .filter_map(|prompt| prompt.turn_id)
            .collect();
        while let Ok(follow_up) = self.control.try_recv() {
            dropped.push(follow_up.turn_id);
        }
        for turn_id in dropped {
            self.emit(Event::FollowUpDropped { turn_id }).await;
        }
        if let Some(writer) = self.writer.take() {
            let _ = tokio::time::timeout(Duration::from_secs(1), writer).await;
        }
    }

    fn outcome(&mut self, exit: Option<Exit>) -> Outcome {
        if self.switch.is_cancelled() {
            return Outcome::Cancelled;
        }
        if let Some(failure) = self.failure.take() {
            return failed(failure, exit.as_ref());
        }
        let Some(exit) = exit else {
            return failed(
                failure(FailureKind::Internal, "lost track of the process".into()),
                None,
            );
        };
        if exit.info.success() && self.results > 0 {
            return Outcome::Completed {
                result: self.last_result.take(),
            };
        }
        let failure = match classify(&exit.stderr_tail) {
            FailureKind::NotSignedIn => failure(
                FailureKind::NotSignedIn,
                format!("{} is not signed in", self.agent.label),
            ),
            _ if exit.info.success() => failure(
                FailureKind::VendorError,
                format!("{} exited without finishing its turn", self.agent.label),
            ),
            _ => {
                let message = match (exit.info.code, exit.info.signal) {
                    (_, Some(signal)) => format!("{} was killed by signal {signal}", self.agent.label),
                    (Some(code), None) => format!("{} exited with code {code}", self.agent.label),
                    (None, None) => format!("{} ended in an unknown way", self.agent.label),
                };
                failure(FailureKind::Crashed, message)
            }
        };
        failed(failure, Some(&exit))
    }
}

/// What kind of failure an agent's message describes: an "Authentication required" error, or a
/// usage limit, which routing falls back on (0012).
fn classify(message: &str) -> FailureKind {
    let lower = message.to_ascii_lowercase();
    if lower.contains("authentication required")
        || lower.contains("not logged in")
        || lower.contains("agent login")
    {
        FailureKind::NotSignedIn
    } else if lower.contains("rate limit") || lower.contains("usage limit") {
        FailureKind::RateLimited
    } else {
        FailureKind::VendorError
    }
}

fn failure(failure: FailureKind, message: String) -> Failure {
    Failure {
        failure,
        message,
        exit: None,
        stderr_tail: None,
    }
}

/// A failed outcome, with how the process ended when it did.
fn failed(mut failure: Failure, exit: Option<&Exit>) -> Outcome {
    if let Some(exit) = exit {
        failure.exit = Some(exit.info);
        failure.stderr_tail = (!exit.stderr_tail.is_empty()).then(|| exit.stderr_tail.clone());
    }
    Outcome::Failed(failure)
}
