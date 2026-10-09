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
//! - `POST /api/auth/websocket-ticket`: a ticket valid once for 30 s, for a `DPoP`-bound token.
//! - `GET /ws?wsTicket=…`: a WebSocket carrying 0007's JSON-RPC, one message per frame.
//! - `/api/hooks/<id>/<token>`, by any method: a scheduled task's webhook ([`crate::schedules`]),
//!   with a body of up to [`MAX_HOOK_BYTES`].
//!
//! While a code waits, plxd advertises itself over mDNS as `_parallax._tcp`, by name, with no
//! secret. Turning `remote` off ends the pairing and closes every connection the listener
//! accepted, and `remote/revoke` closes a session's own.

use std::collections::HashMap;
use std::io;
use std::net::{IpAddr, Ipv4Addr, SocketAddr, UdpSocket};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, PoisonError};
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

use super::tailnet::{Check, Checks, Serving};
use super::{ACCEPT_BACKOFF, Daemon, connection};
use crate::agents::store_error;
use crate::remote::{self, Descriptor, HostKey};

/// How long a pairing code works, as 0065 has it.
pub(crate) const CODE_LIFETIME: Duration = Duration::from_mins(5);

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

/// The most a webhook request's head and body may hold, as T3's.
const MAX_HOOK_BYTES: usize = 1024 * 1024;

/// The remote listener's state, shared with `remote/*`.
#[derive(Debug)]
pub(crate) struct Remote {
    pub port: u16,
    /// Bound instead of every IPv4 address, and reported as the only route. Tests only.
    pub address: Option<IpAddr>,
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
}

impl Remote {
    pub(crate) fn new(port: u16, address: Option<IpAddr>, code_lifetime: Duration) -> Self {
        Self {
            port,
            address,
            code_lifetime,
            changed: Notify::new(),
            listening: AtomicBool::new(false),
            problem: Mutex::default(),
            pairing: Mutex::default(),
            tickets: Mutex::default(),
            proofs: Mutex::default(),
            sessions: Mutex::default(),
        }
    }

    /// Starts a pairing with a new code, which replaces any earlier one, and advertises this host
    /// as `name` over mDNS until it ends. Answers with the code and when it stops working.
    pub(crate) fn new_pairing(&self, name: &str) -> (String, jiff::Timestamp) {
        let code = remote::new_code();
        // A test's listener on loopback has nothing to advertise.
        let advert = self
            .address
            .is_none()
            .then(|| advertise(name, self.port))
            .flatten();
        let pairing = Pairing {
            code: code.clone(),
            expires: Instant::now() + self.code_lifetime,
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
            + jiff::SignedDuration::try_from(self.code_lifetime).expect("a short lifetime");
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

    fn lock_pairing(&self) -> std::sync::MutexGuard<'_, Option<Pairing>> {
        self.pairing.lock().unwrap_or_else(PoisonError::into_inner)
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
    /// uses up the code. A wrong one counts against the code, and the last allowed one locks it.
    fn finish_pake(
        &self,
        id: &str,
        fingerprint: &str,
        thumbprint: &str,
        mac: &[u8],
    ) -> Result<Vec<u8>, &'static str> {
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
            pairing.take().expect("a pairing").end();
            return Ok(key);
        }
        waiting.wrong += 1;
        if waiting.wrong >= remote::MAX_WRONG_CODES {
            warn!("locked the pairing code after too many wrong tries");
            pairing.take().expect("a pairing").end();
        }
        Err("a wrong pairing code")
    }

    /// Records a proof's `jti` for its key. False when it was seen already.
    fn first_use(&self, proven: &remote::Proven) -> bool {
        let mut proofs = self.proofs.lock().unwrap_or_else(PoisonError::into_inner);
        let now = Instant::now();
        proofs.retain(|_, seen| now.duration_since(*seen) < REPLAY_MEMORY);
        proofs
            .insert(format!("{}:{}", proven.thumbprint, proven.jti), now)
            .is_none()
    }

