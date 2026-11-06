//! The app's Device panel (PLX-886): the host's iOS Simulators and Android Emulators, and a live
//! view of one. plxd lists, boots, and shuts devices down itself, and streams them through Expo's
//! device hub, which it runs on loopback and relays over this connection: `device/stream` opens a
//! stream, `device/data` carries what the hub sends, `device/send` what the app sends back.

use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::RunId;

/// A device's platform.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "lowercase")]
pub enum DevicePlatform {
    /// An iOS Simulator, on macOS with Xcode.
    Ios,
    /// An Android Emulator or a phone adb sees, with the Android SDK.
    Android,
}

/// Params of `device/state`.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct DeviceStateParams {
    /// A thread whose agent's open devices to include in `open`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub run_id: Option<RunId>,
}

/// Result of `device/state`: what the host can run, its devices, and the hub.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct DeviceStateResult {
    /// iOS, then Android.
    pub platforms: Vec<DevicePlatformState>,
    /// Every simulator and emulator, booted first.
    pub devices: Vec<DeviceInfo>,
    /// The device hub.
    pub hub: DeviceHubState,
    /// The devices `runId`'s agent opened with `device_open`, most recent last.
    pub open: Vec<String>,
}

/// Whether the host can run a platform's devices.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct DevicePlatformState {
    /// The platform.
    pub platform: DevicePlatform,
    /// Why it can't, such as a missing Android SDK. Absent when it can.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub unavailable: Option<String>,
    /// What it can run but not show yet, such as Android video without ffmpeg.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub warning: Option<String>,
    /// Whether `device/create` can make one of its devices here.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub can_create: bool,
}

/// A simulator, emulator, or phone.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct DeviceInfo {
    /// The simulator's udid, the adb serial, or an AVD's name while it isn't running.
    pub id: String,
    /// Its platform.
    pub platform: DevicePlatform,
    /// Such as "iPhone 17 Pro".
    pub name: String,
    /// Such as "iOS 26.5" or "Android 15".
    pub version: String,
    /// Whether it is running.
    pub booted: bool,
    /// A phone over USB or Wi-Fi rather than an emulator.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub physical: bool,
}

/// How the device hub stands. It installs only when the user asks (`device/setup`).
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct DeviceHubState {
    /// Whether the pinned hub is installed.
    pub installed: bool,
    /// Whether it is being installed.
    pub installing: bool,
    /// Why the last install or start failed.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub failure: Option<String>,
}

/// Params of `device/setup`: installs the device hub in the background.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct DeviceSetupParams {}

/// Result of `device/setup` and `device/shutdown`.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct DeviceOkResult {}

/// Params of `device/boot`, `device/shutdown`, and `device/screenshot`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct DeviceTarget {
    /// The device, from `device/state`.
    pub device_id: String,
    /// Its platform.
    pub platform: DevicePlatform,
}

/// Params of `device/create`: a new iPhone Simulator on the newest iOS runtime, or a new Pixel
/// emulator on the newest system image the Android SDK has.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct DeviceCreateParams {
    /// Which platform's device to make. Absent makes an iPhone.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub platform: Option<DevicePlatform>,
}

/// Result of `device/boot` and `device/create`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct DeviceResult {
    /// The device as it stands now.
    pub device: DeviceInfo,
}

/// Result of `device/screenshot`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct DeviceScreenshotResult {
    /// A PNG of the screen, in base64.
    pub png: String,
}

/// Result of `device/chrome`: the device as Xcode's Simulator or Android Studio's emulator draws
/// it, from the host's own Xcode or Android Studio.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct DeviceChromeResult {
    /// The artwork, or absent when there's none.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub chrome: Option<DeviceChrome>,
}

/// A device's artwork: its bezel and buttons around its screen, in the artwork's own units (points
/// for a simulator, pixels for an emulator), in its natural orientation.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct DeviceChrome {
    /// The whole device's width, side buttons included.
    pub width: f64,
    /// The whole device's height.
    pub height: f64,
    /// Where the screen is.
    pub screen: DeviceRect,
    /// The screen's shape, an image data URL whose alpha masks it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub mask: Option<String>,
    /// The radius of the screen's corners, when no mask or layer shapes them.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub corner_radius: Option<f64>,
    /// The bezel, buttons, and overlays, in drawing order.
    pub layers: Vec<DeviceChromeLayer>,
}

/// One piece of a device's artwork.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct DeviceChromeLayer {
    /// Such as `bezel`, `power`, or `volume-up`.
    pub name: String,
    /// The image, as a data URL.
    pub image: String,
    /// Where it's drawn.
    pub rect: DeviceRect,
    /// Whether it's drawn over the screen, as an emulator's camera cutout is.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub above: bool,
    /// How far a button moves out while the pointer is over it, as Simulator shows it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub hover_x: Option<f64>,
}

/// A rectangle, in points.
#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct DeviceRect {
    /// Its left.
    pub x: f64,
    /// Its top.
    pub y: f64,
    /// Its width.
    pub width: f64,
    /// Its height.
    pub height: f64,
}

/// What a `device/stream` carries.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub enum DeviceStreamKind {
    /// iOS: the screen as length-prefixed AVCC H.264 envelopes, one way.
    Video,
    /// iOS: touches, buttons, and keys to the simulator, and its screen size back. Android: the
    /// screen as SEMU-framed H.264 and the input, on one socket.
    Control,
}

/// Params of `device/stream`: opens a stream to a booted device through the hub, starting the hub
/// first. Its messages arrive as `device/data` until `device/end`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct DeviceStreamParams {
    /// The client's name for it, unique on this connection. Reusing one closes the old stream.
    pub stream_id: String,
    /// The device.
    pub device_id: String,
    /// Its platform.
    pub platform: DevicePlatform,
    /// What it carries.
    pub kind: DeviceStreamKind,
}

/// Result of `device/stream`: the stream is open.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct DeviceStreamResult {}

/// Params of `device/data` (plxd to the app) and `device/send` (the app to plxd): one message on
/// a stream. A video stream's messages are pieces of its body, a control stream's are its
/// socket's messages.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct DeviceDataParams {
    /// The stream.
    pub stream_id: String,
    /// Binary data in base64, or the text of a text message.
    pub data: String,
    /// Whether `data` is a text message rather than base64.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub text: bool,
}

/// Params of `device/close`: the app is done with a stream.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct DeviceCloseParams {
    /// The stream.
    pub stream_id: String,
}

/// Params of `device/end`: a stream ended, other than by `device/close`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct DeviceEndParams {
    /// The stream.
    pub stream_id: String,
    /// Why, when it failed.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub error: Option<String>,
}
