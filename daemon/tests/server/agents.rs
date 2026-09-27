//! The M3 runner end to end (#156): `agent/*` against an in-process server whose worker backend
//! is the fake CLI, in a real git repository.

use std::collections::VecDeque;
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::Arc;
use std::time::Duration;

use rustix::process::Signal;
use tempfile::TempDir;
use tokio::time::Instant;
use wisp_protocol::jsonrpc::{ErrorObject, INVALID_PARAMS, Message, Notification};
use wisp_protocol::methods::{
    AgentAccept, AgentCancel, AgentDiff, AgentEvents, AgentFile, AgentList, AgentRequestChanges,
    AgentSend, AgentStart, EventsEvent, EventsSubscribe, HostHealth, NotificationMethod,
    ProjectCreate, RequestMethod, UsageGet,
};
use wisp_protocol::{
    AcceptId, AccountChoice, AccountId, AgentAcceptParams, AgentAcceptResult, AgentCancelParams,
    AgentDiffParams, AgentDiffResult, AgentDiffStats, AgentEventsParams, AgentFailureKind,
    AgentFileParams, AgentFileResult, AgentFileSide, AgentFileStatus, AgentListParams, AgentMerge,
    AgentMergeKind, AgentOutcome, AgentOutputItem, AgentPolicy, AgentRequestChangesParams,
    AgentRun, AgentSendParams, AgentStartParams, AgentStatus, CoordinatorThreadId, DiffSummary,
    ErrorKind, EventsEventParams, EventsSubscribeParams, HostHealthParams, InitializeResult,
    Project, ProjectCreateParams, ProjectId, Provider, RunId, TurnId, UsageGetParams, WispEvent,
};
use wispd::backend::fake::{FakeBackend, Script, Step};
use wispd::backend::process::{CancelPolicy, Environment, Launcher};
use wispd::backend::{
    Backend, Capabilities, Event, FailureKind, LimitStatus, LimitWindow, ModelUsage, RunRequest,
    StartError, Started, Usage,
};
use wispd::paths::DataDir;
use wispd::routing::BackendRegistry;

use crate::support::{Client, InProcess, PATIENCE, kind, temp_dir};

fn git(dir: &Path, args: &[&str]) -> String {
    let output = Command::new("git")
        .args(args)
        .current_dir(dir)
        .env("GIT_TERMINAL_PROMPT", "0")
        .output()
        .expect("git runs");
    assert!(output.status.success(), "git {args:?}: {output:?}");
    String::from_utf8(output.stdout).unwrap().trim().to_owned()
}

/// A repository under `dir` with one commit and its own identity, as a user's checkout would be.
pub(crate) fn real_repo(dir: &Path) -> PathBuf {
    let repo = dir.join("repos").join("app");
    std::fs::create_dir_all(&repo).unwrap();
    git(&repo, &["init", "-q", "--initial-branch=main"]);
    git(&repo, &["config", "user.name", "Test User"]);
    git(&repo, &["config", "user.email", "test@example.com"]);
    std::fs::write(repo.join("README.md"), "hello\n").unwrap();
    git(&repo, &["add", "-A"]);
    git(&repo, &["commit", "-q", "-m", "init"]);
    repo
}

pub(crate) fn fake(steps: Vec<Step>) -> BackendRegistry {
    let scratch = tempfile::tempdir().unwrap();
    let launcher = Launcher::new(
        DataDir::new(scratch.path()).unwrap(),
        Environment::inherited(),
    );
    let mut backends = BackendRegistry::new();
    backends.register(
        Provider::Anthropic,
        Arc::new(
            FakeBackend::new(launcher, Script { steps }).with_cancel_policy(CancelPolicy {
                signal: Signal::INT,
                group: false,
                // The fake's shell can lose a SIGINT that lands while it forks (#188), so
                // `SIGKILL` follows soon.
                grace: Duration::from_millis(500),
            }),
        ),
    );
    backends
}

/// A backend that fails `start` outright for one exact prompt, and otherwise runs `inner`'s
/// script normally. For reproducing #197's promotion-failure path deterministically.
struct FlakyBackend {
    inner: FakeBackend,
    fails_for: &'static str,
}

impl Backend for FlakyBackend {
    fn name(&self) -> &'static str {
        self.inner.name()
    }

    fn capabilities(&self) -> Capabilities {
        self.inner.capabilities()
    }

    fn start(&self, request: RunRequest) -> Result<Started, StartError> {
        // `Actor::launch` wraps the user's prompt in the worker's own instructions
        // (`worker::worker_prompt`), so this matches a substring, not the whole thing.
        if request.prompt.contains(self.fails_for) {
            return Err(StartError::Invalid(
                "this run is scripted to always fail to start".to_owned(),
            ));
        }
        self.inner.start(request)
    }
}

pub(crate) fn flaky(fails_for: &'static str, steps: Vec<Step>) -> BackendRegistry {
    let scratch = tempfile::tempdir().unwrap();
    let launcher = Launcher::new(
        DataDir::new(scratch.path()).unwrap(),
        Environment::inherited(),
    );
    let mut backends = BackendRegistry::new();
    backends.register(
        Provider::Anthropic,
        Arc::new(FlakyBackend {
            inner: FakeBackend::new(launcher, Script { steps }).with_cancel_policy(CancelPolicy {
                signal: Signal::INT,
                group: false,
                // The fake's shell can lose a SIGINT that lands while it forks (#188), so
                // `SIGKILL` follows soon.
                grace: Duration::from_millis(500),
            }),
            fails_for,
        }),
    );
    backends
}

pub(crate) fn init(session_id: &str) -> Step {
    Step::Init {
        session_id: session_id.to_owned(),
        model: None,
    }
}

pub(crate) fn text(text: &str) -> Step {
    Step::Emit(Event::Text {
        message_id: None,
        text: text.to_owned(),
    })
}

pub(crate) fn end_turn(result: &str) -> Step {
    Step::EndTurn {
        result: Some(result.to_owned()),
    }
}

/// A script that reports its session, then runs until cancelled.
fn hang() -> Vec<Step> {
    vec![init("hang-1"), text("Working"), Step::Hang]
}

pub(crate) fn start_params(project: ProjectId, prompt: &str) -> AgentStartParams {
    AgentStartParams {
        run_id: RunId::generate(),
        project,
        prompt: prompt.to_owned(),
        policy: AgentPolicy::WorkspaceWrite,
        account: Some(AccountChoice::Subscription {
            backend: "fake".to_owned(),
        }),
        coordinator_thread: None,
    }
}

fn send_params(run_id: RunId, turn_id: TurnId, text: &str) -> AgentSendParams {
    AgentSendParams {
        run_id,
        turn_id,
        text: text.to_owned(),
    }
}

/// An in-process wispd and its data folder.
pub(crate) struct Host {
    pub(crate) dir: TempDir,
    pub(crate) server: InProcess,
}

impl Host {
    pub(crate) fn start(dir: TempDir, backends: BackendRegistry) -> Self {
        let mut config = InProcess::config(dir.path());
        config.backends = Some(backends);
        let server = InProcess::start(config);
        Self { dir, server }
    }

    async fn restart(self, backends: BackendRegistry) -> Self {
        let Self { dir, server } = self;
        server.stop().await;
        Self::start(dir, backends)
    }

    pub(crate) async fn client(&self) -> Conn {
        Conn::ready(&self.server.socket).await
    }
}

/// Params for a project on a new real repository under `dir`.
pub(crate) fn project_params(dir: &Path) -> ProjectCreateParams {
    ProjectCreateParams {
        id: ProjectId::generate(),
        name: "app".to_owned(),
        repo_path: real_repo(dir).to_str().unwrap().to_owned(),
    }
}

pub(crate) async fn create(client: &mut Conn, params: ProjectCreateParams) -> Project {
    client.call::<ProjectCreate>(params).await.unwrap().project
}

async fn subscribe(client: &mut Conn, project: ProjectId, after: u64) {
    client
        .call::<EventsSubscribe>(EventsSubscribeParams {
            after,
            project: Some(project),
        })
        .await
        .unwrap();
}

/// A client on which events can arrive between a request and its response. They wait in
/// `pending` for [`until`], so none is lost.
pub(crate) struct Conn {
    client: Client,
    pending: VecDeque<EventsEventParams>,
}

fn event(notification: Notification) -> EventsEventParams {
    assert_eq!(
        notification.method,
        <EventsEvent as NotificationMethod>::NAME
    );
    serde_json::from_value(notification.params.expect("params")).expect("an event")
}

impl Conn {
    async fn connect(socket: &Path) -> Self {
        Self {
            client: Client::connect(socket).await,
            pending: VecDeque::new(),
        }
    }

