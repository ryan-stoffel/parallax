//! The M3 runner end to end (#156): `agent/*` against an in-process server whose worker backend
//! is the fake CLI, in a real git repository.

use std::collections::VecDeque;
#[cfg(target_os = "macos")]
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::Arc;
use std::time::Duration;

use parallax_protocol::jsonrpc::{
    ErrorObject, INVALID_PARAMS, Message, Notification, Request, RequestId,
};
use parallax_protocol::methods::{
    AgentAccept, AgentCancel, AgentDiff, AgentEvents, AgentFile, AgentList, AgentRequestChanges,
    AgentSend, AgentStart, EventsEvent, EventsSubscribe, NotificationMethod, ProjectCreate,
    RepoAdd, RequestMethod,
};
use parallax_protocol::{
    AcceptId, AccountChoice, AgentAcceptParams, AgentAcceptResult, AgentCancelParams,
    AgentDiffParams, AgentDiffResult, AgentDiffStats, AgentEventsParams, AgentFileParams,
    AgentFileResult, AgentFileSide, AgentFileStatus, AgentListParams, AgentMerge, AgentMergeKind,
    AgentOutcome, AgentOutputItem, AgentPolicy, AgentRequestChangesParams, AgentRun,
    AgentSendParams, AgentStartParams, AgentStatus, DiffSummary, ErrorKind, EventsEventParams,
    EventsSubscribeParams, InitializeResult, ParallaxEvent, Project, ProjectCreateParams,
    ProjectId, Provider, Repo, RepoAddParams, RepoId, RunId, TurnId,
};
use plxd::backend::Event;
use plxd::backend::fake::{FakeBackend, Script, Step};
use plxd::backend::process::{CancelPolicy, Environment, Launcher};
use plxd::paths::DataDir;
use plxd::routing::BackendRegistry;
use rustix::process::Signal;
use serde::de::DeserializeOwned;
use tempfile::TempDir;
use tokio::time::Instant;

use crate::support::{Client, InProcess, PATIENCE, kind, temp_dir};

pub(crate) fn git(dir: &Path, args: &[&str]) -> String {
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
    named_repo(dir, "app")
}

/// [`real_repo`] at `dir/repos/<name>`.
pub(crate) fn named_repo(dir: &Path, name: &str) -> PathBuf {
    let repo = dir.join("repos").join(name);
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
    let mut backends = BackendRegistry::new();
    backends.register(Provider::Anthropic, Arc::new(fake_backend(steps)));
    backends
}

/// The fake CLI playing `steps`, as the `fake` account's backend.
pub(crate) fn fake_backend(steps: Vec<Step>) -> FakeBackend {
    let scratch = tempfile::tempdir().unwrap();
    let launcher = Launcher::new(
        DataDir::new(scratch.path()).unwrap(),
        Environment::inherited(),
    );
    FakeBackend::new(launcher, Script { steps }).with_cancel_policy(CancelPolicy {
        signal: Signal::INT,
        group: false,
        // The fake's shell can lose a SIGINT that lands while it forks (#188), so `SIGKILL`
        // follows soon.
        grace: Duration::from_millis(500),
    })
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
        notify: None,
        model: None,
        effort: None,
        permission: None,
        context_window: None,
        fast: None,
        images: Vec::new(),
        approvals: false,
        threads: Vec::new(),
        explore: false,
    }
}

pub(crate) fn send_params(run_id: RunId, turn_id: TurnId, text: &str) -> AgentSendParams {
    AgentSendParams {
        run_id,
        turn_id,
        text: text.to_owned(),
        model: None,
        effort: None,
        permission: None,
        context_window: None,
        fast: None,
        account: None,
        images: Vec::new(),
        threads: Vec::new(),
        from: None,
        delivery: None,
    }
}

