//! The per-user scheduled task that keeps `serve` running on Windows (PLX-576, 0023), registered
//! from XML with `schtasks`, which needs no admin rights for a logon trigger that names the user.
//!
//! [`render_task`] is pure, so it is covered by a golden-file test on every OS, as is reading
//! `schtasks /query`. `install` writes the XML to `task_file` and runs `schtasks /create` and
//! `/run`, `uninstall` runs `/end` and `/delete`, and `status` reads `/query`.
//!
//! `schtasks /end` stops only the action's process, `conhost.exe`, and not the `plxd` it runs.
//! So `install` and `uninstall` also stop that `serve` directly: by its pipe's server pid, with
//! `taskkill /f`, since Windows has no SIGTERM to send it.

use std::path::Path;
#[cfg(any(windows, test))]
use std::path::PathBuf;
#[cfg(windows)]
use std::time::{Duration, Instant};

#[cfg(windows)]
use super::{
    InstallOutcome, STOP_TIMEOUT, Status, UninstallOutcome, check_label_serves, home_dir,
    prepare_install, remove_file, run, run_ok, write_file,
};
use super::{ServiceError, escape_xml};
#[cfg(any(windows, test))]
use super::{ServiceState, unescape_xml};
#[cfg(windows)]
use crate::paths::DataDir;

/// Found on `PATH`, in `System32`.
#[cfg(windows)]
pub(crate) const SCHTASKS: &str = "schtasks";

/// What `schtasks /query /v /fo csv` puts in Last Result while the task runs:
/// `SCHED_S_TASK_RUNNING`, 0x41301.
#[cfg(any(windows, test))]
const LAST_RESULT_RUNNING: &str = "267009";

/// How long [`started`] waits for Task Scheduler to report the task running after `/run`.
#[cfg(windows)]
const START_WAIT: Duration = Duration::from_secs(2);

/// Where the task's XML goes, and stays while it's installed: `%LOCALAPPDATA%\<label>.xml`, or
/// `~\AppData\Local\<label>.xml` when that variable isn't an absolute path. Task Scheduler keeps
/// its own copy where a standard user can't read it, so this one is what `status` reports.
///
/// # Errors
///
/// [`ServiceError::NoHomeDir`] if neither names a folder.
#[cfg(windows)]
pub fn task_file(label: &str) -> Result<PathBuf, ServiceError> {
    let local = match std::env::var_os("LOCALAPPDATA")
        .map(PathBuf::from)
        .filter(|path| path.is_absolute())
    {
        Some(local) => local,
        None => home_dir()?.join("AppData").join("Local"),
    };
    Ok(local.join(format!("{label}.xml")))
}

