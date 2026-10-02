//! The per-user `LaunchAgent` that keeps `serve` running on macOS (#61, 0010).
//!
//! [`render_plist`] is pure, so it is covered by a golden-file test. [`install`], [`uninstall`],
//! and [`status`] shell out to `launchctl`'s `bootstrap`, `bootout`, and `print`, per Apple's
//! guidance to prefer them over the deprecated `load` and `unload`.

use std::path::{Path, PathBuf};

use super::{
    InstallOutcome, ServiceError, ServiceState, Status, UninstallOutcome, check_label_serves,
    home_dir, prepare_install, remove_file, run, run_ok, write_file,
};
use crate::paths::{DATA_DIR_ENV, DataDir};

pub(crate) const LAUNCHCTL: &str = "/bin/launchctl";

/// Where the `LaunchAgent`'s plist goes: `~/Library/LaunchAgents/<label>.plist`.
///
/// # Errors
///
/// [`ServiceError::NoHomeDir`] if the home folder is unknown.
pub fn plist_path(label: &str) -> Result<PathBuf, ServiceError> {
    Ok(home_dir()?
        .join("Library")
        .join("LaunchAgents")
        .join(format!("{label}.plist")))
}

/// Renders the `LaunchAgent` property list for `label`, running `program serve` with
/// [`DATA_DIR_ENV`] set to `data_dir`'s folder. Both stdout and stderr go to `data_dir`'s
/// `logs/plxd.log` (0009), which `serve` also logs to, so a panic before its own logger starts
/// still lands there instead of being lost.
///
/// `KeepAlive.SuccessfulExit` is `false`: launchd restarts `serve` after it exits with a
/// non-zero status (a crash, or losing the startup race for `plxd.lock`), but not after the
/// exit status of 0 that a clean SIGTERM or SIGINT shutdown produces (`daemon/src/main.rs`), so
/// a deliberate stop stays stopped.
#[must_use]
pub fn render_plist(label: &str, program: &Path, data_dir: &DataDir) -> String {
    let label = escape_plist_text(label);
    let program = escape_plist_text(&program.display().to_string());
    let data_dir_value = escape_plist_text(&data_dir.root().display().to_string());
    let log = escape_plist_text(&data_dir.log_file().display().to_string());
    format!(
        "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n\
         <!DOCTYPE plist PUBLIC \"-//Apple//DTD PLIST 1.0//EN\" \"http://www.apple.com/DTDs/PropertyList-1.0.dtd\">\n\
         <plist version=\"1.0\">\n\
         <dict>\n\
         \t<key>Label</key>\n\
         \t<string>{label}</string>\n\
         \t<key>ProgramArguments</key>\n\
         \t<array>\n\
         \t\t<string>{program}</string>\n\
         \t\t<string>serve</string>\n\
         \t</array>\n\
         \t<key>EnvironmentVariables</key>\n\
         \t<dict>\n\
         \t\t<key>{DATA_DIR_ENV}</key>\n\
         \t\t<string>{data_dir_value}</string>\n\
         \t</dict>\n\
         \t<key>RunAtLoad</key>\n\
         \t<true/>\n\
         \t<key>KeepAlive</key>\n\
         \t<dict>\n\
         \t\t<key>SuccessfulExit</key>\n\
         \t\t<false/>\n\
         \t</dict>\n\
         \t<key>StandardOutPath</key>\n\
         \t<string>{log}</string>\n\
         \t<key>StandardErrorPath</key>\n\
         \t<string>{log}</string>\n\
         </dict>\n\
         </plist>\n"
    )
}

// Only text content is ever generated (never an attribute), so quotes need no escaping.
fn escape_plist_text(text: &str) -> String {
    text.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
}

/// Installs or updates the per-user `LaunchAgent` for `label`, running the current `plxd`
/// binary's `serve` against `data_dir`.
///
/// Idempotent: run again, for example after plxd moves, to update the plist and restart the
/// service with the new one (`bootout` then `bootstrap`, since launchd does not reread a
/// bootstrapped job's plist on its own).
///
/// # Errors
///
/// [`ServiceError::AlreadyRunningOutsideService`] when nothing is loaded under `label` yet, but
/// something is already answering `data_dir`'s socket: bootstrapping would only start a second
/// `serve` that fights the first one for the lock. Stop that `serve` first. Other variants for a
/// filesystem or `launchctl` failure.
pub fn install(label: &str, data_dir: &DataDir) -> Result<InstallOutcome, ServiceError> {
    check_label_serves(label, data_dir, DataDir::default_location().ok().as_ref())?;
    let uid = rustix::process::getuid().as_raw();
    let already_loaded = load_state(uid, label)?.loaded();
    let program = prepare_install(data_dir, already_loaded)?;
    let plist = render_plist(label, &program, data_dir);
    let path = plist_path(label)?;
    write_file(&path, &plist)?;

    let uid_target = format!("gui/{uid}");
    if already_loaded {
        // --wait: block until the old `serve` is fully gone, so the bootstrap below can never
        // race it for `plxd.lock`.
        run_ok(
            LAUNCHCTL,
            &["bootout", "--wait", &format!("{uid_target}/{label}")],
        )?;
    }
    run_ok(
        LAUNCHCTL,
        &["bootstrap", &uid_target, &path.display().to_string()],
    )?;

    Ok(if already_loaded {
        InstallOutcome::Reinstalled
    } else {
        InstallOutcome::Installed
    })
}

