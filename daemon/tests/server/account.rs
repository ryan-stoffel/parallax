//! Account sign-in on the remote listener (0091): a client of this host's account is pinned by
//! the host id, gets a session only once its key is approved, a removed key never again, and a
//! setup code approves the device that types it, within its run limit.

use std::path::Path;

use parallax_protocol::methods::{
    AccessApprove, AccessDeny, AccessGet, AccessMerge, AccessRemove, AccessSetupCode,
    HostSettingsSet, RelayId, RelayRegister, RelaySign, RemoteRevoke, RemoteSessions,
};
use parallax_protocol::{
    AccessGetParams, AccessMergeParams, AccessRemoveParams, AccessRequestParams,
    AccessSetupCodeParams, HostSettingsSetParams, RelayIdParams, RelayRegisterParams,
    RelaySignParams, RemoteRevokeParams, RemoteSessionsParams,
};
use plxd::remote::{self, SignIn};
use ring::rand::SystemRandom;
use ring::rsa::{KeyPair, PublicKeyComponents};
use serde_json::json;
use tokio::io::{AsyncReadExt as _, AsyncWriteExt as _};
use tokio::net::TcpListener;

use crate::connect::free_port;
use crate::remote::{LOOPBACK, https, set_remote, wait_listening};
use crate::support::{Client, InProcess, temp_dir};

const USER: &str = "user_1";

fn clerk_key() -> KeyPair {
    KeyPair::from_der(include_bytes!("../fixtures/clerk-test-key.der")).unwrap()
}

/// Serves the test key as a Clerk instance's JWKS on loopback, and answers with its issuer.
async fn clerk() -> String {
    let listener = TcpListener::bind((LOOPBACK, 0)).await.unwrap();
    let issuer = format!("http://{}", listener.local_addr().unwrap());
    let public: PublicKeyComponents<Vec<u8>> = clerk_key().public().into();
    let jwks = json!({ "keys": [{
        "kty": "RSA", "kid": "k1", "n": remote::base64url(&public.n), "e": remote::base64url(&public.e),
    }] })
    .to_string();
    tokio::spawn(async move {
        while let Ok((mut stream, _)) = listener.accept().await {
            let mut request = [0; 4096];
            let _ = stream.read(&mut request).await;
            let answer = format!(
                "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{jwks}",
                jwks.len()
            );
            let _ = stream.write_all(answer.as_bytes()).await;
        }
    });
    issuer
}

/// A fresh session token of `user` from the Clerk instance at `issuer`.
fn token(issuer: &str, user: &str) -> String {
    token_at(issuer, user, remote::now_seconds())
}

/// A session token of `user` from the Clerk instance at `issuer`, issued at `now`.
fn token_at(issuer: &str, user: &str, now: i64) -> String {
    let header = json!({ "alg": "RS256", "kid": "k1" });
    let claims = json!({ "iss": issuer, "sub": user, "sid": "sess", "iat": now, "exp": now + 600 });
    let input = format!(
        "{}.{}",
        remote::base64url(header.to_string().as_bytes()),
        remote::base64url(claims.to_string().as_bytes())
    );
    let key = clerk_key();
    let mut signature = vec![0; key.public().modulus_len()];
    key.sign(
        &ring::signature::RSA_PKCS1_SHA256,
        &SystemRandom::new(),
        input.as_bytes(),
        &mut signature,
    )
    .unwrap();
    format!("{input}.{}", remote::base64url(&signature))
}

/// A host's config: its listener on loopback `port`, the relay at `relay`, trusting `issuer`.
fn config(dir: &Path, issuer: &str, relay: &str, port: u16) -> plxd::server::Config {
    let mut config = InProcess::config(dir);
    config.remote_address = Some(LOOPBACK);
    config.remote_port = port;
    relay.clone_into(&mut config.relay_url);
    config.clerk = plxd::clerk::Config {
        issuer: issuer.to_owned(),
        client_ids: Vec::new(),
        authorized_parties: Vec::new(),
    };
    config
}

