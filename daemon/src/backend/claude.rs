//! The Claude Code backend: runs the user's own signed-in `claude` CLI headless (0004, #116).
//!
//! # The command
//!
//! Every run is `claude -p --output-format stream-json --verbose --input-format stream-json` in
//! the run's cwd, plus the policy's flags, `--model`, `--effort`, and `--resume <session id>`
//! (0004 [10]):
//!
//! - **No-write** is 0004's: [`NO_WRITE_ARGS`], then [`no_write_settings`] as `--settings`, which
//!   also keeps the file tools out of Claude Code's shared temp folder (RYA-176). As a second
//!   check, a no-write run whose `system/init` lists any tool outside [`NO_WRITE_TOOLS`] fails with
//!   [`FailureKind::PolicyViolation`]. A coordinator's run also gets wispd's own MCP tools
//!   (0019): `--mcp-config` with only the `wispd mcp` server, and `--allowedTools` with exactly
//!   [`crate::mcp::ALLOWED_TOOLS`], which `dontAsk` would otherwise deny. `--strict-mcp-config`
//!   still keeps every other MCP server out, and those tools are all `system/init` may add.
//! - **Workspace-write** is 0013's worker sandbox: [`WORKSPACE_WRITE_ARGS`], then the run's
//!   [`worker_permission_mode`], then [`worker_settings`] as `--settings`, then `--add-dir` for
//!   each writable folder:
//!   - `--restricted` loads no user, project, or local settings files, so a repository's
//!     `.claude/settings.json` can't add allow rules, hooks, or an `env` block (#134), and it
//!     confines the file tools to the working directories.
//!   - `--tools` names exactly [`WORKER_TOOLS`]. `Bash` is among them because Claude Code's own
//!     sandbox (Seatbelt on macOS, bubblewrap on Linux) holds every command: writes only to the
//!     working directories and the run's temp folder, no reads of the sandbox's `unreadable`
//!     paths, and no writes to git metadata. `failIfUnavailable` and
//!     `allowUnsandboxedCommands: false` keep a command from ever running outside it. Commands,
//!     `WebFetch`, and `WebSearch` reach any host but [`WORKER_DENIED_HOSTS`] (Ryan, #137), so
//!     the unreadable paths are what keep secrets in.
//!   - `--strict-mcp-config` connects no MCP servers, including the repository's `.mcp.json`.
//!
//!   As a second check, a worker whose `system/init` lists a tool outside [`WORKER_TOOLS`],
//!   reports a Claude Code older than [`WORKER_MIN_VERSION`], or reports a permission mode
//!   other than the one it asked for ([`worker_permission_mode`]), fails with
//!   [`FailureKind::PolicyViolation`].
//!
//!   Only macOS and Linux run workers, with the same settings. On Linux,
//!   `linux_sandbox::check_host` checks before each worker that the sandbox works, seccomp
//!   filter included, because `failIfUnavailable` doesn't cover the filter (0013). It also
//!   refuses a worker when Claude Code runs with [`SCRUB_ENV`] on, which managed settings can
//!   set (RYA-112). That check runs in a separate process, so the permission mode check, which
//!   the flag fails, backs it up from inside the worker's own (RYA-118). Elsewhere the backend
//!   reports no `worker_sandbox` and refuses a workspace-write run.
//!
//! # A worker's temp folder
//!
//! Claude Code keeps its temp files in `$CLAUDE_CODE_TMPDIR/claude-<uid>`, `/tmp/claude-<uid>` by
//! default, which every Claude Code session of the user shares, and its sandbox lets commands
//! write there. So a worker's CLI gets [`TEMP_ENV`] set to the run's own folder,
//! [`WorkerSandbox::temp`] (RYA-130), and its commands get `<temp>/claude-<uid>` as their
//! `TMPDIR`. Claude Code does that only while the path fits in [`MAX_COMMAND_TEMP_BYTES`], and
//! falls back to the shared folder otherwise, so a longer one refuses the worker
//! ([`worker_temp`]). The rest of the run's folder stays hidden from commands, and the settings
//! take back the paths the sandbox always lets them write ([`WORKER_DENIED_WRITES`]).
//!
//! The CLI's own `TMPDIR` stays wispd's. Claude Code keeps its sandbox's Linux proxy bridges
//! there, which commands must reach, and Node's compile cache, which they must not write. In the
//! run's folder the first would be hidden and cut commands off the network (RYA-107).
//!
//! # A worker's `PATH`
//!
//! Claude Code runs each Bash command through the user's `$SHELL`, and zsh reads `/etc/zshenv`
//! and `~/.zshenv` for every command, so startup files that set `PATH` outright replace the
//! `PATH` wispd gave the CLI. Claude Code's shell snapshot would put it back, but the snapshot
//! sits in the configuration folder, which a worker's commands can't read (RYA-126). So a worker
//! also gets [`ENV_FILE_ENV`]: [`write_env_file`] writes a script into the data folder's `tmp/`
//! that puts the CLI's `PATH` back in front, which the CLI reads itself and runs before each
//! command. The run's driver deletes it once the CLI has exited.
//!
//! # Messages go on stdin
//!
//! With `--input-format stream-json`, the prompt and every follow-up are user messages on stdin,
//! one JSON object per line, as the Agent SDK sends them. The prompt never goes in argv, where
//! `ps` would show it and `ARG_MAX` would limit it. Each message carries a `uuid`, the turn id,
//! which the CLI echoes in `result.user_message_uuids`: several messages sent close together can
//! run as one turn, and those ids say which turns a result ended. Once no turn is outstanding,
//! stdin closes and the CLI exits after its last result, which ends the run; a follow-up sent
//! after that fails with [`SendError::Finished`](super::SendError::Finished).
//!
//! # Credentials
//!
//! Every run, whatever its account, drops each inherited variable that could choose Claude's
//! credentials, provider, or endpoint: names starting with one of [`SCRUBBED_PREFIXES`], plus
//! [`SCRUBBED_VARS`]. Those include the three that outrank the login (0004), the cloud provider
//! switches, `ANTHROPIC_BASE_URL`, which would send the login's token elsewhere, and the profile
//! and federation variables. `CLAUDE_CONFIG_DIR` is dropped too, and set only to the account's
//! own configuration folder. [`apply_credential`] then injects only what the account needs: the
//! account's configuration folder for a subscription, or, for an API key account (#118), only
//! [`API_KEY_ENV`] with the key [`key_account::resolve`](super::key_account::resolve) read from
//! the Keychain. The key is never in `args`, so `ps` can't show it, and every copy of it wispd
//! makes along the way ([`super::ApiKey`]'s own buffer, [`super::process::Environment`]'s
//! entries, and the buffers `spawn_session` builds from them) is zeroized once it is done with
//! it. No run inherits [`SCRUB_ENV`]; a no-write run sets it, so the CLI's own subprocesses
//! don't get the key. A worker's sandbox withholds [`WORKER_WITHHELD_VARS`] from its sandboxed
//! commands only: the helpers Claude Code runs outside the sandbox, such as `git` and `rg`, still
//! inherit it.
//!
//! A project's `env` block can still set variables for a worker (0004, #134), so the output is
//! checked as well. A `system/init` whose `apiKeySource` isn't the account's, or is missing, and
//! a `result` whose `modelUsage` names a provider other than `firstParty`, kill the CLI's process
//! group at once and fail the run with [`FailureKind::UnexpectedApiKey`].
//!
//! # Cancel
//!
//! `SIGINT` ends Claude's turn, while `SIGTERM` leaves it unfinished (0004 [11]), so cancel sends
//! `SIGINT`, closes stdin so the CLI exits after the interrupted turn, and kills the process
//! group if it is still running after the grace period.

