//! Pairing through the relay (PLX-1629, 0108): on any relay stream, marked or not, plxd takes only
//! a new computer's setup code (0091). Settings' 0065 code answers as no code there, and its wrong
//! tries and exchanges are left alone. No relay stream pairs a browser. Direct routes take
//! Settings' code on SPAKE2 and `/api/pair/browser` as before. The relay is `hosted.rs`'s fake,
//! with `remoteWeb` on. Its streams are unmarked and `hostedClient` is off, except where a test
//! says otherwise.

use std::net::{IpAddr, Ipv4Addr, Ipv6Addr};

use parallax_protocol::AccessSetupCodeParams;
use parallax_protocol::methods::AccessSetupCode;
use plxd::remote;
use serde_json::{Value, json};
use tempfile::TempDir;

use crate::account::clerk;
use crate::hosted::{FakeRelay, hosted_host, hosted_host_with, port_of};
use crate::remote::{https, new_code};
use crate::support::{Client, InProcess, temp_dir};

/// What plxd says when no code it would take waits.
const NO_CODE: &str = "no pairing code is waiting";

/// A host behind the fake relay, with `remoteWeb` on and `hostedClient` off, and an unmarked
/// route through the relay: its relay, server, client, direct route, relay route, and host id.
/// The folders must outlive the server.
struct Host {
    _relay: FakeRelay,
    server: InProcess,
    client: Client,
    direct: String,
    through: String,
    id: String,
    _dirs: (TempDir, TempDir),
}

async fn host() -> Host {
    let issuer = clerk().await;
    let (dir, web) = (temp_dir(), temp_dir());
    let (relay, server, client, direct, host_id) =
        hosted_host(dir.path(), web.path(), &issuer, false).await;
    let through = relay.route(json!({})).await;
    Host {
        _relay: relay,
        server,
        client,
        direct,
        through,
        id: host_id,
        _dirs: (dir, web),
    }
}

/// The certificate fingerprint the host at `route` presents.
async fn fingerprint(route: &str) -> String {
    remote::open(route, None).await.unwrap().1
}

/// A POST of `body` to `path` at `route`, with `headers`: the status and the JSON answer.
async fn post(route: &str, path: &str, headers: &[(&str, &str)], body: &Value) -> (u16, Value) {
    let (status, _, answer) = https(port_of(route), "POST", path, headers, &body.to_string()).await;
    (status, serde_json::from_slice(&answer).unwrap_or_default())
}

/// A `DPoP` proof by `key` for POST `path` at `route`.
fn proof(key: &remote::DpopKey, route: &str, path: &str) -> String {
    key.proof("POST", &format!("https://{route}{path}"), None)
}

/// A code that isn't `code`.
fn other(code: &str) -> String {
    let flipped = if code.ends_with('2') { '3' } else { '2' };
    format!("{}{flipped}", &code[..code.len() - 1])
}

/// Whether `answer` is the refusal plxd gives while no code it would take waits.
fn no_code(answer: &(u16, Value)) -> bool {
    answer.0 == 401 && answer.1["error_description"] == NO_CODE
}

#[tokio::test]
async fn through_the_relay_spake2_starts_with_no_settings_code_and_directly_it_does() {
    let mut host = host().await;
    let code = new_code(&mut host.client).await;
    let fp = fingerprint(&host.direct).await;
    let (_, first) = remote::pake_client(&code, &fp);
    let start = json!({ "pake": remote::base64url(&first) });

    let refused = post(&host.through, "/api/pair/start", &[], &start).await;
    assert!(no_code(&refused), "{refused:?}");
    // `plxd dial` through the relay hears the code is wrong, used, or expired.
    let phone = temp_dir();
    let through = std::slice::from_ref(&host.through);
    let dialed = remote::pair(through, &code, "phone", phone.path()).await;
    assert!(matches!(dialed, Err(remote::Error::Refused)), "{dialed:?}");

    // The code still waits, and pairs directly.
    let direct = std::slice::from_ref(&host.direct);
    remote::pair(direct, &code, "laptop", phone.path())
        .await
        .unwrap();
    host.server.stop().await;
}

