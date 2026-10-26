//! The ACP backend, configured as Cursor Agent, against a fake `agent` on `PATH` that replays ACP transcripts recorded
//! from Cursor Agent 2026.10.01-14929f9, so every test spawns a real process and speaks the
//! protocol both ways. No test runs the real CLI.

use std::fs;
use std::os::unix::fs::PermissionsExt;
use std::path::PathBuf;
use std::time::Duration;

use serde_json::{Value, json};
use tempfile::TempDir;

use super::{AcpAgent, AcpBackend};
use crate::backend::process::{Environment, Launcher};
use crate::backend::{
    AccountRef, AgentPermission, Answer, Backend, Credential, Decision, Event, EventStream,
    FollowUp, Outcome, Resume, RunId, RunRequest, ToolPolicy, ToolStatus, TurnId,
};
use crate::paths::DataDir;

const FAKE_AGENT: &str = include_str!("fixtures/fake-agent.sh");
const TURN: &str = "01997e2a-4c3b-7d10-8a2e-5f6b7c8d9e01";
const PROMPT: &str = "Make a todo list of two items, then run the shell command `git status --short` \
                      and then create a file hello.txt containing hi. Then reply with one word: done.";

fn fixture(name: &str) -> &'static str {
    match name {
        "thread-mcp" => include_str!("fixtures/thread-mcp.jsonl"),
        "approval" => include_str!("fixtures/approval.jsonl"),
        "resume" => include_str!("fixtures/resume.jsonl"),
        "plan-denied" => include_str!("fixtures/plan-denied.jsonl"),
        "opencode" => include_str!("fixtures/opencode.jsonl"),
        "hermes" => include_str!("fixtures/hermes.jsonl"),
        "plan-refused" => include_str!("fixtures/plan-refused.jsonl"),
        "steer" => include_str!("fixtures/steer.jsonl"),
        "recorded" => include_str!("fixtures/recorded.jsonl"),
        other => panic!("no fixture {other}"),
    }
}

/// A fake `agent` on the launcher's `PATH`, in a folder that also holds what it records.
struct Fake {
    dir: TempDir,
    backend: AcpBackend,
}

/// The ACP shape Cursor used before the SDK sidecar (0036). The ACP driver still serves the other agents.
fn cursor() -> AcpAgent {
    AcpAgent {
        scrub: vec!["CURSOR_".into()],
        model_flag: Some("--model".into()),
        bypass_flag: Some("--force".into()),
        modes: vec![(AgentPermission::Plan, "plan".into())],
        edit_mode: Some("agent".into()),
        ..AcpAgent::new("cursor", "Cursor Agent", "agent", &["acp"])
    }
}

impl Fake {
    fn new(fixture_name: &str) -> Self {
        Self::with_agent(fixture_name, cursor())
    }

    /// The fake as `agent`, whose program is the fake `agent` on `PATH`.
    fn with_agent(fixture_name: &str, agent: AcpAgent) -> Self {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().canonicalize().unwrap();
        let bin = root.join("bin");
        fs::create_dir(&bin).unwrap();
        let program = bin.join("agent");
        fs::write(&program, FAKE_AGENT).unwrap();
        fs::set_permissions(&program, fs::Permissions::from_mode(0o755)).unwrap();
        let path = root.join("fixture.jsonl");
        fs::write(&path, fixture(fixture_name)).unwrap();
        let base: Environment = [
            ("PATH", format!("{}:/usr/bin:/bin", bin.display())),
            ("FAKE_AGENT_DIR", root.display().to_string()),
            ("FAKE_AGENT_FIXTURE", path.display().to_string()),
            ("CURSOR_API_KEY", "parallax-test-not-a-key".into()),
            ("CURSOR_API_ENDPOINT", "https://example.invalid".into()),
        ]
        .into_iter()
        .collect();
        let launcher = Launcher::new(DataDir::new(root.join("data")).unwrap(), base);
        Self {
            dir,
            backend: AcpBackend::new(launcher, agent),
        }
    }

    fn root(&self) -> PathBuf {
        self.dir.path().canonicalize().unwrap()
    }

    fn recorded(&self, name: &str) -> String {
        fs::read_to_string(self.root().join(name)).unwrap_or_default()
    }

    /// What plxd wrote on stdin, one JSON message per line.
    fn stdin(&self) -> Vec<Value> {
        self.recorded("stdin")
            .lines()
            .map(|line| serde_json::from_str(line).unwrap())
            .collect()
    }

