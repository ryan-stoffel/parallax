//! Parallax Relay end to end (PLX-652, 0068): plxd behind a local relay (`wrangler dev`), a client
//! pairing and connecting through it with TLS to plxd's pinned certificate, and webhooks
//! forwarded with plxd's signature check and held while plxd is away. Then two plxds working
//! across it with only their host keys and Tailscale stopped (0101), and syncing You memory
//! (PLX-1362).
//!
//! Runs only when `relay/scripts/e2e.mjs` starts a relay and passes its URL and a Clerk token in
//! `PLXD_TEST_RELAY_URL`, `PLXD_TEST_RELAY_TOKEN`, `PLXD_TEST_RELAY_CHECK_TOKEN`,
//! `PLXD_TEST_RELAY_PEERS_TOKEN`, and `PLXD_TEST_RELAY_SYNC_TOKEN`. Elsewhere it passes without doing anything, but for the older
//! relay's test, whose relay is its own.

use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::time::Duration;

use futures_util::{SinkExt as _, StreamExt as _};
use parallax_protocol::jsonrpc::Message;
use parallax_protocol::methods::{
    AccessGet, AccessMerge, AccessRemove, AgentEvents, AgentList, HostAnnounceUpdate,
    HostSettingsGet, HostSettingsSet, OrchestratorCreate, PeerComputers, RelayCheck, RelayHosts,
    RelayId, RelayRegister, RelayRemove, RelaySign, RemoteRevoke, RemoteSessions, ScheduleList,
    ScheduleSave, ThreadStart,
};
use parallax_protocol::{
    AccessGetParams, AccessMergeParams, AccessRemoveParams, AccountChoice, AgentEventsParams,
    AgentListParams, AgentOutputItem, HostAnnounceUpdateParams, HostSettingsGetParams,
    HostSettingsSetParams, ParallaxEvent, PeerComputersParams, RelayCheckParams, RelayCheckPart,
    RelayHostsParams, RelayIdParams, RelayRegisterParams, RelayRemoveParams, RelaySignParams,
    RelayStatus, RemoteRevokeParams, RemoteSessionsParams, RunId, Schedule, ScheduleListParams,
    ScheduleSaveParams, SignatureEncoding, WebhookSignature,
};
use plxd::backend::fake::Step;
use plxd::{relay, remote};
use serde_json::{Value, json};
use tokio::io::{AsyncReadExt as _, AsyncWriteExt as _};
use tokio::net::tcp::{OwnedReadHalf, OwnedWriteHalf};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::Notify;
use tokio::time::{Instant, sleep};

use crate::agents::{end_turn, fake, git, init, real_repo};
use crate::connect::free_port;
use crate::mcp::{Mcp, mcp_command};
use crate::remote::{
    App, INITIALIZE, LOOPBACK, new_code, open, open_account, set_remote, wait_listening,
};
use crate::support::{Client, InProcess, PATIENCE, temp_dir};
use crate::thread_tools::Keys;
use crate::threads::start_params;
use crate::you_sync::{TABS, body, list, write};

#[cfg(feature = "host-routing-proof")]
mod host_proof;
mod proxied;

async fn set_relay(client: &mut Client, on: bool) {
    client
        .call::<HostSettingsSet>(HostSettingsSetParams {
            relay: Some(on),
            ..HostSettingsSetParams::default()
        })
        .await
        .unwrap();
}

async fn relay_on(client: &mut Client) -> bool {
    let settings = client.call::<HostSettingsGet>(HostSettingsGetParams {});
    settings.await.unwrap().relay == Some(true)
}

/// This host's registration, signed over `token`'s hash, as another computer asks for it.
async fn sign(client: &mut Client, token: &str) -> parallax_protocol::RelaySignResult {
    let hash = remote::base64url(&remote::sha256(token.as_bytes()));
    client
        .call::<RelaySign>(RelaySignParams {
            token_hash: hash,
            user_id: None,
        })
        .await
        .unwrap()
}

#[tokio::test]
async fn signing_in_turns_the_relay_on_unless_its_user_turned_it_off() {
    let dir = temp_dir();
    let mut config = InProcess::config(dir.path());
    // Nothing answers here, so no relay is reached.
    config.relay_url = "http://127.0.0.1:9".to_owned();
    let server = InProcess::start(config);
    let mut client = Client::ready(&server.socket).await;

    assert!(!relay_on(&mut client).await);
    let signed = sign(&mut client, "token").await;
    assert_eq!(signed.host_id.len(), 43, "{signed:?}");
    assert!(relay_on(&mut client).await, "signing in turns it on");
    set_relay(&mut client, false).await;
    sign(&mut client, "token").await;
    assert!(
        !relay_on(&mut client).await,
        "an off the user chose stays off"
    );
}

/// The relay status once `done` says so.
async fn relay_status(client: &mut Client, done: impl Fn(&RelayStatus) -> bool) -> RelayStatus {
    relay_status_within(client, done, PATIENCE).await
}

