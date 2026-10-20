//! The app's Device panel (PLX-886): the host's simulators and emulators, and a live view of one,
//! as T3 Code's Device panel shows them ([0064](../../docs/decisions/0064-agent-ui-tools-and-terminals.md)).
//!
//! - **Devices**: listed, booted, shut down, and captured with [`crate::mcp::device`]'s
//!   `simctl`, `adb`, and `emulator` code, which the agents' `device_*` tools use too.
//! - **Hub**: Expo's device hub (`expo-device-hub`, T3's pin) streams and drives them: serve-sim
//!   for iOS, serve-emu for Android. It installs into `<data>/tools/device-hub/` only when the
//!   user asks (`device/setup`), and runs as plxd's child on a random 127.0.0.1 port from the first
//!   stream until plxd stops. Its wrapper exits when its stdin ends, so it never outlives plxd.
//!   serve-sim has a shell-exec route and serve-emu's routes have no auth, so nothing reaches it
//!   but this module, which opens only the stream routes below.
//! - **Relay**: `device/stream` opens one of three upstreams for a booted device: iOS's AVCC video
//!   body (`/helper/<udid>/stream.avcc`), iOS's input socket (`/helper/ws`), or Android's socket,
//!   which carries both (`/ws`). What it sends goes to the connection that opened it as
//!   `device/data`, in base64 unless it's text, and `device/send` writes back. It ends with the
//!   upstream, `device/close`, or the connection.

use std::fmt::Write as _;
use std::path::Path;
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};
use std::time::Duration;

use data_encoding::BASE64;
use futures_util::{SinkExt as _, StreamExt as _};
use parallax_protocol::jsonrpc::{ErrorObject, Notification};
use parallax_protocol::methods::{DeviceData, DeviceEnd, NotificationMethod};
use parallax_protocol::{
    DeviceCloseParams, DeviceCreateParams, DeviceDataParams, DeviceEndParams, DeviceHubState,
    DeviceInfo, DeviceOkResult, DevicePlatform, DevicePlatformState, DeviceResult,
    DeviceScreenshotResult, DeviceStateParams, DeviceStateResult, DeviceStreamKind,
    DeviceStreamParams, DeviceStreamResult, DeviceTarget,
};
use serde::Deserialize;
use tokio::io::{AsyncReadExt as _, AsyncWriteExt as _};
use tokio::net::TcpStream;
use tokio::sync::mpsc;
use tokio::task::AbortHandle;
use tokio_tungstenite::tungstenite::Message;
use tokio_util::sync::CancellationToken;

use crate::backend::node_sdk::NodeSdk;
use crate::backend::process::{Launcher, Output, ProcessSpec, StdinMode};
use crate::mcp::device::{self as tools, Device, Platform, Toolchain};
use crate::methods::Reply;

/// Expo's device hub at T3 Code's pin, and the wrapper plxd starts it with.
pub(crate) static HUB: NodeSdk = NodeSdk {
    name: "device hub",
    dir: "device-hub",
    manifest: include_bytes!("../../sidecar/device-hub/package.json"),
    lockfile: include_bytes!("../../sidecar/device-hub/package-lock.json"),
    src: &[(
        "main.mjs",
        include_bytes!("../../sidecar/device-hub/src/main.mjs"),
    )],
    pin: "/dependencies/expo-device-hub",
    npm: &["ci", "--omit=dev", "--no-audit", "--no-fund"],
    node_required: "Node.js 22.13 or newer is required",
};

/// The longest the hub takes to answer after it starts.
const HUB_READY: Duration = Duration::from_secs(30);
/// The longest connecting to the hub takes.
const CONNECT: Duration = Duration::from_secs(10);
/// The most body bytes one `device/data` carries, so it stays far under the frame limit.
const MAX_CHUNK: usize = 512 * 1024;
/// The messages the app may send ahead of a stream's socket.
const SEND_QUEUE: usize = 256;

/// The Device panel's devices, hub, and streams.
pub(crate) struct Devices {
    launcher: Launcher,
    hub: tokio::sync::Mutex<Option<Hub>>,
    /// Why the hub last failed to start or stopped.
    hub_failure: Arc<Mutex<Option<String>>>,
    streams: Arc<Mutex<Vec<Relay>>>,
}

