//! Version order, asset and placement choice, and installs from a fake release of `file://` URLs
//! (PLX-700). Nothing here reaches the network or restarts anything.

use std::cmp::Ordering;
use std::fs;
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};

use parallax_protocol::{ErrorKind, HostUpdateRestart};
use tempfile::TempDir;

use super::{
    Placement, SelfUpdate, asset_name, compare, install_release, parse_version, placement,
};
use crate::backend::process::{Environment, Launcher, find_program};
use crate::paths::DataDir;

/// A plxd that prints `plxd <the version beside it>`, with shell builtins only.
const FAKE_PLXD: &str = "#!/bin/sh\nread -r v < \"${0%/*}/plxd.version\"\necho \"plxd $v\"\n";

const NEW: &str = "2610.10912.13045-nightly";

/// The URL schemes the fake releases need.
const FILE: &str = "=https,file";

struct Fixture {
    dir: TempDir,
}

impl Fixture {
    fn new() -> Self {
        let fixture = Self {
            dir: tempfile::tempdir().unwrap(),
        };
        for dir in ["bin", "home", "release"] {
            fs::create_dir(fixture.path(dir)).unwrap();
        }
        let curl = find_program("curl".as_ref(), Some("/usr/bin:/bin".as_ref())).unwrap();
        std::os::unix::fs::symlink(curl, fixture.path("bin/curl")).unwrap();
        fixture
    }

    fn path(&self, name: &str) -> PathBuf {
        self.dir.path().canonicalize().unwrap().join(name)
    }

    fn launcher(&self) -> Launcher {
        let mut env = Environment::empty();
        env.set("PATH", self.path("bin"));
        Launcher::new(DataDir::new(self.path("data")).unwrap(), env)
    }

    /// The URL of a fake release folder holding `v<NEW>/<asset>` with `program` and its
    /// `.sha256`, whose hash is `checksum` when given. `None` on a platform without a release.
    fn release(&self, program: &str, checksum: Option<&str>) -> Option<String> {
        let name = asset_name(NEW, std::env::consts::OS, std::env::consts::ARCH).ok()?;
        let dir = self.path("release").join(format!("v{NEW}"));
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join(&name), program).unwrap();
        let hash = checksum.map_or_else(|| crate::sha256_hex(program.as_bytes()), str::to_owned);
        fs::write(
            dir.join(format!("{name}.sha256")),
            format!("{hash}  {name}\n"),
        )
        .unwrap();
        Some(format!("file://{}", self.path("release").display()))
    }

    /// An old plxd at `relative`, executable.
    fn old_plxd(&self, relative: &str) -> PathBuf {
        let exe = self.path(relative);
        fs::create_dir_all(exe.parent().unwrap()).unwrap();
        fs::write(&exe, "old").unwrap();
        fs::set_permissions(&exe, fs::Permissions::from_mode(0o755)).unwrap();
        exe
    }
}

fn leftovers(dir: &Path) -> Vec<String> {
    fs::read_dir(dir)
        .map(|entries| {
            entries
                .filter_map(Result::ok)
                .map(|e| e.file_name().to_string_lossy().into_owned())
                .filter(|name| name.starts_with(".plxd-update-"))
                .collect()
        })
        .unwrap_or_default()
}

#[test]
fn versions_compare_by_their_numbers_whatever_the_channel() {
    let v = |text: &str| parse_version(text).unwrap();
    assert_eq!(v("2610.10912.13045-nightly"), [2610, 10912, 13045]);
    assert_eq!(v("0.1.0"), [0, 1, 0]);
    assert_eq!(compare(&v("0.1.0"), &v("2610.10912.13045")), Ordering::Less);
    assert_eq!(
        compare(&v("2610.10912.13045"), &v("2610.10912.13045-nightly")),
        Ordering::Equal
    );
    // A later second, minute, and day.
    assert_eq!(
        compare(&v("2610.10912.13046"), &v("2610.10912.13045")),
        Ordering::Greater
    );
    assert_eq!(
        compare(&v("2610.11001.10000"), &v("2610.10923.15959")),
        Ordering::Greater
    );
    assert_eq!(compare(&v("1.2"), &v("1.2.0")), Ordering::Equal);
    for bad in ["", "v1.2", "1..2", "1.2-night ly", "1.2;rm", "../1", "1.x"] {
        assert_eq!(parse_version(bad), None, "{bad:?}");
    }
}

