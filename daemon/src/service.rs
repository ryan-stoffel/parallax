//! `wispd service`: installs, removes, and reports on the per-user service that keeps
//! `wispd serve` running: a `LaunchAgent` on macOS ([`launchd`], #61) and a systemd user unit on
//! Linux ([`systemd`], RYA-18), both named after [`DEFAULT_LABEL`] (0010, 0023).
//!
//! Each OS module renders its file with a pure function, covered by a golden-file test, and drives
//! its service manager. Both compile on every Unix, so their tests run everywhere; the running
//! OS's `install`, `uninstall`, and `status` are re-exported here. What they share lives here: the
//! label rule, the `initialize` probe, and preparing the data folder.

pub mod launchd;
pub mod systemd;

use std::io::{self, BufRead, BufReader, Write};
use std::os::unix::fs::DirBuilderExt;
use std::os::unix::net::UnixStream;
use std::path::{Path, PathBuf};
use std::process::{Command, Output};
use std::time::Duration;

use wisp_protocol::jsonrpc::{Message, Request};
use wisp_protocol::methods::Initialize;
use wisp_protocol::{Capabilities, ClientInfo, InitializeParams, ProtocolRange};

#[cfg(target_os = "macos")]
pub use launchd::{install, status, uninstall};
#[cfg(target_os = "linux")]
pub use systemd::{install, status, uninstall};

use crate::VERSION;
use crate::paths::DataDir;

/// wispd's service label: wisp's bundle id (`io.github.ryan-stoffel.wisp`, 0006) plus `.wispd`.
/// It is the `LaunchAgent`'s label on macOS, and the systemd unit's name, before `.service`, on
/// Linux.
pub const DEFAULT_LABEL: &str = "io.github.ryan-stoffel.wisp.wispd";

/// The environment variable that overrides the label when `--label` is not given. Only tests
/// should set it, so a test run never touches a real install.
pub const SERVICE_LABEL_ENV: &str = "WISPD_SERVICE_LABEL";

/// How long [`status`] and the conflict check in [`install`] wait for an `initialize` answer.
const PROBE_TIMEOUT: Duration = Duration::from_secs(2);

/// Why installing, removing, or checking on the service failed.
#[derive(Debug, thiserror::Error)]
#[non_exhaustive]
pub enum ServiceError {
    /// A `serve` is already answering this data folder's socket, and it is not the one the service
    /// manager runs under this label. Starting the service anyway would start a second `serve`
    /// that loses the race for `wispd.lock` (0009's exit code 3) and gets restarted into the same
    /// failure, fighting the first `serve` for the lock.
    #[error(
        "wispd is already serving {} outside its service; stop it, then run \
         `wispd service install` again",
        .data_dir.display()
    )]
    AlreadyRunningOutsideService {
        /// The data folder it is serving.
        data_dir: PathBuf,
    },
    /// The default label serves only the default data folder, because a plain `wispd attach`
    /// starts the service under that label for that folder (0010). Another folder needs its own
    /// label.
    #[error(
        "the {DEFAULT_LABEL} service serves only the default data folder, not {}; \
         give another data folder its own label with --label",
        .data_dir.display()
    )]
    NotTheDefaultDataDir {
        /// The data folder that was asked for.
        data_dir: PathBuf,
    },
    /// The home folder is unknown, so the service's file can't be placed.
    #[error("the home folder is unknown")]
    NoHomeDir,
    /// The running `wispd`'s own path could not be read.
    #[error("could not find the running wispd's path: {0}")]
    CurrentExe(io::Error),
    /// The data folder could not be prepared. See [`crate::server::prepare_data_dir`].
    #[error(transparent)]
    DataDir(#[from] crate::server::StartError),
    /// A path can't be written into a systemd unit, because it isn't UTF-8 or has a control
    /// character such as a line break.
    #[error("{} can't be written into a systemd unit", .path.display())]
    UnitPath {
        /// The path.
        path: PathBuf,
    },
    /// `launchctl` or `systemctl` exited with an error.
    #[error("`{command}` failed: {stderr}")]
    Failed {
        /// The command line that failed.
        command: String,
        /// Its stderr, trimmed.
        stderr: String,
    },
    /// A file operation failed.
    #[error("{context}: {source}")]
    Io {
        /// What wispd was doing.
        context: String,
        /// The error.
        #[source]
        source: io::Error,
    },
}

