//! Remote access on the LAN (PLX-641, 0065): the HTTPS listener on loopback, pairing with a
//! one-time code over SPAKE2, DPoP-bound sessions, and refusing every client that didn't pair.

use std::net::{IpAddr, Ipv4Addr};
use std::path::Path;
use std::time::Duration;

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