/// The running hub. Dropping it stops it.
struct Hub {
    port: u16,
    task: AbortHandle,
}

impl Drop for Hub {
    fn drop(&mut self) {
        self.task.abort();
    }
}

/// One open stream: the connection it streams to, its name there, and its writer.
struct Relay {
    replies: mpsc::Sender<Reply>,
    id: String,
    send: mpsc::Sender<Message>,
    task: AbortHandle,
}

impl Devices {
    pub(crate) fn new(launcher: Launcher) -> Self {
        Self {
            launcher,
            hub: tokio::sync::Mutex::default(),
            hub_failure: Arc::default(),
            streams: Arc::default(),
        }
    }

    /// The host's toolchain, found on `serve`'s login-shell `PATH`.
    fn tools(&self) -> Toolchain {
        let base = self.launcher.base();
        Toolchain::detect_with(|name| base.get(name).map(ToOwned::to_owned))
    }

    /// `device/state`.
    pub(crate) async fn state(&self, params: DeviceStateParams) -> DeviceStateResult {
        let tools = self.tools();
        let mut platforms = Vec::new();
        let mut devices = Vec::new();
        let (ios, android) = tokio::join!(
            async {
                match &tools.ios {
                    Ok(ios) => tools::ios_devices(ios).await,
                    Err(why) => Err(why.clone()),
                }
            },
            async {
                match &tools.android {
                    Ok(android) => tools::android_devices(android).await,
                    Err(why) => Err(why.clone()),
                }
            },
        );
        for (platform, listed) in [
            (DevicePlatform::Ios, ios),
            (DevicePlatform::Android, android),
        ] {
            let unavailable = match listed {
                Ok(listed) => {
                    devices.extend(listed.into_iter().map(info));
                    None
                }
                Err(why) => Some(why),
            };
            platforms.push(DevicePlatformState {
                platform,
                unavailable,
            });
        }
        devices.sort_by_key(|device| !device.booted);
        let open = params.run_id.map_or_else(Vec::new, |run| {
            let file = tools::sessions_file(&self.launcher.data_dir().temp_dir(), run);
            tools::read_sessions(&file)
                .unwrap_or_default()
                .into_iter()
                .map(|session| session.device_id)
                .collect()
        });
        let (installing, install_failure) = HUB.install_state(&self.launcher);
        DeviceStateResult {
            platforms,
            devices,
            hub: DeviceHubState {
                installed: HUB.installed(&self.launcher).is_some(),
                installing,
                failure: install_failure.or_else(|| lock(&self.hub_failure).clone()),
            },
            open,
        }
    }

    /// `device/setup`: installs the hub in the background.
    pub(crate) fn setup(&self) -> DeviceOkResult {
        *lock(&self.hub_failure) = None;
        HUB.start_install(&self.launcher, true);
        DeviceOkResult {}
    }

    /// `device/boot`.
    pub(crate) async fn boot(&self, target: DeviceTarget) -> Result<DeviceResult, ErrorObject> {
        let tools = self.tools();
        let device = find(&tools, &target).await?;
        let device = tools::boot(&tools, device).await.map_err(failed)?;
        Ok(DeviceResult {
            device: info(device),
        })
    }

    /// `device/shutdown`.
    pub(crate) async fn shutdown(
        &self,
        target: DeviceTarget,
    ) -> Result<DeviceOkResult, ErrorObject> {
        let platform = platform(target.platform);
        tools::shutdown(&self.tools(), platform, &target.device_id)
            .await
            .map_err(failed)?;
        Ok(DeviceOkResult {})
    }

    /// `device/screenshot`.
    pub(crate) async fn screenshot(
        &self,
        target: DeviceTarget,
    ) -> Result<DeviceScreenshotResult, ErrorObject> {
        let png = tools::screen(&self.tools(), platform(target.platform), &target.device_id)
            .await
            .map_err(failed)?;
        Ok(DeviceScreenshotResult {
            png: BASE64.encode(&png),
        })
    }