/// The relay status once `done` says so, within `patience`.
async fn relay_status_within(
    client: &mut Client,
    done: impl Fn(&RelayStatus) -> bool,
    patience: Duration,
) -> RelayStatus {
    let deadline = Instant::now() + patience;
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
            signed: None,
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

    // Word of a restart for an update gets through the relay too (PLX-1418).
    let mut announcing = Client::ready(&server.socket).await;
    announcing
        .send::<HostAnnounceUpdate>(HostAnnounceUpdateParams {})
        .await;
    let told = app.next().await;
    assert!(told.contains(r#""method":"host/updating""#), "{told}");
    // This test's own client hears it too, as its next message.
    let heard = client.next().await;
    assert!(
        matches!(&heard, Some(Message::Notification(n)) if n.method == "host/updating"),
        "{heard:?}"
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
            orchestrator: None,
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

    // The account's hosts on the relay, and removing this one, which frees its place. The other
    // test's computer may be on the same account at the same time.
    let listed = client
        .call::<RelayHosts>(RelayHostsParams {
            token: token.clone(),
        })
        .await
        .unwrap()
        .hosts;
    let this = listed.iter().find(|h| h.this_computer);
    let this = this.unwrap_or_else(|| panic!("{listed:?}"));
    assert!(this.online, "{listed:?}");
    assert!(
        this.usage.as_ref().is_some_and(|usage| usage.limit > 0),
        "{listed:?}"
    );
    let left = client
        .call::<RelayRemove>(RelayRemoveParams {
            token: token.clone(),
            host_id: this.host_id.clone(),
        })
        .await
        .unwrap()
        .hosts;
    assert!(left.iter().all(|h| h.host_id != this.host_id), "{left:?}");
    relay_status(&mut client, |s| !s.connected).await;
}

/// A computer the user didn't sign in on joins the relay with only its signature (PLX-1146): the
/// token stays with the computer that posts it, and pairing stays off.
#[tokio::test]
async fn another_computer_registers_with_its_signature_alone() {
    let (Ok(url), Ok(token)) = (
        std::env::var("PLXD_TEST_RELAY_URL"),
        std::env::var("PLXD_TEST_RELAY_TOKEN"),
    ) else {
        return;
    };
    let start = |dir: &std::path::Path| {
        let mut config = InProcess::config(dir);
        config.relay_url.clone_from(&url);
        InProcess::start(config)
    };
    let (here_dir, there_dir) = (temp_dir(), temp_dir());
    let (here, there) = (start(here_dir.path()), start(there_dir.path()));
    let mut here = Client::ready(&here.socket).await;
    let mut there = Client::ready(&there.socket).await;

    let signed = sign(&mut there, &token).await;
    let registered = here
        .call::<RelayRegister>(RelayRegisterParams {
            token: token.clone(),
            signed: Some(signed.clone()),
        })
        .await;
    assert!(registered.is_ok(), "{registered:?}");
    relay_status(&mut there, |s| s.connected).await;
    let listed = here
        .call::<RelayHosts>(RelayHostsParams {
            token: token.clone(),
        })
        .await
        .unwrap()
        .hosts;
    let joined = listed.iter().find(|h| h.host_id == signed.host_id);
    assert!(
        joined.is_some_and(|h| h.online && !h.this_computer),
        "{listed:?}"
    );
    let removed = here.call::<RelayRemove>(RelayRemoveParams {
        token,
        host_id: signed.host_id,
    });
    removed.await.unwrap();
}

/// A computer on the account of `token`, connected to the relay at `url`, whose plxd takes tokens
/// from the Clerk at `issuer`: the server, its client, and its route and host id.
async fn computer(
    dir: &std::path::Path,
    issuer: &str,
    url: &str,
    token: &str,
) -> (InProcess, Client, String, String) {
    let port = free_port();
    let server = InProcess::start(crate::account::config(dir, issuer, url, port));
    let mut client = Client::ready(&server.socket).await;
    set_remote(&mut client, true).await;
    wait_listening(port, true).await;
    let registered = client
        .call::<RelayRegister>(RelayRegisterParams {
            token: token.to_owned(),
            signed: None,
        })
        .await;
    assert!(registered.is_ok(), "{registered:?}");
    let status = relay_status(&mut client, |s| s.connected).await;
    let hook_url = status.hook_url.unwrap();
    let host_id = hook_url.rsplit('/').next().unwrap().to_owned();
    (server, client, format!("127.0.0.1:{port}"), host_id)
}

/// Whether `key` is on `client`'s computer's removed list within 5 seconds.
async fn learns_removed(client: &mut Client, key: &str) -> bool {
    let deadline = Instant::now() + REMOVAL_ARRIVES;
    while Instant::now() < deadline {
        let state = client.call::<AccessGet>(AccessGetParams::default()).await;
        if state.unwrap().removed_clients.iter().any(|k| k == key) {
            return true;
        }
        sleep(Duration::from_millis(20)).await;
    }
    false
}

/// A live connection to a computer, as a device holds one, that answers a request.
async fn answers(app: &mut App) -> bool {
    app.send(r#"{"jsonrpc":"2.0","id":9,"method":"host/health","params":{}}"#)
        .await;
    app.next().await.contains(r#""result""#)
}

/// The account of the token `relay/scripts/e2e.mjs` passes, as plxd takes tokens from the test's Clerk.
const E2E_USER: &str = "user_e2e";

/// How soon a removal reaches an online computer.
const REMOVAL_ARRIVES: Duration = Duration::from_secs(5);

#[tokio::test]
#[expect(clippy::too_many_lines, reason = "one removal told step by step")]
async fn removing_a_device_on_one_computer_cuts_it_off_on_the_others_within_seconds() {
    let (Ok(url), Ok(relay_token)) = (
        std::env::var("PLXD_TEST_RELAY_URL"),
        std::env::var("PLXD_TEST_RELAY_TOKEN"),
    ) else {
        return;
    };
    let issuer = crate::account::clerk().await;
    let dirs = [temp_dir(), temp_dir(), temp_dir(), temp_dir()];
    let (a_server, mut a, a_route, a_id) =
        computer(dirs[0].path(), &issuer, &url, &relay_token).await;
    let (b_server, mut b, b_route, b_id) =
        computer(dirs[1].path(), &issuer, &url, &relay_token).await;
    let (c_server, mut c, c_route, c_id) =
        computer(dirs[2].path(), &issuer, &url, &relay_token).await;
    // On the account by the relay's list, so it gets statements, but no client approved it.
    let (d_server, mut d, _, _) = computer(dirs[3].path(), &issuer, &url, &relay_token).await;
    let (phone, tablet) = (temp_dir(), temp_dir());
    let phone_key = crate::account::thumbprint(phone.path());
    let tablet_key = crate::account::thumbprint(tablet.path());
    let lists = AccessMergeParams {
        approved_clients: vec![phone_key.clone(), tablet_key.clone()],
        approved_hosts: vec![a_id.clone(), b_id.clone(), c_id.clone()],
        ..AccessMergeParams::default()
    };
    for client in [&mut a, &mut b, &mut c] {
        client.call::<AccessMerge>(lists.clone()).await.unwrap();
    }
    let sign_in = |route: &str, id: &str, name: &'static str, dir: std::path::PathBuf| {
        let (route, id, token) = (
            route.to_owned(),
            id.to_owned(),
            crate::account::token(&issuer, E2E_USER),
        );
        async move { remote::sign_in(&[route], &id, &token, name, false, &dir).await }
    };
    for (route, id) in [(&a_route, &a_id), (&b_route, &b_id), (&c_route, &c_id)] {
        for (dir, name) in [(&phone, "phone"), (&tablet, "tablet")] {
            let signed_in = sign_in(route, id, name, dir.path().to_owned()).await;
            assert!(
                matches!(signed_in, Ok((_, remote::SignIn::Approved { .. }))),
                "{signed_in:?}"
            );
        }
    }
    let live = |route: &String, id: &String, dir: &std::path::Path| {
        let (routes, id, dir) = (vec![route.clone()], id.clone(), dir.to_owned());
        async move {
            let mut app = open_account(&routes, &id, &dir).await.unwrap();
            assert!(app.initialize().await["result"].is_object());
            app
        }
    };
    let mut phone_on_b = live(&b_route, &b_id, phone.path()).await;
    let mut phone_on_c = live(&c_route, &c_id, phone.path()).await;

    // A computer the relay lists that no client approved says the phone is removed. Nobody listens.
    d.call::<AccessRemove>(AccessRemoveParams {
        thumbprint: phone_key.clone(),
    })
    .await
    .unwrap();
    sleep(Duration::from_secs(1)).await;
    assert!(answers(&mut phone_on_b).await, "not approved, so ignored");
    assert!(answers(&mut phone_on_c).await, "not approved, so ignored");

    // Removing it in A's Settings, with no client connected to B or C, closes it there.
    let started = Instant::now();
    let sessions = a.call::<RemoteSessions>(RemoteSessionsParams {}).await;
    let session = sessions.unwrap().sessions;
    let session = session.iter().find(|s| s.name == "phone").unwrap();
    a.call::<RemoteRevoke>(RemoteRevokeParams {
        id: session.id.clone(),
    })
    .await
    .unwrap();
    assert!(phone_on_b.closes().await);
    assert!(phone_on_c.closes().await);
    let took = started.elapsed();
    assert!(took < REMOVAL_ARRIVES, "took {took:?}");
    println!("a removal closed the sessions on two other computers in {took:?}");
    for (route, id, client) in [(&b_route, &b_id, &mut b), (&c_route, &c_id, &mut c)] {
        assert!(learns_removed(client, &phone_key).await);
        let routes = std::slice::from_ref(route);
        let dialed = open_account(routes, id, phone.path()).await;
        assert!(matches!(dialed, Err(remote::Error::Refused)));
        let signed_in = sign_in(route, id, "phone", phone.path().to_owned()).await;
        assert!(matches!(signed_in, Err(remote::Error::Removed)));
    }

    // C goes offline, so it hears nothing and its session stays, until a client catches it up.
    let mut tablet_on_c = live(&c_route, &c_id, tablet.path()).await;
    set_relay(&mut c, false).await;
    relay_status(&mut c, |s| !s.connected).await;
    a.call::<AccessRemove>(AccessRemoveParams {
        thumbprint: tablet_key.clone(),
    })
    .await
    .unwrap();
    assert!(learns_removed(&mut b, &tablet_key).await);
    assert!(!learns_removed(&mut c, &tablet_key).await);
    assert!(answers(&mut tablet_on_c).await, "offline: not told yet");
    set_relay(&mut c, true).await;
    relay_status(&mut c, |s| s.connected).await;
    c.call::<AccessMerge>(AccessMergeParams {
        removed_clients: vec![tablet_key.clone()],
        ..AccessMergeParams::default()
    })
    .await
    .unwrap();
    assert!(tablet_on_c.closes().await);

    // A removal made while A's own connection is down goes when it's back.
    let watch = remote::DpopKey::generate().thumbprint();
    set_relay(&mut a, false).await;
    relay_status(&mut a, |s| !s.connected).await;
    a.call::<AccessRemove>(AccessRemoveParams {
        thumbprint: watch.clone(),
    })
    .await
    .unwrap();
    set_relay(&mut a, true).await;
    relay_status(&mut a, |s| s.connected).await;
    assert!(learns_removed(&mut b, &watch).await);

    for server in [a_server, b_server, c_server, d_server] {
        server.stop().await;
    }
}

#[tokio::test]
async fn the_connection_check_crosses_the_relay_and_names_the_part_that_failed() {
    let (Ok(url), Ok(token)) = (
        std::env::var("PLXD_TEST_RELAY_URL"),
        std::env::var("PLXD_TEST_RELAY_CHECK_TOKEN"),
    ) else {
        return;
    };
    let dir = temp_dir();
    let mut config = InProcess::config(dir.path());
    config.remote_address = Some(LOOPBACK);
    let port = free_port();
    config.remote_port = port;
    config.relay_url.clone_from(&url);
    let server = InProcess::start(config);
    let mut client = Client::ready(&server.socket).await;
    let check = async |client: &mut Client, token: Option<&str>| {
        client
            .call::<RelayCheck>(RelayCheckParams {
                token: token.map(str::to_owned),
            })
            .await
            .unwrap()
    };

    set_relay(&mut client, true).await;
    let unknown = check(&mut client, None).await;
    assert_eq!(unknown.failed, Some(RelayCheckPart::SignIn), "{unknown:?}");

    client
        .call::<RelayRegister>(RelayRegisterParams {
            token: token.clone(),
            signed: None,
        })
        .await
        .unwrap();
    relay_status(&mut client, |s| s.connected).await;
    let off = check(&mut client, None).await;
    assert_eq!(off.failed, Some(RelayCheckPart::Listener), "{off:?}");

    set_remote(&mut client, true).await;
    wait_listening(port, true).await;
    let passed = check(&mut client, Some(&token)).await;
    assert_eq!(passed.failed, None, "{passed:?}");
    assert!(passed.round_trip_ms.is_some(), "{passed:?}");
    let bad = check(&mut client, Some("not.a.token")).await;
    assert_eq!(bad.failed, Some(RelayCheckPart::SignIn), "{bad:?}");
    for result in [&unknown, &off, &passed, &bad] {
        assert!(!result.diagnostics.contains(&token));
        assert!(!result.diagnostics.contains("user_e2e"));
    }
}

#[tokio::test]
async fn the_connection_check_says_an_older_relay_needs_updating() {
    // A relay from before the check: its `ready` doesn't say `check`, and it ignores the rest.
    let listener = TcpListener::bind((LOOPBACK, 0)).await.unwrap();
    let url = format!("http://{}", listener.local_addr().unwrap());
    tokio::spawn(async move {
        let (tcp, _) = listener.accept().await.unwrap();
        let mut socket = tokio_tungstenite::accept_async(tcp).await.unwrap();
        socket
            .send(tokio_tungstenite::tungstenite::Message::text(
                r#"{"t":"ready"}"#,
            ))
            .await
            .unwrap();
        while let Some(Ok(_)) = socket.next().await {}
    });
    let dir = temp_dir();
    let mut config = InProcess::config(dir.path());
    config.relay_url = url;
    let server = InProcess::start(config);
    let mut client = Client::ready(&server.socket).await;
    set_relay(&mut client, true).await;
    relay_status(&mut client, |s| s.connected).await;

    let older = client
        .call::<RelayCheck>(RelayCheckParams { token: None })
        .await
        .unwrap();
    assert_eq!(older.failed, Some(RelayCheckPart::Relay), "{older:?}");
    assert!(older.fix.unwrap().contains("relay needs updating"));
}

/// A computer whose Tailscale is stopped.
#[derive(Debug)]
struct Stopped;

impl plxd::tailnet::Tailnet for Stopped {
    fn status(
        &self,
    ) -> futures_util::future::BoxFuture<'_, Result<plxd::tailnet::Status, plxd::tailnet::NotRunning>>
    {
        Box::pin(async { Err(plxd::tailnet::NotRunning::Stopped("stopped".to_owned())) })
    }

    fn whois(
        &self,
        _: std::net::SocketAddr,
    ) -> futures_util::future::BoxFuture<'_, Result<plxd::tailnet::Whois, String>> {
        Box::pin(async { Err("stopped".to_owned()) })
    }
}

/// One computer on the account: its plxd behind the relay, and a repository cloned from `origin`.
struct Computer {
    dir: tempfile::TempDir,
    port: u16,
    url: String,
    /// How often it pulls You memory.
    every: Duration,
    server: Option<InProcess>,
    client: Client,
    id: String,
}

impl Computer {
    fn config(
        dir: &std::path::Path,
        port: u16,
        url: &str,
        every: Duration,
    ) -> plxd::server::Config {
        let mut config = InProcess::config(dir);
        // Tailscale is stopped: only the relay joins the two.
        config.tailnet = Some(Arc::new(Stopped));
        config.you_sync_interval = every;
        config.remote_address = Some(LOOPBACK);
        config.remote_port = port;
        url.clone_into(&mut config.relay_url);
        config.backends = Some(fake(vec![
            init("work"),
            Step::EchoPrompt,
            Step::SleepMs(3000),
            end_turn("Done there."),
        ]));
        config
    }

    /// A computer named `name`, registered with `token` and connected to the relay at `url`.
    async fn start(name: &str, url: &str, token: &str) -> Self {
        Self::start_syncing(name, url, token, Duration::from_mins(1)).await
    }

    /// As [`Computer::start`], pulling You memory `every`.
    async fn start_syncing(name: &str, url: &str, token: &str, every: Duration) -> Self {
        let (dir, port) = (temp_dir(), free_port());
        let server = InProcess::start(Self::config(dir.path(), port, url, every));
        let mut client = Client::ready(&server.socket).await;
        client
            .call::<HostSettingsSet>(HostSettingsSetParams {
                device_name: Some(name.to_owned()),
                ..HostSettingsSetParams::default()
            })
            .await
            .unwrap();
        set_remote(&mut client, true).await;
        wait_listening(port, true).await;
        let registered = client.call::<RelayRegister>(RelayRegisterParams {
            token: token.to_owned(),
            signed: None,
        });
        registered.await.unwrap();
        relay_status(&mut client, |s| s.connected).await;
        let id = client
            .call::<RelayId>(RelayIdParams {})
            .await
            .unwrap()
            .host_id;
        Self {
            dir,
            port,
            url: url.to_owned(),
            every,
            server: Some(server),
            client,
            id,
        }
    }

    async fn trust(&mut self, other: &str) {
        self.client
            .call::<AccessMerge>(AccessMergeParams {
                approved_hosts: vec![other.to_owned()],
                ..AccessMergeParams::default()
            })
            .await
            .unwrap();
    }

    async fn set_agent_work(&mut self, on: bool) {
        self.client
            .call::<HostSettingsSet>(HostSettingsSetParams {
                agent_work: Some(on),
                ..HostSettingsSetParams::default()
            })
            .await
            .unwrap();
    }

    async fn stop(&mut self) {
        self.server.take().unwrap().stop().await;
    }

    /// Starts plxd again on the same data folder.
    async fn start_again(&mut self) {
        let server = InProcess::start(Self::config(
            self.dir.path(),
            self.port,
            &self.url,
            self.every,
        ));
        self.client = Client::ready(&server.socket).await;
        self.server = Some(server);
        relay_status(&mut self.client, |s| s.connected).await;
    }

    /// Whether `run`'s transcript has a message holding `text`, once it does.
    async fn message_with(&mut self, run: RunId, text: &str) {
        let deadline = Instant::now() + 3 * PATIENCE;
        loop {
            let events = self
                .client
                .call::<AgentEvents>(AgentEventsParams {
                    before: None,
                    run_id: run,
                    after: 0,
                    limit: Some(1000),
                })
                .await
                .unwrap()
                .events;
            let found = events.iter().any(|logged| match &logged.event {
                ParallaxEvent::AgentOutput { items, .. } => items.iter().any(|item| {
                    matches!(item, AgentOutputItem::TurnStarted { text: Some(said), .. }
                        if said.contains(text))
                }),
                _ => false,
            });
            if found {
                return;
            }
            assert!(
                Instant::now() < deadline,
                "no message with {text:?}: {events:?}"
            );
            sleep(Duration::from_millis(100)).await;
        }
    }
}

/// `linked_computers`' entry for the computer `id`.
async fn linked(mcp: &mut Mcp, id: &str) -> Value {
    let listed = mcp.ok("linked_computers", json!({})).await;
    let computers = listed["computers"].as_array().unwrap();
    let found = computers.iter().find(|computer| computer["id"] == id);
    found.unwrap_or_else(|| panic!("{listed}")).clone()
}

/// Two plxds on one account, through the relay with only their host keys (0101): what an agent
/// sees with `agentWork` off, without the repository, and with both, a task on the other computer
/// that wakes its parent across a restart of the caller, and the thread tools' `computer`.
#[tokio::test]
#[expect(clippy::too_many_lines, reason = "one walk across two computers")]
async fn an_agent_works_on_another_computer_through_the_relay() {
    let (Ok(url), Ok(token)) = (
        std::env::var("PLXD_TEST_RELAY_URL"),
        std::env::var("PLXD_TEST_RELAY_PEERS_TOKEN"),
    ) else {
        return;
    };
    let mut here = Computer::start("Here", &url, &token).await;
    let mut there = Computer::start("There", &url, &token).await;
    let (here_id, there_id) = (here.id.clone(), there.id.clone());

    // One repository, pushed to an origin, on the caller.
    let repos = temp_dir();
    let origin = repos.path().join("origin.git");
    git(
        repos.path(),
        &[
            "init",
            "-q",
            "--bare",
            "--initial-branch=main",
            "origin.git",
        ],
    );
    let repo = real_repo(repos.path());
    let origin_url = origin.to_str().unwrap();
    git(&repo, &["remote", "add", "origin", origin_url]);
    git(&repo, &["push", "-q", "origin", "main"]);
    let entry = here
        .client
        .call::<parallax_protocol::methods::RepoAdd>(parallax_protocol::RepoAddParams {
            id: parallax_protocol::RepoId::generate(),
            path: repo.to_str().unwrap().to_owned(),
        })
        .await
        .unwrap()
        .repo;
    let caller = here
        .client
        .call::<ThreadStart>(start_params(Some(entry.id), "Plan the work."))
        .await
        .unwrap()
        .run
        .id;
    let mut mcp = Mcp::spawn(mcp_command(
        here.dir.path(),
        &["--thread", &caller.to_string()],
    ))
    .await;
    let task = json!({"task": "Do the work.", "target": {"computer": there_id}});

    // The caller refuses until it approved the other computer itself.
    let (said, failed) = mcp.tool("delegate_task", task.clone()).await;
    assert!(failed && said.contains("hasn't approved"), "{said}");
    here.trust(&there_id).await;

    // Approved here, but the other computer hasn't approved this one, and has `agentWork` off.
    let shown = linked(&mut mcp, &there_id).await;
    assert_eq!(shown["takesAgentWork"], false, "{shown}");
    assert!(shown["whyNot"].as_str().unwrap().contains("off"), "{shown}");
    let (said, failed) = mcp.tool("delegate_task", task.clone()).await;
    assert!(failed && said.contains("off"), "{said}");
    there.set_agent_work(true).await;
    relay_status(&mut there.client, |s| s.connected).await;
    let (said, failed) = mcp.tool("delegate_task", task.clone()).await;
    assert!(failed && said.contains("hasn't approved"), "{said}");
    there.trust(&here_id).await;

    // Now it takes work, but has no copy of the repository.
    let shown = linked(&mut mcp, &there_id).await;
    assert_eq!(shown["takesAgentWork"], true, "{shown}");
    assert!(
        shown["runningAgents"].is_number() && shown["load"].is_object(),
        "{shown}"
    );
    let (said, failed) = mcp.tool("delegate_task", task.clone()).await;
    assert!(failed && said.contains("no copy"), "{said}");
    let nothing = there
        .client
        .call::<AgentList>(AgentListParams { project: None });
    assert!(
        nothing.await.unwrap().runs.is_empty(),
        "nothing ran there yet"
    );
    let copy = repos.path().join("copy");
    let copied = copy.to_str().unwrap();
    git(repos.path(), &["clone", "-q", origin_url, copied]);
    let copy_entry = there
        .client
        .call::<parallax_protocol::methods::RepoAdd>(parallax_protocol::RepoAddParams {
            id: parallax_protocol::RepoId::generate(),
            path: copied.to_owned(),
        })
        .await
        .unwrap()
        .repo;

    // A task by the computer's name, running there and not here.
    let task = json!({"task": "Do the work.", "target": {"computer": "There"}});
    let started = mcp.ok("delegate_task", task).await;
    assert_eq!(started["computer"]["id"], there_id.as_str(), "{started}");
    let task_id = started["taskId"].as_str().unwrap().to_owned();
    let runs = there
        .client
        .call::<AgentList>(AgentListParams { project: None });
    let run = runs.await.unwrap().runs.into_iter().next().unwrap();
    assert_eq!(run.id.to_string(), task_id);
    assert!(
        run.prompt.contains("started by an agent on Here"),
        "{}",
        run.prompt
    );
    assert!(run.branch.is_some(), "a new worktree: {run:?}");

    // The caller dies between the start and the answer: its row brings the follower back, for a
    // thread that started and for one that never did.
    here.stop().await;
    let stored = parallax_store::Store::open(here.dir.path().join("plxd.sqlite3")).unwrap();
    let row = |id: uuid::Uuid, title: &str, created_at| parallax_store::RemoteRun {
        id,
        host_id: there_id.clone(),
        host_name: "There".to_owned(),
        parent: caller.into(),
        title: title.to_owned(),
        task: true,
        completion_wake: "always".to_owned(),
        delivery: "pending".to_owned(),
        status: "running".to_owned(),
        summary: None,
        reason: None,
        ended_at: None,
        created_at,
    };
    let never: RunId = RunId::generate();
    let long_ago = jiff::Timestamp::now() - jiff::SignedDuration::from_mins(10);
    assert!(
        stored
            .add_remote_run(&row(never.into(), "Never", long_ago))
            .unwrap()
    );
    let unknown: RunId = task_id.parse().unwrap();
    // Forget the real task's row, then record it as the crash left it: recorded, never answered.
    stored.delete_remote_run(unknown.into()).unwrap();
    let now = jiff::Timestamp::now();
    assert!(
        stored
            .add_remote_run(&row(unknown.into(), "Real", now))
            .unwrap()
    );
    drop(stored);
    here.start_again().await;
    here.message_with(caller, &format!("Delegated task {never}"))
        .await;
    here.message_with(caller, "never started").await;

    // The caller restarted during the task, and its end still wakes the parent.
    here.message_with(caller, &format!("Delegated task {task_id}"))
        .await;
    let status = mcp.ok("task_status", json!({"taskId": task_id})).await;
    assert_eq!(status["status"], "completed", "{status}");
    assert!(
        status["summary"].as_str().unwrap().contains("Done there"),
        "{status}"
    );

    // The thread tools take the computer too, and never fall back to this one.
    let listed = mcp.ok("thread_list", json!({"computer": there_id})).await;
    assert_eq!(listed["threads"].as_array().unwrap().len(), 1, "{listed}");
    let (read, failed) = mcp
        .tool(
            "thread_read",
            json!({"runId": task_id, "computer": there_id}),
        )
        .await;
    assert!(!failed && read.contains("Done there"), "{read}");
    let (said, failed) = mcp.tool("thread_read", json!({"runId": task_id})).await;
    assert!(failed && said.contains("no thread"), "{said}");
    let launched = mcp
        .ok(
            "thread_launch",
            json!({"prompt": "More work.", "computer": there_id, "backend": "fake"}),
        )
        .await;
    let thread = launched["runId"].as_str().unwrap().to_owned();
    mcp.ok(
        "thread_wait",
        json!({"runId": thread, "computer": there_id, "timeoutSeconds": 20}),
    )
    .await;
    here.message_with(caller, &format!("Run {thread}")).await;
    let sent = json!({"runId": thread, "computer": there_id, "text": "And this."});
    mcp.ok("thread_send", sent).await;
    let there_run: RunId = thread.parse().unwrap();
    there.message_with(there_run, "From an agent on Here").await;
    mcp.ok(
        "thread_interrupt",
        json!({"runId": thread, "computer": there_id}),
    )
    .await;

    // A message can't drive a thread there that needs less approval than the caller.
    let bypass = there
        .client
        .call::<ThreadStart>(parallax_protocol::ThreadStartParams {
            permission: Some(parallax_protocol::AgentPermission::Bypass),
            ..start_params(Some(copy_entry.id), "Without asking.")
        })
        .await
        .unwrap()
        .run
        .id;
    let sent = json!({"runId": bypass.to_string(), "computer": there_id, "text": "Do this."});
    let (said, failed) = mcp.tool("thread_send", sent).await;
    assert!(failed && said.contains("needs less approval"), "{said}");

    // A branch pushed after the other computer cloned, which it has never fetched, is a base.
    git(&repo, &["branch", "first-push"]);
    git(&repo, &["push", "-q", "origin", "first-push"]);
    let launched = mcp
        .ok(
            "thread_launch",
            json!({
                "prompt": "From the new branch.",
                "computer": there_id,
                "backend": "fake",
                "base": "origin/first-push",
            }),
        )
        .await;
    assert!(launched["runId"].is_string(), "{launched}");

    // A thread in an orchestrator hands work there too, found by the orchestrator's repository.
    let orchestrator = parallax_protocol::OrchestratorCreateParams {
        repo_path: Some(repo.to_str().unwrap().to_owned()),
        id: parallax_protocol::ScopeId::generate(),
        name: "app".to_owned(),
        icon: None,
        permission: None,
        autonomy: None,
        base_branch: None,
    };
    let orchestrator = here
        .client
        .call::<OrchestratorCreate>(orchestrator)
        .await
        .unwrap()
        .orchestrator
        .id;
    let lead = here
        .client
        .call::<ThreadStart>(parallax_protocol::ThreadStartParams {
            orchestrator: Some(orchestrator),
            ..start_params(None, "Lead the work.")
        })
        .await
        .unwrap()
        .run
        .id;
    let mut lead_mcp = Mcp::spawn(mcp_command(
        here.dir.path(),
        &["--thread", &lead.to_string()],
    ))
    .await;
    let task = json!({"task": "A child's work.", "target": {"computer": there_id}});
    let child = lead_mcp.ok("delegate_task", task).await;
    assert_eq!(child["computer"]["id"], there_id.as_str(), "{child}");
    let child: RunId = child["taskId"].as_str().unwrap().parse().unwrap();
    let runs = there
        .client
        .call::<AgentList>(AgentListParams { project: None });
    let run = runs
        .await
        .unwrap()
        .runs
        .into_iter()
        .find(|run| run.id == child);
    let run = run.expect("the child runs there");
    assert!(run.prompt.contains("A child's work."), "{}", run.prompt);
    assert!(
        run.worktree_path.unwrap().contains("copy"),
        "in There's copy"
    );
    here.message_with(lead, &format!("Delegated task {child}"))
        .await;

    // Off closes the session, and the next call says why.
    there.set_agent_work(false).await;
    let sessions = there.client.call::<RemoteSessions>(RemoteSessionsParams {});
    assert!(sessions.await.unwrap().sessions.is_empty());
    let deadline = Instant::now() + PATIENCE;
    loop {
        let (said, failed) = mcp.tool("thread_list", json!({"computer": there_id})).await;
        if failed && said.contains("off") {
            break;
        }
        assert!(Instant::now() < deadline, "{said}");
        sleep(Duration::from_millis(200)).await;
    }

    for id in [here_id, there_id] {
        let removed = here.client.call::<RelayRemove>(RelayRemoveParams {
            token: token.clone(),
            host_id: id,
        });
        removed.await.unwrap();
    }
}

/// You memory between two computers through the relay, with Tailscale stopped on both (PLX-1362):
/// nothing comes from a computer that hasn't approved the one pulling, and once it has, an entry
/// written on it arrives, recorded under its relay id.
#[tokio::test]
async fn you_memory_syncs_through_the_relay_with_tailscale_stopped() {
    let (Ok(url), Ok(token)) = (
        std::env::var("PLXD_TEST_RELAY_URL"),
        std::env::var("PLXD_TEST_RELAY_SYNC_TOKEN"),
    ) else {
        return;
    };
    let every = Duration::from_secs(2);
    let mut here = Computer::start_syncing("Here", &url, &token, every).await;
    let mut there = Computer::start_syncing("There", &url, &token, every).await;
    let (here_id, there_id) = (here.id.clone(), there.id.clone());
    for computer in [&mut here, &mut there] {
        computer.set_agent_work(true).await;
        relay_status(&mut computer.client, |s| s.connected).await;
    }
    write(&mut here.client, TABS, "Tabs", "Use tabs.").await;

    // There approved Here, but Here hasn't approved There, so Here gives it nothing, and says why
    // to There's own client of it, the one its pulls use.
    there.trust(&here_id).await;
    sleep(every * 3).await;
    assert_eq!(body(&mut there.client, TABS).await, None);
    let listed = there.client.call::<PeerComputers>(PeerComputersParams {});
    let listed = listed.await.unwrap().computers;
    let shown = listed
        .iter()
        .find(|computer| computer.id == here_id)
        .unwrap();
    let why = shown.why_not.as_deref().unwrap_or_default();
    assert!(why.contains("hasn't approved"), "{shown:?}");

    // Once it has, the entry arrives after There's wait for a computer that refused it.
    here.trust(&there_id).await;
    let deadline = Instant::now() + every * 10 + PATIENCE;
    while body(&mut there.client, TABS).await.as_deref() != Some("Use tabs.") {
        assert!(Instant::now() < deadline, "the entry never reached There");
        sleep(Duration::from_millis(200)).await;
    }
    let files = list(&mut there.client).await;
    let file = files.iter().find(|file| file.path == TABS).unwrap();
    let machine = file.machine.clone().unwrap();
    assert_eq!(
        (machine.id, machine.name),
        (here_id.clone(), "Here".to_owned())
    );

    for id in [here_id, there_id] {
        let removed = here.client.call::<RelayRemove>(RelayRemoveParams {
            token: token.clone(),
            host_id: id,
        });
        removed.await.unwrap();
    }
}

/// How many connections the relay benchmark times.
const BENCH_RUNS: usize = 7;

/// The median of `values`, in milliseconds.
fn median(mut values: Vec<f64>) -> f64 {
    values.sort_by(f64::total_cmp);
    values[values.len() / 2]
}

/// Connect time and time to the first streamed event through the relay (0091, PLX-1167): from the
/// start of a dial over `relay:<hostId>` to an open `/ws`, and to the first `events/event` of a
/// subscription opened over it. Fails past the `relay` set in scripts/bench/budgets.json, by the
/// median of [`BENCH_RUNS`] connections, each after the spare stream had time to open.
#[tokio::test]
async fn connecting_through_the_relay_stays_within_its_budget() {
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
    let server = InProcess::start(config);
    let mut client = Client::ready(&server.socket).await;
    set_remote(&mut client, true).await;
    wait_listening(port, true).await;
    let registered = client.call::<RelayRegister>(RelayRegisterParams {
        token: token.clone(),
        signed: None,
    });
    registered.await.unwrap();
    let status = relay_status(&mut client, |s| s.connected).await;
    let route = format!(
        "relay:{}",
        status.hook_url.unwrap().rsplit('/').next().unwrap()
    );
    relay::sign_in(url.clone(), token.clone());
    let code = new_code(&mut client).await;
    let phone = temp_dir();
    let routes = std::slice::from_ref(&route);
    let paired = remote::pair(routes, &code, "phone", phone.path())
        .await
        .unwrap();
    // A host-level event for the subscription to replay.
    let orchestrator = crate::agents::orchestrator_params(dir.path());
    client
        .call::<OrchestratorCreate>(orchestrator)
        .await
        .unwrap();

    let subscribe = r#"{"jsonrpc":"2.0","id":2,"method":"events/subscribe","params":{"after":0}}"#;
    let (mut connect, mut first_event) = (Vec::new(), Vec::new());
    for _ in 0..BENCH_RUNS {
        // The app connects long after plxd opened its spare stream.
        sleep(Duration::from_millis(500)).await;
        let started = Instant::now();
        let dialed = remote::dial(routes, &paired.fingerprint, phone.path())
            .await
            .unwrap();
        assert_eq!(dialed.route, route);
        connect.push(started.elapsed().as_secs_f64() * 1000.0);
        let mut app = App::bridged(dialed.socket);
        assert!(app.initialize().await["result"].is_object());
        app.send(subscribe).await;
        while !app.next().await.contains(r#""method":"events/event""#) {}
        first_event.push(started.elapsed().as_secs_f64() * 1000.0);
    }
    let measured = serde_json::json!({
        "connectMs": { "p50": median(connect.clone()), "all": connect },
        "firstEventMs": { "p50": median(first_event.clone()), "all": first_event },
    });
    eprintln!("relay benchmark: {measured}");
    let budgets =
        std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../scripts/bench/budgets.json");
    let budgets: serde_json::Value =
        serde_json::from_slice(&std::fs::read(budgets).unwrap()).unwrap();
    let max = budgets["relay"]["max"]
        .as_object()
        .expect("a relay budget set");
    for (path, budget) in max {
        let (metric, stat) = path.split_once('.').unwrap();
        let value = measured[metric][stat]
            .as_f64()
            .unwrap_or_else(|| panic!("no {path}"));
        assert!(
            value <= budget.as_f64().unwrap(),
            "{path} is {value:.1}, over its {budget}"
        );
    }
    server.stop().await;
}

/// A proxy between plxd and the local relay that fails links the ways a network does: it cuts
/// plxd's control connection alone, refuses new ones, silences connections, leaving them open, or
/// slows plxd's streams.
/// A client goes to the relay directly, so only plxd's link fails.
struct Proxy {
    url: String,
    shared: Arc<ProxyShared>,
}

#[derive(Default)]
struct ProxyShared {
    /// How many control connections plxd has opened.
    controls: AtomicUsize,
    refusing: AtomicBool,
    silent: AtomicBool,
    /// How many connections plxd has opened of any kind.
    connections: AtomicUsize,
    /// Streams among the first this many connections are silent, and any opened after aren't.
    silent_streams: AtomicUsize,
    cut: Notify,
    /// How many milliseconds later than the control connection's plxd's bytes on a stream reach
    /// the relay, as when that socket's path is slower.
    stream_lag_ms: AtomicU64,
    /// The text and close frames that crossed, in the order the proxy read them.
    frames: std::sync::Mutex<Vec<Seen>>,
}

/// One WebSocket frame the proxy read: when, on which stream (none for control), which way, and
/// its opcode and unmasked payload.
#[derive(Clone, Debug)]
struct Seen {
    at: Instant,
    stream: Option<String>,
    from_plxd: bool,
    opcode: u8,
    payload: Vec<u8>,
}

/// Reads one direction of a proxied connection as WebSocket frames, after its HTTP head, and keeps
/// its text and close frames in [`ProxyShared::frames`].
struct Tap {
    shared: Arc<ProxyShared>,
    stream: Option<String>,
    from_plxd: bool,
    past_head: bool,
    buffer: Vec<u8>,
}

impl Tap {
    fn feed(&mut self, bytes: &[u8]) {
        self.buffer.extend_from_slice(bytes);
        if !self.past_head {
            let Some(at) = self.buffer.windows(4).position(|w| w == b"\r\n\r\n") else {
                return;
            };
            self.buffer.drain(..at + 4);
            self.past_head = true;
        }
        while let Some((opcode, payload, used)) = ws_frame(&self.buffer) {
            self.buffer.drain(..used);
            if matches!(opcode, 1 | 8) {
                self.shared.frames.lock().unwrap().push(Seen {
                    at: Instant::now(),
                    stream: self.stream.clone(),
                    from_plxd: self.from_plxd,
                    opcode,
                    payload,
                });
            }
        }
    }
}

/// The first whole WebSocket frame in `bytes`: its opcode, unmasked payload, and length.
fn ws_frame(bytes: &[u8]) -> Option<(u8, Vec<u8>, usize)> {
    let (first, second) = (*bytes.first()?, *bytes.get(1)?);
    let (mut len, mut at) = (usize::from(second & 0x7f), 2);
    if len == 126 {
        len = usize::from(u16::from_be_bytes(bytes.get(2..4)?.try_into().ok()?));
        at = 4;
    } else if len == 127 {
        len = usize::try_from(u64::from_be_bytes(bytes.get(2..10)?.try_into().ok()?)).ok()?;
        at = 10;
    }
    let mask: Option<[u8; 4]> = if second & 0x80 == 0 {
        None
    } else {
        at += 4;
        Some(bytes.get(at - 4..at)?.try_into().ok()?)
    };
    let mut payload = bytes.get(at..at + len)?.to_vec();
    if let Some(mask) = mask {
        for (i, byte) in payload.iter_mut().enumerate() {
            *byte ^= mask[i % 4];
        }
    }
    Some((first & 0x0f, payload, at + len))
}

impl Proxy {
    async fn start(relay: &str) -> Self {
        let relay = relay.strip_prefix("http://").unwrap().to_owned();
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let shared = Arc::new(ProxyShared::default());
        let carrying = Arc::clone(&shared);
        tokio::spawn(async move {
            while let Ok((plxd, _)) = listener.accept().await {
                tokio::spawn(carry(plxd, relay.clone(), Arc::clone(&carrying)));
            }
        });
        Self { url, shared }
    }

    fn controls(&self) -> usize {
        self.shared.controls.load(Ordering::SeqCst)
    }

    /// Waits for plxd to open another control connection after the `seen` it had.
    async fn control_after(&self, seen: usize) {
        let deadline = Instant::now() + Duration::from_mins(2);
        while self.controls() <= seen {
            assert!(Instant::now() < deadline, "plxd never opened another");
            sleep(Duration::from_millis(20)).await;
        }
    }

    /// Each stream plxd's end closed, with how long after plxd's close the relay's close came back
    /// through the proxy and its code, once each has one or 10 s passed.
    async fn answered_closes(&self) -> Vec<(String, Option<(Duration, Option<u16>)>)> {
        let deadline = Instant::now() + Duration::from_secs(10);
        loop {
            let frames = self.shared.frames.lock().unwrap().clone();
            let answers: Vec<_> = frames
                .iter()
                .filter(|frame| frame.from_plxd && frame.opcode == 8)
                .filter_map(|closed| {
                    let answer = frames.iter().find(|frame| {
                        !frame.from_plxd
                            && frame.opcode == 8
                            && frame.stream == closed.stream
                            && frame.at >= closed.at
                    });
                    let answer = answer.map(|answer| {
                        let code = answer
                            .payload
                            .get(..2)
                            .map(|c| u16::from_be_bytes([c[0], c[1]]));
                        (answer.at - closed.at, code)
                    });
                    Some((closed.stream.clone()?, answer))
                })
                .collect();
            if answers.iter().all(|(_, answer)| answer.is_some()) || Instant::now() >= deadline {
                return answers;
            }
            sleep(Duration::from_millis(20)).await;
        }
    }

    /// Whether plxd sent `gone` for `stream` on a control connection.
    fn told_gone(&self, stream: &str) -> bool {
        let named = format!(r#""stream":"{stream}""#);
        let frames = self.shared.frames.lock().unwrap();
        frames.iter().any(|frame| {
            frame.from_plxd
                && frame.stream.is_none()
                && frame.opcode == 1
                && String::from_utf8_lossy(&frame.payload).contains(&named)
        })
    }
}

/// One connection through a [`Proxy`]. Its request's first line says whether it's the control
/// connection. While silent, bytes wait in the socket's buffers, as they would being retransmitted.
async fn carry(plxd: TcpStream, relay: String, shared: Arc<ProxyShared>) {
    let number = shared.connections.fetch_add(1, Ordering::SeqCst);
    let mut head = [0; 512];
    let line = loop {
        let Ok(peeked) = plxd.peek(&mut head).await else {
            return;
        };
        let text = String::from_utf8_lossy(&head[..peeked]);
        if let Some((line, _)) = text.split_once("\r\n") {
            break line.to_owned();
        }
        sleep(Duration::from_millis(1)).await;
    };
    let control = line.contains("/host ");
    let stream = line
        .split_once("/streams/")
        .and_then(|(_, rest)| rest.split(['?', ' ']).next())
        .map(str::to_owned);
    let tap = |from_plxd| Tap {
        shared: Arc::clone(&shared),
        stream: stream.clone(),
        from_plxd,
        past_head: false,
        buffer: Vec::new(),
    };
    let (mut outward_tap, mut inward_tap) = (tap(true), tap(false));
    if control {
        shared.controls.fetch_add(1, Ordering::SeqCst);
        if shared.refusing.load(Ordering::SeqCst) {
            return;
        }
    }
    let Ok(relay) = TcpStream::connect(relay).await else {
        return;
    };
    let (mut plxd_in, mut plxd_out) = plxd.into_split();
    let (mut relay_in, mut relay_out) = relay.into_split();
    let cut = shared.cut.notified();
    let silent = || {
        shared.silent.load(Ordering::SeqCst)
            || (!control && number < shared.silent_streams.load(Ordering::SeqCst))
    };
    let lag = Duration::from_millis(if control {
        0
    } else {
        shared.stream_lag_ms.load(Ordering::SeqCst)
    });
    let outward = async {
        if lag.is_zero() {
            one_way(&mut plxd_in, &mut relay_out, &silent, &mut outward_tap).await;
        } else {
            lagging(&mut plxd_in, &mut relay_out, &silent, lag, &mut outward_tap).await;
        }
    };
    tokio::select! {
        () = cut, if control => {}
        () = outward => {}
        () = one_way(&mut relay_in, &mut plxd_out, &silent, &mut inward_tap) => {}
    }
}

/// [`one_way`], with each read arriving `lag` after it was read, in order.
async fn lagging(
    from: &mut OwnedReadHalf,
    to: &mut OwnedWriteHalf,
    silent: &impl Fn() -> bool,
    lag: Duration,
    tap: &mut Tap,
) {
    let (send, mut receive) = tokio::sync::mpsc::unbounded_channel::<(Instant, Vec<u8>)>();
    let reading = async move {
        let mut buffer = vec![0; 64 * 1024];
        loop {
            while silent() {
                sleep(Duration::from_millis(20)).await;
            }
            let Ok(read @ 1..) = from.read(&mut buffer).await else {
                return;
            };
            tap.feed(&buffer[..read]);
            let due = Instant::now() + lag;
            if send.send((due, buffer[..read].to_vec())).is_err() {
                return;
            }
        }
    };
    let writing = async move {
        while let Some((due, bytes)) = receive.recv().await {
            tokio::time::sleep_until(due).await;
            while silent() {
                sleep(Duration::from_millis(20)).await;
            }
            if to.write_all(&bytes).await.is_err() {
                return;
            }
        }
    };
    tokio::join!(reading, writing);
}

async fn one_way(
    from: &mut OwnedReadHalf,
    to: &mut OwnedWriteHalf,
    silent: &impl Fn() -> bool,
    tap: &mut Tap,
) {
    let mut buffer = vec![0; 64 * 1024];
    loop {
        while silent() {
            sleep(Duration::from_millis(20)).await;
        }
        let Ok(read @ 1..) = from.read(&mut buffer).await else {
            return;
        };
        tap.feed(&buffer[..read]);
        while silent() {
            sleep(Duration::from_millis(20)).await;
        }
        if to.write_all(&buffer[..read]).await.is_err() {
            return;
        }
    }
}

/// A computer with `remote` on, online through `proxy`: the server, its client, and its host id.
async fn online_through(
    dir: &std::path::Path,
    proxy: &Proxy,
    token: &str,
) -> (InProcess, Client, String) {
    let port = free_port();
    let mut config = InProcess::config(dir);
    config.remote_address = Some(LOOPBACK);
    config.remote_port = port;
    config.relay_url.clone_from(&proxy.url);
    let server = InProcess::start(config);
    let mut client = Client::ready(&server.socket).await;
    set_remote(&mut client, true).await;
    wait_listening(port, true).await;
    let registered = client.call::<RelayRegister>(RelayRegisterParams {
        token: token.to_owned(),
        signed: None,
    });
    registered.await.unwrap();
    let status = relay_status(&mut client, |s| s.connected).await;
    let hook_url = status.hook_url.unwrap();
    let host_id = hook_url.rsplit('/').next().unwrap().to_owned();
    (server, client, host_id)
}

/// How long plxd's control connection may take to notice a silent link: two of its 15 s pings, and
/// some room for a busy test machine.
const SILENCE_NOTICED: Duration = Duration::from_secs(35);

#[tokio::test]
async fn a_client_stream_carries_data_through_a_control_drop_and_a_silent_link_is_noticed() {
    let (Ok(url), Ok(token)) = (
        std::env::var("PLXD_TEST_RELAY_URL"),
        std::env::var("PLXD_TEST_RELAY_TOKEN"),
    ) else {
        return;
    };
    let proxy = Proxy::start(&url).await;
    let dir = temp_dir();
    let (server, mut client, host_id) = online_through(dir.path(), &proxy, &token).await;
    relay::sign_in(url.clone(), token.clone());
    let route = format!("relay:{host_id}");
    let code = new_code(&mut client).await;
    let phone = temp_dir();
    let routes = std::slice::from_ref(&route);
    let paired = remote::pair(routes, &code, "phone", phone.path())
        .await
        .unwrap();
    // The app's `initialize` waits on `plxd dial`'s input, so it goes behind the upgrade
    // (PLX-1483), and through the relay it's answered as one sent after the 101 is.
    let first = format!("{INITIALIZE}\n");
    let (mut app, over) = App::dialed_with(routes, &paired.fingerprint, phone.path(), &first)
        .await
        .unwrap();
    assert_eq!(over, route);
    let initialized: Value = serde_json::from_str(&app.next().await).unwrap();
    assert!(initialized["result"].is_object(), "{initialized}");
    assert!(answers(&mut app).await);

    // The control connection drops, and stays down for a while: the client's connection is the
    // same one all through, answering, or `answers` fails.
    proxy.shared.refusing.store(true, Ordering::SeqCst);
    let seen = proxy.controls();
    proxy.shared.cut.notify_waiters();
    relay_status(&mut client, |s| !s.connected).await;
    let down = Instant::now();
    while down.elapsed() < Duration::from_secs(4) {
        assert!(answers(&mut app).await, "the stream ended with control");
        sleep(Duration::from_millis(100)).await;
    }
    proxy.control_after(seen).await;
    proxy.shared.refusing.store(false, Ordering::SeqCst);
    relay_status(&mut client, |s| s.connected).await;
    assert!(answers(&mut app).await, "the relay closed a stream it kept");

    // A new client still gets in, with the kept spare or a new one.
    let dialed = remote::dial(routes, &paired.fingerprint, phone.path())
        .await
        .unwrap();
    let mut second = App::bridged(dialed.socket);
    assert!(second.initialize().await["result"].is_object());
    assert!(answers(&mut app).await);

    // A link gone silent: plxd finds out from its pings, with no close to tell it.
    proxy.shared.silent.store(true, Ordering::SeqCst);
    let silent = Instant::now();
    relay_status_within(&mut client, |s| !s.connected, SILENCE_NOTICED).await;
    eprintln!("a silent link was noticed in {:?}", silent.elapsed());
    proxy.shared.silent.store(false, Ordering::SeqCst);
    relay_status_within(&mut client, |s| s.connected, SILENCE_NOTICED).await;
    server.stop().await;
}

/// How long after a control connection fails plxd must have given up on a dead stream, and the
/// client must have heard: plxd's 10 s check, and some room for a busy test machine.
const DEAD_STREAM_TOLD: Duration = Duration::from_secs(13);

/// How much later than the control connection's plxd's bytes on a stream reach the relay while
/// the next test pairs.
const STREAM_LAG_MS: u64 = 100;

#[tokio::test]
async fn a_client_hears_its_stream_is_gone_and_a_redial_does_not_get_the_dead_spare() {
    let (Ok(url), Ok(token)) = (
        std::env::var("PLXD_TEST_RELAY_URL"),
        std::env::var("PLXD_TEST_RELAY_TOKEN"),
    ) else {
        return;
    };
    let proxy = Proxy::start(&url).await;
    let lag = &proxy.shared.stream_lag_ms;
    lag.store(STREAM_LAG_MS, Ordering::SeqCst);
    let dir = temp_dir();
    let (server, mut client, host_id) = online_through(dir.path(), &proxy, &token).await;
    relay::sign_in(url.clone(), token.clone());
    let route = format!("relay:{host_id}");
    let code = new_code(&mut client).await;
    let phone = temp_dir();
    let routes = std::slice::from_ref(&route);
    // Each pairing request has a stream of its own, which plxd's end closes once it answered. With
    // `gone` faster than the stream, the relay must still pass on the answer first (PLX-1456).
    let paired = remote::pair(routes, &code, "phone", phone.path())
        .await
        .unwrap();
    lag.store(0, Ordering::SeqCst);
    // The relay answers each of those closes with its own, in well under the 10 s plxd waits for
    // one, so those streams get no `gone` and don't hold a place for long.
    let closes = proxy.answered_closes().await;
    assert!(closes.len() >= 2, "{closes:?}");
    sleep(Duration::from_millis(500)).await;
    for (stream, answer) in closes {
        let (waited, code) = answer.expect("the relay answered plxd's close");
        eprintln!("the relay answered plxd's close in {waited:?}, with {STREAM_LAG_MS} ms of lag");
        assert_eq!(code, Some(1000));
        assert!(waited < Duration::from_secs(1), "{waited:?}");
        assert!(!proxy.told_gone(&stream), "a `gone` for {stream}");
    }
    let dialed = remote::dial(routes, &paired.fingerprint, phone.path())
        .await
        .unwrap();
    let mut app = App::bridged(dialed.socket);
    assert!(app.initialize().await["result"].is_object());
    assert!(answers(&mut app).await);
    // plxd asks for the next spare and joins it once the last is taken.
    sleep(Duration::from_secs(1)).await;

    // Every link plxd has to a stream dies, the spare's too, with no close for the relay to see.
    // The control connection fails, and a new one comes up at once.
    let connections = proxy.shared.connections.load(Ordering::SeqCst);
    proxy
        .shared
        .silent_streams
        .store(connections, Ordering::SeqCst);
    let seen = proxy.controls();
    let failed = Instant::now();
    proxy.shared.cut.notify_waiters();
    proxy.control_after(seen).await;
    relay_status(&mut client, |s| s.connected).await;

    // A redial right now gets a working stream, not the dead spare it would wait 10 s on.
    let redial = Instant::now();
    let dialed = remote::dial(routes, &paired.fingerprint, phone.path())
        .await
        .unwrap();
    let mut second = App::bridged(dialed.socket);
    assert!(second.initialize().await["result"].is_object());
    assert!(answers(&mut second).await);
    eprintln!("a redial after the failure took {:?}", redial.elapsed());
    assert!(
        redial.elapsed() < Duration::from_secs(5),
        "got the dead spare"
    );

    // The first client hears that plxd gave up on its stream, with no heartbeat of its own.
    assert!(
        app.closes_within(DEAD_STREAM_TOLD).await,
        "the client was never told"
    );
    eprintln!("the client was told after {:?}", failed.elapsed());
    assert!(
        failed.elapsed() <= DEAD_STREAM_TOLD,
        "{:?}",
        failed.elapsed()
    );
    assert!(answers(&mut second).await, "the new stream ended too");
    server.stop().await;
}

/// How many more connections reach a host over `route` before the relay refuses one, each kept
/// open. Each finishes TLS, since plxd's listener closes a connection that waits too long for it.
async fn open_until_refused(
    route: &str,
    paired: &remote::Paired,
    phone: &std::path::Path,
    open: &mut Vec<remote::Dialed>,
) -> usize {
    let before = open.len();
    let routes = [route.to_owned()];
    while let Ok(dialed) = remote::dial(&routes, &paired.fingerprint, phone).await {
        open.push(dialed);
    }
    open.len() - before
}

#[tokio::test]
async fn the_stream_cap_counts_right_across_a_control_drop() {
    let (Ok(url), Ok(token)) = (
        std::env::var("PLXD_TEST_RELAY_URL"),
        std::env::var("PLXD_TEST_RELAY_TOKEN"),
    ) else {
        return;
    };
    let proxy = Proxy::start(&url).await;
    let dir = temp_dir();
    let (server, mut client, host_id) = online_through(dir.path(), &proxy, &token).await;
    relay::sign_in(url.clone(), token.clone());
    let route = format!("relay:{host_id}");
    let code = new_code(&mut client).await;
    let phone = temp_dir();
    let routes = std::slice::from_ref(&route);
    let paired = remote::pair(routes, &code, "phone", phone.path())
        .await
        .unwrap();
    let mut open = Vec::new();
    let more = async |open: &mut Vec<remote::Dialed>| {
        open_until_refused(&route, &paired, phone.path(), open).await
    };
    // Pairing's own stream frees its place soon after it ends.
    let deadline = Instant::now() + PATIENCE;
    while open.len() < 16 {
        assert!(Instant::now() < deadline, "only {} opened", open.len());
        more(&mut open).await;
    }
    assert_eq!(more(&mut open).await, 0, "the cap is 16");

    let seen = proxy.controls();
    proxy.shared.cut.notify_waiters();
    proxy.control_after(seen).await;
    relay_status(&mut client, |s| s.connected).await;
    assert_eq!(more(&mut open).await, 0, "all 16 stayed");

    // Two go, and their places free, however many reconnects came between.
    open.truncate(14);
    let deadline = Instant::now() + PATIENCE;
    while open.len() < 16 {
        assert!(Instant::now() < deadline, "only {} opened", open.len());
        more(&mut open).await;
        sleep(Duration::from_millis(100)).await;
    }
    assert_eq!(more(&mut open).await, 0, "only those two freed");
    server.stop().await;
}
