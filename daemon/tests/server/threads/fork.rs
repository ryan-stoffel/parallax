//! `thread/fork` (PLX-375, decision 0050): a fork's workspace and transcript, and how its first
//! message continues the parent's conversation, natively or by handoff.

use parallax_protocol::methods::ThreadFork;
use parallax_protocol::{AgentOutputItem, ThreadForkParams, ThreadStartResult};

use super::*;

/// What a backend's CLI started with.
#[derive(Clone, Debug)]
struct Start {
    prompt: String,
    /// The session it resumed or forked.
    resume: Option<String>,
    fork: bool,
}

/// The starts a backend recorded.
type Starts = Arc<Mutex<Vec<Start>>>;

/// The fake CLI as a backend named `name`, recording each start.
struct Seen {
    name: &'static str,
    fake: FakeBackend,
    starts: Starts,
}

impl Backend for Seen {
    fn name(&self) -> &'static str {
        self.name
    }

    fn capabilities(&self) -> Capabilities {
        self.fake.capabilities()
    }

    fn start(&self, request: RunRequest) -> Result<Started, StartError> {
        self.starts.lock().unwrap().push(Start {
            prompt: request.prompt.clone(),
            resume: request.resume.as_ref().map(|r| r.session_id.clone()),
            fork: request.resume.as_ref().is_some_and(|r| r.fork),
        });
        self.fake.start(request)
    }
}

/// A host whose `fake` backend, and `other` backend for another provider, record their starts.
fn host() -> (Host, Starts, Starts) {
    host_running(&editing())
}

/// [`host`], with both backends running `steps`.
fn host_running(steps: &[Step]) -> (Host, Starts, Starts) {
    let (fake, other) = (Arc::default(), Arc::default());
    let mut backends = BackendRegistry::new();
    for (provider, name, starts) in [
        (Provider::Anthropic, "fake", &fake),
        (Provider::Openai, "other", &other),
    ] {
        let seen = Seen {
            name,
            fake: fake_backend(steps.to_vec()),
            starts: Arc::clone(starts),
        };
        backends.register(provider, Arc::new(seen));
    }
    (Host::start(backends), fake, other)
}

fn finished(run_id: RunId) -> impl FnMut(&EventsEventParams) -> bool {
    move |event| {
        matches!(&event.event, ParallaxEvent::AgentUpdated { run_id: id, state }
            if *id == run_id && state.status == AgentStatus::Completed)
    }
}

/// Starts a thread with "Write the notes", then sends it "Now the tests", and returns it and the
/// follow-up's turn id once both turns are done. Subscribes to its scope.
async fn two_turns(client: &mut Conn, params: ThreadStartParams) -> (ThreadStartResult, TurnId) {
    let started = client.call::<ThreadStart>(params).await.unwrap();
    let run_id = started.thread.id;
    client.subscribe(0, Some(scope(started.thread.repo))).await;
    client.until(finished(run_id)).await;
    let follow_up = message(run_id, "Now the tests");
    client.call::<AgentSend>(follow_up.clone()).await.unwrap();
    client.until(finished(run_id)).await;
    (started, follow_up.turn_id)
}

fn fork_params(run_id: RunId) -> ThreadForkParams {
    ThreadForkParams {
        run_id,
        new_run_id: RunId::generate(),
        turn_id: None,
        account: None,
        model: None,
        parent: None,
    }
}

/// The `agent.output` items in run `run_id`'s log, oldest first, and its `agent.started` prompt.
async fn transcript(client: &mut Conn, run_id: RunId) -> (String, Vec<AgentOutputItem>) {
    let events = client
        .call::<AgentEvents>(AgentEventsParams {
            before: None,
            run_id,
            after: 0,
            limit: None,
        })
        .await
        .unwrap()
        .events;
    let Some(ParallaxEvent::AgentStarted { run: Some(run), .. }) = events.first().map(|e| &e.event)
    else {
        panic!("the log starts with agent.started: {events:?}");
    };
    let items = events
        .iter()
        .filter_map(|logged| match &logged.event {
            ParallaxEvent::AgentOutput {
                run_id: id, items, ..
            } => {
                assert_eq!(*id, run_id, "copied items carry the fork's id");
                Some(items.clone())
            }
            _ => None,
        })
        .flatten()
        .collect();
    (run.prompt.clone(), items)
}

