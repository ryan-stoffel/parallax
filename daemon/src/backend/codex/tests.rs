//! The Codex backend against a fake `codex` on `PATH` that replays fixtures, most of them captured
//! from real `codex exec --json` runs, so every test spawns a real process through the
//! supervisor. No test runs the real CLI. Only macOS runs Codex workers, so these tests are
//! macOS-only; the translator's own tests in `stream.rs` run everywhere.

use std::collections::BTreeSet;
use std::fs;
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant};

use tempfile::TempDir;
use wisp_protocol::{AccountChoice, AccountId, Provider, Role};

use super::{CodexBackend, WORKER_FEATURES, worker_overrides};
use crate::backend::process::{Environment, Launcher};
use crate::backend::sandbox::unreadable_in_home;
use crate::backend::{
    AccountRef, AgentEffort, AgentPermission, ApiKey, Backend, Credential, Event, EventStream,
    FailureKind, ModelUsage, Outcome, Resume, RunId, RunRequest, StartError, Started, ToolPolicy,
    ToolStatus, Usage, WarningKind, WorkerSandbox,
};
use crate::keystore::{KeyStore, MemoryKeyStore};
use crate::paths::DataDir;
use crate::routing::{self, BackendRegistry, Defaults, KeyAccounts};

const FAKE_CODEX: &str = include_str!("fixtures/fake-codex.sh");
const THREAD: &str = "01a0eaf8-7c27-7762-a05e-9eae0197d57c";
const TURN: &str = "01997e2a-4c3b-7d10-8a2e-5f6b7c8d9e01";
const DATA: &str = "/Users/u/Library/Application Support/wisp";
const CONTEXT: &str = "/Users/u/Library/Application Support/wisp/context/p";

fn fixture(name: &str) -> &'static str {
    match name {
        "worker" => include_str!("fixtures/worker.jsonl"),
        "resume" => include_str!("fixtures/resume.jsonl"),
        "not-signed-in" => include_str!("fixtures/not-signed-in.jsonl"),
        "usage-limit" => include_str!("fixtures/usage-limit.jsonl"),
        "mcp-call" => include_str!("fixtures/mcp-call.jsonl"),
        "cancel" => include_str!("fixtures/cancel.jsonl"),
        other => panic!("no fixture {other}"),
    }
}

/// Inherited variables that could pick Codex's credentials, endpoint, or configuration. None
/// may reach the CLI.
const INHERITED_CREDENTIALS: &[(&str, &str)] = &[
    ("OPENAI_API_KEY", "wisp-test-not-a-key"),
    ("OPENAI_BASE_URL", "https://example.invalid/v1"),
    ("CODEX_API_KEY", "wisp-test-not-a-key"),
    ("CODEX_HOME", "/tmp/wisp-test-inherited-codex-home"),
];

/// A fake `codex` on the launcher's `PATH`, in a folder that also holds what it records.
struct Fake {
    dir: TempDir,
    backend: CodexBackend,
}

impl Fake {
    fn new(fixture_name: &str) -> Self {
        Self::with_key_fixture(fixture_name, None)
    }

    /// A fake that replays `key_fixture` instead when it runs with an API key.
    fn with_key_fixture(fixture_name: &str, key_fixture: Option<&str>) -> Self {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().canonicalize().unwrap();
        let bin = root.join("bin");
        fs::create_dir(&bin).unwrap();
        let program = bin.join("codex");
        fs::write(&program, FAKE_CODEX).unwrap();
        fs::set_permissions(&program, fs::Permissions::from_mode(0o755)).unwrap();
        let mut base: Environment = [
            ("PATH", format!("{}:/usr/bin:/bin", bin.display())),
            ("FAKE_CODEX_DIR", root.display().to_string()),
            ("KEPT", "yes".into()),
        ]
        .into_iter()
        .chain(
            INHERITED_CREDENTIALS
                .iter()
                .map(|(name, value)| (*name, (*value).to_owned())),
        )
        .collect();
        for (variable, name) in [
            ("FAKE_CODEX_FIXTURE", Some(fixture_name)),
            ("FAKE_CODEX_KEY_FIXTURE", key_fixture),
        ] {
            if let Some(name) = name {
                let path = root.join(format!("{name}.jsonl"));
                fs::write(&path, fixture(name)).unwrap();
                base.set(variable, path);
            }
        }
        let launcher = Launcher::new(DataDir::new(root.join("data")).unwrap(), base);
        Self {
            dir,
            backend: CodexBackend::new(launcher),
        }
    }