#[cfg(target_os = "linux")]
pub mod linux_sandbox;
mod stream;
#[cfg(all(test, unix))]
mod tests;

use std::collections::VecDeque;
use std::ffi::{OsStr, OsString};
use std::io::{self, Write as _};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use serde_json::Value;
use tempfile::TempPath;
use tokio::io::AsyncWriteExt;
use tokio::sync::{Notify, mpsc};

pub(crate) use self::stream::version as parse_version;
use self::stream::{Step, Translator, TurnDone};
use super::event::{Event, Failure, FailureKind, Outcome, WarningKind};
use super::process::{
    CancelPolicy, Environment, Exit, Launcher, Output, OutputLimits, Process, ProcessSpec, Signal,
    SpawnError, StdinMode, StdinPipe,
};
use super::sandbox::worker_sandbox;
use super::{
    AgentEffort, AgentPermission, Backend, CancelSwitch, Capabilities, Credential, EVENT_BUFFER,
    EventSink, FollowUp, Run, RunHandle, RunId, RunRequest, SendError, StartError, Started,
    ToolPolicy, TurnId, WorkerSandbox, check_argument, prepend_path_line,
};
use crate::mcp;

/// The CLI's program name, looked up on the launcher's `PATH`.
pub const PROGRAM: &str = "claude";

/// The arguments every run starts with.
pub const BASE_ARGS: &[&str] = &[
    "-p",
    "--output-format",
    "stream-json",
    "--verbose",
    "--input-format",
    "stream-json",
];

/// [`ToolPolicy::NoWrite`]'s fixed arguments, as 0004 has them: read-only built-in tools, only
/// the user's settings (so no project `env` block or hooks), no MCP servers but wispd's, and
/// every call that would prompt denied. [`arguments`] adds [`no_write_settings`] after them.
pub const NO_WRITE_ARGS: &[&str] = &[
    "--tools",
    "Read,Glob,Grep",
    "--setting-sources",
    "user",
    "--strict-mcp-config",
    "--permission-mode",
    "dontAsk",
];

/// The `--settings` a no-write run gets: hooks off (0004), and no `Read` under Claude Code's
/// shared temp folder, `/tmp/claude-<uid>` in both spellings ([`commands_temp`]), which holds
/// every session's files and which Claude Code otherwise lets it read outside its cwd (RYA-176).
/// 0013 hides the same folder from workers. A `Read` rule covers `Glob` and `Grep` too. The
/// folder is always in `/tmp`, because no no-write run gets [`TEMP_ENV`]: every agent CLI starts
/// from wispd's allowlisted environment (`agents::worker::agent_environment`, 0014), which drops
/// an inherited one, and only a worker has one injected.
#[must_use]
pub fn no_write_settings() -> Value {
    let deny: Vec<String> = ["/tmp", "/private/tmp"]
        .into_iter()
        .map(|temp| format!("Read(/{}/**)", commands_temp(Path::new(temp)).display()))
        .collect();
    serde_json::json!({"disableAllHooks": true, "permissions": {"deny": deny}})
}

/// The only built-in tools a no-write run's `system/init` may list. `EndConversation` stays
/// whatever `--tools` says (the CLI reference), and only ends the session. A coordinator run
/// may also list exactly [`mcp::ALLOWED_TOOLS`], wispd's own MCP tools (0019).
pub const NO_WRITE_TOOLS: &[&str] = &["Read", "Glob", "Grep", "EndConversation"];