    fn request(&self) -> RunRequest {
        RunRequest {
            run_id: RunId::generate(),
            turn_id: Some(TURN.parse().unwrap()),
            cwd: self.root(),
            prompt: PROMPT.into(),
            images: Vec::new(),
            policy: ToolPolicy::WorkspaceWrite,
            sandbox: None,
            account: AccountRef {
                id: "cursor".into(),
                credential: Credential::Subscription { config_home: None },
            },
            resume: None,
            model: Some("composer-2.5-fast".into()),
            effort: None,
            permission: None,
            context_window: None,
            fast: None,
            coordinator_tools: None,
            thread_tools: None,
            approvals: true,
            thread: true,
            instructions: None,
        }
    }
}

async fn next(events: &mut EventStream) -> Event {
    tokio::time::timeout(Duration::from_secs(10), events.next())
        .await
        .expect("no event within 10 s")
        .expect("the stream ended")
}

/// Every event up to and including the terminal one.
async fn rest(events: &mut EventStream) -> Vec<Event> {
    let mut rest = Vec::new();
    while !rest.last().is_some_and(Event::is_terminal) {
        rest.push(next(events).await);
    }
    rest
}

/// The run's outcome, which must come within 10 s: only plxd stopping a lingering fake ends it
/// that soon.
async fn stopped(events: &mut EventStream) -> Outcome {
    let finished = tokio::time::timeout(Duration::from_secs(10), async {
        loop {
            if let Event::Finished { outcome, .. } = next(events).await {
                break outcome;
            }
        }
    });
    finished.await.expect("plxd stops the agent")
}

/// Every event until `Finished`, answering each permission request with `answer`, and sending
/// `follow_up`, if any, when the first one arrives.
async fn run(
    fake: &Fake,
    request: RunRequest,
    answer: impl Fn(&str) -> Decision,
    mut follow_up: Option<FollowUp>,
) -> Vec<Event> {
    let started = fake.backend.start(request).unwrap();
    let mut events = started.events;
    let mut all = Vec::new();
    loop {
        let event = next(&mut events).await;
        if let Event::ApprovalRequested(request) = &event {
            if let Some(message) = follow_up.take() {
                started.run.send(message).unwrap();
            }
            let decision = answer(&request.tool_name);
            started
                .run
                .answer(Answer {
                    approval_id: request.approval_id,
                    decision,
                })
                .unwrap();
        }
        let terminal = event.is_terminal();
        all.push(event);
        if terminal {
            return all;
        }
    }
}

fn allow(_: &str) -> Decision {
    Decision::Allow {
        input: None,
        always: false,
    }
}

fn outcome(events: &[Event]) -> &Outcome {
    match events.last() {
        Some(Event::Finished { outcome, .. }) => outcome,
        other => panic!("expected Finished last, got {other:?}"),
    }
}

fn turns(events: &[Event]) -> Vec<&Event> {
    events
        .iter()
        .filter(|event| {
            matches!(
                event,
                Event::TurnStarted { .. } | Event::TurnFinished { .. }
            )
        })
        .collect()
}

fn status_of<'a>(events: &'a [Event], call: &str) -> Option<&'a ToolStatus> {
    events.iter().find_map(|event| match event {
        Event::ToolResult {
            call_id, status, ..
        } if call_id == call => Some(status),
        _ => None,
    })
}

/// The approval transcript, its request allowed, with a follow-up sent while it waited.
async fn approved() -> (Fake, Vec<Event>, FollowUp) {
    let fake = Fake::new("approval");
    let follow_up = FollowUp {
        turn_id: TurnId::generate(),
        text: "And one more thing.".into(),
        images: Vec::new(),
        steer: false,
        model: None,
        permission: None,
    };
    let events = run(&fake, fake.request(), allow, Some(follow_up.clone())).await;
    (fake, events, follow_up)
}

