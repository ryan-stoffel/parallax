//! plxd behind a proxy (PLX-1363, 0091): a thread runs through the relay under `wrangler dev` with
//! the host's connection going through a plain `CONNECT` proxy, then through a TLS-inspecting one
//! whose own CA stands in for the OS's store through `SSL_CERT_FILE`, and all that one can read
//! holds none of the thread.
//!
//! The proxy settings and roots are the process's, so the host runs in a copy of this test binary
//! ([`host_behind_a_proxy`]) and the client in this one, directly to the relay.

use std::path::Path;
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use data_encoding::BASE64;
use parallax_protocol::jsonrpc::Request;
use parallax_protocol::methods::{AgentStart, EventsSubscribe, RelayRegister, RemoteSessions};
use parallax_protocol::{EventsSubscribeParams, RelayRegisterParams, RemoteSessionsParams};
use plxd::{relay, remote};
use rcgen::{BasicConstraints, CertificateParams, IsCa, Issuer, KeyPair};
use rustls::ServerConfig;
use rustls::pki_types::{CertificateDer, PrivateKeyDer, PrivatePkcs8KeyDer};
use tokio::io::{AsyncRead, AsyncReadExt as _, AsyncWrite, AsyncWriteExt as _};
use tokio::net::{TcpListener, TcpStream, UnixStream};
use tokio::time::{Instant, sleep};
use tokio_rustls::TlsAcceptor;

use crate::agents::{Conn, create, end_turn, fake, init, orchestrator_params, start_params, text};
use crate::connect::free_port;
use crate::remote::{App, LOOPBACK, new_code, open, set_remote, wait_listening};
use crate::support::{Client, InProcess, PATIENCE, socket_path, temp_dir};

use super::{relay_status, set_relay};

/// What the thread says each way, which nothing outside its pinned TLS may read.
const PROMPT: &str = "the-prompt-only-the-host-reads";
const REPLY: &str = "the-reply-only-the-client-reads";

/// The relay's and Clerk's names here, which only the proxies know how to reach.
const RELAY_HOST: &str = "relay.test";
const CLERK_HOST: &str = "clerk.test";

/// The plain proxy's credentials, percent-encoded as they are in `HTTPS_PROXY`.
const PROXY_USER: &str = "user%40corp:proxy-password";
const PROXY_PLAIN_CREDENTIALS: &[u8] = b"user@corp:proxy-password";

/// Set in the copy of this binary that runs the host, to its data folder.
const HOST_DIR: &str = "PLXD_TEST_PROXIED_HOST_DIR";

/// The host's half: serves until it's killed, and does nothing in an ordinary test run.
#[tokio::test]
async fn host_behind_a_proxy() {
    let Ok(dir) = std::env::var(HOST_DIR) else {
        return;
    };
    let mut config = InProcess::config(Path::new(&dir));
    config.remote_address = Some(LOOPBACK);
    config.backends = Some(fake(vec![init("proxied"), text(REPLY), end_turn(REPLY)]));
    let _server = InProcess::start(config);
    std::future::pending::<()>().await;
}

/// A copy of this binary running [`host_behind_a_proxy`], and a client on its socket.
struct Host {
    child: Child,
    client: Client,
    remote_port: u16,
    dir: tempfile::TempDir,
}

impl Drop for Host {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

impl Host {
    async fn start(proxy: &str, ca: Option<&Path>) -> Self {
        let dir = temp_dir();
        let remote_port = free_port();
        let mut command = Command::new(std::env::current_exe().unwrap());
        command
            .args([
                "relay::proxied::host_behind_a_proxy",
                "--exact",
                "--nocapture",
            ])
            .env(HOST_DIR, dir.path())
            .env("HTTPS_PROXY", proxy)
            .env("PLXD_RELAY_URL", format!("https://{RELAY_HOST}"))
            .env("PLXD_CLERK_ISSUER", format!("https://{CLERK_HOST}"))
            .env("PLXD_REMOTE_PORT", remote_port.to_string())
            .env_remove("https_proxy")
            .env_remove("NO_PROXY")
            .env_remove("no_proxy")
            .env_remove("SSL_CERT_DIR")
            .env_remove("SSL_CERT_FILE")
            .stdout(Stdio::null());
        if let Some(ca) = ca {
            command.env("SSL_CERT_FILE", ca);
        }
        let child = command.spawn().unwrap();
        let socket = socket_path(dir.path());
        let deadline = Instant::now() + PATIENCE;
        while UnixStream::connect(&socket).await.is_err() {
            assert!(Instant::now() < deadline, "the host didn't start");
            sleep(Duration::from_millis(20)).await;
        }
        let client = Client::ready(&socket).await;
        Self {
            child,
            client,
            remote_port,
            dir,
        }
    }

