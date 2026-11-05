//! Parallax Relay's plxd side (PLX-652, decision 0068).
//!
//! While the host's `relay` setting is on, plxd keeps one WebSocket open to the relay ([`run`]),
//! opened with the time signed by its host key. Then:
//!
//! - While `remote` is on too, for each client the relay announces, plxd opens a WebSocket for
//!   that client's stream and joins it to a loopback connection to its own remote listener. The
//!   client's TLS ends in plxd, at the certificate it pinned (0065, 0091), so the relay carries
//!   only ciphertext. plxd also keeps one spare stream open (0091): the relay joins the next client
//!   to it without asking plxd first, and plxd asks for another once it's taken.
//! - It answers the webhooks the relay forwards, held ones included, with the same check as
//!   `/api/hooks` ([`crate::schedules::hook`]), keyed by the relay's delivery id so a redelivery
//!   fires once.
//! - It tells the relay when a run needs the user, finishes, or fails, for push, with the thread's
//!   title and the start of its reply sealed with a key only the user's phones get ([`seal`], 0100).
//! - It tells the account's other online hosts when a device is removed here, in a statement signed
//!   by its host key, and takes theirs ([`crate::server::remote::access::receive_removal`], 0091).
//!
//! It reconnects with jittered exponential backoff and polls nothing. Idle, it sends one ping a
//! minute, which the relay answers without waking, to keep Cloudflare's idle timer from closing
//! the socket.
//!
//! A client reaches a host over a `relay:<hostId>` route: [`open_stream`] is the byte stream its
//! TLS runs over, opened with the Clerk session [`sign_in`] keeps in its `Authorization` header.
//!
//! Every connection honors `HTTPS_PROXY` ([`proxy`]). The relay's TLS also trusts the OS's root
//! certificates, so it works through a TLS-inspecting proxy, which then sees what the relay does
//! and no more: clients' streams are still TLS to a pinned certificate. Clerk's doesn't ([`Roots`]).

use std::collections::{BTreeSet, HashMap, HashSet};
use std::io;
use std::net::{IpAddr, Ipv4Addr, SocketAddr};
use std::sync::atomic::{AtomicI64, Ordering};
use std::sync::{Arc, Mutex, OnceLock, PoisonError};
use std::time::Duration;

use futures_util::{SinkExt as _, StreamExt as _};
use parallax_protocol::jsonrpc::ErrorObject;
use parallax_protocol::{
    AgentOutcome, AgentOutputItem, AgentStatus, ErrorKind, ParallaxEvent, RelayHost,
    RelayHostsResult, RelaySignResult, RelayStatus, RunId,
};
use rustls::pki_types::ServerName;
use serde::Deserialize;
use serde_json::{Value, json};
use tokio::io::{AsyncRead, AsyncReadExt as _, AsyncWrite, AsyncWriteExt as _, DuplexStream};
use tokio::net::TcpStream;
use tokio::sync::{Notify, mpsc};
use tokio::time::{self, Instant};
use tokio_tungstenite::WebSocketStream;
use tokio_tungstenite::tungstenite::{self, Message};
use tokio_util::sync::CancellationToken;
use tracing::{debug, info, warn};

mod proxy;
mod seal;

use self::proxy::Proxy;
use crate::event_log::{Entry, EventLog};
use crate::remote::{self, DpopKey, Error};
use crate::server::Daemon;
use crate::store::store_error;

/// Where the relay is unless `PLXD_RELAY_URL` says otherwise.
pub const DEFAULT_URL: &str = "https://relay.parallax.codes";

/// The most plxd corrects its clock by from the relay's: a day, in milliseconds.
const MAX_CLOCK_OFFSET_MS: i64 = 24 * 60 * 60 * 1000;

/// How often plxd pings the relay. Cloudflare closes a WebSocket idle for 100 s.
const PING: Duration = Duration::from_mins(1);
/// How long a run must stay finished or failed before its push goes (PLX-1337): an agent that
/// goes again within it wasn't done. The phone holds its own notification as long (`HOLD_MS`).
const HOLD: Duration = Duration::from_secs(30);

/// The first wait before reconnecting, doubled after each failure up to [`MAX_BACKOFF`].
const FIRST_BACKOFF: Duration = Duration::from_secs(1);
const MAX_BACKOFF: Duration = Duration::from_mins(5);

/// A connection that lasted this long starts the backoff over.
const STEADY: Duration = Duration::from_mins(1);

/// What plxd's ES256 signature opening its control socket covers, with the time in milliseconds,
/// as relay/src/host.ts has it.
fn host_message(host_id: &str, at: i64) -> String {
    format!("parallax-relay-host\n{host_id}\n{at}")
}

/// The header plxd's proof goes in when it opens its control socket.
const PROOF_HEADER: &str = "x-parallax-host-proof";

/// The header the relay's time comes back in when it refuses a proof for its time.
const TIME_HEADER: &str = "x-parallax-relay-time";

/// What plxd signs to register under the user of a Clerk token with SHA-256 `token_hash`.
fn register_message(host_id: &str, token_hash: &str) -> String {
    format!("parallax-relay-register\n{host_id}\n{token_hash}")
}

/// The relay's URL: `PLXD_RELAY_URL`, else [`DEFAULT_URL`].
#[must_use]
pub fn url() -> String {
    std::env::var("PLXD_RELAY_URL")
        .ok()
        .filter(|url| !url.is_empty())
        .unwrap_or_else(|| DEFAULT_URL.to_owned())
}

/// What a byte stream to or through the relay is.
pub trait Io: AsyncRead + AsyncWrite + Unpin + Send + std::fmt::Debug {}
impl<T: AsyncRead + AsyncWrite + Unpin + Send + std::fmt::Debug> Io for T {}

/// A connection to the relay, or to a host through it.
pub type Stream = Box<dyn Io>;

/// The relay and Clerk session a client's `relay:` routes use.
static CLIENT: OnceLock<(String, String)> = OnceLock::new();

/// Keeps the relay at `url` and the Clerk session `token` for this process's `relay:` routes.
/// `plxd dial` takes them from `PLXD_RELAY_URL` and `PLXD_RELAY_TOKEN`. Only the first call counts.
pub fn sign_in(url: String, token: String) {
    let _ = CLIENT.set((url, token));
}

/// The relay's scheme, host, and port.
struct Base {
    tls: bool,
    host: String,
    port: u16,
}

impl Base {
    /// `https://host[:port]`, or `http://` to this computer only, for `wrangler dev`.
    fn parse(url: &str) -> io::Result<Self> {
        let bad = |why: &str| io::Error::new(io::ErrorKind::InvalidInput, format!("{url}: {why}"));
        let (tls, rest) = if let Some(rest) = url.strip_prefix("https://") {
            (true, rest)
        } else if let Some(rest) = url.strip_prefix("http://") {
            (false, rest)
        } else {
            return Err(bad("not an http(s) URL"));
        };
        let authority = rest.split('/').next().unwrap_or_default();
        let (host, port) = match authority.rsplit_once(':') {
            Some((host, port)) => (host, port.parse().map_err(|_| bad("a bad port"))?),
            None => (authority, default_port(tls)),
        };
        if !tls && !local_host(host) {
            return Err(bad("plain HTTP reaches only this computer"));
        }
        Ok(Self {
            tls,
            host: host.to_owned(),
            port,
        })
    }

    fn authority(&self) -> String {
        if self.port == default_port(self.tls) {
            self.host.clone()
        } else {
            format!("{}:{}", self.host, self.port)
        }
    }

    /// A connection to this host: through `HTTPS_PROXY` unless `NO_PROXY` names it or it's this
    /// computer, with TLS checked against `roots`, or plain to loopback.
    async fn connect(&self, roots: Roots) -> io::Result<Stream> {
        let through = if local_host(&self.host) {
            None
        } else {
            Proxy::from_env(&self.host, self.port)?
        };
        let tcp = match through {
            Some(proxy) => proxy.tunnel(&self.host, self.port).await?,
            None => TcpStream::connect((self.host.as_str(), self.port)).await?,
        };
        let _ = tcp.set_nodelay(true);
        if !self.tls {
            return Ok(Box::new(tcp));
        }
        let config = match roots {
            Roots::Mozilla => tls_config(mozilla_roots())?,
            Roots::WithOs => relay_tls().await?,
        };
        let name = ServerName::try_from(self.host.clone()).map_err(io::Error::other)?;
        let tls = tokio_rustls::TlsConnector::from(config)
            .connect(name, tcp)
            .await?;
        Ok(Box::new(tls))
    }
}

/// Which root certificates a connection's TLS is checked against (0091).
#[derive(Clone, Copy, Debug)]
enum Roots {
    /// Mozilla's alone, for Clerk's keys: a proxy's certificate must not vouch for what checks
    /// sign-ins.
    Mozilla,
    /// Mozilla's and the OS's, for the relay: a TLS-inspecting proxy's certificate may vouch for
    /// the outer connection, since what matters inside it is TLS to a pinned certificate.
    WithOs,
}

fn mozilla_roots() -> rustls::RootCertStore {
    rustls::RootCertStore {
        roots: webpki_roots::TLS_SERVER_ROOTS.to_vec(),
    }
}

fn tls_config(roots: rustls::RootCertStore) -> io::Result<Arc<rustls::ClientConfig>> {
    let config = rustls::ClientConfig::builder_with_provider(remote::provider())
        .with_safe_default_protocol_versions()
        .map_err(io::Error::other)?
        .with_root_certificates(roots)
        .with_no_client_auth();
    Ok(Arc::new(config))
}

/// The config for [`Roots::WithOs`], made once, since reading the OS's store can take a moment and
/// reconnects shouldn't wait on it. A root added later counts once plxd restarts. `SSL_CERT_FILE`
/// and `SSL_CERT_DIR` replace the OS's store when set. A store that can't be read leaves
/// Mozilla's roots.
async fn relay_tls() -> io::Result<Arc<rustls::ClientConfig>> {
    static CONFIG: tokio::sync::OnceCell<Arc<rustls::ClientConfig>> =
        tokio::sync::OnceCell::const_new();
    let config = CONFIG.get_or_try_init(|| async {
        let os = tokio::task::spawn_blocking(rustls_native_certs::load_native_certs)
            .await
            .map_err(io::Error::other)?;
        for error in &os.errors {
            warn!(%error, "could not read some of this computer's root certificates");
        }
        let mut roots = mozilla_roots();
        let (added, ignored) = roots.add_parsable_certificates(os.certs);
        info!(
            added,
            ignored, "read this computer's root certificates for the relay"
        );
        tls_config(roots)
    });
    config.await.cloned()
}