    async fn ready(socket: &Path) -> Self {
        let mut conn = Self::connect(socket).await;
        conn.initialize().await;
        conn
    }

    async fn initialize(&mut self) -> InitializeResult {
        self.client.initialize().await.expect("initialize")
    }

    pub(crate) async fn call<M: RequestMethod>(
        &mut self,
        params: M::Params,
    ) -> Result<M::Result, ErrorObject> {
        let id = self.client.send::<M>(params).await;
        loop {
            match self.client.next().await {
                Some(Message::Response(response)) => {
                    assert_eq!(response.id, Some(id));
                    return response.into_result();
                }
                Some(Message::Notification(notification)) => {
                    self.pending.push_back(event(notification));
                }
                other => panic!("expected a response, got {other:?}"),
            }
        }
    }

    async fn next_event(&mut self) -> EventsEventParams {
        if let Some(event) = self.pending.pop_front() {
            return event;
        }
        match self.client.next().await {
            Some(Message::Notification(notification)) => event(notification),
            other => panic!("expected an event, got {other:?}"),
        }
    }

    async fn stays_quiet(&mut self, within: Duration) {
        assert!(self.pending.is_empty(), "{:?}", self.pending);
        self.client.stays_quiet(within).await;
    }
}

/// Events until one matches `done`, which is included.
async fn until(
    client: &mut Conn,
    mut done: impl FnMut(&EventsEventParams) -> bool,
) -> Vec<EventsEventParams> {
    let deadline = Instant::now() + PATIENCE;
    let mut events = Vec::new();
    loop {
        assert!(
            Instant::now() < deadline,
            "gave up waiting; got {events:#?}"
        );
        let event = client.next_event().await;
        let stop = done(&event);
        events.push(event);
        if stop {
            return events;
        }
    }
}

fn updated_to(status: AgentStatus) -> impl FnMut(&EventsEventParams) -> bool {
    move |event| matches!(&event.event, WispEvent::AgentUpdated { state, .. } if state.status == status)
}

fn has_item(item: AgentOutputItem) -> impl FnMut(&EventsEventParams) -> bool {
    move |event| matches!(&event.event, WispEvent::AgentOutput { items, .. } if items.contains(&item))
}

fn items(events: &[EventsEventParams]) -> Vec<AgentOutputItem> {
    events
        .iter()
        .filter_map(|event| match &event.event {
            WispEvent::AgentOutput { items, .. } => Some(items.clone()),
            _ => None,
        })
        .flatten()
        .collect()
}

fn kinds(events: &[EventsEventParams]) -> Vec<String> {
    events
        .iter()
        .map(|event| {
            serde_json::to_value(&event.event).unwrap()["kind"]
                .as_str()
                .unwrap()
                .to_owned()
        })
        .collect()
}

fn outcomes(events: &[EventsEventParams]) -> Vec<AgentOutcome> {
    events
        .iter()
        .filter_map(|event| match &event.event {
            WispEvent::AgentFinished { outcome, .. } => Some(outcome.clone()),
            _ => None,
        })
        .collect()
}

/// How many run worktrees wispd has under the data folder `dir`.
fn worktree_count(dir: &Path) -> usize {
    let Ok(repos) = std::fs::read_dir(dir.join("worktrees")) else {
        return 0;
    };
    repos
        .map(|repo| std::fs::read_dir(repo.unwrap().path()).unwrap().count())
        .sum()
}

async fn list(client: &mut Conn) -> Vec<AgentRun> {
    client
        .call::<AgentList>(AgentListParams::default())
        .await
        .unwrap()
        .runs
}

/// A worker that edits the README in its worktree and writes a shared context note at `note`.
fn editing_script(note: &Path) -> Vec<Step> {
    vec![
        Step::Init {
            session_id: "session-1".to_owned(),
            model: Some("fake-model".to_owned()),
        },
        Step::WriteFile {
            path: "README.md".to_owned(),
            content: "# App\nBuilt by an agent.\n".to_owned(),
        },
        Step::WriteFile {
            path: note.to_str().unwrap().to_owned(),
            content: "Build with cargo.\n".to_owned(),
        },
        text("Done."),
        end_turn("Done."),
    ]
}

/// The run's commit is on its branch with the worker's edit, and the user's own checkout is
/// untouched.
fn assert_committed(repo: &Path, branch: &str, worktree: &Path, diff: &DiffSummary) {
    assert_eq!(git(repo, &["rev-parse", branch]), diff.commit);
    let subject = git(repo, &["log", "-1", "--format=%s", branch]);
    assert_eq!(subject, "wisp: Rewrite the README");
    assert_eq!(
        git(repo, &["show", &format!("{branch}:README.md")]),
        "# App\nBuilt by an agent."
    );
    assert_eq!(
        std::fs::read_to_string(repo.join("README.md")).unwrap(),
        "hello\n"
    );
    assert_eq!(git(repo, &["rev-parse", "--abbrev-ref", "HEAD"]), "main");
    assert_eq!(git(worktree, &["status", "--porcelain"]), "");
}

/// A client that reconnects replays `events` from the log, and `agent/events` pages through the
/// run's own events.
async fn assert_replays(
    host: &Host,
    project: ProjectId,
    run_id: RunId,
    events: &[EventsEventParams],
) {
    let last = events.last().unwrap().seq;
    let mut replay = host.client().await;
    subscribe(&mut replay, project, 0).await;
    let replayed = until(&mut replay, |event| event.seq == last).await;
    let pairs = |events: &[EventsEventParams]| -> Vec<(u64, WispEvent)> {
        events
            .iter()
            .map(|event| (event.seq, event.event.clone()))
            .collect()
    };
    assert_eq!(pairs(&replayed), pairs(events));

    let page = replay
        .call::<AgentEvents>(AgentEventsParams {
            run_id,
            after: 0,
            limit: Some(3),
        })
        .await
        .unwrap();
    assert!(page.more);
    assert_eq!(page.events.len(), 3);
    let rest = replay
        .call::<AgentEvents>(AgentEventsParams {
            run_id,
            after: page.events[2].seq,
            limit: None,
        })
        .await
        .unwrap();
    assert!(!rest.more);
    let paged: Vec<u64> = page
        .events
        .iter()
        .chain(&rest.events)
        .map(|event| event.seq)
        .collect();
    let run_events: Vec<u64> = events
        .iter()
        .filter(|event| !matches!(event.event, WispEvent::ContextChanged { .. }))
        .map(|event| event.seq)
        .collect();
    assert_eq!(paged, run_events);

    let runs = list(&mut replay).await;
    assert_eq!(runs.len(), 1);
    assert_eq!(runs[0].status, AgentStatus::Completed);
}

#[tokio::test]
async fn a_worker_edits_its_worktree_writes_shared_context_commits_and_replays() {
    let dir = temp_dir();
    let project_params = project_params(dir.path());
    let note = dir
        .path()
        .join("context")
        .join(project_params.id.to_string())
        .join("notes.md");
    let host = Host::start(dir, fake(editing_script(&note)));
    let mut client = host.client().await;
    let project = create(&mut client, project_params).await;
    subscribe(&mut client, project.id, 0).await;

    let params = start_params(project.id, "Rewrite the README");
    let started = client.call::<AgentStart>(params.clone()).await.unwrap().run;
    assert_eq!(started.id, params.run_id);
    assert_eq!(started.project, project.id);
    assert_eq!(started.backend, "fake");
    assert_eq!(started.account_id, "fake");
    assert_eq!(started.status, AgentStatus::Running);
    let branch = started.branch.clone().expect("a branch");
    let worktree = PathBuf::from(started.worktree_path.clone().expect("a worktree"));
    assert!(branch.starts_with("wisp/"), "{branch}");

    let mut context_changed = false;
    let mut is_done = updated_to(AgentStatus::Completed);
    let events = until(&mut client, |event| {
        context_changed |=
            matches!(&event.event, WispEvent::ContextChanged { file } if file.path == "notes.md");
        is_done(event)
    })
    .await;
    let kinds = kinds(&events);
    assert_eq!(kinds[0], "agent.started", "{kinds:?}");
    for expected in [
        "agent.updated",
        "agent.output",
        "agent.finished",
        "agent.diffReady",
    ] {
        assert!(
            kinds.iter().any(|kind| kind == expected),
            "{expected} in {kinds:?}"
        );
    }
    let transcript = items(&events);
    assert!(
        transcript.contains(&AgentOutputItem::SessionStarted {
            session_id: "session-1".to_owned(),
            model: Some("fake-model".to_owned()),
        }),
        "{transcript:?}"
    );
    assert!(transcript.contains(&AgentOutputItem::Text {
        message_id: None,
        text: "Done.".to_owned(),
    }));
    assert_eq!(
        outcomes(&events),
        [AgentOutcome::Completed {
            result: Some("Done.".to_owned())
        }]
    );
    let diff = events
        .iter()
        .find_map(|event| match &event.event {
            WispEvent::AgentDiffReady { diff, .. } => Some(diff.clone()),
            _ => None,
        })
        .expect("diffReady");
    assert_eq!((diff.files, diff.insertions, diff.deletions), (1, 2, 1));
    let WispEvent::AgentUpdated { state: done, .. } = &events.last().unwrap().event else {
        unreachable!()
    };
    assert_eq!(done.diff.as_ref(), Some(&diff));
    assert_eq!(done.session_id.as_deref(), Some("session-1"));
    for event in &events {
        if let WispEvent::AgentUpdated { .. } = event.event {
            let json = serde_json::to_string(&event.event).unwrap();
            assert!(!json.contains("Rewrite the README"), "no prompt: {json}");
        }
    }

    assert_committed(Path::new(&project.repo_path), &branch, &worktree, &diff);
    assert_eq!(
        std::fs::read_to_string(&note).unwrap(),
        "Build with cargo.\n"
    );
    if !context_changed {
        until(&mut client, |event| {
            matches!(&event.event, WispEvent::ContextChanged { file } if file.path == "notes.md")
        })
        .await;
    }

    assert_replays(&host, project.id, params.run_id, &events).await;
    host.server.stop().await;
}