#[tokio::test]
async fn a_thread_asks_through_plxd_and_takes_follow_ups_in_its_live_session() {
    let (fake, _, _) = approved().await;

    assert_eq!(
        fake.recorded("argv").lines().collect::<Vec<_>>(),
        ["--model", "composer-2.5-fast", "acp"]
    );
    let env = fake.recorded("env");
    assert!(
        !env.contains("CURSOR_API_KEY") && !env.contains("CURSOR_API_ENDPOINT"),
        "{env}"
    );

    let stdin = fake.stdin();
    let methods: Vec<_> = stdin.iter().map(|line| line["method"].as_str()).collect();
    assert_eq!(
        methods,
        [
            Some("initialize"),
            Some("session/new"),
            Some("session/prompt"),
            None,
            None,
            None,
            Some("session/prompt")
        ]
    );
    assert_eq!(stdin[1]["params"]["cwd"], fake.root().to_str().unwrap());
    assert_eq!(
        stdin[2]["params"]["prompt"],
        json!([{"type": "text", "text": PROMPT}]),
        "the first message is the user's own"
    );
    assert_eq!(
        stdin[3],
        json!({"jsonrpc": "2.0", "id": 0, "result": {}}),
        "todos acknowledged"
    );
    assert_eq!(
        stdin[4],
        json!({"jsonrpc": "2.0", "id": 1, "result": {"outcome": {"outcome": "selected", "optionId": "allow-once"}}})
    );
    assert_eq!(
        stdin[6]["params"]["prompt"][0]["text"],
        "And one more thing."
    );
    assert_eq!(
        stdin[6]["params"]["sessionId"],
        "0cb4faa6-1a77-49e3-a4c7-572c1a178f9a"
    );
}

#[tokio::test]
async fn a_denied_plan_is_rejected_with_the_users_reason_and_keeps_planning() {
    let fake = Fake::new("plan-denied");
    let mut request = fake.request();
    request.permission = Some(AgentPermission::Plan);
    let deny = |_: &str| Decision::Deny {
        message: "Use three sections instead".into(),
        interrupt: false,
    };
    let events = run(&fake, request, deny, None).await;

    let stdin = fake.stdin();
    assert_eq!(
        stdin[4],
        json!({"jsonrpc": "2.0", "id": 0, "result": {"outcome": {"outcome": "rejected", "reason": "Use three sections instead"}}})
    );
    assert_eq!(stdin.len(), 5, "no switch to agent mode, and no build");
    assert_eq!(
        status_of(&events, "tool_6d56f15f-9285-4e66-8f3a-de596a50152"),
        Some(&ToolStatus::Denied)
    );
    let turn = Some(TURN.parse().unwrap());
    assert_eq!(
        turns(&events),
        [
            &Event::TurnStarted { turn_id: turn },
            &Event::TurnFinished {
                turn_id: turn,
                result: Some("Planning three sections instead.".into()),
                failed: false,
            },
        ]
    );
}

#[tokio::test]
async fn a_resumed_session_loads_and_drops_its_replayed_history() {
    let fake = Fake::new("resume");
    let mut request = fake.request();
    request.prompt =
        "Which file did you create earlier in this chat? Answer with the file name only.".into();
    request.resume = Some(Resume::new("0cb4faa6-1a77-49e3-a4c7-572c1a178f9a"));
    let events = run(&fake, request, allow, None).await;

    let stdin = fake.stdin();
    assert_eq!(stdin[1]["method"], "session/load");
    assert_eq!(
        stdin[1]["params"]["sessionId"],
        "0cb4faa6-1a77-49e3-a4c7-572c1a178f9a"
    );
    assert_eq!(
        stdin[2]["params"]["sessionId"],
        "0cb4faa6-1a77-49e3-a4c7-572c1a178f9a"
    );
    assert!(
        !events
            .iter()
            .any(|event| matches!(event, Event::ToolCall { .. } | Event::TodoList { .. })),
        "the replay's tool calls are already in the run's log"
    );
    let text: String = events
        .iter()
        .filter_map(|event| match event {
            Event::TextDelta { text, .. } => Some(text.as_str()),
            _ => None,
        })
        .collect();
    assert_eq!(text, "hello.txt");
    assert_eq!(
        outcome(&events),
        &Outcome::Completed {
            result: Some("hello.txt".into())
        }
    );
}

/// An agent configured as 0040's presets describe one that takes everything over ACP: no model or
/// bypass flag, and `modes` for its permissions.
fn acp_only(modes: Vec<(AgentPermission, String)>) -> AcpAgent {
    AcpAgent {
        modes,
        edit_mode: Some("build".into()),
        ..AcpAgent::new("agent", "Some Agent", "agent", &["acp"])
    }
}

