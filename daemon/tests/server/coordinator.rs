//! The coordinator's planning loop (#196, decision 0020): `coordinator/*` against an in-process
//! wispd whose coordinator is a scripted fake that drives the real `wispd mcp`, and whose workers
//! run on the fake CLI in a real git repository.

use std::path::PathBuf;
use std::sync::{Arc, Mutex, PoisonError};
use std::time::Duration;

use serde_json::json;
use tokio::process::Command;
use tokio::time::{Instant, sleep};
use wisp_protocol::jsonrpc::INVALID_PARAMS;
use wisp_protocol::methods::{
    AccountsDefaultsSet, AgentStart, CoordinatorCancel, CoordinatorEvents, CoordinatorGet,
    CoordinatorSend,
};
use wisp_protocol::{
    AccountChoice, AccountsDefaultsSetParams, AgentFailureKind, AgentOutcome, AgentStartParams,
    CoordinatorCancelParams, CoordinatorEventsParams, CoordinatorGetParams, CoordinatorSendParams,
    CoordinatorStatus, CoordinatorThread, CoordinatorThreadId, ErrorKind, EventsEventParams,
    Project, ProjectId, Provider, Role, RunId, TurnId, WispEvent,
};
use wispd::backend::fake::Step;
use wispd::backend::{
    Backend, CancelSwitch, Capabilities, EVENT_BUFFER, Event, EventSink, Outcome, RunHandle,
    RunRequest, StartError, Started, ToolPolicy,
};
use wispd::mcp::TOOLS;

use crate::agents::{
    Conn, Host, create, end_turn, fake, init, project_params, start_params, subscribe, text, until,
};
use crate::mcp::{Mcp, coordinator_thread};
use crate::support::{InProcess, PATIENCE, kind, temp_dir};

/// The scripted coordinator's session.
const SESSION: &str = "coordinator-session-1";

/// What the scripted coordinator saw of one turn.
#[derive(Clone, Debug)]
struct Seen {
    prompt: String,
    resumed: Option<String>,
}

/// A coordinator backend for tests, named `codex` so the coordinator role's default can name it.
/// Each turn launches `wispd mcp` from the `CoordinatorTools` wispd passed, as a real CLI would
/// from its `--mcp-config`, and acts on its prompt:
///
/// - a wake-up (`wisp: ...`) ends the turn, having reviewed it;
/// - `WRITE` writes a file into the project checkout, which the no-write check must catch;
/// - `PING` ends the turn at once;
/// - `HANG` waits until cancelled;
/// - anything else spawns two workers through `spawn_agent` and ends the turn once both finished.
#[derive(Clone, Default)]
struct ScriptedCoordinator {
    seen: Arc<Mutex<Vec<Seen>>>,
}

impl ScriptedCoordinator {
    fn seen(&self) -> Vec<Seen> {
        self.seen
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .clone()
    }
}

impl Backend for ScriptedCoordinator {
    fn name(&self) -> &'static str {
        "codex"
    }

    fn capabilities(&self) -> Capabilities {
        Capabilities {
            coordinator: true,
            resume: true,
            ..Capabilities::default()
        }
    }

    fn start(&self, request: RunRequest) -> Result<Started, StartError> {
        assert_eq!(
            request.policy,
            ToolPolicy::NoWrite,
            "the coordinator never writes"
        );
        assert!(request.sandbox.is_none());
        let tools = request
            .coordinator_tools
            .clone()
            .ok_or_else(|| StartError::Invalid("the coordinator has no tools".into()))?;
        let config = tools.mcp_config()?;
        let server = &config["mcpServers"]["wispd"];
        let mut mcp = Command::new(server["command"].as_str().unwrap());
        mcp.args(
            server["args"]
                .as_array()
                .unwrap()
                .iter()
                .map(|arg| arg.as_str().unwrap()),
        )
        .env_remove("WISPD_DATA_DIR")
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .kill_on_drop(true);
        self.seen
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .push(Seen {
                prompt: request.prompt.clone(),
                resumed: request
                    .resume
                    .as_ref()
                    .map(|resume| resume.session_id.clone()),
            });
        let switch = CancelSwitch::new();
        let (handle, _follow_ups) = RunHandle::new(request.run_id, false, switch.clone());
        let (sink, events) = EventSink::channel(EVENT_BUFFER, Vec::new());
        tokio::spawn(turn(sink, switch, request, mcp));
        Ok(Started {
            run: Arc::new(handle),
            events,
        })
    }
}

