//! The thread graph's commands and subscriptions (0059 phase 2, PLX-644), on the fake CLI:
//! `orchestration/dispatch`'s queue commands, receipts, and held Stop with its cascade, and
//! `orchestration/subscribeShell` and `orchestration/subscribeThread`'s snapshots, live events,
//! and resumes.

use parallax_protocol::methods::{
    AgentStart, OrchestrationDispatch, OrchestrationSubscribeShell, OrchestrationSubscribeThread,
    OrchestrationThreadHistory, ProjectStart, ThreadStart,
};
use parallax_protocol::{
    AgentOutcome, AgentOutputItem, AgentStatus, DispatchMode, ErrorKind, EventsEventParams,
    OrchestrationCommand, ParallaxEvent, RunId, SubscribeShellParams, SubscribeThreadParams,
    SubscribeThreadResult, ThreadHistoryParams, ThreadRunStatus, ThreadSnapshot, TurnId,
};
use plxd::backend::fake::Step;
use uuid::Uuid;

use crate::agents::{
    Conn, Host, create, fake, has_item, init, project_params, start_params, text, until,
};
use crate::support::{kind, temp_dir};

/// A script that reports its session, then works on its first turn until cancelled.
fn busy() -> Vec<Step> {
    vec![init("graph-1"), text("Working"), Step::Hang]
}

fn working() -> impl FnMut(&EventsEventParams) -> bool {
    has_item(AgentOutputItem::Text {
        message_id: None,
        text: "Working".to_owned(),
    })
}

fn message(thread_id: RunId, message_id: TurnId, text: &str) -> OrchestrationCommand {
    sent(thread_id, message_id, text, DispatchMode::QueueAfterActive)
}

fn sent(
    thread_id: RunId,
    message_id: TurnId,
    text: &str,
    dispatch_mode: DispatchMode,
) -> OrchestrationCommand {
    OrchestrationCommand::MessageDispatch {
        thread_id,
        message_id,
        text: text.to_owned(),
        images: Vec::new(),
        threads: Vec::new(),
        model: None,
        effort: None,
        permission: None,
        context_window: None,
        fast: None,
        account: None,
        dispatch_mode,
    }
}

async fn dispatch(client: &mut Conn, command: OrchestrationCommand) -> u64 {
    client
        .command::<OrchestrationDispatch>(command, Uuid::now_v7())
        .await
        .unwrap()
        .seq
}

async fn subscribe(
    client: &mut Conn,
    thread_id: RunId,
    after_seq: Option<u64>,
) -> SubscribeThreadResult {
    client
        .call::<OrchestrationSubscribeThread>(SubscribeThreadParams {
            thread_id,
            after_seq,
        })
        .await
        .unwrap()
}

async fn snapshot(client: &mut Conn, thread_id: RunId) -> ThreadSnapshot {
    subscribe(client, thread_id, None)
        .await
        .snapshot
        .expect("a subscription with no afterSeq has a snapshot")
}

/// The queue as the thread's snapshot has it: its queued runs' ids, and whether each is held.
async fn queued(client: &mut Conn, thread_id: RunId) -> Vec<(TurnId, bool)> {
    snapshot(client, thread_id)
        .await
        .runs
        .iter()
        .filter(|run| run.status == ThreadRunStatus::Queued)
        .map(|run| (run.id, run.queue_held))
        .collect()
}

fn edit(thread_id: RunId, run_id: TurnId, text: &str) -> OrchestrationCommand {
    OrchestrationCommand::QueuedRunEdit {
        thread_id,
        run_id,
        text: text.to_owned(),
    }
}

fn cancel(thread_id: RunId, run_id: TurnId) -> OrchestrationCommand {
    OrchestrationCommand::QueuedRunCancel { thread_id, run_id }
}

fn stop(thread_id: RunId) -> OrchestrationCommand {
    OrchestrationCommand::RunInterrupt {
        thread_id,
        hold_queue: true,
    }
}

/// A thread with a turn under way, on a project.
async fn working_thread(host: &Host, client: &mut Conn) -> RunId {
    let project = create(client, project_params(host.dir.path())).await;
    let params = start_params(project.id, "Work for a while");
    let thread = params.run_id;
    client.call::<AgentStart>(params).await.unwrap();
    thread
}

