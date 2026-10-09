//! The systemd user unit that keeps `serve` running on Linux (PLX-18, 0023), driven with
//! `systemctl --user`. With `loginctl enable-linger`, it runs while nobody is logged in.
//!
//! [`render_unit`] is pure, so it is covered by a golden-file test. [`install`] runs
//! `daemon-reload`, `enable`, and `restart`, [`uninstall`] runs `disable --now` and
//! `daemon-reload`, and [`status`] reads `show`.

use std::path::{Path, PathBuf};

use super::{
    InstallOutcome, ServiceError, ServiceState, Status, UninstallOutcome, check_label_serves,
    home_dir, prepare_install, remove_file, run_ok, stop_outside_serve, write_file,
};
use crate::paths::{DATA_DIR_ENV, DataDir};

/// Found on `PATH`: `/usr/bin/systemctl` on merged-`/usr` distros, `/bin/systemctl` on others.
pub(crate) const SYSTEMCTL: &str = "systemctl";

/// The unit's name: `<label>.service`.
#[must_use]
pub fn unit_name(label: &str) -> String {
    format!("{label}.service")
}

/// Where the unit goes: `$XDG_CONFIG_HOME/systemd/user/<label>.service`, where
/// `XDG_CONFIG_HOME` counts only when it is absolute and defaults to `~/.config`, as systemd
/// itself reads it.
///
/// # Errors
///
/// [`ServiceError::NoHomeDir`] if `XDG_CONFIG_HOME` doesn't name a folder and the home folder is
/// unknown.
pub fn unit_path(label: &str) -> Result<PathBuf, ServiceError> {
    let config = match std::env::var_os("XDG_CONFIG_HOME")
        .map(PathBuf::from)
        .filter(|path| path.is_absolute())
    {
        Some(config) => config,
        None => home_dir()?.join(".config"),
    };
    Ok(config.join("systemd").join("user").join(unit_name(label)))
}

/// Renders the user unit that runs `program serve` with [`DATA_DIR_ENV`] set to `data_dir`'s
/// folder, the systemd twin of `launchd::render_plist`. stdout and stderr are appended to
/// `logs/plxd.log` (0009), so a panic before `serve`'s own logger starts still lands there.
/// `append:` needs systemd 240; an older one ignores it and sends both to the journal.
///
/// `Restart=on-failure` is `KeepAlive.SuccessfulExit=false`: systemd restarts `serve` after a
/// non-zero exit or a crash, but not after the 0 that a clean SIGTERM shutdown produces, so a
/// deliberate stop stays stopped. `WantedBy=default.target` starts it with the user's manager,
/// which with linger runs from boot.
///
/// `Type=exec` makes `systemctl start` fail when `program` can't be run, so `attach` falls back
/// to starting `serve` itself. `KillMode=mixed` sends the stop's SIGTERM to `serve` alone, as
/// launchd does, so it can stop its agent CLIs itself; whatever is left then gets SIGKILL.
///
/// # Errors
///
/// [`ServiceError::UnitPath`] if `program` or the data folder isn't UTF-8 or has a control
/// character, which a unit file can't hold.
pub fn render_unit(program: &Path, data_dir: &DataDir) -> Result<String, ServiceError> {
    let program = quote(unit_text(program)?).replace('$', "$$");
    let data_dir_value = quote(&format!("{DATA_DIR_ENV}={}", unit_text(data_dir.root())?));
    let log = unit_text(&data_dir.log_file())?.replace('%', "%%");
    Ok(format!(
        "[Unit]\n\
         Description=plxd, the Parallax host daemon\n\
         \n\
         [Service]\n\
         Type=exec\n\
         ExecStart={program} serve\n\
         Environment={data_dir_value}\n\
         KillMode=mixed\n\
         Restart=on-failure\n\
         StandardOutput=append:{log}\n\
         StandardError=append:{log}\n\
         \n\
         [Install]\n\
         WantedBy=default.target\n"
    ))
}