#[tokio::test]
async fn a_follow_up_reaches_a_live_run_and_a_finished_run_resumes_its_session() {
    let dir = temp_dir();
    let host = Host::start(
        dir,
        fake(vec![
            init("chat-1"),
            text("First answer."),
            end_turn("First answer."),
            Step::AwaitFollowUp,
            end_turn("Second answer."),
        ]),
    );
    let mut client = host.client().await;
    let project = create(&mut client, project_params(host.dir.path())).await;
    subscribe(&mut client, project.id, 0).await;
    let params = start_params(project.id, "Answer twice");
    let run_id = params.run_id;
    client.call::<AgentStart>(params).await.unwrap();
    until(
        &mut client,
        has_item(AgentOutputItem::TurnFinished {
            turn_id: None,
            result: Some("First answer.".to_owned()),
        }),
    )
    .await;

    let first = TurnId::generate();
    let sent = client
        .call::<AgentSend>(send_params(run_id, first, "and the tests"))
        .await
        .unwrap();
    assert_eq!(sent.run.status, AgentStatus::Running);
    let again = client
        .call::<AgentSend>(send_params(run_id, first, "and the tests"))
        .await
        .unwrap();
    assert_eq!(again.run.id, run_id, "a retry is answered, not sent twice");
    let conflict = client
        .call::<AgentSend>(send_params(run_id, first, "something else"))
        .await
        .unwrap_err();
    assert_eq!(kind(&conflict), ErrorKind::IdConflict);

    let events = until(&mut client, updated_to(AgentStatus::Completed)).await;
    let transcript = items(&events);
    assert!(transcript.contains(&AgentOutputItem::TurnStarted {
        turn_id: Some(first)
    }));
    assert!(transcript.contains(&AgentOutputItem::Text {
        message_id: None,
        text: "and the tests".to_owned(),
    }));
    assert!(transcript.contains(&AgentOutputItem::TurnFinished {
        turn_id: Some(first),
        result: Some("Second answer.".to_owned()),
    }));
    assert!(
        !kinds(&events).contains(&"agent.diffReady".to_owned()),
        "nothing changed, so nothing was committed"
    );

    // The CLI has exited: a message now resumes the same session in a new process.
    let second = TurnId::generate();
    let resumed = client
        .call::<AgentSend>(send_params(run_id, second, "one more thing"))
        .await
        .unwrap();
    assert_eq!(resumed.run.status, AgentStatus::Running);
    let events = until(
        &mut client,
        has_item(AgentOutputItem::TurnFinished {
            turn_id: Some(second),
            result: Some("First answer.".to_owned()),
        }),
    )
    .await;
    let transcript = items(&events);
    assert!(
        transcript.contains(&AgentOutputItem::SessionStarted {
            session_id: "chat-1".to_owned(),
            model: None,
        }),
        "the resumed process continues the session: {transcript:?}"
    );
    assert!(transcript.contains(&AgentOutputItem::TurnStarted {
        turn_id: Some(second)
    }));
    let third = TurnId::generate();
    client
        .call::<AgentSend>(send_params(run_id, third, "done"))
        .await
        .unwrap();
    until(&mut client, updated_to(AgentStatus::Completed)).await;
    host.server.stop().await;
}

#[tokio::test]
async fn cancel_stops_a_running_worker() {
    let dir = temp_dir();
    let host = Host::start(dir, fake(hang()));
    let mut client = host.client().await;
    let project = create(&mut client, project_params(host.dir.path())).await;
    subscribe(&mut client, project.id, 0).await;
    let params = start_params(project.id, "Work forever");
    let run_id = params.run_id;
    client.call::<AgentStart>(params).await.unwrap();
    until(
        &mut client,
        has_item(AgentOutputItem::Text {
            message_id: None,
            text: "Working".to_owned(),
        }),
    )
    .await;
    let health = client
        .call::<HostHealth>(HostHealthParams {})
        .await
        .unwrap();
    assert_eq!(health.running_agents, 1);

    let cancelling = client
        .call::<AgentCancel>(AgentCancelParams { run_id })
        .await
        .unwrap();
    assert_eq!(cancelling.run.id, run_id);
    let events = until(&mut client, updated_to(AgentStatus::Cancelled)).await;
    assert_eq!(outcomes(&events), [AgentOutcome::Cancelled]);
    let health = client
        .call::<HostHealth>(HostHealthParams {})
        .await
        .unwrap();
    assert_eq!(health.running_agents, 0);
    let again = client
        .call::<AgentCancel>(AgentCancelParams { run_id })
        .await
        .unwrap();
    assert_eq!(again.run.status, AgentStatus::Cancelled, "a no-op");

    let unknown = client
        .call::<AgentCancel>(AgentCancelParams {
            run_id: RunId::generate(),
        })
        .await
        .unwrap_err();
    assert_eq!(kind(&unknown), ErrorKind::RunNotFound);
    let unknown = client
        .call::<AgentEvents>(AgentEventsParams {
            run_id: RunId::generate(),
            after: 0,
            limit: None,
        })
        .await
        .unwrap_err();
    assert_eq!(kind(&unknown), ErrorKind::RunNotFound);
    host.server.stop().await;
}

#[tokio::test]
async fn agent_start_is_idempotent_on_its_run_id() {
    let dir = temp_dir();
    let host = Host::start(dir, fake(vec![init("s"), end_turn("ok")]));
    let mut client = host.client().await;
    let project = create(&mut client, project_params(host.dir.path())).await;
    subscribe(&mut client, project.id, 0).await;
    let params = start_params(project.id, "Do it once");
    let first = client.call::<AgentStart>(params.clone()).await.unwrap().run;
    until(&mut client, updated_to(AgentStatus::Completed)).await;

    let retried = client.call::<AgentStart>(params.clone()).await.unwrap().run;
    assert_eq!(retried.id, first.id);
    assert_eq!(retried.worktree_path, first.worktree_path);
    assert_eq!(retried.status, AgentStatus::Completed);
    client.stays_quiet(Duration::from_millis(300)).await;

    let conflict = client
        .call::<AgentStart>(AgentStartParams {
            prompt: "Do something else".to_owned(),
            ..params.clone()
        })
        .await
        .unwrap_err();
    assert_eq!(kind(&conflict), ErrorKind::IdConflict);
    let tagged = client
        .call::<AgentStart>(AgentStartParams {
            coordinator_thread: Some(CoordinatorThreadId::generate()),
            ..params.clone()
        })
        .await
        .unwrap_err();
    assert_eq!(kind(&tagged), ErrorKind::IdConflict);
    assert_eq!(list(&mut client).await.len(), 1);
    assert_eq!(
        worktree_count(host.dir.path()),
        1,
        "one worktree for one run"
    );

    let missing = client
        .call::<AgentStart>(start_params(ProjectId::generate(), "Nowhere"))
        .await
        .unwrap_err();
    assert_eq!(kind(&missing), ErrorKind::ProjectNotFound);
    let no_account = client
        .call::<AgentStart>(AgentStartParams {
            account: None,
            ..start_params(project.id, "Whose account?")
        })
        .await
        .unwrap_err();
    assert_eq!(no_account.code, INVALID_PARAMS);
    host.server.stop().await;
}

