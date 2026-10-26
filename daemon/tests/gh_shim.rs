//! plxd run as the `gh` shim (PLX-1023): refusals, the low-budget refusal, and pass-through to a
//! fake real `gh`. Nothing here calls GitHub.

use std::io::Write as _;
use std::path::PathBuf;
use std::process::{Command, Output, Stdio};

/// A data folder with plxd as `tools/gh-shim/gh`, and a folder for a fake real `gh`.
struct Fixture {
    temp: tempfile::TempDir,
}

impl Fixture {
    fn new() -> Self {
        let temp = tempfile::tempdir().expect("temp dir");
        let shim = temp.path().join("data/tools/gh-shim");
        std::fs::create_dir_all(&shim).unwrap();
        std::fs::create_dir_all(temp.path().join("bin")).unwrap();
        #[cfg(unix)]
        std::os::unix::fs::symlink(env!("CARGO_BIN_EXE_plxd"), shim.join("gh")).unwrap();
        #[cfg(windows)]
        std::fs::copy(env!("CARGO_BIN_EXE_plxd"), shim.join("gh.exe")).unwrap();
        Self { temp }
    }

    fn data(&self) -> PathBuf {
        self.temp.path().join("data")
    }

    fn bin(&self) -> PathBuf {
        self.temp.path().join("bin")
    }

    /// Runs the shim with `args`, `stdin`, and `env`, with its folder first on `PATH`.
    fn gh(&self, args: &[&str], stdin: &str, env: &[(&str, &str)]) -> Output {
        let shim = self.data().join("tools/gh-shim");
        let path =
            std::env::join_paths([shim.clone(), self.bin(), "/usr/bin".into(), "/bin".into()])
                .unwrap();
        let mut child = Command::new(shim.join(if cfg!(windows) { "gh.exe" } else { "gh" }))
            .args(args)
            .env("PATH", path)
            .env("PLXD_DATA_DIR", self.data())
            // The shim's fallback budget file goes in the temp folder.
            .env("TMPDIR", self.temp.path())
            .env("TMP", self.temp.path())
            .env_remove("PARALLAX_GH_SHIM")
            .envs(env.iter().copied())
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .expect("the shim should run");
        child
            .stdin
            .take()
            .unwrap()
            .write_all(stdin.as_bytes())
            .unwrap();
        child.wait_with_output().unwrap()
    }
}

fn text(bytes: &[u8]) -> String {
    String::from_utf8_lossy(bytes).into_owned()
}

#[test]
fn a_replaced_command_is_refused_with_its_tool() {
    let fixture = Fixture::new();
    let output = fixture.gh(&["pr", "checks", "12", "--watch"], "", &[]);
    assert_eq!(output.status.code(), Some(2), "{output:?}");
    assert_eq!(
        text(&output.stderr),
        "plxd: agents don't run gh pr checks in Parallax; use the watch_pull_request tool instead.\n"
    );
    assert!(output.stdout.is_empty());
}

/// A fake real `gh`: `api rate_limit` adds a line to `rate_limit.log` beside it and answers
/// `$GRAPHQL_LEFT` GraphQL requests left, or fails with `$RATE_LIMIT_FAILS`; anything else
/// prints its arguments and stdin and exits 3.
#[cfg(unix)]
fn fake_gh(bin: &std::path::Path) {
    use std::os::unix::fs::PermissionsExt as _;
    let gh = bin.join("gh");
    std::fs::write(
        &gh,
        r#"#!/bin/sh
if [ "$1 $2" = "api rate_limit" ]; then
  echo asked >> "$(dirname "$0")/rate_limit.log"
  [ -n "$RATE_LIMIT_FAILS" ] && exit 1
  reset=$(( $(date +%s) + 600 ))
  echo "{\"resources\":{\"core\":{\"remaining\":4000,\"reset\":$reset},\"graphql\":{\"remaining\":${GRAPHQL_LEFT:-5000},\"reset\":$reset}}}"
  exit 0
fi
echo "args: $*"
cat
echo "to stderr" >&2
exit 3
"#,
    )
    .unwrap();
    std::fs::set_permissions(&gh, std::fs::Permissions::from_mode(0o755)).unwrap();
}