/// A host with `relay` and `remote` on, signed in to [`USER`]'s account, trusting `issuer`: the
/// server, a client on its socket, its route, and its host id.
async fn host(dir: &Path, issuer: &str) -> (InProcess, Client, String, String) {
    // Nothing answers here, so no relay is reached.
    host_at(config(dir, issuer, "http://127.0.0.1:9", free_port())).await
}

/// [`host`], from `config`.
async fn host_at(config: plxd::server::Config) -> (InProcess, Client, String, String) {
    let port = config.remote_port;
    let server = InProcess::start(config);
    let mut client = Client::ready(&server.socket).await;
    // The signing computer's app names the account; the relay never does.
    let signed = client
        .call::<RelaySign>(RelaySignParams {
            token_hash: "hash".to_owned(),
            user_id: Some(USER.to_owned()),
        })
        .await
        .unwrap();
    let id = client.call::<RelayId>(RelayIdParams {}).await.unwrap();
    assert_eq!(id.host_id, signed.host_id);
    set_remote(&mut client, true).await;
    wait_listening(port, true).await;
    (server, client, format!("127.0.0.1:{port}"), id.host_id)
}

async fn set_relay(client: &mut Client, on: bool) {
    client
        .call::<HostSettingsSet>(HostSettingsSetParams {
            relay: Some(on),
            ..HostSettingsSetParams::default()
        })
        .await
        .unwrap();
}

async fn access(client: &mut Client) -> parallax_protocol::AccessState {
    client
        .call::<AccessGet>(AccessGetParams::default())
        .await
        .unwrap()
}

fn thumbprint(dir: &Path) -> String {
    remote::device_key(dir).unwrap().thumbprint()
}

/// Signs in to `host_id` with a fresh token of `user`, as `name`, from the computer whose data
/// folder is `dir`.
async fn sign_in(
    issuer: &str,
    routes: &[String],
    host_id: &str,
    user: &str,
    name: &str,
    dir: &Path,
) -> Result<(String, SignIn), remote::Error> {
    remote::sign_in(routes, host_id, &token(issuer, user), name, dir).await
}

/// `POST /api/auth/account` at `route` with `token`, from a new key: its status and why.
async fn post_account(route: &str, token: &str) -> (u16, String) {
    let port: u16 = route.rsplit(':').next().unwrap().parse().unwrap();
    let key = remote::DpopKey::generate();
    let path = "/api/auth/account";
    let proof = key.proof("POST", &format!("https://{route}{path}"), Some(token));
    let body = json!({ "token": token, "clientLabel": "x" }).to_string();
    let (status, _, answer) = https(port, "POST", path, &[("DPoP", &proof)], &body).await;
    let answer: serde_json::Value = serde_json::from_slice(&answer).unwrap();
    let why = answer["error_description"].as_str().unwrap_or_default();
    (status, why.to_owned())
}

/// A relay on loopback that answers every request with `answer`.
async fn fake_relay(answer: String) -> String {
    let listener = TcpListener::bind((LOOPBACK, 0)).await.unwrap();
    let url = format!("http://{}", listener.local_addr().unwrap());
    tokio::spawn(async move {
        while let Ok((mut stream, _)) = listener.accept().await {
            let mut request = [0; 8192];
            let _ = stream.read(&mut request).await;
            let _ = stream.write_all(answer.as_bytes()).await;
        }
    });
    url
}

#[tokio::test]
async fn relay_id_reports_the_routes_the_descriptor_does() {
    let issuer = clerk().await;
    let dir = temp_dir();
    let (server, mut client, route, host_id) = host(dir.path(), &issuer).await;
    let id = client.call::<RelayId>(RelayIdParams {}).await.unwrap();
    assert_eq!(id.host_id, host_id);
    assert_eq!(id.routes, std::slice::from_ref(&route));
    let port = route.rsplit_once(':').unwrap().1.parse().unwrap();
    let (status, _, body) = https(port, "GET", "/.well-known/parallax", &[], "").await;
    assert_eq!(status, 200);
    let descriptor: serde_json::Value = serde_json::from_slice(&body).unwrap();
    assert_eq!(descriptor["routes"], json!(id.routes));
    server.stop().await;
}

