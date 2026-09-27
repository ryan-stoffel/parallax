//! `wispd attach` against real `wispd serve` processes in temporary data folders (#60, 0010).
//!
//! The tests drive `attach` through pipes, as the editor does locally and as `ssh` does on a
//! host, and speak the protocol through it.

mod support;

use std::fs;
use std::io::{BufRead as _, BufReader, Write as _};
use std::os::fd::AsFd;
use std::os::unix::fs::symlink;
use std::os::unix::net::UnixStream as StdUnixStream;
use std::path::Path;
use std::time::Duration;

use rustix::process::Signal;
use tokio::time::{Instant, sleep};
use wisp_protocol::jsonrpc::{Message, Request, RequestId};
use wisp_protocol::methods::{HostHealth, HostVersion, Initialize, ProjectCreate, ProjectList};
use wisp_protocol::{
    HostHealthParams, HostVersionParams, InitializeResult, ProjectListParams, StoreState,
};
use wispd::VERSION;
use wispd::attach::{self, Options};
use wispd::launch_agent::LaunchAgent;
use wispd::paths::DataDir;

use crate::support::{
    Attach, PATIENCE, Serve, StopServe, WISPD, create_params, ends_within, gone,
    hold_instance_lock, initialize_params, is_alive, log, pipe, serve_pid, socket_path, spawn_lock,
    stdio_paths, temp_dir, working_dir,
};

#[tokio::test]
async fn the_handshake_goes_through_attach_to_a_running_wispd() {
    let dir = temp_dir();
    let mut serve = Serve::start(dir.path()).await;
    let mut attach = Attach::spawn(dir.path());

    assert_eq!(attach.initialize().await.protocol, 1);
    let health = attach
        .call::<HostHealth>(HostHealthParams {})
        .await
        .unwrap();
    assert_eq!(health.store, StoreState::Ok);
    assert_eq!(
        serve_pid(dir.path()),
        Some(serve.pid()),
        "attach started no other wispd"
    );

    attach.close_stdin();
    let exited = attach.exit().await;
    assert!(exited.status.success(), "{exited:?}");
    assert!(exited.stdout.is_empty(), "{exited:?}");
    assert!(exited.stderr.is_empty(), "{exited:?}");
    assert!(serve.is_running(), "attach never stops wispd");
}

#[tokio::test]
async fn input_that_ends_before_the_answers_still_gets_all_of_them() {
    // `printf '<request>\n' | wispd attach` prints the answer (0007): attach half-closes.
    let dir = temp_dir();
    let _serve = Serve::start(dir.path()).await;
    let mut attach = Attach::spawn(dir.path());
    attach.request::<Initialize>(initialize_params()).await;
    attach.request::<HostVersion>(HostVersionParams {}).await;
    attach.close_stdin();

    let exited = attach.exit().await;
    assert!(exited.status.success(), "{exited:?}");
    let answered: Vec<_> = exited
        .stdout
        .iter()
        .map(|message| match message {
            Message::Response(response) if response.result.is_ok() => response.id.clone(),
            other => panic!("expected an answer, got {other:?}"),
        })
        .collect();
    assert_eq!(
        answered,
        [Some(RequestId::Number(1)), Some(RequestId::Number(2))]
    );
}

#[tokio::test]
async fn attach_starts_a_detached_wispd_when_none_runs() {
    let dir = temp_dir();
    let _stop = StopServe(dir.path().to_owned());
    // A pipe whose write end attach inherits without close-on-exec, as from a careless parent.
    let (extra, extra_write) = pipe();
    let mut attach = Attach::spawn_with(dir.path(), &[], Some(extra_write.as_fd()));
    drop(extra_write);

    let first = attach.initialize().await;
    let serve = serve_pid(dir.path()).expect("the wispd that attach started holds the lock");
    assert_ne!(serve, attach.pid());
    assert_eq!(
        rustix::process::getsid(Some(serve)).unwrap(),
        serve,
        "wispd leads a session of its own"
    );
    let log_file = fs::canonicalize(dir.path().join("logs/wispd.log")).unwrap();
    let log_file = log_file.to_str().unwrap();
    assert_eq!(stdio_paths(serve), ["/dev/null", log_file, log_file]);
    assert_eq!(
        working_dir(serve),
        ["/"],
        "wispd keeps no folder of attach's busy"
    );

    attach.close_stdin();
    // `exit` also checks that stdout and stderr end with attach, so wispd holds neither, and an
    // SSH session could close.
    let exited = attach.exit().await;
    assert!(exited.status.success(), "{exited:?}");
    assert!(exited.stderr.is_empty(), "{exited:?}");
    assert!(
        ends_within(extra, PATIENCE).await,
        "wispd holds a descriptor that attach inherited"
    );
    assert!(is_alive(serve), "wispd outlives the attach that started it");

    let mut again = Attach::spawn(dir.path());
    assert_eq!(
        again.initialize().await.log_id,
        first.log_id,
        "the same wispd"
    );
    again.close_stdin();
    assert!(again.exit().await.status.success());
}