/// A thread's subscription starts from a snapshot with its run, then gets its events. Messages
/// dispatched during its turn are queued runs, which the queue commands reorder, edit, and
/// cancel, idempotently on their command ids. A held Stop keeps them, held, and `queue.resume`
/// starts the next.
#[tokio::test]
async fn queue_commands_change_the_queued_runs_and_a_held_stop_keeps_them() {
    let host = Host::start(temp_dir(), fake(busy()));
    let mut client = host.client().await;
    let thread = working_thread(&host, &mut client).await;
    assert_eq!(snapshot(&mut client, thread).await.thread.id, thread);
    until(&mut client, working()).await;

    let (a, b, c) = (TurnId::generate(), TurnId::generate(), TurnId::generate());
    for (id, words) in [(a, "First"), (b, "Second"), (c, "Third")] {
        dispatch(&mut client, message(thread, id, words)).await;
    }
    let seen = snapshot(&mut client, thread).await;
    let statuses: Vec<_> = seen
        .runs
        .iter()
        .map(|run| (run.status, run.ordinal, run.position))
        .collect();
    assert_eq!(
        statuses,
        [
            (ThreadRunStatus::Running, Some(1), None),
            (ThreadRunStatus::Queued, None, Some(0)),
            (ThreadRunStatus::Queued, None, Some(1)),
            (ThreadRunStatus::Queued, None, Some(2)),
        ]
    );
    assert!(
        seen.events
            .iter()
            .any(|event| matches!(&event.event, ParallaxEvent::AgentStarted { .. })),
        "a short thread's snapshot reaches back to its start"
    );

    // A retried command answers as it first did, and doesn't apply twice; its id can't be reused
    // for another command.
    let reorder = OrchestrationCommand::QueuedRunReorder {
        thread_id: thread,
        run_ids: vec![c, a, b],
    };
    let command_id = Uuid::now_v7();
    let first = client
        .command::<OrchestrationDispatch>(reorder.clone(), command_id)
        .await
        .unwrap();
    let again = client
        .command::<OrchestrationDispatch>(reorder, command_id)
        .await
        .unwrap();
    assert_eq!(again, first);
    let resume = OrchestrationCommand::QueueResume { thread_id: thread };
    let conflict = client
        .command::<OrchestrationDispatch>(resume.clone(), command_id)
        .await
        .unwrap_err();
    assert_eq!(kind(&conflict), ErrorKind::IdConflict);

    dispatch(&mut client, cancel(thread, b)).await;
    let gone = client
        .command::<OrchestrationDispatch>(cancel(thread, b), Uuid::now_v7())
        .await
        .unwrap_err();
    assert_eq!(kind(&gone), ErrorKind::QueuedMessageNotFound);
    dispatch(&mut client, edit(thread, a, "First, edited")).await;
    assert_eq!(queued(&mut client, thread).await, [(c, false), (a, false)]);

    dispatch(&mut client, stop(thread)).await;
    until(&mut client, |event| {
        matches!(
            &event.event,
            ParallaxEvent::AgentFinished {
                outcome: AgentOutcome::Cancelled,
                ..
            }
        )
    })
    .await;
    assert_eq!(
        queued(&mut client, thread).await,
        [(c, true), (a, true)],
        "a held Stop keeps the queue, held"
    );

    dispatch(&mut client, resume).await;
    until(&mut client, |event| {
        matches!(&event.event, ParallaxEvent::AgentOutput { items, .. }
            if items.iter().any(|item| matches!(item, AgentOutputItem::TurnStarted { turn_id: Some(id), .. } if *id == c)))
    })
    .await;
    let statuses: Vec<_> = snapshot(&mut client, thread)
        .await
        .runs
        .iter()
        .map(|run| (run.id, run.status, run.ordinal, run.queue_held))
        .collect();
    assert_eq!(statuses[0].1, ThreadRunStatus::Cancelled);
    assert_eq!(
        &statuses[1..],
        [
            (c, ThreadRunStatus::Running, Some(2), false),
            (a, ThreadRunStatus::Queued, None, false),
        ]
    );
}

