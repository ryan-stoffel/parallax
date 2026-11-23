//! The hosted browser client on plxd's side (0108): the `hostedClient` switch, the streams the
//! relay marks as the hosted client's or a guest's, and the keys that sign in through it. A fake
//! relay on loopback marks each stream as its route says, as the real one will (PLX-1616), and
//! carries it to plxd's listener.

use std::collections::HashMap;
use std::path::Path;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

use futures_util::{SinkExt as _, StreamExt as _};
use parallax_protocol::methods::{
    AccessApprove, AccessDeny, AccessMerge, AccessSetupCode, HostSettingsSet,
};
use parallax_protocol::{
    AccessApproveParams, AccessMergeParams, AccessRequestParams, AccessSetupCodeParams,
    HostSettingsSetParams,
};
use plxd::remote::{self, SignIn};
use serde_json::{Value, json};
use tokio::io::{AsyncReadExt as _, AsyncWriteExt as _};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::{Notify, mpsc, oneshot, watch};
use tokio::time::timeout;
use tokio_tungstenite::WebSocketStream;
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::tungstenite::handshake::server::{ErrorResponse, Request, Response};

use crate::account::{USER, access, clerk, config, host_at, oauth_token, thumbprint, token};
use crate::connect::free_port;
use crate::remote::{LOOPBACK, https, open_account, refusal};
use crate::support::{Client, InProcess, PATIENCE, temp_dir};

/// The hosted client's OAuth application, which these hosts trust.
const HOSTED_APP: &str = "hosted-app";

/// What plxd says to a hosted client while `hostedClient` is off.
const HOSTED_OFF: &str = "The hosted client is off on this computer";

/// Streams announced and not joined yet: each waits for plxd's socket under its id.
type Joins = Arc<Mutex<HashMap<String, oneshot::Sender<WebSocketStream<TcpStream>>>>>;

/// A relay on loopback. It takes plxd's control socket, and for each connection to a route it
/// made, announces a stream marked as that route says, then carries the connection over the
/// stream plxd joins. A stream plxd says is gone before it joined closes its connection.
pub(crate) struct FakeRelay {
    url: String,
    control: mpsc::UnboundedSender<String>,
    joins: Joins,
    /// The streams plxd said were gone without joining them.
    unjoined: Arc<Mutex<Vec<String>>>,
    /// Each list of guest links plxd sent, oldest first (0108).
    guests: Arc<Mutex<Vec<Value>>>,
    next: Arc<AtomicUsize>,
    /// While true, plxd's joins wait before their handshake.
    holding: watch::Sender<bool>,
    /// Told when a join starts waiting.
    held: Arc<Notify>,
}

impl FakeRelay {
    async fn start() -> Self {
        let listener = TcpListener::bind((LOOPBACK, 0)).await.unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let (control, frames) = mpsc::unbounded_channel::<String>();
        let frames = Arc::new(tokio::sync::Mutex::new(frames));
        let joins = Joins::default();
        let unjoined = Arc::new(Mutex::new(Vec::new()));
        let guests = Arc::new(Mutex::new(Vec::new()));
        let (all_joins, all_unjoined) = (Arc::clone(&joins), Arc::clone(&unjoined));
        let all_guests = Arc::clone(&guests);
        let (holding, gate) = watch::channel(false);
        let held = Arc::new(Notify::new());
        let all_held = Arc::clone(&held);
        tokio::spawn(async move {
            while let Ok((tcp, _)) = listener.accept().await {
                let frames = Arc::clone(&frames);
                let (joins, unjoined) = (Arc::clone(&all_joins), Arc::clone(&all_unjoined));
                let guests = Arc::clone(&all_guests);
                let (mut gate, held) = (gate.clone(), Arc::clone(&all_held));
                tokio::spawn(async move {
                    let mut request_line = [0; 512];
                    let peeked = tcp.peek(&mut request_line).await.unwrap_or(0);
                    let join =
                        String::from_utf8_lossy(&request_line[..peeked]).contains("/streams/");
                    if join && *gate.borrow_and_update() {
                        held.notify_one();
                        let _ = gate.wait_for(|on| !on).await;
                    }
                    let mut path = String::new();
                    #[expect(clippy::result_large_err, reason = "tungstenite's callback type")]
                    let read_path = |request: &Request, response: Response| {
                        request.uri().path().clone_into(&mut path);
                        Ok::<_, ErrorResponse>(response)
                    };
                    let Ok(socket) = tokio_tungstenite::accept_hdr_async(tcp, read_path).await
                    else {
                        return;
                    };
                    if let Some((_, id)) = path.split_once("/streams/") {
                        let waiting = joins.lock().unwrap().remove(id);
                        if let Some(waiting) = waiting {
                            let _ = waiting.send(socket);
                        }
                    } else {
                        let mut frames = frames.lock().await;
                        control_socket(socket, &mut frames, &joins, (&unjoined, &guests)).await;
                    }
                });
            }
        });
        Self {
            url,
            control,
            joins,
            unjoined,
            guests,
            next: Arc::default(),
            holding,
            held,
        }
    }