#[tokio::test]
async fn two_attaches_at_once_start_and_share_one_wispd() {
    let dir = temp_dir();
    let _stop = StopServe(dir.path().to_owned());
    let mut first = Attach::spawn(dir.path());
    let mut second = Attach::spawn(dir.path());

    let (one, two) = tokio::join!(first.initialize(), second.initialize());
    assert_eq!(one.log_id, two.log_id, "both reach the same wispd");
    let params = create_params(dir.path(), "wisp");
    first.call::<ProjectCreate>(params.clone()).await.unwrap();
    let listed = second
        .call::<ProjectList>(ProjectListParams {})
        .await
        .unwrap();
    assert!(
        listed
            .projects
            .iter()
            .any(|project| project.id == params.id)
    );

    first.close_stdin();
    second.close_stdin();
    let (first, second) = tokio::join!(first.exit(), second.exit());
    assert!(first.status.success(), "{first:?}");
    assert!(second.status.success(), "{second:?}");
}

#[tokio::test]
async fn attach_exits_when_wispd_stops_and_the_next_one_starts_wispd_again() {
    let dir = temp_dir();
    let _stop = StopServe(dir.path().to_owned());
    let mut attach = Attach::spawn(dir.path());
    let first = attach.initialize().await;

    // A clean stop: wispd closes the connection, so attach exits with its stdin still open.
    let serve = serve_pid(dir.path()).unwrap();
    rustix::process::kill_process(serve, Signal::TERM).unwrap();
    let exited = attach.exit().await;
    assert!(exited.status.success(), "{exited:?}");
    gone(serve).await;

    let mut attach = Attach::spawn(dir.path());
    let second = attach.initialize().await;
    let second_serve = serve_pid(dir.path()).unwrap();
    assert_ne!(second_serve, serve, "a new wispd");
    assert_eq!(
        second.log_id, first.log_id,
        "the event log is stored, so it outlives wispd (decision 0014)"
    );

    // A crash: the socket file stays behind, and nothing listens on it.
    let serve = second_serve;
    rustix::process::kill_process(serve, Signal::KILL).unwrap();
    let exited = attach.exit().await;
    assert!(exited.status.success(), "{exited:?}");
    gone(serve).await;
    assert!(socket_path(dir.path()).exists());

    let mut attach = Attach::spawn(dir.path());
    let third = attach.initialize().await;
    assert_ne!(serve_pid(dir.path()).unwrap(), serve, "a new wispd");
    assert_eq!(third.log_id, second.log_id);
    attach.close_stdin();
    assert!(attach.exit().await.status.success());
}

#[tokio::test]
async fn sighup_ends_attach_and_leaves_wispd_running() {
    let dir = temp_dir();
    let _stop = StopServe(dir.path().to_owned());
    let mut attach = Attach::spawn(dir.path());
    let first = attach.initialize().await;

    attach.signal(Signal::HUP);
    let exited = attach.exit().await;
    assert!(exited.status.success(), "{exited:?}");
    assert!(exited.stderr.is_empty(), "{exited:?}");

    let mut again = Attach::spawn(dir.path());
    assert_eq!(again.initialize().await.log_id, first.log_id);
    again.close_stdin();
    assert!(again.exit().await.status.success());
}

#[tokio::test]
async fn attach_waits_for_another_wispd_to_let_go_of_the_lock() {
    // As while another wispd shuts down: it holds the lock, and its socket is gone (0009).
    let dir = temp_dir();
    let _stop = StopServe(dir.path().to_owned());
    let lock = hold_instance_lock(dir.path());
    let mut attach = Attach::spawn(dir.path());
    let deadline = Instant::now() + PATIENCE;
    while !log(dir.path()).contains("wispd: not starting") {
        assert!(
            Instant::now() < deadline,
            "the wispd that attach started gives way to the lock"
        );
        sleep(Duration::from_millis(20)).await;
    }

    drop(lock);
    attach.initialize().await;
    assert!(serve_pid(dir.path()).is_some());
    attach.close_stdin();
    assert!(attach.exit().await.status.success());
}