/// Renders the task that runs `program serve --data-dir <data_dir>` for the user `user` (a SID),
/// the Windows twin of `launchd::render_plist`. A task's action has no environment of its own, so
/// the data folder goes in `serve`'s `--data-dir`, and `serve` passes it on to what it starts as
/// `PLXD_DATA_DIR`. `serve` logs to `logs/plxd.log` itself; a task's output goes nowhere.
///
/// - `conhost.exe --headless` runs `plxd` with a console that has no window, as Windows'
///   pseudoconsole does, so nothing opens on the desktop at logon.
/// - The logon trigger names the user, which lets a standard user register it. It repeats every
///   5 minutes with no end, and `IgnoreNew` drops a repeat while `serve` runs, so a `serve` that
///   exited for any reason is started again within 5 minutes. `RestartOnFailure` retries a start
///   that failed every minute.
/// - `InteractiveToken` runs it in the user's logon session, where Credential Manager is
///   reachable, and only while they're logged on (0023).
/// - `ExecutionTimeLimit` `PT0S` is no limit; the default of 72 hours would stop `serve`.
/// - Priority 5 is a normal one. The default, 7, is below normal, which `plxd` would inherit
///   from `conhost`.
///
/// # Errors
///
/// [`ServiceError::UnitPath`] if `program` or `data_dir` isn't Unicode.
pub fn render_task(program: &Path, data_dir: &Path, user: &str) -> Result<String, ServiceError> {
    let arguments = format!(
        "--headless {} serve --data-dir {}",
        quote_arg(task_text(program)?),
        quote_arg(task_text(data_dir)?)
    );
    let arguments = escape_xml(&arguments);
    let user = escape_xml(user);
    Ok(format!(
        "<?xml version=\"1.0\" encoding=\"UTF-16\"?>\n\
         <Task version=\"1.2\" xmlns=\"http://schemas.microsoft.com/windows/2004/02/mit/task\">\n\
         \x20 <RegistrationInfo>\n\
         \x20   <Description>plxd, the Parallax host daemon</Description>\n\
         \x20 </RegistrationInfo>\n\
         \x20 <Triggers>\n\
         \x20   <LogonTrigger>\n\
         \x20     <Repetition>\n\
         \x20       <Interval>PT5M</Interval>\n\
         \x20     </Repetition>\n\
         \x20     <UserId>{user}</UserId>\n\
         \x20   </LogonTrigger>\n\
         \x20 </Triggers>\n\
         \x20 <Principals>\n\
         \x20   <Principal id=\"Author\">\n\
         \x20     <UserId>{user}</UserId>\n\
         \x20     <LogonType>InteractiveToken</LogonType>\n\
         \x20     <RunLevel>LeastPrivilege</RunLevel>\n\
         \x20   </Principal>\n\
         \x20 </Principals>\n\
         \x20 <Settings>\n\
         \x20   <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>\n\
         \x20   <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>\n\
         \x20   <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>\n\
         \x20   <StartWhenAvailable>true</StartWhenAvailable>\n\
         \x20   <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>\n\
         \x20   <Priority>5</Priority>\n\
         \x20   <RestartOnFailure>\n\
         \x20     <Interval>PT1M</Interval>\n\
         \x20     <Count>999</Count>\n\
         \x20   </RestartOnFailure>\n\
         \x20 </Settings>\n\
         \x20 <Actions Context=\"Author\">\n\
         \x20   <Exec>\n\
         \x20     <Command>%SystemRoot%\\System32\\conhost.exe</Command>\n\
         \x20     <Arguments>{arguments}</Arguments>\n\
         \x20   </Exec>\n\
         \x20 </Actions>\n\
         </Task>\n"
    ))
}

/// `path` as text the task can hold.
fn task_text(path: &Path) -> Result<&str, ServiceError> {
    path.to_str().ok_or_else(|| ServiceError::UnitPath {
        path: path.to_owned(),
    })
}

/// One command-line argument, double-quoted the way `CommandLineToArgvW` reads it back. A Windows
/// path can't hold `"`, so only backslashes before the closing quote need doubling, as in `C:\`.
fn quote_arg(text: &str) -> String {
    let trailing = text.len() - text.trim_end_matches('\\').len();
    format!("\"{text}{}\"", "\\".repeat(trailing))
}

/// `text` as `schtasks /create /xml` reads it most reliably: UTF-16 LE with a byte order mark,
/// which [`render_task`]'s declaration names.
#[cfg(any(windows, test))]
fn utf16_with_bom(text: &str) -> Vec<u8> {
    std::iter::once(0xFEFF)
        .chain(text.encode_utf16())
        .flat_map(u16::to_le_bytes)
        .collect()
}

/// What a task file from [`render_task`] runs: its `plxd` and its `--data-dir`, read back from the
/// action's arguments. `None` when it isn't such a file.
#[cfg(any(windows, test))]
fn task_action(file: &[u8]) -> Option<(PathBuf, PathBuf)> {
    let units: Vec<u16> = file
        .strip_prefix(&[0xFF, 0xFE][..])?
        .as_chunks()
        .0
        .iter()
        .map(|pair| u16::from_le_bytes(*pair))
        .collect();
    let xml = String::from_utf16(&units).ok()?;
    let (_, rest) = xml.split_once("<Arguments>")?;
    let (arguments, _) = rest.split_once("</Arguments>")?;
    let arguments = unescape_xml(arguments);
    // Neither path can hold `"`, so the quotes `quote_arg` added mark where each one ends.
    let rest = arguments.strip_prefix("--headless \"")?;
    let (program, rest) = rest.split_once("\" serve --data-dir \"")?;
    let data_dir = rest.strip_suffix('"')?;
    Some((unquote_arg(program).into(), unquote_arg(data_dir).into()))
}

