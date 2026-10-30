//! An orchestrator chat end to end (PLX-41, decision 0024): `orchestrator/start` against an
//! in-process plxd whose backend is the fake CLI, in a real git repository. The orchestrator runs
//! in a detached worktree at the integration branch's tip, in the orchestrator's permission mode
//! (0042).

use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use parallax_protocol::jsonrpc::ErrorObject;
use parallax_protocol::methods::{
    AgentEvents, AgentList, AgentSend, AgentStart, EventsSubscribe, HostHealth, OrchestratorDelete,
    OrchestratorList, OrchestratorStart, OrchestratorUpdate,
};
use parallax_protocol::{
    AccountChoice, AgentDelivery, AgentEventsParams, AgentListParams, AgentOutputItem,
    AgentPermission, AgentRun, AgentSendParams, AgentStartParams, AgentStatus, ErrorKind,
    EventsEventParams, EventsSubscribeParams, HostHealthParams, OrchestratorCreateParams,
    OrchestratorDeleteParams, OrchestratorDeleteResult, OrchestratorListParams,
    OrchestratorPermission, OrchestratorStartParams, OrchestratorUpdateParams, ParallaxEvent,
    Provider, RunId, ScopeId, TurnId,
};
use plxd::backend::fake::{FakeBackend, Step};
use plxd::backend::{Backend, Capabilities, RunRequest, StartError, Started, ToolPolicy};
use plxd::routing::BackendRegistry;

use crate::agents::{
    Conn, Host, create, end_turn, fake, fake_backend, git, init, items, orchestrator_params,
    send_params, subscribe, text, until, updated_to,
};
use crate::support::{PATIENCE, eventually, kind, orchestrator_update, temp_dir};

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

pub(crate) fn start_params(orchestrator: ScopeId, prompt: &str) -> OrchestratorStartParams {
    OrchestratorStartParams {
        orchestrator,
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

/// Where `host` keeps the orchestrator's worktree for `orchestrator` (0042).
fn orchestrator_worktree(host: &Host, orchestrator: ScopeId) -> PathBuf {
    host.dir
        .path()
        .join("orchestrators")
        .join(orchestrator.to_string())
}

/// PLX-397: what an orchestrator writes stays in its own worktree. Neither the user's checkout nor
/// the integration branch sees it, and its next CLI process starts from a clean copy of the tip.
#[tokio::test]
async fn an_orchestrators_edit_never_reaches_the_checkout_or_the_integration_branch() {
    let seen = Arc::new(Mutex::new(Vec::new()));
    let write = |path: &str| Step::WriteFile {
        path: path.to_owned(),
        content: "the orchestrator's\n".to_owned(),
    };
    let script = vec![
        init("orchestrator-1"),
        write("README.md"),
        write("stray.txt"),
        end_turn("Edited."),
    ];
    let host = Host::start(temp_dir(), recording(script, &seen));
    let mut client = host.client().await;
    let orchestrator = create(&mut client, orchestrator_params(host.dir.path())).await;
    let repo = PathBuf::from(&orchestrator.repo_path);
    let integration = host
        .dir
        .path()
        .join("integration")
        .join(orchestrator.id.to_string());
    let tip = git(&repo, &["rev-parse", "parallax/app"]);
    subscribe(&mut client, orchestrator.id, 0).await;

    let run = client
        .call::<OrchestratorStart>(start_params(orchestrator.id, "Fix the README yourself."))
        .await
        .unwrap()
        .run;
    until(&mut client, updated_to(AgentStatus::Completed)).await;
    let worktree = orchestrator_worktree(&host, orchestrator.id);
    assert_eq!(seen.lock().unwrap()[0].cwd, worktree);
    assert_eq!(git(&worktree, &["rev-parse", "HEAD"]), tip, "at the tip");
    assert_eq!(git(&worktree, &["branch", "--show-current"]), "");
    assert_eq!(
        std::fs::read_to_string(worktree.join("README.md")).unwrap(),
        "the orchestrator's\n",
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
            vec![init("orchestrator-1"), end_turn("Read.")],
            &seen,
        ))
        .await;
    let mut client = host.client().await;
    subscribe(&mut client, orchestrator.id, 0).await;
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

/// 0060: an orchestrator replaced while its session is idle has that session ended, so two
/// orchestrator CLIs never share the orchestrator's worktree.
#[cfg(unix)]
#[tokio::test]
async fn a_replaced_orchestrators_idle_session_ends() {
    let script = vec![
        init("orchestrator-1"),
        Step::EchoPid,
        Step::EndTurn { result: None },
        Step::AwaitFollowUp,
        end_turn("Done."),
    ];
    let host = Host::start(temp_dir(), fake(script));
    let (mut client, orchestrator) = host.orchestrator_client().await;
    client
        .call::<OrchestratorStart>(start_params(orchestrator.id, "Plan."))
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
        .call::<OrchestratorStart>(start_params(orchestrator.id, "Start over."))
        .await
        .unwrap();
    let deadline = std::time::Instant::now() + PATIENCE;
    while rustix::process::test_kill_process(pid).is_ok() {
        assert!(
            std::time::Instant::now() < deadline,
            "the old orchestrator still runs"
        );
        tokio::time::sleep(std::time::Duration::from_millis(20)).await;
    }
    host.server.stop().await;
}

/// Starts `orchestrator`'s orchestrator on "Plan.".
pub(crate) async fn plan(client: &mut Conn, orchestrator: ScopeId) -> AgentRun {
    client
        .call::<OrchestratorStart>(start_params(orchestrator, "Plan."))
        .await
        .unwrap()
        .run
}

/// Workers on one script, and each orchestrator launch on the next of its own, keeping every
/// request.
struct Roles {
    worker: FakeBackend,
    orchestrator_run: Mutex<Vec<FakeBackend>>,
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
            self.orchestrator_run
                .lock()
                .unwrap()
                .remove(0)
                .start(request)
        } else {
            self.worker.start(request)
        }
    }
}

