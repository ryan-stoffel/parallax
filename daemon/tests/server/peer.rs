//! The client one plxd uses for another (0057), over Parallax Connect's TCP port with a fake
//! tailnet and the device's listener on loopback. The home plxd's side is just the client: nothing
//! in plxd calls it yet.

use std::collections::VecDeque;
use std::sync::atomic::Ordering;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use parallax_protocol::methods::{EventsSubscribe, HostHealth, ProjectCreate};
use parallax_protocol::{
    EventsSubscribeParams, HostHealthParams, HostHealthResult, ParallaxEvent, Project,
};
use plxd::peer::{Incoming, Peers, Plxd};
use plxd::tailnet::Tailnet;
use tokio::sync::mpsc::{self, UnboundedReceiver};
use tokio::time::{Instant, sleep, timeout};

use crate::connect::{
    FakeTailnet, ME, SOMEONE_ELSE, free_port, set_connect, start, start_with, whois,
};
use crate::support::{Client, PATIENCE, create_params};

/// A tailnet whose `whois` answers `ME` for the next `connections` connections.
fn admitting(connections: usize) -> Arc<FakeTailnet> {
    Arc::new(FakeTailnet {
        whois: Mutex::new((0..connections).map(|_| Ok(whois(ME))).collect()),
        ..FakeTailnet::default()
    })
}

fn peers(tailnet: &Arc<FakeTailnet>, port: u16) -> Peers {
    Peers::new(Arc::clone(tailnet) as Arc<dyn Tailnet>, port)
}

/// `call` until it succeeds or the deadline passes, since the listener binds after
/// `set_connect` returns. A refused connection never reaches `whois`, so the fake's answers go
/// to the connections that do.
async fn once_listening<T>(mut call: impl AsyncFnMut() -> Result<T, String>) -> Result<T, String> {
    let deadline = Instant::now() + PATIENCE;
    loop {
        match call().await {
            Err(_) if Instant::now() < deadline => sleep(Duration::from_millis(20)).await,
            answer => return answer,
        }
    }
}

/// `host/health`, a call with no effect on the device. `connect/devices` would probe the fake's
/// loopback peers and use up `whois` answers.
async fn health(peer: &Plxd) -> Result<HostHealthResult, String> {
    peer.call::<HostHealth>(HostHealthParams {}).await
}

fn subscription() -> EventsSubscribeParams {
    EventsSubscribeParams {
        after: 0,
        project: None,
        run: None,
        shell: false,
    }
}

async fn next(incoming: &mut UnboundedReceiver<Incoming>) -> Incoming {
    timeout(PATIENCE, incoming.recv())
        .await
        .expect("a notification")
        .expect("the channel stays open")
}

/// The next `project.created` event, skipping the host's other events.
async fn next_created(incoming: &mut UnboundedReceiver<Incoming>) -> (u64, Project) {
    loop {
        match next(incoming).await {
            Incoming::Event(event) => {
                if let ParallaxEvent::ProjectCreated { project } = event.event {
                    return (event.seq, project);
                }
            }
            Incoming::Reconnected => panic!("expected an event, got a reconnect"),
        }
    }
}

#[tokio::test]
async fn only_a_device_that_serves_this_node_answers() {
    let port = free_port();
    let tailnet = Arc::new(FakeTailnet {
        whois: Mutex::new(VecDeque::from([Ok(whois(ME)), Ok(whois(SOMEONE_ELSE))])),
        ..FakeTailnet::default()
    });
    let (_dir, server, _client) = start(Arc::clone(&tailnet), port).await;
    let peers = peers(&tailnet, port);

    once_listening(async || health(&peers.client("a")).await)
        .await
        .expect("an untagged node of the same user is served");
    // The device's whois names another user for the next connection, so it closes it.
    let refused = health(&Plxd::tailnet(tailnet.clone(), "a".to_owned(), port))
        .await
        .expect_err("the device refuses this node");
    assert!(
        refused.starts_with("the connection to plxd failed"),
        "{refused}"
    );

    // The filter turns these away before any connection: the queue has no answer left.
    for (node, said) in [
        ("b", "b-laptop is offline"),
        ("s", "s isn't one of this computer's devices"),
        ("t", "t isn't one of this computer's devices"),
        ("nobody", "nobody isn't one of this computer's devices"),
    ] {
        assert_eq!(health(&peers.client(node)).await.unwrap_err(), said);
    }
    server.stop().await;
}

#[tokio::test]
async fn a_tagged_this_node_reaches_nobody() {
    let port = free_port();
    let tailnet = Arc::new(FakeTailnet {
        whois: Mutex::new(VecDeque::from([Ok(whois(ME))])),
        tags: vec!["tag:server".to_owned()],
        ..FakeTailnet::default()
    });
    let (_dir, server, _client) = start(Arc::clone(&tailnet), port).await;
    assert_eq!(
        health(&peers(&tailnet, port).client("a"))
            .await
            .unwrap_err(),
        "a isn't one of this computer's devices"
    );
    server.stop().await;
}