/// Undoes [`quote_arg`]'s doubled trailing backslashes, once its quotes are gone.
#[cfg(any(windows, test))]
fn unquote_arg(text: &str) -> &str {
    let trailing = text.len() - text.trim_end_matches('\\').len();
    &text[..text.len() - trailing / 2]
}

/// Reads `schtasks /query /v /fo csv /nh` for a task it found. It prints a quoted CSV row per
/// trigger, in a column order that doesn't change with the language: the seventh is Last Result,
/// [`LAST_RESULT_RUNNING`] while the task runs. The Status column would say so too, but in the
/// system's language. Task Scheduler doesn't say which process is `serve`, so there's no pid.
#[cfg(any(windows, test))]
fn parse_query_output(text: &str) -> ServiceState {
    let running = text
        .lines()
        .any(|row| row.split("\",\"").nth(6) == Some(LAST_RESULT_RUNNING));
    if running {
        ServiceState::Running(None)
    } else {
        ServiceState::Loaded
    }
}

/// Installs or updates the task for `label`, running the current `plxd` binary's `serve` against
/// `data_dir`, then starts it.
///
/// Idempotent: run again, for example after plxd moves, to update the task and restart `serve`
/// with it. A running task is ended and its `serve` stopped before the new one starts, so the two
/// never race for `plxd.lock`.
///
/// # Errors
///
/// [`ServiceError::AlreadyRunningOutsideService`] when the task isn't running but something is
/// already answering `data_dir`'s pipe, unless `replace`. With `replace`, that `serve` is stopped
/// once the task is registered, so an `attach` in between goes through the task. Other variants
/// for a filesystem or `schtasks` failure, or [`ServiceError::StillRunning`].
#[cfg(windows)]
pub fn install(
    label: &str,
    data_dir: &DataDir,
    replace: bool,
) -> Result<InstallOutcome, ServiceError> {
    check_label_serves(label, data_dir, DataDir::default_location().ok().as_ref())?;
    let state = load_state(label)?;
    let (program, outside) = prepare_install(data_dir, state.running(), replace)?;
    let user = crate::windows::this_user_sid()
        .map_err(|error| ServiceError::io("reading this user's SID", error))?;
    let task = render_task(&program, data_dir.root(), &user)?;
    let file = task_file(label)?;
    // A running task's `serve` is the one for the folder it was installed with, which may not be
    // `data_dir`. Read before the file is replaced.
    let installed = installed_data_dir(&file);
    write_file(&file, utf16_with_bom(&task))?;

    if state.running() {
        // Ending a task that has just stopped fails, which changes nothing here.
        let _ = run(SCHTASKS, &["/end", "/tn", label]);
    }
    run_ok(
        SCHTASKS,
        &[
            "/create",
            "/xml",
            &file.display().to_string(),
            "/tn",
            label,
            "/f",
        ],
    )?;
    if state.running() {
        stop_serve(installed.as_ref().unwrap_or(data_dir))?;
    }
    if outside {
        stop_serve(data_dir)?;
    }
    run_ok(SCHTASKS, &["/run", "/tn", label])?;
    Ok(InstallOutcome::of(state.loaded()))
}

