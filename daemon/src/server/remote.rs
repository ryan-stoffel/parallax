//! The remote listener (PLX-641, decision 0065): while the host's `remote` setting is on, plxd
//! listens on TCP port [`remote::PORT`] of every IPv4 address and speaks only HTTPS, with its
//! self-signed certificate ([`crate::remote`]).
//!
//! It binds every address, since the pinned key and a session, not the network, are what let a
//! client in. A connection from outside the local network ([`remote::is_local_network`]) is
//! closed before plxd reads from it, and at most as many handshakes and requests run at once as
//! Connect's whois checks. Each connection carries one request:
//!
//! - `GET /.well-known/parallax`: the [`Descriptor`], with no credential.
//! - `POST /api/pair/start`: the client's SPAKE2 message, while a pairing code waits; answers
//!   with the host's, keyed by the code and this host's certificate fingerprint.
//! - `POST /api/pair/finish`: the client's key confirmation, with a `DPoP` proof. A right one uses
//!   up the code and answers with a session bound to the proof's key, the host's own
//!   confirmation, its name, and its routes. A wrong one counts against the code, which locks
//!   after [`remote::MAX_WRONG_CODES`]. The session's token is stored hashed.
//!   A new computer's setup code (0091) runs the same exchange, and also approves the client's
//!   key for account sign-in. Its runs are capped at [`MAX_SETUP_RUNS`] an hour.
//! - `POST /api/auth/account` and `POST /api/auth/approval`: account sign-in (0091), in
//!   [`access`].
//! - `POST /api/auth/websocket-ticket`: a ticket valid once for 30 s, for a `DPoP`-bound token.
//! - `GET /ws`: a WebSocket carrying 0007's JSON-RPC, one message per frame, opened with the
//!   session's token and a `DPoP` proof for the upgrade itself (0091), or with `?wsTicket=…`, for
//!   a browser, which can't set the upgrade's headers. What a client sent behind the request is
//!   the WebSocket's first frames, once every check passed, and a refusal drops it unread
//!   (PLX-1483). A client sends that only when TLS picked [`remote::EARLY_WS`].
//! - `/api/hooks/<id>/<token>`, by any method: a scheduled task's webhook ([`crate::schedules`]),
//!   with a body of up to [`MAX_HOOK_BYTES`].
//!
//! While the `remoteWeb` setting is on too (PLX-651), it serves the app as a web client:
//!
//! - `GET /` and `GET /assets/<file>`: the renderer build's `web.html` and its files, from
//!   [`Remote::web_dir`], with a Content Security Policy. They hold no secrets, so they need no
//!   session; everything they reach does.
//! - `POST /api/pair/browser`: the waiting code itself, with a `DPoP` proof, from a browser. A
//!   browser checks the certificate itself and can't pin one, so SPAKE2 would vouch for nothing
//!   there. A right code answers with a browser's session, and a wrong one counts against the code
//!   as a wrong confirmation does. While `remoteWeb` is off, a browser's session gets no ticket,
//!   and turning it off closes their sockets; turning it on again lets them back in.
//!
//! Files stream in chunks, at most [`MAX_FILE_RESPONSES`] at once and [`MAX_FILE_RESPONSES_PER_IP`]
//! for one address, and a reader that takes none of a chunk for [`remote::REQUEST_TIMEOUT`] is
//! dropped, so stalled readers hold little memory. A browser's request to `/ws`, `/api/pair/*`, or
//! `/api/auth/*` must come from this host's own origin, `https://<Host>`.
//!
//! While a code waits, plxd advertises itself over mDNS as `_parallax._tcp`, by name, with no
//! secret. Turning `remote` off ends the pairing and closes every connection the listener
//! accepted, and `remote/revoke` closes a session's own.

pub(crate) mod access;

use std::collections::HashMap;
use std::io;
use std::net::{IpAddr, Ipv4Addr, SocketAddr, UdpSocket};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};
use std::time::{Duration, Instant};

use futures_util::{SinkExt as _, StreamExt as _};
use parallax_protocol::RemoteSession;
use parallax_protocol::jsonrpc::ErrorObject;
use parallax_store::Store;
use serde::{Deserialize, Serialize};
use serde_json::json;
use tokio::io::{
    AsyncBufReadExt as _, AsyncRead, AsyncReadExt as _, AsyncWrite, AsyncWriteExt as _,
};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::Notify;
use tokio::time;
use tokio_rustls::TlsAcceptor;
use tokio_tungstenite::WebSocketStream;
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::tungstenite::handshake::derive_accept_key;
use tokio_tungstenite::tungstenite::protocol::Role;
use tokio_util::sync::CancellationToken;
use tracing::{Instrument, debug, info, info_span, warn};

use super::connection::{Closed, Reason, Route};
use super::tailnet::{Check, Checks, Serving};
use super::{ACCEPT_BACKOFF, Daemon, connection};
use crate::agents::store_error;
use crate::relay::{RelayStream, StreamEnd};
use crate::remote::{self, Descriptor, HostKey};

/// How long a pairing code works, as 0065 has it.
pub(crate) const CODE_LIFETIME: Duration = Duration::from_mins(5);

/// How long a new computer's setup code works (0091).
const SETUP_CODE_LIFETIME: Duration = Duration::from_mins(10);

/// How many SPAKE2 runs setup codes allow an hour, together (0091). Each run is one guess.
pub(crate) const MAX_SETUP_RUNS: usize = 5;

/// The window [`MAX_SETUP_RUNS`] and new devices' requests are counted in.
const HOUR: Duration = Duration::from_hours(1);

/// How long a started SPAKE2 exchange waits for its finish.
const PAKE_LIFETIME: Duration = Duration::from_secs(30);

/// How many started exchanges may wait at once. A new one past it pushes out the oldest.
const MAX_PENDING_PAKES: usize = 4;

/// How long a WebSocket ticket works, as 0065 has it.
const TICKET_LIFETIME: Duration = Duration::from_secs(30);

/// How long plxd remembers a `DPoP` proof's `jti`, past its time window.
const REPLAY_MEMORY: Duration = Duration::from_mins(11);

/// How long plxd waits to try again when the port is taken.
const BIND_RETRY: Duration = Duration::from_secs(10);

/// The most a request's head and body may hold.
const MAX_REQUEST_BYTES: usize = 16 * 1024;

/// How much of a request plxd reads at a time. A request ends inside one read, so plxd holds
/// under this many of the bytes behind it ([`Request::early`]). The rest waits unread in the
/// connection, under its flow control.
const READ_CHUNK: usize = 1024;

/// The most a webhook request's head and body may hold, as T3's.
const MAX_HOOK_BYTES: usize = 1024 * 1024;

/// How many connections may be in their TLS handshake and request at once, overall and from one
/// address, each for at most [`remote::REQUEST_TIMEOUT`]. A browser loading the web client opens
/// up to 6 connections to a host at once, and with Connect's 2 per address it lost some: about one
/// load in three failed in e2e/web.spec.ts. Every client of `tailscale serve` comes from loopback,
/// so they share one address's 6.
const MAX_PENDING: usize = 16;
const MAX_PENDING_PER_IP: usize = 6;

/// How long a kept connection waits for a sign-in's next step (PLX-1462). Its steps follow each
/// other at once, and through the relay a waiting connection holds one of the host's 16 streams,
/// so it's short, though longer than a client reuses one for ([`remote::KEEP_IDLE`]).
const KEPT_WAIT: Duration = Duration::from_secs(2);

/// How many of the web client's files may be on their way at once, and to one address: as many as
/// a browser fetches from one host at a time. Every client of `tailscale serve` comes from
/// loopback, so they share one address's share.
const MAX_FILE_RESPONSES: usize = 16;
const MAX_FILE_RESPONSES_PER_IP: usize = 6;

/// How much of a file is read and sent at a time.
const FILE_CHUNK: usize = 16 * 1024;

/// The web client's Content Security Policy, as a header, which unlike vite.config.ts's `<meta>`
/// can forbid framing. Its scripts are this origin's only, and it connects only here and to Open
/// VSX, which Settings > Appearance adds color themes from.
const WEB_CSP: &str = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; \
    img-src 'self' data: https://github.com https://*.githubusercontent.com https://open-vsx.org \
    https://openvsx.eclipsecontent.org; \
    connect-src 'self' https://open-vsx.org https://openvsx.eclipsecontent.org; \
    object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

/// The remote listener's state, shared with `remote/*`.
#[derive(Debug)]
pub(crate) struct Remote {
    pub port: u16,
    /// Bound instead of every IPv4 address, and reported as the only route. Tests only.
    pub address: Option<IpAddr>,
    /// The web client's files: the renderer build, with `web.html` and `assets/`.
    pub web_dir: Option<PathBuf>,
    /// The listener's certificate fingerprint while it's bound, for Settings to show.
    pub fingerprint: Mutex<Option<String>>,
    /// How long a pairing code works. [`CODE_LIFETIME`], except in tests.
    code_lifetime: Duration,
    /// Wakes the listener at once, when `host/settings/set` changes `remote` or a new code
    /// starts, so it ends the pairing when the code expires.
    pub changed: Notify,
    /// Whether the listener is bound now.
    pub listening: AtomicBool,
    /// Why the listener isn't bound while `remote` is on, such as the port being taken.
    pub problem: Mutex<Option<String>>,
    /// The pairing code waiting, if any. A new code replaces it.
    pairing: Mutex<Option<Pairing>>,
    /// Unused WebSocket tickets: the session each opens, and when it stops working.
    tickets: Mutex<HashMap<String, (String, Instant)>>,
    /// The `DPoP` proofs seen lately, by key thumbprint and `jti`, so none is used twice.
    proofs: Mutex<HashMap<String, Instant>>,
    /// Each session's connections close when its token is cancelled.
    sessions: Mutex<HashMap<String, CancellationToken>>,
    /// Account sign-in's approvals (0091).
    pub access: access::Access,
}

impl Remote {
    pub(crate) fn new(
        port: u16,
        address: Option<IpAddr>,
        web_dir: Option<PathBuf>,
        code_lifetime: Duration,
    ) -> Self {
        Self {
            port,
            address,
            web_dir,
            fingerprint: Mutex::default(),
            code_lifetime,
            changed: Notify::new(),
            listening: AtomicBool::new(false),
            problem: Mutex::default(),
            pairing: Mutex::default(),
            tickets: Mutex::default(),
            proofs: Mutex::default(),
            sessions: Mutex::default(),
            access: access::Access::default(),
        }
    }

    /// Starts a pairing with a new code, which replaces any earlier one, and advertises this host
    /// as `name` over mDNS until it ends. A `setup` code is a new computer's (0091): 6 digits, for
    /// 10 minutes, and a client that pairs with it is approved for account sign-in. Answers with
    /// the code and when it stops working.
    pub(crate) fn new_pairing(&self, name: &str, setup: bool) -> (String, jiff::Timestamp) {
        let (code, lifetime) = if setup {
            (remote::new_setup_code(), SETUP_CODE_LIFETIME)
        } else {
            (remote::new_code(), self.code_lifetime)
        };
        // A test's listener on loopback has nothing to advertise.
        let advert = self
            .address
            .is_none()
            .then(|| advertise(name, self.port))
            .flatten();
        let pairing = Pairing {
            code: code.clone(),
            setup,
            expires: Instant::now() + lifetime,
            wrong: 0,
            pending: HashMap::new(),
            advert,
        };
        if let Some(old) = self.lock_pairing().replace(pairing) {
            old.end();
        }
        // The listener's loop waits for the new expiry.
        self.changed.notify_one();
        let expires = jiff::Timestamp::now()
            + jiff::SignedDuration::try_from(lifetime).expect("a short lifetime");
        (code, expires)
    }