    fn new_ticket(&self, session: String) -> String {
        let ticket = remote::random_token(24);
        let mut tickets = self.tickets.lock().unwrap_or_else(PoisonError::into_inner);
        let now = Instant::now();
        tickets.retain(|_, (_, expires)| now < *expires);
        tickets.insert(ticket.clone(), (session, now + TICKET_LIFETIME));
        ticket
    }

    /// Uses up `ticket`: the session it opens, unless it's unknown or expired.
    fn take_ticket(&self, ticket: &str) -> Option<String> {
        let mut tickets = self.tickets.lock().unwrap_or_else(PoisonError::into_inner);
        let (session, expires) = tickets.remove(ticket)?;
        (Instant::now() < expires).then_some(session)
    }

    /// A token that closes one connection of `session`'s, when the listener `closing` closes or
    /// the session is revoked.
    fn watch(&self, session: &str, closing: &CancellationToken) -> CancellationToken {
        let mut sessions = self.sessions.lock().unwrap_or_else(PoisonError::into_inner);
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
        let token = self
            .sessions
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .remove(session);
        if let Some(token) = token {
            token.cancel();
        }
    }
}

/// A pairing code waiting to be used.
struct Pairing {
    code: String,
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
}

/// Keeps the listener in line with the `remote` setting until `stop`.
pub(super) async fn run(serving: Serving, stop: CancellationToken) {
    let remote = &serving.daemon.remote;
    let mut bound: Option<Bound> = None;
    let mut settle = true;
    // Set when `remote` is on and the bind failed, so it tries again.
    let mut retry = false;
    let mut connection_id = 0_u64;
    let checks = Checks::default();
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
                    *remote
                        .problem
                        .lock()
                        .unwrap_or_else(PoisonError::into_inner) = None;
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
                    serving.admit_remote(stream, peer, bound, check, connection_id);
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
            *remote
                .problem
                .lock()
                .unwrap_or_else(PoisonError::into_inner) = None;
            Some(Bound {
                listener,
                key,
                tls,
                closing: serving.abort.child_token(),
            })
        }
        Err(error) => {
            warn!(%address, %error, "could not listen for remote clients");
            let why = if error.kind() == io::ErrorKind::AddrInUse {
                format!("Port {} is in use by another program.", remote.port)
            } else {
                format!("Parallax couldn't listen on port {}: {error}", remote.port)
            };
            *remote
                .problem
                .lock()
                .unwrap_or_else(PoisonError::into_inner) = Some(why);
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
}

impl Request {
    fn header(&self, name: &str) -> Option<&str> {
        self.headers.get(name).map(String::as_str)
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
}

/// Reads one request: its head, up to [`MAX_REQUEST_BYTES`], and its body by `Content-Length`.
async fn read_request<S: AsyncRead + Unpin>(stream: &mut S) -> io::Result<Option<Request>> {
    let mut buffer = Vec::with_capacity(1024);
    let mut chunk = [0; 1024];
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
                let wanted: usize = headers
                    .get("content-length")
                    .and_then(|n| n.parse().ok())
                    .unwrap_or(0);
                let max = if parsed
                    .path
                    .is_some_and(|path| path.starts_with("/api/hooks/"))
                {
                    MAX_HOOK_BYTES
                } else {
                    MAX_REQUEST_BYTES
                };
                if length.checked_add(wanted).is_none_or(|n| n > max) {
                    return Ok(None);
                }
                let mut body = buffer[length..].to_vec();
                body.resize(wanted, 0);
                let have = buffer.len() - length;
                if have < wanted {
                    stream.read_exact(&mut body[have..]).await?;
                }
                return Ok(Some(Request {
                    method: parsed.method.unwrap_or_default().to_owned(),
                    path: parsed.path.unwrap_or_default().to_owned(),
                    headers,
                    body,
                }));
            }
            Ok(httparse::Status::Partial) if buffer.len() < MAX_REQUEST_BYTES => {}
            _ => return Ok(None),
        }
    }
}

