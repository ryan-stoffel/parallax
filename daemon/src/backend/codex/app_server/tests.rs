//! A Codex thread against a fake `codex app-server` on `PATH` that plays a recorded conversation,
//! so each test spawns a real process and reads what plxd wrote to it. No test runs the real CLI.

use std::fs;
use std::os::unix::fs::PermissionsExt;
use std::path::PathBuf;
use std::time::Duration;

use serde_json::{Value, json};
use tempfile::TempDir;

use crate::backend::codex::CodexBackend;
use crate::backend::process::{Environment, Launcher};
use crate::backend::{
    AccountRef, AgentEffort, AgentPermission, Answer, ApiKey, Backend, Credential, Decision, Event,
    EventStream, FollowUp, ModelUsage, Outcome, Resume, RunId, RunRequest, StartError, ToolPolicy,
    ToolStatus, TurnId, Usage,
};
use crate::paths::DataDir;

/// A fake `codex` playing `fixture`, and the folder it records into.
fn fake(fixture: &str) -> (TempDir, CodexBackend) {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().canonicalize().unwrap();
    let bin = root.join("bin");
    fs::create_dir(&bin).unwrap();
    let program = bin.join("codex");
    fs::write(&program, include_str!("../fixtures/fake-app-server.sh")).unwrap();
    fs::set_permissions(&program, fs::Permissions::from_mode(0o755)).unwrap();
    let conversation = root.join("conversation.jsonl");
    fs::write(&conversation, fixture).unwrap();
    let base: Environment = [
        ("PATH", format!("{}:/usr/bin:/bin", bin.display())),
        ("FAKE_CODEX_DIR", root.display().to_string()),
        ("FAKE_CODEX_FIXTURE", conversation.display().to_string()),
        ("CODEX_API_KEY", "parallax-test-not-a-key".to_owned()),
    ]
    .into_iter()
    .collect();
    let launcher = Launcher::new(DataDir::new(root.join("data")).unwrap(), base);
    (dir, CodexBackend::new(launcher))
}

/// The JSON lines plxd wrote to the fake's stdin.
fn written(dir: &TempDir) -> Vec<Value> {
    fs::read_to_string(dir.path().join("stdin"))
        .unwrap()
        .lines()
        .map(|line| serde_json::from_str(line).unwrap())
        .collect()
}

fn request(permission: AgentPermission) -> RunRequest {
    RunRequest {
        run_id: RunId::generate(),
        turn_id: Some(TurnId::generate()),
        cwd: PathBuf::from("/"),
        prompt: "Commit the README change.".into(),
        images: Vec::new(),
        policy: ToolPolicy::WorkspaceWrite,
        sandbox: None,
        account: AccountRef {
            id: "codex".into(),
            credential: Credential::Subscription { config_home: None },
        },
        resume: None,
        model: Some("gpt-6-sol".into()),
        effort: Some(AgentEffort::High),
        permission: Some(permission),
        context_window: None,
        fast: None,
        coordinator_tools: None,
        thread_tools: None,
        approvals: true,
        thread: true,
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
            return all;
        }
    }
}

