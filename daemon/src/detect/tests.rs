//! Detection against fake `claude`, `codex`, and `agent` binaries on `PATH`, so every test spawns
//! a real process through the supervisor. No test runs a real vendor CLI, and every fixture's
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
const FAKE_CODEX: &str = include_str!("fixtures/fake-codex.sh");
const FAKE_AGENT: &str = include_str!("fixtures/fake-agent.sh");

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
async fn an_installed_and_signed_out_cli_reports_no_plan_or_auth_kind() {
    let fixture = Fixture::new();
    fixture.install("codex", FAKE_CODEX);
    let mut env = fixture.env();
    env.set("FAKE_CLI_EXIT", "1");
    let clis = detect(&fixture, env).await;
    let codex = find(&clis, CliKind::Codex);
    assert!(codex.installed, "{codex:?}");
    assert_eq!(codex.signed_in, Some(false));
    assert_eq!(codex.auth_kind, None);
    assert_eq!(codex.plan, None);
    assert_eq!(codex.note, None);
}

#[tokio::test]
async fn a_cli_absent_from_path_is_reported_not_installed_and_nothing_else() {
    let fixture = Fixture::new();
    // No fake binaries installed at all.
    let clis = detect(&fixture, fixture.env()).await;
    for cli in [CliKind::Claude, CliKind::Codex, CliKind::Cursor] {
        let detected = find(&clis, cli);
        assert_eq!(
            *detected,
            DetectedCli {
                cli,
                installed: false,
                path: None,
                version: None,
                signed_in: None,
                auth_kind: None,
                plan: None,
                note: None,
            }
        );
    }
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

#[tokio::test]
async fn garbage_output_with_a_documented_exit_code_falls_back_to_it() {
    let fixture = Fixture::new();
    fixture.install("agent", FAKE_AGENT);
    let mut env = fixture.env();
    env.set("FAKE_CLI_STDOUT", "not json at all {{{");
    // 0004: exit 0 means signed in, even without a parseable body.
    env.set("FAKE_CLI_EXIT", "0");
    let clis = detect(&fixture, env).await;
    let cursor = find(&clis, CliKind::Cursor);
    assert!(cursor.installed, "{cursor:?}");
    assert_eq!(cursor.signed_in, Some(true));
    assert_eq!(
        cursor.note, None,
        "the documented exit code is enough; no note is needed"
    );
}

#[tokio::test]
async fn an_undocumented_exit_code_with_unparseable_output_leaves_signed_in_unknown() {
    let fixture = Fixture::new();
    fixture.install("agent", FAKE_AGENT);
    let mut env = fixture.env();
    env.set("FAKE_CLI_STDOUT", "not json at all {{{");
    env.set("FAKE_CLI_STDERR", "internal error\n");
    env.set("FAKE_CLI_EXIT", "2");
    let clis = detect(&fixture, env).await;
    let cursor = find(&clis, CliKind::Cursor);
    assert!(cursor.installed, "{cursor:?}");
    assert_eq!(cursor.signed_in, None);
    assert!(
        cursor.note.as_ref().is_some_and(|note| note.contains('2')),
        "{cursor:?}"
    );
}

#[tokio::test]
async fn cursors_plan_comes_from_a_separate_about_command_only_when_signed_in() {
    let fixture = Fixture::new();
    fixture.install("agent", FAKE_AGENT);
    let mut env = fixture.env();
    env.set(
        "FAKE_CLI_STDOUT",
        r#"{"loggedIn":true,"authType":"subscription"}"#,
    );
    env.set(
        "FAKE_CLI_ABOUT_STDOUT",
        "Cursor CLI 2026.09.23\nSubscription Tier: Pro+\n",
    );
    let clis = detect(&fixture, env).await;
    let cursor = find(&clis, CliKind::Cursor);
    assert_eq!(cursor.signed_in, Some(true));
    assert_eq!(cursor.plan.as_deref(), Some("Pro+"));

    // Signed out: `about` is never consulted, even though its variables are set.
    let fixture = Fixture::new();
    fixture.install("agent", FAKE_AGENT);
    let mut env = fixture.env();
    env.set("FAKE_CLI_EXIT", "1");
    env.set("FAKE_CLI_ABOUT_STDOUT", "Subscription Tier: Pro+\n");
    let clis = detect(&fixture, env).await;
    let cursor = find(&clis, CliKind::Cursor);
    assert_eq!(cursor.signed_in, Some(false));
    assert_eq!(cursor.plan, None);
}

#[tokio::test]
async fn codexs_plan_comes_from_the_app_server_only_when_signed_in() {
    let fixture = Fixture::new();
    fixture.install("codex", FAKE_CODEX);
    let mut env = fixture.env();
    env.set("FAKE_CLI_EXIT", "0");
    env.set(
        "FAKE_CLI_APP_SERVER_RESPONSE",
        r#"{"id":1,"result":{"planType":"plus"}}"#,
    );
    let clis = detect(&fixture, env).await;
    let codex = find(&clis, CliKind::Codex);
    assert_eq!(codex.signed_in, Some(true));
    assert_eq!(codex.auth_kind, Some(AuthKind::Subscription));
    assert_eq!(codex.plan.as_deref(), Some("plus"));
    // A worker's version check reads it (0013).
    assert_eq!(codex.version.as_deref(), Some("0.157.1"));
}

#[tokio::test]
async fn a_malformed_app_server_reply_leaves_the_plan_absent_without_failing_detection() {
    let fixture = Fixture::new();
    fixture.install("codex", FAKE_CODEX);
    let mut env = fixture.env();
    env.set("FAKE_CLI_EXIT", "0");
    env.set("FAKE_CLI_APP_SERVER_RESPONSE", "not even json");
    let clis = detect(&fixture, env).await;
    let codex = find(&clis, CliKind::Codex);
    assert_eq!(codex.signed_in, Some(true));
    assert_eq!(codex.plan, None);
}

#[tokio::test]
async fn a_cached_list_is_reused_until_a_refresh_or_the_ttl() {
    let fixture = Fixture::new();
    fixture.install("claude", FAKE_CLAUDE);
    let mut env = fixture.env();
    env.set("FAKE_CLI_STDOUT", r#"{"loggedIn":false}"#);
    let detector = CliDetector::new(fixture.launcher(env), Duration::from_secs(2));

    let first = detector.list().await;
    assert_eq!(find(&first.clis, CliKind::Claude).signed_in, Some(false));

    // Changing the fake CLI's answer has no effect on `list` until `refresh` is called: the
    // detector holds no reference back to the environment, so this only proves the cache, not a
    // live re-read, but a second `list` still returning the same value is exactly the contract.
    let second = detector.list().await;
    assert_eq!(
        second, first,
        "list() should serve the cache, not probe again"
    );

    let refreshed = detector.refresh().await;
    assert_eq!(
        find(&refreshed.clis, CliKind::Claude).signed_in,
        Some(false)
    );
}

#[tokio::test]
async fn get_probes_only_the_cli_asked_for() {
    let fixture = Fixture::new();
    // Each fake CLI logs what it's asked to a file of its own.
    let log = |name: &str| fixture.root().join(format!("{name}.log"));
    let fake = |name: &str, answer: &str| {
        let script = format!(
            "#!/bin/sh\necho \"$*\" >> '{}'\n{answer}\n",
            log(name).display()
        );
        fixture.install(name, &script);
    };
    fake(
        "claude",
        r#"case "$*" in "auth status") echo '{"loggedIn":true}';; esac"#,
    );
    fake("agent", "exit 0");
    let status_runs = |name: &str| {
        std::fs::read_to_string(log(name))
            .unwrap_or_default()
            .lines()
            .filter(|line| line.starts_with("auth status") || line.starts_with("status"))
            .count()
    };
    let detector = CliDetector::new(fixture.launcher(fixture.env()), Duration::from_secs(2));

    let claude = detector.get(CliKind::Claude).await;
    assert_eq!(claude.signed_in, Some(true));
    assert_eq!(status_runs("claude"), 1);
    assert_eq!(
        status_runs("agent"),
        0,
        "asking for Claude ran Cursor's status"
    );

    // A second ask is served from the first probe.
    assert_eq!(detector.get(CliKind::Claude).await, claude);
    assert_eq!(status_runs("claude"), 1);

    // The full list probes Cursor, so the check above could have failed, and the list serves what
    // `refresh_one` just probed rather than the older entry.
    detector.list().await;
    assert_eq!(status_runs("agent"), 1);
    detector.refresh_one(CliKind::Claude).await;
    assert_eq!(
        status_runs("claude"),
        3,
        "list and refresh_one each probed Claude"
    );
    detector.list().await;
    detector.get(CliKind::Claude).await;
    assert_eq!(status_runs("claude"), 3, "both were served from the cache");
}

/// Proves detection never opens a vendor's credential files: with sentinel files under fake
/// `.claude`, `.codex`, and `.cursor` folders made unreadable (mode 0), a full `refresh()` still
/// succeeds and the files are exactly as they were. `detect.rs` has no code path that reads a path
/// under `$HOME` at all (unlike `paths.rs` and `service.rs`, which read plxd's own data folder);
/// this test guards against that ever changing, without needing `std::env::set_var` (unsafe, and
/// this workspace denies `unsafe_code`) since the sandboxed `HOME` is only threaded into the fake
/// CLIs' own environment, exactly as a real plxd would hand it to a real vendor CLI.
#[tokio::test]
async fn detection_never_touches_files_under_vendor_config_directories() {
    let fixture = Fixture::new();
    fixture.install("claude", FAKE_CLAUDE);
    fixture.install("codex", FAKE_CODEX);
    fixture.install("agent", FAKE_AGENT);

    let home = fixture.dir.path().join("home");
    fs::create_dir(&home).unwrap();
    let mut sentinels = Vec::new();
    for (config_dir, file_name) in [
        (".claude", "credentials.json"),
        (".codex", "auth.json"),
        (".cursor", "cli-config.json"),
    ] {
        let dir = home.join(config_dir);
        fs::create_dir(&dir).unwrap();
        let file = dir.join(file_name);
        fs::write(&file, b"{\"token\":\"should-never-be-read\"}").unwrap();
        fs::set_permissions(&file, fs::Permissions::from_mode(0o000)).unwrap();
        sentinels.push(file);
    }

    let mut env = fixture.env();
    env.set("HOME", home.display().to_string());
    env.set("FAKE_CLI_STDOUT", r#"{"loggedIn":true}"#);
    env.set("FAKE_CLI_ABOUT_STDOUT", "Subscription Tier: Pro+\n");
    env.set(
        "FAKE_CLI_APP_SERVER_RESPONSE",
        r#"{"id":1,"result":{"planType":"plus"}}"#,
    );
    let clis = detect(&fixture, env).await;
    assert_eq!(clis.len(), 3);

    for file in &sentinels {
        let metadata = fs::metadata(file).unwrap();
        assert_eq!(
            metadata.permissions().mode() & 0o777,
            0,
            "{file:?} permissions changed, so something touched it"
        );
        assert!(
            fs::read(file).is_err(),
            "{file:?} became readable to this process, which should never have happened"
        );
    }
}

#[tokio::test]
async fn a_version_missing_from_auth_status_comes_from_the_version_banner() {
    let fixture = Fixture::new();
    fixture.install(
        "claude",
        "#!/bin/sh\n\
         if [ \"$1\" = --version ]; then echo '2.1.300 (Claude Code)'; exit 0; fi\n\
         printf '%s' '{\"loggedIn\":true,\"authType\":\"subscription\"}'\n",
    );
    let clis = detect(&fixture, fixture.env()).await;
    let claude = find(&clis, CliKind::Claude);
    assert_eq!(claude.version.as_deref(), Some("2.1.300"), "{claude:?}");
    assert_eq!(claude.signed_in, Some(true));
}

#[test]
fn only_a_leading_version_number_is_read_from_a_banner() {
    assert_eq!(
        super::version_from_banner("2.1.248 (Claude Code)\n").as_deref(),
        Some("2.1.248")
    );
    assert_eq!(super::version_from_banner("Claude Code"), None);
    assert_eq!(super::version_from_banner(""), None);
}

const FAKE_GH: &str = include_str!("fixtures/fake-gh.sh");

#[tokio::test]
async fn a_signed_in_gh_reports_its_version_and_account() {
    let fixture = Fixture::new();
    fixture.install("gh", FAKE_GH);
    let mut env = fixture.env();
    env.set(
        "FAKE_CLI_STDOUT",
        "github.com\n  ✓ Logged in to github.com account octocat (keyring)\n  \
         - Active account: true\n  ✓ Logged in to github.com account hubot (keyring)\n",
    );
    let detector = CliDetector::new(fixture.launcher(env), Duration::from_secs(2));
    let gh = detector.github().await;
    assert!(gh.installed, "{gh:?}");
    assert_eq!(gh.version.as_deref(), Some("2.100.0"));
    assert_eq!(gh.signed_in, Some(true));
    assert_eq!(gh.account.as_deref(), Some("octocat"));
    assert_eq!(gh.note, None);
}

#[tokio::test]
async fn a_signed_out_gh_reports_no_account_and_a_missing_one_nothing_at_all() {
    let fixture = Fixture::new();
    // Only the sandbox's bin: CI's Linux runners have a real gh in /usr/bin.
    let mut env = fixture.env();
    env.set("PATH", fixture.bin.display().to_string());
    let detector = CliDetector::new(fixture.launcher(env), Duration::from_secs(2));
    let gh = detector.github().await;
    assert!(!gh.installed);
    assert_eq!((gh.version, gh.signed_in, gh.note), (None, None, None));

    fixture.install("gh", FAKE_GH);
    let mut env = fixture.env();
    env.set("FAKE_CLI_EXIT", "1");
    let detector = CliDetector::new(fixture.launcher(env), Duration::from_secs(2));
    let gh = detector.github().await;
    assert!(gh.installed, "{gh:?}");
    assert_eq!(gh.signed_in, Some(false));
    assert_eq!(gh.account, None);
}

#[test]
fn gh_account_reads_the_pre_2_40_wording() {
    assert_eq!(
        super::gh_account("  ✓ Logged in to github.com as octocat (oauth_token)\n").as_deref(),
        Some("octocat")
    );
    assert_eq!(
        super::gh_account("You are not logged into any GitHub hosts."),
        None
    );
}

#[tokio::test]
async fn an_older_gh_is_asked_without_active_which_it_refuses() {
    let fixture = Fixture::new();
    fixture.install("gh", FAKE_GH);
    let mut env = fixture.env();
    env.set("FAKE_GH_VERSION", "2.45.0");
    env.set(
        "FAKE_CLI_STDOUT",
        "github.com\n  ✓ Logged in to github.com account octocat (keyring)\n",
    );
    let detector = CliDetector::new(fixture.launcher(env), Duration::from_secs(2));
    let gh = detector.github().await;
    assert_eq!(gh.version.as_deref(), Some("2.45.0"));
    assert_eq!(gh.signed_in, Some(true), "{gh:?}");
    assert_eq!(gh.account.as_deref(), Some("octocat"));
}
