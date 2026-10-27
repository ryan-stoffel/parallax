//! The Claude backend against a fake `claude` on `PATH` that replays synthetic fixtures, so every
//! test spawns a real process through the supervisor. No test runs the real CLI.

use std::fs;
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use serde_json::Value;
use tempfile::TempDir;

use super::stream::{Ask, Step, Translator};
use super::{
    ClaudeBackend, LIVE_MODE_ARGS, NO_WRITE_ARGS, PLAN_WORKER_TOOL_LIST, PROMPT_TOOL_ARGS,
    WORKER_TOOL_LIST, WORKER_TOOLS, WORKSPACE_WRITE_ARGS, no_write_settings,
};
use crate::backend::event::{MAX_ALWAYS_ALLOW_RULE_BYTES, MAX_ALWAYS_ALLOW_RULES};
use crate::backend::process::{Environment, Launcher, SpawnError};
use crate::backend::{
    AccountRef, AgentEffort, AgentPermission, Answer, ApiKey, ApprovalRequest, Backend, Credential,
    Decision, Event, EventStream, FailureKind, FollowUp, ImageMediaType, LimitStatus, LimitWindow,
    ModelUsage, Outcome, PromptImage, Resume, Rewind, RunId, RunRequest, SendError, StartError,
    Started, ThreadTools, TodoItem, TodoStatus, ToolPolicy, ToolStatus, TurnId, Usage, WarningKind,
    WorkerSandbox,
};
use crate::mcp;
use crate::paths::DataDir;

const SESSION: &str = "5b1e3c9a-8f2d-4c6e-9a1b-3d7f0e2c4a68";
const TURN_1: &str = "01997e2a-4c3b-7d10-8a2e-5f6b7c8d9e01";
const TURN_2: &str = "01997e2a-4c3b-7d10-8a2e-5f6b7c8d9e02";
const OPUS: &str = "claude-opus-4-7";
const FAKE_CLAUDE: &str = include_str!("fixtures/fake-claude.sh");
const FAKE_SDK: &str = include_str!("fixtures/fake-sdk.sh");

fn fixture(name: &str) -> &'static str {
    match name {
        "read-only" => include_str!("fixtures/read-only.jsonl"),
        "tool-call" => include_str!("fixtures/tool-call.jsonl"),
        "api-key-source" => include_str!("fixtures/api-key-source.jsonl"),
        "api-key-completed" => include_str!("fixtures/api-key-completed.jsonl"),
        "malformed" => include_str!("fixtures/malformed.jsonl"),
        "follow-up-folded" => include_str!("fixtures/follow-up-folded.jsonl"),
        "follow-up-turns" => include_str!("fixtures/follow-up-turns.jsonl"),
        "cancel" => include_str!("fixtures/cancel.jsonl"),
        "provider" => include_str!("fixtures/provider.jsonl"),
        "approval" => include_str!("fixtures/approval.jsonl"),
        "approval-exit" => include_str!("fixtures/approval-exit.jsonl"),
        "recorded" => include_str!("fixtures/recorded.jsonl"),
        other => panic!("no fixture {other}"),
    }
}

/// Inherited variables that could pick Claude's credentials, provider, endpoint, or account, one
/// of each kind, and the variable that would share a run's task list (PLX-251). None may reach the
/// CLI, whatever the run's account or policy.
const INHERITED_CREDENTIALS: &[(&str, &str)] = &[
    ("ANTHROPIC_API_KEY", "parallax-test-not-a-key"),
    ("ANTHROPIC_AUTH_TOKEN", "parallax-test-not-a-bearer"),
    ("CLAUDE_CODE_OAUTH_TOKEN", "parallax-test-not-a-token"),
    (
        "CLAUDE_CODE_OAUTH_REFRESH_TOKEN",
        "parallax-test-not-a-token",
    ),
    ("CLAUDE_CODE_USE_BEDROCK", "1"),
    ("CLAUDE_CODE_USE_VERTEX", "1"),
    ("CLAUDE_CODE_USE_FOUNDRY", "1"),
    ("ANTHROPIC_BASE_URL", "https://example.invalid"),
    ("ANTHROPIC_UNIX_SOCKET", "/tmp/parallax-test.sock"),
    ("ANTHROPIC_PROFILE", "work"),
    ("ANTHROPIC_FEDERATION_RULE_ID", "parallax-test-rule"),
    ("ANTHROPIC_ORGANIZATION_ID", "parallax-test-org"),
    ("AWS_BEARER_TOKEN_BEDROCK", "parallax-test-not-a-token"),
    ("CLAUDE_CONFIG_DIR", "/tmp/parallax-test-inherited-config"),
    ("CLAUDE_CODE_TASK_LIST_ID", "parallax-test-shared-list"),
];

fn turn(id: &str) -> TurnId {
    id.parse().unwrap()
}

/// A fake Agent SDK sidecar ([`sdk::OVERRIDE_ENV`](super::sdk::OVERRIDE_ENV)) that replays a
/// fixture as the `claude` on the launcher's `PATH` would, in a folder that also holds what it
/// records.
struct Fake {
    dir: TempDir,
    backend: ClaudeBackend,
}

impl Fake {
    fn new(fixture_name: &str) -> Self {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().canonicalize().unwrap();
        let bin = root.join("bin");
        fs::create_dir(&bin).unwrap();
        for (name, script) in [("claude", FAKE_CLAUDE), ("claude-sdk", FAKE_SDK)] {
            let program = bin.join(name);
            fs::write(&program, script).unwrap();
            fs::set_permissions(&program, fs::Permissions::from_mode(0o755)).unwrap();
        }
        let fixture_path = root.join("fixture.jsonl");
        fs::write(&fixture_path, fixture(fixture_name)).unwrap();
        let base: Environment = [
            ("PATH", format!("{}:/usr/bin:/bin", bin.display())),
            (
                super::sdk::OVERRIDE_ENV,
                bin.join("claude-sdk").display().to_string(),
            ),
            ("FAKE_CLAUDE_DIR", root.display().to_string()),
            ("FAKE_CLAUDE_FIXTURE", fixture_path.display().to_string()),
            ("SSH_CONNECTION", "10.0.0.2 50000 10.0.0.1 22".into()),
            ("KEPT", "yes".into()),
            // Set in plxd's own environment: a no-write run sets it anyway, and a worker must
            // not get it (PLX-112).
            ("CLAUDE_CODE_SUBPROCESS_ENV_SCRUB", "0".into()),
        ]
        .into_iter()
        .chain(
            INHERITED_CREDENTIALS
                .iter()
                .map(|(name, value)| (*name, (*value).to_owned())),
        )
        .collect();
        let launcher = Launcher::new(DataDir::new(root.join("data")).unwrap(), base);
        Self {
            dir,
            backend: ClaudeBackend::new(launcher),
        }
    }

    fn root(&self) -> PathBuf {
        self.dir.path().canonicalize().unwrap()
    }

    fn recorded(&self, name: &str) -> String {
        fs::read_to_string(self.root().join(name)).unwrap_or_default()
    }

    /// The last query's `open` line: the CLI's program, arguments, folder, and environment.
    fn open(&self) -> Value {
        serde_json::from_str(&self.recorded("open")).unwrap_or_default()
    }

    fn argv(&self) -> Vec<String> {
        self.open()["args"]
            .as_array()
            .into_iter()
            .flatten()
            .map(|arg| arg.as_str().unwrap().to_owned())
            .collect()
    }

    fn env(&self) -> Vec<String> {
        self.open()["env"]
            .as_object()
            .into_iter()
            .flatten()
            .map(|(name, value)| format!("{name}={}", value.as_str().unwrap()))
            .collect()
    }

    /// Checks that no inherited credential reached the CLI. `CLAUDE_CONFIG_DIR` may only have
    /// the value Parallax set on purpose.
    fn assert_no_inherited_credentials(&self, config_dir: Option<&str>) {
        let env = self.env();
        for (name, value) in INHERITED_CREDENTIALS {
            let prefix = format!("{name}=");
            let leaked: Vec<&String> = env
                .iter()
                .filter(|var| var.starts_with(&prefix))
                .filter(|var| *name != "CLAUDE_CONFIG_DIR" || var.ends_with(value))
                .collect();
            assert!(leaked.is_empty(), "{name} leaked: {leaked:?}");
        }
        let config = env
            .iter()
            .find_map(|var| var.strip_prefix("CLAUDE_CONFIG_DIR="));
        assert_eq!(config, config_dir);
    }

    /// The user messages the CLI read from stdin.
    fn stdin(&self) -> Vec<Value> {
        self.recorded("stdin")
            .lines()
            .map(|line| serde_json::from_str(line).unwrap())
            .collect()
    }
}

fn request(cwd: &Path) -> RunRequest {
    RunRequest {
        run_id: RunId::generate(),
        turn_id: Some(turn(TURN_1)),
        cwd: cwd.to_owned(),
        prompt: "Summarize the README.\nKeep it short.".into(),
        images: Vec::new(),
        policy: ToolPolicy::NoWrite,
        sandbox: None,
        account: AccountRef {
            id: "claude-max".into(),
            credential: Credential::Subscription { config_home: None },
        },
        resume: None,
        model: None,
        effort: None,
        permission: None,
        context_window: None,
        fast: None,
        coordinator_tools: None,
        thread_tools: None,
        approvals: false,
        thread: false,
        instructions: None,
    }
}

async fn launch(backend: &dyn Backend, request: RunRequest) -> Started {
    let turn_id = request.turn_id;
    let mut started = backend.start(request).unwrap();
    assert_eq!(
        next(&mut started.events).await,
        Event::TurnStarted { turn_id }
    );
    started
}

// Lifecycle tests skip request measurements, which the real-session replay snapshot covers.
async fn next(events: &mut EventStream) -> Event {
    tokio::time::timeout(Duration::from_secs(10), async {
        loop {
            let event = events.next().await.expect("the stream ended");
            if !matches!(event, Event::RequestUsage(_)) {
                return event;
            }
        }
    })
    .await
    .expect("no event within 10 s")
}

async fn rest(events: &mut EventStream) -> Vec<Event> {
    let mut all = Vec::new();
    loop {
        let event = next(events).await;
        let terminal = event.is_terminal();
        all.push(event);
        if terminal {
            assert!(events.next().await.is_none(), "Finished must be last");
            return all;
        }
    }
}

async fn run(fake: &Fake, request: RunRequest) -> Vec<Event> {
    let mut events = launch(&fake.backend, request).await.events;
    rest(&mut events).await
}

fn outcome(events: &[Event]) -> &Outcome {
    match events.last() {
        Some(Event::Finished { outcome, .. }) => outcome,
        other => panic!("expected Finished last, got {other:?}"),
    }
}