/// Workers on `worker`, and each orchestrator launch on the next of `orchestrator`, in Auto or
/// Bypass.
pub(crate) fn roles(
    worker: Vec<Step>,
    orchestrator_run: Vec<Vec<Step>>,
    seen: &Arc<Mutex<Vec<RunRequest>>>,
) -> BackendRegistry {
    roles_mapping(
        worker,
        orchestrator_run,
        seen,
        &[AgentPermission::Auto, AgentPermission::Bypass],
    )
}

/// [`roles`], mapping only `permissions`.
pub(crate) fn roles_mapping(
    worker: Vec<Step>,
    orchestrator_run: Vec<Vec<Step>>,
    seen: &Arc<Mutex<Vec<RunRequest>>>,
    permissions: &'static [AgentPermission],
) -> BackendRegistry {
    let mut backends = BackendRegistry::new();
    backends.register(
        Provider::Anthropic,
        Arc::new(Roles {
            worker: fake_backend(worker),
            orchestrator_run: Mutex::new(orchestrator_run.into_iter().map(fake_backend).collect()),
            seen: Arc::clone(seen),
            permissions,
        }),
    );
    backends
}

/// Every orchestrator launch `seen` so far.
pub(crate) fn orchestrator_launches(seen: &Mutex<Vec<RunRequest>>) -> Vec<RunRequest> {
    seen.lock()
        .unwrap()
        .iter()
        .filter(|request| request.policy == ToolPolicy::NoWrite)
        .cloned()
        .collect()
}