impl ServiceError {
    fn io(context: impl Into<String>, source: io::Error) -> Self {
        Self::Io {
            context: context.into(),
            source,
        }
    }
}

/// What changed when [`install`] ran.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum InstallOutcome {
    /// Nothing was loaded under this label before; it is now installed and started.
    Installed,
    /// This label was already loaded; its file was refreshed and it was restarted.
    Reinstalled,
}

/// Whether [`uninstall`] found anything to remove.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum UninstallOutcome {
    /// The service was loaded, stopped, and its file removed.
    Removed,
    /// Nothing was installed; uninstalling was a no-op.
    NotInstalled,
}

/// What the service manager reports about a label.
///
/// Loaded and running are kept as one enum rather than two bools, so a report can't be misread
/// as the impossible "running but not loaded".
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ServiceState {
    /// The manager does not have the label loaded.
    NotLoaded,
    /// The manager has it loaded, but it is not currently running.
    Loaded,
    /// The manager has it loaded and running, with its pid when it reported one.
    Running(Option<u32>),
}

impl ServiceState {
    /// The manager has the label loaded: launchd in the per-user GUI domain, or the systemd user
    /// manager.
    #[must_use]
    pub fn loaded(self) -> bool {
        !matches!(self, Self::NotLoaded)
    }

    /// The manager reports the service as currently running.
    #[must_use]
    pub fn running(self) -> bool {
        matches!(self, Self::Running(_))
    }

    /// The running instance's pid, when the manager reports one.
    #[must_use]
    pub fn pid(self) -> Option<u32> {
        match self {
            Self::Running(pid) => pid,
            Self::NotLoaded | Self::Loaded => None,
        }
    }
}

/// What `wispd service status` reports.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Status {
    /// The label checked.
    pub label: String,
    /// Where its plist or unit file would be.
    pub path: PathBuf,
    /// That file exists.
    pub installed: bool,
    /// What the service manager reports for `label`.
    pub state: ServiceState,
    /// The data folder's socket answered an `initialize` request just now.
    pub answers_initialize: bool,
}

impl Status {
    fn check(
        label: &str,
        path: PathBuf,
        state: ServiceState,
        data_dir: &DataDir,
    ) -> Result<Self, ServiceError> {
        let installed = path
            .try_exists()
            .map_err(|error| ServiceError::io(format!("checking {}", path.display()), error))?;
        Ok(Self {
            label: label.to_owned(),
            path,
            installed,
            state,
            answers_initialize: probe_initialize(data_dir),
        })
    }
}

/// The home folder, which must be absolute.
fn home_dir() -> Result<PathBuf, ServiceError> {
    std::env::home_dir()
        .filter(|home| home.is_absolute())
        .ok_or(ServiceError::NoHomeDir)
}

/// Refuses to put [`DEFAULT_LABEL`] on a data folder other than `default`, the default one.
/// `attach` starts the service with that label whenever it serves the default folder, so the
/// service must serve that folder too. Any other label may serve any folder.
fn check_label_serves(
    label: &str,
    data_dir: &DataDir,
    default: Option<&DataDir>,
) -> Result<(), ServiceError> {
    if label == DEFAULT_LABEL && default != Some(data_dir) {
        return Err(ServiceError::NotTheDefaultDataDir {
            data_dir: data_dir.root().to_owned(),
        });
    }
    Ok(())
}

/// What every install does before writing its file: refuses when something other than the
/// service already answers `data_dir` (`ours` says whether the service is what could be
/// answering), prepares the data folder and its `logs/`, and returns the running `wispd`'s path.
fn prepare_install(data_dir: &DataDir, ours: bool) -> Result<PathBuf, ServiceError> {
    if !ours && probe_initialize(data_dir) {
        return Err(ServiceError::AlreadyRunningOutsideService {
            data_dir: data_dir.root().to_owned(),
        });
    }
    crate::server::prepare_data_dir(data_dir.root())?;
    prepare_log_dir(data_dir)?;
    current_exe()
}

