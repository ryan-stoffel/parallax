//! A run's waiting messages (PLX-370, decision 0048): `queue/*` and `agent/send`'s `delivery`,
//! on the fake CLI, across a restart.

use std::sync::Arc;

use parallax_protocol::jsonrpc::{INTERNAL_ERROR, INVALID_PARAMS};
use parallax_protocol::methods::{
    AgentCancel, AgentSend, AgentStart, QueueCancel, QueueEdit, QueueList, QueueReorder,
    QueueSteer, ThreadStart,
};
use parallax_protocol::{
    AgentCancelParams, AgentDelivery, AgentOutcome, AgentOutputItem, AgentSendParams, AgentStatus,
    ErrorKind, EventsEventParams, ParallaxEvent, Provider, QueueCancelParams, QueueEditParams,
    QueueListParams, QueueReorderParams, QueueSteerParams, QueuedMessage, RunId, TurnId,
};
use plxd::backend::fake::Step;
use plxd::routing::BackendRegistry;

use crate::agents::{
    Conn, Host, create, end_turn, fake, fake_backend, has_item, init, items, outcomes,
    project_params, send_params, start_params, subscribe, text, until, updated_to,
};
use crate::support::{kind, temp_dir};

/// A run's script that reports its session, then works on its first turn until cancelled.
fn busy() -> Vec<Step> {
    vec![init("queue-1"), text("Working"), Step::Hang]
}

fn working() -> impl FnMut(&EventsEventParams) -> bool {
    has_item(AgentOutputItem::Text {
        message_id: None,
        text: "Working".to_owned(),
    })
}

async fn queue(client: &mut Conn, run_id: RunId) -> Vec<TurnId> {
    let listed = client
        .call::<QueueList>(QueueListParams { run_id })
        .await
        .unwrap();
    listed.messages.iter().map(|message| message.id).collect()
}

/// The turns a transcript started with a message, in order, with their text.
fn turns(items: &[AgentOutputItem]) -> Vec<(TurnId, String)> {
    items
        .iter()
        .filter_map(|item| match item {
            AgentOutputItem::TurnStarted {
                turn_id: Some(turn_id),
                text: Some(text),
                ..
            } => Some((*turn_id, text.clone())),
            _ => None,
        })
        .collect()
}

/// Puts `c` first, cancels `b`, and edits `a`, checking what each refuses on the way.
async fn reorder_cancel_and_edit(client: &mut Conn, run_id: RunId, [a, b, c]: [TurnId; 3]) {
    let reordered = client
        .call::<QueueReorder>(QueueReorderParams {
            run_id,
            ids: vec![c, a, b],
        })
        .await
        .unwrap();
    assert_eq!(
        reordered.messages.iter().map(|m| m.id).collect::<Vec<_>>(),
        [c, a, b]
    );
    let partial = client
        .call::<QueueReorder>(QueueReorderParams {
            run_id,
            ids: vec![a, b],
        })
        .await
        .unwrap_err();
    assert_eq!(partial.code, INVALID_PARAMS, "{partial:?}");
    let cancelled = client
        .call::<QueueCancel>(QueueCancelParams { run_id, id: b })
        .await
        .unwrap();
    assert_eq!(cancelled.messages.len(), 2);
    until(
        client,
        has_item(AgentOutputItem::FollowUpDropped { turn_id: b }),
    )
    .await;
    let gone = client
        .call::<QueueCancel>(QueueCancelParams { run_id, id: b })
        .await
        .unwrap_err();
    assert_eq!(kind(&gone), ErrorKind::QueuedMessageNotFound);
    let edited = client
        .call::<QueueEdit>(QueueEditParams {
            run_id,
            id: a,
            text: "First, edited".to_owned(),
        })
        .await
        .unwrap();
    assert_eq!(
        edited.messages,
        [
            QueuedMessage {
                id: c,
                text: "Third".to_owned(),
                images: 0,
                threads: Vec::new(),
            },
            QueuedMessage {
                id: a,
                text: "First, edited".to_owned(),
                images: 0,
                threads: Vec::new(),
            },
        ]
    );
}

