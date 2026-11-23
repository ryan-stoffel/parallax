//! Guest links on plxd's side (0108): `guest/*`, the routes a guest's stream serves, binding,
//! the guest level and its outgoing filter, the read limit, and every way a link ends. The fake
//! relay from [`crate::hosted`] marks each stream `guest: <linkId>`, as the real one will
//! (PLX-1616), and keeps the guest links plxd sends it.

use std::time::Duration;

use futures_util::{SinkExt as _, StreamExt as _};
use parallax_protocol::methods::{
    AgentSend, AgentWait, GuestCreate, GuestDismiss, GuestList, GuestRevoke, GuestSend,
    RequestName, ThreadArchive, ThreadDelete, ThreadStart,
};
use parallax_protocol::{
    AgentWaitParams, AgentWaitUntil, ErrorKind, GuestCreateParams, GuestLink, GuestListParams,
    GuestRevokeParams, GuestSuggestionParams, RunId, ThreadArchiveParams, ThreadDeleteParams,
    TurnId,
};
use plxd::remote;
use serde_json::{Value, json};
use tempfile::TempDir;
use tokio::time::timeout;
use tokio_tungstenite::WebSocketStream;
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::tungstenite::client::IntoClientRequest as _;

use crate::account::{USER, clerk, token};
use crate::agents::{end_turn, fake, init, send_params, text};
use crate::hosted::{FakeRelay, allowed, answer, hosted_host_with, port_of, set_hosted};
use crate::remote::{https, open_account, refusal};
use crate::support::{Client, InProcess, PATIENCE, kind, temp_dir};

/// The event kinds a guest may see.
const SHOWN: [&str; 5] = [
    "agent.started",
    "agent.updated",
    "agent.output",
    "agent.finished",
    "thread.reverted",
];

/// A host behind the fake relay with `hostedClient` on and the fake CLI, whose links last
/// `lifetime`.
struct Host {
    relay: FakeRelay,
    server: InProcess,
    client: Client,
    /// Its own route, which no relay marks.
    direct: String,
    id: String,
    issuer: String,
    _dirs: (TempDir, TempDir),
}

impl Host {
    async fn start(lifetime: Option<Duration>) -> Self {
        let issuer = clerk().await;
        let (dir, web) = (temp_dir(), temp_dir());
        let steps = vec![init("guest-1"), text("Reading the code."), end_turn("done")];
        let (relay, server, client, direct, host_id) =
            hosted_host_with(dir.path(), web.path(), &issuer, true, |config| {
                config.backends = Some(fake(steps));
                if let Some(lifetime) = lifetime {
                    config.guest_link_lifetime = lifetime;
                }
            })
            .await;
        Self {
            relay,
            server,
            client,
            direct,
            id: host_id,
            issuer,
            _dirs: (dir, web),
        }
    }

    /// A new thread whose first turn has finished.
    async fn thread(&mut self) -> RunId {
        let params = crate::threads::start_params(None, "Explain the code");
        let thread = params.run_id;
        self.client.call::<ThreadStart>(params).await.unwrap();
        self.wait(thread).await;
        thread
    }

    /// Waits until `thread` is idle.
    async fn wait(&mut self, thread: RunId) {
        let waited = self
            .client
            .call::<AgentWait>(AgentWaitParams {
                run_ids: vec![thread],
                until: AgentWaitUntil::All,
                timeout_ms: 30_000,
            })
            .await
            .unwrap();
        assert!(!waited.timed_out, "the turn ends");
    }