    /// The waiting code and when it expires, for the listener to end the pairing then.
    fn pairing_deadline(&self) -> Option<(String, Instant)> {
        self.lock_pairing()
            .as_ref()
            .map(|p| (p.code.clone(), p.expires))
    }

    /// Whether a code is waiting, and so this host advertises itself.
    pub(crate) fn pairing(&self) -> bool {
        self.lock_pairing().is_some()
    }

    fn lock_pairing(&self) -> MutexGuard<'_, Option<Pairing>> {
        lock(&self.pairing)
    }

    /// Ends the pairing with `code`, or any pairing without one, and stops advertising.
    pub(crate) fn end_pairing(&self, code: Option<&str>) {
        let mut pairing = self.lock_pairing();
        if pairing
            .as_ref()
            .is_some_and(|p| code.is_none_or(|c| p.code == c))
        {
            pairing.take().expect("a pairing").end();
        }
    }

    /// The host's side of a started SPAKE2 exchange: its answer and the exchange's id, while a
    /// code waits.
    fn start_pake(
        &self,
        fingerprint: &str,
        client: &[u8],
    ) -> Result<(String, Vec<u8>), &'static str> {
        let mut pairing = self.lock_pairing();
        let now = Instant::now();
        let Some(waiting) = pairing.as_mut().filter(|p| now < p.expires) else {
            return Err("no pairing code is waiting");
        };
        let (answer, key) = remote::pake_host(&waiting.code, fingerprint, client)
            .map_err(|_| "a bad SPAKE2 message")?;
        if waiting.setup && !self.access.setup_run() {
            return Err("too many tries with setup codes this hour");
        }
        waiting.pending.retain(|_, (_, expires)| now < *expires);
        if waiting.pending.len() >= MAX_PENDING_PAKES {
            let oldest = waiting
                .pending
                .iter()
                .min_by_key(|(_, (_, expires))| *expires)
                .map(|(id, _)| id.clone());
            if let Some(oldest) = oldest {
                waiting.pending.remove(&oldest);
            }
        }
        let id = remote::random_token(16);
        waiting
            .pending
            .insert(id.clone(), (key, now + PAKE_LIFETIME));
        Ok((id, answer))
    }

    /// Checks the client's confirmation for exchange `id`: the shared key when it's right, which
    /// uses up the code, and whether it was a setup code. A wrong one counts against the code, and
    /// the last allowed one locks it.
    fn finish_pake(
        &self,
        id: &str,
        fingerprint: &str,
        thumbprint: &str,
        mac: &[u8],
    ) -> Result<(Vec<u8>, bool), &'static str> {
        let mut pairing = self.lock_pairing();
        let now = Instant::now();
        let Some(waiting) = pairing.as_mut().filter(|p| now < p.expires) else {
            return Err("no pairing code is waiting");
        };
        let Some((key, expires)) = waiting.pending.remove(id) else {
            return Err("an unknown pairing exchange");
        };
        if now >= expires {
            return Err("a pairing exchange that took too long");
        }
        if remote::confirms(&key, b"client", fingerprint, thumbprint, mac) {
            let used = pairing.take().expect("a pairing");
            let setup = used.setup;
            used.end();
            return Ok((key, setup));
        }
        Err(wrong_code(&mut pairing))
    }

    /// Uses up the waiting code if `code` is it, for a browser (PLX-651). A wrong one counts
    /// against the code as a wrong confirmation does, so guesses get the same 5 tries.
    fn use_code(&self, code: &str) -> Result<(), &'static str> {
        let mut pairing = self.lock_pairing();
        // A setup code is for SPAKE2 only, which approves the key that ran it.
        let waiting = pairing.as_ref().filter(|p| !p.setup);
        let Some(waiting) = waiting.filter(|p| Instant::now() < p.expires) else {
            return Err("no pairing code is waiting");
        };
        if waiting.code == code {
            pairing.take().expect("a pairing").end();
            return Ok(());
        }
        Err(wrong_code(&mut pairing))
    }

    /// Records a proof's `jti` for its key. False when it was seen already.
    fn first_use(&self, proven: &remote::Proven) -> bool {
        let mut proofs = lock(&self.proofs);
        let now = Instant::now();
        proofs.retain(|_, seen| now.duration_since(*seen) < REPLAY_MEMORY);
        proofs
            .insert(format!("{}:{}", proven.thumbprint, proven.jti), now)
            .is_none()
    }

    fn new_ticket(&self, session: String) -> String {
        let ticket = remote::random_token(24);
        let mut tickets = lock(&self.tickets);
        let now = Instant::now();
        tickets.retain(|_, (_, expires)| now < *expires);
        tickets.insert(ticket.clone(), (session, now + TICKET_LIFETIME));
        ticket
    }

    /// Uses up `ticket`: the session it opens, unless it's unknown or expired.
    fn take_ticket(&self, ticket: &str) -> Option<String> {
        let (session, expires) = lock(&self.tickets).remove(ticket)?;
        (Instant::now() < expires).then_some(session)
    }

    /// A token that closes one connection of `session`'s, when the listener `closing` closes or
    /// the session is revoked.
    fn watch(&self, session: &str, closing: &CancellationToken) -> CancellationToken {
        let mut sessions = lock(&self.sessions);
        let token = sessions
            .entry(session.to_owned())
            .or_insert_with(|| closing.child_token());
        // A session's token from a listener that has since closed.
        if token.is_cancelled() {
            *token = closing.child_token();
        }
        token.child_token()
    }

    /// Closes every connection of `session`'s.
    pub(crate) fn revoke(&self, session: &str) {
        let token = lock(&self.sessions).remove(session);
        if let Some(token) = token {
            token.cancel();
        }
    }
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

/// Counts a wrong code against the waiting pairing, and ends it at the last allowed one.
fn wrong_code(pairing: &mut Option<Pairing>) -> &'static str {
    if let Some(waiting) = pairing.as_mut() {
        waiting.wrong += 1;
        if waiting.wrong >= remote::MAX_WRONG_CODES {
            warn!("locked the pairing code after too many wrong tries");
            pairing.take().expect("a pairing").end();
        }
    }
    "a wrong pairing code"
}

/// A pairing code waiting to be used.
struct Pairing {
    code: String,
    /// A new computer's setup code (0091), not 0065's.
    setup: bool,
    expires: Instant,
    /// How many wrong codes have been tried.
    wrong: u32,
    /// Started SPAKE2 exchanges, by id: the shared key, and when the exchange stops waiting.
    pending: HashMap<String, (Vec<u8>, Instant)>,
    /// The mDNS advertisement, while it runs.
    advert: Option<mdns_sd::ServiceDaemon>,
}

impl std::fmt::Debug for Pairing {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Pairing")
            .field("wrong", &self.wrong)
            .finish_non_exhaustive()
    }
}

impl Pairing {
    /// Stops advertising.
    fn end(self) {
        if let Some(advert) = self.advert {
            let _ = advert.shutdown();
        }
    }
}

/// Advertises this host as `name` on `port` over mDNS, with no TXT data, or logs why it can't.
fn advertise(name: &str, port: u16) -> Option<mdns_sd::ServiceDaemon> {
    let label: String = name
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '-' })
        .collect();
    // Not the OS's own host name, which macOS's mDNSResponder already answers for.
    let host = format!("{}-parallax.local.", label.trim_matches('-'));
    let advertised = mdns_sd::ServiceDaemon::new().and_then(|mdns| {
        let none: Option<HashMap<String, String>> = None;
        let info = mdns_sd::ServiceInfo::new(remote::SERVICE_TYPE, name, &host, (), port, none)?
            .enable_addr_auto();
        mdns.register(info)?;
        Ok(mdns)
    });
    match advertised {
        Ok(mdns) => Some(mdns),
        Err(error) => {
            warn!(%error, "could not advertise this host for pairing over mDNS");
            None
        }
    }
}

struct Bound {
    listener: TcpListener,
    key: Arc<HostKey>,
    tls: TlsAcceptor,
    /// Closes every connection this listener accepted. A child of the server's abort token.
    closing: CancellationToken,
    /// The web client's files on their way.
    files: Checks,
}

/// Keeps the listener in line with the `remote` setting until `stop`.
pub(super) async fn run(serving: Serving, stop: CancellationToken) {
    let remote = &serving.daemon.remote;
    let mut bound: Option<Bound> = None;
    let mut settle = true;
    // Set when `remote` is on and the bind failed, so it tries again.
    let mut retry = false;
    let mut connection_id = 0_u64;
    let checks = Checks::new(MAX_PENDING, MAX_PENDING_PER_IP);
    loop {
        if settle {
            settle = false;
            match (wanted(&serving.daemon).await, bound.is_some()) {
                (Ok(true), false) => {
                    bound = bind(&serving).await;
                    retry = bound.is_none();
                }
                (Ok(false), true) => {
                    info!("stopped listening for remote clients: remote is off");
                    bound.take().expect("bound").closing.cancel();
                    remote.end_pairing(None);
                }
                (Ok(false), false) => {
                    retry = false;
                    *lock(&remote.problem) = None;
                }
                (Err(error), _) => {
                    warn!(error = %error.message, "could not read the remote setting");
                }
                (Ok(true), true) => {}
            }
            remote.listening.store(bound.is_some(), Ordering::Relaxed);
        }
        // An expired code stops advertising, and its mDNS thread, at once.
        let deadline = remote.pairing_deadline();
        let expiry = deadline
            .as_ref()
            .map_or_else(time::Instant::now, |(_, at)| time::Instant::from_std(*at));
        tokio::select! {
            biased;
            () = stop.cancelled() => break,
            () = remote.changed.notified() => settle = true,
            () = time::sleep_until(expiry), if deadline.is_some() => {
                let code = deadline.map(|(code, _)| code);
                remote.end_pairing(code.as_deref());
            }
            () = time::sleep(BIND_RETRY), if retry => settle = true,
            accepted = accept(bound.as_ref()) => match accepted {
                Ok((stream, peer)) => {
                    connection_id += 1;
                    if !remote::is_local_network(peer.ip()) {
                        warn!(%peer, "refused a remote connection from outside the local network");
                        continue;
                    }
                    let Some(check) = checks.start(peer.ip()) else {
                        debug!(%peer, "closed a remote connection: too many are pending");
                        continue;
                    };
                    let bound = bound.as_ref().expect("accepted");
                    serving.admit_remote(stream, peer, bound, (check, checks.clone()), connection_id);
                }
                Err(error) => {
                    warn!(%error, "could not accept a remote connection");
                    time::sleep(ACCEPT_BACKOFF).await;
                }
            },
        }
    }
    // Shutdown drains the listener's connections like local ones, so it doesn't close them.
    remote.listening.store(false, Ordering::Relaxed);
}

