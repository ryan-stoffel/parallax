//! Parallax Relay end to end (PLX-652, 0068): plxd behind a local relay (`wrangler dev`), a client
//! pairing and connecting through it with TLS to plxd's pinned certificate, and webhooks
//! forwarded with plxd's signature check and held while plxd is away.
//!
//! Runs only when `relay/scripts/e2e.mjs` starts a relay and passes its URL and a Clerk token in
//! `PLXD_TEST_RELAY_URL` and `PLXD_TEST_RELAY_TOKEN`. Elsewhere it passes without doing anything.

use std::time::Duration;

use parallax_protocol::methods::{
    HostSettingsSet, RelayHosts, RelayRegister, RelayRemove, RemoteSessions, ScheduleList,
    ScheduleSave,
};
use parallax_protocol::{
    AccountChoice, HostSettingsSetParams, RelayHostsParams, RelayRegisterParams, RelayRemoveParams,
    RelayStatus, RemoteSessionsParams, Schedule, ScheduleListParams, ScheduleSaveParams,
    SignatureEncoding, WebhookSignature,
};
use plxd::{relay, remote};
use tokio::io::{AsyncReadExt as _, AsyncWriteExt as _};
use tokio::net::TcpStream;
use tokio::time::{Instant, sleep};

use crate::agents::fake;
use crate::connect::free_port;
use crate::remote::{LOOPBACK, new_code, open, set_remote, wait_listening};
use crate::support::{Client, InProcess, PATIENCE, temp_dir};
use crate::thread_tools::Keys;

async fn set_relay(client: &mut Client, on: bool) {
    client
        .call::<HostSettingsSet>(HostSettingsSetParams {
            relay: Some(on),
            ..HostSettingsSetParams::default()
        })
        .await
        .unwrap();
}

/// The relay status once `done` says so.
async fn relay_status(client: &mut Client, done: impl Fn(&RelayStatus) -> bool) -> RelayStatus {
    let deadline = Instant::now() + PATIENCE;
    loop {
        let sessions = client
            .call::<RemoteSessions>(RemoteSessionsParams {})
            .await
            .unwrap();
        let status = sessions.relay.unwrap_or_default();
        if done(&status) {
            return status;
        }
        assert!(
            Instant::now() < deadline,
            "the relay never got there: {status:?}"
        );
        sleep(Duration::from_millis(50)).await;
    }
}

/// How many times the only scheduled task fired, once it's `count`.
async fn fired(client: &mut Client, count: u64) {
    let deadline = Instant::now() + PATIENCE;
    loop {
        let tasks = client
            .call::<ScheduleList>(ScheduleListParams {})
            .await
            .unwrap()
            .tasks;
        if tasks[0].run_count == count {
            return;
        }
        assert!(
            Instant::now() < deadline,
            "fired {} times",
            tasks[0].run_count
        );
        sleep(Duration::from_millis(50)).await;
    }
}

/// A POST to the local relay at `url`: the status and body.
async fn post(url: &str, body: &[u8], signature: &str) -> (u16, String) {
    let rest = url.strip_prefix("http://").unwrap();
    let (authority, path) = rest.split_at(rest.find('/').unwrap());
    let mut tcp = TcpStream::connect(authority).await.unwrap();
    let head = format!(
        "POST {path} HTTP/1.1\r\nHost: {authority}\r\nConnection: close\r\n\
         Content-Type: application/json\r\nX-Hub-Signature-256: {signature}\r\n\
         Content-Length: {}\r\n\r\n",
        body.len()
    );
    tcp.write_all(head.as_bytes()).await.unwrap();
    tcp.write_all(body).await.unwrap();
    // By its length: wrangler dev keeps the connection open for a while despite `close`.
    let mut answer = Vec::new();
    loop {
        let mut chunk = [0; 4096];
        let read = tcp.read(&mut chunk).await.unwrap();
        answer.extend_from_slice(&chunk[..read]);
        let text = String::from_utf8_lossy(&answer).into_owned();
        if let Some((head, body)) = text.split_once("\r\n\r\n") {
            let length = head
                .lines()
                .find_map(|line| {
                    line.to_ascii_lowercase()
                        .strip_prefix("content-length:")?
                        .trim()
                        .parse()
                        .ok()
                })
                .unwrap_or(0);
            if body.len() >= length || read == 0 {
                return (head[9..12].parse().unwrap(), body.to_owned());
            }
        }
        assert!(read > 0, "the relay closed without an answer");
    }
}

