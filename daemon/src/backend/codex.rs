//! The Codex backend: runs the user's own signed-in `codex` CLI headless (0004, PLX-38).
//!
//! plxd runs only threads on Codex (`RunRequest::full_agent`, 0017): a normal thread, a Project's
//! child, or its coordinator (0042), on `codex app-server` as full Codex, with the user's own
//! configuration, follow-ups, and approval requests. See [`app_server`] and 0035. The `codex exec`
//! worker 0013 described is gone (PLX-396).
//!
//! # Images
//!
//! The prompt's images (PLX-191) are files in a folder of their own in the data folder's `tmp/`,
//! which [`write_images`] makes and the run's driver deletes once Codex has exited. The model
//! sees plxd's temp path, never the user's file name, which plxd never gets.
//!
//! # Credentials
//!
//! Every run drops inherited variables starting with [`SCRUBBED_PREFIXES`], which could pick
//! Codex's credentials, endpoint, or configuration folder. A subscription then gets only its
//! account's `CODEX_HOME`, if it has one.

pub mod app_server;
#[cfg(test)]
mod tests;

use std::ffi::{OsStr, OsString};
use std::io;
use std::path::{Path, PathBuf};

use serde_json::json;
use tempfile::TempDir;

use super::commands::{self, CommandsProbe};
use super::event::FailureKind;
use super::process::{Environment, Launcher};
use super::{
    AgentEffort, AgentPermission, Backend, Capabilities, ImageMediaType, Overrides, PromptImage,
    RunRequest, StartError, Started,
};
use crate::images;

/// The CLI's program name, looked up on the launcher's `PATH`.
pub const PROGRAM: &str = "codex";

/// The oldest Codex plxd starts, which the runner checks before it starts a run (0013).
pub const WORKER_MIN_VERSION: &str = "0.157.1";

/// The reasoning efforts a run may ask for: every level (checked with the default model on
/// codex-cli 0.157.1).
const EFFORTS: &[AgentEffort] = &[
    AgentEffort::Low,
    AgentEffort::Medium,
    AgentEffort::High,
    AgentEffort::Xhigh,
    AgentEffort::Max,
];

/// The context windows a run may ask for, in tokens: codex-cli 0.159.3's catalog gives its
/// models 272k by default, and all but `gpt-5.5` up to 872k through `model_context_window`.
const CONTEXT_WINDOWS: &[u32] = &[272_000, 872_000];

/// Prefixes of inherited variables no run gets: `OpenAI`'s and Codex's credentials, endpoints,
/// and configuration (`OPENAI_API_KEY`, `OPENAI_BASE_URL`, `CODEX_API_KEY`, `CODEX_HOME`, ...).
pub const SCRUBBED_PREFIXES: &[&str] = &["OPENAI_", "CODEX_"];

/// The variable that picks a second account's configuration folder.
pub const CONFIG_DIR_ENV: &str = "CODEX_HOME";

/// A [`Backend`] that runs Codex.
#[derive(Clone, Debug)]
pub struct CodexBackend {
    launcher: Launcher,
    overrides: Overrides,
}

impl CodexBackend {
    /// A backend that starts `codex` through `launcher`.
    #[must_use]
    pub fn new(launcher: Launcher) -> Self {
        Self {
            launcher,
            overrides: Overrides::default(),
        }
    }

    /// Runs as a provider instance (0040): its name, program, `CODEX_HOME`, arguments after
    /// `app-server`, and variables.
    #[must_use]
    pub fn with_overrides(mut self, overrides: Overrides) -> Self {
        self.overrides = overrides;
        self
    }
}

/// Codex's `model_reasoning_effort` for `effort`.
///
/// # Errors
///
/// [`StartError::Unsupported`] for an effort this version doesn't know.
pub fn effort_level(effort: AgentEffort) -> Result<&'static str, StartError> {
    Ok(match effort {
        AgentEffort::Low => "low",
        AgentEffort::Medium => "medium",
        AgentEffort::High => "high",
        AgentEffort::Xhigh => "xhigh",
        AgentEffort::Max => "max",
        AgentEffort::Unknown => {
            return Err(StartError::Unsupported(
                "Codex has no such reasoning effort".into(),
            ));
        }
    })
}

