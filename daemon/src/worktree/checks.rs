//! Running a Project's checks command (PLX-411, decision 0045), which the landing queue
//! ([`crate::methods::land`]) does in the integration worktree after each merge.
//!
//! The command runs through `sh -c` (`cmd /C` on Windows) from the manager's launcher, so it gets
//! the agent environment: the login shell's `PATH` and an allowlist of variables, never a token
//! plxd started with, since its output goes to a child. It leads its own process group (a job on
//! Windows), which is killed whole when it exits and when it runs out of time, so nothing it
//! started is left running. Its output is kept here and never logged.

use std::path::Path;
use std::time::Duration;

use tokio::time::timeout;

use super::{WorktreeError, WorktreeManager};
use crate::backend::process::{Output, ProcessSpec};

/// How long a Project's checks may run (0045).
pub const CHECKS_TIMEOUT: Duration = Duration::from_mins(30);

/// How much of the end of the checks' output is kept: what a child gets back (0045).
pub const CHECKS_OUTPUT_BYTES: usize = 64 * 1024;

/// How a Project's checks ended.
#[derive(Debug, PartialEq, Eq)]
pub enum Checked {
    /// They exited 0.
    Passed,
    /// They failed or ran out of time.
    Failed {
        /// Why, as `exited 1`, for people.
        why: String,
        /// The end of their stdout and stderr together, at most [`CHECKS_OUTPUT_BYTES`].
        output: String,
    },
}

impl WorktreeManager {
    /// Runs `command` in `cwd`, stopping it and everything it started after `limit`.
    ///
    /// # Errors
    ///
    /// [`WorktreeError::Spawn`] when the shell can't start.
    pub async fn run_checks(
        &self,
        cwd: &Path,
        command: &str,
        limit: Duration,
    ) -> Result<Checked, WorktreeError> {
        let mut spec = if cfg!(windows) {
            // ponytail: std quotes the command as one argument, which `cmd /C` takes as is unless
            // it holds a `"`; spawn with a raw command line if Windows users need quotes.
            ProcessSpec::new("cmd", cwd)
        } else {
            ProcessSpec::new("sh", cwd)
        };
        spec.args = vec![
            if cfg!(windows) { "/C" } else { "-c" }.into(),
            command.into(),
        ];
        spec.stderr_lines = true;
        spec.limits.max_line_bytes = CHECKS_OUTPUT_BYTES;
        let mut process = self.launcher.spawn(&spec)?;
        let mut output = Vec::new();
        let ran = timeout(limit, async {
            loop {
                match process.next().await {
                    Some(Output::Line(line)) => {
                        output.extend_from_slice(&line);
                        output.push(b'\n');
                    }
                    Some(Output::Oversized { bytes }) => {
                        output.extend_from_slice(format!("[a {bytes}-byte line]\n").as_bytes());
                    }
                    Some(Output::Exited(exit)) => return Some(exit.info),
                    None => return None,
                }
                if output.len() > 2 * CHECKS_OUTPUT_BYTES {
                    output.drain(..output.len() - CHECKS_OUTPUT_BYTES);
                }
            }
        })
        .await;
        // Dropping it kills its process group, or its job, if anything there still runs.
        drop(process);
        let why = match ran {
            Ok(Some(info)) if info.success() => return Ok(Checked::Passed),
            Ok(Some(info)) => match (info.code, info.signal) {
                (Some(code), _) => format!("exited {code}"),
                (None, Some(signal)) => format!("were killed by signal {signal}"),
                (None, None) => "ended without an exit code".to_owned(),
            },
            Ok(None) => "ended without an exit code".to_owned(),
            Err(_) => format!(
                "ran longer than {}, so plxd stopped them",
                minutes_or_seconds(limit)
            ),
        };
        let cut = output.len().saturating_sub(CHECKS_OUTPUT_BYTES);
        Ok(Checked::Failed {
            why,
            output: String::from_utf8_lossy(&output[cut..]).into_owned(),
        })
    }
}

