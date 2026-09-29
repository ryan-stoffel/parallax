//! The Codex backend: runs the user's own signed-in `codex` CLI headless for workers (0004,
//! RYA-38).
//!
//! # The command
//!
//! A new session is `codex exec --json --ignore-user-config --ignore-rules <overrides> -` and a
//! resumed one is `codex exec resume --json --ignore-user-config --ignore-rules <overrides>
//! <thread id> -`, both in the run's cwd, with `-m` for the model and `-c
//! model_reasoning_effort` for the effort. The prompt goes on stdin,
//! which then closes: `codex exec` runs one turn and exits, so the backend takes no follow-ups,
//! and 0014's `agent/send` resumes the thread instead.
//!
//! Only workers run on Codex so far: the coordinator's no-write mode is RYA-39. A worker is held
//! to 0013 by Codex's own sandbox (Seatbelt on macOS), configured entirely by
//! [`worker_overrides`]:
//!
//! - `--ignore-user-config` and `--ignore-rules` load none of the user's `config.toml` or
//!   execpolicy rules, and the worktree is marked `untrusted`, so no project `.codex/` config,
//!   hooks, or rules load either. Auth still comes from `CODEX_HOME`.
//! - A `wisp_worker` permission profile extends `:workspace`, which writes the workspace roots
//!   and the temp folders and keeps `.git` read-only. The context folder is a second root, the
//!   sandbox's unreadable paths are `deny`, and its read-only git paths are `read`, which reopens
//!   them inside a denied folder. Network is on through Codex's proxy with every host allowed; its
//!   local-network guard refuses loopback, private, and this Mac's own addresses.
//! - Hooks, apps (MCP connectors), plugins, and subagents are off, and so are shell snapshots,
//!   which would hand commands the variables `shell_environment_policy` keeps out, such as
//!   `CODEX_API_KEY`.
//!
//! # A worker's `PATH`
//!
//! Codex runs each command with the user's shell, and zsh reads `/etc/zshenv` and `~/.zshenv`
//! for every command, so startup files that set `PATH` outright replace the `PATH` wispd gave the
//! CLI. The shell snapshot that would put it back is off (above). So a worker's commands get
//! `ZDOTDIR`, which zsh reads right after `/etc/zshenv`: [`write_zdotdir`] writes a folder into the
//! data folder's `tmp/` whose `.zshenv` runs the user's own `~/.zshenv` and then puts the CLI's
//! `PATH` back in front (RYA-141). The profile makes the folder readable, since the sandboxed zsh
//! reads it, but not writable. `allow_login_shell=false` keeps `.zprofile` and `.zlogin`, which
//! would run after it, from running. The run's driver deletes the folder once Codex has exited.
//!
//! As a second check, a worker whose output shows an MCP or subagent call is stopped with
//! [`FailureKind::PolicyViolation`]. Codex older than [`WORKER_MIN_VERSION`] would ignore the
//! profile, so the runner refuses it before starting a worker. Only macOS runs Codex workers;
//! elsewhere the backend reports no `worker_sandbox` (0013).
//!
//! # Credentials
//!
//! Every run drops inherited variables starting with [`SCRUBBED_PREFIXES`], which could pick
//! Codex's credentials, endpoint, or configuration folder. A subscription then gets only its
//! account's `CODEX_HOME`, if it has one, and an API key account only [`API_KEY_ENV`], which
//! `codex exec` reads ahead of the login in `auth.json`. The key is never in `args`.
//!
//! # Events and failures
//!
//! `turn.completed.usage` is the thread's running total, so it becomes usage deltas. Exec reports
//! no limit windows. A failed turn says why only in its message, so `stream::classify` reads it
//! for `notSignedIn` and `rateLimited`, which routing falls back on (0012).
//!
//! # Cancel
//!
//! `SIGINT` interrupts Codex's turn, and exec then exits 1; the process group is killed if it is
//! still running after the grace period.

mod stream;
#[cfg(all(test, target_os = "macos"))]
mod tests;

use std::collections::BTreeMap;
use std::ffi::{OsStr, OsString};
use std::fmt::Write as _;
use std::io::{self, Write as _};
use std::path::{Path, PathBuf};
use std::sync::Arc;