#[tokio::test]
async fn a_signed_in_device_is_approved_once_and_a_removed_one_never_again() {
    let issuer = clerk().await;
    let dir = temp_dir();
    let (server, mut client, route, host_id) = host(dir.path(), &issuer).await;
    let routes = [route.clone()];
    let phone = temp_dir();
    let tablet = temp_dir();
    assert_eq!(access(&mut client).await.account.as_deref(), Some(USER));

    // Another key answering for this id is refused before anything is sent.
    let other_id = "A".repeat(43);
    let pinned = sign_in(&issuer, &routes, &other_id, USER, "phone", phone.path()).await;
    assert!(matches!(pinned, Err(remote::Error::WrongHost)), "pinned");
    assert!(matches!(
        remote::dial_account(&routes, &other_id, phone.path()).await,
        Err(remote::Error::Refused | remote::Error::WrongHost)
    ));

    // Another account's token, a stale one, and any token while `relay` is off, get nothing.
    let stranger = sign_in(&issuer, &routes, &host_id, "user_2", "x", phone.path()).await;
    assert!(matches!(stranger, Err(remote::Error::Refused)));
    let stranger = post_account(&route, &token(&issuer, "user_2")).await;
    assert_eq!(stranger, (401, "a token for another account".to_owned()));
    let old = token_at(&issuer, USER, remote::now_seconds() - 400);
    let old = post_account(&route, &old).await;
    assert_eq!(old, (401, "a token issued too long ago".to_owned()));
    set_relay(&mut client, false).await;
    let unlinked = sign_in(&issuer, &routes, &host_id, USER, "x", phone.path()).await;
    assert!(matches!(unlinked, Err(remote::Error::Refused)));
    let unlinked = post_account(&route, &token(&issuer, USER)).await;
    let off = "Reach from anywhere is off on this computer".to_owned();
    assert_eq!(unlinked, (403, off));
    set_relay(&mut client, true).await;

    // A new key gets a request, not a session, and both ends show its code.
    let (_, signed_in) = sign_in(&issuer, &routes, &host_id, USER, "phone", phone.path())
        .await
        .unwrap();
    let SignIn::Pending { request, code } = signed_in else {
        panic!("a new device waits: {signed_in:?}");
    };
    let pending = access(&mut client).await.pending.expect("a request");
    assert_eq!(
        (pending.name.as_str(), pending.code.as_deref()),
        ("phone", Some(code.as_str()))
    );
    assert!(matches!(
        remote::dial_account(&routes, &host_id, phone.path()).await,
        Err(remote::Error::Refused)
    ));
    // It holds the only place: another device can't push it out.
    let second = sign_in(&issuer, &routes, &host_id, USER, "tablet", tablet.path()).await;
    assert!(matches!(second, Err(remote::Error::Refused)));

    // Approved on one of the user's devices, the phone gets its session.
    let waiting = {
        let (route, request, dir) = (route.clone(), request.clone(), phone.path().to_owned());
        let host_id = host_id.clone();
        tokio::spawn(async move { remote::await_approval(&route, &host_id, &request, &dir).await })
    };
    let approved = client
        .call::<AccessApprove>(AccessRequestParams { request })
        .await
        .unwrap();
    assert_eq!(approved.approved_clients, [thumbprint(phone.path())]);
    assert!(matches!(
        waiting.await.unwrap(),
        Ok(SignIn::Approved { .. })
    ));
    let mut app = crate::remote::open_account(&routes, &host_id, phone.path())
        .await
        .unwrap();
    assert!(app.initialize().await["result"].is_object());
    // An approved key signs in again with no step.
    let again = sign_in(&issuer, &routes, &host_id, USER, "phone", phone.path()).await;
    assert!(matches!(again, Ok((_, SignIn::Approved { .. }))));

    // Removed, its sessions end, and no merge approves it again.
    let phone_key = thumbprint(phone.path());
    client
        .call::<AccessRemove>(AccessRemoveParams {
            thumbprint: phone_key.clone(),
        })
        .await
        .unwrap();
    assert!(app.closes().await, "its socket closed");
    assert!(matches!(
        remote::dial_account(&routes, &host_id, phone.path()).await,
        Err(remote::Error::Refused)
    ));
    let state = client
        .call::<AccessMerge>(AccessMergeParams {
            approved_clients: vec![phone_key.clone()],
            ..AccessMergeParams::default()
        })
        .await
        .unwrap();
    assert!(state.approved_clients.is_empty(), "{state:?}");
    assert_eq!(state.removed_clients, [phone_key]);
    let refused = sign_in(&issuer, &routes, &host_id, USER, "phone", phone.path()).await;
    assert!(matches!(refused, Err(remote::Error::Refused)));

    // The used-up request freed its place.
    let tablet_in = sign_in(&issuer, &routes, &host_id, USER, "tablet", tablet.path()).await;
    assert!(matches!(tablet_in, Ok((_, SignIn::Pending { .. }))));
    server.stop().await;
}

