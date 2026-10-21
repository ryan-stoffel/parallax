//! A simulator's artwork as Xcode's Simulator draws it (PLX-886), read from the host's own Xcode:
//! nothing of Apple's ships with Parallax.
//!
//! - The simulator's device type (`simctl list devices --json`) names its `.simdevicetype`
//!   bundle, whose `profile.plist` names its `DeviceKit` chrome and its screen's mask, and whose
//!   `capabilities.plist` gives its screen in pixels and its scale.
//! - The chrome (`/Library/Developer/DeviceKit/Chrome/<name>.devicechrome`) has `chrome.json`,
//!   which places the bezel (its composite image) and each side button, and the PDFs they draw.
//! - The PDFs become PNGs at the screen's scale with macOS's `sips`. Each device type's artwork is
//!   read once per plxd.

use std::collections::HashMap;
use std::future::Future;
use std::path::{Path, PathBuf};

use data_encoding::BASE64;
use parallax_protocol::{DeviceChrome, DeviceChromeLayer, DeviceRect};
use serde::Deserialize;
use serde_json::Value;

use crate::mcp::device as tools;

/// Where Xcode keeps device types and chrome: the shared folders, then Xcode's own.
const DEVICE_TYPES: &[&str] = &[
    "/Library/Developer/CoreSimulator/Profiles/DeviceTypes",
    "/Applications/Xcode.app/Contents/Developer/Platforms/iPhoneOS.platform/Library/Developer/CoreSimulator/Profiles/DeviceTypes",
];
const CHROMES: &[&str] = &[
    "/Library/Developer/DeviceKit/Chrome",
    "/Applications/Xcode.app/Contents/Developer/Platforms/iPhoneOS.platform/Library/Developer/DeviceKit/Chrome",
];

/// Each device type's artwork, once read.
#[derive(Default)]
pub(crate) struct Chromes(tokio::sync::Mutex<HashMap<String, Option<DeviceChrome>>>);

impl Chromes {
    /// Simulator `udid`'s artwork, or `None` when Xcode has none for it.
    pub(crate) async fn get(
        &self,
        xcrun: &Path,
        udid: &str,
    ) -> Result<Option<DeviceChrome>, String> {
        let kind = device_type(xcrun, udid).await?;
        let mut cache = self.0.lock().await;
        if let Some(known) = cache.get(&kind) {
            return Ok(known.clone());
        }
        let chrome = match bundle(&kind) {
            Some(bundle) => read(&bundle).await?,
            None => None,
        };
        cache.insert(kind, chrome.clone());
        Ok(chrome)
    }
}

/// `simctl`'s device type for `udid`, such as `com.apple.CoreSimulator.SimDeviceType.iPhone-17-Pro`.
async fn device_type(xcrun: &Path, udid: &str) -> Result<String, String> {
    #[derive(Deserialize)]
    struct Listed {
        devices: HashMap<String, Vec<Simulator>>,
    }
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Simulator {
        udid: String,
        device_type_identifier: Option<String>,
    }
    let args = ["simctl", "list", "devices", "--json"];
    let listed = tools::run(xcrun, &args, tools::COMMAND_TIMEOUT).await?;
    let listed: Listed = serde_json::from_slice(&listed)
        .map_err(|error| format!("could not read simctl's device list: {error}"))?;
    listed
        .devices
        .into_values()
        .flatten()
        .find(|simulator| simulator.udid == udid)
        .and_then(|simulator| simulator.device_type_identifier)
        .ok_or_else(|| format!("No simulator {udid} on this host."))
}

/// The `.simdevicetype` bundle whose identifier is `kind`.
fn bundle(kind: &str) -> Option<PathBuf> {
    // Bundles are named for their device, such as `iPhone 17 Pro.simdevicetype`, and identified
    // as `...SimDeviceType.iPhone-17-Pro`, so the name is tried first.
    let name = kind.rsplit('.').next()?.replace('-', " ");
    let candidates = DEVICE_TYPES.iter().flat_map(|dir| {
        let named = Path::new(dir).join(format!("{name}.simdevicetype"));
        let all = std::fs::read_dir(dir).into_iter().flatten().flatten();
        std::iter::once(named).chain(all.map(|entry| entry.path()))
    });
    candidates.into_iter().find(|path| {
        plist(&path.join("Contents/Info.plist"))
            .is_some_and(|info| info["CFBundleIdentifier"] == kind)
    })
}

