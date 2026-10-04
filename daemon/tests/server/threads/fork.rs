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

/// Two calls claiming one new id must create exactly one fork with the winning origin.
async fn conflicting_forks(host: &Host, left: ThreadForkParams, right: ThreadForkParams) {
    assert_eq!(left.new_run_id, right.new_run_id);
    let mut a = host.client().await;
    let mut b = host.client().await;
    let (a, b) = tokio::join!(
        a.call::<ThreadFork>(left.clone()),
        b.call::<ThreadFork>(right.clone())
    );
    let (winner, params, error) = match (a, b) {
        (Ok(winner), Err(error)) => (winner, left, error),
        (Err(error), Ok(winner)) => (winner, right, error),
        other => panic!("one fork succeeds and the other conflicts: {other:?}"),
    };
    assert_eq!(kind(&error), ErrorKind::IdConflict, "{error:?}");
    let from = winner.thread.forked_from.unwrap();
    assert_eq!(from.run, params.run_id);
    assert_eq!(Some(from.turn), params.turn_id);
    let mut client = host.client().await;
    assert_eq!(
        client
            .call::<ThreadFork>(params.clone())
            .await
            .unwrap()
            .thread,
        winner.thread
    );
    let list = client
        .call::<ThreadList>(ThreadListParams {})
        .await
        .unwrap();
    assert_eq!(
        list.threads
            .iter()
            .filter(|thread| thread.id == params.new_run_id)
            .count(),
        1
    );
    let events = client
        .call::<AgentEvents>(AgentEventsParams {
            run_id: params.new_run_id,
            after: 0,
            limit: None,
        })
        .await
        .unwrap();
    assert_eq!(
        events
            .events
            .iter()
            .filter(|logged| matches!(logged.event, ParallaxEvent::AgentStarted { .. }))
            .count(),
        1
    );
}

#[tokio::test]
async fn concurrent_forks_from_different_threads_conflict() {
    let (host, _, _) = host();
    let mut client = host.client().await;
    let path = real_repo(host.work.path(), "app");
    let repo = client.add(&path).await;
    let params = || ThreadStartParams {
        checkout: true,
        ..start_params(Some(repo.id), "Write the notes")
    };
    let (a, _) = two_turns(&mut client, params()).await;
    let (b, _) = two_turns(&mut client, params()).await;
    let left = ThreadForkParams {
        turn_id: Some(first_turn(a.thread.id)),
        ..fork_params(a.thread.id)
    };
    let right = ThreadForkParams {
        new_run_id: left.new_run_id,
        turn_id: Some(first_turn(b.thread.id)),
        ..fork_params(b.thread.id)
    };
    conflicting_forks(&host, left, right).await;
    host.server.stop().await;
}

#[tokio::test]
async fn concurrent_forks_at_different_turns_conflict() {
    let (host, _, _) = host();
    let mut client = host.client().await;
    let path = real_repo(host.work.path(), "app");
    let repo = client.add(&path).await;
    let (parent, follow_up) = two_turns(
        &mut client,
        ThreadStartParams {
            checkout: true,
            ..start_params(Some(repo.id), "Write the notes")
        },
    )
    .await;
    let left = ThreadForkParams {
        turn_id: Some(first_turn(parent.thread.id)),
        ..fork_params(parent.thread.id)
    };
    let right = ThreadForkParams {
        turn_id: Some(follow_up),
        ..left.clone()
    };
    conflicting_forks(&host, left, right).await;
    host.server.stop().await;
}

