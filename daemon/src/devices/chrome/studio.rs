//! An emulator's artwork as Android Studio's emulator draws it: its skin, from the host's Android
//! Studio, or the AVD's own `skin.path`.
//!
//! - `adb emu avd path` gives the running emulator's AVD folder, whose `config.ini` names its skin
//!   (`skin.path`) or its device profile (`hw.device.name`, such as `pixel_9`).
//! - A profile's skin is `<Android Studio>/plugins/android/resources/device-art-resources/<name>/`
//!   (a foldable's in its `default/`): a `layout` file, which places the display in the frame, and
//!   the images it names, drawn under the display (`background`) or over it (`foreground` mask,
//!   `onion`). Each skin is read once per plxd.

use std::path::{Path, PathBuf};

use data_encoding::BASE64;
use parallax_protocol::{DeviceChrome, DeviceChromeLayer, DeviceRect};

use super::Chromes;
use crate::mcp::device as tools;

impl Chromes {
    /// Emulator `serial`'s artwork, or `None` when there's no skin for it.
    pub(crate) async fn android(
        &self,
        adb: &Path,
        sdk: Option<&Path>,
        serial: &str,
    ) -> Result<Option<DeviceChrome>, String> {
        if !serial.starts_with("emulator-") {
            return Ok(None);
        }
        let args = ["-s", serial, "emu", "avd", "path"];
        let Ok(path) = tools::run(adb, &args, tools::COMMAND_TIMEOUT).await else {
            return Ok(None);
        };
        let path = String::from_utf8_lossy(&path);
        let Some(avd) = path.lines().map(str::trim).find(|line| !line.is_empty()) else {
            return Ok(None);
        };
        let Some(skin) = skin(Path::new(avd), sdk) else {
            return Ok(None);
        };
        let key = format!("android:{}", skin.display());
        let mut cache = self.0.lock().await;
        if let Some(known) = cache.get(&key) {
            return Ok(known.clone());
        }
        let chrome = read(&skin);
        cache.insert(key, chrome.clone());
        Ok(chrome)
    }
}

/// The skin folder AVD `avd` uses: its `skin.path`, else its device profile's in Android Studio or
/// the SDK's `skins/`.
fn skin(avd: &Path, sdk: Option<&Path>) -> Option<PathBuf> {
    let config = std::fs::read_to_string(avd.join("config.ini")).ok()?;
    let value = |key: &str| {
        config.lines().find_map(|line| {
            let (k, v) = line.split_once('=')?;
            (k.trim() == key).then(|| v.trim().to_owned())
        })
    };
    let mut candidates = Vec::new();
    if let Some(path) = value("skin.path").filter(|path| !path.starts_with('_')) {
        let path = PathBuf::from(path);
        if path.is_absolute() {
            candidates.push(path);
        } else if let Some(sdk) = sdk {
            candidates.push(sdk.join(path));
        }
    }
    if let Some(name) = value("hw.device.name") {
        candidates.extend(studio_art().into_iter().map(|dir| dir.join(&name)));
        candidates.extend(sdk.map(|sdk| sdk.join("skins").join(&name)));
    }
    candidates.into_iter().find_map(|dir| {
        [dir.clone(), dir.join("default")]
            .into_iter()
            .find(|dir| dir.join("layout").is_file())
    })
}

/// Where Android Studio keeps its device art, on each OS's usual install paths.
// ponytail: only the usual install folders; a Toolbox or custom install falls back to the plain frame.
fn studio_art() -> Vec<PathBuf> {
    let art = Path::new("plugins/android/resources/device-art-resources");
    let home = std::env::home_dir().unwrap_or_default();
    let var = |name: &str| std::env::var_os(name).map(PathBuf::from);
    let mut installs: Vec<PathBuf> = Vec::new();
    if cfg!(target_os = "macos") {
        for app in ["Android Studio.app", "Android Studio Preview.app"] {
            installs.push(Path::new("/Applications").join(app).join("Contents"));
            installs.push(home.join("Applications").join(app).join("Contents"));
        }
    } else if cfg!(windows) {
        installs.extend(var("ProgramFiles").map(|dir| dir.join("Android/Android Studio")));
        installs.extend(var("LOCALAPPDATA").map(|dir| dir.join("Programs/Android Studio")));
    } else {
        installs.push("/opt/android-studio".into());
        installs.push("/usr/local/android-studio".into());
        installs.push("/snap/android-studio/current/android-studio".into());
        installs.push(home.join("android-studio"));
    }
    installs
        .into_iter()
        .map(|install| install.join(art))
        .collect()
}

