//! Computer use (PLX-897, decision 0077): Codex's tools for operating the user's desktop apps,
//! which `plxd mcp` serves on macOS ([`crate::mcp::computer`]). This module holds what doesn't
//! need macOS: the running apps from `lsappinfo`, the apps no thread may control, key names,
//! how a window's accessibility tree reads to the model, the apps the user always allows, and
//! `computer/*`. [`macos`] makes the system calls.
//!
//! Permissions are plxd's own: plxd runs as the Parallax `LaunchAgent`, and macOS checks
//! Accessibility and Screen Recording against the process that agent starts, which every thread's
//! `plxd mcp` descends from.

#![cfg_attr(not(target_os = "macos"), allow(dead_code))]

use std::fmt::Write as _;
use std::path::{Path, PathBuf};

use parallax_protocol::jsonrpc::ErrorObject;
use parallax_protocol::{
    ComputerAskParams, ComputerAskResult, ComputerForgetParams, ComputerStatus,
    ComputerStatusParams,
};

use crate::server::Daemon;

#[cfg(target_os = "macos")]
pub mod macos;

/// The tool a computer use permission request names in the transcript, with the app as its
/// input's `app`.
pub const APPROVAL_TOOL: &str = "computer_use";

/// What a tool says when plxd lacks the Accessibility permission.
pub const NO_ACCESSIBILITY: &str = "Parallax doesn't have the Accessibility permission, so it can't read or control apps. Ask the user to turn on plxd in System Settings > Privacy & Security > Accessibility, or to open Parallax Settings > Computer use.";

/// The apps no thread may control, by bundle id prefix: terminals, which would get around a
/// thread's sandbox and approvals, Parallax itself, and the keychain.
const BLOCKED: &[(&str, &str)] = &[
    ("com.apple.Terminal", "a terminal"),
    ("com.googlecode.iterm2", "a terminal"),
    ("dev.warp.", "a terminal"),
    ("com.mitchellh.ghostty", "a terminal"),
    ("org.alacritty", "a terminal"),
    ("net.kovidgoyal.kitty", "a terminal"),
    ("com.github.wez.wezterm", "a terminal"),
    ("co.zeit.hyper", "a terminal"),
    ("dev.parallax.", "Parallax itself"),
    ("com.apple.keychainaccess", "the keychain"),
];

/// A point on screen, in points from the main display's top left.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct Point {
    pub x: f64,
    pub y: f64,
}

/// A frame on screen, in points.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct Rect {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

impl Rect {
    pub fn center(&self) -> Point {
        Point {
            x: self.x + self.width / 2.0,
            y: self.y + self.height / 2.0,
        }
    }
}

/// What the tree shows of one element.
#[derive(Clone, Debug, PartialEq)]
pub struct Info {
    /// Its Accessibility role, such as `AXButton`.
    pub role: String,
    /// The role as macOS describes it to people, such as "button".
    pub kind: String,
    pub title: String,
    pub description: String,
    pub value: String,
    pub placeholder: String,
    pub enabled: bool,
    pub focused: bool,
    pub selected: bool,
    pub frame: Option<Rect>,
    /// Such as `AXPress` and `AXShowMenu`.
    pub actions: Vec<String>,
}

impl Default for Info {
    fn default() -> Self {
        Self {
            role: String::new(),
            kind: String::new(),
            title: String::new(),
            description: String::new(),
            value: String::new(),
            placeholder: String::new(),
            enabled: true,
            focused: false,
            selected: false,
            frame: None,
            actions: Vec::new(),
        }
    }
}

/// The containers the tree leaves out when they have no text and nothing to do, so their
/// children read one level up.
const PLAIN: &[&str] = &[
    "AXGroup",
    "AXUnknown",
    "AXLayoutArea",
    "AXLayoutItem",
    "AXSplitter",
];

/// Whether the tree shows an element: anything but an empty [`PLAIN`] container.
pub fn shown(info: &Info) -> bool {
    !(PLAIN.contains(&info.role.as_str())
        && info.title.is_empty()
        && info.description.is_empty()
        && info.value.is_empty())
        || info
            .actions
            .iter()
            .any(|action| !matches!(action.as_str(), "AXShowMenu" | "AXScrollToVisible"))
}