#[tokio::test]
async fn a_run_interrupted_by_a_restart_or_a_crash_resumes_by_its_session() {
    let dir = temp_dir();
    let host = Host::start(dir, fake(hang()));
    let mut client = Conn::connect(&host.server.socket).await;
    let first_log = client.initialize().await.log_id;
    let project = create(&mut client, project_params(host.dir.path())).await;
    subscribe(&mut client, project.id, 0).await;
    let params = start_params(project.id, "Work until wispd stops");
    let run_id = params.run_id;
    client.call::<AgentStart>(params).await.unwrap();
    let before = until(
        &mut client,
        has_item(AgentOutputItem::Text {
            message_id: None,
            text: "Working".to_owned(),
        }),
    )
    .await;
    let seq_before = before.last().unwrap().seq;
    drop(client);

    // A clean stop: the run's CLI is cancelled and the run recorded as interrupted.
    let host = host.restart(fake(hang())).await;
    let mut client = Conn::connect(&host.server.socket).await;
    let init = client.initialize().await;
    assert_eq!(init.log_id, first_log, "the event log outlived wispd");
    let runs = list(&mut client).await;
    assert_eq!(runs[0].status, AgentStatus::Interrupted);
    assert_eq!(runs[0].session_id.as_deref(), Some("hang-1"));
    subscribe(&mut client, project.id, seq_before).await;
    let stopped = until(&mut client, updated_to(AgentStatus::Interrupted)).await;
    assert_eq!(outcomes(&stopped), [AgentOutcome::Interrupted]);

    let turn = TurnId::generate();
    let resumed = client
        .call::<AgentSend>(send_params(run_id, turn, "carry on"))
        .await
        .unwrap();
    assert_eq!(resumed.run.status, AgentStatus::Running);
    let events = until(
        &mut client,
        has_item(AgentOutputItem::TurnStarted {
            turn_id: Some(turn),
        }),
    )
    .await;
    assert!(items(&events).contains(&AgentOutputItem::SessionStarted {
        session_id: "hang-1".to_owned(),
        model: None,
    }));
    drop(client);

    // A crash: the store still says `running` when wispd starts.
    let Host { dir, server } = host;
    server.stop().await;
    {
        let db = rusqlite::Connection::open(dir.path().join("wispd.sqlite3")).unwrap();
        db.execute("UPDATE runs SET status = 'running'", [])
            .unwrap();
    }
    let host = Host::start(dir, fake(hang()));
    let mut client = host.client().await;
    let runs = list(&mut client).await;
    assert_eq!(runs[0].status, AgentStatus::Interrupted);
    assert_eq!(runs[0].session_id.as_deref(), Some("hang-1"));
    host.server.stop().await;
}

/// #190 N5: a fresh actor after a restart has no in-memory record of a turn it (or a wispd
/// before it) already sent, so `agent/send`'s idempotency has to come from the store instead.
#[tokio::test]
async fn a_sent_turn_stays_idempotent_across_a_restart() {
    let dir = temp_dir();
    let host = Host::start(dir, fake(hang()));
    let mut client = host.client().await;
    let project = create(&mut client, project_params(host.dir.path())).await;
    subscribe(&mut client, project.id, 0).await;
    let params = start_params(project.id, "Work until cancelled");
    let run_id = params.run_id;
    client.call::<AgentStart>(params).await.unwrap();
    until(
        &mut client,
        has_item(AgentOutputItem::Text {
            message_id: None,
            text: "Working".to_owned(),
        }),
    )
    .await;

    client
        .call::<AgentCancel>(AgentCancelParams { run_id })
        .await
        .unwrap();
    until(&mut client, updated_to(AgentStatus::Cancelled)).await;

    // The CLI has exited: sending resumes the session in a new process, and the turn is recorded
    // with the run, not only kept in the actor's own memory.
    let turn = TurnId::generate();
    let sent = client
        .call::<AgentSend>(send_params(run_id, turn, "carry on"))
        .await
        .unwrap();
    assert_eq!(sent.run.status, AgentStatus::Running);
    let events = until(
        &mut client,
        has_item(AgentOutputItem::TurnStarted {
            turn_id: Some(turn),
        }),
    )
    .await;
    let seq_before = events.last().unwrap().seq;
    drop(client);

    let host = host.restart(fake(hang())).await;
    let mut client = host.client().await;
    subscribe(&mut client, project.id, seq_before).await;
    until(&mut client, updated_to(AgentStatus::Interrupted)).await;

    // A retry with the same text is answered from the stored turn, not sent to the CLI again.
    let retried = client
        .call::<AgentSend>(send_params(run_id, turn, "carry on"))
        .await
        .unwrap();
    assert_eq!(retried.run.id, run_id);
    client.stays_quiet(Duration::from_millis(300)).await;

    // A retry with different text still conflicts, exactly as it would without a restart.
    let conflict = client
        .call::<AgentSend>(send_params(run_id, turn, "something else"))
        .await
        .unwrap_err();
    assert_eq!(kind(&conflict), ErrorKind::IdConflict);
    host.server.stop().await;
}

#[tokio::test]
async fn a_worker_learns_its_limits_and_a_fallback_moves_its_usage_to_the_new_account() {
    let dir = temp_dir();
    let project_params = project_params(dir.path());
    let context = dir
        .path()
        .join("context")
        .join(project_params.id.to_string());
    let host = Host::start(
        dir,
        fake(vec![
            Step::Emit(Event::AccountFallback {
                from_account: "fake".to_owned(),
                to_account: "key-1".to_owned(),
                reason: FailureKind::RateLimited,
            }),
            init("s-1"),
            Step::EchoPrompt,
            Step::Emit(Event::Usage(ModelUsage {
                model: None,
                usage: Usage {
                    input_tokens: 7,
                    output_tokens: 3,
                    ..Usage::default()
                },
            })),
            end_turn("ok"),
        ]),
    );
    let mut client = host.client().await;
    let project = create(&mut client, project_params).await;
    subscribe(&mut client, project.id, 0).await;
    client
        .call::<AgentStart>(start_params(project.id, "Tidy the build"))
        .await
        .unwrap();
    let events = until(&mut client, updated_to(AgentStatus::Completed)).await;

    let fallback = events.iter().find_map(|event| match &event.event {
        WispEvent::AgentAccountFallback {
            from_account,
            to_account,
            reason,
            ..
        } => Some((from_account.clone(), to_account.clone(), *reason)),
        _ => None,
    });
    assert_eq!(
        fallback,
        Some((
            "fake".to_owned(),
            "key-1".to_owned(),
            AgentFailureKind::RateLimited
        ))
    );
    let WispEvent::AgentUpdated { state: run, .. } = &events.last().unwrap().event else {
        unreachable!()
    };
    assert_eq!(run.account_id, "key-1");
    let usage = client.call::<UsageGet>(UsageGetParams {}).await.unwrap();
    let charged: Vec<(&str, u64)> = usage
        .accounts
        .iter()
        .map(|account| (account.account_id.as_str(), account.today.input_tokens))
        .collect();
    assert_eq!(
        charged,
        [("key-1", 7)],
        "charged to the account it fell back to"
    );

    let prompt = items(&events)
        .into_iter()
        .find_map(|item| match item {
            AgentOutputItem::Text { text, .. } => Some(text),
            _ => None,
        })
        .expect("the fake echoed its prompt");
    let context = context.canonicalize().unwrap();
    assert!(
        prompt.contains(&context.display().to_string()),
        "names the shared context folder: {prompt}"
    );
    assert!(prompt.contains("Don't commit"), "{prompt}");
    assert!(prompt.contains("localhost"), "{prompt}");
    assert!(prompt.ends_with("Your task:\nTidy the build"), "{prompt}");
    host.server.stop().await;
}

/// A backend that doesn't implement the worker sandbox, as Codex doesn't until #122.
struct Unsandboxed;

impl Backend for Unsandboxed {
    fn name(&self) -> &'static str {
        "codex"
    }

    fn capabilities(&self) -> Capabilities {
        Capabilities::default()
    }

    fn start(&self, _: RunRequest) -> Result<Started, StartError> {
        panic!("a worker must never start on a backend without the sandbox")
    }
}

