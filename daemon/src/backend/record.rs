//! Recording a vendor CLI's session as a replay fixture (PLX-493).
//!
//! Off unless plxd runs with [`RECORD_ENV`] naming a folder. Then each process whose
//! [`ProcessSpec::record`](super::process::ProcessSpec::record) names it writes
//! `<folder>/<name>-<unix ms>-<n>.jsonl`, readable only by its owner on unix: every stdout line as
//! it is, with the home folder replaced by `~`, and on unix a bare `@read` before each line plxd
//! sends on stdin, which is the fake CLIs' directive to wait for one (`fake-claude.sh`,
//! `fake-app-server.sh`, `fake-agent.sh`). What plxd sends is never written, so a key passed on
//! stdin can't end up in a fixture. The CLIs echo some of it on stdout, though: Codex's
//! app-server repeats the prompt as a `userMessage` item, and Claude Code a subagent's. Stdout can
//! also carry an email, an account id, or the repo's path: review and scrub a recording, prompts
//! included, before committing it.
//!
//! To record: run `PLXD_RECORD_CLI=/tmp/rec plxd serve`, start a short thread on the backend, and
//! scrub the file into that backend's `fixtures/recorded.jsonl` with
//! `scripts/scrub-recording.py <raw> <fixture>`, then review it. Its replay test then fails until
//! `UPDATE_SNAPSHOTS=1 cargo test -p plxd a_recorded_session` rewrites the `recorded.events.jsonl` snapshot.

use std::fs::{self, File, OpenOptions};
use std::io::{self, Write as _};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, PoisonError};
use std::time::{SystemTime, UNIX_EPOCH};

/// The variable naming the folder recordings go into.
pub const RECORD_ENV: &str = "PLXD_RECORD_CLI";

/// One process's recording. Clones write to the same file.
#[derive(Clone, Debug)]
pub struct Recorder {
    file: Arc<Mutex<File>>,
    /// The home folder as stdout may spell it, JSON-escaped first, which [`Self::stdout`] scrubs.
    homes: Vec<String>,
}

impl Recorder {
    /// A new recording for the CLI `name`, when [`RECORD_ENV`] is set.
    ///
    /// # Errors
    ///
    /// If the folder or the file can't be created.
    pub fn open(name: &str) -> io::Result<Option<Self>> {
        match std::env::var_os(RECORD_ENV) {
            Some(dir) => Self::create(&PathBuf::from(dir), name).map(Some),
            None => Ok(None),
        }
    }

    /// A new recording for the CLI `name` in `dir`, which is created if missing.
    fn create(dir: &Path, name: &str) -> io::Result<Self> {
        static COUNT: AtomicU64 = AtomicU64::new(0);
        let mut folder = fs::DirBuilder::new();
        let mut options = OpenOptions::new();
        // Owner-only: a raw recording can hold prompts, paths, and the repo's contents.
        #[cfg(unix)]
        {
            use std::os::unix::fs::{DirBuilderExt as _, OpenOptionsExt as _};
            folder.mode(0o700);
            options.mode(0o600);
        }
        folder.recursive(true).create(dir)?;
        let ms = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis();
        let file = options
            .create_new(true)
            .append(true)
            .open(dir.join(format!(
                "{name}-{ms}-{}.jsonl",
                COUNT.fetch_add(1, Ordering::Relaxed)
            )))?;
        Ok(Self {
            file: Arc::new(Mutex::new(file)),
            homes: std::env::home_dir()
                .map(|home| homes(&home.display().to_string()))
                .unwrap_or_default(),
        })
    }

    /// Writes a line of stdout, with the home folder replaced by `~`.
    pub fn stdout(&self, line: &[u8]) {
        let mut line = String::from_utf8_lossy(line).into_owned();
        for home in &self.homes {
            line = line.replace(home.as_str(), "~");
        }
        self.write(&line);
    }

    /// Marks that plxd sent a line on stdin.
    pub fn stdin(&self) {
        self.write("@read");
    }

    fn write(&self, line: &str) {
        let mut file = self.file.lock().unwrap_or_else(PoisonError::into_inner);
        // ponytail: a failed write loses a line of a dev-only recording, never the run.
        let _ = writeln!(file, "{line}");
    }
}

/// The ways stdout may spell `home`: JSON-escaped, as `C:\\Users\\me` for Windows' `C:\Users\me`,
/// then as it is. None for an empty or root home, which would match every path.
fn homes(home: &str) -> Vec<String> {
    if home.is_empty() || home == "/" {
        return Vec::new();
    }
    let escaped = serde_json::to_string(home).unwrap_or_default();
    let escaped = escaped.trim_matches('"');
    if escaped == home {
        vec![home.to_owned()]
    } else {
        vec![escaped.to_owned(), home.to_owned()]
    }
}