async fn wanted(daemon: &Daemon) -> Result<bool, ErrorObject> {
    daemon
        .reader
        .run(&CancellationToken::new(), |db| {
            db.remote().map_err(|e| store_error(&e))
        })
        .await
}

/// This plxd's certificate, made the first time `remote` is on.
pub(crate) async fn host_key(daemon: &Daemon) -> io::Result<HostKey> {
    let path = daemon.data_dir.root().join("remote-key");
    tokio::task::spawn_blocking(move || HostKey::load_or_create(&path))
        .await
        .map_err(io::Error::other)?
}

/// Binds the listener with this plxd's certificate, or logs why it can't.
async fn bind(serving: &Serving) -> Option<Bound> {
    let daemon = &serving.daemon;
    let remote = &daemon.remote;
    let key = match host_key(daemon).await {
        Ok(key) => Arc::new(key),
        Err(error) => {
            warn!(%error, "could not read or make the remote certificate");
            return None;
        }
    };
    let tls = match key.server_config() {
        Ok(config) => TlsAcceptor::from(config),
        Err(error) => {
            warn!(%error, "could not use the remote certificate");
            return None;
        }
    };
    let address = SocketAddr::new(
        remote.address.unwrap_or(IpAddr::V4(Ipv4Addr::UNSPECIFIED)),
        remote.port,
    );
    match TcpListener::bind(address).await {
        Ok(listener) => {
            info!(%address, fingerprint = %key.fingerprint, "listening for remote clients");
            *lock(&remote.fingerprint) = Some(key.fingerprint.clone());
            *lock(&remote.problem) = None;
            Some(Bound {
                listener,
                key,
                tls,
                closing: serving.abort.child_token(),
                files: Checks::new(MAX_FILE_RESPONSES, MAX_FILE_RESPONSES_PER_IP),
            })
        }
        Err(error) => {
            warn!(%address, %error, "could not listen for remote clients");
            let why = if error.kind() == io::ErrorKind::AddrInUse {
                format!("Port {} is in use by another program.", remote.port)
            } else {
                format!("Parallax couldn't listen on port {}: {error}", remote.port)
            };
            *lock(&remote.problem) = Some(why);
            None
        }
    }
}

async fn accept(bound: Option<&Bound>) -> io::Result<(TcpStream, SocketAddr)> {
    match bound {
        Some(bound) => bound.listener.accept().await,
        None => std::future::pending().await,
    }
}

/// A request plxd read: its method, path with query, headers by lowercase name, and body.
struct Request {
    method: String,
    path: String,
    headers: HashMap<String, String>,
    body: Vec<u8>,
    /// A webhook whose body is over [`MAX_HOOK_BYTES`]: it was not read, and gets a 413.
    too_large: bool,
    /// What was read behind the request, under [`READ_CHUNK`] bytes: a client's first WebSocket
    /// frames, sent without waiting for the upgrade's answer (PLX-1483). Nothing reads it but the
    /// WebSocket of a `/ws` upgrade that passed every check ([`serve_socket`]).
    early: Vec<u8>,
}

impl Request {
    fn header(&self, name: &str) -> Option<&str> {
        self.headers.get(name).map(String::as_str)
    }

    /// Whether the client asked to keep the connection for another request. Clients from before
    /// PLX-1462 send `Connection: close`.
    fn keeps_alive(&self) -> bool {
        self.header("connection")
            .is_some_and(|value| value.eq_ignore_ascii_case("keep-alive"))
    }

    /// The query parameter `name`.
    fn query(&self, name: &str) -> Option<&str> {
        let (_, query) = self.path.split_once('?')?;
        query
            .split('&')
            .find_map(|pair| pair.strip_prefix(name)?.strip_prefix('='))
    }

    /// The URL a `DPoP` proof for this request names: the scheme, `Host`, and path.
    fn url(&self) -> String {
        let path = self.path.split('?').next().unwrap_or_default();
        format!("https://{}{path}", self.header("host").unwrap_or_default())
    }

    /// Checks this `POST`'s `DPoP` proof, bound to `access_token` when it has one.
    fn proof(&self, access_token: Option<&str>) -> Result<remote::Proven, &'static str> {
        self.proof_for("POST", access_token)
    }

    /// Checks this request's `DPoP` proof for `method`, bound to `access_token` when it has one.
    fn proof_for(
        &self,
        method: &str,
        access_token: Option<&str>,
    ) -> Result<remote::Proven, &'static str> {
        let proof = self.header("dpop").unwrap_or_default();
        let now = remote::now_seconds();
        remote::verify_proof(proof, method, &self.url(), now, access_token)
    }
}

/// Reads one request: its head, up to [`MAX_REQUEST_BYTES`], and its body by `Content-Length` or
/// in chunks. A webhook's body may be up to [`MAX_HOOK_BYTES`]; a longer one is left unread and
/// marked `too_large`. Any other request too long for its cap is `None`.
async fn read_request<S: AsyncRead + Unpin>(stream: &mut S) -> io::Result<Option<Request>> {
    let mut buffer = Vec::with_capacity(READ_CHUNK);
    let mut chunk = [0; READ_CHUNK];
    loop {
        let read = stream.read(&mut chunk).await?;
        if read == 0 {
            return Ok(None);
        }
        buffer.extend_from_slice(&chunk[..read]);
        let mut headers = [httparse::EMPTY_HEADER; 32];
        let mut parsed = httparse::Request::new(&mut headers);
        match parsed.parse(&buffer) {
            Ok(httparse::Status::Complete(length)) => {
                let headers: HashMap<String, String> = parsed
                    .headers
                    .iter()
                    .map(|h| {
                        (
                            h.name.to_ascii_lowercase(),
                            String::from_utf8_lossy(h.value).into_owned(),
                        )
                    })
                    .collect();
                let path = parsed.path.unwrap_or_default().to_owned();
                let hook = path.starts_with("/api/hooks/");
                let max = if hook {
                    MAX_HOOK_BYTES
                } else {
                    MAX_REQUEST_BYTES - length.min(MAX_REQUEST_BYTES)
                };
                let mut request = Request {
                    method: parsed.method.unwrap_or_default().to_owned(),
                    path,
                    headers,
                    body: Vec::new(),
                    too_large: false,
                    early: Vec::new(),
                };
                let mut rest = buffer.split_off(length);
                let chunked = request
                    .header("transfer-encoding")
                    .is_some_and(|coding| coding.to_ascii_lowercase().contains("chunked"));
                let body = if chunked {
                    read_chunked(stream, rest, max).await?
                } else {
                    let wanted: usize = request
                        .header("content-length")
                        .and_then(|n| n.parse().ok())
                        .unwrap_or(0);
                    request.early = rest.split_off(wanted.min(rest.len()));
                    read_sized(stream, rest, wanted, max).await?
                };
                match body {
                    Some(body) => request.body = body,
                    None if hook => request.too_large = true,
                    None => return Ok(None),
                }
                return Ok(Some(request));
            }
            Ok(httparse::Status::Partial) if buffer.len() < MAX_REQUEST_BYTES => {}
            _ => return Ok(None),
        }
    }
}

/// A body of `wanted` bytes, the first of them already in `rest`; `None` when it is over `max`.
async fn read_sized<S: AsyncRead + Unpin>(
    stream: &mut S,
    mut rest: Vec<u8>,
    wanted: usize,
    max: usize,
) -> io::Result<Option<Vec<u8>>> {
    if wanted > max {
        return Ok(None);
    }
    let have = rest.len().min(wanted);
    rest.resize(wanted, 0);
    if have < wanted {
        stream.read_exact(&mut rest[have..]).await?;
    }
    Ok(Some(rest))
}

/// A chunked body, the first of it already in `rest`; `None` when it is over `max`.
async fn read_chunked<S: AsyncRead + Unpin>(
    stream: &mut S,
    mut rest: Vec<u8>,
    max: usize,
) -> io::Result<Option<Vec<u8>>> {
    let invalid = || io::Error::new(io::ErrorKind::InvalidData, "a malformed chunked body");
    let mut body = Vec::new();
    loop {
        let line = read_line(stream, &mut rest).await?;
        let size = line.split(';').next().unwrap_or_default().trim();
        let size = usize::from_str_radix(size, 16).map_err(|_| invalid())?;
        if size == 0 {
            // Trailers, to the empty line that ends them.
            while !read_line(stream, &mut rest).await?.is_empty() {}
            return Ok(Some(body));
        }
        if body.len().saturating_add(size) > max {
            return Ok(None);
        }
        fill(stream, &mut rest, size + 2).await?;
        if &rest[size..size + 2] != b"\r\n" {
            return Err(invalid());
        }
        body.extend_from_slice(&rest[..size]);
        rest.drain(..size + 2);
    }
}

/// Reads until `rest` holds at least `wanted` bytes.
async fn fill<S: AsyncRead + Unpin>(
    stream: &mut S,
    rest: &mut Vec<u8>,
    wanted: usize,
) -> io::Result<()> {
    let mut chunk = [0; 8192];
    while rest.len() < wanted {
        let read = stream.read(&mut chunk).await?;
        if read == 0 {
            return Err(io::ErrorKind::UnexpectedEof.into());
        }
        rest.extend_from_slice(&chunk[..read]);
    }
    Ok(())
}

/// The next line of `rest`, reading more as needed, without its CRLF. A chunk-size or trailer
/// line is short, so one over 4 KiB is refused.
async fn read_line<S: AsyncRead + Unpin>(stream: &mut S, rest: &mut Vec<u8>) -> io::Result<String> {
    loop {
        if let Some(at) = rest.windows(2).position(|pair| pair == b"\r\n") {
            let line = String::from_utf8_lossy(&rest[..at]).into_owned();
            rest.drain(..at + 2);
            return Ok(line);
        }
        if rest.len() > 4096 {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "a line is too long",
            ));
        }
        let wanted = rest.len() + 1;
        fill(stream, rest, wanted).await?;
    }
}

/// Writes a JSON answer with `status`, and closes the connection.
async fn respond<S: AsyncWrite + Unpin>(
    stream: &mut S,
    status: u16,
    body: &serde_json::Value,
) -> io::Result<()> {
    respond_kept(stream, status, body, false).await
}

/// Writes a JSON answer with `status`, and closes the connection unless `keep_alive`.
async fn respond_kept<S: AsyncWrite + Unpin>(
    stream: &mut S,
    status: u16,
    body: &serde_json::Value,
    keep_alive: bool,
) -> io::Result<()> {
    let reason = match status {
        200 => "OK",
        202 => "Accepted",
        400 => "Bad Request",
        401 => "Unauthorized",
        403 => "Forbidden",
        404 => "Not Found",
        409 => "Conflict",
        413 => "Content Too Large",
        503 => "Service Unavailable",
        429 => "Too Many Requests",
        _ => "Internal Server Error",
    };
    let body = body.to_string();
    let mut answer = format!(
        "HTTP/1.1 {status} {reason}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nCache-Control: no-store\r\nConnection: {}\r\n",
        body.len(),
        if keep_alive { "keep-alive" } else { "close" }
    );
    if status == 401 {
        answer.push_str("WWW-Authenticate: DPoP algs=\"ES256\"\r\n");
    }
    answer.push_str("\r\n");
    answer.push_str(&body);
    stream.write_all(answer.as_bytes()).await?;
    if keep_alive {
        stream.flush().await
    } else {
        stream.shutdown().await
    }
}