#[tokio::test]
async fn an_approval_round_trips_and_a_follow_up_joins_the_live_thread() {
    let (dir, backend) = fake(include_str!("../fixtures/app-server-manual.jsonl"));
    let request = request(AgentPermission::Manual);
    let first = request.turn_id;
    let started = backend.start(request).unwrap();
    let mut stream = started.events;
    let mut events = Vec::new();
    let asked = loop {
        match next(&mut stream).await {
            Event::ApprovalRequested(asked) => break asked,
            event => events.push(event),
        }
    };
    assert_eq!(asked.tool_name, "command_execution");
    assert_eq!(asked.call_id.as_deref(), Some("exec-c"));
    // Sent while the first turn waits: it runs once that turn completes.
    let follow_up = TurnId::generate();
    started
        .run
        .send(FollowUp {
            turn_id: follow_up,
            text: "What's the hash?".into(),
            images: Vec::new(),
            steer: false,
        })
        .unwrap();
    started
        .run
        .answer(Answer {
            approval_id: asked.approval_id,
            decision: Decision::Allow {
                input: None,
                always: true,
            },
        })
        .unwrap();
    events.extend(rest(&mut stream).await);

    let turns: Vec<&Event> = events
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
            &Event::TurnStarted { turn_id: first },
            &Event::TurnFinished {
                turn_id: first,
                result: Some("Committed.".into()),
                failed: false,
            },
            &Event::TurnStarted {
                turn_id: Some(follow_up)
            },
            &Event::TurnFinished {
                turn_id: Some(follow_up),
                result: Some("42ed0b6".into()),
                failed: false,
            },
        ]
    );
    assert!(events.contains(&Event::SessionStarted {
        session_id: "t-1".into(),
        model: Some("gpt-6-sol".into()),
        api_key_source: None,
    }));
    assert!(events.iter().any(|event| matches!(
        event,
        Event::ToolResult { call_id, status: ToolStatus::Ok, .. } if call_id == "exec-c"
    )));
    assert!(
        !events
            .iter()
            .any(|event| matches!(event, Event::ApprovalWithdrawn { .. })),
        "an answered request's serverRequest/resolved withdraws nothing"
    );
    assert_eq!(
        events.last(),
        Some(&Event::Finished {
            outcome: Outcome::Completed {
                result: Some("42ed0b6".into())
            },
            usage_totals: vec![ModelUsage {
                model: None,
                usage: Usage {
                    input_tokens: 120,
                    output_tokens: 20,
                    cache_read_tokens: 90,
                    ..Usage::default()
                }
            }],
        })
    );

    assert_manual_writes(&dir);
}

/// What plxd wrote to the Manual thread's app-server, and how it started it.
fn assert_manual_writes(dir: &TempDir) {
    let written = written(dir);
    let methods: Vec<&str> = written
        .iter()
        .map(|line| line["method"].as_str().unwrap_or("(response)"))
        .collect();
    assert_eq!(
        methods,
        [
            "initialize",
            "initialized",
            "thread/start",
            "turn/start",
            "(response)",
            "turn/start"
        ]
    );
    assert_eq!(
        written[2]["params"],
        json!({"cwd": "/", "approvalPolicy": "untrusted", "sandbox": "workspace-write",
               "model": "gpt-6-sol"}),
        "the user's own config, with only the mode and model on top"
    );
    assert_eq!(
        written[3]["params"],
        json!({"threadId": "t-1", "effort": "high", "input": [
            {"type": "text", "text": "Commit the README change.", "text_elements": []}
        ]}),
        "the first message is the user's, as written"
    );
    assert_eq!(
        written[4],
        json!({"id": 0, "result": {"decision": "acceptForSession"}})
    );
    assert_eq!(written[5]["params"]["input"][0]["text"], "What's the hash?");
    let argv = fs::read_to_string(dir.path().join("argv")).unwrap();
    assert_eq!(argv, "app-server\n");
    let env = fs::read_to_string(dir.path().join("env")).unwrap();
    assert!(
        !env.contains("CODEX_API_KEY"),
        "inherited credentials are scrubbed"
    );
}