impl WorktreeManager {
    /// Puts `project`'s integration branch and worktree back on `tip`, as red checks do.
    ///
    /// # Errors
    ///
    /// A git failure.
    pub async fn reset_integration(
        &self,
        project: parallax_protocol::ProjectId,
        tip: &str,
    ) -> Result<(), WorktreeError> {
        let path = self.integration_path(project);
        self.run_git_ok(&path, &["reset", "--hard", "--quiet", tip])
            .await?;
        self.run_git_ok(&path, &["clean", "-fd", "--quiet"]).await?;
        Ok(())
    }
}

/// `limit` as people say it: whole minutes, or seconds.
fn minutes_or_seconds(limit: Duration) -> String {
    let seconds = limit.as_secs();
    if seconds >= 60 && seconds.is_multiple_of(60) {
        format!("{} minutes", seconds / 60)
    } else {
        format!("{seconds} seconds")
    }
}

#[cfg(test)]
mod tests {
    use std::time::Duration;

    use super::{CHECKS_OUTPUT_BYTES, Checked};
    use crate::backend::process::Launcher;
    use crate::paths::DataDir;
    use crate::worktree::WorktreeManager;

    fn manager(root: &std::path::Path) -> WorktreeManager {
        let data = DataDir::new(root.join("data")).unwrap();
        let launcher = Launcher::new(data.clone(), crate::agents::worker::agent_environment());
        WorktreeManager::new(launcher, data.root())
    }

    #[tokio::test]
    async fn checks_pass_on_exit_zero_and_fail_with_the_end_of_their_output() {
        let dir = tempfile::tempdir().unwrap();
        let manager = manager(dir.path());
        let limit = Duration::from_mins(1);
        let passed = manager.run_checks(dir.path(), "echo fine", limit).await;
        assert_eq!(passed.unwrap(), Checked::Passed);

        let failed = manager
            .run_checks(dir.path(), "echo broke&& echo oops 1>&2&& exit 3", limit)
            .await
            .unwrap();
        let Checked::Failed { why, output } = failed else {
            panic!("passed");
        };
        assert_eq!(why, "exited 3");
        assert!(
            output.contains("broke") && output.contains("oops"),
            "{output}"
        );
    }

    /// Only the last 64 KiB of a long output is kept.
    #[cfg(unix)]
    #[tokio::test]
    async fn only_the_end_of_a_long_output_is_kept() {
        let dir = tempfile::tempdir().unwrap();
        let command = "i=0; while [ $i -lt 20000 ]; do echo line $i; i=$((i+1)); done; exit 1";
        let failed = manager(dir.path())
            .run_checks(dir.path(), command, Duration::from_mins(1))
            .await
            .unwrap();
        let Checked::Failed { output, .. } = failed else {
            panic!("passed");
        };
        assert_eq!(output.len(), CHECKS_OUTPUT_BYTES);
        assert!(
            output.ends_with("line 19999\n"),
            "{}",
            &output[output.len() - 40..]
        );
        assert!(!output.contains("line 100\n"));
    }

    /// Checks that run out of time fail, and nothing they started is left running.
    #[cfg(unix)]
    #[tokio::test]
    async fn checks_that_run_too_long_are_stopped_with_everything_they_started() {
        let dir = tempfile::tempdir().unwrap();
        let pid_file = dir.path().join("pid");
        let command = format!(
            "sleep 60 & echo $! > '{}'; echo started; wait",
            pid_file.display()
        );
        let failed = manager(dir.path())
            .run_checks(dir.path(), &command, Duration::from_secs(2))
            .await
            .unwrap();
        assert_eq!(
            failed,
            Checked::Failed {
                why: "ran longer than 2 seconds, so plxd stopped them".to_owned(),
                output: "started\n".to_owned(),
            }
        );
        let pid: i32 = std::fs::read_to_string(&pid_file)
            .unwrap()
            .trim()
            .parse()
            .unwrap();
        let deadline = std::time::Instant::now() + Duration::from_secs(10);
        // Signal 0 checks that the process exists; a zombie its shell left is reaped by init.
        while std::process::Command::new("kill")
            .args(["-0", &pid.to_string()])
            .stderr(std::process::Stdio::null())
            .status()
            .unwrap()
            .success()
        {
            assert!(
                std::time::Instant::now() < deadline,
                "the grandchild still runs"
            );
            std::thread::sleep(Duration::from_millis(50));
        }
    }
}
