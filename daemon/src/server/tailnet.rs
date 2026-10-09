//! Parallax Connect's listener (decision 0056): while the host's `connect` setting is on and
//! Tailscale runs, plxd listens on TCP port 7340 of its own Tailscale IPv4, and nowhere else.
//!
//! [`run`] checks every [`Config::connect_check_interval`](super::Config) and at once when
//! `host/settings/set` changes `connect`, and binds, rebinds when this node's address, user, or
//! tagged state changes, or drops the listener. A listener that stops, for any reason but
//! shutdown, closes every connection it accepted; local connections stay. Each accepted
//! connection is served as a local one only after [`admit`] lets its peer in, which runs
//! `tailscale whois` before plxd reads anything from it. At most [`MAX_PENDING_CHECKS`] of those
//! checks run at once, and [`MAX_PENDING_CHECKS_PER_IP`] for one peer address; a connection over
//! either cap is closed at once.

use std::collections::HashMap;
use std::io;
use std::net::{IpAddr, SocketAddr};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, PoisonError};
use std::time::Duration;

use tokio::net::{TcpListener, TcpStream};
use tokio::sync::{Notify, OwnedSemaphorePermit, Semaphore};
use tokio::time::{self, MissedTickBehavior};
use tokio_util::sync::CancellationToken;
use tokio_util::task::TaskTracker;
use tracing::{Instrument, debug, info, info_span, warn};

use super::{ACCEPT_BACKOFF, Daemon, connection};
use crate::agents::store_error;
use crate::tailnet::{Owner, Tailnet, admit};

/// How many accepted connections may wait on `tailscale whois` at once.
pub(crate) const MAX_PENDING_CHECKS: usize = 8;

/// How many of those may come from one peer address, so one peer can't hold every slot.
pub(crate) const MAX_PENDING_CHECKS_PER_IP: usize = 2;

/// How many more times a bind refused with "address in use" is tried, [`BIND_RETRY_PAUSE`]
/// apart, before the listener waits for the next check.
const BIND_RETRIES: u32 = 10;
const BIND_RETRY_PAUSE: Duration = Duration::from_millis(20);

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
    /// Closes every connection this listener accepted, checked or served. A child of the
    /// server's abort token.
    closing: CancellationToken,
}

impl Bound {
    /// Stops listening and closes this listener's connections.
    fn close(self) {
        self.closing.cancel();
    }
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
    let checks = Checks::default();
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
                        let Some(check) = checks.start(peer.ip()) else {
                            debug!(%peer, "closed a tailnet connection: too many checks are pending");
                            continue;
                        };
                        let bound = bound.as_ref().expect("accepted");
                        let accepted = Accepted {
                            stream,
                            peer,
                            owner: Arc::clone(&bound.owner),
                            closing: bound.closing.child_token(),
                            id: connection_id,
                        };
                        serving.admit(accepted, check);
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
                // A new user or tag would admit different peers, so it rebinds like a new address.
                if let Some(current) = bound.as_mut().filter(|b| {
                    b.address == address
                        && b.owner.user_id == owner.user_id
                        && b.owner.tagged == owner.tagged
                }) {
                    current.owner = Arc::new(owner);
                    continue;
                }
                if let Some(old) = bound.take() {
                    info!(
                        address = %old.address,
                        "stopped listening on the tailnet: this node's address, user, or tags changed"
                    );
                    old.close();
                }
                let bound_now = tokio::select! {
                    () = stop.cancelled() => break,
                    bound_now = bind(address) => bound_now,
                };
                match bound_now {
                    Ok(listener) => {
                        info!(%address, "listening on the tailnet");
                        bound = Some(Bound {
                            address,
                            listener,
                            owner: Arc::new(owner),
                            closing: serving.abort.child_token(),
                        });
                        problem = None;
                    }
                    Err(error) => {
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
                    old.close();
                }
                problem = Some(why);
            }
        }
        connect.listening.store(bound.is_some(), Ordering::Relaxed);
    }
    // Shutdown drains the listener's connections like local ones, so it doesn't close them.
    connect.listening.store(false, Ordering::Relaxed);
}

