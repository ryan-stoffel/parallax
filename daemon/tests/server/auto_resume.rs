//! Auto-resume after a usage limit (PLX-371, decision 0049), end to end: a run the fake CLI stops
//! `rateLimited` waits, with its stored timer, and resumes its session when the limit resets.

use std::collections::VecDeque;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use jiff::{SignedDuration, Timestamp};
use parallax_protocol::methods::{
    AgentCancel, AgentList, AgentResumeNow, AgentSend, AgentStart, HostSettingsGet, ThreadStart,
};
use parallax_protocol::{
    AgentBackgroundKind, AgentBackgroundTask, AgentCancelParams, AgentListParams, AgentOutputItem,
    AgentPermission, AgentResumeNowParams, AgentRunState, AgentStatus, ErrorKind,
    EventsEventParams, HostSettingsGetParams, ParallaxEvent, ProjectId, Provider, RunId, TurnId,
};
use plxd::backend::fake::{FakeBackend, Step};
use plxd::backend::{
    Backend, Capabilities, Event, LimitStatus, LimitWindow, RunRequest, StartError, Started,
};
use plxd::routing::BackendRegistry;

use crate::agents::{
    Conn, Host, end_turn, fake_backend, init, items, real_repo, send_params, start_params,
    subscribe, until, updated_to,
};
use crate::support::{InProcess, kind, temp_dir};

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