/// Plays a run on a recorded fixture to its end, allowing every permission request, and checks
/// its events, one JSON line each, against the snapshot at `path`. With `UPDATE_SNAPSHOTS` set it
/// rewrites the snapshot instead. Approval ids, which plxd makes fresh each run, read `approval`.
/// Unix only, as the backends' tests are: the fake CLIs that play the fixtures are `sh` scripts.
#[cfg(all(test, unix))]
pub(crate) async fn assert_replays(started: super::Started, path: &std::path::Path) {
    use super::{Answer, Decision, Event};

    let super::Started { run, mut events } = started;
    let mut lines = String::new();
    loop {
        let event = tokio::time::timeout(std::time::Duration::from_secs(10), events.next())
            .await
            .expect("no event within 10 s")
            .expect("the stream ended before Finished");
        if let Event::ApprovalRequested(request) = &event {
            run.answer(Answer {
                approval_id: request.approval_id,
                decision: Decision::Allow {
                    input: None,
                    always: false,
                },
            })
            .unwrap();
        }
        let mut json = serde_json::to_value(&event).unwrap();
        if json.get("approvalId").is_some() {
            json["approvalId"] = "approval".into();
        }
        lines.push_str(&json.to_string());
        lines.push('\n');
        if event.is_terminal() {
            break;
        }
    }
    if std::env::var_os("UPDATE_SNAPSHOTS").is_some() {
        fs::write(path, &lines).unwrap();
        return;
    }
    let expected = fs::read_to_string(path).unwrap_or_default();
    assert!(
        lines == expected,
        "the replay of {} no longer matches its snapshot; if the change is intended, rerun with \
         UPDATE_SNAPSHOTS=1 and review the diff\n--- got\n{lines}",
        path.display()
    );
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn it_scrubs_home_and_marks_stdin() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("rec.jsonl");
        let recorder = Recorder {
            file: Arc::new(Mutex::new(File::create(&path).unwrap())),
            homes: homes("/Users/someone"),
        };
        recorder.stdout(br#"{"cwd":"/Users/someone/repo"}"#);
        recorder.stdin();
        assert_eq!(
            fs::read_to_string(&path).unwrap(),
            "{\"cwd\":\"~/repo\"}\n@read\n"
        );
    }

    #[test]
    fn it_scrubs_a_windows_home_in_json_and_as_it_is() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("rec.jsonl");
        let recorder = Recorder {
            file: Arc::new(Mutex::new(File::create(&path).unwrap())),
            homes: homes(r"C:\Users\someone"),
        };
        recorder.stdout(br#"{"cwd":"C:\\Users\\someone\\repo"}"#);
        recorder.stdout(br"plain C:\Users\someone\repo");
        assert_eq!(
            fs::read_to_string(&path).unwrap(),
            "{\"cwd\":\"~\\\\repo\"}\nplain ~\\repo\n"
        );
        assert!(homes("/").is_empty());
    }

    /// A raw recording can hold prompts and paths, so only its owner can read it.
    #[cfg(unix)]
    #[test]
    fn a_recording_is_owner_only() {
        use std::os::unix::fs::PermissionsExt as _;

        let dir = tempfile::tempdir().unwrap();
        let folder = dir.path().join("rec");
        Recorder::create(&folder, "claude").unwrap();
        let file = fs::read_dir(&folder)
            .unwrap()
            .next()
            .unwrap()
            .unwrap()
            .path();
        let mode = |path: &Path| fs::metadata(path).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode(&folder), 0o700);
        assert_eq!(mode(&file), 0o600);
    }

    /// The recorded fixtures and their snapshots hold none of what
    /// `scripts/scrub-recording.py` removes. The hand-written fixtures make up their own paths.
    #[test]
    fn recorded_fixtures_hold_no_personal_data() {
        let fixtures = [
            include_str!("claude/fixtures/recorded.jsonl"),
            include_str!("claude/fixtures/recorded.events.jsonl"),
            include_str!("codex/fixtures/recorded.jsonl"),
            include_str!("codex/fixtures/recorded.events.jsonl"),
            include_str!("acp/fixtures/recorded.jsonl"),
            include_str!("acp/fixtures/recorded.events.jsonl"),
        ];
        let forbidden = [
            "/Users/",
            "/home/",
            "/private/",
            "@gmail.com",
            "req_",
            "127.0.0.1",
            "organization",
            "account_uuid",
            "accountuuid",
            "org_id",
            "orgid",
            "plantype",
            "overage",
            "(global)",
            "(user skill)",
        ];
        for (i, fixture) in fixtures.iter().enumerate() {
            let lower = fixture.to_lowercase();
            for needle in forbidden {
                assert!(
                    !lower.contains(&needle.to_lowercase()),
                    "fixture {i} holds {needle:?}"
                );
            }
            let signatures = fixture.matches(r#""signature":""#).count();
            let redacted = fixture.matches(r#""signature":"redacted""#).count();
            assert_eq!(
                signatures, redacted,
                "fixture {i} holds a thinking signature"
            );
        }
    }
}