fn failure(events: &[Event]) -> (FailureKind, &str) {
    match outcome(events) {
        Outcome::Failed(failure) => (failure.failure, failure.message.as_str()),
        other => panic!("expected a failure, got {other:?}"),
    }
}

fn texts(events: &[Event]) -> Vec<&str> {
    events
        .iter()
        .filter_map(|event| match event {
            Event::Text { text, .. } => Some(text.as_str()),
            _ => None,
        })
        .collect()
}

fn warnings(events: &[Event]) -> Vec<WarningKind> {
    events
        .iter()
        .filter_map(|event| match event {
            Event::Warning { warning, .. } => Some(*warning),
            _ => None,
        })
        .collect()
}

fn tokens(input: u64, output: u64, read: u64, write: u64, cost: u64) -> Usage {
    Usage {
        input_tokens: input,
        output_tokens: output,
        cache_read_tokens: read,
        cache_write_tokens: write,
        cost_usd_micros: Some(cost),
    }
}

#[tokio::test]
async fn a_read_only_run_maps_the_stream_and_uses_the_no_write_policy() {
    let fake = Fake::new("read-only");
    let cwd = fake.root();
    let all = run(&fake, request(&cwd)).await;
    assert_eq!(
        all,
        [
            Event::SessionStarted {
                session_id: SESSION.into(),
                model: Some(OPUS.into()),
                api_key_source: Some("none".into()),
            },
            Event::Reasoning {
                message_id: Some("msg_01Rd1".into()),
                text: "The user wants a summary of the README.".into(),
            },
            Event::Text {
                message_id: Some("msg_01Rd1".into()),
                text: "The README describes Parallax, a macOS editor with a host daemon.".into(),
            },
            Event::RateLimit(LimitWindow {
                window: "five_hour".into(),
                duration_minutes: Some(300),
                used_percent: Some(12.0),
                status: LimitStatus::Allowed,
                resets_at: Some("2026-09-25T19:00:00Z".parse().unwrap()),
            }),
            Event::Usage(ModelUsage {
                model: Some(OPUS.into()),
                usage: tokens(12, 180, 14000, 3000, 42_100),
            }),
            // The turn's last transcript entry, where a rewind resumes (0062).
            Event::TurnCursor {
                turn_id: Some(turn(TURN_1)),
                cursor: "a0000000-0000-4000-8000-000000000004".into(),
            },
            Event::TurnFinished {
                turn_id: Some(turn(TURN_1)),
                result: Some(
                    "The README describes Parallax, a macOS editor with a host daemon.".into()
                ),
                failed: false,
            },
            Event::Finished {
                outcome: Outcome::Completed {
                    result: Some(
                        "The README describes Parallax, a macOS editor with a host daemon.".into()
                    ),
                },
                usage_totals: vec![ModelUsage {
                    model: Some(OPUS.into()),
                    usage: tokens(12, 180, 14000, 3000, 42_100),
                }],
            },
        ]
    );

    let mut expected: Vec<&str> = super::BASE_ARGS.to_vec();
    let mut settings = no_write_settings();
    settings["showThinkingSummaries"] = true.into();
    let settings = settings.to_string();
    expected.extend(NO_WRITE_ARGS);
    expected.extend(["--settings", &settings]);
    assert_eq!(fake.argv(), expected);
    assert_eq!(
        NO_WRITE_ARGS.join(" "),
        "--tools Read,Glob,Grep --setting-sources user --strict-mcp-config --permission-mode \
         dontAsk",
        "0004's no-write flags, before its settings"
    );
    let env = fake.env();
    assert_eq!(fake.open()["cwd"], cwd.display().to_string());
    assert_eq!(
        fake.open()["executable"],
        fake.root().join("bin/claude").display().to_string(),
        "the SDK runs the user's own claude"
    );
    fake.assert_no_inherited_credentials(None);
    assert!(!env.iter().any(|var| var.starts_with("SSH_CONNECTION=")));
    assert!(!env.iter().any(|var| var.starts_with("CLAUDE_ENV_FILE=")));
    for set in [
        "CLAUDE_CODE_SUBPROCESS_ENV_SCRUB=1",
        "CLAUDE_CODE_STARTUP_FAILURE_RESULTS=1",
        "KEPT=yes",
    ] {
        assert!(env.iter().any(|var| var == set), "{set} missing: {env:?}");
    }

    assert_eq!(
        fake.stdin(),
        [serde_json::json!({
            "type": "user",
            "message": {"role": "user", "content": "Summarize the README.\nKeep it short."},
            "parent_tool_use_id": null,
            "uuid": TURN_1,
        })],
        "the prompt goes on stdin, not in argv"
    );
}

/// PLX-176: a plain no-write run has hooks off (0004) and can't read Claude Code's shared temp
/// folder, which holds every session's files, in either spelling.
#[test]
fn a_no_write_run_cannot_read_claudes_shared_temp_folder() {
    let args = super::arguments(&request(Path::new("/repo"))).unwrap();
    let at = args.iter().position(|arg| arg == "--settings").unwrap();
    let settings: Value = serde_json::from_str(args[at + 1].to_str().unwrap()).unwrap();
    let uid = rustix::process::getuid().as_raw();
    assert_eq!(
        settings,
        serde_json::json!({
            "disableAllHooks": true,
            "permissions": {"deny": [
                format!("Read(//tmp/claude-{uid}/**)"),
                format!("Read(//private/tmp/claude-{uid}/**)"),
            ]},
            "env": {"CLAUDE_CODE_TASK_LIST_ID": ""},
            "showThinkingSummaries": true,
        })
    );
}

/// A sandbox as #156 builds it, for a worktree at `cwd`.
fn worker_sandbox(cwd: &Path) -> WorkerSandbox {
    WorkerSandbox::for_worktree(
        Path::new("/Users/u"),
        Path::new("/Users/u/Library/Application Support/parallax"),
        cwd,
        Path::new("/Users/u/src/app/.git"),
        Path::new("/Users/u/Library/Application Support/parallax/context/p"),
        Path::new("/tmp/parallax-625c7f6d/Ab12Cd"),
    )
}

/// A worker's policy, sandbox, model, effort, and second account reached the CLI.
#[expect(
    clippy::too_many_lines,
    reason = "the settings are spelled out whole, so a changed one shows in the diff"
)]
fn assert_worker_invocation(fake: &Fake) {
    let argv = fake.argv();
    let cwd = fake.root().display().to_string();
    let mut expected: Vec<&str> = WORKSPACE_WRITE_ARGS.to_vec();
    expected.extend(["--permission-mode", "acceptEdits", "--settings"]);
    let base = super::BASE_ARGS.len();
    assert_eq!(argv[base..base + expected.len()], expected);
    assert_eq!(
        WORKSPACE_WRITE_ARGS.join(" "),
        "--restricted --tools Read,Edit,Write,Glob,Grep,NotebookEdit,Bash,WebFetch,WebSearch,\
         TodoWrite,TaskCreate,TaskGet,TaskList,TaskUpdate --strict-mcp-config",
        "0013's worker policy, exactly"
    );
    assert_eq!(WORKER_TOOL_LIST, WORKER_TOOLS.join(","));

    let settings: Value = serde_json::from_str(&argv[base + expected.len()]).unwrap();
    let mut deny_read: Vec<String> = worker_sandbox(Path::new(&cwd))
        .unreadable
        .iter()
        .map(|path| path.display().to_string())
        .collect();
    deny_read.push("/tmp/claude-second-account".into());
    let uid = rustix::process::getuid().as_raw();
    assert_eq!(
        settings,
        serde_json::json!({
            "disableAllHooks": true,
            "permissions": {
                "allow": ["Bash", "WebFetch(domain:*)", "WebSearch"],
                "deny": [
                    "WebFetch(domain:localhost)",
                    "WebFetch(domain:127.0.0.1)",
                    "WebFetch(domain:[::1])",
                    "WebFetch(domain:0.0.0.0)",
                    "WebFetch(domain:[::])",
                ],
            },
            "sandbox": {
                "enabled": true,
                "failIfUnavailable": true,
                "autoAllowBashIfSandboxed": true,
                "allowUnsandboxedCommands": false,
                "excludedCommands": [],
                "network": {
                    "strictAllowlist": true,
                    "deniedDomains": ["localhost", "127.0.0.1", "[::1]", "0.0.0.0", "[::]"],
                    "allowLocalBinding": false,
                },
                "filesystem": {
                    "denyRead": deny_read,
                    "allowRead": [
                        cwd,
                        "/Users/u/Library/Application Support/parallax/context/p",
                        format!("{cwd}/.git"),
                        "/Users/u/src/app/.git",
                        "/Users/u/Library/Application Support/parallax/uploads",
                        "/Users/u/Library/Application Support/parallax/tools/gh-shim",
                        "/Users/u/Library/Application Support/parallax/github-budget.json",
                        format!("/tmp/parallax-625c7f6d/Ab12Cd/claude-{uid}"),
                    ],
                    "denyWrite": [
                        format!("{cwd}/.git"),
                        "/Users/u/src/app/.git",
                        "/Users/u/Library/Application Support/parallax/uploads",
                        "/Users/u/Library/Application Support/parallax/tools/gh-shim",
                        "/Users/u/Library/Application Support/parallax/github-budget.json",
                        "/tmp/claude",
                        "/private/tmp/claude",
                        "~/.npm/_logs",
                        "~/.claude/debug",
                    ],
                },
                "credentials": {"envVars": [
                    {"name": "ANTHROPIC_API_KEY", "mode": "deny"},
                    {"name": "CLAUDE_CODE_MESSAGING_TOKEN", "mode": "deny"},
                ]},
            },
            "env": {"CLAUDE_CODE_TASK_LIST_ID": ""},
            "showThinkingSummaries": true,
        })
    );
    assert_eq!(
        argv[base + 1 + expected.len()..],
        [
            "--add-dir",
            "/Users/u/Library/Application Support/parallax/context/p",
            "--model",
            "claude-sonnet-4-6",
            "--effort",
            "high",
        ]
    );
    for flag in [
        "--setting-sources",
        "--allowedTools",
        "--dangerously-skip-permissions",
    ] {
        assert!(!argv.iter().any(|arg| arg == flag), "{flag}: {argv:?}");
    }
    fake.assert_no_inherited_credentials(Some("/tmp/claude-second-account"));
    // On Linux the flag would widen the sandbox's writes (PLX-20); `credentials` stands in for it.
    // The fake's base environment sets it, so this also checks that a worker drops it (PLX-112).
    let env = fake.env();
    assert!(
        !env.iter()
            .any(|var| var.starts_with("CLAUDE_CODE_SUBPROCESS_ENV_SCRUB=")),
        "{env:?}"
    );
    // The run's own temp folder (PLX-130).
    let temp = "CLAUDE_CODE_TMPDIR=/tmp/parallax-625c7f6d/Ab12Cd".to_owned();
    assert!(env.contains(&temp), "{env:?}");
}

