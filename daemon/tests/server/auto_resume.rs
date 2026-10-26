//! Auto-resume after a usage limit (PLX-371, decision 0049), end to end: a run the fake CLI stops
//! `rateLimited` waits, with its stored timer, and resumes its session when the limit resets.

use std::collections::VecDeque;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use jiff::{SignedDuration, Timestamp};
use parallax_protocol::methods::{AgentList, AgentStart};
use parallax_protocol::{
    AgentListParams, AgentOutputItem, AgentPermission, AgentRunState, AgentStatus,
    EventsEventParams, ParallaxEvent, Provider, RunId,
};
use plxd::backend::fake::{FakeBackend, Step};
use plxd::backend::{
    Backend, Capabilities, Event, LimitStatus, LimitWindow, RunRequest, StartError, Started,
};
use plxd::routing::BackendRegistry;

use crate::agents::{
    Conn, Host, end_turn, fake_backend, init, items, start_params, subscribe, until, updated_to,
};
use crate::support::{InProcess, temp_dir};

/// What plxd sends a run once its limit resets.
const CONTINUE: &str = "Your usage limit has reset. Continue where you left off.";

/// What plxd sends a run whose CLI was killed from outside (PLX-805).
const KILLED: &str = "Your CLI was killed by a signal Parallax didn't send, and any background \
    tasks it ran were stopped with it. Continue where you left off, restarting any you still need.";

/// The fake backend playing one script per CLI it starts, the last one again once they run out,
/// and keeping every request.
struct Sequence {
    scripts: Mutex<VecDeque<FakeBackend>>,
    seen: Arc<Mutex<Vec<RunRequest>>>,
}

impl Backend for Sequence {
    fn name(&self) -> &'static str {
        "fake"
    }

    fn capabilities(&self) -> Capabilities {
        self.scripts.lock().unwrap()[0].capabilities()
    }

    // The fake's (0042), so its runs start in a Project's mode.
    fn permissions(&self) -> &[AgentPermission] {
        &[AgentPermission::Auto, AgentPermission::Bypass]
    }

    fn start(&self, request: RunRequest) -> Result<Started, StartError> {
        self.seen.lock().unwrap().push(request.clone());
        let mut scripts = self.scripts.lock().unwrap();
        let next = if scripts.len() > 1 {
            scripts.pop_front().unwrap()
        } else {
            scripts[0].clone()
        };
        next.start(request)
    }
}

fn sequence(scripts: Vec<Vec<Step>>, seen: &Arc<Mutex<Vec<RunRequest>>>) -> BackendRegistry {
    let mut backends = BackendRegistry::new();
    backends.register(
        Provider::Anthropic,
        Arc::new(Sequence {
            scripts: Mutex::new(scripts.into_iter().map(fake_backend).collect()),
            seen: Arc::clone(seen),
        }),
    );
    backends
}

/// An in-process plxd with no jitter, and a backoff of `backoff` with no reset known.
fn host(dir: tempfile::TempDir, backends: BackendRegistry, backoff: Duration) -> Host {
    let mut config = InProcess::config(dir.path());
    config.backends = Some(backends);
    config.resume_jitter = Duration::ZERO;
    config.resume_backoff = backoff;
    let server = InProcess::start(config);
    Host { dir, server }
}

/// A CLI that the account's limit stops, reporting the window that resets at `reset`, if any.
fn limited(session: &str, reset: Option<Timestamp>) -> Vec<Step> {
    let mut steps = vec![init(session)];
    if let Some(reset) = reset {
        steps.push(Step::Emit(Event::RateLimit(LimitWindow {
            window: "five_hour".to_owned(),
            duration_minutes: Some(300),
            used_percent: Some(100.0),
            status: LimitStatus::Rejected,
            resets_at: Some(reset),
        })));
    }
    steps.push(Step::Emit(
        serde_json::from_value(serde_json::json!({
            "kind": "finished",
            "outcome": {"status": "failed", "failure": "rateLimited", "message": "You've hit your limit"},
        }))
        .unwrap(),
    ));
    steps.push(Step::Exit(1));
    steps
}

/// A resumed CLI that says what it was sent and finishes.
fn resumed() -> Vec<Step> {
    vec![init("unused"), Step::EchoPrompt, end_turn("done")]
}

fn waiting(event: &EventsEventParams) -> Option<&AgentRunState> {
    match &event.event {
        ParallaxEvent::AgentUpdated { state, .. } if state.status == AgentStatus::Waiting => {
            Some(state)
        }
        _ => None,
    }
}

async fn status(client: &mut Conn, run: RunId) -> AgentStatus {
    let runs = client
        .call::<AgentList>(AgentListParams::default())
        .await
        .unwrap()
        .runs;
    runs.into_iter().find(|r| r.id == run).unwrap().status
}

/// A reset `seconds` from now. Tests use at least 3: creating a Project and starting its run cut
/// worktrees (PLX-409), which can take over a second on a busy runner.
fn in_seconds(seconds: i64) -> Timestamp {
    Timestamp::now() + SignedDuration::from_secs(seconds)
}

/// The text of each turn the transcript started, and whether plxd sent it.
fn turns(events: &[EventsEventParams]) -> Vec<(String, bool)> {
    items(events)
        .into_iter()
        .filter_map(|item| match item {
            AgentOutputItem::TurnStarted {
                text: Some(text),
                wake,
                ..
            } => Some((text, wake)),
            _ => None,
        })
        .collect()
}

