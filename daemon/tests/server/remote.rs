//! Remote access on the LAN (PLX-641, 0065): the HTTPS listener on loopback, pairing with a
//! one-time code over SPAKE2, DPoP-bound sessions, and refusing every client that didn't pair.

use std::collections::HashMap;
use std::fmt::Write as _;
use std::net::{IpAddr, Ipv4Addr};
use std::path::Path;
use std::time::Duration;

use futures_util::{SinkExt as _, StreamExt as _};
use parallax_protocol::methods::{
    HostSettingsGet, HostSettingsSet, RemotePair, RemoteRevoke, RemoteSessions,
};
use parallax_protocol::{
    HostSettingsGetParams, HostSettingsSetParams, RemotePairParams, RemoteRevokeParams,
    RemoteSessionsParams,
};
use plxd::remote;
use serde_json::Value;
use tokio::io::{AsyncBufReadExt as _, AsyncReadExt as _, AsyncWriteExt as _, BufReader, duplex};
use tokio::net::TcpStream;
use tokio::time::{Instant, sleep, timeout};
use tokio_tungstenite::tungstenite::Message;

use crate::connect::free_port;
use crate::support::{Client, InProcess, PATIENCE, temp_dir};

const LOOPBACK: IpAddr = IpAddr::V4(Ipv4Addr::LOCALHOST);

async fn set_remote(client: &mut Client, on: bool) {
    let settings = client
        .call::<HostSettingsSet>(HostSettingsSetParams {
            remote: Some(on),
            ..HostSettingsSetParams::default()
        })
        .await
        .unwrap();
    assert_eq!(settings.remote, Some(on));
}

/// Waits until something accepts at `port`, or stops accepting.
async fn wait_listening(port: u16, listening: bool) {
    let deadline = Instant::now() + PATIENCE;
    while TcpStream::connect((LOOPBACK, port)).await.is_ok() != listening {
        assert!(Instant::now() < deadline, "the listener never changed");
        sleep(Duration::from_millis(20)).await;
    }
}

/// A new pairing code, as the host shows it.
async fn new_code(client: &mut Client) -> String {
    let answer = client
        .call::<RemotePair>(RemotePairParams {})
        .await
        .unwrap();
    assert_eq!(
        answer.code.len(),
        remote::CODE_LENGTH + 1,
        "{}",
        answer.code
    );
    answer.code
}

/// A code that isn't `code`.
fn wrong(code: &str) -> String {
    let flipped = if code.ends_with('2') { '3' } else { '2' };
    format!("{}{flipped}", &code[..code.len() - 1])
}

/// An app's connection to a paired host: lines in and out, as `plxd dial` bridges them.
struct App {
    lines: tokio::io::Lines<BufReader<tokio::io::ReadHalf<tokio::io::DuplexStream>>>,
    writer: tokio::io::WriteHalf<tokio::io::DuplexStream>,
}

async fn open(routes: &[String], fingerprint: &str, data_dir: &Path) -> Result<App, remote::Error> {
    let socket = remote::dial(routes, fingerprint, data_dir).await?;
    let (app, stdio) = duplex(64 * 1024);
    let (input, output) = tokio::io::split(stdio);
    tokio::spawn(remote::bridge(socket, input, output));
    let (reader, writer) = tokio::io::split(app);
    Ok(App {
        lines: BufReader::new(reader).lines(),
        writer,
    })
}

impl App {
    async fn initialize(&mut self) -> Value {
        let request = r#"{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocol":{"min":1,"max":1},"client":{"name":"test","version":"0"},"capabilities":{}}}"#;
        self.writer
            .write_all(format!("{request}\n").as_bytes())
            .await
            .unwrap();
        let line = timeout(PATIENCE, self.lines.next_line())
            .await
            .unwrap()
            .unwrap();
        serde_json::from_str(&line.expect("an answer")).unwrap()
    }

    /// Whether the host closed the connection within `PATIENCE`.
    async fn closes(&mut self) -> bool {
        matches!(
            timeout(PATIENCE, self.lines.next_line()).await,
            Ok(Ok(None) | Err(_))
        )
    }
}

