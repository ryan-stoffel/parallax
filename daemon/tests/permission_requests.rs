//! Real Claude Code for RYA-222 (0031): in Manual, a run whose client answers permission requests
//! asks wispd over stdio before a tool call that would prompt, and runs it or not on wispd's
//! answer, and a run whose client doesn't is denied as before. In Plan, a worker hands its plan
//! over the same way (RYA-243). A worker also keeps its plan with Claude Code's task tools, which
//! ask nothing (RYA-248). Each test starts the CLI through wispd's own Claude backend, so
//! the arguments, the translator that reads the CLI's `can_use_tool` request, and the driver that
//! writes the `control_response` are the ones a real run uses. A local fake Messages API asks for
//! the tool calls, so no account or Anthropic connection is needed. Set `WISP_SANDBOX_CLAUDE` to
//! the CLI under test, as CI's Linux legs do.
#![cfg(unix)]

#[expect(
    dead_code,
    reason = "these tests run the CLI through wispd's backend, not `run_worker`"
)]
mod common;

use std::ffi::OsStr;
use std::fs;
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;
use std::time::Duration;

use common::{ToolCall, fake_api, worker_request};
use serde_json::{Value, json};
use wisp_protocol::{CoordinatorThreadId, ProjectId};
use wispd::backend::claude::ClaudeBackend;
use wispd::backend::process::{Environment, Launcher};
use wispd::backend::run_temp::RunTemp;
use wispd::backend::{
    AccountRef, AgentPermission, Answer, ApiKey, ApprovalRequest, Backend, CoordinatorTools,
    Credential, Decision, Event, Outcome, RunId, RunRequest, Started, ToolPolicy, ToolStatus,
};
use wispd::paths::DataDir;

const KEY: &str = "sk-ant-wisp-test-key-never-send";

/// What the fake API's Bash calls run: it says so, and leaves a line in `ran` for each run.
const PROBE: &str = "echo probe-ran\necho x >> ran\n";

/// Where [`WRAPPER`] finds the fake API's base URL.
const API_ENV: &str = "WISP_TEST_API_URL";
/// Where [`WRAPPER`] finds the CLI under test.
const CLAUDE_ENV: &str = "WISP_TEST_CLAUDE";

/// The program the backend starts: the CLI under test, against the fake API. wispd passes no
/// inherited `ANTHROPIC_` variable on to a run, so the base URL can only reach the CLI this way.
const WRAPPER: &str = "#!/bin/sh\n\
    export ANTHROPIC_BASE_URL=\"$WISP_TEST_API_URL\" DISABLE_AUTOUPDATER=1 \
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1\n\
    exec \"$WISP_TEST_CLAUDE\" \"$@\"\n";

/// [`WRAPPER`], written once, before any test here starts a process, so no other test's child
/// can still hold it open for writing when it runs ("Text file busy").
fn wrapper() -> &'static Path {
    static PATH: OnceLock<PathBuf> = OnceLock::new();
    PATH.get_or_init(|| {
        let path = Path::new(env!("CARGO_TARGET_TMPDIR")).join("claude-against-fake-api");
        fs::write(&path, WRAPPER).unwrap();
        fs::set_permissions(&path, fs::Permissions::from_mode(0o755)).unwrap();
        path
    })
}

/// wispd's Claude backend, as `serve` builds it, with `data` as wispd's data folder and `home` as
/// `HOME`, starting `claude` against the fake API at `api`.
fn claude_backend(
    claude: &OsStr,
    api: &str,
    root: &Path,
    home: &Path,
    data: &Path,
) -> ClaudeBackend {
    // The CLI's own `TMPDIR`, wispd's in a real run.
    fs::create_dir_all(root.join("tmp")).unwrap();
    let mut env = Environment::empty();
    env.set("PATH", std::env::var_os("PATH").unwrap_or_default());
    env.set("HOME", home);
    env.set("TMPDIR", root.join("tmp"));
    env.set(API_ENV, api);
    env.set(CLAUDE_ENV, claude);
    ClaudeBackend::new(Launcher::new(DataDir::new(data).unwrap(), env)).with_program(wrapper())
}

