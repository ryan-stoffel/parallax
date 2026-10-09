//! The device tools against fake `xcrun`, `adb`, and `emulator` scripts, which log their
//! arguments to `calls` in their folder.
#![cfg(unix)]

use std::path::{Path, PathBuf};

use serde_json::{Value, json};
use tempfile::TempDir;

use super::{Android, Devices, Ios, Toolchain, android_sdk, png_size};

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

/// A booted emulator `emulator-5554` running AVD `Pixel_8` once `$D/booted` exists, a phone
/// `R58M`, and AVDs `Pixel_8` and `Tablet`.
fn android(dir: &Path) -> Android {
    let png = dir.join("shot.png");
    std::fs::write(&png, PNG).unwrap();
    let adb = script(
        dir,
        "adb",
        r#"case "$*" in
  devices) echo "List of devices attached"; [ -e "$D/booted" ] && printf 'emulator-5554\tdevice\n'; printf 'R58M\tdevice\nOFFLINE\toffline\n' ;;
  "-s emulator-5554 emu avd name") printf 'Pixel_8\r\nOK\r\n' ;;
  "-s R58M shell getprop ro.product.model") echo "Galaxy S10" ;;
  *"getprop ro.build.version.release") echo 15 ;;
  *"getprop sys.boot_completed") echo 1 ;;
  *"exec-out screencap -p") cat "$D/shot.png" ;;
esac"#,
    );
    let emulator = script(
        dir,
        "emulator",
        r#"case "$1" in
  -list-avds) printf 'Pixel_8\nTablet\n' ;;
  -avd) touch "$D/booted"; sleep 2 ;;
esac"#,
    );
    Android { adb, emulator }
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
esac"#,
    );
    Ios { xcrun, open: None }
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
async fn lists_ios_simulators_android_devices_and_avds_and_what_the_thread_has_open() {
    let dir = TempDir::new().unwrap();
    std::fs::write(dir.path().join("booted"), "").unwrap();
    let tools = Toolchain {
        ios: Ok(ios(dir.path())),
        android: Ok(android(dir.path())),
    };
    let devices = devices(&dir, tools);
    let listed = call(&devices, "device_list", json!({})).await.unwrap();
    let summary = |id: &str, platform: &str, name: &str, version: &str, booted, physical| json!({"hostId": "local", "id": id, "platform": platform, "name": name, "version": version, "booted": booted, "physical": physical});
    assert_eq!(
        listed["devices"],
        json!([
            summary("SIM-OFF", "ios", "iPhone 16", "iOS 18.0", false, false),
            summary("SIM-ON", "ios", "iPhone 16 Pro", "iOS 18.0", true, false),
            summary(
                "emulator-5554",
                "android",
                "Pixel_8",
                "Android 15",
                true,
                false
            ),
            summary("R58M", "android", "Galaxy S10", "Android 15", true, true),
            summary("Tablet", "android", "Tablet", "Android", false, false),
        ])
    );
    assert_eq!(
        listed["hosts"][0]["platforms"],
        json!([{"platform": "ios", "available": true}, {"platform": "android", "available": true}])
    );
    assert_eq!(listed["open"], json!([]));

    let opened = call(&devices, "device_open", json!({"deviceId": "R58M"}))
        .await
        .unwrap();
    assert_eq!(opened["device"]["id"], "R58M");
    let listed = call(&devices, "device_list", json!({})).await.unwrap();
    assert_eq!(
        listed["open"],
        json!([{"hostId": "local", "deviceId": "R58M"}])
    );
}

#[tokio::test]
async fn without_a_toolchain_each_platform_says_why_and_open_points_at_device_list() {
    let dir = TempDir::new().unwrap();
    let tools = Toolchain {
        ios: Err("iOS Simulators need macOS with Xcode.".to_owned()),
        android: Err("Android SDK was not found.".to_owned()),
    };
    let devices = devices(&dir, tools);
    let listed = call(&devices, "device_list", json!({})).await.unwrap();
    assert_eq!(
        listed["hosts"][0]["platforms"],
        json!([
            {"platform": "ios", "available": false, "reason": "iOS Simulators need macOS with Xcode."},
            {"platform": "android", "available": false, "reason": "Android SDK was not found."},
        ])
    );
    assert_eq!(listed["devices"], json!([]));
    let error = call(&devices, "device_open", json!({})).await.unwrap_err();
    assert_eq!(
        error,
        "No simulators or emulators were found. Call device_list to see why."
    );
    let error = call(&devices, "device_screenshot", json!({}))
        .await
        .unwrap_err();
    assert_eq!(
        error,
        "No device is open in this thread. Call device_open first."
    );
    let error = call(&devices, "device_list", json!({"hostId": "mac-mini"}))
        .await
        .unwrap_err();
    assert!(error.starts_with("No device host mac-mini."), "{error}");
}