/// Concurrent identical cross-provider forks share one scratch workspace and filtered model.
#[tokio::test]
async fn concurrent_cross_provider_fork_retries_return_the_same_fork() {
    let (host, _, other) = host();
    let mut client = host.client().await;
    let (parent, _) = two_turns(
        &mut client,
        ThreadStartParams {
            model: Some("parent-model".to_owned()),
            ..start_params(None, "Write the notes")
        },
    )
    .await;
    let params = ThreadForkParams {
        account: Some(AccountChoice::Subscription {
            backend: "other".to_owned(),
        }),
        ..fork_params(parent.thread.id)
    };
    let mut retry_client = host.client().await;
    let (first, retry) = tokio::join!(
        client.call::<ThreadFork>(params.clone()),
        retry_client.call::<ThreadFork>(params.clone())
    );
    let (first, retry) = (first.unwrap(), retry.unwrap());
    assert_eq!(first.thread, retry.thread);
    assert_eq!(first.run, retry.run);
    assert_eq!(first.run.backend, "other");
    assert_eq!(first.run.model, None, "the parent's model is filtered");
    let scratch = host
        .data()
        .join("scratch")
        .join(params.new_run_id.to_string());
    assert!(scratch.join(".git").is_dir());
    let (_, copied) = transcript(&mut client, params.new_run_id).await;
    assert_eq!(follow_ups(&copied), ["Now the tests"]);
    assert_eq!(texts(&copied), ["Done.", "Done."], "history copied once");
    client
        .call::<AgentSend>(message(params.new_run_id, "Carry on"))
        .await
        .unwrap();
    client.until(finished(params.new_run_id)).await;
    {
        let starts = other.lock().unwrap();
        assert_eq!(starts.len(), 1);
        assert_eq!(starts[0].resume, None);
        assert!(
            starts[0]
                .prompt
                .contains("began with another agent, on fake,")
        );
    }
    host.server.stop().await;
}

