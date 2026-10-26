//! The device tools against fake `xcrun`, `adb`, and `emulator` scripts, which log their
//! arguments to `calls` in their folder.
#![cfg(unix)]

use std::path::{Path, PathBuf};

use serde_json::{Value, json};
use tempfile::TempDir;

use super::{Devices, Ios, Toolchain};

/// A 1x1 PNG, as `xcrun simctl io` and `adb exec-out screencap` print it.
const PNG: &[u8] = b"\x89PNG\r\n\x1a\n\0\0\0\x0dIHDR\0\0\0\x01\0\0\0\x02\x08\x06\0\0\0";

const SIMCTL_LIST: &str = r#"{"devices": {
  "com.apple.CoreSimulator.SimRuntime.iOS-18-0": [
    {"udid": "SIM-OFF", "name": "iPhone 16", "state": "Shutdown", "isAvailable": true},
    {"udid": "SIM-ON", "name": "iPhone 16 Pro", "state": "Booted", "isAvailable": true}
  ],
  "com.apple.CoreSimulator.SimRuntime.watchOS-11-0": [
    {"udid": "WATCH", "name": "Apple Watch", "state": "Shutdown", "isAvailable": true}
  ]
}}"#;

/// Writes an executable `sh` script `name` into `dir` that logs its arguments, then runs `body`.
fn script(dir: &Path, name: &str, body: &str) -> PathBuf {
    use std::os::unix::fs::PermissionsExt as _;

    let path = dir.join(name);
    let text = format!(
        "#!/bin/sh\nD='{}'\necho \"{name} $*\" >> \"$D/calls\"\n{body}\n",
        dir.display()
    );
    std::fs::write(&path, text).unwrap();
    std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
    path
}

fn ios(dir: &Path) -> Ios {
    let png = dir.join("shot.png");
    std::fs::write(&png, PNG).unwrap();
    std::fs::write(dir.join("list.json"), SIMCTL_LIST).unwrap();
    let xcrun = script(
        dir,
        "xcrun",
        r#"case "$2" in
  list) cat "$D/list.json" ;;
  io) cp "$D/shot.png" "$6" ;;
  shutdown) [ -e "$D/off-$3" ] && { echo "Unable to shutdown device in current state: Shutdown" >&2; exit 149; }; touch "$D/off-$3" ;;
  boot) sleep 1; sed "/\"$3\"/s/Shutdown/Booted/" "$D/list.json" > "$D/list.new"; mv "$D/list.new" "$D/list.json" ;;
esac"#,
    );
    Ios { xcrun }
}

/// [`ios`]'s commands, and no Android SDK.
fn ios_only(dir: &Path) -> Toolchain {
    Toolchain {
        ios: Ok(ios(dir)),
        android: Err("Android SDK was not found.".to_owned()),
    }
}

fn devices(dir: &TempDir, tools: Toolchain) -> Devices {
    let run = parallax_protocol::RunId::generate();
    Devices {
        tools,
        sessions: dir.path().join("tmp/devices").join(format!("{run}.json")),
    }
}

async fn call(devices: &Devices, name: &str, arguments: Value) -> Result<Value, String> {
    let reply = devices.call(name, arguments).await?;
    Ok(serde_json::from_str(&reply.text).unwrap())
}

fn calls(dir: &TempDir) -> String {
    std::fs::read_to_string(dir.path().join("calls")).unwrap_or_default()
}

#[tokio::test]
async fn every_thread_shares_the_running_simulator_and_only_its_last_shuts_it_down() {
    let dir = TempDir::new().unwrap();
    let tools = || ios_only(dir.path());
    let (first, second) = (devices(&dir, tools()), devices(&dir, tools()));
    for thread in [&first, &second] {
        let opened = call(thread, "device_open", json!({})).await.unwrap();
        assert_eq!(opened["device"]["id"], "SIM-ON");
    }
    let error = call(&second, "device_open", json!({"deviceId": "SIM-OFF"}))
        .await
        .unwrap_err();
    assert!(
        error.starts_with("iPhone 16 Pro (SIM-ON) is this computer's one simulator or emulator"),
        "{error}"
    );
    assert!(!calls(&dir).contains("simctl boot"), "{}", calls(&dir));

    // The first thread still has it open, so the second only closes it.
    let closed = call(&second, "device_close", json!({"shutdown": true}))
        .await
        .unwrap();
    assert_eq!(closed["leftRunning"], json!(["SIM-ON"]));
    assert!(!calls(&dir).contains("simctl shutdown"), "{}", calls(&dir));
    let closed = call(&first, "device_close", json!({"shutdown": true}))
        .await
        .unwrap();
    assert_eq!(closed, json!({}));
    assert!(calls(&dir).contains("xcrun simctl shutdown SIM-ON"));
    // A second shutdown, as from a thread closing at the same time, finds it off and succeeds.
    super::shutdown(&tools(), super::Platform::Ios, "SIM-ON")
        .await
        .unwrap();
}

#[tokio::test]
async fn a_command_past_its_limit_is_killed() {
    let dir = TempDir::new().unwrap();
    let pid = dir.path().join("pid");
    let slow = script(
        dir.path(),
        "slow",
        &format!("echo $$ > '{}'; exec sleep 30", pid.display()),
    );
    let started = std::time::Instant::now();
    let error = super::run(&slow, &[], std::time::Duration::from_millis(500))
        .await
        .unwrap_err();
    assert!(error.contains("did not finish"), "{error}");
    assert!(started.elapsed() < std::time::Duration::from_secs(5));
    // Its process is gone, so it can't keep plxd from exiting (PLX-919).
    let pid = std::fs::read_to_string(&pid).unwrap();
    let mut gone = false;
    for _ in 0..50 {
        let alive = std::process::Command::new("kill")
            .args(["-0", pid.trim()])
            .status()
            .unwrap()
            .success();
        if !alive {
            gone = true;
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
    }
    assert!(gone, "the slow command is still running");
}