/// A coordinator in Manual at `cwd`, which is full Claude Code (0027), on an API key, whose
/// client answers permission requests. Its wispd tools' server can't reach a wispd, so it fails
/// to start, which the run doesn't need.
fn coordinator(cwd: &Path, data: &Path) -> RunRequest {
    RunRequest {
        run_id: RunId::generate(),
        turn_id: None,
        cwd: cwd.to_owned(),
        prompt: "Run the probe.".into(),
        images: Vec::new(),
        policy: ToolPolicy::NoWrite,
        sandbox: None,
        account: AccountRef {
            id: "test".into(),
            credential: Credential::ApiKey(ApiKey::new(KEY.into())),
        },
        resume: None,
        model: Some("claude-sonnet-4-6".into()),
        effort: None,
        permission: Some(AgentPermission::Manual),
        coordinator_tools: Some(CoordinatorTools {
            program: PathBuf::from(env!("CARGO_BIN_EXE_wispd")),
            data_dir: data.to_owned(),
            project: ProjectId::generate(),
            thread: CoordinatorThreadId::generate(),
        }),
        approvals: true,
    }
}

/// A folder for one test, with `home`, `data`, and a `project` folder that holds [`PROBE`].
struct Folders {
    _dir: tempfile::TempDir,
    root: PathBuf,
    home: PathBuf,
    data: PathBuf,
    project: PathBuf,
}

impl Folders {
    fn new() -> Self {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().canonicalize().unwrap();
        let (home, data, project) = (root.join("home"), root.join("data"), root.join("project"));
        for folder in [&home, &data, &project] {
            fs::create_dir_all(folder).unwrap();
        }
        fs::write(project.join("probe.sh"), PROBE).unwrap();
        Self {
            _dir: dir,
            root,
            home,
            data,
            project,
        }
    }
}

/// Runs `request` to its end, answering each permission request with `decide`'s decision, and
/// returns its events.
async fn drive(
    backend: &ClaudeBackend,
    request: RunRequest,
    decide: impl Fn(&ApprovalRequest) -> Decision,
) -> Vec<Event> {
    let Started { run, mut events } = backend.start(request).unwrap();
    let mut all = Vec::new();
    loop {
        let Ok(event) = tokio::time::timeout(Duration::from_secs(120), events.next()).await else {
            panic!("no event within 120 s, after {all:#?}");
        };
        let event = event.expect("the stream ended before Finished");
        if let Event::ApprovalRequested(asked) = &event {
            run.answer(Answer {
                approval_id: asked.approval_id,
                decision: decide(asked),
            })
            .unwrap();
        }
        let last = event.is_terminal();
        all.push(event);
        if last {
            return all;
        }
    }
}

fn requests(events: &[Event]) -> Vec<&ApprovalRequest> {
    events
        .iter()
        .filter_map(|event| match event {
            Event::ApprovalRequested(asked) => Some(asked),
            _ => None,
        })
        .collect()
}

/// Each tool result's call id, status, and output.
fn results(events: &[Event]) -> Vec<(&str, ToolStatus, &str)> {
    events
        .iter()
        .filter_map(|event| match event {
            Event::ToolResult {
                call_id,
                status,
                output,
            } => Some((call_id.as_str(), *status, output.as_deref().unwrap_or(""))),
            _ => None,
        })
        .collect()
}

fn outcome(events: &[Event]) -> &Outcome {
    match events.last() {
        Some(Event::Finished { outcome, .. }) => outcome,
        other => panic!("expected Finished last, got {other:?}"),
    }
}

fn done() -> Outcome {
    Outcome::Completed {
        result: Some("done".into()),
    }
}

