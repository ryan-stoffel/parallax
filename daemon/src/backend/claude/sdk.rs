//! The Claude Agent SDK sidecar (0061): one Node process per plxd data folder that holds every
//! Claude run's live `query()`, as T3 Code's server holds them in-process.
//!
//! plxd still builds the CLI's arguments and environment ([`super::arguments`]); a [`Query`]
//! hands them to the sidecar, which runs the user's `claude` through the SDK and passes its stdout
//! lines back unchanged, so [`super::stream`] reads them as before. What plxd wrote on the CLI's
//! stdin goes to the sidecar instead ([`Input::stdin`]): a user message joins the query's prompt,
//! and the answer to a `can_use_tool` request answers the SDK's `canUseTool`. The line protocol is
//! in `sidecar/claude/src/main.mjs`.
//!
//! The sidecar starts with the first query and exits once the last one is gone: its stdin closes
//! when the last [`Query`] or [`Input`] drops. If it dies, every query it held ends as a CLI that
//! exited would.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, LazyLock, Mutex, PoisonError, Weak};
use std::time::Duration;

use serde::ser::{SerializeMap, Serializer as _};
use tokio::io::AsyncWriteExt as _;
use tokio::sync::mpsc;
use zeroize::Zeroize as _;

use super::super::event::ExitInfo;
use super::super::node_sdk::NodeSdk;
use super::super::process::{
    Exit, Launcher, Output, OutputLimits, ProcessSpec, StdinMode, StdinPipe,
    check_working_directory, find_program,
};
use super::super::record::Recorder;
use super::super::{RunId, StartError};
use crate::detect;

/// What a host without a new enough Node is told.
pub const NODE_REQUIRED: &str = "Node.js 22.16 or newer is required";

/// The SDK the sidecar runs, installed on first use, without the SDK's bundled `claude` (its
/// optional packages) or its peers: the sidecar runs the user's own `claude` (0004), and the SDK's
/// one file needs nothing else.
pub(crate) static SDK: NodeSdk = NodeSdk {
    name: "Claude Agent SDK",
    dir: "claude-agent-sdk",
    repo: "claude",
    pin: "/dependencies/@anthropic-ai~1claude-agent-sdk",
    npm: &[
        "ci",
        "--omit=dev",
        "--omit=optional",
        "--omit=peer",
        "--no-audit",
        "--no-fund",
    ],
    node_required: NODE_REQUIRED,
};

/// A program to run as the sidecar instead, for tests.
pub const OVERRIDE_ENV: &str = "PLXD_CLAUDE_SDK";

/// The longest line the sidecar writes: a CLI line of plxd's usual limit, which the sidecar checks
/// itself, with its query id in front, for text that is up to 3 bytes a character.
const MAX_SIDECAR_LINE: usize = 3 * super::super::process::DEFAULT_MAX_LINE_BYTES + 64;

/// Why the sidecar can't run yet: no Node, or the SDK isn't installed, in which case this starts
/// installing it, but not again after a failure. `None` once it can.
fn unready(launcher: &Launcher) -> Option<String> {
    if launcher.base().get(OVERRIDE_ENV).is_some() {
        return None;
    }
    if !SDK.script_present() {
        return Some(SDK.no_sidecar());
    }
    if detect::resolve(launcher, "node").is_none() {
        return Some(NODE_REQUIRED.into());
    }
    if SDK.installed(launcher).is_some() {
        return None;
    }
    let _ = SDK.start_install(launcher, false);
    let (installing, failure) = SDK.install_state(launcher);
    Some(if installing {
        SDK.installing_note()
    } else {
        failure.unwrap_or_else(|| SDK.installing_note())
    })
}

/// What Settings says about the sidecar, when it can't run Claude yet: [`unready`], or a Node
/// older than 22.16. Starts installing the SDK as [`unready`] does.
pub(crate) async fn status(launcher: &Launcher) -> Option<String> {
    if let Some(why) = unready(launcher) {
        return Some(why);
    }
    if launcher.base().get(OVERRIDE_ENV).is_some() {
        return None;
    }
    let ran = detect::run(launcher, "node", &["--version"], Duration::from_secs(10))
        .await
        .ok()?;
    let version = super::parse_version(ran.stdout.trim().trim_start_matches('v'))?;
    (version < (22, 16, 0))
        .then(|| format!("{NODE_REQUIRED} (this host has {})", ran.stdout.trim()))
}

