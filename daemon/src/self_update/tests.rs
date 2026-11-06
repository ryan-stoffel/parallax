//! What `host/update` decides on every OS (PLX-700, PLX-825): version order, where an update goes,
//! handing over to a copy that isn't older, and putting the old plxd back when a move fails.
//! Nothing here downloads or restarts anything. `install_tests` installs from fake releases on Unix.

use std::cmp::Ordering;
use std::fs;
use std::path::{Path, PathBuf};

use parallax_protocol::HostUpdateRestart;

use super::{
    ASIDE, PLXD, Placement, SelfUpdate, asset_name, compare, move_in, parse_version, placement,
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

/// A plxd in `dir` that reports `version`, by the `plxd.version` beside it.
fn copy_in(dir: &Path, version: &str) -> PathBuf {
    fs::create_dir_all(dir).unwrap();
    fs::write(dir.join(crate::VERSION_FILE), format!("{version}\n")).unwrap();
    let program = dir.join(PLXD);
    fs::write(&program, "copy").unwrap();
    program
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

/// A new plxd that can't move in puts the one it set aside back, so none goes missing.
#[test]
fn a_failed_move_in_puts_the_old_plxd_back() {
    let dir = tempfile::tempdir().unwrap();
    let program = dir.path().join(PLXD);
    fs::write(&program, "running").unwrap();

    let error = move_in(&dir.path().join("missing"), &program, true).unwrap_err();
    assert!(error.contains("Couldn't move plxd into"), "{error}");
    assert_eq!(fs::read_to_string(&program).unwrap(), "running");
    assert!(!dir.path().join(ASIDE).exists());

    let new = dir.path().join("new");
    fs::write(&new, "new").unwrap();
    move_in(&new, &program, true).unwrap();
    assert_eq!(fs::read_to_string(&program).unwrap(), "new");
    assert_eq!(
        fs::read_to_string(dir.path().join(ASIDE)).unwrap(),
        "running"
    );
}