/// A skin's `layout`: `key value` pairs and `key { ... }` blocks.
#[derive(Debug, PartialEq)]
enum Node {
    Value(String),
    Block(Vec<(String, Node)>),
}

impl Node {
    fn get(&self, key: &str) -> Option<&Node> {
        match self {
            Node::Block(children) => children.iter().find(|(k, _)| k == key).map(|(_, v)| v),
            Node::Value(_) => None,
        }
    }

    fn at(&self, path: &[&str]) -> Option<&Node> {
        path.iter().try_fold(self, |node, key| node.get(key))
    }

    fn text(&self, path: &[&str]) -> Option<&str> {
        match self.at(path)? {
            Node::Value(value) => Some(value),
            Node::Block(_) => None,
        }
    }

    fn number(&self, path: &[&str]) -> Option<f64> {
        self.text(path)?.parse().ok()
    }

    fn children(&self) -> &[(String, Node)] {
        match self {
            Node::Block(children) => children,
            Node::Value(_) => &[],
        }
    }
}

/// The block whose `{` was just read, through its `}`.
fn block<'a>(tokens: &mut std::iter::Peekable<impl Iterator<Item = &'a str>>) -> Node {
    let mut children = Vec::new();
    while let Some(key) = tokens.next() {
        if key == "}" {
            break;
        }
        match tokens.next() {
            Some("{") => children.push((key.to_owned(), block(tokens))),
            Some(value) => children.push((key.to_owned(), Node::Value(value.to_owned()))),
            None => break,
        }
    }
    Node::Block(children)
}

/// Parses a `layout` file.
fn parse(text: &str) -> Node {
    let mut tokens = text
        .split(|c: char| c.is_whitespace())
        .filter(|token| !token.is_empty())
        .peekable();
    block(&mut tokens)
}

/// The artwork of the skin in `dir`, or `None` when its layout doesn't say where the display is.
fn read(dir: &Path) -> Option<DeviceChrome> {
    let layout = parse(&std::fs::read_to_string(dir.join("layout")).ok()?);
    let display = layout.at(&["parts", "device", "display"])?;
    let (display_wide, display_high) = (display.number(&["width"])?, display.number(&["height"])?);
    let layouts = layout.get("layouts")?;
    let chosen = layouts
        .get("portrait")
        .or_else(|| layouts.children().first().map(|(_, node)| node))?;
    let place = |part: &Node| Some((part.number(&["x"])?, part.number(&["y"])?));
    let parts: Vec<(&str, (f64, f64))> = chosen
        .children()
        .iter()
        .filter_map(|(_, part)| Some((part.text(&["name"])?, place(part)?)))
        .collect();
    let (_, (screen_x, screen_y)) = parts.iter().find(|(name, _)| *name == "device")?;
    let screen = DeviceRect {
        x: *screen_x,
        y: *screen_y,
        width: display_wide,
        height: display_high,
    };
    let mut under = Vec::new();
    let mut over = Vec::new();
    for (name, (x, y)) in parts.iter().filter(|(name, _)| *name != "device") {
        let Some(part) = layout.at(&["parts", name]) else {
            continue;
        };
        if let Some(layer) = image(dir, part.text(&["background", "image"]), "back", (*x, *y)) {
            under.push(layer);
        }
        if let Some(layer) = image(dir, part.text(&["onion", "image"]), "onion", (*x, *y)) {
            over.push(layer);
        }
        // The mask covers the display: its corners and camera cutout.
        let mask = image(
            dir,
            part.text(&["foreground", "mask"]),
            "mask",
            (screen.x, screen.y),
        );
        over.extend(mask);
    }
    for layer in &mut over {
        layer.above = true;
    }
    Some(DeviceChrome {
        width: chosen.number(&["width"])?,
        height: chosen.number(&["height"])?,
        screen,
        mask: None,
        corner_radius: display.number(&["corner_radius"]),
        layers: under.into_iter().chain(over).collect(),
    })
}

