//! Tests against real, temporary git repositories and a real `git` binary, in the same style as
//! `backend::process`'s own tests spawning real processes.

use std::os::unix::fs::{PermissionsExt, symlink};
use std::path::{Path, PathBuf};
use std::process::Command;

use parallax_protocol::{ProjectId, RunId};

use super::{WorktreeManager, short_hash};
use crate::backend::process::{Environment, Launcher};
use crate::paths::DataDir;

fn manager(data_root: &Path) -> WorktreeManager {
    let launcher = Launcher::new(DataDir::new(data_root).unwrap(), Environment::inherited());
    WorktreeManager::new(launcher, data_root)
}

fn git(dir: &Path, args: &[&str]) {
    let status = Command::new("git")
        .args(args)
        .current_dir(dir)
        .env("GIT_TERMINAL_PROMPT", "0")
        .status()
        .expect("git should run");
    assert!(status.success(), "git {args:?} failed in {}", dir.display());
}

fn git_output(dir: &Path, args: &[&str]) -> String {
    let output = Command::new("git")
        .arg("-C")
        .arg(dir)
        .args(args)
        .output()
        .expect("git should run");
    assert!(
        output.status.success(),
        "git -C {} {args:?}: {output:?}",
        dir.display()
    );
    String::from_utf8(output.stdout).unwrap().trim().to_owned()
}

fn rev_parse(dir: &Path, reference: &str) -> String {
    git_output(dir, &["rev-parse", reference])
}

/// Like [`git_output`], but with the git directory pinned explicitly instead of discovered from
/// `work_tree`'s `.git` file: used to check on a repository after a test has rewritten that file,
/// once `work_tree` itself can no longer be trusted to find it.
fn git_output_pinned(work_tree: &Path, git_dir: &Path, args: &[&str]) -> String {
    let output = Command::new("git")
        .arg(format!("--git-dir={}", git_dir.display()))
        .arg(format!("--work-tree={}", work_tree.display()))
        .args(args)
        .output()
        .expect("git should run");
    assert!(output.status.success(), "git {args:?}: {output:?}");
    String::from_utf8(output.stdout).unwrap().trim().to_owned()
}

/// Writes an executable shell script at `path`, creating its parent folder if needed, that
/// touches `sentinel` when run. Every hook, hooksPath, `.gitattributes` driver, and filter test
/// below plants one of these and then asserts `sentinel` was never created, proving plxd's
/// worktree-scoped git calls never ran it (#166).
fn write_sentinel_script(path: &Path, sentinel: &Path) {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).unwrap();
    }
    std::fs::write(path, format!("#!/bin/sh\ntouch '{}'\n", sentinel.display())).unwrap();
    let mut perms = std::fs::metadata(path).unwrap().permissions();
    perms.set_mode(0o755);
    std::fs::set_permissions(path, perms).unwrap();
}

fn worktree_count(repo: &Path) -> usize {
    let output = Command::new("git")
        .args([
            "-C",
            repo.to_str().unwrap(),
            "worktree",
            "list",
            "--porcelain",
        ])
        .output()
        .expect("git should run");
    assert!(output.status.success(), "{output:?}");
    String::from_utf8(output.stdout)
        .unwrap()
        .lines()
        .filter(|line| line.starts_with("worktree "))
        .count()
}

/// Initializes a repo at `dir` with one commit and a local identity, and returns `dir`.
fn init_repo(dir: &Path) -> PathBuf {
    std::fs::create_dir_all(dir).unwrap();
    git(dir, &["init", "-q", "--initial-branch=main"]);
    git(dir, &["config", "user.name", "Test User"]);
    git(dir, &["config", "user.email", "test@example.com"]);
    std::fs::write(dir.join("README.md"), "hello\n").unwrap();
    git(dir, &["add", "-A"]);
    git(dir, &["commit", "-q", "-m", "init"]);
    dir.to_owned()
}

