//! `plxd attach` and `plxd serve` on Windows (0023): attach starts a detached `serve`, which
//! answers over the named pipe, outlives attach, holds the lock, and gets none of attach's
//! handles. And `plxd service`'s logon task (PLX-576), which attach starts, and `host/update`
//! replacing a running plxd.exe, with and without that task (PLX-825).
#![cfg(windows)]

use std::fmt::Write as _;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use parallax_protocol::framing::FrameCodec;
use parallax_protocol::jsonrpc::{Message, Request};
use parallax_protocol::methods::{HostUpdate, HostVersion, Initialize};
use parallax_protocol::{
    Capabilities, ClientInfo, HostUpdateParams, HostUpdateRestart, HostVersionParams,
    InitializeParams, ProtocolRange,
};
use plxd::attach::{self, Options};
use plxd::launch_agent::LaunchAgent;
use plxd::paths::DataDir;
use sha2::Digest as _;
use tokio::io::AsyncWriteExt;
use tokio::process::Command;
use tokio::time::timeout;
use tokio_util::codec::Framed;

const PATIENCE: Duration = Duration::from_secs(30);

fn plxd(data: &Path, args: &[&str]) -> Command {
    let mut command = Command::new(env!("CARGO_BIN_EXE_plxd"));
    command
        .args(args)
        .arg("--data-dir")
        .arg(data)
        .env_remove("PLXD_LOG")
        .env_remove("PLXD_DATA_DIR")
        .kill_on_drop(true);
    command
}

fn initialize() -> Request<InitializeParams> {
    Request::new::<Initialize>(
        1,
        InitializeParams {
            protocol: ProtocolRange::SUPPORTED,
            client: ClientInfo {
                name: "plxd-windows-tests".to_owned(),
                version: "0.0.0".to_owned(),
                machine_id: None,
            },
            capabilities: Capabilities::default(),
        },
    )
}

/// Runs `plxd attach` with one `initialize` on stdin, then the end of stdin, and returns what
/// it printed. attach only exits once stdout's other copies close, so this also fails if the
/// `serve` it started inherited its stdout.
async fn attach_once(data: &Path) -> String {
    let mut child = plxd(data, &["attach"])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    let mut line = serde_json::to_string(&initialize()).unwrap();
    line.push('\n');
    let mut stdin = child.stdin.take().unwrap();
    stdin.write_all(line.as_bytes()).await.unwrap();
    drop(stdin);
    let output = timeout(PATIENCE, child.wait_with_output())
        .await
        .expect("attach and everything holding its stdout finished")
        .unwrap();
    assert!(output.status.success(), "{output:?}");
    String::from_utf8(output.stdout).unwrap()
}

/// The pid `serve` logged when it started listening.
fn serve_pid(data: &Path) -> u32 {
    let log = std::fs::read_to_string(data.join("logs").join("plxd.log")).unwrap();
    let listening = log
        .lines()
        .rfind(|line| line.contains("listening"))
        .unwrap_or_else(|| panic!("no listening line in {log}"));
    let pid = listening.split_once("pid=").unwrap().1;
    pid.split(|c: char| !c.is_ascii_digit())
        .next()
        .unwrap()
        .parse()
        .unwrap()
}

