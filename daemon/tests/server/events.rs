//! `events/subscribe`, `events/event`, and `events/unsubscribe`.

use std::path::Path;

use parallax_protocol::jsonrpc::{Message, Notification};
use parallax_protocol::methods::{
    EventsSubscribe, NotificationMethod, OrchestratorCreate, OrchestratorList,
};
use parallax_protocol::{
    ErrorKind, EventsEventParams, EventsSubscribeParams, Orchestrator, OrchestratorListParams,
    ParallaxEvent, SubscriptionId,
};

use crate::support::{Client, InProcess, Plxd, create_params, kind, temp_dir};

async fn create(client: &mut Client, dir: &Path, name: &str) -> Orchestrator {
    client
        .call::<OrchestratorCreate>(create_params(dir, name))
        .await
        .unwrap()
        .orchestrator
}

async fn subscribe(client: &mut Client, after: u64) -> SubscriptionId {
    client
        .call::<EventsSubscribe>(EventsSubscribeParams {
            after,
            project: None,
            run: None,
            shell: false,
        })
        .await
        .unwrap()
        .subscription
}

async fn event(client: &mut Client) -> EventsEventParams {
    match client.next().await {
        Some(Message::Notification(Notification { method, params })) => {
            assert_eq!(
                method,
                <parallax_protocol::methods::EventsEvent as NotificationMethod>::NAME
            );
            serde_json::from_value(params.expect("params")).expect("an event")
        }
        other => panic!("expected an event, got {other:?}"),
    }
}

fn created(event: &EventsEventParams) -> &Orchestrator {
    match &event.event {
        ParallaxEvent::OrchestratorCreated { orchestrator } => orchestrator,
        other => panic!("expected orchestrator.created, got {other:?}"),
    }
}

#[tokio::test]
async fn subscribers_get_the_replay_then_live_events_on_every_connection() {
    let dir = temp_dir();
    let plxd = Plxd::start(dir.path()).await;
    let mut creator = Client::ready(&plxd.socket).await;
    let first = create(&mut creator, dir.path(), "parallax").await;

    let mut replaying = Client::ready(&plxd.socket).await;
    let replay = subscribe(&mut replaying, 0).await;
    let replayed = event(&mut replaying).await;
    assert_eq!(replayed.subscription, replay);
    assert_eq!(replayed.seq, 1);
    assert_eq!(replayed.project, None, "orchestrator.created is host-level");
    assert_eq!(replayed.time, first.created_at);
    assert_eq!(created(&replayed), &first);

    let mut live = Client::ready(&plxd.socket).await;
    let snapshot = live
        .call::<OrchestratorList>(OrchestratorListParams {})
        .await
        .unwrap();
    let live_subscription = subscribe(&mut live, snapshot.seq).await;

    let second = create(&mut creator, dir.path(), "roster").await;
    for (client, subscription) in [(&mut replaying, replay), (&mut live, live_subscription)] {
        let delivered = event(client).await;
        assert_eq!(delivered.subscription, subscription);
        assert_eq!(delivered.seq, 2);
        assert_eq!(created(&delivered), &second);
    }
}

#[tokio::test]
async fn events_older_than_the_retention_need_a_resync() {
    let dir = temp_dir();
    let mut config = InProcess::config(dir.path());
    config.event_retention = 2;
    let server = InProcess::start(config);
    let mut client = Client::ready(&server.socket).await;
    for name in ["a", "b", "c"] {
        create(&mut client, dir.path(), name).await;
    }

    let error = client
        .call::<EventsSubscribe>(EventsSubscribeParams {
            after: 0,
            project: None,
            run: None,
            shell: false,
        })
        .await
        .unwrap_err();
    assert_eq!(kind(&error), ErrorKind::ResyncRequired);

    subscribe(&mut client, 1).await;
    assert_eq!(event(&mut client).await.seq, 2);
    assert_eq!(event(&mut client).await.seq, 3);
    drop(client);
    server.stop().await;
}

#[tokio::test]
async fn events_reach_a_subscriber_while_it_is_also_making_requests() {
    let dir = temp_dir();
    let plxd = Plxd::start(dir.path()).await;
    let mut client = Client::ready(&plxd.socket).await;
    client
        .call::<EventsSubscribe>(EventsSubscribeParams {
            after: 0,
            project: None,
            run: None,
            shell: false,
        })
        .await
        .unwrap();
    let create = client
        .send::<OrchestratorCreate>(create_params(dir.path(), "parallax"))
        .await;
    let mut saw_answer = false;
    let mut saw_event = false;
    while !(saw_answer && saw_event) {
        match client.next().await.expect("a message") {
            Message::Response(response) => {
                assert_eq!(response.id, Some(create.clone()));
                saw_answer = true;
            }
            Message::Notification(notification) => {
                assert_eq!(notification.method, "events/event");
                saw_event = true;
            }
            Message::Request(request) => panic!("unexpected request {request:?}"),
        }
    }
}