/// Whether `host` names this computer, which no proxy stands in front of.
fn local_host(host: &str) -> bool {
    host == "localhost" || host.parse::<IpAddr>().is_ok_and(|ip| ip.is_loopback())
}

/// HTTPS's port, or HTTP's.
fn default_port(tls: bool) -> u16 {
    if tls { 443 } else { 80 }
}

/// What a relay call signed in with the user's Clerk session answers when the relay refuses it.
const SIGN_IN_REFUSED: &str = "The relay didn't accept this sign-in.";

/// What a relay call answers when it couldn't reach the relay.
fn cant_reach(error: &Error) -> String {
    format!("Parallax couldn't reach the relay: {error}")
}

/// A JSON `GET` of `path` at `url`, with no credential, such as Clerk's JWKS (0091): its status,
/// JSON body, and `Cache-Control` `max-age`. HTTPS checked against [`Roots::Mozilla`], or plain
/// HTTP to this computer.
pub(crate) async fn get(url: &str, path: &str) -> Result<Answer, Error> {
    request(url, Roots::Mozilla, "GET", path, None, None).await
}

/// An HTTP answer: its status, JSON body, and `Cache-Control` `max-age`.
pub(crate) type Answer = (u16, Value, Option<Duration>);

/// One JSON request to the relay, signed in with `token` when given: its status and JSON body.
async fn http(
    url: &str,
    method: &str,
    path: &str,
    token: Option<&str>,
    body: Option<&Value>,
) -> Result<(u16, Value), Error> {
    let (status, body, _) = request(url, Roots::WithOs, method, path, token, body).await?;
    Ok((status, body))
}

/// One JSON request: its status, JSON body, and `Cache-Control` `max-age`.
async fn request(
    url: &str,
    roots: Roots,
    method: &str,
    path: &str,
    token: Option<&str>,
    body: Option<&Value>,
) -> Result<Answer, Error> {
    let base = Base::parse(url)?;
    let mut stream = base.connect(roots).await?;
    let body = body.map(ToString::to_string).unwrap_or_default();
    let authorization = token
        .map(|token| format!("Authorization: Bearer {token}\r\n"))
        .unwrap_or_default();
    let head = format!(
        "{method} {path} HTTP/1.1\r\nHost: {}\r\n{authorization}\
         Connection: close\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n",
        base.authority(),
        body.len()
    );
    stream.write_all(head.as_bytes()).await?;
    stream.write_all(body.as_bytes()).await?;
    stream.flush().await?;
    // Read until the body is whole, since a server may keep the connection open regardless.
    let mut answer = Vec::new();
    let mut chunk = [0; 4096];
    loop {
        let read = match stream.read(&mut chunk).await {
            Ok(read) => read,
            Err(error) if error.kind() == io::ErrorKind::UnexpectedEof => 0,
            Err(error) => return Err(error.into()),
        };
        answer.extend_from_slice(&chunk[..read]);
        if let Some(parsed) = parse_response(&answer, read == 0) {
            return parsed;
        }
        if read == 0 {
            return Err(Error::Protocol(
                "the relay sent an answer that isn't HTTP".to_owned(),
            ));
        }
    }
}

/// The status, JSON body, and `Cache-Control` `max-age` of `answer`, once it's whole, or at the
/// end of the connection.
fn parse_response(answer: &[u8], ended: bool) -> Option<Result<Answer, Error>> {
    let mut headers = [httparse::EMPTY_HEADER; 32];
    let mut response = httparse::Response::new(&mut headers);
    let Ok(httparse::Status::Complete(length)) = response.parse(answer) else {
        return None;
    };
    let header = |name: &str| {
        response
            .headers
            .iter()
            .find(|h| h.name.eq_ignore_ascii_case(name))
            .map(|h| String::from_utf8_lossy(h.value).into_owned())
    };
    let rest = &answer[length..];
    let body = if header("transfer-encoding").is_some_and(|v| v.contains("chunked")) {
        if !ended && !rest.ends_with(b"0\r\n\r\n") {
            return None;
        }
        dechunk(rest)
    } else if let Some(size) = header("content-length").and_then(|v| v.trim().parse().ok()) {
        if rest.len() < size {
            return ended
                .then(|| Err(Error::Protocol("the relay's answer was cut off".to_owned())));
        }
        rest[..size].to_vec()
    } else if ended {
        rest.to_vec()
    } else {
        return None;
    };
    let status = response.code.unwrap_or(0);
    let max_age = header("cache-control").and_then(|value| {
        let (_, rest) = value.split_once("max-age=")?;
        let digits: String = rest.chars().take_while(char::is_ascii_digit).collect();
        digits.parse().ok().map(Duration::from_secs)
    });
    Some(Ok((
        status,
        serde_json::from_slice(&body).unwrap_or(Value::Null),
        max_age,
    )))
}

/// A chunked body's bytes.
fn dechunk(mut rest: &[u8]) -> Vec<u8> {
    let mut body = Vec::new();
    while let Some(end) = rest.windows(2).position(|w| w == b"\r\n") {
        let size = std::str::from_utf8(&rest[..end])
            .ok()
            .and_then(|line| usize::from_str_radix(line.split(';').next()?.trim(), 16).ok())
            .unwrap_or(0);
        let start = end + 2;
        if size == 0 || rest.len() < start + size {
            break;
        }
        body.extend_from_slice(&rest[start..start + size]);
        rest = rest.get(start + size + 2..).unwrap_or_default();
    }
    body
}

