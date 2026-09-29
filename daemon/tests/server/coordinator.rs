//! A project's coordinator chat end to end (RYA-41, decision 0024): `project/start` against an
//! in-process wispd whose backend is the fake CLI, in a real git repository. The coordinator runs
//! in a detached worktree of its own (RYA-171).

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use uuid::Uuid;
use wisp_protocol::methods::{AgentEvents, AgentSend, AgentStart, ProjectList, ProjectStart};
use wisp_protocol::{
    AccountChoice, AgentEventsParams, AgentFailureKind, AgentOutcome, AgentOutputItem, AgentPolicy,
    AgentStartParams, AgentStatus, CoordinatorThreadId, ErrorKind, EventsEventParams, ProjectId,
    ProjectListParams, ProjectStartParams, Provider, RunId, TurnId, WispEvent,
};
use wispd::backend::fake::{FakeBackend, Step};
use wispd::backend::{Backend, Capabilities, RunRequest, StartError, Started, ToolPolicy};
use wispd::paths::DataDir;
use wispd::routing::BackendRegistry;

use crate::agents::{
    Host, create, end_turn, fake, fake_backend, git, init, items, outcomes, project_params,
    send_params, subscribe, text, until, updated_to,
};
use crate::support::{PATIENCE, kind, temp_dir};

/// The fake backend, keeping every request it is asked to start.
struct Recording {
    fake: FakeBackend,
    seen: Arc<Mutex<Vec<RunRequest>>>,
}

impl Backend for Recording {
    fn name(&self) -> &'static str {
        self.fake.name()
    }

    fn capabilities(&self) -> Capabilities {
        self.fake.capabilities()
    }

    fn start(&self, request: RunRequest) -> Result<Started, StartError> {
        self.seen.lock().unwrap().push(request.clone());
        self.fake.start(request)
    }
}

fn recording(steps: Vec<Step>, seen: &Arc<Mutex<Vec<RunRequest>>>) -> BackendRegistry {
    let mut backends = BackendRegistry::new();
    backends.register(
        Provider::Anthropic,
        Arc::new(Recording {
            fake: fake_backend(steps),
            seen: Arc::clone(seen),
        }),
    );
    backends
}

fn start_params(project: ProjectId, prompt: &str) -> ProjectStartParams {
    ProjectStartParams {
        project,
        run_id: RunId::generate(),
        prompt: prompt.to_owned(),
        account: Some(AccountChoice::Subscription {
            backend: "fake".to_owned(),
        }),
        model: None,
        effort: None,
    }
}

fn head(repo: &Path) -> String {
    git(repo, &["rev-parse", "HEAD"])
}

/// Where `host` runs `project`'s coordinator.
fn worktree(host: &Host, project: ProjectId) -> PathBuf {
    DataDir::new(host.dir.path())
        .unwrap()
        .coordinator_dir(project)
}

fn finished(event: &EventsEventParams) -> bool {
    matches!(event.event, WispEvent::AgentFinished { .. })
}

