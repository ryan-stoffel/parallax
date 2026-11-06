//! Starting the per-user service that `plxd service` installs (0010, 0023), as `attach` does
//! when it finds plxd not running: the `LaunchAgent` on macOS (#61), with `launchctl
//! kickstart`, the systemd user unit on Linux (PLX-18), with `systemctl --user start`, and the
//! logon task on Windows (PLX-576), with `schtasks /run`.
//!
//! The label and file paths are `crate::service`'s. The service under its `DEFAULT_LABEL` serves
//! the default data folder, which `plxd service install` enforces.

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
#[cfg(windows)]
use crate::service::{DEFAULT_LABEL, task_scheduler};

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
    /// The program to run: `/bin/launchctl` on macOS, `systemctl` on Linux, and `schtasks` on
    /// Windows, except in tests.
    pub program: PathBuf,
    /// Its arguments: `kickstart gui/<uid>/<label>` on macOS, `--user start <label>.service` on
    /// Linux, and `/run /tn <label>` on Windows.
    pub args: Vec<String>,
    /// The scheduled task the command starts, which [`LaunchAgent::start`] then waits to see
    /// running.
    #[cfg(windows)]
    pub task: String,
}

/// The command line, with the program's file name, such as
/// `launchctl kickstart gui/501/io.github.ryan-stoffel.parallax.plxd`.
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
    /// The service serves the default data folder, so a `--data-dir` or `PLXD_DATA_DIR` that
    /// names another folder never starts it. It counts as installed when its plist, unit file, or
    /// task XML exists.
    #[cfg(any(target_os = "macos", target_os = "linux", windows))]
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
        #[cfg(windows)]
        let (file, agent) = (
            task_scheduler::task_file(DEFAULT_LABEL).ok()?,
            Self {
                program: PathBuf::from(task_scheduler::SCHTASKS),
                args: vec![
                    "/run".to_owned(),
                    "/tn".to_owned(),
                    DEFAULT_LABEL.to_owned(),
                ],
                task: DEFAULT_LABEL.to_owned(),
            },
        );
        file.is_file().then_some(agent)
    }

    /// Never one: this OS has no service.
    #[cfg(not(any(target_os = "macos", target_os = "linux", windows)))]
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
    /// killed. The error includes what it printed on stderr. On Windows, also if the task isn't
    /// running soon after, since `schtasks /run` succeeds for a task Task Scheduler then doesn't
    /// start, as while the user isn't logged on (0023).
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
            #[cfg(windows)]
            if !task_scheduler::started(&self.task, deadline) {
                return Err(io::Error::other(format!(
                    "`{self}` ran, but Task Scheduler didn't start the task, which it doesn't \
                     while you aren't logged on to Windows"
                )));
            }
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

    use super::LaunchAgent;
    use crate::paths::DataDir;

    #[test]
    fn another_data_folder_never_uses_the_launch_agent() {
        let dir = DataDir::new("/tmp/plxd-not-the-default").unwrap();
        assert_eq!(LaunchAgent::installed_for(&dir), None);
    }
}