/// Writes a JSON answer with `status`, and closes the connection.
async fn respond<S: AsyncWrite + Unpin>(
    stream: &mut S,
    status: u16,
    body: &serde_json::Value,
) -> io::Result<()> {
    let reason = match status {
        200 => "OK",
        202 => "Accepted",
        400 => "Bad Request",
        401 => "Unauthorized",
        404 => "Not Found",
        409 => "Conflict",
        429 => "Too Many Requests",
        _ => "Internal Server Error",
    };
    let body = body.to_string();
    let mut answer = format!(
        "HTTP/1.1 {status} {reason}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nCache-Control: no-store\r\nConnection: close\r\n",
        body.len()
    );
    if status == 401 {
        answer.push_str("WWW-Authenticate: DPoP algs=\"ES256\"\r\n");
    }
    answer.push_str("\r\n");
    answer.push_str(&body);
    stream.write_all(answer.as_bytes()).await?;
    stream.shutdown().await
}

fn refused(why: &str) -> (u16, serde_json::Value) {
    (
        401,
        json!({ "error": "invalid_grant", "error_description": why }),
    )
}

impl Serving {
    /// Runs TLS and reads one request, then answers it. `check` is held until the request is
    /// read. It runs as one of the server's connections, so shutdown waits for it.
    fn admit_remote(
        &self,
        stream: TcpStream,
        peer: SocketAddr,
        bound: &Bound,
        check: Check,
        id: u64,
    ) {
        let daemon = Arc::clone(&self.daemon);
        let stop_reading = self.stop_reading.clone();
        let key = Arc::clone(&bound.key);
        let tls = bound.tls.clone();
        let closing = bound.closing.clone();
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
                let (mut stream, request) = match read {
                    Ok(Ok(Some(read))) => read,
                    Ok(Ok(None)) => return debug!(%peer, "closed a remote connection without a request"),
                    Ok(Err(error)) => return debug!(%peer, %error, "a remote connection failed"),
                    Err(_) => return debug!(%peer, "closed a remote connection that sent no request in time"),
                };
                let route = request.path.split('?').next().unwrap_or_default();
                let (status, body) = match (request.method.as_str(), route) {
                    ("GET", "/ws") => {
                        return serve_socket(stream, &request, daemon, stop_reading, &closing, peer).await;
                    }
                    ("GET", "/.well-known/parallax") => (200, descriptor(&daemon, &key).await),
                    ("POST", "/api/pair/start") => start_pairing(&daemon, &key, &request),
                    ("POST", "/api/pair/finish") => finish_pairing(&daemon, &key, &request).await,
                    ("POST", "/api/auth/websocket-ticket") => ticket(&daemon, &request).await,
                    (method, hook) if hook.starts_with("/api/hooks/") => {
                        let Request { path, headers, body, .. } = &request;
                        crate::schedules::hook(&daemon, method, path, headers, body).await
                    }
                    _ => (404, json!({ "error": "not_found" })),
                };
                // A webhook's path holds its token, so the log names only the route.
                let route = if route.starts_with("/api/hooks/") { "/api/hooks/…" } else { route };
                if !matches!(status, 200 | 202) {
                    warn!(%peer, path = route, status, "refused a remote request");
                }
                let _ = time::timeout(remote::REQUEST_TIMEOUT, respond(&mut stream, status, &body)).await;
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
    let proof = request.header("dpop").unwrap_or_default();
    let now = remote::now_seconds();
    let proven = match remote::verify_proof(proof, "POST", &request.url(), now, None) {
        Ok(proven) => proven,
        Err(why) => return refused(why),
    };
    let fp = &key.fingerprint;
    let shared = match daemon
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
    let token = remote::random_token(32);
    let session = StoredSession {
        id: uuid::Uuid::new_v4().to_string(),
        name: clean_name(&finish.client_label),
        token_hash: remote::hex(&remote::sha256(token.as_bytes())),
        thumbprint: proven.thumbprint.clone(),
        created_at: jiff::Timestamp::now().to_string(),
    };
    let name = session.name.clone();
    let stored = daemon
        .store
        .run(&CancellationToken::new(), move |db| {
            let mut sessions = read_sessions(db)?;
            sessions.push(session);
            write_sessions(db, &sessions)
        })
        .await;
    if let Err(error) = stored {
        warn!(error = %error.message, "could not keep a remote session");
        return (500, json!({ "error": "server_error" }));
    }
    info!(%name, "paired a remote client");
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

/// `POST /api/auth/websocket-ticket`: a 30 s ticket for `/ws`, for a session's token with a `DPoP`
/// proof from its key.
async fn ticket(daemon: &Daemon, request: &Request) -> (u16, serde_json::Value) {
    let Some(token) = request
        .header("authorization")
        .and_then(|value| value.strip_prefix("DPoP "))
    else {
        return refused("no DPoP access token");
    };
    let Some(session) = session_for(daemon, token).await else {
        return refused("an unknown or revoked session");
    };
    let proof = request.header("dpop").unwrap_or_default();
    let now = remote::now_seconds();
    let proven = match remote::verify_proof(proof, "POST", &request.url(), now, Some(token)) {
        Ok(proven) => proven,
        Err(why) => return refused(why),
    };
    if proven.thumbprint != session.thumbprint {
        return refused("a DPoP proof from another key");
    }
    if !daemon.remote.first_use(&proven) {
        return refused("a replayed DPoP proof");
    }
    let ticket = daemon.remote.new_ticket(session.id);
    let seconds = TICKET_LIFETIME.as_secs();
    (200, json!({ "ticket": ticket, "expiresIn": seconds }))
}

/// `GET /ws`: opens the WebSocket a ticket allows, and serves it as a socket connection.
async fn serve_socket(
    mut stream: tokio_rustls::server::TlsStream<TcpStream>,
    request: &Request,
    daemon: Arc<Daemon>,
    stop_reading: CancellationToken,
    closing: &CancellationToken,
    peer: SocketAddr,
) {
    let session = request
        .query("wsTicket")
        .and_then(|t| daemon.remote.take_ticket(t));
    let key = request.header("sec-websocket-key");
    let upgrade = request
        .header("upgrade")
        .is_some_and(|u| u.eq_ignore_ascii_case("websocket"));
    let (Some(session), Some(key), true) = (session, key, upgrade) else {
        warn!(%peer, "refused a WebSocket without a valid ticket");
        let refusal = refused("a wrong, used, or expired ticket");
        let _ = respond(&mut stream, refusal.0, &refusal.1).await;
        return;
    };
    // Watched before the session is checked, so a revoke that lands in between still closes it.
    let closing = daemon.remote.watch(&session, closing);
    // A session revoked after its ticket was made.
    if !session_exists(&daemon, &session).await {
        let refusal = refused("a revoked session");
        let _ = respond(&mut stream, refusal.0, &refusal.1).await;
        return;
    }
    let accept = derive_accept_key(key.as_bytes());
    let switching = format!(
        "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: {accept}\r\n\r\n"
    );
    if stream.write_all(switching.as_bytes()).await.is_err() {
        return;
    }
    info!(%peer, "accepted a remote WebSocket");
    let socket =
        WebSocketStream::from_raw_socket(stream, Role::Server, Some(remote::websocket_config()))
            .await;
    let (local, plain) = tokio::io::duplex(64 * 1024);
    let (local_in, local_out) = tokio::io::split(local);
    let serve = connection::serve(plain, daemon, stop_reading, closing);
    let ((), pumped) = tokio::join!(serve, pump(socket, local_in, local_out));
    if let Err(error) = pumped {
        debug!(%peer, %error, "a remote WebSocket failed");
    }
}

/// Carries frames from `socket` to the connection as lines, and its lines back as frames, until
/// the connection closes. A client's close ends what the connection reads, so it still answers
/// what it read.
async fn pump<S, I, O>(socket: WebSocketStream<S>, local_in: I, mut local_out: O) -> io::Result<()>
where
    S: AsyncRead + AsyncWrite + Unpin,
    I: AsyncRead + Unpin,
    O: AsyncWrite + Unpin,
{
    let (mut sink, mut frames) = socket.split();
    let incoming = async {
        while let Some(frame) = frames.next().await {
            match frame {
                Ok(Message::Text(text)) => {
                    local_out.write_all(text.as_bytes()).await?;
                    local_out.write_all(b"\n").await?;
                }
                Ok(Message::Close(_)) | Err(_) => break,
                Ok(_) => {}
            }
        }
        local_out.shutdown().await
    };
    let outgoing = async {
        let mut lines = tokio::io::BufReader::new(local_in).lines();
        while let Some(line) = lines.next_line().await? {
            sink.send(Message::text(line))
                .await
                .map_err(io::Error::other)?;
        }
        let _ = sink.close().await;
        Ok::<_, io::Error>(())
    };
    tokio::pin!(incoming, outgoing);
    let mut receiving = true;
    loop {
        tokio::select! {
            done = &mut outgoing => return done,
            done = &mut incoming, if receiving => {
                receiving = false;
                if let Err(error) = done {
                    debug!(%error, "could not end a remote connection's input");
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

async fn session_exists(daemon: &Daemon, id: &str) -> bool {
    stored_sessions(daemon).await.iter().any(|s| s.id == id)
}

fn listed(sessions: Vec<StoredSession>) -> Vec<RemoteSession> {
    sessions
        .into_iter()
        .map(|s| RemoteSession {
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
    let sessions = daemon.reader.run(cancel, |db| read_sessions(db)).await?;
    Ok(listed(sessions))
}

/// Revokes the session `id` and closes its connections. Answers with the sessions left.
pub(crate) async fn revoke(
    daemon: &Daemon,
    cancel: &CancellationToken,
    id: String,
) -> Result<Vec<RemoteSession>, ErrorObject> {
    let gone = id.clone();
    let sessions = daemon
        .store
        .run(cancel, move |db| {
            let mut sessions = read_sessions(db)?;
            sessions.retain(|s| s.id != gone);
            write_sessions(db, &sessions)?;
            Ok(sessions)
        })
        .await?;
    daemon.remote.revoke(&id);
    info!(session = %id, "revoked a remote session");
    Ok(listed(sessions))
}

/// A new pairing code, advertised over mDNS by this host's name while it waits. Refused while
/// the listener isn't bound.
pub(crate) async fn new_pairing(daemon: &Daemon) -> Result<(String, jiff::Timestamp), String> {
    let remote = &daemon.remote;
    if !remote.listening.load(Ordering::Relaxed) {
        let problem = remote
            .problem
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .clone();
        return Err(problem.unwrap_or_else(|| "Turn on pairing first.".to_owned()));
    }
    let name = host_name(daemon).await;
    Ok(remote.new_pairing(&name))
}

/// A client's name as kept: no control characters, at most 64 characters.
fn clean_name(name: &str) -> String {
    let name: String = name.chars().filter(|c| !c.is_control()).take(64).collect();
    name.trim().to_owned()
}

/// Where a client can reach this host, best first: its LAN address, the one its default route
/// leaves from, then its Tailscale address. Each an IP, with the port when it isn't
/// [`remote::PORT`].
pub(crate) async fn routes(daemon: &Daemon) -> Vec<String> {
    let remote = &daemon.remote;
    let route = |ip: IpAddr| {
        if remote.port == remote::PORT {
            ip.to_string()
        } else {
            SocketAddr::new(ip, remote.port).to_string()
        }
    };
    if let Some(ip) = remote.address {
        return vec![route(ip)];
    }
    let mut routes = Vec::new();
    // Connecting a UDP socket sends nothing; it only picks the address a packet would leave from.
    let primary = UdpSocket::bind((Ipv4Addr::UNSPECIFIED, 0))
        .and_then(|socket| {
            socket.connect((Ipv4Addr::new(192, 0, 2, 1), 9))?;
            socket.local_addr()
        })
        .map(|address| address.ip());
    if let Some(ip) = primary
        .ok()
        .filter(|ip| remote::is_local_network(*ip) && !ip.is_loopback())
    {
        routes.push(route(ip));
    }
    if let Some(ip) = daemon
        .connect
        .tailnet
        .status()
        .await
        .ok()
        .and_then(|s| s.this.ipv4())
    {
        routes.push(route(ip));
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
        problem: remote
            .problem
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .clone(),
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