#[tokio::test]
async fn a_coordinator_runs_no_write_in_its_own_worktree_and_resumes_there_after_a_restart() {
    let seen = Arc::new(Mutex::new(Vec::new()));
    let script = || {
        vec![
            init("coordinator-1"),
            text("Planning."),
            end_turn("Planned."),
        ]
    };
    let host = Host::start(temp_dir(), recording(script(), &seen));
    let mut client = host.client().await;
    let project = create(&mut client, project_params(host.dir.path())).await;
    let repo = PathBuf::from(&project.repo_path);
    let worktree = worktree(&host, project.id);
    let before = head(&repo);
    // The user's own uncommitted work stays in the checkout.
    std::fs::write(repo.join("notes.txt"), "mine\n").unwrap();
    subscribe(&mut client, project.id, 0).await;

    let params = start_params(project.id, "Plan the README.");
    let run = client
        .call::<ProjectStart>(params.clone())
        .await
        .unwrap()
        .run;
    assert_eq!(run.policy, AgentPolicy::NoWrite);
    let thread = CoordinatorThreadId::try_from(Uuid::from(run.id)).unwrap();
    assert_eq!(
        run.coordinator_thread,
        Some(thread),
        "its thread is its own id"
    );
    assert_eq!(run.worktree_path, None);
    let retried = client.call::<ProjectStart>(params.clone()).await.unwrap();
    assert_eq!(retried.run.id, run.id, "a retry returns the same run");
    let projects = client
        .call::<ProjectList>(ProjectListParams {})
        .await
        .unwrap()
        .projects;
    assert_eq!(projects[0].coordinator, Some(run.id));

    let events = until(&mut client, updated_to(AgentStatus::Completed)).await;
    assert!(items(&events).contains(&AgentOutputItem::Text {
        message_id: None,
        text: "Planning.".to_owned(),
    }));
    let first = seen.lock().unwrap()[0].clone();
    assert_eq!(first.policy, ToolPolicy::NoWrite);
    assert_eq!(first.cwd, worktree, "it runs in its own worktree");
    assert_eq!(head(&worktree), before, "at the repository's HEAD");
    assert!(first.sandbox.is_none());
    let tools = first.coordinator_tools.expect("wispd's tools are attached");
    assert_eq!((tools.project, tools.thread), (project.id, thread));
    assert!(first.prompt.contains("spawn_agent"), "{}", first.prompt);
    assert!(
        first.prompt.ends_with("Plan the README."),
        "{}",
        first.prompt
    );
    assert_eq!(head(&repo), before, "a coordinator is never committed");
    assert_eq!(
        std::fs::read_to_string(repo.join("notes.txt")).unwrap(),
        "mine\n"
    );

    let host = host.restart(recording(script(), &seen)).await;
    let mut client = host.client().await;
    let transcript = client
        .call::<AgentEvents>(AgentEventsParams {
            run_id: run.id,
            after: 0,
            limit: None,
        })
        .await
        .unwrap();
    assert!(
        transcript.events.iter().any(|logged| matches!(
            &logged.event,
            WispEvent::AgentOutput { items, .. } if items.iter().any(|item| matches!(
                item, AgentOutputItem::Text { text, .. } if text == "Planning."
            ))
        )),
        "the transcript survives the restart"
    );
    subscribe(&mut client, project.id, 0).await;
    client
        .call::<AgentSend>(send_params(run.id, TurnId::generate(), "Go on."))
        .await
        .unwrap();
    until(&mut client, updated_to(AgentStatus::Completed)).await;
    let resumed = seen.lock().unwrap()[1].clone();
    assert_eq!(
        resumed.resume.map(|resume| resume.session_id).as_deref(),
        Some("coordinator-1"),
        "a message resumes the session"
    );
    assert_eq!(resumed.prompt, "Go on.");
    assert_eq!(
        resumed.cwd, worktree,
        "the session resumes where it started"
    );
    assert_eq!(resumed.policy, ToolPolicy::NoWrite);
    assert!(resumed.coordinator_tools.is_some());
    host.server.stop().await;
}

#[tokio::test]
async fn a_turn_that_changes_the_working_tree_stops_and_names_the_change_without_reverting_it() {
    let script = vec![
        init("coordinator-1"),
        Step::WriteFile {
            path: "README.md".to_owned(),
            content: "rewritten\n".to_owned(),
        },
        end_turn("Edited."),
        Step::Hang,
    ];
    let host = Host::start(temp_dir(), fake(script));
    let mut client = host.client().await;
    let project = create(&mut client, project_params(host.dir.path())).await;
    subscribe(&mut client, project.id, 0).await;

    let run = client
        .call::<ProjectStart>(start_params(project.id, "Look around."))
        .await
        .unwrap()
        .run;
    let events = until(&mut client, updated_to(AgentStatus::Failed)).await;
    let outcomes = outcomes(&events);
    let [AgentOutcome::Failed { failure, message }] = outcomes.as_slice() else {
        panic!("{events:#?}");
    };
    assert_eq!(*failure, AgentFailureKind::PolicyViolation);
    assert!(message.contains("README.md"), "{message}");
    let repo = PathBuf::from(&project.repo_path);
    assert_eq!(
        std::fs::read_to_string(worktree(&host, project.id).join("README.md")).unwrap(),
        "rewritten\n",
        "wispd reverts nothing during the turn"
    );
    assert_eq!(
        std::fs::read_to_string(repo.join("README.md")).unwrap(),
        "hello\n",
        "the user's checkout is untouched"
    );
    assert_eq!(run.policy, AgentPolicy::NoWrite);
    host.server.stop().await;
}