use tempfile::TempDir;
use tokio::io::AsyncWriteExt;

use self::stream::{Step, Translator};
use super::event::{Event, Failure, FailureKind, Outcome, WarningKind};
use super::process::{
    CancelPolicy, Environment, Exit, Launcher, Output, Process, ProcessSpec, Signal, SpawnError,
    StdinMode,
};
use super::sandbox::worker_sandbox;
use super::{
    AgentEffort, AgentPermission, Backend, CancelSwitch, Capabilities, Credential, EVENT_BUFFER,
    EventSink, RunHandle, RunRequest, StartError, Started, ToolPolicy, TurnId, WorkerSandbox,
    check_argument, prepend_path_line,
};

/// The CLI's program name, looked up on the launcher's `PATH`.
pub const PROGRAM: &str = "codex";

/// The flags every run starts with, after `exec` or `exec resume`.
pub const BASE_ARGS: &[&str] = &["--json", "--ignore-user-config", "--ignore-rules"];

/// The oldest Codex a worker's sandbox was checked on (0013). An older one might not know the
/// permission profile, which it would ignore instead of refusing.
pub const WORKER_MIN_VERSION: &str = "0.157.1";

/// The features a worker runs with: the network proxy on, so domain rules and the local-network
/// guard apply, and everything that would add hooks, MCP servers, subagents, or a shell
/// snapshot off.
pub const WORKER_FEATURES: &str = "features={network_proxy=true, hooks=false, apps=false, \
    plugins=false, remote_plugin=false, multi_agent=false, skill_mcp_dependency_install=false, \
    shell_snapshot=false}";

/// The reasoning efforts a worker may ask for: `-c model_reasoning_effort` takes every level
/// (checked with the default model on codex-cli 0.157.1).
const EFFORTS: &[AgentEffort] = &[
    AgentEffort::Low,
    AgentEffort::Medium,
    AgentEffort::High,
    AgentEffort::Xhigh,
    AgentEffort::Max,
];

/// The worker permissions Codex maps: only `edit`. `codex exec` has no plan mode.
const PERMISSIONS: &[AgentPermission] = &[AgentPermission::Edit];

/// Prefixes of inherited variables no run gets: `OpenAI`'s and Codex's credentials, endpoints,
/// and configuration (`OPENAI_API_KEY`, `OPENAI_BASE_URL`, `CODEX_API_KEY`, `CODEX_HOME`, ...).
pub const SCRUBBED_PREFIXES: &[&str] = &["OPENAI_", "CODEX_"];

/// The variable an API key account's key is injected as (0004's table).
pub const API_KEY_ENV: &str = "CODEX_API_KEY";

/// The variable that picks a second account's configuration folder.
pub const CONFIG_DIR_ENV: &str = "CODEX_HOME";

/// A [`Backend`] that runs Codex.
#[derive(Clone, Debug)]
pub struct CodexBackend {
    launcher: Launcher,
}

impl CodexBackend {
    /// A backend that starts `codex` through `launcher`.
    #[must_use]
    pub fn new(launcher: Launcher) -> Self {
        Self { launcher }
    }
}

