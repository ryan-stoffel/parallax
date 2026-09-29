//! A project's coordinator chat end to end (RYA-41, decision 0024): `project/start` against an
//! in-process wispd whose backend is the fake CLI, in a real git repository.

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use uuid::Uuid;
use wisp_protocol::methods::{AgentEvents, AgentSend, ProjectList, ProjectStart};
use wisp_protocol::{
    AccountChoice, AgentEventsParams, AgentFailureKind, AgentOutcome, AgentOutputItem, AgentPolicy,
    AgentStatus, CoordinatorThreadId, ErrorKind, ProjectId, ProjectListParams, ProjectStartParams,
    Provider, RunId, TurnId, WispEvent,
};
use wispd::backend::fake::{FakeBackend, Step};
use wispd::backend::{Backend, Capabilities, RunRequest, StartError, Started, ToolPolicy};
use wispd::routing::BackendRegistry;

use crate::agents::{
    Host, create, end_turn, fake, fake_backend, git, init, items, outcomes, project_params,
    send_params, subscribe, text, until, updated_to,
};
use crate::support::{kind, temp_dir};

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

#[tokio::test]
async fn a_coordinator_runs_no_write_in_the_repository_and_resumes_after_a_restart() {
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
    let before = head(&repo);
    // The user's own uncommitted work, there before the turn, is not the coordinator's change.
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
    let another = ProjectStartParams {
        run_id: RunId::generate(),
        ..params.clone()
    };
    let refused = client.call::<ProjectStart>(another).await.unwrap_err();
    assert_eq!(kind(&refused), ErrorKind::IdConflict, "one per project");
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
    assert_eq!(first.cwd, repo, "it runs in the repository itself");
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
        std::fs::read_to_string(repo.join("README.md")).unwrap(),
        "rewritten\n",
        "wispd reverts nothing"
    );
    assert_eq!(run.policy, AgentPolicy::NoWrite);
    host.server.stop().await;
}

#[tokio::test]
async fn a_coordinator_that_never_reported_a_session_can_be_replaced() {
    let host = Host::start(temp_dir(), fake(vec![Step::Exit(1)]));
    let mut client = host.client().await;
    let project = create(&mut client, project_params(host.dir.path())).await;
    subscribe(&mut client, project.id, 0).await;

    client
        .call::<ProjectStart>(start_params(project.id, "Plan."))
        .await
        .unwrap();
    until(&mut client, updated_to(AgentStatus::Failed)).await;
    let again = client
        .call::<ProjectStart>(start_params(project.id, "Plan again."))
        .await;
    assert!(
        again.is_ok(),
        "a failed start leaves no session to resume: {again:?}"
    );
    host.server.stop().await;
}