/// Kills `serve` for `data`, and waits until its pipe is gone.
async fn kill(data: &Path) {
    let pid = serve_pid(data);
    let status = Command::new("taskkill")
        .args(["/F", "/PID", &pid.to_string()])
        .stdout(Stdio::null())
        .status()
        .await
        .unwrap();
    assert!(status.success(), "taskkill {pid}");
    let pipe = DataDir::new(data).unwrap().socket_path().unwrap().path;
    timeout(PATIENCE, async {
        while plxd::transport::connect(&pipe).await.is_ok() {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("the pipe went away");
}

#[tokio::test]
async fn attach_starts_a_serve_that_answers_outlives_it_and_holds_the_lock() {
    let data = tempfile::tempdir().unwrap();

    let stdout = attach_once(data.path()).await;
    let line = stdout.strip_suffix('\n').expect("one line");
    assert!(!line.contains('\n'), "{stdout:?}");
    let response: serde_json::Value = serde_json::from_str(line).unwrap();
    assert_eq!(response["id"], 1, "{line}");
    assert_eq!(response["result"]["protocol"], 1, "{line}");

    // serve is still running after attach, and serving this user over the pipe.
    let pipe = DataDir::new(data.path())
        .unwrap()
        .socket_path()
        .unwrap()
        .path;
    let mut client = Framed::new(
        plxd::transport::connect(&pipe).await.unwrap(),
        FrameCodec::new(),
    );
    client.send(&initialize()).await.unwrap();
    let frame = timeout(PATIENCE, client.next())
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    assert!(
        matches!(Message::from_frame(&frame), Ok(Message::Response(response)) if response.result.is_ok())
    );
    drop(client);

    // A second serve for the folder is kept out by the lock, whose holder it can't name.
    let second = timeout(PATIENCE, plxd(data.path(), &["serve"]).output())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(second.status.code(), Some(3), "{second:?}");
    let said = String::from_utf8_lossy(&second.stderr);
    assert!(
        said.contains("already running") && !said.contains("pid"),
        "{said}"
    );

    // The lock file stays when serve dies, and doesn't keep the next one out.
    kill(data.path()).await;
    assert!(data.path().join("plxd.lock").exists());
    let stdout = attach_once(data.path()).await;
    assert!(stdout.contains("\"protocol\":1"), "{stdout}");
    kill(data.path()).await;
}

const TEST_LABEL: &str = "io.github.ryan-stoffel.parallax.plxd.windows-test";

/// Runs `plxd service <command>` under [`TEST_LABEL`] for `data`, with the task's XML in `local`.
async fn service(data: &Path, local: &Path, command: &str) -> String {
    let output = timeout(
        PATIENCE,
        plxd(data, &["service", command, "--label", TEST_LABEL])
            .env("LOCALAPPDATA", local)
            .output(),
    )
    .await
    .expect("plxd service finished")
    .unwrap();
    assert!(output.status.success(), "{command}: {output:?}");
    String::from_utf8(output.stdout).unwrap()
}

/// What Task Scheduler says about [`TEST_LABEL`], for a failure message.
fn schtasks_query() -> String {
    let output = std::process::Command::new("schtasks")
        .args(["/query", "/tn", TEST_LABEL, "/v", "/fo", "csv", "/nh"])
        .output()
        .unwrap();
    String::from_utf8_lossy(&output.stdout).into_owned()
}

/// Uninstalls the label (third) for the data folder (first), with the task's XML in the second,
/// when a test ends, even partway, so no logon task is left behind.
struct Uninstall<'a>(&'a Path, &'a Path, &'a str);

impl Drop for Uninstall<'_> {
    fn drop(&mut self) {
        let _ = std::process::Command::new(env!("CARGO_BIN_EXE_plxd"))
            .args(["service", "uninstall", "--label", self.2, "--data-dir"])
            .arg(self.0)
            .env("LOCALAPPDATA", self.1)
            .output();
    }
}

/// `plxd service` against the real Task Scheduler, under a test label: install registers the
/// task and its `serve` answers, status reports it running and its program, and uninstall stops
/// that `serve`, for the folder the task serves rather than the one it's given, and removes the
/// task.
#[tokio::test]
async fn service_installs_reports_and_uninstalls_a_logon_task() {
    let temp = tempfile::tempdir().unwrap();
    let data = temp.path().join("data");
    let local = temp.path().join("local");
    std::fs::create_dir(&local).unwrap();
    let _uninstall = Uninstall(&data, &local, TEST_LABEL);

    assert_eq!(
        service(&data, &local, "install").await,
        format!("installed and started {TEST_LABEL}\n")
    );
    let xml = std::fs::read(local.join(format!("{TEST_LABEL}.xml"))).unwrap();
    assert_eq!(xml[..2], [0xFF, 0xFE], "UTF-16 LE with a byte order mark");

    let mut status = String::new();
    let answered = timeout(PATIENCE, async {
        while !status.contains("answers initialize: true") {
            tokio::time::sleep(Duration::from_millis(100)).await;
            status = service(&data, &local, "status").await;
        }
    })
    .await;
    assert!(answered.is_ok(), "{status}{}", schtasks_query());
    let program = format!("program: {}\n", env!("CARGO_BIN_EXE_plxd"));
    for line in ["installed: true", "loaded: true", "running: true", &program] {
        assert!(status.contains(line), "{status}{}", schtasks_query());
    }

    let elsewhere = temp.path().join("elsewhere");
    assert_eq!(
        service(&elsewhere, &local, "uninstall").await,
        format!("uninstalled {TEST_LABEL}\n")
    );
    let status = service(&data, &local, "status").await;
    for line in [
        "installed: false",
        "loaded: false",
        "answers initialize: false",
    ] {
        assert!(status.contains(line), "{status}");
    }
    assert_eq!(
        service(&data, &local, "uninstall").await,
        format!("{TEST_LABEL} was not installed\n")
    );
}

/// attach starts `serve` itself when `schtasks /run` succeeds but the task doesn't run, as while
/// the user isn't logged on (0023).
#[test]
fn attach_starts_serve_when_the_task_does_not_run() {
    let runtime = tokio::runtime::Runtime::new().unwrap();
    let data = tempfile::tempdir().unwrap();
    let options = Options {
        program: env!("CARGO_BIN_EXE_plxd").into(),
        connect_timeout: PATIENCE,
        launch_agent: Some(LaunchAgent {
            // Succeeds, as `schtasks /run` does, and starts nothing.
            program: "whoami".into(),
            args: Vec::new(),
            task: format!("{TEST_LABEL}.missing"),
        }),
    };

    let entered = runtime.enter();
    let connected = attach::connect(&DataDir::new(data.path()).unwrap(), &options);
    drop(connected.expect("attach started serve itself"));
    drop(entered);
    // `serve` can accept the connection before it logs the pid that `kill` reads.
    let log = data.path().join("logs").join("plxd.log");
    runtime.block_on(async {
        timeout(PATIENCE, async {
            while !std::fs::read_to_string(&log).is_ok_and(|log| log.contains("listening")) {
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .expect("serve logged its pid");
        kill(data.path()).await;
    });
}

/// The release `host/update` installs in these tests: this build of plxd, under a newer version.
const NEW: &str = "2610.10912.13045-nightly";

/// A home whose `.parallax-plxd\plxd.exe` is this build of plxd at an older version, and a
/// `file://` release of it at [`NEW`] (PLX-825). In the target folder, whose path has no 8.3
/// short names for `service status` to differ by.
struct Update {
    temp: tempfile::TempDir,
    /// The home's `.parallax-plxd\plxd.exe`.
    program: PathBuf,
    releases: String,
}

impl Update {
    fn new() -> Self {
        let temp = tempfile::tempdir_in(env!("CARGO_TARGET_TMPDIR")).unwrap();
        let shared = temp.path().join("home").join(".parallax-plxd");
        std::fs::create_dir_all(&shared).unwrap();
        std::fs::create_dir(temp.path().join("local")).unwrap();
        let program = shared.join("plxd.exe");
        std::fs::copy(env!("CARGO_BIN_EXE_plxd"), &program).unwrap();
        std::fs::write(shared.join("plxd.version"), "2610.10101.10000\n").unwrap();

        let arch = match std::env::consts::ARCH {
            "x86_64" => "x64",
            "aarch64" => "arm64",
            other => panic!("Parallax has no plxd release for {other}"),
        };
        let name = format!("parallax-plxd-{NEW}-win-{arch}.exe");
        let release = temp.path().join("release");
        let dir = release.join(format!("v{NEW}"));
        std::fs::create_dir_all(&dir).unwrap();
        let bytes = std::fs::read(env!("CARGO_BIN_EXE_plxd")).unwrap();
        std::fs::write(dir.join(&name), &bytes).unwrap();
        let hash = sha2::Sha256::digest(&bytes)
            .iter()
            .fold(String::new(), |mut hex, byte| {
                let _ = write!(hex, "{byte:02x}");
                hex
            });
        std::fs::write(
            dir.join(format!("{name}.sha256")),
            format!("{hash}  {name}\n"),
        )
        .unwrap();
        let releases = format!("file:///{}", release.display()).replace('\\', "/");
        Self {
            temp,
            program,
            releases,
        }
    }

    fn path(&self, name: &str) -> PathBuf {
        self.temp.path().join(name)
    }

    /// The home's `.parallax-plxd\plxd.exe serve`, updating from the fake release, with its
    /// logon task under `label`.
    fn serve(&self, label: &str) -> Command {
        let mut command = Command::new(&self.program);
        command
            .arg("serve")
            .arg("--data-dir")
            .arg(self.path("data"))
            .env("USERPROFILE", self.path("home"))
            .env("LOCALAPPDATA", self.path("local"))
            .env("PLXD_RELEASES_URL", &self.releases)
            .env("PLXD_SERVICE_LABEL", label)
            .env_remove("PLXD_LOG")
            .env_remove("PLXD_DATA_DIR")
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .kill_on_drop(true);
        command
    }

    /// `plxd service <args>` from the home's plxd.exe, with the task's XML in `local`.
    async fn service(&self, args: &[&str]) -> std::process::Output {
        timeout(
            PATIENCE,
            Command::new(&self.program)
                .arg("service")
                .args(args)
                .arg("--data-dir")
                .arg(self.path("data"))
                .env("LOCALAPPDATA", self.path("local"))
                .env_remove("PLXD_DATA_DIR")
                .output(),
        )
        .await
        .expect("plxd service finished")
        .unwrap()
    }

    /// Asks the `serve` for the data folder to update to [`NEW`], waits for a `serve` of [`NEW`]
    /// to answer in its place, and for the old plxd.exe, renamed aside, to be deleted.
    async fn update(&self) {
        let pipe = DataDir::new(self.path("data"))
            .unwrap()
            .socket_path()
            .unwrap()
            .path;
        let answer = timeout(PATIENCE * 10, async {
            loop {
                let params = HostUpdateParams {
                    version: NEW.to_owned(),
                    now: false,
                };
                match plxd::peer::Plxd::local(pipe.clone())
                    .call::<HostUpdate>(params)
                    .await
                {
                    Err(error) if error.contains("could not reach") => {
                        tokio::time::sleep(Duration::from_millis(100)).await;
                    }
                    answer => return answer,
                }
            }
        })
        .await
        .expect("host/update answered")
        .unwrap();
        assert_eq!(answer.version, NEW);
        assert_eq!(answer.restart, HostUpdateRestart::Now, "{}", answer.message);

        let mut reported = String::new();
        let restarted = timeout(PATIENCE * 2, async {
            while reported != NEW {
                tokio::time::sleep(Duration::from_millis(200)).await;
                let plxd = plxd::peer::Plxd::local(pipe.clone());
                if let Ok(version) = plxd.call::<HostVersion>(HostVersionParams {}).await {
                    reported = version.plxd;
                }
            }
        })
        .await;
        assert!(restarted.is_ok(), "still plxd {reported}");

        let shared = self.program.parent().unwrap();
        let version = std::fs::read_to_string(shared.join("plxd.version")).unwrap();
        assert_eq!(version, format!("{NEW}\n"));
        let aside = shared.join(plxd::self_update::ASIDE);
        timeout(PATIENCE, async {
            while aside.exists() {
                tokio::time::sleep(Duration::from_millis(100)).await;
            }
        })
        .await
        .expect("the new serve deleted the old plxd.exe");
    }

    /// Waits for `serve` to have logged "listening" `count` times, so [`kill`] finds the last.
    async fn listened(&self, count: usize) {
        let log = self.path("data").join("logs").join("plxd.log");
        timeout(PATIENCE, async {
            while std::fs::read_to_string(&log).map_or(0, |log| log.matches("listening").count())
                < count
            {
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .expect("serve logged its pid");
    }
}

/// Without a logon task, `host/update` renames the running plxd.exe aside, moves the new one in,
/// and starts its `serve` detached (PLX-825).
#[tokio::test]
async fn host_update_replaces_a_running_plxd_and_starts_the_new_serve() {
    let update = Update::new();
    let _old = update.serve(&format!("{TEST_LABEL}.none")).spawn().unwrap();
    update.update().await;
    update.listened(2).await;
    kill(&update.path("data")).await;
}

/// With the logon task installed, `host/update` hands over through the new plxd.exe's
/// `service install --replace`, and the task runs the new `serve` (PLX-825).
#[tokio::test]
async fn host_update_hands_over_through_the_logon_task() {
    let update = Update::new();
    let label = format!("{TEST_LABEL}.update");
    let (data, local) = (update.path("data"), update.path("local"));
    let _uninstall = Uninstall(&data, &local, &label);
    let installed = update.service(&["install", "--label", &label]).await;
    assert!(installed.status.success(), "{installed:?}");
    // The task's `serve` has the user's own environment, without the fake release, so one with
    // this test's takes its place until the update hands back to the task.
    update.listened(1).await;
    kill(&data).await;
    let _old = update.serve(&label).spawn().unwrap();

    update.update().await;
    let status = update.service(&["status", "--label", &label]).await;
    let status = String::from_utf8(status.stdout).unwrap();
    let program = format!("program: {}\n", update.program.display());
    for line in ["running: true", &program] {
        assert!(status.contains(line), "{status}");
    }
}
