//! The `OpenCode` backend: runs a thread on `OpenCode`'s HTTP server, the API `opencode serve`
//! exposes (PLX-559), rather than `opencode acp`, which always starts a server of its own.
//!
//! # The server
//!
//! An instance with `OPENCODE_SERVER_URL` uses that server. Without it, each run starts
//! `opencode serve --hostname 127.0.0.1 --port 0` in the run's folder with the instance's program,
//! arguments, home, and variables, reads the URL it prints, and stops it when the run ends. A
//! server asks for HTTP basic auth when it has a password: `OPENCODE_SERVER_USERNAME` or
//! `opencode`, and `OPENCODE_SERVER_PASSWORD`, a secret read from the keychain only when a run
//! starts (0040). A server plxd starts gets that password, or a random one when the instance
//! has none, so it is never open to the host's other users. The three server variables go to
//! nothing else: not to `opencode serve` beyond its password and username, and never on a
//! command line. `OpenCode` passes its own environment to the tools it runs, so a spawned
//! server's password reaches the agent's shell, which already runs as the server does.
//!
//! # The HTTP client
//!
//! plxd has no HTTP client of its own, so every call is a `curl` run, as a model service's model
//! list is (0040): the credentials and the JSON body go to curl as a config on stdin, which `ps`
//! never shows, and https works for a remote server. A loopback server is reached without the
//! host's proxy, so none sees its password ([`LOOPBACK`]), and a URL must be `http://` or
//! `https://`. The event stream is one `curl -N` on
//! `/event` for the run's folder, read line by line, which fails once it is quiet for a minute,
//! though the server sends a heartbeat every few seconds.
//!
//! # Sessions and turns
//!
//! A run checks that the server is `OpenCode` 1.x's (`GET /global/health`), creates a session
//! (`POST /session`) or checks the one it resumes (`GET /session/<id>`), and opens its event
//! stream before the first prompt. Each message is a `POST /session/<id>/prompt_async`, with its
//! images as `data:` file parts before its text, the model as `providerID/modelID`, and Plan's
//! `plan` agent; a turn ends when the session goes idle after it went busy for the prompt, or
//! with a `session.error`, which fails the run. A follow-up sent during a turn waits for it. A
//! steer (PLX-370) aborts the turn (`POST /session/<id>/abort`) and then goes as the next
//! prompt, as ACP agents take one. Once no turn is in flight, nothing waits, and plxd holds no
//! message for it ([`Run::hold`]), the run ends; a later message resumes the session.
//!
//! Only threads and a Project's coordinator run here (`RunRequest::full_agent`, 0042): `OpenCode`
//! has no worker sandbox plxd can check. A thread with `approvals` or Bypass gets its
//! `plxd mcp --thread` server (0041) through `POST /mcp`, under a name of its own run, since
//! a server's MCP servers are shared by its folder's sessions; it is disconnected at the end.
//!
//! # Permission requests
//!
//! `OpenCode`'s `build` and `plan` agents allow everything unless told otherwise, and a session's
//! rules come after the agent's, the last match winning. So every run appends its level's rules
//! to the session ([`rules`], 0054): Supervised asks for `bash` and `edit`, Auto-accept edits
//! allows `edit`, Plan denies `edit`, and Full access allows both. Below Full access `task` is
//! denied too, since a subagent's session keeps only its parent's denials, and the `question`
//! tool is always denied, since the app has no card for it. A `permission.asked` is answered by
//! level as ACP agents' requests are ([`stream::Translator`]), else becomes
//! [`Event::ApprovalRequested`], and [`Run::answer`] replies `once` or `reject`. A rejection
//! carries a message, the user's or a default, since `OpenCode` ends the turn on one without;
//! only an interrupt goes without and aborts. Without `approvals`, plxd rejects what its level
//! doesn't allow. Rejecting one request makes `OpenCode` reject the session's other pending ones
//! with no message (`permission.replied`), which plxd withdraws; that still ends the turn,
//! except on a server plxd started, which gets `continue_loop_on_deny` ([`CONFIG_CONTENT`]).
//! A question another tool still asks is answered with [`stream::QUESTION_ANSWER`], so the
//! agent goes on.
//!
//! # Cancel
//!
//! Cancel aborts the turn and ends the run; a server plxd started is stopped with it.

mod stream;

#[cfg(all(test, unix))]
mod tests;

use std::collections::{HashMap, VecDeque};
use std::ffi::OsString;
use std::fmt::Write as _;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use parallax_protocol::ProviderModel;
use serde_json::{Value, json};
use tokio::io::AsyncWriteExt;
use tokio::sync::{Notify, mpsc};

use self::stream::{Ask, Step, Translator};
use super::event::{Event, Failure, FailureKind, Outcome, WarningKind};
use super::process::{CancelPolicy, Launcher, Output, Process, ProcessSpec, StdinMode};
use super::{
    AgentPermission, Answer, AnswerError, ApiKey, ApprovalId, Backend, CancelSwitch, Capabilities,
    Credential, Decision, EVENT_BUFFER, EventSink, FollowUp, Held, PromptImage, Run, RunHandle,
    RunId, RunRequest, SendError, StartError, Started, TurnId, check_argument,
};

