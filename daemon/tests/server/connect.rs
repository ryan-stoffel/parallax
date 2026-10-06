//! Parallax Connect's tailnet listener and `connect/devices` (0056), with a fake tailnet and the
//! listener on loopback.

use std::collections::VecDeque;
use std::net::{IpAddr, Ipv4Addr, SocketAddr};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use futures_util::future::BoxFuture;
use futures_util::{SinkExt, StreamExt};
use parallax_protocol::framing::FrameCodec;
use parallax_protocol::jsonrpc::{Message, Request};
use parallax_protocol::methods::{ConnectDevices, HostSettingsSet, Initialize};
use parallax_protocol::{
    ConnectDevicesParams, HostSettingsSetParams, ProtocolRange, TailscaleState,
};
use plxd::tailnet::{Node, NotRunning, Status, Tailnet, Whois};
use tokio::net::TcpStream;
use tokio::time::{Instant, sleep, timeout};
use tokio_util::codec::Framed;

use crate::support::{Client, InProcess, PATIENCE, initialize_params, temp_dir};

const ME: u64 = 1;
const SOMEONE_ELSE: u64 = 2;
const LOOPBACK: IpAddr = IpAddr::V4(Ipv4Addr::LOCALHOST);

/// A tailnet whose `whois` answers come from a queue, one per connection.
#[derive(Debug, Default)]
struct FakeTailnet {
    whois: Mutex<VecDeque<Result<Whois, String>>>,
    /// This node's tags.
    tags: Vec<String>,
    /// `whois` never answers.
    hang: bool,
}

fn node(id: &str, host_name: &str, user_id: u64, ip: IpAddr, online: bool) -> Node {
    Node {
        id: id.to_owned(),
        host_name: host_name.to_owned(),
        dns_name: format!("{host_name}.example.ts.net"),
        os: "linux".to_owned(),
        user_id,
        tags: Vec::new(),
        ips: vec![ip],
        online,
    }
}

fn tagged(mut node: Node) -> Node {
    node.tags = vec!["tag:k3s".to_owned()];
    node
}

impl Tailnet for FakeTailnet {
    fn status(&self) -> BoxFuture<'_, Result<Status, NotRunning>> {
        let own = IpAddr::V4(Ipv4Addr::new(100, 64, 0, 1));
        let elsewhere = IpAddr::V4(Ipv4Addr::new(100, 64, 0, 9));
        Box::pin(async move {
            let mut this = node("self", "this", ME, own, true);
            this.tags.clone_from(&self.tags);
            Ok(Status {
                this,
                peers: vec![
                    node("b", "b-laptop", ME, elsewhere, false),
                    node("s", "shared", SOMEONE_ELSE, LOOPBACK, true),
                    tagged(node("t", "tagged", ME, LOOPBACK, true)),
                    // Answers on loopback, where the listener is.
                    node("a", "a-desktop", ME, LOOPBACK, true),
                ],
            })
        })
    }

    fn whois(&self, _: SocketAddr) -> BoxFuture<'_, Result<Whois, String>> {
        if self.hang {
            return Box::pin(std::future::pending());
        }
        let next = self.whois.lock().unwrap().pop_front();
        Box::pin(async move { next.unwrap_or_else(|| Err("peer not found".to_owned())) })
    }
}

fn whois(user_id: u64) -> Whois {
    Whois {
        user_id,
        tags: Vec::new(),
        node: "peer.example.ts.net".to_owned(),
    }
}

/// A server on a temporary folder with `tailnet`, its Connect listener on loopback at `port`,
/// and a local client that has turned `connect` on.
async fn start(tailnet: FakeTailnet, port: u16) -> (tempfile::TempDir, InProcess, Client) {
    let dir = temp_dir();
    let mut config = InProcess::config(dir.path());
    config.tailnet = Some(Arc::new(tailnet));
    config.connect_address = Some(LOOPBACK);
    config.connect_port = port;
    // Only the setting's change can bind it in time.
    config.connect_check_interval = Duration::from_hours(1);
    let server = InProcess::start(config);
    let mut client = Client::ready(&server.socket).await;
    set_connect(&mut client, true).await;
    (dir, server, client)
}

/// Whether the connection ends within `within`, without a message.
async fn closes_within(framed: &mut Framed<TcpStream, FrameCodec>, within: Duration) -> bool {
    match timeout(within, framed.next()).await {
        Ok(None | Some(Err(_))) => true,
        Ok(Some(Ok(frame))) => panic!("expected no message, got {frame:?}"),
        Err(_) => false,
    }
}

fn free_port() -> u16 {
    std::net::TcpListener::bind((LOOPBACK, 0))
        .unwrap()
        .local_addr()
        .unwrap()
        .port()
}

async fn set_connect(client: &mut Client, on: bool) {
    let settings = client
        .call::<HostSettingsSet>(HostSettingsSetParams {
            connect: Some(on),
            ..HostSettingsSetParams::default()
        })
        .await
        .unwrap();
    assert_eq!(settings.connect, Some(on));
}