/// The built-in tools a worker gets (0013): the file tools, `Bash`, which Claude Code's sandbox
/// confines, the web tools (Ryan, #137), and `TodoWrite`. No subagents, skills, or MCP tools.
/// `EndConversation` may appear in `system/init` as well, as for a no-write run.
pub const WORKER_TOOLS: &[&str] = &[
    "Read",
    "Edit",
    "Write",
    "Glob",
    "Grep",
    "NotebookEdit",
    "Bash",
    "WebFetch",
    "WebSearch",
    "TodoWrite",
];

/// [`WORKER_TOOLS`] as `--tools` takes them.
pub const WORKER_TOOL_LIST: &str =
    "Read,Edit,Write,Glob,Grep,NotebookEdit,Bash,WebFetch,WebSearch,TodoWrite";

/// The names for this Mac that no worker command or `WebFetch` may reach, even with network
/// access: this Mac's own services wait on #168. The sandbox's proxy canonicalizes other
/// spellings of loopback (`127.1`, `[::ffff:127.0.0.1]`) and refuses names that resolve to this
/// Mac, but it doesn't check IP literals, so the unspecified addresses are listed too. This Mac's
/// interface addresses aren't: 0013 records that gap.
pub const WORKER_DENIED_HOSTS: &[&str] = &["localhost", "127.0.0.1", "[::1]", "0.0.0.0", "[::]"];

/// The permission mode a worker asks for by default ([`worker_permission_mode`]). A worker must
/// then report the mode it asked for in `system/init`. Claude Code forces `default` instead when
/// [`SCRUB_ENV`] is on, so another mode there means the worker's own process runs in scrub mode,
/// whatever `linux_sandbox::check_host` saw (RYA-118).
pub const WORKER_PERMISSION_MODE: &str = "acceptEdits";

/// [`ToolPolicy::WorkspaceWrite`]'s fixed arguments (0013). [`arguments`] adds the run's
/// `--permission-mode` ([`worker_permission_mode`]), [`worker_settings`], and `--add-dir`
/// folders after them.
pub const WORKSPACE_WRITE_ARGS: &[&str] = &[
    "--restricted",
    "--tools",
    WORKER_TOOL_LIST,
    "--strict-mcp-config",
];

/// Every [`AgentEffort`] but the fallback: `--effort` takes them all. Claude Code downgrades
/// `xhigh` on models that lack it, and only warns about a level it doesn't know, so wispd sends
/// only these.
const EFFORTS: &[AgentEffort] = &[
    AgentEffort::Low,
    AgentEffort::Medium,
    AgentEffort::High,
    AgentEffort::Xhigh,
    AgentEffort::Max,
];

/// The worker permissions Claude Code maps, both inside the worker sandbox (0013).
const PERMISSIONS: &[AgentPermission] = &[AgentPermission::Edit, AgentPermission::Plan];

/// The oldest Claude Code that has every flag and setting a worker relies on: `--restricted`
/// arrived in 2.1.248, the last of them (0013). An older CLI rejects the unknown flag, and a
/// worker whose `system/init` reports an older version fails, but #156 also checks the detected
/// version before it starts one, for a clearer error. Linux workers need 2.1.275 or later:
/// `linux_sandbox::check_host` reads a `sandbox status` field that arrived then (RYA-112).
pub const WORKER_MIN_VERSION: &str = "2.1.248";

/// Prefixes of inherited variables no run gets: Anthropic credentials, endpoints, profiles, and
/// federation (`ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_BASE_URL`,
/// `ANTHROPIC_PROFILE`, ...), the cloud provider switches (`CLAUDE_CODE_USE_BEDROCK`, ...), and
/// OAuth tokens (`CLAUDE_CODE_OAUTH_TOKEN`, `CLAUDE_CODE_OAUTH_REFRESH_TOKEN`).
pub const SCRUBBED_PREFIXES: &[&str] = &["ANTHROPIC_", "CLAUDE_CODE_USE_", "CLAUDE_CODE_OAUTH_"];

/// Inherited variables no run gets, besides [`SCRUBBED_PREFIXES`]: Bedrock's API key; the
/// configuration folder, which [`apply_credential`] sets only to the account's own; and
/// [`SCRUB_ENV`], which a no-write run sets itself and a worker must not get (RYA-112).
pub const SCRUBBED_VARS: &[&str] = &["AWS_BEARER_TOKEN_BEDROCK", CONFIG_DIR_ENV, SCRUB_ENV];

/// The variable that picks a second account's configuration folder.
pub const CONFIG_DIR_ENV: &str = "CLAUDE_CONFIG_DIR";

/// What `system/init` reports as `apiKeySource` for a subscription login.
pub const SUBSCRIPTION_KEY_SOURCE: &str = "none";

/// The variable an API key account's key is injected as (0004's table, #118).
pub const API_KEY_ENV: &str = "ANTHROPIC_API_KEY";

/// What `system/init` reports as `apiKeySource` for an API key account. Happens to be the same
/// string as [`API_KEY_ENV`] (0004's table), but the two names are checked independently.
pub const API_KEY_SOURCE: &str = "ANTHROPIC_API_KEY";

/// Variables every run gets: report a startup failure as a `result` instead of on stderr alone.
const ALWAYS_SET: &[(&str, &str)] = &[("CLAUDE_CODE_STARTUP_FAILURE_RESULTS", "1")];

/// Set to `1` for a no-write run, to keep credentials out of the CLI's own subprocesses, such as
/// wispd's MCP server (0004 Consequences). A worker doesn't get it: on Linux it swaps in Claude
/// Code's CI sandbox profile, which lets commands write all of `/home`, `/tmp`, `/var`, `/opt`,
/// `/run`, `/mnt`, and `/root` (RYA-20). [`worker_settings`] withholds [`WORKER_WITHHELD_VARS`]
/// from a worker's commands instead, and [`SCRUBBED_VARS`] keeps an inherited one out. Managed
/// settings can still set it, and their `env` beats wispd's, so on Linux
/// `linux_sandbox::check_host` refuses a worker when Claude Code runs with it on (RYA-112), and
/// on every OS a worker whose `system/init` shows the permission mode it forces fails
/// (RYA-118). It forces a no-write run's mode to `default` as well, so those aren't checked.
const SCRUB_ENV: &str = "CLAUDE_CODE_SUBPROCESS_ENV_SCRUB";