#[tokio::test]
async fn a_resumed_thread_without_approvals_never_asks_and_declines_what_codex_does() {
    let (dir, backend) = fake(include_str!("../fixtures/app-server-resume.jsonl"));
    let mut request = request(AgentPermission::Manual);
    request.approvals = false;
    request.context_window = Some(872_000);
    request.fast = Some(true);
    request.resume = Some(Resume {
        session_id: "t-0".into(),
        usage_totals: vec![ModelUsage {
            model: None,
            usage: Usage {
                input_tokens: 1000,
                output_tokens: 100,
                ..Usage::default()
            },
        }],
        fork: false,
    });
    let events = rest(&mut backend.start(request).unwrap().events).await;
    assert!(
        !events
            .iter()
            .any(|event| matches!(event, Event::ApprovalRequested(_))),
        "a client that can't answer never sees a request"
    );
    assert!(events.iter().any(|event| matches!(
        event,
        Event::ToolResult {
            status: ToolStatus::Denied,
            ..
        }
    )));
    let added: u64 = events
        .iter()
        .filter_map(|event| match event {
            Event::Usage(delta) => Some(delta.usage.input_tokens),
            _ => None,
        })
        .sum();
    assert_eq!(added, 300, "only what the resumed thread added");
    assert!(matches!(
        events.last(),
        Some(Event::Finished {
            outcome: Outcome::Completed { result: None },
            ..
        })
    ));

    let written = written(&dir);
    assert_eq!(written[2]["method"], "thread/resume");
    assert_eq!(
        written[2]["params"],
        json!({"threadId": "t-0", "excludeTurns": true, "cwd": "/", "approvalPolicy": "never",
               "sandbox": "workspace-write", "model": "gpt-6-sol",
               "config": {"model_context_window": 872_000}, "serviceTier": "priority"})
    );
    assert_eq!(
        written[4],
        json!({"id": 0, "result": {"decision": "decline"}})
    );
    assert_eq!(written[5]["id"], 1);
    assert_eq!(written[5]["error"]["code"], -32601);
}

/// A `/compact` (PLX-638) compacts the thread with `thread/compact/start` instead of starting a
/// turn, and its `contextCompaction` item shows under way, then done.
#[tokio::test]
async fn compact_compacts_the_thread_instead_of_starting_a_turn() {
    let (dir, backend) = fake(include_str!("../fixtures/app-server-compact.jsonl"));
    let mut request = request(AgentPermission::Edit);
    request.prompt = " /Compact\n".into();
    request.resume = Some(Resume::new("t-0"));
    let turn_id = request.turn_id;
    let events = rest(&mut backend.start(request).unwrap().events).await;
    let shown: Vec<&Event> = events
        .iter()
        .filter(|event| {
            matches!(
                event,
                Event::ContextCompaction { .. } | Event::TurnFinished { .. }
            )
        })
        .collect();
    assert_eq!(
        shown,
        [
            &Event::ContextCompaction { done: false },
            &Event::ContextCompaction { done: true },
            &Event::TurnFinished {
                turn_id,
                result: None,
                failed: false,
            },
        ]
    );
    assert!(matches!(
        events.last(),
        Some(Event::Finished {
            outcome: Outcome::Completed { result: None },
            ..
        })
    ));
    let written = written(&dir);
    assert_eq!(
        written[3],
        json!({"id": 3, "method": "thread/compact/start", "params": {"threadId": "t-0"}})
    );
}

/// A fork's first run forks the parent's thread rather than resuming it (0050).
#[test]
fn a_forks_first_run_forks_the_thread() {
    let mut request = request(AgentPermission::Edit);
    request.resume = Some(Resume {
        fork: true,
        ..Resume::new("t-0")
    });
    let (method, params) = super::thread_params(&request).unwrap();
    assert_eq!(method, "thread/fork");
    assert_eq!(params["threadId"], "t-0");
}

#[test]
fn a_thread_on_an_api_key_or_in_plan_is_refused_before_spawning() {
    let (_dir, backend) = fake("");
    let mut keyed = request(AgentPermission::Edit);
    keyed.account.credential = Credential::ApiKey(ApiKey::new("sk-test".into()));
    let plan = request(AgentPermission::Plan);
    for request in [keyed, plan] {
        assert!(matches!(
            backend.start(request),
            Err(StartError::Unsupported(_))
        ));
    }
}

