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
#[derive(Debug)]
struct FakeTailnet {
    whois: Mutex<VecDeque<Result<Whois, String>>>,
}

fn node(id: &str, host_name: &str, user_id: u64, ip: IpAddr, online: bool) -> Node {
    Node {
        id: id.to_owned(),
        host_name: host_name.to_owned(),
        dns_name: format!("{host_name}.example.ts.net"),
        os: "linux".to_owned(),
        user_id,
        ips: vec![ip],
        online,
    }
}

impl Tailnet for FakeTailnet {
    fn status(&self) -> BoxFuture<'_, Result<Status, NotRunning>> {
        let own = IpAddr::V4(Ipv4Addr::new(100, 64, 0, 1));
        let elsewhere = IpAddr::V4(Ipv4Addr::new(100, 64, 0, 9));
        Box::pin(async move {
            Ok(Status {
                this: node("self", "this", ME, own, true),
                peers: vec![
                    node("b", "b-laptop", ME, elsewhere, false),
                    node("t", "tagged", SOMEONE_ELSE, LOOPBACK, true),
                    // Answers on loopback, where the listener is.
                    node("a", "a-desktop", ME, LOOPBACK, true),
                ],
            })
        })
    }

    fn whois(&self, _: SocketAddr) -> BoxFuture<'_, Result<Whois, String>> {
        let next = self.whois.lock().unwrap().pop_front();
        Box::pin(async move { next.unwrap_or_else(|| Err("peer not found".to_owned())) })
    }
}

fn whois(user_id: u64) -> Whois {
    Whois {
        user_id,
        node: "peer.example.ts.net".to_owned(),
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
    let dir = temp_dir();
    let port = free_port();
    let tailnet = Arc::new(FakeTailnet {
        whois: Mutex::new(VecDeque::from([Ok(whois(ME)), Ok(whois(SOMEONE_ELSE))])),
    });
    let mut config = InProcess::config(dir.path());
    config.tailnet = Some(tailnet);
    config.connect_address = Some(LOOPBACK);
    config.connect_port = port;
    // Only the setting's change can bind it in time.
    config.connect_check_interval = Duration::from_hours(1);
    let server = InProcess::start(config);
    let mut client = Client::ready(&server.socket).await;
    set_connect(&mut client, true).await;

    let mut allowed = dial(port).await;
    match initialize(&mut allowed).await {
        Some(Message::Response(response)) => assert!(response.result.is_ok(), "{response:?}"),
        other => panic!("expected initialize's answer, got {other:?}"),
    }
    let mut refused = dial(port).await;
    assert!(
        initialize(&mut refused).await.is_none(),
        "closed unanswered"
    );

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
    let mut still_open = allowed;
    assert!(
        matches!(
            initialize(&mut still_open).await,
            Some(Message::Response(_))
        ),
        "turning it off leaves open connections alone"
    );
    server.stop().await;
}