/// A resume replays a short gap with no snapshot, and answers a long gap, or a `seq` this log
/// never reached, with a fresh snapshot. A snapshot's history pages back through older events.
#[tokio::test]
async fn a_resume_replays_a_short_gap_and_snapshots_a_long_one() {
    let host = Host::start(temp_dir(), fake(busy()));
    let mut client = host.client().await;
    let thread = working_thread(&host, &mut client).await;
    let start = snapshot(&mut client, thread).await.seq;
    until(&mut client, working()).await;
    let waiting = TurnId::generate();
    dispatch(&mut client, message(thread, waiting, "Later")).await;
    // Each edit is one `queue.updated`: well past what a resume replays.
    for i in 0..130 {
        dispatch(
            &mut client,
            edit(thread, waiting, &format!("Later, take {i}")),
        )
        .await;
    }
    let recent = dispatch(&mut client, edit(thread, waiting, "Later, for good")).await;
    let last = dispatch(&mut client, edit(thread, waiting, "Later, really")).await;

    let mut fresh = host.client().await;
    let short = subscribe(&mut fresh, thread, Some(recent)).await;
    assert!(short.snapshot.is_none(), "a short gap replays");
    let replayed = until(&mut fresh, |event| event.seq == last).await;
    assert_eq!(replayed.len(), 1);
    assert!(
        matches!(&replayed[0].event, ParallaxEvent::QueueUpdated { messages, .. }
        if messages[0].text == "Later, really")
    );

    let long = subscribe(&mut fresh, thread, Some(start)).await;
    let seen = long.snapshot.expect("a long gap gets a snapshot");
    assert!(seen.seq >= last);
    let queued: Vec<_> = seen
        .runs
        .iter()
        .filter(|run| run.status == ThreadRunStatus::Queued)
        .map(|run| run.text.clone())
        .collect();
    assert_eq!(queued, [Some("Later, really".to_owned())]);
    let unknown = subscribe(&mut fresh, thread, Some(last + 1_000)).await;
    assert!(
        unknown.snapshot.is_some(),
        "a seq past the log's head gets a snapshot"
    );

    // History before the snapshot's first event is the rest of the thread.
    let first = seen.events.first().map_or(seen.seq + 1, |event| event.seq);
    let history = fresh
        .call::<OrchestrationThreadHistory>(ThreadHistoryParams {
            thread_id: thread,
            before: first,
        })
        .await
        .unwrap();
    assert!(history.events.iter().all(|event| event.seq < first));
    assert!(!history.more);
}

/// The shell starts from every project, run, and thread, then gets what a sidebar shows: a run's
/// status, but none of its transcript. A held Stop on a thread stops the threads it started.
#[tokio::test]
async fn the_shell_shows_status_and_a_stop_cascades_to_child_threads() {
    let host = Host::start(temp_dir(), fake(busy()));
    let mut client = host.client().await;
    let parent = crate::threads::start_params(None, "Lead");
    let parent_id = parent.run_id;
    client.call::<ThreadStart>(parent).await.unwrap();
    let child = parallax_protocol::ThreadStartParams {
        parent: Some(parent_id),
        ..crate::threads::start_params(None, "Help")
    };
    let child_id = child.run_id;
    client.call::<ThreadStart>(child).await.unwrap();

    let shell = client
        .call::<OrchestrationSubscribeShell>(SubscribeShellParams { after_seq: None })
        .await
        .unwrap()
        .snapshot
        .expect("a first shell subscription has a snapshot");
    let ids: Vec<_> = shell.runs.iter().map(|run| run.id).collect();
    assert!(
        ids.contains(&parent_id) && ids.contains(&child_id),
        "{ids:?}"
    );
    assert_eq!(shell.threads.len(), 2);
    // The child may already be running in the snapshot, with no live event to follow.
    let child_running = shell
        .runs
        .iter()
        .any(|run| run.id == child_id && run.status == AgentStatus::Running);
    if !child_running {
        until(&mut client, |event| {
            matches!(&event.event, ParallaxEvent::AgentUpdated { run_id, state }
                if *run_id == child_id && state.status == AgentStatus::Running)
        })
        .await;
    }

    dispatch(&mut client, stop(parent_id)).await;
    let events = until(&mut client, |event| {
        matches!(&event.event, ParallaxEvent::AgentUpdated { run_id, state }
            if *run_id == child_id && state.status == AgentStatus::Cancelled)
    })
    .await;
    assert!(
        events.iter().all(|event| !matches!(&event.event,
            ParallaxEvent::AgentOutput { items, .. } if items.iter().any(|item| matches!(item, AgentOutputItem::Text { .. })))),
        "the shell gets no transcript"
    );

    // A resume from the shell's last seq replays the short gap.
    let last = events.last().unwrap().seq;
    let mut fresh = host.client().await;
    let resumed = fresh
        .call::<OrchestrationSubscribeShell>(SubscribeShellParams {
            after_seq: Some(last - 1),
        })
        .await
        .unwrap();
    assert!(resumed.snapshot.is_none());
    let replayed = until(&mut fresh, |event| event.seq == last).await;
    assert_eq!(replayed.len(), 1);
}