#[test]
fn the_asset_is_named_for_the_os_and_arch() {
    assert_eq!(
        asset_name(NEW, "macos", "aarch64").unwrap(),
        format!("parallax-plxd-{NEW}-mac-arm64")
    );
    assert_eq!(
        asset_name(NEW, "linux", "x86_64").unwrap(),
        format!("parallax-plxd-{NEW}-linux-x64")
    );
    assert_eq!(
        asset_name(NEW, "linux", "aarch64").unwrap(),
        format!("parallax-plxd-{NEW}-linux-arm64")
    );
    assert!(
        asset_name(NEW, "macos", "x86_64")
            .unwrap_err()
            .contains("Intel")
    );
    assert!(asset_name(NEW, "windows", "x86_64").is_err());
    assert!(asset_name(NEW, "linux", "riscv64").is_err());
}

#[test]
fn bundled_plxd_installs_beside_the_home_and_standalone_plxd_in_place() {
    let home = Path::new("/home/me");
    let shared = Placement::Shared(home.join(".parallax-plxd"));
    for bundled in [
        "/Applications/Parallax.app/Contents/Resources/plxd",
        "/opt/Parallax/resources/plxd",
        "/tmp/.mount_ParallaxAbc/resources/plxd",
        "/home/me/.parallax-plxd/plxd",
    ] {
        assert_eq!(
            placement(Path::new(bundled), home).unwrap(),
            shared,
            "{bundled}"
        );
    }
    for standalone in [
        "/home/me/.local/bin/plxd",
        "/usr/local/bin/plxd",
        "/home/me/debugging/plxd",
    ] {
        assert_eq!(
            placement(Path::new(standalone), home).unwrap(),
            Placement::InPlace(standalone.into()),
            "{standalone}"
        );
    }
    for dev in [
        "/src/parallax/target/debug/plxd",
        "/src/parallax/target/release/plxd",
        "/src/parallax/target/aarch64-apple-darwin/release/plxd",
        "/src/parallax/target/debug/deps/plxd-0123abcd",
    ] {
        let error = placement(Path::new(dev), home).unwrap_err();
        assert!(error.contains("development build"), "{dev}: {error}");
    }
}

#[tokio::test]
async fn a_standalone_plxd_is_replaced_in_place_with_its_version_beside_it() {
    let fixture = Fixture::new();
    let Some(releases) = fixture.release(FAKE_PLXD, None) else {
        return;
    };
    let exe = fixture.old_plxd("local/bin/plxd");
    let installed = install_release(
        &fixture.launcher(),
        &releases,
        FILE,
        NEW,
        &Placement::InPlace(exe.clone()),
        &fixture.path("home"),
    )
    .await
    .unwrap();
    assert_eq!(installed, exe);
    assert_eq!(fs::read_to_string(&exe).unwrap(), FAKE_PLXD);
    assert_eq!(
        fs::metadata(&exe).unwrap().permissions().mode() & 0o777,
        0o755
    );
    assert_eq!(
        fs::read_to_string(exe.with_file_name("plxd.version")).unwrap(),
        format!("{NEW}\n")
    );
    assert!(leftovers(exe.parent().unwrap()).is_empty());
    assert!(!fixture.path("home/.parallax-plxd").exists());
}

#[tokio::test]
async fn a_bundled_plxd_installs_to_parallax_plxd() {
    let fixture = Fixture::new();
    let Some(releases) = fixture.release(FAKE_PLXD, None) else {
        return;
    };
    let shared = fixture.path("home/.parallax-plxd");
    let installed = install_release(
        &fixture.launcher(),
        &releases,
        FILE,
        NEW,
        &Placement::Shared(shared.clone()),
        &fixture.path("home"),
    )
    .await
    .unwrap();
    assert_eq!(installed, shared.join("plxd"));
    assert_eq!(fs::read_to_string(&installed).unwrap(), FAKE_PLXD);
    assert_eq!(
        fs::read_to_string(shared.join("plxd.version")).unwrap(),
        format!("{NEW}\n")
    );
    assert!(leftovers(&shared).is_empty());
}