/// Writes `images` as files into a new folder in `dir` (plxd's data folder's `tmp/`), named by
/// their order and file type, and returns the folder, which deletes them when dropped, with their
/// paths. `None` for no images. Only the folder's owner may open it (0700).
///
/// # Errors
///
/// If an image isn't base64, or `dir` or a file can't be written.
pub fn write_images(
    dir: &Path,
    images: &[PromptImage],
) -> io::Result<Option<(TempDir, Vec<PathBuf>)>> {
    if images.is_empty() {
        return Ok(None);
    }
    std::fs::create_dir_all(dir)?;
    let mut builder = tempfile::Builder::new();
    builder.prefix("codex-images-");
    #[cfg(unix)]
    builder.permissions(std::os::unix::fs::PermissionsExt::from_mode(0o700));
    let folder = builder.tempdir_in(dir)?;
    let mut paths = Vec::with_capacity(images.len());
    for (n, image) in (1..).zip(images) {
        let bytes = images::decode(&image.data).ok_or_else(|| {
            io::Error::new(
                io::ErrorKind::InvalidInput,
                format!("image {n} isn't base64"),
            )
        })?;
        let extension = match image.media_type {
            ImageMediaType::Png => "png",
            ImageMediaType::Jpeg => "jpg",
            ImageMediaType::Gif => "gif",
            ImageMediaType::Webp => "webp",
            ImageMediaType::Unknown => "bin",
        };
        let path = folder.path().join(format!("{n}.{extension}"));
        std::fs::write(&path, bytes)?;
        paths.push(path);
    }
    Ok(Some((folder, paths)))
}

/// The failure a failed turn's message points to. Codex often reports only the message, so
/// routing's fallback (0012) depends on these phrases: an HTTP 401, or a login that has to be
/// made again, is [`FailureKind::NotSignedIn`]; a usage limit, quota, or rate limit, or a plain
/// HTTP 429 that outlasted Codex's retries ("exceeded retry limit, last status: 429 Too Many
/// Requests"), is [`FailureKind::RateLimited`]. A plan that doesn't include Codex ("upgrade to
/// Plus") stays a [`FailureKind::VendorError`], so it isn't quietly billed to a paid key instead.
pub(super) fn classify(message: &str) -> FailureKind {
    let lower = message.to_lowercase();
    let any = |phrases: &[&str]| phrases.iter().any(|phrase| lower.contains(phrase));
    if any(&[
        "401 unauthorized",
        "not logged in",
        "sign in again",
        "signing in again",
    ]) {
        FailureKind::NotSignedIn
    } else if any(&[
        "usage limit",
        "rate limit",
        "too many requests",
        "quota exceeded",
        "out of credits",
        "spend cap",
    ]) {
        FailureKind::RateLimited
    } else {
        FailureKind::VendorError
    }
}

/// The variables of `base` that no run gets: [`SCRUBBED_PREFIXES`].
#[must_use]
pub fn scrubbed(base: &Environment) -> Vec<OsString> {
    base.names()
        .filter(|name| {
            SCRUBBED_PREFIXES
                .iter()
                .any(|prefix| name.as_encoded_bytes().starts_with(prefix.as_bytes()))
        })
        .map(OsStr::to_owned)
        .collect()
}

impl Backend for CodexBackend {
    fn name(&self) -> &str {
        self.overrides.name.as_deref().unwrap_or(PROGRAM)
    }

    fn capabilities(&self) -> Capabilities {
        Capabilities {
            follow_ups: true,
            resume: true,
            reports_cost: false,
            rate_limits: false,
            // A thread on app-server runs in Codex's own mode sandbox, not 0013's.
            worker_sandbox: false,
            fork: true,
        }
    }

    fn efforts(&self) -> &'static [AgentEffort] {
        EFFORTS
    }

    /// A thread's modes ([`app_server::mode`]).
    fn full_thread(&self) -> bool {
        true
    }

    fn cli(&self) -> Option<parallax_protocol::CliKind> {
        Some(parallax_protocol::CliKind::Codex)
    }

    fn permissions(&self) -> &[AgentPermission] {
        app_server::PERMISSIONS
    }

    fn context_windows(&self) -> &'static [u32] {
        CONTEXT_WINDOWS
    }

    fn fast_mode(&self) -> bool {
        true
    }

    /// `codex app-server` on the default login, asked for `skills/list` ([`commands::codex`]).
    fn commands(&self, cwd: &Path) -> Result<Option<CommandsProbe>, StartError> {
        let home = self.overrides.home.as_deref();
        let spec = app_server::spec(&self.launcher, &self.overrides, cwd, home);
        Ok(Some(CommandsProbe {
            process: self.launcher.spawn(&spec)?,
            input: vec![
                commands::request(1, "initialize", &app_server::initialize_params()),
                json!({"jsonrpc": "2.0", "method": "initialized"}),
                commands::request(commands::LIST_ID, "skills/list", &json!({"cwds": [cwd]})),
            ],
            parse: commands::codex,
        }))
    }

    fn start(&self, request: RunRequest) -> Result<Started, StartError> {
        if !request.full_agent() {
            return Err(StartError::Unsupported(
                "plxd runs only threads and coordinators on Codex (decisions 0035, 0042)".into(),
            ));
        }
        app_server::start(&self.launcher, &self.overrides, request)
    }
}
