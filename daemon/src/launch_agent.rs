//! Starting the per-user service that `wispd service` installs (0010, 0023), as `attach` does
//! when it finds wispd not running: the `LaunchAgent` on macOS (#61), with `launchctl
//! kickstart`, and the systemd user unit on Linux (RYA-18), with `systemctl --user start`.
//!
//! The label and file paths are `crate::service`'s. The service under its `DEFAULT_LABEL` serves
//! the default data folder, which `wispd service install` enforces. Windows has no service yet
//! (RYA-22), so there `attach` always starts `serve` itself.

use std::fmt;
use std::io::{self, Read as _};
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::thread;
use std::time::{Duration, Instant};

use crate::paths::DataDir;
#[cfg(target_os = "macos")]
use crate::service::{DEFAULT_LABEL, launchd};
#[cfg(target_os = "linux")]
use crate::service::{DEFAULT_LABEL, systemd};

const POLL: Duration = Duration::from_millis(10);

/// The service target of the agent under `DEFAULT_LABEL` for the user `uid`:
/// `gui/<uid>/<label>`. launchd loads it into the user's GUI domain, where the Keychain is
/// reachable (0004).
#[cfg(target_os = "macos")]
#[must_use]
pub fn service_target(uid: u32) -> String {
    format!("gui/{uid}/{DEFAULT_LABEL}")
}

/// The command that starts an installed service, which `attach` runs.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct LaunchAgent {
    /// The program to run: `/bin/launchctl` on macOS and `systemctl` on Linux, except in tests.
    pub program: PathBuf,
    /// Its arguments: `kickstart gui/<uid>/<label>` on macOS, and `--user start <label>.service`
    /// on Linux.
    pub args: Vec<String>,
}

/// The command line, with the program's file name, such as
/// `launchctl kickstart gui/501/io.github.ryan-stoffel.wisp.wispd`.
impl fmt::Display for LaunchAgent {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let program = self.program.file_name().unwrap_or(self.program.as_os_str());
        write!(f, "{}", program.display())?;
        self.args.iter().try_for_each(|arg| write!(f, " {arg}"))
    }
}

impl LaunchAgent {
    /// This user's service, if it is installed and serves `data_dir`.
    ///
    /// The service serves the default data folder, so a `--data-dir` or `WISPD_DATA_DIR` that
    /// names another folder never starts it. It counts as installed when its plist or unit file
    /// exists.
    #[cfg(any(target_os = "macos", target_os = "linux"))]
    #[must_use]
    pub fn installed_for(data_dir: &DataDir) -> Option<Self> {
        if DataDir::default_location().ok()? != *data_dir {
            return None;
        }
        #[cfg(target_os = "macos")]
        let (file, agent) = (
            launchd::plist_path(DEFAULT_LABEL).ok()?,
            Self {
                program: PathBuf::from(launchd::LAUNCHCTL),
                args: vec![
                    "kickstart".to_owned(),
                    service_target(rustix::process::getuid().as_raw()),
                ],
            },
        );
        #[cfg(target_os = "linux")]
        let (file, agent) = (
            systemd::unit_path(DEFAULT_LABEL).ok()?,
            Self {
                program: PathBuf::from(systemd::SYSTEMCTL),
                args: vec![
                    "--user".to_owned(),
                    "start".to_owned(),
                    systemd::unit_name(DEFAULT_LABEL),
                ],
            },
        );
        file.is_file().then_some(agent)
    }

    /// Never one: Windows has no service yet.
    #[cfg(not(any(target_os = "macos", target_os = "linux")))]
    #[must_use]
    pub fn installed_for(_data_dir: &DataDir) -> Option<Self> {
        None
    }

