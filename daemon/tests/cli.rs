use std::process::{Command, Output};

#[cfg(unix)]
#[path = "common/temp.rs"]
mod temp;

fn wispd(args: &[&str]) -> Output {
    Command::new(env!("CARGO_BIN_EXE_wispd"))
        .args(args)
        .env_remove("WISPD_LOG")
        .env_remove("WISPD_DATA_DIR")
        .output()
        .expect("wispd should run")
}

#[test]
fn version_prints_name_and_version() {
    let output = wispd(&["--version"]);

    assert!(output.status.success(), "{output:?}");
    assert_eq!(
        String::from_utf8_lossy(&output.stdout),
        concat!("wispd ", env!("CARGO_PKG_VERSION"), "\n")
    );
    assert!(output.stderr.is_empty(), "{output:?}");
}

#[test]
fn unknown_argument_prints_usage_and_exits_2() {
    let output = wispd(&["--bogus"]);

    assert_eq!(output.status.code(), Some(2), "{output:?}");
    assert!(output.stdout.is_empty(), "{output:?}");
    assert!(
        String::from_utf8_lossy(&output.stderr).contains("Usage: wispd"),
        "{output:?}"
    );
}

#[test]
fn no_arguments_print_help_and_exit_2() {
    let output = wispd(&[]);

    assert_eq!(output.status.code(), Some(2), "{output:?}");
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(stderr.contains("Usage: wispd"), "{output:?}");
    assert!(stderr.contains("serve"), "{output:?}");
}

#[test]
fn an_unknown_log_level_is_a_usage_error() {
    let output = wispd(&[
        "serve",
        "--log-level",
        "loud",
        "--data-dir",
        "/nonexistent/wispd",
    ]);

    assert_eq!(output.status.code(), Some(2), "{output:?}");
    assert!(
        String::from_utf8_lossy(&output.stderr).contains("unknown log level"),
        "{output:?}"
    );
}

// This only ever reads: `launchctl print` on a label nobody bootstrapped, a socket connect
// that finds nobody listening, and a file existence check. It never calls `install`, so running
// `cargo test` never bootstraps a real LaunchAgent.
#[cfg(target_os = "macos")]
#[test]
fn service_status_reports_a_fresh_label_as_absent() {
    let temp = temp::temp_dir();
    let data_dir = temp.path().to_str().expect("a UTF-8 temp path");
    let output = wispd(&[
        "service",
        "status",
        "--data-dir",
        data_dir,
        "--label",
        "io.github.ryan-stoffel.wisp.wispd.cli-test-status",
    ]);

    assert!(output.status.success(), "{output:?}");
    let stdout = String::from_utf8_lossy(&output.stdout);
    assert!(stdout.contains("installed: false"), "{stdout}");
    assert!(stdout.contains("loaded: false"), "{stdout}");
    assert!(stdout.contains("running: false"), "{stdout}");
    assert!(stdout.contains("answers initialize: false"), "{stdout}");
}

// The refusal comes before anything touches launchd or `~/Library/LaunchAgents`, so this never
// installs a real LaunchAgent.
#[cfg(target_os = "macos")]
#[test]
fn service_install_refuses_the_default_label_for_another_data_folder() {
    let temp = temp::temp_dir();
    let data_dir = temp.path().join("data");
    let output = Command::new(env!("CARGO_BIN_EXE_wispd"))
        .args(["service", "install", "--data-dir"])
        .arg(&data_dir)
        .env_remove("WISPD_LOG")
        .env_remove("WISPD_DATA_DIR")
        .env_remove("WISPD_SERVICE_LABEL")
        .output()
        .expect("wispd should run");

    assert_eq!(output.status.code(), Some(1), "{output:?}");
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(
        stderr.contains("serves only the default data folder"),
        "{stderr}"
    );
    assert!(
        !data_dir.exists(),
        "nothing was prepared for the refused folder"
    );
}