/// A WebSocket to the relay's `path`, with `headers`. A 404 is [`Error::Refused`]: no such host,
/// or stream.
async fn websocket(
    url: &str,
    path: &str,
    headers: &[(&'static str, &str)],
) -> Result<WebSocketStream<Stream>, Error> {
    upgrade(url, path, headers)
        .await
        .map_err(|(_, error)| error)
}

/// [`websocket`], with the HTTP status the relay refused the upgrade with, if it answered one.
async fn upgrade(
    url: &str,
    path: &str,
    headers: &[(&'static str, &str)],
) -> Result<WebSocketStream<Stream>, (Option<u16>, Error)> {
    use tokio_tungstenite::tungstenite::client::IntoClientRequest as _;
    let base = Base::parse(url).map_err(|e| (None, e.into()))?;
    let stream = base
        .connect(Roots::WithOs)
        .await
        .map_err(|e| (None, e.into()))?;
    let scheme = if base.tls { "wss" } else { "ws" };
    let address = format!("{scheme}://{}{path}", base.authority());
    let mut request = address
        .into_client_request()
        .map_err(|e| (None, Error::Protocol(e.to_string())))?;
    for (name, value) in headers {
        let value = value
            .parse()
            .map_err(|_| (None, Error::Protocol(format!("a bad {name} header"))))?;
        request.headers_mut().insert(*name, value);
    }
    let config = Some(remote::websocket_config());
    let (socket, _) = tokio_tungstenite::client_async_with_config(request, stream, config)
        .await
        .map_err(|error| {
            let tungstenite::Error::Http(response) = error else {
                let error = Error::Protocol(format!("the relay's WebSocket failed: {error}"));
                return (None, error);
            };
            let status = response.status().as_u16();
            let error = match status {
                404 => Error::Refused,
                401 => match relay_clock(&response) {
                    Some(relay_ms) => Error::Clock(relay_ms),
                    None => Error::Protocol("the relay refused this host's proof".to_owned()),
                },
                _ => Error::Protocol(format!("the relay's WebSocket failed: HTTP {status}")),
            };
            (Some(status), error)
        })?;
    Ok(socket)
}

/// Joins a WebSocket's binary frames to a byte stream: what's written to the answer goes out in
/// frames, and frames come out of it. Either side's end ends both.
fn pipe(socket: WebSocketStream<Stream>) -> DuplexStream {
    let (ours, theirs) = tokio::io::duplex(64 * 1024);
    tokio::spawn(async move {
        let (mut sink, mut frames) = socket.split();
        let (mut reader, mut writer) = tokio::io::split(theirs);
        let outgoing = async {
            let mut buffer = vec![0; 16 * 1024];
            loop {
                let read = reader.read(&mut buffer).await?;
                if read == 0 {
                    break;
                }
                let frame = Message::binary(buffer[..read].to_vec());
                sink.send(frame).await.map_err(io::Error::other)?;
            }
            let _ = sink.close().await;
            Ok::<_, io::Error>(())
        };
        let incoming = async {
            while let Some(frame) = frames.next().await {
                match frame.map_err(io::Error::other)? {
                    Message::Binary(bytes) => writer.write_all(&bytes).await?,
                    Message::Close(_) => break,
                    _ => {}
                }
            }
            writer.shutdown().await
        };
        let ended = tokio::select! {
            ended = outgoing => ended,
            ended = incoming => ended,
        };
        if let Err(error) = ended {
            debug!(%error, "a relay stream ended");
        }
    });
    ours
}

/// A byte stream to the host with relay id `host_id`, through the relay [`sign_in`] named, opened
/// with the Clerk token in the `Authorization` header and no ticket first (0091). The relay can't
/// read it: the caller runs TLS to the host's pinned certificate over it.
///
/// # Errors
///
/// When there's no sign-in, the relay refuses it or isn't reachable, or the host is offline or
/// isn't this user's. None of them is [`Error::Refused`], which only the host itself says.
pub async fn open_stream(host_id: &str) -> Result<DuplexStream, Error> {
    let Some((url, token)) = CLIENT.get() else {
        return Err(Error::Protocol(
            "the relay route needs a sign-in (PLXD_RELAY_TOKEN)".to_owned(),
        ));
    };
    stream_at(url, token, host_id).await
}

/// [`open_stream`] through the relay at `url`, signed in with `token`. A relay from before 0091
/// refuses the header with 401, 404, or 426 before any stream opens. Then this asks it for a
/// ticket and opens `/connect?ticket=`, as such a relay expects. Once a stream opened, nothing is
/// tried again.
async fn stream_at(url: &str, token: &str, host_id: &str) -> Result<DuplexStream, Error> {
    let path = format!("/v1/hosts/{host_id}/connect");
    let authorization = format!("Bearer {token}");
    let mut socket = match upgrade(url, &path, &[("authorization", &authorization)]).await {
        Ok(socket) => socket,
        Err((Some(401 | 404 | 426), _)) => ticketed(url, token, host_id).await?,
        Err((_, error)) => return Err(error),
    };
    // The relay says so once the host joined the stream.
    match socket.next().await {
        Some(Ok(Message::Text(text))) if text.as_str() == "ready" => Ok(pipe(socket)),
        _ => Err(Error::Protocol(
            "the host didn't join the relay's stream".to_owned(),
        )),
    }
}

/// A WebSocket to `host_id` opened with a ticket, as a relay from before 0091 expects.
async fn ticketed(url: &str, token: &str, host_id: &str) -> Result<WebSocketStream<Stream>, Error> {
    let path = format!("/v1/hosts/{host_id}/tickets");
    let (status, body) = http(url, "POST", &path, Some(token), None).await?;
    let Some(ticket) = body["ticket"].as_str().filter(|_| status == 200) else {
        return Err(Error::Protocol(format!(
            "the relay answered {status}: {}",
            body["error"].as_str().unwrap_or("no ticket")
        )));
    };
    let path = format!("/v1/hosts/{host_id}/connect?ticket={ticket}");
    match websocket(url, &path, &[]).await {
        Err(Error::Refused) => Err(Error::Protocol("the relay refused the ticket".to_owned())),
        other => other,
    }
}

/// The relay connection's state, and the wake-up for setting changes.
#[derive(Debug)]
pub(crate) struct Relay {
    /// The relay's URL.
    pub url: String,
    /// Wakes [`run`] when `relay` or `remote` changes, or a registration succeeds.
    pub changed: Notify,
    /// Wakes the connection to send the relay its webhook URLs again, after a scheduled task
    /// is saved or deleted.
    pub hooks_changed: Notify,
    /// How far the relay's clock is ahead of this computer's, in milliseconds, once the relay
    /// refused a proof for its time. Proofs are signed by the relay's clock from then on.
    clock_offset: AtomicI64,
    status: Mutex<Status>,
    /// The keys removed here that the account's other hosts haven't been told of. Each stays until
    /// it's sent, so a socket that's down sends it on the next.
    removals: Mutex<BTreeSet<String>>,
    /// Wakes the connection to send [`Relay::removals`].
    removed: Notify,
}

#[derive(Clone, Debug, Default)]
struct Status {
    /// This host's relay id while connected.
    connected: Option<String>,
    problem: Option<String>,
}

impl Relay {
    pub(crate) fn new(url: String) -> Self {
        Self {
            url,
            changed: Notify::new(),
            hooks_changed: Notify::new(),
            clock_offset: AtomicI64::new(0),
            status: Mutex::default(),
            removals: Mutex::default(),
            removed: Notify::new(),
        }
    }

    /// Tells the account's other online hosts, on this connection or the next, that `key` is
    /// removed.
    pub(crate) fn tell_removed(&self, key: String) {
        self.removals
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .insert(key);
        self.removed.notify_one();
    }

    /// The keys the next removal statement names.
    fn waiting_removals(&self) -> Vec<String> {
        let waiting = self.removals.lock().unwrap_or_else(PoisonError::into_inner);
        waiting.iter().take(MAX_REMOVALS).cloned().collect()
    }

    /// Stops waiting to tell of `keys`, and wakes the connection for any others.
    fn sent_removals(&self, keys: &[String]) {
        let mut waiting = self.removals.lock().unwrap_or_else(PoisonError::into_inner);
        for key in keys {
            waiting.remove(key);
        }
        if !waiting.is_empty() {
            self.removed.notify_one();
        }
    }

    fn set(&self, status: Status) {
        *self.status.lock().unwrap_or_else(PoisonError::into_inner) = status;
    }

    fn get(&self) -> Status {
        self.status
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .clone()
    }

    /// `remote/sessions`' `relay`, while the setting is on.
    pub(crate) fn status(&self) -> RelayStatus {
        let status = self.get();
        RelayStatus {
            connected: status.connected.is_some(),
            hook_url: status
                .connected
                .map(|id| format!("{}/v1/hooks/{id}", self.url)),
            problem: status.problem,
        }
    }

    /// This host's `relay:` route while it's connected.
    pub(crate) fn route(&self) -> Option<String> {
        let id = self.get().connected?;
        Some(format!("{}{id}", remote::RELAY_ROUTE))
    }

    /// How far the relay's clock is ahead of this computer's, in milliseconds, as last measured.
    /// Zero until the relay refused a proof for its time.
    pub(crate) fn clock_offset_ms(&self) -> i64 {
        self.clock_offset.load(Ordering::Relaxed)
    }
}

/// Whether plxd should be connected: `relay` on. Pushes and webhooks need nothing else
/// (PLX-1146).
pub(crate) async fn wanted(daemon: &Daemon) -> bool {
    daemon
        .reader
        .run(&CancellationToken::new(), |db| {
            Ok(db.relay().unwrap_or(false))
        })
        .await
        .unwrap_or(false)
}

/// Whether plxd serves clients' streams: `remote` on, since they end at its remote listener.
async fn serving(daemon: &Daemon) -> bool {
    daemon
        .reader
        .run(&CancellationToken::new(), |db| {
            Ok(db.remote().unwrap_or(false))
        })
        .await
        .unwrap_or(false)
}

/// Turns `relay` on for a host whose user never set it, so signing in is enough for phone
/// notifications (PLX-1146), and reconnects. One turned off stays off.
async fn on_unless_chosen(daemon: &Daemon) {
    let turned = daemon
        .store
        .run(&CancellationToken::new(), |db| {
            Ok(!db.relay_chosen().unwrap_or(true) && db.set_relay(true).is_ok())
        })
        .await
        .unwrap_or(false);
    if turned {
        info!("turned the relay on for this computer");
    }
    daemon.relay.changed.notify_one();
}

/// `relay/sign`: this host's registration with the relay, signed with its key over `token_hash`,
/// the SHA-256 of a Clerk session token that stays on another computer, which posts it with
/// [`register`] (PLX-1146). Records `user`, the token's Clerk user that the caller names, as this
/// host's account (0091). Turns `relay` on unless its user chose.
pub(crate) async fn sign(
    daemon: &Daemon,
    token_hash: &str,
    user: Option<&str>,
) -> Result<RelaySignResult, String> {
    let key = signer(daemon).await.map_err(|e| e.to_string())?;
    let host_id = key.thumbprint();
    let (x, y) = key.coordinates();
    let signature = key.sign(register_message(&host_id, token_hash).as_bytes());
    if let Some(user) = user {
        crate::server::remote::access::record_account(daemon, user).await?;
    }
    on_unless_chosen(daemon).await;
    Ok(RelaySignResult {
        host_id,
        x,
        y,
        name: crate::server::remote::host_name(daemon).await,
        signature: remote::base64url(&signature),
    })
}

/// The host key as the relay knows it.
async fn signer(daemon: &Daemon) -> Result<DpopKey, Error> {
    let key = crate::server::remote::host_key(daemon).await?;
    key.signer()
        .ok_or_else(|| Error::Protocol("the host key isn't P-256".to_owned()))
}

/// `relay/register`: registers a host's key with the relay under the user of the Clerk session
/// `token`: `signed`, another computer's from its `relay/sign`, else this host's, signed now. This
/// host's records the token's user as its account (0091), from the token the caller handed it,
/// never from the relay, turns `relay` on unless its user chose, and reconnects. Answers why it
/// couldn't.
pub(crate) async fn register(
    daemon: &Daemon,
    token: &str,
    signed: Option<RelaySignResult>,
) -> Result<(), String> {
    let own = signed.is_none();
    let signed = match signed {
        Some(signed) => signed,
        None => {
            sign(
                daemon,
                &remote::base64url(&remote::sha256(token.as_bytes())),
                None,
            )
            .await?
        }
    };
    let RelaySignResult {
        host_id,
        x,
        y,
        name,
        signature,
    } = signed;
    let body = json!({
        "hostId": host_id,
        "jwk": { "kty": "EC", "crv": "P-256", "x": x, "y": y },
        "name": name,
        "signature": signature,
    });
    let relay = &daemon.relay;
    let answered = http(&relay.url, "POST", "/v1/hosts", Some(token), Some(&body)).await;
    match answered {
        Ok((200, _)) => {
            info!(%host_id, own, "registered with the relay");
            if own {
                if let Some(user) = crate::clerk::subject(token) {
                    crate::server::remote::access::record_account(daemon, &user).await?;
                }
                relay.changed.notify_one();
            }
            Ok(())
        }
        Ok((401, _)) => Err(SIGN_IN_REFUSED.to_owned()),
        Ok((status, body)) => Err(format!(
            "The relay answered {status}: {}",
            body["error"].as_str().unwrap_or("no reason")
        )),
        Err(error) => Err(cant_reach(&error)),
    }
}

/// `relay/hosts`: the hosts the user of the Clerk session `token` has on the relay, this one
/// marked, and those that left the account, as the relay says. An outage answers with its own
/// [`ErrorKind`], so an app can say what's down (PLX-1351). Anything else answers why not, for
/// people.
pub(crate) async fn hosts(daemon: &Daemon, token: &str) -> Result<RelayHostsResult, ErrorObject> {
    let own = signer(daemon).await.ok().map(|key| key.thumbprint());
    let answered = http(&daemon.relay.url, "GET", "/v1/hosts", Some(token), None).await;
    let body = match answered {
        Ok((200, body)) => body,
        Ok((401, _)) => return Err(ErrorObject::invalid_params(SIGN_IN_REFUSED)),
        Ok((503, body)) if body["error"] == "clerk_unreachable" => {
            return Err(ErrorObject::parallax(
                ErrorKind::ClerkUnreachable,
                "The relay can't reach Clerk to check this sign-in.",
            ));
        }
        Ok((status @ 500.., _)) => {
            return Err(ErrorObject::parallax(
                ErrorKind::RelayUnreachable,
                format!("The relay answered {status}."),
            ));
        }
        Ok((status, _)) => {
            return Err(ErrorObject::invalid_params(format!(
                "The relay answered {status}."
            )));
        }
        Err(error) => {
            return Err(ErrorObject::parallax(
                ErrorKind::RelayUnreachable,
                cant_reach(&error),
            ));
        }
    };
    let Some(listed) = body["hosts"].as_array() else {
        return Err(ErrorObject::invalid_params(
            "The relay's answer didn't list any hosts.",
        ));
    };
    let hosts = listed
        .iter()
        .filter_map(|host| {
            let host_id = host["hostId"].as_str()?.to_owned();
            Some(RelayHost {
                this_computer: own.as_deref() == Some(host_id.as_str()),
                name: host["name"].as_str().unwrap_or_default().to_owned(),
                online: host["online"].as_bool().unwrap_or(false),
                usage: serde_json::from_value(host["usage"].clone()).ok(),
                host_id,
            })
        })
        .collect();
    let removed = body["removed"].as_array().map(|ids| {
        ids.iter()
            .filter_map(|id| id.as_str().map(str::to_owned))
            .collect()
    });
    Ok(RelayHostsResult { hosts, removed })
}

/// `relay/remove`: removes the user's host `host_id` from the relay, which frees its place. One
/// already gone counts as removed. Answers why not, for people.
pub(crate) async fn remove(daemon: &Daemon, token: &str, host_id: &str) -> Result<(), String> {
    let id_like = host_id.len() == 43
        && host_id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_');
    if !id_like {
        return Err("That isn't a host on the relay.".to_owned());
    }
    let path = format!("/v1/hosts/{host_id}");
    match http(&daemon.relay.url, "DELETE", &path, Some(token), None).await {
        Ok((200 | 404, _)) => {
            info!(%host_id, "removed a host from the relay");
            Ok(())
        }
        Ok((401, _)) => Err(SIGN_IN_REFUSED.to_owned()),
        Ok((status, _)) => Err(format!("The relay answered {status}.")),
        Err(error) => Err(cant_reach(&error)),
    }
}

/// How a connection to the relay ended, other than failing.
enum Ended {
    /// plxd is shutting down.
    Stopped,
    /// `relay` turned off.
    Off,
}

/// Keeps plxd connected to the relay while `relay` is on, until `stop`.
pub(crate) async fn run(daemon: Arc<Daemon>, stop: CancellationToken) {
    let relay = &daemon.relay;
    let mut failures = 0_u32;
    let mut pushes = Pushes::new(daemon.log.head());
    loop {
        if !wanted(&daemon).await {
            relay.set(Status::default());
            // Unlinked: a new device's request waiting for approval goes too (0091).
            daemon.remote.access.clear();
            tokio::select! {
                () = stop.cancelled() => return,
                () = relay.changed.notified() => continue,
            }
        }
        let started = Instant::now();
        let ended = connected(&daemon, &stop, &mut pushes).await;
        let wait = match ended {
            Ok(Ended::Stopped) => return,
            Ok(Ended::Off) => {
                pushes.holds.clear();
                continue;
            }
            // Waits for `relay/register` here, or tries again on backoff, since another computer
            // may register this one with its `relay/sign` (PLX-1146).
            Err(Error::Refused) => {
                let problem = "This computer isn't registered with the relay yet. Sign in to Parallax to register it.";
                relay.set(Status {
                    connected: None,
                    problem: Some(problem.to_owned()),
                });
                failures += 1;
                Some(backoff(failures))
            }
            Err(error) => {
                warn!(%error, "lost the relay connection");
                if started.elapsed() >= STEADY {
                    failures = 0;
                }
                failures += 1;
                relay.set(Status {
                    connected: None,
                    problem: Some(cant_reach(&error)),
                });
                Some(backoff(failures))
            }
        };
        tokio::select! {
            () = stop.cancelled() => return,
            () = relay.changed.notified() => failures = 0,
            () = time::sleep(wait.unwrap_or_default()), if wait.is_some() => {}
        }
    }
}

/// The wait after `failures` failures in a row: doubling from [`FIRST_BACKOFF`] up to
/// [`MAX_BACKOFF`], then a random half to all of it, so hosts don't reconnect in step.
fn backoff(failures: u32) -> Duration {
    let full = FIRST_BACKOFF
        .saturating_mul(1 << failures.saturating_sub(1).min(16))
        .min(MAX_BACKOFF);
    let mut random = [0; 4];
    let _ = getrandom::fill(&mut random);
    let fraction = f64::from(u32::from_le_bytes(random)) / f64::from(u32::MAX);
    full.mul_f64(0.5 + fraction / 2.0)
}

/// One connection to the relay: opened with a proof of the host key, then streams, webhooks, and
/// pushes until it ends.
async fn connected(
    daemon: &Arc<Daemon>,
    stop: &CancellationToken,
    pushes: &mut Pushes,
) -> Result<Ended, Error> {
    let key = signer(daemon).await?;
    let host_id = key.thumbprint();
    let url = &daemon.relay.url;
    // The time in milliseconds, signed: the relay takes each proof once, from 5 minutes behind its
    // clock to 30 s ahead, so there's no challenge to wait on and no pending socket a stranger can
    // push out. Signed by the relay's clock once it said this one is off.
    let handshake = |at: i64| {
        let signature = key.sign(host_message(&host_id, at).as_bytes());
        let proof = format!("{at}.{}", remote::base64url(&signature));
        let path = format!("/v1/hosts/{host_id}/host");
        async move {
            let mut socket = websocket(url, &path, &[(PROOF_HEADER, &proof)]).await?;
            if next_json(&mut socket).await?["t"] != "ready" {
                return Err(Error::Protocol(
                    "the relay didn't accept the host key".to_owned(),
                ));
            }
            Ok(socket)
        }
    };
    let timed = |at| async move {
        time::timeout(remote::REQUEST_TIMEOUT, handshake(at))
            .await
            .map_err(|_| Error::Protocol("the relay didn't answer in time".to_owned()))?
    };
    let relay = &daemon.relay;
    let socket = match timed(now_ms() + relay.clock_offset.load(Ordering::Relaxed)).await {
        Err(Error::Clock(relay_ms)) => {
            // A clock off by more than a day isn't a drift to correct for, and keeps the sums below
            // from overflowing.
            let Some(offset) = relay_ms
                .checked_sub(now_ms())
                .filter(|offset| offset.abs() <= MAX_CLOCK_OFFSET_MS)
            else {
                warn!(
                    relay_ms,
                    "the relay's time is over a day from this computer's; not using it"
                );
                return Err(Error::Clock(relay_ms));
            };
            warn!(
                seconds = offset / 1000,
                "this computer's clock is off from the relay's; signing with the relay's time"
            );
            relay.clock_offset.store(offset, Ordering::Relaxed);
            timed(now_ms() + offset).await?
        }
        other => other?,
    };
    info!(%host_id, "connected to the relay");
    daemon.relay.set(Status {
        connected: Some(host_id.clone()),
        problem: None,
    });
    let ended = serve(daemon, socket, &host_id, stop, pushes).await;
    daemon.relay.set(Status::default());
    ended
}

/// How many keys one removal statement names, which keeps it well under
/// [`remote::MAX_REMOVAL_BYTES`].
const MAX_REMOVALS: usize = 100;

/// How many removal statements from the relay wait while one is checked. The rest are dropped, and
/// their computers learn of those removals from a client.
const MAX_WAITING_REMOVALS: usize = 16;

/// The longest text frame plxd reads from the relay: a removal statement of
/// [`remote::MAX_REMOVAL_BYTES`], with each character escaped at worst.
const MAX_TEXT_FRAME: usize = 2 * remote::MAX_REMOVAL_BYTES + 64;

/// A queue of the relay's removal statements, checked one at a time until the sender drops. A relay
/// sending many therefore costs one task, a bounded amount of memory, and one store read at a time.
fn removal_queue(daemon: &Arc<Daemon>) -> mpsc::Sender<String> {
    let (queue, mut statements) = mpsc::channel::<String>(MAX_WAITING_REMOVALS);
    let daemon = Arc::clone(daemon);
    tokio::spawn(async move {
        while let Some(statement) = statements.recv().await {
            crate::server::remote::access::receive_removal(&daemon, &statement).await;
        }
    });
    queue
}

/// Queues `statement` unless it's too long or `queue` is full: whether it did. Nothing is copied
/// for one it refuses.
fn queue_removal(queue: &mpsc::Sender<String>, statement: &str) -> bool {
    if statement.len() > remote::MAX_REMOVAL_BYTES {
        debug!("ignored a device's removal too long to check");
        return false;
    }
    let Ok(place) = queue.try_reserve() else {
        debug!("dropped a device's removal: too many are waiting");
        return false;
    };
    place.send(statement.to_owned());
    true
}

/// The next removal statement to send, with the keys it names. None with nothing waiting. With no
/// account to sign for, the keys are dropped, and other computers learn of them from a client.
async fn next_removal(daemon: &Daemon) -> Option<(Vec<String>, Message)> {
    let keys = daemon.relay.waiting_removals();
    if keys.is_empty() {
        return None;
    }
    let Some(account) = crate::server::remote::access::account(daemon).await else {
        daemon.relay.sent_removals(&keys);
        return None;
    };
    let key = signer(daemon).await.ok()?;
    let statement = remote::signed_removal(&key, &account, &keys);
    let message = json!({ "t": "removed", "statement": statement });
    Some((keys, Message::text(message.to_string())))
}

/// Milliseconds since the epoch, by this computer's clock.
fn now_ms() -> i64 {
    let since = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default();
    i64::try_from(since.as_millis()).unwrap_or(i64::MAX)
}

/// The relay's clock, in milliseconds, from its refusal of a proof for its time.
fn relay_clock<T>(response: &tungstenite::http::Response<T>) -> Option<i64> {
    response
        .headers()
        .get(TIME_HEADER)?
        .to_str()
        .ok()?
        .parse()
        .ok()
}

/// The next text frame as JSON.
async fn next_json(socket: &mut WebSocketStream<Stream>) -> Result<Value, Error> {
    loop {
        match socket.next().await {
            Some(Ok(Message::Text(text))) => {
                return Ok(serde_json::from_str(&text).unwrap_or(Value::Null));
            }
            Some(Ok(Message::Close(_))) | None => {
                return Err(Error::Protocol(
                    "the relay closed the connection".to_owned(),
                ));
            }
            Some(Ok(_)) => {}
            Some(Err(error)) => return Err(Error::Protocol(error.to_string())),
        }
    }
}

/// Serves an accepted connection until it ends.
#[expect(
    clippy::too_many_lines,
    reason = "one select over the relay's messages, plxd's events, and the spare stream"
)]
async fn serve(
    daemon: &Arc<Daemon>,
    socket: WebSocketStream<Stream>,
    host_id: &str,
    stop: &CancellationToken,
    pushes: &mut Pushes,
) -> Result<Ended, Error> {
    let (mut sink, mut frames) = socket.split();
    let (replies, mut answered) = mpsc::channel::<String>(16);
    let removals = removal_queue(daemon);
    // The streams close with this connection.
    let streams = stop.child_token();
    let _streams = streams.clone().drop_guard();
    let remote = &daemon.remote;
    let local = SocketAddr::new(
        remote.address.unwrap_or(IpAddr::V4(Ipv4Addr::LOCALHOST)),
        remote.port,
    );
    let mut events = daemon.log.watch();
    pushes.catch_up(&daemon.log, Instant::now());
    // The spare stream (0091): asked for while `remote` is on, and again once it's taken or ends.
    let (spare_done, mut spare_ended) = mpsc::channel::<()>(4);
    let mut spare: Option<CancellationToken> = None;
    let mut ping = time::interval_at(Instant::now() + PING, PING);
    let mut heard = true;
    let failed = |error: tungstenite::Error| Error::Protocol(error.to_string());
    // The webhook URLs this plxd serves, so the relay refuses the rest for free.
    let hooks = || async {
        let keys = crate::schedules::hook_keys(daemon).await;
        Message::text(json!({ "t": "hooks", "keys": keys }).to_string())
    };
    sink.send(hooks().await).await.map_err(failed)?;
    // Any removal the last connection didn't send. None waiting wakes nothing.
    daemon.relay.sent_removals(&[]);
    loop {
        // `remote` on with no spare asks for one; `remote` off closes it.
        match (serving(daemon).await, &spare) {
            (true, None) => {
                spare = Some(streams.child_token());
                sink.send(Message::text(r#"{"t":"spare"}"#))
                    .await
                    .map_err(failed)?;
            }
            (false, Some(open)) => {
                open.cancel();
                spare = None;
            }
            _ => {}
        }
        let held = pushes.next_due();
        tokio::select! {
            () = stop.cancelled() => {
                let _ = sink.close().await;
                return Ok(Ended::Stopped);
            }
            () = daemon.relay.changed.notified() => {
                if !wanted(daemon).await {
                    let _ = sink.close().await;
                    return Ok(Ended::Off);
                }
            }
            Some(()) = spare_ended.recv() => spare = None,
            _ = ping.tick() => {
                if !heard {
                    return Err(Error::Protocol("the relay stopped answering".to_owned()));
                }
                heard = false;
                sink.send(Message::text("ping")).await.map_err(failed)?;
            }
            Some(reply) = answered.recv() => sink.send(Message::text(reply)).await.map_err(failed)?,
            () = daemon.relay.hooks_changed.notified() => {
                sink.send(hooks().await).await.map_err(failed)?;
            }
            () = daemon.relay.removed.notified() => {
                if let Some((keys, removal)) = next_removal(daemon).await {
                    sink.send(removal).await.map_err(failed)?;
                    daemon.relay.sent_removals(&keys);
                }
            }
            Ok(()) = events.changed() => {
                for (run, state) in pushes.read(&daemon.log, Instant::now()) {
                    let push = message(daemon, host_id, run, state).await;
                    sink.send(Message::text(push)).await.map_err(failed)?;
                }
            }
            () = time::sleep_until(held.unwrap_or_else(Instant::now)), if held.is_some() => {
                // An event ready at this moment too may cancel a hold, so events go first.
                for (run, state) in pushes.read(&daemon.log, Instant::now()) {
                    let push = message(daemon, host_id, run, state).await;
                    sink.send(Message::text(push)).await.map_err(failed)?;
                }
                // Each stays held until it's sent, so a socket that fails sends it on the next.
                for (run, state) in pushes.due(Instant::now()) {
                    let push = message(daemon, host_id, run, state).await;
                    sink.send(Message::text(push)).await.map_err(failed)?;
                    pushes.holds.remove(&run);
                }
            }
            frame = frames.next() => {
                heard = true;
                match frame {
                    Some(Ok(Message::Text(text))) => {
                        // No frame the relay sends plxd is this long, so none costs a parse.
                        let message: Value = if text.len() > MAX_TEXT_FRAME {
                            Value::Null
                        } else {
                            serde_json::from_str(&text).unwrap_or(Value::Null)
                        };
                        if message["t"] == "open" && serving(daemon).await {
                            let url = daemon.relay.url.clone();
                            let host_id = host_id.to_owned();
                            let joined = match (&spare, message["spare"] == true) {
                                (Some(open), true) => Some((open.clone(), spare_done.clone())),
                                _ => None,
                            };
                            let stop = joined.as_ref().map_or_else(|| streams.clone(), |(open, _)| open.clone());
                            let done = joined.map(|(_, done)| done);
                            tokio::spawn(stream(url, host_id, message, local, stop, done));
                        } else if message["t"] == "removed"
                            && let Some(statement) = message["statement"].as_str()
                        {
                            queue_removal(&removals, statement);
                        }
                    }
                    Some(Ok(Message::Binary(frame))) => {
                        let daemon = Arc::clone(daemon);
                        let replies = replies.clone();
                        tokio::spawn(async move {
                            if let Some(reply) = hook(&daemon, &frame).await {
                                let _ = replies.send(reply.to_string()).await;
                            }
                        });
                    }
                    Some(Ok(Message::Close(_))) | None => {
                        return Err(Error::Protocol("the relay closed the connection".to_owned()));
                    }
                    Some(Ok(_)) => {}
                    Some(Err(error)) => return Err(failed(error)),
                }
            }
        }
    }
}

/// Joins a client's stream, which the relay announced with `message`, to the remote listener at
/// `local`, until either ends or `stop`. The spare stream, with `spare` to say when it's taken or
/// ended, waits for the relay's `ready`, sent when a client joins it, before it dials `local`.
async fn stream(
    url: String,
    host_id: String,
    message: Value,
    local: SocketAddr,
    stop: CancellationToken,
    spare: Option<mpsc::Sender<()>>,
) {
    let id = message["stream"].as_str().unwrap_or_default();
    let token = message["token"].as_str().unwrap_or_default();
    // Both go into a path, so only their alphabets.
    let plain = |text: &str, extra: &[u8]| {
        !text.is_empty()
            && text
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || extra.contains(&b))
    };
    if !plain(id, b"-") || !plain(token, b"-_") {
        return warn!("the relay announced a stream with a bad id or token");
    }
    let path = format!("/v1/hosts/{host_id}/streams/{id}?token={token}");
    let mut unused = spare.clone();
    let joined = async {
        let mut socket = websocket(&url, &path, &[]).await?;
        if spare.is_some() {
            loop {
                match socket.next().await {
                    Some(Ok(Message::Text(text))) if text.as_str() == "ready" => break,
                    Some(Ok(_)) => {}
                    _ => return Err(Error::Protocol("the spare stream closed".to_owned())),
                }
            }
            // Taken: the next client gets a new spare.
            if let Some(done) = unused.take() {
                let _ = done.send(()).await;
            }
        }
        let mut tcp = TcpStream::connect(local).await?;
        let _ = tcp.set_nodelay(true);
        let mut piped = pipe(socket);
        tokio::io::copy_bidirectional(&mut piped, &mut tcp).await?;
        Ok::<_, Error>(())
    };
    tokio::select! {
        () = stop.cancelled() => {}
        joined = joined => if let Err(error) = joined {
            debug!(%error, "a relay stream ended");
        }
    }
    // A spare that ended before a client took it is asked for again, after a pause so a relay
    // that keeps refusing it isn't asked in a loop.
    if let Some(done) = unused {
        if !stop.is_cancelled() {
            time::sleep(FIRST_BACKOFF).await;
        }
        let _ = done.send(()).await;
    }
}

/// plxd's answer to a webhook frame from the relay: the head's JSON length (u32, big-endian), the
/// head, then the raw body, as relay/src/host.ts sends it. `None` for a frame that isn't one.
async fn hook(daemon: &Daemon, frame: &[u8]) -> Option<Value> {
    #[derive(Deserialize)]
    struct Head {
        id: String,
        method: String,
        path: String,
        headers: HashMap<String, String>,
    }
    let (length, rest) = frame.split_first_chunk::<4>()?;
    let length = usize::try_from(u32::from_be_bytes(*length)).ok()?;
    let head: Head = serde_json::from_slice(rest.get(..length)?).ok()?;
    let body = &rest[length..];
    let delivery = uuid::Uuid::parse_str(&head.id).ok()?;
    let (status, answer) = if head.path.starts_with("/api/hooks/") {
        let headers = head
            .headers
            .into_iter()
            .map(|(name, value)| (name.to_ascii_lowercase(), value))
            .collect();
        let method = &head.method;
        crate::schedules::hook(daemon, method, &head.path, &headers, body, Some(delivery)).await
    } else {
        (404, json!({ "error": "hook_not_found" }))
    };
    Some(json!({ "t": "hook", "id": head.id, "status": status, "body": answer }))
}

/// The runs whose agent still waits on background work (a subagent, command, or Monitor) or on
/// pull requests plxd watches (PLX-777). A turn that ends while its run waits isn't done: the
/// agent usually wakes for what it waits on and carries on. If it doesn't, the run is done once
/// the wait clears and [`HOLD`] passes.
#[derive(Default)]
struct Waiting {
    background: HashSet<RunId>,
    watching: HashSet<RunId>,
}

impl Waiting {
    fn on(&self, run: RunId) -> bool {
        self.background.contains(&run) || self.watching.contains(&run)
    }
}

/// Puts `run` in `set` or takes it out.
fn mark(set: &mut HashSet<RunId>, run: RunId, on: bool) {
    if on {
        set.insert(run);
    } else {
        set.remove(&run);
    }
}

/// A push to send: the run and the state it reached.
type Push = (RunId, &'static str);

/// A run's `done` or `failed` push, waiting out [`HOLD`].
struct Hold {
    /// The status it holds at: any other cancels it.
    status: AgentStatus,
    due: Instant,
}

/// What plxd has told the relay about runs, which outlives a connection, so a hold goes on through
/// a reconnect, and a run that waits still does.
struct Pushes {
    /// The last event read: [`Pushes::read`] moves past each, so none goes twice.
    after: u64,
    waiting: Waiting,
    /// The runs whose last turn completed and that haven't gone again since.
    completed: HashSet<RunId>,
    holds: HashMap<RunId, Hold>,
}

impl Pushes {
    fn new(after: u64) -> Self {
        Self {
            after,
            waiting: Waiting::default(),
            completed: HashSet::new(),
            holds: HashMap::new(),
        }
    }

    /// The pushes to send now for the events after `after`, a run asking for approval, and the
    /// holds those events start and cancel.
    fn read(&mut self, log: &EventLog, now: Instant) -> Vec<Push> {
        let mut pushes = Vec::new();
        loop {
            let (holds, completed) = (&self.holds, &self.completed);
            let kept = |e: &Entry| {
                e.approvals
                    || match e.kind() {
                        "agent.finished" | "agent.background" | "pr.watches" => true,
                        // Frequent, and it only matters to a held or completed run.
                        "agent.updated" => e.run.is_some_and(|run| {
                            holds.contains_key(&run) || completed.contains(&run)
                        }),
                        _ => false,
                    }
            };
            match log.next_matching(self.after, kept) {
                Ok((Some(entry), seq)) => {
                    self.after = seq;
                    pushes.extend(self.apply(&entry.event(), now));
                }
                Ok((None, head)) => {
                    self.after = head;
                    return pushes;
                }
                // What a hold waited to hear may be among what's gone, so it can't say.
                Err(_) => {
                    self.after = log.head();
                    self.holds.clear();
                    self.completed.clear();
                    return pushes;
                }
            }
        }
    }

    /// Reads what happened while no socket was open. A held run follows it, and `waiting` stays
    /// right, but nothing else that happened then is pushed: it would all arrive at once, late.
    fn catch_up(&mut self, log: &EventLog, now: Instant) {
        let held: HashSet<RunId> = self.holds.keys().copied().collect();
        self.read(log, now);
        self.holds.retain(|run, _| held.contains(run));
    }

    /// Takes in `event`: the push it sends at once, if any.
    fn apply(&mut self, event: &ParallaxEvent, now: Instant) -> Option<Push> {
        match event {
            ParallaxEvent::AgentBackground { run_id, tasks } => {
                let was = self.waiting.on(*run_id);
                mark(&mut self.waiting.background, *run_id, !tasks.is_empty());
                self.wait_changed(*run_id, was, now);
            }
            ParallaxEvent::PrWatches { run_id, urls } => {
                let was = self.waiting.on(*run_id);
                mark(&mut self.waiting.watching, *run_id, !urls.is_empty());
                self.wait_changed(*run_id, was, now);
            }
            ParallaxEvent::AgentUpdated { run_id, state } => {
                if state.status != AgentStatus::Completed {
                    self.completed.remove(run_id);
                }
                if self
                    .holds
                    .get(run_id)
                    .is_some_and(|hold| hold.status != state.status)
                {
                    self.holds.remove(run_id);
                }
            }
            ParallaxEvent::AgentFinished { run_id, outcome } => {
                let done = matches!(outcome, AgentOutcome::Completed { .. });
                mark(&mut self.completed, *run_id, done);
                let status = match outcome {
                    AgentOutcome::Completed { .. } if !self.waiting.on(*run_id) => {
                        Some(AgentStatus::Completed)
                    }
                    AgentOutcome::Failed { .. } => Some(AgentStatus::Failed),
                    _ => None,
                };
                if let Some(status) = status {
                    let due = now + HOLD;
                    self.holds.insert(*run_id, Hold { status, due });
                } else {
                    self.holds.remove(run_id);
                }
            }
            // A compacted turn repeats requests that were already pushed.
            ParallaxEvent::AgentOutput {
                run_id,
                items,
                compacted: None,
                ..
            } if items
                .iter()
                .any(|item| matches!(item, AgentOutputItem::ApprovalRequested { .. })) =>
            {
                self.holds.remove(run_id);
                return Some((*run_id, "needsYou"));
            }
            _ => {}
        }
        None
    }

    /// What `run`'s waiting means now, `was` being whether it waited before this event. A run
    /// that waits isn't done, though a failure is news whatever it waits on, and its hold ends only
    /// when the run goes again, as the phone's does. A completed run's last wait clearing may bring
    /// no new turn, as when its CLI exits, so that starts a hold, which a new turn cancels.
    fn wait_changed(&mut self, run: RunId, was: bool, now: Instant) {
        if self.waiting.on(run) {
            if self
                .holds
                .get(&run)
                .is_some_and(|hold| hold.status == AgentStatus::Completed)
            {
                self.holds.remove(&run);
            }
        } else if was && self.completed.contains(&run) {
            let status = AgentStatus::Completed;
            let due = now + HOLD;
            self.holds.insert(run, Hold { status, due });
        }
    }

    /// When the next hold ends.
    fn next_due(&self) -> Option<Instant> {
        self.holds.values().map(|hold| hold.due).min()
    }

    /// The pushes whose holds ended by `now`. The caller removes each once it's sent.
    fn due(&self, now: Instant) -> Vec<Push> {
        self.holds
            .iter()
            .filter(|(_, hold)| hold.due <= now)
            .map(|(run, hold)| {
                let state = if hold.status == AgentStatus::Failed {
                    "failed"
                } else {
                    "done"
                };
                (*run, state)
            })
            .collect()
    }
}

/// What tells the relay that `run` reached `state`, with its title and text sealed for the phone,
/// or with neither when they can't be read, so the phone shows the relay's fixed text.
async fn message(daemon: &Daemon, host_id: &str, run: RunId, state: &str) -> String {
    let mut push = json!({ "t": "push", "run": run.to_string(), "state": state });
    if let Some(sealed) = sealed(daemon, host_id, run, state).await {
        push["sealed"] = sealed.into();
    } else {
        debug!(%run, "this push goes with the fixed text only");
    }
    push.to_string()
}

/// How many of a run's newest events are searched for its last reply, as the phone does.
const REPLY_EVENTS: usize = 200;
const REPLY_BYTES: usize = 1 << 20;

/// `run`'s title and the start of its last reply, sealed with this host's push key (0100).
async fn sealed(daemon: &Daemon, host_id: &str, run: RunId, state: &str) -> Option<String> {
    let title = daemon
        .reader
        .run(&CancellationToken::new(), move |db| {
            let thread = db.get_thread(run.into()).map_err(|e| store_error(&e))?;
            let row = db.get_run(run.into()).map_err(|e| store_error(&e))?;
            Ok(thread
                .and_then(|thread| thread.fields.title)
                .or_else(|| row.map(|row| seal::first_line(&row.fields.prompt))))
        })
        .await
        .ok()??;
    let log = Arc::clone(&daemon.log);
    let data_dir = daemon.data_dir.root().to_owned();
    let (key, reply) = tokio::task::spawn_blocking(move || {
        let key = remote::push_key(&data_dir).ok()?;
        let head = log.head();
        let (entries, _) = log
            .run_events_before(run, head + 1, REPLY_EVENTS, REPLY_BYTES)
            .ok()?;
        Some((
            key,
            seal::last_reply(entries.iter().map(|e| e.event().into_owned())),
        ))
    })
    .await
    .ok()??;
    let text = seal::text_for(state, reply);
    seal::seal(&key, host_id, &run.to_string(), state, &title, &text)
}

#[cfg(test)]
mod tests {
    use parallax_protocol::{AgentBackgroundKind, AgentBackgroundTask, AgentFailureKind};

    use super::*;

    /// A log, the pushes reading it, one run's events, and a clock moved by hand.
    struct Fixture {
        log: EventLog,
        pushes: Pushes,
        run: RunId,
        now: Instant,
    }

    impl Fixture {
        fn new() -> Self {
            let log = EventLog::new(100);
            let pushes = Pushes::new(log.head());
            Self {
                log,
                pushes,
                run: RunId::generate(),
                now: Instant::now(),
            }
        }

        fn log(&self, event: ParallaxEvent) {
            self.log
                .append_in_memory(jiff::Timestamp::now(), None, event);
        }

        /// Logs `event` and reads it: the states pushed at once.
        fn see(&mut self, event: ParallaxEvent) -> Vec<String> {
            self.log(event);
            let pushes = self.pushes.read(&self.log, self.now);
            pushes
                .iter()
                .map(|(_, state)| (*state).to_owned())
                .collect()
        }

        /// Moves on by `by`: the states of the holds that ended, each sent.
        fn wait(&mut self, by: Duration) -> Vec<String> {
            self.now += by;
            let due = self.pushes.due(self.now);
            for (run, _) in &due {
                self.pushes.holds.remove(run);
            }
            due.iter().map(|(_, state)| (*state).to_owned()).collect()
        }

        fn completed(&self) -> ParallaxEvent {
            ParallaxEvent::AgentFinished {
                run_id: self.run,
                outcome: AgentOutcome::Completed { result: None },
            }
        }

        fn failed(&self) -> ParallaxEvent {
            ParallaxEvent::AgentFinished {
                run_id: self.run,
                outcome: AgentOutcome::Failed {
                    failure: AgentFailureKind::SpawnFailed,
                    message: "no CLI".to_owned(),
                },
            }
        }

        fn status(&self, status: &str) -> ParallaxEvent {
            ParallaxEvent::AgentUpdated {
                run_id: self.run,
                state: serde_json::from_value(json!({
                    "status": status,
                    "accountId": "a",
                    "updatedAt": "2026-01-01T00:00:00Z",
                }))
                .unwrap(),
            }
        }

        fn background(&self, on: bool) -> ParallaxEvent {
            ParallaxEvent::AgentBackground {
                run_id: self.run,
                tasks: on
                    .then(|| AgentBackgroundTask {
                        task_id: "t1".to_owned(),
                        kind: AgentBackgroundKind::Monitor,
                        description: "Watching the build".to_owned(),
                        call_id: None,
                    })
                    .into_iter()
                    .collect(),
            }
        }

        fn watches(&self, on: bool) -> ParallaxEvent {
            ParallaxEvent::PrWatches {
                run_id: self.run,
                urls: on
                    .then(|| "https://github.com/o/r/pull/1".to_owned())
                    .into_iter()
                    .collect(),
            }
        }

        fn approval(&self) -> ParallaxEvent {
            serde_json::from_value(json!({
                "kind": "agent.output",
                "runId": self.run,
                "items": [{
                    "kind": "approvalRequested",
                    "approvalId": "01a0f1c2-3d4e-7f50-8a61-7b8c9d0e1f21",
                    "toolName": "Bash",
                    "input": {},
                    "expiresAt": "2026-01-01T00:00:00Z",
                }],
            }))
            .unwrap()
        }
    }

    const NOTHING: [String; 0] = [];
    const JUST_UNDER: Duration = HOLD.saturating_sub(Duration::from_secs(1));

    #[test]
    fn a_run_that_stays_finished_or_failed_pushes_once_when_the_hold_ends() {
        let mut f = Fixture::new();
        assert_eq!(f.see(f.completed()), NOTHING);
        // The state saved with `agent.finished` isn't the run going again.
        assert_eq!(f.see(f.status("completed")), NOTHING);
        assert_eq!(f.wait(JUST_UNDER), NOTHING);
        assert_eq!(f.wait(Duration::from_secs(1)), ["done"]);
        assert_eq!(f.wait(HOLD), NOTHING);
        assert_eq!(f.pushes.next_due(), None);

        assert_eq!(f.see(f.failed()), NOTHING);
        assert_eq!(f.pushes.next_due(), Some(f.now + HOLD));
        assert_eq!(f.wait(HOLD), ["failed"]);
    }

    #[test]
    fn a_run_going_again_within_the_hold_cancels_it() {
        let mut f = Fixture::new();
        let again = [
            f.status("running"),
            f.status("waiting"),
            f.background(true),
            f.watches(true),
        ];
        for event in again {
            assert_eq!(f.see(f.completed()), NOTHING);
            assert_eq!(f.see(event), NOTHING);
            assert_eq!(f.wait(HOLD), NOTHING);
            // Back as it was for the next.
            assert_eq!(f.see(f.background(false)), NOTHING);
            assert_eq!(f.see(f.watches(false)), NOTHING);
        }

        // Finished again later, the hold starts over.
        assert_eq!(f.see(f.completed()), NOTHING);
        assert_eq!(f.wait(JUST_UNDER), NOTHING);
        assert_eq!(f.see(f.status("running")), NOTHING);
        assert_eq!(f.see(f.completed()), NOTHING);
        assert_eq!(f.wait(JUST_UNDER), NOTHING);
        assert_eq!(f.wait(Duration::from_secs(1)), ["done"]);
    }

    #[test]
    fn an_approval_request_pushes_at_once_and_ends_the_hold() {
        let mut f = Fixture::new();
        assert_eq!(f.see(f.completed()), NOTHING);
        assert_eq!(f.see(f.approval()), ["needsYou"]);
        assert_eq!(f.wait(HOLD), NOTHING);
    }

    #[test]
    fn a_turn_that_ends_while_its_run_waits_is_not_done() {
        let mut f = Fixture::new();
        f.see(f.background(true));
        f.see(f.completed());
        assert_eq!(f.wait(HOLD), NOTHING, "a Monitor still runs");
        f.see(f.background(false));
        f.see(f.watches(true));
        f.see(f.completed());
        assert_eq!(f.wait(HOLD), NOTHING, "a pull request is still watched");
        f.see(f.watches(false));
        f.see(f.completed());
        assert_eq!(f.wait(HOLD), ["done"]);
        // A failure is news whatever the run waits on, unless the run goes again.
        f.see(f.background(true));
        f.see(f.failed());
        f.see(f.watches(true));
        assert_eq!(f.wait(HOLD), ["failed"]);
        f.see(f.failed());
        f.see(f.status("running"));
        assert_eq!(f.wait(HOLD), NOTHING);
    }

    #[test]
    fn a_reconnect_keeps_holds_and_waiting_and_sends_nothing_old() {
        let mut f = Fixture::new();
        let held = f.run;
        assert_eq!(f.see(f.completed()), NOTHING);

        // While the socket is down, a second run starts waiting, asks for approval, and finishes.
        f.run = RunId::generate();
        f.log(f.watches(true));
        f.log(f.approval());
        f.log(f.completed());
        f.pushes.catch_up(&f.log, f.now);
        assert_eq!(
            f.pushes.holds.len(),
            1,
            "what happened meanwhile isn't pushed"
        );
        assert!(f.pushes.holds.contains_key(&held));
        // Its waiting is still known, so its next turn isn't done.
        assert_eq!(f.see(f.completed()), NOTHING);
        assert_eq!(f.pushes.holds.len(), 1);

        // The first run's hold ends on the new connection, and only once.
        assert_eq!(f.wait(HOLD), ["done"]);
        f.pushes.catch_up(&f.log, f.now);
        assert_eq!(f.wait(HOLD), NOTHING);

        // A held run that goes again while the socket is down doesn't push.
        f.run = held;
        assert_eq!(f.see(f.completed()), NOTHING);
        f.log(f.status("running"));
        f.pushes.catch_up(&f.log, f.now);
        assert_eq!(f.wait(HOLD), NOTHING);
    }

    #[test]
    fn a_completed_run_whose_last_wait_clears_is_done_with_no_new_turn() {
        let mut f = Fixture::new();
        f.see(f.background(true));
        f.see(f.watches(true));
        f.see(f.completed());
        assert_eq!(f.wait(HOLD), NOTHING);
        f.see(f.background(false));
        assert_eq!(f.wait(HOLD), NOTHING, "a pull request is still watched");
        f.see(f.watches(false));
        assert_eq!(f.wait(JUST_UNDER), NOTHING);
        assert_eq!(f.wait(Duration::from_secs(1)), ["done"]);
        // Empty again, nothing cleared.
        f.see(f.watches(false));
        assert_eq!(f.wait(HOLD), NOTHING);
        // A hold cancelled by a wait starts over when that wait clears.
        f.see(f.completed());
        f.see(f.background(true));
        f.see(f.background(false));
        assert_eq!(f.wait(HOLD), ["done"]);
        // The agent woke within the hold.
        f.see(f.background(true));
        f.see(f.background(false));
        f.see(f.status("running"));
        assert_eq!(f.wait(HOLD), NOTHING);
        // A run going again isn't tracked: its next finish decides.
        f.see(f.background(true));
        f.see(f.background(false));
        assert_eq!(f.wait(HOLD), NOTHING);
    }

    /// Both ends of a socket to the relay, in memory.
    async fn socket() -> (WebSocketStream<Stream>, WebSocketStream<Stream>) {
        let (plxd, relay) = tokio::io::duplex(4096);
        let end = |io: DuplexStream, role| {
            WebSocketStream::from_raw_socket(Box::new(io) as Stream, role, None)
        };
        (
            end(plxd, tungstenite::protocol::Role::Client).await,
            end(relay, tungstenite::protocol::Role::Server).await,
        )
    }

    #[tokio::test(start_paused = true)]
    async fn a_held_push_goes_out_on_the_next_connection_when_its_hold_ends() {
        let dir = tempfile::tempdir().unwrap();
        let daemon = Daemon::for_tests(dir.path(), 10, Duration::from_secs(90));
        let stop = CancellationToken::new();
        let run = RunId::generate();
        let mut pushes = Pushes::new(daemon.log.head());
        daemon.log.append_in_memory(
            jiff::Timestamp::now(),
            None,
            ParallaxEvent::AgentFinished {
                run_id: run,
                outcome: AgentOutcome::Completed { result: None },
            },
        );
        let finished = Instant::now();
        pushes.read(&daemon.log, finished);

        // The socket drops long before the hold ends.
        let (plxd, mut relay) = socket().await;
        let (ended, ()) = tokio::join!(
            serve(&daemon, plxd, "host", &stop, &mut pushes),
            async move { assert_eq!(next_json(&mut relay).await.unwrap()["t"], "hooks") }
        );
        assert!(ended.is_err());
        assert!(finished.elapsed() < HOLD);

        let (plxd, mut relay) = socket().await;
        let (ended, ()) = tokio::join!(serve(&daemon, plxd, "host", &stop, &mut pushes), async {
            assert_eq!(next_json(&mut relay).await.unwrap()["t"], "hooks");
            let push = next_json(&mut relay).await.unwrap();
            assert_eq!(push["t"], "push");
            assert_eq!(push["run"], run.to_string());
            assert_eq!(push["state"], "done");
            assert!(finished.elapsed() >= HOLD);
            stop.cancel();
        });
        assert!(matches!(ended, Ok(Ended::Stopped)));
        assert_eq!(pushes.next_due(), None);
    }

    #[tokio::test]
    async fn a_push_carries_the_threads_title_and_reply_sealed_or_goes_without() {
        let dir = tempfile::tempdir().unwrap();
        let daemon = Daemon::for_tests(dir.path(), 10, Duration::from_secs(90));
        let host = "host";

        // A run plxd can't read goes with the fixed text.
        let unknown = RunId::generate();
        let push: Value =
            serde_json::from_str(&message(&daemon, host, unknown, "done").await).unwrap();
        assert_eq!(push["run"], unknown.to_string());
        assert_eq!(push.get("sealed"), None);

        let run = crate::agents::orchestrator::tests::plain_thread(&daemon).await;
        daemon
            .store
            .run(&CancellationToken::new(), move |db| {
                let update = parallax_store::ThreadUpdate {
                    title: Some(Some("Fix the bug".to_owned())),
                    ..Default::default()
                };
                db.update_thread(run.into(), &update)
                    .map_err(|e| store_error(&e))?;
                Ok(())
            })
            .await
            .unwrap();
        daemon
            .store
            .append(
                jiff::Timestamp::now(),
                None,
                ParallaxEvent::AgentOutput {
                    run_id: run,
                    items: vec![AgentOutputItem::Text {
                        message_id: None,
                        text: "**All** done".to_owned(),
                    }],
                    compacted: None,
                },
            )
            .await;

        let key = remote::push_key(dir.path()).ok();
        let sealed_for = async |state: &str| -> Value {
            let push: Value =
                serde_json::from_str(&message(&daemon, host, run, state).await).unwrap();
            assert_eq!(push["state"], state);
            seal::open(
                key.as_ref().unwrap(),
                &format!("{host}:{run}:{state}"),
                push["sealed"].as_str().unwrap(),
            )
            .unwrap()
        };
        assert_eq!(
            sealed_for("done").await,
            json!({ "title": "Fix the bug", "text": "All done" })
        );
        assert_eq!(
            sealed_for("needsYou").await,
            json!({ "title": "Fix the bug", "text": "Needs your approval" })
        );
    }

    /// `select!` picks among ready arms at random, so a few rounds, each with a hold's deadline
    /// and the event that cancels it ready at once. An approval logged with them still goes.
    #[tokio::test(start_paused = true)]
    async fn an_event_ready_with_a_holds_deadline_is_read_first() {
        let dir = tempfile::tempdir().unwrap();
        let daemon = Daemon::for_tests(dir.path(), 100, Duration::from_secs(90));
        let stop = CancellationToken::new();
        let append = |event| {
            daemon
                .log
                .append_in_memory(jiff::Timestamp::now(), None, event);
        };
        let (f, asking) = (Fixture::new(), Fixture::new());
        let mut pushes = Pushes::new(daemon.log.head());
        for _ in 0..16 {
            append(f.completed());
            pushes.read(&daemon.log, Instant::now());

            let (plxd, mut relay) = socket().await;
            let (running, approval) = (f.status("running"), asking.approval());
            let (ended, ()) = tokio::join!(
                serve(&daemon, plxd, "host", &stop, &mut pushes),
                async move {
                    assert_eq!(next_json(&mut relay).await.unwrap()["t"], "hooks");
                    append(running);
                    append(approval);
                    time::advance(HOLD).await;
                    let push = next_json(&mut relay).await.unwrap();
                    assert_eq!(push["state"], "needsYou");
                }
            );
            assert!(ended.is_err());
            assert_eq!(pushes.next_due(), None);
        }
    }

    #[test]
    fn the_removal_queue_refuses_what_is_too_long_and_what_it_has_no_room_for() {
        let (queue, _statements) = mpsc::channel(2);
        let too_long = "x".repeat(remote::MAX_REMOVAL_BYTES + 1);
        assert!(!queue_removal(&queue, &too_long));
        assert!(queue_removal(&queue, "one"));
        assert!(queue_removal(&queue, "two"), "the long one took no room");
        assert!(!queue_removal(&queue, "three"));
    }

    /// A compromised relay floods plxd with statements, each costing a signature check and store
    /// reads. They run one at a time, and a real one still lands once there's room.
    #[tokio::test]
    async fn a_flood_of_removals_from_the_relay_is_checked_one_at_a_time() {
        use crate::server::remote::access;
        let dir = tempfile::tempdir().unwrap();
        let daemon = Daemon::for_tests(dir.path(), 100, Duration::from_secs(90));
        let stop = CancellationToken::new();
        access::record_account(&daemon, "user").await.unwrap();
        let computer = DpopKey::generate();
        let phone = DpopKey::generate().thumbprint();
        let tablet = DpopKey::generate().thumbprint();
        let lists = parallax_protocol::AccessMergeParams {
            approved_clients: vec![phone.clone(), tablet.clone()],
            approved_hosts: vec![computer.thumbprint()],
            ..Default::default()
        };
        access::merge(&daemon, &stop, lists).await.unwrap();
        let frame =
            |statement: String| json!({ "t": "removed", "statement": statement }).to_string();
        let stranger = DpopKey::generate();
        let forged = frame(remote::signed_removal(
            &stranger,
            "user",
            std::slice::from_ref(&phone),
        ));
        let huge = frame("x".repeat(4 * remote::MAX_REMOVAL_BYTES));
        let real = frame(remote::signed_removal(
            &computer,
            "user",
            std::slice::from_ref(&tablet),
        ));
        let mut pushes = Pushes::new(daemon.log.head());
        let (plxd, mut relay) = socket().await;
        let (ended, ()) = tokio::join!(serve(&daemon, plxd, "host", &stop, &mut pushes), async {
            assert_eq!(next_json(&mut relay).await.unwrap()["t"], "hooks");
            let metrics = tokio::runtime::Handle::current().metrics();
            let mut most = 0;
            for sent in 0..2000 {
                let flood = if sent % 100 == 0 { &huge } else { &forged };
                relay.send(Message::text(flood.as_str())).await.unwrap();
                most = most.max(metrics.num_alive_tasks());
            }
            assert!(most <= 2, "{most} tasks were alive at once");
            let removed = |state: &parallax_protocol::AccessState, key: &str| {
                state.removed_clients.iter().any(|k| k == key)
            };
            let deadline = Instant::now() + Duration::from_secs(20);
            loop {
                relay.send(Message::text(real.as_str())).await.unwrap();
                let state = access::state(&daemon, None, &stop).await.unwrap();
                if removed(&state, &tablet) {
                    assert!(!removed(&state, &phone), "the flood changed nothing");
                    break;
                }
                assert!(Instant::now() < deadline, "the real one never landed");
                time::sleep(Duration::from_millis(10)).await;
            }
            drop(relay);
        });
        assert!(ended.is_err());
    }

    /// A relay from before 0091, on loopback: `/connect` without a ticket is 401, `POST
    /// /tickets` with the token answers `t1`, and `/connect?ticket=t1` says `ready` and echoes.
    /// Each request's first line goes to `seen`. Like a real server, it reads a request whole
    /// before answering and closes only after the client does: closing with unread bytes resets
    /// the connection, and on Windows the client then loses the answer.
    async fn ticket_only_relay(seen: Arc<Mutex<Vec<String>>>) -> String {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        tokio::spawn(async move {
            loop {
                let (tcp, _) = listener.accept().await.unwrap();
                tokio::spawn(answer_like_a_ticket_relay(tcp, Arc::clone(&seen)));
            }
        });
        url
    }

    /// One request to [`ticket_only_relay`]. The client's requests here have no body.
    async fn answer_like_a_ticket_relay(mut tcp: TcpStream, seen: Arc<Mutex<Vec<String>>>) {
        // Peeked, not read, so a WebSocket handshake can still read it.
        let mut buffer = vec![0; 8192];
        let head = loop {
            let peeked = tcp.peek(&mut buffer).await.unwrap();
            let text = String::from_utf8_lossy(&buffer[..peeked]);
            if let Some(end) = text.find("\r\n\r\n") {
                break text[..end + 4].to_owned();
            }
            assert!(peeked > 0, "the client closed mid-request");
            time::sleep(Duration::from_millis(1)).await;
        };
        let line = head.lines().next().unwrap_or_default().to_owned();
        seen.lock().unwrap().push(line.clone());
        if line.starts_with("GET /v1/hosts/h/connect?ticket=t1 ") {
            let mut socket = tokio_tungstenite::accept_async(tcp).await.unwrap();
            socket.send(Message::text("ready")).await.unwrap();
            while let Some(Ok(frame)) = socket.next().await {
                if frame.is_binary() {
                    socket.send(frame).await.unwrap();
                }
            }
            return;
        }
        tcp.read_exact(&mut vec![0; head.len()]).await.unwrap();
        let (status, body) = if !line.starts_with("POST /v1/hosts/h/tickets ") {
            ("401 Unauthorized", "")
        } else if head.contains("Authorization: Bearer tok\r\n") {
            ("200 OK", r#"{"ticket":"t1"}"#)
        } else {
            ("401 Unauthorized", r#"{"error":"unauthorized"}"#)
        };
        let answer = format!(
            "HTTP/1.1 {status}\r\nContent-Length: {}\r\n\r\n{body}",
            body.len()
        );
        tcp.write_all(answer.as_bytes()).await.unwrap();
        let _ = tcp.shutdown().await;
        // Until the client closes its side.
        let _ = tcp.read_to_end(&mut Vec::new()).await;
    }

    #[tokio::test]
    async fn a_relay_that_only_knows_tickets_gets_one_after_refusing_the_header() {
        let seen = Arc::new(Mutex::new(Vec::new()));
        let url = ticket_only_relay(Arc::clone(&seen)).await;
        let mut stream = stream_at(&url, "tok", "h").await.unwrap();
        stream.write_all(b"ping").await.unwrap();
        let mut echoed = [0; 4];
        stream.read_exact(&mut echoed).await.unwrap();
        assert_eq!(&echoed, b"ping");
        assert_eq!(
            *seen.lock().unwrap(),
            [
                "GET /v1/hosts/h/connect HTTP/1.1",
                "POST /v1/hosts/h/tickets HTTP/1.1",
                "GET /v1/hosts/h/connect?ticket=t1 HTTP/1.1",
            ]
        );
    }

    #[test]
    fn urls_are_https_or_plain_http_to_this_computer() {
        let base = Base::parse("https://relay.parallax.codes").unwrap();
        assert_eq!(
            (base.tls, base.authority(), base.port),
            (true, "relay.parallax.codes".to_owned(), 443)
        );
        let local = Base::parse("http://127.0.0.1:8787").unwrap();
        assert_eq!(
            (local.tls, local.authority()),
            (false, "127.0.0.1:8787".to_owned())
        );
        assert!(Base::parse("http://relay.parallax.codes").is_err());
        assert!(Base::parse("ftp://relay.parallax.codes").is_err());
    }
}