/// A running sidecar: where its lines go, and which query each line it writes is for.
#[derive(Debug)]
struct Host {
    input: mpsc::UnboundedSender<String>,
    routes: Arc<Routes>,
}

/// Each live query's output, by id. `None` once the sidecar has exited.
type Routes = Mutex<Option<HashMap<String, mpsc::UnboundedSender<Output>>>>;

/// The sidecars, one per data folder, while a query holds one.
static HOSTS: LazyLock<Mutex<HashMap<PathBuf, Weak<Host>>>> = LazyLock::new(Mutex::default);

impl Host {
    /// The data folder's sidecar, started if none is running.
    fn get(launcher: &Launcher) -> Result<Arc<Self>, StartError> {
        let key = launcher.data_dir().root().to_owned();
        let mut hosts = HOSTS.lock().unwrap_or_else(PoisonError::into_inner);
        if let Some(host) = hosts.get(&key).and_then(Weak::upgrade)
            && host.alive()
        {
            return Ok(host);
        }
        let host = Arc::new(Self::start(launcher)?);
        hosts.insert(key, Arc::downgrade(&host));
        Ok(host)
    }

    fn alive(&self) -> bool {
        !self.input.is_closed() && self.routes().is_some()
    }

    fn routes(
        &self,
    ) -> std::sync::MutexGuard<'_, Option<HashMap<String, mpsc::UnboundedSender<Output>>>> {
        self.routes.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// Starts the sidecar in the background, once the SDK is installed: a query sent while it
    /// installs waits for it, rather than failing, and fails with the install if that does.
    fn start(launcher: &Launcher) -> Result<Self, StartError> {
        if launcher.base().get(OVERRIDE_ENV).is_none() {
            if !SDK.script_present() {
                return Err(StartError::Unsupported(SDK.no_sidecar()));
            }
            if detect::resolve(launcher, "node").is_none() {
                return Err(StartError::Unsupported(format!(
                    "{NODE_REQUIRED} to run Claude"
                )));
            }
            if SDK.installed(launcher).is_none() {
                SDK.start_install(launcher, true)
                    .map_err(StartError::Unsupported)?;
            }
        }
        let (input, lines) = mpsc::unbounded_channel();
        let routes = Arc::new(Mutex::new(Some(HashMap::new())));
        tokio::spawn(serve(launcher.clone(), lines, Arc::clone(&routes)));
        Ok(Self { input, routes })
    }
}

/// Runs the sidecar: waits for the SDK's install, starts it, and routes its lines until it exits.
async fn serve(launcher: Launcher, lines: mpsc::UnboundedReceiver<String>, routes: Arc<Routes>) {
    let mut process = match sidecar_spec(&launcher).await {
        Ok(spec) => match launcher.spawn(&spec) {
            Ok(process) => process,
            Err(error) => return end_all(&routes, None, &error.to_string()),
        },
        Err(why) => return end_all(&routes, None, &why),
    };
    let Some(stdin) = process.take_stdin() else {
        return end_all(&routes, None, "the Claude Agent SDK sidecar has no stdin");
    };
    tokio::spawn(write(stdin, lines));
    read(process, routes).await;
}

/// How to start the sidecar, once the SDK is installed: `node` and the installed `main.mjs`, or
/// [`OVERRIDE_ENV`]'s program.
async fn sidecar_spec(launcher: &Launcher) -> Result<ProcessSpec, String> {
    let cwd = launcher.data_dir().root().to_owned();
    std::fs::create_dir_all(&cwd).map_err(|error| error.to_string())?;
    let mut spec = if let Some(program) = launcher.base().get(OVERRIDE_ENV) {
        ProcessSpec::new(program, &cwd)
    } else {
        let installed = loop {
            if let Some(installed) = SDK.installed(launcher) {
                break installed;
            }
            match SDK.install_state(launcher) {
                (true, _) => {}
                (false, Some(failure)) => return Err(failure),
                (false, None) => SDK.start_install(launcher, true)?,
            }
            tokio::time::sleep(Duration::from_millis(200)).await;
        };
        let script = SDK.main_script(&installed).map_err(|error| {
            format!(
                "couldn't update the Claude Agent SDK sidecar in {}: {error}",
                installed.display()
            )
        })?;
        let mut spec = ProcessSpec::new("node", &cwd);
        spec.args = vec![script.into()];
        spec
    };
    // The sidecar needs no credentials: each query brings the CLI's environment.
    spec.scrub = super::scrubbed(launcher.base());
    spec.inject.set("DISABLE_TELEMETRY", "1");
    spec.stdin = StdinMode::Piped;
    spec.limits = OutputLimits {
        max_line_bytes: MAX_SIDECAR_LINE,
        ..OutputLimits::default()
    };
    Ok(spec)
}