/// Binds `address`. Right after the old listener closes, macOS can refuse its address for a
/// moment, so a refused bind is tried again before the next check (PLX-595).
async fn bind(address: SocketAddr) -> io::Result<TcpListener> {
    let mut tries = 0;
    loop {
        match TcpListener::bind(address).await {
            Err(error) if error.kind() == io::ErrorKind::AddrInUse && tries < BIND_RETRIES => {
                tries += 1;
                time::sleep(BIND_RETRY_PAUSE).await;
            }
            bound => return bound,
        }
    }
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

/// The whois checks pending, overall and per peer address.
#[derive(Clone)]
struct Checks {
    all: Arc<Semaphore>,
    per_ip: Arc<Mutex<HashMap<IpAddr, usize>>>,
}

impl Default for Checks {
    fn default() -> Self {
        Self {
            all: Arc::new(Semaphore::new(MAX_PENDING_CHECKS)),
            per_ip: Arc::default(),
        }
    }
}

impl Checks {
    /// A slot for a check of a connection from `ip`, or `None` when either cap is reached.
    fn start(&self, ip: IpAddr) -> Option<Check> {
        let mut per_ip = self.per_ip.lock().unwrap_or_else(PoisonError::into_inner);
        if per_ip.get(&ip).copied().unwrap_or(0) >= MAX_PENDING_CHECKS_PER_IP {
            return None;
        }
        let permit = Arc::clone(&self.all).try_acquire_owned().ok()?;
        *per_ip.entry(ip).or_default() += 1;
        Some(Check {
            _permit: permit,
            per_ip: Arc::clone(&self.per_ip),
            ip,
        })
    }
}

/// A pending check's slot, given back when it drops.
struct Check {
    _permit: OwnedSemaphorePermit,
    per_ip: Arc<Mutex<HashMap<IpAddr, usize>>>,
    ip: IpAddr,
}

impl Drop for Check {
    fn drop(&mut self) {
        let mut per_ip = self.per_ip.lock().unwrap_or_else(PoisonError::into_inner);
        if let Some(count) = per_ip.get_mut(&self.ip) {
            *count -= 1;
            if *count == 0 {
                per_ip.remove(&self.ip);
            }
        }
    }
}

/// A connection the listener accepted, not yet checked.
struct Accepted {
    stream: TcpStream,
    peer: SocketAddr,
    owner: Arc<Owner>,
    /// Its listener's `closing`.
    closing: CancellationToken,
    id: u64,
}

impl Serving {
    /// Serves the connection once `tailscale whois` shows its peer is a node [`admit`] lets in,
    /// and closes it otherwise. `check` is held until whois answers. The check runs as one of the
    /// server's connections, so shutdown waits for it.
    fn admit(&self, accepted: Accepted, check: Check) {
        let Accepted {
            stream,
            peer,
            owner,
            closing,
            id,
        } = accepted;
        let daemon = Arc::clone(&self.daemon);
        let stop_reading = self.stop_reading.clone();
        let span = info_span!("tailnet", id);
        self.connections.spawn(
            async move {
                let whois = tokio::select! {
                    whois = daemon.connect.tailnet.whois(peer) => whois,
                    () = closing.cancelled() => return,
                };
                drop(check);
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

#[cfg(test)]
mod tests {
    use std::net::{IpAddr, Ipv4Addr};
    use std::time::Duration;

    use super::{Checks, MAX_PENDING_CHECKS, MAX_PENDING_CHECKS_PER_IP, bind};

    #[tokio::test]
    async fn a_bind_refused_as_in_use_is_tried_again() {
        let taken = std::net::TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).unwrap();
        let address = taken.local_addr().unwrap();
        let freed = std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(50));
            drop(taken);
        });
        bind(address).await.expect("bound once the address is free");
        freed.join().unwrap();
    }

    #[test]
    fn checks_are_capped_overall_and_per_peer_address() {
        let checks = Checks::default();
        let one: IpAddr = "100.64.0.1".parse().unwrap();
        let held: Vec<_> = (0..MAX_PENDING_CHECKS_PER_IP)
            .map(|_| checks.start(one).expect("under the per-address cap"))
            .collect();
        assert!(checks.start(one).is_none(), "over the per-address cap");
        drop(held);
        assert!(
            checks.start(one).is_some(),
            "a finished check frees its slot"
        );

        let many: Vec<_> = (0..MAX_PENDING_CHECKS)
            .map(|n| {
                let ip = IpAddr::from([100, 64, 1, u8::try_from(n).unwrap()]);
                checks.start(ip).expect("under the overall cap")
            })
            .collect();
        assert!(
            checks.start("100.64.2.1".parse().unwrap()).is_none(),
            "over the overall cap"
        );
        drop(many);
        assert!(checks.per_ip.lock().unwrap().is_empty());
    }
}
