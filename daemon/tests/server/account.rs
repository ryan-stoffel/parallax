//! Account sign-in on the remote listener (0091): a client of this host's account is pinned by
//! the host id, gets a session only once its key is approved, a removed key never again, and a
//! setup code approves the device that types it, within its run limit.

use std::path::Path;
use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::Duration;

use futures_util::{SinkExt as _, StreamExt as _};
use parallax_protocol::methods::{
    AccessApprove, AccessDeny, AccessForgetHost, AccessGet, AccessMerge, AccessRemove,
    AccessSetupCode, HostSettingsSet, RelayId, RelayPushKey, RelayRegister, RelaySign,
    RemoteRevoke, RemoteSessions,
};
use parallax_protocol::{
    AccessForgetHostParams, AccessGetParams, AccessMergeParams, AccessRemoveParams,
    AccessRequestParams, AccessSetupCodeParams, HostSettingsSetParams, RelayIdParams,
    RelayPushKeyParams, RelayRegisterParams, RelaySignParams, RemoteRevokeParams,
    RemoteSessionsParams,
};
use plxd::remote::{self, SignIn};
use ring::rand::SystemRandom;
use ring::rsa::{KeyPair, PublicKeyComponents};
use rustls::pki_types::PrivatePkcs8KeyDer;
use serde_json::json;
use tokio::io::{AsyncReadExt as _, AsyncWriteExt as _};
use tokio::net::TcpListener;
use tokio::sync::mpsc;
use tokio::time::{Instant, sleep, timeout};
use tokio_tungstenite::tungstenite::Message;

use crate::connect::free_port;
use crate::remote::{LOOPBACK, https, open_account, refusal, set_remote, wait_listening};
use crate::support::{Client, InProcess, temp_dir};

const USER: &str = "user_1";

fn clerk_key() -> KeyPair {
    KeyPair::from_der(include_bytes!("../fixtures/clerk-test-key.der")).unwrap()
}

