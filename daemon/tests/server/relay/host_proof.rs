//! Executes actual pinned TLS, fresh authenticated WS, initialize and health on the proof route.
use super::*;
use tokio::io::{AsyncReadExt as _, AsyncWriteExt as _};

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
    eprintln!(
        "host-proof startupMs={}",
        startup.elapsed().as_secs_f64() * 1000.0
    );
    let route = format!(
        "relay:{}",
        status.hook_url.unwrap().rsplit('/').next().unwrap()
    );
    relay::sign_in(url, token);
    let routes = std::slice::from_ref(&route);
    let phone = temp_dir();
    let code = new_code(&mut client).await;
    relay::host_proof_client(true);
    let paired = remote::pair(routes, &code, "proof-client", phone.path())
        .await
        .unwrap();
    relay::host_proof_client(true);
    // Carrier starts with control establishment, outside these opens. This is feasibility only.
    for attempt in 0..3 {
        let dialed = remote::dial(routes, &paired.fingerprint, phone.path())
            .await
            .unwrap();
        let mut app = App::bridged(dialed.socket);
        assert!(app.initialize().await["result"].is_object());
        for _ in 0..50 {
            assert!(answers(&mut app).await);
        }
        eprintln!("host-proof feasibility attempt={attempt} initialize=ok health=50");
    }
    // An actual final HTTP body followed by EOF must survive the native drain contract.
    let (mut http, _) = remote::open(&route, Some(&paired.fingerprint))
        .await
        .unwrap();
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

    // Preserve the real authority's 30/minute open limit. Pacing is outside timed intent.
    sleep(Duration::from_secs(35)).await;
    sleep(Duration::from_secs(35)).await;
    client
        .call::<OrchestratorCreate>(crate::agents::orchestrator_params(dir.path()))
        .await
        .unwrap();
    let mut failures = 0;
    for pair in 0..30 {
        for candidate in if pair % 2 == 0 {
            [false, true]
        } else {
            [true, false]
        } {
            sleep(Duration::from_secs(3)).await;
            relay::host_proof_client(candidate);
            let intent = Instant::now();
            let dialed = match remote::dial(routes, &paired.fingerprint, phone.path()).await {
                Ok(dialed) => dialed,
                Err(error) => {
                    failures += 1;
                    eprintln!(
                        "host-proof sample {}",
                        serde_json::json!({"pair":pair,"candidate":candidate,"failure":error.to_string()})
                    );
                    continue;
                }
            };
            let connected = intent.elapsed().as_secs_f64() * 1000.0;
            let mut app = App::bridged(dialed.socket);
            let initialized = app.initialize().await;
            assert!(initialized["result"].is_object());
            let initialize = intent.elapsed().as_secs_f64() * 1000.0;
            app.send(
                r#"{"jsonrpc":"2.0","id":2,"method":"events/subscribe","params":{"after":0}}"#,
            )
            .await;
            while !app.next().await.contains(r#""method":"events/event""#) {}
            let replay = intent.elapsed().as_secs_f64() * 1000.0;
            let mut health = Vec::new();
            for _ in 0..50 {
                let started = Instant::now();
                app.send(r#"{"jsonrpc":"2.0","id":9,"method":"host/health","params":{}}"#)
                    .await;
                loop {
                    let answer: serde_json::Value =
                        serde_json::from_str(&app.next().await).unwrap();
                    if answer["id"] == 9 {
                        assert!(answer["result"].is_object());
                        break;
                    }
                }
                health.push(started.elapsed().as_secs_f64() * 1000.0);
            }
            eprintln!(
                "host-proof sample {}",
                serde_json::json!({"pair":pair,"candidate":candidate,
                "connectedMs":connected,"initializeMs":initialize,"actualReplayMs":replay,"healthMs":health})
            );
        }
    }
    assert_eq!(failures, 0, "raw failures above, no timing acceptance");
    relay::host_proof_client(true);
    set_relay(&mut client, false).await;
    relay_status(&mut client, |s| !s.connected).await;
    assert!(
        remote::dial(routes, &paired.fingerprint, phone.path())
            .await
            .is_err(),
        "offline carrier must fail"
    );
    let restart = Instant::now();
    set_relay(&mut client, true).await;
    relay_status(&mut client, |s| s.connected).await;
    let recovered = remote::dial(routes, &paired.fingerprint, phone.path())
        .await
        .unwrap();
    let mut recovered = App::bridged(recovered.socket);
    assert!(recovered.initialize().await["result"].is_object());
    eprintln!(
        "host-proof restartedMs={}",
        restart.elapsed().as_secs_f64() * 1000.0
    );
    assert!(matches!(
        remote::open(&route, Some(&"00".repeat(32))).await,
        Err(remote::Error::WrongHost)
    ));
    let dialed = remote::dial(routes, &paired.fingerprint, phone.path())
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
        "revocation must close the metadata-registered relay stream"
    );
    assert!(
        remote::dial(routes, &paired.fingerprint, phone.path())
            .await
            .is_err()
    );
    relay::host_proof_client(false);
    server.stop().await;
}
