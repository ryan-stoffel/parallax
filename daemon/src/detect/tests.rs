//! Detection against a fake `claude`, so every test spawns a real process through the
//! supervisor. No test runs a real vendor CLI, and every fixture's
//! output is synthetic (invented for these tests), not captured from a real CLI; see #124.

use std::fs;
use std::os::unix::fs::PermissionsExt;
use std::path::PathBuf;
use std::time::Duration;

use tempfile::TempDir;

use super::CliDetector;
use crate::backend::process::{Environment, Launcher};
use crate::paths::DataDir;
use parallax_protocol::{AuthKind, CliKind, DetectedCli};

const FAKE_CLAUDE: &str = include_str!("fixtures/fake-claude.sh");

/// A sandbox with a `bin` folder on `PATH`, so tests can install whichever fake CLIs a scenario
/// needs and leave the rest absent (which detection reports as `installed: false`).
struct Fixture {
    dir: TempDir,
    bin: PathBuf,
}

impl Fixture {
    fn new() -> Self {
        let dir = tempfile::tempdir().unwrap();
        let bin = dir.path().join("bin");
        fs::create_dir(&bin).unwrap();
        Self { dir, bin }
    }

    fn root(&self) -> PathBuf {
        self.dir.path().canonicalize().unwrap()
    }

    fn install(&self, name: &str, script: &str) {
        let program = self.bin.join(name);
        fs::write(&program, script).unwrap();
        fs::set_permissions(&program, fs::Permissions::from_mode(0o755)).unwrap();
    }

    fn env(&self) -> Environment {
        let mut env = Environment::empty();
        env.set("PATH", format!("{}:/bin:/usr/bin", self.bin.display()));
        env
    }

    fn launcher(&self, env: Environment) -> Launcher {
        Launcher::new(DataDir::new(self.root().join("data")).unwrap(), env)
    }
}

async fn detect(fixture: &Fixture, env: Environment) -> Vec<DetectedCli> {
    let detector = CliDetector::new(fixture.launcher(env), Duration::from_secs(2));
    detector.refresh().await.clis
}

fn find(clis: &[DetectedCli], cli: CliKind) -> &DetectedCli {
    clis.iter().find(|detected| detected.cli == cli).unwrap()
}

#[tokio::test]
async fn an_installed_and_signed_in_cli_reports_its_plan_and_version() {
    let fixture = Fixture::new();
    fixture.install("claude", FAKE_CLAUDE);
    let mut env = fixture.env();
    env.set(
        "FAKE_CLI_STDOUT",
        r#"{"loggedIn":true,"authType":"subscription","subscriptionType":"max","version":"2.1.281"}"#,
    );
    let clis = detect(&fixture, env).await;
    let claude = find(&clis, CliKind::Claude);
    assert!(claude.installed, "{claude:?}");
    assert!(
        claude.path.as_ref().unwrap().ends_with("/bin/claude"),
        "{claude:?}"
    );
    assert_eq!(claude.version.as_deref(), Some("2.1.281"));
    assert_eq!(claude.signed_in, Some(true));
    assert_eq!(claude.auth_kind, Some(AuthKind::Subscription));
    assert_eq!(claude.plan.as_deref(), Some("max"));
    assert_eq!(claude.note, None);
}

#[tokio::test]
async fn a_status_command_that_never_answers_times_out_without_a_signed_in_state() {
    let fixture = Fixture::new();
    fixture.install("claude", FAKE_CLAUDE);
    let mut env = fixture.env();
    env.set("FAKE_CLI_SLEEP", "30");
    let detector = CliDetector::new(fixture.launcher(env), Duration::from_millis(200));
    let started = std::time::Instant::now();
    let clis = detector.refresh().await.clis;
    assert!(
        started.elapsed() < Duration::from_secs(5),
        "the timeout should cut this short"
    );
    let claude = find(&clis, CliKind::Claude);
    assert!(claude.installed);
    assert_eq!(claude.signed_in, None);
    assert!(
        claude
            .note
            .as_deref()
            .is_some_and(|note| note.contains("timed out")),
        "{claude:?}"
    );
}