/// Connects once the listener is bound.
async fn dial(port: u16) -> Framed<TcpStream, FrameCodec> {
    let deadline = Instant::now() + PATIENCE;
    loop {
        if let Ok(stream) = TcpStream::connect((LOOPBACK, port)).await {
            return Framed::new(stream, FrameCodec::new());
        }
        assert!(Instant::now() < deadline, "the listener never bound");
        sleep(Duration::from_millis(20)).await;
    }
}

/// `initialize`'s answer, or `None` when the connection closes first.
async fn initialize(framed: &mut Framed<TcpStream, FrameCodec>) -> Option<Message> {
    let request = Request::new::<Initialize>(1, initialize_params(ProtocolRange::SUPPORTED));
    // A refused connection may already be closed.
    let _ = framed.send(&request).await;
    match timeout(PATIENCE, framed.next())
        .await
        .expect("an answer or the end")
    {
        Some(Ok(frame)) => Some(Message::from_frame(&frame).unwrap()),
        _ => None,
    }
}

#[tokio::test]
async fn only_another_device_of_the_same_user_is_served() {
    let port = free_port();
    let mut tagged_peer = whois(ME);
    tagged_peer.tags = vec!["tag:k3s".to_owned()];
    let tailnet = FakeTailnet {
        whois: Mutex::new(VecDeque::from([
            Ok(whois(ME)),
            Ok(whois(SOMEONE_ELSE)),
            Ok(tagged_peer),
        ])),
        ..FakeTailnet::default()
    };
    let (_dir, server, mut client) = start(tailnet, port).await;

    let mut allowed = dial(port).await;
    match initialize(&mut allowed).await {
        Some(Message::Response(response)) => assert!(response.result.is_ok(), "{response:?}"),
        other => panic!("expected initialize's answer, got {other:?}"),
    }
    for refused in ["another user", "a tagged node of the same user"] {
        let mut connection = dial(port).await;
        assert!(initialize(&mut connection).await.is_none(), "{refused}");
    }

    let devices = client
        .call::<ConnectDevices>(ConnectDevicesParams {})
        .await
        .unwrap();
    assert_eq!(devices.tailscale, TailscaleState::Running);
    assert!(devices.listening);
    assert_eq!(devices.port, port);
    assert_eq!(devices.self_device.unwrap().id, "self");
    let found: Vec<_> = devices
        .devices
        .iter()
        .map(|device| (device.host_name.as_str(), device.parallax))
        .collect();
    assert_eq!(found, [("a-desktop", true), ("b-laptop", false)]);

    set_connect(&mut client, false).await;
    let deadline = Instant::now() + PATIENCE;
    while TcpStream::connect((LOOPBACK, port)).await.is_ok() {
        assert!(Instant::now() < deadline, "the listener never closed");
        sleep(Duration::from_millis(20)).await;
    }
    assert!(
        closes_within(&mut allowed, PATIENCE).await,
        "turning it off closes the tailnet's connections"
    );
    let devices = client
        .call::<ConnectDevices>(ConnectDevicesParams {})
        .await
        .expect("the local connection stays");
    assert!(!devices.listening);
    server.stop().await;
}

#[tokio::test]
async fn a_tagged_host_lists_and_serves_nobody() {
    let port = free_port();
    let tailnet = FakeTailnet {
        whois: Mutex::new(VecDeque::from([Ok(whois(ME))])),
        tags: vec!["tag:server".to_owned()],
        ..FakeTailnet::default()
    };
    let (_dir, server, mut client) = start(tailnet, port).await;

    let mut connection = dial(port).await;
    assert!(initialize(&mut connection).await.is_none(), "refused");
    let devices = client
        .call::<ConnectDevices>(ConnectDevicesParams {})
        .await
        .unwrap();
    assert_eq!(devices.self_device.unwrap().id, "self");
    assert!(devices.devices.is_empty(), "{:?}", devices.devices);
    server.stop().await;
}

#[tokio::test]
async fn connections_over_the_pending_check_cap_close_at_once() {
    let port = free_port();
    let tailnet = FakeTailnet {
        hang: true,
        ..FakeTailnet::default()
    };
    let (_dir, server, mut client) = start(tailnet, port).await;

    let mut pending = Vec::new();
    for _ in 0..8 {
        pending.push(dial(port).await);
    }
    let mut over = dial(port).await;
    assert!(closes_within(&mut over, PATIENCE).await, "over the cap");
    assert!(
        !closes_within(&mut pending[0], Duration::from_millis(200)).await,
        "still waiting on whois"
    );

    set_connect(&mut client, false).await;
    for connection in &mut pending {
        assert!(
            closes_within(connection, PATIENCE).await,
            "turning it off closes connections whose check is pending"
        );
    }
    server.stop().await;
}