/// The stored timer outlives plxd: a run waiting when plxd stops resumes its session at the reset
/// once plxd is back, with plxd's own "continue" turn, and only once.
#[tokio::test]
async fn a_limited_run_resumes_at_its_reset_after_a_restart() {
    let seen = Arc::new(Mutex::new(Vec::new()));
    let reset = in_seconds(3);
    let backends = sequence(vec![limited("s-1", Some(reset)), resumed()], &seen);
    let host = host(temp_dir(), backends, Duration::from_secs(600));
    let (mut client, project) = host.project_client().await;
    let run = client
        .call::<AgentStart>(start_params(project.id, "Build it."))
        .await
        .unwrap()
        .run;
    let events = until(&mut client, |event| waiting(event).is_some()).await;
    let state = waiting(events.last().unwrap()).unwrap();
    assert_eq!(
        state.resume_at,
        Some(reset),
        "it waits for the reset the CLI reported"
    );
    assert_eq!(state.error.as_deref(), Some("You've hit your limit"));
    let seq = events.last().unwrap().seq;
    drop(client);

    let host = {
        let Host { dir, server } = host;
        server.stop().await;
        self::host(
            dir,
            sequence(vec![resumed()], &seen),
            Duration::from_secs(600),
        )
    };
    let mut client = host.client().await;
    subscribe(&mut client, project.id, seq).await;
    let events = until(&mut client, updated_to(AgentStatus::Completed)).await;
    assert!(Timestamp::now() >= reset, "not before the reset");
    assert!(items(&events).contains(&AgentOutputItem::Text {
        message_id: None,
        text: CONTINUE.to_owned(),
    }));
    assert!(
        items(&events).iter().any(|item| matches!(
            item,
            AgentOutputItem::TurnStarted { text: Some(text), wake: true, .. } if text == CONTINUE
        )),
        "the transcript marks it as plxd's turn: {events:#?}"
    );
    let launches = seen.lock().unwrap().clone();
    assert_eq!(launches.len(), 2);
    assert_eq!(
        launches[1]
            .resume
            .as_ref()
            .map(|resume| resume.session_id.as_str()),
        Some("s-1"),
        "the session resumes"
    );
    assert_eq!(launches[1].prompt, CONTINUE);
    assert_eq!(status(&mut client, run.id).await, AgentStatus::Completed);
    host.server.stop().await;
}

/// A CLI that runs `steps` in session `session`, then is killed by a signal plxd didn't send.
fn killed(session: &str, steps: Vec<Step>) -> Vec<Step> {
    let mut script = vec![init(session)];
    script.extend(steps);
    script.push(Step::Crash);
    script
}

/// Starts a run on a fresh plxd playing `scripts`, one per CLI. Returns the host, a subscribed
/// client, and the run.
async fn started(
    scripts: Vec<Vec<Step>>,
    seen: &Arc<Mutex<Vec<RunRequest>>>,
) -> (Host, Conn, RunId) {
    let host = host(
        temp_dir(),
        sequence(scripts, seen),
        Duration::from_secs(600),
    );
    let (mut client, project) = host.project_client().await;
    let run = client
        .call::<AgentStart>(start_params(project.id, "Build it."))
        .await
        .unwrap()
        .run;
    (host, client, run.id)
}

/// The launches so far resumed session `s-1` with plxd's [`KILLED`] turn, after the first.
fn resumed_killed(seen: &Arc<Mutex<Vec<RunRequest>>>) {
    for launch in &seen.lock().unwrap()[1..] {
        assert_eq!(
            launch
                .resume
                .as_ref()
                .map(|resume| resume.session_id.as_str()),
            Some("s-1")
        );
        assert_eq!(launch.prompt, KILLED);
    }
}

/// PLX-805: a CLI killed mid-turn by a signal plxd didn't send, as by a stray `pkill`, resumes its
/// session with plxd's own turn and carries on.
#[tokio::test]
async fn a_cli_killed_mid_turn_resumes_its_session() {
    let seen = Arc::new(Mutex::new(Vec::new()));
    let (host, mut client, run) = started(vec![killed("s-1", Vec::new()), resumed()], &seen).await;
    let events = until(&mut client, updated_to(AgentStatus::Completed)).await;
    assert!(
        turns(&events).contains(&(KILLED.to_owned(), true)),
        "{events:#?}"
    );
    assert_eq!(seen.lock().unwrap().len(), 2);
    resumed_killed(&seen);
    assert_eq!(status(&mut client, run).await, AgentStatus::Completed);
    host.server.stop().await;
}

/// PLX-805: a resumed CLI killed again before any turn completes stays stopped, so one that keeps
/// dying isn't restarted forever.
#[tokio::test]
async fn a_cli_killed_again_before_a_turn_completes_stays_stopped() {
    let seen = Arc::new(Mutex::new(Vec::new()));
    let scripts = vec![
        killed("s-1", Vec::new()),
        killed("s-1", Vec::new()),
        resumed(),
    ];
    let (host, mut client, run) = started(scripts, &seen).await;
    until(&mut client, updated_to(AgentStatus::Failed)).await;
    until(&mut client, updated_to(AgentStatus::Failed)).await;
    tokio::time::sleep(Duration::from_millis(500)).await;
    assert_eq!(
        seen.lock().unwrap().len(),
        2,
        "the second kill started nothing"
    );
    resumed_killed(&seen);
    assert_eq!(status(&mut client, run).await, AgentStatus::Failed);
    host.server.stop().await;
}
