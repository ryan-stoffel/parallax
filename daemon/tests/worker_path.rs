//! Real Claude Code regression for RYA-126: a worker's Bash finds a tool that only wispd's `PATH`
//! has, even when the user's zsh startup files set `PATH` outright, and its commands can't read or
//! write the script that puts `PATH` back. A local fake Messages API asks for Bash, so no account
//! or Anthropic connection is needed. Set `WISP_SANDBOX_CLAUDE` to the CLI under test; it needs
//! `/bin/zsh`.
#![cfg(unix)]

mod common;

use std::fs;
use std::os::unix::fs::PermissionsExt;
use std::path::Path;

use common::{run_worker, tool_result, worker_request};
use wispd::backend::claude::{ENV_FILE_ENV, write_env_file};
use wispd::paths::DataDir;

#[tokio::test]
async fn a_worker_keeps_wispds_path_when_zsh_startup_resets_it() {
    let Some(claude) = std::env::var_os("WISP_SANDBOX_CLAUDE") else {
        eprintln!("skipped: set WISP_SANDBOX_CLAUDE to test the real Claude Code CLI");
        return;
    };
    assert!(
        Path::new("/bin/zsh").exists(),
        "the test needs /bin/zsh, the shell whose startup resets PATH"
    );
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().canonicalize().unwrap();
    let home = root.join("home");
    let data = root.join("data");
    let worktree = data.join("worktrees/run");
    let context = data.join("context/p");
    let git_dir = root.join("repo/.git");
    let tools = root.join("tools");
    for folder in [
        &home,
        &worktree,
        &context,
        &git_dir,
        &tools,
        &root.join("tmp"),
    ] {
        fs::create_dir_all(folder).unwrap();
    }
    // As nix-darwin's /etc/zshenv does: every zsh reads it, even `zsh -c`.
    fs::write(home.join(".zshenv"), "export PATH=/usr/bin:/bin\n").unwrap();
    let tool = tools.join("wisp-path-probe");
    fs::write(&tool, "#!/bin/sh\necho found-the-tool\n").unwrap();
    fs::set_permissions(&tool, fs::Permissions::from_mode(0o755)).unwrap();
    fs::write(
        worktree.join(".git"),
        format!("gitdir: {}/worktrees/run\n", git_dir.display()),
    )
    .unwrap();

    let request = worker_request(&home, &data, &worktree, &git_dir, &context);
    let path = format!(
        "{}:{}",
        tools.display(),
        std::env::var("PATH").unwrap_or_default()
    );
    let env_file = write_env_file(&DataDir::new(&data).unwrap().temp_dir(), path.as_ref()).unwrap();
    fs::write(
        worktree.join("probe.sh"),
        format!(
            "wisp-path-probe\n\
             cat '{0}' 2>/dev/null || echo denied-read\n\
             echo x >> '{0}' 2>/dev/null || echo denied-write\n",
            env_file.display()
        ),
    )
    .unwrap();
    // The default configuration folder, as for a subscription: the sandbox can't read it, so
    // Claude Code's shell snapshot, which would restore PATH, can't either.
    let config = home.join(".claude");
    let (stdout, transcript) = run_worker(
        &claude,
        &request,
        &root,
        &home,
        &[
            ("ANTHROPIC_API_KEY", "sk-ant-wisp-test-key-never-send"),
            ("PATH", &path),
            ("SHELL", "/bin/zsh"),
            ("CLAUDE_CONFIG_DIR", config.to_str().unwrap()),
            (ENV_FILE_ENV, env_file.to_str().unwrap()),
        ],
    )
    .await;
    let result = tool_result(&stdout).unwrap_or_else(|| panic!("no Bash result:\n{transcript}"));
    assert!(result.contains("found-the-tool"), "{transcript}");
    assert!(result.contains("denied-read"), "{transcript}");
    assert!(result.contains("denied-write"), "{transcript}");
}