    /// `device/create`: an iPhone Simulator of the newest model the newest iOS runtime runs.
    pub(crate) async fn create(&self, _: DeviceCreateParams) -> Result<DeviceResult, ErrorObject> {
        let tools = self.tools();
        let ios = tools.ios.as_ref().map_err(|why| failed(why.clone()))?;
        let args = ["simctl", "list", "runtimes", "available", "--json"];
        let listed = tools::run(&ios.xcrun, &args, tools::COMMAND_TIMEOUT)
            .await
            .map_err(failed)?;
        let (runtime, kind) = newest_iphone(&listed).map_err(failed)?;
        let args = [
            "simctl",
            "create",
            &kind.name,
            &kind.identifier,
            &runtime.identifier,
        ];
        let udid = tools::run(&ios.xcrun, &args, tools::COMMAND_TIMEOUT)
            .await
            .map_err(failed)?;
        Ok(DeviceResult {
            device: DeviceInfo {
                id: String::from_utf8_lossy(&udid).trim().to_owned(),
                platform: DevicePlatform::Ios,
                name: kind.name,
                version: runtime.name,
                booted: false,
                physical: false,
            },
        })
    }

    /// `device/stream`: starts the hub if it isn't running, connects to the stream, and relays it
    /// to `replies` until it ends, `device/close`, or `stopped`.
    pub(crate) async fn stream(
        &self,
        params: DeviceStreamParams,
        replies: &mpsc::Sender<Reply>,
        stopped: &CancellationToken,
    ) -> Result<DeviceStreamResult, ErrorObject> {
        let port = self.hub().await.map_err(failed)?;
        let path = upstream_path(params.platform, params.kind, &params.device_id);
        let upstream = match params.kind {
            DeviceStreamKind::Video => Upstream::Body(get(port, &path).await.map_err(failed)?),
            DeviceStreamKind::Control => {
                if params.platform == DevicePlatform::Ios {
                    prime_ios(port, &params.device_id).await;
                }
                let url = format!("ws://127.0.0.1:{port}{path}");
                let tcp = connect(port).await.map_err(failed)?;
                let (socket, _) =
                    tokio::time::timeout(CONNECT, tokio_tungstenite::client_async(url, tcp))
                        .await
                        .map_err(|_| failed("The device hub didn't answer.".to_owned()))?
                        .map_err(|error| {
                            failed(format!("The device hub refused the stream: {error}"))
                        })?;
                Upstream::Socket(Box::new(socket))
            }
        };
        let (send, outgoing) = mpsc::channel(SEND_QUEUE);
        let id = params.stream_id;
        // The task can't start until it's registered, so a `device/close` right after this answer
        // finds it.
        let mut streams = lock(&self.streams);
        close_relay(&mut streams, replies, &id);
        let task = tokio::spawn(relay(
            upstream,
            outgoing,
            replies.clone(),
            stopped.clone(),
            id.clone(),
            Arc::clone(&self.streams),
        ));
        streams.push(Relay {
            replies: replies.clone(),
            id,
            send,
            task: task.abort_handle(),
        });
        Ok(DeviceStreamResult {})
    }

    /// `device/send`: a message for a control stream's socket. A video stream ignores it.
    pub(crate) fn send(&self, replies: &mpsc::Sender<Reply>, params: DeviceDataParams) {
        let message = if params.text {
            Message::text(params.data)
        } else {
            match BASE64.decode(params.data.as_bytes()) {
                Ok(bytes) => Message::binary(bytes),
                Err(_) => return,
            }
        };
        let streams = lock(&self.streams);
        if let Some(relay) = streams
            .iter()
            .find(|relay| relay.id == params.stream_id && relay.replies.same_channel(replies))
        {
            // ponytail: input past a full queue is dropped; a client that floods it loses taps.
            let _ = relay.send.try_send(message);
        }
    }

    /// `device/close`.
    pub(crate) fn close(&self, replies: &mpsc::Sender<Reply>, params: &DeviceCloseParams) {
        close_relay(&mut lock(&self.streams), replies, &params.stream_id);
    }