fn follow_ups(items: &[AgentOutputItem]) -> Vec<&str> {
    items
        .iter()
        .filter_map(|item| match item {
            AgentOutputItem::TurnStarted {
                text: Some(text), ..
            } => Some(text.as_str()),
            _ => None,
        })
        .collect()
}

/// The fake CLI as a backend named `name` that maps only `permissions`.
struct Modes {
    name: &'static str,
    fake: FakeBackend,
    permissions: &'static [AgentPermission],
}

impl Backend for Modes {
    fn name(&self) -> &'static str {
        self.name
    }

    fn capabilities(&self) -> Capabilities {
        self.fake.capabilities()
    }

    fn permissions(&self) -> &[AgentPermission] {
        self.permissions
    }

    fn start(&self, request: RunRequest) -> Result<Started, StartError> {
        self.fake.start(request)
    }
}

/// PLX-465: a fork a thread asks for keeps its parent's mode, so onto a backend that doesn't map
/// it, as Codex has no Plan and an ACP agent may have no Manual, it is refused rather than run in
/// the default, Edit, which needs less approval. A fork from the app still drops it (0050).
#[tokio::test]
async fn a_fork_for_a_parent_refuses_a_mode_its_backend_cant_run() {
    use AgentPermission::{Auto, Bypass, Edit, Manual, Plan};
    let mut backends = BackendRegistry::new();
    // Claude Code's modes, Codex's, and those of an ACP agent with no Manual. Not named after
    // the built-in CLIs, which plxd would look for on the machine.
    for (provider, name, permissions) in [
        (
            Provider::Anthropic,
            "fake",
            &[Auto, Manual, Edit, Plan, Bypass][..],
        ),
        (Provider::Openai, "other", &[Auto, Manual, Edit, Bypass][..]),
        (Provider::Cursor, "acp", &[Auto, Edit, Bypass][..]),
    ] {
        let modes = Modes {
            name,
            fake: fake_backend(editing()),
            permissions,
        };
        backends.register(provider, Arc::new(modes));
    }
    let host = Host::start(backends);
    let mut client = host.client().await;
    let asker = client
        .call::<ThreadStart>(start_params(None, "Fork it"))
        .await
        .unwrap()
        .run
        .id;
    for (mode, backend) in [(Plan, "other"), (Manual, "acp")] {
        // Its own subscription, so the last thread's events don't end this one's turns.
        let mut client = host.client().await;
        let original = ThreadStartParams {
            permission: Some(mode),
            ..start_params(None, "Write the notes")
        };
        let (original, _) = two_turns(&mut client, original).await;
        let onto = ThreadForkParams {
            account: Some(AccountChoice::Subscription {
                backend: backend.to_owned(),
            }),
            ..fork_params(original.thread.id)
        };
        let refused = client
            .call::<ThreadFork>(ThreadForkParams {
                parent: Some(asker),
                ..onto.clone()
            })
            .await
            .unwrap_err();
        assert_eq!(kind(&refused), ErrorKind::UnsupportedOption, "{refused:?}");
        let forked = client.call::<ThreadFork>(onto).await.unwrap();
        assert_eq!(forked.run.permission, None, "the app's fork drops it");
    }
    host.server.stop().await;
}

