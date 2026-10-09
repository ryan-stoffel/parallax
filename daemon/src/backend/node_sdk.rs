//! A Node SDK that one of plxd's sidecars runs, installed on first use: the Cursor SDK (0053) and
//! the Claude Agent SDK (0061). The app ships only the sidecar's own files. [`NodeSdk::install`]
//! puts the pinned package in `<data>/tools/<dir>/<version>/` with `npm ci`, and the sidecar runs
//! from there, because the SDK finds its files by walking up from the sidecar's `main.mjs`.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, PoisonError};
use std::time::Duration;

use serde_json::Value;

use super::process::{Launcher, ProcessSpec};
use crate::detect;

/// One sidecar's SDK.
#[derive(Debug)]
pub(crate) struct NodeSdk {
    /// What people call it, such as `Cursor SDK`.
    pub name: &'static str,
    /// Its folder beside `plxd` in the app, and under plxd's tools folder.
    pub dir: &'static str,
    /// The sidecar's folder under the repo's `sidecar/`, for a plxd built from the repo.
    pub repo: &'static str,
    /// The pinned package, as a JSON pointer into the sidecar's `package.json`.
    pub pin: &'static str,
    /// `npm`'s arguments for the install.
    pub npm: &'static [&'static str],
    /// What a host without a new enough Node is told.
    pub node_required: &'static str,
}

/// An install in the background, per SDK folder: whether one is running, and why the last failed.
#[derive(Default)]
struct InstallState {
    installing: bool,
    failure: Option<String>,
}

static INSTALLS: std::sync::LazyLock<Mutex<HashMap<PathBuf, InstallState>>> =
    std::sync::LazyLock::new(Mutex::default);

impl NodeSdk {
    /// The sidecar's files: [`Self::dir`] beside `plxd` in the app, else the repo's.
    pub fn source_dir(&self) -> PathBuf {
        if let Ok(exe) = std::env::current_exe()
            && let Some(dir) = exe.parent()
        {
            let bundled = dir.join(self.dir);
            if bundled.join("package.json").is_file() {
                return bundled;
            }
        }
        Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../sidecar")
            .join(self.repo)
    }

    /// Whether the sidecar's files are in the repo or beside `plxd`, installed or not.
    pub fn script_present(&self) -> bool {
        self.source_dir().join("src").join("main.mjs").is_file()
    }

    /// What Settings says while it installs.
    pub fn installing_note(&self) -> String {
        format!("Installing the {}…", self.name)
    }

    /// What a plxd without the sidecar's files says.
    pub fn no_sidecar(&self) -> String {
        format!("This plxd doesn't include the {} sidecar.", self.name)
    }

    /// Starts [`Self::install`] in the background unless the SDK is installed or installing. With
    /// `retry` false it doesn't start again after a failure, so a probe while offline doesn't run
    /// npm each time; Install retries.
    ///
    /// # Errors
    ///
    /// When this plxd has no sidecar to install.
    pub fn start_install(&'static self, launcher: &Launcher, retry: bool) -> Result<(), String> {
        if self.pinned().is_none() {
            return Err(self.no_sidecar());
        }
        let key = self.installs_dir(launcher);
        {
            let mut installs = INSTALLS.lock().unwrap_or_else(PoisonError::into_inner);
            let state = installs.entry(key.clone()).or_default();
            if state.installing
                || self.installed(launcher).is_some()
                || (!retry && state.failure.is_some())
            {
                return Ok(());
            }
            state.installing = true;
            state.failure = None;
        }
        let launcher = launcher.clone();
        tokio::spawn(async move {
            let failure = self.install(&launcher).await.err();
            let mut installs = INSTALLS.lock().unwrap_or_else(PoisonError::into_inner);
            *installs.entry(key).or_default() = InstallState {
                installing: false,
                failure,
            };
        });
        Ok(())
    }

    /// Whether an install is running, and why the last one failed.
    pub fn install_state(&self, launcher: &Launcher) -> (bool, Option<String>) {
        INSTALLS
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .get(&self.installs_dir(launcher))
            .map_or((false, None), |state| {
                (state.installing, state.failure.clone())
            })
    }