/// Variables a worker's commands never see (0013): an API key account's key, and the token for
/// Claude Code's own messaging socket. `sandbox.credentials` unsets them for each sandboxed
/// command, as [`SCRUB_ENV`] would.
pub const WORKER_WITHHELD_VARS: &[&str] = &[API_KEY_ENV, "CLAUDE_CODE_MESSAGING_TOKEN"];

/// Paths Claude Code 2.1.283's sandbox lets every command write whatever the settings say, which
/// a worker's `denyWrite` takes back (RYA-130): `/tmp/claude` in both spellings, npm's log folder,
/// and Claude Code's debug logs. `~/` is the CLI's `HOME`. A `denyWrite` rule beats them.
pub const WORKER_DENIED_WRITES: &[&str] = &[
    "/tmp/claude",
    "/private/tmp/claude",
    "~/.npm/_logs",
    "~/.claude/debug",
];

/// The variable naming Claude Code's temp folder, which it uses `claude-<uid>` in, apart from the
/// process's own `TMPDIR`.
pub const TEMP_ENV: &str = "CLAUDE_CODE_TMPDIR";

/// The longest `$CLAUDE_CODE_TMPDIR/claude-<uid>` that Claude Code 2.1.283 gives a command as
/// `TMPDIR`. A longer one gets the shared `/tmp/claude-<uid>` instead, which a worker can't use.
pub const MAX_COMMAND_TEMP_BYTES: usize = 44;

/// The folder a worker's CLI gets as [`TEMP_ENV`]: `temp`, the run's own (RYA-130), spelled as
/// short as it can be. On macOS, `/private/tmp/...` becomes `/tmp/...`, where `/tmp`
/// links, which saves 8 of the [`MAX_COMMAND_TEMP_BYTES`].
///
/// # Errors
///
/// [`StartError::Invalid`] if [`commands_temp`] in it is longer than [`MAX_COMMAND_TEMP_BYTES`].
pub fn worker_temp(temp: &Path) -> Result<PathBuf, StartError> {
    let temp = match temp.strip_prefix("/private/tmp") {
        Ok(rest) if cfg!(target_os = "macos") => Path::new("/tmp").join(rest),
        _ => temp.to_owned(),
    };
    let commands = commands_temp(&temp);
    if commands.as_os_str().len() > MAX_COMMAND_TEMP_BYTES {
        return Err(StartError::Invalid(format!(
            "the worker's temp folder {} is longer than {MAX_COMMAND_TEMP_BYTES} bytes, so Claude \
             Code would give its commands the one every session shares instead",
            commands.display()
        )));
    }
    Ok(temp)
}

/// `<temp>/claude-<uid>`: the folder Claude Code makes in its temp folder `temp` and gives
/// sandboxed commands as their `TMPDIR`, which its sandbox lets them write.
#[must_use]
pub fn commands_temp(temp: &Path) -> PathBuf {
    #[cfg(unix)]
    let uid = rustix::process::getuid().as_raw();
    // What Claude Code uses where there is no uid.
    #[cfg(not(unix))]
    let uid = 0;
    temp.join(format!("claude-{uid}"))
}

/// The variable naming a script that Claude Code reads and runs before each Bash command, after
/// the shell's startup files and its own shell snapshot (2.1.283). See [`write_env_file`].
pub const ENV_FILE_ENV: &str = "CLAUDE_ENV_FILE";

/// Writes a worker's [`ENV_FILE_ENV`] script into `dir`, which no worker may read or write
/// (wispd's data folder's `tmp/`), and returns its path, which deletes the file when dropped. The
/// script puts `path`, the `PATH` the CLI started with, in front of whatever `PATH` the shell's
/// startup files left (RYA-126). The file is new, has a random name, and only its owner may read
/// or write it.
///
/// # Errors
///
/// If `dir` can't be created or the file can't be written.
pub fn write_env_file(dir: &Path, path: &OsStr) -> io::Result<TempPath> {
    std::fs::create_dir_all(dir)?;
    let mut file = tempfile::Builder::new()
        .prefix("claude-env-")
        .suffix(".sh")
        .tempfile_in(dir)?;
    file.write_all(&prepend_path_line(path))?;
    Ok(file.into_temp_path())
}

/// A [`Backend`] that runs Claude Code.
#[derive(Clone, Debug)]
pub struct ClaudeBackend {
    launcher: Launcher,
    program: OsString,
    cancel: CancelPolicy,
    limits: OutputLimits,
}

impl ClaudeBackend {
    /// A backend that starts `claude` through `launcher`.
    #[must_use]
    pub fn new(launcher: Launcher) -> Self {
        Self {
            launcher,
            program: PROGRAM.into(),
            cancel: CancelPolicy::default(),
            limits: OutputLimits::default(),
        }
    }

    /// Runs `program`, a name on `PATH` or an absolute path, instead of `claude`.
    #[must_use]
    pub fn with_program(mut self, program: impl Into<OsString>) -> Self {
        self.program = program.into();
        self
    }

    /// Cancels with `policy` instead of `SIGINT` and a 10 s grace period.
    #[must_use]
    pub fn with_cancel_policy(mut self, policy: CancelPolicy) -> Self {
        self.cancel = policy;
        self
    }