#[tokio::test]
async fn workers_are_refused_where_wispd_cannot_sandbox_them() {
    let dir = temp_dir();
    // A `claude` older than the sandbox needs, found where agents' CLIs are looked up.
    let bin = dir.path().join("bin");
    std::fs::create_dir_all(&bin).unwrap();
    let claude = bin.join("claude");
    std::fs::write(
        &claude,
        "#!/bin/sh\n\
         if [ \"$1\" = --version ]; then echo '2.1.100 (Claude Code)'; exit 0; fi\n\
         printf '%s' '{\"loggedIn\":true}'\n",
    )
    .unwrap();
    std::fs::set_permissions(&claude, std::fs::Permissions::from_mode(0o755)).unwrap();
    let mut environment = Environment::empty();
    environment.set("PATH", format!("{}:/usr/bin:/bin", bin.display()));

    let mut config = InProcess::config(dir.path());
    config.agent_environment = Some(environment.clone());
    let mut backends = BackendRegistry::new();
    backends.register(
        Provider::Anthropic,
        Arc::new(wispd::backend::claude::ClaudeBackend::new(Launcher::new(
            DataDir::new(dir.path()).unwrap(),
            environment,
        ))),
    );
    backends.register(Provider::Openai, Arc::new(Unsandboxed));
    config.backends = Some(backends);
    let server = InProcess::start(config);
    let mut client = Conn::ready(&server.socket).await;
    let project = create(&mut client, project_params(dir.path())).await;

    let old = client
        .call::<AgentStart>(AgentStartParams {
            account: Some(AccountChoice::Subscription {
                backend: "claude".to_owned(),
            }),
            ..start_params(project.id, "Fix it")
        })
        .await
        .unwrap_err();
    assert_eq!(kind(&old), ErrorKind::WorkerUnavailable);
    assert!(old.message.contains("2.1.100"), "{}", old.message);
    assert!(old.message.contains("2.1.248"), "{}", old.message);

    let unsandboxed = client
        .call::<AgentStart>(AgentStartParams {
            account: Some(AccountChoice::Subscription {
                backend: "codex".to_owned(),
            }),
            ..start_params(project.id, "Fix it")
        })
        .await
        .unwrap_err();
    assert_eq!(kind(&unsandboxed), ErrorKind::WorkerUnavailable);
    assert!(
        unsandboxed.message.contains("codex"),
        "{}",
        unsandboxed.message
    );

    std::fs::write(Path::new(&project.repo_path).join("README.md"), "dirty\n").unwrap();
    let mut fake_config = InProcess::config(dir.path());
    fake_config.backends = Some(fake(vec![init("s"), end_turn("ok")]));
    server.stop().await;
    let server = InProcess::start(fake_config);
    let mut client = Conn::ready(&server.socket).await;
    let dirty = client
        .call::<AgentStart>(start_params(project.id, "Fix it"))
        .await
        .unwrap_err();
    assert_eq!(kind(&dirty), ErrorKind::WorktreeFailed);
    assert!(dirty.message.contains("uncommitted"), "{}", dirty.message);

    assert!(list(&mut client).await.is_empty(), "nothing was recorded");
    assert_eq!(worktree_count(dir.path()), 0, "and no worktree was made");
    server.stop().await;
}

fn decode_base64(text: &str) -> Vec<u8> {
    let value = |c: u8| -> u32 {
        match c {
            b'A'..=b'Z' => u32::from(c - b'A'),
            b'a'..=b'z' => u32::from(c - b'a') + 26,
            b'0'..=b'9' => u32::from(c - b'0') + 52,
            b'+' => 62,
            b'/' => 63,
            _ => panic!("not base64: {c}"),
        }
    };
    let mut out = Vec::new();
    for chunk in text.as_bytes().chunks(4) {
        let data: Vec<u8> = chunk.iter().copied().filter(|&c| c != b'=').collect();
        let n = data
            .iter()
            .enumerate()
            .fold(0, |n, (i, &c)| n | (value(c) << (18 - 6 * i)));
        let bytes = n.to_be_bytes();
        out.extend_from_slice(&bytes[1..data.len()]);
    }
    out
}

async fn read_file(
    client: &mut Conn,
    run_id: RunId,
    path: &str,
    side: AgentFileSide,
) -> Result<AgentFileResult, ErrorObject> {
    client
        .call::<AgentFile>(AgentFileParams {
            run_id,
            path: path.to_owned(),
            side,
            size_only: None,
        })
        .await
}

async fn content(client: &mut Conn, run_id: RunId, path: &str, side: AgentFileSide) -> String {
    let file = read_file(client, run_id, path, side).await.unwrap();
    assert!(file.exists, "{path} on {side:?}");
    String::from_utf8(decode_base64(&file.content.expect("content"))).unwrap()
}

/// `agent/diff` and `agent/file` show the run's commit against its base.
async fn assert_reviewable(
    client: &mut Conn,
    run_id: RunId,
    repo: &Path,
    commit: &str,
) -> AgentDiffResult {
    let diff = client
        .call::<AgentDiff>(AgentDiffParams { run_id })
        .await
        .unwrap();
    assert_eq!(diff.head, commit);
    assert_eq!(diff.base, git(repo, &["rev-parse", "main"]));
    assert_eq!(
        diff.stats,
        AgentDiffStats {
            files: 1,
            insertions: 2,
            deletions: 1
        }
    );
    assert_eq!(diff.files.len(), 1);
    let readme = &diff.files[0];
    assert_eq!(
        (readme.path.as_str(), readme.status),
        ("README.md", AgentFileStatus::Modified)
    );
    assert!(
        readme
            .diff
            .as_deref()
            .unwrap()
            .contains("+Built by an agent.\n"),
        "{readme:?}"
    );

    assert_eq!(
        content(client, run_id, "README.md", AgentFileSide::Head).await,
        "# App\nBuilt by an agent.\n"
    );
    assert_eq!(
        content(client, run_id, "README.md", AgentFileSide::Base).await,
        "hello\n"
    );
    let stat = client
        .call::<AgentFile>(AgentFileParams {
            run_id,
            path: "README.md".to_owned(),
            side: AgentFileSide::Head,
            size_only: Some(true),
        })
        .await
        .unwrap();
    assert!(stat.exists && !stat.too_large);
    assert_eq!(stat.size, Some(25));
    assert_eq!(stat.content, None, "sizeOnly leaves the content out");
    diff
}

/// `agent/file` reads nothing outside the run's commits, whatever path it is given.
async fn assert_paths_are_checked(client: &mut Conn, run_id: RunId) {
    let missing = read_file(client, run_id, "nope.md", AgentFileSide::Head)
        .await
        .unwrap();
    assert!(!missing.exists && missing.content.is_none());
    for escape in [
        "../../../../etc/passwd",
        "/etc/passwd",
        "..",
        "./README.md",
        "src/../README.md",
        ".git/config",
        ".git/worktrees",
        "a\\..\\..\\b",
        "",
    ] {
        let error = read_file(client, run_id, escape, AgentFileSide::Head)
            .await
            .unwrap_err();
        assert_eq!(error.code, INVALID_PARAMS, "{escape:?}: {error:?}");
    }
    let unknown = client
        .call::<AgentFile>(AgentFileParams {
            run_id: RunId::generate(),
            path: "README.md".to_owned(),
            side: AgentFileSide::Head,
            size_only: None,
        })
        .await
        .unwrap_err();
    assert_eq!(kind(&unknown), ErrorKind::RunNotFound);
}

/// An accepted run answers a retry of its accept, and nothing else.
async fn assert_closed_after_accept(
    client: &mut Conn,
    accept: &AgentAcceptParams,
    accepted: &AgentAcceptResult,
) {
    let again = client.call::<AgentAccept>(accept.clone()).await.unwrap();
    assert_eq!(&again, accepted, "a retry gets the same answer");
    let other = client
        .call::<AgentAccept>(AgentAcceptParams {
            id: AcceptId::generate(),
            ..accept.clone()
        })
        .await
        .unwrap_err();
    assert_eq!(kind(&other), ErrorKind::RunAccepted);
    let closed = client
        .call::<AgentDiff>(AgentDiffParams {
            run_id: accept.run_id,
        })
        .await
        .unwrap_err();
    assert_eq!(kind(&closed), ErrorKind::RunAccepted);
    let closed = read_file(client, accept.run_id, "README.md", AgentFileSide::Head)
        .await
        .unwrap_err();
    assert_eq!(kind(&closed), ErrorKind::RunAccepted);
    let closed = client
        .call::<AgentRequestChanges>(AgentRequestChangesParams {
            run_id: accept.run_id,
            turn_id: TurnId::generate(),
            text: "one more thing".to_owned(),
        })
        .await
        .unwrap_err();
    assert_eq!(kind(&closed), ErrorKind::RunAccepted);
}