    fn root(&self) -> PathBuf {
        self.dir.path().canonicalize().unwrap()
    }

    fn recorded(&self, name: &str) -> String {
        fs::read_to_string(self.root().join(name)).unwrap_or_default()
    }

    fn argv(&self) -> Vec<String> {
        self.recorded("argv").lines().map(str::to_owned).collect()
    }

    /// The CLI's value for each variable in `names`, or `None` where it had none.
    fn env(&self, names: &[&str]) -> Vec<Option<String>> {
        let env = self.recorded("env");
        names
            .iter()
            .map(|name| {
                env.lines()
                    .find_map(|line| line.strip_prefix(&format!("{name}=")))
                    .map(str::to_owned)
            })
            .collect()
    }
}

fn sandbox(cwd: &Path) -> WorkerSandbox {
    WorkerSandbox::for_worktree(
        Path::new("/Users/u"),
        Path::new(DATA),
        cwd,
        Path::new("/Users/u/src/app/.git"),
        Path::new(CONTEXT),
    )
}

fn request(cwd: &Path) -> RunRequest {
    RunRequest {
        run_id: RunId::generate(),
        turn_id: Some(TURN.parse().unwrap()),
        cwd: cwd.to_owned(),
        prompt: "Run `echo hello`, then create hello.txt.".into(),
        policy: ToolPolicy::WorkspaceWrite,
        sandbox: Some(sandbox(cwd)),
        account: AccountRef {
            id: "codex".into(),
            credential: Credential::Subscription { config_home: None },
        },
        resume: None,
        model: None,
        effort: None,
        permission: None,
        coordinator_tools: None,
    }
}