#[tokio::test]
async fn a_setup_code_approves_the_device_that_types_it_within_five_runs_an_hour() {
    let issuer = clerk().await;
    let dir = temp_dir();
    let (server, mut client, route, host_id) = host(dir.path(), &issuer).await;
    let routes = [route];
    let laptop = temp_dir();
    let new_code = async |client: &mut Client| {
        let setup = client
            .call::<AccessSetupCode>(AccessSetupCodeParams {})
            .await
            .unwrap();
        assert_eq!(setup.code.len(), remote::DIGITS, "{}", setup.code);
        setup.code
    };
    let wrong = |code: &str| if code == "000000" { "000001" } else { "000000" }.to_owned();

    // The right code approves the key that typed it, and the terminal learns its name.
    let code = new_code(&mut client).await;
    remote::pair_account(&routes, &host_id, &code, "laptop", laptop.path())
        .await
        .unwrap();
    let state = access(&mut client).await;
    assert_eq!(state.setup_approved.as_deref(), Some("laptop"));
    assert_eq!(state.approved_clients, [thumbprint(laptop.path())]);
    let mut app = crate::remote::open_account(&routes, &host_id, laptop.path())
        .await
        .unwrap();
    assert!(app.initialize().await["result"].is_object());

    // Each run is one guess, and five runs an hour is all, whatever the code.
    let code = new_code(&mut client).await;
    for _ in 0..3 {
        let guess =
            remote::pair_account(&routes, &host_id, &wrong(&code), "x", laptop.path()).await;
        assert!(matches!(guess, Err(remote::Error::Refused)));
    }
    let code = new_code(&mut client).await;
    let guess = remote::pair_account(&routes, &host_id, &wrong(&code), "x", laptop.path()).await;
    assert!(matches!(guess, Err(remote::Error::Refused)));
    let right = remote::pair_account(&routes, &host_id, &code, "x", laptop.path());
    assert!(
        matches!(right.await, Err(remote::Error::Refused)),
        "the sixth run this hour"
    );
    server.stop().await;
}

