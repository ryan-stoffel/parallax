//! The per-user `LaunchAgent` that keeps `serve` running on macOS (#61, 0010).
//!
//! [`render_plist`] is pure, so it is covered by a golden-file test. [`install`], [`uninstall`],
//! and [`status`] shell out to `launchctl`'s `bootstrap`, `bootout`, and `print`, per Apple's
//! guidance to prefer them over the deprecated `load` and `unload`.

use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use super::{
    InstallOutcome, ServiceError, ServiceState, Status, UninstallOutcome, check_label_serves,
    escape_xml, home_dir, prepare_install, remove_file, run, run_ok, stop_outside_serve,
    unescape_xml, write_file,
};
use crate::paths::{DATA_DIR_ENV, DataDir};

pub(crate) const LAUNCHCTL: &str = "/bin/launchctl";

/// How long [`install`] keeps retrying a `bootstrap` that fails right after a `bootout`.
const BOOTSTRAP_PATIENCE: Duration = Duration::from_secs(10);

/// How long [`bootstrap`] waits between tries.
const BOOTSTRAP_RETRY: Duration = Duration::from_millis(250);

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
/// `KeepAlive` is `true`: launchd restarts `serve` after any exit, a clean SIGTERM shutdown's 0
/// included, throttled to one start every 10 s. Only `launchctl bootout` keeps it stopped.
#[must_use]
pub fn render_plist(label: &str, program: &Path, data_dir: &DataDir) -> String {
    let label = escape_xml(label);
    let program = escape_xml(&program.display().to_string());
    let data_dir_value = escape_xml(&data_dir.root().display().to_string());
    let log = escape_xml(&data_dir.log_file().display().to_string());
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
         \t<true/>\n\
         \t<key>StandardOutPath</key>\n\
         \t<string>{log}</string>\n\
         \t<key>StandardErrorPath</key>\n\
         \t<string>{log}</string>\n\
         </dict>\n\
         </plist>\n"
    )
}

/// Installs or updates the per-user `LaunchAgent` for `label`, running the current `plxd`
/// binary's `serve` against `data_dir`.
///
/// Idempotent: run again, for example after plxd moves, to update the plist and restart the
/// service with the new one (`bootout` then `bootstrap`, since launchd does not reread a
/// bootstrapped job's plist on its own). A `bootstrap` that fails right after the `bootout` is
/// retried for up to [`BOOTSTRAP_PATIENCE`], since by then the old `serve` is gone.
///
/// # Errors
///
/// [`ServiceError::AlreadyRunningOutsideService`] when nothing is running under `label`, but
/// something is already answering `data_dir`'s socket, unless `replace`: bootstrapping would only
/// start a second `serve` that fights the first one for the lock. Other variants for a
/// filesystem or `launchctl` failure, or [`ServiceError::StillRunning`].
///
/// With `replace`, that `serve` is stopped after the bootstrap, so an `attach` in between goes
/// through `launchctl kickstart` rather than starting its own. Until it's gone, the service's
/// `serve` exits 3 and launchd throttles it; a last `kickstart` starts it at once.
pub fn install(
    label: &str,
    data_dir: &DataDir,
    replace: bool,
) -> Result<InstallOutcome, ServiceError> {
    check_label_serves(label, data_dir, DataDir::default_location().ok().as_ref())?;
    let uid = rustix::process::getuid().as_raw();
    let state = load_state(uid, label)?;
    let already_loaded = state.loaded();
    // Loaded isn't enough: a loaded agent whose `serve` keeps exiting 3 leaves the one outside it
    // holding the data folder.
    let (program, outside) = prepare_install(data_dir, state.running(), replace)?;
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
    bootstrap(
        LAUNCHCTL,
        &["bootstrap", &uid_target, &path.display().to_string()],
        if already_loaded {
            BOOTSTRAP_PATIENCE
        } else {
            Duration::ZERO
        },
    )?;
    if outside {
        stop_outside_serve(data_dir)?;
        run_ok(LAUNCHCTL, &["kickstart", &format!("{uid_target}/{label}")])?;
    }

    Ok(InstallOutcome::of(already_loaded))
}

