//! The client one plxd uses for another (0057), over Parallax Connect's TCP port with a fake
//! tailnet and the device's listener on loopback. The home plxd's side is just the client: nothing
//! in plxd calls it yet.

use std::collections::VecDeque;
use std::sync::atomic::Ordering;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use parallax_protocol::methods::HostHealth;
use parallax_protocol::{HostHealthParams, HostHealthResult};
use plxd::peer::{Peers, Plxd};
use plxd::tailnet::Tailnet;
use tokio::time::{Instant, sleep};

use crate::connect::{FakeTailnet, ME, SOMEONE_ELSE, free_port, set_connect, start, whois};
use crate::support::PATIENCE;

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