    /// Holds plxd's joins of streams before their handshake while `on`, and lets them go after.
    fn hold(&self, on: bool) {
        self.holding.send_replace(on);
    }

    /// Waits until a join is held.
    async fn join_held(&self) {
        timeout(PATIENCE, self.held.notified()).await.unwrap();
    }

    /// A route whose every connection the relay announces with `mark` added to its `open` frame.
    pub(crate) async fn route(&self, mark: Value) -> String {
        let listener = TcpListener::bind((LOOPBACK, 0)).await.unwrap();
        let route = format!("127.0.0.1:{}", listener.local_addr().unwrap().port());
        let (control, joins, next) = (
            self.control.clone(),
            Arc::clone(&self.joins),
            Arc::clone(&self.next),
        );
        tokio::spawn(async move {
            while let Ok((tcp, _)) = listener.accept().await {
                let id = format!("s{}", next.fetch_add(1, Ordering::Relaxed));
                let (joined, join) = oneshot::channel();
                joins.lock().unwrap().insert(id.clone(), joined);
                let mut open = json!({ "t": "open", "stream": id, "token": "tok" });
                for (name, value) in mark.as_object().unwrap() {
                    open[name] = value.clone();
                }
                control.send(open.to_string()).unwrap();
                tokio::spawn(async move {
                    if let Ok(Ok(socket)) = timeout(PATIENCE, join).await {
                        carry(tcp, socket).await;
                    }
                });
            }
        });
        route
    }

    pub(crate) fn unjoined(&self) -> Vec<String> {
        self.unjoined.lock().unwrap().clone()
    }

    /// The last list of guest links plxd sent, if it sent one.
    pub(crate) fn guests(&self) -> Option<Value> {
        self.guests.lock().unwrap().last().cloned()
    }
}