/// Image `file` in `dir` as a layer at `at`, its own size.
fn image(dir: &Path, file: Option<&str>, name: &str, at: (f64, f64)) -> Option<DeviceChromeLayer> {
    let file = file?;
    let bytes = std::fs::read(dir.join(file)).ok()?;
    let (width, height) = size(&bytes)?;
    let kind = if bytes.starts_with(b"\x89PNG") {
        "png"
    } else {
        "webp"
    };
    Some(DeviceChromeLayer {
        name: name.to_owned(),
        image: format!("data:image/{kind};base64,{}", BASE64.encode(&bytes)),
        rect: DeviceRect {
            x: at.0,
            y: at.1,
            width: f64::from(width),
            height: f64::from(height),
        },
        above: false,
        hover_x: None,
    })
}

/// A PNG's or WebP's width and height, from its header.
fn size(bytes: &[u8]) -> Option<(u32, u32)> {
    let big32 = |at: usize| Some(u32::from_be_bytes(bytes.get(at..at + 4)?.try_into().ok()?));
    let little16 = |at: usize| {
        Some(u32::from(u16::from_le_bytes(
            bytes.get(at..at + 2)?.try_into().ok()?,
        )))
    };
    let little24 = |at: usize| {
        let b = bytes.get(at..at + 3)?;
        Some(u32::from(b[0]) | u32::from(b[1]) << 8 | u32::from(b[2]) << 16)
    };
    if bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        return Some((big32(16)?, big32(20)?));
    }
    if bytes.get(0..4)? != b"RIFF" || bytes.get(8..12)? != b"WEBP" {
        return None;
    }
    match bytes.get(12..16)? {
        b"VP8X" => Some((little24(24)? + 1, little24(27)? + 1)),
        b"VP8L" => {
            let bits = u32::from_le_bytes(bytes.get(21..25)?.try_into().ok()?);
            Some(((bits & 0x3fff) + 1, ((bits >> 14) & 0x3fff) + 1))
        }
        b"VP8 " => Some((little16(26)? & 0x3fff, little16(28)? & 0x3fff)),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::{Node, parse, size};

    const PIXEL_9: &str = "parts {
  device { display { width 1080 height 2424 x 0 y 0 corner_radius 87 } }
  portrait { background { image back.webp } foreground { mask mask.webp cutout hole } }
}
layouts {
  portrait {
    width 1198 height 2531 event EV_SW:0:1
    part1 { name portrait x 0 y 0 }
    part2 { name device x 55 y 58 }
  }
}";

    #[test]
    fn a_layout_reads_as_its_blocks() {
        let layout = parse(PIXEL_9);
        assert_eq!(
            layout.number(&["parts", "device", "display", "corner_radius"]),
            Some(87.0)
        );
        assert_eq!(
            layout.text(&["parts", "portrait", "foreground", "mask"]),
            Some("mask.webp")
        );
        let portrait = layout.at(&["layouts", "portrait"]).unwrap();
        assert_eq!(portrait.number(&["width"]), Some(1198.0));
        let names: Vec<_> = portrait
            .children()
            .iter()
            .filter_map(|(_, part)| part.text(&["name"]))
            .collect();
        assert_eq!(names, ["portrait", "device"]);
        assert_eq!(parse("a {").get("a"), Some(&Node::Block(Vec::new())));
    }

    #[test]
    fn image_sizes_read_from_headers() {
        let png = b"\x89PNG\r\n\x1a\n\0\0\0\x0dIHDR\0\0\x04\x38\0\0\x09\x78";
        assert_eq!(size(png), Some((1080, 2424)));
        // VP8X: canvas width - 1 and height - 1, 24 bits each.
        let mut vp8x = b"RIFF\0\0\0\0WEBPVP8X\0\0\0\0\0\0\0\0".to_vec();
        vp8x.extend([0x37, 0x04, 0x00, 0x77, 0x09, 0x00]);
        assert_eq!(size(&vp8x), Some((1080, 2424)));
        assert_eq!(size(b"GIF89a"), None);
    }
}