/// Runs `launchctl`, the program at `launchctl`, with `args`, a `bootstrap`, trying again every
/// [`BOOTSTRAP_RETRY`] while it fails, until `patience` is up. launchd tears a booted-out job down
/// after `bootout` returns, so a bootstrap right after one can fail until it's done.
fn bootstrap(launchctl: &str, args: &[&str], patience: Duration) -> Result<(), ServiceError> {
    let deadline = Instant::now() + patience;
    loop {
        let result = run_ok(launchctl, args);
        if result.is_ok() || Instant::now() >= deadline {
            return result.map(drop);
        }
        std::thread::sleep(BOOTSTRAP_RETRY);
    }
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
    Ok(UninstallOutcome::of(was_loaded || removed_file))
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
    let path = plist_path(label)?;
    let program = std::fs::read_to_string(&path)
        .ok()
        .and_then(|plist| plist_program(&plist));
    Status::check(label, path, program, state, data_dir)
}

/// The program a plist from [`render_plist`] runs: the first `<string>` after
/// `<key>ProgramArguments</key>`, unescaped.
fn plist_program(plist: &str) -> Option<PathBuf> {
    let (_, rest) = plist.split_once("<key>ProgramArguments</key>")?;
    let (_, rest) = rest.split_once("<string>")?;
    let (program, _) = rest.split_once("</string>")?;
    Some(PathBuf::from(unescape_xml(program)))
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
    use std::time::{Duration, Instant};

    use super::{bootstrap, escape_xml, parse_print_output, plist_path, render_plist};
    use crate::paths::DataDir;
    use crate::service::DEFAULT_LABEL;
    use crate::service::tests::fake_program;

    #[test]
    fn a_failing_bootstrap_is_retried_until_its_patience_is_up() {
        let dir = tempfile::tempdir().unwrap();
        let tries = dir.path().join("tries");
        // Fails twice, as launchd does while it still tears the old job down, then succeeds.
        let launchctl = fake_program(
            dir.path(),
            "launchctl",
            &format!(
                "echo \"$*\" >> '{tries}'\n\
                 [ $(wc -l < '{tries}') -gt 2 ] || {{ echo 'Bootstrap failed: 5: Input/output error' >&2; exit 5; }}",
                tries = tries.display()
            ),
        );
        let args = ["bootstrap", "gui/501", "/tmp/a.plist"];

        bootstrap(&launchctl, &args, Duration::from_secs(10)).unwrap();
        assert_eq!(
            std::fs::read_to_string(&tries).unwrap(),
            "bootstrap gui/501 /tmp/a.plist\n".repeat(3)
        );

        std::fs::remove_file(&tries).unwrap();
        let error = bootstrap(&launchctl, &args, Duration::ZERO).unwrap_err();
        assert!(error.to_string().contains("Input/output error"), "{error}");
        assert_eq!(std::fs::read_to_string(&tries).unwrap().lines().count(), 1);

        let started = Instant::now();
        let failing = fake_program(dir.path(), "failing", "exit 5");
        bootstrap(&failing, &args, Duration::from_millis(600)).unwrap_err();
        assert!(started.elapsed() >= Duration::from_millis(600));
        assert!(started.elapsed() < Duration::from_secs(5));
    }

    #[test]
    fn plist_matches_the_golden_file() {
        let data_dir = DataDir::new("/Users/ryan/Library/Application Support/parallax").unwrap();
        let plist = render_plist(DEFAULT_LABEL, Path::new("/usr/local/bin/plxd"), &data_dir);
        let golden = include_str!("../../tests/golden/launchagent.plist");
        assert_eq!(plist, golden);
    }

    #[test]
    fn status_reads_the_program_back_from_the_plist() {
        let data_dir = DataDir::new("/Users/a&b/parallax").unwrap();
        let program = Path::new("/Applications/A&B <1>.app/plxd");
        let plist = render_plist(DEFAULT_LABEL, program, &data_dir);
        assert_eq!(super::plist_program(&plist).as_deref(), Some(program));
        assert_eq!(super::plist_program("<plist/>"), None);
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
        assert_eq!(escape_xml("a&b<c>d"), "a&amp;b&lt;c&gt;d");
        assert_eq!(escape_xml("plain"), "plain");
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
