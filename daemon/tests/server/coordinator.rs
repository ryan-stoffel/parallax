//! A project's coordinator chat end to end (PLX-41, decision 0024): `project/start` against an
//! in-process plxd whose backend is the fake CLI, in a real git repository. The coordinator runs
//! in a detached worktree at the integration branch's tip, in the project's permission mode
//! (0042).

use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use parallax_protocol::jsonrpc::ErrorObject;
use parallax_protocol::methods::{
    AgentEvents, AgentList, AgentSend, AgentStart, EventsSubscribe, HostHealth, ProjectDelete,
    ProjectList, ProjectStart, ProjectUpdate,
};
use parallax_protocol::{
    AccountChoice, AgentDelivery, AgentEventsParams, AgentListParams, AgentOutputItem,
    AgentPermission, AgentRun, AgentSendParams, AgentStartParams, AgentStatus, ErrorKind,
    EventsEventParams, EventsSubscribeParams, HostHealthParams, ParallaxEvent, ProjectCreateParams,
    ProjectDeleteParams, ProjectDeleteResult, ProjectId, ProjectListParams, ProjectPermission,
    ProjectStartParams, ProjectUpdateParams, Provider, RunId, TurnId,
};
use plxd::backend::fake::{FakeBackend, Step};
use plxd::backend::{Backend, Capabilities, RunRequest, StartError, Started, ToolPolicy};
use plxd::routing::BackendRegistry;

use crate::agents::{
    Conn, Host, create, end_turn, fake, fake_backend, git, init, items, project_params,
    send_params, subscribe, text, until, updated_to,
};
use crate::support::{PATIENCE, eventually, kind, project_update, temp_dir};

/// The fake backend, keeping every request it is asked to start.
struct Recording {
    fake: FakeBackend,
    seen: Arc<Mutex<Vec<RunRequest>>>,
}

impl Backend for Recording {
    fn name(&self) -> &str {
        self.fake.name()
    }

    fn capabilities(&self) -> Capabilities {
        self.fake.capabilities()
    }