/// The CLI's arguments for `request`, whose commands get `zdotdir` as `ZDOTDIR` (see
/// [`worker_overrides`]).
///
/// # Errors
///
/// [`StartError::Invalid`] if the model or the resume id could be read as an option, or if the
/// worker has no usable [`WorkerSandbox`]. [`StartError::Unsupported`] for a no-write run, a
/// permission other than `edit`, or an effort this version doesn't know.
pub fn arguments(
    request: &RunRequest,
    zdotdir: Option<&Path>,
) -> Result<Vec<OsString>, StartError> {
    let Some(sandbox) = worker_sandbox(request)? else {
        return Err(StartError::Unsupported(
            "wispd runs only workers on Codex so far; its coordinator is RYA-39".into(),
        ));
    };
    let mut args: Vec<OsString> = vec!["exec".into()];
    if request.resume.is_some() {
        args.push("resume".into());
    }
    args.extend(BASE_ARGS.iter().map(Into::into));
    let config_home = match &request.account.credential {
        Credential::Subscription { config_home } => config_home.as_deref(),
        Credential::ApiKey(_) => None,
    };
    for value in worker_overrides(sandbox, &request.cwd, config_home, zdotdir) {
        args.extend(["-c".into(), value.into()]);
    }
    if !matches!(request.permission, None | Some(AgentPermission::Edit)) {
        return Err(StartError::Unsupported(
            "codex exec has no plan mode; a Codex worker only edits (RYA-97)".into(),
        ));
    }
    if let Some(effort) = request.effort {
        let level = match effort {
            AgentEffort::Low => "low",
            AgentEffort::Medium => "medium",
            AgentEffort::High => "high",
            AgentEffort::Xhigh => "xhigh",
            AgentEffort::Max => "max",
            AgentEffort::Unknown => {
                return Err(StartError::Unsupported(
                    "Codex has no such reasoning effort".into(),
                ));
            }
        };
        args.extend([
            "-c".into(),
            format!(r#"model_reasoning_effort="{level}""#).into(),
        ]);
    }
    if let Some(model) = &request.model {
        check_argument("model", model)?;
        args.extend(["-m".into(), model.into()]);
    }
    if let Some(resume) = &request.resume {
        check_argument("resume id", &resume.session_id)?;
        args.push(resume.session_id.clone().into());
    }
    args.push("-".into());
    Ok(args)
}

/// The `-c` overrides that hold a worker in `cwd` to 0013 (see the module docs). Each sets one
/// top-level key to an inline table, so no path is ever part of a dotted key. A path both
/// unreadable and read-only is denied. A second account's `config_home` is unreadable too.
/// `zdotdir`, the worker's [`write_zdotdir`] folder, is readable and is its commands' `ZDOTDIR`.
#[must_use]
pub fn worker_overrides(
    sandbox: &WorkerSandbox,
    cwd: &Path,
    config_home: Option<&Path>,
    zdotdir: Option<&Path>,
) -> Vec<String> {
    let mut access: BTreeMap<&Path, &str> = sandbox
        .read_only
        .iter()
        .map(|path| (path.as_path(), "read"))
        .collect();
    for path in sandbox
        .unreadable
        .iter()
        .map(PathBuf::as_path)
        .chain(config_home)
    {
        access.insert(path, "deny");
    }
    if let Some(zdotdir) = zdotdir {
        access.insert(zdotdir, "read");
    }
    let filesystem = inline(
        access
            .iter()
            .map(|(path, rule)| format!("{}=\"{rule}\"", toml(path))),
    );
    let roots = inline(
        sandbox
            .writable
            .iter()
            .map(|path| format!("{}=true", toml(path))),
    );
    vec![
        r#"default_permissions="wisp_worker""#.to_owned(),
        format!(
            r#"permissions={{wisp_worker={{extends=":workspace", workspace_roots={roots}, filesystem={filesystem}, network={{enabled=true, domains={{"*"="allow"}}}}}}}}"#
        ),
        WORKER_FEATURES.to_owned(),
        format!(r#"projects={{{}={{trust_level="untrusted"}}}}"#, toml(cwd)),
        r#"approval_policy="never""#.to_owned(),
        r#"web_search="live""#.to_owned(),
        "allow_login_shell=false".to_owned(),
        format!(
            "shell_environment_policy={{ignore_default_excludes=false{}}}",
            zdotdir
                .map(|zdotdir| format!(", set={{ZDOTDIR={}}}", toml(zdotdir)))
                .unwrap_or_default()
        ),
    ]
}

/// The start of a worker's `.zshenv`. zsh reads it in place of the user's `~/.zshenv`, so it runs
/// that file itself, after unsetting `ZDOTDIR` so neither that file nor the command sees wispd's
/// folder.
const ZSHENV_START: &[u8] = b"unset ZDOTDIR\n[ -f \"$HOME/.zshenv\" ] && . \"$HOME/.zshenv\"\n";

/// Writes a worker's `ZDOTDIR` into `dir` (wispd's data folder's `tmp/`) and returns it, which
/// deletes it when dropped (RYA-141). Its `.zshenv` runs the user's `~/.zshenv` and then puts
/// `path`, the `PATH` the CLI started with, in front of whatever `PATH` the startup files left.
/// The folder is new, has a random name and a canonical path, as the sandbox needs, and only its
/// owner may open it (0700, and 0600 for the file).
///
/// # Errors
///
/// If `dir` can't be created or the folder can't be written.
pub fn write_zdotdir(dir: &Path, path: &OsStr) -> io::Result<TempDir> {
    std::fs::create_dir_all(dir)?;
    let mut builder = tempfile::Builder::new();
    builder.prefix("codex-zdotdir-");
    #[cfg(unix)]
    builder.permissions(std::os::unix::fs::PermissionsExt::from_mode(0o700));
    let zdotdir = builder.tempdir_in(dir.canonicalize()?)?;
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    std::os::unix::fs::OpenOptionsExt::mode(&mut options, 0o600);
    let mut file = options.open(zdotdir.path().join(".zshenv"))?;
    file.write_all(ZSHENV_START)?;
    file.write_all(&prepend_path_line(path))?;
    Ok(zdotdir)
}

/// `{a, b, ...}`, an inline table of `entries`.
fn inline(entries: impl Iterator<Item = String>) -> String {
    format!("{{{}}}", entries.collect::<Vec<_>>().join(", "))
}

/// `path` as a TOML basic string. [`worker_sandbox`] has already refused any that isn't UTF-8.
fn toml(path: &Path) -> String {
    let mut out = String::from("\"");
    for c in path.to_string_lossy().chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            c if c.is_control() => {
                write!(out, "\\u{:04X}", u32::from(c)).expect("writing to a String never fails");
            }
            c => out.push(c),
        }
    }
    out.push('"');
    out
}