/// A coordinator's Bash asks first. wispd allows it for the rest of the session with the rule the
/// CLI offered, so the probe runs, and the same call later runs without asking.
#[tokio::test]
async fn a_manual_coordinator_runs_bash_once_wispd_allows_it() {
    let Some(claude) = std::env::var_os("WISP_SANDBOX_CLAUDE") else {
        eprintln!("skipped: set WISP_SANDBOX_CLAUDE to test the real Claude Code CLI");
        return;
    };
    let folders = Folders::new();
    let probe = ToolCall::bash("sh probe.sh");
    let api = fake_api(vec![probe.clone(), probe]).await;
    let backend = claude_backend(&claude, &api, &folders.root, &folders.home, &folders.data);
    let request = coordinator(&folders.project, &folders.data);

    let events = drive(&backend, request, |_| Decision::Allow {
        input: None,
        always: true,
    })
    .await;
    let asked = requests(&events);
    assert_eq!(asked.len(), 1, "only the first call asks: {events:#?}");
    assert_eq!(asked[0].tool_name, "Bash");
    assert_eq!(asked[0].input["command"], "sh probe.sh");
    assert_eq!(asked[0].call_id.as_deref(), Some("toolu_01WispProbe"));
    assert!(!asked[0].always_allow.is_empty(), "{events:#?}");
    assert!(!asked[0].interactive);
    let results = results(&events);
    assert_eq!(results.len(), 2, "{events:#?}");
    for (_, status, output) in results {
        assert_eq!(status, ToolStatus::Ok, "{events:#?}");
        assert!(output.contains("probe-ran"), "{events:#?}");
    }
    assert_eq!(
        fs::read_to_string(folders.project.join("ran")).unwrap(),
        "x\nx\n"
    );
    assert_eq!(outcome(&events), &done(), "{events:#?}");
}

/// A coordinator's Bash asks, wispd denies it with the user's words, and the CLI skips the call
/// and tells the model why.
#[tokio::test]
async fn a_manual_coordinator_skips_bash_that_wispd_denies() {
    const DENIAL: &str = "Not now: wisp's test denies this call.";
    let Some(claude) = std::env::var_os("WISP_SANDBOX_CLAUDE") else {
        eprintln!("skipped: set WISP_SANDBOX_CLAUDE to test the real Claude Code CLI");
        return;
    };
    let folders = Folders::new();
    let api = fake_api(vec![ToolCall::bash("sh probe.sh")]).await;
    let backend = claude_backend(&claude, &api, &folders.root, &folders.home, &folders.data);
    let request = coordinator(&folders.project, &folders.data);

    let events = drive(&backend, request, |_| Decision::Deny {
        message: DENIAL.into(),
        interrupt: false,
    })
    .await;
    let asked = requests(&events);
    assert_eq!(asked.len(), 1, "{events:#?}");
    assert_eq!(asked[0].tool_name, "Bash");
    assert_eq!(asked[0].call_id.as_deref(), Some("toolu_01WispProbe"));
    let results = results(&events);
    assert_eq!(results.len(), 1, "{events:#?}");
    let (call_id, status, output) = results[0];
    assert_eq!(call_id, "toolu_01WispProbe");
    assert_ne!(status, ToolStatus::Ok, "{events:#?}");
    assert!(output.contains(DENIAL), "{events:#?}");
    assert!(!folders.project.join("ran").exists(), "the probe never ran");
    assert_eq!(outcome(&events), &done(), "{events:#?}");
}

/// A coordinator whose client doesn't answer runs as before the prompt channel: Claude Code
/// denies its Bash without asking anyone, and the turn goes on.
#[tokio::test]
async fn a_manual_coordinator_without_approvals_is_denied_without_asking() {
    let Some(claude) = std::env::var_os("WISP_SANDBOX_CLAUDE") else {
        eprintln!("skipped: set WISP_SANDBOX_CLAUDE to test the real Claude Code CLI");
        return;
    };
    let folders = Folders::new();
    let api = fake_api(vec![ToolCall::bash("sh probe.sh")]).await;
    let backend = claude_backend(&claude, &api, &folders.root, &folders.home, &folders.data);
    let request = RunRequest {
        approvals: false,
        ..coordinator(&folders.project, &folders.data)
    };

    let events = drive(&backend, request, |asked| {
        panic!("a run without approvals asked: {asked:?}")
    })
    .await;
    assert!(requests(&events).is_empty(), "{events:#?}");
    let results = results(&events);
    assert_eq!(results.len(), 1, "{events:#?}");
    assert_ne!(results[0].1, ToolStatus::Ok, "{events:#?}");
    assert!(!folders.project.join("ran").exists(), "the probe never ran");
    assert_eq!(outcome(&events), &done(), "{events:#?}");
}

