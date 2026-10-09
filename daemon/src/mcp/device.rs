//! T3 Code's device tools (PLX-640): `device_list`, `device_open`, `device_screenshot`, and
//! `device_close`, with T3's names, inputs, selection rules, and errors. T3 drives devices through
//! its device hub and hands the agent its `agent-device` CLI; these run `xcrun simctl` for iOS
//! Simulators on macOS and the Android SDK's `adb` and `emulator` directly, from `plxd mcp`.
//!
//! Parallax has no Device panel, so opening an iOS Simulator shows it in Simulator.app, and an
//! Android emulator opens its own window. The devices a thread opened (T3's sessions) are kept in
//! `tmp/devices/<run>.json` in plxd's data folder, so they last across the thread's turns until
//! plxd restarts, as T3's last until its server does. The only device host is this computer,
//! `local`.

use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::Duration;

use parallax_protocol::RunId;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use tokio::time::{Instant, sleep, timeout};

use super::{Reply, parse, pretty};

/// Every device tool, as [`definitions`] lists them.
pub const TOOLS: &[&str] = &[
    "device_list",
    "device_open",
    "device_screenshot",
    "device_close",
];

/// The one device host: this computer.
const LOCAL: &str = "local";

/// The longest a device takes to boot.
const BOOT_TIMEOUT: Duration = Duration::from_mins(3);

/// The longest any other device command takes.
const COMMAND_TIMEOUT: Duration = Duration::from_secs(30);

/// How often a booting emulator is checked.
const BOOT_POLL: Duration = Duration::from_secs(1);

/// The definitions of [`TOOLS`], in its order: T3's schemas, with descriptions that name what
/// Parallax does in place of T3's Device panel and `agent-device` CLI.
#[must_use]
pub fn definitions() -> Vec<Value> {
    let host_id = json!({"type": "string", "description": "Device host from device_list. Defaults to local."});
    let annotations = |title: &str, read_only: bool, destructive: bool| {
        json!({
            "title": title,
            "readOnlyHint": read_only,
            "destructiveHint": destructive,
            "idempotentHint": true,
            "openWorldHint": title != "List devices",
        })
    };
    vec![
        json!({
            "name": "device_list",
            "description": "List iOS Simulators and Android Emulators on this environment's device hosts, which platforms each host can run, and which devices this thread already has open. Call this before device_open when you do not know a device id.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "hostId": {"type": "string", "description": "Limit to one device host. Defaults to all hosts."},
                },
                "additionalProperties": false,
            },
            "annotations": annotations("List devices", true, false),
        }),
        json!({
            "name": "device_open",
            "description": "Open a simulator or emulator for this thread: boots it if needed and shows its window so the user can watch. Returns how to drive it with simctl or adb.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "deviceId": {"type": "string", "description": "Simulator udid or emulator serial from device_list. Omit to use the booted device for the platform, or the most recently used one."},
                    "platform": {"type": "string", "enum": ["ios", "android"], "description": "Required when deviceId is omitted and both platforms are available."},
                    "hostId": host_id,
                },
                "additionalProperties": false,
            },
            "annotations": annotations("Open device", false, false),
        }),
        json!({
            "name": "device_screenshot",
            "description": "Capture the current screen of an open device as a PNG image. Use it to see what the user sees; for taps and text use simctl or adb as device_open describes.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "deviceId": {"type": "string", "description": "Device from device_list. Omit to use the device most recently opened in this thread."},
                    "hostId": host_id,
                },
                "additionalProperties": false,
            },
            "annotations": annotations("Screenshot device", true, false),
        }),
        json!({
            "name": "device_close",
            "description": "Close a device this thread opened. Pass shutdown=true to also power the simulator or emulator off.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "deviceId": {"type": "string", "description": "Device to close. Omit to close every device in this thread."},
                    "hostId": host_id,
                    "shutdown": {"type": "boolean", "description": "Also power the simulator or emulator off. Defaults to false."},
                },
                "additionalProperties": false,
            },
            "annotations": annotations("Close device", false, true),
        }),
    ]
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
enum Platform {
    Ios,
    Android,
}