async fn turn(mut sink: EventSink, switch: CancelSwitch, request: RunRequest, mcp: Command) {
    let session_id = request
        .resume
        .as_ref()
        .map_or_else(|| SESSION.to_owned(), |resume| resume.session_id.clone());
    let _ = sink
        .emit(Event::SessionStarted {
            session_id,
            model: None,
            api_key_source: None,
        })
        .await;
    let _ = sink
        .emit(Event::TurnStarted {
            turn_id: request.turn_id,
        })
        .await;
    let prompt = &request.prompt;
    let result = if prompt.contains("wisp: ") && prompt.contains("subagent") {
        "Reviewed the finished runs.".to_owned()
    } else if prompt.contains("WRITE") {
        std::fs::write(request.cwd.join("NOTES.md"), "written by the coordinator\n").unwrap();
        "Wrote a file.".to_owned()
    } else if prompt.contains("PING") {
        "Pong.".to_owned()
    } else if prompt.contains("HANG") {
        while !switch.is_cancelled() {
            sleep(Duration::from_millis(20)).await;
        }
        let _ = sink.finish(Outcome::Cancelled).await;
        return;
    } else {
        spawn_two_and_wait(mcp).await
    };
    let _ = sink
        .emit(Event::TurnFinished {
            turn_id: request.turn_id,
            result: Some(result.clone()),
        })
        .await;
    let _ = sink
        .finish(Outcome::Completed {
            result: Some(result),
        })
        .await;
}

/// Turn one: checks the tools, spawns two workers, and waits until both have finished, so their
/// wake-ups arrive while this turn runs, or at worst within the batching window after it.
async fn spawn_two_and_wait(command: Command) -> String {
    let mut mcp = Mcp::launch(command).await;
    let listed = mcp.request("tools/list", json!({})).await;
    let names: Vec<&str> = listed["result"]["tools"]
        .as_array()
        .unwrap()
        .iter()
        .map(|tool| tool["name"].as_str().unwrap())
        .collect();
    assert_eq!(names, TOOLS);
    for prompt in ["Write the build section.", "Write the test section."] {
        mcp.ok(
            "spawn_agent",
            json!({"prompt": prompt, "account": {"kind": "subscription", "backend": "fake"}}),
        )
        .await;
    }
    let deadline = Instant::now() + PATIENCE;
    loop {
        let listed = mcp.ok("list_agents", json!({})).await;
        let runs = listed["runs"].as_array().unwrap();
        if runs.len() == 2 && runs.iter().all(|run| run["status"] == "completed") {
            return "Started two workers.".to_owned();
        }
        assert!(
            Instant::now() < deadline,
            "the workers never finished: {listed}"
        );
        sleep(Duration::from_millis(50)).await;
    }
}

/// A worker that edits the README in its worktree and finishes.
fn worker() -> Vec<Step> {
    vec![
        init("worker-session"),
        Step::WriteFile {
            path: "README.md".to_owned(),
            content: "hello\nA section.\n".to_owned(),
        },
        text("Wrote the section."),
        end_turn("Done."),
    ]
}