/// Connects to `data_dir`'s socket and sends `initialize`, to see whether something answers it
/// right now. `false` covers every way that can fail to happen: no socket, nothing listening, a
/// connection that doesn't answer in time, or an answer that isn't a well-formed response.
fn probe_initialize(data_dir: &DataDir) -> bool {
    let Ok(socket) = data_dir.socket_path() else {
        return false;
    };
    let Ok(mut stream) = UnixStream::connect(&socket.path) else {
        return false;
    };
    if stream.set_read_timeout(Some(PROBE_TIMEOUT)).is_err()
        || stream.set_write_timeout(Some(PROBE_TIMEOUT)).is_err()
    {
        return false;
    }
    let request = Request::new::<Initialize>(
        1,
        InitializeParams {
            protocol: ProtocolRange::SUPPORTED,
            client: ClientInfo {
                name: "wispd-service".to_owned(),
                version: VERSION.to_owned(),
                machine_id: None,
            },
            capabilities: Capabilities::default(),
        },
    );
    let Ok(mut line) = serde_json::to_string(&request) else {
        return false;
    };
    line.push('\n');
    if stream.write_all(line.as_bytes()).is_err() {
        return false;
    }
    let mut reader = BufReader::new(stream);
    let mut response_line = String::new();
    if reader.read_line(&mut response_line).is_err() {
        return false;
    }
    let frame = response_line.trim_end_matches(['\n', '\r']);
    matches!(
        Message::from_frame(frame.as_bytes()),
        Ok(Message::Response(_))
    )
}

/// Creates `logs/` under the data folder, if it is not there yet, so the service manager has
/// somewhere to send `serve`'s stdout and stderr before `serve` itself creates the folder.
fn prepare_log_dir(data_dir: &DataDir) -> Result<(), ServiceError> {
    let log_file = data_dir.log_file();
    let Some(dir) = log_file.parent() else {
        return Ok(());
    };
    std::fs::DirBuilder::new()
        .recursive(true)
        .mode(0o700)
        .create(dir)
        .map_err(|error| ServiceError::io(format!("creating {}", dir.display()), error))
}

/// The absolute path of the running `wispd` binary, as `std::env::current_exe` reports it.
///
/// This is not resolved through symlinks: a package manager that upgrades wispd by relinking a
/// stable path should keep the service pointing at that stable path. Re-running `install` after
/// moving the binary picks up its new location either way.
fn current_exe() -> Result<PathBuf, ServiceError> {
    std::env::current_exe().map_err(ServiceError::CurrentExe)
}

/// Writes the service's file, creating its folder first.
fn write_file(path: &Path, contents: &str) -> Result<(), ServiceError> {
    if let Some(dir) = path.parent() {
        std::fs::DirBuilder::new()
            .recursive(true)
            .create(dir)
            .map_err(|error| ServiceError::io(format!("creating {}", dir.display()), error))?;
    }
    std::fs::write(path, contents)
        .map_err(|error| ServiceError::io(format!("writing {}", path.display()), error))
}

/// Removes the service's file, and says whether there was one.
fn remove_file(path: &Path) -> Result<bool, ServiceError> {
    match std::fs::remove_file(path) {
        Ok(()) => Ok(true),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(false),
        Err(error) => Err(ServiceError::io(
            format!("removing {}", path.display()),
            error,
        )),
    }
}

fn run(program: &str, args: &[&str]) -> Result<Output, ServiceError> {
    Command::new(program)
        .args(args)
        .output()
        .map_err(|error| ServiceError::io(format!("running {program} {}", args.join(" ")), error))
}

/// Runs `program` and turns a non-zero exit into [`ServiceError::Failed`].
fn run_ok(program: &str, args: &[&str]) -> Result<Output, ServiceError> {
    let output = run(program, args)?;
    if output.status.success() {
        Ok(output)
    } else {
        Err(ServiceError::Failed {
            command: format!("{program} {}", args.join(" ")),
            stderr: String::from_utf8_lossy(&output.stderr).trim().to_owned(),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::{DEFAULT_LABEL, ServiceError, check_label_serves};
    use crate::paths::DataDir;

    #[test]
    fn the_default_label_serves_only_the_default_data_folder() {
        let default = DataDir::new("/Users/me/Library/Application Support/wisp").unwrap();
        let other = DataDir::new("/tmp/elsewhere").unwrap();

        check_label_serves(DEFAULT_LABEL, &default, Some(&default)).unwrap();
        let error = check_label_serves(DEFAULT_LABEL, &other, Some(&default)).unwrap_err();
        assert!(
            matches!(&error, ServiceError::NotTheDefaultDataDir { data_dir } if data_dir == other.root()),
            "{error:?}"
        );
        assert!(error.to_string().contains("--label"), "{error}");
        assert!(check_label_serves(DEFAULT_LABEL, &default, None).is_err());

        check_label_serves("io.example.test", &other, Some(&default)).unwrap();
    }
}