/// The variables of `base` that no run gets: [`SCRUBBED_PREFIXES`].
#[must_use]
pub fn scrubbed(base: &Environment) -> Vec<OsString> {
    base.names()
        .filter(|name| {
            SCRUBBED_PREFIXES
                .iter()
                .any(|prefix| name.as_encoded_bytes().starts_with(prefix.as_bytes()))
        })
        .map(OsStr::to_owned)
        .collect()
}

impl Backend for CodexBackend {
    fn name(&self) -> &'static str {
        PROGRAM
    }

    fn capabilities(&self) -> Capabilities {
        Capabilities {
            follow_ups: false,
            resume: true,
            coordinator: false,
            reports_cost: false,
            rate_limits: false,
            worker_sandbox: cfg!(target_os = "macos"),
        }
    }

    fn efforts(&self) -> &'static [AgentEffort] {
        EFFORTS
    }

    fn permissions(&self) -> &'static [AgentPermission] {
        PERMISSIONS
    }

    fn start(&self, request: RunRequest) -> Result<Started, StartError> {
        if request.prompt.is_empty() {
            return Err(StartError::Invalid("the prompt is empty".into()));
        }
        if request.policy == ToolPolicy::WorkspaceWrite && !self.capabilities().worker_sandbox {
            return Err(StartError::Unsupported(
                "wispd hasn't checked Codex's worker sandbox on this OS yet (decision 0013)".into(),
            ));
        }
        let zdotdir = match self.launcher.base().get("PATH") {
            Some(path) => Some(
                write_zdotdir(&self.launcher.data_dir().temp_dir(), path)
                    .map_err(SpawnError::Io)?,
            ),
            None => None,
        };
        let mut spec = ProcessSpec::new(PROGRAM, &request.cwd);
        spec.args = arguments(&request, zdotdir.as_ref().map(TempDir::path))?;
        spec.scrub = scrubbed(self.launcher.base());
        match &request.account.credential {
            Credential::Subscription { config_home } => {
                if let Some(home) = config_home {
                    spec.inject.set(CONFIG_DIR_ENV, home);
                }
            }
            Credential::ApiKey(key) => {
                spec.inject.set(API_KEY_ENV, key.expose());
            }
        }
        spec.stdin = StdinMode::Piped;

        let mut process = self.launcher.spawn(&spec)?;
        if let Some(mut stdin) = process.take_stdin() {
            let prompt = request.prompt.clone();
            // Dropping the pipe once the prompt is written closes stdin, which exec waits for.
            tokio::spawn(async move {
                let _ = stdin.write_all(prompt.as_bytes()).await;
            });
        }
        let switch = CancelSwitch::new();
        switch.arm(process.signals().clone(), CancelPolicy::default());
        let (handle, _) = RunHandle::new(request.run_id, false, switch.clone());
        let baseline = request
            .resume
            .map(|resume| resume.usage_totals)
            .unwrap_or_default();
        let (sink, events) = EventSink::channel(EVENT_BUFFER, baseline);
        let turn_id = request.turn_id;
        let prefix = turn_id.unwrap_or_else(TurnId::generate).to_string();
        tokio::spawn(drive(
            process,
            sink,
            switch,
            turn_id,
            Translator::new(prefix),
            zdotdir,
        ));
        Ok(Started {
            run: Arc::new(handle),
            events,
        })
    }
}