/// A simulator, emulator, or connected phone, as T3's `DeviceSummary`.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
struct Device {
    host_id: &'static str,
    /// The simulator's udid, or the adb serial (an AVD's name while it isn't running).
    id: String,
    platform: Platform,
    name: String,
    /// Such as "iOS 18.0" or "Android 15".
    version: String,
    booted: bool,
    physical: bool,
}

/// A device the thread opened, as T3's `DeviceSession`.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Session {
    host_id: String,
    device_id: String,
    platform: Platform,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct ListArgs {
    host_id: Option<String>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct OpenArgs {
    device_id: Option<String>,
    platform: Option<Platform>,
    host_id: Option<String>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct TargetArgs {
    device_id: Option<String>,
    host_id: Option<String>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct CloseArgs {
    device_id: Option<String>,
    host_id: Option<String>,
    #[serde(default)]
    shutdown: bool,
}

/// Where each platform's commands are, or why this computer can't run it.
struct Toolchain {
    ios: Result<Ios, String>,
    android: Result<Android, String>,
}

struct Ios {
    xcrun: PathBuf,
    /// macOS's `open`, which shows a booted simulator in Simulator.app. None in tests.
    open: Option<PathBuf>,
}

struct Android {
    adb: PathBuf,
    emulator: PathBuf,
}

impl Toolchain {
    /// What this computer has, found as T3 finds it.
    fn detect() -> Self {
        let path = std::env::var_os("PATH");
        let ios = if cfg!(target_os = "macos") {
            crate::backend::process::find_program("xcrun".as_ref(), path.as_deref())
                .map(|xcrun| Ios {
                    xcrun,
                    open: Some(PathBuf::from("/usr/bin/open")),
                })
                .map_err(|_| "Xcode command line tools were not found.".to_owned())
        } else {
            Err("iOS Simulators need macOS with Xcode.".to_owned())
        };
        let var = |name| std::env::var_os(name).filter(|value| !value.is_empty());
        let explicit = var("ANDROID_HOME").or_else(|| var("ANDROID_SDK_ROOT"));
        let home = var("HOME").or_else(|| var("USERPROFILE"));
        let local_app_data = var("LOCALAPPDATA");
        let mut roots: Vec<PathBuf> = Vec::new();
        if let Some(explicit) = &explicit {
            roots.push(explicit.into());
        } else {
            if let Some(home) = &home {
                let home = Path::new(home);
                roots.push(home.join("Library/Android/sdk"));
                roots.push(home.join("Android/Sdk"));
            }
            if let Some(local) = &local_app_data {
                roots.push(Path::new(local).join("Android/Sdk"));
            }
            // An `adb` on PATH is `<sdk>/platform-tools/adb`.
            if let Ok(adb) = crate::backend::process::find_program("adb".as_ref(), path.as_deref())
                && let Some(root) = std::fs::canonicalize(adb)
                    .ok()
                    .and_then(|adb| Some(adb.parent()?.parent()?.to_owned()))
            {
                roots.push(root);
            }
        }
        Self {
            ios,
            android: android_sdk(&roots, explicit.is_some()),
        }
    }
}

/// The first of `roots` with the SDK's `adb` or `emulator`, or the only one when it is
/// `ANDROID_HOME`'s, as T3 resolves it, with T3's reasons for what's missing.
fn android_sdk(roots: &[PathBuf], explicit: bool) -> Result<Android, String> {
    let exe = |name: &str| format!("{name}{}", std::env::consts::EXE_SUFFIX);
    for root in roots {
        let adb = root.join("platform-tools").join(exe("adb"));
        let emulator = root.join("emulator").join(exe("emulator"));
        let (has_adb, has_emulator) = (adb.is_file(), emulator.is_file());
        if !(explicit || has_adb || has_emulator) {
            continue;
        }
        let root = root.display();
        return match (has_adb, has_emulator) {
            (true, true) => Ok(Android { adb, emulator }),
            (false, _) => Err(format!(
                "Android SDK Platform-Tools are missing from {root}. Install them in Android Studio's SDK Manager."
            )),
            (true, false) => Err(format!(
                "Android Emulator is missing from {root}. Install it in Android Studio's SDK Manager."
            )),
        };
    }
    Err("Android SDK was not found. Install it with Android Studio or set ANDROID_HOME to your SDK directory.".to_owned())
}

/// The device tools for one thread.
pub struct Devices {
    tools: Toolchain,
    /// The file holding the thread's [`Session`]s.
    sessions: PathBuf,
}

impl Devices {
    /// The device tools for `run`, keeping its open devices in `temp`, plxd's data folder's
    /// `tmp/`.
    #[must_use]
    pub fn new(temp: &Path, run: RunId) -> Self {
        Self {
            tools: Toolchain::detect(),
            sessions: temp.join("devices").join(format!("{run}.json")),
        }
    }

    /// Runs device tool `name`.
    ///
    /// # Errors
    ///
    /// Why the tool failed, for the model.
    pub async fn call(&self, name: &str, arguments: Value) -> Result<Reply, String> {
        match name {
            "device_list" => {
                let ListArgs { host_id } = parse(arguments)?;
                check_host(host_id.as_deref())?;
                self.list().await.map(Reply::from)
            }
            "device_open" => self.open(parse(arguments)?).await.map(Reply::from),
            "device_screenshot" => self.screenshot(parse(arguments)?).await,
            "device_close" => self.close(parse(arguments)?).await.map(Reply::from),
            other => Err(format!("no tool is named {other:?}")),
        }
    }

    async fn list(&self) -> Result<String, String> {
        let (ios, ios_reason) = match &self.tools.ios {
            Ok(ios) => split(ios_devices(ios).await),
            Err(reason) => (Vec::new(), Some(reason.clone())),
        };
        let (android, android_reason) = match &self.tools.android {
            Ok(android) => split(android_devices(android).await),
            Err(reason) => (Vec::new(), Some(reason.clone())),
        };
        let platform = |platform: &str, reason: Option<String>| match reason {
            None => json!({"platform": platform, "available": true}),
            Some(reason) => json!({"platform": platform, "available": false, "reason": reason}),
        };
        let open: Vec<Value> = self
            .read_sessions()?
            .iter()
            .map(|session| json!({"hostId": session.host_id, "deviceId": session.device_id}))
            .collect();
        let devices = [ios, android].concat();
        Ok(pretty(&json!({
            "hosts": [{
                "id": LOCAL,
                "kind": "local",
                "label": "This computer",
                "platforms": [platform("ios", ios_reason), platform("android", android_reason)],
            }],
            "devices": devices,
            "open": open,
        })))
    }

    async fn open(&self, args: OpenArgs) -> Result<String, String> {
        check_host(args.host_id.as_deref())?;
        let mut devices = Vec::new();
        if let Ok(ios) = &self.tools.ios {
            devices.extend(ios_devices(ios).await.unwrap_or_default());
        }
        if let Ok(android) = &self.tools.android {
            devices.extend(android_devices(android).await.unwrap_or_default());
        }
        let mut device = pick(devices, &args)?;
        match device.platform {
            Platform::Ios => {
                let ios = self.tools.ios.as_ref()?;
                if !device.booted {
                    let xcrun = &ios.xcrun;
                    let failed = |error: String| boot_failed(&device.id, &error);
                    run(xcrun, &["simctl", "boot", &device.id], BOOT_TIMEOUT)
                        .await
                        .map_err(failed)?;
                    run(xcrun, &["simctl", "bootstatus", &device.id], BOOT_TIMEOUT)
                        .await
                        .map_err(failed)?;
                    device.booted = true;
                }
                if let Some(open) = &ios.open {
                    // Shows it to the user, as T3's Device panel would. Without a desktop, as
                    // over SSH, it fails, and the simulator runs headless.
                    let args = [
                        "-a",
                        "Simulator",
                        "--args",
                        "-CurrentDeviceUDID",
                        &device.id,
                    ];
                    let _ = run(open, &args, COMMAND_TIMEOUT).await;
                }
            }
            Platform::Android => {
                let android = self.tools.android.as_ref()?;
                if !device.booted {
                    let serial = boot_avd(android, &device.id).await?;
                    device = android_device(android, serial).await;
                }
            }
        }
        let mut sessions = self.read_sessions()?;
        sessions.retain(|session| session.device_id != device.id);
        sessions.push(Session {
            host_id: LOCAL.to_owned(),
            device_id: device.id.clone(),
            platform: device.platform,
        });
        self.write_sessions(&sessions)?;
        let quick_start = quick_start(&device);
        Ok(pretty(
            &json!({"device": device, "quickStart": quick_start}),
        ))
    }

    async fn screenshot(&self, args: TargetArgs) -> Result<Reply, String> {
        check_host(args.host_id.as_deref())?;
        let sessions = self.read_sessions()?;
        // Only devices this thread opened: another thread's device is not this agent's to watch.
        let Some(session) = sessions.iter().rev().find(|session| {
            args.device_id
                .as_ref()
                .is_none_or(|id| *id == session.device_id)
        }) else {
            return Err(match &args.device_id {
                None => "No device is open in this thread. Call device_open first.".to_owned(),
                Some(id) => format!(
                    "Device {id} on host {LOCAL} is not open in this thread. Call device_open first."
                ),
            });
        };
        let id = &session.device_id;
        let (device, png) = match session.platform {
            Platform::Ios => {
                let ios = self.tools.ios.as_ref()?;
                let devices = ios_devices(ios).await?;
                let device = devices.into_iter().find(|device| device.id == *id);
                let device = device.ok_or_else(|| not_found(id))?;
                let args = ["simctl", "io", id, "screenshot", "--type=png", "-"];
                (device, run(&ios.xcrun, &args, COMMAND_TIMEOUT).await?)
            }
            Platform::Android => {
                let android = self.tools.android.as_ref()?;
                let device = android_device(android, id.clone()).await;
                let args = ["-s", id, "exec-out", "screencap", "-p"];
                (device, run(&android.adb, &args, COMMAND_TIMEOUT).await?)
            }
        };
        let (width, height) = png_size(&png).ok_or("The device's screenshot was not a PNG.")?;
        let text = pretty(&json!({
            "device": device,
            "screenshot": {"mimeType": "image/png", "width": width, "height": height},
        }));
        Ok(Reply {
            text,
            png: Some(png),
        })
    }

    async fn close(&self, args: CloseArgs) -> Result<String, String> {
        check_host(args.host_id.as_deref())?;
        let (closing, kept): (Vec<_>, Vec<_>) =
            self.read_sessions()?.into_iter().partition(|session| {
                args.device_id
                    .as_ref()
                    .is_none_or(|id| *id == session.device_id)
            });
        if closing.is_empty() {
            return Ok("{}".to_owned());
        }
        self.write_sessions(&kept)?;
        if args.shutdown {
            for session in &closing {
                let id = session.device_id.as_str();
                match session.platform {
                    Platform::Ios => {
                        let ios = self.tools.ios.as_ref()?;
                        run(&ios.xcrun, &["simctl", "shutdown", id], BOOT_TIMEOUT).await?;
                    }
                    // A phone isn't powered off; only an emulator is.
                    Platform::Android if id.starts_with("emulator-") => {
                        let android = self.tools.android.as_ref()?;
                        run(&android.adb, &["-s", id, "emu", "kill"], COMMAND_TIMEOUT).await?;
                    }
                    Platform::Android => {}
                }
            }
        }
        Ok("{}".to_owned())
    }

    fn read_sessions(&self) -> Result<Vec<Session>, String> {
        match std::fs::read(&self.sessions) {
            Ok(bytes) => Ok(serde_json::from_slice(&bytes).unwrap_or_default()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(Vec::new()),
            Err(error) => Err(format!(
                "could not read this thread's open devices: {error}"
            )),
        }
    }

    fn write_sessions(&self, sessions: &[Session]) -> Result<(), String> {
        let failed =
            |error: std::io::Error| format!("could not save this thread's open devices: {error}");
        if let Some(dir) = self.sessions.parent() {
            std::fs::create_dir_all(dir).map_err(failed)?;
        }
        let json = serde_json::to_vec(sessions).map_err(|error| error.to_string())?;
        std::fs::write(&self.sessions, json).map_err(failed)
    }
}

/// Refuses a host other than [`LOCAL`].
fn check_host(host_id: Option<&str>) -> Result<(), String> {
    match host_id {
        Some(host) if host != LOCAL => Err(format!(
            "No device host {host}. This environment's only host is {LOCAL}."
        )),
        _ => Ok(()),
    }
}

fn split(listed: Result<Vec<Device>, String>) -> (Vec<Device>, Option<String>) {
    match listed {
        Ok(devices) => (devices, None),
        Err(reason) => (Vec::new(), Some(reason)),
    }
}

fn not_found(id: &str) -> String {
    format!("Device {id} was not found on host {LOCAL}.")
}

fn boot_failed(id: &str, why: &str) -> String {
    format!("Device {id} failed to boot: {why}")
}

/// The device `device_open` takes, as T3 picks it: `deviceId`'s, or else the platform's booted
/// device, or its first.
fn pick(devices: Vec<Device>, args: &OpenArgs) -> Result<Device, String> {
    if let Some(id) = &args.device_id {
        return devices
            .into_iter()
            .find(|device| device.id == *id)
            .ok_or_else(|| {
                format!("No device {id} on host {LOCAL}. Call device_list for current ids.")
            });
    }
    let candidates: Vec<Device> = devices
        .into_iter()
        .filter(|device| {
            args.platform
                .is_none_or(|platform| device.platform == platform)
        })
        .collect();
    let Some(first) = candidates.first() else {
        return Err(match args.platform {
            None => {
                "No simulators or emulators were found. Call device_list to see why.".to_owned()
            }
            Some(platform) => format!(
                "No {} devices were found on host {LOCAL}. Call device_list to see why.",
                if platform == Platform::Ios {
                    "ios"
                } else {
                    "android"
                }
            ),
        });
    };
    if args.platform.is_none()
        && candidates
            .iter()
            .any(|device| device.platform != first.platform)
    {
        return Err(
            "Both iOS and Android devices are available; pass platform or deviceId.".to_owned(),
        );
    }
    let booted = candidates.iter().position(|device| device.booted);
    Ok(candidates
        .into_iter()
        .nth(booted.unwrap_or(0))
        .expect("a candidate"))
}

/// How the agent drives `device`, in place of T3's `agent-device` quick start.
fn quick_start(device: &Device) -> String {
    let (name, version, id) = (&device.name, &device.version, &device.id);
    let lines = match device.platform {
        Platform::Ios => vec![
            format!("{name} ({version}) is open in Simulator, where the user can watch it."),
            format!("Drive it with xcrun simctl, passing its udid {id}:"),
            format!("  xcrun simctl install {id} <path-to-.app>"),
            format!("  xcrun simctl launch {id} <bundle-id>"),
            format!("  xcrun simctl openurl {id} <url>"),
            format!("  xcrun simctl terminate {id} <bundle-id>"),
            "Call device_screenshot to see the screen.".to_owned(),
        ],
        Platform::Android => vec![
            format!(
                "{name} ({version}) is open in its emulator window, where the user can watch it."
            ),
            format!("Drive it with adb, passing its serial {id}:"),
            format!("  adb -s {id} install <path-to-.apk>"),
            format!("  adb -s {id} shell monkey -p <package> 1"),
            format!("  adb -s {id} shell input tap <x> <y>"),
            format!("  adb -s {id} shell input text '<text>'"),
            format!("  adb -s {id} shell uiautomator dump /dev/tty   # the screen's view tree"),
            "Call device_screenshot to see the screen.".to_owned(),
        ],
    };
    lines.join("\n")
}

/// Runs `program` with `args` and returns its stdout, or why it failed.
// ponytail: a command that runs past `limit` is left running; kill it if a hung adb ever piles up.
async fn run(program: &Path, args: &[&str], limit: Duration) -> Result<Vec<u8>, String> {
    let name = program.file_stem().unwrap_or_default().to_string_lossy();
    let shown = format!("{name} {}", args.join(" "));
    let mut command = Command::new(program);
    command.args(args).stdin(Stdio::null());
    let output = timeout(limit, tokio::task::spawn_blocking(move || command.output()))
        .await
        .map_err(|_| format!("`{shown}` did not finish in {} s.", limit.as_secs()))?
        .map_err(|error| error.to_string())?
        .map_err(|error| format!("could not run `{shown}`: {error}"))?;
    if output.status.success() {
        return Ok(output.stdout);
    }
    let stderr = String::from_utf8_lossy(&output.stderr);
    Err(format!(
        "`{shown}` failed ({}): {}",
        output.status,
        super::tail(stderr.trim(), 1024)
    ))
}

/// `simctl list devices available --json`'s shape.
#[derive(Deserialize)]
struct SimctlList {
    devices: std::collections::BTreeMap<String, Vec<SimctlDevice>>,
}

#[derive(Deserialize)]
struct SimctlDevice {
    udid: String,
    name: String,
    state: String,
}

/// The available iOS Simulators.
async fn ios_devices(ios: &Ios) -> Result<Vec<Device>, String> {
    let args = ["simctl", "list", "devices", "available", "--json"];
    let listed = run(&ios.xcrun, &args, COMMAND_TIMEOUT).await?;
    let listed: SimctlList = serde_json::from_slice(&listed)
        .map_err(|error| format!("could not read simctl's device list: {error}"))?;
    let mut devices = Vec::new();
    for (runtime, simulators) in listed.devices {
        // `com.apple.CoreSimulator.SimRuntime.iOS-18-0`, as "iOS 18.0". watchOS, tvOS, and
        // visionOS runtimes aren't iOS.
        let Some(number) = runtime
            .rsplit('.')
            .next()
            .and_then(|r| r.strip_prefix("iOS-"))
        else {
            continue;
        };
        let version = format!("iOS {}", number.replace('-', "."));
        devices.extend(simulators.into_iter().map(|simulator| Device {
            host_id: LOCAL,
            id: simulator.udid,
            platform: Platform::Ios,
            name: simulator.name,
            version: version.clone(),
            booted: simulator.state == "Booted",
            physical: false,
        }));
    }
    Ok(devices)
}

/// The running emulators and connected phones, then the AVDs that aren't running.
async fn android_devices(android: &Android) -> Result<Vec<Device>, String> {
    let mut devices = Vec::new();
    for serial in serials(android).await? {
        devices.push(android_device(android, serial).await);
    }
    let avds = run(&android.emulator, &["-list-avds"], COMMAND_TIMEOUT).await?;
    for name in String::from_utf8_lossy(&avds).lines().map(str::trim) {
        let running = devices
            .iter()
            .any(|device| !device.physical && device.name == name);
        if !name.is_empty() && !running {
            devices.push(Device {
                host_id: LOCAL,
                id: name.to_owned(),
                platform: Platform::Android,
                name: name.to_owned(),
                version: "Android".to_owned(),
                booted: false,
                physical: false,
            });
        }
    }
    Ok(devices)
}

/// The serials `adb devices` lists as ready.
async fn serials(android: &Android) -> Result<Vec<String>, String> {
    let listed = run(&android.adb, &["devices"], COMMAND_TIMEOUT).await?;
    Ok(String::from_utf8_lossy(&listed)
        .lines()
        .skip(1)
        .filter_map(|line| {
            let mut fields = line.split_whitespace();
            let serial = fields.next()?;
            (fields.next() == Some("device")).then(|| serial.to_owned())
        })
        .collect())
}

/// The running device `serial`: an emulator, named by its AVD, or a phone, by its model.
async fn android_device(android: &Android, serial: String) -> Device {
    let emulator = serial.starts_with("emulator-");
    let name = if emulator {
        first_line(
            run(
                &android.adb,
                &["-s", &serial, "emu", "avd", "name"],
                COMMAND_TIMEOUT,
            )
            .await,
        )
    } else {
        getprop(android, &serial, "ro.product.model").await
    };
    let release = getprop(android, &serial, "ro.build.version.release").await;
    Device {
        host_id: LOCAL,
        name: name.unwrap_or_else(|| serial.clone()),
        id: serial,
        platform: Platform::Android,
        version: release.map_or_else(
            || "Android".to_owned(),
            |release| format!("Android {release}"),
        ),
        booted: true,
        physical: !emulator,
    }
}

async fn getprop(android: &Android, serial: &str, name: &str) -> Option<String> {
    let args = ["-s", serial, "shell", "getprop", name];
    first_line(run(&android.adb, &args, COMMAND_TIMEOUT).await)
}

fn first_line(output: Result<Vec<u8>, String>) -> Option<String> {
    let output = output.ok()?;
    let line = String::from_utf8_lossy(&output)
        .lines()
        .next()?
        .trim()
        .to_owned();
    (!line.is_empty()).then_some(line)
}

/// Starts AVD `name` and waits until it has booted: its serial.
async fn boot_avd(android: &Android, name: &str) -> Result<String, String> {
    let mut command = Command::new(&android.emulator);
    command
        .args(["-avd", name])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    // Its own process group, so it outlives the thread's turn and its CLI.
    // ponytail: on Windows it stays in the CLI's job; break away if Windows threads need it.
    #[cfg(unix)]
    std::os::unix::process::CommandExt::process_group(&mut command, 0);
    let mut child = command.spawn().map_err(|error| {
        boot_failed(
            name,
            &format!("The simulator or emulator could not start: {error}"),
        )
    })?;
    let deadline = Instant::now() + BOOT_TIMEOUT;
    loop {
        if let Ok(Some(status)) = child.try_wait() {
            return Err(boot_failed(
                name,
                &format!(
                    "The simulator or emulator could not start ({status}). Check its configuration."
                ),
            ));
        }
        for serial in serials(android).await.unwrap_or_default() {
            let args = ["-s", &serial, "emu", "avd", "name"];
            if serial.starts_with("emulator-")
                && first_line(run(&android.adb, &args, COMMAND_TIMEOUT).await).as_deref()
                    == Some(name)
                && getprop(android, &serial, "sys.boot_completed")
                    .await
                    .as_deref()
                    == Some("1")
            {
                return Ok(serial);
            }
        }
        if Instant::now() >= deadline {
            return Err(boot_failed(
                name,
                "The device did not become ready in time.",
            ));
        }
        sleep(BOOT_POLL).await;
    }
}

/// A PNG's width and height, from its IHDR chunk, or `None` if `png` isn't a PNG.
fn png_size(png: &[u8]) -> Option<(u32, u32)> {
    if !png.starts_with(b"\x89PNG\r\n\x1a\n") || png.get(12..16) != Some(b"IHDR") {
        return None;
    }
    let number = |at: usize| Some(u32::from_be_bytes(png.get(at..at + 4)?.try_into().ok()?));
    Some((number(16)?, number(20)?))
}

#[cfg(test)]
mod tests;
