//! Parallax Relay's plxd side (PLX-652, decision 0068).
//!
//! While the host's `relay` and `remote` settings are both on, plxd keeps one WebSocket open to
//! the relay ([`run`]), opened with the time signed by its host key. Then:
//!
//! - For each client the relay announces, plxd opens a WebSocket for that client's stream and
//!   joins it to a loopback connection to its own remote listener. The client's TLS ends in plxd,
//!   at the certificate it pinned while pairing (0065), so the relay carries only ciphertext.
//! - It answers the webhooks the relay forwards, held ones included, with the same check as
//!   `/api/hooks` ([`crate::schedules::hook`]), keyed by the relay's delivery id so a redelivery
//!   fires once.
//! - It tells the relay when a run needs the user, finishes, or fails, for push, with no content.
//!
//! It reconnects with jittered exponential backoff and polls nothing. Idle, it sends one ping a
//! minute, which the relay answers without waking, to keep Cloudflare's idle timer from closing
//! the socket.
//!
//! A client reaches a host over a `relay:<hostId>` route: [`open_stream`] is the byte stream its
//! TLS runs over, signed in with the Clerk session [`sign_in`] keeps.

use std::collections::HashMap;
use std::io;
use std::net::{IpAddr, Ipv4Addr, SocketAddr};
use std::sync::atomic::{AtomicI64, Ordering};
use std::sync::{Arc, Mutex, OnceLock, PoisonError};
use std::time::Duration;

use futures_util::{SinkExt as _, StreamExt as _};
use parallax_protocol::{AgentOutcome, AgentOutputItem, ParallaxEvent, RelayHost, RelayStatus};
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

use crate::event_log::{Entry, EventLog};
use crate::remote::{self, DpopKey, Error};
use crate::server::Daemon;

/// Where the relay is unless `PLXD_RELAY_URL` says otherwise.
pub const DEFAULT_URL: &str = "https://relay.parallx.dev";

/// The most plxd corrects its clock by from the relay's: a day, in milliseconds.
const MAX_CLOCK_OFFSET_MS: i64 = 24 * 60 * 60 * 1000;

/// How often plxd pings the relay. Cloudflare closes a WebSocket idle for 100 s.
const PING: Duration = Duration::from_mins(1);

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
            None => (authority, if tls { 443 } else { 80 }),
        };
        let local = host == "localhost" || host.parse::<IpAddr>().is_ok_and(|ip| ip.is_loopback());
        if !tls && !local {
            return Err(bad("plain HTTP reaches only this computer"));
        }
        Ok(Self {
            tls,
            host: host.to_owned(),
            port,
        })
    }

    fn authority(&self) -> String {
        if self.port == if self.tls { 443 } else { 80 } {
            self.host.clone()
        } else {
            format!("{}:{}", self.host, self.port)
        }
    }

    /// A connection to the relay: TLS checked against the Mozilla roots, or plain to loopback.
    async fn connect(&self) -> io::Result<Stream> {
        let tcp = TcpStream::connect((self.host.as_str(), self.port)).await?;
        let _ = tcp.set_nodelay(true);
        if !self.tls {
            return Ok(Box::new(tcp));
        }
        let roots = rustls::RootCertStore {
            roots: webpki_roots::TLS_SERVER_ROOTS.to_vec(),
        };
        let config = rustls::ClientConfig::builder_with_provider(remote::provider())
            .with_safe_default_protocol_versions()
            .map_err(io::Error::other)?
            .with_root_certificates(roots)
            .with_no_client_auth();
        let name = ServerName::try_from(self.host.clone()).map_err(io::Error::other)?;
        let tls = tokio_rustls::TlsConnector::from(Arc::new(config))
            .connect(name, tcp)
            .await?;
        Ok(Box::new(tls))
    }
}