/// Messages sent during a turn wait in order, are reordered, edited, and cancelled, survive a
/// restart, and the next plxd sends them in their order: the first to a resumed session, the
/// next to the same CLI once its turn has ended.
#[tokio::test]
async fn waiting_messages_are_edited_reordered_cancelled_and_sent_in_order_after_a_restart() {
    let host = Host::start(temp_dir(), fake(busy()));
    let mut client = host.client().await;
    let project = create(&mut client, project_params(host.dir.path())).await;
    subscribe(&mut client, project.id, 0).await;
    let params = start_params(project.id, "Work for a while");
    let run_id = params.run_id;
    client.call::<AgentStart>(params).await.unwrap();
    until(&mut client, working()).await;

    let other = crate::threads::start_params(None, "Another thread");
    let other_id = other.run_id;
    client.call::<ThreadStart>(other).await.unwrap();

    let (a, b, c) = (TurnId::generate(), TurnId::generate(), TurnId::generate());
    for (turn, message) in [(a, "First"), (b, "Second"), (c, "Third")] {
        // The second has a thread attached, which clients see while it waits, and the other
        // thread sends the third, which its turn still names after the restart.
        let threads = if turn == b {
            vec![other_id]
        } else {
            Vec::new()
        };
        let from = (turn == c).then_some(other_id);
        let sent = client
            .call::<AgentSend>(AgentSendParams {
                threads,
                from,
                ..send_params(run_id, turn, message)
            })
            .await
            .unwrap();
        assert_eq!(sent.run.status, AgentStatus::Running);
    }
    let updated = until(&mut client, |event| {
        matches!(&event.event, ParallaxEvent::QueueUpdated { messages, .. } if messages.len() == 3)
    })
    .await;
    assert!(
        matches!(&updated.last().unwrap().event, ParallaxEvent::QueueUpdated { run_id: id, messages }
            if *id == run_id && messages[1].threads == [other_id])
    );
    assert_eq!(queue(&mut client, run_id).await, [a, b, c]);

    reorder_cancel_and_edit(&mut client, run_id, [a, b, c]).await;
    let seq = until(&mut client, |event| {
        matches!(&event.event, ParallaxEvent::QueueUpdated { messages, .. }
            if messages.iter().any(|m| m.text == "First, edited"))
    })
    .await
    .last()
    .unwrap()
    .seq;
    drop(client);

    // The next plxd resumes the session with the first message; the second goes to the same CLI
    // once that turn has ended.
    let next = vec![
        init("queue-1"),
        end_turn("Did the third."),
        Step::AwaitFollowUp,
        end_turn("Did the first."),
    ];
    let host = host.restart(fake(next)).await;
    let mut client = host.client().await;
    subscribe(&mut client, project.id, seq).await;
    let events = until(&mut client, updated_to(AgentStatus::Completed)).await;
    assert_eq!(
        outcomes(&events)[0],
        AgentOutcome::Interrupted,
        "the restart interrupted the first turn"
    );
    let transcript = items(&events);
    assert_eq!(
        turns(&transcript),
        [(c, "Third".to_owned()), (a, "First, edited".to_owned())]
    );
    assert!(transcript.iter().any(|item| matches!(item,
        AgentOutputItem::TurnStarted { turn_id: Some(turn), from: Some(from), .. }
            if *turn == c && *from == other_id)));
    assert!(transcript.contains(&AgentOutputItem::Text {
        message_id: None,
        text: "First, edited".to_owned(),
    }));
    assert!(queue(&mut client, run_id).await.is_empty());
    host.server.stop().await;
}