#[tokio::test]
async fn a_removal_beats_an_approval_not_yet_used_and_revoking_a_session_removes_its_key() {
    let issuer = clerk().await;
    let dir = temp_dir();
    let (server, mut client, route, host_id) = host(dir.path(), &issuer).await;
    let routes = [route.clone()];
    let phone = temp_dir();

    // Approved, then removed before the phone's next step: no session.
    let (_, signed_in) = sign_in(&issuer, &routes, &host_id, USER, "phone", phone.path())
        .await
        .unwrap();
    let SignIn::Pending { request, .. } = signed_in else {
        panic!("{signed_in:?}");
    };
    client
        .call::<AccessApprove>(AccessRequestParams {
            request: request.clone(),
        })
        .await
        .unwrap();
    client
        .call::<AccessRemove>(AccessRemoveParams {
            thumbprint: thumbprint(phone.path()),
        })
        .await
        .unwrap();
    let late = remote::await_approval(&route, &host_id, &request, phone.path()).await;
    assert!(matches!(late, Err(remote::Error::Refused)), "{late:?}");
    assert!(access(&mut client).await.pending.is_none());

    // Revoking an approved device's session removes its key, so it can't sign straight back in.
    let tablet = temp_dir();
    let (_, signed_in) = sign_in(&issuer, &routes, &host_id, USER, "tablet", tablet.path())
        .await
        .unwrap();
    let SignIn::Pending { request, .. } = signed_in else {
        panic!("{signed_in:?}");
    };
    let waiting = {
        let (route, request, dir) = (route.clone(), request.clone(), tablet.path().to_owned());
        let host_id = host_id.clone();
        tokio::spawn(async move { remote::await_approval(&route, &host_id, &request, &dir).await })
    };
    client
        .call::<AccessApprove>(AccessRequestParams { request })
        .await
        .unwrap();
    assert!(matches!(
        waiting.await.unwrap(),
        Ok(SignIn::Approved { .. })
    ));
    let sessions = client
        .call::<RemoteSessions>(RemoteSessionsParams {})
        .await
        .unwrap()
        .sessions;
    let session = sessions.iter().find(|s| s.name == "tablet").unwrap();
    client
        .call::<RemoteRevoke>(RemoteRevokeParams {
            id: session.id.clone(),
        })
        .await
        .unwrap();
    let state = access(&mut client).await;
    assert!(state.removed_clients.contains(&thumbprint(tablet.path())));
    assert!(state.approved_clients.is_empty(), "{state:?}");
    let again = sign_in(&issuer, &routes, &host_id, USER, "tablet", tablet.path()).await;
    assert!(matches!(again, Err(remote::Error::Refused)), "{again:?}");
    server.stop().await;
}

#[tokio::test]
async fn unlinking_drops_a_waiting_request_and_a_browser_cant_pair_with_a_setup_code() {
    let issuer = clerk().await;
    let dir = temp_dir();
    let (server, mut client, route, host_id) = host(dir.path(), &issuer).await;
    let routes = [route.clone()];
    let phone = temp_dir();
    let (_, signed_in) = sign_in(&issuer, &routes, &host_id, USER, "phone", phone.path())
        .await
        .unwrap();
    let SignIn::Pending { request, .. } = signed_in else {
        panic!("{signed_in:?}");
    };
    set_relay(&mut client, false).await;
    let approval = remote::await_approval(&route, &host_id, &request, phone.path()).await;
    assert!(
        matches!(approval, Err(remote::Error::Refused)),
        "{approval:?}"
    );
    assert!(access(&mut client).await.pending.is_none(), "dropped");

    // A setup code is for SPAKE2 only, so a browser typing it gets nothing.
    client
        .call::<HostSettingsSet>(HostSettingsSetParams {
            remote_web: Some(true),
            ..HostSettingsSetParams::default()
        })
        .await
        .unwrap();
    let code = client
        .call::<AccessSetupCode>(AccessSetupCodeParams {})
        .await
        .unwrap()
        .code;
    let port: u16 = route.rsplit(':').next().unwrap().parse().unwrap();
    let key = remote::DpopKey::generate();
    let path = "/api/pair/browser";
    let proof = key.proof("POST", &format!("https://{route}{path}"), None);
    let body = json!({ "code": code, "clientLabel": "browser" }).to_string();
    let (status, _, answer) = https(port, "POST", path, &[("DPoP", &proof)], &body).await;
    let answer: serde_json::Value = serde_json::from_slice(&answer).unwrap();
    assert_eq!(
        (status, answer["error_description"].as_str()),
        (401, Some("no pairing code is waiting"))
    );
    server.stop().await;
}