#[tokio::test]
async fn a_model_and_mode_go_as_config_options_and_an_open_call_closes_with_the_turn() {
    let fake = Fake::with_agent(
        "opencode",
        acp_only(vec![(AgentPermission::Plan, "plan".into())]),
    );
    let mut request = fake.request();
    request.model = Some("opencode/big-pickle".into());
    request.permission = Some(AgentPermission::Plan);
    let events = run(&fake, request, allow, None).await;

    let sent = fake.stdin();
    let options: Vec<(&str, &str)> = sent
        .iter()
        .filter(|m| m["method"] == "session/set_config_option")
        .map(|m| {
            let p = &m["params"];
            (
                p["configId"].as_str().unwrap(),
                p["value"].as_str().unwrap(),
            )
        })
        .collect();
    assert_eq!(
        options,
        [("model", "opencode/big-pickle"), ("mode", "plan")]
    );
    assert!(sent.iter().all(|m| m["method"] != "session/set_model"));
    assert_eq!(status_of(&events, "call_1"), Some(&ToolStatus::Error));
    let usage: Vec<_> = events
        .iter()
        .filter_map(|e| match e {
            Event::Usage(usage) => Some(usage),
            _ => None,
        })
        .collect();
    assert_eq!(usage.len(), 1);
    assert_eq!(usage[0].model.as_deref(), Some("opencode/big-pickle"));
    assert_eq!(
        (usage[0].usage.input_tokens, usage[0].usage.output_tokens),
        (100, 30)
    );
    assert!(
        !events.iter().any(|e| matches!(e, Event::Warning { .. })),
        "usage_update is bookkeeping, not an unknown event"
    );
    assert!(matches!(outcome(&events), Outcome::Completed { .. }));
}

#[tokio::test]
async fn without_config_options_the_model_and_mode_go_as_their_own_methods() {
    let fake = Fake::with_agent(
        "hermes",
        acp_only(vec![(AgentPermission::Edit, "accept_edits".into())]),
    );
    let mut request = fake.request();
    request.model = Some("custom:qwen3-4b".into());
    let events = run(&fake, request, allow, None).await;

    let sent = fake.stdin();
    let set_model = sent
        .iter()
        .find(|m| m["method"] == "session/set_model")
        .unwrap();
    assert_eq!(set_model["params"]["modelId"], "custom:qwen3-4b");
    let set_mode = sent
        .iter()
        .find(|m| m["method"] == "session/set_mode")
        .unwrap();
    assert_eq!(set_mode["params"]["modeId"], "accept_edits");
    assert!(matches!(outcome(&events), Outcome::Completed { .. }));
}

#[tokio::test]
async fn a_plan_mode_the_agent_refuses_fails_the_run_before_its_prompt() {
    let fake = Fake::with_agent(
        "plan-refused",
        acp_only(vec![(AgentPermission::Plan, "plan".into())]),
    );
    let mut request = fake.request();
    request.model = None;
    request.permission = Some(AgentPermission::Plan);
    let events = run(&fake, request, allow, None).await;

    assert!(fake.stdin().iter().all(|m| m["method"] != "session/prompt"));
    let Outcome::Failed(failure) = outcome(&events) else {
        panic!("expected a failure, got {:?}", outcome(&events));
    };
    assert!(
        failure.message.contains("unknown mode plan"),
        "{}",
        failure.message
    );
}

/// PLX-370: ACP can't add to a running turn, so a steer cancels it, and goes as the next prompt
/// once the cancelled turn has ended.
#[tokio::test]
async fn a_steer_cancels_the_running_turn_and_goes_next() {
    let fake = Fake::new("steer");
    let started = fake.backend.start(fake.request()).unwrap();
    let mut stream = started.events;
    let mut events = Vec::new();
    loop {
        let event = next(&mut stream).await;
        let running = matches!(&event, Event::ToolCall { call_id, .. } if call_id == "tool_s");
        events.push(event);
        if running {
            break;
        }
    }
    let steer = TurnId::generate();
    started
        .run
        .send(FollowUp {
            turn_id: steer,
            text: "Change of plan: reply BANANA instead.".into(),
            images: Vec::new(),
            steer: true,
            model: None,
            permission: None,
        })
        .unwrap();
    events.extend(rest(&mut stream).await);
    let first = Some(TURN.parse().unwrap());
    assert_eq!(
        turns(&events),
        [
            &Event::TurnStarted { turn_id: first },
            &Event::TurnFinished {
                turn_id: first,
                result: None,
                failed: false,
            },
            &Event::TurnStarted {
                turn_id: Some(steer)
            },
            &Event::TurnFinished {
                turn_id: Some(steer),
                result: Some("BANANA".into()),
                failed: false,
            },
        ]
    );
    let stdin = fake.stdin();
    assert_eq!(
        stdin[3],
        json!({"jsonrpc": "2.0", "method": "session/cancel",
               "params": {"sessionId": "0cb4faa6-1a77-49e3-a4c7-572c1a178f9a"}})
    );
    assert_eq!(stdin[4]["method"], "session/prompt");
    assert_eq!(
        stdin[4]["params"]["prompt"][0]["text"],
        "Change of plan: reply BANANA instead."
    );
}