/// A worker's worktree in `folders`' data folder, laid out as wispd lays one out and holding
/// [`PROBE`], and a request for a worker there in `permission`, on an API key, whose client
/// answers permission requests. Keep the [`RunTemp`] until the run is over.
fn worker(folders: &Folders, permission: AgentPermission) -> (PathBuf, RunRequest, RunTemp) {
    let worktree = folders.data.join("worktrees/run");
    let context = folders.data.join("context/p");
    let git_dir = folders.root.join("repo/.git");
    for folder in [&worktree, &context, &git_dir] {
        fs::create_dir_all(folder).unwrap();
    }
    fs::write(
        worktree.join(".git"),
        format!("gitdir: {}/worktrees/run\n", git_dir.display()),
    )
    .unwrap();
    fs::write(worktree.join("probe.sh"), PROBE).unwrap();
    let (mut request, temp) =
        worker_request(&folders.home, &folders.data, &worktree, &git_dir, &context);
    request.permission = Some(permission);
    request.approvals = true;
    request.account.credential = Credential::ApiKey(ApiKey::new(KEY.into()));
    (worktree, request, temp)
}

/// A worker in Manual, in its sandbox: its Bash runs without asking, since its settings allow
/// Bash (0013), and its `Write` asks. wispd allows it, and the file is written.
#[tokio::test]
async fn a_manual_worker_asks_before_writing_but_not_before_sandboxed_bash() {
    let Some(claude) = std::env::var_os("WISP_SANDBOX_CLAUDE") else {
        eprintln!("skipped: set WISP_SANDBOX_CLAUDE to test the real Claude Code CLI");
        return;
    };
    let folders = Folders::new();
    let (worktree, request, _temp) = worker(&folders, AgentPermission::Manual);
    let file = worktree.join("approved.txt");
    let write = ToolCall {
        name: "Write",
        input: json!({"file_path": file.to_str().unwrap(), "content": "approved\n"}),
    };
    let api = fake_api(vec![ToolCall::bash("sh probe.sh"), write]).await;
    let backend = claude_backend(&claude, &api, &folders.root, &folders.home, &folders.data);

    let events = drive(&backend, request, |_| Decision::Allow {
        input: None,
        always: false,
    })
    .await;
    let asked = requests(&events);
    assert_eq!(asked.len(), 1, "only the Write asks: {events:#?}");
    assert_eq!(asked[0].tool_name, "Write");
    assert_eq!(asked[0].input["file_path"], file.to_str().unwrap());
    assert_eq!(asked[0].call_id.as_deref(), Some("toolu_01WispProbe1"));
    let results = results(&events);
    assert_eq!(results.len(), 2, "{events:#?}");
    assert_eq!(results[0].1, ToolStatus::Ok, "{events:#?}");
    assert!(results[0].2.contains("probe-ran"), "{events:#?}");
    assert_eq!(results[1].1, ToolStatus::Ok, "{events:#?}");
    assert_eq!(fs::read_to_string(&file).unwrap(), "approved\n");
    assert_eq!(outcome(&events), &done(), "{events:#?}");
}

/// A worker in Plan whose client answers hands its plan to wispd with `ExitPlanMode` (RYA-243),
/// and wispd's allow takes it out of plan mode. In plan mode, Claude Code 2.1.283 sends each
/// command to its auto-mode classifier, which the fake API can't answer, so the worker's first
/// Bash is denied without asking. Once the plan is allowed, the CLI runs in Manual, where the
/// worker's settings allow sandboxed Bash (0013), so the same command runs without asking.
#[tokio::test]
async fn a_plan_worker_hands_its_plan_to_wispd_and_leaves_plan_mode_on_its_allow() {
    const PLAN: &str = "1. Add a README.\n2. Link it from the docs.\n";
    let Some(claude) = std::env::var_os("WISP_SANDBOX_CLAUDE") else {
        eprintln!("skipped: set WISP_SANDBOX_CLAUDE to test the real Claude Code CLI");
        return;
    };
    let folders = Folders::new();
    let (worktree, request, _temp) = worker(&folders, AgentPermission::Plan);
    let probe = ToolCall::bash("sh probe.sh");
    let exit_plan = ToolCall {
        name: "ExitPlanMode",
        input: json!({"plan": PLAN}),
    };
    let api = fake_api(vec![probe.clone(), exit_plan, probe]).await;
    let backend = claude_backend(&claude, &api, &folders.root, &folders.home, &folders.data);

    let events = drive(&backend, request, |asked| {
        if asked.tool_name == "ExitPlanMode" {
            Decision::Allow {
                input: None,
                always: false,
            }
        } else {
            Decision::Deny {
                message: "Only the plan is approved.".into(),
                interrupt: false,
            }
        }
    })
    .await;
    let asked = requests(&events);
    assert_eq!(asked.len(), 1, "only the plan asks: {events:#?}");
    assert_eq!(asked[0].tool_name, "ExitPlanMode");
    assert!(asked[0].interactive, "{events:#?}");
    assert_eq!(asked[0].input["plan"], PLAN);
    assert_eq!(asked[0].call_id.as_deref(), Some("toolu_01WispProbe1"));
    let results = results(&events);
    assert_eq!(results.len(), 3, "{events:#?}");
    assert_ne!(
        results[0].1,
        ToolStatus::Ok,
        "plan mode ran it: {events:#?}"
    );
    assert_eq!(results[1].1, ToolStatus::Ok, "{events:#?}");
    assert_eq!(results[2].1, ToolStatus::Ok, "{events:#?}");
    assert!(results[2].2.contains("probe-ran"), "{events:#?}");
    assert_eq!(
        fs::read_to_string(worktree.join("ran")).unwrap(),
        "x\n",
        "only the command after the allow ran"
    );
    assert_eq!(outcome(&events), &done(), "{events:#?}");
}

