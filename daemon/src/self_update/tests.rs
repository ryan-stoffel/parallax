//! What `host/update` decides on every OS (PLX-700, PLX-825): version order, asset names, where an
//! update goes, a copy that isn't older, and Windows' rename-aside. Nothing here downloads or
//! restarts anything. `install_tests` installs from fake releases on Unix.

use std::cmp::Ordering;
use std::fs;
use std::path::{Path, PathBuf};

use parallax_protocol::HostUpdateRestart;

use super::{
    ASIDE, PLXD, Placement, SelfUpdate, asset_name, compare, not_older, parse_version, placement,
    remove_aside, set_aside,
};
use crate::backend::process::{Environment, Launcher};
use crate::paths::DataDir;

const NEW: &str = "2610.10912.13045-nightly";

/// A version before [`NEW`], and one after.
const OLDER: &str = "2610.10901.10000";
const NEWER: &str = "2610.11001.10000-nightly";

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
    for (os, arch, name) in [
        ("macos", "aarch64", "mac-arm64"),
        ("linux", "x86_64", "linux-x64"),
        ("linux", "aarch64", "linux-arm64"),
        ("windows", "x86_64", "win-x64.exe"),
        ("windows", "aarch64", "win-arm64.exe"),
    ] {
        assert_eq!(
            asset_name(NEW, os, arch).unwrap(),
            format!("parallax-plxd-{NEW}-{name}")
        );
    }
    assert!(
        asset_name(NEW, "macos", "x86_64")
            .unwrap_err()
            .contains("Intel")
    );
    assert!(asset_name(NEW, "freebsd", "x86_64").is_err());
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

/// An NSIS install's `resources\`, and the copy itself, install to `%USERPROFILE%\.parallax-plxd`.
#[cfg(windows)]
#[test]
fn a_windows_install_goes_to_parallax_plxd() {
    let home = Path::new(r"C:\Users\me");
    let shared = Placement::Shared(home.join(".parallax-plxd"));
    for bundled in [
        r"C:\Users\me\AppData\Local\Programs\Parallax\resources\plxd.exe",
        r"C:\Users\me\.parallax-plxd\plxd.exe",
    ] {
        assert_eq!(
            placement(Path::new(bundled), home).unwrap(),
            shared,
            "{bundled}"
        );
    }
    let error = placement(Path::new(r"D:\parallax\target\debug\plxd.exe"), home).unwrap_err();
    assert!(error.contains("development build"), "{error}");
}

/// A plxd in `dir` that reports `version`, by the `plxd.version` beside it.
fn copy_in(dir: &Path, version: &str) -> PathBuf {
    fs::create_dir_all(dir).unwrap();
    fs::write(dir.join(crate::VERSION_FILE), format!("{version}\n")).unwrap();
    let program = dir.join(PLXD);
    fs::write(&program, "copy").unwrap();
    program
}

#[test]
fn only_a_copy_that_is_there_and_not_older_counts() {
    let dir = tempfile::tempdir().unwrap();
    let program = copy_in(dir.path(), NEW);
    assert_eq!(not_older(&program, NEW).as_deref(), Some(NEW));
    assert_eq!(not_older(&program, OLDER).as_deref(), Some(NEW));
    assert_eq!(not_older(&program, NEWER), None);
    fs::remove_file(&program).unwrap();
    assert_eq!(not_older(&program, OLDER), None, "a plxd.version alone");
}

/// PLX-825: the app refreshed the copy to [`NEWER`] while the plxd running it is still
/// [`OLDER`], and another computer's app asks for [`NEW`]. plxd hands over to the copy, and
/// downloads nothing: this release has none.
#[tokio::test]
async fn host_update_hands_over_to_a_copy_that_isnt_older_instead_of_writing_over_it() {
    if asset_name(NEW, std::env::consts::OS, std::env::consts::ARCH).is_err() {
        return;
    }
    let temp = tempfile::tempdir().unwrap();
    let home = temp.path().join("home");
    let program = copy_in(&home.join(".parallax-plxd"), NEWER);
    let launcher = Launcher::new(
        DataDir::new(temp.path().join("data")).unwrap(),
        Environment::empty(),
    );
    let update = SelfUpdate::for_tests(launcher, "file:///nonexistent", &program, &home, OLDER);

    let answer = update.install(NEW, 0, false).await.unwrap();
    assert_eq!(answer.version, NEWER);
    assert_eq!(answer.restart, HostUpdateRestart::Now);
    assert_eq!(update.installed(), Some(program.clone()));
    assert_eq!(fs::read_to_string(&program).unwrap(), "copy");
    let version = fs::read_to_string(program.with_file_name(crate::VERSION_FILE)).unwrap();
    assert_eq!(version, format!("{NEWER}\n"));
}

/// Windows renames a running plxd.exe but won't replace it, so the old one moves aside, over an
/// earlier one, and the next `serve` deletes it.
#[tokio::test]
async fn a_replaced_plxd_moves_aside_and_the_next_start_deletes_it() {
    let dir = tempfile::tempdir().unwrap();
    let program = dir.path().join(PLXD);
    let aside = dir.path().join(ASIDE);
    fs::write(&aside, "earlier").unwrap();
    fs::write(&program, "running").unwrap();

    set_aside(&program);
    assert!(!program.exists());
    assert_eq!(fs::read_to_string(&aside).unwrap(), "running");
    // Nothing to move: the earlier one stays.
    set_aside(&program);
    assert_eq!(fs::read_to_string(&aside).unwrap(), "running");

    remove_aside(program.clone()).await;
    assert!(!aside.exists());
    // Nothing to delete: it returns at once.
    remove_aside(program).await;
}