/// The thread's server goes in `session/new` and `session/load` only with `approvals` or Bypass,
/// and its tools then run without asking. A coordinator's go the same way (0042).
#[tokio::test]
async fn thread_mcp_is_injected_on_new_and_load_and_preapproved() {
    for (resume, approvals, bypass, coordinator) in [
        (false, true, false, false),
        (true, true, false, false),
        (false, false, false, false),
        (false, false, true, false),
        (false, false, true, true),
    ] {
        let fake = Fake::new("thread-mcp");
        let mut request = fake.request();
        let tools = Some(crate::backend::ThreadTools {
            program: "/bin/plxd".into(),
            data_dir: "/tmp/parallax data".into(),
            run: request.run_id,
        });
        if coordinator {
            request.thread = false;
            request.policy = crate::backend::ToolPolicy::NoWrite;
            request.coordinator_tools = tools;
        } else {
            request.thread_tools = tools;
        }
        let run_id = request.run_id;
        request.approvals = approvals;
        request.permission = bypass.then_some(AgentPermission::Bypass);
        request.resume = resume.then(|| Resume::new("mcp-session"));
        request.instructions = Some("Never edit files.".into());
        let events = run(
            &fake,
            request,
            |_| panic!("Parallax tools must not ask"),
            None,
        )
        .await;
        assert!(matches!(outcome(&events), Outcome::Completed { .. }));
        let messages = fake.stdin();
        assert_eq!(
            messages[1]["method"],
            if resume {
                "session/load"
            } else {
                "session/new"
            }
        );
        let expected_servers = if approvals || bypass {
            json!([{
                "name": "plxd", "command": "/bin/plxd",
                "args": ["mcp", "--data-dir", "/tmp/parallax data", "--thread", run_id.to_string()],
                "env": [],
            }])
        } else {
            json!([])
        };
        assert_eq!(messages[1]["params"]["mcpServers"], expected_servers);
        // ACP has no system prompt, so each process's first message leads with them (0078).
        let prompt = messages
            .iter()
            .find(|message| message["method"] == "session/prompt")
            .unwrap();
        assert_eq!(
            prompt["params"]["prompt"][0]["text"],
            format!("Never edit files.\n\n{PROMPT}")
        );
        assert_eq!(
            messages[3]["result"]["outcome"]["optionId"],
            if approvals || bypass {
                "allow-once"
            } else {
                "reject-once"
            }
        );
    }
}

/// An agent that stays up after stdin closes, as Cursor does while a stdio MCP server it started
/// is connected, is stopped once nothing is held for it, and its finished turn still completes.
#[tokio::test]
async fn an_agent_that_outlives_its_stdin_is_stopped_after_held_messages_are_released() {
    let fake = Fake::new("resume");
    fs::write(
        fake.root().join("fixture.jsonl"),
        format!("{}\n@linger\n", fixture("resume")),
    )
    .unwrap();
    let mut request = fake.request();
    request.resume = Some(Resume::new("0cb4faa6-1a77-49e3-a4c7-572c1a178f9a"));
    let started = fake.backend.start(request).unwrap();
    started.run.hold(true);
    let mut events = started.events;
    while !matches!(next(&mut events).await, Event::TurnFinished { .. }) {}
    assert!(
        tokio::time::timeout(Duration::from_secs(3), events.next())
            .await
            .is_err(),
        "a held session stays alive for its queued message"
    );
    started.run.hold(false);
    // The fake lingers for a minute, so only plxd stopping it ends the run this soon.
    let outcome = stopped(&mut events).await;
    assert!(matches!(outcome, Outcome::Completed { .. }), "{outcome:?}");
}

/// A real session, recorded with `PLXD_RECORD_CLI` (PLX-493), replays to its snapshot: a read, a
/// shell command that asks first, and the reply.
#[tokio::test]
async fn a_recorded_session_replays_to_its_snapshot() {
    let fake = Fake::new("recorded");
    crate::backend::record::assert_replays(
        fake.backend.start(fake.request()).unwrap(),
        std::path::Path::new(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/src/backend/acp/fixtures/recorded.events.jsonl"
        )),
    )
    .await;
}