fn refused(why: &str) -> (u16, serde_json::Value) {
    (
        401,
        json!({ "error": "invalid_grant", "error_description": why }),
    )
}

impl Serving {
    /// Runs TLS and reads one request, then answers it, and then the next while a sign-in's step
    /// answered 202 and asked to keep the connection. `check` is held until the first request is
    /// read, and a slot of `checks` while each next one is awaited. It runs as one of the server's
    /// connections, so shutdown waits for it.
    fn admit_remote(
        &self,
        stream: TcpStream,
        peer: SocketAddr,
        bound: &Bound,
        (check, checks): (Check, Checks),
        id: u64,
    ) {
        let daemon = Arc::clone(&self.daemon);
        let stop_reading = self.stop_reading.clone();
        let key = Arc::clone(&bound.key);
        let tls = bound.tls.clone();
        let closing = bound.closing.clone();
        let files = bound.files.clone();
        self.connections.spawn(
            async move {
                let read = async {
                    let mut stream = tls.accept(stream).await?;
                    let request = read_request(&mut stream).await?;
                    Ok::<_, io::Error>(request.map(|request| (stream, request)))
                };
                let read = tokio::select! {
                    read = time::timeout(remote::REQUEST_TIMEOUT, read) => read,
                    () = closing.cancelled() => return,
                };
                drop(check);
                let (mut stream, mut request) = match read {
                    Ok(Ok(Some(read))) => read,
                    Ok(Ok(None)) => return debug!(%peer, "closed a remote connection without a request"),
                    Ok(Err(error)) => return debug!(%peer, %error, "a remote connection failed"),
                    Err(_) => return debug!(%peer, "closed a remote connection that sent no request in time"),
                };
                loop {
                    let route = request.path.split('?').next().unwrap_or_default();
                    let guarded = route == "/ws" || route.starts_with("/api/pair/") || route.starts_with("/api/auth/");
                    let (status, body) = match (request.method.as_str(), route) {
                        _ if guarded && !same_origin(&request) => {
                            (403, json!({ "error": "forbidden", "error_description": "another origin" }))
                        }
                        ("GET", "/ws") => {
                            return serve_socket(stream, &request, daemon, stop_reading, &closing, peer).await;
                        }
                        ("GET", path) if web_file(path).is_some() && web_on(&daemon).await => {
                            let Some(slot) = files.start(peer.ip()) else {
                                let busy = json!({ "error": "busy" });
                                let _ = time::timeout(remote::REQUEST_TIMEOUT, respond(&mut stream, 503, &busy)).await;
                                return debug!(%peer, "refused a web client file: too many on their way");
                            };
                            let file = web_file(path).expect("a web file");
                            serve_file(stream, &daemon, &file, peer).await;
                            return drop(slot);
                        }
                        ("GET", "/.well-known/parallax") => (200, descriptor(&daemon, &key).await),
                        ("POST", "/api/pair/start") => start_pairing(&daemon, &key, &request),
                        ("POST", "/api/pair/finish") => finish_pairing(&daemon, &key, &request).await,
                        ("POST", "/api/pair/browser") if web_on(&daemon).await => {
                            pair_browser(&daemon, &request).await
                        }
                        ("POST", "/api/auth/websocket-ticket") => ticket(&daemon, &request).await,
                        ("POST", "/api/auth/account") => access::sign_in(&daemon, &key, &request).await,
                        ("POST", "/api/auth/approval") => access::approval(&daemon, &key, &request).await,
                        ("POST", "/api/auth/peer") => access::peer(&daemon, &request).await,
                        _ if request.too_large => (413, json!({ "error": "body_too_large" })),
                        (method, hook) if hook.starts_with("/api/hooks/") => {
                            let Request { path, headers, body, .. } = &request;
                            crate::schedules::hook(&daemon, method, path, headers, body, None).await
                        }
                        _ => (404, json!({ "error": "not_found" })),
                    };
                    // A webhook's path holds its token, so the log names only the route.
                    let route = if route.starts_with("/api/hooks/") { "/api/hooks/…" } else { route };
                    if !matches!(status, 200 | 202) {
                        warn!(%peer, path = route, status, "refused a remote request");
                    }
                    // A sign-in's steps follow each other on one connection, so through the relay
                    // they take one stream (PLX-1462): only a 202 has a next step. Waiting for it
                    // takes a pending slot, as a new connection's request does, and with none free
                    // the connection ends. Any other answer ends it too.
                    let sign_in = matches!(route, "/api/auth/account" | "/api/auth/approval");
                    let waiting = (sign_in && status == 202 && request.keeps_alive())
                        .then(|| checks.start(peer.ip()))
                        .flatten();
                    let answered = respond_kept(&mut stream, status, &body, waiting.is_some());
                    let answered = time::timeout(remote::REQUEST_TIMEOUT, answered).await;
                    if waiting.is_none() || !matches!(answered, Ok(Ok(()))) {
                        return;
                    }
                    let next = tokio::select! {
                        next = time::timeout(KEPT_WAIT, read_request(&mut stream)) => next,
                        () = closing.cancelled() => return,
                        () = stop_reading.cancelled() => return,
                    };
                    drop(waiting);
                    match next {
                        Ok(Ok(Some(next))) => request = next,
                        _ => return debug!(%peer, "closed a kept-alive remote connection"),
                    }
                }
            }
            .instrument(info_span!("remote", id)),
        );
    }
}

async fn descriptor(daemon: &Daemon, key: &HostKey) -> serde_json::Value {
    let descriptor = Descriptor {
        host_id: key.fingerprint.clone(),
        name: host_name(daemon).await,
        plxd: crate::version().to_owned(),
        routes: routes(daemon).await,
    };
    serde_json::to_value(descriptor).expect("plain JSON")
}

/// `POST /api/pair/start`: the host's SPAKE2 answer to the client's message, while a code waits.
fn start_pairing(daemon: &Daemon, key: &HostKey, request: &Request) -> (u16, serde_json::Value) {
    let client = serde_json::from_slice::<serde_json::Value>(&request.body)
        .ok()
        .and_then(|body| body["pake"].as_str().map(str::to_owned))
        .and_then(|pake| data_encoding::BASE64URL_NOPAD.decode(pake.as_bytes()).ok());
    let Some(client) = client else {
        return (400, json!({ "error": "invalid_request" }));
    };
    match daemon.remote.start_pake(&key.fingerprint, &client) {
        Ok((id, answer)) => (
            200,
            json!({ "pairing": id, "pake": remote::base64url(&answer) }),
        ),
        Err(why) => refused(why),
    }
}

/// `POST /api/pair/finish`: the client's key confirmation, with a `DPoP` proof. A right one gets
/// a session bound to the proof's key, and the host's own confirmation.
async fn finish_pairing(
    daemon: &Daemon,
    key: &HostKey,
    request: &Request,
) -> (u16, serde_json::Value) {
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Finish {
        pairing: String,
        confirm: String,
        #[serde(default)]
        client_label: String,
    }
    let finish = serde_json::from_slice::<Finish>(&request.body).ok();
    let mac = finish.as_ref().and_then(|f| {
        data_encoding::BASE64URL_NOPAD
            .decode(f.confirm.as_bytes())
            .ok()
    });
    let (Some(finish), Some(mac)) = (finish, mac) else {
        return (400, json!({ "error": "invalid_request" }));
    };
    let proven = match request.proof(None) {
        Ok(proven) => proven,
        Err(why) => return refused(why),
    };
    let fp = &key.fingerprint;
    let (shared, setup) =
        match daemon
            .remote
            .finish_pake(&finish.pairing, fp, &proven.thumbprint, &mac)
        {
            Ok(shared) => shared,
            Err(why) => return refused(why),
        };
    // Only a client that knew the code gets its proof remembered, so strangers can't grow the map.
    if !daemon.remote.first_use(&proven) {
        return refused("a replayed DPoP proof");
    }
    // A setup code approves the key that typed it for account sign-in (0091).
    if setup
        && let Err(refusal) = access::approve_by_setup(daemon, &proven, &finish.client_label).await
    {
        return refusal;
    }
    let token = match new_session(daemon, &proven, &finish.client_label, false).await {
        Ok(token) => token,
        Err(refusal) => return refusal,
    };
    let confirm = remote::confirmation(&shared, b"host", fp, &proven.thumbprint);
    (
        200,
        json!({
            "accessToken": token,
            "tokenType": "DPoP",
            "confirm": remote::base64url(&confirm),
            "name": host_name(daemon).await,
            "routes": routes(daemon).await,
        }),
    )
}

/// Keeps a new session bound to the key of `proven`, named `label`, and answers with its token.
/// A key the account removed gets none: checked in the same write that keeps the session, so a
/// removal can't land between the check and the session (0091).
async fn new_session(
    daemon: &Daemon,
    proven: &remote::Proven,
    label: &str,
    browser: bool,
) -> Result<String, (u16, serde_json::Value)> {
    let token = remote::random_token(32);
    let session = StoredSession {
        id: uuid::Uuid::new_v4().to_string(),
        name: clean_name(label),
        token_hash: remote::hex(&remote::sha256(token.as_bytes())),
        thumbprint: proven.thumbprint.clone(),
        created_at: jiff::Timestamp::now().to_string(),
        browser,
        peer: false,
    };
    let name = session.name.clone();
    let stored = daemon
        .store
        .run(&CancellationToken::new(), move |db| {
            if access::read_lists(db)?
                .removed_clients
                .contains(&session.thumbprint)
            {
                return Ok(false);
            }
            let mut sessions = read_sessions(db)?;
            sessions.push(session);
            write_sessions(db, &sessions)?;
            Ok(true)
        })
        .await;
    match stored {
        Ok(true) => {
            info!(%name, "paired a remote client");
            Ok(token)
        }
        Ok(false) => Err(access::removed(remote::DEVICE_REMOVED)),
        Err(error) => {
            warn!(error = %error.message, "could not keep a remote session");
            Err((500, json!({ "error": "server_error" })))
        }
    }
}