    /// The running hub's port, starting it first.
    async fn hub(&self) -> Result<u16, String> {
        let mut hub = self.hub.lock().await;
        if let Some(running) = hub.as_ref()
            && !running.task.is_finished()
        {
            return Ok(running.port);
        }
        *hub = None;
        let Some(installed) = HUB.installed(&self.launcher) else {
            return Err(
                "The device hub isn't installed. Set it up in the Device panel.".to_owned(),
            );
        };
        let port = free_port()
            .map_err(|error| format!("Couldn't reserve a port for the device hub: {error}"))?;
        let spec = self.hub_spec(&installed, port)?;
        let mut process = self
            .launcher
            .spawn(&spec)
            .map_err(|error| format!("Couldn't start the device hub: {error}"))?;
        // Its wrapper exits when stdin ends, which it does when this task, and plxd, goes.
        let stdin = process.take_stdin();
        let failure = Arc::clone(&self.hub_failure);
        let (exited_tx, mut exited) = tokio::sync::watch::channel(None::<String>);
        let task = tokio::spawn(async move {
            let _stdin = stdin;
            while let Some(output) = process.next().await {
                if let Output::Exited(exit) = output {
                    let how = match (exit.info.code, exit.info.signal) {
                        (_, Some(signal)) => format!("killed by signal {signal}"),
                        (Some(code), None) => format!("exit code {code}"),
                        (None, None) => "unknown exit".to_owned(),
                    };
                    let mut why = format!("The device hub stopped ({how})");
                    if !exit.stderr_tail.is_empty() {
                        why = format!("{why}: {}", last_line(&exit.stderr_tail));
                    }
                    *lock(&failure) = Some(why.clone());
                    let _ = exited_tx.send(Some(why));
                }
            }
        });
        let running = Hub {
            port,
            task: task.abort_handle(),
        };
        let deadline = tokio::time::Instant::now() + HUB_READY;
        loop {
            if ready(port).await {
                *lock(&self.hub_failure) = None;
                *hub = Some(running);
                return Ok(port);
            }
            if let Some(why) = exited.borrow_and_update().clone() {
                return Err(why);
            }
            if tokio::time::Instant::now() >= deadline {
                return Err("The device hub didn't start in time.".to_owned());
            }
            tokio::select! {
                _ = exited.changed() => {}
                () = tokio::time::sleep(Duration::from_millis(100)) => {}
            }
        }
    }
}

impl Devices {
    /// How to start the hub installed in `installed` on `port`, with the Android SDK it uses.
    fn hub_spec(&self, installed: &Path, port: u16) -> Result<ProcessSpec, String> {
        let main = HUB
            .main_script(installed)
            .map_err(|error| format!("Couldn't prepare the device hub: {error}"))?;
        let mut spec = ProcessSpec::new("node", installed);
        spec.args = vec![
            main.into_os_string(),
            "--port".into(),
            port.to_string().into(),
        ];
        spec.args.extend(
            [
                "--host",
                "127.0.0.1",
                "--hide-sidebar",
                "--hide-boot-device",
            ]
            .map(Into::into),
        );
        if !cfg!(target_os = "macos") {
            // Only a Mac lists simulators; elsewhere the hub's attempt reads as an error.
            spec.args.extend(["--platform", "android"].map(Into::into));
        }
        spec.stdin = StdinMode::Piped;
        spec.inject.set("FORCE_COLOR", "0").set("NO_COLOR", "1");
        if let Ok(android) = &self.tools().android
            && let Some(root) = android.sdk_root()
        {
            spec.inject.set("ANDROID_HOME", root);
            let path = self
                .launcher
                .base()
                .get("PATH")
                .map(ToOwned::to_owned)
                .unwrap_or_default();
            let dirs = [root.join("platform-tools"), root.join("emulator")]
                .into_iter()
                .chain(std::env::split_paths(&path));
            if let Ok(joined) = std::env::join_paths(dirs) {
                spec.inject.set("PATH", joined);
            }
        }
        Ok(spec)
    }
}