    /// A link to `thread`, and a guest with a new key on a route the relay marks with it.
    async fn share(&mut self, thread: RunId, can_suggest: bool) -> (GuestLink, Guest) {
        let made = self
            .client
            .call::<GuestCreate>(GuestCreateParams {
                thread_id: thread,
                can_suggest,
            })
            .await
            .unwrap();
        let parts: Vec<_> = made.fragment.split('.').collect();
        assert_eq!(parts[..2], [self.id.as_str(), made.link.id.as_str()]);
        let secret = remote::base64url_decode(parts[2]).unwrap();
        assert_eq!(secret.len(), 32);
        let route = self.relay.route(json!({ "guest": made.link.id })).await;
        let guest = Guest {
            route,
            key: remote::DpopKey::generate(),
            host_key: remote::base64url(&hkdf(&secret, b"parallax guest host key v1")),
            pass: hkdf(&secret, b"parallax guest relay pass v1"),
        };
        (made.link, guest)
    }

    async fn links(&mut self) -> Vec<GuestLink> {
        let listed = self.client.call::<GuestList>(GuestListParams {}).await;
        listed.unwrap().links
    }

    /// Waits until the relay's last list of guest links has `count`.
    async fn relay_lists(&self, count: usize) -> Value {
        let mut last = Value::Null;
        for _ in 0..100 {
            last = self.relay.guests().unwrap_or_default();
            if last.as_array().is_some_and(|links| links.len() == count) {
                return last;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        panic!("the relay's guest links never reached {count}: {last}");
    }
}

/// HKDF-SHA256 with no salt, 32 bytes for `info`, as a browser's `WebCrypto` derives it.
fn hkdf(secret: &[u8], info: &[u8]) -> [u8; 32] {
    use ring::hkdf;
    let mut out = [0; 32];
    let info = [info];
    hkdf::Salt::new(hkdf::HKDF_SHA256, &[])
        .extract(secret)
        .expand(&info, hkdf::HKDF_SHA256)
        .unwrap()
        .fill(&mut out)
        .unwrap();
    out
}

/// A guest's browser: its route through the relay, its key, and what the link's secret derives.
struct Guest {
    route: String,
    key: remote::DpopKey,
    host_key: String,
    pass: [u8; 32],
}

impl Guest {
    /// `POST /api/auth/guest` at `route` with `host_key` and a proof from `key`: the status and
    /// answer.
    async fn sign_in_as(&self, route: &str, key: &remote::DpopKey, host_key: &str) -> (u16, Value) {
        let path = "/api/auth/guest";
        let proof = key.proof("POST", &format!("https://{route}{path}"), None);
        let body = json!({ "hostKey": host_key }).to_string();
        let port = port_of(route);
        let (status, _, answer) = https(port, "POST", path, &[("DPoP", &proof)], &body).await;
        (status, serde_json::from_slice(&answer).unwrap_or_default())
    }

    async fn sign_in(&self) -> (u16, Value) {
        self.sign_in_as(&self.route, &self.key, &self.host_key)
            .await
    }

    /// The guest's socket at `route` with a proof from `key`, initialized, if it opens.
    async fn socket_at(&self, route: &str, key: &remote::DpopKey) -> Option<Socket> {
        let (tls, _) = remote::open(route, None).await.ok()?;
        let mut request = format!("wss://{route}/ws").into_client_request().unwrap();
        let proof = key.proof("GET", &format!("https://{route}/ws"), None);
        request.headers_mut().insert("dpop", proof.parse().unwrap());
        let (socket, _) = tokio_tungstenite::client_async(request, tls).await.ok()?;
        let mut socket = Socket { socket, next_id: 1 };
        let (answer, _) = socket
            .call(
                "initialize",
                json!({
                    "protocol": { "min": 1, "max": 1 },
                    "client": { "name": "guest", "version": "0" },
                    "capabilities": {}
                }),
            )
            .await;
        assert!(answer["result"]["logId"].is_string(), "{answer}");
        Some(socket)
    }

    async fn socket(&self) -> Option<Socket> {
        self.socket_at(&self.route, &self.key).await
    }

    /// Signs in and opens the socket.
    async fn join(&self) -> Socket {
        assert_eq!(self.sign_in().await.0, 200);
        self.socket().await.expect("the guest's socket opens")
    }
}

type Stream = WebSocketStream<tokio_rustls::client::TlsStream<plxd::relay::Stream>>;

/// A guest's JSON-RPC socket.
struct Socket {
    socket: Stream,
    next_id: u64,
}

impl Socket {
    /// The next message, if one comes within `limit`. `None` too when the socket closed.
    async fn next_within(&mut self, limit: Duration) -> Option<Value> {
        loop {
            match timeout(limit, self.socket.next()).await {
                Ok(Some(Ok(Message::Text(text)))) => {
                    return Some(serde_json::from_str(&text).unwrap());
                }
                Ok(Some(Ok(Message::Ping(_) | Message::Pong(_)))) => {}
                _ => return None,
            }
        }
    }

    /// Calls `method` with `params`: its answer, and the notifications that came before it.
    async fn call(&mut self, method: &str, params: Value) -> (Value, Vec<Value>) {
        let id = self.next_id;
        self.next_id += 1;
        let request = json!({ "jsonrpc": "2.0", "id": id, "method": method, "params": params });
        self.socket
            .send(Message::text(request.to_string()))
            .await
            .unwrap();
        let mut notifications = Vec::new();
        loop {
            let message = self.next_within(PATIENCE).await.expect("an answer");
            if message["id"] == id {
                return (message, notifications);
            }
            notifications.push(message);
        }
    }

    /// The error kind `method` with `params` fails with, if it fails.
    async fn refusal(&mut self, method: &str, params: Value) -> Option<String> {
        let (answer, _) = self.call(method, params).await;
        answer["error"]["data"]["kind"].as_str().map(str::to_owned)
    }

    /// Whether plxd closes the socket within `PATIENCE`, whatever it sends first.
    async fn closes(&mut self) -> bool {
        let deadline = tokio::time::Instant::now() + PATIENCE;
        while tokio::time::Instant::now() < deadline {
            match timeout(PATIENCE, self.socket.next()).await {
                Ok(None | Some(Err(_) | Ok(Message::Close(_)))) => return true,
                Ok(Some(Ok(_))) => {}
                Err(_) => return false,
            }
        }
        false
    }
}

/// The params of `orchestration/subscribeThread` for `thread`.
fn subscribe(thread: RunId) -> Value {
    json!({ "threadId": thread })
}

const REFUSED: Option<&str> = Some("guestRefused");

/// On a live link's stream, `method` `path` gets 404 and plxd closes the stream ([`https`] reads
/// to its end).
async fn refused_on_a_guest_stream(method: &str, path: &str) {
    let mut host = Host::start(None).await;
    let thread = host.thread().await;
    let (_, guest) = host.share(thread, false).await;
    let not_found = (404, Some("not_found".to_owned()));
    assert_eq!(
        answer(&guest.route, method, path).await,
        not_found,
        "{method} {path}"
    );
    host.server.stop().await;
}

#[tokio::test]
async fn a_guest_stream_gets_no_descriptor() {
    refused_on_a_guest_stream("GET", "/.well-known/parallax").await;
}

#[tokio::test]
async fn a_guest_stream_cant_start_lan_pairing() {
    refused_on_a_guest_stream("POST", "/api/pair/start").await;
}

#[tokio::test]
async fn a_guest_stream_cant_finish_lan_pairing() {
    refused_on_a_guest_stream("POST", "/api/pair/finish").await;
}

#[tokio::test]
async fn a_guest_stream_cant_pair_a_browser_with_the_code() {
    refused_on_a_guest_stream("POST", "/api/pair/browser").await;
}

#[tokio::test]
async fn a_guest_stream_gets_no_account_sign_in() {
    refused_on_a_guest_stream("POST", "/api/auth/account").await;
}

#[tokio::test]
async fn a_guest_stream_gets_no_account_approval() {
    refused_on_a_guest_stream("POST", "/api/auth/approval").await;
}

#[tokio::test]
async fn a_guest_stream_gets_no_peer_sign_in() {
    refused_on_a_guest_stream("POST", "/api/auth/peer").await;
}

#[tokio::test]
async fn a_guest_stream_gets_no_websocket_ticket() {
    refused_on_a_guest_stream("POST", "/api/auth/websocket-ticket").await;
}

#[tokio::test]
async fn a_guest_stream_reaches_no_webhook() {
    refused_on_a_guest_stream("POST", "/api/hooks/hook1/secret").await;
}

#[tokio::test]
async fn a_guest_stream_gets_no_web_client_page() {
    refused_on_a_guest_stream("GET", "/").await;
}

#[tokio::test]
async fn a_guest_stream_gets_no_web_client_file() {
    refused_on_a_guest_stream("GET", "/assets/app-1a.js").await;
}

#[tokio::test]
async fn guest_sign_in_and_the_guest_socket_are_refused_on_every_unmarked_or_hosted_stream() {
    let mut host = Host::start(None).await;
    let thread = host.thread().await;
    let (link, guest) = host.share(thread, false).await;
    let ordinary = host.relay.route(json!({})).await;
    let hosted = host.relay.route(json!({ "client": "hosted" })).await;
    let not_found = (404, Some("not_found".to_owned()));
    for route in [&host.direct, &ordinary, &hosted] {
        let signed_in = guest.sign_in_as(route, &guest.key, &guest.host_key).await;
        assert_eq!(signed_in.0, 404, "{route}");
        assert_eq!(answer(route, "POST", "/api/auth/guest").await, not_found);
    }
    assert!(host.links().await[0].bound_at.is_none(), "none of it bound");

    // Bound on its own stream, the key's proof still opens no socket anywhere else.
    assert_eq!(guest.sign_in().await.0, 200);
    for route in [&host.direct, &ordinary, &hosted] {
        assert!(
            guest.socket_at(route, &guest.key).await.is_none(),
            "{route}"
        );
    }
    assert!(guest.socket().await.is_some());
    assert_eq!(host.links().await[0].id, link.id);
    host.server.stop().await;
}

#[tokio::test]
async fn the_first_browser_binds_the_link_and_no_other_gets_in() {
    let mut host = Host::start(None).await;
    let thread = host.thread().await;
    let (link, guest) = host.share(thread, false).await;
    assert!(link.bound_at.is_none());

    // Opening the stream, a socket before signing in, and a wrong host key bind nothing.
    assert!(guest.socket().await.is_none(), "not bound yet");
    let wrong = remote::base64url(&[1; 32]);
    let (status, why) = guest.sign_in_as(&guest.route, &guest.key, &wrong).await;
    assert_eq!(
        (status, why["error"].as_str()),
        (401, Some("invalid_grant"))
    );
    assert!(host.links().await[0].bound_at.is_none());

    // The first key with the host key binds it, and gets in again.
    let (status, signed_in) = guest.sign_in().await;
    assert_eq!(status, 200, "{signed_in}");
    assert_eq!(signed_in["threadId"], json!(thread));
    assert_eq!(signed_in["canSuggest"], false);
    let bound_at = host.links().await[0].bound_at;
    assert!(bound_at.is_some());
    assert_eq!(guest.sign_in().await.0, 200);
    assert_eq!(host.links().await[0].bound_at, bound_at, "bound once");

    // Another browser with the whole link is refused, and its socket too.
    let other = remote::DpopKey::generate();
    let (status, why) = guest
        .sign_in_as(&guest.route, &other, &guest.host_key)
        .await;
    assert_eq!(
        (status, why["error"].as_str()),
        (403, Some("access_denied"))
    );
    assert!(guest.socket_at(&guest.route, &other).await.is_none());
    assert!(guest.socket().await.is_some(), "the bound key's opens");
    host.server.stop().await;
}

#[tokio::test]
async fn guest_sign_in_refuses_a_bad_body_a_missing_proof_and_a_replayed_one() {
    let mut host = Host::start(None).await;
    let thread = host.thread().await;
    let (_, guest) = host.share(thread, false).await;
    let port = port_of(&guest.route);
    let path = "/api/auth/guest";
    let url = format!("https://{}{path}", guest.route);
    let body = json!({ "hostKey": guest.host_key }).to_string();
    let proof = guest.key.proof("POST", &url, None);

    let no_key = https(port, "POST", path, &[("DPoP", &proof)], "{}").await;
    assert_eq!(no_key.0, 400);
    let no_proof = https(port, "POST", path, &[], &body).await;
    assert_eq!(no_proof.0, 401);
    let fresh = guest.key.proof("POST", &url, None);
    assert_eq!(
        https(port, "POST", path, &[("DPoP", &fresh)], &body)
            .await
            .0,
        200
    );
    let replayed = https(port, "POST", path, &[("DPoP", &fresh)], &body).await;
    assert_eq!(replayed.0, 401, "a replayed proof");

    // A ticket opens no guest's socket, even beside the bound key's proof.
    let (tls, _) = remote::open(&guest.route, None).await.unwrap();
    let mut request = format!("wss://{}/ws?wsTicket=anything", guest.route)
        .into_client_request()
        .unwrap();
    let proof = guest
        .key
        .proof("GET", &format!("https://{}/ws", guest.route), None);
    request.headers_mut().insert("dpop", proof.parse().unwrap());
    assert!(tokio_tungstenite::client_async(request, tls).await.is_err());
    assert!(guest.socket().await.is_some(), "without one it opens");
    host.server.stop().await;
}

#[tokio::test]
async fn a_guest_is_refused_every_method_outside_its_list_and_every_other_thread() {
    let mut host = Host::start(None).await;
    let (thread, other) = (host.thread().await, host.thread().await);
    let (_, guest) = host.share(thread, true).await;
    let mut socket = guest.join().await;
    let allowed = [
        "events/unsubscribe",
        "orchestration/subscribeThread",
        "orchestration/threadHistory",
        "guest/suggest",
    ];
    for method in RequestName::ALL.iter().map(|method| method.name()) {
        if allowed.contains(&method) {
            continue;
        }
        let params = json!({ "threadId": thread, "runId": thread });
        assert_eq!(
            socket.refusal(method, params).await.as_deref(),
            REFUSED,
            "{method}"
        );
    }

    // Each allowed method checks the thread id.
    assert_eq!(
        socket
            .refusal("orchestration/subscribeThread", subscribe(other))
            .await
            .as_deref(),
        REFUSED
    );
    let history = |thread| json!({ "threadId": thread, "before": 1_000_000 });
    assert_eq!(
        socket
            .refusal("orchestration/threadHistory", history(other))
            .await
            .as_deref(),
        REFUSED
    );
    let suggest = |thread| json!({ "threadId": thread, "text": "Try the other file" });
    assert_eq!(
        socket
            .refusal("guest/suggest", suggest(other))
            .await
            .as_deref(),
        REFUSED
    );
    assert_eq!(
        socket
            .refusal("orchestration/threadHistory", history(thread))
            .await,
        None
    );
    // Writes to a terminal or device are dropped, and the socket still answers.
    let write = json!({ "jsonrpc": "2.0", "method": "terminal/write", "params": {
        "threadId": thread, "terminalId": "t", "data": "ls\n" } });
    socket
        .socket
        .send(Message::text(write.to_string()))
        .await
        .unwrap();
    assert_eq!(
        socket
            .refusal("orchestration/subscribeThread", subscribe(thread))
            .await,
        None
    );
    host.server.stop().await;
}

#[tokio::test]
async fn a_guest_sees_only_its_threads_events_of_the_listed_kinds() {
    let mut host = Host::start(None).await;
    let (thread, other) = (host.thread().await, host.thread().await);
    let (_, guest) = host.share(thread, false).await;
    let mut socket = guest.join().await;
    let (answer, _) = socket
        .call("orchestration/subscribeThread", subscribe(thread))
        .await;
    let snapshot = &answer["result"]["snapshot"];
    let events = snapshot["events"].as_array().unwrap();
    assert!(!events.is_empty(), "{snapshot}");
    for logged in events {
        let event = &logged["event"];
        assert!(SHOWN.contains(&event["kind"].as_str().unwrap()), "{event}");
        assert_eq!(event["runId"], json!(thread));
    }
    for hidden in ["requests", "background", "watching"] {
        assert!(
            snapshot[hidden].as_array().is_none_or(Vec::is_empty),
            "{hidden}"
        );
    }
    // Older pages hold the same, though the thread's own log has more kinds.
    let (page, _) = socket
        .call(
            "orchestration/threadHistory",
            json!({ "threadId": thread, "before": 1_000_000 }),
        )
        .await;
    let page = page["result"]["events"].as_array().unwrap().clone();
    assert!(!page.is_empty());
    for logged in &page {
        assert!(
            SHOWN.contains(&logged["event"]["kind"].as_str().unwrap()),
            "{logged}"
        );
    }
    let owner = host
        .client
        .call::<parallax_protocol::methods::OrchestrationThreadHistory>(
            parallax_protocol::ThreadHistoryParams {
                thread_id: thread,
                before: 1_000_000,
            },
        )
        .await
        .unwrap();
    assert!(owner.events.len() > page.len(), "the owner's page has more");

    // Another turn on the other thread, then on this one: only this one's listed events come.
    for run in [other, thread] {
        let send = send_params(run, TurnId::generate(), "Once more");
        host.client.call::<AgentSend>(send).await.unwrap();
        host.wait(run).await;
    }
    let mut seen = Vec::new();
    while let Some(message) = socket.next_within(Duration::from_secs(2)).await {
        seen.push(message);
    }
    assert!(!seen.is_empty(), "this thread's turn reaches the guest");
    for message in &seen {
        assert_eq!(message["method"], "events/event", "{message}");
        let event = &message["params"]["event"];
        assert!(SHOWN.contains(&event["kind"].as_str().unwrap()), "{event}");
        assert_eq!(event["runId"], json!(thread), "{event}");
    }
    host.server.stop().await;
}

#[tokio::test]
async fn a_guests_reads_stop_at_ten_a_minute() {
    let mut host = Host::start(None).await;
    let thread = host.thread().await;
    let (_, guest) = host.share(thread, false).await;
    let mut socket = guest.join().await;
    let history = json!({ "threadId": thread, "before": 1_000_000 });
    for read in 0..10 {
        let refused = socket
            .refusal("orchestration/threadHistory", history.clone())
            .await;
        assert_eq!(refused, None, "read {read}");
    }
    assert_eq!(
        socket
            .refusal("orchestration/threadHistory", history.clone())
            .await
            .as_deref(),
        Some("guestRateLimited")
    );
    // A second socket of the same link shares the limit.
    let mut again = guest.socket().await.unwrap();
    assert_eq!(
        again
            .refusal("orchestration/threadHistory", history)
            .await
            .as_deref(),
        Some("guestRateLimited")
    );
    host.server.stop().await;
}

/// How a test ends a live link.
async fn ends_the_link(host: &mut Host, thread: RunId, link: &GuestLink, how: &str) {
    match how {
        "revoke" => {
            let left = host
                .client
                .call::<GuestRevoke>(GuestRevokeParams {
                    link: link.id.clone(),
                })
                .await
                .unwrap();
            assert!(left.links.is_empty());
        }
        "new link" => {
            let made = host
                .client
                .call::<GuestCreate>(GuestCreateParams {
                    thread_id: thread,
                    can_suggest: false,
                })
                .await
                .unwrap();
            assert_ne!(made.link.id, link.id);
        }
        "archive" => {
            let archive = ThreadArchiveParams {
                run_id: thread,
                archived: true,
            };
            host.client.call::<ThreadArchive>(archive).await.unwrap();
        }
        "delete" => {
            let delete = ThreadDeleteParams { run_id: thread };
            host.client.call::<ThreadDelete>(delete).await.unwrap();
        }
        "hosted client off" => set_hosted(&mut host.client, false).await,
        "expiry" => {}
        other => panic!("{other}"),
    }
}

/// A guest with its socket open sees it close when the link ends `how`. The link leaves the
/// owner's list and the relay's, and a new stream for it is refused unjoined.
async fn a_live_guest_is_cut_off(how: &str) {
    let lifetime = (how == "expiry").then_some(Duration::from_secs(4));
    let mut host = Host::start(lifetime).await;
    let thread = host.thread().await;
    let (link, guest) = host.share(thread, false).await;
    let listed = host.relay_lists(1).await;
    assert_eq!(listed[0]["link"], link.id);
    let pass = remote::hex(&remote::sha256(&guest.pass));
    assert_eq!(listed[0]["pass"], pass, "the SHA-256 of the relay pass");
    assert_eq!(listed[0]["expires"], link.expires_at.as_second());
    let mut socket = guest.join().await;

    ends_the_link(&mut host, thread, &link, how).await;
    assert!(socket.closes().await, "{how} closes the guest's socket");
    let live: Vec<_> = host.links().await.into_iter().map(|l| l.id).collect();
    assert!(!live.contains(&link.id), "{how}");
    let left = usize::from(how == "new link");
    let listed = host.relay_lists(left).await;
    assert!(
        listed
            .as_array()
            .unwrap()
            .iter()
            .all(|l| l["link"] != link.id)
    );
    let unjoined = host.relay.unjoined().len();
    assert!(guest.socket().await.is_none(), "{how}");
    assert_eq!(
        host.relay.unjoined().len(),
        unjoined + 1,
        "refused unjoined"
    );
    host.server.stop().await;
}

#[tokio::test]
async fn stop_sharing_cuts_off_a_live_guest() {
    a_live_guest_is_cut_off("revoke").await;
}

#[tokio::test]
async fn a_new_link_cuts_off_the_threads_live_guest() {
    a_live_guest_is_cut_off("new link").await;
}

#[tokio::test]
async fn archiving_the_thread_cuts_off_its_live_guest() {
    a_live_guest_is_cut_off("archive").await;
}

#[tokio::test]
async fn deleting_the_thread_cuts_off_its_live_guest() {
    a_live_guest_is_cut_off("delete").await;
}

#[tokio::test]
async fn the_hosted_client_turning_off_cuts_off_every_live_guest() {
    a_live_guest_is_cut_off("hosted client off").await;
}

#[tokio::test]
async fn expiry_cuts_off_a_live_guest() {
    a_live_guest_is_cut_off("expiry").await;
}

#[tokio::test]
async fn only_a_full_access_session_makes_a_link_and_only_while_the_hosted_client_is_on() {
    let mut host = Host::start(None).await;
    let thread = host.thread().await;
    let create = |thread| GuestCreateParams {
        thread_id: thread,
        can_suggest: false,
    };

    // Off, archived, and unknown threads get no link.
    set_hosted(&mut host.client, false).await;
    let off = host.client.call::<GuestCreate>(create(thread)).await;
    assert_eq!(kind(&off.unwrap_err()), ErrorKind::GuestRefused);
    set_hosted(&mut host.client, true).await;
    let unknown = host
        .client
        .call::<GuestCreate>(create(RunId::generate()))
        .await;
    assert_eq!(kind(&unknown.unwrap_err()), ErrorKind::ThreadNotFound);
    let archived = host.thread().await;
    let archive = ThreadArchiveParams {
        run_id: archived,
        archived: true,
    };
    host.client.call::<ThreadArchive>(archive).await.unwrap();
    let refused = host.client.call::<GuestCreate>(create(archived)).await;
    assert_eq!(kind(&refused.unwrap_err()), ErrorKind::GuestRefused);

    // A read-only device can't make, list, or end one.
    let device = temp_dir();
    let token = token(&host.issuer, USER);
    let direct = host.direct.clone();
    let host_id = host.id.clone();
    allowed(
        &direct,
        &host_id,
        &token,
        device.path(),
        &mut host.client,
        Some(true),
    )
    .await;
    let mut app = open_account(&[direct], &host_id, device.path())
        .await
        .unwrap();
    app.initialize().await;
    let params = format!(r#"{{"threadId":"{thread}"}}"#);
    for (id, method) in [(2, "guest/create"), (3, "guest/list"), (4, "guest/revoke")] {
        let params = if method == "guest/revoke" {
            r#"{"link":"x"}"#.to_owned()
        } else {
            params.clone()
        };
        let refused = refusal(&mut app, id, method, &params).await;
        assert_eq!(refused.as_deref(), Some("readOnly"), "{method}");
    }
    assert!(host.links().await.is_empty());
    host.server.stop().await;
}

#[tokio::test]
async fn a_guests_suggestion_waits_until_the_owner_sends_or_dismisses_it() {
    let mut host = Host::start(None).await;
    let thread = host.thread().await;

    // Without "can suggest messages", a guest can't.
    let (_, guest) = host.share(thread, false).await;
    let mut socket = guest.join().await;
    let suggest = |text: &str| json!({ "threadId": thread, "text": text });
    assert_eq!(
        socket
            .refusal("guest/suggest", suggest("Hi"))
            .await
            .as_deref(),
        REFUSED
    );

    // With it, the message waits in the link, and nothing runs.
    let (link, guest) = host.share(thread, true).await;
    let mut socket = guest.join().await;
    let (answer, _) = socket.call("guest/suggest", suggest("Add a test")).await;
    let first: TurnId =
        serde_json::from_value(answer["result"]["suggestion"]["id"].clone()).unwrap();
    let (answer, _) = socket.call("guest/suggest", suggest("Rename it")).await;
    let second: TurnId =
        serde_json::from_value(answer["result"]["suggestion"]["id"].clone()).unwrap();
    let waiting = &host.links().await[0];
    let texts: Vec<_> = waiting
        .suggestions
        .iter()
        .map(|s| s.text.as_str())
        .collect();
    assert_eq!(texts, ["Add a test", "Rename it"]);

    // Dismissed, it's gone. Sent, it runs as the owner's turn.
    let answer = |suggestion| GuestSuggestionParams {
        link: link.id.clone(),
        suggestion,
    };
    let left = host
        .client
        .call::<GuestDismiss>(answer(second))
        .await
        .unwrap();
    assert_eq!(left.links[0].suggestions.len(), 1);
    let left = host.client.call::<GuestSend>(answer(first)).await.unwrap();
    assert!(left.links[0].suggestions.is_empty());
    host.wait(thread).await;
    let (history, _) = socket
        .call(
            "orchestration/threadHistory",
            json!({ "threadId": thread, "before": 1_000_000 }),
        )
        .await;
    let events = history["result"]["events"].as_array().unwrap();
    let sent = events
        .iter()
        .any(|logged| logged["event"].to_string().contains("Add a test"));
    assert!(sent, "the sent message is in the thread");
    let again = host.client.call::<GuestSend>(answer(first)).await;
    assert_eq!(kind(&again.unwrap_err()), ErrorKind::GuestRefused);

    // Only a guest suggests.
    let owner = host
        .client
        .call::<parallax_protocol::methods::GuestSuggest>(parallax_protocol::GuestSuggestParams {
            thread_id: thread,
            text: "Mine".to_owned(),
        })
        .await;
    assert_eq!(kind(&owner.unwrap_err()), ErrorKind::GuestRefused);
    assert!(host.links().await[0].suggestions.is_empty());
    host.server.stop().await;
}