/// Ends every query the sidecar held, as CLIs that exited with `info`, saying `why`.
fn end_all(routes: &Routes, info: Option<ExitInfo>, why: &str) {
    let Some(routes) = routes.lock().unwrap_or_else(PoisonError::into_inner).take() else {
        return;
    };
    for route in routes.into_values() {
        let _ = route.send(Output::Exited(Exit {
            info: info.unwrap_or(ExitInfo {
                code: None,
                signal: None,
            }),
            stderr_tail: why.to_owned(),
        }));
    }
}

/// Writes lines to the sidecar in order, zeroizing each, since a query's environment can hold an
/// API key (0004).
async fn write(mut stdin: StdinPipe, mut lines: mpsc::UnboundedReceiver<String>) {
    while let Some(mut line) = lines.recv().await {
        let written = stdin.write_all(line.as_bytes()).await;
        line.zeroize();
        if written.is_err() {
            break;
        }
    }
}

/// Routes the sidecar's lines to their queries, and ends every query when the sidecar exits.
async fn read(mut process: super::super::process::Process, routes: Arc<Routes>) {
    let deliver = |id: &str, output: Output| {
        let mut routes = routes.lock().unwrap_or_else(PoisonError::into_inner);
        let Some(routes) = routes.as_mut() else {
            return;
        };
        let last = matches!(output, Output::Exited(_));
        if let Some(route) = routes.get(id) {
            let _ = route.send(output);
        }
        if last {
            routes.remove(id);
        }
    };
    let exit = loop {
        match process.next().await {
            Some(Output::Line(line)) => {
                let Some(space) = line.iter().position(|&byte| byte == b' ') else {
                    continue;
                };
                let Ok(id) = std::str::from_utf8(&line[..space]) else {
                    continue;
                };
                let rest = &line[space + 1..];
                let output = if let Some(status) = rest.strip_prefix(b"exit ") {
                    Output::Exited(exit_of(status))
                } else if let Some(bytes) = rest.strip_prefix(b"oversized ") {
                    let bytes = std::str::from_utf8(bytes)
                        .ok()
                        .and_then(|bytes| bytes.parse().ok())
                        .unwrap_or(MAX_SIDECAR_LINE);
                    Output::Oversized { bytes }
                } else {
                    Output::Line(rest.to_vec())
                };
                deliver(id, output);
            }
            Some(Output::Oversized { bytes }) => {
                tracing::warn!(bytes, "skipped an oversized line from the Claude sidecar");
            }
            Some(Output::Exited(exit)) => break Some(exit),
            None => break None,
        }
    };
    let tail = exit.as_ref().map_or("", |exit| exit.stderr_tail.as_str());
    let why = format!("the Claude Agent SDK sidecar exited: {tail}");
    end_all(
        &routes,
        exit.as_ref().map(|exit| exit.info),
        why.trim_end_matches([':', ' ']),
    );
}

/// A query's `exit {"code", "signal", "stderr"}`.
fn exit_of(status: &[u8]) -> Exit {
    #[derive(serde::Deserialize, Default)]
    #[serde(default)]
    struct Status {
        code: Option<i32>,
        signal: Option<i32>,
        stderr: String,
    }
    let status: Status = serde_json::from_slice(status).unwrap_or_default();
    Exit {
        info: ExitInfo {
            code: status.code,
            signal: status.signal,
        },
        stderr_tail: status.stderr,
    }
}

/// What a query sends the sidecar. Clones send for the same query.
#[derive(Clone, Debug)]
pub(super) struct Input {
    id: Arc<str>,
    host: Arc<Host>,
    recorder: Option<Recorder>,
}

impl Input {
    /// A line plxd would have written on the CLI's stdin, without its newline: a user message or
    /// a `control_response`. Returns whether the sidecar is still there to take it.
    pub fn stdin(&self, line: &str) -> bool {
        if let Some(recorder) = &self.recorder {
            recorder.stdin();
        }
        self.send(format!(
            "{{\"id\":{},\"stdin\":{}}}\n",
            serde_json::Value::from(&*self.id),
            line.trim_end()
        ))
    }

    /// Ends the CLI's turn: the SDK's `interrupt()`.
    pub fn interrupt(&self) {
        self.control("interrupt");
    }