#[tokio::test]
async fn a_finished_run_is_reviewed_accepted_into_the_branch_and_then_closed() {
    let dir = temp_dir();
    let project_params = project_params(dir.path());
    let note = dir
        .path()
        .join("context")
        .join(project_params.id.to_string())
        .join("notes.md");
    let host = Host::start(dir, fake(editing_script(&note)));
    let mut client = host.client().await;
    let project = create(&mut client, project_params).await;
    let repo = PathBuf::from(&project.repo_path);
    subscribe(&mut client, project.id, 0).await;
    let params = start_params(project.id, "Rewrite the README");
    let run_id = params.run_id;
    let started = client.call::<AgentStart>(params).await.unwrap().run;
    let branch = started.branch.clone().unwrap();
    let worktree = PathBuf::from(started.worktree_path.clone().unwrap());
    let events = until(&mut client, updated_to(AgentStatus::Completed)).await;
    let WispEvent::AgentUpdated { state, .. } = &events.last().unwrap().event else {
        unreachable!()
    };
    let commit = state.diff.as_ref().expect("a commit").commit.clone();

    let diff = assert_reviewable(&mut client, run_id, &repo, &commit).await;
    assert_paths_are_checked(&mut client, run_id).await;

    let stale = client
        .call::<AgentAccept>(AgentAcceptParams {
            run_id,
            id: AcceptId::generate(),
            commit: Some(diff.base.clone()),
        })
        .await
        .unwrap_err();
    assert_eq!(kind(&stale), ErrorKind::MergeRefused);
    assert!(stale.message.contains("since"), "{}", stale.message);

    let accept = AgentAcceptParams {
        run_id,
        id: AcceptId::generate(),
        commit: Some(commit.clone()),
    };
    let accepted = client.call::<AgentAccept>(accept.clone()).await.unwrap();
    assert_eq!(
        accepted.merge,
        AgentMerge {
            commit: commit.clone(),
            into: "main".to_owned(),
            how: AgentMergeKind::FastForward,
        }
    );
    assert_eq!(accepted.run.status, AgentStatus::Accepted);
    assert_eq!(accepted.run.branch, None);
    assert_eq!(accepted.run.worktree_path, None);
    assert_eq!(git(&repo, &["rev-parse", "HEAD"]), commit);
    assert_eq!(
        std::fs::read_to_string(repo.join("README.md")).unwrap(),
        "# App\nBuilt by an agent.\n"
    );
    assert!(!worktree.exists(), "the worktree is removed");
    assert_eq!(
        git(&repo, &["branch", "--list", &branch]),
        "",
        "and its branch"
    );
    let events = until(&mut client, updated_to(AgentStatus::Accepted)).await;
    assert!(events.iter().any(|event| matches!(
        &event.event,
        WispEvent::AgentAccepted { run_id: id, merge } if *id == run_id && *merge == accepted.merge
    )));

    assert_closed_after_accept(&mut client, &accept, &accepted).await;

    // After a restart, the accept is still answered from the store.
    let host = host.restart(fake(Vec::new())).await;
    let mut client = host.client().await;
    let runs = list(&mut client).await;
    assert_eq!(runs[0].status, AgentStatus::Accepted);
    assert_eq!(runs[0].branch, None);
    assert_eq!(
        client.call::<AgentAccept>(accept).await.unwrap(),
        AgentAcceptResult {
            run: runs[0].clone(),
            merge: accepted.merge,
        }
    );
    let closed = client
        .call::<AgentSend>(send_params(run_id, TurnId::generate(), "hello?"))
        .await
        .unwrap_err();
    assert_eq!(kind(&closed), ErrorKind::RunAccepted);
    host.server.stop().await;
}

#[tokio::test]
async fn review_reads_commits_not_the_worktree_and_accept_waits_for_the_run_to_stop() {
    let dir = temp_dir();
    let host = Host::start(
        dir,
        fake(vec![
            init("review-1"),
            Step::AwaitFollowUp,
            end_turn("Noted."),
            Step::Hang,
        ]),
    );
    let mut client = host.client().await;
    let project = create(&mut client, project_params(host.dir.path())).await;
    let repo = PathBuf::from(&project.repo_path);
    subscribe(&mut client, project.id, 0).await;
    let params = start_params(project.id, "Link a secret");
    let run_id = params.run_id;
    let started = client.call::<AgentStart>(params).await.unwrap().run;
    let worktree = PathBuf::from(started.worktree_path.unwrap());

    let requested = client
        .call::<AgentRequestChanges>(AgentRequestChangesParams {
            run_id,
            turn_id: TurnId::generate(),
            text: "Please also update the docs.".to_owned(),
        })
        .await
        .unwrap();
    assert_eq!(requested.run.status, AgentStatus::Running);
    until(
        &mut client,
        has_item(AgentOutputItem::Text {
            message_id: None,
            text: "Please also update the docs.".to_owned(),
        }),
    )
    .await;

    // The worker writes into its worktree while it runs: nothing is reviewable until wispd
    // commits, and accept waits for the run to stop.
    let secret_dir = tempfile::tempdir().unwrap();
    let secret = secret_dir.path().join("secret.txt");
    std::fs::write(&secret, "do not read me\n").unwrap();
    std::os::unix::fs::symlink(&secret, worktree.join("leak")).unwrap();
    std::os::unix::fs::symlink(secret_dir.path(), worktree.join("leakdir")).unwrap();
    let live = client
        .call::<AgentDiff>(AgentDiffParams { run_id })
        .await
        .unwrap();
    assert_eq!(live.base, live.head);
    assert!(live.files.is_empty());
    let busy = client
        .call::<AgentAccept>(AgentAcceptParams {
            run_id,
            id: AcceptId::generate(),
            commit: None,
        })
        .await
        .unwrap_err();
    assert_eq!(kind(&busy), ErrorKind::MergeRefused);
    assert!(busy.message.contains("running"), "{}", busy.message);

    client
        .call::<AgentCancel>(AgentCancelParams { run_id })
        .await
        .unwrap();
    until(&mut client, updated_to(AgentStatus::Cancelled)).await;

    let diff = client
        .call::<AgentDiff>(AgentDiffParams { run_id })
        .await
        .unwrap();
    let paths: Vec<_> = diff.files.iter().map(|file| file.path.as_str()).collect();
    assert_eq!(paths, ["leak", "leakdir"]);
    assert_eq!(
        content(&mut client, run_id, "leak", AgentFileSide::Head).await,
        secret.to_str().unwrap(),
        "a symlink reads as its target path, never the target's content"
    );
    let through = read_file(
        &mut client,
        run_id,
        "leakdir/secret.txt",
        AgentFileSide::Head,
    )
    .await
    .unwrap();
    assert!(!through.exists, "no path leads through a symlinked folder");

    let accepted = client
        .call::<AgentAccept>(AgentAcceptParams {
            run_id,
            id: AcceptId::generate(),
            commit: Some(diff.head.clone()),
        })
        .await
        .unwrap();
    assert_eq!(accepted.merge.how, AgentMergeKind::FastForward);
    assert_eq!(git(&repo, &["rev-parse", "HEAD"]), diff.head);
    host.server.stop().await;
}

// #197: the host and project scheduler.