    /// Reads output with `limits` instead of the defaults.
    #[must_use]
    pub fn with_limits(mut self, limits: OutputLimits) -> Self {
        self.limits = limits;
        self
    }
}

/// The CLI's arguments for `request`.
///
/// # Errors
///
/// [`StartError::Invalid`] if the model or the resume id could be read as an option, if a
/// worker has no usable [`WorkerSandbox`], or if a no-write run asks for a permission.
/// [`StartError::Unsupported`] for an effort or permission this version doesn't know.
pub fn arguments(request: &RunRequest) -> Result<Vec<OsString>, StartError> {
    let policy = match request.policy {
        ToolPolicy::NoWrite => NO_WRITE_ARGS,
        ToolPolicy::WorkspaceWrite => WORKSPACE_WRITE_ARGS,
    };
    let mut args: Vec<OsString> = BASE_ARGS.iter().chain(policy).map(Into::into).collect();
    match request.policy {
        ToolPolicy::WorkspaceWrite => {
            let mode = worker_permission_mode(request.permission)?;
            args.extend(["--permission-mode".into(), mode.into()]);
        }
        ToolPolicy::NoWrite if request.permission.is_some() => {
            return Err(StartError::Invalid(
                "a no-write run takes no permission; its mode is fixed (0004)".into(),
            ));
        }
        ToolPolicy::NoWrite => {
            args.extend(["--settings".into(), no_write_settings().to_string().into()]);
        }
    }
    if let Some(tools) = &request.coordinator_tools {
        if request.policy != ToolPolicy::NoWrite {
            return Err(StartError::Invalid(
                "wispd's coordinator tools are only for a no-write run".into(),
            ));
        }
        args.extend([
            "--mcp-config".into(),
            tools.mcp_config()?.to_string().into(),
            "--allowedTools".into(),
            mcp::ALLOWED_TOOLS.join(",").into(),
        ]);
    }
    if let Some(sandbox) = worker_sandbox(request)? {
        let config_home = match &request.account.credential {
            Credential::Subscription { config_home } => config_home.as_deref(),
            Credential::ApiKey(_) => None,
        };
        let settings = worker_settings(sandbox, &request.cwd, config_home);
        args.extend(["--settings".into(), settings.to_string().into()]);
        for dir in &sandbox.writable {
            args.extend(["--add-dir".into(), dir.into()]);
        }
    }
    if let Some(model) = &request.model {
        check_argument("model", model)?;
        args.extend(["--model".into(), model.into()]);
    }
    if let Some(effort) = request.effort {
        args.extend(["--effort".into(), effort_level(effort)?.into()]);
    }
    if let Some(resume) = &request.resume {
        check_argument("resume id", &resume.session_id)?;
        args.extend(["--resume".into(), resume.session_id.clone().into()]);
    }
    Ok(args)
}

/// The `--settings` a worker runs with (0013): hooks off; Bash and the web tools allowed; and
/// Claude Code's Bash sandbox on, with no way around it, `sandbox`'s paths, every host but
/// [`WORKER_DENIED_HOSTS`], and no [`WORKER_WITHHELD_VARS`]. `WebFetch(domain:*)` is what opens
/// the network: the sandbox takes its allowlist from `WebFetch` allow rules, and a bare `*`
/// matches every host. The denied hosts are `WebFetch` deny rules as well as `deniedDomains`,
/// because the sandbox's list binds only commands, and a deny rule beats the `*` allow for the
/// tool. Bash is an allow rule as well, not only `autoAllowBashIfSandboxed`, so it stays allowed
/// if managed settings force permission mode `default` (RYA-112). `cwd`, the writable folders,
/// the read-only git paths, and the commands' `TMPDIR` in the run's temp folder
/// ([`commands_temp`], which Claude Code lets them write) stay readable inside an unreadable
/// path, such as wispd's data folder, which holds the worktree, the context folder, and a normal
/// thread's scratch repository (#110). The rest of the temp folder stays hidden: the CLI's own
/// unsandboxed processes keep files there. A second account's `config_home` is unreadable too.
/// [`WORKER_DENIED_WRITES`] aren't writable.
#[must_use]
pub fn worker_settings(sandbox: &WorkerSandbox, cwd: &Path, config_home: Option<&Path>) -> Value {
    let unreadable = strings(
        sandbox
            .unreadable
            .iter()
            .map(PathBuf::as_path)
            .chain(config_home),
    );
    let readable = strings(
        std::iter::once(cwd)
            .chain(sandbox.writable.iter().map(PathBuf::as_path))
            .chain(sandbox.read_only.iter().map(PathBuf::as_path))
            .chain([commands_temp(&sandbox.temp).as_path()]),
    );
    let mut read_only = strings(sandbox.read_only.iter().map(PathBuf::as_path));
    read_only.extend(WORKER_DENIED_WRITES.iter().map(|&path| path.to_owned()));
    let denied_fetches: Vec<String> = WORKER_DENIED_HOSTS
        .iter()
        .map(|host| format!("WebFetch(domain:{host})"))
        .collect();
    let withheld: Vec<Value> = WORKER_WITHHELD_VARS
        .iter()
        .map(|name| serde_json::json!({"name": name, "mode": "deny"}))
        .collect();
    serde_json::json!({
        "disableAllHooks": true,
        "permissions": {
            "allow": ["Bash", "WebFetch(domain:*)", "WebSearch"],
            "deny": denied_fetches,
        },
        "sandbox": {
            "enabled": true,
            "failIfUnavailable": true,
            "autoAllowBashIfSandboxed": true,
            "allowUnsandboxedCommands": false,
            "excludedCommands": [],
            "network": {
                "strictAllowlist": true,
                "deniedDomains": WORKER_DENIED_HOSTS,
                "allowLocalBinding": false,
            },
            "filesystem": {
                "denyRead": unreadable,
                "allowRead": readable,
                "denyWrite": read_only,
            },
            "credentials": {"envVars": withheld},
        },
    })
}