/// `POST /api/pair/browser` (PLX-651): the waiting code, typed into a browser, with a `DPoP`
/// proof. A right one gets a session bound to the proof's key.
async fn pair_browser(daemon: &Daemon, request: &Request) -> (u16, serde_json::Value) {
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Pair {
        code: String,
        #[serde(default)]
        client_label: String,
    }
    let Ok(pair) = serde_json::from_slice::<Pair>(&request.body) else {
        return (400, json!({ "error": "invalid_request" }));
    };
    let proven = match request.proof(None) {
        Ok(proven) => proven,
        Err(why) => return refused(why),
    };
    // A replayed proof is refused before it can use up or count against the code. Proofs are only
    // remembered while a code waits, so strangers can't grow the map at other times.
    if !daemon.remote.pairing() {
        return refused("no pairing code is waiting");
    }
    if !daemon.remote.first_use(&proven) {
        return refused("a replayed DPoP proof");
    }
    if let Err(why) = daemon.remote.use_code(&remote::normalize_code(&pair.code)) {
        return refused(why);
    }
    let token = match new_session(daemon, &proven, &pair.client_label, true).await {
        Ok(token) => token,
        Err(refusal) => return refusal,
    };
    (
        200,
        json!({ "accessToken": token, "tokenType": "DPoP", "name": host_name(daemon).await }),
    )
}

/// Whether a request comes from this host's own origin, or from no browser at all: a browser
/// sends `Origin` with every WebSocket and POST, and a page elsewhere can't set it.
fn same_origin(request: &Request) -> bool {
    request.header("origin").is_none_or(|origin| {
        request
            .header("host")
            .is_some_and(|host| origin == format!("https://{host}"))
    })
}

/// Whether the web client is on: `remoteWeb`, read for each request so turning it off takes effect
/// at once.
async fn web_on(daemon: &Daemon) -> bool {
    daemon
        .reader
        .run(&CancellationToken::new(), |db| {
            db.remote_web().map_err(|e| store_error(&e))
        })
        .await
        .unwrap_or(false)
}

/// The web client's file a `GET` of `path` names: `web.html` for `/`, or a file directly in
/// `assets/` named with letters, digits, `.`, `_`, and `-` only, so no path leaves the folder.
/// [`serve_file`] then serves it only if `assets/` lists that exact name, which leaves out
/// Windows' device names (`CON`, `NUL`, `COM1`) and the trailing dots it strips.
fn web_file(path: &str) -> Option<String> {
    if path == "/" {
        return Some("web.html".to_owned());
    }
    let name = path.strip_prefix("/assets/")?;
    let plain = !name.starts_with('.')
        && name
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"._-".contains(&b));
    (plain && !name.is_empty()).then(|| format!("assets/{name}"))
}

/// `write`, unless the reader takes none of it for [`remote::REQUEST_TIMEOUT`].
async fn step(write: impl Future<Output = io::Result<()>>) -> io::Result<()> {
    time::timeout(remote::REQUEST_TIMEOUT, write)
        .await
        .unwrap_or_else(|_| Err(io::ErrorKind::TimedOut.into()))
}

/// Whether `dir` lists a file named exactly `name`.
async fn lists(dir: &Path, name: &str) -> bool {
    let Ok(mut entries) = tokio::fs::read_dir(dir).await else {
        return false;
    };
    while let Ok(Some(entry)) = entries.next_entry().await {
        if entry.file_name() == name {
            return true;
        }
    }
    false
}

/// Answers with the web client's `file`, or 404 when it isn't there, as in a plxd without the app.
/// It streams in [`FILE_CHUNK`]s, and gives up on a reader that takes none of one for
/// [`remote::REQUEST_TIMEOUT`].
async fn serve_file(
    mut stream: tokio_rustls::server::TlsStream<TcpStream>,
    daemon: &Daemon,
    file: &str,
    peer: SocketAddr,
) {
    let opened = async {
        let dir = daemon
            .remote
            .web_dir
            .as_deref()
            .ok_or(io::ErrorKind::NotFound)?;
        let path = dir.join(file);
        if let Some(name) = file.strip_prefix("assets/")
            && !lists(&dir.join("assets"), name).await
        {
            return Err(io::ErrorKind::NotFound.into());
        }
        let opened = tokio::fs::File::open(&path).await?;
        let length = opened.metadata().await?.len();
        Ok::<_, io::Error>((opened, length))
    };
    let Ok((mut opened, length)) = opened.await else {
        debug!(%peer, file, "the web client has no such file");
        let _ = respond(&mut stream, 404, &json!({ "error": "not_found" })).await;
        return;
    };
    let kind = match file.rsplit('.').next() {
        Some("html") => "text/html; charset=utf-8",
        Some("js") => "text/javascript; charset=utf-8",
        Some("css") => "text/css; charset=utf-8",
        Some("woff2") => "font/woff2",
        Some("svg") => "image/svg+xml",
        Some("png") => "image/png",
        _ => "application/octet-stream",
    };
    // Asset names carry a hash of their contents, so they never change; the page always reloads.
    let cache = if file == "web.html" {
        "no-cache"
    } else {
        "public, max-age=31536000, immutable"
    };
    let head = format!(
        "HTTP/1.1 200 OK\r\nContent-Type: {kind}\r\nContent-Length: {length}\r\nCache-Control: {cache}\r\nContent-Security-Policy: {WEB_CSP}\r\nX-Content-Type-Options: nosniff\r\nReferrer-Policy: no-referrer\r\nConnection: close\r\n\r\n",
    );
    let send = async {
        step(stream.write_all(head.as_bytes())).await?;
        let mut chunk = vec![0; FILE_CHUNK];
        loop {
            let read = opened.read(&mut chunk).await?;
            if read == 0 {
                break;
            }
            step(stream.write_all(&chunk[..read])).await?;
        }
        step(stream.shutdown()).await
    };
    if let Err(error) = send.await {
        debug!(%peer, %error, file, "could not send a web client file");
    }
}

/// `POST /api/auth/websocket-ticket`: a 30 s ticket for `/ws`, for a session's token with a `DPoP`
/// proof from its key.
/// Its refusals tell the session's end apart from a bad proof, such as one from a clock that's
/// off: only `invalid_token` means pairing again. A browser's session while `remoteWeb` is off is
/// `access_denied`, and works again once it's on.
async fn ticket(daemon: &Daemon, request: &Request) -> (u16, serde_json::Value) {
    let session = match authorize(daemon, request, "POST").await {
        Ok(session) => session,
        Err(refusal) => return refusal,
    };
    let ticket = daemon.remote.new_ticket(session);
    let seconds = TICKET_LIFETIME.as_secs();
    (200, json!({ "ticket": ticket, "expiresIn": seconds }))
}

/// The session a `method` request's `Authorization: DPoP` token and `DPoP` proof stand for, or why
/// not.
async fn authorize(
    daemon: &Daemon,
    request: &Request,
    method: &str,
) -> Result<String, (u16, serde_json::Value)> {
    let refused =
        |error: &str, why: &str| (401, json!({ "error": error, "error_description": why }));
    let Some(token) = request
        .header("authorization")
        .and_then(|value| value.strip_prefix("DPoP "))
    else {
        return Err(refused("invalid_token", "no DPoP access token"));
    };
    let Some(session) = session_for(daemon, token).await else {
        return Err(refused("invalid_token", "an unknown or revoked session"));
    };
    let proven = request
        .proof_for(method, Some(token))
        .map_err(|why| refused("invalid_dpop_proof", why))?;
    if proven.thumbprint != session.thumbprint {
        return Err(refused(
            "invalid_dpop_proof",
            "a DPoP proof from another key",
        ));
    }
    if !daemon.remote.first_use(&proven) {
        return Err(refused("invalid_dpop_proof", "a replayed DPoP proof"));
    }
    if session.browser && !web_on(daemon).await {
        let why = "Open in a browser is off on this computer";
        return Err((
            403,
            json!({ "error": "access_denied", "error_description": why }),
        ));
    }
    Ok(session.id)
}

/// `GET /ws`: opens the WebSocket a session's token and proof, or a ticket, allows, and serves it
/// as a socket connection. What the client sent behind the request ([`Request::early`]) goes to
/// the WebSocket only after every check passed and the 101 went out, so it's handled as frames
/// sent later are, read-only level included. Every refusal returns first, which drops it unread.
async fn serve_socket(
    mut stream: tokio_rustls::server::TlsStream<TcpStream>,
    request: &Request,
    daemon: Arc<Daemon>,
    stop_reading: CancellationToken,
    closing: &CancellationToken,
    peer: SocketAddr,
) {
    let session = match request.query("wsTicket") {
        Some(ticket) => daemon
            .remote
            .take_ticket(ticket)
            .ok_or_else(|| refused("a wrong, used, or expired ticket")),
        // The proof opens the channel itself, a round trip shorter (0091).
        None => authorize(&daemon, request, "GET").await,
    };
    let key = request.header("sec-websocket-key");
    let upgrade = request
        .header("upgrade")
        .is_some_and(|u| u.eq_ignore_ascii_case("websocket"));
    let (Ok(session), Some(key), true) = (session.as_ref(), key, upgrade) else {
        warn!(%peer, "refused a WebSocket without a valid ticket or proof");
        let refusal = session
            .err()
            .unwrap_or_else(|| (400, json!({ "error": "invalid_request" })));
        let _ = respond(&mut stream, refusal.0, &refusal.1).await;
        return;
    };
    let session = session.clone();
    // Watched before the session is checked, so a revoke that lands in between still closes it.
    let closing = daemon.remote.watch(&session, closing);
    // A session revoked after its ticket was made, or a browser's after `remoteWeb` went off. A
    // device made read-only after this has the connection closed too, as a revoke does.
    let Some((read_only, computer)) = session_kind(&daemon, &session).await else {
        let refusal = refused("a revoked session");
        let _ = respond(&mut stream, refusal.0, &refusal.1).await;
        return;
    };
    let accept = derive_accept_key(key.as_bytes());
    let switching = format!(
        "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: {accept}\r\n\r\n"
    );
    if stream.write_all(switching.as_bytes()).await.is_err() {
        return;
    }
    info!(%peer, "accepted a remote WebSocket");
    let (early, config) = (request.early.clone(), Some(remote::websocket_config()));
    let socket = WebSocketStream::from_partially_read(stream, early, Role::Server, config).await;
    let relay_stream = daemon.relay.joined(peer);
    let (local, plain) = tokio::io::duplex(64 * 1024);
    let (local_in, local_out) = tokio::io::split(local);
    let over_relay = relay_stream.is_some();
    let ended = closing.clone();
    // Another computer's peer session is one of the user's computers, as Connect's is (0101).
    let serve = connection::serve(
        plain,
        daemon,
        stop_reading,
        closing,
        computer,
        read_only,
        over_relay,
        true,
    );
    let pumped = pump(socket, local_in, local_out, over_relay.then_some(&ended));
    let (mut closed, (pumped, socket_end)) = tokio::join!(serve, pumped);
    if let Err(error) = pumped {
        debug!(%peer, %error, "a remote WebSocket failed");
    }
    explain(&mut closed, socket_end, relay_stream.as_deref());
    closed.log(route_of(peer.ip(), relay_stream.is_some()));
}

/// Which route a connection to the remote listener came over. A relay stream comes from plxd
/// itself, so only its registration tells it from a client on this computer.
fn route_of(ip: IpAddr, relay_stream: bool) -> Route {
    if relay_stream {
        return Route::Relay;
    }
    match ip.to_canonical() {
        ip if ip.is_loopback() => Route::Local,
        IpAddr::V4(v4) if matches!(v4.octets(), [100, b, ..] if b & 0xc0 == 64) => Route::Tailnet,
        _ => Route::Lan,
    }
}

