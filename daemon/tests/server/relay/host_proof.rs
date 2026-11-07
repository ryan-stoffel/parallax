//! Disposable host stays resident. Each measured client runs once in a fresh test process.
use super::*;
use std::path::Path;
use std::process::Stdio;
use tokio::io::{AsyncBufReadExt as _, AsyncReadExt as _, AsyncWriteExt as _, BufReader};
use tokio::process::Command;

const CHILD: &str = "PLXD_HOST_PROOF_ATTEMPT";
const MARKER: &str = "host-proof-child ";

fn emit(stage: &str, data: serde_json::Value) {
    println!(
        "{MARKER}{}",
        serde_json::json!({"stage":stage,"data":data,"pid":std::process::id()})
    );
}

#[tokio::test]
async fn client_attempt() {
    let Ok(config) = std::env::var(CHILD) else {
        return;
    };
    let config: serde_json::Value = serde_json::from_str(&config).unwrap();
    let text = |key: &str| config[key].as_str().unwrap();
    relay::sign_in(
        std::env::var("PLXD_TEST_RELAY_URL").unwrap(),
        std::env::var("PLXD_TEST_RELAY_TOKEN").unwrap(),
    );
    relay::host_proof_client(config["candidate"] == true);
    emit("started", serde_json::Value::Null);
    let route = text("route").to_owned();
    let intent = Instant::now();
    let dialed = remote::dial(
        std::slice::from_ref(&route),
        text("pin"),
        Path::new(text("dir")),
    )
    .await
    .unwrap();
    emit(
        "connected",
        serde_json::json!({"networkMs":intent.elapsed().as_secs_f64()*1000.0}),
    );
    let mut app = App::bridged(dialed.socket);
    assert!(app.initialize().await["result"].is_object());
    emit("initialized", serde_json::Value::Null);
    app.send(r#"{"jsonrpc":"2.0","id":2,"method":"events/subscribe","params":{"after":0}}"#)
        .await;
    while !app.next().await.contains(r#""method":"events/event""#) {}
    emit("replayed", serde_json::Value::Null);
    let mut health = Vec::new();
    for _ in 0..50 {
        let started = Instant::now();
        app.send(r#"{"jsonrpc":"2.0","id":9,"method":"host/health","params":{}}"#)
            .await;
        loop {
            let answer: serde_json::Value = serde_json::from_str(&app.next().await).unwrap();
            if answer["id"] == 9 {
                assert!(answer["result"].is_object());
                break;
            }
        }
        health.push(started.elapsed().as_secs_f64() * 1000.0);
    }
    emit("complete", serde_json::json!({"healthMs":health}));
}

/// Parent's clock starts before spawn and records received readiness markers, including launch/IPC.
async fn attempt(route: &str, pin: &str, dir: &Path, candidate: bool) -> serde_json::Value {
    let intent = Instant::now();
    let mut child = Command::new(std::env::current_exe().unwrap())
        .args([
            "--exact",
            "relay::host_proof::client_attempt",
            "--nocapture",
            "--test-threads=1",
        ])
        .env(
            CHILD,
            serde_json::json!({"route":route,"pin":pin,"dir":dir,"candidate":candidate})
                .to_string(),
        )
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit())
        .kill_on_drop(true)
        .spawn()
        .unwrap();
    let mut sample = serde_json::json!({"candidate":candidate,"pid":child.id()});
    let mut lines = BufReader::new(child.stdout.take().unwrap()).lines();
    while let Some(line) = lines.next_line().await.unwrap() {
        let Some((_, record)) = line.split_once(MARKER) else {
            continue;
        };
        let record: serde_json::Value = serde_json::from_str(record).unwrap();
        assert_eq!(record["pid"].as_u64(), child.id().map(u64::from));
        let field = match record["stage"].as_str().unwrap() {
            "started" => "launchToChildMs",
            "connected" => "launchToReadyMs",
            "initialized" => "launchToInitializeMs",
            "replayed" => "launchToActualReplayMs",
            "complete" => {
                sample["healthMs"] = record["data"]["healthMs"].clone();
                continue;
            }
            _ => panic!("unknown proof child stage"),
        };
        sample[field] = serde_json::json!(intent.elapsed().as_secs_f64() * 1000.0);
        if field == "launchToReadyMs" {
            sample["networkMs"] = record["data"]["networkMs"].clone();
        }
    }
    let status = child.wait().await.unwrap();
    if !status.success() || sample["healthMs"].as_array().is_none_or(|s| s.len() != 50) {
        sample["failure"] =
            serde_json::json!(format!("client exit {status}, incomplete markers/RPCs"));
    }
    sample
}

async fn wait_carrier(host: &str) {
    let deadline = Instant::now() + PATIENCE;
    while !relay::host_proof_carrier(host, None).await.unwrap() {
        assert!(Instant::now() < deadline, "carrier not ready");
        sleep(Duration::from_millis(100)).await;
    }
}

async fn final_http(route: &str, pin: &str) {
    let (mut http, _) = remote::open(route, Some(pin)).await.unwrap();
    http.write_all(
        b"GET /.well-known/parallax HTTP/1.1\r\nHost: parallax\r\nConnection: close\r\n\r\n",
    )
    .await
    .unwrap();
    let mut response = Vec::new();
    tokio::time::timeout(PATIENCE, http.read_to_end(&mut response))
        .await
        .unwrap()
        .unwrap();
    let split = response.windows(4).position(|w| w == b"\r\n\r\n").unwrap();
    let head = String::from_utf8_lossy(&response[..split]);
    assert!(head.starts_with("HTTP/1.1 200"), "{head}");
    let length: usize = head
        .lines()
        .find_map(|line| {
            let (name, value) = line.split_once(':')?;
            name.eq_ignore_ascii_case("content-length")
                .then(|| value.trim().parse().unwrap())
        })
        .unwrap();
    assert_eq!(response.len() - split - 4, length);
    assert!(
        serde_json::from_slice::<serde_json::Value>(&response[split + 4..])
            .unwrap()
            .is_object()
    );
    eprintln!("host-proof finalHttp=ok bytes={length}");
}

async fn replace_carrier(client: &mut Client, route: &str, pin: &str, dir: &Path) {
    relay::host_proof_client(true);
    let routes = &[route.to_owned()];
    let host = route.strip_prefix("relay:").unwrap();
    let dialed = remote::dial(routes, pin, dir).await.unwrap();
    let mut old = App::bridged(dialed.socket);
    assert!(old.initialize().await["result"].is_object());
    assert!(answers(&mut old).await);
    assert!(!relay::host_proof_carrier(host, Some(false)).await.unwrap());
    assert!(
        old.closes().await,
        "old logical connection survived data carrier loss"
    );
    assert!(
        remote::dial(routes, pin, dir).await.is_err(),
        "candidate accepted without data carrier"
    );
    assert!(relay_status(client, |s| s.connected).await.connected);
    // A working legacy session proves the host/control remained reachable during candidate loss.
    relay::host_proof_client(false);
    let baseline = remote::dial(routes, pin, dir).await.unwrap();
    let mut baseline = App::bridged(baseline.socket);
    assert!(baseline.initialize().await["result"].is_object());
    assert!(answers(&mut baseline).await);
    let restart = Instant::now();
    relay::host_proof_carrier(host, Some(true)).await.unwrap();
    wait_carrier(host).await;
    relay::host_proof_client(true);
    let before_launch = restart.elapsed();
    let recovered = attempt(route, pin, dir, true).await;
    eprintln!(
        "host-proof carrierReplacement {}",
        serde_json::json!({
        "throughAuthenticatedReadyMs": recovered["launchToReadyMs"].as_f64()
            .map(|ready| before_launch.as_secs_f64()*1000.0 + ready),
        "sample":recovered})
    );
    assert!(recovered["failure"].is_null());
    // The old app remains closed; its application writes are never replayed on the replacement.
    assert!(old.closes().await);
}

#[tokio::test]
async fn fresh_clients_use_persistent_host_carrier_for_real_rpc() {
    let url = std::env::var("PLXD_TEST_RELAY_URL").expect("run through host-proof.mjs");
    let token = std::env::var("PLXD_TEST_RELAY_TOKEN").unwrap();
    let dir = temp_dir();
    let port = free_port();
    let mut config = InProcess::config(dir.path());
    config.remote_address = Some(LOOPBACK);
    config.remote_port = port;
    config.relay_url.clone_from(&url);
    config.backends = Some(fake(Vec::new()));
    let startup = Instant::now();
    let server = InProcess::start(config);
    let mut client = Client::ready(&server.socket).await;
    set_remote(&mut client, true).await;
    wait_listening(port, true).await;
    client
        .call::<RelayRegister>(RelayRegisterParams {
            token: token.clone(),
            signed: None,
        })
        .await
        .unwrap();
    let status = relay_status(&mut client, |s| s.connected).await;
    let control_online = startup.elapsed();
    let host = status
        .hook_url
        .unwrap()
        .rsplit('/')
        .next()
        .unwrap()
        .to_owned();
    let route = format!("relay:{host}");
    relay::sign_in(url, token);
    relay::host_proof_client(true);
    wait_carrier(&host).await;
    let phone = temp_dir();
    let code = new_code(&mut client).await;
    let paired = remote::pair(
        std::slice::from_ref(&route),
        &code,
        "proof-client",
        phone.path(),
    )
    .await
    .unwrap();
    client
        .call::<OrchestratorCreate>(crate::agents::orchestrator_params(dir.path()))
        .await
        .unwrap();
    let before_launch = startup.elapsed();
    let first = attempt(&route, &paired.fingerprint, phone.path(), true).await;
    eprintln!(
        "host-proof startup {}",
        serde_json::json!({"controlOnlineMs":control_online.as_secs_f64()*1000.0,
        "firstUsableCandidateMs":first["launchToReadyMs"].as_f64().map(|ready| before_launch.as_secs_f64()*1000.0 + ready),
        "includesFixtureEnrollment":true,"sample":first})
    );
    assert!(first["failure"].is_null());
    assert!(matches!(
        remote::open(&route, Some(&"00".repeat(32))).await,
        Err(remote::Error::WrongHost)
    ));
    final_http(&route, &paired.fingerprint).await;
    replace_carrier(&mut client, &route, &paired.fingerprint, phone.path()).await;
    sleep(Duration::from_secs(35)).await;
    sleep(Duration::from_secs(35)).await;
    let mut failures = 0;
    for pair in 0..30 {
        for candidate in if pair % 2 == 0 {
            [false, true]
        } else {
            [true, false]
        } {
            sleep(Duration::from_secs(3)).await;
            let sample = attempt(&route, &paired.fingerprint, phone.path(), candidate).await;
            if !sample["failure"].is_null() {
                failures += 1;
            }
            eprintln!(
                "host-proof sample {}",
                serde_json::json!({"pair":pair,"sample":sample})
            );
        }
    }
    assert_eq!(failures, 0, "raw failures above, no timing acceptance");
    relay::host_proof_client(true);
    let dialed = remote::dial(
        std::slice::from_ref(&route),
        &paired.fingerprint,
        phone.path(),
    )
    .await
    .unwrap();
    let mut app = App::bridged(dialed.socket);
    assert!(app.initialize().await["result"].is_object());
    let sessions = client
        .call::<RemoteSessions>(RemoteSessionsParams {})
        .await
        .unwrap();
    let session = sessions
        .sessions
        .iter()
        .find(|s| s.name == "proof-client")
        .unwrap();
    client
        .call::<RemoteRevoke>(RemoteRevokeParams {
            id: session.id.clone(),
        })
        .await
        .unwrap();
    assert!(
        app.closes().await,
        "revocation must close metadata-registered relay stream"
    );
    assert!(
        remote::dial(
            std::slice::from_ref(&route),
            &paired.fingerprint,
            phone.path()
        )
        .await
        .is_err()
    );
    relay::host_proof_client(false);
    server.stop().await;
}