/// The variable that names the server an instance uses.
pub const URL_VAR: &str = "OPENCODE_SERVER_URL";
/// The variable that holds the server's password, a secret.
pub const PASSWORD_VAR: &str = "OPENCODE_SERVER_PASSWORD";
/// The variable that holds the server's user name, `opencode` when unset.
pub const USERNAME_VAR: &str = "OPENCODE_SERVER_USERNAME";

/// The levels an `OpenCode` thread takes, in the picker's order (0054).
pub const PERMISSIONS: &[AgentPermission] = &[
    AgentPermission::Manual,
    AgentPermission::Edit,
    AgentPermission::Plan,
    AgentPermission::Bypass,
];

/// The hosts curl reaches without a proxy, so no proxy sees a local server's password. A remote
/// server still goes through the host's proxy, which only tunnels https.
const LOOPBACK: &str = "127.0.0.1,localhost,::1";

/// The config a server plxd starts gets, unless the instance or plxd's environment sets one:
/// without it, `OpenCode` ends the turn when it rejects a request's siblings with no message,
/// as it does once one of several parallel requests is denied.
const CONFIG_CONTENT: &str = r#"{"experimental":{"continue_loop_on_deny":true}}"#;

/// How long a server plxd starts may take to say where it listens, and its event stream to open.
const START_TIMEOUT: Duration = Duration::from_secs(30);

/// How long one HTTP call may take.
const CALL_TIMEOUT: Duration = Duration::from_secs(30);

/// One `OpenCode` instance: its server, or how to start one. A provider instance (0040) builds
/// it from its settings.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Opencode {
    /// The backend's name, the provider instance's id.
    pub name: String,
    /// What messages call it, such as `OpenCode`.
    pub label: String,
    /// The program a started server runs, looked up on the launcher's `PATH`, or an absolute path.
    pub program: OsString,
    /// Arguments after `serve --hostname 127.0.0.1 --port 0`.
    pub args: Vec<OsString>,
    /// Variables a started server gets: the instance's, without the server variables.
    pub env: Vec<(OsString, OsString)>,
    /// `OPENCODE_SERVER_URL`: the server to use instead of starting one.
    pub url: Option<String>,
    /// `OPENCODE_SERVER_USERNAME`.
    pub username: Option<String>,
    /// `OPENCODE_SERVER_PASSWORD`, when this instance was built with its secrets.
    pub password: Option<ApiKey>,
}

impl Opencode {
    /// `program` with `args`, and `env`, from which the server variables are taken.
    #[must_use]
    pub fn new(
        name: &str,
        label: &str,
        program: impl Into<OsString>,
        args: Vec<OsString>,
        env: Vec<(OsString, OsString)>,
    ) -> Self {
        let mut opencode = Self {
            name: name.to_owned(),
            label: label.to_owned(),
            program: program.into(),
            args,
            env: Vec::new(),
            url: None,
            username: None,
            password: None,
        };
        for (name, value) in env {
            let text = || value.to_string_lossy().into_owned();
            if name == URL_VAR {
                opencode.url = Some(text()).filter(|url| !url.is_empty());
            } else if name == USERNAME_VAR {
                opencode.username = Some(text()).filter(|user| !user.is_empty());
            } else if name == PASSWORD_VAR {
                opencode.password =
                    Some(ApiKey::new(text())).filter(|key| !key.expose().is_empty());
            } else {
                opencode.env.push((name, value));
            }
        }
        opencode
    }

    /// The server at its URL, with its credentials.
    fn server(&self, url: &str, password: Option<&str>) -> Server {
        let user = self.username.as_deref().unwrap_or("opencode");
        Server {
            url: url.trim_end_matches('/').to_owned(),
            auth: password.map(|password| ApiKey::new(format!("{user}:{password}"))),
        }
    }

    /// `opencode serve` in `cwd`, with `password`, as [`listening`] reads it, through `launcher`.
    fn serve_spec(&self, launcher: &Launcher, cwd: &Path, password: &str) -> ProcessSpec {
        let mut spec = ProcessSpec::new(&self.program, cwd);
        spec.args = ["serve", "--hostname", "127.0.0.1", "--port", "0"]
            .iter()
            .map(OsString::from)
            .chain(self.args.iter().cloned())
            .collect();
        // Inherited ones would point the server, or plxd, elsewhere.
        spec.scrub = [URL_VAR, USERNAME_VAR, PASSWORD_VAR]
            .iter()
            .map(OsString::from)
            .collect();
        spec.inject = self.env.iter().cloned().collect();
        spec.inject.set(PASSWORD_VAR, password);
        if let Some(user) = &self.username {
            spec.inject.set(USERNAME_VAR, user);
        }
        let config = "OPENCODE_CONFIG_CONTENT";
        if spec.inject.get(config).is_none() && launcher.base().get(config).is_none() {
            spec.inject.set(config, CONFIG_CONTENT);
        }
        spec
    }
}

/// Checks that `url` is an `http://` or `https://` URL, so curl never reads it as an option.
fn check_url(url: &str) -> Result<(), String> {
    if url.starts_with("http://") || url.starts_with("https://") {
        Ok(())
    } else {
        Err(format!(
            "{URL_VAR} must start with http:// or https://, not {url:?}"
        ))
    }
}

/// A random password for a server plxd starts with none of the instance's.
fn random_password() -> String {
    uuid::Uuid::new_v4().simple().to_string()
}