#[tokio::test]
#[expect(clippy::too_many_lines, reason = "one pairing told step by step")]
async fn a_client_pairs_with_the_code_and_every_other_is_refused() {
    let port = free_port();
    let dir = temp_dir();
    let mut config = InProcess::config(dir.path());
    config.remote_address = Some(LOOPBACK);
    config.remote_port = port;
    let server = InProcess::start(config);
    let mut client = Client::ready(&server.socket).await;
    let laptop = temp_dir();
    let other = temp_dir();

    // Off by default: nothing listens, and there's no code.
    let settings = client
        .call::<HostSettingsGet>(HostSettingsGetParams {})
        .await
        .unwrap();
    assert_eq!(settings.remote, Some(false));
    assert!(TcpStream::connect((LOOPBACK, port)).await.is_err());
    assert!(
        client
            .call::<RemotePair>(RemotePairParams {})
            .await
            .is_err()
    );
    set_remote(&mut client, true).await;
    wait_listening(port, true).await;
    client
        .call::<HostSettingsSet>(HostSettingsSetParams {
            device_name: Some("Studio".to_owned()),
            ..HostSettingsSetParams::default()
        })
        .await
        .unwrap();

    // Only HTTPS: a plain HTTP request gets no answer.
    let mut plain = TcpStream::connect((LOOPBACK, port)).await.unwrap();
    plain
        .write_all(b"GET /.well-known/parallax HTTP/1.1\r\nHost: x\r\n\r\n")
        .await
        .unwrap();
    let mut answer = Vec::new();
    let _ = timeout(PATIENCE, plain.read_to_end(&mut answer))
        .await
        .unwrap();
    assert!(
        !answer.starts_with(b"HTTP/"),
        "{}",
        String::from_utf8_lossy(&answer)
    );

    let code = new_code(&mut client).await;
    let route = format!("127.0.0.1:{port}");
    let routes = std::slice::from_ref(&route);
    let refused = remote::pair(routes, &wrong(&code), "laptop", laptop.path()).await;
    assert!(
        matches!(refused, Err(remote::Error::Refused)),
        "{refused:?}"
    );
    // A wrong code doesn't use up the right one, and lowercase still matches it.
    let paired = remote::pair(routes, &code.to_lowercase(), "laptop", laptop.path())
        .await
        .unwrap();
    assert_eq!(paired.name, "Studio");
    assert_eq!(paired.fingerprint.len(), 64);
    assert_eq!(paired.routes, [route.as_str()]);
    let again = remote::pair(routes, &code, "thief", other.path()).await;
    assert!(
        matches!(again, Err(remote::Error::Refused)),
        "a code works once: {again:?}"
    );

    // Too many wrong codes lock the code, so the right one stops working too.
    let locked = new_code(&mut client).await;
    for _ in 0..remote::MAX_WRONG_CODES {
        let guess = remote::pair(routes, &wrong(&locked), "guesser", other.path()).await;
        assert!(matches!(guess, Err(remote::Error::Refused)), "{guess:?}");
    }
    let late = remote::pair(routes, &locked, "desktop", other.path()).await;
    assert!(
        matches!(late, Err(remote::Error::Refused)),
        "locked: {late:?}"
    );

    let sessions = client
        .call::<RemoteSessions>(RemoteSessionsParams {})
        .await
        .unwrap();
    assert!(sessions.listening);
    let sessions = sessions.sessions;
    assert_eq!(sessions.len(), 1);
    assert_eq!(sessions[0].name, "laptop");

    // Routes are tried in order: the first is dead, the second answers.
    let dead = format!("127.0.0.1:{}", free_port());
    let fp = &paired.fingerprint;
    let mut app = open(&[dead, route.clone()], fp, laptop.path())
        .await
        .unwrap();
    let initialized = app.initialize().await;
    assert!(initialized["result"]["logId"].is_string(), "{initialized}");

    // No credential, or a stolen token without its DPoP key, is refused.
    let stranger = open(routes, fp, other.path()).await;
    assert!(
        matches!(stranger, Err(remote::Error::Refused)),
        "{:?}",
        stranger.err()
    );
    let second = new_code(&mut client).await;
    remote::pair(routes, &second, "desktop", other.path())
        .await
        .unwrap();
    let thief = temp_dir();
    let read = |dir: &Path| -> Value {
        let file = dir.join("remote-hosts").join(fp);
        serde_json::from_slice(&std::fs::read(file).unwrap()).unwrap()
    };
    let (stolen, theirs) = (read(laptop.path()), read(other.path()));
    let mixed = serde_json::json!({ "token": stolen["token"], "key": theirs["key"] });
    std::fs::create_dir_all(thief.path().join("remote-hosts")).unwrap();
    std::fs::write(
        thief.path().join("remote-hosts").join(fp),
        mixed.to_string(),
    )
    .unwrap();
    let replayed = open(routes, fp, thief.path()).await;
    assert!(
        matches!(replayed, Err(remote::Error::Refused)),
        "{:?}",
        replayed.err()
    );

    // Revoking closes the session's connection and refuses it after.
    let id = sessions[0].id.clone();
    let left = client
        .call::<RemoteRevoke>(RemoteRevokeParams { id })
        .await
        .unwrap();
    assert_eq!(left.sessions.len(), 1, "the desktop's session stays");
    assert!(app.closes().await, "revoking closes its connection");
    let after = open(routes, fp, laptop.path()).await;
    assert!(
        matches!(after, Err(remote::Error::Refused)),
        "{:?}",
        after.err()
    );

    set_remote(&mut client, false).await;
    wait_listening(port, false).await;
    server.stop().await;
}