    fn socket(&self) -> std::path::PathBuf {
        socket_path(self.dir.path())
    }
}

/// A CA that signs a certificate for whatever host it's asked, as an inspecting proxy does.
struct Authority {
    issuer: Issuer<'static, KeyPair>,
    der: CertificateDer<'static>,
}

impl Authority {
    fn new() -> Self {
        let key = KeyPair::generate().unwrap();
        let mut params = CertificateParams::new(Vec::new()).unwrap();
        params.is_ca = IsCa::Ca(BasicConstraints::Unconstrained);
        let der = params.self_signed(&key).unwrap().der().clone();
        Self {
            issuer: Issuer::new(params, key),
            der,
        }
    }

    fn pem(&self) -> String {
        let body = BASE64.encode(&self.der);
        let lines: Vec<&str> = body
            .as_bytes()
            .chunks(64)
            .map(|line| std::str::from_utf8(line).unwrap())
            .collect();
        format!(
            "-----BEGIN CERTIFICATE-----\n{}\n-----END CERTIFICATE-----\n",
            lines.join("\n")
        )
    }

    fn forge(&self, host: &str) -> TlsAcceptor {
        let key = KeyPair::generate().unwrap();
        let params = CertificateParams::new(vec![host.to_owned()]).unwrap();
        let leaf = params.signed_by(&key, &self.issuer).unwrap();
        let config =
            ServerConfig::builder_with_provider(Arc::new(rustls::crypto::ring::default_provider()))
                .with_safe_default_protocol_versions()
                .unwrap()
                .with_no_client_auth()
                .with_single_cert(
                    vec![leaf.der().clone()],
                    PrivateKeyDer::Pkcs8(PrivatePkcs8KeyDer::from(key.serialize_der())),
                )
                .unwrap();
        TlsAcceptor::from(Arc::new(config))
    }
}

/// What one connection carried: from the client, and to it.
type Carried = Arc<Mutex<[Vec<u8>; 2]>>;

/// What a proxy saw.
#[derive(Default)]
struct Seen {
    /// Each `CONNECT`'s target.
    asked: Mutex<Vec<String>>,
    /// The targets whose client refused an inspecting proxy's certificate.
    refused: Mutex<Vec<String>>,
    /// What each connection carried.
    carried: Mutex<Vec<Carried>>,
}

impl Seen {
    /// Each direction of each connection, with its WebSocket frames unmasked.
    fn readable(&self) -> Vec<u8> {
        let mut all = Vec::new();
        for connection in self.carried.lock().unwrap().iter() {
            for direction in connection.lock().unwrap().iter() {
                all.extend(unmasked(direction));
                all.push(b'\n');
            }
        }
        all
    }