    fn permissions(&self) -> &[AgentPermission] {
        self.fake.permissions()
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

pub(crate) fn start_params(project: ProjectId, prompt: &str) -> ProjectStartParams {
    ProjectStartParams {
        project,
        run_id: RunId::generate(),
        prompt: prompt.to_owned(),
        account: Some(AccountChoice::Subscription {
            backend: "fake".to_owned(),
        }),
        model: None,
        effort: None,
        permission: None,
        images: Vec::new(),
        approvals: false,
    }
}

/// Where `host` keeps the coordinator's worktree for `project` (0042).
fn coordinator_worktree(host: &Host, project: ProjectId) -> PathBuf {
    host.dir
        .path()
        .join("coordinators")
        .join(project.to_string())
}

/// PLX-397: what a coordinator writes stays in its own worktree. Neither the user's checkout nor
/// the integration branch sees it, and its next CLI process starts from a clean copy of the tip.
#[tokio::test]
async fn a_coordinators_edit_never_reaches_the_checkout_or_the_integration_branch() {
    let seen = Arc::new(Mutex::new(Vec::new()));
    let write = |path: &str| Step::WriteFile {
        path: path.to_owned(),
        content: "the coordinator's\n".to_owned(),
    };
    let script = vec![
        init("coordinator-1"),
        write("README.md"),
        write("stray.txt"),
        end_turn("Edited."),
    ];
    let host = Host::start(temp_dir(), recording(script, &seen));
    let mut client = host.client().await;
    let project = create(&mut client, project_params(host.dir.path())).await;
    let repo = PathBuf::from(&project.repo_path);
    let integration = host
        .dir
        .path()
        .join("integration")
        .join(project.id.to_string());
    let tip = git(&repo, &["rev-parse", "parallax/app"]);
    subscribe(&mut client, project.id, 0).await;

    let run = client
        .call::<ProjectStart>(start_params(project.id, "Fix the README yourself."))
        .await
        .unwrap()
        .run;
    until(&mut client, updated_to(AgentStatus::Completed)).await;
    let worktree = coordinator_worktree(&host, project.id);
    assert_eq!(seen.lock().unwrap()[0].cwd, worktree);
    assert_eq!(git(&worktree, &["rev-parse", "HEAD"]), tip, "at the tip");
    assert_eq!(git(&worktree, &["branch", "--show-current"]), "");
    assert_eq!(
        std::fs::read_to_string(worktree.join("README.md")).unwrap(),
        "the coordinator's\n",
        "the edit is in its worktree"
    );
    for checkout in [&repo, &integration] {
        assert_eq!(
            std::fs::read_to_string(checkout.join("README.md")).unwrap(),
            "hello\n"
        );
        assert!(!checkout.join("stray.txt").exists());
        assert_eq!(git(checkout, &["status", "--porcelain"]), "");
    }
    assert_eq!(git(&repo, &["rev-parse", "parallax/app"]), tip);
    assert_eq!(git(&repo, &["rev-parse", "main"]), tip);

    // The next process, one that writes nothing, starts from a clean copy of the tip.
    let host = host
        .restart(recording(
            vec![init("coordinator-1"), end_turn("Read.")],
            &seen,
        ))
        .await;
    let mut client = host.client().await;
    subscribe(&mut client, project.id, 0).await;
    client
        .call::<AgentSend>(send_params(run.id, TurnId::generate(), "Go on."))
        .await
        .unwrap();
    until(&mut client, updated_to(AgentStatus::Completed)).await;
    assert_eq!(seen.lock().unwrap().len(), 2);
    assert_eq!(
        std::fs::read_to_string(worktree.join("README.md")).unwrap(),
        "hello\n"
    );
    assert!(!worktree.join("stray.txt").exists());
    assert_eq!(git(&repo, &["rev-parse", "parallax/app"]), tip);
    host.server.stop().await;
}

/// 0060: a coordinator replaced while its session is idle has that session ended, so two
/// coordinator CLIs never share the Project's worktree.
#[cfg(unix)]
#[tokio::test]
async fn a_replaced_coordinators_idle_session_ends() {
    let script = vec![
        init("coordinator-1"),
        Step::EchoPid,
        Step::EndTurn { result: None },
        Step::AwaitFollowUp,
        end_turn("Done."),
    ];
    let host = Host::start(temp_dir(), fake(script));
    let (mut client, project) = host.project_client().await;
    client
        .call::<ProjectStart>(start_params(project.id, "Plan."))
        .await
        .unwrap();
    let events = until(&mut client, updated_to(AgentStatus::Completed)).await;
    let pid: i32 = items(&events)
        .iter()
        .find_map(|item| match item {
            AgentOutputItem::Text { text, .. } => text.parse().ok(),
            _ => None,
        })
        .expect("the CLI printed its pid");
    let pid = rustix::process::Pid::from_raw(pid).unwrap();
    assert!(
        rustix::process::test_kill_process(pid).is_ok(),
        "idle, still up"
    );

    client
        .call::<ProjectStart>(start_params(project.id, "Start over."))
        .await
        .unwrap();
    let deadline = std::time::Instant::now() + PATIENCE;
    while rustix::process::test_kill_process(pid).is_ok() {
        assert!(
            std::time::Instant::now() < deadline,
            "the old coordinator still runs"
        );
        tokio::time::sleep(std::time::Duration::from_millis(20)).await;
    }
    host.server.stop().await;
}

/// Starts `project`'s coordinator on "Plan.".
pub(crate) async fn plan(client: &mut Conn, project: ProjectId) -> AgentRun {
    client
        .call::<ProjectStart>(start_params(project, "Plan."))
        .await
        .unwrap()
        .run
}

/// Workers on one script, and each coordinator launch on the next of its own, keeping every
/// request.
struct Roles {
    worker: FakeBackend,
    coordinator: Mutex<Vec<FakeBackend>>,
    seen: Arc<Mutex<Vec<RunRequest>>>,
    permissions: &'static [AgentPermission],
}

impl Backend for Roles {
    fn name(&self) -> &str {
        self.worker.name()
    }

    fn capabilities(&self) -> Capabilities {
        self.worker.capabilities()
    }

    fn permissions(&self) -> &'static [AgentPermission] {
        self.permissions
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

/// Workers on `worker`, and each coordinator launch on the next of `coordinator`, in Auto or
/// Bypass.
pub(crate) fn roles(
    worker: Vec<Step>,
    coordinator: Vec<Vec<Step>>,
    seen: &Arc<Mutex<Vec<RunRequest>>>,
) -> BackendRegistry {
    roles_mapping(
        worker,
        coordinator,
        seen,
        &[AgentPermission::Auto, AgentPermission::Bypass],
    )
}

/// [`roles`], mapping only `permissions`.
pub(crate) fn roles_mapping(
    worker: Vec<Step>,
    coordinator: Vec<Vec<Step>>,
    seen: &Arc<Mutex<Vec<RunRequest>>>,
    permissions: &'static [AgentPermission],
) -> BackendRegistry {
    let mut backends = BackendRegistry::new();
    backends.register(
        Provider::Anthropic,
        Arc::new(Roles {
            worker: fake_backend(worker),
            coordinator: Mutex::new(coordinator.into_iter().map(fake_backend).collect()),
            seen: Arc::clone(seen),
            permissions,
        }),
    );
    backends
}

/// Every coordinator launch `seen` so far.
pub(crate) fn coordinator_launches(seen: &Mutex<Vec<RunRequest>>) -> Vec<RunRequest> {
    seen.lock()
        .unwrap()
        .iter()
        .filter(|request| request.policy == ToolPolicy::NoWrite)
        .cloned()
        .collect()
}

/// The `n`th coordinator launch, once it happens.
pub(crate) async fn nth_launch(seen: &Mutex<Vec<RunRequest>>, n: usize) -> RunRequest {
    let deadline = Instant::now() + PATIENCE;
    loop {
        if let Some(launch) = coordinator_launches(seen).get(n) {
            return launch.clone();
        }
        assert!(Instant::now() < deadline, "the coordinator was never woken");
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
}

/// A worker `project`'s coordinator starts through its tools, as `spawn_agent` would.
pub(crate) async fn spawn(client: &mut Conn, coordinator: &AgentRun, task: &str) -> RunId {
    let params = AgentStartParams {
        coordinator_thread: coordinator.coordinator_thread,
        ..crate::agents::start_params(coordinator.project, task)
    };
    client.call::<AgentStart>(params).await.unwrap().run.id
}

/// PLX-394 (0042): the coordinator and the runs it spawns run in the Project's mode, whatever
/// they ask for, and a mode `project/update` changes applies from each run's next CLI process.
#[tokio::test]
async fn a_projects_runs_run_in_its_mode_and_a_new_mode_applies_from_their_next_process() {
    let seen = Arc::new(Mutex::new(Vec::new()));
    // Workers never finish, so no wake-up takes a coordinator script.
    let backends = roles(
        vec![init("worker-1"), Step::AwaitFollowUp],
        vec![
            vec![init("coordinator-1"), end_turn("Planned.")],
            vec![init("coordinator-1"), end_turn("Planned again.")],
        ],
        &seen,
    );
    let host = Host::start(temp_dir(), backends);
    let mut client = host.client().await;
    let project = create(
        &mut client,
        ProjectCreateParams {
            permission: Some(ProjectPermission::Bypass),
            ..project_params(host.dir.path())
        },
    )
    .await;
    assert_eq!(project.permission, Some(ProjectPermission::Bypass));
    subscribe(&mut client, project.id, 0).await;
    let coordinator = client
        .call::<ProjectStart>(ProjectStartParams {
            permission: Some(AgentPermission::Plan),
            ..start_params(project.id, "Plan.")
        })
        .await
        .unwrap()
        .run;
    assert_eq!(coordinator.permission, Some(AgentPermission::Bypass));
    until(&mut client, updated_to(AgentStatus::Completed)).await;
    assert_eq!(
        nth_launch(&seen, 0).await.permission,
        Some(AgentPermission::Bypass)
    );
    let asked = client
        .call::<AgentStart>(AgentStartParams {
            coordinator_thread: coordinator.coordinator_thread,
            permission: Some(AgentPermission::Edit),
            ..crate::agents::start_params(project.id, "Fix a typo.")
        })
        .await
        .unwrap()
        .run
        .id;

    let updated = client
        .call::<ProjectUpdate>(ProjectUpdateParams {
            permission: Some(ProjectPermission::Auto),
            ..project_update(project.id)
        })
        .await
        .unwrap()
        .project;
    assert_eq!(updated.permission, Some(ProjectPermission::Auto));
    client
        .call::<AgentSend>(AgentSendParams {
            permission: Some(AgentPermission::Plan),
            ..send_params(coordinator.id, TurnId::generate(), "Plan more.")
        })
        .await
        .unwrap();
    assert_eq!(
        nth_launch(&seen, 1).await.permission,
        Some(AgentPermission::Auto)
    );
    let after = spawn(&mut client, &coordinator, "Add a license.").await;

    let launched = |run: RunId| {
        seen.lock()
            .unwrap()
            .iter()
            .find(|request| request.run_id == run)
            .map(|request| request.permission)
    };
    assert_eq!(launched(asked), Some(Some(AgentPermission::Bypass)));
    assert_eq!(launched(after), Some(Some(AgentPermission::Auto)));
    host.server.stop().await;
}

/// PLX-222 (0031): a coordinator keeps `approvals` when it resumes. One started without them, as
/// an older app starts it, asks too (PLX-473), as every child does, since the inbox answers (0042).
#[tokio::test]
async fn approvals_last_through_a_resume_and_every_child_has_them() {
    let seen = Arc::new(Mutex::new(Vec::new()));
    // Workers never finish, so no wake-up takes a coordinator script.
    let backends = roles(
        vec![init("worker-1"), Step::AwaitFollowUp],
        vec![
            vec![init("coordinator-1"), end_turn("Planned.")],
            vec![init("coordinator-1"), end_turn("Planned again.")],
            vec![init("coordinator-2"), end_turn("Planned anew.")],
        ],
        &seen,
    );
    let host = Host::start(temp_dir(), backends);
    let (mut client, project) = host.project_client().await;
    let answering = client
        .call::<ProjectStart>(ProjectStartParams {
            approvals: true,
            ..start_params(project.id, "Plan.")
        })
        .await
        .unwrap()
        .run;
    until(&mut client, updated_to(AgentStatus::Completed)).await;
    let subagent = spawn(&mut client, &answering, "Add a README.").await;
    client
        .call::<AgentSend>(send_params(answering.id, TurnId::generate(), "Plan more."))
        .await
        .unwrap();
    assert!(nth_launch(&seen, 0).await.approvals);
    assert!(nth_launch(&seen, 1).await.approvals, "a resume keeps them");
    until(&mut client, updated_to(AgentStatus::Completed)).await;

    // Starting over, from a client that doesn't answer.
    let quiet = client
        .call::<ProjectStart>(start_params(project.id, "Start over."))
        .await
        .unwrap()
        .run;
    assert!(nth_launch(&seen, 2).await.approvals);
    until(&mut client, updated_to(AgentStatus::Completed)).await;
    let quiet_subagent = spawn(&mut client, &quiet, "Add a license.").await;

    let launched = |run: RunId| {
        seen.lock()
            .unwrap()
            .iter()
            .find(|request| request.run_id == run)
            .map(|request| request.approvals)
    };
    assert_eq!(launched(subagent), Some(true));
    assert_eq!(launched(quiet_subagent), Some(true));
    host.server.stop().await;
}

/// PLX-42: two runs the coordinator started finish during its turn; once that turn ends, and with
/// no client connected, plxd wakes it with one turn that names both.
#[tokio::test]
async fn runs_finishing_during_a_coordinator_turn_wake_it_once_with_no_client_connected() {
    let seen = Arc::new(Mutex::new(Vec::new()));
    let backends = roles(
        vec![init("worker-1"), end_turn("Added it.")],
        vec![
            vec![
                init("coordinator-1"),
                Step::AwaitFollowUp,
                end_turn("Planned."),
            ],
            vec![init("coordinator-1"), end_turn("Reviewed.")],
        ],
        &seen,
    );
    let host = Host::start(temp_dir(), backends);
    let (mut client, project) = host.project_client().await;
    let coordinator = plan(&mut client, project.id).await;

    let mut workers = Vec::new();
    for task in ["Add a README.", "Add a license."] {
        workers.push(spawn(&mut client, &coordinator, task).await);
    }
    let mut left = workers.len();
    until(&mut client, |event| {
        if matches!(&event.event, ParallaxEvent::AgentUpdated { run_id, state }
            if workers.contains(run_id) && state.status == AgentStatus::Completed)
        {
            left -= 1;
        }
        left == 0
    })
    .await;
    // Past wake-ups' 2 s batch: a turn in progress still holds them.
    tokio::time::sleep(Duration::from_secs(3)).await;
    assert_eq!(
        coordinator_launches(&seen).len(),
        1,
        "no wake-up during a turn"
    );

    // The user's message, steered into the coordinator's turn, ends it; then nobody is watching.
    client
        .call::<AgentSend>(AgentSendParams {
            delivery: Some(AgentDelivery::Steer),
            ..send_params(coordinator.id, TurnId::generate(), "Go on.")
        })
        .await
        .unwrap();
    drop(client);
    let wake = nth_launch(&seen, 1).await;
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
        matches!(&event.event, ParallaxEvent::AgentOutput { items, .. } if items.iter().any(|item|
            matches!(item, AgentOutputItem::TurnStarted { wake: true, .. })))
    })
    .await;
    let Some(ParallaxEvent::AgentOutput { run_id, items, .. }) = events.last().map(|e| &e.event)
    else {
        unreachable!();
    };
    assert_eq!(*run_id, coordinator.id);
    assert!(items.contains(&AgentOutputItem::TurnStarted {
        turn_id: wake.turn_id,
        text: Some(wake.prompt.clone()),
        wake: true,
        from: None,
        images: Vec::new(),
        threads: Vec::new(),
    }));
    host.server.stop().await;
}

fn subscribe_host(after: u64) -> EventsSubscribeParams {
    EventsSubscribeParams {
        after,
        project: None,
        run: None,
        shell: false,
    }
}

async fn delete(client: &mut Conn, project: ProjectId) -> Result<ProjectDeleteResult, ErrorObject> {
    client
        .call::<ProjectDelete>(ProjectDeleteParams { project })
        .await
}

async fn runs_of(client: &mut Conn, project: ProjectId) -> Vec<AgentRun> {
    let params = AgentListParams {
        project: Some(project),
    };
    client.call::<AgentList>(params).await.unwrap().runs
}

fn deleted(project: ProjectId) -> impl FnMut(&EventsEventParams) -> bool {
    move |event| matches!(&event.event, ParallaxEvent::ProjectDeleted { project: id } if *id == project)
}

/// PLX-338: deleting a project stops its coordinator and the subagent it started, and removes
/// their runs, events, worktree, and branch, its context folder, and the project itself, which
/// `project.deleted` tells every client, then and on replay.
#[tokio::test]
async fn deleting_a_project_stops_its_agents_and_removes_everything() {
    let seen = Arc::new(Mutex::new(Vec::new()));
    let backends = roles(
        vec![init("worker-1"), text("Working"), Step::Hang],
        vec![vec![init("coordinator-1"), Step::Hang]],
        &seen,
    );
    let host = Host::start(temp_dir(), backends);
    let mut client = host.client().await;
    let project = create(&mut client, project_params(host.dir.path())).await;
    let repo = PathBuf::from(&project.repo_path);
    let context = host.dir.path().join("context").join(project.id.to_string());
    assert!(context.is_dir());
    client
        .call::<EventsSubscribe>(subscribe_host(0))
        .await
        .unwrap();
    subscribe(&mut client, project.id, 0).await;
    let coordinator = plan(&mut client, project.id).await;
    let worker = spawn(&mut client, &coordinator, "Build it.").await;
    let mut running = vec![coordinator.id, worker];
    until(&mut client, |event| {
        if let ParallaxEvent::AgentUpdated { run_id, state } = &event.event
            && state.status == AgentStatus::Running
        {
            running.retain(|run| run != run_id);
        }
        running.is_empty()
    })
    .await;
    let run = runs_of(&mut client, project.id)
        .await
        .into_iter()
        .find(|run| run.id == worker)
        .unwrap();
    let worktree = PathBuf::from(run.worktree_path.unwrap());
    let branch = run.branch.unwrap();
    assert!(worktree.is_dir());

    delete(&mut client, project.id).await.unwrap();
    until(&mut client, deleted(project.id)).await;
    let health = client
        .call::<HostHealth>(HostHealthParams {})
        .await
        .unwrap();
    assert_eq!(health.running_agents, 0, "both agents were stopped");
    let projects = client
        .call::<ProjectList>(ProjectListParams {})
        .await
        .unwrap()
        .projects;
    assert!(projects.is_empty());
    assert!(runs_of(&mut client, project.id).await.is_empty());
    for run_id in [coordinator.id, worker] {
        let events = client
            .call::<AgentEvents>(AgentEventsParams {
                before: None,
                run_id,
                after: 0,
                limit: None,
            })
            .await
            .unwrap_err();
        assert_eq!(kind(&events), ErrorKind::RunNotFound);
    }
    // The cleanup effects run once the deletes commit (0059).
    eventually(
        "the worktrees, the branch, and the project's notes are removed",
        || {
            !worktree.exists()
                && git(&repo, &["branch", "--list", &branch]).is_empty()
                && !context.exists()
                && !coordinator_worktree(&host, project.id).exists()
        },
    )
    .await;
    assert!(repo.join("README.md").is_file(), "the repository stays");

    let mut replay = host.client().await;
    replay
        .call::<EventsSubscribe>(subscribe_host(0))
        .await
        .unwrap();
    until(&mut replay, deleted(project.id)).await;

    let again = delete(&mut client, project.id).await.unwrap_err();
    assert_eq!(kind(&again), ErrorKind::ProjectNotFound);
    host.server.stop().await;
}
