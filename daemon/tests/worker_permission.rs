//! Real Claude Code regression for RYA-110 and RYA-20: a worker can run Bash, and its commands
//! don't see the key. A local fake Messages API asks for Bash, so no account or Anthropic
//! connection is needed. Set `WISP_SANDBOX_CLAUDE` to the CLI under test.
#![cfg(unix)]

mod common;

use std::fs;

use common::{run_worker, tool_result};
use wispd::backend::{AccountRef, Credential, RunId, RunRequest, ToolPolicy, WorkerSandbox};

const KEY: &str = "sk-ant-wisp-test-key-never-send";
/// A stand-in for the messaging token, in case Claude Code doesn't set its own.
const TOKEN: &str = "wisp-test-messaging-token";

#[tokio::test]
async fn a_worker_can_run_bash_without_exposing_its_key() {
    let Some(claude) = std::env::var_os("WISP_SANDBOX_CLAUDE") else {
        eprintln!("skipped: set WISP_SANDBOX_CLAUDE to test the real Claude Code CLI");
        return;
    };
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().canonicalize().unwrap();
    let home = root.join("home");
    let data = root.join("data");
    let worktree = data.join("worktrees/run");
    let context = data.join("context/p");
    let git_dir = root.join("repo/.git");
    for folder in [
        &home.join(".ssh"),
        &worktree,
        &context,
        &git_dir,
        &root.join("tmp"),
    ] {
        fs::create_dir_all(folder).unwrap();
    }
    fs::write(home.join(".ssh/id_ed25519"), "private-test-key").unwrap();
    fs::write(
        worktree.join(".git"),
        format!("gitdir: {}/worktrees/run\n", git_dir.display()),
    )
    .unwrap();
    fs::write(
        worktree.join("probe.sh"),
        format!(
            "if [ -n \"${{ANTHROPIC_API_KEY-}}\" ]; then echo key-exposed; else echo key-hidden; fi\n\
             if [ -n \"${{CLAUDE_CODE_MESSAGING_TOKEN-}}\" ]; then echo token-exposed; else echo token-hidden; fi\n             cat '{}' 2>/dev/null || echo denied-read\n             echo x > inside && echo wrote-inside\n             echo x > '{}' 2>/dev/null || echo denied-write\n",
            home.join(".ssh/id_ed25519").display(), home.join("outside").display(),
        ),
    ).unwrap();

    let request = RunRequest {
        run_id: RunId::generate(),
        turn_id: None,
        cwd: worktree.clone(),
        prompt: "Run the probe.".into(),
        policy: ToolPolicy::WorkspaceWrite,
        sandbox: Some(WorkerSandbox::for_worktree(
            &home, &data, &worktree, &git_dir, &context,
        )),
        account: AccountRef {
            id: "test".into(),
            credential: Credential::Subscription { config_home: None },
        },
        resume: None,
        model: Some("claude-sonnet-4-6".into()),
        coordinator_tools: None,
    };
    let (stdout, transcript) = run_worker(
        &claude,
        &request,
        &root,
        &home,
        &[
            ("ANTHROPIC_API_KEY", KEY),
            ("CLAUDE_CODE_MESSAGING_TOKEN", TOKEN),
        ],
    )
    .await;
    let result = tool_result(&stdout).unwrap_or_else(|| panic!("no Bash result:\n{transcript}"));
    assert!(result.contains("key-hidden"), "{transcript}");
    assert!(!result.contains(KEY), "{transcript}");
    assert!(result.contains("token-hidden"), "{transcript}");
    assert!(!result.contains(TOKEN), "{transcript}");
    assert!(result.contains("wrote-inside"), "{transcript}");
    assert!(result.contains("denied-read"), "{transcript}");
    assert!(result.contains("denied-write"), "{transcript}");
    assert!(!home.join("outside").exists());
}