/// Runs `list` until `ready` accepts what it returns, asserting on every poll that no more than
/// `host_limit` runs are `starting` or `running` at once. Polls rather than following events,
/// since several runs progress concurrently here and a single `until` can only wait for one, and
/// `queued_reason` (unlike a run's stored fields) is never carried on the event stream, only on
/// `agent/list` and `agent/start`'s own results.
async fn poll_until(
    client: &mut Conn,
    host_limit: usize,
    mut ready: impl FnMut(&[AgentRun]) -> bool,
) -> Vec<AgentRun> {
    let deadline = Instant::now() + PATIENCE;
    loop {
        let runs = list(client).await;
        let active = runs
            .iter()
            .filter(|run| matches!(run.status, AgentStatus::Starting | AgentStatus::Running))
            .count();
        assert!(
            active <= host_limit,
            "more than the host limit of {host_limit} ran at once: {runs:#?}"
        );
        if ready(&runs) {
            return runs;
        }
        assert!(Instant::now() < deadline, "gave up waiting; got {runs:#?}");
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
}

fn status_of(runs: &[AgentRun], id: RunId) -> &AgentRun {
    runs.iter()
        .find(|run| run.id == id)
        .unwrap_or_else(|| panic!("run {id} is listed: {runs:#?}"))
}

#[tokio::test]
async fn five_spawns_under_a_host_limit_of_two_run_at_most_two_at_once_and_all_finish() {
    let dir = temp_dir();
    let mut config = InProcess::config(dir.path());
    config.backends = Some(fake(vec![init("s"), text("hi"), Step::Hang]));
    config.scheduler_host_limit = 2;
    config.scheduler_project_limit = 5; // isolate the host limit; not what this test checks
    let server = InProcess::start(config);
    let mut client = Conn::ready(&server.socket).await;
    let project = create(&mut client, project_params(dir.path())).await;

    let mut run_ids = Vec::new();
    for i in 0..5 {
        let params = start_params(project.id, &format!("task {i}"));
        run_ids.push(params.run_id);
        client.call::<AgentStart>(params).await.unwrap();
    }

    let runs = poll_until(&mut client, 2, |runs| {
        let active = runs
            .iter()
            .filter(|run| matches!(run.status, AgentStatus::Starting | AgentStatus::Running))
            .count();
        let queued = runs
            .iter()
            .filter(|run| run.status == AgentStatus::Queued)
            .count();
        active == 2 && queued == 3
    })
    .await;
    for run in runs.iter().filter(|run| run.status == AgentStatus::Queued) {
        assert!(run.queued_reason.is_some(), "{run:?}");
    }

    // Cancel every run in the order it was created. Each cancel frees a slot, which the scheduler
    // fills from the queue, so the next-oldest queued run gets its turn.
    for &id in &run_ids {
        poll_until(&mut client, 2, |runs| {
            matches!(
                status_of(runs, id).status,
                AgentStatus::Starting | AgentStatus::Running
            )
        })
        .await;
        client
            .call::<AgentCancel>(AgentCancelParams { run_id: id })
            .await
            .unwrap();
    }

    let finished = poll_until(&mut client, 2, |runs| {
        runs.iter().all(|run| run.status == AgentStatus::Cancelled)
    })
    .await;
    assert_eq!(finished.len(), 5);
    server.stop().await;
}

#[tokio::test]
async fn cancelling_a_queued_run_creates_no_worktree() {
    let dir = temp_dir();
    let mut config = InProcess::config(dir.path());
    config.backends = Some(fake(hang()));
    config.scheduler_host_limit = 1;
    let server = InProcess::start(config);
    let mut client = Conn::ready(&server.socket).await;
    let project = create(&mut client, project_params(dir.path())).await;

    let running = start_params(project.id, "keeps the one slot busy");
    client.call::<AgentStart>(running).await.unwrap();

    let params = start_params(project.id, "never gets a worktree");
    let queued = client.call::<AgentStart>(params.clone()).await.unwrap().run;
    assert_eq!(queued.status, AgentStatus::Queued);
    assert_eq!(queued.worktree_path, None);
    assert_eq!(queued.branch, None);

    let cancelled = client
        .call::<AgentCancel>(AgentCancelParams {
            run_id: params.run_id,
        })
        .await
        .unwrap()
        .run;
    assert_eq!(cancelled.status, AgentStatus::Cancelled);
    assert_eq!(
        cancelled.worktree_path, None,
        "cancelling a queued run must never create one"
    );
    server.stop().await;
}

#[tokio::test]
async fn queued_runs_survive_a_restart() {
    let dir = temp_dir();
    let mut config = InProcess::config(dir.path());
    config.backends = Some(fake(hang()));
    config.scheduler_host_limit = 1;
    let server = InProcess::start(config);
    let mut client = Conn::ready(&server.socket).await;
    let project = create(&mut client, project_params(dir.path())).await;

    let first = start_params(project.id, "occupies the one slot");
    client.call::<AgentStart>(first).await.unwrap();
    let second = start_params(project.id, "stays queued");
    let queued = client.call::<AgentStart>(second.clone()).await.unwrap().run;
    assert_eq!(queued.status, AgentStatus::Queued);
    drop(client);
    server.stop().await;

    let mut config = InProcess::config(dir.path());
    config.backends = Some(fake(hang()));
    config.scheduler_host_limit = 1;
    let server = InProcess::start(config);
    let mut client = Conn::ready(&server.socket).await;
    let runs = list(&mut client).await;
    let still_queued = status_of(&runs, second.run_id);
    assert_eq!(
        still_queued.status,
        AgentStatus::Queued,
        "a restart must not lose or reinterpret a queued run: {still_queued:?}"
    );
    assert_eq!(still_queued.worktree_path, None);
    server.stop().await;
}

#[tokio::test]
async fn a_rate_limited_account_pauses_new_starts_until_its_reset() {
    let dir = temp_dir();
    let mut config = InProcess::config(dir.path());
    config.backends = Some(fake(vec![
        init("s"),
        Step::Emit(Event::RateLimit(LimitWindow {
            window: "five_hour".to_owned(),
            duration_minutes: None,
            used_percent: Some(100.0),
            status: LimitStatus::Rejected,
            resets_at: Some(jiff::Timestamp::now() + jiff::Span::new().seconds(2)),
        })),
        text("hi"),
        Step::Hang,
    ]));
    config.scheduler_host_limit = 1;
    // Fast enough that the periodic tick notices the reset well inside `PATIENCE`, with no other
    // run finishing to trigger a retry.
    config.scheduler_tick_interval = Duration::from_millis(30);
    let server = InProcess::start(config);
    let mut client = Conn::ready(&server.socket).await;
    let project = create(&mut client, project_params(dir.path())).await;
    subscribe(&mut client, project.id, 0).await;

    let first = start_params(project.id, "reports the account rate limited");
    let first_id = first.run_id;
    client.call::<AgentStart>(first).await.unwrap();
    // The script's `RateLimit` event precedes "hi"; waiting for "hi" means the actor already
    // processed it and paused the account before the second run is admitted.
    until(
        &mut client,
        has_item(AgentOutputItem::Text {
            message_id: None,
            text: "hi".to_owned(),
        }),
    )
    .await;

    let second = start_params(project.id, "waits for the same account");
    let queued = client.call::<AgentStart>(second.clone()).await.unwrap().run;
    assert_eq!(
        queued.status,
        AgentStatus::Queued,
        "the one host slot is still taken by the first run"
    );

    client
        .call::<AgentCancel>(AgentCancelParams { run_id: first_id })
        .await
        .unwrap();

    // The freed slot's own tick considers the second run, finds its account still paused, and
    // leaves it queued with a reason instead of starting it.
    let paused = poll_until(&mut client, 1, |runs| {
        status_of(runs, second.run_id)
            .queued_reason
            .as_deref()
            .is_some_and(|reason| reason.contains("rate limited"))
    })
    .await;
    assert_eq!(
        status_of(&paused, second.run_id).status,
        AgentStatus::Queued
    );

    // Once the window resets, the periodic tick promotes it on its own, with nothing else
    // finishing to trigger a retry.
    poll_until(&mut client, 1, |runs| {
        status_of(runs, second.run_id).status == AgentStatus::Running
    })
    .await;
    server.stop().await;
}

// #269 review: a deadlock, and a rate-limited direct start, a queue that skipped validation, and
// order the scheduler did not actually guarantee.

/// The review's own repro: A holds the one slot, B is queued behind it and always fails to spawn,
/// C is queued behind B. Cancelling A must promote B (which fails), then C (which must still
/// start) — and every connection, including one asking about a run this has nothing to do with,
/// must keep answering throughout. An earlier version of the scheduler deadlocked exactly here:
/// `Actor::release_slot` awaited a recursive `scheduler::tick` that was still holding the mutex
/// its own caller held, wedging every actor's commands (and the accept loop, where the periodic
/// retry ran inline) forever. `poll_until`'s own timeout is what turns that hang into a failing
/// assertion instead of a wedged test binary.
#[tokio::test]
async fn a_run_that_fails_to_spawn_releases_its_slot_so_the_next_queued_run_still_starts() {
    let dir = temp_dir();
    let mut config = InProcess::config(dir.path());
    config.backends = Some(flaky(
        "always fails to spawn",
        vec![init("s"), text("hi"), Step::Hang],
    ));
    config.scheduler_host_limit = 1;
    let server = InProcess::start(config);
    let mut client = Conn::ready(&server.socket).await;
    let project = create(&mut client, project_params(dir.path())).await;

    let a = start_params(project.id, "A holds the one slot");
    client.call::<AgentStart>(a.clone()).await.unwrap();
    let b = start_params(project.id, "always fails to spawn");
    let queued_b = client.call::<AgentStart>(b.clone()).await.unwrap().run;
    assert_eq!(queued_b.status, AgentStatus::Queued);
    let c = start_params(project.id, "C must still get its turn");
    let queued_c = client.call::<AgentStart>(c.clone()).await.unwrap().run;
    assert_eq!(queued_c.status, AgentStatus::Queued);

    client
        .call::<AgentCancel>(AgentCancelParams { run_id: a.run_id })
        .await
        .unwrap();

    poll_until(&mut client, 1, |runs| {
        status_of(runs, b.run_id).status == AgentStatus::Failed
    })
    .await;
    poll_until(&mut client, 1, |runs| {
        status_of(runs, c.run_id).status == AgentStatus::Running
    })
    .await;

    // The connection must still answer promptly, including for a run the deadlock never touched.
    // The call answering at all is the point; the cancel itself is still in flight when it does
    // (its snapshot is taken the moment the signal is sent, same as every other cancel here), so
    // `poll_until` confirms the run actually stops.
    client
        .call::<AgentCancel>(AgentCancelParams { run_id: c.run_id })
        .await
        .unwrap();
    poll_until(&mut client, 1, |runs| {
        status_of(runs, c.run_id).status == AgentStatus::Cancelled
    })
    .await;
    server.stop().await;
}

/// A permanent error while promoting a queued run — here, its repository is gone by the time its
/// turn comes — fails the run outright instead of leaving it `queued` and retrying the same dead
/// end on every future pass.
#[tokio::test]
async fn a_permanent_error_while_promoting_a_queued_run_fails_it_instead_of_retrying_forever() {
    let dir = temp_dir();
    let mut config = InProcess::config(dir.path());
    config.backends = Some(fake(hang()));
    config.scheduler_host_limit = 1;
    config.scheduler_tick_interval = Duration::from_millis(30);
    let server = InProcess::start(config);
    let mut client = Conn::ready(&server.socket).await;
    let project = create(&mut client, project_params(dir.path())).await;
    let repo_path = PathBuf::from(&project.repo_path);

    let first = start_params(project.id, "occupies the one slot");
    client.call::<AgentStart>(first.clone()).await.unwrap();
    let second = start_params(project.id, "its repository will be gone by its turn");
    let queued = client.call::<AgentStart>(second.clone()).await.unwrap().run;
    assert_eq!(queued.status, AgentStatus::Queued);

    std::fs::remove_dir_all(&repo_path).unwrap();
    client
        .call::<AgentCancel>(AgentCancelParams {
            run_id: first.run_id,
        })
        .await
        .unwrap();

    let failed = poll_until(&mut client, 1, |runs| {
        status_of(runs, second.run_id).status == AgentStatus::Failed
    })
    .await;
    assert!(
        status_of(&failed, second.run_id).error.is_some(),
        "{:?}",
        status_of(&failed, second.run_id)
    );
    server.stop().await;
}

/// `agent/start` validates a request the same way whether or not it ends up queued: a bad account
/// fails immediately, even while the host is full, instead of sitting `queued` forever.
#[tokio::test]
async fn a_bad_request_fails_immediately_even_while_the_host_is_full() {
    let dir = temp_dir();
    let mut config = InProcess::config(dir.path());
    config.backends = Some(fake(hang()));
    config.scheduler_host_limit = 1;
    let server = InProcess::start(config);
    let mut client = Conn::ready(&server.socket).await;
    let project = create(&mut client, project_params(dir.path())).await;

    let first = start_params(project.id, "occupies the one slot");
    client.call::<AgentStart>(first).await.unwrap();

    let mut bad = start_params(project.id, "names an account that does not exist");
    bad.account = Some(AccountChoice::Key {
        id: AccountId::generate(),
    });
    let error = client.call::<AgentStart>(bad).await.unwrap_err();
    assert_eq!(kind(&error), ErrorKind::AccountNotFound);

    let runs = list(&mut client).await;
    assert_eq!(
        runs.len(),
        1,
        "the bad request must never be recorded: {runs:#?}"
    );
    server.stop().await;
}

/// A rate-limited account pauses a brand-new `agent/start`, not only one that happened to queue
/// first: the host here has plenty of room, and nothing else is queued.
#[tokio::test]
async fn a_rate_limited_account_pauses_a_direct_start_with_a_free_slot() {
    let dir = temp_dir();
    let mut config = InProcess::config(dir.path());
    config.backends = Some(fake(vec![
        init("s"),
        Step::Emit(Event::RateLimit(LimitWindow {
            window: "five_hour".to_owned(),
            duration_minutes: None,
            used_percent: Some(100.0),
            status: LimitStatus::Rejected,
            resets_at: Some(jiff::Timestamp::now() + jiff::Span::new().hours(1)),
        })),
        text("hi"),
        Step::Hang,
    ]));
    config.scheduler_host_limit = 4;
    let server = InProcess::start(config);
    let mut client = Conn::ready(&server.socket).await;
    let project = create(&mut client, project_params(dir.path())).await;
    subscribe(&mut client, project.id, 0).await;

    let first = start_params(project.id, "reports the account rate limited");
    client.call::<AgentStart>(first).await.unwrap();
    until(
        &mut client,
        has_item(AgentOutputItem::Text {
            message_id: None,
            text: "hi".to_owned(),
        }),
    )
    .await;

    let second = start_params(project.id, "must not start on the paused account");
    let run = client.call::<AgentStart>(second).await.unwrap().run;
    assert_eq!(
        run.status,
        AgentStatus::Queued,
        "the host has plenty of free slots (4) and nothing is queued, so only the rate limit \
         explains this"
    );
    assert!(
        run.queued_reason
            .as_deref()
            .unwrap()
            .contains("rate limited"),
        "{run:?}"
    );
    server.stop().await;
}

/// A new `agent/start` must not start ahead of an older queued run, even in a different project
/// that, on its own, would have room: once anything is queued host-wide, the scheduler task is
/// the only thing that promotes, always oldest first.
#[tokio::test]
async fn a_new_start_queues_behind_an_older_queued_run_in_a_different_project() {
    let dir = temp_dir();
    let mut config = InProcess::config(dir.path());
    config.backends = Some(fake(hang()));
    config.scheduler_host_limit = 5;
    config.scheduler_project_limit = 1;
    let server = InProcess::start(config);
    let mut client = Conn::ready(&server.socket).await;
    let dir_b = temp_dir();
    let project_a = create(&mut client, project_params(dir.path())).await;
    let project_b = create(&mut client, project_params(dir_b.path())).await;

    let first = start_params(project_a.id, "fills project A's own limit of one");
    client.call::<AgentStart>(first).await.unwrap();
    let second = start_params(
        project_a.id,
        "queues on A's limit; the host has plenty of room",
    );
    let queued = client.call::<AgentStart>(second).await.unwrap().run;
    assert_eq!(queued.status, AgentStatus::Queued);

    let third = start_params(
        project_b.id,
        "a later arrival in an unrelated, empty project",
    );
    let run = client.call::<AgentStart>(third).await.unwrap().run;
    assert_eq!(
        run.status,
        AgentStatus::Queued,
        "a new run must not start ahead of an older queued one, even in a different project"
    );
    server.stop().await;
}

// #272: resumed runs count against the scheduler limits too.

/// Resuming a finished run's session starts a new CLI process, which must respect the same host
/// limit a fresh start does: it is refused, not silently allowed to exceed the limit, while
/// another run holds the only slot.
#[tokio::test]
async fn resuming_a_finished_run_is_refused_while_the_host_is_full() {
    let dir = temp_dir();
    let mut config = InProcess::config(dir.path());
    config.backends = Some(fake(hang()));
    config.scheduler_host_limit = 1;
    let server = InProcess::start(config);
    let mut client = Conn::ready(&server.socket).await;
    let project = create(&mut client, project_params(dir.path())).await;
    subscribe(&mut client, project.id, 0).await;

    let done = start_params(project.id, "finishes and can be resumed");
    let run_id = done.run_id;
    client.call::<AgentStart>(done).await.unwrap();
    // Waits for the CLI's session to actually be recorded before cancelling: cancelling too soon
    // would end the run before it ever became resumable, unrelated to what this test checks.
    until(
        &mut client,
        has_item(AgentOutputItem::Text {
            message_id: None,
            text: "Working".to_owned(),
        }),
    )
    .await;
    client
        .call::<AgentCancel>(AgentCancelParams { run_id })
        .await
        .unwrap();
    poll_until(&mut client, 1, |runs| {
        status_of(runs, run_id).status == AgentStatus::Cancelled
    })
    .await;

    let holder = start_params(project.id, "holds the only slot");
    client.call::<AgentStart>(holder).await.unwrap();

    let turn = TurnId::generate();
    let error = client
        .call::<AgentSend>(send_params(run_id, turn, "carry on"))
        .await
        .unwrap_err();
    assert_eq!(kind(&error), ErrorKind::HostBusy);

    let runs = list(&mut client).await;
    assert_eq!(
        status_of(&runs, run_id).status,
        AgentStatus::Cancelled,
        "no second CLI was actually started for the resumed run"
    );
    server.stop().await;
}