/// A message plxd can't store isn't queued: `agent/send` answers with the store's error, and the
/// queue stays empty.
#[tokio::test]
async fn a_message_that_cant_be_stored_is_refused() {
    let host = Host::start(temp_dir(), fake(busy()));
    let mut client = host.client().await;
    let project = create(&mut client, project_params(host.dir.path())).await;
    subscribe(&mut client, project.id, 0).await;
    let params = start_params(project.id, "Work for a while");
    let run_id = params.run_id;
    client.call::<AgentStart>(params).await.unwrap();
    until(&mut client, working()).await;

    // The store refuses the queue's write at once. Holding SQLite's write lock instead would
    // make every write, the event log's included, wait out the 5 s busy timeout in turn, which
    // can outlast the client's patience.
    rusqlite::Connection::open(host.dir.path().join("plxd.sqlite3"))
        .unwrap()
        .execute_batch(
            "CREATE TRIGGER refuse_queued BEFORE INSERT ON queued
             BEGIN SELECT RAISE(ABORT, 'refused by the test'); END;",
        )
        .unwrap();
    let refused = client
        .call::<AgentSend>(send_params(run_id, TurnId::generate(), "Then this"))
        .await
        .unwrap_err();
    assert!(
        refused.message.contains("refused by the test"),
        "{refused:?}"
    );
    assert_eq!(queue(&mut client, run_id).await, []);
    host.server.stop().await;
}

/// `/compact` (PLX-638) on a backend that can't compact its context, here the fake CLI, is
/// refused rather than queued for it.
#[tokio::test]
async fn compact_is_refused_on_a_backend_that_cant_compact() {
    let host = Host::start(temp_dir(), fake(busy()));
    let mut client = host.client().await;
    let project = create(&mut client, project_params(host.dir.path())).await;
    subscribe(&mut client, project.id, 0).await;
    let params = start_params(project.id, "Work for a while");
    let run_id = params.run_id;
    client.call::<AgentStart>(params).await.unwrap();
    until(&mut client, working()).await;

    let refused = client
        .call::<AgentSend>(send_params(run_id, TurnId::generate(), " /compact "))
        .await
        .unwrap_err();
    assert_eq!(kind(&refused), ErrorKind::UnsupportedOption);
    assert!(
        refused.message.ends_with("can't compact its context"),
        "{refused:?}"
    );
    assert_eq!(queue(&mut client, run_id).await, []);
    host.server.stop().await;
}

/// Failed edits, reorders, and cancellations leave both queues and the event log unchanged.
#[tokio::test]
async fn queue_mutations_that_cant_be_stored_are_refused() {
    let host = Host::start(temp_dir(), fake(busy()));
    let mut client = host.client().await;
    let project = create(&mut client, project_params(host.dir.path())).await;
    subscribe(&mut client, project.id, 0).await;
    let params = start_params(project.id, "Work for a while");
    let run_id = params.run_id;
    client.call::<AgentStart>(params).await.unwrap();
    until(&mut client, working()).await;

    let (a, b) = (TurnId::generate(), TurnId::generate());
    for (turn, message) in [(a, "First"), (b, "Second")] {
        client
            .call::<AgentSend>(send_params(run_id, turn, message))
            .await
            .unwrap();
    }
    let original = client
        .call::<QueueList>(QueueListParams { run_id })
        .await
        .unwrap();
    let db_path = host.dir.path().join("plxd.sqlite3");
    let stored = parallax_store::Store::open(&db_path).unwrap();
    let original_rows = stored.queue(run_id.into()).unwrap();
    let db = rusqlite::Connection::open(&db_path).unwrap();
    let seq: i64 = db
        .query_row("SELECT COALESCE(MAX(seq), 0) FROM events", [], |row| {
            row.get(0)
        })
        .unwrap();
    // set_queue deletes then inserts within a transaction. Rejecting the insert also verifies
    // that its deletion rolls back, including when cancel leaves one remaining message.
    db.execute_batch(
        "CREATE TRIGGER refuse_queued BEFORE INSERT ON queued
         BEGIN SELECT RAISE(ABORT, 'refused by the test'); END;",
    )
    .unwrap();
    for operation in ["edit", "reorder", "cancel"] {
        let refused = match operation {
            "edit" => {
                client
                    .call::<QueueEdit>(QueueEditParams {
                        run_id,
                        id: a,
                        text: "Edited".to_owned(),
                    })
                    .await
            }
            "reorder" => {
                client
                    .call::<QueueReorder>(QueueReorderParams {
                        run_id,
                        ids: vec![b, a],
                    })
                    .await
            }
            "cancel" => {
                client
                    .call::<QueueCancel>(QueueCancelParams { run_id, id: a })
                    .await
            }
            _ => unreachable!(),
        }
        .unwrap_err();
        assert_eq!(refused.code, INTERNAL_ERROR, "{operation}: {refused:?}");
        assert!(
            refused.message.contains("refused by the test"),
            "{refused:?}"
        );
        assert_eq!(
            client
                .call::<QueueList>(QueueListParams { run_id })
                .await
                .unwrap()
                .messages,
            original.messages,
            "{operation} changed the actor queue"
        );
        assert_eq!(stored.queue(run_id.into()).unwrap(), original_rows);
        let events: i64 = db
            .query_row("SELECT COUNT(*) FROM events WHERE seq > ?1", [seq], |row| {
                row.get(0)
            })
            .unwrap();
        assert_eq!(
            events, 0,
            "{operation} emitted events despite its storage failure"
        );
    }

    db.execute_batch("DROP TRIGGER refuse_queued").unwrap();
    client
        .call::<QueueCancel>(QueueCancelParams { run_id, id: a })
        .await
        .unwrap();
    until(
        &mut client,
        has_item(AgentOutputItem::FollowUpDropped { turn_id: a }),
    )
    .await;
    assert_eq!(queue(&mut client, run_id).await, [b]);
    host.server.stop().await;
}