/// The most of an element's value the tree shows.
const MAX_VALUE_CHARS: usize = 200;

/// One line of the tree: `index`, at `depth`.
pub fn line(index: usize, depth: usize, info: &Info) -> String {
    let mut line = format!("{}{index} ", "  ".repeat(depth));
    let kind = if info.kind.is_empty() {
        info.role.trim_start_matches("AX")
    } else {
        &info.kind
    };
    line.push_str(kind);
    if !info.title.is_empty() {
        let _ = write!(line, " {}", quoted(&info.title));
    }
    if !info.description.is_empty() && info.description != info.title {
        let _ = write!(line, ", {}", one_line(&info.description));
    }
    if !info.value.is_empty() && info.value != info.title {
        let _ = write!(line, ", value: {}", quoted(&info.value));
    } else if !info.placeholder.is_empty() {
        let _ = write!(line, ", placeholder: {}", quoted(&info.placeholder));
    }
    for (flag, word) in [
        (!info.enabled, "disabled"),
        (info.focused, "focused"),
        (info.selected, "selected"),
    ] {
        if flag {
            let _ = write!(line, " ({word})");
        }
    }
    let secondary: Vec<&str> = info
        .actions
        .iter()
        .filter(|action| !matches!(action.as_str(), "AXPress" | "AXScrollToVisible"))
        .map(|action| action.trim_start_matches("AX"))
        .collect();
    if !secondary.is_empty() {
        let _ = write!(line, ". Secondary actions: {}", secondary.join(", "));
    }
    line
}

fn one_line(text: &str) -> String {
    let mut text = text.replace('\n', "\\n");
    if let Some((end, _)) = text.char_indices().nth(MAX_VALUE_CHARS) {
        text.truncate(end);
        text.push('…');
    }
    text
}

fn quoted(text: &str) -> String {
    format!("\"{}\"", one_line(text).replace('"', "\\\""))
}

/// A running app, as `lsappinfo` lists it.
#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct App {
    pub name: String,
    pub bundle_id: String,
    pub pid: i32,
}

/// The apps in the Dock, from `lsappinfo list`: those of type `Foreground`, in its order.
pub fn parse_apps(listed: &str) -> Vec<App> {
    let mut apps = Vec::new();
    let mut current: Option<(String, String)> = None;
    for line in listed.lines() {
        let trimmed = line.trim();
        // ` 12) "Notes" ASN:0x0-0x1d01d: `
        if let Some((number, rest)) = trimmed.split_once(") \"")
            && number.chars().all(|c| c.is_ascii_digit())
            && let Some((name, _)) = rest.split_once('"')
        {
            current = Some((name.to_owned(), String::new()));
        } else if let Some(id) = trimmed.strip_prefix("bundleID=\"")
            && let Some((_, bundle)) = &mut current
        {
            id.trim_end_matches('"').clone_into(bundle);
        } else if let Some(rest) = trimmed.strip_prefix("pid = ")
            && rest.contains("type=\"Foreground\"")
            && let Some((name, bundle_id)) = current.take()
            && let Some(Ok(pid)) = rest.split_whitespace().next().map(str::parse)
        {
            apps.push(App {
                name,
                bundle_id,
                pid,
            });
        }
    }
    apps
}

/// The app `wanted` names, by its name or bundle id, either in any case.
pub fn find<'a>(apps: &'a [App], wanted: &str) -> Option<&'a App> {
    let wanted = wanted.trim().trim_end_matches(".app");
    apps.iter().find(|app| {
        app.name.eq_ignore_ascii_case(wanted) || app.bundle_id.eq_ignore_ascii_case(wanted)
    })
}

/// Why no thread may control the app with `bundle_id`, if it is [`BLOCKED`].
pub fn blocked(bundle_id: &str) -> Option<&'static str> {
    BLOCKED
        .iter()
        .find(|(prefix, _)| bundle_id.starts_with(prefix))
        .map(|(_, why)| *why)
}

/// Quartz's modifier flags.
const SHIFT: u64 = 0x2_0000;
const CONTROL: u64 = 0x4_0000;
const OPTION: u64 = 0x8_0000;
const COMMAND: u64 = 0x10_0000;
const FUNCTION: u64 = 0x80_0000;