/// PLX-370: a steer sent while a command runs is `turn/steer` with Codex's id for the running
/// turn, and its turn ends with that turn. Held, app-server stays open after the turn until plxd
/// lets it go.
#[tokio::test]
async fn a_steer_joins_the_running_turn_and_a_held_thread_stays_open() {
    let (dir, backend) = fake(include_str!("../fixtures/app-server-steer.jsonl"));
    let mut request = request(AgentPermission::Edit);
    request.approvals = false;
    let first = request.turn_id;
    let started = backend.start(request).unwrap();
    let mut stream = started.events;
    let mut events = Vec::new();
    loop {
        let event = next(&mut stream).await;
        let running = matches!(&event, Event::ToolCall { call_id, .. } if call_id == "exec-1");
        events.push(event);
        if running {
            break;
        }
    }
    started.run.hold(true);
    let steer = TurnId::generate();
    started
        .run
        .send(FollowUp {
            turn_id: steer,
            text: "Change of plan: reply BANANA instead.".into(),
            images: Vec::new(),
            steer: true,
        })
        .unwrap();
    let turn_done = loop {
        let event = next(&mut stream).await;
        let done = matches!(event, Event::TurnFinished { turn_id: Some(id), .. } if id == steer);
        events.push(event);
        if done {
            break events.len();
        }
    };
    // Held, the thread waits for more instead of exiting.
    assert!(
        tokio::time::timeout(Duration::from_millis(300), stream.next())
            .await
            .is_err(),
        "a held thread ended"
    );
    started.run.hold(false);
    events.extend(rest(&mut stream).await);

    let turns: Vec<&Event> = events[..turn_done]
        .iter()
        .filter(|event| {
            matches!(
                event,
                Event::TurnStarted { .. } | Event::TurnFinished { .. }
            )
        })
        .collect();
    let banana = Some("BANANA".to_owned());
    assert_eq!(
        turns,
        [
            &Event::TurnStarted { turn_id: first },
            &Event::TurnStarted {
                turn_id: Some(steer)
            },
            &Event::TurnFinished {
                turn_id: first,
                result: banana.clone(),
                failed: false,
            },
            &Event::TurnFinished {
                turn_id: Some(steer),
                result: banana.clone(),
                failed: false,
            },
        ]
    );
    assert!(matches!(
        events.last(),
        Some(Event::Finished {
            outcome: Outcome::Completed { .. },
            ..
        })
    ));
    let written = written(&dir);
    assert_eq!(written[4]["method"], "turn/steer");
    assert_eq!(
        written[4]["params"],
        json!({"threadId": "t-1", "expectedTurnId": "u-1", "input": [{"type": "text",
               "text": "Change of plan: reply BANANA instead.", "text_elements": []}]})
    );
}

/// 0060: threads on one login share one app-server, which initializes once and sends each
/// thread its own lines, and a thread that is done unloads with `thread/unsubscribe`.
#[tokio::test]
async fn threads_on_one_login_share_an_app_server_and_unsubscribe_when_done() {
    let (dir, backend) = fake(include_str!("../fixtures/app-server-shared.jsonl"));
    let mut runs = Vec::new();
    for _ in 0..2 {
        let mut request = request(AgentPermission::Edit);
        request.approvals = false;
        runs.push(backend.start(request).unwrap().events);
    }
    let mut sessions = Vec::new();
    for stream in &mut runs {
        let events = rest(stream).await;
        let session = events.iter().find_map(|event| match event {
            Event::SessionStarted { session_id, .. } => Some(session_id.clone()),
            _ => None,
        });
        let text = events.iter().find_map(|event| match event {
            Event::Text { text, .. } => Some(text.clone()),
            _ => None,
        });
        let expected = match session.as_deref() {
            Some("t-1") => "First thread.",
            Some("t-2") => "Second thread.",
            other => panic!("no thread for {other:?}: {events:?}"),
        };
        assert_eq!(text.as_deref(), Some(expected), "{events:?}");
        assert!(matches!(
            events.last(),
            Some(Event::Finished {
                outcome: Outcome::Completed { .. },
                ..
            })
        ));
        sessions.extend(session);
    }
    sessions.sort();
    assert_eq!(sessions, ["t-1", "t-2"]);

    // Both unsubscribe, then the last one's leaving closes stdin.
    let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
    let written = loop {
        let written: Vec<Value> = fs::read_to_string(dir.path().join("stdin"))
            .unwrap_or_default()
            .lines()
            .map(|line| serde_json::from_str(line).unwrap())
            .collect();
        let unsubscribed = written
            .iter()
            .filter(|line| line["method"] == "thread/unsubscribe")
            .count();
        if unsubscribed == 2 {
            break written;
        }
        assert!(tokio::time::Instant::now() < deadline, "{written:?}");
        tokio::time::sleep(Duration::from_millis(20)).await;
    };
    let initialized = written
        .iter()
        .filter(|line| line["method"] == "initialize")
        .count();
    assert_eq!(initialized, 1, "one app-server: {written:?}");
}