/// An in-process plxd and its data folder.
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

    /// A host whose API keys and secrets live in `keys`, never the real keystore.
    pub(crate) fn start_with_keys(
        dir: TempDir,
        backends: BackendRegistry,
        keys: std::sync::Arc<dyn plxd::keystore::KeyStore>,
    ) -> Self {
        let mut config = InProcess::config(dir.path());
        config.backends = Some(backends);
        config.keys = Some(keys);
        let server = InProcess::start(config);
        Self { dir, server }
    }

    pub(crate) async fn restart(self, backends: BackendRegistry) -> Self {
        let Self { dir, server } = self;
        server.stop().await;
        Self::start(dir, backends)
    }

    pub(crate) async fn client(&self) -> Conn {
        Conn::ready(&self.server.socket).await
    }

    /// A client on a new Project in a new real repository, subscribed to its events from the
    /// start.
    pub(crate) async fn project_client(&self) -> (Conn, Project) {
        let mut client = self.client().await;
        let project = create(&mut client, project_params(self.dir.path())).await;
        subscribe(&mut client, project.id, 0).await;
        (client, project)
    }
}

/// The project id a repo entry's events carry: the entry's own id.
pub(crate) fn scope(repo: RepoId) -> ProjectId {
    ProjectId::try_from(uuid::Uuid::from(repo)).unwrap()
}

/// Params for a project on a new real repository under `dir`.
pub(crate) fn project_params(dir: &Path) -> ProjectCreateParams {
    ProjectCreateParams {
        id: ProjectId::generate(),
        name: "app".to_owned(),
        repo_path: real_repo(dir).to_str().unwrap().to_owned(),
        icon: None,
        permission: None,
        autonomy: None,
        base_branch: None,
    }
}

pub(crate) async fn create(client: &mut Conn, params: ProjectCreateParams) -> Project {
    client.call::<ProjectCreate>(params).await.unwrap().project
}

pub(crate) async fn subscribe(client: &mut Conn, project: ProjectId, after: u64) {
    client
        .call::<EventsSubscribe>(EventsSubscribeParams {
            after,
            project: Some(project),
            run: None,
            shell: false,
        })
        .await
        .unwrap();
}

/// A client on which events can arrive between a request and its response. They wait in
/// `pending` for [`until`], so none is lost.
pub(crate) struct Conn {
    client: Client,
    pub(crate) pending: VecDeque<EventsEventParams>,
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

    pub(crate) async fn ready(socket: &Path) -> Self {
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
        self.response(id).await
    }

    /// [`Conn::call`] with `commandId` in its params (0052, 0059).
    pub(crate) async fn command<M: RequestMethod>(
        &mut self,
        params: M::Params,
        command_id: uuid::Uuid,
    ) -> Result<M::Result, ErrorObject> {
        let mut value = serde_json::to_value(params).unwrap();
        value.as_object_mut().unwrap().insert(
            "commandId".to_owned(),
            serde_json::json!(command_id.hyphenated().to_string()),
        );
        let id = RequestId::String(uuid::Uuid::now_v7().hyphenated().to_string());
        self.client
            .send_message(&Request {
                id: id.clone(),
                method: M::NAME.to_owned(),
                params: Some(value),
            })
            .await;
        self.response(id).await
    }

