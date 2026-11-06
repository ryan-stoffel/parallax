//! An orchestrator's inbox end to end (PLX-401, decision 0043): each source adds its item and
//! appends `inbox.added`, and `inbox/list` and `inbox/seen` read and mark them.

use std::sync::{Arc, Mutex};

use parallax_protocol::methods::{
    AgentStart, InboxList, InboxSeen, OrchestratorList, OrchestratorStart,
};
use parallax_protocol::{
    AgentStartParams, AgentStatus, ErrorKind, InboxItem, InboxKind, InboxListParams,
    InboxSeenParams, OrchestratorListParams, OrchestratorThreadId, ParallaxEvent, ScopeId,
};
use parallax_store::WakeState;
use plxd::backend::fake::Step;
use plxd::paths::DataDir;

use crate::agents::{Conn, Host, end_turn, fake, init, start_params, subscribe, until, updated_to};
use crate::orchestrator::{nth_launch, orchestrator_launches, roles, spawn};
use crate::support::{kind, temp_dir};

/// A run `orchestrator`'s orchestrator started, as its `spawn_agent` tool starts one.
fn child(orchestrator: ScopeId, task: &str) -> AgentStartParams {
    AgentStartParams {
        orchestrator_thread: Some(OrchestratorThreadId::generate()),
        ..start_params(orchestrator, task)
    }
}

/// The next `inbox.added`, checked to be on `orchestrator`'s events.
pub(crate) async fn added(client: &mut Conn, orchestrator: ScopeId) -> InboxItem {
    let events = until(client, |event| {
        matches!(event.event, ParallaxEvent::InboxAdded { .. })
    })
    .await;
    let event = events.last().unwrap();
    assert_eq!(event.project, Some(orchestrator));
    let ParallaxEvent::InboxAdded { item } = &event.event else {
        unreachable!();
    };
    item.clone()
}

async fn list(client: &mut Conn, orchestrator: ScopeId) -> Vec<InboxItem> {
    client
        .call::<InboxList>(InboxListParams { orchestrator })
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
    let (mut client, orchestrator) = host.orchestrator_client().await;

    let run = client
        .call::<AgentStart>(child(
            orchestrator.id,
            "Rewrite the README.\nKeep it short.",
        ))
        .await
        .unwrap()
        .run
        .id;
    let item = added(&mut client, orchestrator.id).await;
    assert_eq!(item.kind, InboxKind::Done);
    assert_eq!(item.run, run);
    assert_eq!(item.text, "Rewrite the README.: done, 1 files (+1 -1)");
    assert_eq!(item.seen_at, None);
    assert_eq!(
        list(&mut client, orchestrator.id).await,
        std::slice::from_ref(&item)
    );

    let seen = client
        .call::<InboxSeen>(InboxSeenParams {
            orchestrator: orchestrator.id,
            items: vec![item.id],
        })
        .await
        .unwrap()
        .items;
    let seen_at = seen[0].seen_at.expect("marked seen");
    let again = client
        .call::<InboxSeen>(InboxSeenParams {
            orchestrator: orchestrator.id,
            items: vec![item.id],
        })
        .await
        .unwrap()
        .items;
    assert_eq!(again[0].seen_at, Some(seen_at), "the first time is kept");
    assert_eq!(list(&mut client, orchestrator.id).await, seen);

    let unknown = client
        .call::<InboxList>(InboxListParams {
            orchestrator: ScopeId::generate(),
        })
        .await
        .unwrap_err();
    assert_eq!(kind(&unknown), ErrorKind::OrchestratorNotFound);
    host.server.stop().await;
}

/// 0043: an orchestrator takes 100 wake-up turns in a row with no message from the user. The next
/// one pauses its wake-ups instead, and that adds `needsYou` about the orchestrator.
#[tokio::test]
async fn the_wake_up_after_the_hundredth_in_a_row_pauses_and_adds_needs_you() {
    let seen = Arc::new(Mutex::new(Vec::new()));
    let done = || vec![init("worker-1"), end_turn("Done.")];
    let turn = |result: &str| vec![init("orchestrator-1"), end_turn(result)];
    let host = Host::start(temp_dir(), roles(done(), vec![turn("Planned.")], &seen));
    let (mut client, orchestrator) = host.orchestrator_client().await;
    let orchestrator_run = client
        .call::<OrchestratorStart>(crate::orchestrator::start_params(orchestrator.id, "Plan."))
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
        ..store.wake_state(orchestrator_run.id.into()).unwrap()
    };
    store
        .set_wake_state(orchestrator_run.id.into(), state)
        .unwrap();
    drop(store);

    let backends = roles(done(), vec![turn("Reviewed.")], &seen);
    let host = Host::start(host.dir, backends);
    let mut client = host.client().await;
    let seq = client
        .call::<OrchestratorList>(OrchestratorListParams {})
        .await
        .unwrap()
        .seq;
    subscribe(&mut client, orchestrator.id, seq).await;
    spawn(&mut client, &orchestrator_run, "Add a README.").await;
    nth_launch(&seen, 1).await;
    until(&mut client, |event| {
        matches!(&event.event, ParallaxEvent::AgentUpdated { run_id, state }
            if *run_id == orchestrator_run.id && state.status == AgentStatus::Completed)
    })
    .await;

    spawn(&mut client, &orchestrator_run, "Add a license.").await;
    let paused = loop {
        let item = added(&mut client, orchestrator.id).await;
        if item.kind == InboxKind::NeedsYou {
            break item;
        }
    };
    assert_eq!(paused.run, orchestrator_run.id);
    assert!(
        paused.text.starts_with("Wake-ups paused."),
        "{}",
        paused.text
    );
    assert_eq!(
        orchestrator_launches(&seen).len(),
        2,
        "the hundredth woke it"
    );
    host.server.stop().await;
    let store =
        parallax_store::Store::open(DataDir::new(host.dir.path()).unwrap().store_file()).unwrap();
    let state = store.wake_state(orchestrator_run.id.into()).unwrap();
    assert_eq!((state.in_a_row, state.paused), (100, true));
}