/// Claude Code gives commands its temp folder only while `<folder>/claude-<uid>` fits in 44
/// bytes, and the shared one otherwise, so a longer folder refuses the worker (PLX-130).
#[test]
fn a_worker_s_temp_folder_must_leave_claude_code_room() {
    let uid = rustix::process::getuid().as_raw().to_string();
    let fits = format!(
        "/tmp/{}",
        "x".repeat(44 - "/tmp//claude-".len() - uid.len())
    );
    assert_eq!(
        super::worker_temp(Path::new(&fits)).unwrap(),
        Path::new(&fits)
    );
    let error = super::worker_temp(Path::new(&format!("{fits}x"))).unwrap_err();
    assert!(
        error.to_string().contains("every session shares"),
        "{error}"
    );
    // macOS's canonical `/private/tmp` is spelled `/tmp`, where it links, to save the room.
    let canonical = super::worker_temp(Path::new(&format!("/private{fits}")));
    if cfg!(target_os = "macos") {
        assert_eq!(canonical.unwrap(), Path::new(&fits));
    } else {
        assert!(canonical.is_err());
    }
}

/// PLX-97, 0027: a worker's permission picks Claude Code's mode of the same name, and its sandbox
/// settings stay the same, except in bypass, where Claude Code refuses `--restricted` and the
/// worker runs as full Claude Code. A no-write run's mode is fixed (0004), so it takes no
/// permission.
#[test]
fn a_worker_s_permission_picks_its_mode_inside_the_same_sandbox_but_bypass() {
    let cwd = Path::new("/Users/u/wt");
    let mut worker = request(cwd);
    worker.policy = ToolPolicy::WorkspaceWrite;
    worker.sandbox = Some(worker_sandbox(cwd));
    let args = |permission| -> Vec<String> {
        let request = RunRequest {
            permission,
            ..worker.clone()
        };
        super::arguments(&request)
            .unwrap()
            .into_iter()
            .map(|arg| arg.into_string().unwrap())
            .collect()
    };
    let after = |args: &[String], flag: &str| {
        let at = args.iter().position(|arg| arg == flag).unwrap();
        args[at + 1].clone()
    };
    let default = args(None);
    let edit = args(Some(AgentPermission::Edit));
    assert_eq!(default, edit);
    assert_eq!(after(&edit, "--permission-mode"), "acceptEdits");
    for (permission, mode) in [
        (AgentPermission::Auto, "auto"),
        (AgentPermission::Manual, "default"),
        (AgentPermission::Plan, "plan"),
    ] {
        let args = args(Some(permission));
        assert_eq!(after(&args, "--permission-mode"), mode);
        assert_eq!(after(&args, "--settings"), after(&edit, "--settings"));
        assert!(args.starts_with(&edit[..super::BASE_ARGS.len() + WORKSPACE_WRITE_ARGS.len()]));
        assert_eq!(
            args.iter()
                .filter(|arg| *arg == "--permission-mode")
                .count(),
            1
        );
    }
    let bypass = args(Some(AgentPermission::Bypass));
    assert_eq!(after(&bypass, "--permission-mode"), "bypassPermissions");
    for flag in ["--restricted", "--tools", "--strict-mcp-config"] {
        assert!(!bypass.contains(&flag.to_owned()), "{flag}: {bypass:?}");
    }
    // None of the sandbox's settings, only its task list's (PLX-251).
    assert_eq!(
        after(&bypass, "--settings"),
        r#"{"env":{"CLAUDE_CODE_TASK_LIST_ID":""},"showThinkingSummaries":true}"#
    );
    assert_eq!(
        bypass.iter().filter(|arg| *arg == "--add-dir").count(),
        edit.iter().filter(|arg| *arg == "--add-dir").count()
    );

    let no_write = RunRequest {
        permission: Some(AgentPermission::Edit),
        ..request(cwd)
    };
    assert!(matches!(
        super::arguments(&no_write),
        Err(StartError::Invalid(_))
    ));
}

#[test]
fn a_worker_without_a_usable_sandbox_is_refused_before_anything_runs() {
    let fake = Fake::new("tool-call");
    let mut worker = request(&fake.root());
    worker.policy = ToolPolicy::WorkspaceWrite;
    let refused = |request: RunRequest| match fake.backend.start(request) {
        Err(StartError::Invalid(message)) => message,
        Err(other) => panic!("expected Invalid, got {other:?}"),
        Ok(_) => panic!("expected Invalid, got a run"),
    };
    assert!(refused(worker.clone()).contains("0013"));

    let mut relative = worker_sandbox(&fake.root());
    relative.writable.push("context".into());
    worker.sandbox = Some(relative);
    assert!(refused(worker.clone()).contains("context"));

    let mut empty = worker_sandbox(&fake.root());
    empty.unreadable.clear();
    worker.sandbox = Some(empty);
    assert!(refused(worker.clone()).contains("nothing unreadable"));

    for glob in [
        "/Users/u/src/app[old]/.git",
        "/Users/u/src/app]/.git",
        "/Users/u/src/a*/.git",
        "/Users/u/src/a?/.git",
    ] {
        let mut sandbox = worker_sandbox(&fake.root());
        sandbox.read_only[1] = glob.into();
        worker.sandbox = Some(sandbox);
        assert!(refused(worker.clone()).contains(glob), "{glob}");
    }
    let mut glob_cwd = worker.clone();
    glob_cwd.sandbox = Some(worker_sandbox(&fake.root()));
    glob_cwd.cwd = "/Users/u/src/app[old]".into();
    assert!(refused(glob_cwd).contains("app[old]"));

    worker.sandbox = Some(worker_sandbox(&fake.root()));
    worker.account.credential = Credential::Subscription {
        config_home: Some("second-account".into()),
    };
    assert!(refused(worker.clone()).contains("second-account"));
    worker.account.credential = Credential::Subscription {
        config_home: Some("/Users/u/.claude-*".into()),
    };
    assert!(refused(worker).contains(".claude-*"));
    assert_eq!(fake.argv(), Vec::<String>::new(), "nothing ran");
}

#[tokio::test]
async fn a_worker_run_edits_in_its_cwd_and_reports_its_tool_calls() {
    let fake = Fake::new("tool-call");
    let mut request = request(&fake.root());
    request.policy = ToolPolicy::WorkspaceWrite;
    request.sandbox = Some(worker_sandbox(&fake.root()));
    request.model = Some("claude-sonnet-4-6".into());
    request.effort = Some(AgentEffort::High);
    request.account.credential = Credential::Subscription {
        config_home: Some("/tmp/claude-second-account".into()),
    };
    let all = run(&fake, request).await;
    assert_worker_invocation(&fake);

    let calls: Vec<(&str, &str)> = all
        .iter()
        .filter_map(|event| match event {
            Event::ToolCall { call_id, name, .. } => Some((call_id.as_str(), name.as_str())),
            _ => None,
        })
        .collect();
    assert_eq!(
        calls,
        [
            ("toolu_01Todo", "TodoWrite"),
            ("toolu_01Read", "Read"),
            ("toolu_01Edit", "Edit"),
            ("toolu_01Bash", "Bash"),
            ("toolu_01Glob", "Glob"),
        ]
    );
    let results: Vec<(&str, ToolStatus, Option<&str>)> = all
        .iter()
        .filter_map(|event| match event {
            Event::ToolResult {
                call_id,
                status,
                output,
                ..
            } => Some((call_id.as_str(), *status, output.as_deref())),
            _ => None,
        })
        .collect();
    assert_eq!(
        results[1],
        (
            "toolu_01Read",
            ToolStatus::Ok,
            Some("     1\tfn parse() {}")
        )
    );
    assert_eq!(results[2].1, ToolStatus::Ok);
    assert_eq!(
        results[3].1,
        ToolStatus::Denied,
        "permission_denied names it"
    );
    assert_eq!(
        results[4],
        (
            "toolu_01Glob",
            ToolStatus::Error,
            Some("Error: path does not exist")
        )
    );
    let edit = all.iter().find_map(|event| match event {
        Event::ToolCall { name, input, .. } if name == "Edit" => Some(input),
        _ => None,
    });
    assert_eq!(edit.unwrap()["new_string"], "i < n");
    assert!(all.contains(&Event::TodoList {
        items: vec![
            TodoItem {
                text: "Read the parser".into(),
                status: TodoStatus::Completed
            },
            TodoItem {
                text: "Fix the off-by-one".into(),
                status: TodoStatus::InProgress
            },
            TodoItem {
                text: "Run the tests".into(),
                status: TodoStatus::Pending
            },
        ]
    }));
    assert_eq!(
        outcome(&all),
        &Outcome::Completed {
            result: Some("Fixed the off-by-one in the parser. I couldn't run the tests.".into())
        }
    );
}

/// A subscription run whose init reports an API key, or a model served by another provider,
/// stops before any output (0004).
#[tokio::test]
async fn a_run_billed_elsewhere_is_stopped_at_once() {
    {
        let fake = Fake::new("api-key-source");
        let started = Instant::now();
        let all = run(&fake, request(&fake.root())).await;
        assert!(
            started.elapsed() < Duration::from_secs(5),
            "it hangs otherwise"
        );
        assert_eq!(
            all[0],
            Event::SessionStarted {
                session_id: SESSION.into(),
                model: Some(OPUS.into()),
                api_key_source: Some("ANTHROPIC_API_KEY".into()),
            }
        );
        assert!(texts(&all).is_empty(), "nothing after the init: {all:?}");
        let (kind, message) = failure(&all);
        assert_eq!(kind, FailureKind::UnexpectedApiKey);
        assert!(message.contains("\"ANTHROPIC_API_KEY\""), "{message}");
    }
    {
        let fake = Fake::new("provider");
        let all = run(&fake, request(&fake.root())).await;
        let (kind, message) = failure(&all);
        assert_eq!(kind, FailureKind::UnexpectedApiKey);
        assert!(message.contains("bedrock"), "{message}");
        assert!(
            !all.iter()
                .any(|event| matches!(event, Event::Usage(_) | Event::TurnFinished { .. })),
            "usage billed elsewhere isn't the account's: {all:?}"
        );
    }
}

/// A fork's first run continues a copy of the parent's session (0050).
#[test]
fn a_forks_first_run_forks_the_session() {
    let mut request = request(Path::new("/repo"));
    request.resume = Some(Resume {
        fork: true,
        ..Resume::new(SESSION)
    });
    let args: Vec<String> = super::arguments(&request)
        .unwrap()
        .into_iter()
        .map(|arg| arg.into_string().unwrap())
        .collect();
    assert_eq!(
        &args[args.len() - 3..],
        ["--resume", SESSION, "--fork-session"]
    );
}