/// Paths as settings strings. [`worker_sandbox`] has already refused any that isn't UTF-8.
fn strings<'a>(paths: impl Iterator<Item = &'a Path>) -> Vec<String> {
    paths
        .map(|path| path.to_string_lossy().into_owned())
        .collect()
}

/// A worker's `--permission-mode` for `permission` (RYA-97): `acceptEdits` by default, or `plan`,
/// whose file tools refuse to write. Neither loosens the worker sandbox (0013): its commands run
/// in the same sandbox either way.
///
/// # Errors
///
/// [`StartError::Unsupported`] for a permission this version doesn't know.
pub fn worker_permission_mode(
    permission: Option<AgentPermission>,
) -> Result<&'static str, StartError> {
    match permission {
        None | Some(AgentPermission::Edit) => Ok(WORKER_PERMISSION_MODE),
        Some(AgentPermission::Plan) => Ok("plan"),
        Some(AgentPermission::Unknown) => Err(StartError::Unsupported(
            "Claude Code has no mode for this permission".into(),
        )),
    }
}

/// `--effort`'s value for `effort`.
fn effort_level(effort: AgentEffort) -> Result<&'static str, StartError> {
    Ok(match effort {
        AgentEffort::Low => "low",
        AgentEffort::Medium => "medium",
        AgentEffort::High => "high",
        AgentEffort::Xhigh => "xhigh",
        AgentEffort::Max => "max",
        AgentEffort::Unknown => {
            return Err(StartError::Unsupported(
                "Claude Code has no such effort level".into(),
            ));
        }
    })
}

/// The variables of `base` that no run gets: [`SCRUBBED_PREFIXES`] and [`SCRUBBED_VARS`].
#[must_use]
pub fn scrubbed(base: &Environment) -> Vec<OsString> {
    base.names()
        .filter(|name| {
            let bytes = name.as_encoded_bytes();
            SCRUBBED_PREFIXES
                .iter()
                .any(|prefix| bytes.starts_with(prefix.as_bytes()))
                || SCRUBBED_VARS.iter().any(|var| var.as_bytes() == bytes)
        })
        .map(OsStr::to_owned)
        .collect()
}

/// Injects what `credential` needs into `spec`, after [`scrubbed`] removed every inherited
/// credential, and returns the `apiKeySource` that `system/init` must then report.
///
/// # Errors
///
/// Never today; kept fallible so a future credential kind this backend can't serve has somewhere
/// to report it, the way [`StartError::Unsupported`] already does elsewhere in this module.
pub fn apply_credential(
    credential: &Credential,
    spec: &mut ProcessSpec,
) -> Result<&'static str, StartError> {
    match credential {
        Credential::Subscription { config_home } => {
            if let Some(home) = config_home {
                spec.inject.set(CONFIG_DIR_ENV, home);
            }
            Ok(SUBSCRIPTION_KEY_SOURCE)
        }
        Credential::ApiKey(key) => {
            spec.inject.set(API_KEY_ENV, key.expose());
            Ok(API_KEY_SOURCE)
        }
    }
}

impl Backend for ClaudeBackend {
    fn name(&self) -> &'static str {
        "claude"
    }

    fn capabilities(&self) -> Capabilities {
        Capabilities {
            follow_ups: true,
            resume: true,
            coordinator: true,
            reports_cost: true,
            rate_limits: true,
            worker_sandbox: cfg!(any(target_os = "macos", target_os = "linux")),
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
        if request.policy != ToolPolicy::NoWrite && !self.capabilities().worker_sandbox {
            return Err(StartError::Unsupported(
                "wispd can't check Claude Code's worker sandbox on this OS yet (decision 0023)"
                    .into(),
            ));
        }
        let mut spec = ProcessSpec::new(self.program.clone(), &request.cwd);
        spec.args = arguments(&request)?;
        if let Some(sandbox) = worker_sandbox(&request)? {
            spec.inject.set(TEMP_ENV, worker_temp(&sandbox.temp)?);
        }
        spec.scrub = scrubbed(self.launcher.base());
        let expected_key_source = apply_credential(&request.account.credential, &mut spec)?;
        for (name, value) in ALWAYS_SET {
            spec.inject.set(name, value);
        }
        if request.policy == ToolPolicy::NoWrite {
            spec.inject.set(SCRUB_ENV, "1");
        }
        let env_file = match self.launcher.base().get("PATH") {
            Some(path) if request.policy == ToolPolicy::WorkspaceWrite => {
                let dir = self.launcher.data_dir().temp_dir();
                let file = write_env_file(&dir, path).map_err(SpawnError::Io)?;
                spec.inject.set(ENV_FILE_ENV, file.as_os_str());
                Some(file)
            }
            _ => None,
        };
        spec.stdin = StdinMode::Piped;
        spec.limits = self.limits;

        let process = self.launcher.spawn(&spec)?;
        let switch = CancelSwitch::new();
        switch.arm(process.signals().clone(), self.cancel);
        let (handle, control) = RunHandle::new(request.run_id, true, switch.clone());
        let stop = Arc::new(Notify::new());
        let baseline = request
            .resume
            .map(|resume| resume.usage_totals)
            .unwrap_or_default();
        let (sink, events) = EventSink::channel(EVENT_BUFFER, baseline);
        let driver = Driver {
            process,
            control,
            sink,
            switch,
            stop: Arc::clone(&stop),
            translator: Translator::new(request.policy, expected_key_source)
                .with_coordinator_tools(request.coordinator_tools.is_some())
                .with_permission_mode(worker_permission_mode(request.permission)?),
            turns: VecDeque::new(),
            violation: None,
            env_file,
        };
        tokio::spawn(driver.run(Message::new(request.turn_id, &request.prompt, false)));
        Ok(Started {
            run: Arc::new(ClaudeRun { handle, stop }),
            events,
        })
    }
}