/// Serves plxd's control socket: says it's ready, sends what waits in `frames`, answers its pings,
/// drops the stream it says is gone before joining it, and keeps each list of guest links.
async fn control_socket(
    mut socket: WebSocketStream<TcpStream>,
    frames: &mut mpsc::UnboundedReceiver<String>,
    joins: &Joins,
    (unjoined, guests): (&Mutex<Vec<String>>, &Mutex<Vec<Value>>),
) {
    if socket
        .send(Message::text(r#"{"t":"ready"}"#))
        .await
        .is_err()
    {
        return;
    }
    loop {
        tokio::select! {
            Some(frame) = frames.recv() => {
                if socket.send(Message::text(frame)).await.is_err() {
                    return;
                }
            }
            read = socket.next() => {
                let Some(Ok(Message::Text(text))) = read else {
                    return;
                };
                if text.as_str() == "ping" {
                    if socket.send(Message::text("pong")).await.is_err() {
                        return;
                    }
                    continue;
                }
                let frame: Value = serde_json::from_str(&text).unwrap_or_default();
                if frame["t"] == "guests" {
                    guests.lock().unwrap().push(frame["links"].clone());
                }
                if frame["t"] == "gone"
                    && let Some(id) = frame["stream"].as_str()
                    && joins.lock().unwrap().remove(id).is_some()
                {
                    unjoined.lock().unwrap().push(id.to_owned());
                }
            }
        }
    }
}

/// Carries `tcp` over plxd's end of a stream, each way, until either ends.
async fn carry(tcp: TcpStream, socket: WebSocketStream<TcpStream>) {
    let (mut read, mut write) = tcp.into_split();
    let (mut sink, mut stream) = socket.split();
    let up = async {
        let mut buffer = vec![0; 16 * 1024];
        while let Ok(n @ 1..) = read.read(&mut buffer).await {
            if sink
                .send(Message::binary(buffer[..n].to_vec()))
                .await
                .is_err()
            {
                break;
            }
        }
        let _ = sink.close().await;
    };
    let down = async {
        while let Some(Ok(message)) = stream.next().await {
            match message {
                Message::Binary(bytes) => {
                    if write.write_all(&bytes).await.is_err() {
                        break;
                    }
                }
                Message::Close(_) => break,
                _ => {}
            }
        }
        let _ = write.shutdown().await;
    };
    tokio::join!(up, down);
}

pub(crate) fn port_of(route: &str) -> u16 {
    route.rsplit(':').next().unwrap().parse().unwrap()
}

/// A host behind a fake relay, trusting the hosted client's application, with `hostedClient` as
/// `on` says, and the web client on with its files: the relay, the server, a client on its socket,
/// its loopback route, and its host id. The web folder must outlive the server.
async fn hosted_host(
    dir: &Path,
    web: &Path,
    issuer: &str,
    on: bool,
) -> (FakeRelay, InProcess, Client, String, String) {
    hosted_host_with(dir, web, issuer, on, |_| {}).await
}

/// [`hosted_host`], with `edit` changing the host's config first.
pub(crate) async fn hosted_host_with(
    dir: &Path,
    web: &Path,
    issuer: &str,
    on: bool,
    edit: impl FnOnce(&mut plxd::server::Config),
) -> (FakeRelay, InProcess, Client, String, String) {
    std::fs::create_dir_all(web.join("assets")).unwrap();
    std::fs::write(web.join("web.html"), "<!doctype html>web").unwrap();
    std::fs::write(web.join("assets/app-1a.js"), "app()").unwrap();
    let relay = FakeRelay::start().await;
    let mut config = config(dir, issuer, &relay.url, free_port());
    config.clerk.hosted_client_ids = vec![HOSTED_APP.to_owned()];
    config.remote_web_dir = Some(web.to_owned());
    edit(&mut config);
    let (server, mut client, route, host_id) = host_at(config).await;
    client
        .call::<HostSettingsSet>(HostSettingsSetParams {
            remote_web: Some(true),
            ..HostSettingsSetParams::default()
        })
        .await
        .unwrap();
    set_hosted(&mut client, on).await;
    (relay, server, client, route, host_id)
}

/// A host on loopback alone, trusting the hosted client's application, with `hostedClient` off:
/// the server, a client on its socket, its route, and its host id.
async fn direct_host(dir: &Path, issuer: &str) -> (InProcess, Client, String, String) {
    // Nothing answers here, so no relay is reached.
    let mut config = config(dir, issuer, "http://127.0.0.1:9", free_port());
    config.clerk.hosted_client_ids = vec![HOSTED_APP.to_owned()];
    host_at(config).await
}

pub(crate) async fn set_hosted(client: &mut Client, on: bool) {
    let settings = client
        .call::<HostSettingsSet>(HostSettingsSetParams {
            hosted_client: Some(on),
            ..HostSettingsSetParams::default()
        })
        .await
        .unwrap();
    assert_eq!(settings.hosted_client, Some(on));
}

/// A fresh token of the hosted client's application, for [`USER`].
pub(crate) fn hosted_token(issuer: &str) -> String {
    oauth_token(issuer, USER, HOSTED_APP)
}

/// Signs in at `route` with `token` from the computer whose data folder is `dir`: the request it
/// waits on.
async fn ask(route: &str, host_id: &str, token: &str, dir: &Path) -> String {
    let routes = [route.to_owned()];
    let (_, signed_in) = remote::sign_in(&routes, host_id, token, "browser", false, dir)
        .await
        .unwrap();
    let SignIn::Pending { request, .. } = signed_in else {
        panic!("a new device waits: {signed_in:?}");
    };
    request
}

/// [`ask`], then `client` allows the request with `read_only`, and the device gets its session.
pub(crate) async fn allowed(
    route: &str,
    host_id: &str,
    token: &str,
    dir: &Path,
    client: &mut Client,
    read_only: Option<bool>,
) {
    let request = ask(route, host_id, token, dir).await;
    approve(route, host_id, request, dir, client, read_only).await;
}

/// `client` allows `request`, from the computer whose data folder is `dir`, with `read_only`, and
/// the device gets its session.
async fn approve(
    route: &str,
    host_id: &str,
    request: String,
    dir: &Path,
    client: &mut Client,
    read_only: Option<bool>,
) {
    let waiting = {
        let (route, host_id, request) = (route.to_owned(), host_id.to_owned(), request.clone());
        let dir = dir.to_owned();
        tokio::spawn(async move { remote::await_approval(&route, &host_id, &request, &dir).await })
    };
    client
        .call::<AccessApprove>(AccessApproveParams { request, read_only })
        .await
        .unwrap();
    let approved = waiting.await.unwrap();
    assert!(
        matches!(approved, Ok(SignIn::Approved { .. })),
        "{approved:?}"
    );
}

/// The status of `method` `path` at `route`, and the `error` its answer names, if any.
pub(crate) async fn answer(route: &str, method: &str, path: &str) -> (u16, Option<String>) {
    let (status, _, body) = https(port_of(route), method, path, &[], "").await;
    let error = serde_json::from_slice::<Value>(&body)
        .ok()
        .and_then(|body| body["error"].as_str().map(str::to_owned));
    (status, error)
}

/// On a stream the relay marked as the hosted client's, `method` `path` gets 404 and plxd closes
/// the stream ([`https`] reads to its end). The same request on an ordinary stream through the
/// same relay is served.
async fn refused_on_a_hosted_stream(method: &str, path: &str) {
    let issuer = clerk().await;
    let (dir, web) = (temp_dir(), temp_dir());
    let (relay, server, _client, _, _) = hosted_host(dir.path(), web.path(), &issuer, true).await;
    let hosted = relay.route(json!({ "client": "hosted" })).await;
    let ordinary = relay.route(json!({})).await;
    let not_found = (404, Some("not_found".to_owned()));
    assert_eq!(
        answer(&hosted, method, path).await,
        not_found,
        "{method} {path}"
    );
    assert_ne!(
        answer(&ordinary, method, path).await,
        not_found,
        "{method} {path}"
    );
    server.stop().await;
}

#[tokio::test]
async fn a_hosted_stream_gets_no_descriptor() {
    refused_on_a_hosted_stream("GET", "/.well-known/parallax").await;
}

#[tokio::test]
async fn a_hosted_stream_cant_start_lan_pairing() {
    refused_on_a_hosted_stream("POST", "/api/pair/start").await;
}

#[tokio::test]
async fn a_hosted_stream_cant_finish_lan_pairing() {
    refused_on_a_hosted_stream("POST", "/api/pair/finish").await;
}

#[tokio::test]
async fn a_hosted_stream_cant_pair_a_browser_with_the_code() {
    refused_on_a_hosted_stream("POST", "/api/pair/browser").await;
}

#[tokio::test]
async fn a_hosted_stream_gets_no_peer_sign_in() {
    refused_on_a_hosted_stream("POST", "/api/auth/peer").await;
}

#[tokio::test]
async fn a_hosted_stream_gets_no_websocket_ticket() {
    refused_on_a_hosted_stream("POST", "/api/auth/websocket-ticket").await;
}

#[tokio::test]
async fn a_hosted_stream_reaches_no_webhook() {
    refused_on_a_hosted_stream("POST", "/api/hooks/hook1/secret").await;
}

#[tokio::test]
async fn a_hosted_stream_gets_no_web_client_page() {
    refused_on_a_hosted_stream("GET", "/").await;
}

#[tokio::test]
async fn a_hosted_stream_gets_no_web_client_file() {
    refused_on_a_hosted_stream("GET", "/assets/app-1a.js").await;
}

#[tokio::test]
async fn hosted_and_guest_streams_are_refused_while_off_and_a_hosted_browser_starts_read_only() {
    let issuer = clerk().await;
    let (dir, web, browser) = (temp_dir(), temp_dir(), temp_dir());
    let (relay, server, mut client, _, host_id) =
        hosted_host(dir.path(), web.path(), &issuer, false).await;
    let hosted = relay.route(json!({ "client": "hosted" })).await;
    let guest = relay.route(json!({ "guest": "link1" })).await;
    let ordinary = relay.route(json!({})).await;

    // Off: plxd says each marked stream is gone and never joins it, so no TLS starts. An ordinary
    // stream still works.
    for route in [&hosted, &guest] {
        assert!(remote::open(route, None).await.is_err(), "{route}");
    }
    assert_eq!(relay.unjoined().len(), 2);
    let (status, _) = answer(&ordinary, "GET", "/.well-known/parallax").await;
    assert_eq!(status, 200);

    // On: a hosted stream takes account sign-in, and a guest's for a link that isn't live is still
    // refused unjoined (PLX-1618).
    set_hosted(&mut client, true).await;
    assert!(remote::open(&guest, None).await.is_err());
    assert_eq!(relay.unjoined().len(), 3);
    allowed(
        &hosted,
        &host_id,
        &hosted_token(&issuer),
        browser.path(),
        &mut client,
        None,
    )
    .await;
    let key = thumbprint(browser.path());
    assert!(access(&mut client).await.read_only_clients.contains(&key));
    let routes = [hosted.clone()];
    let mut app = open_account(&routes, &host_id, browser.path())
        .await
        .unwrap();
    app.initialize().await;
    assert_eq!(refusal(&mut app, 2, "thread/list", "{}").await, None);
    assert_eq!(
        refusal(&mut app, 3, "host/settings/set", r#"{"autoResume":false}"#).await,
        Some("readOnly".to_owned()),
        "read-only by default"
    );

    // Off again cuts the stream, and its key can't get back in. Its session stays for later.
    set_hosted(&mut client, false).await;
    assert!(app.closes().await, "turning it off closes the socket");
    assert!(
        open_account(&routes, &host_id, browser.path())
            .await
            .is_err()
    );
    let unjoined = relay.unjoined().len();
    assert!(unjoined > 2, "the new streams were refused unjoined");

    // On again lets it back in.
    set_hosted(&mut client, true).await;
    let mut app = open_account(&routes, &host_id, browser.path())
        .await
        .unwrap();
    app.initialize().await;
    server.stop().await;
}

#[tokio::test]
async fn a_sign_in_is_the_hosted_clients_by_its_tokens_application_on_any_stream() {
    let issuer = clerk().await;
    let dir = temp_dir();
    let (server, mut client, route, host_id) = direct_host(dir.path(), &issuer).await;
    let (phone, browser) = (temp_dir(), temp_dir());

    // The desktop's or phone's token isn't the hosted client's, so the switch doesn't touch it.
    let request = ask(&route, &host_id, &token(&issuer, USER), phone.path()).await;
    assert!(!access(&mut client).await.pending.unwrap().hosted);
    client
        .call::<AccessDeny>(AccessRequestParams { request })
        .await
        .unwrap();

    // The hosted client's token is, on an unmarked stream too, so it's refused while off.
    let routes = [route.clone()];
    let refused = remote::sign_in(
        &routes,
        &host_id,
        &hosted_token(&issuer),
        "browser",
        false,
        browser.path(),
    )
    .await;
    assert!(
        matches!(refused, Err(remote::Error::Refused)),
        "{refused:?}"
    );
    let port = port_of(&route);
    let key = remote::DpopKey::generate();
    let token = hosted_token(&issuer);
    let path = "/api/auth/account";
    let proof = key.proof("POST", &format!("https://{route}{path}"), Some(&token));
    let body = json!({ "token": token, "clientLabel": "browser" }).to_string();
    let (status, _, why) = https(port, "POST", path, &[("DPoP", &proof)], &body).await;
    assert_eq!(status, 403);
    let why: Value = serde_json::from_slice(&why).unwrap();
    assert_eq!(why["error_description"], HOSTED_OFF);

    // On, its request says it's the hosted client's, and its session closes when the switch
    // turns off.
    set_hosted(&mut client, true).await;
    let request = ask(&route, &host_id, &hosted_token(&issuer), browser.path()).await;
    assert!(access(&mut client).await.pending.unwrap().hosted);
    approve(&route, &host_id, request, browser.path(), &mut client, None).await;
    let mut app = open_account(&routes, &host_id, browser.path())
        .await
        .unwrap();
    app.initialize().await;
    set_hosted(&mut client, false).await;
    assert!(app.closes().await, "a hosted key's socket closes");
    assert!(
        open_account(&routes, &host_id, browser.path())
            .await
            .is_err()
    );
    server.stop().await;
}

#[tokio::test]
async fn allow_is_read_only_by_default_for_a_hosted_clients_request_alone() {
    let issuer = clerk().await;
    let dir = temp_dir();
    let (server, mut client, route, host_id) = direct_host(dir.path(), &issuer).await;
    set_hosted(&mut client, true).await;
    let cases = [
        (hosted_token(&issuer), None, true),
        (hosted_token(&issuer), Some(false), false),
        (token(&issuer, USER), None, false),
        (token(&issuer, USER), Some(true), true),
    ];
    for (token, read_only, marked) in cases {
        let device = temp_dir();
        allowed(
            &route,
            &host_id,
            &token,
            device.path(),
            &mut client,
            read_only,
        )
        .await;
        let key = thumbprint(device.path());
        let state = access(&mut client).await;
        assert!(state.approved_clients.contains(&key));
        assert_eq!(
            state.read_only_clients.contains(&key),
            marked,
            "{read_only:?}"
        );
    }
    server.stop().await;
}

#[tokio::test]
async fn a_browser_approved_on_one_computer_is_refused_on_another_with_the_hosted_client_off() {
    let issuer = clerk().await;
    let (a_dir, b_dir, browser) = (temp_dir(), temp_dir(), temp_dir());
    let (a, mut a_client, a_route, a_id) = direct_host(a_dir.path(), &issuer).await;
    let (b, mut b_client, b_route, b_id) = direct_host(b_dir.path(), &issuer).await;
    set_hosted(&mut a_client, true).await;
    allowed(
        &a_route,
        &a_id,
        &hosted_token(&issuer),
        browser.path(),
        &mut a_client,
        None,
    )
    .await;

    // A's lists reach B, as the user's apps copy them between computers (0091).
    let lists = access(&mut a_client).await;
    let key = thumbprint(browser.path());
    assert!(lists.approved_clients.contains(&key));
    let merged = b_client
        .call::<AccessMerge>(AccessMergeParams {
            approved_clients: lists.approved_clients,
            removed_clients: lists.removed_clients,
            approved_hosts: lists.approved_hosts,
            allowed_hosts: lists.allowed_hosts,
            read_only_clients: lists.read_only_clients,
        })
        .await
        .unwrap();
    assert!(merged.approved_clients.contains(&key));

    // B judges the key from its own sign-in's token, and its own switch is off.
    let b_routes = [b_route];
    let sign_in = async || {
        remote::sign_in(
            &b_routes,
            &b_id,
            &hosted_token(&issuer),
            "browser",
            false,
            browser.path(),
        )
        .await
    };
    let refused = sign_in().await;
    assert!(
        matches!(refused, Err(remote::Error::Refused)),
        "{refused:?}"
    );

    // Turned on there, A's approval is enough.
    set_hosted(&mut b_client, true).await;
    let admitted = sign_in().await;
    assert!(
        matches!(admitted, Ok((_, SignIn::Approved { .. }))),
        "{admitted:?}"
    );
    a.stop().await;
    b.stop().await;
}

#[tokio::test]
async fn a_hosted_request_a_setup_command_names_still_needs_the_owners_allow() {
    let issuer = clerk().await;
    let (dir, browser) = (temp_dir(), temp_dir());
    let (server, mut client, route, host_id) = direct_host(dir.path(), &issuer).await;
    set_hosted(&mut client, true).await;
    // The command names the browser's key, as a bad page could talk its user into.
    client
        .call::<AccessSetupCode>(AccessSetupCodeParams {
            device: Some(thumbprint(browser.path())),
        })
        .await
        .unwrap();
    let routes = [route.clone()];
    let (_, signed_in) = remote::sign_in(
        &routes,
        &host_id,
        &hosted_token(&issuer),
        "browser",
        true,
        browser.path(),
    )
    .await
    .unwrap();
    let SignIn::Pending { request, .. } = signed_in else {
        panic!("a new device waits: {signed_in:?}");
    };

    // Its own Allow approves nothing: this computer must confirm.
    let said = remote::allow(&route, &host_id, &request, browser.path())
        .await
        .unwrap();
    assert_eq!(said, SignIn::Confirm);
    let key = thumbprint(browser.path());
    assert!(!access(&mut client).await.approved_clients.contains(&key));

    // The owner's Allow does, read-only.
    approve(&route, &host_id, request, browser.path(), &mut client, None).await;
    assert!(access(&mut client).await.read_only_clients.contains(&key));
    server.stop().await;
}

#[tokio::test]
async fn a_desktop_token_on_a_hosted_stream_signs_in_as_the_hosted_client() {
    let issuer = clerk().await;
    let (dir, web, device) = (temp_dir(), temp_dir(), temp_dir());
    let (relay, server, mut client, direct, host_id) =
        hosted_host(dir.path(), web.path(), &issuer, true).await;
    let hosted = relay.route(json!({ "client": "hosted" })).await;

    // The token is the desktop's, but the stream is the hosted client's.
    let request = ask(&hosted, &host_id, &token(&issuer, USER), device.path()).await;
    assert!(access(&mut client).await.pending.unwrap().hosted);
    approve(&hosted, &host_id, request, device.path(), &mut client, None).await;
    let key = thumbprint(device.path());
    assert!(access(&mut client).await.read_only_clients.contains(&key));

    // Its session is the hosted client's on any route, so the switch closes it.
    let mut app = open_account(&[direct], &host_id, device.path())
        .await
        .unwrap();
    app.initialize().await;
    set_hosted(&mut client, false).await;
    assert!(app.closes().await, "the switch closes its socket");
    server.stop().await;
}

#[tokio::test]
async fn a_stream_opened_as_the_switch_turns_off_is_refused_at_its_request() {
    let issuer = clerk().await;
    let (dir, web) = (temp_dir(), temp_dir());
    let (relay, server, mut client, _, _) =
        hosted_host(dir.path(), web.path(), &issuer, true).await;
    let hosted = relay.route(json!({ "client": "hosted" })).await;

    // plxd takes the open while the switch is on, and the switch turns off before the stream
    // joins, so turning it off cuts nothing.
    relay.hold(true);
    let asked = tokio::spawn(async move { answer(&hosted, "GET", "/.well-known/parallax").await });
    relay.join_held().await;
    set_hosted(&mut client, false).await;
    relay.hold(false);
    let refused = (403, Some("access_denied".to_owned()));
    assert_eq!(asked.await.unwrap(), refused);
    server.stop().await;
}

/// A WebSocket ticket from `route` for the session the computer whose data folder is `dir` saved
/// for `host_id`.
async fn saved_ticket(route: &str, host_id: &str, dir: &Path) -> String {
    let port = port_of(route);
    let saved = std::fs::read(dir.join("remote-hosts").join(host_id)).unwrap();
    let saved: Value = serde_json::from_slice(&saved).unwrap();
    let session = saved["token"].as_str().unwrap().to_owned();
    let pkcs8 = remote::base64url_decode(saved["key"].as_str().unwrap()).unwrap();
    let key = remote::DpopKey::from_pkcs8(&pkcs8).unwrap();
    let base = format!("https://{route}");
    let path = "/api/auth/websocket-ticket";
    let proof = key.proof("POST", &format!("{base}{path}"), Some(&session));
    let authorization = format!("DPoP {session}");
    let headers = [("Authorization", authorization.as_str()), ("DPoP", &proof)];
    let (status, _, answer) = https(port, "POST", path, &headers, "").await;
    assert_eq!(status, 200);
    let answer: Value = serde_json::from_slice(&answer).unwrap();
    answer["ticket"].as_str().unwrap().to_owned()
}

/// Whether `/ws` at `route` opens with `ticket`.
async fn opens_with_ticket(route: &str, ticket: &str) -> bool {
    use tokio_tungstenite::tungstenite::client::IntoClientRequest as _;
    let (tls, _) = remote::open(route, None).await.unwrap();
    let request = format!("wss://{route}/ws?wsTicket={ticket}")
        .into_client_request()
        .unwrap();
    tokio_tungstenite::client_async(request, tls).await.is_ok()
}

#[tokio::test]
async fn a_hosted_streams_socket_takes_only_a_hosted_clients_session_with_its_proof() {
    let issuer = clerk().await;
    let (dir, web, phone, browser) = (temp_dir(), temp_dir(), temp_dir(), temp_dir());
    let (relay, server, mut client, direct, host_id) =
        hosted_host(dir.path(), web.path(), &issuer, true).await;
    let hosted = relay.route(json!({ "client": "hosted" })).await;

    // Another device's session, with its proof, opens no socket on a hosted stream, though it
    // does on its own route.
    allowed(
        &direct,
        &host_id,
        &token(&issuer, USER),
        phone.path(),
        &mut client,
        None,
    )
    .await;
    let on_hosted = open_account(std::slice::from_ref(&hosted), &host_id, phone.path()).await;
    assert!(on_hosted.is_err());
    let mut app = open_account(std::slice::from_ref(&direct), &host_id, phone.path())
        .await
        .unwrap();
    app.initialize().await;

    // A hosted client's session does, with its proof.
    allowed(
        &hosted,
        &host_id,
        &hosted_token(&issuer),
        browser.path(),
        &mut client,
        None,
    )
    .await;
    let mut app = open_account(std::slice::from_ref(&hosted), &host_id, browser.path())
        .await
        .unwrap();
    app.initialize().await;

    // Not with a ticket, which works on an unmarked route.
    let ticket = saved_ticket(&direct, &host_id, browser.path()).await;
    assert!(
        !opens_with_ticket(&hosted, &ticket).await,
        "a hosted stream"
    );
    let ticket = saved_ticket(&direct, &host_id, browser.path()).await;
    assert!(opens_with_ticket(&direct, &ticket).await, "its own route");
    server.stop().await;
}
