//! Stopping: `service install`'s replace, SIGTERM with requests in flight, and the idle timer.

use std::fs;
use std::time::Duration;

use parallax_protocol::methods::{HostHealth, OrchestratorCreate};
use parallax_protocol::{HostHealthParams, OrchestratorCreateResult};
use rustix::process::Signal;
use tokio::time::sleep;

use crate::support::{
    Client, InProcess, PATIENCE, Plxd, WriteLock, create_params, eventually, temp_dir,
};

const SETTLE: Duration = Duration::from_millis(300);

#[tokio::test]
async fn service_install_replace_stops_the_serve_holding_the_lock() {
    let dir = temp_dir();
    let plxd = Plxd::start(dir.path()).await;
    let data_dir = plxd::paths::DataDir::new(dir.path()).unwrap();

    tokio::task::spawn_blocking(move || plxd::service::stop_outside_serve(&data_dir))
        .await
        .unwrap()
        .unwrap();

    // It returns once the lock is free; `serve` exits cleanly just after.
    let (status, stderr) = tokio::time::timeout(PATIENCE, plxd.exit())
        .await
        .expect("plxd exits after it is stopped");
    assert!(status.success(), "{stderr}");
    // A free lock is nothing to stop.
    let data_dir = plxd::paths::DataDir::new(dir.path()).unwrap();
    plxd::service::stop_outside_serve(&data_dir).unwrap();
}

#[tokio::test]
async fn sigterm_finishes_the_requests_in_flight_then_cleans_up() {
    let dir = temp_dir();
    let mut plxd = Plxd::start(dir.path()).await;
    let mut client = Client::ready(&plxd.socket).await;
    let lock = WriteLock::take(dir.path());
    let params = create_params(dir.path(), "parallax");
    let create = client.send::<OrchestratorCreate>(params.clone()).await;
    sleep(SETTLE).await;

    plxd.signal(Signal::TERM);
    let socket = plxd.socket.clone();
    eventually("the socket is removed", || !socket.exists()).await;
    assert!(plxd.is_running(), "it waits for the request in flight");
    assert!(std::os::unix::net::UnixStream::connect(&socket).is_err());

    lock.release();
    let answered = client.response().await;
    assert_eq!(answered.id, Some(create));
    let created: OrchestratorCreateResult = answered.into_result().unwrap();
    assert_eq!(created.orchestrator.id, params.id);
    assert!(client.closes_within(PATIENCE).await);

    let (status, stderr) = plxd.exit().await;
    assert!(status.success(), "{status} {stderr}");
    assert!(!dir.path().join("plxd.lock").exists());
    let log = fs::read_to_string(dir.path().join("logs/plxd.log")).unwrap();
    assert!(log.contains("SIGTERM"), "{log}");
    assert!(log.contains("stopped"), "{log}");
}

#[tokio::test]
async fn a_silent_connection_is_dropped_and_a_talking_one_is_not() {
    let dir = temp_dir();
    let mut config = InProcess::config(dir.path());
    config.idle_timeout = Duration::from_millis(400);
    let server = InProcess::start(config);
    let mut silent = Client::ready(&server.socket).await;
    let mut talking = Client::ready(&server.socket).await;

    for _ in 0..8 {
        sleep(Duration::from_millis(100)).await;
        talking
            .call::<HostHealth>(HostHealthParams {})
            .await
            .unwrap();
    }
    assert!(silent.closes_within(Duration::from_millis(100)).await);
    talking
        .call::<HostHealth>(HostHealthParams {})
        .await
        .unwrap();
    drop(talking);
    server.stop().await;
}