/// Removes the task for `label`: ends it if it's running, and stops its `serve`, for the data
/// folder its XML names; then deletes the task and the XML. A running task whose XML is gone
/// leaves its `serve` running, since nothing says which folder that is.
///
/// Idempotent: uninstalling a label that was never installed succeeds and reports
/// [`UninstallOutcome::NotInstalled`].
///
/// # Errors
///
/// A [`ServiceError`] if `schtasks /delete` fails, the `serve` doesn't stop, or the XML exists
/// but can't be removed.
#[cfg(windows)]
pub fn uninstall(label: &str) -> Result<UninstallOutcome, ServiceError> {
    let state = load_state(label)?;
    let file = task_file(label)?;
    let data_dir = installed_data_dir(&file);
    if state.running() {
        let _ = run(SCHTASKS, &["/end", "/tn", label]);
    }
    if state.loaded() {
        run_ok(SCHTASKS, &["/delete", "/tn", label, "/f"])?;
    }
    // After the delete, so the task's next repeat can't start it again.
    if state.running()
        && let Some(data_dir) = &data_dir
    {
        stop_serve(data_dir)?;
    }
    let removed_file = remove_file(&file)?;
    Ok(UninstallOutcome::of(state.loaded() || removed_file))
}

/// Reports what Task Scheduler knows about `label`, and whether `data_dir`'s pipe answers right
/// now.
///
/// # Errors
///
/// A [`ServiceError`] if the XML's path or `schtasks /query` can't be checked. Not answering
/// `initialize` is reported in the result, not treated as an error.
#[cfg(windows)]
pub fn status(label: &str, data_dir: &DataDir) -> Result<Status, ServiceError> {
    let state = load_state(label)?;
    let path = task_file(label)?;
    let program = installed_action(&path).map(|(program, _)| program);
    Status::check(label, path, program, state, data_dir)
}

/// What the task file at `file` runs, if it's there: see [`task_action`].
#[cfg(windows)]
fn installed_action(file: &Path) -> Option<(PathBuf, PathBuf)> {
    task_action(&std::fs::read(file).ok()?)
}

/// The data folder the task file at `file` serves, if it's there.
#[cfg(windows)]
fn installed_data_dir(file: &Path) -> Option<DataDir> {
    DataDir::new(installed_action(file)?.1).ok()
}

/// Whether Task Scheduler reports `label` running within [`START_WAIT`], or by `deadline` if
/// that's sooner. `attach` asks after `schtasks /run`, which only asks Task Scheduler to start
/// it: it doesn't while the user has no interactive session, such as over SSH with nobody logged
/// on (0023).
#[cfg(windows)]
pub(crate) fn started(label: &str, deadline: Instant) -> bool {
    let deadline = deadline.min(Instant::now() + START_WAIT);
    loop {
        if load_state(label).is_ok_and(ServiceState::running) {
            return true;
        }
        if Instant::now() >= deadline {
            return false;
        }
        std::thread::sleep(Duration::from_millis(100));
    }
}

/// Asks Task Scheduler about `label`. A task that isn't registered makes `/query` fail, which
/// reads as [`ServiceState::NotLoaded`].
#[cfg(windows)]
fn load_state(label: &str) -> Result<ServiceState, ServiceError> {
    let output = run(
        SCHTASKS,
        &["/query", "/tn", label, "/v", "/fo", "csv", "/nh"],
    )?;
    if !output.status.success() {
        return Ok(ServiceState::NotLoaded);
    }
    Ok(parse_query_output(&String::from_utf8_lossy(&output.stdout)))
}

/// Stops the `serve` holding `data_dir`'s lock: `taskkill /f` on its pipe's server, then waits up
/// to [`STOP_TIMEOUT`] for the lock to be free. Windows has no SIGTERM to send it. A `serve` that
/// holds the lock but doesn't answer yet, as while it's starting, is looked for again until then.
/// Nothing holding the lock is not an error.
#[cfg(windows)]
fn stop_serve(data_dir: &DataDir) -> Result<(), ServiceError> {
    let deadline = Instant::now() + STOP_TIMEOUT;
    let mut killed = None;
    while lock_held(data_dir) {
        if killed.is_none()
            && let Some(pid) = serve_pid(data_dir)
        {
            run_ok("taskkill", &["/f", "/pid", &pid.to_string()])?;
            killed = Some(pid);
        }
        if Instant::now() >= deadline {
            return Err(match killed {
                Some(pid) => ServiceError::StillRunning { pid },
                None => ServiceError::LockHeldWithoutAnswering {
                    data_dir: data_dir.root().to_owned(),
                },
            });
        }
        std::thread::sleep(Duration::from_millis(20));
    }
    Ok(())
}