/// An in-process wispd whose coordinator is `coordinator` and whose workers run [`worker`].
async fn host(coordinator: &ScriptedCoordinator) -> (Host, Conn, Project) {
    let dir = temp_dir();
    let mut backends = fake(worker());
    backends.register(Provider::Openai, Arc::new(coordinator.clone()));
    let mut config = InProcess::config(dir.path());
    config.backends = Some(backends);
    config.wispd_program = Some(PathBuf::from(env!("CARGO_BIN_EXE_wispd")));
    let server = InProcess::start(config);
    let host = Host { dir, server };
    let mut client = host.client().await;
    let project = create(&mut client, project_params(host.dir.path())).await;
    client
        .call::<AccountsDefaultsSet>(AccountsDefaultsSetParams {
            role: Role::Coordinator,
            account: Some(AccountChoice::Subscription {
                backend: "codex".to_owned(),
            }),
        })
        .await
        .unwrap();
    subscribe(&mut client, project.id, 0).await;
    (host, client, project)
}

async fn send(
    client: &mut Conn,
    project: ProjectId,
    turn_id: TurnId,
    text: &str,
) -> CoordinatorThread {
    client
        .call::<CoordinatorSend>(CoordinatorSendParams {
            project,
            turn_id,
            text: text.to_owned(),
        })
        .await
        .unwrap()
        .thread
}

fn finished(event: &EventsEventParams) -> Option<&AgentOutcome> {
    match &event.event {
        WispEvent::CoordinatorFinished { outcome, .. } => Some(outcome),
        _ => None,
    }
}

/// The `coordinator.turnStarted` events among `events`: their turn ids, run ids, and text.
fn turns(events: &[EventsEventParams]) -> Vec<(Vec<TurnId>, Vec<RunId>, String)> {
    events
        .iter()
        .filter_map(|event| match &event.event {
            WispEvent::CoordinatorTurnStarted {
                turn_ids,
                run_ids,
                text,
                ..
            } => Some((turn_ids.clone(), run_ids.clone(), text.clone())),
            _ => None,
        })
        .collect()
}

fn sorted(mut ids: Vec<RunId>) -> Vec<RunId> {
    ids.sort();
    ids
}

/// Events until the thread is idle again after the `n`th `coordinator.finished`.
async fn until_finished(client: &mut Conn, n: usize) -> Vec<EventsEventParams> {
    let mut seen = 0;
    until(client, |event| {
        seen += usize::from(finished(event).is_some());
        seen == n
            && matches!(&event.event, WispEvent::CoordinatorUpdated { state, .. } if state.status == CoordinatorStatus::Idle)
    })
    .await
}

/// #196's end to end: the coordinator plans in a new session, spawns two workers through its
/// tools, and is woken once, in its resumed session, with both runs' outcomes and diff stats.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn the_coordinator_spawns_two_workers_and_is_woken_once_when_both_finish() {
    let coordinator = ScriptedCoordinator::default();
    let (host, mut client, project) = host(&coordinator).await;
    let turn = TurnId::generate();

    let started = send(
        &mut client,
        project.id,
        turn,
        "Document the build and the tests.",
    )
    .await;
    assert_eq!(started.status, CoordinatorStatus::Running);
    assert_eq!(started.backend.as_deref(), Some("codex"));
    let events = until_finished(&mut client, 2).await;

    let delivered = turns(&events);
    assert_eq!(
        delivered.len(),
        2,
        "one turn for the message, one wake-up for both runs"
    );
    assert_eq!(delivered[0].0, [turn]);
    assert!(delivered[0].1.is_empty());
    let runs: Vec<RunId> = events
        .iter()
        .filter_map(|event| match &event.event {
            WispEvent::AgentStarted { run_id, run } => {
                assert_eq!(run.as_ref().unwrap().coordinator_thread, Some(started.id));
                Some(*run_id)
            }
            _ => None,
        })
        .collect();
    assert_eq!(runs.len(), 2);
    assert!(delivered[1].0.is_empty());
    assert_eq!(sorted(delivered[1].1.clone()), sorted(runs.clone()));
    let wake = &delivered[1].2;
    for run in &runs {
        assert!(
            wake.contains(&format!("- Run {run}: completed, saying: Done.")),
            "{wake}"
        );
    }
    assert!(wake.contains("changes 1 files, +1 -0"), "{wake}");
    assert!(
        wake.starts_with("wisp: 2 subagents you started have finished."),
        "{wake}"
    );
    for event in &events {
        if let Some(outcome) = finished(event) {
            assert!(
                matches!(outcome, AgentOutcome::Completed { .. }),
                "{outcome:?}"
            );
        }
    }

    let seen = coordinator.seen();
    assert_eq!(seen.len(), 2);
    assert_eq!(seen[0].resumed, None);
    assert!(
        seen[0]
            .prompt
            .starts_with("You are the coordinator of a wisp project."),
        "a new session starts with the planning instructions: {}",
        seen[0].prompt
    );
    assert!(
        seen[0]
            .prompt
            .ends_with("Document the build and the tests.")
    );
    assert_eq!(seen[1].resumed.as_deref(), Some(SESSION));
    assert_eq!(
        &seen[1].prompt, wake,
        "a resumed session gets only the wake-up"
    );

    afterwards(&mut client, project.id, turn, started.id, &coordinator).await;
    host.server.stop().await;
}