/// Through the SDK sidecar's fake, a revert keeps the session (0062): `rewind` returns it, and the
/// next run resumes it at the cursor the kept turn reported.
#[tokio::test]
async fn a_revert_resumes_the_session_at_the_kept_turns_cursor() {
    let fake = Fake::new("read-only");
    let cwd = fake.root();
    let capabilities = fake.backend.capabilities();
    assert!(capabilities.rewind && capabilities.resume_at);
    let first = run(&fake, request(&cwd)).await;
    let cursor = first
        .iter()
        .find_map(|event| match event {
            Event::TurnCursor { cursor, .. } => Some(cursor.clone()),
            _ => None,
        })
        .expect("the turn's cursor");
    let rewind = Rewind {
        session_id: SESSION.into(),
        cwd: cwd.clone(),
        turns: 1,
    };
    let session = fake.backend.rewind(rewind).await.unwrap();
    assert_eq!(session, SESSION);

    let mut next = request(&cwd);
    next.resume = Some(Resume {
        at: Some(cursor.clone()),
        ..Resume::new(session)
    });
    run(&fake, next).await;
    let argv = fake.argv();
    assert_eq!(
        &argv[argv.len() - 4..],
        ["--resume", SESSION, "--resume-session-at", cursor.as_str()]
    );
}

// #118: an API key account.

fn api_key_request(cwd: &Path, key: &str) -> RunRequest {
    let mut request = request(cwd);
    request.account = AccountRef {
        id: "anthropic-key".into(),
        credential: Credential::ApiKey(ApiKey::new(key.into())),
    };
    request
}

#[tokio::test]
async fn an_api_key_account_gets_only_its_key_and_reports_it_as_the_source() {
    let fake = Fake::new("api-key-completed");
    let key = "sk-ant-api03-test-key-not-real";
    let all = run(&fake, api_key_request(&fake.root(), key)).await;
    assert_eq!(
        all[0],
        Event::SessionStarted {
            session_id: SESSION.into(),
            model: Some(OPUS.into()),
            api_key_source: Some("ANTHROPIC_API_KEY".into()),
        }
    );
    assert!(
        matches!(outcome(&all), Outcome::Completed { .. }),
        "{all:?}"
    );
    let env = fake.env();
    // Every other inherited credential is scrubbed; ANTHROPIC_API_KEY is Parallax's own value, not
    // the poisoned inherited one INHERITED_CREDENTIALS set.
    for (name, value) in INHERITED_CREDENTIALS {
        let prefix = format!("{name}=");
        let leaked: Vec<&String> = env
            .iter()
            .filter(|var| var.starts_with(&prefix))
            .filter(|var| *name != "ANTHROPIC_API_KEY" || var.ends_with(value))
            .collect();
        assert!(leaked.is_empty(), "{name} leaked: {leaked:?}");
    }
    assert!(env.contains(&format!("ANTHROPIC_API_KEY={key}")), "{env:?}");
    assert!(
        env.contains(&"CLAUDE_CODE_SUBPROCESS_ENV_SCRUB=1".to_owned()),
        "{env:?}"
    );
    let serialized = format!("{all:?}");
    assert!(
        !serialized.contains(key),
        "the key must not appear in an event: {serialized}"
    );
}

#[tokio::test]
async fn an_api_key_never_reaches_tracing_output() {
    use std::io::Write;
    use std::sync::{Arc, Mutex};

    #[derive(Clone, Default)]
    struct Capture(Arc<Mutex<Vec<u8>>>);

    impl Write for Capture {
        fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
            self.0.lock().unwrap().extend_from_slice(buf);
            Ok(buf.len())
        }

        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }

    let capture = Capture::default();
    let for_writer = capture.clone();
    let subscriber = tracing_subscriber::fmt()
        .with_max_level(tracing::Level::TRACE)
        .with_writer(move || for_writer.clone())
        .finish();
    let guard = tracing::subscriber::set_default(subscriber);
    let key = "sk-ant-api03-test-key-not-real";

    // A completed run and a failed one (the mismatch check), so both outcomes are covered.
    let completed = Fake::new("api-key-completed");
    let completed_request = api_key_request(&completed.root(), key);
    assert!(
        !format!("{completed_request:?}").contains(key),
        "the key must not appear in a request's Debug output"
    );
    tracing::info!("parallax-test-sentinel: starting the completed run");
    let all = run(&completed, completed_request).await;
    assert!(
        matches!(outcome(&all), Outcome::Completed { .. }),
        "{all:?}"
    );

    let mismatched = Fake::new("read-only");
    tracing::info!("parallax-test-sentinel: starting the mismatched run");
    let all = run(&mismatched, api_key_request(&mismatched.root(), key)).await;
    assert_eq!(failure(&all).0, FailureKind::UnexpectedApiKey);

    drop(guard);
    let logged = String::from_utf8_lossy(&capture.0.lock().unwrap()).into_owned();
    assert!(
        logged.contains("parallax-test-sentinel: starting the mismatched run"),
        "the capture never saw anything, so it can't prove the key's absence: {logged:?}"
    );
    assert!(
        !logged.contains(key),
        "the key leaked into tracing output: {logged}"
    );
}

#[tokio::test]
async fn malformed_lines_warn_and_unknown_types_are_skipped_quietly() {
    let fake = Fake::new("malformed");
    let all = run(&fake, request(&fake.root())).await;
    assert_eq!(
        warnings(&all),
        [
            WarningKind::MalformedLine,
            WarningKind::MalformedLine,
            WarningKind::MalformedLine,
            WarningKind::MalformedLine,
        ]
    );
    assert_eq!(texts(&all), ["Still here."]);
    assert_eq!(
        outcome(&all),
        &Outcome::Completed {
            result: Some("Still here.".into())
        }
    );
}

/// A steer goes into the running turn as the SDK's `priority: "now"` (0061), and the CLI folds it
/// in.
#[tokio::test]
async fn a_follow_up_during_a_turn_that_the_cli_folds_in_finishes_with_it() {
    let fake = Fake::new("follow-up-folded");
    let Started { run, mut events } = launch(&fake.backend, request(&fake.root())).await;
    assert!(matches!(
        next(&mut events).await,
        Event::SessionStarted { .. }
    ));
    assert!(matches!(next(&mut events).await, Event::Text { .. }));
    let follow_up = FollowUp {
        turn_id: turn(TURN_2),
        text: "Fix the tests too.".into(),
        images: Vec::new(),
        steer: true,
        model: None,
        permission: None,
    };
    run.send(follow_up.clone()).unwrap();
    run.send(follow_up).unwrap();
    let all = rest(&mut events).await;
    let turns: Vec<&Event> = all
        .iter()
        .filter(|event| {
            matches!(
                event,
                Event::TurnStarted { .. } | Event::TurnFinished { .. } | Event::Text { .. }
            )
        })
        .collect();
    let done = Some("Parser and tests done.".to_owned());
    assert_eq!(
        turns,
        [
            &Event::TurnStarted {
                turn_id: Some(turn(TURN_2))
            },
            &Event::Text {
                message_id: Some("msg_01Ff2".into()),
                text: "And the tests, as you asked.".into()
            },
            &Event::TurnFinished {
                turn_id: Some(turn(TURN_1)),
                result: done.clone(),
                failed: false,
            },
            &Event::TurnFinished {
                turn_id: Some(turn(TURN_2)),
                result: done,
                failed: false,
            },
        ]
    );
    let stdin = fake.stdin();
    assert_eq!(stdin.len(), 2, "sent once: {stdin:?}");
    assert_eq!(stdin[1]["uuid"], TURN_2);
    assert_eq!(stdin[1]["message"]["content"], "Fix the tests too.");
    assert_eq!(stdin[1]["priority"], "now");
    assert_eq!(stdin[0].get("priority"), None, "the prompt isn't a steer");
    assert!(matches!(outcome(&all), Outcome::Completed { .. }));
    assert_eq!(
        run.send(FollowUp {
            turn_id: TurnId::generate(),
            text: "too late".into(),
            images: Vec::new(),
            steer: false,
            model: None,
            permission: None,
        }),
        Err(SendError::Finished)
    );
}

#[tokio::test]
async fn a_follow_up_can_be_its_own_turn_and_stdin_waits_for_it() {
    let fake = Fake::new("follow-up-turns");
    let Started { run, mut events } = launch(&fake.backend, request(&fake.root())).await;
    assert!(matches!(
        next(&mut events).await,
        Event::SessionStarted { .. }
    ));
    assert!(matches!(next(&mut events).await, Event::Text { .. }));
    run.send(FollowUp {
        turn_id: turn(TURN_2),
        text: "And now the docs.".into(),
        images: Vec::new(),
        steer: false,
        model: None,
        permission: None,
    })
    .unwrap();
    let all = rest(&mut events).await;
    let sessions = all
        .iter()
        .filter(|event| matches!(event, Event::SessionStarted { .. }))
        .count();
    assert_eq!(
        sessions, 0,
        "the second turn's init repeats the same session"
    );
    let turns: Vec<&Event> = all
        .iter()
        .filter(|event| {
            matches!(
                event,
                Event::TurnStarted { .. } | Event::TurnFinished { .. }
            )
        })
        .collect();
    assert_eq!(
        turns,
        [
            &Event::TurnStarted {
                turn_id: Some(turn(TURN_2))
            },
            &Event::TurnFinished {
                turn_id: Some(turn(TURN_1)),
                result: Some("First answer.".into()),
                failed: false,
            },
            &Event::TurnFinished {
                turn_id: Some(turn(TURN_2)),
                result: Some("Second answer.".into()),
                failed: false,
            },
        ]
    );
    let usage: u64 = all
        .iter()
        .filter_map(|event| match event {
            Event::Usage(delta) => Some(delta.usage.output_tokens),
            _ => None,
        })
        .sum();
    assert_eq!(usage, 220, "cumulative totals across turns become deltas");
    assert_eq!(
        outcome(&all),
        &Outcome::Completed {
            result: Some("Second answer.".into())
        }
    );
}

#[tokio::test]
async fn images_go_before_the_text_as_base64_blocks_and_a_message_of_images_alone_has_no_text() {
    let png = PromptImage {
        media_type: ImageMediaType::Png,
        data: "iVBORw0KGgo=".into(),
    };
    let gif = PromptImage {
        media_type: ImageMediaType::Gif,
        data: "R0lGODlh".into(),
    };
    let fake = Fake::new("follow-up-turns");
    let request = RunRequest {
        images: vec![png, gif.clone()],
        ..request(&fake.root())
    };
    let Started { run, mut events } = launch(&fake.backend, request).await;
    assert!(matches!(
        next(&mut events).await,
        Event::SessionStarted { .. }
    ));
    run.send(FollowUp {
        turn_id: turn(TURN_2),
        text: String::new(),
        images: vec![gif],
        steer: false,
        model: None,
        permission: None,
    })
    .unwrap();
    rest(&mut events).await;
    let block = |media_type: &str, data: &str| {
        serde_json::json!({
            "type": "image",
            "source": {"type": "base64", "media_type": media_type, "data": data},
        })
    };
    let text = |text: &str| serde_json::json!({"type": "text", "text": text});
    let stdin = fake.stdin();
    assert_eq!(
        stdin[0]["message"]["content"],
        serde_json::json!([
            block("image/png", "iVBORw0KGgo="),
            block("image/gif", "R0lGODlh"),
            text("Summarize the README.\nKeep it short."),
        ])
    );
    assert_eq!(
        stdin[1]["message"]["content"],
        serde_json::json!([block("image/gif", "R0lGODlh")])
    );
}