#[tokio::test]
async fn a_new_start_replaces_the_coordinator_only_once_it_stops_running() {
    let script = vec![
        init("coordinator-1"),
        Step::AwaitFollowUp,
        end_turn("Done."),
    ];
    let host = Host::start(temp_dir(), fake(script));
    let mut client = host.client().await;
    let project = create(&mut client, project_params(host.dir.path())).await;
    subscribe(&mut client, project.id, 0).await;

    let first = client
        .call::<ProjectStart>(start_params(project.id, "Plan."))
        .await
        .unwrap()
        .run;
    let refused = client
        .call::<ProjectStart>(start_params(project.id, "Start over."))
        .await
        .unwrap_err();
    assert_eq!(
        kind(&refused),
        ErrorKind::IdConflict,
        "one live coordinator"
    );

    client
        .call::<AgentSend>(send_params(first.id, TurnId::generate(), "Wrap up."))
        .await
        .unwrap();
    until(&mut client, updated_to(AgentStatus::Completed)).await;
    // Once it stops, even with a session that might never resume, a new start replaces it.
    let second = client
        .call::<ProjectStart>(start_params(project.id, "Start over."))
        .await
        .unwrap()
        .run;
    let projects = client
        .call::<ProjectList>(ProjectListParams {})
        .await
        .unwrap()
        .projects;
    assert_eq!(projects[0].coordinator, Some(second.id));
    // The replaced one stays stopped, so the project's worktree has one coordinator.
    let refused = client
        .call::<AgentSend>(send_params(first.id, TurnId::generate(), "Still there?"))
        .await
        .unwrap_err();
    assert_eq!(kind(&refused), ErrorKind::RunNotResumable);
    host.server.stop().await;
}

#[tokio::test]
async fn the_users_edits_and_commits_during_a_turn_never_stop_it() {
    let script = vec![
        init("coordinator-1"),
        Step::AwaitFollowUp,
        end_turn("Done."),
    ];
    let host = Host::start(temp_dir(), fake(script));
    let mut client = host.client().await;
    let project = create(&mut client, project_params(host.dir.path())).await;
    let repo = PathBuf::from(&project.repo_path);
    let worktree = worktree(&host, project.id);
    subscribe(&mut client, project.id, 0).await;

    let run = client
        .call::<ProjectStart>(start_params(project.id, "Plan."))
        .await
        .unwrap()
        .run;
    // While its turn runs: an editor save, a commit that moves HEAD, and stray files.
    std::fs::write(repo.join("README.md"), "edited\n").unwrap();
    git(&repo, &["commit", "-qam", "Edit the README."]);
    std::fs::write(repo.join("notes.txt"), "draft\n").unwrap();
    std::fs::write(repo.join(".DS_Store"), "\0").unwrap();
    client
        .call::<AgentSend>(send_params(run.id, TurnId::generate(), "Go on."))
        .await
        .unwrap();
    let events = until(&mut client, finished).await;
    assert!(
        matches!(
            outcomes(&events).as_slice(),
            [AgentOutcome::Completed { .. }]
        ),
        "{events:#?}"
    );

    // Its next CLI process reads the new commit.
    client
        .call::<AgentSend>(send_params(run.id, TurnId::generate(), "Look again."))
        .await
        .unwrap();
    assert_eq!(head(&worktree), head(&repo));
    assert_eq!(
        std::fs::read_to_string(worktree.join("README.md")).unwrap(),
        "edited\n"
    );
    assert!(!worktree.join("notes.txt").exists());
    host.server.stop().await;
}

/// Workers on one script, and each coordinator launch on the next of its own, keeping every
/// request.
struct Roles {
    worker: FakeBackend,
    coordinator: Mutex<Vec<FakeBackend>>,
    seen: Arc<Mutex<Vec<RunRequest>>>,
}

