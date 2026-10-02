//! `plxd attach` and `plxd serve` on Windows (0023): attach starts a detached `serve`, which
//! answers over the named pipe, outlives attach, holds the lock, and gets none of attach's
//! handles.
#![cfg(windows)]

use std::path::Path;
use std::process::Stdio;
use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use parallax_protocol::framing::FrameCodec;
use parallax_protocol::jsonrpc::{Message, Request};
use parallax_protocol::methods::Initialize;
use parallax_protocol::{Capabilities, ClientInfo, InitializeParams, ProtocolRange};
use plxd::paths::DataDir;
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