#[tokio::test]
async fn attach_gives_up_at_its_timeout_while_another_process_holds_the_lock() {
    let dir = temp_dir();
    let _stop = StopServe(dir.path().to_owned());
    let lock = hold_instance_lock(dir.path());
    let started = Instant::now();
    let attach = Attach::spawn_with(dir.path(), &["--connect-timeout", "1"], None);

    let exited = attach.exit().await;
    assert_eq!(exited.status.code(), Some(4), "{exited:?}");
    assert!(exited.stdout.is_empty(), "{exited:?}");
    assert!(
        exited
            .stderr
            .starts_with("wispd attach: nothing accepted a connection at "),
        "{exited:?}"
    );
    assert!(exited.stderr.contains("within 1s"), "{exited:?}");
    assert!(started.elapsed() >= Duration::from_secs(1));

    // The last wispd that attach started may still be starting. Released now, the lock would let
    // it run on after the test.
    every_serve_gave_way(dir.path()).await;
    drop(lock);
}

/// Waits until every `serve` that logged its start in `data_dir` has also logged giving way to
/// the lock, and no new one has started for a while.
async fn every_serve_gave_way(data_dir: &Path) {
    let deadline = Instant::now() + PATIENCE;
    let mut settled_since = None;
    loop {
        let log = log(data_dir);
        let started = log.matches("wispd: starting").count();
        let gave_way = log.matches("wispd: not starting").count();
        assert!(started > 0, "attach started wispd");
        if started == gave_way {
            let since = *settled_since.get_or_insert_with(Instant::now);
            if since.elapsed() >= Duration::from_millis(500) {
                return;
            }
        } else {
            settled_since = None;
        }
        assert!(Instant::now() < deadline, "a wispd did not give way: {log}");
        sleep(Duration::from_millis(50)).await;
    }
}

#[tokio::test]
async fn attach_reports_a_wispd_that_cannot_start_without_waiting_out_the_timeout() {
    let dir = temp_dir();
    // `serve` refuses a symlinked lock file; attach doesn't look at it.
    symlink(dir.path().join("elsewhere"), dir.path().join("wispd.lock")).unwrap();
    let started = Instant::now();
    let attach = Attach::spawn(dir.path());

    let exited = attach.exit().await;
    assert_eq!(exited.status.code(), Some(4), "{exited:?}");
    assert!(exited.stdout.is_empty(), "{exited:?}");
    assert!(
        exited.stderr.starts_with(
            "wispd attach: wispd serve stopped before it accepted a connection (exit status: 1): \
             wispd: locking "
        ),
        "the error quotes the last line wispd logged: {exited:?}"
    );
    assert!(
        started.elapsed() < Duration::from_secs(5),
        "took {:?}",
        started.elapsed()
    );
}

#[tokio::test]
async fn a_file_that_is_not_a_socket_is_reported_without_starting_wispd() {
    let dir = temp_dir();
    fs::write(socket_path(dir.path()), "not a socket").unwrap();

    let exited = Attach::spawn(dir.path()).exit().await;
    assert_eq!(exited.status.code(), Some(4), "{exited:?}");
    assert!(
        exited
            .stderr
            .starts_with("wispd attach: could not connect to "),
        "{exited:?}"
    );
    assert!(serve_pid(dir.path()).is_none(), "no wispd was started");
    assert_eq!(
        fs::read_to_string(socket_path(dir.path())).unwrap(),
        "not a socket"
    );
}

#[tokio::test]
async fn a_symlinked_data_folder_is_refused_before_anything_is_written() {
    let dir = temp_dir();
    let target = dir.path().join("target");
    fs::create_dir(&target).unwrap();
    let link = dir.path().join("link");
    symlink(&target, &link).unwrap();

    let exited = Attach::spawn(&link).exit().await;
    assert_eq!(exited.status.code(), Some(4), "{exited:?}");
    assert!(exited.stderr.contains("symlink"), "{exited:?}");
    assert!(fs::read_dir(&target).unwrap().next().is_none());
}

#[tokio::test]
async fn a_long_data_folder_is_reached_through_the_fallback_socket() {
    let dir = temp_dir();
    let data = dir.path().join("d".repeat(100));
    let _stop = StopServe(data.clone());
    let socket = DataDir::new(&data).unwrap().socket_path().unwrap();
    assert!(socket.fallback);

    let mut attach = Attach::spawn(&data);
    attach.initialize().await;
    assert!(socket.path.exists());
    attach.close_stdin();
    assert!(attach.exit().await.status.success());
}