/// 0058: a named thread's branch is renamed by the naming rules, and its worktree follows, until
/// it has an upstream.
#[tokio::test]
async fn a_branch_is_renamed_until_it_has_an_upstream() {
    let repo_dir = tempfile::tempdir().unwrap();
    let repo = init_repo(repo_dir.path()).canonicalize().unwrap();
    let data_dir = tempfile::tempdir().unwrap();
    let mgr = manager(data_dir.path());
    let id = RunId::generate();
    let created = mgr
        .create_named(&repo, id, None, Some("the-login-page"))
        .await
        .unwrap();

    let renamed = mgr
        .rename_branch(&repo, id, &created.branch, "login-crash")
        .await
        .unwrap();
    assert_eq!(renamed.as_deref(), Some("parallax/login-crash"));
    assert_eq!(
        git_output(&created.path, &["branch", "--show-current"]),
        "parallax/login-crash"
    );

    // A name another branch has gets the short run id, as at creation.
    git(&repo, &["branch", "parallax/taken"]);
    let renamed = mgr
        .rename_branch(&repo, id, "parallax/login-crash", "taken")
        .await
        .unwrap();
    let short = short_hash(&id.to_string());
    assert_eq!(renamed, Some(format!("parallax/taken-{short}")));

    // Once pushed, it keeps its name.
    let branch = format!("parallax/taken-{short}");
    git(
        &repo,
        &["config", &format!("branch.{branch}.remote"), "origin"],
    );
    git(
        &repo,
        &[
            "config",
            &format!("branch.{branch}.merge"),
            &format!("refs/heads/{branch}"),
        ],
    );
    let kept = mgr
        .rename_branch(&repo, id, &branch, "anything-else")
        .await
        .unwrap();
    assert_eq!(kept, None);
    assert_eq!(
        git_output(&created.path, &["branch", "--show-current"]),
        branch
    );
}

/// A symlink where the coordinator's worktree goes is refused, and its target left alone.
#[tokio::test]
async fn a_coordinators_worktree_refuses_a_symlink() {
    let repo_dir = tempfile::tempdir().unwrap();
    let repo = init_repo(repo_dir.path()).canonicalize().unwrap();
    let data_dir = tempfile::tempdir().unwrap();
    let mgr = manager(data_dir.path());
    let theirs = data_dir.path().join("theirs");
    git(
        &repo,
        &[
            "worktree",
            "add",
            "-q",
            "-b",
            "mine",
            theirs.to_str().unwrap(),
        ],
    );
    std::fs::write(theirs.join("draft.txt"), "unsaved\n").unwrap();
    let project = ProjectId::generate();
    let path = mgr.coordinator_path(project);
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    symlink(&theirs, &path).unwrap();

    mgr.refresh_coordinator(&repo, project, "HEAD")
        .await
        .unwrap_err();
    assert_eq!(git_output(&theirs, &["branch", "--show-current"]), "mine");
    assert!(theirs.join("draft.txt").exists());
}

/// Many runs start in one repo at once (PLX-275): every create succeeds, on its own branch, with its
/// files checked out and nothing left uncommitted.
#[tokio::test]
async fn concurrent_creates_on_one_repo_all_succeed() {
    let repo_dir = tempfile::tempdir().unwrap();
    let repo = init_repo(repo_dir.path()).canonicalize().unwrap();
    let data_dir = tempfile::tempdir().unwrap();
    let mgr = manager(data_dir.path());

    let created: Vec<_> = futures_util::future::join_all(
        (0..20).map(|_| mgr.create_named(&repo, RunId::generate(), None, None)),
    )
    .await
    .into_iter()
    .map(Result::unwrap)
    .collect();

    let branches: std::collections::HashSet<_> = created.iter().map(|c| &c.branch).collect();
    assert_eq!(branches.len(), 20, "every worktree has its own branch");
    for worktree in &created {
        assert_eq!(
            std::fs::read_to_string(worktree.path.join("README.md")).unwrap(),
            "hello\n"
        );
        assert_eq!(git_output(&worktree.path, &["status", "--porcelain"]), "");
    }
    assert_eq!(worktree_count(&repo), 21, "main plus the 20 new worktrees");
}