/// Cancel is the SDK's `interrupt()`, which ends the CLI's turn as `SIGINT` did, then the end of
/// its prompt.
#[tokio::test]
async fn cancel_interrupts_the_cli() {
    let fake = Fake::new("cancel");
    let Started { run, mut events } = launch(&fake.backend, request(&fake.root())).await;
    assert!(matches!(
        next(&mut events).await,
        Event::SessionStarted { .. }
    ));
    // The fake sidecar prints `@trap-armed` once an interrupt would end the query (fake-sdk.sh),
    // which the translator reports as a malformed line. Waiting for it here keeps cancel() below
    // from racing it (#149).
    assert!(matches!(
        next(&mut events).await,
        Event::Warning {
            warning: WarningKind::MalformedLine,
            ..
        }
    ));
    assert!(matches!(next(&mut events).await, Event::Text { .. }));
    let started = Instant::now();
    run.cancel();
    run.cancel();
    let all = rest(&mut events).await;
    assert_eq!(
        all,
        [Event::Finished {
            outcome: Outcome::Cancelled,
            usage_totals: Vec::new()
        }]
    );
    assert!(started.elapsed() < Duration::from_secs(5));
    assert_eq!(fake.recorded("signals"), "SIGINT\n");
}

/// A revert ends a thread's live session, which exits at the interrupt, and the next turn starts
/// a new session under the same run id (PLX-712). The cancelled session's grace-period kill must
/// not reach it, even when its turn outlasts the grace period.
#[tokio::test]
async fn a_cancelled_sessions_kill_spares_the_next_session_of_its_run() {
    let fake = Fake::new("cancel");
    let backend = fake.backend.clone().with_grace(Duration::from_millis(300));
    let first = request(&fake.root());
    let run_id = first.run_id;
    let Started { run, mut events } = launch(&backend, first).await;
    assert!(matches!(
        next(&mut events).await,
        Event::SessionStarted { .. }
    ));
    // `@trap-armed`: an interrupt ends the query from here.
    assert!(matches!(next(&mut events).await, Event::Warning { .. }));
    assert!(matches!(next(&mut events).await, Event::Text { .. }));
    run.cancel();
    assert_eq!(outcome(&rest(&mut events).await), &Outcome::Cancelled);

    let slow =
        fixture("read-only").replace("\n{\"type\":\"result\"", "\n@sleep 1\n{\"type\":\"result\"");
    fs::write(fake.root().join("fixture.jsonl"), slow).unwrap();
    let second = RunRequest {
        run_id,
        ..request(&fake.root())
    };
    let Started {
        run: _run,
        mut events,
    } = launch(&backend, second).await;
    let all = rest(&mut events).await;
    assert!(
        matches!(outcome(&all), Outcome::Completed { .. }),
        "{all:?}"
    );
}

#[tokio::test]
async fn bad_requests_are_refused_before_spawning() {
    let fake = Fake::new("read-only");
    let cwd = fake.root();
    let mut empty = request(&cwd);
    empty.prompt.clear();
    let mut flag_model = request(&cwd);
    flag_model.model = Some("--dangerously-skip-permissions".into());
    let mut spaced_resume = request(&cwd);
    spaced_resume.resume = Some(Resume::new("a session"));
    for bad in [empty, flag_model, spaced_resume] {
        assert!(
            matches!(fake.backend.start(bad), Err(StartError::Invalid(_))),
            "accepted"
        );
    }
    let missing = fake.backend.clone().with_program("claude-not-installed");
    assert!(matches!(
        missing.start(request(&cwd)),
        Err(StartError::Spawn(SpawnError::NotFound { .. }))
    ));
    assert_eq!(fake.argv(), Vec::<String>::new(), "nothing ran");
}