    /// Ends the query's prompt, so the CLI exits after its last turn, as closing its stdin did.
    pub fn end(&self) {
        self.control("end");
    }

    /// Kills the CLI's process group.
    pub fn kill(&self) {
        self.control("kill");
    }

    fn control(&self, kind: &str) {
        let id = serde_json::Value::from(&*self.id);
        self.send(format!("{{\"id\":{id},\"type\":\"{kind}\"}}\n"));
    }

    fn send(&self, line: String) -> bool {
        self.host.input.send(line).is_ok()
    }
}

/// One run's query in the sidecar: what plxd sends it, and the CLI's lines, as a [`Process`]'s
/// output, ending with [`Output::Exited`].
///
/// [`Process`]: super::super::process::Process
#[derive(Debug)]
pub(super) struct Query {
    input: Input,
    output: mpsc::UnboundedReceiver<Output>,
    exited: bool,
}

impl Query {
    /// Starts the query `id` running `spec`'s program, arguments, working directory, and
    /// environment, as [`Launcher::spawn`] would start the CLI.
    pub fn open(launcher: &Launcher, spec: &ProcessSpec, id: RunId) -> Result<Self, StartError> {
        let env = launcher.environment(spec);
        check_working_directory(&spec.cwd)?;
        let program = find_program(&spec.program, env.get("PATH"))?;
        let id: Arc<str> = id.to_string().into();
        let mut frame = Vec::new();
        {
            let mut serializer = serde_json::Serializer::new(&mut frame);
            let mut map = serializer.serialize_map(None).map_err(invalid)?;
            map.serialize_entry("id", &*id).map_err(invalid)?;
            map.serialize_entry("type", "open").map_err(invalid)?;
            map.serialize_entry("executable", &program.to_string_lossy())
                .map_err(invalid)?;
            let args: Vec<_> = spec.args.iter().map(|arg| arg.to_string_lossy()).collect();
            map.serialize_entry("args", &args).map_err(invalid)?;
            map.serialize_entry("cwd", &spec.cwd.to_string_lossy())
                .map_err(invalid)?;
            let vars: HashMap<_, _> = env
                .names()
                .filter_map(|name| Some((name.to_string_lossy(), env.get(name)?.to_string_lossy())))
                .collect();
            map.serialize_entry("env", &vars).map_err(invalid)?;
            map.end().map_err(invalid)?;
        }
        frame.push(b'\n');
        let mut frame = String::from_utf8(frame).map_err(|error| invalid(error.utf8_error()))?;
        let recorder = Recorder::open("claude").map_err(super::super::process::SpawnError::Io)?;
        let (route, output) = mpsc::unbounded_channel();
        // A sidecar that died since the last query is replaced once.
        for _ in 0..2 {
            let host = Host::get(launcher)?;
            let registered = host
                .routes()
                .as_mut()
                .is_some_and(|routes| routes.insert(id.to_string(), route.clone()).is_none());
            if registered {
                match host.input.send(frame) {
                    Ok(()) => {
                        return Ok(Self {
                            input: Input { id, host, recorder },
                            output,
                            exited: false,
                        });
                    }
                    Err(mpsc::error::SendError(back)) => frame = back,
                }
            }
            if let Some(routes) = host.routes().as_mut() {
                routes.remove(&*id);
            }
        }
        frame.zeroize();
        Err(StartError::Invalid(
            "the Claude Agent SDK sidecar stopped taking queries".into(),
        ))
    }

    /// What the run sends its query.
    pub fn input(&self) -> Input {
        self.input.clone()
    }

    /// The next piece of the CLI's output. [`Output::Exited`] always comes last, then `None`.
    pub async fn next(&mut self) -> Option<Output> {
        if self.exited {
            return None;
        }
        let output = self.output.recv().await?;
        match &output {
            Output::Line(line) => {
                if let Some(recorder) = &self.input.recorder {
                    recorder.stdout(line);
                }
            }
            Output::Exited(_) => self.exited = true,
            Output::Oversized { .. } => {}
        }
        Some(output)
    }
}

impl Drop for Query {
    /// Kills a CLI still running, as dropping its [`Process`] did.
    ///
    /// [`Process`]: super::super::process::Process
    fn drop(&mut self) {
        if !self.exited {
            self.input.kill();
        }
        if let Some(routes) = self.input.host.routes().as_mut() {
            routes.remove(&*self.input.id);
        }
    }
}

fn invalid(error: impl std::fmt::Display) -> StartError {
    StartError::Invalid(format!("couldn't write the Claude query: {error}"))
}
