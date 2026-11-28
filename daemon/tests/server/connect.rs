//! Parallax Connect's tailnet listener and `connect/devices` (0056), with a fake tailnet and the
//! listener on loopback.

use std::collections::VecDeque;
use std::net::{IpAddr, Ipv4Addr, SocketAddr};
use std::sync::atomic::{AtomicBool, Ordering};
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

pub(crate) const ME: u64 = 1;
pub(crate) const SOMEONE_ELSE: u64 = 2;
const LOOPBACK: IpAddr = IpAddr::V4(Ipv4Addr::LOCALHOST);

/// A tailnet whose `whois` answers come from a queue, one per connection.
#[derive(Debug, Default)]
pub(crate) struct FakeTailnet {
    pub(crate) whois: Mutex<VecDeque<Result<Whois, String>>>,
    /// This node's tags.
    pub(crate) tags: Vec<String>,
    /// `whois` never answers.
    pub(crate) hang: bool,
    /// This node is signed in as `SOMEONE_ELSE` instead of `ME`.
    pub(crate) switched_user: AtomicBool,
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
            let user = if self.switched_user.load(Ordering::Relaxed) {
                SOMEONE_ELSE
            } else {
                ME
            };
            let mut this = node("self", "this", user, own, true);
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

pub(crate) fn whois(user_id: u64) -> Whois {
    Whois {
        user_id,
        tags: Vec::new(),
        node: "peer.example.ts.net".to_owned(),
    }
}

/// A server on a temporary folder with `tailnet`, its Connect listener on loopback at `port`,
/// and a local client that has turned `connect` on.
pub(crate) async fn start(
    tailnet: Arc<FakeTailnet>,
    port: u16,
) -> (tempfile::TempDir, InProcess, Client) {
    start_with(tailnet, port, |_| {}).await
}

/// [`start`], with `adjust` changing the server's config first.
pub(crate) async fn start_with(
    tailnet: Arc<FakeTailnet>,
    port: u16,
    adjust: impl FnOnce(&mut plxd::server::Config),
) -> (tempfile::TempDir, InProcess, Client) {
    let dir = temp_dir();
    let mut config = InProcess::config(dir.path());
    adjust(&mut config);
    config.tailnet = Some(tailnet);
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

/// The ports [`free_port`] hands out: below every OS's ephemeral range (Linux starts at 32768,
/// macOS at 49152), so no `bind(0)` or outgoing connection in another test takes one between
/// `free_port` returning it and plxd binding it (PLX-1643).
const TEST_PORTS: std::ops::Range<u16> = 20_000..32_000;

/// A port for a test's server to bind later, free on every address now. Each is picked at random
/// and never handed out twice in this process. Two test binaries running at once, as on a
/// computer with several worktrees, can still pick the same one, rarely, and [`host_at`] starts
/// again on another when plxd can't bind it.
///
/// [`host_at`]: crate::account::host_at
pub(crate) fn free_port() -> u16 {
    use std::collections::HashSet;
    use std::hash::BuildHasher as _;
    static GIVEN: Mutex<Option<HashSet<u16>>> = Mutex::new(None);
    let span = u64::from(TEST_PORTS.end - TEST_PORTS.start);
    let mut given = GIVEN.lock().unwrap();
    let given = given.get_or_insert_with(HashSet::new);
    for attempt in 0..span {
        let random = std::collections::hash_map::RandomState::new().hash_one(attempt);
        let port = TEST_PORTS.start + u16::try_from(random % span).expect("below the span");
        let free = |ip: IpAddr| std::net::TcpListener::bind((ip, port)).is_ok();
        if !given.contains(&port)
            && free(IpAddr::V4(Ipv4Addr::UNSPECIFIED))
            && free(IpAddr::V6(std::net::Ipv6Addr::UNSPECIFIED))
        {
            given.insert(port);
            return port;
        }
    }
    panic!("no free port in {TEST_PORTS:?}");
}

pub(crate) async fn set_connect(client: &mut Client, on: bool) {
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
    let (_dir, server, mut client) = start(Arc::new(tailnet), port).await;

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
    let (_dir, server, mut client) = start(Arc::new(tailnet), port).await;

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
async fn a_new_user_at_the_same_address_closes_the_tailnets_connections() {
    let port = free_port();
    let tailnet = Arc::new(FakeTailnet {
        whois: Mutex::new(VecDeque::from([Ok(whois(ME))])),
        ..FakeTailnet::default()
    });
    let (_dir, server, mut client) = start(Arc::clone(&tailnet), port).await;
    let mut admitted = dial(port).await;
    assert!(matches!(
        initialize(&mut admitted).await,
        Some(Message::Response(_))
    ));

    tailnet.switched_user.store(true, Ordering::Relaxed);
    // Setting `connect` wakes the check at once.
    set_connect(&mut client, true).await;
    assert!(
        closes_within(&mut admitted, PATIENCE).await,
        "admitted under the old user, so closed"
    );
    // It listens again, at the same address, for the new user.
    let mut again = dial(port).await;
    assert!(
        initialize(&mut again).await.is_none(),
        "whois has nobody left"
    );
    server.stop().await;
}