/// Reads `serve`'s output until it says where it listens: `opencode server listening on <url>`.
async fn listening(serve: &mut Process) -> Result<String, String> {
    loop {
        match serve.next().await {
            Some(Output::Line(line)) => {
                let line = String::from_utf8_lossy(&line);
                if let Some((_, rest)) = line.split_once("listening on ")
                    && let Some(url) = rest.split_whitespace().next()
                {
                    return Ok(url.to_owned());
                }
            }
            Some(Output::Oversized { .. }) => {}
            Some(Output::Exited(exit)) => {
                return Err(format!("opencode serve exited: {}", exit.stderr_tail));
            }
            None => return Err("opencode serve exited".to_owned()),
        }
    }
}

/// An `OpenCode` server as plxd calls it, through `curl`.
#[derive(Clone, Debug)]
pub struct Server {
    url: String,
    /// `user:password`, for basic auth.
    auth: Option<ApiKey>,
}

impl Server {
    /// The curl config that signs in, if the server has a password.
    fn config(&self) -> String {
        self.auth
            .as_ref()
            .map(|auth| format!("user = {}\n", quote(auth.expose())))
            .unwrap_or_default()
    }

    /// `METHOD path` with `body` as JSON (none for `Null`): its answer, `Null` when empty.
    ///
    /// # Errors
    ///
    /// Why the server couldn't be reached, or what it answered instead.
    pub async fn call(
        &self,
        launcher: &Launcher,
        method: &str,
        path: &str,
        body: &Value,
    ) -> Result<Value, String> {
        let url = format!("{}{path}", self.url);
        let mut spec = ProcessSpec::new("curl", std::env::temp_dir());
        let max_time = CALL_TIMEOUT.as_secs().to_string();
        // `-q` first: a `.curlrc` could change what curl prints.
        spec.args = [
            "-q",
            "--noproxy",
            LOOPBACK,
            "-sS",
            "--max-time",
            max_time.as_str(),
            "-K",
            "-",
            "-X",
            method,
            "-w",
            "\n%{http_code}",
            url.as_str(),
        ]
        .iter()
        .map(Into::into)
        .collect();
        spec.stdin = StdinMode::Piped;
        let mut config = self.config();
        if !body.is_null() {
            config.push_str("header = \"content-type: application/json\"\n");
            let _ = writeln!(config, "data-binary = {}", quote(&body.to_string()));
        }
        let timeout = CALL_TIMEOUT + Duration::from_secs(5);
        let ran = crate::detect::run_spec(launcher, &spec, config.as_bytes(), timeout).await?;
        if ran.exit_code != Some(0) {
            return Err(format!(
                "couldn't reach the OpenCode server at {}: {}",
                self.url,
                ran.stderr_tail.trim()
            ));
        }
        let text = ran.stdout.trim_end();
        let (body, status) = text.rsplit_once('\n').unwrap_or(("", text));
        let value = serde_json::from_str(body).unwrap_or_else(|_| Value::from(body));
        match status {
            "401" if self.auth.is_some() => Err(format!(
                "the OpenCode server at {} refused the password",
                self.url
            )),
            "401" => Err(format!(
                "the OpenCode server at {} asks for a password ({PASSWORD_VAR})",
                self.url
            )),
            status if status.starts_with('2') => {
                Ok(if body.is_empty() { Value::Null } else { value })
            }
            status => Err(value["data"]["message"]
                .as_str()
                .or_else(|| value["message"].as_str())
                .or_else(|| value["name"].as_str())
                .map_or_else(
                    || format!("the OpenCode server answered {status}: {body}"),
                    str::to_owned,
                )),
        }
    }

    /// The server's version, from `/global/health`.
    ///
    /// # Errors
    ///
    /// [`Server::call`]'s, or that it isn't `OpenCode` 1.x's server: 2.x's API is another one.
    pub async fn version(&self, launcher: &Launcher) -> Result<String, String> {
        let health = self
            .call(launcher, "GET", "/global/health", &Value::Null)
            .await?;
        health["version"]
            .as_str()
            .filter(|_| health["healthy"] == true)
            .map(str::to_owned)
            .ok_or_else(|| {
                format!(
                    "{} doesn't answer as an OpenCode 1.x server; plxd doesn't run OpenCode 2's API yet",
                    self.url
                )
            })
    }

    /// The server's events for `folder`'s sessions: `curl -N` on `/event`, one `data:` line each.
    fn events(&self, launcher: &Launcher, folder: &Path) -> Result<Process, String> {
        let url = format!("{}/event?directory={}", self.url, encode(folder));
        let mut spec = ProcessSpec::new("curl", std::env::temp_dir());
        // The server sends a heartbeat every few seconds, so a stream that goes quiet for a
        // minute is dead, such as a remote server's that the network dropped.
        spec.args = [
            "-q",
            "--noproxy",
            LOOPBACK,
            "-sSN",
            "--fail",
            "--speed-limit",
            "1",
            "--speed-time",
            "60",
            "-K",
            "-",
            url.as_str(),
        ]
        .iter()
        .map(Into::into)
        .collect();
        spec.stdin = StdinMode::Piped;
        let mut process = launcher
            .spawn(&spec)
            .map_err(|error| format!("couldn't start curl: {error}"))?;
        let config = self.config();
        if let Some(mut stdin) = process.take_stdin() {
            tokio::spawn(async move {
                let _ = stdin.write_all(config.as_bytes()).await;
            });
        }
        Ok(process)
    }
}