#[tokio::test]
async fn commit_all_uses_an_identity_configured_only_in_a_global_gitconfig() {
    // Regression test (PR #172 review): most users' identity lives in `~/.gitconfig`, not the
    // repository's local config, and `commit_all`'s worktree-scoped calls can't see it (their
    // `HOME` and `GIT_CONFIG_GLOBAL` are locked down, #166). `commit_all` must still resolve it,
    // by asking `repo_root` directly, and use it for the commit.
    let repo_dir = tempfile::tempdir().unwrap();
    let repo = init_repo(repo_dir.path()).canonicalize().unwrap();
    git(&repo, &["config", "--unset", "user.name"]);
    git(&repo, &["config", "--unset", "user.email"]);

    let fake_home = tempfile::tempdir().unwrap();
    std::fs::write(
        fake_home.path().join(".gitconfig"),
        "[user]\n\tname = Global User\n\temail = global@example.com\n",
    )
    .unwrap();

    let data_dir = tempfile::tempdir().unwrap();
    let path = std::env::var("PATH").unwrap();
    let base: Environment = [
        ("PATH", path.as_str()),
        ("HOME", fake_home.path().to_str().unwrap()),
    ]
    .into_iter()
    .collect();
    let launcher = Launcher::new(DataDir::new(data_dir.path()).unwrap(), base);
    let mgr = WorktreeManager::new(launcher, data_dir.path());
    let created = mgr
        .create_named(&repo, RunId::generate(), None, None)
        .await
        .unwrap();
    std::fs::write(created.path.join("README.md"), "edited\n").unwrap();

    let commit = mgr
        .commit_all(&created.path, &created.git_dir, &repo, "agent changes")
        .await
        .unwrap()
        .expect("there was something to commit, with the identity resolved from ~/.gitconfig");

    assert_eq!(commit.sha, rev_parse(&created.path, "HEAD"));
    assert_eq!(
        git_output(&created.path, &["log", "-1", "--format=%an"]),
        "Global User"
    );
    assert_eq!(
        git_output(&created.path, &["log", "-1", "--format=%ae"]),
        "global@example.com"
    );
}

// #166: a worker controls every file in its worktree. These tests plant the vectors #137 found
// (a hook, a repo-configured `core.hooksPath` reaching into the worktree, a `.gitattributes`
// diff or filter driver, and a rewritten `.git` file) and check the sentinel each one's script
// would create never appears.

#[tokio::test]
async fn commit_all_does_not_run_a_post_commit_hook_via_a_repo_configured_hooks_path() {
    let repo_dir = tempfile::tempdir().unwrap();
    let repo = init_repo(repo_dir.path()).canonicalize().unwrap();
    let data_dir = tempfile::tempdir().unwrap();
    let mgr = manager(data_dir.path());
    let created = mgr
        .create_named(&repo, RunId::generate(), None, None)
        .await
        .unwrap();

    // As if the repository already had husky-style hooks configured: `core.hooksPath` points at
    // a folder inside the worktree, which a worker can write. `--no-verify` alone would not stop
    // this: it only skips `pre-commit` and `commit-msg`, not `post-commit`.
    let hooks_dir = created.path.join(".husky").join("_");
    let sentinel = data_dir.path().join("sentinel-hooks-path");
    write_sentinel_script(&hooks_dir.join("post-commit"), &sentinel);
    git(
        &created.path,
        &["config", "core.hooksPath", hooks_dir.to_str().unwrap()],
    );

    std::fs::write(created.path.join("README.md"), "edited\n").unwrap();
    let commit = mgr
        .commit_all(&created.path, &created.git_dir, &repo, "agent changes")
        .await
        .unwrap()
        .expect("there was something to commit");

    assert_eq!(commit.sha, rev_parse(&created.path, "HEAD"));
    assert!(!sentinel.exists(), "the post-commit hook must not have run");
}