    /// Starts the service unless it is running, waiting for the command until `deadline` at the
    /// latest.
    ///
    /// # Errors
    ///
    /// If the command can't run, fails, or is still running at `deadline`, in which case it is
    /// killed. The error includes what it printed on stderr.
    pub fn start(&self, deadline: Instant) -> io::Result<()> {
        let mut child = Command::new(&self.program)
            .args(&self.args)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::piped())
            .spawn()?;
        let status = loop {
            if let Some(status) = child.try_wait()? {
                break status;
            }
            let now = Instant::now();
            if now >= deadline {
                let _ = child.kill();
                let _ = child.wait();
                return Err(io::Error::new(
                    io::ErrorKind::TimedOut,
                    format!("`{self}` did not finish in time"),
                ));
            }
            thread::sleep(POLL.min(deadline - now));
        };
        if status.success() {
            return Ok(());
        }
        // launchctl and systemctl print a line or two, well under a pipe's buffer, so they never
        // blocked on writing it.
        let mut printed = String::new();
        if let Some(mut stderr) = child.stderr.take() {
            let _ = stderr.read_to_string(&mut printed);
        }
        Err(io::Error::other(format!(
            "`{self}` failed ({status}): {}",
            printed.trim()
        )))
    }
}

#[cfg(all(test, unix))]
mod tests {
    use std::fs;
    use std::os::unix::fs::PermissionsExt;
    use std::path::{Path, PathBuf};
    use std::time::{Duration, Instant};

    use super::LaunchAgent;
    use crate::paths::DataDir;

    #[cfg(target_os = "macos")]
    #[test]
    fn the_service_target_is_the_default_label_in_the_gui_domain() {
        assert_eq!(
            super::service_target(501),
            "gui/501/io.github.ryan-stoffel.wisp.wispd"
        );
    }

    #[test]
    fn another_data_folder_never_uses_the_launch_agent() {
        let dir = DataDir::new("/tmp/wispd-not-the-default").unwrap();
        assert_eq!(LaunchAgent::installed_for(&dir), None);
    }

    fn fake_launchctl(dir: &Path, script: &str) -> PathBuf {
        let path = dir.join("launchctl");
        fs::write(&path, format!("#!/bin/sh\n{script}\n")).unwrap();
        fs::set_permissions(&path, fs::Permissions::from_mode(0o755)).unwrap();
        path
    }

    fn agent(launchctl: PathBuf) -> LaunchAgent {
        LaunchAgent {
            program: launchctl,
            args: vec!["kickstart".to_owned(), "gui/501/test".to_owned()],
        }
    }

    fn soon() -> Instant {
        Instant::now() + Duration::from_secs(10)
    }

    #[test]
    fn start_runs_the_command_and_reports_its_failure() {
        let dir = tempfile::tempdir().unwrap();
        let args = dir.path().join("args");
        let ok = agent(fake_launchctl(
            dir.path(),
            &format!("echo \"$@\" > '{}'", args.display()),
        ));
        ok.start(soon()).unwrap();
        assert_eq!(
            fs::read_to_string(&args).unwrap(),
            "kickstart gui/501/test\n"
        );

        let failing = agent(fake_launchctl(
            dir.path(),
            "echo 'Could not find service' >&2; exit 113",
        ));
        let error = failing.start(soon()).unwrap_err().to_string();
        assert!(
            error.contains("`launchctl kickstart gui/501/test` failed"),
            "{error}"
        );
        assert!(error.contains("Could not find service"), "{error}");
        assert!(error.contains("113"), "{error}");
    }

    #[test]
    fn a_start_that_hangs_is_given_up_at_the_deadline() {
        let dir = tempfile::tempdir().unwrap();
        let hanging = agent(fake_launchctl(dir.path(), "exec sleep 30"));
        let started = Instant::now();
        let error = hanging
            .start(started + Duration::from_millis(200))
            .unwrap_err();
        assert_eq!(error.kind(), std::io::ErrorKind::TimedOut);
        assert!(
            started.elapsed() < Duration::from_secs(5),
            "{:?}",
            started.elapsed()
        );
    }
}