async fn next(events: &mut EventStream) -> Event {
    tokio::time::timeout(Duration::from_secs(10), events.next())
        .await
        .expect("no event within 10 s")
        .expect("the stream ended")
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

async fn run(backend: &dyn Backend, request: RunRequest) -> Vec<Event> {
    rest(&mut backend.start(request).unwrap().events).await
}

fn outcome(events: &[Event]) -> &Outcome {
    match events.last() {
        Some(Event::Finished { outcome, .. }) => outcome,
        other => panic!("expected Finished last, got {other:?}"),
    }
}

fn failure(events: &[Event]) -> FailureKind {
    match outcome(events) {
        Outcome::Failed(failure) => failure.failure,
        other => panic!("expected a failure, got {other:?}"),
    }
}

fn tokens(input: u64, output: u64, read: u64) -> Usage {
    Usage {
        input_tokens: input,
        output_tokens: output,
        cache_read_tokens: read,
        cache_write_tokens: 0,
        cost_usd_micros: None,
    }
}

/// `argv`'s `-c` values, in order.
fn overrides(argv: &[String]) -> Vec<&str> {
    argv.windows(2)
        .filter(|pair| pair[0] == "-c")
        .map(|pair| pair[1].as_str())
        .collect()
}

#[tokio::test]
async fn a_worker_run_maps_the_real_stream_and_holds_codex_to_0013() {
    let fake = Fake::new("worker");
    let cwd = fake.root();
    let mut worker = request(&cwd);
    worker.model = Some("gpt-5.5-codex".into());
    worker.effort = Some(AgentEffort::Xhigh);
    worker.account.credential = Credential::Subscription {
        config_home: Some("/tmp/codex-second-account".into()),
    };
    let events = run(&fake.backend, worker).await;

    let call = |item: &str| format!("{TURN}-{item}");
    let path = "/Users/u/Library/Application Support/wisp/worktrees/app-1a2b/run/hello.txt";
    let session = Event::SessionStarted {
        session_id: THREAD.into(),
        model: None,
        api_key_source: None,
    };
    let text = |text: &str| Event::Text {
        message_id: None,
        text: text.into(),
    };
    assert_eq!(
        events,
        [
            Event::TurnStarted {
                turn_id: Some(TURN.parse().unwrap())
            },
            session,
            text(
                "1. Run `echo hello` in the shell.\n2. Create `hello.txt` containing `hi` using \
                 `apply_patch`.\n\nA plan tool isn’t available in this session, so I’ve stated \
                 the plan here.\n"
            ),
            Event::ToolCall {
                call_id: call("item_1"),
                name: "command_execution".into(),
                input: serde_json::json!({"command": "/bin/zsh -lc 'echo hello'"}),
            },
            Event::ToolResult {
                call_id: call("item_1"),
                status: ToolStatus::Ok,
                output: Some("hello\n".into()),
            },
            Event::ToolCall {
                call_id: call("item_2"),
                name: "file_change".into(),
                input: serde_json::json!({"changes": [{"path": path, "kind": "add"}]}),
            },
            Event::ToolResult {
                call_id: call("item_2"),
                status: ToolStatus::Ok,
                output: None,
            },
            text("done"),
            // input_tokens counts cached input too: 55274 - 36352.
            Event::Usage(ModelUsage {
                model: None,
                usage: tokens(18_922, 184, 36_352),
            }),
            Event::TurnFinished {
                turn_id: Some(TURN.parse().unwrap()),
                result: Some("done".into()),
            },
            Event::Finished {
                outcome: Outcome::Completed {
                    result: Some("done".into())
                },
                usage_totals: vec![ModelUsage {
                    model: None,
                    usage: tokens(18_922, 184, 36_352),
                }],
            },
        ]
    );

    assert_worker_invocation(&fake);
}

/// A worker's prompt, sandbox, model, and second account reached the CLI, and nothing else did.
fn assert_worker_invocation(fake: &Fake) {
    let cwd = fake.root();
    // The prompt went on stdin, never in argv, and stdin closed after it.
    assert_eq!(
        fake.recorded("stdin"),
        "Run `echo hello`, then create hello.txt."
    );
    let argv = fake.argv();
    assert_eq!(
        argv[..4],
        ["exec", "--json", "--ignore-user-config", "--ignore-rules"]
    );
    assert_eq!(argv[argv.len() - 3..], ["-m", "gpt-5.5-codex", "-"]);
    let cwd_text = cwd.display().to_string();
    let values = overrides(&argv);
    assert_eq!(values.len(), 8, "{values:?}");
    assert_eq!(values[0], r#"default_permissions="wisp_worker""#);
    let permissions = values[1]
        .strip_prefix(&format!(
            r#"permissions={{wisp_worker={{extends=":workspace", workspace_roots={{"{CONTEXT}"=true}}, filesystem={{"#
        ))
        .and_then(|rest| {
            rest.strip_suffix(r#"}, network={enabled=true, domains={"*"="allow"}}}}"#)
        })
        .unwrap_or_else(|| panic!("{}", values[1]));
    let rules: BTreeSet<&str> = permissions.split(", ").collect();
    let mut expected: BTreeSet<String> = unreadable_in_home()
        .map(|path| format!(r#""/Users/u/{path}"="deny""#))
        .collect();
    expected.extend([
        format!(r#""{DATA}"="deny""#),
        r#""/tmp/codex-second-account"="deny""#.to_owned(),
        format!(r#""{cwd_text}/.git"="read""#),
        r#""/Users/u/src/app/.git"="read""#.to_owned(),
    ]);
    assert_eq!(rules, expected.iter().map(String::as_str).collect());
    assert_eq!(
        values[2..],
        [
            "features={network_proxy=true, hooks=false, apps=false, plugins=false, \
             remote_plugin=false, multi_agent=false, skill_mcp_dependency_install=false, \
             shell_snapshot=false}",
            &format!(r#"projects={{"{cwd_text}"={{trust_level="untrusted"}}}}"#),
            r#"approval_policy="never""#,
            r#"web_search="live""#,
            "shell_environment_policy={ignore_default_excludes=false}",
            r#"model_reasoning_effort="xhigh""#,
        ]
    );
    assert_eq!(values[2], WORKER_FEATURES);
    for flag in [
        "-s",
        "--sandbox",
        "--dangerously-bypass-approvals-and-sandbox",
        "--add-dir",
    ] {
        assert!(!argv.iter().any(|arg| arg == flag), "{flag}: {argv:?}");
    }

    // Only the account's own configuration folder reaches the CLI.
    assert_eq!(
        fake.env(&[
            "OPENAI_API_KEY",
            "OPENAI_BASE_URL",
            "CODEX_API_KEY",
            "CODEX_HOME",
            "KEPT",
            "PWD"
        ]),
        [
            None,
            None,
            None,
            Some("/tmp/codex-second-account".into()),
            Some("yes".into()),
            Some(cwd_text)
        ]
    );
}

#[tokio::test]
async fn a_resumed_thread_reports_only_what_it_adds() {
    let fake = Fake::new("resume");
    let mut resumed = request(&fake.root());
    resumed.resume = Some(Resume {
        session_id: THREAD.into(),
        usage_totals: vec![ModelUsage {
            model: None,
            usage: tokens(18_922, 184, 36_352),
        }],
    });
    let events = run(&fake.backend, resumed).await;

    let argv = fake.argv();
    assert_eq!(argv[..2], ["exec", "resume"]);
    assert_eq!(argv[argv.len() - 2..], [THREAD, "-"]);
    // The real resume's running total: input 73838 with 54656 cached, output 190.
    let usage: Vec<&Usage> = events
        .iter()
        .filter_map(|event| match event {
            Event::Usage(delta) => Some(&delta.usage),
            _ => None,
        })
        .collect();
    assert_eq!(usage, [&tokens(260, 6, 18_304)]);
    assert_eq!(
        outcome(&events),
        &Outcome::Completed {
            result: Some("hello.txt".into())
        }
    );
}

#[tokio::test]
async fn an_api_key_account_gets_only_its_key() {
    let fake = Fake::new("worker");
    let mut keyed = request(&fake.root());
    keyed.account.credential = Credential::ApiKey(ApiKey::new("sk-proj-wisp-test".into()));
    let events = run(&fake.backend, keyed).await;
    assert!(matches!(outcome(&events), Outcome::Completed { .. }));
    assert_eq!(
        fake.env(&["CODEX_API_KEY", "OPENAI_API_KEY", "CODEX_HOME"]),
        [Some("sk-proj-wisp-test".into()), None, None]
    );
    assert!(!fake.argv().iter().any(|arg| arg.contains("sk-proj")));
}

/// Routing's key accounts: one `OpenAI` key to fall back to.
struct OneKey(AccountId);

impl KeyAccounts for OneKey {
    fn provider_of(&self, id: AccountId) -> Option<Provider> {
        (id == self.0).then_some(Provider::Openai)
    }

    fn fallback_for(&self, provider: Provider) -> Option<AccountId> {
        (provider == Provider::Openai).then_some(self.0)
    }
}

#[tokio::test]
async fn a_signed_out_or_limited_login_falls_back_to_an_openai_key() {
    for (first, reason) in [
        ("not-signed-in", FailureKind::NotSignedIn),
        ("usage-limit", FailureKind::RateLimited),
    ] {
        let fake = Fake::with_key_fixture(first, Some("worker"));
        let mut backends = BackendRegistry::new();
        backends.register(Provider::Openai, Arc::new(fake.backend.clone()));
        let key = AccountId::generate();
        let store = MemoryKeyStore::new();
        store.set(key, "sk-proj-fallback").unwrap();
        let resolved = routing::resolve(
            &backends,
            &OneKey(key),
            &Defaults::default(),
            Role::Worker,
            Some(AccountChoice::Subscription {
                backend: "codex".into(),
            }),
            ToolPolicy::WorkspaceWrite,
        )
        .unwrap();
        let mut started = routing::start(
            Arc::new(store),
            &OneKey(key),
            resolved,
            request(&fake.root()),
        )
        .unwrap();
        let events = rest(&mut started.events).await;
        assert!(
            events.contains(&Event::AccountFallback {
                from_account: "codex".into(),
                to_account: key.to_string(),
                reason,
            }),
            "{first}: {events:?}"
        );
        assert!(
            matches!(outcome(&events), Outcome::Completed { .. }),
            "{first}"
        );
        assert_eq!(
            fake.env(&["CODEX_API_KEY"]),
            [Some("sk-proj-fallback".into())]
        );
    }
}

#[tokio::test]
async fn an_mcp_call_stops_the_worker_at_once() {
    let fake = Fake::new("mcp-call");
    let started = Instant::now();
    let events = run(&fake.backend, request(&fake.root())).await;
    assert_eq!(failure(&events), FailureKind::PolicyViolation);
    assert!(started.elapsed() < Duration::from_secs(5));
}

#[tokio::test]
async fn cancel_interrupts_codex_with_sigint() {
    let fake = Fake::new("cancel");
    let Started { run, mut events } = fake.backend.start(request(&fake.root())).unwrap();
    assert!(matches!(next(&mut events).await, Event::TurnStarted { .. }));
    assert!(matches!(
        next(&mut events).await,
        Event::SessionStarted { .. }
    ));
    // `@trap-armed`, printed once the fake's SIGINT trap is installed: a deterministic handshake.
    assert!(matches!(
        next(&mut events).await,
        Event::Warning {
            warning: WarningKind::MalformedLine,
            ..
        }
    ));
    assert!(matches!(next(&mut events).await, Event::Text { .. }));
    assert!(matches!(next(&mut events).await, Event::ToolCall { .. }));
    let started = Instant::now();
    run.cancel();
    assert_eq!(outcome(&rest(&mut events).await), &Outcome::Cancelled);
    assert!(started.elapsed() < Duration::from_secs(5));
    assert_eq!(fake.recorded("signals"), "SIGINT\n");
}

#[tokio::test]
async fn requests_codex_can_t_run_are_refused_before_spawning() {
    let fake = Fake::new("worker");
    let cwd = fake.root();
    let refuse = |request: RunRequest| fake.backend.start(request).map(|_| ()).unwrap_err();

    let mut no_write = request(&cwd);
    no_write.policy = ToolPolicy::NoWrite;
    assert!(matches!(refuse(no_write), StartError::Unsupported(_)));
    let mut no_sandbox = request(&cwd);
    no_sandbox.sandbox = None;
    assert!(matches!(refuse(no_sandbox), StartError::Invalid(_)));
    let mut option = request(&cwd);
    option.model = Some("--dangerously-bypass-approvals-and-sandbox".into());
    assert!(matches!(refuse(option), StartError::Invalid(_)));
    assert!(fake.argv().is_empty(), "nothing was spawned");
}

#[test]
fn paths_are_quoted_as_toml_strings() {
    let cwd = Path::new("/Users/u/we\"ird\\dir\u{7f}");
    let values = worker_overrides(&sandbox(cwd), cwd, None);
    assert_eq!(
        values[3],
        r#"projects={"/Users/u/we\"ird\\dir\u007F"={trust_level="untrusted"}}"#
    );
}