/// Removes the per-user `LaunchAgent` for `label`: stops it if loaded, then deletes its plist.
///
/// Idempotent: uninstalling a label that was never installed succeeds and reports
/// [`UninstallOutcome::NotInstalled`].
///
/// # Errors
///
/// A [`ServiceError`] if `launchctl bootout` fails for a reason other than the label already
/// being gone, [`plist_path`] fails, or the plist file exists but can't be removed.
pub fn uninstall(label: &str) -> Result<UninstallOutcome, ServiceError> {
    let uid = rustix::process::getuid().as_raw();
    let was_loaded = load_state(uid, label)?.loaded();
    if was_loaded {
        run_ok(
            LAUNCHCTL,
            &["bootout", "--wait", &format!("gui/{uid}/{label}")],
        )?;
    }
    let removed_file = remove_file(&plist_path(label)?)?;
    Ok(if was_loaded || removed_file {
        UninstallOutcome::Removed
    } else {
        UninstallOutcome::NotInstalled
    })
}

/// Reports what launchd knows about `label`, and whether `data_dir`'s socket answers right now.
///
/// # Errors
///
/// A [`ServiceError`] if the plist path or `launchctl print` can't be checked. Not answering
/// `initialize` is reported in the result, not treated as an error.
pub fn status(label: &str, data_dir: &DataDir) -> Result<Status, ServiceError> {
    let uid = rustix::process::getuid().as_raw();
    let state = load_state(uid, label)?;
    Status::check(label, plist_path(label)?, state, data_dir)
}

/// Asks launchd about `label` with `launchctl print`. A label nothing has bootstrapped yet is
/// not an error: `print` simply exits non-zero, which reads as [`ServiceState::NotLoaded`].
fn load_state(uid: u32, label: &str) -> Result<ServiceState, ServiceError> {
    let output = run(LAUNCHCTL, &["print", &format!("gui/{uid}/{label}")])?;
    if !output.status.success() {
        return Ok(ServiceState::NotLoaded);
    }
    let (running, pid) = parse_print_output(&String::from_utf8_lossy(&output.stdout));
    Ok(if running {
        ServiceState::Running(pid)
    } else {
        ServiceState::Loaded
    })
}

/// Reads `state = running` and `pid = <n>` out of `launchctl print`'s text. Anything else about
/// a not-currently-running job (`launchctl` has used both "not running" and no `state` line at
/// all across macOS releases) is left as `running: false, pid: None`, which is always correct
/// even if the exact wording changes again.
fn parse_print_output(text: &str) -> (bool, Option<u32>) {
    let running = text.lines().any(|line| line.trim() == "state = running");
    let pid = text
        .lines()
        .find_map(|line| line.trim().strip_prefix("pid = ")?.trim().parse().ok());
    (running, pid)
}

#[cfg(test)]
mod tests {
    use std::path::Path;

    use super::{escape_plist_text, parse_print_output, plist_path, render_plist};
    use crate::paths::DataDir;
    use crate::service::DEFAULT_LABEL;

    #[test]
    fn plist_matches_the_golden_file() {
        let data_dir = DataDir::new("/Users/ryan/Library/Application Support/parallax").unwrap();
        let plist = render_plist(DEFAULT_LABEL, Path::new("/usr/local/bin/plxd"), &data_dir);
        let golden = include_str!("../../tests/golden/launchagent.plist");
        assert_eq!(plist, golden);
    }

    #[test]
    fn special_characters_in_paths_and_the_label_are_escaped() {
        let data_dir = DataDir::new("/Users/a&b/parallax").unwrap();
        let plist = render_plist("a&b<c>", Path::new("/bin/<plxd>"), &data_dir);
        assert!(
            plist.contains("<string>a&amp;b&lt;c&gt;</string>"),
            "{plist}"
        );
        assert!(
            plist.contains("<string>/bin/&lt;plxd&gt;</string>"),
            "{plist}"
        );
        assert!(plist.contains("/Users/a&amp;b/parallax"), "{plist}");
    }

    #[test]
    fn escaping_handles_the_reserved_characters_and_leaves_the_rest_alone() {
        assert_eq!(escape_plist_text("a&b<c>d"), "a&amp;b&lt;c&gt;d");
        assert_eq!(escape_plist_text("plain"), "plain");
    }

    #[test]
    fn plist_path_is_under_launch_agents_with_the_label() {
        let path = plist_path("io.example.test").unwrap();
        assert!(
            path.ends_with("Library/LaunchAgents/io.example.test.plist"),
            "{}",
            path.display()
        );
    }

    #[test]
    fn parses_a_running_jobs_state_and_pid_from_launchctl_print() {
        // A trimmed capture of real `launchctl print gui/<uid>/<label>` output.
        let text = "gui/501/io.example = {\n\
                     \tactive count = 1\n\
                     \tstate = running\n\n\
                     \tprogram = /bin/sleep\n\
                     \tpid = 85309\n\
                     \truns = 1\n\
                     }\n";
        assert_eq!(parse_print_output(text), (true, Some(85309)));
    }

    #[test]
    fn a_job_that_is_not_running_has_no_pid() {
        let text = "gui/501/io.example = {\n\tstate = not running\n}\n";
        assert_eq!(parse_print_output(text), (false, None));
    }

    #[test]
    fn unrecognized_output_is_read_as_not_running_rather_than_an_error() {
        assert_eq!(parse_print_output(""), (false, None));
    }
}