/// How a remote client's WebSocket ended, when it ended before plxd closed it.
#[derive(Debug)]
enum SocketEnd {
    /// The client sent a close frame.
    Closed,
    /// The transport ended with no close frame.
    Ended,
    Failed(String),
}

/// Says why a remote connection ended. [`pump`] ends the connection's input however the WebSocket
/// ended, so to [`connection::serve`] each of these is the client closing.
fn explain(closed: &mut Closed, socket_end: Option<SocketEnd>, relay_stream: Option<&RelayStream>) {
    if closed.reason != Reason::ClientClosed {
        return;
    }
    match socket_end {
        Some(SocketEnd::Closed) => return,
        Some(SocketEnd::Failed(error)) => closed.error = Some(error),
        Some(SocketEnd::Ended) | None => {}
    }
    closed.reason = Reason::TransportClosed;
    let Some(stream) = relay_stream else {
        return;
    };
    match stream.end() {
        Some(StreamEnd::Closed { code, reason }) => {
            // The relay ends a stream with this when the client's end of it goes.
            if !(code == Some(1000) && reason == "closed") {
                closed.reason = Reason::RelayClosed;
            }
            closed.close_code = code;
            closed.close_reason = Some(reason);
        }
        Some(StreamEnd::Failed(error)) => closed.error = Some(error),
        None => {}
    }
    // Last, since plxd's own close of the stream can look like any of these.
    if stream.relay_off() {
        closed.reason = Reason::RelayOff;
    }
}

/// How many bytes plxd may have sent a client over the relay that the client hasn't answered for.
/// The relay can't push back on plxd, so what a slow client hasn't read yet sits in its memory
/// (`relay/src/stream.ts`). This bounds it, and how long a request's answer waits behind it. A ping
/// goes after each window's worth, since each pong counts as a frame on the host's daily budget.
const RELAY_WINDOW: u64 = 512 * 1024;

/// How far a client over the relay has read, from its pongs (PLX-1359). The ping is plxd's
/// WebSocket's own, inside the TLS the relay can't read, so the relay does nothing and every client
/// answers it unchanged. It carries the bytes sent so far, which the pong echoes. A client that
/// answered once and then stops is a client that stopped reading: its replies stall, and the
/// connection closes after the stall timeout as any such connection does ([`connection`]), which
/// ends the wait. Only that connection waits: its terminals skip ahead instead of queueing
/// ([`crate::terminals`]), and nothing else on plxd waits for its queue. Nor does it wait while the
/// connection hasn't taken a request plxd read: the pong may be behind that request, and the
/// connection takes it only once its replies go out (PLX-1447).
#[derive(Default)]
struct Window {
    sent: AtomicU64,
    answered: AtomicU64,
    /// A client has answered, and hasn't closed. One that never answers is never waited for.
    paced: AtomicBool,
    /// A request is waiting for the connection to take it, so no frame behind it is read.
    handing: AtomicBool,
    heard: Notify,
}

impl Window {
    fn pong(&self, payload: &[u8]) {
        if let Ok(sent) = <[u8; 8]>::try_from(payload) {
            self.answered
                .fetch_max(u64::from_be_bytes(sent), Ordering::Relaxed);
            self.paced.store(true, Ordering::Relaxed);
            self.heard.notify_one();
        }
    }

    fn stop(&self) {
        self.paced.store(false, Ordering::Relaxed);
        self.heard.notify_one();
    }

    /// Whether a request is waiting for the connection to take it.
    fn handing(&self, handing: bool) {
        self.handing.store(handing, Ordering::Relaxed);
        if handing {
            self.heard.notify_one();
        }
    }

    fn full(&self) -> bool {
        let sent = self.sent.load(Ordering::Relaxed);
        self.paced.load(Ordering::Relaxed)
            && !self.handing.load(Ordering::Relaxed)
            && sent.saturating_sub(self.answered.load(Ordering::Relaxed)) >= RELAY_WINDOW
    }

    /// Returns once there's room, or the client closed.
    async fn room(&self) {
        while self.full() {
            self.heard.notified().await;
        }
    }
}

/// Carries frames from `socket` to the connection as lines, and its lines back as frames, until
/// the connection closes. A client's close ends what the connection reads, so it still answers
/// what it read. Answers with how the socket ended, if it did first. Over the relay, `relay` is the
/// connection's `closing`, and what's sent waits for the client's pongs ([`Window`]) until then.
async fn pump<S, I, O>(
    socket: WebSocketStream<S>,
    local_in: I,
    mut local_out: O,
    relay: Option<&CancellationToken>,
) -> (io::Result<()>, Option<SocketEnd>)
where
    S: AsyncRead + AsyncWrite + Unpin,
    I: AsyncRead + Unpin,
    O: AsyncWrite + Unpin,
{
    let (mut sink, mut frames) = socket.split();
    let window = Window::default();
    let over_relay = relay.is_some();
    let incoming = async {
        let mut end = SocketEnd::Ended;
        while let Some(frame) = frames.next().await {
            match frame {
                Ok(Message::Text(text)) => {
                    window.handing(true);
                    let handed = async {
                        local_out.write_all(text.as_bytes()).await?;
                        local_out.write_all(b"\n").await
                    };
                    let handed = handed.await;
                    window.handing(false);
                    handed?;
                }
                Ok(Message::Pong(payload)) if over_relay => window.pong(&payload),
                Ok(Message::Close(_)) => {
                    end = SocketEnd::Closed;
                    break;
                }
                Err(error) => {
                    end = SocketEnd::Failed(error.to_string());
                    break;
                }
                Ok(_) => {}
            }
        }
        local_out.shutdown().await?;
        Ok::<_, io::Error>(end)
    };
    let outgoing = async {
        let ping = |sent: u64| Message::Ping(sent.to_be_bytes().to_vec().into());
        if over_relay {
            // The first answer says this client answers, so it can be waited for.
            sink.send(ping(0)).await.map_err(io::Error::other)?;
        }
        let mut lines = tokio::io::BufReader::new(local_in).lines();
        let mut pinged = 0;
        while let Some(line) = lines.next_line().await? {
            if let Some(closed) = relay {
                // Once it's closed, what's left goes unpaced, and the input ends.
                tokio::select! {
                    () = window.room() => {}
                    () = closed.cancelled() => {}
                }
            }
            let sent =
                window.sent.fetch_add(line.len() as u64, Ordering::Relaxed) + line.len() as u64;
            if over_relay && sent - pinged >= RELAY_WINDOW {
                pinged = sent;
                // Together, so the ping doesn't take a relay frame of its own.
                sink.feed(Message::text(line))
                    .await
                    .map_err(io::Error::other)?;
                sink.send(ping(sent)).await.map_err(io::Error::other)?;
            } else {
                sink.send(Message::text(line))
                    .await
                    .map_err(io::Error::other)?;
            }
        }
        let _ = sink.close().await;
        Ok::<_, io::Error>(())
    };
    tokio::pin!(incoming, outgoing);
    let mut receiving = true;
    let mut socket_end = None;
    loop {
        tokio::select! {
            done = &mut outgoing => return (done, socket_end),
            done = &mut incoming, if receiving => {
                receiving = false;
                // No pong comes from a client that closed, and what it read is still answered.
                window.stop();
                match done {
                    Ok(end) => socket_end = Some(end),
                    Err(error) => debug!(%error, "could not end a remote connection's input"),
                }
            }
        }
    }
}

/// A session as `host_settings.remote_sessions` keeps it.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct StoredSession {
    id: String,
    name: String,
    /// The SHA-256 of its token, in hex. The token itself is only the client's.
    token_hash: String,
    /// The JWK thumbprint of the `DPoP` key it's bound to.
    thumbprint: String,
    created_at: String,
    /// Made by `/api/pair/browser`, so it works only while `remoteWeb` is on.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    browser: bool,
    /// Made by `/api/auth/peer` for another computer's agents (0101), so it ends when `agentWork`
    /// turns off.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    peer: bool,
}

fn read_sessions(db: &Store) -> Result<Vec<StoredSession>, ErrorObject> {
    let Some(json) = db.remote_sessions().map_err(|e| store_error(&e))? else {
        return Ok(Vec::new());
    };
    serde_json::from_str(&json).map_err(|e| {
        ErrorObject::internal_error(format!("the remote sessions are unreadable: {e}"))
    })
}

fn write_sessions(db: &Store, sessions: &[StoredSession]) -> Result<(), ErrorObject> {
    let json =
        serde_json::to_string(sessions).map_err(|e| ErrorObject::internal_error(e.to_string()))?;
    db.set_remote_sessions(Some(&json))
        .map_err(|e| store_error(&e))
}

async fn stored_sessions(daemon: &Daemon) -> Vec<StoredSession> {
    daemon
        .reader
        .run(&CancellationToken::new(), |db| read_sessions(db))
        .await
        .unwrap_or_default()
}

/// The session whose token is `token`.
async fn session_for(daemon: &Daemon, token: &str) -> Option<StoredSession> {
    let hash = remote::hex(&remote::sha256(token.as_bytes()));
    stored_sessions(daemon)
        .await
        .into_iter()
        .find(|s| s.token_hash == hash)
}

/// Whether session `id`'s device is read-only, and whether it is another computer's peer session
/// (0101), if it may have a socket now: it exists, and a browser's only while `remoteWeb` is on.
/// Lists it can't read leave it no socket, rather than full access.
async fn session_kind(daemon: &Daemon, id: &str) -> Option<(bool, bool)> {
    let id = id.to_owned();
    let (browser, read_only, peer) = daemon
        .reader
        .run(&CancellationToken::new(), move |db| {
            let lists = access::read_lists(db)?;
            let sessions = read_sessions(db)?;
            let session = sessions.iter().find(|s| s.id == id);
            Ok(session.map(|s| {
                let read_only = lists.read_only_clients.contains(&s.thumbprint);
                (s.browser, read_only, s.peer)
            }))
        })
        .await
        .ok()
        .flatten()?;
    (!browser || web_on(daemon).await).then_some((read_only, peer))
}

/// Closes every browser's connections, as `remoteWeb` turns off. Their sessions stay, for when it
/// turns on again.
pub(crate) async fn close_browsers(daemon: &Daemon) {
    for session in stored_sessions(daemon).await {
        if session.browser {
            daemon.remote.revoke(&session.id);
        }
    }
}

fn listed(sessions: Vec<StoredSession>, lists: &access::Lists) -> Vec<RemoteSession> {
    sessions
        .into_iter()
        .map(|s| RemoteSession {
            read_only: lists.read_only_clients.contains(&s.thumbprint),
            id: s.id,
            name: s.name,
            created_at: s.created_at,
        })
        .collect()
}

/// The sessions, oldest first.
pub(crate) async fn sessions(
    daemon: &Daemon,
    cancel: &CancellationToken,
) -> Result<Vec<RemoteSession>, ErrorObject> {
    daemon
        .reader
        .run(cancel, |db| {
            Ok(listed(read_sessions(db)?, &access::read_lists(db)?))
        })
        .await
}