/// After the end to end: nothing else wakes the coordinator, a retried message isn't sent again,
/// and `coordinator/get` and `coordinator/events` show the thread and only its own events.
async fn afterwards(
    client: &mut Conn,
    project: ProjectId,
    turn: TurnId,
    thread_id: CoordinatorThreadId,
    coordinator: &ScriptedCoordinator,
) {
    // Nothing else wakes it, and a retried message is not sent again.
    client.stays_quiet(Duration::from_millis(1500)).await;
    let retried = send(client, project, turn, "Document the build and the tests.").await;
    assert_eq!(retried.status, CoordinatorStatus::Idle);
    let conflict = client
        .call::<CoordinatorSend>(CoordinatorSendParams {
            project,
            turn_id: turn,
            text: "Something else.".to_owned(),
        })
        .await
        .unwrap_err();
    assert_eq!(kind(&conflict), ErrorKind::IdConflict);
    assert_eq!(coordinator.seen().len(), 2);

    let thread = client
        .call::<CoordinatorGet>(CoordinatorGetParams { project })
        .await
        .unwrap()
        .thread;
    assert_eq!(thread.id, thread_id);
    assert_eq!(thread.session_id.as_deref(), Some(SESSION));
    assert_eq!(thread.error, None);

    let logged = client
        .call::<CoordinatorEvents>(CoordinatorEventsParams {
            project,
            after: 0,
            limit: None,
        })
        .await
        .unwrap();
    assert!(!logged.more);
    assert!(matches!(
        logged.events[0].event,
        WispEvent::CoordinatorStarted { .. }
    ));
    let replayed: Vec<EventsEventParams> = logged
        .events
        .iter()
        .map(|logged| EventsEventParams {
            subscription: wisp_protocol::SubscriptionId::generate(),
            seq: logged.seq,
            time: logged.time,
            project: logged.project,
            event: logged.event.clone(),
        })
        .collect();
    assert_eq!(turns(&replayed).len(), 2);
    assert!(
        logged.events.iter().all(|logged| !matches!(
            logged.event,
            WispEvent::AgentStarted { .. } | WispEvent::AgentFinished { .. }
        )),
        "only the coordinator's own events"
    );
}

/// Two runs the coordinator started finish while it is idle: one wake-up names both, and starts
/// a new session with the planning instructions first.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn runs_that_finish_together_while_idle_wake_the_coordinator_once() {
    let coordinator = ScriptedCoordinator::default();
    let (host, mut client, project) = host(&coordinator).await;
    let thread = coordinator_thread(&mut client, project.id).await;

    let mut runs = Vec::new();
    for prompt in ["First task.", "Second task."] {
        let params = AgentStartParams {
            coordinator_thread: Some(thread),
            ..start_params(project.id, prompt)
        };
        runs.push(client.call::<AgentStart>(params).await.unwrap().run.id);
    }
    let events = until_finished(&mut client, 1).await;
    let delivered = turns(&events);
    assert_eq!(delivered.len(), 1);
    assert_eq!(sorted(delivered[0].1.clone()), sorted(runs));
    let seen = coordinator.seen();
    assert_eq!(seen.len(), 1);
    assert!(
        seen[0]
            .prompt
            .starts_with("You are the coordinator of a wisp project.")
    );
    assert!(seen[0].prompt.ends_with(&delivered[0].2));
    client.stays_quiet(Duration::from_millis(1500)).await;
    host.server.stop().await;
}