#[tokio::test]
#[expect(
    clippy::too_many_lines,
    reason = "one walk through the relay, step by step"
)]
async fn a_client_reaches_its_host_and_webhooks_arrive_through_the_relay() {
    let (Ok(url), Ok(token)) = (
        std::env::var("PLXD_TEST_RELAY_URL"),
        std::env::var("PLXD_TEST_RELAY_TOKEN"),
    ) else {
        return;
    };
    let port = free_port();
    let dir = temp_dir();
    let mut config = InProcess::config(dir.path());
    config.remote_address = Some(LOOPBACK);
    config.remote_port = port;
    config.relay_url.clone_from(&url);
    config.backends = Some(fake(Vec::new()));
    // The webhook's secret goes in a keystore: this one, not the OS's.
    config.keys = Some(std::sync::Arc::new(Keys::default()));
    let server = InProcess::start(config);
    let mut client = Client::ready(&server.socket).await;

    // On, but not registered: the relay doesn't know this host's key yet.
    set_remote(&mut client, true).await;
    wait_listening(port, true).await;
    set_relay(&mut client, true).await;
    let unregistered = relay_status(&mut client, |s| s.problem.is_some()).await;
    assert!(
        unregistered.problem.unwrap().contains("isn't registered"),
        "the relay refused an unknown host"
    );
    let registered = client
        .call::<RelayRegister>(RelayRegisterParams {
            token: token.clone(),
        })
        .await;
    assert!(registered.is_ok(), "{registered:?}");
    let status = relay_status(&mut client, |s| s.connected).await;
    let hook_url = status.hook_url.unwrap();
    let route = format!("relay:{}", hook_url.rsplit('/').next().unwrap());

    // Pairing and the session run inside the relay's stream, with TLS to plxd's own certificate.
    relay::sign_in(url.clone(), token.clone());
    let code = new_code(&mut client).await;
    let phone = temp_dir();
    let paired = remote::pair(std::slice::from_ref(&route), &code, "phone", phone.path())
        .await
        .unwrap();
    assert!(paired.routes.contains(&route), "{:?}", paired.routes);
    let mut app = open(
        std::slice::from_ref(&route),
        &paired.fingerprint,
        phone.path(),
    )
    .await
    .unwrap();
    let initialized = app.initialize().await;
    assert!(initialized["result"].is_object(), "{initialized}");
    // The relay can't stand in for the host: the client pins the host's certificate.
    let other = "00".repeat(32);
    let forged = remote::open(&route, Some(&other)).await;
    assert!(
        matches!(forged, Err(remote::Error::WrongHost)),
        "{forged:?}"
    );

    // A webhook's public URL is the relay's, and plxd checks its signature.
    let task = client
        .call::<ScheduleSave>(ScheduleSaveParams {
            id: None,
            title: "Release notes".to_owned(),
            prompt: "Write notes for {{body.tag}}.".to_owned(),
            enabled: true,
            schedule: Schedule::Webhook {
                signature: Some(WebhookSignature {
                    header: "x-hub-signature-256".to_owned(),
                    encoding: SignatureEncoding::Hex,
                    prefix: "sha256=".to_owned(),
                    secret: Some("s3cret".to_owned()),
                    secret_ref: None,
                }),
            },
            thread: None,
            project: None,
            repo: None,
            account: Some(AccountChoice::Subscription {
                backend: "fake".to_owned(),
            }),
            model: None,
            effort: None,
            permission: None,
            from: None,
        })
        .await
        .unwrap();
    let hook = task.webhook.unwrap().url.unwrap();
    assert!(hook.starts_with(&hook_url), "{hook}");
    let body = br#"{"tag":"v1.2"}"#;
    let key = ring::hmac::Key::new(ring::hmac::HMAC_SHA256, b"s3cret");
    let signed = format!(
        "sha256={}",
        data_encoding::HEXLOWER.encode(ring::hmac::sign(&key, body).as_ref())
    );
    // plxd lists the new hook's URL with the relay, which answers unlisted ones 404.
    assert_eq!(post(&format!("{hook}x"), body, &signed).await.0, 404);
    let deadline = Instant::now() + PATIENCE;
    let mut bad = post(&hook, body, "sha256=00").await.0;
    while bad == 404 && Instant::now() < deadline {
        sleep(Duration::from_millis(50)).await;
        bad = post(&hook, body, "sha256=00").await.0;
    }
    assert_eq!(bad, 401, "a bad signature");
    let (status, answer) = post(&hook, body, &signed).await;
    assert_eq!(status, 202, "{answer}");
    fired(&mut client, 1).await;

    // Away: the relay holds the request, and plxd fires it once it's back.
    set_relay(&mut client, false).await;
    relay_status(&mut client, |s| !s.connected).await;
    let (status, answer) = post(&hook, body, &signed).await;
    assert_eq!((status, answer.as_str()), (202, r#"{"queued":true}"#));
    set_relay(&mut client, true).await;
    relay_status(&mut client, |s| s.connected).await;
    fired(&mut client, 2).await;

    // The account's hosts on the relay, and removing this one, which frees its place.
    let listed = client
        .call::<RelayHosts>(RelayHostsParams {
            token: token.clone(),
        })
        .await
        .unwrap()
        .hosts;
    assert_eq!(listed.len(), 1);
    assert!(listed[0].this_computer && listed[0].online, "{listed:?}");
    let left = client
        .call::<RelayRemove>(RelayRemoveParams {
            token: token.clone(),
            host_id: listed[0].host_id.clone(),
        })
        .await
        .unwrap()
        .hosts;
    assert!(left.is_empty(), "{left:?}");
    relay_status(&mut client, |s| !s.connected).await;
}