/// Revokes the session `id` and closes its connections. Answers with the sessions left. A session
/// whose key the account approved also removes that key (0091), so the device can't sign straight
/// back in. Another computer's agents' session refuses that computer here instead, until `agentWork`
/// turns off (0101): its host key can't be replaced, so it stays out of what hosts copy.
pub(crate) async fn revoke(
    daemon: &Daemon,
    cancel: &CancellationToken,
    id: String,
) -> Result<Vec<RemoteSession>, ErrorObject> {
    let gone = id.clone();
    let (sessions, approved) = daemon
        .store
        .run(cancel, move |db| {
            let mut sessions = read_sessions(db)?;
            let found = sessions.iter().find(|s| s.id == gone);
            let thumbprint = found.map(|s| s.thumbprint.clone());
            let peer = found.is_some_and(|s| s.peer);
            sessions.retain(|s| s.id != gone);
            write_sessions(db, &sessions)?;
            if peer && let Some(key) = &thumbprint {
                access::refuse_peer(db, key)?;
            }
            let lists = access::read_lists(db)?;
            let approved = thumbprint.filter(|key| lists.approved_clients.contains(key));
            Ok((listed(sessions, &lists), approved))
        })
        .await?;
    daemon.remote.revoke(&id);
    info!(session = %id, "revoked a remote session");
    if let Some(thumbprint) = approved {
        access::remove(daemon, cancel, thumbprint).await?;
        return self::sessions(daemon, cancel).await;
    }
    Ok(sessions)
}

/// A new pairing code, advertised over mDNS by this host's name while it waits. Refused while
/// the listener isn't bound.
pub(crate) async fn new_pairing(daemon: &Daemon) -> Result<(String, jiff::Timestamp), String> {
    let remote = &daemon.remote;
    if !remote.listening.load(Ordering::Relaxed) {
        let problem = lock(&remote.problem).clone();
        return Err(problem.unwrap_or_else(|| "Turn on pairing first.".to_owned()));
    }
    let name = host_name(daemon).await;
    Ok(remote.new_pairing(&name, false))
}

/// A new computer's setup code (0091), which replaces any pairing code waiting, for a signed-in
/// client to type. With `device`, that key's Allow is enough while the code lasts. Refused while
/// the listener isn't bound.
pub(crate) async fn new_setup_code(
    daemon: &Daemon,
    device: Option<String>,
) -> Result<(String, jiff::Timestamp), String> {
    let remote = &daemon.remote;
    if !remote.listening.load(Ordering::Relaxed) {
        let problem = lock(&remote.problem).clone();
        return Err(problem.unwrap_or_else(|| "Turn on Reach from anywhere first.".to_owned()));
    }
    let name = host_name(daemon).await;
    let (code, expires) = remote.new_pairing(&name, true);
    remote.access.setup_started(device, expires);
    Ok((code, expires))
}

/// A client's name as kept: no control characters, at most 64 characters.
fn clean_name(name: &str) -> String {
    let name: String = name.chars().filter(|c| !c.is_control()).take(64).collect();
    name.trim().to_owned()
}

/// Where a client can reach this host, best first: its LAN address, the one its default route
/// leaves from, then its Tailscale address, found with `tailscale status` whether or not Connect
/// is on (0091), each an IP, with the port when it isn't [`remote::PORT`], then `relay:<hostId>`
/// while plxd is connected to the relay (PLX-652). Clients try the LAN and Tailscale routes
/// together and the relay last ([`remote::race`]).
pub(crate) async fn routes(daemon: &Daemon) -> Vec<String> {
    let remote = &daemon.remote;
    let route = |ip: IpAddr| {
        if remote.port == remote::PORT {
            ip.to_string()
        } else {
            SocketAddr::new(ip, remote.port).to_string()
        }
    };
    let relay = daemon.relay.route();
    if let Some(ip) = remote.address {
        return std::iter::once(route(ip)).chain(relay).collect();
    }
    // Connecting a UDP socket sends nothing; it only picks the address a packet would leave from.
    let primary = UdpSocket::bind((Ipv4Addr::UNSPECIFIED, 0))
        .and_then(|socket| {
            socket.connect((Ipv4Addr::new(192, 0, 2, 1), 9))?;
            socket.local_addr()
        })
        .map(|address| address.ip());
    let lan = primary
        .ok()
        .filter(|ip| remote::is_local_network(*ip) && !ip.is_loopback())
        .map(route);
    let tailnet = daemon
        .connect
        .tailnet
        .status()
        .await
        .ok()
        .and_then(|s| s.this.ipv4())
        .map(route);
    ordered(lan, tailnet, relay)
}

/// The routes in the order clients try them: the LAN address, the Tailscale address, then the
/// relay, each once. The default route may leave from the Tailscale address itself.
fn ordered(lan: Option<String>, tailnet: Option<String>, relay: Option<String>) -> Vec<String> {
    let mut routes: Vec<String> = Vec::new();
    for route in [lan, tailnet, relay].into_iter().flatten() {
        if !routes.contains(&route) {
            routes.push(route);
        }
    }
    routes
}

/// `remote/sessions`' answer: the sessions, and whether the listener is bound and why not.
pub(crate) fn listed_with_status(
    daemon: &Daemon,
    sessions: Vec<RemoteSession>,
) -> parallax_protocol::RemoteSessionsResult {
    let remote = &daemon.remote;
    parallax_protocol::RemoteSessionsResult {
        sessions,
        listening: remote.listening.load(Ordering::Relaxed),
        pairing: remote.pairing(),
        fingerprint: lock(&remote.fingerprint)
            .clone()
            .filter(|_| remote.listening.load(Ordering::Relaxed)),
        problem: lock(&remote.problem).clone(),
        relay: Some(daemon.relay.status()),
    }
}