/// 0004's second check: a turn that writes to the project checkout fails with
/// `policyViolation`, naming the file, and the thread keeps the error.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_turn_that_writes_to_the_checkout_fails_as_a_policy_violation() {
    let coordinator = ScriptedCoordinator::default();
    let (host, mut client, project) = host(&coordinator).await;

    send(&mut client, project.id, TurnId::generate(), "WRITE a note.").await;
    let events = until_finished(&mut client, 1).await;
    let outcome = events.iter().find_map(finished).unwrap();
    let AgentOutcome::Failed { failure, message } = outcome else {
        panic!("expected a failure, got {outcome:?}");
    };
    assert_eq!(*failure, AgentFailureKind::PolicyViolation);
    assert!(message.contains("NOTES.md"), "{message}");
    let thread = client
        .call::<CoordinatorGet>(CoordinatorGetParams {
            project: project.id,
        })
        .await
        .unwrap()
        .thread;
    assert_eq!(thread.status, CoordinatorStatus::Idle);
    assert!(thread.error.unwrap().contains("NOTES.md"));
    host.server.stop().await;
}

/// `coordinator/cancel` stops a running turn; the next message starts a turn again.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_cancelled_turn_ends_cancelled_and_the_next_message_runs() {
    let coordinator = ScriptedCoordinator::default();
    let (host, mut client, project) = host(&coordinator).await;

    send(
        &mut client,
        project.id,
        TurnId::generate(),
        "HANG for a while.",
    )
    .await;
    let cancelled = client
        .call::<CoordinatorCancel>(CoordinatorCancelParams {
            project: project.id,
        })
        .await
        .unwrap()
        .thread;
    assert_eq!(cancelled.status, CoordinatorStatus::Running);
    let events = until_finished(&mut client, 1).await;
    assert_eq!(
        events.iter().find_map(finished),
        Some(&AgentOutcome::Cancelled)
    );

    send(&mut client, project.id, TurnId::generate(), "PING").await;
    until_finished(&mut client, 1).await;
    let seen = coordinator.seen();
    assert_eq!(seen.len(), 2);
    assert_eq!(seen[1].resumed.as_deref(), Some(SESSION));
    host.server.stop().await;
}

/// `agent/start` takes a `coordinatorThread` only when it is the project's own.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_run_is_tagged_only_with_its_own_projects_coordinator_thread() {
    let coordinator = ScriptedCoordinator::default();
    let (host, mut client, project) = host(&coordinator).await;
    let other = create(&mut client, project_params(&host.dir.path().join("other"))).await;
    let theirs = coordinator_thread(&mut client, other.id).await;

    for thread in [CoordinatorThreadId::generate(), theirs] {
        let refused = client
            .call::<AgentStart>(AgentStartParams {
                coordinator_thread: Some(thread),
                ..start_params(project.id, "Tagged.")
            })
            .await
            .unwrap_err();
        assert_eq!(refused.code, INVALID_PARAMS, "{refused:?}");
        assert!(
            refused.message.contains("coordinatorThread"),
            "{}",
            refused.message
        );
    }
    let missing = client
        .call::<CoordinatorGet>(CoordinatorGetParams {
            project: ProjectId::generate(),
        })
        .await
        .unwrap_err();
    assert_eq!(kind(&missing), ErrorKind::ProjectNotFound);
    host.server.stop().await;
}
