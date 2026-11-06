//! Making an Android emulator, and what showing one needs (PLX-886).
//!
//! - **Create**: the newest system image the SDK already has (Google APIs, for this machine's
//!   architecture) becomes a Pixel AVD with the SDK's `avdmanager`, on the newest Pixel profile
//!   that version knows. `avdmanager` is Java, so it gets `JAVA_HOME`, or else Android Studio's own
//!   runtime. Nothing is downloaded: with no system image, the panel says to add one.
//! - **ffmpeg**: serve-emu encodes an emulator's screen with ffmpeg, so its video needs one on
//!   `PATH` (or `SERVE_EMU_FFMPEG`).

use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::process::Command;

use crate::backend::process::{Environment, find_program};

/// The Pixel profiles a new AVD tries, newest first.
const PROFILES: &[&str] = &["pixel_9", "pixel_8", "pixel_7", "pixel_6"];

/// An installed system image: its `sdkmanager` package and its API level.
#[derive(Debug, PartialEq)]
pub(crate) struct SystemImage {
    pub package: String,
    pub api: u32,
}

/// The newest Google APIs system image in `sdk` for this machine's architecture.
pub(crate) fn system_image(sdk: &Path) -> Option<SystemImage> {
    let abi = if cfg!(target_arch = "aarch64") {
        "arm64-v8a"
    } else {
        "x86_64"
    };
    let mut found = Vec::new();
    for platform in std::fs::read_dir(sdk.join("system-images")).ok()?.flatten() {
        let name = platform.file_name().to_string_lossy().into_owned();
        let Some(api) = name
            .strip_prefix("android-")
            .and_then(|api| api.parse::<u32>().ok())
        else {
            continue;
        };
        for tag in ["google_apis", "google_apis_playstore"] {
            if platform.path().join(tag).join(abi).is_dir() {
                found.push(SystemImage {
                    package: format!("system-images;{name};{tag};{abi}"),
                    api,
                });
            }
        }
    }
    // The newest; at one level the last found, the Play Store image, which has the Play Store.
    found.into_iter().max_by_key(|image| image.api)
}

/// The SDK's `avdmanager`, from its latest command-line tools.
pub(crate) fn avdmanager(sdk: &Path) -> Option<PathBuf> {
    let name = if cfg!(windows) {
        "avdmanager.bat"
    } else {
        "avdmanager"
    };
    let path = sdk.join("cmdline-tools/latest/bin").join(name);
    path.is_file().then_some(path)
}

/// A Java runtime `avdmanager` can use.
pub(crate) enum Java {
    /// `JAVA_HOME`, or Android Studio's own runtime: it gets `JAVA_HOME`.
    Home(PathBuf),
    /// A `java` on `PATH`.
    OnPath,
}

/// Whether a `java` on `PATH` runs, found once.
static JAVA_ON_PATH: std::sync::OnceLock<bool> = std::sync::OnceLock::new();

/// A Java runtime for `avdmanager`: `JAVA_HOME`, Android Studio's own, or a `java` on `PATH` that
/// runs (macOS's `/usr/bin/java` is a stub without one), found once per plxd.
pub(crate) fn java(env: &Environment) -> Option<Java> {
    if let Some(home) = env.get("JAVA_HOME").filter(|home| !home.is_empty()) {
        return Some(Java::Home(home.into()));
    }
    let studio: &[&str] = if cfg!(target_os = "macos") {
        &["/Applications/Android Studio.app/Contents/jbr/Contents/Home"]
    } else if cfg!(windows) {
        &["C:/Program Files/Android/Android Studio/jbr"]
    } else {
        &["/opt/android-studio/jbr", "/usr/local/android-studio/jbr"]
    };
    if let Some(home) = studio
        .iter()
        .map(PathBuf::from)
        .find(|home| home.join("bin").is_dir())
    {
        return Some(Java::Home(home));
    }
    let runs = *JAVA_ON_PATH.get_or_init(|| {
        find_program("java".as_ref(), env.get("PATH")).is_ok_and(|java| {
            Command::new(java)
                .arg("-version")
                .stdout(std::process::Stdio::null())
                .stderr(std::process::Stdio::null())
                .status()
                .is_ok_and(|status| status.success())
        })
    });
    runs.then_some(Java::OnPath)
}

