//! Parallax Connect's listener (decision 0056): while the host's `connect` setting is on and
//! Tailscale runs, plxd listens on TCP port 7340 of its own Tailscale IPv4, and nowhere else.
//!
//! [`run`] checks every [`Config::connect_check_interval`](super::Config) and at once when
//! `host/settings/set` changes `connect`, and binds, rebinds on a new address, or drops the
//! listener. Dropping it leaves open connections alone. Each accepted connection is served as a
//! local one only after [`admit`] lets its peer in, which runs `tailscale whois` before plxd reads
//! anything from it.

use std::io;
use std::net::{IpAddr, SocketAddr};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use tokio::net::{TcpListener, TcpStream};
use tokio::sync::Notify;
use tokio::time::{self, MissedTickBehavior};
use tokio_util::sync::CancellationToken;
use tokio_util::task::TaskTracker;
use tracing::{Instrument, info, info_span, warn};

use super::{ACCEPT_BACKOFF, Daemon, connection};
use crate::agents::store_error;
use crate::tailnet::{Owner, Tailnet, admit};

/// Parallax Connect's state, shared by the listener and `connect/devices`.
#[derive(Debug)]
pub(crate) struct Connect {
    pub tailnet: Arc<dyn Tailnet>,
    pub port: u16,
    /// Bound instead of this node's Tailscale IPv4. Tests only.
    pub address: Option<IpAddr>,
    /// Wakes the listener at once, when `host/settings/set` changes `connect`.
    pub changed: Notify,
    /// Whether the listener is bound now.
    pub listening: AtomicBool,
}

impl Connect {
    pub(crate) fn new(tailnet: Arc<dyn Tailnet>, port: u16, address: Option<IpAddr>) -> Self {
        Self {
            tailnet,
            port,
            address,
            changed: Notify::new(),
            listening: AtomicBool::new(false),
        }
    }
}

/// What a served connection shares with the server's own.
pub(super) struct Serving {
    pub daemon: Arc<Daemon>,
    pub connections: TaskTracker,
    pub stop_reading: CancellationToken,
    pub abort: CancellationToken,
}

struct Bound {
    address: SocketAddr,
    listener: TcpListener,
    owner: Arc<Owner>,
}

/// Where the listener should be, or why it shouldn't.
enum Want {
    Listen { address: SocketAddr, owner: Owner },
    Not(String),
}

/// Keeps the listener in line with the setting and Tailscale until `stop`.
pub(super) async fn run(serving: Serving, period: Duration, stop: CancellationToken) {
    let connect = &serving.daemon.connect;
    let mut bound: Option<Bound> = None;
    let mut problem: Option<String> = None;
    let mut check = time::interval(period);
    check.set_missed_tick_behavior(MissedTickBehavior::Delay);
    let mut connection_id = 0_u64;
    loop {
        tokio::select! {
            biased;
            () = stop.cancelled() => break,
            _ = check.tick() => {}
            () = connect.changed.notified() => {}
            accepted = accept(bound.as_ref()) => {
                match accepted {
                    Ok((stream, peer)) => {
                        connection_id += 1;
                        let owner = Arc::clone(&bound.as_ref().expect("accepted").owner);
                        serving.admit(stream, peer, owner, connection_id);
                    }
                    Err(error) => {
                        warn!(%error, "could not accept a tailnet connection");
                        time::sleep(ACCEPT_BACKOFF).await;
                    }
                }
                continue;
            }
        }
        let want = tokio::select! {
            () = stop.cancelled() => break,
            want = want(&serving.daemon) => want,
        };
        match want {
            Want::Listen { address, owner } => {
                if let Some(current) = bound.as_mut().filter(|b| b.address == address) {
                    current.owner = Arc::new(owner);
                    continue;
                }
                match TcpListener::bind(address).await {
                    Ok(listener) => {
                        info!(%address, "listening on the tailnet");
                        bound = Some(Bound {
                            address,
                            listener,
                            owner: Arc::new(owner),
                        });
                        problem = None;
                    }
                    Err(error) => {
                        bound = None;
                        let now = format!("could not listen on {address}: {error}");
                        if problem.as_ref() != Some(&now) {
                            warn!("{now}");
                        }
                        problem = Some(now);
                    }
                }
            }
            Want::Not(why) => {
                if let Some(old) = bound.take() {
                    info!(address = %old.address, reason = %why, "stopped listening on the tailnet");
                }
                problem = Some(why);
            }
        }
        connect.listening.store(bound.is_some(), Ordering::Relaxed);
    }
    connect.listening.store(false, Ordering::Relaxed);
}

async fn accept(bound: Option<&Bound>) -> io::Result<(TcpStream, SocketAddr)> {
    match bound {
        Some(bound) => bound.listener.accept().await,
        None => std::future::pending().await,
    }
}

/// Reads the setting, then Tailscale's status when it is on. The setting comes from the reader,
/// so the check never queues a write behind it.
async fn want(daemon: &Daemon) -> Want {
    let on = daemon
        .reader
        .run(&CancellationToken::new(), |db| {
            db.connect().map_err(|e| store_error(&e))
        })
        .await;
    match on {
        Ok(true) => {}
        Ok(false) => return Want::Not("connect is off".to_owned()),
        Err(error) => return Want::Not(format!("the store failed: {}", error.message)),
    }
    let connect = &daemon.connect;
    let status = match connect.tailnet.status().await {
        Ok(status) => status,
        Err(error) => return Want::Not(error.to_string()),
    };
    let Some(ip) = connect.address.or_else(|| status.this.ipv4()) else {
        return Want::Not("this node has no Tailscale IPv4 address".to_owned());
    };
    Want::Listen {
        address: SocketAddr::new(ip, connect.port),
        owner: Owner::of(&status),
    }
}

impl Serving {
    /// Serves `stream` once `tailscale whois` shows `peer` is another node of `owner`'s user, and
    /// closes it otherwise. The check runs as one of the server's connections, so shutdown waits
    /// for it.
    fn admit(&self, stream: TcpStream, peer: SocketAddr, owner: Arc<Owner>, id: u64) {
        let daemon = Arc::clone(&self.daemon);
        let stop_reading = self.stop_reading.clone();
        let closing = self.abort.child_token();
        let span = info_span!("tailnet", id);
        self.connections.spawn(
            async move {
                let whois = daemon.connect.tailnet.whois(peer).await;
                match admit(&owner, peer.ip(), whois) {
                    Ok(whois) => {
                        info!(%peer, node = %whois.node, "accepted a tailnet connection");
                        // Small request and answer frames: send each at once.
                        let _ = stream.set_nodelay(true);
                        connection::serve(stream, daemon, stop_reading, closing).await;
                    }
                    Err(reason) => warn!(%peer, %reason, "refused a tailnet connection"),
                }
            }
            .instrument(span),
        );
    }
}