/// `path` as text a unit file can hold: UTF-8, with no line break or other control character.
fn unit_text(path: &Path) -> Result<&str, ServiceError> {
    path.to_str()
        .filter(|text| !text.chars().any(char::is_control))
        .ok_or_else(|| ServiceError::UnitPath {
            path: path.to_owned(),
        })
}

/// A double-quoted unit value: `\` and `"` are backslash-escaped, and `%` is doubled so systemd
/// doesn't read it as a specifier. `ExecStart` also expands `$`, which its caller doubles.
fn quote(text: &str) -> String {
    let escaped = text
        .replace('\\', "\\\\")
        .replace('"', "\\\"")
        .replace('%', "%%");
    format!("\"{escaped}\"")
}

/// Installs or updates the user unit for `label`, running the current `plxd` binary's `serve`
/// against `data_dir`, then enables and (re)starts it.
///
/// Idempotent: run again, for example after plxd moves, to update the unit and restart the
/// service with it. `restart` waits for the old `serve` to stop before starting the new one, so
/// the two never race for `plxd.lock`.
///
/// # Errors
///
/// [`ServiceError::AlreadyRunningOutsideService`] when the unit isn't running but something is
/// already answering `data_dir`'s socket, unless `replace`. Other variants for a filesystem or
/// `systemctl` failure, including a session with no user manager to reach, or
/// [`ServiceError::StillRunning`].
///
/// With `replace`, that `serve` is stopped once the unit is enabled, so an `attach` in between
/// starts the unit rather than its own `serve`. `reset-failed` then clears a start limit that
/// such a start may have hit while the old `serve` held the lock.
pub fn install(
    label: &str,
    data_dir: &DataDir,
    replace: bool,
) -> Result<InstallOutcome, ServiceError> {
    check_label_serves(label, data_dir, DataDir::default_location().ok().as_ref())?;
    let state = load_state(label)?;
    let (program, outside) = prepare_install(data_dir, state.running(), replace)?;
    let unit = render_unit(&program, data_dir)?;
    write_file(&unit_path(label)?, &unit)?;

    let name = unit_name(label);
    systemctl(&["daemon-reload"])?;
    systemctl(&["enable", &name])?;
    if outside {
        stop_outside_serve(data_dir)?;
        systemctl(&["reset-failed", &name])?;
    }
    systemctl(&["restart", &name])?;
    Ok(if state.loaded() {
        InstallOutcome::Reinstalled
    } else {
        InstallOutcome::Installed
    })
}

/// Removes the user unit for `label`: stops and disables it if systemd has it loaded, deletes
/// the unit file and its `default.target.wants` link, and reloads systemd so it forgets the
/// unit. The link is deleted directly because a unit systemd couldn't load, such as one it can't
/// parse, is never disabled.
///
/// Idempotent: uninstalling a label that was never installed succeeds and reports
/// [`UninstallOutcome::NotInstalled`].
///
/// # Errors
///
/// A [`ServiceError`] if `systemctl` fails, or the unit file exists but can't be removed.
pub fn uninstall(label: &str) -> Result<UninstallOutcome, ServiceError> {
    let was_loaded = load_state(label)?.loaded();
    if was_loaded {
        systemctl(&["disable", "--now", &unit_name(label)])?;
    }
    let path = unit_path(label)?;
    let link = path
        .with_file_name("default.target.wants")
        .join(unit_name(label));
    let removed_link = remove_file(&link)?;
    let removed_file = remove_file(&path)? || removed_link;
    if removed_file {
        systemctl(&["daemon-reload"])?;
    }
    Ok(if was_loaded || removed_file {
        UninstallOutcome::Removed
    } else {
        UninstallOutcome::NotInstalled
    })
}

/// Reports what systemd knows about `label`, and whether `data_dir`'s socket answers right now.
///
/// # Errors
///
/// A [`ServiceError`] if the unit path or `systemctl show` can't be checked. Not answering
/// `initialize` is reported in the result, not treated as an error.
pub fn status(label: &str, data_dir: &DataDir) -> Result<Status, ServiceError> {
    let state = load_state(label)?;
    Status::check(label, unit_path(label)?, state, data_dir)
}