/// One JSON request to the relay, signed in with `token`: its status and JSON body.
async fn http(
    url: &str,
    method: &str,
    path: &str,
    token: &str,
    body: Option<&Value>,
) -> Result<(u16, Value), Error> {
    let base = Base::parse(url)?;
    let mut stream = base.connect().await?;
    let body = body.map(ToString::to_string).unwrap_or_default();
    let head = format!(
        "{method} {path} HTTP/1.1\r\nHost: {}\r\nAuthorization: Bearer {token}\r\n\
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

/// The status and JSON body of `answer`, once it's whole, or at the end of the connection.
fn parse_response(answer: &[u8], ended: bool) -> Option<Result<(u16, Value), Error>> {
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
    Some(Ok((
        status,
        serde_json::from_slice(&body).unwrap_or(Value::Null),
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

/// A WebSocket to the relay's `path`, with `proof` in [`PROOF_HEADER`] when given. A 404 is
/// [`Error::Refused`]: no such host, or stream.
async fn websocket(
    url: &str,
    path: &str,
    proof: Option<&str>,
) -> Result<WebSocketStream<Stream>, Error> {
    use tokio_tungstenite::tungstenite::client::IntoClientRequest as _;
    let base = Base::parse(url)?;
    let stream = base.connect().await?;
    let scheme = if base.tls { "wss" } else { "ws" };
    let address = format!("{scheme}://{}{path}", base.authority());
    let mut request = address
        .into_client_request()
        .map_err(|e| Error::Protocol(e.to_string()))?;
    if let Some(proof) = proof {
        let value = proof
            .parse()
            .map_err(|_| Error::Protocol("a bad proof".to_owned()))?;
        request.headers_mut().insert(PROOF_HEADER, value);
    }
    let config = Some(remote::websocket_config());
    let (socket, _) = tokio_tungstenite::client_async_with_config(request, stream, config)
        .await
        .map_err(|error| match error {
            tungstenite::Error::Http(response) if response.status() == 404 => Error::Refused,
            tungstenite::Error::Http(response) if response.status() == 401 => {
                match relay_clock(&response) {
                    Some(relay_ms) => Error::Clock(relay_ms),
                    None => Error::Protocol("the relay refused this host's proof".to_owned()),
                }
            }
            other => Error::Protocol(format!("the relay's WebSocket failed: {other}")),
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

/// A byte stream to the host with relay id `host_id`, through the relay [`sign_in`] named. The
/// relay can't read it: the caller runs TLS to the host's pinned certificate over it.
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
    let path = format!("/v1/hosts/{host_id}/tickets");
    let (status, body) = http(url, "POST", &path, token, None).await?;
    let Some(ticket) = body["ticket"].as_str().filter(|_| status == 200) else {
        return Err(Error::Protocol(format!(
            "the relay answered {status}: {}",
            body["error"].as_str().unwrap_or("no ticket")
        )));
    };
    let path = format!("/v1/hosts/{host_id}/connect?ticket={ticket}");
    let mut socket = match websocket(url, &path, None).await {
        Err(Error::Refused) => {
            return Err(Error::Protocol("the relay refused the ticket".to_owned()));
        }
        other => other?,
    };
    // The relay says so once the host joined the stream.
    match socket.next().await {
        Some(Ok(Message::Text(text))) if text.as_str() == "ready" => Ok(pipe(socket)),
        _ => Err(Error::Protocol(
            "the host didn't join the relay's stream".to_owned(),
        )),
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
}

/// Whether plxd should be connected: `relay` and `remote` both on.
pub(crate) async fn wanted(daemon: &Daemon) -> bool {
    daemon
        .reader
        .run(&CancellationToken::new(), |db| {
            Ok(db.relay().unwrap_or(false) && db.remote().unwrap_or(false))
        })
        .await
        .unwrap_or(false)
}

/// The host key as the relay knows it.
async fn signer(daemon: &Daemon) -> Result<DpopKey, Error> {
    let key = crate::server::remote::host_key(daemon).await?;
    key.signer()
        .ok_or_else(|| Error::Protocol("the host key isn't P-256".to_owned()))
}

/// `relay/register`: registers this host's key with the relay under the user of the Clerk
/// session `token`, signed with that key, and reconnects. Answers why it couldn't.
pub(crate) async fn register(daemon: &Daemon, token: &str) -> Result<(), String> {
    let key = signer(daemon).await.map_err(|e| e.to_string())?;
    let host_id = key.thumbprint();
    let (x, y) = key.coordinates();
    let token_hash = remote::base64url(&remote::sha256(token.as_bytes()));
    let signature = key.sign(register_message(&host_id, &token_hash).as_bytes());
    let body = json!({
        "hostId": host_id,
        "jwk": { "kty": "EC", "crv": "P-256", "x": x, "y": y },
        "name": crate::server::remote::host_name(daemon).await,
        "signature": remote::base64url(&signature),
    });
    let relay = &daemon.relay;
    let answered = http(&relay.url, "POST", "/v1/hosts", token, Some(&body)).await;
    match answered {
        Ok((200, _)) => {
            info!(%host_id, "registered with the relay");
            relay.changed.notify_one();
            Ok(())
        }
        Ok((401, _)) => Err("The relay didn't accept this sign-in.".to_owned()),
        Ok((status, body)) => Err(format!(
            "The relay answered {status}: {}",
            body["error"].as_str().unwrap_or("no reason")
        )),
        Err(error) => Err(format!("Parallax couldn't reach the relay: {error}")),
    }
}

/// `relay/hosts`: the hosts the user of the Clerk session `token` has on the relay, this one
/// marked. Answers why not, for people.
pub(crate) async fn hosts(daemon: &Daemon, token: &str) -> Result<Vec<RelayHost>, String> {
    let own = signer(daemon).await.ok().map(|key| key.thumbprint());
    let answered = http(&daemon.relay.url, "GET", "/v1/hosts", token, None).await;
    let body = match answered {
        Ok((200, body)) => body,
        Ok((401, _)) => return Err("The relay didn't accept this sign-in.".to_owned()),
        Ok((status, _)) => return Err(format!("The relay answered {status}.")),
        Err(error) => return Err(format!("Parallax couldn't reach the relay: {error}")),
    };
    let listed = body["hosts"].as_array().cloned().unwrap_or_default();
    Ok(listed
        .iter()
        .filter_map(|host| {
            let host_id = host["hostId"].as_str()?.to_owned();
            Some(RelayHost {
                this_computer: own.as_deref() == Some(host_id.as_str()),
                name: host["name"].as_str().unwrap_or_default().to_owned(),
                online: host["online"].as_bool().unwrap_or(false),
                host_id,
            })
        })
        .collect())
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
    match http(&daemon.relay.url, "DELETE", &path, token, None).await {
        Ok((200 | 404, _)) => {
            info!(%host_id, "removed a host from the relay");
            Ok(())
        }
        Ok((401, _)) => Err("The relay didn't accept this sign-in.".to_owned()),
        Ok((status, _)) => Err(format!("The relay answered {status}.")),
        Err(error) => Err(format!("Parallax couldn't reach the relay: {error}")),
    }
}

/// How a connection to the relay ended, other than failing.
enum Ended {
    /// plxd is shutting down.
    Stopped,
    /// `relay` or `remote` turned off.
    Off,
}

/// Keeps plxd connected to the relay while `relay` and `remote` are on, until `stop`.
pub(crate) async fn run(daemon: Arc<Daemon>, stop: CancellationToken) {
    let relay = &daemon.relay;
    let mut failures = 0_u32;
    loop {
        if !wanted(&daemon).await {
            relay.set(Status::default());
            tokio::select! {
                () = stop.cancelled() => return,
                () = relay.changed.notified() => continue,
            }
        }
        let started = Instant::now();
        let ended = connected(&daemon, &stop).await;
        let wait = match ended {
            Ok(Ended::Stopped) => return,
            Ok(Ended::Off) => continue,
            // Waits for `relay/register`.
            Err(Error::Refused) => {
                let problem = "This computer isn't registered with the relay yet. Sign in to Parallax to register it.";
                relay.set(Status {
                    connected: None,
                    problem: Some(problem.to_owned()),
                });
                None
            }
            Err(error) => {
                warn!(%error, "lost the relay connection");
                if started.elapsed() >= STEADY {
                    failures = 0;
                }
                failures += 1;
                relay.set(Status {
                    connected: None,
                    problem: Some(format!("Parallax couldn't reach the relay: {error}")),
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
async fn connected(daemon: &Arc<Daemon>, stop: &CancellationToken) -> Result<Ended, Error> {
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
            let mut socket = websocket(url, &path, Some(&proof)).await?;
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
    let ended = serve(daemon, socket, &host_id, stop).await;
    daemon.relay.set(Status::default());
    ended
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
async fn serve(
    daemon: &Arc<Daemon>,
    socket: WebSocketStream<Stream>,
    host_id: &str,
    stop: &CancellationToken,
) -> Result<Ended, Error> {
    let (mut sink, mut frames) = socket.split();
    let send = |text: String| Message::text(text);
    let (replies, mut answered) = mpsc::channel::<String>(16);
    // The streams close with this connection.
    let streams = stop.child_token();
    let _streams = streams.clone().drop_guard();
    let remote = &daemon.remote;
    let local = SocketAddr::new(
        remote.address.unwrap_or(IpAddr::V4(Ipv4Addr::LOCALHOST)),
        remote.port,
    );
    let mut events = daemon.log.watch();
    let mut after = daemon.log.head();
    let mut ping = time::interval_at(Instant::now() + PING, PING);
    let mut heard = true;
    let failed = |error: tungstenite::Error| Error::Protocol(error.to_string());
    // The webhook URLs this plxd serves, so the relay refuses the rest for free.
    let hooks = || async {
        let keys = crate::schedules::hook_keys(daemon).await;
        send(json!({ "t": "hooks", "keys": keys }).to_string())
    };
    sink.send(hooks().await).await.map_err(failed)?;
    loop {
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
            _ = ping.tick() => {
                if !heard {
                    return Err(Error::Protocol("the relay stopped answering".to_owned()));
                }
                heard = false;
                sink.send(send("ping".to_owned())).await.map_err(failed)?;
            }
            Some(reply) = answered.recv() => sink.send(send(reply)).await.map_err(failed)?,
            () = daemon.relay.hooks_changed.notified() => {
                sink.send(hooks().await).await.map_err(failed)?;
            }
            Ok(()) = events.changed() => {
                for push in pushes(&daemon.log, &mut after) {
                    sink.send(send(push)).await.map_err(failed)?;
                }
            }
            frame = frames.next() => {
                heard = true;
                match frame {
                    Some(Ok(Message::Text(text))) => {
                        let message: Value = serde_json::from_str(&text).unwrap_or(Value::Null);
                        if message["t"] == "open" {
                            let url = daemon.relay.url.clone();
                            let host_id = host_id.to_owned();
                            tokio::spawn(stream(url, host_id, message, local, streams.clone()));
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
/// `local`, until either ends or `stop`.
async fn stream(
    url: String,
    host_id: String,
    message: Value,
    local: SocketAddr,
    stop: CancellationToken,
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
    let joined = async {
        let socket = websocket(&url, &path, None).await?;
        let mut tcp = TcpStream::connect(local).await?;
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

/// The pushes for the events after `after`, which moves past them: a run that asks for approval,
/// finishes, or fails. Each names only the run.
fn pushes(log: &EventLog, after: &mut u64) -> Vec<String> {
    let mut pushes = Vec::new();
    loop {
        match log.next_matching(*after, |e| e.approvals || e.kind() == "agent.finished") {
            Ok((Some(entry), seq)) => {
                *after = seq;
                pushes.extend(push(&entry));
            }
            Ok((None, head)) => {
                *after = head;
                return pushes;
            }
            Err(_) => {
                *after = log.head();
                return pushes;
            }
        }
    }
}

fn push(entry: &Entry) -> Option<String> {
    let (run, state) = match &*entry.event() {
        ParallaxEvent::AgentFinished { run_id, outcome } => match outcome {
            AgentOutcome::Completed { .. } => (*run_id, "done"),
            AgentOutcome::Failed { .. } => (*run_id, "failed"),
            _ => return None,
        },
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
            (*run_id, "needsYou")
        }
        _ => return None,
    };
    Some(json!({ "t": "push", "run": run.to_string(), "state": state }).to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn urls_are_https_or_plain_http_to_this_computer() {
        let base = Base::parse("https://relay.parallx.dev").unwrap();
        assert_eq!(
            (base.tls, base.authority(), base.port),
            (true, "relay.parallx.dev".to_owned(), 443)
        );
        let local = Base::parse("http://127.0.0.1:8787").unwrap();
        assert_eq!(
            (local.tls, local.authority()),
            (false, "127.0.0.1:8787".to_owned())
        );
        assert!(Base::parse("http://relay.parallx.dev").is_err());
        assert!(Base::parse("ftp://relay.parallx.dev").is_err());
    }

    #[tokio::test]
    async fn a_websocket_refused_for_its_time_gives_the_relays_clock() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        tokio::spawn(async move {
            let (mut tcp, _) = listener.accept().await.unwrap();
            let mut request = [0; 4096];
            let _ = tcp.read(&mut request).await.unwrap();
            let body = r#"{"error":"clock_skew","now":1791777777777}"#;
            let answer = format!(
                "HTTP/1.1 401 Unauthorized\r\nx-parallax-relay-time: 1791777777777\r\n\
                 content-type: application/json\r\n\
                 content-length: {}\r\n\r\n{body}",
                body.len()
            );
            tcp.write_all(answer.as_bytes()).await.unwrap();
        });
        let refused = websocket(&url, "/v1/hosts/x/host", Some("1.sig")).await;
        assert!(
            matches!(refused, Err(Error::Clock(1_791_777_777_777))),
            "{:?}",
            refused.err()
        );
        // Any other 401 is a refusal, not a clock.
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        tokio::spawn(async move {
            let (mut tcp, _) = listener.accept().await.unwrap();
            let _ = tcp.read(&mut [0; 4096]).await.unwrap();
            let answer = "HTTP/1.1 401 Unauthorized\r\ncontent-length: 0\r\n\r\n";
            tcp.write_all(answer.as_bytes()).await.unwrap();
        });
        let refused = websocket(&url, "/v1/hosts/x/host", Some("1.sig")).await;
        assert!(
            matches!(refused, Err(Error::Protocol(_))),
            "{:?}",
            refused.err()
        );
    }

    #[test]
    fn chunked_bodies_are_joined() {
        assert_eq!(
            dechunk(b"4\r\n{\"a\"\r\n3\r\n:1}\r\n0\r\n\r\n"),
            b"{\"a\":1}"
        );
    }

    #[test]
    fn backoff_doubles_to_five_minutes_with_jitter() {
        for (failures, full) in [(1, 1), (2, 2), (3, 4), (20, 300)] {
            let wait = backoff(failures);
            let full = Duration::from_secs(full);
            assert!(wait >= full / 2 && wait <= full, "{failures}: {wait:?}");
        }
    }
}
