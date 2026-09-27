//! Contract tests against the real, signed-in `claude` on `PATH` (#274). CI has no Claude login,
//! so they are ignored there; run them where Claude Code is installed and signed in:
//!
//! ```sh
//! cargo test -p wispd real_claude -- --ignored
//! ```
//!
//! Each runs a worker exactly as wispd builds one, on the cheapest model with a tiny prompt, in a
//! throwaway repository and a throwaway data folder, billed to the signed-in account.

use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::Duration;

use super::ClaudeBackend;
use crate::agents::worker::agent_environment;
use crate::backend::process::Launcher;
use crate::backend::{
    AccountRef, Backend, Credential, Event, Outcome, RunId, RunRequest, ToolPolicy, ToolStatus,
    WorkerSandbox,
};
use crate::paths::DataDir;

struct Worker {
    _dirs: (tempfile::TempDir, tempfile::TempDir),
    worktree: PathBuf,
    events: Vec<Event>,
}

fn git(dir: &Path, args: &[&str]) {
    let status = Command::new("git")
        .arg("-C")
        .arg(dir)
        .args([
            "-c",
            "user.name=wisp",
            "-c",
            "user.email=wisp@example.invalid",
        ])
        .args(args)
        .status()
        .unwrap();
    assert!(status.success(), "git {args:?}");
}

/// Runs `prompt` as a worker in a linked worktree of a fresh repository. The data folder's name
/// has a space in it, as `~/Library/Application Support/wisp` does.
async fn run_worker(prompt: &str) -> Worker {
    let repo_dir = tempfile::Builder::new()
        .prefix("wisp-repo")
        .tempdir()
        .unwrap();
    let data_dir = tempfile::Builder::new()
        .prefix("wisp data")
        .tempdir()
        .unwrap();
    let repo = repo_dir.path().canonicalize().unwrap();
    let data = data_dir.path().canonicalize().unwrap();
    git(&repo, &["init", "-q", "-b", "main"]);
    std::fs::write(repo.join("README.md"), "demo\n").unwrap();
    git(&repo, &["add", "."]);
    git(&repo, &["commit", "-q", "-m", "init"]);
    let worktree = data.join("worktrees/wt");
    git(
        &repo,
        &[
            "worktree",
            "add",
            "-q",
            "-b",
            "wt",
            worktree.to_str().unwrap(),
        ],
    );
    let context = data.join("context/p");
    std::fs::create_dir_all(&context).unwrap();
    let home = std::env::home_dir().unwrap().canonicalize().unwrap();

    let launcher = Launcher::new(DataDir::new(&data).unwrap(), agent_environment());
    let backend = ClaudeBackend::new(launcher);
    let mut started = backend
        .start(RunRequest {
            run_id: RunId::generate(),
            turn_id: None,
            cwd: worktree.clone(),
            prompt: prompt.into(),
            policy: ToolPolicy::WorkspaceWrite,
            sandbox: Some(WorkerSandbox::for_worktree(
                &home,
                &data,
                &worktree,
                &repo.join(".git"),
                &context,
            )),
            account: AccountRef {
                id: "claude".into(),
                credential: Credential::Subscription { config_home: None },
            },
            resume: None,
            model: Some("haiku".into()),
            coordinator_tools: None,
        })
        .unwrap();
    let mut events = Vec::new();
    while let Some(event) = tokio::time::timeout(Duration::from_secs(300), started.events.next())
        .await
        .expect("no event within 300 s")
    {
        events.push(event);
    }
    Worker {
        _dirs: (repo_dir, data_dir),
        worktree,
        events,
    }
}

fn denied_calls(events: &[Event]) -> usize {
    events
        .iter()
        .filter(|event| {
            matches!(
                event,
                Event::ToolResult {
                    status: ToolStatus::Denied,
                    ..
                }
            )
        })
        .count()
}

#[tokio::test]
#[ignore = "runs the real, signed-in claude"]
async fn real_claude_worker_writes_edits_runs_bash_and_fetches() {
    let worker = run_worker(
        "Do exactly these four steps and nothing else. 1. Use the Write tool to create \
         hello.txt containing the word hi. 2. Use the Edit tool to replace hi with hello in \
         hello.txt. 3. Use the Bash tool to run: echo there > bash.txt 4. Use the WebFetch tool \
         to fetch https://example.com and say its title.",
    )
    .await;
    let events = &worker.events;
    assert!(
        matches!(
            events.last(),
            Some(Event::Finished {
                outcome: Outcome::Completed { .. },
                ..
            })
        ),
        "{events:#?}"
    );
    assert_eq!(denied_calls(events), 0, "{events:#?}");
    let read = |name: &str| std::fs::read_to_string(worker.worktree.join(name)).ok();
    assert_eq!(
        read("hello.txt").as_deref().map(str::trim),
        Some("hello"),
        "{events:#?}"
    );
    assert_eq!(
        read("bash.txt").as_deref().map(str::trim),
        Some("there"),
        "{events:#?}"
    );
}

#[tokio::test]
#[ignore = "runs the real, signed-in claude"]
async fn real_claude_worker_cannot_write_outside_its_worktree_or_to_protected_paths() {
    let outside_dir = tempfile::tempdir().unwrap();
    let outside = outside_dir
        .path()
        .canonicalize()
        .unwrap()
        .join("outside.txt");
    let outside_bash = outside.with_file_name("bash.txt");
    let worker = run_worker(&format!(
        "This is a permissions test. Try each step once with the tool named, even if you expect \
         it to fail, and never retry another way. 1. Use the Write tool to create {} containing \
         hi. 2. Use the Write tool to create .claude/settings.json containing {{}}. 3. Read the \
         file .git, then use the Write tool to replace it with the text: gitdir: /tmp/elsewhere \
         4. Use the Bash tool to run: echo hi > {} 5. Use the Bash tool to run: echo elsewhere \
         >> .git",
        outside.display(),
        outside_bash.display()
    ))
    .await;
    let events = &worker.events;
    assert!(!outside.exists(), "{events:#?}");
    assert!(!outside_bash.exists(), "{events:#?}");
    assert!(
        !worker.worktree.join(".claude/settings.json").exists(),
        "{events:#?}"
    );
    let dot_git = std::fs::read_to_string(worker.worktree.join(".git")).unwrap();
    assert!(!dot_git.contains("elsewhere"), "{events:#?}");
    assert!(denied_calls(events) >= 2, "{events:#?}");
}