#[tokio::test]
async fn an_expired_code_ends_the_pairing_and_its_advertisement() {
    let port = free_port();
    let dir = temp_dir();
    let mut config = InProcess::config(dir.path());
    config.remote_address = Some(LOOPBACK);
    config.remote_port = port;
    config.remote_code_lifetime = Duration::from_millis(300);
    let server = InProcess::start(config);
    let mut client = Client::ready(&server.socket).await;
    set_remote(&mut client, true).await;
    wait_listening(port, true).await;

    let code = new_code(&mut client).await;
    let status = client
        .call::<RemoteSessions>(RemoteSessionsParams {})
        .await
        .unwrap();
    assert!(status.pairing, "a code is waiting");
    let deadline = Instant::now() + PATIENCE;
    while client
        .call::<RemoteSessions>(RemoteSessionsParams {})
        .await
        .unwrap()
        .pairing
    {
        assert!(Instant::now() < deadline, "the pairing never ended");
        sleep(Duration::from_millis(50)).await;
    }
    let route = format!("127.0.0.1:{port}");
    let late = remote::pair(std::slice::from_ref(&route), &code, "laptop", dir.path()).await;
    assert!(matches!(late, Err(remote::Error::Refused)), "{late:?}");
    server.stop().await;
}

/// One HTTPS request to the listener on loopback `port`: its status, its headers by lowercase
/// name, and its body.
async fn https(
    port: u16,
    method: &str,
    path: &str,
    headers: &[(&str, &str)],
    body: &str,
) -> (u16, HashMap<String, String>, Vec<u8>) {
    let (mut tls, _) = remote::open(&format!("127.0.0.1:{port}"), None)
        .await
        .unwrap();
    let mut head = format!(
        "{method} {path} HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nContent-Length: {}\r\n",
        body.len()
    );
    for (name, value) in headers {
        let _ = write!(head, "{name}: {value}\r\n");
    }
    tls.write_all(format!("{head}\r\n{body}").as_bytes())
        .await
        .unwrap();
    let mut answer = Vec::new();
    let _ = timeout(PATIENCE, tls.read_to_end(&mut answer))
        .await
        .unwrap();
    let mut parsed = [httparse::EMPTY_HEADER; 16];
    let mut response = httparse::Response::new(&mut parsed);
    let httparse::Status::Complete(length) = response.parse(&answer).unwrap() else {
        panic!("a partial answer");
    };
    let headers = response
        .headers
        .iter()
        .map(|h| {
            let value = String::from_utf8_lossy(h.value).into_owned();
            (h.name.to_ascii_lowercase(), value)
        })
        .collect();
    (response.code.unwrap(), headers, answer[length..].to_vec())
}

type WebSocket = tokio_tungstenite::WebSocketStream<tokio_rustls::client::TlsStream<TcpStream>>;