/// The pid of the process serving `data_dir`'s pipe, which [`crate::transport::connect`] checks
/// runs as this user. The lock file names it too, but its lock is mandatory, so nobody else can
/// read it (0023).
#[cfg(windows)]
fn serve_pid(data_dir: &DataDir) -> Option<u32> {
    let socket = data_dir.socket_path().ok()?;
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .ok()?;
    // The pipe is opened and closed inside the runtime, which its client needs.
    runtime.block_on(async {
        let stream = crate::transport::connect(&socket.path).await.ok()?;
        crate::windows::pipe_server_pid(&stream).ok()
    })
}

/// Whether a process holds `data_dir`'s `plxd.lock`.
#[cfg(windows)]
fn lock_held(data_dir: &DataDir) -> bool {
    std::fs::File::open(data_dir.lock_file())
        .is_ok_and(|file| matches!(file.try_lock(), Err(std::fs::TryLockError::WouldBlock)))
}

#[cfg(test)]
mod tests {
    use std::path::Path;

    use super::{
        LAST_RESULT_RUNNING, parse_query_output, quote_arg, render_task, task_action,
        utf16_with_bom,
    };
    use crate::service::ServiceState;

    #[test]
    fn task_matches_the_golden_file() {
        let task = render_task(
            Path::new(r"C:\Program Files\Parallax\resources\plxd.exe"),
            Path::new(r"C:\Users\ryan\.parallax"),
            "S-1-5-21-1004336348-1177238915-682003330-1001",
        )
        .unwrap();
        let golden = include_str!("../../tests/golden/task.xml");
        assert_eq!(task, golden);
    }

    #[test]
    fn paths_are_quoted_for_the_command_line_and_escaped_for_xml() {
        let task = render_task(Path::new(r"C:\A&B\<plxd>.exe"), Path::new(r"D:\"), "S-1").unwrap();
        assert!(
            task.contains(
                r#"<Arguments>--headless "C:\A&amp;B\&lt;plxd&gt;.exe" serve --data-dir "D:\\"</Arguments>"#
            ),
            "{task}"
        );
        assert_eq!(quote_arg(r"C:\x"), r#""C:\x""#);
        assert_eq!(quote_arg(r"C:\x\\"), r#""C:\x\\\\""#);
    }

    #[test]
    fn the_program_and_data_folder_are_read_back_from_the_file() {
        let program = Path::new(r"C:\A&B\<plxd>.exe");
        let file = utf16_with_bom(&render_task(program, Path::new(r"D:\"), "S-1").unwrap());
        assert_eq!(
            task_action(&file),
            Some((program.to_owned(), r"D:\".into()))
        );
        assert_eq!(task_action(b"<Task/>"), None);
    }

    #[test]
    fn the_file_is_utf16_with_a_byte_order_mark() {
        assert_eq!(utf16_with_bom("<é"), [0xFF, 0xFE, b'<', 0, 0xE9, 0]);
    }

    #[test]
    fn parses_schtasks_query() {
        // A trimmed `schtasks /query /tn <label> /v /fo csv /nh` row, for a running task.
        let row = |result: &str| {
            format!(
                "\"HOST\",\"\\io.example\",\"N/A\",\"Running\",\"Interactive only\",\
                 \"10/15/2026 3:00:00 PM\",\"{result}\",\"HOST\\ryan\",\
                 \"%SystemRoot%\\System32\\conhost.exe --headless \"C:\\plxd.exe\" serve\"\r\n"
            )
        };
        assert_eq!(
            parse_query_output(&row(LAST_RESULT_RUNNING)),
            ServiceState::Running(None)
        );
        assert_eq!(parse_query_output(&row("0")), ServiceState::Loaded);
        assert_eq!(parse_query_output(""), ServiceState::Loaded);
    }
}