    fn holds(&self, text: &str) -> bool {
        let all = self.readable();
        all.windows(text.len()).any(|at| at == text.as_bytes())
    }
}

/// `bytes`, from a connection that may have turned into a WebSocket, with every frame's payload
/// unmasked. A client XORs its frames with a key sent beside them, so a plain search of what it
/// sent would find nothing whether or not it was plaintext.
fn unmasked(bytes: &[u8]) -> Vec<u8> {
    let Some(end) = bytes.windows(4).position(|at| at == b"\r\n\r\n") else {
        return bytes.to_vec();
    };
    let (head, mut rest) = bytes.split_at(end + 4);
    let mut out = head.to_vec();
    let head = String::from_utf8_lossy(head).to_ascii_lowercase();
    if !head.contains("upgrade: websocket") {
        out.extend_from_slice(rest);
        return out;
    }
    while rest.len() >= 2 {
        let masked = rest[1] & 0x80 != 0;
        let (length, at) = match rest[1] & 0x7f {
            126 if rest.len() >= 4 => (usize::from(u16::from_be_bytes([rest[2], rest[3]])), 4),
            127 if rest.len() >= 10 => {
                let bytes: [u8; 8] = rest[2..10].try_into().unwrap();
                (usize::try_from(u64::from_be_bytes(bytes)).unwrap(), 10)
            }
            126 | 127 => break,
            short => (usize::from(short), 2),
        };
        let mask = if masked { 4 } else { 0 };
        if rest.len() < at + mask + length {
            break;
        }
        let payload = &rest[at + mask..at + mask + length];
        if masked {
            let key = &rest[at..at + 4];
            out.extend(payload.iter().zip(key.iter().cycle()).map(|(b, k)| b ^ k));
        } else {
            out.extend_from_slice(payload);
        }
        rest = &rest[at + mask + length..];
    }
    out
}

/// Copies both ways between `client` and `server`, keeping what passes.
async fn carry(
    mut client: impl AsyncRead + AsyncWrite + Unpin,
    mut server: impl AsyncRead + AsyncWrite + Unpin,
    seen: &Seen,
) {
    let kept = Arc::new(Mutex::new([Vec::new(), Vec::new()]));
    seen.carried.lock().unwrap().push(kept.clone());
    let (mut from_client, mut from_server) = (vec![0; 64 * 1024], vec![0; 64 * 1024]);
    loop {
        tokio::select! {
            read = client.read(&mut from_client) => {
                let read = read.unwrap_or(0);
                if read == 0 || server.write_all(&from_client[..read]).await.is_err() {
                    return;
                }
                let _ = server.flush().await;
                kept.lock().unwrap()[0].extend_from_slice(&from_client[..read]);
            }
            read = server.read(&mut from_server) => {
                let read = read.unwrap_or(0);
                if read == 0 || client.write_all(&from_server[..read]).await.is_err() {
                    return;
                }
                let _ = client.flush().await;
                kept.lock().unwrap()[1].extend_from_slice(&from_server[..read]);
            }
        }
    }
}

/// Reads a `CONNECT`, answering 407 without `credentials` when it needs them. Its target.
async fn asked(tcp: &mut TcpStream, credentials: Option<&str>) -> Option<String> {
    let mut head = Vec::new();
    while !head.ends_with(b"\r\n\r\n") {
        head.push(tcp.read_u8().await.ok()?);
    }
    let head = String::from_utf8(head).ok()?;
    let target = head.split(' ').nth(1)?.to_owned();
    if let Some(credentials) = credentials
        && !head.contains(&format!("Proxy-Authorization: Basic {credentials}\r\n"))
    {
        let _ = tcp.write_all(b"HTTP/1.1 407 Nope\r\n\r\n").await;
        return None;
    }
    tcp.write_all(b"HTTP/1.1 200 OK\r\n\r\n").await.ok()?;
    Some(target)
}

/// A proxy that ends TLS itself with a certificate its CA signs for the target, reads what's
/// inside, and passes it on to the relay at `relay`. Its port and what it saw.
async fn inspecting_proxy(authority: Arc<Authority>, relay: String) -> (u16, Arc<Seen>) {
    let listener = TcpListener::bind((LOOPBACK, 0)).await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let seen = Arc::new(Seen::default());
    let kept = seen.clone();
    tokio::spawn(async move {
        loop {
            let (mut tcp, _) = listener.accept().await.unwrap();
            let (authority, relay, seen) = (authority.clone(), relay.clone(), kept.clone());
            tokio::spawn(async move {
                let Some(target) = asked(&mut tcp, None).await else {
                    return;
                };
                seen.asked.lock().unwrap().push(target.clone());
                let host = target.split(':').next().unwrap_or_default();
                let Ok(tls) = authority.forge(host).accept(tcp).await else {
                    seen.refused.lock().unwrap().push(target);
                    return;
                };
                let upstream = TcpStream::connect(&relay).await.unwrap();
                carry(tls, upstream, &seen).await;
            });
        }
    });
    (port, seen)
}

/// A proxy that only tunnels, and only with its credentials, to a TLS front for the relay at
/// `relay`, as the relay's own certificate would be. Its port and what it saw.
async fn plain_proxy(authority: Arc<Authority>, relay: String) -> (u16, Arc<Seen>) {
    let front = TcpListener::bind((LOOPBACK, 0)).await.unwrap();
    let front_port = front.local_addr().unwrap().port();
    let unseen = Arc::new(Seen::default());
    tokio::spawn(async move {
        loop {
            let (tcp, _) = front.accept().await.unwrap();
            let (acceptor, relay) = (authority.forge(RELAY_HOST), relay.clone());
            let unseen = unseen.clone();
            tokio::spawn(async move {
                if let Ok(tls) = acceptor.accept(tcp).await {
                    let upstream = TcpStream::connect(&relay).await.unwrap();
                    carry(tls, upstream, &unseen).await;
                }
            });
        }
    });
    let listener = TcpListener::bind((LOOPBACK, 0)).await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let seen = Arc::new(Seen::default());
    let kept = seen.clone();
    let credentials = BASE64.encode(PROXY_PLAIN_CREDENTIALS);
    tokio::spawn(async move {
        loop {
            let (mut tcp, _) = listener.accept().await.unwrap();
            let (seen, credentials) = (kept.clone(), credentials.clone());
            tokio::spawn(async move {
                let Some(target) = asked(&mut tcp, Some(&credentials)).await else {
                    return;
                };
                seen.asked.lock().unwrap().push(target);
                let upstream = TcpStream::connect((LOOPBACK, front_port)).await.unwrap();
                carry(tcp, upstream, &seen).await;
            });
        }
    });
    (port, seen)
}

/// The relay's address and a Clerk token, under `relay/scripts/e2e.mjs`.
fn relay_under_test() -> Option<(String, String)> {
    Some((
        std::env::var("PLXD_TEST_RELAY_URL").ok()?,
        std::env::var("PLXD_TEST_RELAY_TOKEN").ok()?,
    ))
}

/// Registers `host` with the relay through its proxy and connects it. Its `relay:` route.
async fn connected(host: &mut Host, token: &str) -> String {
    set_remote(&mut host.client, true).await;
    wait_listening(host.remote_port, true).await;
    set_relay(&mut host.client, true).await;
    let registered = host
        .client
        .call::<RelayRegister>(RelayRegisterParams {
            token: token.to_owned(),
            signed: None,
        })
        .await;
    assert!(registered.is_ok(), "{registered:?}");
    let status = relay_status(&mut host.client, |status| status.connected).await;
    let id = status.hook_url.unwrap();
    format!("relay:{}", id.rsplit('/').next().unwrap())
}

/// Pairs a client through the relay at `url`, directly, runs a thread on `host`, and reads its
/// reply. It reaches the client through the proxy host's connection.
async fn run_a_thread(host: &mut Host, route: &str, url: &str, token: &str) {
    relay::sign_in(url.to_owned(), token.to_owned());
    let code = new_code(&mut host.client).await;
    let phone = temp_dir();
    let paired = remote::pair(&[route.to_owned()], &code, "phone", phone.path())
        .await
        .unwrap();
    let mut app: App = open(&[route.to_owned()], &paired.fingerprint, phone.path())
        .await
        .unwrap();
    assert!(app.initialize().await["result"].is_object());

    let mut conn = Conn::ready(&host.socket()).await;
    let project = create(&mut conn, orchestrator_params(host.dir.path())).await;
    let subscribe = Request::new::<EventsSubscribe>(
        2,
        EventsSubscribeParams {
            after: 0,
            project: Some(project.id),
            run: None,
            shell: false,
        },
    );
    app.send(&serde_json::to_string(&subscribe).unwrap()).await;
    let start = Request::new::<AgentStart>(3, start_params(project.id, PROMPT));
    app.send(&serde_json::to_string(&start).unwrap()).await;
    while !app.next().await.contains(REPLY) {}
}

#[tokio::test]
async fn a_plain_proxy_with_credentials_carries_the_relay_and_reads_nothing() {
    let Some((url, token)) = relay_under_test() else {
        return;
    };
    let authority = Arc::new(Authority::new());
    let relay_address = url.trim_start_matches("http://").to_owned();
    let (port, seen) = plain_proxy(authority.clone(), relay_address).await;
    let files = temp_dir();
    let ca = files.path().join("ca.pem");
    std::fs::write(&ca, authority.pem()).unwrap();

    let proxy = format!("http://{PROXY_USER}@127.0.0.1:{port}");
    let mut host = Host::start(&proxy, Some(&ca)).await;
    let route = connected(&mut host, &token).await;
    run_a_thread(&mut host, &route, &url, &token).await;

    let asked = seen.asked.lock().unwrap().clone();
    assert!(asked.contains(&format!("{RELAY_HOST}:443")), "{asked:?}");
    for text in ["x-parallax-host-proof", "Bearer", PROMPT, REPLY] {
        assert!(!seen.holds(text), "a tunnel showed {text}");
    }
}

#[tokio::test]
async fn an_inspecting_proxy_reads_the_outer_connection_and_no_thread() {
    let Some((url, token)) = relay_under_test() else {
        return;
    };
    let authority = Arc::new(Authority::new());
    let relay_address = url.trim_start_matches("http://").to_owned();
    let (port, seen) = inspecting_proxy(authority.clone(), relay_address).await;
    let proxy = format!("http://127.0.0.1:{port}");

    // Without its CA in the store, plxd refuses the proxy's certificate for the relay.
    let mut untrusting = Host::start(&proxy, None).await;
    let refused = untrusting
        .client
        .call::<RelayRegister>(RelayRegisterParams {
            token: token.clone(),
            signed: None,
        })
        .await;
    let refused = format!("{refused:?}");
    assert!(refused.contains("UnknownIssuer"), "{refused}");
    assert!(seen.carried.lock().unwrap().is_empty());
    drop(untrusting);

    // With it, the relay's connection works, and the proxy reads all of it.
    let files = temp_dir();
    let ca = files.path().join("ca.pem");
    std::fs::write(&ca, authority.pem()).unwrap();
    let mut host = Host::start(&proxy, Some(&ca)).await;
    let route = connected(&mut host, &token).await;
    run_a_thread(&mut host, &route, &url, &token).await;
    let sessions = host
        .client
        .call::<RemoteSessions>(RemoteSessionsParams {})
        .await
        .unwrap();
    assert!(sessions.relay.is_some_and(|relay| relay.connected));

    // The capture is real: it holds the outer HTTP, what plxd masked, and the stream's WebSocket.
    for text in [
        "x-parallax-host-proof",
        "Bearer",
        r#""t":"hooks""#,
        "/streams/",
    ] {
        assert!(seen.holds(text), "the capture lacks {text}");
    }
    // The thread isn't in it, either way.
    for text in [PROMPT, REPLY] {
        assert!(!seen.holds(text), "the proxy read {text}");
    }

    // Clerk's keys keep Mozilla's roots alone: the same store doesn't vouch for the proxy there,
    // so the sign-in fails and the proxy reads no request for them.
    let host_id = route.trim_start_matches("relay:").to_owned();
    let phone = temp_dir();
    let signed_in = remote::sign_in(
        std::slice::from_ref(&route),
        &host_id,
        &token,
        "laptop",
        false,
        phone.path(),
    )
    .await;
    assert!(signed_in.is_err(), "{signed_in:?}");
    let clerk = format!("{CLERK_HOST}:443");
    assert!(
        seen.refused.lock().unwrap().contains(&clerk),
        "plxd asked for Clerk's keys through the proxy and refused its certificate"
    );
    assert!(!seen.holds("jwks.json"));
}