#[tokio::test]
async fn worktree_git_commands_ignore_a_rewritten_git_file() {
    let repo_dir = tempfile::tempdir().unwrap();
    let repo = init_repo(repo_dir.path()).canonicalize().unwrap();
    let data_dir = tempfile::tempdir().unwrap();
    let mgr = manager(data_dir.path());
    let created = mgr
        .create_named(&repo, RunId::generate(), None, None)
        .await
        .unwrap();

    // A second, fully attacker-controlled repository, with a hook that would prove it ran.
    let evil_dir = tempfile::tempdir().unwrap();
    let evil_repo = init_repo(evil_dir.path()).canonicalize().unwrap();
    let sentinel = data_dir.path().join("sentinel-git-file-redirect");
    write_sentinel_script(
        &evil_repo.join(".git").join("hooks").join("post-commit"),
        &sentinel,
    );

    // The worker rewrites the worktree's `.git` file to point at the attacker's repository.
    std::fs::write(
        created.path.join(".git"),
        format!("gitdir: {}\n", evil_repo.join(".git").display()),
    )
    .unwrap();

    std::fs::write(created.path.join("README.md"), "edited\n").unwrap();
    let commit = mgr
        .commit_all(&created.path, &created.git_dir, &repo, "agent changes")
        .await
        .unwrap()
        .expect("there was something to commit");

    let head = git_output_pinned(&created.path, &created.git_dir, &["rev-parse", "HEAD"]);
    assert_eq!(commit.sha, head);
    assert_ne!(
        head,
        rev_parse(&evil_repo, "HEAD"),
        "the commit must land in the real repository, not the redirected one"
    );
    assert!(
        !sentinel.exists(),
        "a hook from the redirected .git file must not have run"
    );
}

mod checkpoint;
mod review;

#[tokio::test]
async fn git_status_counts_staged_ignored_additions_without_changing_real_index() {
    use super::RunFolder;
    for mode in ["checkout", "worktree", "unborn"] {
        let dir = tempfile::tempdir().unwrap();
        let repo = dir.path().join("repo");
        std::fs::create_dir(&repo).unwrap();
        git(&repo, &["init", "-b", "main"]);
        git(&repo, &["config", "user.name", "Test"]);
        git(&repo, &["config", "user.email", "test@example.com"]);
        std::fs::write(repo.join(".gitignore"), "ignored.txt\n").unwrap();
        git(&repo, &["add", ".gitignore"]);
        if mode != "unborn" {
            git(&repo, &["commit", "-m", "Initial"]);
        }
        let mgr = manager(&dir.path().join("data"));
        let created = if mode == "worktree" {
            Some(
                mgr.create_named(&repo, RunId::generate(), None, None)
                    .await
                    .unwrap(),
            )
        } else {
            None
        };
        let folder = match &created {
            Some(created) => RunFolder::Worktree {
                path: &created.path,
                git_dir: &created.git_dir,
            },
            None => RunFolder::Checkout(&repo),
        };
        let root = created
            .as_ref()
            .map_or(repo.as_path(), |created| created.path.as_path());
        let git_dir = created
            .as_ref()
            .map_or_else(|| repo.join(".git"), |created| created.git_dir.clone());
        std::fs::write(root.join("ignored.txt"), "one\ntwo\nthree\n").unwrap();
        std::fs::write(root.join("normal.txt"), "normal\n").unwrap();
        git(root, &["add", "-f", "ignored.txt", "normal.txt"]);
        // Count current contents, and deduplicate the nonignored staged addition.
        std::fs::write(root.join("ignored.txt"), "one\ntwo\n").unwrap();
        let index = std::fs::read(git_dir.join("index")).unwrap();
        let staged = git_output(root, &["diff", "--cached", "--numstat"]);
        let status = mgr.status(folder).await.unwrap();
        assert_eq!(
            (status.insertions, status.deletions),
            (if mode == "unborn" { 4 } else { 3 }, 0),
            "{mode}"
        );
        assert_eq!(
            std::fs::read(git_dir.join("index")).unwrap(),
            index,
            "{mode}"
        );
        assert_eq!(
            git_output(root, &["diff", "--cached", "--numstat"]),
            staged,
            "{mode}"
        );
        // A staged addition removed again contributes no working-file lines.
        std::fs::remove_file(root.join("ignored.txt")).unwrap();
        let status = mgr.status(folder).await.unwrap();
        assert_eq!(
            (status.insertions, status.deletions),
            (if mode == "unborn" { 2 } else { 1 }, 0),
            "{mode}"
        );
        assert_eq!(
            std::fs::read(git_dir.join("index")).unwrap(),
            index,
            "{mode}"
        );
        assert_eq!(
            git_output(root, &["diff", "--cached", "--numstat"]),
            staged,
            "{mode}"
        );
    }
}