/// The `agent.output` items in run `run_id`'s log, oldest first, and its `agent.started` prompt.
async fn transcript(client: &mut Conn, run_id: RunId) -> (String, Vec<AgentOutputItem>) {
    let events = client
        .call::<AgentEvents>(AgentEventsParams {
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
            ParallaxEvent::AgentOutput { run_id: id, items } => {
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

/// PLX-465: a fork records the run that asked for it as its parent, which must exist, and a retry
/// naming another parent is `idConflict`.
#[tokio::test]
async fn a_fork_records_the_run_that_asked_for_it_as_its_parent() {
    let (host, _, _) = host();
    let mut client = host.client().await;
    let (parent, _) = two_turns(&mut client, start_params(None, "Write the notes")).await;
    let asker = client
        .call::<ThreadStart>(start_params(None, "Fork it"))
        .await
        .unwrap()
        .run
        .id;
    let missing = ThreadForkParams {
        parent: Some(RunId::generate()),
        ..fork_params(parent.thread.id)
    };
    let refused = client.call::<ThreadFork>(missing).await.unwrap_err();
    assert_eq!(kind(&refused), ErrorKind::RunNotFound, "{refused:?}");

    let params = ThreadForkParams {
        parent: Some(asker),
        ..fork_params(parent.thread.id)
    };
    let forked = client.call::<ThreadFork>(params.clone()).await.unwrap();
    assert_eq!(forked.thread.parent, Some(asker));
    let other = ThreadForkParams {
        parent: None,
        ..params
    };
    let conflict = client.call::<ThreadFork>(other).await.unwrap_err();
    assert_eq!(kind(&conflict), ErrorKind::IdConflict, "{conflict:?}");
    host.server.stop().await;
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
    for (provider, name, permissions) in [
        (
            Provider::Anthropic,
            "fake",
            &[Auto, Manual, Edit, Plan, Bypass][..],
        ),
        (Provider::Openai, "codex", &[Auto, Manual, Edit, Bypass][..]),
        (Provider::Cursor, "cursor", &[Auto, Edit, Bypass][..]),
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
    for (mode, backend) in [(Plan, "codex"), (Manual, "cursor")] {
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

/// A Current checkout thread forked onto another provider works in the same checkout, and its
/// first message hands the parent's conversation to the new CLI.
#[tokio::test]
async fn a_fork_onto_another_provider_takes_a_handoff_in_the_same_checkout() {
    let (host, _, other) = host();
    let path = real_repo(host.work.path(), "app");
    let mut client = host.client().await;
    let repo = client.add(&path).await;
    let params = ThreadStartParams {
        checkout: true,
        ..start_params(Some(repo.id), "Write the notes")
    };
    let (parent, _) = two_turns(&mut client, params).await;

    let params = ThreadForkParams {
        account: Some(AccountChoice::Subscription {
            backend: "other".to_owned(),
        }),
        model: Some("gpt-6".to_owned()),
        ..fork_params(parent.thread.id)
    };
    let forked = client.call::<ThreadFork>(params.clone()).await.unwrap();
    assert!(forked.run.checkout);
    assert_eq!(forked.run.worktree_path, None);
    assert_eq!(forked.run.backend, "other");
    assert_eq!(forked.run.model.as_deref(), Some("gpt-6"));

    client
        .call::<AgentSend>(message(params.new_run_id, "Carry on"))
        .await
        .unwrap();
    client.until(finished(params.new_run_id)).await;
    let starts = other.lock().unwrap().clone();
    let [start] = starts.as_slice() else {
        panic!("one CLI on the other backend: {starts:?}");
    };
    assert_eq!(start.resume, None, "a new session");
    assert!(
        start.prompt.contains("began with another agent, on fake,"),
        "names the parent's backend: {}",
        start.prompt
    );
    assert!(
        start.prompt.contains(
            "User:\nWrite the notes\n\nAgent:\nDone.\n\nUser:\nNow the tests\n\nAgent:\nDone.\n</conversation>"
        ),
        "{}",
        start.prompt
    );
    assert!(
        start.prompt.ends_with("yours to answer:\nCarry on"),
        "{}",
        start.prompt
    );
    let (_, items) = transcript(&mut client, params.new_run_id).await;
    assert!(
        items
            .iter()
            .any(|item| matches!(item, AgentOutputItem::Notice { detail }
            if detail.starts_with("Moved from fake to other:"))),
        "{items:?}"
    );
    host.server.stop().await;
}

/// A fork at an earlier turn of a thread with no repo: its own scratch repository with the
/// parent's latest commit, the parent's transcript up to that turn, and a handoff of only that.
#[tokio::test]
async fn a_fork_at_an_earlier_turn_hands_over_the_conversation_up_to_it() {
    let (host, fake, _) = host();
    let mut client = host.client().await;
    let (parent, _) = two_turns(&mut client, start_params(None, "Write the notes")).await;

    let unknown = ThreadForkParams {
        turn_id: Some(TurnId::generate()),
        ..fork_params(parent.thread.id)
    };
    let refused = client.call::<ThreadFork>(unknown).await.unwrap_err();
    assert_eq!(refused.code, INVALID_PARAMS, "{refused:?}");

    let params = ThreadForkParams {
        turn_id: Some(first_turn(parent.thread.id)),
        ..fork_params(parent.thread.id)
    };
    let forked = client.call::<ThreadFork>(params.clone()).await.unwrap();
    assert_eq!(forked.thread.repo, parent.thread.repo, "the scratch entry");
    let worktree = PathBuf::from(forked.run.worktree_path.clone().unwrap());
    assert!(
        worktree.join("NOTES.md").exists(),
        "cut from the parent's latest commit"
    );
    let scratch = host
        .data()
        .join("scratch")
        .join(params.new_run_id.to_string());
    assert!(
        scratch.join(".git").is_dir(),
        "a scratch repository of its own"
    );
    let (_, items) = transcript(&mut client, params.new_run_id).await;
    assert!(follow_ups(&items).is_empty(), "{items:?}");
    assert!(
        items
            .iter()
            .any(|item| matches!(item, AgentOutputItem::Text { text, .. } if text == "Done.")),
        "{items:?}"
    );

    client
        .call::<AgentSend>(message(params.new_run_id, "Carry on"))
        .await
        .unwrap();
    client.until(finished(params.new_run_id)).await;
    let last = fake.lock().unwrap().last().cloned().unwrap();
    assert_eq!(last.resume, None, "a handoff, not the parent's session");
    assert!(
        last.prompt
            .contains("User:\nWrite the notes\n\nAgent:\nDone.\n</conversation>"),
        "{}",
        last.prompt
    );
    assert!(!last.prompt.contains("Now the tests"), "{}", last.prompt);
    host.server.stop().await;
}

/// The prompt's turn of run `run_id`, which `thread/fork` names by the run's id.
fn first_turn(run_id: RunId) -> TurnId {
    TurnId::try_from(uuid::Uuid::from(run_id)).unwrap()
}

fn texts(items: &[AgentOutputItem]) -> Vec<&str> {
    items
        .iter()
        .filter_map(|item| match item {
            AgentOutputItem::Text { text, .. } => Some(text.as_str()),
            _ => None,
        })
        .collect()
}

fn text(run_id: RunId, wanted: &'static str) -> impl FnMut(&EventsEventParams) -> bool {
    move |event| {
        matches!(&event.event, ParallaxEvent::AgentOutput { run_id: id, items }
            if *id == run_id && texts(items).contains(&wanted))
    }
}

/// A fork at a turn the user followed up mid-turn, as Claude Code's driver logs one: the
/// follow-up's `turnStarted` comes before the end of the turn it followed. The fork is refused
/// until that turn ends, and then copies all of it and none of the follow-up.
#[tokio::test]
async fn a_fork_at_a_turn_followed_up_mid_turn_copies_the_whole_turn() {
    let steps = [
        Step::Init {
            session_id: "thread-1".to_owned(),
            model: None,
        },
        Step::Emit(Event::Text {
            message_id: None,
            text: "Working.".to_owned(),
        }),
        Step::AwaitFollowUp,
        Step::AwaitFollowUp,
        Step::Emit(Event::Text {
            message_id: None,
            text: "The first turn's end.".to_owned(),
        }),
        Step::EndTurn { result: None },
        Step::Emit(Event::Text {
            message_id: None,
            text: "The follow-ups' answer.".to_owned(),
        }),
        Step::EndTurn { result: None },
        Step::EndTurn { result: None },
    ];
    let (host, _, _) = host_running(&steps);
    let mut client = host.client().await;
    let parent = client
        .call::<ThreadStart>(start_params(None, "Write the notes"))
        .await
        .unwrap();
    let run_id = parent.thread.id;
    client.subscribe(0, Some(scope(parent.thread.repo))).await;
    client.until(text(run_id, "Working.")).await;
    client
        .call::<AgentSend>(AgentSendParams {
            delivery: Some(parallax_protocol::AgentDelivery::Steer),
            ..message(run_id, "Now the tests")
        })
        .await
        .unwrap();
    client.until(text(run_id, "Now the tests")).await;

    let params = ThreadForkParams {
        turn_id: Some(first_turn(run_id)),
        ..fork_params(run_id)
    };
    let refused = client.call::<ThreadFork>(params.clone()).await.unwrap_err();
    assert_eq!(refused.code, INVALID_PARAMS, "{refused:?}");

    client
        .call::<AgentSend>(AgentSendParams {
            delivery: Some(parallax_protocol::AgentDelivery::Steer),
            ..message(run_id, "And the docs")
        })
        .await
        .unwrap();
    client.until(finished(run_id)).await;
    client.call::<ThreadFork>(params.clone()).await.unwrap();
    let (_, items) = transcript(&mut client, params.new_run_id).await;
    assert!(follow_ups(&items).is_empty(), "{items:?}");
    assert_eq!(
        texts(&items),
        [
            "Working.",
            "Now the tests",
            "And the docs",
            "The first turn's end."
        ]
    );
    assert!(
        matches!(
            items.last(),
            Some(AgentOutputItem::TurnFinished { turn_id: None, .. })
        ),
        "{items:?}"
    );
    host.server.stop().await;
}

/// A fork of a fork that has sent nothing copies all the history that fork copied, whose turns
/// are its prompt's turn: they can be forked only from the thread they came from.
#[tokio::test]
async fn a_fresh_fork_forks_with_all_it_copied() {
    let (host, _, _) = host();
    let mut client = host.client().await;
    let (parent, follow_up) = two_turns(&mut client, start_params(None, "Write the notes")).await;
    let first = fork_params(parent.thread.id);
    client.call::<ThreadFork>(first.clone()).await.unwrap();

    let copied = ThreadForkParams {
        turn_id: Some(follow_up),
        ..fork_params(first.new_run_id)
    };
    let refused = client.call::<ThreadFork>(copied).await.unwrap_err();
    assert_eq!(refused.code, INVALID_PARAMS, "{refused:?}");
    assert!(refused.message.contains("of its own"), "{refused:?}");

    let second = fork_params(first.new_run_id);
    let forked = client.call::<ThreadFork>(second.clone()).await.unwrap();
    let from = forked.thread.forked_from.expect("forkedFrom");
    assert_eq!(
        (from.run, from.turn),
        (first.new_run_id, first_turn(first.new_run_id))
    );
    let (_, items) = transcript(&mut client, second.new_run_id).await;
    assert_eq!(follow_ups(&items), ["Now the tests"]);
    assert_eq!(texts(&items), ["Done.", "Done."]);
    host.server.stop().await;
}

/// A fork at a turn that was stopped mid-turn, after the user had followed it up: the turn ends at
/// its CLI's `agent.finished`, as a stopped turn logs no `turnFinished`, so the fork copies all of
/// it, even while a later turn runs.
#[tokio::test]
async fn a_fork_at_a_stopped_turn_copies_it_while_a_later_turn_runs() {
    let steps = [
        Step::Init {
            session_id: "thread-1".to_owned(),
            model: None,
        },
        Step::Emit(Event::Text {
            message_id: None,
            text: "Working.".to_owned(),
        }),
        Step::AwaitFollowUp,
        Step::Emit(Event::Text {
            message_id: None,
            text: "The first turn's end.".to_owned(),
        }),
        Step::Hang,
    ];
    let (host, _, _) = host_running(&steps);
    let mut client = host.client().await;
    let parent = client
        .call::<ThreadStart>(start_params(None, "Write the notes"))
        .await
        .unwrap();
    let run_id = parent.thread.id;
    client.subscribe(0, Some(scope(parent.thread.repo))).await;
    client.until(text(run_id, "Working.")).await;
    client
        .call::<AgentSend>(AgentSendParams {
            delivery: Some(parallax_protocol::AgentDelivery::Steer),
            ..message(run_id, "Now the tests")
        })
        .await
        .unwrap();
    client.until(text(run_id, "The first turn's end.")).await;
    client
        .call::<AgentCancel>(AgentCancelParams { run_id, from: None })
        .await
        .unwrap();
    client.until(updated_to(AgentStatus::Cancelled)).await;
    client
        .call::<AgentSend>(message(run_id, "And the docs"))
        .await
        .unwrap();
    client.until(updated_to(AgentStatus::Running)).await;

    let params = ThreadForkParams {
        turn_id: Some(first_turn(run_id)),
        ..fork_params(run_id)
    };
    client.call::<ThreadFork>(params.clone()).await.unwrap();
    let (_, items) = transcript(&mut client, params.new_run_id).await;
    assert!(follow_ups(&items).is_empty(), "{items:?}");
    assert_eq!(
        texts(&items),
        ["Working.", "Now the tests", "The first turn's end."]
    );
    host.server.stop().await;
}

/// A fork of a fork that never ran hands over from the backend the conversation ran on, not the
/// one the first fork was made for.
#[tokio::test]
async fn a_fork_of_an_unrun_fork_hands_over_from_where_the_conversation_ran() {
    let (host, _, other) = host();
    let mut client = host.client().await;
    let (parent, _) = two_turns(&mut client, start_params(None, "Write the notes")).await;
    let first = ThreadForkParams {
        account: Some(AccountChoice::Subscription {
            backend: "other".to_owned(),
        }),
        ..fork_params(parent.thread.id)
    };
    client.call::<ThreadFork>(first.clone()).await.unwrap();
    let second = fork_params(first.new_run_id);
    let forked = client.call::<ThreadFork>(second.clone()).await.unwrap();
    assert_eq!(forked.run.backend, "other");

    client
        .call::<AgentSend>(message(second.new_run_id, "Carry on"))
        .await
        .unwrap();
    client.until(finished(second.new_run_id)).await;
    let start = other.lock().unwrap().last().cloned().unwrap();
    assert!(
        start.prompt.contains("began with another agent, on fake,"),
        "{}",
        start.prompt
    );
    host.server.stop().await;
}