/// A steer goes into the running turn ahead of what waits, which follows once both turns end; a
/// steer can't change the run's model.
#[tokio::test]
async fn a_steer_goes_into_the_running_turn_ahead_of_waiting_messages() {
    let script = vec![
        init("steer-1"),
        text("Working"),
        Step::AwaitFollowUp,
        end_turn("Started."),
        end_turn("Steered."),
        Step::AwaitFollowUp,
        end_turn("Queued."),
    ];
    let host = Host::start(temp_dir(), fake(script));
    let mut client = host.client().await;
    let project = create(&mut client, project_params(host.dir.path())).await;
    subscribe(&mut client, project.id, 0).await;
    let params = start_params(project.id, "Work for a while");
    let run_id = params.run_id;
    client.call::<AgentStart>(params).await.unwrap();
    until(&mut client, working()).await;

    let (queued, steered) = (TurnId::generate(), TurnId::generate());
    client
        .call::<AgentSend>(send_params(run_id, queued, "Then this"))
        .await
        .unwrap();
    client
        .call::<AgentSend>(send_params(run_id, steered, "Change course"))
        .await
        .unwrap();
    let refused = client
        .call::<AgentSend>(AgentSendParams {
            model: Some("sonnet".to_owned()),
            delivery: Some(AgentDelivery::Steer),
            ..send_params(run_id, TurnId::generate(), "Faster")
        })
        .await
        .unwrap_err();
    assert_eq!(kind(&refused), ErrorKind::UnsupportedOption);

    let left = client
        .call::<QueueSteer>(QueueSteerParams {
            run_id,
            id: steered,
        })
        .await
        .unwrap();
    assert_eq!(
        left.messages.iter().map(|m| m.id).collect::<Vec<_>>(),
        [queued]
    );
    let events = until(&mut client, updated_to(AgentStatus::Completed)).await;
    let transcript = items(&events);
    assert_eq!(
        turns(&transcript),
        [
            (steered, "Change course".to_owned()),
            (queued, "Then this".to_owned())
        ]
    );
    let read: Vec<_> = transcript
        .iter()
        .filter_map(|item| match item {
            AgentOutputItem::Text { text, .. } if text != "Working" => Some(text.as_str()),
            _ => None,
        })
        .collect();
    assert_eq!(read, ["Change course", "Then this"]);
    host.server.stop().await;
}