/// A WebSocket to `/ws` with `ticket`, sent from `origin`, once it has initialized.
async fn web_socket(
    port: u16,
    ticket: &str,
    origin: &str,
) -> Result<WebSocket, tokio_tungstenite::tungstenite::Error> {
    use tokio_tungstenite::tungstenite::client::IntoClientRequest as _;
    let (tls, _) = remote::open(&format!("127.0.0.1:{port}"), None)
        .await
        .unwrap();
    let mut request = format!("wss://127.0.0.1:{port}/ws?wsTicket={ticket}")
        .into_client_request()
        .unwrap();
    request
        .headers_mut()
        .insert("origin", origin.parse().unwrap());
    let (mut socket, _) = tokio_tungstenite::client_async(request, tls).await?;
    let initialize = r#"{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocol":{"min":1,"max":1},"client":{"name":"browser","version":"0"},"capabilities":{}}}"#;
    socket.send(Message::text(initialize)).await?;
    let answer = timeout(PATIENCE, socket.next()).await.unwrap().unwrap()?;
    let answer: Value = serde_json::from_str(answer.to_text()?).unwrap();
    assert!(answer["result"]["logId"].is_string(), "{answer}");
    Ok(socket)
}

/// A ticket for the browser session `token`, bound to `key`: the status and the answer.
async fn web_ticket(port: u16, key: &remote::DpopKey, token: &str) -> (u16, Value) {
    let path = "/api/auth/websocket-ticket";
    let base = format!("https://127.0.0.1:{port}");
    let authorization = format!("DPoP {token}");
    let dpop = key.proof("POST", &format!("{base}{path}"), Some(token));
    let headers = [
        ("Authorization", authorization.as_str()),
        ("DPoP", dpop.as_str()),
        ("Origin", base.as_str()),
    ];
    let (status, _, body) = https(port, "POST", path, &headers, "").await;
    (status, serde_json::from_slice(&body).unwrap())
}

async fn set_web(client: &mut Client, on: bool) {
    let settings = client
        .call::<HostSettingsSet>(HostSettingsSetParams {
            remote_web: Some(on),
            ..HostSettingsSetParams::default()
        })
        .await
        .unwrap();
    assert_eq!(settings.remote_web, Some(on));
}