// `wispd service` on Linux, against a stand-in `systemctl` on `PATH` and a temporary home folder,
// so it needs no user manager and never touches a real one. The stand-in records its arguments,
// and `show` reports the unit loaded once its file exists, as systemd would.
#[cfg(target_os = "linux")]
#[test]
fn service_installs_reports_and_uninstalls_a_systemd_user_unit() {
    use std::fs;
    use std::os::unix::fs::PermissionsExt;

    const LABEL: &str = "io.github.ryan-stoffel.wisp.wispd.cli-test";
    let temp = temp::temp_dir();
    let bin = temp.path().join("bin");
    let home = temp.path().join("home");
    let data = temp.path().join("data");
    let calls = temp.path().join("calls");
    let unit = home.join(format!(".config/systemd/user/{LABEL}.service"));
    fs::create_dir(&bin).unwrap();
    let systemctl = bin.join("systemctl");
    fs::write(
        &systemctl,
        format!(
            "#!/bin/sh\n\
             echo \"$*\" >> '{calls}'\n\
             if [ \"$2\" = show ]; then\n\
             \x20 if [ -e '{unit}' ]; then echo LoadState=loaded; else echo LoadState=not-found; fi\n\
             \x20 echo MainPID=0\n\
             fi\n",
            calls = calls.display(),
            unit = unit.display(),
        ),
    )
    .unwrap();
    fs::set_permissions(&systemctl, fs::Permissions::from_mode(0o755)).unwrap();
    let path = format!(
        "{}:{}",
        bin.display(),
        std::env::var("PATH").unwrap_or_default()
    );
    let service = |command: &str| {
        let output = Command::new(env!("CARGO_BIN_EXE_wispd"))
            .args(["service", command, "--label", LABEL, "--data-dir"])
            .arg(&data)
            .env("PATH", &path)
            .env("HOME", &home)
            .env_remove("XDG_CONFIG_HOME")
            .env_remove("XDG_DATA_HOME")
            .env_remove("WISPD_LOG")
            .env_remove("WISPD_DATA_DIR")
            .env_remove("WISPD_SERVICE_LABEL")
            .output()
            .expect("wispd should run");
        assert!(output.status.success(), "{command}: {output:?}");
        String::from_utf8_lossy(&output.stdout).into_owned()
    };

    assert_eq!(
        service("install"),
        format!("installed and started {LABEL}\n")
    );
    let text = fs::read_to_string(&unit).unwrap();
    assert!(
        text.contains(&format!(
            "ExecStart=\"{}\" serve\n",
            env!("CARGO_BIN_EXE_wispd")
        )),
        "{text}"
    );
    assert!(
        text.contains(&format!("WISPD_DATA_DIR={}\"\n", data.display())),
        "{text}"
    );

    let status = service("status");
    assert!(status.contains("installed: true"), "{status}");
    assert!(status.contains("loaded: true"), "{status}");
    assert!(status.contains("running: false"), "{status}");

    assert_eq!(service("uninstall"), format!("uninstalled {LABEL}\n"));
    assert!(!unit.exists());

    // An enable link left behind for a unit systemd didn't load is removed too.
    let wants = unit.with_file_name("default.target.wants");
    let link = wants.join(format!("{LABEL}.service"));
    fs::create_dir(&wants).unwrap();
    std::os::unix::fs::symlink(&unit, &link).unwrap();
    assert_eq!(service("uninstall"), format!("uninstalled {LABEL}\n"));
    assert!(fs::symlink_metadata(&link).is_err());

    assert_eq!(service("uninstall"), format!("{LABEL} was not installed\n"));

    let show = format!("--user show --property=LoadState,MainPID {LABEL}.service");
    assert_eq!(
        fs::read_to_string(&calls).unwrap(),
        format!(
            "{show}\n\
             --user daemon-reload\n\
             --user enable {LABEL}.service\n\
             --user restart {LABEL}.service\n\
             {show}\n\
             {show}\n\
             --user disable --now {LABEL}.service\n\
             --user daemon-reload\n\
             {show}\n\
             --user daemon-reload\n\
             {show}\n"
        )
    );
}