/// A Project's coordinator runs on app-server as a thread does, with its own tools (0042).
#[test]
fn a_coordinator_gets_its_tools_as_a_thread_does() {
    let mut request = request(AgentPermission::Auto);
    request.thread = false;
    request.policy = crate::backend::ToolPolicy::NoWrite;
    request.coordinator_tools = Some(crate::backend::ThreadTools {
        program: "/bin/plxd".into(),
        data_dir: "/tmp/parallax".into(),
        run: request.run_id,
    });
    assert!(request.full_agent());
    let (method, params) = super::thread_params(&request).unwrap();
    assert_eq!(method, "thread/start");
    assert_eq!(
        params["config"]["mcp_servers.plxd.args"],
        json!([
            "mcp",
            "--data-dir",
            "/tmp/parallax",
            "--thread",
            request.run_id.to_string()
        ])
    );
    request.coordinator_tools = None;
    assert!(!request.full_agent(), "any other run is refused");
}

/// Session overrides add only plxd's keys, so app-server retains the user's servers.
#[test]
fn thread_mcp_joins_user_config_on_start_resume_and_fork() {
    for (resume, expected) in [
        (None, "thread/start"),
        (Some(false), "thread/resume"),
        (Some(true), "thread/fork"),
    ] {
        let mut request = request(AgentPermission::Edit);
        request.resume = resume.map(|fork| Resume {
            fork,
            ..Resume::new("t-parent")
        });
        request.context_window = Some(872_000);
        request.thread_tools = Some(crate::backend::ThreadTools {
            program: "/bin/plxd".into(),
            data_dir: "/tmp/parallax data".into(),
            run: request.run_id,
        });
        let (method, params) = super::thread_params(&request).unwrap();
        assert_eq!(method, expected);
        assert_eq!(
            params["config"],
            json!({
                "model_context_window": 872_000,
                "mcp_servers.plxd.command": "/bin/plxd",
                "mcp_servers.plxd.args":
                    ["mcp", "--data-dir", "/tmp/parallax data", "--thread", request.run_id.to_string()],
                "mcp_servers.plxd.default_tools_approval_mode": "approve",
            })
        );
        request.approvals = false;
        let (_, params) = super::thread_params(&request).unwrap();
        assert_eq!(params["config"], json!({"model_context_window": 872_000}));
        request.permission = Some(AgentPermission::Bypass);
        let (_, params) = super::thread_params(&request).unwrap();
        assert_eq!(params["config"]["mcp_servers.plxd.command"], "/bin/plxd");
    }
}

/// A real session, recorded with `PLXD_RECORD_CLI` (PLX-493), replays to its snapshot: two shell
/// commands that each ask first, and the reply.
#[tokio::test]
async fn a_recorded_session_replays_to_its_snapshot() {
    let (_dir, backend) = fake(include_str!("../fixtures/recorded.jsonl"));
    let request = RunRequest {
        turn_id: Some("01997e2a-4c3b-7d10-8a2e-5f6b7c8d9e01".parse().unwrap()),
        ..request(AgentPermission::Manual)
    };
    crate::backend::record::assert_replays(
        backend.start(request).unwrap(),
        std::path::Path::new(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/src/backend/codex/fixtures/recorded.events.jsonl"
        )),
    )
    .await;
}