/// A key and its modifiers, as `computer_press_key` names them in xdotool's style, such as
/// `Return`, `super+c`, `cmd+shift+4`, or `Page_Down`: its macOS virtual key code and Quartz flags.
pub fn parse_key(combo: &str) -> Result<(u16, u64), String> {
    let parts: Vec<&str> = combo.split('+').map(str::trim).collect();
    let (key, modifiers) = match parts.split_last() {
        // `cmd++` presses plus.
        Some((&"", rest)) if combo.ends_with("++") => ("=", &rest[..rest.len() - 1]),
        Some((key, rest)) if !key.is_empty() => (*key, rest),
        _ => return Err(format!("No key in {combo:?}.")),
    };
    let mut flags = 0;
    for modifier in modifiers {
        flags |= match modifier.to_ascii_lowercase().as_str() {
            "cmd" | "command" | "super" | "meta" | "win" => COMMAND,
            "ctrl" | "control" => CONTROL,
            "alt" | "option" | "opt" => OPTION,
            "shift" => SHIFT,
            "fn" => FUNCTION,
            other => {
                return Err(format!(
                    "{other:?} isn't a modifier. Use cmd, ctrl, alt, shift, or fn."
                ));
            }
        };
    }
    let code = key_code(key)
        .ok_or_else(|| format!("{key:?} isn't a key name, such as Return, Tab, a, or F5."))?;
    Ok((code, flags))
}

fn key_code(key: &str) -> Option<u16> {
    const LETTERS: &[u16; 26] = &[
        0, 11, 8, 2, 14, 3, 5, 4, 34, 38, 40, 37, 46, 45, 31, 35, 12, 15, 1, 17, 32, 9, 13, 7, 16,
        6,
    ];
    const DIGITS: &[u16; 10] = &[29, 18, 19, 20, 21, 23, 22, 26, 28, 25];
    const F_KEYS: &[u16; 12] = &[122, 120, 99, 118, 96, 97, 98, 100, 101, 109, 103, 111];
    let mut chars = key.chars();
    if let (Some(c), None) = (chars.next(), chars.next()) {
        let c = c.to_ascii_lowercase();
        if c.is_ascii_lowercase() {
            return Some(LETTERS[usize::from(c as u8 - b'a')]);
        }
        if let Some(d) = c.to_digit(10) {
            return Some(DIGITS[d as usize]);
        }
    }
    if let Some(n) = key
        .strip_prefix(['F', 'f'])
        .and_then(|n| n.parse::<usize>().ok())
        .filter(|n| (1..=12).contains(n))
    {
        return Some(F_KEYS[n - 1]);
    }
    Some(match key.to_ascii_lowercase().as_str() {
        "return" | "enter" | "kp_enter" => 36,
        "tab" => 48,
        "space" | " " => 49,
        "backspace" => 51,
        "delete" | "forwarddelete" => 117,
        "escape" | "esc" => 53,
        "left" => 123,
        "right" => 124,
        "down" => 125,
        "up" => 126,
        "home" => 115,
        "end" => 119,
        "page_up" | "pageup" | "prior" => 116,
        "page_down" | "pagedown" | "next" => 121,
        "minus" | "-" => 27,
        "equal" | "=" | "plus" => 24,
        "bracketleft" | "[" => 33,
        "bracketright" | "]" => 30,
        "semicolon" | ";" => 41,
        "apostrophe" | "'" => 39,
        "comma" | "," => 43,
        "period" | "." => 47,
        "slash" | "/" => 44,
        "backslash" | "\\" => 42,
        "grave" | "`" => 50,
        _ => return None,
    })
}

/// The file of apps the user always allows: `{"apps": [...]}` in plxd's data folder.
fn allowed_file(data_dir: &Path) -> PathBuf {
    data_dir.join("computer-use.json")
}

#[derive(Default, serde::Serialize, serde::Deserialize)]
struct Allowed {
    apps: Vec<String>,
}

/// The apps the user always allows, sorted.
pub fn always_allowed(data_dir: &Path) -> Vec<String> {
    std::fs::read(allowed_file(data_dir))
        .ok()
        .and_then(|bytes| serde_json::from_slice::<Allowed>(&bytes).ok())
        .unwrap_or_default()
        .apps
}