/// A worker keeps its plan with Claude Code's task tools (RYA-248). Its `--tools` names them, so
/// 2.1.283 offers them even on a model it would otherwise give no todo tool, and its init passes
/// wispd's check. The CLI writes the list itself, in its configuration folder outside the
/// worktree, which the worker's commands still can't read.
#[tokio::test]
async fn a_worker_keeps_its_plan_with_the_task_tools_where_its_commands_cannot_read_it() {
    let Some(claude) = std::env::var_os("WISP_SANDBOX_CLAUDE") else {
        eprintln!("skipped: set WISP_SANDBOX_CLAUDE to test the real Claude Code CLI");
        return;
    };
    let folders = Folders::new();
    let (worktree, mut request, _temp) = worker(&folders, AgentPermission::Edit);
    request.model = Some("claude-opus-5-5".into());
    // In a script, so only the sandbox, not Claude Code's own checks, can stop the read.
    fs::write(
        worktree.join("peek.sh"),
        "cat \"$HOME\"/.claude/tasks/*/1.json\necho peeked\n",
    )
    .unwrap();
    let task = |name, input| ToolCall { name, input };
    let api = fake_api(vec![
        task(
            "TaskCreate",
            json!({
                "subject": "Add tests",
                "description": "Cover the parser",
                "activeForm": "Adding tests",
            }),
        ),
        task(
            "TaskUpdate",
            json!({"taskId": "1", "status": "in_progress"}),
        ),
        ToolCall::bash("sh peek.sh"),
        task("TaskUpdate", json!({"taskId": "1", "status": "completed"})),
    ])
    .await;
    let backend = claude_backend(&claude, &api, &folders.root, &folders.home, &folders.data);

    let events = drive(&backend, request, |asked| {
        panic!("an Accept Edits worker asked: {asked:?}")
    })
    .await;
    let results = results(&events);
    assert_eq!(results.len(), 4, "{events:#?}");
    assert_eq!(
        results[0],
        (
            "toolu_01WispProbe",
            ToolStatus::Ok,
            "Task #1 created successfully: Add tests"
        ),
        "{events:#?}"
    );
    assert_eq!(results[1].2, "Updated task #1 status", "{events:#?}");
    assert!(results[2].2.contains("peeked"), "{events:#?}");
    assert!(!results[2].2.contains("Cover the parser"), "{events:#?}");
    assert_eq!(results[3].2, "Updated task #1 status", "{events:#?}");
    assert_eq!(outcome(&events), &done(), "{events:#?}");

    let session = events
        .iter()
        .find_map(|event| match event {
            Event::SessionStarted { session_id, .. } => Some(session_id.as_str()),
            _ => None,
        })
        .unwrap();
    let list = folders.home.join(".claude/tasks").join(session);
    let saved: Value =
        serde_json::from_str(&fs::read_to_string(list.join("1.json")).unwrap()).unwrap();
    assert_eq!(saved["subject"], "Add tests");
    assert_eq!(saved["status"], "completed");
    assert!(
        !worktree.join(".claude").exists(),
        "nothing in the worktree"
    );
}