/// A denied request, and any request in a run whose client can't answer, goes back as
/// `reject-once`.
#[tokio::test]
async fn a_denial_or_a_run_without_approvals_rejects_the_call() {
    {
        let fake = Fake::new("approval");
        let deny = |_: &str| Decision::Deny {
            message: "Not now.".into(),
            interrupt: false,
        };
        let events = run(&fake, fake.request(), deny, None).await;
        assert_eq!(
            fake.stdin()[4],
            json!({"jsonrpc": "2.0", "id": 1, "result": {"outcome": {"outcome": "selected", "optionId": "reject-once"}}})
        );
        assert_eq!(
            status_of(&events, "tool_a9c103b0-e438-4509-a890-8dd71a1d771"),
            Some(&ToolStatus::Denied)
        );
    }
    {
        let fake = Fake::new("approval");
        let mut request = fake.request();
        request.approvals = false;
        let events = run(&fake, request, |_| unreachable!("nothing asks"), None).await;
        assert!(
            !events
                .iter()
                .any(|event| matches!(event, Event::ApprovalRequested(_)))
        );
        assert_eq!(
            fake.stdin()[4]["result"]["outcome"]["optionId"],
            "reject-once"
        );
    }
}
/// plxd answers a permission request by the run's mode (0054), and auto-allows only the
/// injected server's known tools: a matching title alone never authorizes a shell or another
/// server's tool.
#[test]
fn a_permission_request_is_answered_by_the_mode_and_the_injected_server() {
    {
        // A matching title alone never authorizes a shell or another server's tool.
        use super::stream::{Step, Translator};
        for (provider, tool, kind, injected, allowed) in [
            ("plxd", "thread_list", "other", true, true),
            ("user-server", "thread_list", "other", true, false),
            ("plxd", "unknown", "other", true, false),
            ("plxd", "thread_list", "execute", true, false),
            ("plxd", "thread_list", "other", false, false),
        ] {
            let mut translator = Translator::default();
            translator.asks = true;
            translator.thread_tools = injected;
            let update = json!({"method": "session/update", "params": {"update": {
                "sessionUpdate": "tool_call", "toolCallId": "call", "kind": kind,
                "title": "plxd: thread_list", "status": "pending",
                "rawInput": {"providerIdentifier": provider, "toolName": tool}
            }}});
            translator.line(update.to_string().as_bytes());
            let ask = json!({"id": 7, "method": "session/request_permission", "params": {
                "toolCall": {"toolCallId": "call"},
                "options": [{"optionId": "yes", "kind": "allow_once"}],
            }});
            let steps = translator.line(ask.to_string().as_bytes());
            assert_eq!(
                steps.iter().any(|step| matches!(step, Step::Ask(..))),
                !allowed
            );
            let allowed_at_once = steps.iter().any(|step| {
                matches!(step, Step::Reply(value) if value["result"]["outcome"]["optionId"] == "yes")
            });
            assert_eq!(allowed_at_once, allowed);
        }
    }
    {
        // plxd answers an agent's permission requests by the run's mode (0054), whatever the agent is.
        use super::stream::{Step, Translator};
        for (permission, kind, allowed) in [
            (AgentPermission::Bypass, "execute", true),
            (AgentPermission::Edit, "edit", true),
            (AgentPermission::Edit, "execute", false),
            (AgentPermission::Manual, "edit", false),
            (AgentPermission::Plan, "edit", false),
        ] {
            let mut translator = Translator::default();
            translator.asks = true;
            translator.permission = Some(permission);
            let update = json!({"method": "session/update", "params": {"update": {
                "sessionUpdate": "tool_call", "toolCallId": "call", "kind": kind,
                "title": "a call", "status": "pending",
            }}});
            translator.line(update.to_string().as_bytes());
            let ask = json!({"id": 7, "method": "session/request_permission", "params": {
                "toolCall": {"toolCallId": "call"},
                "options": [{"optionId": "yes", "kind": "allow_once"}],
            }});
            let steps = translator.line(ask.to_string().as_bytes());
            assert_eq!(
                steps.iter().any(|step| matches!(step, Step::Ask(..))),
                !allowed,
                "{permission:?} {kind}"
            );
        }
    }
}