fn save_allowed(data_dir: &Path, mut apps: Vec<String>) -> Result<Vec<String>, ErrorObject> {
    apps.sort_by_key(|app| app.to_lowercase());
    apps.dedup_by(|a, b| a.eq_ignore_ascii_case(b));
    let json = serde_json::to_vec_pretty(&Allowed { apps: apps.clone() })
        .map_err(|error| ErrorObject::internal_error(error.to_string()))?;
    // Written whole and renamed into place, so a reader never sees half a file.
    let saved = tempfile::NamedTempFile::new_in(data_dir).and_then(|mut file| {
        std::io::Write::write_all(&mut file, &json)?;
        file.persist(allowed_file(data_dir))
            .map_err(|error| error.error)?;
        Ok(())
    });
    saved.map_err(|error| {
        ErrorObject::internal_error(format!(
            "could not save the apps computer use may use: {error}"
        ))
    })?;
    Ok(apps)
}

fn unsupported() -> ErrorObject {
    ErrorObject::invalid_params("computer use needs a plxd on macOS")
}

/// `computer/ask`: an always-allowed app answers at once; otherwise the thread's transcript asks
/// the user, and Always allow saves the app.
pub(crate) async fn ask(
    daemon: std::sync::Arc<Daemon>,
    params: ComputerAskParams,
) -> Result<ComputerAskResult, ErrorObject> {
    if !cfg!(target_os = "macos") {
        return Err(unsupported());
    }
    let app = params.app.trim().to_owned();
    if app.is_empty() || app.len() > 256 {
        return Err(ErrorObject::invalid_params("app must be 1 to 256 bytes"));
    }
    let root = daemon.data_dir.root().to_owned();
    let mut apps = always_allowed(&root);
    if apps.iter().any(|known| known.eq_ignore_ascii_case(&app)) {
        return Ok(ComputerAskResult {
            allowed: true,
            always: true,
        });
    }
    let answer = crate::agents::computer_ask(daemon, params.run_id, app.clone()).await?;
    if answer.allowed && answer.always {
        apps.push(app);
        save_allowed(&root, apps)?;
    }
    Ok(answer)
}

/// `computer/status`.
pub(crate) async fn status(
    daemon: &Daemon,
    params: ComputerStatusParams,
) -> Result<ComputerStatus, ErrorObject> {
    let root = daemon.data_dir.root().to_owned();
    tokio::task::spawn_blocking(move || read_status(&root, params.request))
        .await
        .map_err(|error| ErrorObject::internal_error(error.to_string()))?
}

/// `computer/forget`.
pub(crate) async fn forget(
    daemon: &Daemon,
    params: ComputerForgetParams,
) -> Result<ComputerStatus, ErrorObject> {
    let root = daemon.data_dir.root().to_owned();
    let mut apps = always_allowed(&root);
    apps.retain(|app| !app.eq_ignore_ascii_case(params.app.trim()));
    save_allowed(&root, apps)?;
    status(daemon, ComputerStatusParams::default()).await
}

#[cfg_attr(
    target_os = "macos",
    expect(clippy::unnecessary_wraps, reason = "only other OSes fail")
)]
fn read_status(root: &Path, request: bool) -> Result<ComputerStatus, ErrorObject> {
    #[cfg(target_os = "macos")]
    {
        // Accessibility first, whose prompt opens its pane. macOS asks for Screen Recording only
        // once, so after that its pane opens instead.
        let accessibility = macos::accessibility(request);
        let screen_recording = macos::screen_recording(request && accessibility);
        if request && accessibility && !screen_recording {
            let pane =
                "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture";
            let _ = std::process::Command::new("/usr/bin/open")
                .arg(pane)
                .status();
        }
        Ok(ComputerStatus {
            accessibility,
            screen_recording,
            program: std::env::current_exe()
                .ok()
                .and_then(|exe| Some(exe.file_name()?.to_string_lossy().into_owned()))
                .unwrap_or_else(|| "plxd".to_owned()),
            apps: always_allowed(root),
        })
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (root, request);
        Err(unsupported())
    }
}

#[cfg(test)]
mod tests;