/// A stand-in for `launchctl` that records its arguments and runs `then`.
fn fake_launchctl(dir: &Path, then: &str) -> LaunchAgent {
    use std::os::unix::fs::PermissionsExt;

    let script = dir.join("launchctl");
    let args = dir.join("launchctl-args");
    fs::write(
        &script,
        format!("#!/bin/sh\necho \"$@\" >> '{}'\n{then}\n", args.display()),
    )
    .unwrap();
    fs::set_permissions(&script, fs::Permissions::from_mode(0o755)).unwrap();
    LaunchAgent {
        launchctl: script,
        service: "gui/501/wispd-test".to_owned(),
    }
}

fn options(launch_agent: LaunchAgent) -> Options {
    Options {
        program: WISPD.into(),
        connect_timeout: PATIENCE,
        launch_agent: Some(launch_agent),
        version: VERSION,
    }
}

#[test]
fn a_launch_agent_is_kickstarted_instead_of_starting_serve() {
    let dir = temp_dir();
    let data = dir.path().join("data");
    let _stop = StopServe(data.clone());
    // The stand-in starts wispd itself, as launchd would.
    let agent = fake_launchctl(
        dir.path(),
        &format!(
            "WISPD_DATA_DIR='{}' '{WISPD}' serve </dev/null >/dev/null 2>&1 &",
            data.display()
        ),
    );
    let data_dir = DataDir::new(&data).unwrap();

    // Held so that the stand-in and its wispd inherit nothing another test is creating.
    let connected = {
        let _lock = spawn_lock();
        attach::connect(&data_dir, &options(agent))
    };
    connected.expect("connect through the launch agent");
    assert_eq!(
        fs::read_to_string(dir.path().join("launchctl-args")).unwrap(),
        "kickstart gui/501/wispd-test\n"
    );
    let log = log(&data);
    assert_eq!(
        log.matches("starting").count(),
        1,
        "attach started no wispd itself: {log}"
    );
}

#[test]
fn a_launch_agent_that_cannot_start_falls_back_to_serve() {
    let dir = temp_dir();
    let data = dir.path().join("data");
    let _stop = StopServe(data.clone());
    let agent = fake_launchctl(dir.path(), "echo 'Could not find service' >&2; exit 113");
    let data_dir = DataDir::new(&data).unwrap();

    let connected = {
        let _lock = spawn_lock();
        attach::connect(&data_dir, &options(agent))
    };
    connected.expect("connect to the wispd that attach started");
    assert_eq!(
        fs::read_to_string(dir.path().join("launchctl-args")).unwrap(),
        "kickstart gui/501/wispd-test\n"
    );
    assert!(serve_pid(&data).is_some());
}

/// Options for an `attach` of release `version`, with no launch agent.
fn as_version(version: &'static str) -> Options {
    Options {
        program: WISPD.into(),
        connect_timeout: PATIENCE,
        launch_agent: None,
        version,
    }
}

/// Sends `initialize` on a connection that [`attach::connect`] made, and returns the answer.
fn initialize_on(stream: &StdUnixStream) -> InitializeResult {
    stream.set_read_timeout(Some(PATIENCE)).unwrap();
    let mut line = serde_json::to_vec(&Request::new::<Initialize>(1, initialize_params())).unwrap();
    line.push(b'\n');
    (&*stream).write_all(&line).unwrap();
    let mut answer = String::new();
    BufReader::new(stream).read_line(&mut answer).unwrap();
    match Message::from_frame(answer.trim_end().as_bytes()).unwrap() {
        Message::Response(response) => response.into_result().expect("initialize"),
        other => panic!("expected a response, got {other:?}"),
    }
}

/// Waits until the `serve` the test started has exited.
async fn stopped(serve: &mut Serve) {
    let deadline = Instant::now() + PATIENCE;
    while serve.is_running() {
        assert!(
            Instant::now() < deadline,
            "the older wispd is still running"
        );
        sleep(Duration::from_millis(20)).await;
    }
}

