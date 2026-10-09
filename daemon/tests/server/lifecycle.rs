//! Starting, running, and stopping: the instance lock, the socket, signals, timers, and logs.

use std::fmt::Write as _;
use std::fs::{self, Permissions};
use std::os::unix::fs::{FileTypeExt, PermissionsExt, symlink};
use std::os::unix::net::UnixDatagram;
use std::path::Path;
use std::time::Duration;

use parallax_protocol::methods::{HostHealth, ProjectCreate};
use parallax_protocol::{HostHealthParams, ProjectCreateResult};
use rustix::process::Signal;
use sha2::{Digest, Sha256};
use tokio::time::{Instant, sleep};

use crate::support::{
    Client, InProcess, PATIENCE, Plxd, WriteLock, create_params, eventually, run_to_exit,
    socket_path, temp_dir,
};

const SETTLE: Duration = Duration::from_millis(300);

fn mode(path: &Path) -> u32 {
    fs::symlink_metadata(path).unwrap().permissions().mode() & 0o777
}

#[tokio::test]
async fn a_second_instance_is_refused_and_the_first_keeps_serving() {
    let dir = temp_dir();
    let first = Plxd::start(dir.path()).await;

    let (status, stderr) = run_to_exit(dir.path(), &[]).await;
    assert_eq!(status.code(), Some(3), "{stderr}");
    assert!(stderr.contains("already running"), "{stderr}");
    assert!(stderr.contains(&format!("pid {}", first.pid())), "{stderr}");

    let mut client = Client::ready(&first.socket).await;
    client
        .call::<HostHealth>(HostHealthParams {})
        .await
        .unwrap();
}

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
async fn a_stale_socket_is_replaced() {
    let dir = temp_dir();
    let socket = socket_path(dir.path());
    // A socket file nothing serves. It is a datagram socket because a stream listener here could
    // be inherited by another test's child before close-on-exec is set, and then accept the
    // connects meant for plxd (#86). plxd removes any kind of socket.
    drop(UnixDatagram::bind(&socket).unwrap());
    assert!(
        fs::symlink_metadata(&socket)
            .unwrap()
            .file_type()
            .is_socket()
    );

    let plxd = Plxd::start(dir.path()).await;
    let mut client = Client::ready(&plxd.socket).await;
    client
        .call::<HostHealth>(HostHealthParams {})
        .await
        .unwrap();
}

#[tokio::test]
async fn a_file_that_is_not_a_socket_is_left_alone_and_stops_startup() {
    let dir = temp_dir();
    let socket = socket_path(dir.path());
    fs::write(&socket, "keep me").unwrap();

    let (status, stderr) = run_to_exit(dir.path(), &[]).await;
    assert_eq!(status.code(), Some(1), "{stderr}");
    assert!(stderr.contains("is not a socket"), "{stderr}");
    assert_eq!(fs::read_to_string(&socket).unwrap(), "keep me");
}

#[tokio::test]
async fn a_symlinked_data_folder_stops_startup() {
    let dir = temp_dir();
    let target = dir.path().join("target");
    fs::create_dir(&target).unwrap();
    let link = dir.path().join("link");
    symlink(&target, &link).unwrap();

    let (status, stderr) = run_to_exit(&link, &[]).await;
    assert_eq!(status.code(), Some(1), "{stderr}");
    assert!(stderr.contains("symlink"), "{stderr}");
    assert!(
        fs::read_dir(&target).unwrap().next().is_none(),
        "nothing was written"
    );
}