#[tokio::test]
async fn a_folder_plxd_cant_write_falls_back_to_parallax_plxd() {
    let fixture = Fixture::new();
    let Some(releases) = fixture.release(FAKE_PLXD, None) else {
        return;
    };
    let exe = fixture.old_plxd("locked/plxd");
    let locked = exe.parent().unwrap();
    fs::set_permissions(locked, fs::Permissions::from_mode(0o555)).unwrap();
    // Root writes anywhere, so there's nothing to fall back from.
    if tempfile::tempdir_in(locked).is_ok() {
        return;
    }
    let installed = install_release(
        &fixture.launcher(),
        &releases,
        FILE,
        NEW,
        &Placement::InPlace(exe.clone()),
        &fixture.path("home"),
    )
    .await
    .unwrap();
    fs::set_permissions(locked, fs::Permissions::from_mode(0o755)).unwrap();
    assert_eq!(installed, fixture.path("home/.parallax-plxd/plxd"));
    assert_eq!(fs::read_to_string(&exe).unwrap(), "old");
}

#[tokio::test]
async fn a_checksum_mismatch_or_a_plxd_that_wont_run_replaces_nothing() {
    let fixture = Fixture::new();
    let Some(releases) = fixture.release(FAKE_PLXD, Some(&"a".repeat(64))) else {
        return;
    };
    let exe = fixture.old_plxd("local/bin/plxd");
    let placement = Placement::InPlace(exe.clone());
    let home = fixture.path("home");
    let error = install_release(&fixture.launcher(), &releases, FILE, NEW, &placement, &home)
        .await
        .unwrap_err();
    assert!(error.contains("SHA-256"), "{error}");

    let releases = fixture
        .release("#!/bin/sh\necho broken >&2\nexit 1\n", None)
        .unwrap();
    let error = install_release(&fixture.launcher(), &releases, FILE, NEW, &placement, &home)
        .await
        .unwrap_err();
    assert!(error.contains("doesn't run"), "{error}");
    assert!(error.contains("broken"), "{error}");

    // A real host downloads over HTTPS only, so a `file://` release is refused.
    let releases = fixture.release(FAKE_PLXD, None).unwrap();
    let error = install_release(
        &fixture.launcher(),
        &releases,
        "=https",
        NEW,
        &placement,
        &home,
    )
    .await
    .unwrap_err();
    assert!(error.starts_with("Couldn't download"), "{error}");

    let error = install_release(
        &fixture.launcher(),
        "file:///nonexistent",
        FILE,
        NEW,
        &placement,
        &home,
    )
    .await
    .unwrap_err();
    assert!(error.starts_with("Couldn't download"), "{error}");

    assert_eq!(fs::read_to_string(&exe).unwrap(), "old");
    assert!(!exe.with_file_name("plxd.version").exists());
    assert!(leftovers(exe.parent().unwrap()).is_empty());
}

