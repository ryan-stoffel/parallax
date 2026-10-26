//! A Project's inbox end to end (PLX-401, decision 0043): each source adds its item and appends
//! `inbox.added`, and `inbox/list` and `inbox/seen` read and mark them.

use std::sync::{Arc, Mutex};

use parallax_protocol::methods::{AgentStart, InboxList, InboxSeen, ProjectList, ProjectStart};
use parallax_protocol::{
    AgentStartParams, AgentStatus, CoordinatorThreadId, ErrorKind, InboxItem, InboxKind,
    InboxListParams, InboxSeenParams, ParallaxEvent, ProjectId, ProjectListParams,
};
use parallax_store::WakeState;
use plxd::backend::fake::Step;
use plxd::paths::DataDir;

use crate::agents::{Conn, Host, end_turn, fake, init, start_params, subscribe, until, updated_to};
use crate::coordinator::{coordinator_launches, nth_launch, roles, spawn};
use crate::support::{kind, temp_dir};

/// A run `project`'s coordinator started, as its `spawn_agent` tool starts one.
fn child(project: ProjectId, task: &str) -> AgentStartParams {
    AgentStartParams {
        coordinator_thread: Some(CoordinatorThreadId::generate()),
        ..start_params(project, task)
    }
}

/// The next `inbox.added`, checked to be on `project`'s events.
pub(crate) async fn added(client: &mut Conn, project: ProjectId) -> InboxItem {
    let events = until(client, |event| {
        matches!(event.event, ParallaxEvent::InboxAdded { .. })
    })
    .await;
    let event = events.last().unwrap();
    assert_eq!(event.project, Some(project));
    let ParallaxEvent::InboxAdded { item } = &event.event else {
        unreachable!();
    };
    item.clone()
}

async fn list(client: &mut Conn, project: ProjectId) -> Vec<InboxItem> {
    client
        .call::<InboxList>(InboxListParams { project })
        .await
        .unwrap()
        .items
}

/// A child that finishes adds `done` with its diff stats, and `inbox/seen` marks the item once.
#[tokio::test]
async fn a_child_finishing_adds_done_with_its_diff_stats_and_seen_marks_it() {
    let host = Host::start(
        temp_dir(),
        fake(vec![
            init("session-1"),
            Step::WriteFile {
                path: "README.md".to_owned(),
                content: "# App\n".to_owned(),
            },
            end_turn("Done."),
        ]),
    );
    let (mut client, project) = host.project_client().await;

    let run = client
        .call::<AgentStart>(child(project.id, "Rewrite the README.\nKeep it short."))
        .await
        .unwrap()
        .run
        .id;
    let item = added(&mut client, project.id).await;
    assert_eq!(item.kind, InboxKind::Done);
    assert_eq!(item.run, run);
    assert_eq!(item.text, "Rewrite the README.: done, 1 files (+1 -1)");
    assert_eq!(item.seen_at, None);
    assert_eq!(
        list(&mut client, project.id).await,
        std::slice::from_ref(&item)
    );

    let seen = client
        .call::<InboxSeen>(InboxSeenParams {
            project: project.id,
            items: vec![item.id],
        })
        .await
        .unwrap()
        .items;
    let seen_at = seen[0].seen_at.expect("marked seen");
    let again = client
        .call::<InboxSeen>(InboxSeenParams {
            project: project.id,
            items: vec![item.id],
        })
        .await
        .unwrap()
        .items;
    assert_eq!(again[0].seen_at, Some(seen_at), "the first time is kept");
    assert_eq!(list(&mut client, project.id).await, seen);

    let unknown = client
        .call::<InboxList>(InboxListParams {
            project: ProjectId::generate(),
        })
        .await
        .unwrap_err();
    assert_eq!(kind(&unknown), ErrorKind::ProjectNotFound);
    host.server.stop().await;
}

/// 0043: a coordinator takes 100 wake-up turns in a row with no message from the user. The next
/// one pauses its wake-ups instead, and that adds `needsYou` about the coordinator.
#[tokio::test]
async fn the_wake_up_after_the_hundredth_in_a_row_pauses_and_adds_needs_you() {
    let seen = Arc::new(Mutex::new(Vec::new()));
    let done = || vec![init("worker-1"), end_turn("Done.")];
    let turn = |result: &str| vec![init("coordinator-1"), end_turn(result)];
    let host = Host::start(temp_dir(), roles(done(), vec![turn("Planned.")], &seen));
    let (mut client, project) = host.project_client().await;
    let coordinator = client
        .call::<ProjectStart>(crate::coordinator::start_params(project.id, "Plan."))
        .await
        .unwrap()
        .run;
    until(&mut client, updated_to(AgentStatus::Completed)).await;
    host.server.stop().await;
    let store =
        parallax_store::Store::open(DataDir::new(host.dir.path()).unwrap().store_file()).unwrap();
    let state = WakeState {
        in_a_row: 99,
        paused: false,
        ..store.wake_state(coordinator.id.into()).unwrap()
    };
    store.set_wake_state(coordinator.id.into(), state).unwrap();
    drop(store);

    let backends = roles(done(), vec![turn("Reviewed.")], &seen);
    let host = Host::start(host.dir, backends);
    let mut client = host.client().await;
    let seq = client
        .call::<ProjectList>(ProjectListParams {})
        .await
        .unwrap()
        .seq;
    subscribe(&mut client, project.id, seq).await;
    spawn(&mut client, &coordinator, "Add a README.").await;
    nth_launch(&seen, 1).await;
    until(&mut client, |event| {
        matches!(&event.event, ParallaxEvent::AgentUpdated { run_id, state }
            if *run_id == coordinator.id && state.status == AgentStatus::Completed)
    })
    .await;

    spawn(&mut client, &coordinator, "Add a license.").await;
    let paused = loop {
        let item = added(&mut client, project.id).await;
        if item.kind == InboxKind::NeedsYou {
            break item;
        }
    };
    assert_eq!(paused.run, coordinator.id);
    assert!(
        paused.text.starts_with("Wake-ups paused."),
        "{}",
        paused.text
    );
    assert_eq!(
        coordinator_launches(&seen).len(),
        2,
        "the hundredth woke it"
    );
    host.server.stop().await;
    let store =
        parallax_store::Store::open(DataDir::new(host.dir.path()).unwrap().store_file()).unwrap();
    let state = store.wake_state(coordinator.id.into()).unwrap();
    assert_eq!((state.in_a_row, state.paused), (100, true));
}