#[tokio::test]
async fn the_data_folder_socket_lock_and_log_are_private() {
    let dir = temp_dir();
    let data = dir.path().join("data");
    fs::create_dir(&data).unwrap();
    fs::set_permissions(&data, Permissions::from_mode(0o755)).unwrap();

    let plxd = Plxd::start(&data).await;
    assert_eq!(mode(&data), 0o700);
    assert_eq!(mode(&plxd.socket), 0o600);
    let lock = data.join("plxd.lock");
    assert_eq!(mode(&lock), 0o600);
    assert_eq!(
        fs::read_to_string(&lock).unwrap(),
        format!("{}\n", plxd.pid())
    );
    assert_eq!(mode(&data.join("logs/plxd.log")), 0o600);
    assert_eq!(mode(&data.join("logs")), 0o700);
}

#[cfg(target_os = "macos")]
fn darwin_user_temp_dir() -> std::path::PathBuf {
    let output = std::process::Command::new("/usr/bin/getconf")
        .arg("DARWIN_USER_TEMP_DIR")
        .output()
        .unwrap();
    assert!(output.status.success());
    std::path::PathBuf::from(String::from_utf8(output.stdout).unwrap().trim_end())
}

/// With no `--data-dir`, the data folder is `~/.parallax`, unless that doesn't exist and an older
/// folder does: on Linux, `$XDG_DATA_HOME/parallax` when that is absolute (0023).
#[cfg(unix)]
#[tokio::test]
async fn the_default_data_folder_is_parallax_in_home_unless_an_older_one_exists() {
    use rustix::process::{Pid, kill_process};

    let home = temp_dir();
    let data_home = temp_dir();
    let new = home.path().join(".parallax");
    let mut cases = vec![(None, new.clone(), false)];
    if cfg!(target_os = "linux") {
        let old = data_home.path().join("parallax");
        cases.push((Some(data_home.path().to_str().unwrap()), old.clone(), true));
        // A relative XDG_DATA_HOME is ignored, so there is no older folder to keep.
        cases.push((Some("relative/data"), new.clone(), false));
    }
    for (xdg_data_home, expected, exists_already) in cases {
        if exists_already {
            fs::create_dir_all(&expected).unwrap();
        }
        let mut command = std::process::Command::new(env!("CARGO_BIN_EXE_plxd"));
        command
            .arg("serve")
            .env("HOME", home.path())
            .env_remove("PLXD_DATA_DIR")
            .env_remove("PLXD_LOG")
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null());
        match xdg_data_home {
            Some(value) => command.env("XDG_DATA_HOME", value),
            None => command.env_remove("XDG_DATA_HOME"),
        };
        let mut child = command.spawn().unwrap();
        let socket = expected.join("plxd.sock");
        eventually(&format!("{} exists", socket.display()), || socket.exists()).await;
        let pid = Pid::from_raw(i32::try_from(child.id()).unwrap()).unwrap();
        kill_process(pid, Signal::TERM).unwrap();
        assert!(child.wait().unwrap().success(), "{xdg_data_home:?}");
        fs::remove_dir_all(&expected).unwrap();
    }
}

#[tokio::test]
async fn a_long_data_folder_puts_the_socket_in_the_per_user_fallback_folder() {
    let dir = temp_dir();
    let data = dir.path().join("d".repeat(100));
    let hash = Sha256::digest(data.as_os_str().as_encoded_bytes())[..4]
        .iter()
        .fold(String::new(), |mut hex, byte| {
            let _ = write!(hex, "{byte:02x}");
            hex
        });
    // Linux's fallback is XDG_RUNTIME_DIR (0023), which this test points at a folder of its own.
    // macOS ignores it.
    let runtime = temp_dir();
    #[cfg(target_os = "macos")]
    let fallback = darwin_user_temp_dir();
    #[cfg(target_os = "linux")]
    let fallback = runtime.path().to_owned();
    let expected = fallback.join(format!("plxd-{hash}.sock"));
    assert!(data.join("plxd.sock").as_os_str().len() > 107);

    let env = [("XDG_RUNTIME_DIR", runtime.path().to_str().unwrap())];
    let plxd = Plxd::start_at(&data, expected.clone(), &[], &env).await;
    assert_eq!(plxd.socket, expected);
    assert_eq!(mode(&expected), 0o600);
    assert!(!data.join("plxd.sock").exists());
    let mut client = Client::ready(&expected).await;
    client
        .call::<HostHealth>(HostHealthParams {})
        .await
        .unwrap();
    drop(client);

    plxd.signal(Signal::TERM);
    assert!(plxd.exit().await.0.success());
    assert!(
        !expected.exists(),
        "the fallback socket is removed at shutdown"
    );
}