/// The run's handle: [`RunHandle`], plus closing stdin on cancel so the CLI exits after the
/// interrupted turn instead of waiting for more input until the grace period ends.
struct ClaudeRun {
    handle: RunHandle,
    stop: Arc<Notify>,
}

impl Run for ClaudeRun {
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
}

/// A user message for the CLI's stdin.
#[derive(Debug)]
struct Message {
    turn_id: Option<TurnId>,
    uuid: String,
    line: String,
    follow_up: bool,
}

impl Message {
    fn new(turn_id: Option<TurnId>, text: &str, follow_up: bool) -> Self {
        let uuid = turn_id.unwrap_or_else(TurnId::generate).to_string();
        let mut line = serde_json::json!({
            "type": "user",
            "message": {"role": "user", "content": text},
            "parent_tool_use_id": null,
            "uuid": uuid,
        })
        .to_string();
        line.push('\n');
        Self {
            turn_id,
            uuid,
            line,
            follow_up,
        }
    }
}

/// The result of writing one message to stdin.
enum Delivery {
    Written(Message),
    Failed(Message),
}

/// Writes messages to stdin in order, off the driver's loop, so a CLI that stops reading stdin
/// can't keep the driver from reading its stdout.
async fn write_messages(
    mut stdin: StdinPipe,
    mut queue: mpsc::UnboundedReceiver<Message>,
    results: mpsc::UnboundedSender<Delivery>,
) {
    let mut broken = false;
    while let Some(message) = queue.recv().await {
        broken = broken || stdin.write_all(message.line.as_bytes()).await.is_err();
        let result = if broken {
            Delivery::Failed(message)
        } else {
            Delivery::Written(message)
        };
        let _ = results.send(result);
    }
}

/// The CLI's stdin: a queue into [`write_messages`], and its results.
struct Stdin {
    queue: Option<mpsc::UnboundedSender<Message>>,
    results: mpsc::UnboundedReceiver<Delivery>,
    writer: Option<tokio::task::JoinHandle<()>>,
    /// Messages queued whose delivery hasn't been read yet.
    pending: usize,
}

impl Stdin {
    fn start(process: &mut Process) -> Self {
        let (results_tx, results) = mpsc::unbounded_channel();
        let Some(pipe) = process.take_stdin() else {
            return Self {
                queue: None,
                results,
                writer: None,
                pending: 0,
            };
        };
        let (queue, queue_rx) = mpsc::unbounded_channel();
        Self {
            queue: Some(queue),
            results,
            writer: Some(tokio::spawn(write_messages(pipe, queue_rx, results_tx))),
            pending: 0,
        }
    }

    fn is_open(&self) -> bool {
        self.queue.is_some()
    }

    /// Queues `message`, or gives it back once stdin is closed.
    fn send(&mut self, message: Message) -> Result<(), Message> {
        let Some(queue) = &self.queue else {
            return Err(message);
        };
        queue.send(message).map_err(|error| error.0)?;
        self.pending += 1;
        Ok(())
    }

    /// Closes stdin once the writer has written what is queued.
    fn close(&mut self) {
        self.queue = None;
    }
}

/// One run: forwards the CLI's events, delivers follow-ups, and decides the outcome when the CLI
/// exits. Cancelling doesn't wait for it: the handle signals the process through the switch.
struct Driver {
    process: Process,
    control: mpsc::UnboundedReceiver<FollowUp>,
    sink: EventSink,
    switch: CancelSwitch,
    stop: Arc<Notify>,
    translator: Translator,
    /// Turns the CLI has been sent but hasn't finished, oldest first: their ids and `uuid`s.
    turns: VecDeque<(Option<TurnId>, String)>,
    violation: Option<Failure>,
    /// A worker's [`ENV_FILE_ENV`] script, deleted once the CLI has exited.
    env_file: Option<TempPath>,
}