#[cfg(unix)]
#[test]
fn everything_else_runs_the_real_gh_unchanged() {
    let fixture = Fixture::new();
    fake_gh(&fixture.bin());

    let output = fixture.gh(&["pr", "list", "--search", "a b"], "from stdin\n", &[]);
    assert_eq!(output.status.code(), Some(3), "{output:?}");
    assert_eq!(
        text(&output.stdout),
        "args: pr list --search a b\nfrom stdin\n"
    );
    assert_eq!(text(&output.stderr), "to stderr\n");
    // The read refreshed the budget with `gh api rate_limit`.
    let budget = std::fs::read_to_string(fixture.data().join("github-budget.json")).unwrap();
    assert!(budget.contains("\"remaining\":4000"), "{budget}");

    // The escape hatch lets a replaced command through.
    let output = fixture.gh(&["pr", "checks", "12"], "", &[("PARALLAX_GH_SHIM", "off")]);
    assert_eq!(output.status.code(), Some(3), "{output:?}");
    assert_eq!(text(&output.stdout), "args: pr checks 12\n");
}

#[cfg(unix)]
#[test]
fn a_read_is_refused_when_its_quota_is_nearly_spent() {
    let fixture = Fixture::new();
    fake_gh(&fixture.bin());
    let low = [("GRAPHQL_LEFT", "150")];

    let output = fixture.gh(&["pr", "list"], "", &low);
    assert_eq!(output.status.code(), Some(2), "{output:?}");
    let stderr = text(&output.stderr);
    assert!(
        stderr.starts_with(
            "plxd: GitHub's GraphQL quota is down to 150 requests until it resets at "
        ),
        "{stderr}"
    );
    // A REST read and a write still run.
    let output = fixture.gh(&["run", "list"], "", &low);
    assert_eq!(output.status.code(), Some(3), "{output:?}");
    let output = fixture.gh(&["pr", "merge", "12"], "", &low);
    assert_eq!(output.status.code(), Some(3), "{output:?}");
}

#[cfg(unix)]
#[test]
fn a_failed_quota_read_isnt_tried_again_for_a_minute() {
    let fixture = Fixture::new();
    fake_gh(&fixture.bin());
    let fails = [("RATE_LIMIT_FAILS", "1")];

    for _ in 0..2 {
        let output = fixture.gh(&["pr", "list"], "", &fails);
        assert_eq!(output.status.code(), Some(3), "{output:?}");
    }
    let log = std::fs::read_to_string(fixture.bin().join("rate_limit.log")).unwrap();
    assert_eq!(log.lines().count(), 1, "{log}");
}

/// A budget no real read could have written, such as one another user planted with nothing left
/// until next year, is ignored, and isn't copied into the data folder's.
#[cfg(unix)]
#[test]
fn a_future_dated_budget_holds_nothing_back() {
    let fixture = Fixture::new();
    fake_gh(&fixture.bin());
    let planted = r#"{"graphql":{"remaining":0,"resetAt":"2099-01-01T00:00:00Z","seenAt":"2099-01-01T00:00:00Z"},"checkedAt":"2099-01-01T00:00:00Z"}"#;
    std::fs::write(fixture.data().join("github-budget.json"), planted).unwrap();
    // The shim's fallback, in the `TMPDIR` the fixture sets.
    std::fs::write(fixture.temp.path().join("plxd-github-budget.json"), planted).unwrap();

    let output = fixture.gh(&["pr", "list"], "", &[]);
    assert_eq!(output.status.code(), Some(3), "{output:?}");
    let budget = std::fs::read_to_string(fixture.data().join("github-budget.json")).unwrap();
    assert!(!budget.contains("2099"), "{budget}");
    assert!(budget.contains("\"remaining\":5000"), "{budget}");
}