    /// Installs the version the sidecar pins into `<data>/tools/<dir>/<version>/` with `npm`,
    /// unless it's there, then removes every other version. Returns what went wrong, for people.
    /// [`Self::start_install`] runs it one at a time.
    pub async fn install(&self, launcher: &Launcher) -> Result<(), String> {
        let source = self.source_dir();
        let pin = self.pinned().ok_or_else(|| self.no_sidecar())?;
        let root = self.installs_dir(launcher);
        let target = root.join(&pin);
        let name = self.name;
        if !target.is_dir() {
            if detect::resolve(launcher, "node").is_none() {
                return Err(format!("{} to install the {name}", self.node_required));
            }
            if detect::resolve(launcher, "npm").is_none() {
                return Err(format!("npm is required to install the {name}"));
            }
            let failed = |error: std::io::Error| format!("Couldn't install the {name}: {error}");
            std::fs::create_dir_all(&root).map_err(failed)?;
            // Removed on drop, with whatever is still in it.
            let temp = tempfile::Builder::new()
                .prefix(".install-")
                .tempdir_in(&root)
                .map_err(failed)?;
            for file in ["package.json", "package-lock.json"] {
                std::fs::copy(source.join(file), temp.path().join(file)).map_err(failed)?;
            }
            let mut spec = ProcessSpec::new("npm", temp.path());
            spec.args = self.npm.iter().map(Into::into).collect();
            let ran = detect::run_spec(launcher, &spec, b"", Duration::from_secs(600))
                .await
                .map_err(|error| format!("Couldn't install the {name}: npm {error}"))?;
            if ran.exit_code != Some(0) {
                let why = ran
                    .stderr_tail
                    .trim()
                    .lines()
                    .last()
                    .unwrap_or("npm failed");
                return Err(format!("Couldn't install the {name}: {why}"));
            }
            std::fs::rename(temp.path(), &target).map_err(failed)?;
        }
        remove_others(&root, &pin);
        Ok(())
    }

    /// The installed SDK for the version the sidecar pins, if it's there.
    pub fn installed(&self, launcher: &Launcher) -> Option<PathBuf> {
        let dir = self.installs_dir(launcher).join(self.pinned()?);
        dir.is_dir().then_some(dir)
    }

    /// The folder its versions are installed in.
    pub fn installs_dir(&self, launcher: &Launcher) -> PathBuf {
        launcher.data_dir().tools_dir().join(self.dir)
    }

    /// The version the shipped `package.json` pins.
    fn pinned(&self) -> Option<String> {
        let bytes = std::fs::read(self.source_dir().join("package.json")).ok()?;
        let value: Value = serde_json::from_slice(&bytes).ok()?;
        let pin = value.pointer(self.pin)?.as_str()?;
        (!pin.is_empty()
            && pin
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || ".-".contains(c)))
        .then(|| pin.to_owned())
    }

    /// The installed sidecar's `main.mjs`, its `src/` brought up to date from the shipped files
    /// first, so an app update that keeps the SDK version still runs its own sidecar.
    ///
    /// # Errors
    ///
    /// If the files can't be copied.
    pub fn main_script(&self, installed: &Path) -> std::io::Result<PathBuf> {
        sync_sources(&self.source_dir(), installed)?;
        Ok(installed.join("src").join("main.mjs"))
    }
}

/// Removes everything in `root` but `keep`: older versions, and what a stopped install left.
/// ponytail: a version a running sidecar still holds open on Windows stays until the next install.
fn remove_others(root: &Path, keep: &str) {
    for entry in std::fs::read_dir(root).into_iter().flatten().flatten() {
        if entry.file_name() != keep {
            let _ = std::fs::remove_dir_all(entry.path());
        }
    }
}

/// Copies the shipped `src/` files into `dir`'s when they differ, each by a rename.
fn sync_sources(source: &Path, dir: &Path) -> std::io::Result<()> {
    let to = dir.join("src");
    std::fs::create_dir_all(&to)?;
    for entry in std::fs::read_dir(source.join("src"))? {
        let entry = entry?;
        let want = std::fs::read(entry.path())?;
        let path = to.join(entry.file_name());
        if std::fs::read(&path).ok().as_ref() != Some(&want) {
            let mut temp = tempfile::NamedTempFile::new_in(&to)?;
            std::io::Write::write_all(&mut temp, &want)?;
            temp.persist(&path)?;
        }
    }
    Ok(())
}