#[tokio::test]
#[expect(
    clippy::too_many_lines,
    reason = "the web client's whole surface, step by step"
)]
async fn the_web_client_is_served_only_when_on_and_pairs_a_browser_with_the_code() {
    let port = free_port();
    let dir = temp_dir();
    let web = temp_dir();
    std::fs::create_dir(web.path().join("assets")).unwrap();
    std::fs::write(web.path().join("web.html"), "<!doctype html>web").unwrap();
    std::fs::write(web.path().join("assets/app-1a.js"), "app()").unwrap();
    std::fs::write(web.path().join("secret.txt"), "secret").unwrap();
    let mut config = InProcess::config(dir.path());
    config.remote_address = Some(LOOPBACK);
    config.remote_port = port;
    config.remote_web_dir = Some(web.path().to_owned());
    let server = InProcess::start(config);
    let mut client = Client::ready(&server.socket).await;
    set_remote(&mut client, true).await;
    wait_listening(port, true).await;
    let key = remote::DpopKey::generate();
    let base = format!("https://127.0.0.1:{port}");
    let pair = |code: &str| serde_json::json!({ "code": code, "clientLabel": "Phone" }).to_string();
    let proof =
        |path: &str, token: Option<&str>| key.proof("POST", &format!("{base}{path}"), token);

    // Off by default, even with `remote` on: no page, and no pairing with the code alone.
    let settings = client
        .call::<HostSettingsGet>(HostSettingsGetParams {})
        .await
        .unwrap();
    assert_eq!(settings.remote_web, Some(false));
    assert_eq!(https(port, "GET", "/", &[], "").await.0, 404);
    let code = new_code(&mut client).await;
    let dpop = proof("/api/pair/browser", None);
    let (status, ..) = https(
        port,
        "POST",
        "/api/pair/browser",
        &[("DPoP", &dpop)],
        &pair(&code),
    )
    .await;
    assert_eq!(status, 404);

    set_web(&mut client, true).await;

    // The page and its assets, with a policy that forbids framing and other origins' scripts.
    let (status, headers, body) = https(port, "GET", "/", &[], "").await;
    assert_eq!((status, body.as_slice()), (200, &b"<!doctype html>web"[..]));
    let csp = &headers["content-security-policy"];
    assert!(
        csp.contains("frame-ancestors 'none'") && csp.contains("script-src 'self';"),
        "{csp}"
    );
    assert_eq!(headers["x-content-type-options"], "nosniff");
    let (status, headers, body) = https(port, "GET", "/assets/app-1a.js", &[], "").await;
    assert_eq!((status, body.as_slice()), (200, &b"app()"[..]));
    assert!(headers["content-type"].starts_with("text/javascript"));
    // Nothing else in the folder, or outside it.
    for path in [
        "/secret.txt",
        "/web.html",
        "/assets/../secret.txt",
        "/assets/..%2fsecret.txt",
        "/assets/",
        "/assets/.hidden",
        // Windows' devices, and the trailing dot it strips, aren't in the folder's listing.
        "/assets/CON",
        "/assets/nul.js",
        "/assets/app-1a.js.",
    ] {
        assert_eq!(https(port, "GET", path, &[], "").await.0, 404, "{path}");
    }

    // A page on another origin can't pair, even with the right code, and doesn't use it up.
    let evil = [("DPoP", dpop.as_str()), ("Origin", "https://evil.example")];
    let (status, ..) = https(port, "POST", "/api/pair/browser", &evil, &pair(&code)).await;
    assert_eq!(status, 403);
    // No proof, or a wrong code, is refused.
    let (status, ..) = https(port, "POST", "/api/pair/browser", &[], &pair(&code)).await;
    assert_eq!(status, 401);
    let dpop = proof("/api/pair/browser", None);
    let (status, ..) = https(
        port,
        "POST",
        "/api/pair/browser",
        &[("DPoP", &dpop)],
        &pair(&wrong(&code)),
    )
    .await;
    assert_eq!(status, 401);

    // A proof seen once is refused before it reaches the code, so a replay can't use it up.
    let seen = proof("/api/pair/browser", None);
    let headers = [("DPoP", seen.as_str())];
    let (status, ..) = https(
        port,
        "POST",
        "/api/pair/browser",
        &headers,
        &pair(&wrong(&code)),
    )
    .await;
    assert_eq!(status, 401);
    let (status, _, body) = https(port, "POST", "/api/pair/browser", &headers, &pair(&code)).await;
    assert_eq!(status, 401);
    assert!(String::from_utf8_lossy(&body).contains("replayed"));

    // The right code, as typed, from this host's own origin.
    let dpop = proof("/api/pair/browser", None);
    let own = [("DPoP", dpop.as_str()), ("Origin", base.as_str())];
    let typed = code.to_lowercase();
    let (status, _, body) = https(port, "POST", "/api/pair/browser", &own, &pair(&typed)).await;
    assert_eq!(status, 200, "{}", String::from_utf8_lossy(&body));
    let paired: Value = serde_json::from_slice(&body).unwrap();
    let token = paired["accessToken"].as_str().unwrap().to_owned();
    let dpop = proof("/api/pair/browser", None);
    let (status, ..) = https(
        port,
        "POST",
        "/api/pair/browser",
        &[("DPoP", &dpop)],
        &pair(&code),
    )
    .await;
    assert_eq!(status, 401, "a code works once");
    let sessions = client
        .call::<RemoteSessions>(RemoteSessionsParams {})
        .await
        .unwrap();
    assert_eq!(sessions.sessions[0].name, "Phone");

    // Too many wrong codes lock it, as for SPAKE2.
    let locked = new_code(&mut client).await;
    for _ in 0..remote::MAX_WRONG_CODES {
        let dpop = proof("/api/pair/browser", None);
        let (status, ..) = https(
            port,
            "POST",
            "/api/pair/browser",
            &[("DPoP", &dpop)],
            &pair(&wrong(&locked)),
        )
        .await;
        assert_eq!(status, 401);
    }
    let dpop = proof("/api/pair/browser", None);
    let (status, ..) = https(
        port,
        "POST",
        "/api/pair/browser",
        &[("DPoP", &dpop)],
        &pair(&locked),
    )
    .await;
    assert_eq!(status, 401, "locked");

    // The session opens the WebSocket through a ticket, from this origin only. An unknown token is
    // `invalid_token`, the only refusal that means pairing again.
    let (status, refusal) = web_ticket(port, &key, "nope").await;
    assert_eq!(
        (status, refusal["error"].as_str()),
        (401, Some("invalid_token"))
    );
    let (status, ticket) = web_ticket(port, &key, &token).await;
    assert_eq!(status, 200, "{ticket}");
    let ticket = ticket["ticket"].as_str().unwrap();
    let elsewhere = web_socket(port, ticket, "https://evil.example").await;
    assert!(
        matches!(&elsewhere, Err(tokio_tungstenite::tungstenite::Error::Http(r)) if r.status() == 403),
        "{elsewhere:?}"
    );
    web_socket(port, ticket, &base).await.unwrap();
    let reused = web_socket(port, ticket, &base).await;
    assert!(
        matches!(&reused, Err(tokio_tungstenite::tungstenite::Error::Http(r)) if r.status() == 401),
        "a ticket works once: {reused:?}"
    );

    // Off: the page is gone, a browser's open socket closes and it gets no ticket, and a paired
    // computer keeps working.
    let route = format!("127.0.0.1:{port}");
    let desktop = temp_dir();
    let second = new_code(&mut client).await;
    let paired = remote::pair(
        std::slice::from_ref(&route),
        &second,
        "desktop",
        desktop.path(),
    )
    .await
    .unwrap();
    let (_, ticket) = web_ticket(port, &key, &token).await;
    let mut socket = web_socket(port, ticket["ticket"].as_str().unwrap(), &base)
        .await
        .unwrap();
    set_web(&mut client, false).await;
    assert_eq!(https(port, "GET", "/", &[], "").await.0, 404);
    let closed = timeout(PATIENCE, socket.next()).await.unwrap();
    assert!(
        matches!(closed, None | Some(Ok(Message::Close(_)) | Err(_))),
        "{closed:?}"
    );
    let (status, refusal) = web_ticket(port, &key, &token).await;
    assert_eq!(
        (status, refusal["error"].as_str()),
        (403, Some("access_denied"))
    );
    let mut app = open(&[route], &paired.fingerprint, desktop.path())
        .await
        .unwrap();
    assert!(app.initialize().await["result"]["logId"].is_string());

    // On again: the browser's session works as before.
    set_web(&mut client, true).await;
    let (status, ticket) = web_ticket(port, &key, &token).await;
    assert_eq!(status, 200, "{ticket}");
    web_socket(port, ticket["ticket"].as_str().unwrap(), &base)
        .await
        .unwrap();
    server.stop().await;
}

