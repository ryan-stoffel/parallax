//! Starting the launch agent that [`crate::service`] installs (#61), as `attach` does when it
//! finds wispd not running (0010), and restarting it when it runs an older wispd (0020).
//!
//! The label and plist path are [`service`]'s. The agent under [`DEFAULT_LABEL`] serves the
//! default data folder, which `wispd service install` enforces.

use std::io::{self, Read as _};
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::thread;
use std::time::{Duration, Instant};

use crate::paths::DataDir;
use crate::service::{self, DEFAULT_LABEL, LAUNCHCTL};

const POLL: Duration = Duration::from_millis(10);

/// The service target of the agent under [`DEFAULT_LABEL`] for the user `uid`:
/// `gui/<uid>/<label>`. launchd loads it into the user's GUI domain, where the Keychain is
/// reachable (0004).
#[must_use]
pub fn service_target(uid: u32) -> String {
    format!("gui/{uid}/{DEFAULT_LABEL}")
}

/// A launch agent that `attach` can start.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct LaunchAgent {
    /// The `launchctl` to run: `/bin/launchctl`, except in tests.
    pub launchctl: PathBuf,
    /// The service target to start.
    pub service: String,
}

impl LaunchAgent {
    /// This user's launch agent, if it is installed and serves `data_dir`.
    ///
    /// The agent serves the default data folder, so a `--data-dir` or `WISPD_DATA_DIR` that
    /// names another folder never starts it. It counts as installed when its plist exists.
    #[must_use]
    pub fn installed_for(data_dir: &DataDir) -> Option<Self> {
        if DataDir::default_location().ok()? != *data_dir {
            return None;
        }
        service::plist_path(DEFAULT_LABEL)
            .ok()?
            .is_file()
            .then(|| Self {
                launchctl: PathBuf::from(LAUNCHCTL),
                service: service_target(rustix::process::getuid().as_raw()),
            })
    }

    /// Starts the service unless it is running, with `launchctl kickstart`, waiting for
    /// `launchctl` until `deadline` at the latest.
    ///
    /// # Errors
    ///
    /// If `launchctl` can't run, fails, or is still running at `deadline`, in which case it is
    /// killed. The error includes what it printed on stderr.
    pub fn kickstart(&self, deadline: Instant) -> io::Result<()> {
        self.run_kickstart(&["kickstart"], deadline)
    }

    /// Stops the service if it is running and starts it again from its plist, with `launchctl
    /// kickstart -k`, waiting for `launchctl` until `deadline` at the latest.
    ///
    /// # Errors
    ///
    /// As [`Self::kickstart`].
    pub fn restart(&self, deadline: Instant) -> io::Result<()> {
        self.run_kickstart(&["kickstart", "-k"], deadline)
    }

    /// The pid of the service's running process, as `launchctl print` reports it, or `None` when
    /// it isn't running or `launchctl` can't tell.
    #[must_use]
    pub fn pid(&self) -> Option<u32> {
        let output = Command::new(&self.launchctl)
            .arg("print")
            .arg(&self.service)
            .stdin(Stdio::null())
            .stderr(Stdio::null())
            .output()
            .ok()?;
        if !output.status.success() {
            return None;
        }
        match service::parse_print_output(&String::from_utf8_lossy(&output.stdout)) {
            (true, pid) => pid,
            (false, _) => None,
        }
    }

    fn run_kickstart(&self, args: &[&str], deadline: Instant) -> io::Result<()> {
        let command = format!("launchctl {} {}", args.join(" "), self.service);
        let mut child = Command::new(&self.launchctl)
            .args(args)
            .arg(&self.service)
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
                    format!("`{command}` did not finish in time"),
                ));
            }
            thread::sleep(POLL.min(deadline - now));
        };
        if status.success() {
            return Ok(());
        }
        // launchctl prints a line or two, well under a pipe's buffer, so it never blocked on
        // writing it.
        let mut printed = String::new();
        if let Some(mut stderr) = child.stderr.take() {
            let _ = stderr.read_to_string(&mut printed);
        }
        Err(io::Error::other(format!(
            "`{command}` failed ({status}): {}",
            printed.trim()
        )))
    }
}

#[cfg(test)]
mod tests {
    use std::fs;
    use std::os::unix::fs::PermissionsExt;
    use std::path::{Path, PathBuf};
    use std::time::{Duration, Instant};

    use super::{LaunchAgent, service_target};
    use crate::paths::DataDir;

    #[test]
    fn the_service_target_is_the_default_label_in_the_gui_domain() {
        assert_eq!(
            service_target(501),
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
            launchctl,
            service: "gui/501/test".to_owned(),
        }
    }

    fn soon() -> Instant {
        Instant::now() + Duration::from_secs(10)
    }

    #[test]
    fn kickstart_runs_launchctl_and_reports_its_failure() {
        let dir = tempfile::tempdir().unwrap();
        let args = dir.path().join("args");
        let ok = agent(fake_launchctl(
            dir.path(),
            &format!("echo \"$@\" > '{}'", args.display()),
        ));
        ok.kickstart(soon()).unwrap();
        assert_eq!(
            fs::read_to_string(&args).unwrap(),
            "kickstart gui/501/test\n"
        );

        let failing = agent(fake_launchctl(
            dir.path(),
            "echo 'Could not find service' >&2; exit 113",
        ));
        let error = failing.kickstart(soon()).unwrap_err().to_string();
        assert!(error.contains("Could not find service"), "{error}");
        assert!(error.contains("113"), "{error}");
    }

    #[test]
    fn restart_kills_and_starts_again_and_pid_reads_launchctl_print() {
        let dir = tempfile::tempdir().unwrap();
        let args = dir.path().join("args");
        let running = agent(fake_launchctl(
            dir.path(),
            &format!(
                "echo \"$@\" >> '{}'\nprintf 'gui/501/test = {{\\n\\tstate = running\\n\\tpid = 4242\\n}}\\n'",
                args.display()
            ),
        ));
        running.restart(soon()).unwrap();
        assert_eq!(running.pid(), Some(4242));
        assert_eq!(
            fs::read_to_string(&args).unwrap(),
            "kickstart -k gui/501/test\nprint gui/501/test\n"
        );

        let stopped = agent(fake_launchctl(
            dir.path(),
            "printf 'gui/501/test = {\\n\\tstate = not running\\n}\\n'",
        ));
        assert_eq!(stopped.pid(), None);
        let unknown = agent(fake_launchctl(dir.path(), "exit 113"));
        assert_eq!(unknown.pid(), None);
    }

    #[test]
    fn a_kickstart_that_hangs_is_given_up_at_the_deadline() {
        let dir = tempfile::tempdir().unwrap();
        let hanging = agent(fake_launchctl(dir.path(), "exec sleep 30"));
        let started = Instant::now();
        let error = hanging
            .kickstart(started + Duration::from_millis(200))
            .unwrap_err();
        assert_eq!(error.kind(), std::io::ErrorKind::TimedOut);
        assert!(
            started.elapsed() < Duration::from_secs(5),
            "{:?}",
            started.elapsed()
        );
    }
}
