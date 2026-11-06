//! Installs from a fake release of `file://` URLs, with a `sh` script for plxd (PLX-700). Nothing
//! here reaches the network or restarts anything.

use std::fs;
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};

use parallax_protocol::{ErrorKind, HostUpdateRestart};
use tempfile::TempDir;

use super::{Placement, SelfUpdate, asset_name, install_release};
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

    /// Installs [`NEW`] from `releases` over the URL schemes in `protocols`, where `placement`
    /// says, for the fixture's home.
    async fn install(
        &self,
        releases: &str,
        protocols: &str,
        placement: &Placement,
    ) -> Result<(String, PathBuf), String> {
        let home = self.path("home");
        install_release(&self.launcher(), releases, protocols, NEW, placement, &home).await
    }

    /// The self-update of the plxd at `exe`, which runs `current`, installing from `releases`.
    fn update(&self, exe: &Path, releases: &str, current: &str) -> SelfUpdate {
        SelfUpdate::for_tests(self.launcher(), releases, exe, &self.path("home"), current)
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

#[tokio::test]
async fn a_standalone_plxd_is_replaced_in_place_with_its_version_beside_it() {
    let fixture = Fixture::new();
    let Some(releases) = fixture.release(FAKE_PLXD, None) else {
        return;
    };
    let exe = fixture.old_plxd("local/bin/plxd");
    let installed = fixture
        .install(&releases, FILE, &Placement::InPlace(exe.clone()))
        .await
        .unwrap();
    assert_eq!(installed, (NEW.to_owned(), exe.clone()));
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
async fn a_checksum_mismatch_or_a_plxd_that_wont_run_replaces_nothing() {
    let fixture = Fixture::new();
    let Some(releases) = fixture.release(FAKE_PLXD, Some(&"a".repeat(64))) else {
        return;
    };
    let exe = fixture.old_plxd("local/bin/plxd");
    let placement = Placement::InPlace(exe.clone());
    let error = fixture
        .install(&releases, FILE, &placement)
        .await
        .unwrap_err();
    assert!(error.contains("SHA-256"), "{error}");

    let releases = fixture
        .release("#!/bin/sh\necho broken >&2\nexit 1\n", None)
        .unwrap();
    let error = fixture
        .install(&releases, FILE, &placement)
        .await
        .unwrap_err();
    assert!(error.contains("doesn't run"), "{error}");
    assert!(error.contains("broken"), "{error}");

    // A real host downloads over HTTPS only, so a `file://` release is refused.
    let releases = fixture.release(FAKE_PLXD, None).unwrap();
    let error = fixture
        .install(&releases, "=https", &placement)
        .await
        .unwrap_err();
    assert!(error.starts_with("Couldn't download"), "{error}");

    let error = fixture
        .install("file:///nonexistent", FILE, &placement)
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
    let update = |current: &str, releases: &str| fixture.update(&exe, releases, current);
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