/// A steer with no target goes to the thread's run under way; with none under way, as after a
/// Stop, it starts a run of its own.
#[tokio::test]
async fn a_steer_with_no_run_under_way_starts_its_own() {
    let host = Host::start(temp_dir(), fake(busy()));
    let mut client = host.client().await;
    let thread = working_thread(&host, &mut client).await;
    subscribe(&mut client, thread, None).await;
    until(&mut client, working()).await;
    dispatch(&mut client, stop(thread)).await;
    until(&mut client, |event| {
        matches!(&event.event, ParallaxEvent::AgentFinished { .. })
    })
    .await;

    let steer = TurnId::generate();
    let mode = DispatchMode::SteerActive {
        target_run_id: None,
    };
    dispatch(&mut client, sent(thread, steer, "Carry on", mode)).await;
    until(&mut client, |event| {
        matches!(&event.event, ParallaxEvent::AgentOutput { items, .. }
            if items.iter().any(|item| matches!(item, AgentOutputItem::TurnStarted { turn_id: Some(id), .. } if *id == steer)))
    })
    .await;
    let runs = snapshot(&mut client, thread).await.runs;
    assert_eq!(
        runs.iter()
            .map(|run| (run.status, run.ordinal))
            .collect::<Vec<_>>(),
        [
            (ThreadRunStatus::Cancelled, Some(1)),
            (ThreadRunStatus::Running, Some(2)),
        ]
    );
}

/// A Project coordinator's Stop ends only its own turn (Ryan, 0059): its queue isn't held, so a
/// message waiting behind the turn starts once the CLI has exited.
#[tokio::test]
async fn a_coordinators_stop_ends_its_turn_and_its_queue_goes_on() {
    let host = Host::start(temp_dir(), fake(busy()));
    let mut client = host.client().await;
    let project = create(&mut client, project_params(host.dir.path())).await;
    let params = crate::coordinator::start_params(project.id, "Plan the release");
    let coordinator = client.call::<ProjectStart>(params).await.unwrap().run.id;
    subscribe(&mut client, coordinator, None).await;
    until(&mut client, working()).await;
    let next = TurnId::generate();
    dispatch(
        &mut client,
        message(coordinator, next, "Then the changelog"),
    )
    .await;
    assert_eq!(queued(&mut client, coordinator).await, [(next, false)]);

    dispatch(&mut client, stop(coordinator)).await;
    until(&mut client, |event| {
        matches!(&event.event, ParallaxEvent::AgentOutput { items, .. }
            if items.iter().any(|item| matches!(item, AgentOutputItem::TurnStarted { turn_id: Some(id), .. } if *id == next)))
    })
    .await;
    let runs: Vec<_> = snapshot(&mut client, coordinator)
        .await
        .runs
        .iter()
        .map(|run| (run.status, run.queue_held))
        .collect();
    assert_eq!(
        runs,
        [
            (ThreadRunStatus::Cancelled, false),
            (ThreadRunStatus::Running, false),
        ]
    );
}