/// The `n`th orchestrator launch, once it happens.
pub(crate) async fn nth_launch(seen: &Mutex<Vec<RunRequest>>, n: usize) -> RunRequest {
    let deadline = Instant::now() + PATIENCE;
    loop {
        if let Some(launch) = orchestrator_launches(seen).get(n) {
            return launch.clone();
        }
        assert!(
            Instant::now() < deadline,
            "the orchestrator was never woken"
        );
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
}

/// A worker `orchestrator`'s orchestrator starts through its tools, as `spawn_agent` would.
pub(crate) async fn spawn(client: &mut Conn, orchestrator_run: &AgentRun, task: &str) -> RunId {
    let params = AgentStartParams {
        orchestrator_thread: orchestrator_run.orchestrator_thread,
        ..crate::agents::start_params(orchestrator_run.project, task)
    };
    client.call::<AgentStart>(params).await.unwrap().run.id
}

/// PLX-394 (0042): the orchestrator and the runs it spawns run in the orchestrator's mode, whatever
/// they ask for, and a mode `orchestrator/update` changes applies from each run's next CLI process.
#[tokio::test]
async fn an_orchestrators_runs_run_in_its_mode_and_a_new_mode_applies_from_their_next_process() {
    let seen = Arc::new(Mutex::new(Vec::new()));
    // Workers never finish, so no wake-up takes an orchestrator script.
    let backends = roles(
        vec![init("worker-1"), Step::AwaitFollowUp],
        vec![
            vec![init("orchestrator-1"), end_turn("Planned.")],
            vec![init("orchestrator-1"), end_turn("Planned again.")],
        ],
        &seen,
    );
    let host = Host::start(temp_dir(), backends);
    let mut client = host.client().await;
    let orchestrator = create(
        &mut client,
        OrchestratorCreateParams {
            permission: Some(OrchestratorPermission::Bypass),
            ..orchestrator_params(host.dir.path())
        },
    )
    .await;
    assert_eq!(
        orchestrator.permission,
        Some(OrchestratorPermission::Bypass)
    );
    subscribe(&mut client, orchestrator.id, 0).await;
    let orchestrator_run = client
        .call::<OrchestratorStart>(OrchestratorStartParams {
            permission: Some(AgentPermission::Plan),
            ..start_params(orchestrator.id, "Plan.")
        })
        .await
        .unwrap()
        .run;
    assert_eq!(orchestrator_run.permission, Some(AgentPermission::Bypass));
    until(&mut client, updated_to(AgentStatus::Completed)).await;
    assert_eq!(
        nth_launch(&seen, 0).await.permission,
        Some(AgentPermission::Bypass)
    );
    let asked = client
        .call::<AgentStart>(AgentStartParams {
            orchestrator_thread: orchestrator_run.orchestrator_thread,
            permission: Some(AgentPermission::Edit),
            ..crate::agents::start_params(orchestrator.id, "Fix a typo.")
        })
        .await
        .unwrap()
        .run
        .id;

    let updated = client
        .call::<OrchestratorUpdate>(OrchestratorUpdateParams {
            permission: Some(OrchestratorPermission::Auto),
            ..orchestrator_update(orchestrator.id)
        })
        .await
        .unwrap()
        .orchestrator;
    assert_eq!(updated.permission, Some(OrchestratorPermission::Auto));
    client
        .call::<AgentSend>(AgentSendParams {
            permission: Some(AgentPermission::Plan),
            ..send_params(orchestrator_run.id, TurnId::generate(), "Plan more.")
        })
        .await
        .unwrap();
    assert_eq!(
        nth_launch(&seen, 1).await.permission,
        Some(AgentPermission::Auto)
    );
    let after = spawn(&mut client, &orchestrator_run, "Add a license.").await;

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

/// PLX-222 (0031): an orchestrator keeps `approvals` when it resumes. One started without them, as
/// an older app starts it, asks too (PLX-473), as every child does, since the inbox answers (0042).
#[tokio::test]
async fn approvals_last_through_a_resume_and_every_child_has_them() {
    let seen = Arc::new(Mutex::new(Vec::new()));
    // Workers never finish, so no wake-up takes an orchestrator script.
    let backends = roles(
        vec![init("worker-1"), Step::AwaitFollowUp],
        vec![
            vec![init("orchestrator-1"), end_turn("Planned.")],
            vec![init("orchestrator-1"), end_turn("Planned again.")],
            vec![init("orchestrator-2"), end_turn("Planned anew.")],
        ],
        &seen,
    );
    let host = Host::start(temp_dir(), backends);
    let (mut client, orchestrator) = host.orchestrator_client().await;
    let answering = client
        .call::<OrchestratorStart>(OrchestratorStartParams {
            approvals: true,
            ..start_params(orchestrator.id, "Plan.")
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
        .call::<OrchestratorStart>(start_params(orchestrator.id, "Start over."))
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

/// PLX-42: two runs the orchestrator started finish during its turn; once that turn ends, and with
/// no client connected, plxd wakes it with one turn that names both.
#[tokio::test]
async fn runs_finishing_during_a_orchestrator_turn_wake_it_once_with_no_client_connected() {
    let seen = Arc::new(Mutex::new(Vec::new()));
    let backends = roles(
        vec![init("worker-1"), end_turn("Added it.")],
        vec![
            vec![
                init("orchestrator-1"),
                Step::AwaitFollowUp,
                end_turn("Planned."),
            ],
            vec![init("orchestrator-1"), end_turn("Reviewed.")],
        ],
        &seen,
    );
    let host = Host::start(temp_dir(), backends);
    let (mut client, orchestrator) = host.orchestrator_client().await;
    let orchestrator_run = plan(&mut client, orchestrator.id).await;

    let mut workers = Vec::new();
    for task in ["Add a README.", "Add a license."] {
        workers.push(spawn(&mut client, &orchestrator_run, task).await);
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
        orchestrator_launches(&seen).len(),
        1,
        "no wake-up during a turn"
    );

    // The user's message, steered into the orchestrator's turn, ends it; then nobody is watching.
    client
        .call::<AgentSend>(AgentSendParams {
            delivery: Some(AgentDelivery::Steer),
            ..send_params(orchestrator_run.id, TurnId::generate(), "Go on.")
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
    subscribe(&mut client, orchestrator.id, 0).await;
    let events = until(&mut client, |event| {
        matches!(&event.event, ParallaxEvent::AgentOutput { items, .. } if items.iter().any(|item|
            matches!(item, AgentOutputItem::TurnStarted { wake: true, .. })))
    })
    .await;
    let Some(ParallaxEvent::AgentOutput { run_id, items, .. }) = events.last().map(|e| &e.event)
    else {
        unreachable!();
    };
    assert_eq!(*run_id, orchestrator_run.id);
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

async fn delete(
    client: &mut Conn,
    orchestrator: ScopeId,
) -> Result<OrchestratorDeleteResult, ErrorObject> {
    client
        .call::<OrchestratorDelete>(OrchestratorDeleteParams { orchestrator })
        .await
}

async fn runs_of(client: &mut Conn, orchestrator: ScopeId) -> Vec<AgentRun> {
    let params = AgentListParams {
        project: Some(orchestrator),
    };
    client.call::<AgentList>(params).await.unwrap().runs
}

fn deleted(orchestrator: ScopeId) -> impl FnMut(&EventsEventParams) -> bool {
    move |event| matches!(&event.event, ParallaxEvent::OrchestratorDeleted { orchestrator: id } if *id == orchestrator)
}

/// PLX-338: deleting an orchestrator stops its orchestrator and the subagent it started, and
/// removes their runs, events, worktree, and branch, its context folder, and the orchestrator
/// itself, which `orchestrator.deleted` tells every client, then and on replay.
#[tokio::test]
async fn deleting_a_orchestrator_stops_its_agents_and_removes_everything() {
    let seen = Arc::new(Mutex::new(Vec::new()));
    let backends = roles(
        vec![init("worker-1"), text("Working"), Step::Hang],
        vec![vec![init("orchestrator-1"), Step::Hang]],
        &seen,
    );
    let host = Host::start(temp_dir(), backends);
    let mut client = host.client().await;
    let orchestrator = create(&mut client, orchestrator_params(host.dir.path())).await;
    let repo = PathBuf::from(&orchestrator.repo_path);
    let context = host
        .dir
        .path()
        .join("context")
        .join(orchestrator.id.to_string());
    assert!(context.is_dir());
    client
        .call::<EventsSubscribe>(subscribe_host(0))
        .await
        .unwrap();
    subscribe(&mut client, orchestrator.id, 0).await;
    let orchestrator_run = plan(&mut client, orchestrator.id).await;
    let worker = spawn(&mut client, &orchestrator_run, "Build it.").await;
    let mut running = vec![orchestrator_run.id, worker];
    until(&mut client, |event| {
        if let ParallaxEvent::AgentUpdated { run_id, state } = &event.event
            && state.status == AgentStatus::Running
        {
            running.retain(|run| run != run_id);
        }
        running.is_empty()
    })
    .await;
    let run = runs_of(&mut client, orchestrator.id)
        .await
        .into_iter()
        .find(|run| run.id == worker)
        .unwrap();
    let worktree = PathBuf::from(run.worktree_path.unwrap());
    let branch = run.branch.unwrap();
    assert!(worktree.is_dir());

    delete(&mut client, orchestrator.id).await.unwrap();
    until(&mut client, deleted(orchestrator.id)).await;
    let health = client
        .call::<HostHealth>(HostHealthParams {})
        .await
        .unwrap();
    assert_eq!(health.running_agents, 0, "both agents were stopped");
    let orchestrators = client
        .call::<OrchestratorList>(OrchestratorListParams {})
        .await
        .unwrap()
        .orchestrators;
    assert!(orchestrators.is_empty());
    assert!(runs_of(&mut client, orchestrator.id).await.is_empty());
    for run_id in [orchestrator_run.id, worker] {
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
        "the worktrees, the branch, and the orchestrator's notes are removed",
        || {
            !worktree.exists()
                && git(&repo, &["branch", "--list", &branch]).is_empty()
                && !context.exists()
                && !orchestrator_worktree(&host, orchestrator.id).exists()
        },
    )
    .await;
    assert!(repo.join("README.md").is_file(), "the repository stays");

    let mut replay = host.client().await;
    replay
        .call::<EventsSubscribe>(subscribe_host(0))
        .await
        .unwrap();
    until(&mut replay, deleted(orchestrator.id)).await;

    let again = delete(&mut client, orchestrator.id).await.unwrap_err();
    assert_eq!(kind(&again), ErrorKind::OrchestratorNotFound);
    host.server.stop().await;
}