#[tokio::test]
async fn diff_commits_does_not_run_a_gitattributes_textconv_driver() {
    let repo_dir = tempfile::tempdir().unwrap();
    let repo = init_repo(repo_dir.path()).canonicalize().unwrap();
    let data_dir = tempfile::tempdir().unwrap();
    let mgr = manager(data_dir.path());
    let created = mgr
        .create_named(&repo, RunId::generate(), None, None)
        .await
        .unwrap();

    // The driver itself is configured locally (as a repository's own `.git/config` might be, for
    // example by git-lfs); the worker's own writable surface is `.gitattributes`, routing a file
    // of its choosing through that driver.
    let sentinel = data_dir.path().join("sentinel-textconv");
    let script = created.path.join("textconv.sh");
    write_sentinel_script(&script, &sentinel);
    git(
        &created.path,
        &["config", "diff.evil.textconv", script.to_str().unwrap()],
    );
    std::fs::write(created.path.join(".gitattributes"), "*.bin diff=evil\n").unwrap();
    std::fs::write(created.path.join("data.bin"), "binary-ish\n").unwrap();
    let commit = mgr
        .commit_all(&created.path, &created.git_dir, &repo, "agent changes")
        .await
        .unwrap()
        .expect("there was something to commit");

    let diff = mgr
        .diff_commits(&created.path, &created.git_dir, &created.base, &commit.sha)
        .await
        .unwrap();

    assert!(
        diff.files
            .iter()
            .any(|file| file.path == "data.bin" && file.diff.is_some())
    );

    assert!(!sentinel.exists(), "the textconv driver must not have run");
}

#[tokio::test]
async fn stage_all_does_not_run_a_gitattributes_filter_from_a_fake_global_config() {
    let repo_dir = tempfile::tempdir().unwrap();
    let repo = init_repo(repo_dir.path()).canonicalize().unwrap();

    // A fake "ambient" HOME with a global gitconfig defining a filter driver, standing in for
    // whatever an inherited or otherwise compromised environment might already have configured.
    // A worker can't write here, but plxd's worktree-scoped calls must not reach it either
    // way — `GIT_CONFIG_NOSYSTEM`, `GIT_CONFIG_GLOBAL`, and `HOME` are all overridden.
    let fake_home = tempfile::tempdir().unwrap();
    let sentinel = fake_home.path().join("sentinel-filter");
    let script = fake_home.path().join("evil-clean.sh");
    write_sentinel_script(&script, &sentinel);
    std::fs::write(
        fake_home.path().join(".gitconfig"),
        format!("[filter \"evil\"]\n\tclean = {}\n", script.display()),
    )
    .unwrap();

    let data_dir = tempfile::tempdir().unwrap();
    let path = std::env::var("PATH").unwrap();
    let base: Environment = [
        ("PATH", path.as_str()),
        ("HOME", fake_home.path().to_str().unwrap()),
    ]
    .into_iter()
    .collect();
    let launcher = Launcher::new(DataDir::new(data_dir.path()).unwrap(), base);
    let mgr = WorktreeManager::new(launcher, data_dir.path());
    let created = mgr
        .create_named(&repo, RunId::generate(), None, None)
        .await
        .unwrap();

    std::fs::write(
        created.path.join(".gitattributes"),
        "*.secret filter=evil\n",
    )
    .unwrap();
    std::fs::write(created.path.join("leak.secret"), "sensitive\n").unwrap();

    mgr.diff_stat(&created.path, &created.git_dir, &created.base)
        .await
        .unwrap();

    assert!(!sentinel.exists(), "the filter driver must not have run");
}