#[tokio::test]
async fn the_filter_runs_again_when_the_connection_is_replaced() {
    let port = free_port();
    let tailnet = admitting(2);
    let (_dir, server, mut client) = start(Arc::clone(&tailnet), port).await;
    let peer = peers(&tailnet, port).client("a");
    once_listening(async || health(&peer).await).await.unwrap();

    // This node signs in as someone else, so "a" is no longer one of its own devices, and the
    // device closes the connection. Calls fail until the client notices and dials again.
    tailnet.switched_user.store(true, Ordering::Relaxed);
    set_connect(&mut client, true).await;
    let deadline = Instant::now() + PATIENCE;
    loop {
        let error = health(&peer).await.err().unwrap_or_default();
        if error == "a isn't one of this computer's devices" {
            break;
        }
        assert!(Instant::now() < deadline, "the filter never ran: {error:?}");
        sleep(Duration::from_millis(20)).await;
    }
    assert_eq!(
        tailnet.whois.lock().unwrap().len(),
        1,
        "the refused dial never reached the device"
    );
    server.stop().await;
}

#[tokio::test]
async fn callers_of_one_device_share_one_connection() {
    let port = free_port();
    // A second connection would use the second answer.
    let tailnet = admitting(2);
    let (_dir, server, _client) = start(Arc::clone(&tailnet), port).await;
    let peers = peers(&tailnet, port);

    let (first, second) = tokio::join!(
        once_listening(async || health(&peers.client("a")).await),
        once_listening(async || health(&peers.client("a")).await),
    );
    first.unwrap();
    second.unwrap();
    assert_eq!(tailnet.whois.lock().unwrap().len(), 1);
    server.stop().await;
}

#[tokio::test]
async fn events_arrive_again_after_a_reconnect_and_a_new_subscription() {
    let port = free_port();
    let tailnet = admitting(3);
    let (dir, server, mut client) = start(Arc::clone(&tailnet), port).await;
    let peer = peers(&tailnet, port).client("a");
    let (sender, mut incoming) = mpsc::unbounded_channel();
    peer.notify(sender);
    once_listening(async || peer.call::<EventsSubscribe>(subscription()).await)
        .await
        .unwrap();

    client
        .call::<ProjectCreate>(create_params(dir.path(), "first"))
        .await
        .unwrap();
    let (seq, project) = next_created(&mut incoming).await;
    assert_eq!(project.name, "first");

    // The device closes its tailnet connections, then listens again. The client opens a new one
    // on its next call, and says so. Off takes effect first, once the client's calls fail, since
    // the listener reads the setting when woken and could otherwise read on twice.
    set_connect(&mut client, false).await;
    let deadline = Instant::now() + PATIENCE;
    while health(&peer).await.is_ok() {
        assert!(
            Instant::now() < deadline,
            "the device never stopped listening"
        );
        sleep(Duration::from_millis(20)).await;
    }
    set_connect(&mut client, true).await;
    let deadline = Instant::now() + PATIENCE;
    loop {
        let _ = health(&peer).await;
        match incoming.try_recv() {
            Ok(Incoming::Reconnected) => break,
            Ok(Incoming::Event(_)) | Err(_) => {}
        }
        assert!(Instant::now() < deadline, "the client never reconnected");
        sleep(Duration::from_millis(20)).await;
    }
    peer.call::<EventsSubscribe>(EventsSubscribeParams {
        after: seq,
        ..subscription()
    })
    .await
    .unwrap();
    client
        .call::<ProjectCreate>(create_params(dir.path(), "second"))
        .await
        .unwrap();
    let (_, project) = next_created(&mut incoming).await;
    assert_eq!(project.name, "second");
    server.stop().await;
}

#[tokio::test]
async fn a_silent_subscribed_connection_outlives_the_devices_idle_timeout() {
    let port = free_port();
    let tailnet = admitting(2);
    // The real timeouts, scaled down. The device drops a silent connection after 1.5 s. The
    // client stops using an unused one after 200 ms, and sends `host/health` every 500 ms, so a
    // call 350 ms after a heartbeat finds the connection idle by the client's own rule.
    let (dir, server, _client) = start_with(Arc::clone(&tailnet), port, |config| {
        config.idle_timeout = Duration::from_millis(1500);
    })
    .await;
    let peer = peers(&tailnet, port)
        .client("a")
        .with_timing(Duration::from_millis(200), Some(Duration::from_millis(500)));
    let (sender, mut incoming) = mpsc::unbounded_channel();
    peer.notify(sender);
    once_listening(async || peer.call::<EventsSubscribe>(subscription()).await)
        .await
        .unwrap();

    // A subscribed connection isn't dropped for idling, so this call uses it.
    sleep(Duration::from_millis(850)).await;
    health(&peer).await.unwrap();
    assert_eq!(
        tailnet.whois.lock().unwrap().len(),
        1,
        "the call opened a new connection"
    );

    // With no calls, only the heartbeat keeps the device from closing it.
    sleep(Duration::from_millis(2000)).await;
    // The first local client idled out too.
    let mut client = Client::ready(&server.socket).await;
    client
        .call::<ProjectCreate>(create_params(dir.path(), "late"))
        .await
        .unwrap();
    let (_, project) = next_created(&mut incoming).await;
    assert_eq!(project.name, "late");
    server.stop().await;
}