#[tokio::test]
async fn host_update_never_downgrades_and_answers_when_it_restarts() {
    let fixture = Fixture::new();
    let releases = fixture.release(FAKE_PLXD, None);
    let exe = fixture.old_plxd("local/bin/plxd");
    let update = |current: &str, releases: &str| {
        SelfUpdate::for_tests(
            fixture.launcher(),
            releases,
            &exe,
            &fixture.path("home"),
            current,
        )
    };
    let kind =
        |error: &parallax_protocol::jsonrpc::ErrorObject| error.parallax_data().unwrap().kind;

    let newer = update("2610.10912.13046", "file:///nonexistent");
    let error = newer.install(NEW, 0, false).await.unwrap_err();
    assert_eq!(kind(&error), ErrorKind::HostUpdateFailed);
    assert!(
        error.message.contains("never downgrades"),
        "{}",
        error.message
    );

    let same = update("2610.10912.13045", "file:///nonexistent");
    let answer = same.install(NEW, 3, false).await.unwrap();
    assert_eq!(answer.restart, HostUpdateRestart::UpToDate);

    let error = same.install("2611.1.1;reboot", 0, false).await.unwrap_err();
    assert!(
        error.message.contains("isn't a Parallax release"),
        "{}",
        error.message
    );

    let Some(releases) = releases else {
        return;
    };
    let old = update("0.1.0", &releases);
    let answer = old.install(NEW, 2, false).await.unwrap();
    assert_eq!(answer.restart, HostUpdateRestart::AfterRuns);
    assert_eq!(answer.running_agents, 2);
    assert_eq!(answer.version, NEW);
    assert!(
        answer.message.contains("2 running agents"),
        "{}",
        answer.message
    );
    assert_eq!(fs::read_to_string(&exe).unwrap(), FAKE_PLXD);
    assert_eq!(old.installed(), Some(exe.clone()));

    // Asked `now`, it restarts at once, interrupting them.
    let now = old.install(NEW, 2, true).await.unwrap();
    assert_eq!(now.restart, HostUpdateRestart::Now);
    assert!(
        now.message.contains("interrupting its 2"),
        "{}",
        now.message
    );

    // Installed already: the same answer, without downloading again.
    fs::remove_dir_all(fixture.path("release")).unwrap();
    let again = old.install(NEW, 0, false).await.unwrap();
    assert_eq!(again.restart, HostUpdateRestart::Now);
}

#[tokio::test]
async fn a_development_build_refuses_to_update() {
    let fixture = Fixture::new();
    let exe = fixture.old_plxd("parallax/target/debug/plxd");
    let update = SelfUpdate::for_tests(
        fixture.launcher(),
        "file:///nonexistent",
        &exe,
        &fixture.path("home"),
        "0.1.0",
    );
    let error = update.install(NEW, 0, false).await.unwrap_err();
    assert!(
        error.message.contains("development build"),
        "{}",
        error.message
    );
    assert_eq!(fs::read_to_string(&exe).unwrap(), "old");
}

#[test]
fn a_plxd_its_service_runs_exits_for_the_service_to_restart_it() {
    use super::{Handover, fallback, in_unit_cgroup, run_by_service};

    let program = PathBuf::from("/home/u/.local/bin/plxd");
    assert_eq!(fallback(program.clone(), true), Handover::Exit);
    assert_eq!(fallback(program.clone(), false), Handover::Spawn(program));

    // The manager names this process as its service's.
    assert!(run_by_service(Some(42), 42, false));
    // Another process, or none: only the hint decides.
    assert!(!run_by_service(Some(7), 42, false));
    assert!(!run_by_service(None, 42, false));
    assert!(run_by_service(None, 42, true));

    let unit = "io.github.ryan-stoffel.parallax.plxd.service";
    let in_unit = format!("0::/user.slice/user-1000.slice/user@1000.service/app.slice/{unit}\n");
    assert!(in_unit_cgroup(&in_unit, unit));
    // cgroup v1 lines, one per controller.
    assert!(in_unit_cgroup(
        &format!("12:pids:/user.slice/user@1000.service/{unit}\n1:name=systemd:/x\n"),
        unit
    ));
    // A terminal's scope, or another unit whose name only starts the same.
    assert!(!in_unit_cgroup(
        "0::/user.slice/user-1000.slice/session-3.scope\n",
        unit
    ));
    assert!(!in_unit_cgroup(
        &format!("0::/user.slice/user@1000.service/app.slice/{unit}.d\n"),
        unit
    ));
}

/// PLX-746: the handover waits for running agents unless asked `now`, and always for a download,
/// which may be a newer release than the one it would hand over to.
#[test]
fn the_handover_waits_for_agents_unless_now_and_for_a_download() {
    let fixture = Fixture::new();
    let exe = fixture.old_plxd("local/bin/plxd");
    let update = SelfUpdate::for_tests(
        fixture.launcher(),
        "file:///nonexistent",
        &exe,
        &fixture.path("home"),
        "0.1.0",
    );
    assert!(!update.waits(0));
    assert!(update.waits(2));
    super::lock(&update.state).now = true;
    assert!(!update.waits(2));
    super::lock(&update.state).busy = true;
    assert!(update.waits(0));
}