/// The last line of a process's stderr, short.
fn last_line(stderr: &str) -> String {
    let line = stderr.trim().lines().last().unwrap_or_default();
    line.chars().take(300).collect()
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

fn failed(why: String) -> ErrorObject {
    ErrorObject::invalid_params(why)
}

fn platform(platform: DevicePlatform) -> Platform {
    match platform {
        DevicePlatform::Ios => Platform::Ios,
        DevicePlatform::Android => Platform::Android,
    }
}

fn info(device: Device) -> DeviceInfo {
    DeviceInfo {
        id: device.id,
        platform: match device.platform {
            Platform::Ios => DevicePlatform::Ios,
            Platform::Android => DevicePlatform::Android,
        },
        name: device.name,
        version: device.version,
        booted: device.booted,
        physical: device.physical,
    }
}

/// The device `target` names, as its platform lists it.
async fn find(tools: &Toolchain, target: &DeviceTarget) -> Result<Device, ErrorObject> {
    let listed = match target.platform {
        DevicePlatform::Ios => match &tools.ios {
            Ok(ios) => tools::ios_devices(ios).await,
            Err(why) => Err(why.clone()),
        },
        DevicePlatform::Android => match &tools.android {
            Ok(android) => tools::android_devices(android).await,
            Err(why) => Err(why.clone()),
        },
    };
    listed
        .map_err(failed)?
        .into_iter()
        .find(|device| device.id == target.device_id)
        .ok_or_else(|| failed(format!("No device {} on this host.", target.device_id)))
}

/// The hub route a stream reads: the only routes plxd opens.
fn upstream_path(platform: DevicePlatform, kind: DeviceStreamKind, device: &str) -> String {
    let device = percent_encode(device);
    match (platform, kind) {
        (DevicePlatform::Ios, DeviceStreamKind::Video) => {
            format!("/vendor/serve-sim/helper/{device}/stream.avcc")
        }
        (DevicePlatform::Ios, DeviceStreamKind::Control) => {
            format!("/vendor/serve-sim/helper/ws?device={device}")
        }
        // The Android socket carries video and input both.
        (DevicePlatform::Android, _) => {
            format!("/vendor/serve-emu/ws?device={device}&frame-meta=1")
        }
    }
}

/// `value` with everything but unreserved characters percent-encoded.
fn percent_encode(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    for byte in value.bytes() {
        if byte.is_ascii_alphanumeric() || b"-._~".contains(&byte) {
            out.push(byte as char);
        } else {
            let _ = write!(out, "%{byte:02X}");
        }
    }
    out
}

/// serve-sim's helper only takes input and sends its screen size once screen capture runs, which
/// the MJPEG stream starts and the AVCC one doesn't reliably, as T3 found. Reading its first bytes
/// is enough.
async fn prime_ios(port: u16, device: &str) {
    let path = format!(
        "/vendor/serve-sim/helper/{}/stream.mjpeg",
        percent_encode(device)
    );
    let _ = tokio::time::timeout(Duration::from_secs(2), async {
        if let Ok(mut body) = get(port, &path).await {
            let _ = body.next().await;
        }
    })
    .await;
}

enum Upstream {
    Body(Body),
    Socket(Box<tokio_tungstenite::WebSocketStream<TcpStream>>),
}

/// Relays `upstream` to `replies` as `device/data`, and `outgoing` to it, then sends `device/end`
/// unless the stream was closed or replaced.
async fn relay(
    upstream: Upstream,
    mut outgoing: mpsc::Receiver<Message>,
    replies: mpsc::Sender<Reply>,
    stopped: CancellationToken,
    id: String,
    streams: Arc<Mutex<Vec<Relay>>>,
) {
    let data = |data: String, text: bool| {
        Reply::Notification(notification::<DeviceData>(DeviceDataParams {
            stream_id: id.clone(),
            data,
            text,
        }))
    };
    let error = match upstream {
        Upstream::Body(mut body) => loop {
            tokio::select! {
                () = stopped.cancelled() => return,
                next = body.next() => match next {
                    Ok(Some(bytes)) => {
                        for piece in bytes.chunks(MAX_CHUNK) {
                            if replies.send(data(BASE64.encode(piece), false)).await.is_err() {
                                return;
                            }
                        }
                    }
                    Ok(None) => break None,
                    Err(why) => break Some(why),
                },
            }
        },
        Upstream::Socket(mut socket) => loop {
            tokio::select! {
                () = stopped.cancelled() => return,
                sent = outgoing.recv() => {
                    let Some(message) = sent else { return };
                    if let Err(error) = socket.send(message).await {
                        break Some(format!("The device stream closed: {error}"));
                    }
                }
                received = socket.next() => match received {
                    Some(Ok(Message::Binary(bytes))) => {
                        if replies.send(data(BASE64.encode(&bytes), false)).await.is_err() {
                            return;
                        }
                    }
                    Some(Ok(Message::Text(text))) => {
                        if replies.send(data(text.as_str().to_owned(), true)).await.is_err() {
                            return;
                        }
                    }
                    Some(Ok(Message::Close(frame))) => {
                        break frame.map(|frame| frame.reason.to_string()).filter(|why| !why.is_empty());
                    }
                    Some(Ok(_)) => {}
                    Some(Err(error)) => break Some(format!("The device stream closed: {error}")),
                    None => break None,
                },
            }
        },
    };
    // Gone from the list unless `device/close` or a new stream of the same name took it out first,
    // which also means the app isn't waiting for an end.
    let listed = {
        let mut streams = lock(&streams);
        let at = streams
            .iter()
            .position(|relay| relay.id == id && relay.replies.same_channel(&replies));
        at.map(|at| streams.remove(at)).is_some()
    };
    if !listed {
        return;
    }
    let end = notification::<DeviceEnd>(DeviceEndParams {
        stream_id: id.clone(),
        error,
    });
    let _ = replies.send(Reply::Notification(end)).await;
}

fn close_relay(streams: &mut Vec<Relay>, replies: &mpsc::Sender<Reply>, id: &str) {
    streams.retain(|relay| {
        let this = relay.id == id && relay.replies.same_channel(replies);
        if this {
            relay.task.abort();
        }
        !this
    });
}

fn notification<M: NotificationMethod>(params: M::Params) -> Notification {
    Notification {
        method: M::NAME.to_owned(),
        params: serde_json::to_value(params).ok(),
    }
}

/// A free port on loopback, for the hub. Another process could take it before the hub binds it,
/// and then the hub fails to start and the next stream tries again.
fn free_port() -> std::io::Result<u16> {
    Ok(std::net::TcpListener::bind(("127.0.0.1", 0))?
        .local_addr()?
        .port())
}

async fn connect(port: u16) -> Result<TcpStream, String> {
    let stream = tokio::time::timeout(CONNECT, TcpStream::connect(("127.0.0.1", port)))
        .await
        .map_err(|_| "The device hub didn't answer.".to_owned())?
        .map_err(|error| format!("Couldn't reach the device hub: {error}"))?;
    let _ = stream.set_nodelay(true);
    Ok(stream)
}

/// Whether the hub answers `/readyz`.
async fn ready(port: u16) -> bool {
    tokio::time::timeout(Duration::from_secs(2), get(port, "/readyz"))
        .await
        .is_ok_and(|body| body.is_ok())
}

/// An HTTP/1.1 response body being read.
struct Body {
    stream: TcpStream,
    buffer: Vec<u8>,
    chunked: Option<Chunked>,
}

impl Body {
    /// The body's next bytes, or `None` at its end.
    async fn next(&mut self) -> Result<Option<Vec<u8>>, String> {
        let mut read = vec![0; 64 * 1024];
        loop {
            match &mut self.chunked {
                Some(chunked) => {
                    let mut out = Vec::new();
                    let done = chunked.take(&mut self.buffer, &mut out)?;
                    if !out.is_empty() {
                        return Ok(Some(out));
                    }
                    if done {
                        return Ok(None);
                    }
                }
                None if !self.buffer.is_empty() => {
                    return Ok(Some(std::mem::take(&mut self.buffer)));
                }
                None => {}
            }
            let n = self
                .stream
                .read(&mut read)
                .await
                .map_err(|error| format!("The device stream broke: {error}"))?;
            if n == 0 {
                return if self.chunked.is_some() {
                    Err("The device stream ended early.".to_owned())
                } else {
                    Ok(None)
                };
            }
            self.buffer.extend_from_slice(&read[..n]);
        }
    }
}

/// `GET path` on the hub: the body of a 200 response.
async fn get(port: u16, path: &str) -> Result<Body, String> {
    let mut stream = connect(port).await?;
    let request =
        format!("GET {path} HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nConnection: close\r\n\r\n");
    stream
        .write_all(request.as_bytes())
        .await
        .map_err(|error| format!("Couldn't reach the device hub: {error}"))?;
    let mut buffer = Vec::new();
    let mut read = vec![0; 16 * 1024];
    loop {
        let n = tokio::time::timeout(CONNECT, stream.read(&mut read))
            .await
            .map_err(|_| "The device hub didn't answer.".to_owned())?
            .map_err(|error| format!("Couldn't reach the device hub: {error}"))?;
        if n == 0 {
            return Err("The device hub closed the stream.".to_owned());
        }
        buffer.extend_from_slice(&read[..n]);
        let mut headers = [httparse::EMPTY_HEADER; 32];
        let mut response = httparse::Response::new(&mut headers);
        match response.parse(&buffer) {
            Ok(httparse::Status::Complete(length)) => {
                let status = response.code.unwrap_or_default();
                if status != 200 {
                    return Err(format!("The device hub answered {status} for the stream."));
                }
                let chunked = response.headers.iter().any(|header| {
                    header.name.eq_ignore_ascii_case("transfer-encoding")
                        && String::from_utf8_lossy(header.value).contains("chunked")
                });
                buffer.drain(..length);
                return Ok(Body {
                    stream,
                    buffer,
                    chunked: chunked.then(Chunked::default),
                });
            }
            Ok(httparse::Status::Partial) if buffer.len() < 64 * 1024 => {}
            _ => return Err("The device hub's answer wasn't HTTP.".to_owned()),
        }
    }
}

/// Decoding a chunked body: how much of the current chunk is left to read.
#[derive(Default)]
struct Chunked {
    /// The bytes of the current chunk not read yet, and whether its CRLF is still to come.
    left: Option<(usize, bool)>,
}

impl Chunked {
    /// Moves the data of every chunk in `buffer` to `out`, leaving what's incomplete. Returns
    /// whether the last chunk has been read.
    fn take(&mut self, buffer: &mut Vec<u8>, out: &mut Vec<u8>) -> Result<bool, String> {
        let mut at = 0;
        let done = loop {
            match &mut self.left {
                Some((0, true)) => {
                    if buffer.len() < at + 2 {
                        break false;
                    }
                    at += 2;
                    self.left = None;
                }
                Some((left, _)) if *left > 0 => {
                    let n = (*left).min(buffer.len() - at);
                    if n == 0 {
                        break false;
                    }
                    out.extend_from_slice(&buffer[at..at + n]);
                    at += n;
                    *left -= n;
                    if *left == 0 {
                        self.left = Some((0, true));
                    }
                }
                Some(_) => break true,
                None => {
                    let Some(line) = buffer[at..].windows(2).position(|pair| pair == b"\r\n")
                    else {
                        if buffer.len() - at > 1024 {
                            return Err("The device stream's framing was wrong.".to_owned());
                        }
                        break false;
                    };
                    let size = std::str::from_utf8(&buffer[at..at + line])
                        .ok()
                        .and_then(|line| {
                            usize::from_str_radix(line.split(';').next()?.trim(), 16).ok()
                        })
                        .ok_or("The device stream's framing was wrong.")?;
                    at += line + 2;
                    self.left = Some((size, size > 0));
                    if size == 0 {
                        break true;
                    }
                }
            }
        };
        buffer.drain(..at);
        Ok(done)
    }
}

/// `simctl list runtimes --json`'s shape.
#[derive(Deserialize)]
struct Runtimes {
    runtimes: Vec<Runtime>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Runtime {
    identifier: String,
    name: String,
    #[serde(default)]
    platform: String,
    #[serde(default)]
    supported_device_types: Vec<DeviceKind>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct DeviceKind {
    identifier: String,
    name: String,
    #[serde(default)]
    product_family: String,
}

/// The newest iOS runtime, and the iPhone it lists first that's a Pro and not a Pro Max (simctl
/// lists newest first), else its first iPhone.
fn newest_iphone(listed: &[u8]) -> Result<(Runtime, DeviceKind), String> {
    let listed: Runtimes = serde_json::from_slice(listed)
        .map_err(|error| format!("Couldn't read simctl's runtimes: {error}"))?;
    let Some(mut runtime) = listed
        .runtimes
        .into_iter()
        .rfind(|runtime| runtime.platform == "iOS")
    else {
        return Err(
            "No iOS runtime is installed. Install one in Xcode under Settings > Components."
                .to_owned(),
        );
    };
    let kinds = std::mem::take(&mut runtime.supported_device_types);
    let iphones = kinds
        .into_iter()
        .filter(|kind| kind.product_family == "iPhone");
    let mut first = None;
    for kind in iphones {
        if kind.name.ends_with(" Pro") {
            return Ok((runtime, kind));
        }
        first.get_or_insert(kind);
    }
    first
        .map(|kind| (runtime, kind))
        .ok_or_else(|| "The iOS runtime runs no iPhone.".to_owned())
}

#[cfg(test)]
mod tests;
