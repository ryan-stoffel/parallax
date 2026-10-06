//! `connect/devices` (decision 0056): this node and the tailnet's other nodes of its Tailscale
//! user, with whether plxd answers on each.

use std::net::{IpAddr, SocketAddr};
use std::sync::atomic::Ordering;
use std::time::Duration;

use futures_util::future::join_all;
use parallax_protocol::jsonrpc::ErrorObject;
use parallax_protocol::{
    ConnectDevicesParams, ConnectDevicesResult, TailnetDevice, TailscaleState,
};
use tokio::net::TcpStream;

use super::Context;
use crate::tailnet::{Node, NotRunning};

/// How long a peer's port has to accept a connection.
const PROBE_TIMEOUT: Duration = Duration::from_millis(1500);

/// `connect/devices`. A host without Tailscale, or where it isn't running, answers with no
/// devices rather than an error.
pub(crate) async fn devices(
    context: &Context,
    _: ConnectDevicesParams,
) -> Result<ConnectDevicesResult, ErrorObject> {
    let connect = &context.daemon.connect;
    let listening = connect.listening.load(Ordering::Relaxed);
    let empty = |tailscale| ConnectDevicesResult {
        tailscale,
        port: connect.port,
        listening,
        self_device: None,
        devices: Vec::new(),
    };
    let status = match connect.tailnet.status().await {
        Ok(status) => status,
        Err(NotRunning::Missing) => return Ok(empty(TailscaleState::Missing)),
        Err(NotRunning::Stopped(_)) => return Ok(empty(TailscaleState::Stopped)),
    };
    let user = status.this.user_id;
    let mut mine: Vec<Node> = status
        .peers
        .into_iter()
        .filter(|peer| peer.user_id == user)
        .collect();
    mine.sort_by(|a, b| {
        (a.host_name.to_lowercase(), &a.id).cmp(&(b.host_name.to_lowercase(), &b.id))
    });
    let answers = join_all(mine.iter().map(|peer| {
        let ip = peer.ipv4().filter(|_| peer.online);
        probe(ip, connect.port)
    }))
    .await;
    Ok(ConnectDevicesResult {
        tailscale: TailscaleState::Running,
        port: connect.port,
        listening,
        self_device: Some(device(&status.this, listening)),
        devices: mine
            .iter()
            .zip(answers)
            .map(|(peer, parallax)| device(peer, parallax))
            .collect(),
    })
}

fn device(node: &Node, parallax: bool) -> TailnetDevice {
    TailnetDevice {
        id: node.id.clone(),
        host_name: node.host_name.clone(),
        dns_name: node.dns_name.clone(),
        os: node.os.clone(),
        ip: node.ipv4().map(|ip| ip.to_string()).unwrap_or_default(),
        online: node.online,
        parallax,
    }
}

/// Whether something accepts a TCP connection at `ip`'s `port` within [`PROBE_TIMEOUT`].
async fn probe(ip: Option<IpAddr>, port: u16) -> bool {
    let Some(ip) = ip else {
        return false;
    };
    let connect = TcpStream::connect(SocketAddr::new(ip, port));
    matches!(
        tokio::time::timeout(PROBE_TIMEOUT, connect).await,
        Ok(Ok(_))
    )
}