#[tokio::test]
async fn through_the_relay_spake2_finishes_with_no_settings_code_and_leaves_its_tries() {
    let mut host = host().await;
    let code = new_code(&mut host.client).await;
    let fp = fingerprint(&host.direct).await;
    let (state, first) = remote::pake_client(&code, &fp);
    let start = json!({ "pake": remote::base64url(&first) });
    let (status, started) = post(&host.direct, "/api/pair/start", &[], &start).await;
    assert_eq!(status, 200, "{started}");
    let shared = state
        .finish(
            &data_encoding::BASE64URL_NOPAD
                .decode(started["pake"].as_str().unwrap().as_bytes())
                .unwrap(),
        )
        .unwrap();
    let key = remote::DpopKey::generate();
    let right = remote::confirmation(&shared, b"client", &fp, &key.thumbprint());
    let finish = |confirm: &[u8]| json!({ "pairing": started["pairing"], "confirm": remote::base64url(confirm) });
    let path = "/api/pair/finish";

    // As many wrong confirmations as lock a code, then the right one: none counts or ends the
    // exchange.
    for _ in 0..remote::MAX_WRONG_CODES {
        let dpop = proof(&key, &host.through, path);
        let wrong = finish(&[0; 32]);
        let refused = post(&host.through, path, &[("DPoP", &dpop)], &wrong).await;
        assert!(no_code(&refused), "{refused:?}");
    }
    let dpop = proof(&key, &host.through, path);
    let refused = post(&host.through, path, &[("DPoP", &dpop)], &finish(&right)).await;
    assert!(no_code(&refused), "{refused:?}");

    // The same exchange finishes directly.
    let dpop = proof(&key, &host.direct, path);
    let (status, paired) = post(&host.direct, path, &[("DPoP", &dpop)], &finish(&right)).await;
    assert_eq!(status, 200, "{paired}");
    assert!(paired["accessToken"].is_string(), "{paired}");
    host.server.stop().await;
}

#[tokio::test]
async fn a_setup_code_pairs_through_the_relay() {
    let mut host = host().await;
    let setup = host
        .client
        .call::<AccessSetupCode>(AccessSetupCodeParams::default())
        .await
        .unwrap();
    let phone = temp_dir();
    let through = std::slice::from_ref(&host.through);
    let paired = remote::pair_account(through, &host.id, &setup.code, "phone", phone.path())
        .await
        .unwrap();
    assert_eq!(paired.routes[0], host.through);
    host.server.stop().await;
}

#[tokio::test]
async fn no_browser_pairs_through_the_relay_and_one_pairs_directly() {
    let mut host = host().await;
    let code = new_code(&mut host.client).await;
    let key = remote::DpopKey::generate();
    let path = "/api/pair/browser";
    let pair = |code: &str| json!({ "code": code, "clientLabel": "Browser" });
    let not_found = |answer: &(u16, Value)| answer.0 == 404 && answer.1["error"] == "not_found";

    // `remoteWeb` is on. As many wrong codes as lock one, then the right one, with this host's
    // origin as a page in the browser's own TLS could write it: each gets 404.
    let origin = format!("https://{}", host.through);
    for typed in
        std::iter::repeat_n(other(&code), remote::MAX_WRONG_CODES as usize).chain([code.clone()])
    {
        let dpop = proof(&key, &host.through, path);
        let headers = [("DPoP", dpop.as_str()), ("Origin", origin.as_str())];
        let refused = post(&host.through, path, &headers, &pair(&typed)).await;
        assert!(not_found(&refused), "{refused:?}");
    }

    // The code still waits, and pairs a browser directly.
    let dpop = proof(&key, &host.direct, path);
    let (status, paired) = post(&host.direct, path, &[("DPoP", &dpop)], &pair(&code)).await;
    assert_eq!(status, 200, "{paired}");
    assert!(paired["accessToken"].is_string(), "{paired}");
    host.server.stop().await;
}

/// A host that binds every address still dials itself on loopback, where its listener sees each
/// relay stream come from, so it still tells a relay stream and its mark from a direct connection.
#[tokio::test]
async fn a_host_on_every_address_still_knows_its_relay_streams_and_their_marks() {
    for every in [
        IpAddr::V4(Ipv4Addr::UNSPECIFIED),
        IpAddr::V6(Ipv6Addr::UNSPECIFIED),
    ] {
        let issuer = clerk().await;
        let (dir, web) = (temp_dir(), temp_dir());
        let bind_every = |config: &mut plxd::server::Config| config.remote_address = Some(every);
        let (relay, server, mut client, direct, _) =
            hosted_host_with(dir.path(), web.path(), &issuer, true, bind_every).await;
        let hosted = relay.route(json!({ "client": "hosted" })).await;
        let through = relay.route(json!({})).await;

        // The hosted client's stream gets no descriptor, which the direct route serves.
        let descriptor = async |route: &str| {
            let (status, ..) = https(port_of(route), "GET", "/.well-known/parallax", &[], "").await;
            status
        };
        assert_eq!(descriptor(&hosted).await, 404, "{every}");
        assert_eq!(descriptor(&direct).await, 200, "{every}");

        // An unmarked stream takes no Settings code.
        let code = new_code(&mut client).await;
        let fp = fingerprint(&direct).await;
        let (_, first) = remote::pake_client(&code, &fp);
        let start = json!({ "pake": remote::base64url(&first) });
        let refused = post(&through, "/api/pair/start", &[], &start).await;
        assert!(no_code(&refused), "{every}: {refused:?}");
        server.stop().await;
    }
}