impl Backend for Roles {
    fn name(&self) -> &'static str {
        self.worker.name()
    }

    fn capabilities(&self) -> Capabilities {
        self.worker.capabilities()
    }

    fn start(&self, request: RunRequest) -> Result<Started, StartError> {
        self.seen.lock().unwrap().push(request.clone());
        if request.policy == ToolPolicy::NoWrite {
            self.coordinator.lock().unwrap().remove(0).start(request)
        } else {
            self.worker.start(request)
        }
    }
}

/// RYA-42: two runs the coordinator started finish during its turn; once that turn ends, and with
/// no client connected, wispd wakes it with one turn that names both.
#[tokio::test]
async fn runs_finishing_during_a_coordinator_turn_wake_it_once_with_no_client_connected() {
    let seen = Arc::new(Mutex::new(Vec::new()));
    let mut backends = BackendRegistry::new();
    backends.register(
        Provider::Anthropic,
        Arc::new(Roles {
            worker: fake_backend(vec![init("worker-1"), end_turn("Added it.")]),
            coordinator: Mutex::new(vec![
                fake_backend(vec![
                    init("coordinator-1"),
                    Step::AwaitFollowUp,
                    end_turn("Planned."),
                ]),
                fake_backend(vec![init("coordinator-1"), end_turn("Reviewed.")]),
            ]),
            seen: Arc::clone(&seen),
        }),
    );
    let host = Host::start(temp_dir(), backends);
    let mut client = host.client().await;
    let project = create(&mut client, project_params(host.dir.path())).await;
    subscribe(&mut client, project.id, 0).await;
    let coordinator = client
        .call::<ProjectStart>(start_params(project.id, "Plan."))
        .await
        .unwrap()
        .run;

    // As its spawn_agent would start them.
    let thread = coordinator.coordinator_thread;
    let mut workers = Vec::new();
    for task in ["Add a README.", "Add a license."] {
        let params = AgentStartParams {
            coordinator_thread: thread,
            ..crate::agents::start_params(project.id, task)
        };
        workers.push(client.call::<AgentStart>(params).await.unwrap().run.id);
    }
    let mut left = workers.len();
    until(&mut client, |event| {
        if matches!(&event.event, WispEvent::AgentUpdated { run_id, state }
            if workers.contains(run_id) && state.status == AgentStatus::Completed)
        {
            left -= 1;
        }
        left == 0
    })
    .await;
    let coordinator_launches = || {
        let seen = seen.lock().unwrap();
        seen.iter()
            .filter(|request| request.policy == ToolPolicy::NoWrite)
            .cloned()
            .collect::<Vec<_>>()
    };
    // Past wake-ups' 2 s batch: a turn in progress still holds them.
    tokio::time::sleep(Duration::from_secs(3)).await;
    assert_eq!(coordinator_launches().len(), 1, "no wake-up during a turn");

    // The user's message ends the coordinator's turn; then nobody is watching.
    client
        .call::<AgentSend>(send_params(coordinator.id, TurnId::generate(), "Go on."))
        .await
        .unwrap();
    drop(client);
    let deadline = Instant::now() + PATIENCE;
    while coordinator_launches().len() < 2 {
        assert!(Instant::now() < deadline, "the coordinator was never woken");
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    let wake = coordinator_launches()[1].clone();
    assert!(wake.resume.is_some(), "a wake-up resumes the session");
    for worker in &workers {
        assert!(wake.prompt.contains(&worker.to_string()), "{}", wake.prompt);
    }
    assert!(
        wake.prompt.contains("completed, saying: Added it."),
        "{}",
        wake.prompt
    );

    let mut client = host.client().await;
    subscribe(&mut client, project.id, 0).await;
    let events = until(&mut client, |event| {
        matches!(&event.event, WispEvent::AgentOutput { items, .. } if items.iter().any(|item|
            matches!(item, AgentOutputItem::TurnStarted { wake: true, .. })))
    })
    .await;
    let Some(WispEvent::AgentOutput { run_id, items }) = events.last().map(|e| &e.event) else {
        unreachable!();
    };
    assert_eq!(*run_id, coordinator.id);
    assert!(items.contains(&AgentOutputItem::TurnStarted {
        turn_id: wake.turn_id,
        text: Some(wake.prompt.clone()),
        wake: true,
    }));
    host.server.stop().await;
}