/// `text` as a quoted curl config string.
fn quote(text: &str) -> String {
    let escaped = text
        .replace('\\', "\\\\")
        .replace('"', "\\\"")
        .replace('\n', "\\n")
        .replace('\r', "\\r");
    format!("\"{escaped}\"")
}

/// `path` percent-encoded for a query string.
fn encode(path: &Path) -> String {
    let mut encoded = String::new();
    for byte in path.to_string_lossy().bytes() {
        if byte.is_ascii_alphanumeric() || b"-_.~/".contains(&byte) {
            encoded.push(char::from(byte));
        } else {
            let _ = write!(encoded, "%{byte:02X}");
        }
    }
    encoded
}

/// What [`inspect`] found about an instance's server.
#[derive(Debug, Default)]
pub struct Inspected {
    /// The server's version, from `/global/health`.
    pub version: Option<String>,
    /// Every model of its connected providers, as `providerID/modelID`.
    pub models: Vec<ProviderModel>,
    /// Whether it has a provider it can run a model on.
    pub signed_in: Option<bool>,
    /// What the user should know: where the server is, or why it couldn't be read.
    pub note: Option<String>,
}

/// Reads `opencode`'s server: its URL's, or one started in the user's home and stopped after.
/// `secret` says the instance keeps a password in the keychain, which a probe never reads (0040).
pub async fn inspect(launcher: &Launcher, opencode: &Opencode, secret: bool) -> Inspected {
    let read = async {
        let mut started = None;
        let server = if let Some(url) = &opencode.url {
            check_url(url)?;
            opencode.server(url, opencode.password.as_ref().map(ApiKey::expose))
        } else {
            let password = random_password();
            let home = std::env::home_dir().unwrap_or_else(std::env::temp_dir);
            let spec = opencode.serve_spec(launcher, &home, &password);
            let mut serve = launcher
                .spawn(&spec)
                .map_err(|error| format!("couldn't start opencode serve: {error}"))?;
            let url = listening(&mut serve).await?;
            started = Some(serve);
            opencode.server(&url, Some(&password))
        };
        let version = server.version(launcher).await?;
        let providers = server.call(launcher, "GET", "/config/providers", &Value::Null);
        let providers = providers.await?;
        drop(started);
        Ok::<_, String>((version, providers))
    };
    let (version, providers) = match tokio::time::timeout(START_TIMEOUT, read).await {
        Ok(Ok(read)) => read,
        Ok(Err(error)) => {
            let note = if secret && error.contains("asks for a password") {
                format!(
                    "The OpenCode server at {} is reachable. plxd can't list its models: it reads \
                     {PASSWORD_VAR} only when a thread runs",
                    opencode.url.as_deref().unwrap_or_default()
                )
            } else {
                error
            };
            return Inspected {
                note: Some(note),
                ..Inspected::default()
            };
        }
        Err(_) => {
            return Inspected {
                note: Some(format!(
                    "the OpenCode server didn't answer within {}s",
                    START_TIMEOUT.as_secs()
                )),
                ..Inspected::default()
            };
        }
    };
    let models: Vec<ProviderModel> = providers["providers"]
        .as_array()
        .into_iter()
        .flatten()
        .flat_map(|provider| {
            let id = provider["id"].as_str().unwrap_or_default();
            provider["models"]
                .as_object()
                .into_iter()
                .flatten()
                .map(move |(model, info)| ProviderModel {
                    id: format!("{id}/{model}"),
                    name: info["name"].as_str().unwrap_or(model).to_owned(),
                })
        })
        .collect();
    Inspected {
        version: Some(version),
        signed_in: Some(!models.is_empty()),
        note: opencode
            .url
            .as_ref()
            .map(|url| format!("Uses the OpenCode server at {url}")),
        models,
    }
}

/// A [`Backend`] that runs threads on one `OpenCode` instance's server.
#[derive(Clone, Debug)]
pub struct OpencodeBackend {
    launcher: Launcher,
    opencode: Arc<Opencode>,
}

impl OpencodeBackend {
    /// A backend for `opencode`, whose servers start through `launcher`.
    #[must_use]
    pub fn new(launcher: Launcher, opencode: Opencode) -> Self {
        Self {
            launcher,
            opencode: Arc::new(opencode),
        }
    }
}

/// The session rules a run with `permission` appends, which win over the agent's and every
/// earlier run's, since they come last (0054). A `task` subagent's session takes only its
/// parent's `deny` rules, never an `ask`, and runs on an agent that allows everything, so
/// below Full access the thread has no subagents. The `question` tool is always off: the app
/// has no card for it. So is the experimental `plan_exit`, which would take plxd's answer to its
/// question as the user's approval and leave the `plan` agent; a thread leaves Plan when the
/// user picks another level.
fn rules(permission: AgentPermission) -> Value {
    let (bash, edit, task) = match permission {
        AgentPermission::Bypass => ("allow", "allow", "allow"),
        AgentPermission::Edit => ("ask", "allow", "deny"),
        AgentPermission::Plan => ("ask", "deny", "deny"),
        _ => ("ask", "ask", "deny"),
    };
    json!([
        {"permission": "bash", "pattern": "*", "action": bash},
        {"permission": "edit", "pattern": "*", "action": edit},
        {"permission": "task", "pattern": "*", "action": task},
        {"permission": "question", "pattern": "*", "action": "deny"},
        {"permission": "plan_exit", "pattern": "*", "action": "deny"},
    ])
}