/// Runs one process: forwards its events and decides the outcome when it exits. Cancelling
/// doesn't go through here: the run's handle signals the process through `switch`. `zdotdir`,
/// the worker's [`write_zdotdir`] folder, is deleted once the process has exited.
async fn drive(
    mut process: Process,
    mut sink: EventSink,
    switch: CancelSwitch,
    turn_id: Option<TurnId>,
    mut translator: Translator,
    zdotdir: Option<TempDir>,
) {
    let mut violation = None;
    if sink.emit(Event::TurnStarted { turn_id }).await.is_err() {
        switch.cancel();
    }
    let exit = loop {
        tokio::select! {
            output = process.next() => match output {
                Some(Output::Line(line)) if violation.is_none() => {
                    for step in translator.line(&line) {
                        let sent = match step {
                            Step::Emit(event) => sink.emit(event).await,
                            Step::Total(total) => sink.observe_total(None, total).await,
                            Step::TurnDone(result) => {
                                sink.emit(Event::TurnFinished { turn_id, result }).await
                            }
                            Step::Violation(failure) => {
                                // Kill at once: the worker is already outside its policy.
                                let _ = process.signals().signal_group(Signal::KILL);
                                violation = Some(failure);
                                break;
                            }
                        };
                        if sent.is_err() {
                            switch.cancel();
                        }
                    }
                }
                Some(Output::Line(_)) => {}
                Some(Output::Oversized { bytes }) => {
                    let warning = Event::Warning {
                        warning: WarningKind::OversizedLine,
                        detail: format!("skipped a {bytes}-byte line"),
                    };
                    if sink.emit(warning).await.is_err() {
                        switch.cancel();
                    }
                }
                Some(Output::Exited(exit)) => break Some(exit),
                None => break None,
            },
            () = sink.closed(), if !switch.is_cancelled() => switch.cancel(),
        }
    };
    drop(zdotdir);
    let outcome = outcome(violation, &switch, &mut translator, exit);
    let _ = sink.finish(outcome).await;
}

/// How the run ended, once its process exited.
fn outcome(
    violation: Option<Failure>,
    switch: &CancelSwitch,
    translator: &mut Translator,
    exit: Option<Exit>,
) -> Outcome {
    if let Some(violation) = violation {
        return failed(violation, exit.as_ref());
    }
    if switch.is_cancelled() {
        return Outcome::Cancelled;
    }
    if let Some(failure) = translator.failure.take() {
        return failed(failure, exit.as_ref());
    }
    let Some(exit) = exit else {
        return failed(
            failure(FailureKind::Internal, "lost track of the process".into()),
            None,
        );
    };
    if exit.info.success() && translator.completed {
        return Outcome::Completed {
            result: translator.last_result.take(),
        };
    }
    let failure = if stream::classify(&exit.stderr_tail) == FailureKind::NotSignedIn {
        failure(FailureKind::NotSignedIn, "Codex is not signed in".into())
    } else if exit.info.success() {
        failure(
            FailureKind::VendorError,
            "Codex exited without finishing its turn".into(),
        )
    } else {
        let message = match (exit.info.code, exit.info.signal) {
            (_, Some(signal)) => format!("Codex was killed by signal {signal}"),
            (Some(code), None) => format!("Codex exited with code {code}"),
            (None, None) => "Codex ended in an unknown way".to_owned(),
        };
        failure(FailureKind::Crashed, message)
    };
    failed(failure, Some(&exit))
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