/// Output before the init, or an init whose version, permission mode, or tool list breaks the
/// run's policy (0004, 0013), stops the run.
#[allow(clippy::too_many_lines, reason = "one table of distinct cases")]
#[test]
fn an_init_outside_the_run_s_policy_is_refused() {
    {
        // An init whose version, permission mode, or tool list breaks the run's policy (0004, 0013) stops it.
        {
            for (reported, refused) in [
                ("2.1.247", true),
                ("2.0.999", true),
                ("1.9.300", true),
                ("not-a-version", true),
                ("2.1.248", false),
                ("2.1.281", false),
                ("2.2.0", false),
                ("10.0.0-beta.1", false),
            ] {
                let mut translator = Translator::new(ToolPolicy::WorkspaceWrite, "none");
                let steps = translator.line(&init_with_version(r#"["Bash"]"#, reported));
                let expected = refused.then_some(FailureKind::PolicyViolation);
                assert_eq!(violation_kind(&steps), expected, "{reported}");
            }
            let mut translator = Translator::new(ToolPolicy::WorkspaceWrite, "none");
            let unversioned =
                br#"{"type":"system","subtype":"init","session_id":"s","apiKeySource":"none","tools":["Bash"]}"#;
            assert_eq!(
                violation_kind(&translator.line(unversioned)),
                Some(FailureKind::PolicyViolation)
            );
            let mut translator = Translator::new(ToolPolicy::NoWrite, "none");
            let old_reader = init_with_version(r#"["Read"]"#, "2.1.200");
            assert_eq!(
                violation_kind(&translator.line(&old_reader)),
                None,
                "no-write runs have no floor"
            );
        }
        {
            let init = |mode: &str| {
                format!(
                    r#"{{"type":"system","subtype":"init","session_id":"s","apiKeySource":"none","claude_code_version":"2.1.283","tools":["Read"]{mode}}}"#
                )
            };
            for (mode, refused) in [
                (r#","permissionMode":"acceptEdits""#, false),
                (r#","permissionMode":"default""#, true),
                (r#","permissionMode":"bypassPermissions""#, true),
                ("", true),
            ] {
                let mut translator = Translator::new(ToolPolicy::WorkspaceWrite, "none");
                let steps = translator.line(init(mode).as_bytes());
                let expected = refused.then_some(FailureKind::PolicyViolation);
                assert_eq!(violation_kind(&steps), expected, "{mode}");
            }
            // A plan worker (PLX-97) must report plan mode, and scrub mode's "default" still fails it.
            for (mode, refused) in [
                (r#","permissionMode":"plan""#, false),
                (r#","permissionMode":"acceptEdits""#, true),
                (r#","permissionMode":"default""#, true),
            ] {
                let mut translator = Translator::new(ToolPolicy::WorkspaceWrite, "none")
                    .with_permission_mode("plan");
                let steps = translator.line(init(mode).as_bytes());
                let expected = refused.then_some(FailureKind::PolicyViolation);
                assert_eq!(violation_kind(&steps), expected, "{mode}");
            }
            // plxd sets CLAUDE_CODE_SUBPROCESS_ENV_SCRUB for a no-write run, which forces "default".
            let mut translator = Translator::new(ToolPolicy::NoWrite, "none");
            let steps = translator.line(init(r#","permissionMode":"default""#).as_bytes());
            assert_eq!(violation_kind(&steps), None);
        }
        {
            // An older Claude Code, or `CLAUDE_CODE_ENABLE_TASKS=false`, lists `TodoWrite`; 2.1.283 lists
            // the task tools in its place (PLX-248).
            for todo_tools in [
                r#""TodoWrite""#,
                r#""TaskCreate","TaskGet","TaskList","TaskUpdate""#,
            ] {
                let allowed = init_line(&format!(
                    r#"["Read","Edit","Write","Glob","Grep","NotebookEdit","Bash","WebFetch","WebSearch",{todo_tools},"EndConversation"]"#
                ));
                let mut translator = Translator::new(ToolPolicy::WorkspaceWrite, "none");
                assert_eq!(
                    violation_kind(&translator.line(&allowed)),
                    None,
                    "{todo_tools}"
                );
            }
            for extra in [
                r#"["Bash","Monitor"]"#,
                r#"["Bash","Task"]"#,
                r#"["Bash","Agent"]"#,
                r#"["Bash","Skill"]"#,
                r#"["Bash","mcp__github__create_issue"]"#,
                // Background tasks' tools, which share the task tools' prefix but not their purpose.
                r#"["TaskCreate","TaskStop"]"#,
                r#"["TaskCreate","TaskOutput"]"#,
            ] {
                let mut translator = Translator::new(ToolPolicy::WorkspaceWrite, "none");
                assert_eq!(
                    violation_kind(&translator.line(&init_line(extra))),
                    Some(FailureKind::PolicyViolation),
                    "{extra}"
                );
            }
        }
        {
            let allowed = init_line(r#"["Read","Glob","Grep","EndConversation"]"#);
            let mut translator = Translator::new(ToolPolicy::NoWrite, "none");
            assert_eq!(violation_kind(&translator.line(&allowed)), None);
            for extra in [
                r#"["Read","WebFetch"]"#,
                r#"["Read","Task"]"#,
                r#"["Read","mcp__github__create_issue"]"#,
                r#"["Read",7]"#,
            ] {
                let mut translator = Translator::new(ToolPolicy::NoWrite, "none");
                assert_eq!(
                    violation_kind(&translator.line(&init_line(extra))),
                    Some(FailureKind::PolicyViolation),
                    "{extra}"
                );
            }
            let mut translator = Translator::new(ToolPolicy::NoWrite, "none");
            let no_tools =
                br#"{"type":"system","subtype":"init","session_id":"s","apiKeySource":"none"}"#;
            assert_eq!(
                violation_kind(&translator.line(no_tools)),
                Some(FailureKind::PolicyViolation)
            );
        }
    }
    {
        let mut translator = Translator::new(ToolPolicy::NoWrite, "none");
        let assistant =
            br#"{"type":"assistant","message":{"id":"m","content":[{"type":"text","text":"hi"}]}}"#;
        assert!(matches!(
            translator.line(assistant).as_slice(),
            [Step::Violation(failure)] if failure.failure == FailureKind::UnexpectedApiKey
        ));
    }
}

fn init_line(tools: &str) -> Vec<u8> {
    init_with_version(tools, "2.1.281")
}

/// An init line in a worker's permission mode. No-write runs don't check theirs.
fn init_with_version(tools: &str, version: &str) -> Vec<u8> {
    format!(
        r#"{{"type":"system","subtype":"init","session_id":"s","apiKeySource":"none","claude_code_version":"{version}","permissionMode":"acceptEdits","tools":{tools}}}"#
    )
    .into_bytes()
}

fn violation_kind(steps: &[Step]) -> Option<FailureKind> {
    steps.iter().find_map(|step| match step {
        Step::Violation(failure) => Some(failure.failure),
        _ => None,
    })
}

/// PLX-276, 0034: a thread is full Claude Code in every mode, as a bypass worker is: no
/// `--restricted`, `--tools`, `--strict-mcp-config`, or sandbox settings, so the user's settings,
/// skills, and MCP servers load. It asks plxd in every mode, Accept Edits since nothing sandboxes
/// its commands and Bypass for a mode it may switch to while it runs, which
/// `--allow-dangerously-skip-permissions` allows, and in Plan it has `ExitPlanMode` without a
/// `--tools` list. Its init may list any tool. A worker keeps its sandbox, and so does a thread
/// whose client can't answer requests.
#[test]
fn a_thread_is_full_claude_code_in_every_mode() {
    let cwd = Path::new("/Users/u/wt");
    let mut thread = request(cwd);
    thread.policy = ToolPolicy::WorkspaceWrite;
    thread.sandbox = Some(worker_sandbox(cwd));
    thread.approvals = true;
    thread.thread = true;
    for permission in [
        None,
        Some(AgentPermission::Auto),
        Some(AgentPermission::Manual),
        Some(AgentPermission::Edit),
        Some(AgentPermission::Plan),
        Some(AgentPermission::Bypass),
    ] {
        let request = RunRequest {
            permission,
            ..thread.clone()
        };
        let args: Vec<String> = super::arguments(&request)
            .unwrap()
            .into_iter()
            .map(|arg| arg.into_string().unwrap())
            .collect();
        for flag in ["--restricted", "--tools", "--strict-mcp-config"] {
            assert!(
                !args.contains(&flag.to_owned()),
                "{permission:?} {flag}: {args:?}"
            );
        }
        let settings = args.iter().position(|arg| arg == "--settings").unwrap();
        assert_eq!(
            args[settings + 1],
            r#"{"env":{"CLAUDE_CODE_TASK_LIST_ID":""},"showThinkingSummaries":true}"#
        );
        assert!(super::prompts(&request), "{permission:?}");
        assert!(args.contains(&LIVE_MODE_ARGS[0].to_owned()), "{args:?}");
        assert!(!super::hands_over_plans(&request));
    }
    let unanswered = RunRequest {
        approvals: false,
        ..thread.clone()
    };
    let args = super::arguments(&unanswered).unwrap();
    assert!(args.contains(&"--restricted".into()));
    assert!(!args.contains(&LIVE_MODE_ARGS[0].into()));
    let worker = RunRequest {
        thread: false,
        ..thread
    };
    assert!(
        super::arguments(&worker)
            .unwrap()
            .contains(&"--restricted".into())
    );
    assert!(
        !super::prompts(&worker),
        "a sandboxed worker in Accept Edits never asks"
    );

    let loaded = init_line(r#"["Read","Bash","Skill","Task","mcp__linear__list_issues"]"#);
    let mut translator = Translator::new(ToolPolicy::WorkspaceWrite, "none").with_thread(true);
    assert_eq!(violation_kind(&translator.line(&loaded)), None);
    let mut translator = Translator::new(ToolPolicy::WorkspaceWrite, "none");
    assert_eq!(
        violation_kind(&translator.line(&loaded)),
        Some(FailureKind::PolicyViolation)
    );
}

/// 0041: a full Claude Code thread gets `plxd mcp --thread <its run>` through `--mcp-config`,
/// with no `--strict-mcp-config`, so the user's own MCP servers stay, and the tools lead its
/// `--allowedTools`, so they run in every mode. A sandboxed thread gets none, since the server
/// runs outside the sandbox.
#[test]
fn a_full_thread_gets_its_thread_tools_beside_the_users_mcp_servers() {
    let cwd = Path::new("/Users/u/wt");
    let tools = ThreadTools {
        program: PathBuf::from("/Applications/Parallax.app/Contents/Resources/plxd"),
        data_dir: PathBuf::from("/Users/u/Library/Application Support/parallax"),
        run: RunId::generate(),
    };
    let mut thread = request(cwd);
    thread.policy = ToolPolicy::WorkspaceWrite;
    thread.sandbox = Some(worker_sandbox(cwd));
    thread.approvals = true;
    thread.thread = true;
    thread.thread_tools = Some(tools.clone());
    let config = serde_json::json!({"mcpServers": {"plxd": {
        "type": "stdio",
        "command": "/Applications/Parallax.app/Contents/Resources/plxd",
        "args": [
            "mcp",
            "--data-dir", "/Users/u/Library/Application Support/parallax",
            "--thread", tools.run.to_string(),
        ],
    }}});
    let allowed = format!(
        "{},TodoWrite,TaskCreate,TaskGet,TaskList,TaskUpdate",
        mcp::thread::ALLOWED_TOOLS.join(",")
    );
    for permission in [
        None,
        Some(AgentPermission::Manual),
        Some(AgentPermission::Plan),
    ] {
        let request = RunRequest {
            permission,
            ..thread.clone()
        };
        let args: Vec<String> = super::arguments(&request)
            .unwrap()
            .into_iter()
            .map(|arg| arg.into_string().unwrap())
            .collect();
        let at = args.iter().position(|arg| arg == "--mcp-config").unwrap();
        assert_eq!(args[at + 1], config.to_string(), "{permission:?}");
        assert_eq!(
            args[at + 2..at + 4],
            ["--allowedTools".to_owned(), allowed.clone()]
        );
        assert!(!args.contains(&"--strict-mcp-config".to_owned()));
    }
    let sandboxed = RunRequest {
        approvals: false,
        ..thread
    };
    let args = super::arguments(&sandboxed).unwrap();
    assert!(args.contains(&"--strict-mcp-config".into()));
    assert!(!args.contains(&"--mcp-config".into()));
}

fn failed_result() -> &'static [u8] {
    br#"{"type":"result","subtype":"success","is_error":true,"result":"API Error"}"#
}

fn last_failure(translator: &Translator) -> FailureKind {
    translator.last_failure.as_ref().unwrap().failure
}

/// A failed turn's kind, which routing falls back on (0012): a retry's error or a rejected
/// limit names it until the turn ends, and a resume of a session Claude Code lost is a lost
/// session (PLX-937).
#[test]
fn a_failed_turn_names_its_kind() {
    {
        let mut translator = Translator::new(ToolPolicy::WorkspaceWrite, "none");
        translator.line(&init_line(r#"["Read"]"#));
        for (error, kind) in [
            ("rate_limit", FailureKind::RateLimited),
            ("authentication_failed", FailureKind::NotSignedIn),
            ("overloaded", FailureKind::VendorError),
        ] {
            let retry = format!(r#"{{"type":"system","subtype":"api_retry","error":"{error}"}}"#);
            translator.line(retry.as_bytes());
            translator.line(failed_result());
            assert_eq!(last_failure(&translator), kind, "{error}");
        }

        let rejected = br#"{"type":"rate_limit_event","rate_limit_info":{"status":"rejected","rateLimitType":"five_hour"}}"#;
        translator.line(rejected);
        translator.line(failed_result());
        assert_eq!(last_failure(&translator), FailureKind::RateLimited);
        translator.line(failed_result());
        assert_eq!(
            last_failure(&translator),
            FailureKind::VendorError,
            "the next turn starts clean"
        );

        translator.line(rejected);
        let max_turns = br#"{"type":"result","subtype":"error_max_turns","is_error":true}"#;
        translator.line(max_turns);
        assert_eq!(
            last_failure(&translator),
            FailureKind::VendorError,
            "a limit the run set says nothing about the account"
        );
    }
    {
        // PLX-937: `--resume` with a session Claude Code no longer has fails as a lost session, as
        // 2.1.309 reports it, before any `init`.
        let mut translator = Translator::new(ToolPolicy::NoWrite, "none");
        let lost = br#"{"type":"result","subtype":"error_during_execution","is_error":true,"num_turns":0,"session_id":"gone","errors":["No conversation found with session ID: gone"]}"#;
        translator.line(lost);
        let failure = translator.last_failure.as_ref().unwrap();
        assert_eq!(failure.failure, FailureKind::SessionNotFound);
        assert_eq!(
            failure.message,
            "No conversation found with session ID: gone"
        );
    }
}

/// A coordinator's request at `cwd`, whose plxd tools make it full Claude Code (0027).
fn coordinator(cwd: &Path) -> RunRequest {
    RunRequest {
        coordinator_tools: Some(ThreadTools {
            program: PathBuf::from("/Applications/Parallax.app/Contents/Resources/plxd"),
            data_dir: cwd.join("data"),
            run: RunId::generate(),
        }),
        ..request(cwd)
    }
}

/// PLX-222: Manual, Auto, and Plan ask plxd over stdio, right after the mode, for a worker and a
/// coordinator alike, when the client answers. Without `approvals`, every mode runs as before, as
/// do Accept Edits and Bypass Permissions, and a plain no-write run never asks.
#[test]
fn only_the_modes_that_prompt_ask_plxd_over_stdio_and_only_with_approvals() {
    let cwd = Path::new("/Users/u/wt");
    let mut worker = request(cwd);
    worker.policy = ToolPolicy::WorkspaceWrite;
    worker.sandbox = Some(worker_sandbox(cwd));
    for (base, approvals) in [
        (worker.clone(), true),
        (coordinator(cwd), true),
        (worker, false),
        (coordinator(cwd), false),
    ] {
        for (permission, prompting) in [
            (None, false),
            (Some(AgentPermission::Edit), false),
            (Some(AgentPermission::Bypass), false),
            (Some(AgentPermission::Manual), true),
            (Some(AgentPermission::Auto), true),
            (Some(AgentPermission::Plan), true),
        ] {
            let expected = prompting && approvals;
            let request = RunRequest {
                permission,
                approvals,
                ..base.clone()
            };
            let args: Vec<String> = super::arguments(&request)
                .unwrap()
                .into_iter()
                .map(|arg| arg.into_string().unwrap())
                .collect();
            let mode = args.iter().position(|arg| arg == "--permission-mode");
            let prompt_tool = args.iter().position(|arg| arg == PROMPT_TOOL_ARGS[0]);
            assert_eq!(super::prompts(&request), expected, "{permission:?}");
            if expected {
                assert_eq!(prompt_tool, mode.map(|mode| mode + 2), "{args:?}");
                assert_eq!(args[prompt_tool.unwrap() + 1], PROMPT_TOOL_ARGS[1]);
            } else {
                assert_eq!(prompt_tool, None, "{args:?}");
            }
            // The prompt channel, and a plan worker's `ExitPlanMode` (PLX-243), are the only
            // arguments `approvals` changes.
            if !approvals {
                let mut asking: Vec<String> = super::arguments(&RunRequest {
                    approvals: true,
                    ..request.clone()
                })
                .unwrap()
                .into_iter()
                .map(|arg| arg.into_string().unwrap())
                .collect();
                if let Some(at) = asking.iter().position(|arg| arg == PROMPT_TOOL_ARGS[0]) {
                    asking.drain(at..at + PROMPT_TOOL_ARGS.len());
                }
                if let Some(tools) = asking
                    .iter_mut()
                    .find(|arg| arg.as_str() == PLAN_WORKER_TOOL_LIST)
                {
                    WORKER_TOOL_LIST.clone_into(tools);
                }
                assert_eq!(args, asking, "{permission:?}");
            }
        }
    }
    let plain = RunRequest {
        approvals: true,
        ..request(cwd)
    };
    assert!(!super::prompts(&plain));
    assert!(
        !super::arguments(&plain)
            .unwrap()
            .contains(&PROMPT_TOOL_ARGS[0].into())
    );
}

/// PLX-222: an allow, a denial, or an edited input goes back on stdin as the Agent SDK writes it.
#[allow(clippy::too_many_lines, reason = "one table of distinct cases")]
#[tokio::test]
async fn an_answer_reaches_the_cli_as_the_user_gave_it() {
    {
        // PLX-222: in Manual, Claude Code's `can_use_tool` becomes a permission request, and an allow
        // goes back on stdin as the Agent SDK writes it: the input it asked with, and with `always`, only
        // its allow rules, for the session. Its other suggestions are dropped.
        let fake = Fake::new("approval");
        let request = RunRequest {
            permission: Some(AgentPermission::Manual),
            approvals: true,
            ..coordinator(&fake.root())
        };
        let Started { run, mut events } = launch(&fake.backend, request).await;
        let asked = until_asked(&mut events).await;
        assert_eq!(asked.tool_name, "Bash");
        assert_eq!(
            asked.input,
            serde_json::json!({"command": "pnpm test", "description": "Run the tests"})
        );
        assert_eq!(asked.call_id.as_deref(), Some("toolu_01Ap1"));
        assert_eq!(asked.always_allow, ["Bash(pnpm test:*)"]);
        assert_eq!(
            asked.reason.as_deref(),
            Some("Current permission mode (Default) requires approval for this Bash command"),
            "terminal escapes are removed"
        );
        assert!(!asked.interactive);
        run.answer(Answer {
            approval_id: asked.approval_id,
            decision: Decision::Allow {
                input: None,
                always: true,
            },
        })
        .unwrap();
        let all = rest(&mut events).await;
        assert_eq!(
            outcome(&all),
            &Outcome::Completed {
                result: Some("Ran the tests.".into())
            }
        );
        let argv = fake.argv();
        let mode = argv
            .iter()
            .position(|arg| arg == "--permission-mode")
            .unwrap();
        assert_eq!(
            argv[mode..mode + 4],
            [
                "--permission-mode",
                "default",
                "--permission-prompt-tool",
                "stdio"
            ]
        );
        assert_eq!(
            fake.stdin()[1],
            serde_json::json!({
                "type": "control_response",
                "response": {
                    "subtype": "success",
                    "request_id": "req-ap-1",
                    "response": {
                        "behavior": "allow",
                        "updatedInput": {"command": "pnpm test", "description": "Run the tests"},
                        "updatedPermissions": [{
                            "type": "addRules",
                            "rules": [{"toolName": "Bash", "ruleContent": "pnpm test:*"}],
                            "behavior": "allow",
                            "destination": "session",
                        }],
                        "toolUseID": "toolu_01Ap1",
                    },
                },
            })
        );
    }
    {
        // PLX-222: a denial goes back with its message, and an edited input replaces the one asked with.
        for (decision, expected) in [
            (
                Decision::Deny {
                    message: "Not the whole suite.".into(),
                    interrupt: false,
                },
                serde_json::json!({
                    "behavior": "deny",
                    "message": "Not the whole suite.",
                    "interrupt": false,
                    "toolUseID": "toolu_01Ap1",
                }),
            ),
            (
                Decision::Allow {
                    input: Some(serde_json::json!({"command": "pnpm test parser"})),
                    always: false,
                },
                serde_json::json!({
                    "behavior": "allow",
                    "updatedInput": {"command": "pnpm test parser"},
                    "toolUseID": "toolu_01Ap1",
                }),
            ),
        ] {
            let fake = Fake::new("approval");
            let request = RunRequest {
                permission: Some(AgentPermission::Manual),
                approvals: true,
                ..coordinator(&fake.root())
            };
            let Started { run, mut events } = launch(&fake.backend, request).await;
            let asked = until_asked(&mut events).await;
            run.answer(Answer {
                approval_id: asked.approval_id,
                decision,
            })
            .unwrap();
            rest(&mut events).await;
            assert_eq!(fake.stdin()[1]["response"]["response"], expected);
        }
    }
}

/// Events until the run's first permission request, which it returns.
async fn until_asked(events: &mut EventStream) -> ApprovalRequest {
    loop {
        match next(events).await {
            Event::ApprovalRequested(request) => return request,
            Event::Finished { outcome, .. } => panic!("the run ended first: {outcome:?}"),
            _ => {}
        }
    }
}

/// An init line of a coordinator in `mode`.
fn coordinator_init(mode: &str) -> Vec<u8> {
    format!(
        r#"{{"type":"system","subtype":"init","session_id":"s","apiKeySource":"none","permissionMode":"{mode}","tools":["Read","Bash"]}}"#
    )
    .into_bytes()
}

fn asks(steps: &[Step]) -> Vec<(&ApprovalRequest, &Ask)> {
    steps
        .iter()
        .filter_map(|step| match step {
            Step::Ask(request, ask) => Some((request, ask)),
            _ => None,
        })
        .collect()
}

/// PLX-222: control requests are the driver's only when the CLI was started with the prompt
/// channel; otherwise they're skipped, as before. One before the init is refused, since the CLI
/// may be on credentials nobody checked.
#[test]
fn control_requests_are_answered_only_with_the_prompt_channel() {
    let request = br#"{"type":"control_request","request_id":"r1","request":{"subtype":"can_use_tool","tool_name":"Bash","input":{"command":"ls"}}}"#;
    let cancel = br#"{"type":"control_cancel_request","request_id":"r1"}"#;
    let mut without = Translator::new(ToolPolicy::NoWrite, "none")
        .with_coordinator_tools(true)
        .with_permission_mode("default");
    without.line(&coordinator_init("default"));
    assert_eq!(without.line(request), []);
    assert_eq!(without.line(cancel), []);

    let mut early = Translator::new(ToolPolicy::NoWrite, "none")
        .with_coordinator_tools(true)
        .with_permission_mode("default")
        .with_prompts(true);
    assert_eq!(
        violation_kind(&early.line(request)),
        Some(FailureKind::UnexpectedApiKey)
    );

    let mut translator = Translator::new(ToolPolicy::NoWrite, "none")
        .with_coordinator_tools(true)
        .with_permission_mode("default")
        .with_prompts(true);
    assert_eq!(
        violation_kind(&translator.line(&coordinator_init("default"))),
        None
    );
    let steps = translator.line(request);
    let [(asked, ask)] = asks(&steps)[..] else {
        panic!("{steps:?}")
    };
    assert_eq!(asked.tool_name, "Bash");
    assert_eq!(asked.input, serde_json::json!({"command": "ls"}));
    assert!(asked.always_allow.is_empty());
    assert_eq!(ask.request_id, "r1");
    assert_eq!(ask.tool_use_id, None);
    assert_eq!(translator.line(cancel), [Step::Withdraw("r1".into())]);
    let elicit = br#"{"type":"control_request","request_id":"r2","request":{"subtype":"elicitation","mcp_server_name":"x"}}"#;
    assert_eq!(
        translator.line(elicit),
        [Step::Refuse {
            request_id: "r2".into(),
            error: "plxd doesn't answer elicitation control requests".into(),
        }]
    );
    let nameless = br#"{"type":"control_request","request_id":"r3","request":{"subtype":"can_use_tool","input":{}}}"#;
    assert!(matches!(
        translator.line(nameless).as_slice(),
        [Step::Refuse { request_id, .. }] if request_id == "r3"
    ));
}

/// PLX-222, PLX-243: after an approved plan, an init may report only a mode that asks as much,
/// and a worker lists `ExitPlanMode` only when it hands plans over.
#[allow(clippy::too_many_lines, reason = "one table of distinct cases")]
#[test]
fn leaving_plan_mode_allows_only_modes_that_ask_as_much() {
    {
        // PLX-222: approving `ExitPlanMode` takes Claude Code to its pre-plan mode, so later inits may
        // report another mode than the one the run asked for; until then they may not.
        let plan = || {
            Translator::new(ToolPolicy::NoWrite, "none")
                .with_coordinator_tools(true)
                .with_permission_mode("plan")
                .with_prompts(true)
        };
        let mut translator = plan();
        assert_eq!(
            violation_kind(&translator.line(&coordinator_init("plan"))),
            None
        );
        assert_eq!(
            violation_kind(&translator.line(&coordinator_init("default"))),
            Some(FailureKind::PolicyViolation)
        );
        let mut translator = plan();
        assert_eq!(
            violation_kind(&translator.line(&coordinator_init("plan"))),
            None
        );
        translator.left_plan_mode();
        assert_eq!(
            violation_kind(&translator.line(&coordinator_init("default"))),
            None
        );
        // Only Claude Code's own modes after plan mode: never one that asks less, or none at all.
        for (mode, expected) in [
            ("acceptEdits", None),
            ("plan", None),
            ("bypassPermissions", Some(FailureKind::PolicyViolation)),
            ("auto", Some(FailureKind::PolicyViolation)),
        ] {
            let mut translator = plan();
            translator.line(&coordinator_init("plan"));
            translator.left_plan_mode();
            assert_eq!(
                violation_kind(&translator.line(&coordinator_init(mode))),
                expected,
                "{mode}"
            );
        }
        let mut translator = plan();
        translator.line(&coordinator_init("plan"));
        translator.left_plan_mode();
        let modeless = br#"{"type":"system","subtype":"init","session_id":"s","apiKeySource":"none","tools":["Read","Bash"]}"#;
        assert_eq!(
            violation_kind(&translator.line(modeless)),
            Some(FailureKind::PolicyViolation)
        );
    }
    {
        // PLX-243: a worker's init may list `ExitPlanMode` only when its `--tools` named it, and still
        // nothing else beyond the worker's tools. After the plan's approval, Claude Code still lists it
        // and reports Manual, which the check then accepts, but never a mode that asks less.
        // What 2.1.283 lists for a plan worker that asks plxd.
        let planning = r#"["Bash","Edit","ExitPlanMode","Glob","Grep","NotebookEdit","Read","WebFetch","WebSearch","Write"]"#;
        let worker = |mode: &'static str, plan_exit: bool| {
            Translator::new(ToolPolicy::WorkspaceWrite, "none")
                .with_permission_mode(mode)
                .with_prompts(true)
                .with_plan_exit(plan_exit)
        };
        let mut translator = worker("plan", true);
        assert_eq!(
            violation_kind(&translator.line(&worker_init("plan", planning))),
            None
        );
        for mode in ["plan", "default", "auto", "acceptEdits"] {
            let mut translator = worker(mode, false);
            assert_eq!(
                violation_kind(&translator.line(&worker_init(mode, planning))),
                Some(FailureKind::PolicyViolation),
                "{mode}"
            );
        }
        for extra in [
            "AskUserQuestion",
            "EnterPlanMode",
            "Agent",
            "mcp__plxd__spawn_agent",
        ] {
            let tools = format!(r#"["Bash","ExitPlanMode","{extra}"]"#);
            let mut translator = worker("plan", true);
            assert_eq!(
                violation_kind(&translator.line(&worker_init("plan", &tools))),
                Some(FailureKind::PolicyViolation),
                "{extra}"
            );
        }
        for (mode, expected) in [
            ("default", None),
            ("acceptEdits", None),
            ("bypassPermissions", Some(FailureKind::PolicyViolation)),
            ("auto", Some(FailureKind::PolicyViolation)),
        ] {
            let mut translator = worker("plan", true);
            translator.line(&worker_init("plan", planning));
            translator.left_plan_mode();
            assert_eq!(
                violation_kind(&translator.line(&worker_init(mode, planning))),
                expected,
                "{mode}"
            );
        }
    }
}

/// `agent/setPermission`: a thread's later `system/init`s must report the mode its CLI reported
/// switching to in `system/status`, and a switch it never reported still fails the check. A
/// worker's mode doesn't follow a status line.
#[test]
fn a_threads_mode_check_follows_the_switch_its_cli_reports() {
    let tools = r#"["Bash","Read"]"#;
    let switched = br#"{"type":"system","subtype":"status","status":null,"permissionMode":"bypassPermissions"}"#;
    let thread = || {
        Translator::new(ToolPolicy::WorkspaceWrite, "none")
            .with_thread(true)
            .with_permission_mode("default")
            .with_prompts(true)
    };
    let mut translator = thread();
    assert_eq!(
        violation_kind(&translator.line(&worker_init("default", tools))),
        None
    );
    assert_eq!(violation_kind(&translator.line(switched)), None);
    assert_eq!(
        violation_kind(&translator.line(&worker_init("bypassPermissions", tools))),
        None
    );
    let mut translator = thread();
    translator.line(&worker_init("default", tools));
    assert_eq!(
        violation_kind(&translator.line(&worker_init("bypassPermissions", tools))),
        Some(FailureKind::PolicyViolation)
    );
    let mut worker = Translator::new(ToolPolicy::WorkspaceWrite, "none")
        .with_permission_mode("default")
        .with_prompts(true);
    let worker_tools = format!(
        "[{}]",
        WORKER_TOOLS
            .iter()
            .map(|t| format!("{t:?}"))
            .collect::<Vec<_>>()
            .join(",")
    );
    assert_eq!(
        violation_kind(&worker.line(&worker_init("default", &worker_tools))),
        None
    );
    worker.line(switched);
    assert_eq!(
        violation_kind(&worker.line(&worker_init("bypassPermissions", &worker_tools))),
        Some(FailureKind::PolicyViolation)
    );
}

/// An init line of a worker on Claude Code 2.1.283 in `mode`, listing `tools`.
fn worker_init(mode: &str, tools: &str) -> Vec<u8> {
    format!(
        r#"{{"type":"system","subtype":"init","session_id":"s","apiKeySource":"none","claude_code_version":"2.1.283","permissionMode":"{mode}","tools":{tools}}}"#
    )
    .into_bytes()
}

/// PLX-222: a request offers to always allow only the rules its `approvalRequested` item shows
/// whole, at most [`MAX_ALWAYS_ALLOW_RULES`], and an answer with `always` sends exactly those.
#[test]
fn always_allow_offers_only_the_rules_the_user_is_shown() {
    let mut rules: Vec<Value> = (0..20)
        .map(|n| serde_json::json!({"toolName": "Bash", "ruleContent": format!("make {n}:*")}))
        .collect();
    let long = "x".repeat(MAX_ALWAYS_ALLOW_RULE_BYTES);
    rules.insert(
        1,
        serde_json::json!({"toolName": "Bash", "ruleContent": long}),
    );
    let request = serde_json::json!({
        "type": "control_request",
        "request_id": "r1",
        "request": {
            "subtype": "can_use_tool",
            "tool_name": "Bash",
            "input": {"command": "make 0"},
            "permission_suggestions": [{
                "type": "addRules",
                "rules": rules,
                "behavior": "allow",
                "destination": "localSettings",
            }],
        },
    });
    let mut translator = Translator::new(ToolPolicy::NoWrite, "none")
        .with_coordinator_tools(true)
        .with_permission_mode("default")
        .with_prompts(true);
    translator.line(&coordinator_init("default"));
    let steps = translator.line(request.to_string().as_bytes());
    let [(asked, ask)] = asks(&steps)[..] else {
        panic!("{steps:?}")
    };
    assert_eq!(asked.always_allow.len(), MAX_ALWAYS_ALLOW_RULES);
    assert_eq!(asked.always_allow[0], "Bash(make 0:*)");
    assert_eq!(
        asked.always_allow[1], "Bash(make 1:*)",
        "a rule too long to show whole isn't offered"
    );
    let sent: Vec<&Value> = ask
        .updates
        .iter()
        .flat_map(|update| update["rules"].as_array().unwrap())
        .collect();
    let shown: Vec<String> = sent
        .iter()
        .map(|rule| format!("Bash({})", rule["ruleContent"].as_str().unwrap()))
        .collect();
    assert_eq!(shown, asked.always_allow, "what is sent is what is shown");
}

/// PLX-222: a request the CLI still waits on when it exits is withdrawn in the run's own events,
/// before its `Finished`, so it ends even when an account fallback (#119) runs another attempt in
/// its place.
#[tokio::test]
async fn a_request_left_waiting_when_the_cli_exits_is_withdrawn_before_the_run_ends() {
    let fake = Fake::new("approval-exit");
    let request = RunRequest {
        permission: Some(AgentPermission::Manual),
        approvals: true,
        ..coordinator(&fake.root())
    };
    let Started { mut events, .. } = launch(&fake.backend, request).await;
    let asked = until_asked(&mut events).await;
    let all = rest(&mut events).await;
    assert_eq!(
        all[all.len() - 2],
        Event::ApprovalWithdrawn {
            approval_id: asked.approval_id
        },
        "{all:?}"
    );
    assert!(matches!(outcome(&all), Outcome::Failed(_)), "{all:?}");
}

/// A real session, recorded with `PLXD_RECORD_CLI` (PLX-493), replays to its snapshot: thinking
/// summaries (PLX-713), a subagent's tool call, a Write that asks first, and the streamed reply
/// (PLX-714).
#[tokio::test]
async fn a_recorded_session_replays_to_its_snapshot() {
    let fake = Fake::new("recorded");
    let request = RunRequest {
        policy: ToolPolicy::WorkspaceWrite,
        sandbox: Some(worker_sandbox(&fake.root())),
        permission: Some(AgentPermission::Manual),
        model: Some("claude-haiku-5-5".into()),
        approvals: true,
        thread: true,
        ..request(&fake.root())
    };
    crate::backend::record::assert_replays(
        fake.backend.start(request).unwrap(),
        Path::new(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/src/backend/claude/fixtures/recorded.events.jsonl"
        )),
    )
    .await;
}

/// A sidecar that answers each query's prompt at once and ends it when its prompt ends, logging
/// its own start and end, and that dies when a prompt says `crash`.
const ANSWERING_SDK: &str = r#"#!/bin/sh
dir=$FAKE_CLAUDE_DIR
echo start >> "$dir/starts"
init='{"type":"system","subtype":"init","session_id":"s","tools":["Read"],"model":"m","permissionMode":"dontAsk","apiKeySource":"none"}'
result='{"type":"result","subtype":"success","is_error":false,"result":"done","user_message_uuids":[],"queued_turn_count":0}'
while IFS= read -r line; do
  id=$(printf '%s' "$line" | sed -n 's/^{"id":"\([^"]*\)".*/\1/p')
  case $line in
    *crash*) echo 'out of memory' >&2; exit 3 ;;
    *'"stdin":'*) printf '%s %s\n%s %s\n' "$id" "$init" "$id" "$result" ;;
    *'"type":"end"'*) printf '%s exit {"code":0}\n' "$id" ;;
  esac
done
echo end >> "$dir/starts"
"#;

fn answering(fake: &Fake) -> ClaudeBackend {
    let sdk = fake.root().join("bin/answering-sdk");
    fs::write(&sdk, ANSWERING_SDK).unwrap();
    fs::set_permissions(&sdk, fs::Permissions::from_mode(0o755)).unwrap();
    let mut base = Environment::empty();
    base.set(
        "PATH",
        format!("{}:/usr/bin:/bin", fake.root().join("bin").display()),
    );
    base.set("FAKE_CLAUDE_DIR", fake.root());
    base.set(super::sdk::OVERRIDE_ENV, &sdk);
    ClaudeBackend::new(Launcher::new(
        DataDir::new(fake.root().join("data")).unwrap(),
        base,
    ))
}

/// A sidecar that dies ends every query it held, with its own stderr, as a CLI that crashed.
#[tokio::test]
async fn a_dead_sidecar_fails_every_run_on_it() {
    let fake = Fake::new("read-only");
    let backend = answering(&fake);
    let mut waiting = backend.start(request(&fake.root())).unwrap();
    let mut crashing = request(&fake.root());
    crashing.prompt = "crash".into();
    let mut crashing = backend.start(crashing).unwrap();
    // The first run's prompt is answered before the second's kills the sidecar, so hold it.
    waiting.run.hold(true);
    for started in [&mut crashing, &mut waiting] {
        let all = rest(&mut started.events).await;
        let Outcome::Failed(failure) = outcome(&all) else {
            panic!("{all:?}");
        };
        assert_eq!(failure.failure, FailureKind::Crashed, "{failure:?}");
        assert_eq!(
            failure.stderr_tail.as_deref(),
            Some("the Claude Agent SDK sidecar exited: out of memory")
        );
    }
}
