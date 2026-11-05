//! Parallax Relay end to end (PLX-652, 0068): plxd behind a local relay (`wrangler dev`), a client
//! pairing and connecting through it with TLS to plxd's pinned certificate, and webhooks
//! forwarded with plxd's signature check and held while plxd is away.
//!
//! Runs only when `relay/scripts/e2e.mjs` starts a relay and passes its URL and a Clerk token in
//! `PLXD_TEST_RELAY_URL` and `PLXD_TEST_RELAY_TOKEN`. Elsewhere it passes without doing anything.

use std::time::Duration;

use parallax_protocol::jsonrpc::Message;
use parallax_protocol::methods::{
    AccessGet, AccessMerge, AccessRemove, HostAnnounceUpdate, HostSettingsGet, HostSettingsSet,
    OrchestratorCreate, RelayHosts, RelayRegister, RelayRemove, RelaySign, RemoteRevoke,
    RemoteSessions, ScheduleList, ScheduleSave,
};
use parallax_protocol::{
    AccessGetParams, AccessMergeParams, AccessRemoveParams, AccountChoice,
    HostAnnounceUpdateParams, HostSettingsGetParams, HostSettingsSetParams, RelayHostsParams,
    RelayRegisterParams, RelayRemoveParams, RelaySignParams, RelayStatus, RemoteRevokeParams,
    RemoteSessionsParams, Schedule, ScheduleListParams, ScheduleSaveParams, SignatureEncoding,
    WebhookSignature,
};
use plxd::{relay, remote};
use tokio::io::{AsyncReadExt as _, AsyncWriteExt as _};
use tokio::net::TcpStream;
use tokio::time::{Instant, sleep};

use crate::agents::fake;
use crate::connect::free_port;
use crate::remote::{App, LOOPBACK, new_code, open, open_account, set_remote, wait_listening};
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