/// A fork at the latest turn of a thread in a worktree: its own worktree from the parent's latest
/// commit, the parent's whole transcript, and a first message that forks the parent's session.
#[tokio::test]
async fn a_fork_at_the_latest_turn_forks_the_parents_session() {
    let (host, fake, _) = host();
    let path = real_repo(host.work.path(), "app");
    let mut client = host.client().await;
    let repo = client.add(&path).await;
    let (parent, follow_up) =
        two_turns(&mut client, start_params(Some(repo.id), "Write the notes")).await;

    let params = fork_params(parent.thread.id);
    let forked = client.call::<ThreadFork>(params.clone()).await.unwrap();
    let from = forked.thread.forked_from.expect("forkedFrom");
    assert_eq!((from.run, from.turn), (parent.thread.id, follow_up));
    assert_eq!(forked.thread.repo, repo.id);
    assert_eq!(forked.run.status, AgentStatus::Completed, "no CLI yet");
    assert_eq!(forked.run.prompt, "Write the notes");
    assert_ne!(forked.run.branch, parent.run.branch);
    let worktree = PathBuf::from(forked.run.worktree_path.clone().unwrap());
    assert_eq!(
        std::fs::read_to_string(worktree.join("NOTES.md")).unwrap(),
        "Written in a thread.\n",
        "cut from the parent's latest commit"
    );
    let (prompt, items) = transcript(&mut client, params.new_run_id).await;
    assert_eq!(prompt, "Write the notes");
    assert_eq!(follow_ups(&items), ["Now the tests"]);

    let retried = client.call::<ThreadFork>(params.clone()).await.unwrap();
    assert_eq!(retried.thread, forked.thread, "a retry returns the fork");
    let other_turn = ThreadForkParams {
        turn_id: Some(first_turn(parent.thread.id)),
        ..params.clone()
    };
    let conflict = client.call::<ThreadFork>(other_turn).await.unwrap_err();
    assert_eq!(kind(&conflict), ErrorKind::IdConflict);

    client
        .call::<AgentSend>(message(params.new_run_id, "Carry on"))
        .await
        .unwrap();
    client.until(finished(params.new_run_id)).await;
    let last = fake.lock().unwrap().last().cloned().unwrap();
    assert_eq!(last.resume.as_deref(), Some("thread-1"), "{last:?}");
    assert!(last.fork, "{last:?}");
    assert_eq!(last.prompt, "Carry on");
    host.server.stop().await;
}

/// The prompt's turn of run `run_id`, which `thread/fork` names by the run's id.
fn first_turn(run_id: RunId) -> TurnId {
    TurnId::try_from(uuid::Uuid::from(run_id)).unwrap()
}

/// A fork's copied turns are runs of its own under the same turn ids (0059, PLX-644): the source
/// keeps its runs, each on its first attempt, and the fork lists copies of them.
#[tokio::test]
async fn a_fork_has_its_own_runs_and_leaves_its_sources_alone() {
    use parallax_protocol::methods::OrchestrationSubscribeThread;
    use parallax_protocol::{SubscribeThreadParams, ThreadRunStatus};

    let (host, _, _) = host();
    let mut client = host.client().await;
    let (started, follow_up) = two_turns(&mut client, start_params(None, "Write the notes")).await;
    let source = started.thread.id;
    let fork = client
        .call::<ThreadFork>(fork_params(source))
        .await
        .unwrap()
        .thread
        .id;
    let mut runs = async |thread_id| {
        let snapshot = client
            .call::<OrchestrationSubscribeThread>(SubscribeThreadParams {
                thread_id,
                after_seq: None,
            })
            .await
            .unwrap()
            .snapshot
            .unwrap();
        snapshot
            .runs
            .iter()
            .map(|run| (run.id, run.ordinal, run.status, run.attempt))
            .collect::<Vec<_>>()
    };
    let theirs = runs(source).await;
    assert_eq!(theirs.len(), 2, "{theirs:?}");
    assert_eq!(theirs[1].0, follow_up);
    for (i, run) in theirs.iter().enumerate() {
        let ordinal = u32::try_from(i + 1).unwrap();
        assert_eq!(
            (run.1, run.2, run.3),
            (Some(ordinal), ThreadRunStatus::Completed, Some(1)),
            "{theirs:?}"
        );
    }
    // A first turn has no id of its own, so plxd made one for each thread.
    let copies = runs(fork).await;
    assert_eq!(copies[1], theirs[1], "the follow-up's copy keeps its id");
    let shape = |runs: &[(TurnId, Option<u32>, ThreadRunStatus, Option<u32>)]| {
        runs.iter()
            .map(|run| (run.1, run.2, run.3))
            .collect::<Vec<_>>()
    };
    assert_eq!(
        shape(&copies),
        shape(&theirs),
        "the fork's copies, as their source's"
    );
    assert_eq!(
        runs(source).await,
        theirs,
        "and the source's unchanged by the copy"
    );
}