#[tokio::test]
async fn an_older_wispd_is_replaced_and_its_data_kept() {
    let dir = temp_dir();
    let _stop = StopServe(dir.path().to_owned());
    let mut old = Serve::start(dir.path()).await;
    let old_pid = old.pid();
    let params = create_params(dir.path(), "kept");
    let mut attach = Attach::spawn(dir.path());
    attach.initialize().await;
    attach.call::<ProjectCreate>(params.clone()).await.unwrap();
    attach.close_stdin();
    assert!(attach.exit().await.status.success());

    let connected = {
        let _lock = spawn_lock();
        attach::connect(&DataDir::new(dir.path()).unwrap(), &as_version("999.0.0"))
    };
    let stream = connected.expect("connect to the wispd that replaced the older one");
    stopped(&mut old).await;
    let new_pid = serve_pid(dir.path()).expect("a new wispd holds the lock");
    assert_ne!(new_pid, old_pid);
    assert_eq!(initialize_on(&stream).wispd, VERSION);
    drop(stream);

    // The new wispd is this build's version, so a plain attach keeps it.
    let mut attach = Attach::spawn(dir.path());
    attach.initialize().await;
    let listed = attach
        .call::<ProjectList>(ProjectListParams {})
        .await
        .unwrap();
    assert!(
        listed
            .projects
            .iter()
            .any(|project| project.id == params.id),
        "the store survived the restart"
    );
    attach.close_stdin();
    let exited = attach.exit().await;
    assert!(exited.stderr.is_empty(), "{exited:?}");
    assert_eq!(serve_pid(dir.path()), Some(new_pid));
}

#[tokio::test]
async fn a_wispd_of_the_same_or_a_newer_version_is_kept() {
    let dir = temp_dir();
    let mut serve = Serve::start(dir.path()).await;
    for version in [VERSION, "0.0.1", "not a version"] {
        let connected = {
            let _lock = spawn_lock();
            attach::connect(&DataDir::new(dir.path()).unwrap(), &as_version(version))
        };
        let stream = connected.expect("connect");
        assert_eq!(initialize_on(&stream).wispd, VERSION, "{version}");
        assert!(
            serve.is_running(),
            "attach {version} kept the running wispd"
        );
        assert_eq!(serve_pid(dir.path()), Some(serve.pid()), "{version}");
    }
}

#[tokio::test]
async fn two_newer_attaches_racing_replace_an_older_wispd_once() {
    let dir = temp_dir();
    let _stop = StopServe(dir.path().to_owned());
    let mut old = Serve::start(dir.path()).await;
    let data_dir = DataDir::new(dir.path()).unwrap();
    let options = as_version("999.0.0");

    let (first, second) = {
        let _lock = spawn_lock();
        std::thread::scope(|scope| {
            let first = scope.spawn(|| attach::connect(&data_dir, &options));
            let second = scope.spawn(|| attach::connect(&data_dir, &options));
            (first.join().unwrap(), second.join().unwrap())
        })
    };
    let (first, second) = (first.expect("first"), second.expect("second"));
    stopped(&mut old).await;
    assert_eq!(
        initialize_on(&first).log_id,
        initialize_on(&second).log_id,
        "both reach the same new wispd"
    );
    assert_ne!(serve_pid(dir.path()), Some(old.pid()));
}

#[tokio::test]
async fn an_older_launch_agent_wispd_is_restarted_through_launchctl() {
    let dir = temp_dir();
    let data = dir.path().join("data");
    let _stop = StopServe(data.clone());
    let mut old = Serve::start(&data).await;
    let lock = data.join("wispd.lock");
    // The stand-in reports the running wispd as launchd's, and on `kickstart -k` stops it and
    // starts another once it has let go of the lock, as launchd would.
    let agent = fake_launchctl(
        dir.path(),
        &format!(
            "case \"$1\" in\n\
             print) printf 'svc = {{\\n\\tstate = running\\n\\tpid = %s\\n}}\\n' \"$(cat '{lock}')\" ;;\n\
             kickstart) kill \"$(cat '{lock}')\"\n\
             while [ -e '{lock}' ]; do sleep 0.02; done\n\
             WISPD_DATA_DIR='{data}' '{WISPD}' serve </dev/null >/dev/null 2>&1 & ;;\n\
             esac",
            lock = lock.display(),
            data = data.display(),
        ),
    );
    let options = Options {
        launch_agent: Some(agent),
        ..as_version("999.0.0")
    };

    let connected = {
        let _lock = spawn_lock();
        attach::connect(&DataDir::new(&data).unwrap(), &options)
    };
    connected.expect("connect to the restarted wispd");
    stopped(&mut old).await;
    assert_eq!(
        fs::read_to_string(dir.path().join("launchctl-args")).unwrap(),
        "print gui/501/wispd-test\nkickstart -k gui/501/wispd-test\n"
    );
    assert_ne!(serve_pid(&data), Some(old.pid()));
    let log = log(&data);
    assert_eq!(
        log.matches("wispd: starting").count(),
        2,
        "only the stand-in started a wispd: {log}"
    );
}