/// Reads this process's resident memory, in KiB.
#[cfg(unix)]
fn rss_kib() -> u64 {
    let out = std::process::Command::new("ps")
        .args(["-o", "rss=", "-p", &std::process::id().to_string()])
        .output()
        .unwrap();
    String::from_utf8_lossy(&out.stdout).trim().parse().unwrap()
}

#[cfg(unix)]
#[tokio::test]
async fn readers_that_stall_on_the_web_client_hold_little_memory() {
    const READERS: usize = 200;
    const FILE_BYTES: usize = 2 * 1024 * 1024;
    let port = free_port();
    let dir = temp_dir();
    let web = temp_dir();
    std::fs::create_dir(web.path().join("assets")).unwrap();
    std::fs::write(web.path().join("assets/main-1a.js"), vec![b'x'; FILE_BYTES]).unwrap();
    let mut config = InProcess::config(dir.path());
    config.remote_address = Some(LOOPBACK);
    config.remote_port = port;
    config.remote_web_dir = Some(web.path().to_owned());
    let server = InProcess::start(config);
    let mut client = Client::ready(&server.socket).await;
    set_remote(&mut client, true).await;
    wait_listening(port, true).await;
    set_web(&mut client, true).await;

    let before = rss_kib();
    // Each asks for the file and never reads the answer.
    let mut stalled = Vec::new();
    for _ in 0..READERS {
        let (mut tls, _) = remote::open(&format!("127.0.0.1:{port}"), None)
            .await
            .unwrap();
        let request = format!("GET /assets/main-1a.js HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\n\r\n");
        tls.write_all(request.as_bytes()).await.unwrap();
        stalled.push(tls);
    }
    sleep(Duration::from_secs(1)).await;
    let grown = rss_kib().saturating_sub(before);
    // Reading each whole file into memory, as this once did, held about 400 MiB here.
    assert!(
        grown < 64 * 1024,
        "grew {grown} KiB with {READERS} stalled readers"
    );
    drop(stalled);
    server.stop().await;
}