#[tokio::test]
async fn sigterm_finishes_the_requests_in_flight_then_cleans_up() {
    let dir = temp_dir();
    let mut plxd = Plxd::start(dir.path()).await;
    let mut client = Client::ready(&plxd.socket).await;
    let lock = WriteLock::take(dir.path());
    let params = create_params(dir.path(), "parallax");
    let create = client.send::<ProjectCreate>(params.clone()).await;
    sleep(SETTLE).await;

    plxd.signal(Signal::TERM);
    let socket = plxd.socket.clone();
    eventually("the socket is removed", || !socket.exists()).await;
    assert!(plxd.is_running(), "it waits for the request in flight");
    assert!(std::os::unix::net::UnixStream::connect(&socket).is_err());

    lock.release();
    let answered = client.response().await;
    assert_eq!(answered.id, Some(create));
    let created: ProjectCreateResult = answered.into_result().unwrap();
    assert_eq!(created.project.id, params.id);
    assert!(client.closes_within(PATIENCE).await);

    let (status, stderr) = plxd.exit().await;
    assert!(status.success(), "{status} {stderr}");
    assert!(!dir.path().join("plxd.lock").exists());
    let log = fs::read_to_string(dir.path().join("logs/plxd.log")).unwrap();
    assert!(log.contains("SIGTERM"), "{log}");
    assert!(log.contains("stopped"), "{log}");
}

#[tokio::test]
async fn sigterm_does_not_wait_out_the_grace_for_a_client_that_stopped_reading() {
    let dir = temp_dir();
    let plxd = Plxd::start(dir.path()).await;
    let socket = plxd.socket.clone();
    // Pipelines requests on its own thread and never reads the answers.
    let flood = std::thread::spawn(move || {
        let mut stream = std::os::unix::net::UnixStream::connect(&socket).unwrap();
        let initialize = "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"initialize\",\"params\":\
            {\"protocol\":{\"min\":1,\"max\":1},\"client\":{\"name\":\"t\",\"version\":\"0\"},\
            \"capabilities\":{}}}\n";
        let mut sent = std::io::Write::write_all(&mut stream, initialize.as_bytes());
        let mut id = 2_u64;
        while sent.is_ok() {
            let line = format!("{{\"jsonrpc\":\"2.0\",\"id\":{id},\"method\":\"host/health\"}}\n");
            sent = std::io::Write::write_all(&mut stream, line.as_bytes());
            id += 1;
        }
    });
    sleep(SETTLE).await;

    let signalled = Instant::now();
    plxd.signal(Signal::TERM);
    let (status, stderr) = plxd.exit().await;
    assert!(status.success(), "{status} {stderr}");
    assert!(
        signalled.elapsed() < Duration::from_secs(5),
        "took {:?}; the grace is 10 s",
        signalled.elapsed()
    );
    flood.join().expect("the flood ends when plxd closes");
}