#[tokio::test]
async fn open_picks_as_t3_does() {
    let dir = TempDir::new().unwrap();
    std::fs::write(dir.path().join("booted"), "").unwrap();
    let tools = Toolchain {
        ios: Ok(ios(dir.path())),
        android: Ok(android(dir.path())),
    };
    let devices = devices(&dir, tools);
    let error = call(&devices, "device_open", json!({})).await.unwrap_err();
    assert_eq!(
        error,
        "Both iOS and Android devices are available; pass platform or deviceId."
    );
    let error = call(&devices, "device_open", json!({"deviceId": "nope"}))
        .await
        .unwrap_err();
    assert_eq!(
        error,
        "No device nope on host local. Call device_list for current ids."
    );
    // The platform's booted device, not its first.
    let opened = call(&devices, "device_open", json!({"platform": "ios"}))
        .await
        .unwrap();
    assert_eq!(opened["device"]["id"], "SIM-ON");
    assert!(!calls(&dir).contains("simctl boot"), "{}", calls(&dir));
    assert!(
        opened["quickStart"]
            .as_str()
            .unwrap()
            .contains("xcrun simctl launch SIM-ON <bundle-id>")
    );
}

#[tokio::test]
async fn a_simulator_boots_shows_its_screen_and_shuts_down() {
    let dir = TempDir::new().unwrap();
    let tools = Toolchain {
        ios: Ok(ios(dir.path())),
        android: Err("Android SDK was not found.".to_owned()),
    };
    let devices = devices(&dir, tools);
    let opened = call(&devices, "device_open", json!({"deviceId": "SIM-OFF"}))
        .await
        .unwrap();
    assert_eq!(opened["device"]["booted"], true);
    assert!(calls(&dir).contains("xcrun simctl boot SIM-OFF\nxcrun simctl bootstatus SIM-OFF\n"));

    let reply = devices.call("device_screenshot", json!({})).await.unwrap();
    assert_eq!(reply.png.as_deref(), Some(PNG));
    let metadata: Value = serde_json::from_str(&reply.text).unwrap();
    assert_eq!(metadata["device"]["id"], "SIM-OFF");
    assert_eq!(
        metadata["screenshot"],
        json!({"mimeType": "image/png", "width": 1, "height": 2})
    );
    assert!(calls(&dir).contains("xcrun simctl io SIM-OFF screenshot --type=png /"));

    let error = call(&devices, "device_screenshot", json!({"deviceId": "SIM-ON"}))
        .await
        .unwrap_err();
    assert_eq!(
        error,
        "Device SIM-ON on host local is not open in this thread. Call device_open first."
    );

    let closed = call(&devices, "device_close", json!({"shutdown": true}))
        .await
        .unwrap();
    assert_eq!(closed, json!({}));
    assert!(calls(&dir).contains("xcrun simctl shutdown SIM-OFF"));
    let error = call(&devices, "device_screenshot", json!({}))
        .await
        .unwrap_err();
    assert_eq!(
        error,
        "No device is open in this thread. Call device_open first."
    );
}

#[tokio::test]
async fn an_avd_boots_to_its_emulators_serial_and_closing_kills_it() {
    let dir = TempDir::new().unwrap();
    let tools = Toolchain {
        ios: Err("iOS Simulators need macOS with Xcode.".to_owned()),
        android: Ok(android(dir.path())),
    };
    let devices = devices(&dir, tools);
    let opened = call(
        &devices,
        "device_open",
        json!({"platform": "android", "deviceId": "Pixel_8"}),
    )
    .await
    .unwrap();
    assert_eq!(opened["device"]["id"], "emulator-5554");
    assert_eq!(opened["device"]["booted"], true);
    assert!(calls(&dir).contains("emulator -avd Pixel_8"));

    let reply = devices
        .call("device_screenshot", json!({"deviceId": "emulator-5554"}))
        .await
        .unwrap();
    assert_eq!(reply.png.as_deref(), Some(PNG));

    call(&devices, "device_close", json!({"shutdown": true}))
        .await
        .unwrap();
    assert!(calls(&dir).contains("adb -s emulator-5554 emu kill"));
}

#[test]
fn the_android_sdk_needs_adb_and_the_emulator() {
    let dir = TempDir::new().unwrap();
    let root = dir.path().to_owned();
    let missing = android_sdk(std::slice::from_ref(&root), false)
        .err()
        .unwrap();
    assert!(
        missing.starts_with("Android SDK was not found."),
        "{missing}"
    );
    // ANDROID_HOME names the SDK even when it's empty.
    let explicit = android_sdk(std::slice::from_ref(&root), true)
        .err()
        .unwrap();
    assert!(
        explicit.starts_with("Android SDK Platform-Tools are missing"),
        "{explicit}"
    );
    std::fs::create_dir(root.join("platform-tools")).unwrap();
    std::fs::write(root.join("platform-tools/adb"), "").unwrap();
    let no_emulator = android_sdk(std::slice::from_ref(&root), false)
        .err()
        .unwrap();
    assert!(
        no_emulator.starts_with("Android Emulator is missing"),
        "{no_emulator}"
    );
    std::fs::create_dir(root.join("emulator")).unwrap();
    std::fs::write(root.join("emulator/emulator"), "").unwrap();
    assert!(android_sdk(&[root], false).is_ok());
}

#[test]
fn a_png_has_its_size_and_anything_else_has_none() {
    assert_eq!(png_size(PNG), Some((1, 2)));
    assert_eq!(png_size(b"GIF89a"), None);
    assert_eq!(png_size(&PNG[..20]), None);
}