    /// The answer to `id`, which must be the next response, keeping the events before it.
    async fn response<T: DeserializeOwned>(&mut self, id: RequestId) -> Result<T, ErrorObject> {
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

    /// Adds the repository at `path` as a repo entry, and returns the entry.
    pub(crate) async fn add(&mut self, path: &Path) -> Repo {
        self.call::<RepoAdd>(RepoAddParams {
            id: RepoId::generate(),
            path: path.to_str().unwrap().to_owned(),
        })
        .await
        .unwrap()
        .repo
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
}

/// Events until one matches `done`, which is included.
pub(crate) async fn until(
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

pub(crate) fn updated_to(status: AgentStatus) -> impl FnMut(&EventsEventParams) -> bool {
    move |event| matches!(&event.event, ParallaxEvent::AgentUpdated { state, .. } if state.status == status)
}

pub(crate) fn has_item(item: AgentOutputItem) -> impl FnMut(&EventsEventParams) -> bool {
    move |event| matches!(&event.event, ParallaxEvent::AgentOutput { items, .. } if items.contains(&item))
}

pub(crate) fn items(events: &[EventsEventParams]) -> Vec<AgentOutputItem> {
    events
        .iter()
        .filter_map(|event| match &event.event {
            ParallaxEvent::AgentOutput { items, .. } => Some(items.clone()),
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

pub(crate) fn outcomes(events: &[EventsEventParams]) -> Vec<AgentOutcome> {
    events
        .iter()
        .filter_map(|event| match &event.event {
            ParallaxEvent::AgentFinished { outcome, .. } => Some(outcome.clone()),
            _ => None,
        })
        .collect()
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
    assert_eq!(subject, "parallax: Rewrite the README");
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
    let pairs = |events: &[EventsEventParams]| -> Vec<(u64, ParallaxEvent)> {
        events
            .iter()
            .map(|event| (event.seq, event.event.clone()))
            .collect()
    };
    assert_eq!(pairs(&replayed), pairs(events));

    let page = replay
        .call::<AgentEvents>(AgentEventsParams {
            before: None,
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
            before: None,
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
    // The run's own events, which carry its id: not the Project's context or inbox events.
    let run_events: Vec<u64> = events
        .iter()
        .filter(|event| serde_json::to_value(&event.event).unwrap()["runId"] == run_id.to_string())
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
    assert!(branch.starts_with("parallax/"), "{branch}");

    let (mut context_changed, mut checkpoint) = (false, false);
    let mut is_done = updated_to(AgentStatus::Completed);
    let mut events = until(&mut client, |event| {
        context_changed |=
            matches!(&event.event, ParallaxEvent::ContextChanged { file } if file.path == "notes.md");
        checkpoint |= matches!(event.event, ParallaxEvent::ThreadCheckpoint { .. });
        is_done(event)
    })
    .await;
    let kinds = kinds(&events);
    assert_eq!(kinds[0], "agent.started", "{kinds:?}");
    for expected in ["agent.updated", "agent.output", "agent.finished"] {
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
    let ParallaxEvent::AgentUpdated { state: done, .. } = &events.last().unwrap().event else {
        unreachable!()
    };
    let diff = done.diff.as_ref().expect("a diff");
    assert_eq!((diff.files, diff.insertions, diff.deletions), (1, 2, 1));
    assert_eq!(done.session_id.as_deref(), Some("session-1"));
    for event in &events {
        if let ParallaxEvent::AgentUpdated { .. } = event.event {
            let json = serde_json::to_string(&event.event).unwrap();
            assert!(!json.contains("Rewrite the README"), "no prompt: {json}");
        }
    }

    assert_committed(Path::new(&project.repo_path), &branch, &worktree, diff);
    assert_eq!(
        std::fs::read_to_string(&note).unwrap(),
        "Build with cargo.\n"
    );
    // The turn's checkpoint is a run event that can follow its end (0062), so the replay waits
    // for it too.
    if !(context_changed && checkpoint) {
        events.extend(
            until(&mut client, |event| {
                context_changed |= matches!(&event.event, ParallaxEvent::ContextChanged { file } if file.path == "notes.md");
                checkpoint |= matches!(event.event, ParallaxEvent::ThreadCheckpoint { .. });
                context_changed && checkpoint
            })
            .await,
        );
    }

    assert_replays(&host, project.id, params.run_id, &events).await;
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
    let params = start_params(project.id, "Work until plxd stops");
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
    assert_eq!(init.log_id, first_log, "the event log outlived plxd");
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
    // The resumed CLI reports its session after the turn has started, so the two can land in
    // separate 50 ms `agent.output` batches (PLX-132): wait for both.
    let mut wanted = vec![
        AgentOutputItem::TurnStarted {
            turn_id: Some(turn),
            text: Some("carry on".to_owned()),
            wake: false,
            from: None,
            images: Vec::new(),
            threads: Vec::new(),
        },
        AgentOutputItem::SessionStarted {
            session_id: "hang-1".to_owned(),
            model: None,
        },
    ];
    until(&mut client, |event| {
        if let ParallaxEvent::AgentOutput { items, .. } = &event.event {
            wanted.retain(|item| !items.contains(item));
        }
        wanted.is_empty()
    })
    .await;
    drop(client);

    // A crash: the store still says `running` when plxd starts, and the turn that never ended
    // left its replies unindexed (PLX-487).
    let Host { dir, server } = host;
    server.stop().await;
    let replies = |dir: &std::path::Path| -> i64 {
        rusqlite::Connection::open(dir.join("plxd.sqlite3"))
            .unwrap()
            .query_row(
                "SELECT COUNT(*) FROM thread_text WHERE text LIKE '%Working%'",
                [],
                |row| row.get(0),
            )
            .unwrap()
    };
    {
        let db = rusqlite::Connection::open(dir.path().join("plxd.sqlite3")).unwrap();
        db.execute("UPDATE runs SET status = 'running'", [])
            .unwrap();
        db.execute("DELETE FROM thread_text WHERE seq > 0", [])
            .unwrap();
    }
    assert_eq!(replies(dir.path()), 0);
    let host = Host::start(dir, fake(hang()));
    let mut client = host.client().await;
    let runs = list(&mut client).await;
    assert_eq!(runs[0].status, AgentStatus::Interrupted);
    assert_eq!(runs[0].session_id.as_deref(), Some("hang-1"));
    host.server.stop().await;
    assert_eq!(replies(host.dir.path()), 1, "indexed at startup");
}

/// A stand-in for the Claude Agent SDK sidecar (0061) that records each query's `open` line and
/// what plxd sends its CLI's stdin in `out/claude.open` and `out/claude.stdin` beside its folder,
/// and ends a query that plxd interrupts or kills.
#[cfg(target_os = "macos")]
const CLAUDE_SDK: &str = r#"#!/bin/sh
out="$(dirname "$0")/../out"
while IFS= read -r line; do
  case $line in
    *'"type":"open"'*) printf '%s\n' "$line" > "$out/claude.open" ;;
    *'"stdin":'*) printf '%s\n' "$line" >> "$out/claude.stdin" ;;
    *'"type":"interrupt"'* | *'"type":"kill"'*)
      id=$(printf '%s' "$line" | sed -n 's/^{"id":"\([^"]*\)".*/\1/p')
      printf '%s exit {"code":null,"signal":2}\n' "$id" ;;
  esac
done
"#;

/// An in-process plxd whose Claude Code, Codex, and Cursor backends are plxd's real ones,
/// running `scripts`, stand-ins for `claude`, `codex`, and the Cursor SDK sidecar (`cursor-sdk`,
/// through `PLXD_CURSOR_SDK`), from a folder in `dir` that is the agents' whole `PATH` besides the
/// system's. Claude runs through [`CLAUDE_SDK`] (`PLXD_CLAUDE_SDK`).
#[cfg(target_os = "macos")]
fn built_in_kinds(dir: &Path, scripts: [(&str, String); 3]) -> InProcess {
    let bin = dir.join("bin");
    std::fs::create_dir_all(&bin).unwrap();
    let scripts = scripts
        .into_iter()
        .chain([("claude-sdk", CLAUDE_SDK.to_owned())]);
    for (program, script) in scripts {
        let path = bin.join(program);
        std::fs::write(&path, script).unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
    }
    let mut environment = Environment::empty();
    environment.set("PATH", format!("{}:/usr/bin:/bin", bin.display()));
    environment.set("PLXD_CURSOR_SDK", bin.join("cursor-sdk"));
    environment.set("PLXD_CLAUDE_SDK", bin.join("claude-sdk"));
    let mut config = InProcess::config(dir);
    config.agent_environment = Some(environment.clone());
    let mut backends = BackendRegistry::new();
    let launcher = Launcher::new(DataDir::new(dir).unwrap(), environment);
    backends.register(
        Provider::Anthropic,
        Arc::new(plxd::backend::claude::ClaudeBackend::new(launcher.clone())),
    );
    backends.register(
        Provider::Openai,
        Arc::new(plxd::backend::codex::CodexBackend::new(launcher.clone())),
    );
    backends.register(
        Provider::Cursor,
        Arc::new(plxd::providers::cursor_backend(launcher)),
    );
    config.backends = Some(backends);
    InProcess::start(config)
}

/// What the stand-in for `program` recorded in `out`'s `file`, once it holds `wanted`.
#[cfg(target_os = "macos")]
async fn recorded(out: &Path, program: &str, file: &str, wanted: &str) -> String {
    let path = out.join(format!("{program}.{file}"));
    let deadline = Instant::now() + PATIENCE;
    loop {
        let text = std::fs::read_to_string(&path).unwrap_or_default();
        if text.contains(wanted) {
            return text;
        }
        assert!(
            Instant::now() < deadline,
            "{program} never wrote {wanted:?}: {text}"
        );
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
}

/// PLX-396 (0042): a Project's child starts on each built-in kind as a thread the user starts
/// would, through plxd's real backends: Claude Code as full Claude Code with plxd's thread tools,
/// Codex on `codex app-server`, and Cursor on its SDK sidecar (0053), each in the Project's mode and
/// asking through the inbox. Auto is where a worker would have kept the sandbox's flags. Each
/// stand-in CLI records its arguments and what plxd writes it.
#[cfg(target_os = "macos")]
#[tokio::test]
#[expect(clippy::too_many_lines, reason = "one case per built-in kind")]
async fn a_projects_child_starts_as_a_thread_on_each_built_in_kind() {
    use parallax_protocol::{AgentPermission, ProjectPermission};

    let dir = temp_dir();
    let out = dir.path().join("out");
    std::fs::create_dir_all(&out).unwrap();
    let out = out.canonicalize().unwrap();
    let script = |program: &'static str, version: &str| {
        let out = out.display();
        let script = format!(
            "#!/bin/sh\n\
             case \"$1\" in\n\
             --version) echo '{version}'; exit 0 ;;\n\
             auth|login|status) printf '%s' '{{\"loggedIn\":true}}'; exit 0 ;;\n\
             esac\n\
             printf '%s\\n' \"$@\" > '{out}/{program}.argv'\n\
             while IFS= read -r line; do printf '%s\\n' \"$line\" >> '{out}/{program}.stdin'; done\n"
        );
        (program, script)
    };
    let server = built_in_kinds(
        dir.path(),
        [
            script("claude", "2.1.300 (Claude Code)"),
            script("codex", "codex-cli 0.160.0"),
            script("cursor-sdk", "1.0.35"),
        ],
    );
    let mut client = Conn::ready(&server.socket).await;
    let mut projects = Vec::new();
    for permission in [ProjectPermission::Auto, ProjectPermission::Bypass] {
        let repo = temp_dir();
        let params = ProjectCreateParams {
            permission: Some(permission),
            ..project_params(repo.path())
        };
        projects.push((create(&mut client, params).await, repo));
    }
    let (auto, bypass) = (&projects[0].0, &projects[1].0);

    let (auto_mode, bypass_mode) = (AgentPermission::Auto, AgentPermission::Bypass);
    for (project, mode, backend, program) in [
        (auto, auto_mode, "claude", "claude"),
        (auto, auto_mode, "codex", "codex"),
        (auto, auto_mode, "cursor", "cursor-sdk"),
        (bypass, bypass_mode, "claude", "claude"),
        (bypass, bypass_mode, "codex", "codex"),
        (bypass, bypass_mode, "cursor", "cursor-sdk"),
    ] {
        // Both Codex children share the first one's app-server (0060), so it starts once.
        if program != "codex" || project.id == auto.id {
            for file in ["argv", "stdin", "open"] {
                let _ = std::fs::remove_file(out.join(format!("{program}.{file}")));
            }
        }
        let run = client
            .call::<AgentStart>(AgentStartParams {
                account: Some(AccountChoice::Subscription {
                    backend: backend.to_owned(),
                }),
                ..start_params(project.id, "Tidy the build")
            })
            .await
            .unwrap()
            .run;
        assert!(run.approvals, "{backend} asks through the inbox");
        assert_eq!(run.permission, Some(mode), "{backend}");
        assert!(run.branch.is_some(), "{backend} works in its own worktree");

        // Claude's arguments go to the Agent SDK sidecar, in its query's `open` line.
        let argv = if backend == "claude" {
            let open = recorded(&out, program, "open", "\n").await;
            let open: serde_json::Value = serde_json::from_str(&open).unwrap();
            let args: Vec<&str> = open["args"]
                .as_array()
                .unwrap()
                .iter()
                .map(|arg| arg.as_str().unwrap())
                .collect();
            args.join("\n")
        } else {
            recorded(&out, program, "argv", "\n").await
        };
        let argv: Vec<&str> = argv.lines().collect();
        match backend {
            "claude" => {
                for worker in ["--restricted", "--tools", "--strict-mcp-config"] {
                    assert!(!argv.contains(&worker), "{mode:?}: {argv:?}");
                }
                let flag = argv.iter().position(|arg| *arg == "--permission-mode");
                let expected = if mode == auto_mode {
                    "auto"
                } else {
                    "bypassPermissions"
                };
                assert_eq!(flag.map(|at| argv[at + 1]), Some(expected));
                assert!(argv.contains(&"--mcp-config"), "the thread tools: {argv:?}");
                let stdin = recorded(&out, program, "stdin", "Tidy the build").await;
                assert!(
                    stdin.contains(
                        "You are working on a task in the Parallax Project \\\"app\\\".\\n\
                         Your Parallax tools are on the plxd MCP server: thread_list,"
                    ),
                    "{stdin}"
                );
                assert!(
                    stdin.contains("\\n\\nYour task:\\nTidy the build"),
                    "{stdin}"
                );
            }
            "codex" => {
                assert_eq!(argv, ["app-server"]);
                // The threads' app-server, not a login check's, initializes once.
                let stdin = recorded(&out, program, "stdin", "\"title\":\"Parallax\"").await;
                assert_eq!(
                    stdin.matches("\"title\":\"Parallax\"").count(),
                    1,
                    "{stdin}"
                );
            }
            _ => {
                assert_eq!(argv.first(), Some(&"run"), "{argv:?}");
                let permission = if mode == auto_mode { "auto" } else { "bypass" };
                recorded(
                    &out,
                    program,
                    "stdin",
                    &format!("\"permission\":\"{permission}\""),
                )
                .await;
            }
        }
    }
    server.stop().await;
}

pub(crate) fn decode_base64(text: &str) -> Vec<u8> {
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
            offset: None,
            length: None,
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
            offset: None,
            length: None,
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
            offset: None,
            length: None,
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
    let ParallaxEvent::AgentUpdated { state, .. } = &events.last().unwrap().event else {
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
        ParallaxEvent::AgentAccepted { run_id: id, merge } if *id == run_id && *merge == accepted.merge
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
            Step::EndTurn { result: None },
            Step::AwaitFollowUp,
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

    // The worker writes into its worktree while it runs: nothing is reviewable until plxd
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
        .call::<AgentCancel>(AgentCancelParams { run_id, from: None })
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