#[tokio::test]
async fn sigint_stops_the_server_and_closes_idle_connections() {
    let dir = temp_dir();
    let plxd = Plxd::start(dir.path()).await;
    let mut client = Client::ready(&plxd.socket).await;

    plxd.signal(Signal::INT);
    assert!(client.closes_within(PATIENCE).await);
    let socket = plxd.socket.clone();
    let (status, stderr) = plxd.exit().await;
    assert!(status.success(), "{status} {stderr}");
    assert!(!socket.exists());
    assert!(!dir.path().join("plxd.lock").exists());
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

#[tokio::test]
async fn a_deleted_socket_is_bound_again() {
    let dir = temp_dir();
    let mut config = InProcess::config(dir.path());
    config.socket_check_interval = Duration::from_millis(100);
    let server = InProcess::start(config);
    let mut before = Client::ready(&server.socket).await;

    fs::remove_file(&server.socket).unwrap();
    let socket = server.socket.clone();
    eventually("the socket is back", || socket.exists()).await;
    assert_eq!(mode(&server.socket), 0o600);
    let mut after = Client::ready(&server.socket).await;
    after.call::<HostHealth>(HostHealthParams {}).await.unwrap();
    before
        .call::<HostHealth>(HostHealthParams {})
        .await
        .unwrap();
    drop((before, after));
    server.stop().await;
    assert!(!socket.exists());
}

async fn log_after_a_request(args: &[&str], env: &[(&str, &str)]) -> String {
    let dir = temp_dir();
    let plxd = Plxd::start_with(dir.path(), args, env).await;
    let mut client = Client::ready(&plxd.socket).await;
    client
        .call::<HostHealth>(HostHealthParams {})
        .await
        .unwrap();
    drop(client);
    plxd.signal(Signal::TERM);
    assert!(plxd.exit().await.0.success());
    fs::read_to_string(dir.path().join("logs/plxd.log")).unwrap()
}

#[tokio::test]
async fn logs_go_to_the_data_folder_at_the_level_from_the_flag_or_env() {
    let info = log_after_a_request(&[], &[]).await;
    assert!(
        info.contains(" INFO ") && info.contains("listening"),
        "{info}"
    );
    assert!(!info.contains(" DEBUG "), "{info}");

    let debug = log_after_a_request(&["--log-level", "debug"], &[]).await;
    assert!(debug.contains(" DEBUG "), "{debug}");

    let warn = log_after_a_request(&[], &[("PLXD_LOG", "warn")]).await;
    assert!(!warn.contains("listening"), "{warn}");

    let flag_wins = log_after_a_request(&["--log-level", "info"], &[("PLXD_LOG", "warn")]).await;
    assert!(flag_wins.contains("listening"), "{flag_wins}");
}

#[tokio::test]
async fn client_text_cant_forge_or_bloat_log_lines() {
    let dir = temp_dir();
    let plxd = Plxd::start_with(dir.path(), &["--log-level", "debug"], &[]).await;
    let forged = "2026-09-24T00:00:00.000000Z ERROR forged";
    let huge = "x".repeat(1_000_000);
    for (name, method) in [
        (format!("parallax\n{forged}"), format!("a\n{forged}")),
        (huge.clone(), huge),
    ] {
        let mut client = Client::connect(&plxd.socket).await;
        client
            .send_message(&serde_json::json!({
                "jsonrpc": "2.0",
                "id": 1,
                "method": "initialize",
                "params": {
                    "protocol": {"min": 1, "max": 1},
                    "client": {"name": name, "version": "0"},
                    "capabilities": {}
                }
            }))
            .await;
        assert!(client.response().await.result.is_ok());
        client
            .send_message(&serde_json::json!({"jsonrpc": "2.0", "id": 2, "method": method}))
            .await;
        client.response().await;
        client
            .send_message(&serde_json::json!({"jsonrpc": "2.0", "method": method}))
            .await;
        client
            .call::<HostHealth>(HostHealthParams {})
            .await
            .unwrap();
    }
    plxd.signal(Signal::TERM);
    assert!(plxd.exit().await.0.success());

    let log = fs::read_to_string(dir.path().join("logs/plxd.log")).unwrap();
    assert!(
        log.contains("ERROR forged"),
        "the text is logged, escaped: {log}"
    );
    for line in log.lines() {
        assert!(!line.starts_with(forged), "a forged line: {line}");
        assert!(line.len() < 1_000, "a {}-byte line", line.len());
    }
}
