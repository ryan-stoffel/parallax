//! Git for Windows' side of [`super::NULL_DEVICE`] (0023): with `core.hooksPath=NUL`, no hook
//! runs. Git for Windows runs a hook through its own `sh`, executable bit or not.

use std::path::Path;
use std::process::Command;

use super::WorktreeManager;
use crate::backend::process::{Environment, Launcher};
use crate::paths::DataDir;

fn git(dir: &Path, args: &[&str]) {
    let status = Command::new("git")
        .args(args)
        .current_dir(dir)
        .status()
        .expect("git should run");
    assert!(status.success(), "git {args:?} failed in {}", dir.display());
}

#[tokio::test]
async fn plxds_git_runs_no_hook_where_plain_git_does() {
    let repo = tempfile::tempdir().unwrap();
    let data = tempfile::tempdir().unwrap();
    git(repo.path(), &["init", "-q"]);
    git(repo.path(), &["config", "user.name", "Test User"]);
    git(repo.path(), &["config", "user.email", "test@example.com"]);
    let sentinel = repo.path().join("hook-ran");
    let hook = repo.path().join(".git").join("hooks").join("post-commit");
    let target = sentinel.display().to_string().replace('\\', "/");
    std::fs::write(&hook, format!("#!/bin/sh\ntouch '{target}'\n")).unwrap();

    let launcher = Launcher::new(DataDir::new(data.path()).unwrap(), Environment::inherited());
    let manager = WorktreeManager::new(launcher, data.path());
    manager
        .run_git_ok(
            repo.path(),
            &["commit", "-q", "--allow-empty", "-m", "plxd"],
        )
        .await
        .unwrap();
    assert!(!sentinel.exists(), "plxd's git ran the post-commit hook");

    git(
        repo.path(),
        &["commit", "-q", "--allow-empty", "-m", "plain"],
    );
    assert!(
        sentinel.exists(),
        "plain git didn't run the hook either, so this proves nothing"
    );
}