impl Driver {
    async fn run(mut self, prompt: Message) {
        let mut stdin = Stdin::start(&mut self.process);
        self.turns.push_back((prompt.turn_id, prompt.uuid.clone()));
        let first = Event::TurnStarted {
            turn_id: prompt.turn_id,
        };
        if self.sink.emit(first).await.is_err() {
            self.switch.cancel();
        }
        if stdin.send(prompt).is_err() {
            self.control.close();
        }
        let mut control_open = true;

        let exit = loop {
            tokio::select! {
                // Deliveries first, so a follow-up's TurnStarted comes before what the CLI answers.
                biased;
                Some(delivery) = stdin.results.recv() => {
                    stdin.pending = stdin.pending.saturating_sub(1);
                    match delivery {
                        Delivery::Written(message) if message.follow_up => {
                            self.turns.push_back((message.turn_id, message.uuid));
                            let started = Event::TurnStarted { turn_id: message.turn_id };
                            self.emit(started).await;
                        }
                        Delivery::Written(_) => {}
                        Delivery::Failed(message) => {
                            // stdin is gone, so no later message can arrive either.
                            stdin.close();
                            self.control.close();
                            self.dropped(&message).await;
                        }
                    }
                }
                output = self.process.next() => match output {
                    Some(Output::Line(line)) => {
                        if self.violation.is_none() {
                            let steps = self.translator.line(&line);
                            self.apply(steps, &mut stdin).await;
                        }
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
                follow_up = self.control.recv(), if control_open => match follow_up {
                    Some(follow_up) => {
                        let message = Message::new(Some(follow_up.turn_id), &follow_up.text, true);
                        if let Err(message) = stdin.send(message) {
                            self.dropped(&message).await;
                        }
                    }
                    None => control_open = false,
                },
                () = self.stop.notified(), if stdin.is_open() => {
                    stdin.close();
                    self.control.close();
                }
                () = self.sink.closed(), if !self.switch.is_cancelled() => {
                    self.switch.cancel();
                    stdin.close();
                    self.control.close();
                }
            }
            self.close_when_idle(&mut stdin);
        };

        self.drop_undelivered(stdin).await;
        self.env_file = None;
        let outcome = self.outcome(exit);
        let _ = self.sink.finish(outcome).await;
    }

    async fn apply(&mut self, steps: Vec<Step>, stdin: &mut Stdin) {
        for step in steps {
            match step {
                Step::Emit(event) => self.emit(event).await,
                Step::Total(total) => {
                    let observed = self
                        .sink
                        .observe_total(total.model.as_deref(), total.usage)
                        .await;
                    if observed.is_err() {
                        self.switch.cancel();
                    }
                }
                Step::TurnDone(done) => {
                    for turn_id in self.finish_turns(&done) {
                        let result = done.result.clone();
                        self.emit(Event::TurnFinished { turn_id, result }).await;
                    }
                }
                Step::Violation(failure) => {
                    // Kill at once, not SIGINT: every moment it runs may bill the wrong account.
                    let _ = self.process.signals().signal_group(Signal::KILL);
                    self.violation = Some(failure);
                    stdin.close();
                    self.control.close();
                    return;
                }
            }
        }
    }

    /// The turns a `result` ended, oldest first. Turns finish in the order they started, so a
    /// result ends every outstanding turn up to the newest one it names.
    fn finish_turns(&mut self, done: &TurnDone) -> Vec<Option<TurnId>> {
        let named = self
            .turns
            .iter()
            .rposition(|(_, uuid)| done.uuids.contains(uuid));
        let count = match (named, done.queued) {
            (Some(index), _) => index + 1,
            // With no ids to go by and nothing queued, or no count either, every turn sent so far
            // is taken as done. At worst a folded follow-up finishes early; ending only one turn
            // could leave stdin open and the run waiting forever.
            (None, Some(0) | None) if done.uuids.is_empty() => self.turns.len(),
            (None, _) => 1,
        };
        let count = count.min(self.turns.len());
        self.turns
            .drain(..count)
            .map(|(turn_id, _)| turn_id)
            .collect()
    }

    /// Closes stdin once no turn is outstanding, so the CLI exits after its last result.
    fn close_when_idle(&mut self, stdin: &mut Stdin) {
        if stdin.is_open() && self.turns.is_empty() && stdin.pending == 0 {
            stdin.close();
            self.control.close();
        }
    }

    async fn emit(&mut self, event: Event) {
        if self.sink.emit(event).await.is_err() {
            self.switch.cancel();
        }
    }

    async fn dropped(&mut self, message: &Message) {
        if message.follow_up
            && let Some(turn_id) = message.turn_id
        {
            self.emit(Event::FollowUpDropped { turn_id }).await;
        }
    }

    /// After the CLI exited: reports every follow-up that was sent or queued but never started a
    /// turn as dropped.
    async fn drop_undelivered(&mut self, mut stdin: Stdin) {
        self.control.close();
        let mut late = Vec::new();
        while let Ok(follow_up) = self.control.try_recv() {
            late.push(follow_up);
        }
        for follow_up in late {
            let message = Message::new(Some(follow_up.turn_id), &follow_up.text, true);
            if let Err(message) = stdin.send(message) {
                self.dropped(&message).await;
            }
        }
        stdin.close();
        if let Some(writer) = stdin.writer.take() {
            // Writes fail at once once nothing holds the pipe's read end. Something the CLI
            // started outside its process group could, so don't wait on it for long.
            let _ = tokio::time::timeout(Duration::from_secs(1), writer).await;
        }
        while let Ok(delivery) = stdin.results.try_recv() {
            let (Delivery::Written(message) | Delivery::Failed(message)) = delivery;
            self.dropped(&message).await;
        }
    }

    fn outcome(&mut self, exit: Option<Exit>) -> Outcome {
        if let Some(violation) = self.violation.take() {
            return failed(violation, exit.as_ref());
        }
        if self.switch.is_cancelled() {
            return Outcome::Cancelled;
        }
        if let Some(failure) = self.translator.last_failure.take() {
            return failed(failure, exit.as_ref());
        }
        let Some(exit) = exit else {
            return failed(
                failure(FailureKind::Internal, "lost track of the process".into()),
                None,
            );
        };
        if exit.info.success() && self.translator.results > 0 {
            return Outcome::Completed {
                result: self.translator.last_result.take(),
            };
        }
        let lower = exit.stderr_tail.to_ascii_lowercase();
        let failure = if lower.contains("not logged in") || lower.contains("/login") {
            failure(
                FailureKind::NotSignedIn,
                "Claude Code is not signed in".into(),
            )
        } else if exit.info.success() {
            failure(
                FailureKind::VendorError,
                "Claude Code exited without finishing its turn".into(),
            )
        } else {
            let message = match (exit.info.code, exit.info.signal) {
                (_, Some(signal)) => format!("Claude Code was killed by signal {signal}"),
                (Some(code), None) => format!("Claude Code exited with code {code}"),
                (None, None) => "Claude Code ended in an unknown way".to_owned(),
            };
            failure(FailureKind::Crashed, message)
        };
        failed(failure, Some(&exit))
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