/// Asks the user manager about `label` with `systemctl --user show`, which succeeds for a unit
/// that doesn't exist too, with `LoadState=not-found`.
fn load_state(label: &str) -> Result<ServiceState, ServiceError> {
    let output = systemctl(&["show", "--property=LoadState,MainPID", &unit_name(label)])?;
    Ok(parse_show_output(&String::from_utf8_lossy(&output.stdout)))
}

/// Reads `LoadState=` and `MainPID=` out of `systemctl show`'s `KEY=VALUE` lines. A non-zero
/// `MainPID` means `serve` is running; `LoadState=loaded` without one means it isn't. Anything
/// else, including output it doesn't recognize, is not loaded.
fn parse_show_output(text: &str) -> ServiceState {
    let value = |key: &str| {
        text.lines()
            .find_map(|line| line.strip_prefix(key)?.strip_prefix('='))
    };
    match value("MainPID").and_then(|pid| pid.trim().parse::<u32>().ok()) {
        Some(pid) if pid != 0 => ServiceState::Running(Some(pid)),
        _ if value("LoadState") == Some("loaded") => ServiceState::Loaded,
        _ => ServiceState::NotLoaded,
    }
}

fn systemctl(args: &[&str]) -> Result<std::process::Output, ServiceError> {
    run_ok(SYSTEMCTL, &[&["--user"], args].concat())
}

#[cfg(test)]
mod tests {
    use std::path::Path;

    use super::{parse_show_output, quote, render_unit, unit_name};
    use crate::paths::DataDir;
    use crate::service::{DEFAULT_LABEL, ServiceError, ServiceState};

    #[test]
    fn unit_matches_the_golden_file() {
        let data_dir = DataDir::new("/home/ryan/.local/share/parallax").unwrap();
        let unit = render_unit(Path::new("/usr/local/bin/plxd"), &data_dir).unwrap();
        let golden = include_str!("../../tests/golden/systemd.service");
        assert_eq!(unit, golden);
        assert_eq!(
            unit_name(DEFAULT_LABEL),
            "io.github.ryan-stoffel.parallax.plxd.service"
        );
    }

    #[test]
    fn special_characters_in_paths_are_quoted_and_escaped() {
        let data_dir = DataDir::new("/home/a b/100%/\"q\"").unwrap();
        let unit = render_unit(Path::new("/opt/$x\\y/plxd"), &data_dir).unwrap();
        assert!(
            unit.contains("ExecStart=\"/opt/$$x\\\\y/plxd\" serve\n"),
            "{unit}"
        );
        assert!(
            unit.contains("Environment=\"PLXD_DATA_DIR=/home/a b/100%%/\\\"q\\\"\"\n"),
            "{unit}"
        );
        assert!(
            unit.contains("StandardOutput=append:/home/a b/100%%/\"q\"/logs/plxd.log\n"),
            "{unit}"
        );
        assert_eq!(quote("plain"), "\"plain\"");
    }

    #[test]
    fn a_path_with_a_line_break_is_refused() {
        let data_dir = DataDir::new("/home/ryan/parallax").unwrap();
        let error = render_unit(Path::new("/bin/wi\nspd"), &data_dir).unwrap_err();
        assert!(matches!(error, ServiceError::UnitPath { .. }), "{error:?}");
    }

    #[test]
    fn parses_systemctl_show() {
        assert_eq!(
            parse_show_output("LoadState=loaded\nMainPID=4242\n"),
            ServiceState::Running(Some(4242))
        );
        assert_eq!(
            parse_show_output("MainPID=0\nLoadState=loaded\n"),
            ServiceState::Loaded
        );
        assert_eq!(
            parse_show_output("LoadState=not-found\nMainPID=0\n"),
            ServiceState::NotLoaded
        );
        assert_eq!(parse_show_output(""), ServiceState::NotLoaded);
    }
}