/// Sleeps until a moment after `at`.
async fn sleep_past(at: Timestamp) {
    let wait: Duration = at
        .duration_since(Timestamp::now())
        .try_into()
        .unwrap_or_default();
    tokio::time::sleep(wait + Duration::from_millis(300)).await;
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

/// Starts a run on a fresh plxd whose first CLI the limit stops until `reset`, and the scripts
/// after it, and waits until it is waiting. Returns the host, a subscribed client, and the run.
async fn waiting_run(
    reset: Timestamp,
    seen: &Arc<Mutex<Vec<RunRequest>>>,
) -> (Host, Conn, RunId, u64) {
    let backends = sequence(vec![limited("s-1", Some(reset)), resumed()], seen);
    let host = host(temp_dir(), backends, Duration::from_secs(600));
    let (mut client, project) = host.project_client().await;
    let run = client
        .call::<AgentStart>(start_params(project.id, "Build it."))
        .await
        .unwrap()
        .run;
    let events = until(&mut client, |event| waiting(event).is_some()).await;
    let seq = events.last().unwrap().seq;
    (host, client, run.id, seq)
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

/// `agent/cancel` on a waiting run clears its timer: it is `cancelled`, and nothing starts when
/// the reset comes.
#[tokio::test]
async fn cancelling_a_waiting_run_clears_its_timer() {
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
    until(&mut client, |event| waiting(event).is_some()).await;

    let cancelled = client
        .call::<AgentCancel>(AgentCancelParams {
            run_id: run.id,
            from: None,
        })
        .await
        .unwrap()
        .run;
    assert_eq!(cancelled.status, AgentStatus::Cancelled);
    assert_eq!(cancelled.resume_at, None);
    tokio::time::sleep(Duration::from_secs(2)).await;
    assert_eq!(seen.lock().unwrap().len(), 1, "nothing resumed it");
    assert_eq!(status(&mut client, run.id).await, AgentStatus::Cancelled);
    let refused = client
        .call::<AgentResumeNow>(AgentResumeNowParams { run_id: run.id })
        .await
        .unwrap_err();
    assert_eq!(kind(&refused), ErrorKind::RunNotResumable);
    host.server.stop().await;
}

/// Cursor reports no reset time, so each resume that finds the limit still on waits twice as long
/// as the last. Each limit is waited for once: every wait ends in exactly one resume.
#[tokio::test]
async fn with_no_reset_time_it_retries_on_a_growing_interval() {
    let seen = Arc::new(Mutex::new(Vec::new()));
    let backoff = Duration::from_millis(300);
    let backends = sequence(vec![limited("s-1", None)], &seen);
    let host = host(temp_dir(), backends, backoff);
    let (mut client, project) = host.project_client().await;
    client
        .call::<AgentStart>(start_params(project.id, "Build it."))
        .await
        .unwrap();
    let mut waits = Vec::new();
    for _ in 0..3 {
        let events = until(&mut client, |event| waiting(event).is_some()).await;
        let state = waiting(events.last().unwrap()).unwrap();
        waits.push(state.resume_at.unwrap().duration_since(state.updated_at));
    }
    let millis: Vec<i64> = waits
        .iter()
        .map(|wait| i64::try_from(wait.as_millis()).unwrap())
        .collect();
    for (wait, expected) in millis.iter().zip([300, 600, 1200]) {
        assert!(
            (expected - 100..=expected).contains(wait),
            "waits {millis:?} should double from 300 ms"
        );
    }
    assert_eq!(seen.lock().unwrap().len(), 3, "one resume per wait");
    host.server.stop().await;
}

/// The host setting is off by default (0060): a plain thread a limit stops just fails, and
/// `agent/resumeNow` refuses it. A Project's runs, as in the tests above, wait whatever it says.
#[tokio::test]
async fn a_plain_thread_waits_only_with_the_host_setting_on() {
    let seen = Arc::new(Mutex::new(Vec::new()));
    let backends = sequence(vec![limited("s-1", Some(in_seconds(60)))], &seen);
    let host = host(temp_dir(), backends, Duration::from_secs(600));
    let mut client = host.client().await;
    let settings = client
        .call::<HostSettingsGet>(HostSettingsGetParams {})
        .await
        .unwrap();
    assert!(!settings.auto_resume, "off by default");

    let checkout = temp_dir();
    let repo = client.add(&real_repo(checkout.path())).await;
    let scope = ProjectId::try_from(uuid::Uuid::from(repo.id)).unwrap();
    subscribe(&mut client, scope, 0).await;
    let start = crate::open_pr::thread(Some(repo.id));
    let run_id = start.run_id;
    client.call::<ThreadStart>(start).await.unwrap();
    let events = until(&mut client, updated_to(AgentStatus::Failed)).await;
    assert!(events.iter().all(|event| waiting(event).is_none()));
    let refused = client
        .call::<AgentResumeNow>(AgentResumeNowParams { run_id })
        .await
        .unwrap_err();
    assert_eq!(kind(&refused), ErrorKind::RunNotResumable);
    host.server.stop().await;
}

#[tokio::test]
async fn a_reset_that_passed_while_plxd_was_stopped_resumes_at_once() {
    let seen = Arc::new(Mutex::new(Vec::new()));
    let reset = in_seconds(3);
    let (host, client, run, seq) = waiting_run(reset, &seen).await;
    drop(client);
    let Host { dir, server } = host;
    server.stop().await;
    sleep_past(reset).await;

    let host = self::host(
        dir,
        sequence(vec![resumed()], &seen),
        Duration::from_secs(600),
    );
    let mut client = host.client().await;
    let listed = client
        .call::<AgentList>(AgentListParams::default())
        .await
        .unwrap()
        .runs;
    let project_id = listed.iter().find(|r| r.id == run).unwrap().project;
    subscribe(&mut client, project_id, seq).await;
    let events = until(&mut client, updated_to(AgentStatus::Completed)).await;
    assert_eq!(turns(&events), [(CONTINUE.to_owned(), true)]);
    assert_eq!(seen.lock().unwrap().len(), 2, "resumed once");
    host.server.stop().await;
}

/// The user's own message to a waiting run resumes it now and clears the timer, so the reset
/// starts nothing more.
#[tokio::test]
async fn a_message_to_a_waiting_run_clears_its_timer() {
    let seen = Arc::new(Mutex::new(Vec::new()));
    let reset = in_seconds(3);
    let (host, mut client, run, _) = waiting_run(reset, &seen).await;
    let sent = client
        .call::<AgentSend>(send_params(run, TurnId::generate(), "Try again."))
        .await
        .unwrap()
        .run;
    assert_eq!(sent.resume_at, None);
    let events = until(&mut client, updated_to(AgentStatus::Completed)).await;
    assert_eq!(turns(&events), [("Try again.".to_owned(), false)]);
    sleep_past(reset).await;
    assert_eq!(seen.lock().unwrap().len(), 2, "the reset started nothing");
    assert_eq!(status(&mut client, run).await, AgentStatus::Completed);
    host.server.stop().await;
}

/// `agent/resumeNow` resumes a waiting run before its reset, as the user's own turn.
#[tokio::test]
async fn resume_now_resumes_a_waiting_run_as_the_users_turn() {
    let seen = Arc::new(Mutex::new(Vec::new()));
    let (host, mut client, run, _) = waiting_run(in_seconds(600), &seen).await;
    let resumed = client
        .call::<AgentResumeNow>(AgentResumeNowParams { run_id: run })
        .await
        .unwrap()
        .run;
    assert_eq!(resumed.resume_at, None);
    let events = until(&mut client, updated_to(AgentStatus::Completed)).await;
    assert_eq!(turns(&events), [(CONTINUE.to_owned(), false)]);
    let launches = seen.lock().unwrap().clone();
    assert_eq!(launches.len(), 2);
    assert_eq!(
        launches[1]
            .resume
            .as_ref()
            .map(|resume| resume.session_id.as_str()),
        Some("s-1")
    );
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

/// PLX-805: an idle session killed while its background work runs resumes too, since the work it
/// waited on died with it.
#[tokio::test]
async fn a_cli_killed_idle_with_background_work_resumes_its_session() {
    let seen = Arc::new(Mutex::new(Vec::new()));
    let watching = Step::Emit(Event::BackgroundTasks {
        tasks: vec![AgentBackgroundTask {
            task_id: "m1".to_owned(),
            kind: AgentBackgroundKind::Monitor,
            description: "Watching CI".to_owned(),
            call_id: None,
        }],
    });
    let first = killed(
        "s-1",
        vec![watching, end_turn("watching"), Step::SleepMs(500)],
    );
    let (host, mut client, run) = started(vec![first, resumed()], &seen).await;
    let events = until(&mut client, |event| {
        turns(std::slice::from_ref(event)).contains(&(KILLED.to_owned(), true))
    })
    .await;
    assert!(!events.is_empty());
    until(&mut client, updated_to(AgentStatus::Completed)).await;
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