#[tokio::test]
async fn a_clock_the_relay_says_is_off_refuses_sign_ins_and_registering_records_the_account() {
    let issuer = clerk().await;
    // A relay whose clock is 10 minutes ahead of this computer's.
    let ahead = (remote::now_seconds() + 600) * 1000;
    let relay = fake_relay(format!(
        "HTTP/1.1 401 Unauthorized\r\nx-parallax-relay-time: {ahead}\r\nContent-Length: 0\r\n\r\n"
    ))
    .await;
    let dir = temp_dir();
    let (server, _client, route, _) =
        host_at(config(dir.path(), &issuer, &relay, free_port())).await;
    let deadline = tokio::time::Instant::now() + crate::support::PATIENCE;
    loop {
        let (status, why) = post_account(&route, &token(&issuer, USER)).await;
        if why.contains("clock") {
            assert_eq!(status, 401);
            break;
        }
        assert!(tokio::time::Instant::now() < deadline, "{status} {why}");
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    }
    server.stop().await;

    // This host's own registration records the token's user as its account.
    let relay = fake_relay(
        "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 2\r\n\r\n{}"
            .to_owned(),
    )
    .await;
    let dir = temp_dir();
    let server = InProcess::start(config(dir.path(), &issuer, &relay, free_port()));
    let mut client = Client::ready(&server.socket).await;
    assert_eq!(access(&mut client).await.account, None);
    client
        .call::<RelayRegister>(RelayRegisterParams {
            token: token(&issuer, "user_registered"),
            signed: None,
        })
        .await
        .unwrap();
    assert_eq!(
        access(&mut client).await.account.as_deref(),
        Some("user_registered")
    );
    server.stop().await;
}

#[tokio::test]
async fn request_and_setup_limits_and_a_waiting_request_survive_a_restart() {
    let issuer = clerk().await;
    let dir = temp_dir();
    let port = free_port();
    let start = || host_at(config(dir.path(), &issuer, "http://127.0.0.1:9", port));
    let (server, mut client, route, host_id) = start().await;
    let routes = [route.clone()];
    // Four requests started and denied, and a fifth waiting.
    for i in 0..4 {
        let device = temp_dir();
        let (_, signed_in) = sign_in(&issuer, &routes, &host_id, USER, "x", device.path())
            .await
            .unwrap();
        let SignIn::Pending { request, .. } = signed_in else {
            panic!("{i}: {signed_in:?}");
        };
        client
            .call::<AccessDeny>(AccessRequestParams { request })
            .await
            .unwrap();
    }
    let phone = temp_dir();
    let (_, waiting) = sign_in(&issuer, &routes, &host_id, USER, "phone", phone.path())
        .await
        .unwrap();
    // And five setup runs.
    let code = client
        .call::<AccessSetupCode>(AccessSetupCodeParams {})
        .await
        .unwrap()
        .code;
    let wrong = if code == "000000" { "000001" } else { "000000" };
    for _ in 0..5 {
        let laptop = temp_dir();
        let guess = remote::pair_account(&routes, &host_id, wrong, "x", laptop.path()).await;
        assert!(matches!(guess, Err(remote::Error::Refused)));
    }
    let before = access(&mut client).await.pending.unwrap();
    server.stop().await;

    let (server, mut client, _, _) = start().await;
    let after = access(&mut client).await.pending.expect("still waiting");
    assert_eq!((after.id, after.code), (before.id, before.code));
    // The same phone finds its request, with the same code.
    let (_, again) = sign_in(&issuer, &routes, &host_id, USER, "phone", phone.path())
        .await
        .unwrap();
    assert_eq!(again, waiting);
    let SignIn::Pending { request, .. } = waiting else {
        panic!("{waiting:?}");
    };
    client
        .call::<AccessDeny>(AccessRequestParams { request })
        .await
        .unwrap();
    let sixth = post_account(&route, &token(&issuer, USER)).await;
    assert_eq!(
        sixth,
        (429, "too many new devices asked this hour".to_owned())
    );
    let code = client
        .call::<AccessSetupCode>(AccessSetupCodeParams {})
        .await
        .unwrap()
        .code;
    let laptop = temp_dir();
    let right = remote::pair_account(&routes, &host_id, &code, "x", laptop.path()).await;
    assert!(
        matches!(right, Err(remote::Error::Refused)),
        "the sixth run"
    );
    server.stop().await;
}
