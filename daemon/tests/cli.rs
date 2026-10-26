use std::process::{Command, Output};

#[cfg(unix)]
#[path = "common/temp.rs"]
mod temp;

fn plxd(args: &[&str]) -> Output {
    Command::new(env!("CARGO_BIN_EXE_plxd"))
        .args(args)
        .env_remove("PLXD_LOG")
        .env_remove("PLXD_DATA_DIR")
        .output()
        .expect("plxd should run")
}

/// A packaged plxd reports the version the app's package step wrote beside it (0030).
#[test]
fn version_prints_the_version_file_beside_the_executable() {
    let dir = tempfile::tempdir().expect("temp dir");
    let exe = dir.path().join(
        std::path::Path::new(env!("CARGO_BIN_EXE_plxd"))
            .file_name()
            .unwrap(),
    );
    std::fs::copy(env!("CARGO_BIN_EXE_plxd"), &exe).expect("copy plxd");
    std::fs::write(
        dir.path().join(plxd::VERSION_FILE),
        "2609.13017.14512-nightly\n",
    )
    .unwrap();

    let output = Command::new(&exe)
        .arg("--version")
        .output()
        .expect("plxd should run");

    assert!(output.status.success(), "{output:?}");
    assert_eq!(
        String::from_utf8_lossy(&output.stdout),
        "plxd 2609.13017.14512-nightly\n"
    );
}