/// This computer's name for a client: its Connect nickname, else its host name.
pub(crate) async fn host_name(daemon: &Daemon) -> String {
    let nickname = daemon
        .reader
        .run(&CancellationToken::new(), |db| {
            db.device_name().map_err(|e| store_error(&e))
        })
        .await;
    if let Ok(Some(name)) = nickname {
        return name;
    }
    #[cfg(unix)]
    let name = rustix::system::uname()
        .nodename()
        .to_string_lossy()
        .into_owned();
    #[cfg(windows)]
    let name = std::env::var("COMPUTERNAME").unwrap_or_default();
    name.trim_end_matches(".local").to_owned()
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;
    use std::sync::atomic::AtomicUsize;
    use std::time::Duration;

    use futures_util::{SinkExt as _, StreamExt as _};
    use tokio::io::{AsyncReadExt as _, AsyncWriteExt as _, DuplexStream};
    use tokio_util::sync::CancellationToken;

    use super::{
        Closed, MAX_HOOK_BYTES, Message, Ordering, READ_CHUNK, Reason, RelayStream, Role, Route,
        SocketEnd, StreamEnd, WebSocketStream, explain, read_request, route_of, time,
    };

    #[test]
    fn a_remote_connection_routes_by_its_peer_and_registration() {
        let route = |ip: &str, relay| route_of(ip.parse().unwrap(), relay);
        assert_eq!(route("127.0.0.1", true), Route::Relay);
        assert_eq!(route("127.0.0.1", false), Route::Local);
        assert_eq!(route("::ffff:127.0.0.1", false), Route::Local);
        assert_eq!(route("192.168.1.5", false), Route::Lan);
        assert_eq!(route("100.64.0.7", false), Route::Tailnet);
        assert_eq!(route("100.128.0.7", false), Route::Lan);
    }

    /// How a connection that read EOF is explained, with what it knows and the stream's end.
    fn explained(
        socket_end: Option<SocketEnd>,
        relay: Option<(Option<StreamEnd>, bool)>,
        reason: Reason,
    ) -> Closed {
        let mut closed = Closed {
            session: None,
            reason,
            error: None,
            close_code: None,
            close_reason: None,
            lived: Duration::ZERO,
        };
        let stream = relay.map(|(end, relay_off)| {
            let stop = CancellationToken::new();
            if relay_off {
                stop.cancel();
            }
            RelayStream {
                stop,
                end: Arc::new(std::sync::Mutex::new(end)),
            }
        });
        explain(&mut closed, socket_end, stream.as_ref());
        closed
    }

    #[test]
    fn eof_from_the_pump_is_explained_by_how_the_socket_and_stream_ended() {
        let closed = |code, reason: &str| StreamEnd::Closed {
            code,
            reason: reason.to_owned(),
        };
        let eof = Reason::ClientClosed;
        let ended = Some(SocketEnd::Ended);

        // A close frame is the client closing, whatever else is true.
        let clean = explained(Some(SocketEnd::Closed), Some((None, true)), eof);
        assert_eq!(clean.reason, Reason::ClientClosed);
        // No close frame, off the relay.
        assert_eq!(explained(None, None, eof).reason, Reason::TransportClosed);
        // The relay ends a stream this way when its client goes.
        let gone = explained(
            ended,
            Some((Some(closed(Some(1000), "closed")), false)),
            eof,
        );
        assert_eq!(gone.reason, Reason::TransportClosed);
        assert_eq!(gone.close_code, Some(1000));
        // The relay's own reasons.
        let code = explained(
            Some(SocketEnd::Ended),
            Some((Some(closed(Some(4429), "daily limit")), false)),
            eof,
        );
        assert_eq!(code.reason, Reason::RelayClosed);
        assert_eq!(code.close_code, Some(4429));
        assert_eq!(code.close_reason.as_deref(), Some("daily limit"));
        let reconnected = closed(Some(1000), "the host reconnected");
        let host = explained(
            Some(SocketEnd::Ended),
            Some((Some(reconnected.clone()), false)),
            eof,
        );
        assert_eq!(host.reason, Reason::RelayClosed);
        // `relay` going off explains the rest, and keeps the code that came with it.
        let off = explained(Some(SocketEnd::Ended), Some((Some(reconnected), true)), eof);
        assert_eq!(off.reason, Reason::RelayOff);
        assert_eq!(off.close_code, Some(1000));
        // A reason plxd already knows stays.
        let down = explained(None, Some((None, true)), Reason::Shutdown);
        assert_eq!(down.reason, Reason::Shutdown);
    }

    #[test]
    fn routes_go_lan_then_tailscale_then_the_relay_each_once() {
        let some = |route: &str| Some(route.to_owned());
        let relay = format!("relay:{}", "h".repeat(43));
        assert_eq!(
            super::ordered(some("192.168.1.5"), some("100.64.0.7"), Some(relay.clone())),
            ["192.168.1.5", "100.64.0.7", relay.as_str()]
        );
        assert_eq!(
            super::ordered(None, some("100.64.0.7:7400"), Some(relay.clone())),
            ["100.64.0.7:7400", relay.as_str()],
            "Tailscale alone, with Connect off or no LAN"
        );
        assert_eq!(
            super::ordered(some("100.64.0.7"), some("100.64.0.7"), None),
            ["100.64.0.7"],
            "a default route through the tailnet"
        );
    }

    async fn read(raw: Vec<u8>) -> Option<super::Request> {
        let (mut client, mut server) = tokio::io::duplex(64 * 1024);
        tokio::spawn(async move { client.write_all(&raw).await });
        read_request(&mut server).await.unwrap()
    }

    #[tokio::test]
    async fn a_webhook_body_reads_by_length_or_in_chunks_and_an_oversized_one_is_marked() {
        let sized =
            read(b"POST /api/hooks/a/b HTTP/1.1\r\ncontent-length: 5\r\n\r\nhello".to_vec())
                .await
                .unwrap();
        assert_eq!(sized.body, b"hello");

        let chunked = b"POST /api/hooks/a/b HTTP/1.1\r\nTransfer-Encoding: chunked\r\n\r\n\
                        5;ext=1\r\nhello\r\n7\r\n, world\r\n0\r\nx-trailer: 1\r\n\r\n";
        let chunked = read(chunked.to_vec()).await.unwrap();
        assert_eq!(chunked.body, b"hello, world");
        assert!(!chunked.too_large);

        let head = format!(
            "POST /api/hooks/a/b HTTP/1.1\r\ncontent-length: {}\r\n\r\n",
            MAX_HOOK_BYTES + 1
        );
        let big = read(head.into_bytes()).await.unwrap();
        assert!(big.too_large);
        assert!(big.body.is_empty());

        let other = "POST /api/pair/start HTTP/1.1\r\ncontent-length: 20000\r\n\r\n";
        assert!(
            read(other.as_bytes().to_vec()).await.is_none(),
            "other routes keep 16 KiB"
        );
    }

    #[tokio::test]
    async fn what_comes_behind_a_request_is_kept_under_one_read_and_the_rest_left_unread() {
        // A client that sends far more behind its upgrade than plxd holds.
        let behind: Vec<u8> = (0..100 * 1024).map(|n: u32| n.to_le_bytes()[0]).collect();
        let mut raw = b"GET /ws HTTP/1.1\r\nhost: h\r\n\r\n".to_vec();
        raw.extend_from_slice(&behind);
        let (mut client, mut server) = tokio::io::duplex(64 * 1024);
        tokio::spawn(async move { client.write_all(&raw).await });
        let request = read_request(&mut server).await.unwrap().unwrap();
        assert!(request.body.is_empty());
        assert!(!request.early.is_empty() && request.early.len() < READ_CHUNK);
        // The rest is still in the connection, in order, for the WebSocket to read.
        let mut all = request.early;
        server.read_to_end(&mut all).await.unwrap();
        assert_eq!(all, behind);

        let sized =
            read(b"POST /api/pair/start HTTP/1.1\r\ncontent-length: 2\r\n\r\n{}next".to_vec())
                .await
                .unwrap();
        assert_eq!(
            (sized.body.as_slice(), sized.early.as_slice()),
            (&b"{}"[..], &b"next"[..])
        );
    }

    const LINE: usize = 128 * 1024;
    const PATIENCE: Duration = Duration::from_secs(20);

    /// A `pump` over the relay: the client's socket, the input of what's sent to it, the
    /// connection's `closing`, and the pump.
    struct RelayPump {
        client: WebSocketStream<DuplexStream>,
        input: DuplexStream,
        closing: CancellationToken,
        pump: tokio::task::JoinHandle<()>,
    }

    async fn relay_pump() -> RelayPump {
        // Room for everything, so only the window holds `pump` back.
        let (client, server) = tokio::io::duplex(64 * 1024 * 1024);
        let server = WebSocketStream::from_raw_socket(server, Role::Server, None).await;
        let client = WebSocketStream::from_raw_socket(client, Role::Client, None).await;
        let (input, local_in) = tokio::io::duplex(64 * 1024);
        let closing = CancellationToken::new();
        let token = closing.clone();
        let pump = tokio::spawn(async move {
            let _ = super::pump(server, local_in, tokio::io::sink(), Some(&token)).await;
        });
        RelayPump {
            client,
            input,
            closing,
            pump,
        }
    }

    /// Reads `client`'s first ping and answers it, so it's a client that answers, then reads
    /// nothing more.
    async fn answer_once(client: &mut WebSocketStream<DuplexStream>) {
        let first = time::timeout(PATIENCE, client.next()).await.unwrap();
        assert!(matches!(first, Some(Ok(Message::Ping(_)))), "{first:?}");
        client.flush().await.unwrap();
        time::sleep(Duration::from_millis(100)).await;
    }

    /// Writes `lines` of [`LINE`] bytes to `input`. Answers how many bytes it has written so far.
    fn feed(mut input: DuplexStream, lines: usize) -> Arc<AtomicUsize> {
        let written = Arc::new(AtomicUsize::new(0));
        let counter = Arc::clone(&written);
        tokio::spawn(async move {
            let line = format!("{}\n", "x".repeat(LINE - 1));
            for _ in 0..lines {
                input.write_all(line.as_bytes()).await.unwrap();
                counter.fetch_add(LINE, Ordering::Relaxed);
            }
            // The connection stays open while the client reads the rest.
            std::future::pending::<()>().await;
        });
        written
    }

    #[tokio::test]
    async fn a_client_that_answered_and_stopped_reading_holds_the_window() {
        let RelayPump {
            mut client, input, ..
        } = relay_pump().await;
        answer_once(&mut client).await;

        let lines = 32;
        let written = feed(input, lines);
        time::sleep(Duration::from_millis(500)).await;
        let held = written.load(Ordering::Relaxed);
        assert!(
            held <= 1024 * 1024,
            "{held} bytes went past a stopped client"
        );

        // It reads again, which answers the pings on the way, and all of it comes.
        let texts = async {
            let mut texts = 0;
            while texts < lines {
                match client.next().await.expect("the socket ended early") {
                    Ok(Message::Text(_)) => texts += 1,
                    Ok(_) => {}
                    Err(error) => panic!("after {texts} lines: {error}"),
                }
            }
        };
        time::timeout(PATIENCE, texts)
            .await
            .expect("the rest never came");
    }

    /// PLX-1447: a client that answered once, then sent more requests than the connection takes
    /// while its replies wait, and reads again. The pong for the window is behind those requests,
    /// and the connection takes them only once its replies are out, so the window mustn't wait
    /// for it then. Before, both waited until the stall closed the connection.
    #[tokio::test]
    async fn a_pong_behind_requests_the_connection_hasnt_taken_doesnt_hold_the_window() {
        // As a relay stream and `remote::serve` have them: neither holds the requests.
        let (client, server) = tokio::io::duplex(64 * 1024);
        let server = WebSocketStream::from_raw_socket(server, Role::Server, None).await;
        let mut client = WebSocketStream::from_raw_socket(client, Role::Client, None).await;
        let (mut input, local_in) = tokio::io::duplex(64 * 1024);
        let (local_out, mut requests) = tokio::io::duplex(64 * 1024);
        tokio::spawn(async move {
            let closing = CancellationToken::new();
            let _ = super::pump(server, local_in, local_out, Some(&closing)).await;
        });
        answer_once(&mut client).await;

        let (mut sink, mut frames) = client.split();
        let request = "r".repeat(16 * 1024);
        let sent = tokio::spawn(async move {
            for _ in 0..32 {
                sink.send(Message::text(request.clone())).await.unwrap();
            }
            sink
        });
        time::sleep(Duration::from_millis(100)).await;
        // The connection, with every request slot taken: its replies, past the window, go out
        // before it reads another request, as `connection::serve`'s do.
        let lines = 8;
        let connection = tokio::spawn(async move {
            let line = format!("{}\n", "x".repeat(LINE - 1));
            for _ in 0..lines {
                input.write_all(line.as_bytes()).await.unwrap();
            }
            let mut read = vec![0; 32 * (16 * 1024 + 1)];
            requests.read_exact(&mut read).await.unwrap();
            input
        });

        let texts = async {
            let mut texts = 0;
            while texts < lines {
                match frames.next().await.expect("the socket ended early") {
                    Ok(Message::Text(_)) => texts += 1,
                    Ok(_) => {}
                    Err(error) => panic!("after {texts} lines: {error}"),
                }
            }
        };
        time::timeout(PATIENCE, texts)
            .await
            .expect("the replies waited on a pong behind requests");
        time::timeout(PATIENCE, connection)
            .await
            .expect("the connection never got its requests")
            .unwrap();
        drop(sent);
    }

    /// PLX-1447: once the connection takes a client's request, the window waits again, so a
    /// client that sent requests and then stopped reading is still held.
    #[tokio::test]
    async fn the_window_holds_again_once_the_connection_takes_the_request() {
        // Room for everything, so only the window holds `pump` back.
        let (client, server) = tokio::io::duplex(64 * 1024 * 1024);
        let server = WebSocketStream::from_raw_socket(server, Role::Server, None).await;
        let mut client = WebSocketStream::from_raw_socket(client, Role::Client, None).await;
        let (input, local_in) = tokio::io::duplex(64 * 1024);
        let (local_out, mut requests) = tokio::io::duplex(64 * 1024);
        tokio::spawn(async move {
            let closing = CancellationToken::new();
            let _ = super::pump(server, local_in, local_out, Some(&closing)).await;
        });
        answer_once(&mut client).await;
        client.send(Message::text("request")).await.unwrap();
        let mut taken = [0; 8];
        time::timeout(PATIENCE, requests.read_exact(&mut taken))
            .await
            .expect("the connection never got the request")
            .unwrap();
        assert_eq!(&taken, b"request\n");

        // The client reads nothing more.
        let written = feed(input, 32);
        time::sleep(Duration::from_millis(500)).await;
        let held = written.load(Ordering::Relaxed);
        assert!(
            held <= 1024 * 1024,
            "{held} bytes went past a stopped client after its request was taken"
        );
    }

    #[tokio::test]
    async fn a_client_that_never_answers_is_never_waited_for() {
        // The client stays open, and never answers.
        let RelayPump {
            client: _client,
            input,
            ..
        } = relay_pump().await;
        let lines = 32;
        let written = feed(input, lines);
        let all = async {
            while written.load(Ordering::Relaxed) < lines * LINE {
                time::sleep(Duration::from_millis(10)).await;
            }
        };
        time::timeout(PATIENCE, all)
            .await
            .expect("it waited for a client that never answers");
    }

    #[tokio::test]
    async fn a_stalled_client_is_let_go_when_its_connection_closes() {
        let RelayPump {
            mut client,
            mut input,
            closing,
            pump,
        } = relay_pump().await;
        answer_once(&mut client).await;
        // More than the window, so the pump waits on a client that won't read.
        let write = tokio::spawn(async move {
            let line = format!("{}\n", "x".repeat(LINE - 1));
            for _ in 0..32 {
                input.write_all(line.as_bytes()).await.unwrap();
            }
        });
        time::sleep(Duration::from_millis(500)).await;
        assert!(
            !pump.is_finished() && !write.is_finished(),
            "nothing waited"
        );

        // The connection closes, as one does once its writes stall. Its last lines go unpaced, and
        // the pump ends with its input.
        closing.cancel();
        time::timeout(PATIENCE, write)
            .await
            .expect("the pump still waits on the client")
            .unwrap();
        time::timeout(PATIENCE, pump)
            .await
            .expect("the pump never ended")
            .unwrap();
    }
}