/// Makes a Pixel AVD in `sdk` from `image`, named for its profile: the AVD's name and profile.
pub(crate) fn create(
    sdk: &Path,
    image: &SystemImage,
    env: &Environment,
    taken: &[String],
) -> Result<(String, &'static str), String> {
    let avdmanager = avdmanager(sdk).ok_or(
        "Android SDK Command-line Tools (latest) are missing. Install them in Android Studio's SDK Manager.",
    )?;
    let java = java(env)
        .ok_or("Making an emulator needs Java. Install Android Studio, which brings its own.")?;
    let mut last = String::new();
    for profile in PROFILES {
        let base = profile_name(profile);
        let name = (1..=99)
            .map(|n| {
                if n == 1 {
                    base.clone()
                } else {
                    format!("{base}_{n}")
                }
            })
            .find(|name| !taken.iter().any(|taken| taken == name))
            .ok_or("Every Pixel name is taken.")?;
        let mut command = Command::new(&avdmanager);
        command
            .args([
                "create",
                "avd",
                "-n",
                &name,
                "-k",
                &image.package,
                "-d",
                profile,
            ])
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped());
        for name in env.names() {
            if let Some(value) = env.get(name) {
                command.env(name, value);
            }
        }
        if let Java::Home(home) = &java {
            command.env("JAVA_HOME", home);
        }
        let mut child = command
            .spawn()
            .map_err(|error| format!("Couldn't run avdmanager: {error}"))?;
        // It asks whether to make a custom hardware profile.
        if let Some(mut stdin) = child.stdin.take() {
            let _ = std::io::Write::write_all(&mut stdin, b"no\n");
        }
        let output = child
            .wait_with_output()
            .map_err(|error| error.to_string())?;
        if output.status.success() {
            return Ok((name, profile));
        }
        String::from_utf8_lossy(&output.stderr)
            .trim()
            .lines()
            .last()
            .unwrap_or_default()
            .clone_into(&mut last);
    }
    Err(format!("Couldn't make an emulator: {last}"))
}

/// `pixel_9` as `Pixel_9`, as Android Studio names an AVD.
fn profile_name(profile: &str) -> String {
    let mut chars = profile.chars();
    chars
        .next()
        .map(|first| first.to_ascii_uppercase().to_string() + chars.as_str())
        .unwrap_or_default()
}

/// Whether serve-emu can find an ffmpeg to encode an emulator's screen.
pub(crate) fn has_ffmpeg(env: &Environment) -> bool {
    env.get("SERVE_EMU_FFMPEG")
        .is_some_and(|path| Path::new(path).is_file())
        || find_program("ffmpeg".as_ref(), env.get("PATH")).is_ok()
}

/// What to run for ffmpeg, on this OS.
pub(crate) fn ffmpeg_missing() -> String {
    let install = if cfg!(target_os = "macos") {
        "brew install ffmpeg"
    } else if cfg!(windows) {
        "winget install ffmpeg"
    } else {
        "sudo apt install ffmpeg"
    };
    format!("Android video needs ffmpeg. Install it with `{install}`, then restart Parallax.")
}

/// The AVD names in `avd_home`, to keep a new one's name free.
pub(crate) fn avd_names(avd_home: &Path) -> Vec<String> {
    std::fs::read_dir(avd_home)
        .into_iter()
        .flatten()
        .flatten()
        .filter_map(|entry| {
            let name: OsString = entry.file_name();
            name.to_string_lossy()
                .strip_suffix(".ini")
                .map(ToOwned::to_owned)
        })
        .collect()
}

/// Where AVDs live: `ANDROID_AVD_HOME`, else `ANDROID_USER_HOME/avd`, else `~/.android/avd`.
pub(crate) fn avd_home(env: &Environment) -> Option<PathBuf> {
    if let Some(home) = env.get("ANDROID_AVD_HOME").filter(|home| !home.is_empty()) {
        return Some(home.into());
    }
    if let Some(home) = env.get("ANDROID_USER_HOME").filter(|home| !home.is_empty()) {
        return Some(Path::new(home).join("avd"));
    }
    let home = env.get("HOME").or_else(|| env.get("USERPROFILE"))?;
    Some(Path::new(home).join(".android/avd"))
}