// The refusal comes before anything touches launchd or `~/Library/LaunchAgents`, so this never
// installs a real LaunchAgent.
#[cfg(target_os = "macos")]
#[test]
fn service_install_refuses_the_default_label_for_another_data_folder() {
    let temp = temp::temp_dir();
    let data_dir = temp.path().join("data");
    let output = Command::new(env!("CARGO_BIN_EXE_plxd"))
        .args(["service", "install", "--data-dir"])
        .arg(&data_dir)
        .env_remove("PLXD_LOG")
        .env_remove("PLXD_DATA_DIR")
        .env_remove("PLXD_SERVICE_LABEL")
        .output()
        .expect("plxd should run");

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

// `plxd service` on Linux, against a stand-in `systemctl` on `PATH` and a temporary home folder,
// so it needs no user manager and never touches a real one. The stand-in records its arguments,
// and `show` reports the unit loaded once its file exists, as systemd would. A stand-in `loginctl`
// reports lingering off and refuses to turn it on, which only warns.
#[cfg(target_os = "linux")]
#[test]
#[expect(
    clippy::too_many_lines,
    reason = "install, status, and uninstall step by step, with their stand-ins"
)]
fn service_installs_reports_and_uninstalls_a_systemd_user_unit() {
    use std::fs;
    use std::os::unix::fs::PermissionsExt;

    const LABEL: &str = "io.github.ryan-stoffel.parallax.plxd.cli-test";
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
    let loginctl = bin.join("loginctl");
    fs::write(
        &loginctl,
        format!(
            "#!/bin/sh\n\
             echo \"loginctl $*\" >> '{calls}'\n\
             if [ \"$1\" = show-user ]; then echo Linger=no; else echo 'Access denied' >&2; exit 1; fi\n",
            calls = calls.display(),
        ),
    )
    .unwrap();
    fs::set_permissions(&loginctl, fs::Permissions::from_mode(0o755)).unwrap();
    let path = format!(
        "{}:{}",
        bin.display(),
        std::env::var("PATH").unwrap_or_default()
    );
    let service = |command: &str| {
        let output = Command::new(env!("CARGO_BIN_EXE_plxd"))
            .args(["service", command, "--label", LABEL, "--data-dir"])
            .arg(&data)
            .env("PATH", &path)
            .env("HOME", &home)
            .env_remove("XDG_CONFIG_HOME")
            .env_remove("XDG_DATA_HOME")
            .env_remove("PLXD_LOG")
            .env_remove("PLXD_DATA_DIR")
            .env_remove("PLXD_SERVICE_LABEL")
            .output()
            .expect("plxd should run");
        assert!(output.status.success(), "{command}: {output:?}");
        (
            String::from_utf8_lossy(&output.stdout).into_owned(),
            String::from_utf8_lossy(&output.stderr).into_owned(),
        )
    };

    let (stdout, stderr) = service("install");
    assert_eq!(stdout, format!("installed and started {LABEL}\n"));
    assert!(
        stderr.contains("warning: `loginctl --no-ask-password enable-linger"),
        "{stderr}"
    );
    let text = fs::read_to_string(&unit).unwrap();
    assert!(
        text.contains(&format!(
            "ExecStart=\"{}\" serve\n",
            env!("CARGO_BIN_EXE_plxd")
        )),
        "{text}"
    );
    assert!(
        text.contains(&format!("PLXD_DATA_DIR={}\"\n", data.display())),
        "{text}"
    );

    let (status, _) = service("status");
    assert!(status.contains("installed: true"), "{status}");
    assert!(status.contains("loaded: true"), "{status}");
    assert!(status.contains("running: false"), "{status}");

    assert_eq!(service("uninstall").0, format!("uninstalled {LABEL}\n"));
    assert!(!unit.exists());

    // An enable link left behind for a unit systemd didn't load is removed too.
    let wants = unit.with_file_name("default.target.wants");
    let link = wants.join(format!("{LABEL}.service"));
    fs::create_dir(&wants).unwrap();
    std::os::unix::fs::symlink(&unit, &link).unwrap();
    assert_eq!(service("uninstall").0, format!("uninstalled {LABEL}\n"));
    assert!(fs::symlink_metadata(&link).is_err());

    assert_eq!(
        service("uninstall").0,
        format!("{LABEL} was not installed\n")
    );

    let show = format!("--user show --property=LoadState,MainPID {LABEL}.service");
    let uid = rustix::process::getuid().as_raw();
    assert_eq!(
        fs::read_to_string(&calls).unwrap(),
        format!(
            "{show}\n\
             --user daemon-reload\n\
             --user enable {LABEL}.service\n\
             loginctl show-user {uid} --property=Linger\n\
             loginctl --no-ask-password enable-linger {uid}\n\
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

/// `plxd dial` bridges stdin and stdout to a TCP peer, half-closing when stdin ends, and exits 0
/// once the peer closes (0056).
#[test]
fn dial_bridges_stdio_to_the_address_and_half_closes() {
    use std::io::{Read as _, Write as _};

    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let address = listener.local_addr().unwrap().to_string();
    let echo = std::thread::spawn(move || {
        let (mut stream, _) = listener.accept().unwrap();
        let mut received = Vec::new();
        stream.read_to_end(&mut received).unwrap();
        stream.write_all(&received).unwrap();
    });
    let mut child = Command::new(env!("CARGO_BIN_EXE_plxd"))
        .args(["dial", &address])
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .expect("plxd should run");
    child
        .stdin
        .take()
        .unwrap()
        .write_all(b"{\"jsonrpc\":\"2.0\"}\n")
        .unwrap();
    let output = child.wait_with_output().unwrap();
    echo.join().unwrap();

    assert!(output.status.success(), "{output:?}");
    assert_eq!(output.stdout, b"{\"jsonrpc\":\"2.0\"}\n");
}

#[test]
fn connect_on_stores_the_setting_in_the_data_folder() {
    let dir = tempfile::tempdir().expect("temp dir");
    let data_dir = dir.path().join("data");
    let output = plxd(&["connect", "on", "--data-dir", data_dir.to_str().unwrap()]);

    assert!(output.status.success(), "{output:?}");
    assert_eq!(output.stdout, b"Parallax Connect is on.\n");
    let store = parallax_store::Store::open(data_dir.join("plxd.sqlite3")).unwrap();
    assert!(store.connect().unwrap());
}
