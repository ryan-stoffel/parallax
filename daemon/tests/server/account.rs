//! Account sign-in on the remote listener (0091): a client of this host's account is pinned by
//! the host id, gets a session only once its key is approved, a removed key never again, and a
//! setup code approves the device that types it, within its run limit.

use std::path::Path;

use parallax_protocol::methods::{
    AccessApprove, AccessGet, AccessMerge, AccessRemove, AccessSetupCode, HostSettingsSet, RelayId,
    RelaySign,
};
use parallax_protocol::{
    AccessGetParams, AccessMergeParams, AccessRemoveParams, AccessRequestParams,
    AccessSetupCodeParams, HostSettingsSetParams, RelayIdParams, RelaySignParams,
};
use plxd::remote::{self, SignIn};
use ring::rand::SystemRandom;
use ring::rsa::{KeyPair, PublicKeyComponents};
use serde_json::json;
use tokio::io::{AsyncReadExt as _, AsyncWriteExt as _};
use tokio::net::TcpListener;

use crate::connect::free_port;
use crate::remote::{LOOPBACK, set_remote, wait_listening};
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
    let now = remote::now_seconds();
    let header = json!({ "alg": "RS256", "kid": "k1" });
    let claims = json!({ "iss": issuer, "sub": user, "sid": "sess", "iat": now, "exp": now + 60 });
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

/// A host with `relay` and `remote` on, signed in to [`USER`]'s account, trusting `issuer`: the
/// server, a client on its socket, its route, and its host id.
async fn host(dir: &Path, issuer: &str) -> (InProcess, Client, String, String) {
    let port = free_port();
    let mut config = InProcess::config(dir);
    config.remote_address = Some(LOOPBACK);
    config.remote_port = port;
    // Nothing answers here, so no relay is reached.
    "http://127.0.0.1:9".clone_into(&mut config.relay_url);
    config.clerk = plxd::clerk::Config {
        issuer: issuer.to_owned(),
        client_ids: Vec::new(),
        authorized_parties: Vec::new(),
    };
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

    // Another account's token, and any token while `relay` is off, get nothing.
    let stranger = sign_in(&issuer, &routes, &host_id, "user_2", "x", phone.path()).await;
    assert!(matches!(stranger, Err(remote::Error::Refused)));
    set_relay(&mut client, false).await;
    let unlinked = sign_in(&issuer, &routes, &host_id, USER, "x", phone.path()).await;
    assert!(matches!(unlinked, Err(remote::Error::Refused)));
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