/// On a backend that takes no messages while it runs, a steer cancels the turn and resumes the
/// session with the message.
#[tokio::test]
async fn a_steer_interrupts_a_cli_that_takes_no_messages_and_resumes_with_it() {
    let mut backends = BackendRegistry::new();
    backends.register(
        Provider::Anthropic,
        Arc::new(fake_backend(busy()).without_follow_ups()),
    );
    let host = Host::start(temp_dir(), backends);
    let mut client = host.client().await;
    let project = create(&mut client, project_params(host.dir.path())).await;
    subscribe(&mut client, project.id, 0).await;
    let params = start_params(project.id, "Work for a while");
    let run_id = params.run_id;
    client.call::<AgentStart>(params).await.unwrap();
    until(&mut client, working()).await;

    let turn = TurnId::generate();
    let steered = client
        .call::<AgentSend>(AgentSendParams {
            delivery: Some(AgentDelivery::Steer),
            ..send_params(run_id, turn, "Stop and do this")
        })
        .await
        .unwrap();
    assert_eq!(steered.run.status, AgentStatus::Running);
    let events = until(
        &mut client,
        has_item(AgentOutputItem::TurnStarted {
            turn_id: Some(turn),
            text: Some("Stop and do this".to_owned()),
            wake: false,
            from: None,
            images: Vec::new(),
            threads: Vec::new(),
        }),
    )
    .await;
    assert_eq!(outcomes(&events), [AgentOutcome::Cancelled]);
    client
        .call::<AgentCancel>(AgentCancelParams { run_id, from: None })
        .await
        .unwrap();
    until(&mut client, updated_to(AgentStatus::Cancelled)).await;
    host.server.stop().await;
}

#[tokio::test]
async fn a_steer_receipt_failure_retains_the_error_and_removes_the_delivered_queue_entry() {
    // First allow error receipts, then fail every UPDATE. DELETE is allowed in both cases.
    for persistent in [false, true] {
        let script = vec![
            init("receipt-steer"),
            text("Working"),
            Step::AwaitFollowUp,
            text("Steered once"),
            Step::Hang,
        ];
        let host = Host::start(temp_dir(), fake(script));
        let mut client = host.client().await;
        let project = create(&mut client, project_params(host.dir.path())).await;
        subscribe(&mut client, project.id, 0).await;
        let params = start_params(project.id, "Work");
        let run_id = params.run_id;
        client.call::<AgentStart>(params).await.unwrap();
        until(&mut client, working()).await;
        let turn = TurnId::generate();
        client
            .call::<AgentSend>(send_params(run_id, turn, "Change course"))
            .await
            .unwrap();
        let db = rusqlite::Connection::open(host.dir.path().join("plxd.sqlite3")).unwrap();
        let condition = if persistent {
            "1"
        } else {
            "json_extract(NEW.result, '$.code') IS NULL"
        };
        db.execute_batch(&format!(
            "CREATE TRIGGER fail_steer_receipt BEFORE UPDATE ON command_receipts WHEN {condition} BEGIN SELECT RAISE(FAIL, 'steer receipt failed'); END;"
        )).unwrap();
        let mut commands = crate::support::Client::ready(&host.server.socket).await;
        let id = uuid::Uuid::now_v7();
        let params = QueueSteerParams { run_id, id: turn };
        let first =
            crate::commands::call_with_command::<QueueSteer>(&mut commands, params.clone(), id)
                .await
                .unwrap_err();
        assert!(first.message.contains("steer receipt failed"), "{first:?}");
        // The backend's output proves steering succeeded before the receipt failed.
        until(
            &mut client,
            has_item(AgentOutputItem::Text {
                message_id: None,
                text: "Steered once".to_owned(),
            }),
        )
        .await;
        let retry = tokio::time::timeout(
            std::time::Duration::from_secs(2),
            crate::commands::call_with_command::<QueueSteer>(&mut commands, params, id),
        )
        .await
        .expect("partial command retry must terminate")
        .unwrap_err();
        assert_eq!(retry, first);
        assert!(queue(&mut client, run_id).await.is_empty());
        let left: i64 = db
            .query_row(
                "SELECT COUNT(*) FROM queued WHERE run_id = ?1",
                [run_id.to_string()],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(left, 0, "delivered message must not remain queued on disk");
        let stored: Option<String> = db
            .query_row(
                "SELECT result FROM command_receipts WHERE command_id = ?1",
                [id.to_string()],
                |row| row.get(0),
            )
            .unwrap();
        if persistent {
            assert!(
                stored.is_none(),
                "claim must survive even when error persistence fails"
            );
        } else {
            assert_eq!(
                serde_json::from_str::<parallax_protocol::jsonrpc::ErrorObject>(&stored.unwrap())
                    .unwrap(),
                first
            );
        }
        host.server.stop().await;
    }
}