/// Checks `request` for what `OpenCode` can run, and returns its model as `prompt_async` takes it.
///
/// # Errors
///
/// [`StartError::Unsupported`] for a run that isn't a thread or a coordinator, a key account or
/// an account folder, a fork, an effort, context window, or fast mode, or a level it doesn't map,
/// and [`StartError::Invalid`] for an empty prompt or a model that isn't `provider/model`.
fn check(label: &str, request: &RunRequest) -> Result<Option<Value>, StartError> {
    if !request.full_agent() {
        return Err(StartError::Unsupported(format!(
            "plxd runs only threads and coordinators on {label}: it has no worker sandbox"
        )));
    }
    match &request.account.credential {
        Credential::Subscription { config_home: None } => {}
        Credential::Subscription { .. } => {
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
    if request.resume.as_ref().is_some_and(|resume| resume.fork) {
        return Err(StartError::Unsupported(format!(
            "{label} can't fork a session"
        )));
    }
    if request.effort.is_some() || request.context_window.is_some() || request.fast.is_some() {
        return Err(StartError::Unsupported(format!(
            "{label}'s effort, context window, and speed are part of its model"
        )));
    }
    if !PERMISSIONS.contains(&request.permission.unwrap_or(AgentPermission::Edit)) {
        return Err(StartError::Unsupported(format!(
            "{label} has no mode for this permission"
        )));
    }
    if request.prompt.is_empty() && request.images.is_empty() {
        return Err(StartError::Invalid("the prompt is empty".into()));
    }
    let Some(model) = &request.model else {
        return Ok(None);
    };
    check_argument("model", model)?;
    let Some((provider, model)) = model.split_once('/') else {
        return Err(StartError::Invalid(format!(
            "{label}'s models are provider/model, such as opencode/big-pickle"
        )));
    };
    Ok(Some(json!({"providerID": provider, "modelID": model})))
}

/// The thread's `plxd mcp --thread` server as `POST /mcp` takes it, named for the run, for a
/// thread with `approvals` or Bypass (0041).
fn thread_mcp(request: &RunRequest) -> Result<Option<Value>, StartError> {
    let tools = request
        .full_agent_tools()
        .filter(|_| request.approvals || request.permission == Some(AgentPermission::Bypass));
    let Some(tools) = tools else {
        return Ok(None);
    };
    let config = tools.mcp_config()?;
    let server = &config["mcpServers"][crate::mcp::SERVER];
    let mut command = vec![server["command"].clone()];
    command.extend(server["args"].as_array().into_iter().flatten().cloned());
    let run = request.run_id.to_string();
    let name = format!("{}-{}", crate::mcp::SERVER, &run[run.len() - 8..]);
    Ok(Some(json!({
        "name": name,
        "config": {"type": "local", "command": command, "enabled": true},
    })))
}

impl Backend for OpencodeBackend {
    fn name(&self) -> &str {
        &self.opencode.name
    }

    fn capabilities(&self) -> Capabilities {
        Capabilities {
            follow_ups: true,
            resume: true,
            ..Capabilities::default()
        }
    }

    fn permissions(&self) -> &[AgentPermission] {
        PERMISSIONS
    }

    fn full_thread(&self) -> bool {
        true
    }

    fn start(&self, request: RunRequest) -> Result<Started, StartError> {
        let model = check(&self.opencode.label, &request)?;
        if let Some(url) = &self.opencode.url {
            check_url(url).map_err(StartError::Invalid)?;
        }
        let mcp = thread_mcp(&request)?;
        let switch = CancelSwitch::new();
        // A server of plxd's own starts here, so a missing program fails the start.
        let (serve, serve_password) = if self.opencode.url.is_some() {
            (None, None)
        } else {
            let password = self
                .opencode
                .password
                .as_ref()
                .map_or_else(random_password, |password| password.expose().to_owned());
            let spec = self
                .opencode
                .serve_spec(&self.launcher, &request.cwd, &password);
            let serve = self.launcher.spawn(&spec)?;
            switch.arm(serve.signals().clone(), CancelPolicy::default());
            (Some(serve), Some(password))
        };
        let (handle, control) = RunHandle::new(request.run_id, true, switch.clone());
        let (handle, answers) = handle.with_answers();
        let held = handle.held();
        let stop = Arc::new(Notify::new());
        let baseline = request
            .resume
            .as_ref()
            .map(|resume| resume.usage_totals.clone())
            .unwrap_or_default();
        let (sink, events) = EventSink::channel(EVENT_BUFFER, baseline);
        let permission = request.permission.unwrap_or(AgentPermission::Edit);
        let mut translator = Translator::default();
        translator.asks = request.approvals;
        translator.permission = Some(permission);
        let driver = Driver {
            launcher: self.launcher.clone(),
            opencode: Arc::clone(&self.opencode),
            serve,
            serve_password,
            server: None,
            events: None,
            folder: request.cwd.clone(),
            control,
            control_open: true,
            answers,
            held,
            sink,
            switch,
            stop: Arc::clone(&stop),
            translator,
            resume: request.resume.map(|resume| resume.session_id),
            rules: rules(permission),
            agent: (permission == AgentPermission::Plan).then_some("plan"),
            model_name: request.model.clone(),
            model,
            mcp,
            session: String::new(),
            prompts: VecDeque::from([Prompt::new(
                request.turn_id,
                &request.prompt,
                &request.images,
                false,
            )]),
            in_flight: None,
            asks: HashMap::new(),
            failure: None,
            results: 0,
            last_result: None,
        };
        tokio::spawn(driver.run());
        Ok(Started {
            run: Arc::new(OpencodeRun { handle, stop }),
            events,
        })
    }
}

/// The run's handle: [`RunHandle`], plus waking the driver on cancel.
struct OpencodeRun {
    handle: RunHandle,
    stop: Arc<Notify>,
}

impl Run for OpencodeRun {
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

    fn hold(&self, held: bool) {
        self.handle.hold(held);
    }
}

/// A message for `prompt_async`.
#[derive(Debug)]
struct Prompt {
    turn_id: Option<TurnId>,
    parts: Vec<Value>,
    /// A follow-up, which is reported dropped if the run ends before sending it.
    follow_up: bool,
}

impl Prompt {
    /// `text` as a text part, after `images` as `data:` file parts. Images alone have no text part.
    fn new(turn_id: Option<TurnId>, text: &str, images: &[PromptImage], follow_up: bool) -> Self {
        let images = images.iter().map(|image| {
            let mime = serde_json::to_value(image.media_type).unwrap_or_default();
            let mime = mime.as_str().unwrap_or("image/png");
            json!({"type": "file", "mime": mime, "url": format!("data:{mime};base64,{}", image.data)})
        });
        let text = (!text.trim().is_empty()).then(|| json!({"type": "text", "text": text}));
        Self {
            turn_id,
            parts: images.chain(text).collect(),
            follow_up,
        }
    }
}

/// A turn the session is working on, by its caller's id.
#[derive(Clone, Copy, Debug)]
struct InFlight(Option<TurnId>);

/// The next output of `process`, or never without one.
async fn next(process: &mut Option<Process>) -> Option<Output> {
    match process {
        Some(process) => process.next().await,
        None => std::future::pending().await,
    }
}

/// One run: opens the session, sends its messages, and maps the server's events.
struct Driver {
    launcher: Launcher,
    opencode: Arc<Opencode>,
    /// The server plxd started for the run, if the instance names none.
    serve: Option<Process>,
    serve_password: Option<String>,
    server: Option<Server>,
    /// The `/event` stream.
    events: Option<Process>,
    folder: PathBuf,
    control: mpsc::UnboundedReceiver<FollowUp>,
    control_open: bool,
    answers: mpsc::UnboundedReceiver<Answer>,
    /// While held, plxd has a message waiting for the run, so it doesn't end (PLX-370).
    held: Held,
    sink: EventSink,
    switch: CancelSwitch,
    stop: Arc<Notify>,
    translator: Translator,
    resume: Option<String>,
    rules: Value,
    agent: Option<&'static str>,
    model: Option<Value>,
    model_name: Option<String>,
    /// The thread's MCP server, for `POST /mcp`.
    mcp: Option<Value>,
    session: String,
    /// Messages waiting for the turn before them to end.
    prompts: VecDeque<Prompt>,
    /// The turn the session is working on.
    in_flight: Option<InFlight>,
    /// Requests the server waits on.
    asks: HashMap<ApprovalId, Ask>,
    failure: Option<Failure>,
    results: usize,
    last_result: Option<String>,
}

impl Driver {
    async fn run(mut self) {
        match self.setup().await {
            Ok(()) => self.turns().await,
            Err(message) => {
                if self.failure.is_none() {
                    self.failure = Some(failure(classify(&message), message));
                }
            }
        }
        if self.switch.is_cancelled() && self.in_flight.is_some() {
            self.abort().await;
        }
        if let Some(name) = self.mcp.as_ref().and_then(|mcp| mcp["name"].as_str()) {
            let path = self.path(&format!("/mcp/{name}/disconnect"));
            let _ = self.call("POST", &path, &Value::Null).await;
        }
        self.drop_undelivered().await;
        for approval_id in std::mem::take(&mut self.asks).into_keys() {
            self.emit(Event::ApprovalWithdrawn { approval_id }).await;
        }
        let outcome = self.outcome();
        let _ = self.sink.finish(outcome).await;
    }

    /// Finds the server, opens or checks the session, and opens the event stream.
    async fn setup(&mut self) -> Result<(), String> {
        let label = self.opencode.label.clone();
        let server = match (&self.opencode.url, &mut self.serve) {
            (Some(url), _) => self
                .opencode
                .server(url, self.opencode.password.as_ref().map(ApiKey::expose)),
            (None, Some(serve)) => {
                let url = tokio::time::timeout(START_TIMEOUT, listening(serve))
                    .await
                    .map_err(|_| format!("{label}'s server didn't start in time"))??;
                self.opencode.server(&url, self.serve_password.as_deref())
            }
            (None, None) => return Err(format!("{label} has no server")),
        };
        server.version(&self.launcher).await?;
        self.server = Some(server.clone());
        let rules = json!({"permission": self.rules});
        let session = if let Some(session) = self.resume.clone() {
            let path = self.path(&format!("/session/{session}"));
            self.call("GET", &path, &Value::Null).await?;
            self.call("PATCH", &path, &rules).await?;
            session
        } else {
            let created = self.call("POST", &self.path("/session"), &rules).await?;
            created["id"]
                .as_str()
                .ok_or_else(|| format!("{label} started no session"))?
                .to_owned()
        };
        // The stream opens before any prompt, so it has every event of the first turn.
        let mut events = server.events(&self.launcher, &self.folder)?;
        let connected = async {
            loop {
                match events.next().await {
                    Some(Output::Line(line)) if line.starts_with(b"data:") => return Ok(()),
                    Some(Output::Line(_) | Output::Oversized { .. }) => {}
                    Some(Output::Exited(exit)) => {
                        return Err(format!(
                            "couldn't read the OpenCode server's events: {}",
                            exit.stderr_tail
                        ));
                    }
                    None => return Err("couldn't read the OpenCode server's events".to_owned()),
                }
            }
        };
        tokio::time::timeout(START_TIMEOUT, connected)
            .await
            .map_err(|_| "the OpenCode server's events didn't start in time".to_owned())??;
        self.events = Some(events);
        self.session.clone_from(&session);
        self.translator.session.clone_from(&session);
        self.emit(Event::SessionStarted {
            session_id: session,
            model: self.model_name.clone(),
            api_key_source: None,
        })
        .await;
        if let Some(mcp) = self.mcp.clone()
            && let Err(error) = self.call("POST", &self.path("/mcp"), &mcp).await
        {
            let detail = format!("{label} couldn't add Parallax's tools: {error}");
            self.emit(Event::Notice { detail }).await;
        }
        Ok(())
    }

    /// Sends messages and reads events until no turn is left.
    async fn turns(&mut self) {
        let mut answers_open = true;
        loop {
            self.next_prompt().await;
            if self.failure.is_some() || self.switch.is_cancelled() {
                return;
            }
            if self.in_flight.is_none()
                && self.prompts.is_empty()
                && self.asks.is_empty()
                && self.control.is_empty()
                && !self.held.now()
            {
                return;
            }
            tokio::select! {
                output = next(&mut self.events) => match output {
                    Some(Output::Line(line)) => self.line(&line).await,
                    Some(Output::Oversized { bytes }) => {
                        self.emit(Event::Warning {
                            warning: WarningKind::OversizedLine,
                            detail: format!("skipped a {bytes}-byte event"),
                        })
                        .await;
                    }
                    Some(Output::Exited(exit)) => {
                        let message = format!(
                            "lost the OpenCode server's events: {}",
                            exit.stderr_tail
                        );
                        self.failure = Some(failure(FailureKind::Crashed, message));
                    }
                    None => {
                        let message = "lost the OpenCode server's events".to_owned();
                        self.failure = Some(failure(FailureKind::Crashed, message));
                    }
                },
                output = next(&mut self.serve) => match output {
                    Some(Output::Line(_) | Output::Oversized { .. }) => {}
                    Some(Output::Exited(exit)) => {
                        let message = format!("opencode serve exited: {}", exit.stderr_tail);
                        self.failure = Some(failure(FailureKind::Crashed, message));
                    }
                    None => {
                        let message = "opencode serve exited".to_owned();
                        self.failure = Some(failure(FailureKind::Crashed, message));
                    }
                },
                answer = self.answers.recv(), if answers_open => match answer {
                    Some(answer) => self.answer(answer).await,
                    None => answers_open = false,
                },
                follow_up = self.control.recv(), if self.control_open => match follow_up {
                    Some(follow_up) => self.follow_up(follow_up).await,
                    None => self.control_open = false,
                },
                () = self.stop.notified() => self.switch.cancel(),
                () = self.sink.closed(), if !self.switch.is_cancelled() => self.switch.cancel(),
                () = self.held.changed() => {}
            }
            if let Some(failure) = &self.failure
                && self.in_flight.is_some()
            {
                // The turn ends with the run.
                let message = failure.message.clone();
                self.finish_turn(Some(message)).await;
            }
        }
    }

    async fn line(&mut self, line: &[u8]) {
        let Some(data) = line.strip_prefix(b"data:") else {
            return;
        };
        let event = match serde_json::from_slice::<Value>(data) {
            Ok(event) => event,
            Err(error) => {
                self.emit(Event::Warning {
                    warning: WarningKind::MalformedLine,
                    detail: error.to_string(),
                })
                .await;
                return;
            }
        };
        for step in self.translator.event(&event) {
            match step {
                Step::Emit(event) => self.emit(event).await,
                Step::Ask(request, ask) => {
                    self.asks.insert(request.approval_id, ask);
                    self.emit(Event::ApprovalRequested(request)).await;
                }
                Step::Post { path, body } => self.post(&path, &body).await,
                Step::Replied { id, rejected } => {
                    let replied: Vec<ApprovalId> = self
                        .asks
                        .iter()
                        .filter(|(_, ask)| ask.id == id)
                        .map(|(approval_id, _)| *approval_id)
                        .collect();
                    for approval_id in replied {
                        if let Some(ask) = self.asks.remove(&approval_id)
                            && let Some(call_id) = ask.call_id
                            && rejected
                        {
                            self.translator.denied.insert(call_id);
                        }
                        self.emit(Event::ApprovalWithdrawn { approval_id }).await;
                    }
                }
                Step::Idle => self.finish_turn(None).await,
                Step::Failed(message) if self.in_flight.is_some() => {
                    self.failure = Some(failure(classify(&message), message.clone()));
                    self.finish_turn(Some(message)).await;
                }
                Step::Failed(detail) => self.emit(Event::Notice { detail }).await,
            }
        }
    }

    /// Ends the turn in flight, failed with `error` or else with its text as its result.
    async fn finish_turn(&mut self, error: Option<String>) {
        let Some(InFlight(turn_id)) = self.in_flight.take() else {
            return;
        };
        for event in self.translator.unfinished() {
            self.emit(event).await;
        }
        let text = self.translator.take_text();
        let result = if error.is_none() {
            self.results += 1;
            self.last_result.clone_from(&text);
            text
        } else {
            None
        };
        self.emit(Event::TurnFinished { turn_id, result }).await;
    }

    /// Sends the next message once no turn is in flight.
    async fn next_prompt(&mut self) {
        if self.in_flight.is_some() || self.failure.is_some() || self.switch.is_cancelled() {
            return;
        }
        let Some(prompt) = self.prompts.pop_front() else {
            return;
        };
        let mut body = json!({"parts": prompt.parts});
        if let Some(agent) = self.agent {
            body["agent"] = agent.into();
        }
        if let Some(model) = &self.model {
            body["model"] = model.clone();
        }
        self.translator.busy = false;
        self.in_flight = Some(InFlight(prompt.turn_id));
        self.emit(Event::TurnStarted {
            turn_id: prompt.turn_id,
        })
        .await;
        let path = self.path(&format!("/session/{}/prompt_async", self.session));
        if let Err(message) = self.call("POST", &path, &body).await {
            self.failure = Some(failure(classify(&message), message.clone()));
            self.finish_turn(Some(message)).await;
        }
    }

    /// Queues a follow-up. A steer goes next, and aborts the turn in flight first (PLX-370).
    async fn follow_up(&mut self, follow_up: FollowUp) {
        let prompt = Prompt::new(
            Some(follow_up.turn_id),
            &follow_up.text,
            &follow_up.images,
            true,
        );
        if follow_up.steer && self.in_flight.is_some() {
            self.prompts.push_front(prompt);
            self.abort().await;
        } else {
            self.prompts.push_back(prompt);
        }
    }

    /// Aborts the turn in flight, and withdraws every request it waits on. The idle that
    /// follows ends the turn. A server that is gone has nothing to abort.
    async fn abort(&mut self) {
        let path = self.path(&format!("/session/{}/abort", self.session));
        let _ = self.call("POST", &path, &Value::Null).await;
        for approval_id in std::mem::take(&mut self.asks).into_keys() {
            self.emit(Event::ApprovalWithdrawn { approval_id }).await;
        }
    }

    /// Replies to a request the server still waits on. A denial that interrupts also aborts
    /// the turn.
    async fn answer(&mut self, answer: Answer) {
        let Some(ask) = self.asks.remove(&answer.approval_id) else {
            return;
        };
        let (body, interrupt) = match answer.decision {
            Decision::Allow { .. } => (json!({"reply": "once"}), false),
            Decision::Deny { message, interrupt } => {
                if let Some(call_id) = ask.call_id {
                    self.translator.denied.insert(call_id);
                }
                // With a message, `OpenCode` tells the agent and goes on; without, it ends the
                // turn, which only an interrupt should. The siblings it then rejects carry none.
                let message = if message.trim().is_empty() && !interrupt {
                    "The user denied this.".to_owned()
                } else {
                    message
                };
                let mut body = json!({"reply": "reject"});
                if !message.trim().is_empty() {
                    body["message"] = message.into();
                }
                (body, interrupt)
            }
        };
        self.post(&ask.path, &body).await;
        if interrupt {
            self.abort().await;
        }
    }

    /// `path` for the run's folder.
    fn path(&self, path: &str) -> String {
        format!("{path}?directory={}", encode(&self.folder))
    }

    async fn call(&self, method: &str, path: &str, body: &Value) -> Result<Value, String> {
        let Some(server) = &self.server else {
            return Err("no server".to_owned());
        };
        server.call(&self.launcher, method, path, body).await
    }

    /// `POST path` for the folder, whose failure is only reported.
    async fn post(&mut self, path: &str, body: &Value) {
        let path = self.path(path);
        if let Err(detail) = self.call("POST", &path, body).await {
            self.emit(Event::Notice { detail }).await;
        }
    }

    async fn emit(&mut self, event: Event) {
        if self.sink.emit(event).await.is_err() {
            self.switch.cancel();
        }
    }

    /// Reports every follow-up that never started a turn as dropped, and takes no more.
    async fn drop_undelivered(&mut self) {
        self.control.close();
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
    }

    fn outcome(&mut self) -> Outcome {
        if self.switch.is_cancelled() {
            return Outcome::Cancelled;
        }
        if let Some(failure) = self.failure.take() {
            return Outcome::Failed(failure);
        }
        if self.results > 0 {
            return Outcome::Completed {
                result: self.last_result.take(),
            };
        }
        Outcome::Failed(failure(
            FailureKind::Internal,
            format!("{} ended without finishing a turn", self.opencode.label),
        ))
    }
}

/// What kind of failure `OpenCode`'s message describes: a provider without a login, or a usage
/// limit, which routing falls back on (0012).
fn classify(message: &str) -> FailureKind {
    let lower = message.to_ascii_lowercase();
    if ["api key", "not logged in", "unauthorized", "authenticat"]
        .iter()
        .any(|words| lower.contains(words))
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