/// A plist as JSON, through macOS's `plutil`.
fn plist(path: &Path) -> Option<Value> {
    let output = std::process::Command::new("/usr/bin/plutil")
        .args(["-convert", "json", "-o", "-"])
        .arg(path)
        .output()
        .ok()?;
    output
        .status
        .success()
        .then(|| serde_json::from_slice(&output.stdout).ok())
        .flatten()
}

/// The parts of `chrome.json` the artwork uses.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ChromeJson {
    images: Images,
    #[serde(default)]
    inputs: Vec<Input>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Images {
    composite: String,
    #[serde(default)]
    device_padding: Padding,
}

#[derive(Default, Deserialize)]
struct Padding {
    #[serde(default)]
    top: f64,
    #[serde(default)]
    left: f64,
    #[serde(default)]
    bottom: f64,
    #[serde(default)]
    right: f64,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Input {
    name: String,
    image: String,
    anchor: String,
    #[serde(default)]
    on_top: bool,
    offsets: Offsets,
}

#[derive(Deserialize)]
struct Offsets {
    normal: Point,
    rollover: Option<Point>,
}

#[derive(Deserialize)]
struct Point {
    x: f64,
    y: f64,
}

/// The artwork of the device type in `bundle`, or `None` when its chrome isn't installed.
async fn read(bundle: &Path) -> Result<Option<DeviceChrome>, String> {
    let resources = bundle.join("Contents/Resources");
    let (Some(profile), Some(capabilities)) = (
        plist(&resources.join("profile.plist")),
        plist(&resources.join("capabilities.plist")),
    ) else {
        return Ok(None);
    };
    let screen = &capabilities["capabilities"]["ScreenDimensionsCapability"];
    let (Some(pixels_wide), Some(pixels_high), Some(scale)) = (
        screen["main-screen-width"].as_f64(),
        screen["main-screen-height"].as_f64(),
        screen["main-screen-scale"]
            .as_f64()
            .filter(|scale| *scale > 0.0),
    ) else {
        return Ok(None);
    };
    let Some(name) = profile["chromeIdentifier"]
        .as_str()
        .and_then(|id| id.rsplit('.').next())
    else {
        return Ok(None);
    };
    let Some(chrome) = CHROMES
        .iter()
        .map(|dir| Path::new(dir).join(format!("{name}.devicechrome/Contents/Resources")))
        .find(|dir| dir.join("chrome.json").is_file())
    else {
        return Ok(None);
    };
    let json = std::fs::read(chrome.join("chrome.json"))
        .map_err(|error| format!("could not read Simulator's artwork: {error}"))?;
    let json: ChromeJson = serde_json::from_slice(&json)
        .map_err(|error| format!("could not read Simulator's artwork: {error}"))?;
    let temp = tempfile::tempdir().map_err(|error| error.to_string())?;
    let png = |name: &str| {
        let pdf = chrome.join(format!("{name}.pdf"));
        let out = temp.path().join(format!("{name}.png"));
        async move { rasterize(&pdf, &out, scale).await }
    };

    let (bezel, bezel_size) = png(&json.images.composite).await?;
    let pad = &json.images.device_padding;
    let width = bezel_size.0 + pad.left + pad.right;
    let height = bezel_size.1 + pad.top + pad.bottom;
    let (screen_wide, screen_high) = (pixels_wide / scale, pixels_high / scale);
    let screen = DeviceRect {
        x: pad.left + (bezel_size.0 - screen_wide) / 2.0,
        y: pad.top + (bezel_size.1 - screen_high) / 2.0,
        width: screen_wide,
        height: screen_high,
    };
    let mask = match profile["framebufferMask"].as_str() {
        Some(mask) => {
            let pdf = resources.join(format!("{mask}.pdf"));
            let out = temp.path().join("mask.png");
            // Only its edge matters, and it's drawn at about a point a pixel, so 2x is plenty.
            rasterize(&pdf, &out, scale.min(2.0)).await?.0
        }
        None => return Ok(None),
    };

    // Buttons under the bezel first, as Simulator stacks them, then the bezel, then any on top.
    let (under, over) = buttons(&json.inputs, width, pad.top, &png).await?;
    let bezel = DeviceChromeLayer {
        name: "bezel".to_owned(),
        png: bezel,
        rect: DeviceRect {
            x: pad.left,
            y: pad.top,
            width: bezel_size.0,
            height: bezel_size.1,
        },
        hover_x: None,
    };
    let layers = under.into_iter().chain([bezel]).chain(over).collect();
    Ok(Some(DeviceChrome {
        width,
        height,
        screen,
        mask,
        layers,
    }))
}

/// Each side button's layer, placed as `chrome.json` places it on a device `width` points wide
/// whose bezel starts `top` points down: those under the bezel, and those over it.
async fn buttons<F, Fut>(
    inputs: &[Input],
    width: f64,
    top: f64,
    png: &F,
) -> Result<(Vec<DeviceChromeLayer>, Vec<DeviceChromeLayer>), String>
where
    F: Fn(&str) -> Fut,
    Fut: Future<Output = Result<(String, (f64, f64)), String>>,
{
    let mut under = Vec::new();
    let mut over = Vec::new();
    for input in inputs {
        let (image, (w, h)) = png(&input.image).await?;
        let x = match input.anchor.as_str() {
            "right" => width + input.offsets.normal.x - w,
            _ => input.offsets.normal.x,
        };
        let hover_x = input
            .offsets
            .rollover
            .as_ref()
            .map(|rollover| rollover.x - input.offsets.normal.x);
        let layer = DeviceChromeLayer {
            name: input.name.clone(),
            png: image,
            rect: DeviceRect {
                x,
                y: top + input.offsets.normal.y,
                width: w,
                height: h,
            },
            hover_x,
        };
        if input.on_top {
            over.push(layer);
        } else {
            under.push(layer);
        }
    }
    Ok((under, over))
}

/// `pdf` as a PNG at `scale` pixels a point: the PNG in base64, and the PDF's size in points.
async fn rasterize(pdf: &Path, out: &Path, scale: f64) -> Result<(String, (f64, f64)), String> {
    let sips = Path::new("/usr/bin/sips");
    let pdf_arg = pdf.to_string_lossy();
    let measured = tools::run(
        sips,
        &["-g", "pixelWidth", "-g", "pixelHeight", &pdf_arg],
        tools::COMMAND_TIMEOUT,
    )
    .await?;
    let size = size(&String::from_utf8_lossy(&measured))
        .ok_or_else(|| format!("could not measure {}", pdf.display()))?;
    let (w, h) = (
        (size.0 * scale).round().to_string(),
        (size.1 * scale).round().to_string(),
    );
    let out_arg = out.to_string_lossy();
    let args = [
        "-s", "format", "png", "-z", &h, &w, &pdf_arg, "--out", &out_arg,
    ];
    tools::run(sips, &args, tools::COMMAND_TIMEOUT).await?;
    let png =
        std::fs::read(out).map_err(|error| format!("could not read {}: {error}", out.display()))?;
    Ok((BASE64.encode(&png), size))
}

/// `sips -g pixelWidth -g pixelHeight`'s width and height.
fn size(sips: &str) -> Option<(f64, f64)> {
    let value = |key: &str| {
        sips.lines()
            .find_map(|line| line.trim().strip_prefix(key)?.trim().parse::<f64>().ok())
    };
    Some((value("pixelWidth:")?, value("pixelHeight:")?))
}

#[cfg(test)]
mod tests {
    #[test]
    fn sips_sizes_read_as_points() {
        let out = "/x/PhoneComposite.pdf\n  pixelWidth: 436.000\n  pixelHeight: 908.000\n";
        assert_eq!(super::size(out), Some((436.0, 908.0)));
        assert_eq!(super::size("nothing"), None);
    }
}