/// Serves the test key as a Clerk instance's JWKS on loopback, and answers with its issuer.
pub(crate) async fn clerk() -> String {
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
pub(crate) fn token(issuer: &str, user: &str) -> String {
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
pub(crate) fn config(dir: &Path, issuer: &str, relay: &str, port: u16) -> plxd::server::Config {
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

pub(crate) fn thumbprint(dir: &Path) -> String {
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
    remote::sign_in(routes, host_id, &token(issuer, user), name, false, dir).await
}

/// [`sign_in`] with a new computer's code to compare, as its Allow dialog does: the request's id
/// and code.
async fn compare(
    issuer: &str,
    routes: &[String],
    host_id: &str,
    name: &str,
    dir: &Path,
) -> Result<(String, String, String), remote::Error> {
    let token = token(issuer, USER);
    let (route, signed_in) = remote::sign_in(routes, host_id, &token, name, true, dir).await?;
    let SignIn::Pending { request, code } = signed_in else {
        panic!("{signed_in:?}");
    };
    Ok((route, request, code))
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
async fn forgetting_a_computer_drops_its_approval_and_this_computers_session_for_it() {
    const OTHER: &str = "kZ3Ua8Qe0pX5y6mN9bR2tLwVc4jH7sD1fG8oI3uE5nA";
    let issuer = clerk().await;
    let dir = temp_dir();
    let (_server, mut client, _, _) = host(dir.path(), &issuer).await;
    client
        .call::<AccessMerge>(AccessMergeParams {
            approved_hosts: vec![OTHER.to_owned()],
            allowed_hosts: vec![OTHER.to_owned()],
            ..AccessMergeParams::default()
        })
        .await
        .unwrap();
    assert_eq!(access(&mut client).await.allowed_hosts, [OTHER]);
    let saved = dir.path().join("remote-hosts");
    std::fs::create_dir_all(&saved).unwrap();
    std::fs::write(saved.join(OTHER), "{}").unwrap();
    std::fs::write(saved.join(format!("{OTHER}.request")), "{}").unwrap();
    std::fs::write(saved.join(format!("{OTHER}.requests")), "[]").unwrap();

    let state = client
        .call::<AccessForgetHost>(AccessForgetHostParams {
            host_id: OTHER.to_owned(),
        })
        .await
        .unwrap();
    assert!(state.approved_hosts.is_empty());
    assert!(state.allowed_hosts.is_empty());
    assert_eq!(std::fs::read_dir(&saved).unwrap().count(), 0);

    // Doing it again, as a second computer's Remove would, changes nothing.
    client
        .call::<AccessForgetHost>(AccessForgetHostParams {
            host_id: OTHER.to_owned(),
        })
        .await
        .unwrap();
}

#[tokio::test]
async fn the_push_key_is_32_bytes_under_the_hosts_relay_id() {
    let issuer = clerk().await;
    let dir = temp_dir();
    let (_server, mut client, _, host_id) = host(dir.path(), &issuer).await;
    let first = client
        .call::<RelayPushKey>(RelayPushKeyParams {})
        .await
        .unwrap();
    assert_eq!(first.host_id, host_id);
    assert_eq!(remote::base64url_decode(&first.key).unwrap().len(), 32);
    let again = client
        .call::<RelayPushKey>(RelayPushKeyParams {})
        .await
        .unwrap();
    assert_eq!(again.key, first.key);
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

/// A TLS server with a key of its own at `name`, as a stale or hostile address the user added
/// would be, which closes its first `closing` connections before TLS: its route, and how many
/// bytes any client sent it once TLS was up.
async fn wrong_key_server(name: &str, closing: usize) -> (String, Arc<AtomicUsize>) {
    let listener = TcpListener::bind((LOOPBACK, 0)).await.unwrap();
    let route = format!("{name}:{}", listener.local_addr().unwrap().port());
    let made = rcgen::generate_simple_self_signed(["parallax".to_owned()]).unwrap();
    let key = PrivatePkcs8KeyDer::from(made.signing_key.serialize_der());
    let provider = Arc::new(rustls::crypto::ring::default_provider());
    let config = rustls::ServerConfig::builder_with_provider(provider)
        .with_safe_default_protocol_versions()
        .unwrap()
        .with_no_client_auth()
        .with_single_cert(vec![made.cert.der().clone()], key.into())
        .unwrap();
    let acceptor = tokio_rustls::TlsAcceptor::from(Arc::new(config));
    let received = Arc::new(AtomicUsize::new(0));
    let counted = Arc::clone(&received);
    tokio::spawn(async move {
        let mut closing = closing;
        while let Ok((stream, _)) = listener.accept().await {
            if closing > 0 {
                closing -= 1;
                continue;
            }
            let acceptor = acceptor.clone();
            let counted = Arc::clone(&counted);
            tokio::spawn(async move {
                let Ok(mut tls) = acceptor.accept(stream).await else {
                    return;
                };
                let mut read = [0; 1024];
                while let Ok(n @ 1..) = tls.read(&mut read).await {
                    counted.fetch_add(n, Ordering::SeqCst);
                }
            });
        }
    });
    (route, received)
}

#[tokio::test]
async fn a_user_added_route_with_the_wrong_key_gets_nothing_and_blocks_nothing() {
    let issuer = clerk().await;
    let dir = temp_dir();
    let (server, mut client, route, host_id) = host(dir.path(), &issuer).await;
    // A DNS name, as a user would add one, tried first.
    let (wrong, received) = wrong_key_server("localhost", 0).await;
    let pin = remote::Pin::HostId(host_id.clone());
    let routes = [wrong.clone(), route.clone()];
    let phone = temp_dir();

    // Alone, it's the wrong host for every step that could send a credential.
    let alone = std::slice::from_ref(&wrong);
    assert!(matches!(
        remote::probe(alone, false, &pin).await,
        Err(remote::Error::WrongHost)
    ));
    let signing_in = sign_in(&issuer, alone, &host_id, USER, "phone", phone.path()).await;
    assert!(matches!(signing_in, Err(remote::Error::WrongHost)));
    assert!(matches!(
        remote::pair_account(alone, &host_id, "000000", "phone", phone.path()).await,
        Err(remote::Error::WrongHost)
    ));

    // With the real route after it, each goes on to that: a setup code, a sign-in, a probe, a dial.
    let setup = client
        .call::<AccessSetupCode>(AccessSetupCodeParams::default())
        .await
        .unwrap();
    remote::pair_account(&routes, &host_id, &setup.code, "phone", phone.path())
        .await
        .unwrap();
    let (over, signed_in) = sign_in(&issuer, &routes, &host_id, USER, "phone", phone.path())
        .await
        .unwrap();
    assert_eq!(over, route);
    assert!(matches!(signed_in, SignIn::Approved { .. }));
    for in_order in [false, true] {
        assert_eq!(remote::probe(&routes, in_order, &pin).await.unwrap(), route);
        let dialed = remote::dial_account(&routes, in_order, &host_id, phone.path()).await;
        assert_eq!(dialed.unwrap().route, route);
    }

    assert_eq!(received.load(Ordering::SeqCst), 0, "nothing reached it");
    server.stop().await;
}

#[tokio::test]
async fn a_route_that_drops_a_connection_then_shows_the_wrong_key_blocks_nothing() {
    let issuer = clerk().await;
    let dir = temp_dir();
    let (server, mut client, route, host_id) = host(dir.path(), &issuer).await;
    let phone = temp_dir();

    let (wrong, received) = wrong_key_server("localhost", 1).await;
    let routes = [wrong, route.clone()];
    let setup = client
        .call::<AccessSetupCode>(AccessSetupCodeParams::default())
        .await
        .unwrap();
    remote::pair_account(&routes, &host_id, &setup.code, "phone", phone.path())
        .await
        .unwrap();
    assert_eq!(
        received.load(Ordering::SeqCst),
        0,
        "pairing sent it nothing"
    );

    let (wrong, received) = wrong_key_server("localhost", 1).await;
    let routes = [wrong, route.clone()];
    let (over, _) = sign_in(&issuer, &routes, &host_id, USER, "phone", phone.path())
        .await
        .unwrap();
    assert_eq!(over, route);
    assert_eq!(
        received.load(Ordering::SeqCst),
        0,
        "signing in sent it nothing"
    );
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
        remote::dial_account(&routes, false, &other_id, phone.path()).await,
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
        remote::dial_account(&routes, false, &host_id, phone.path()).await,
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
        remote::dial_account(&routes, false, &host_id, phone.path()).await,
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
async fn the_device_a_setup_command_names_needs_only_its_allow_and_a_caught_token_gets_nothing() {
    let issuer = clerk().await;
    let dir = temp_dir();
    let (server, mut client, route, host_id) = host(dir.path(), &issuer).await;
    let routes = [route];
    let (laptop, attacker) = (temp_dir(), temp_dir());
    client
        .call::<AccessSetupCode>(AccessSetupCodeParams {
            device: Some(thumbprint(laptop.path())),
        })
        .await
        .unwrap();

    // A valid token from any other key can't start a request, so it can't hold the slot either.
    let caught = compare(&issuer, &routes, &host_id, "laptop", attacker.path()).await;
    assert!(matches!(caught, Err(remote::Error::Refused)));
    assert!(access(&mut client).await.pending.is_none());

    // Both screens show one code, and the named key's Allow gets its session.
    let (at, request, code) = compare(&issuer, &routes, &host_id, "laptop", laptop.path())
        .await
        .unwrap();
    assert_eq!(access(&mut client).await.pending.unwrap().code, Some(code));
    let allowed = remote::allow(&at, &host_id, &request, laptop.path())
        .await
        .unwrap();
    assert!(matches!(allowed, SignIn::Approved { .. }), "{allowed:?}");
    let state = access(&mut client).await;
    assert_eq!(state.setup_approved.as_deref(), Some("laptop"));
    assert_eq!(state.approved_clients, [thumbprint(laptop.path())]);
    let mut app = crate::remote::open_account(&routes, &host_id, laptop.path())
        .await
        .unwrap();
    assert!(app.initialize().await["result"].is_object());
    server.stop().await;
}

#[tokio::test]
async fn with_a_bare_setup_command_allow_alone_gets_no_session_until_this_computer_confirms() {
    let issuer = clerk().await;
    let dir = temp_dir();
    let (server, mut client, route, host_id) = host(dir.path(), &issuer).await;
    let routes = [route];
    let (laptop, attacker) = (temp_dir(), temp_dir());
    client
        .call::<AccessSetupCode>(AccessSetupCodeParams::default())
        .await
        .unwrap();

    // An attacker that races the laptop can say Allow all it likes. The terminal shows its request.
    let (at, request, code) = compare(&issuer, &routes, &host_id, "laptop", attacker.path())
        .await
        .unwrap();
    let said = remote::allow(&at, &host_id, &request, attacker.path())
        .await
        .unwrap();
    assert_eq!(said, SignIn::Confirm);
    let state = access(&mut client).await;
    assert!(state.approved_clients.is_empty());
    assert_eq!(state.pending.unwrap().code, Some(code));
    let raced = compare(&issuer, &routes, &host_id, "laptop", laptop.path()).await;
    assert!(
        matches!(raced, Err(remote::Error::Refused)),
        "one at a time"
    );

    // The user sees a request they didn't make and denies it, which ends it for the attacker.
    client
        .call::<AccessDeny>(AccessRequestParams {
            request: request.clone(),
        })
        .await
        .unwrap();
    let denied = remote::await_approval(&at, &host_id, &request, attacker.path()).await;
    assert!(matches!(denied, Err(remote::Error::Refused)));

    // The laptop's own request: Allow there, then Enter here.
    let (at, request, _) = compare(&issuer, &routes, &host_id, "laptop", laptop.path())
        .await
        .unwrap();
    let said = remote::allow(&at, &host_id, &request, laptop.path())
        .await
        .unwrap();
    assert_eq!(said, SignIn::Confirm);
    client
        .call::<AccessApprove>(AccessRequestParams {
            request: request.clone(),
        })
        .await
        .unwrap();
    let approved = remote::await_approval(&at, &host_id, &request, laptop.path())
        .await
        .unwrap();
    assert!(matches!(approved, SignIn::Approved { .. }), "{approved:?}");

    // A key already approved shows no code to compare, so comparing keeps no session from it.
    remote::forget_host(laptop.path(), &host_id).unwrap();
    let again = compare(&issuer, &routes, &host_id, "laptop", laptop.path()).await;
    assert!(matches!(again, Err(remote::Error::Refused)));
    let saved = crate::remote::open_account(&routes, &host_id, laptop.path()).await;
    assert!(saved.is_err(), "no session was kept");

    // A client's Deny drops its own request, so the slot doesn't wait out its 10 minutes.
    let (at, request, _) = compare(&issuer, &routes, &host_id, "x", attacker.path())
        .await
        .unwrap();
    remote::withdraw(&at, &host_id, &request, attacker.path()).await;
    assert!(access(&mut client).await.pending.is_none());
    server.stop().await;
}

#[tokio::test]
#[expect(clippy::too_many_lines, reason = "one device told step by step")]
async fn read_only_stays_with_the_key_and_no_merge_lifts_it() {
    let issuer = clerk().await;
    let dir = temp_dir();
    let (server, mut client, route, host_id) = host(dir.path(), &issuer).await;
    let routes = [route.clone()];
    let phone = temp_dir();
    let (_, signed_in) = sign_in(&issuer, &routes, &host_id, USER, "phone", phone.path())
        .await
        .unwrap();
    let SignIn::Pending { request, .. } = signed_in else {
        panic!("a new device waits: {signed_in:?}");
    };
    let waiting = {
        let (route, request, dir) = (route.clone(), request.clone(), phone.path().to_owned());
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
    let mut app = open_account(&routes, &host_id, phone.path()).await.unwrap();
    app.initialize().await;

    // Another host's mark reaches this one in a merge, and closes the connection it has.
    let key = thumbprint(phone.path());
    let merged = client
        .call::<AccessMerge>(AccessMergeParams {
            read_only_clients: vec![key.clone()],
            ..AccessMergeParams::default()
        })
        .await
        .unwrap();
    assert!(merged.read_only_clients.contains(&key));
    assert!(app.closes().await, "the mark closes its connection");

    // Signing in again makes a new session, which is read-only too.
    let again = sign_in(&issuer, &routes, &host_id, USER, "phone", phone.path()).await;
    assert!(matches!(again, Ok((_, SignIn::Approved { .. }))));
    let sessions = client
        .call::<RemoteSessions>(RemoteSessionsParams {})
        .await
        .unwrap()
        .sessions;
    assert_eq!(sessions.len(), 2);
    assert!(sessions.iter().all(|s| s.read_only));
    let mut app = open_account(&routes, &host_id, phone.path()).await.unwrap();
    app.initialize().await;
    let write = r#"{"autoResume":false}"#;
    assert_eq!(
        refusal(&mut app, 2, "host/settings/set", write).await,
        Some("readOnly".to_owned())
    );

    // It reads who may sign in, with no request's code to answer.
    let tablet = temp_dir();
    let (_, tablet_in) = sign_in(&issuer, &routes, &host_id, USER, "tablet", tablet.path())
        .await
        .unwrap();
    let SignIn::Pending { request, .. } = tablet_in else {
        panic!("a new device waits: {tablet_in:?}");
    };
    assert!(access(&mut client).await.pending.is_some());
    app.send(r#"{"jsonrpc":"2.0","id":3,"method":"access/get","params":{}}"#)
        .await;
    let state: serde_json::Value = serde_json::from_str(&app.next().await).unwrap();
    assert!(state["result"]["version"].is_number(), "{state}");
    assert!(state["result"].get("pending").is_none(), "{state}");

    // A merge from a host or client that doesn't know the mark, or wants it gone, lists the key
    // as approved at most. The mark stays, and so does its connection.
    let merged = client
        .call::<AccessMerge>(AccessMergeParams {
            approved_clients: vec![key.clone()],
            ..AccessMergeParams::default()
        })
        .await
        .unwrap();
    assert!(merged.read_only_clients.contains(&key));
    assert_eq!(refusal(&mut app, 4, "thread/list", "{}").await, None);
    assert_eq!(
        refusal(&mut app, 5, "host/settings/set", write).await,
        Some("readOnly".to_owned())
    );

    // Removed, the key gets nothing again, and stays marked. Another key, once approved, has full
    // access.
    let removed = client
        .call::<AccessRemove>(AccessRemoveParams {
            thumbprint: key.clone(),
        })
        .await
        .unwrap();
    assert!(removed.removed_clients.contains(&key));
    assert!(removed.read_only_clients.contains(&key));
    assert!(app.closes().await, "its socket closed");
    let refused = sign_in(&issuer, &routes, &host_id, USER, "phone", phone.path()).await;
    assert!(matches!(refused, Err(remote::Error::Refused)));
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
    let mut app = open_account(&routes, &host_id, tablet.path())
        .await
        .unwrap();
    app.initialize().await;
    assert_eq!(refusal(&mut app, 2, "host/settings/set", write).await, None);
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
            .call::<AccessSetupCode>(AccessSetupCodeParams::default())
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

/// A relay on loopback that takes one plxd's control socket: frames sent on the first answer go to
/// plxd, and the `removed` frames plxd sends come out of the second.
async fn fake_control_relay() -> (
    String,
    mpsc::Sender<String>,
    mpsc::Receiver<serde_json::Value>,
) {
    let listener = TcpListener::bind((LOOPBACK, 0)).await.unwrap();
    let url = format!("http://{}", listener.local_addr().unwrap());
    let (to_plxd, mut frames) = mpsc::channel::<String>(16);
    let (removal, from_plxd) = mpsc::channel(16);
    tokio::spawn(async move {
        let (tcp, _) = listener.accept().await.unwrap();
        let mut socket = tokio_tungstenite::accept_async(tcp).await.unwrap();
        socket
            .send(Message::text(r#"{"t":"ready"}"#))
            .await
            .unwrap();
        loop {
            tokio::select! {
                Some(frame) = frames.recv() => socket.send(Message::text(frame)).await.unwrap(),
                read = socket.next() => {
                    let Some(Ok(Message::Text(text))) = read else { return };
                    let frame: serde_json::Value = serde_json::from_str(&text).unwrap_or_default();
                    if frame["t"] == "removed" {
                        removal.send(frame).await.unwrap();
                    }
                }
            }
        }
    });
    (url, to_plxd, from_plxd)
}

/// The key the removal frame `frame` names, once `signer` is checked as what signed it for [`USER`].
fn announced(frame: &serde_json::Value, signer: &str) -> Vec<String> {
    let statement = frame["statement"].as_str().unwrap();
    let (signed_by, removed) = remote::open_removal(statement, USER).unwrap();
    assert_eq!(signed_by, signer);
    removed
}

#[tokio::test]
#[expect(
    clippy::too_many_lines,
    reason = "what a relay could send, told case by case"
)]
async fn a_removal_from_the_relay_counts_only_when_an_approved_computer_signed_it() {
    let issuer = clerk().await;
    let (relay, frames, mut announcements) = fake_control_relay().await;
    let dir = temp_dir();
    let port = free_port();
    let (server, mut client, route, host_id) =
        host_at(config(dir.path(), &issuer, &relay, port)).await;
    let routes = [route.clone()];
    let approved = remote::DpopKey::generate();
    let stranger = remote::DpopKey::generate();
    // Added with Allow alone: one kept only as restricted, and one a merge left in both lists.
    let restricted = remote::DpopKey::generate();
    let in_both = remote::DpopKey::generate();
    let (phone, tablet) = (temp_dir(), temp_dir());
    let phone_key = thumbprint(phone.path());
    let tablet_key = thumbprint(tablet.path());
    client
        .call::<AccessMerge>(AccessMergeParams {
            approved_clients: vec![phone_key.clone(), tablet_key.clone()],
            removed_clients: Vec::new(),
            approved_hosts: vec![approved.thumbprint(), in_both.thumbprint()],
            allowed_hosts: vec![restricted.thumbprint(), in_both.thumbprint()],
            read_only_clients: vec![tablet_key.clone()],
        })
        .await
        .unwrap();
    let lists = access(&mut client).await;
    assert!(lists.approved_hosts.contains(&in_both.thumbprint()));
    assert!(lists.allowed_hosts.contains(&in_both.thumbprint()));
    for (dir, name) in [(&phone, "phone"), (&tablet, "tablet")] {
        let signed_in = sign_in(&issuer, &routes, &host_id, USER, name, dir.path()).await;
        assert!(matches!(signed_in, Ok((_, SignIn::Approved { .. }))));
    }
    let mut phone_app = open_account(&routes, &host_id, phone.path()).await.unwrap();
    assert!(phone_app.initialize().await["result"].is_object());
    let tell = |statement: String| {
        let frame = json!({ "t": "removed", "statement": statement }).to_string();
        let frames = frames.clone();
        async move { frames.send(frame).await.unwrap() }
    };
    let one = |key: &str| vec![key.to_owned()];

    // What a relay could make: signed by a host of its own, by a fake computer the user allowed, by
    // an approved computer for another account, an approved computer's with another key swapped
    // in, too long, and not one at all.
    tell(remote::signed_removal(&stranger, USER, &one(&phone_key))).await;
    tell(remote::signed_removal(&restricted, USER, &one(&phone_key))).await;
    tell(remote::signed_removal(&in_both, USER, &one(&phone_key))).await;
    tell(remote::signed_removal(
        &approved,
        "user_2",
        &one(&phone_key),
    ))
    .await;
    let real = remote::signed_removal(&approved, USER, &one(&tablet_key));
    tell(real.replace(&tablet_key, &phone_key)).await;
    tell(remote::signed_removal(
        &approved,
        USER,
        &vec![phone_key.clone(); 200],
    ))
    .await;
    tell("not a statement".to_owned()).await;

    // The real one, last, ends the tablet's sessions.
    tell(real.clone()).await;
    let mut state = access(&mut client).await;
    let deadline = Instant::now() + Duration::from_secs(5);
    while state.removed_clients.is_empty() && Instant::now() < deadline {
        sleep(Duration::from_millis(20)).await;
        state = access(&mut client).await;
    }
    sleep(Duration::from_millis(200)).await;
    let state_after = access(&mut client).await;
    assert_eq!(state_after.removed_clients, one(&tablet_key));
    assert_eq!(state_after.approved_clients, one(&phone_key));
    assert_eq!(
        state_after.read_only_clients,
        one(&tablet_key),
        "still marked"
    );
    let tablet_again = open_account(&routes, &host_id, tablet.path()).await;
    assert!(matches!(tablet_again, Err(remote::Error::Refused)));
    phone_app
        .send(r#"{"jsonrpc":"2.0","id":2,"method":"host/health","params":{}}"#)
        .await;
    assert!(
        phone_app.next().await.contains(r#""result""#),
        "still connected"
    );

    // Replaying it changes nothing, and what comes from the relay isn't passed on.
    let version = access(&mut client).await.version;
    tell(real).await;
    sleep(Duration::from_millis(200)).await;
    assert_eq!(access(&mut client).await.version, version);

    // A removal made here goes to the relay signed by this host, once. The phone's live session
    // ends here, and a real statement can't bring it back.
    client
        .call::<AccessRemove>(AccessRemoveParams {
            thumbprint: phone_key.clone(),
        })
        .await
        .unwrap();
    assert!(phone_app.closes().await);
    let frame = timeout(Duration::from_secs(5), announcements.recv())
        .await
        .unwrap();
    assert_eq!(announced(&frame.unwrap(), &host_id), one(&phone_key));
    client
        .call::<AccessRemove>(AccessRemoveParams {
            thumbprint: phone_key,
        })
        .await
        .unwrap();
    let other = remote::DpopKey::generate().thumbprint();
    client
        .call::<AccessRemove>(AccessRemoveParams {
            thumbprint: other.clone(),
        })
        .await
        .unwrap();
    let frame = timeout(Duration::from_secs(5), announcements.recv())
        .await
        .unwrap();
    assert_eq!(announced(&frame.unwrap(), &host_id), one(&other));
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
        .call::<AccessSetupCode>(AccessSetupCodeParams::default())
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
        .call::<AccessSetupCode>(AccessSetupCodeParams::default())
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
        .call::<AccessSetupCode>(AccessSetupCodeParams::default())
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
