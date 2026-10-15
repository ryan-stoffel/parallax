//! A Node SDK that one of plxd's sidecars runs, installed on first use: the Cursor SDK (0053) and
//! the Claude Agent SDK (0061). plxd embeds the sidecar's own files, so a plxd copied anywhere
//! has them. [`NodeSdk::install`] puts the pinned package in `<data>/tools/<dir>/<version>/` with
//! `npm ci`, and the sidecar runs from there, because the SDK finds its files by walking up from
//! the sidecar's `main.mjs`.

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
    /// Its folder under plxd's tools folder.
    pub dir: &'static str,
    /// The sidecar's `package.json`, which pins the SDK.
    pub manifest: &'static [u8],
    /// The sidecar's `package-lock.json`, for `npm ci`.
    pub lockfile: &'static [u8],
    /// The sidecar's `src/*.mjs` but the tests, by file name.
    pub src: &'static [(&'static str, &'static [u8])],
    /// The pinned package, as a JSON pointer into [`Self::manifest`].
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
    /// What Settings says while it installs.
    pub fn installing_note(&self) -> String {
        format!("Installing the {}…", self.name)
    }

    /// Starts [`Self::install`] in the background unless the SDK is installed or installing. With
    /// `retry` false it doesn't start again after a failure, so a probe while offline doesn't run
    /// npm each time; Install retries.
    pub fn start_install(&'static self, launcher: &Launcher, retry: bool) {
        let key = self.installs_dir(launcher);
        {
            let mut installs = INSTALLS.lock().unwrap_or_else(PoisonError::into_inner);
            let state = installs.entry(key.clone()).or_default();
            if state.installing
                || self.installed(launcher).is_some()
                || (!retry && state.failure.is_some())
            {
                return;
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
        let pin = self.pinned();
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
            std::fs::write(temp.path().join("package.json"), self.manifest).map_err(failed)?;
            std::fs::write(temp.path().join("package-lock.json"), self.lockfile).map_err(failed)?;
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
        let dir = self.installs_dir(launcher).join(self.pinned());
        dir.is_dir().then_some(dir)
    }

    /// The folder its versions are installed in.
    pub fn installs_dir(&self, launcher: &Launcher) -> PathBuf {
        launcher.data_dir().tools_dir().join(self.dir)
    }

    /// The version [`Self::manifest`] pins, which the tests below check each sidecar has.
    fn pinned(&self) -> String {
        let manifest: Value =
            serde_json::from_slice(self.manifest).expect("the sidecar's package.json is JSON");
        let pin = manifest
            .pointer(self.pin)
            .and_then(Value::as_str)
            .expect("the sidecar's package.json pins the SDK");
        assert!(
            !pin.is_empty()
                && pin
                    .chars()
                    .all(|c| c.is_ascii_alphanumeric() || ".-".contains(c)),
            "the sidecar's package.json pins an exact version"
        );
        pin.to_owned()
    }

    /// The installed sidecar's `main.mjs`, its `src/` brought up to date from [`Self::src`]
    /// first, each changed file by a rename, so a plxd update that keeps the SDK version still
    /// runs its own sidecar.
    ///
    /// # Errors
    ///
    /// If the files can't be written.
    pub fn main_script(&self, installed: &Path) -> std::io::Result<PathBuf> {
        let to = installed.join("src");
        std::fs::create_dir_all(&to)?;
        for (name, want) in self.src {
            let path = to.join(name);
            if std::fs::read(&path).ok().as_deref() != Some(*want) {
                let mut temp = tempfile::NamedTempFile::new_in(&to)?;
                std::io::Write::write_all(&mut temp, want)?;
                temp.persist(&path)?;
            }
        }
        Ok(to.join("main.mjs"))
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

#[cfg(test)]
mod tests {
    use std::fs;
    use std::path::Path;

    /// Each SDK embeds exactly its sidecar's `package.json`, `package-lock.json`, and `src/*.mjs`
    /// but the tests, so a module added to `src` without being embedded fails here. Each pins a
    /// version, and an installed `src` that's out of date is brought up to date.
    #[test]
    fn each_sidecar_embeds_exactly_its_files() {
        for (sdk, repo) in [
            (&crate::backend::claude::sdk::SDK, "claude"),
            (&crate::backend::cursor_sdk::SDK, "cursor"),
        ] {
            let dir = Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("../sidecar")
                .join(repo);
            let read = |path: &str| fs::read_to_string(dir.join(path)).unwrap();
            let text = |bytes: &[u8]| String::from_utf8(bytes.to_vec()).unwrap();
            assert_eq!(text(sdk.manifest), read("package.json"), "{repo}");
            assert_eq!(text(sdk.lockfile), read("package-lock.json"), "{repo}");
            let mut on_disk: Vec<String> = fs::read_dir(dir.join("src"))
                .unwrap()
                .map(|entry| entry.unwrap().file_name().into_string().unwrap())
                .filter(|name| {
                    Path::new(name).extension().is_some_and(|ext| ext == "mjs")
                        && !name.ends_with(".test.mjs")
                })
                .collect();
            on_disk.sort();
            let mut embedded: Vec<&str> = sdk.src.iter().map(|(name, _)| *name).collect();
            embedded.sort_unstable();
            assert_eq!(embedded, on_disk, "{repo}'s embedded src/*.mjs");
            for (name, bytes) in sdk.src {
                assert_eq!(text(bytes), read(&format!("src/{name}")), "{repo}");
            }
            assert!(!sdk.pinned().is_empty());

            let installed = tempfile::tempdir().unwrap();
            fs::create_dir_all(installed.path().join("src")).unwrap();
            fs::write(installed.path().join("src/main.mjs"), "an older sidecar").unwrap();
            let main = sdk.main_script(installed.path()).unwrap();
            assert_eq!(fs::read_to_string(main).unwrap(), read("src/main.mjs"));
        }
    }
}
