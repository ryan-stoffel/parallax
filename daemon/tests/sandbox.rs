//! Claude Code's worker sandbox, for real (0013). Runs the Claude Code named in
//! `PLX_SANDBOX_CLAUDE` with the arguments plxd gives a worker, against a fake Messages API on
//! 127.0.0.1 that asks for one Bash command, then checks what that command could do. Nothing
//! reaches Anthropic, and no login is used.
//!
//! Skipped when `PLX_SANDBOX_CLAUDE` is unset. CI's Linux legs install bubblewrap, socat, and a
//! pinned Claude Code, and set it.
#![cfg(unix)]

mod common;

use std::fmt::Write as _;
use std::fs;
use std::os::unix::fs::{DirBuilderExt as _, PermissionsExt};
use std::os::unix::net::UnixListener;
use std::path::{Path, PathBuf};

use common::{run_worker, tool_result, worker_request};
use plxd::backend::RunRequest;
use plxd::backend::claude::{commands_temp, worker_temp};
use plxd::backend::run_temp;
use plxd::paths::DataDir;

const SECRET: &str = "parallax-sandbox-test-secret";

/// Held for a whole test, since [`a_worker_s_temp_is_its_own`] makes and removes `/tmp/claude`.
/// Claude Code binds it into a command's sandbox if it exists when the command is wrapped, and
/// bwrap fails if it is gone by the time bwrap starts (PLX-665).
static TMP_CLAUDE: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

#[tokio::test]
async fn a_worker_cannot_read_secrets_write_outside_its_worktree_or_reach_unix_sockets() {
    let Some(claude) = std::env::var_os("PLX_SANDBOX_CLAUDE") else {
        eprintln!("skipped: PLX_SANDBOX_CLAUDE doesn't name a Claude Code to test");
        return;
    };
    let _tmp_claude = TMP_CLAUDE.lock().await;
    let dir = tempfile::tempdir().unwrap();
    // Canonical, since Seatbelt matches real paths and macOS's temp folder is behind a symlink.
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
        &data.join("context/other"),
        &git_dir,
    ] {
        fs::create_dir_all(folder).unwrap();
    }
    // A key in the home folder, and another project's context in plxd's data folder.
    fs::write(home.join(".ssh/id_ed25519"), format!("{SECRET}-key")).unwrap();
    fs::write(
        data.join("context/other/notes.md"),
        format!("{SECRET}-notes"),
    )
    .unwrap();
    let git_file = format!("gitdir: {}/worktrees/run\n", git_dir.display());
    fs::write(worktree.join(".git"), &git_file).unwrap();
    let socket = root.join("probe.sock");
    let listener = UnixListener::bind(&socket).unwrap();
    listener.set_nonblocking(true).unwrap();

    // The probe is a script in the worktree, so Claude Code's permission checks can't see what it
    // touches, as with any build script a worker runs. Only the OS sandbox stands in its way.
    let path = |path: &Path| path.display().to_string();
    let mut probe = format!(
        "cat '{key}'\n\
         cat '{notes}'\n\
         echo x > '{home_file}'\n\
         echo x > '{root_file}'\n\
         echo x > '{git_file}'\n\
         echo x > '{inside}' && echo wrote-inside\n\
         echo x > '{note}' && echo wrote-context\n",
        key = path(&home.join(".ssh/id_ed25519")),
        notes = path(&data.join("context/other/notes.md")),
        home_file = path(&home.join("outside")),
        root_file = path(&root.join("outside")),
        git_file = path(&worktree.join(".git")),
        inside = path(&worktree.join("inside")),
        note = path(&context.join("note")),
    );
    let (mut request, _temp) = worker_request(&home, &data, &worktree, &git_dir, &context);
    if cfg!(target_os = "linux") {
        // The seccomp filter's job: no Unix sockets, such as the D-Bus session bus.
        writeln!(
            probe,
            "socat -u OPEN:/dev/null 'UNIX-CONNECT:{}' && echo socket-connected",
            path(&socket)
        )
        .unwrap();
        probe_registry_login(&mut probe, &mut request, &root);
    }
    fs::write(worktree.join("probe.sh"), probe).unwrap();

    let (stdout, transcript) = run_worker(
        &claude,
        &request,
        &root,
        &home,
        &[("ANTHROPIC_API_KEY", "sk-ant-parallax-sandbox-test")],
    )
    .await;

    let result = tool_result(&stdout).unwrap_or_else(|| panic!("no Bash result:\n{transcript}"));
    assert!(result.contains("wrote-inside"), "{transcript}");
    assert!(result.contains("wrote-context"), "{result}");
    assert!(worktree.join("inside").exists());
    assert!(context.join("note").exists());
    assert!(!stdout.contains(SECRET), "a secret was read:\n{result}");
    assert!(!home.join("outside").exists(), "{result}");
    assert!(!root.join("outside").exists(), "{result}");
    assert_eq!(fs::read_to_string(worktree.join(".git")).unwrap(), git_file);
    if cfg!(target_os = "linux") {
        assert!(!result.contains("socket-connected"), "{result}");
        assert!(
            listener.accept().is_err(),
            "a Unix socket connect got through"
        );
    }
}

/// Writes a registry login where rootless Podman keeps one, in a runtime folder under `root`,
/// denies that folder as `WorkerSandbox::for_worktree` denies the user's runtime folders on Linux,
/// and adds a read of the login to `probe` (PLX-107). Which folders those are is `sandbox.rs`'s
/// unit tests' job; this checks that the sandbox holds a deny there.
fn probe_registry_login(probe: &mut String, request: &mut RunRequest, root: &Path) {
    let runtime = root.join("run");
    let login = runtime.join("containers/auth.json");
    fs::create_dir_all(login.parent().unwrap()).unwrap();
    fs::set_permissions(&runtime, fs::Permissions::from_mode(0o700)).unwrap();
    fs::write(&login, format!("{SECRET}-registry")).unwrap();
    request.sandbox.as_mut().unwrap().unreadable.push(runtime);
    writeln!(probe, "cat '{}'", login.display()).unwrap();
}

/// A worker's `TMPDIR` is its own run's (PLX-130): it can't read or write another run's temp
/// folder, the `/tmp/claude-<uid>` every Claude Code session shares, or its CLI's own temp files,
/// and it can't write the paths Claude Code's sandbox would always allow.
#[tokio::test]
async fn a_worker_s_temp_is_its_own() {
    let Some(claude) = std::env::var_os("PLX_SANDBOX_CLAUDE") else {
        eprintln!("skipped: PLX_SANDBOX_CLAUDE doesn't name a Claude Code to test");
        return;
    };
    let _tmp_claude = TMP_CLAUDE.lock().await;
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().canonicalize().unwrap();
    let home = root.join("home");
    let data = root.join("data");
    let worktree = data.join("worktrees/run");
    let context = data.join("context/p");
    let git_dir = root.join("repo/.git");
    for folder in [
        &home.join(".npm/_logs"),
        &home.join(".claude/debug"),
        &worktree,
        &context,
        &git_dir,
    ] {
        fs::create_dir_all(folder).unwrap();
    }
    let git_file = format!("gitdir: {}/worktrees/run\n", git_dir.display());
    fs::write(worktree.join(".git"), git_file).unwrap();
    let (request, _temp) = worker_request(&home, &data, &worktree, &git_dir, &context);
    let temp = &request.sandbox.as_ref().unwrap().temp;
    // Another run of the same plxd, and what another Claude Code session left in the shared
    // folder, which this makes if it's missing.
    let other = run_temp::create(&DataDir::new(&data).unwrap()).unwrap();
    fs::write(other.path().join("secret"), format!("{SECRET}-other-run")).unwrap();
    let uid = rustix::process::getuid().as_raw();
    let shared = Path::new("/tmp").join(format!("claude-{uid}"));
    if let Err(error) = fs::DirBuilder::new().mode(0o700).create(&shared) {
        assert_eq!(error.kind(), std::io::ErrorKind::AlreadyExists, "{error}");
    }
    let session = tempfile::Builder::new()
        .prefix("parallax-sandbox-test-")
        .tempdir_in(&shared)
        .unwrap();
    fs::write(session.path().join("output"), format!("{SECRET}-session")).unwrap();
    // One of the paths the sandbox always lets commands write, made to exist so only the rule
    // can stop the write.
    let made_tmp_claude = fs::create_dir("/tmp/claude").is_ok();

    // What counts is what reaches the disk: on Linux, a write under a hidden folder lands in
    // the tmpfs that hides it, which only that one command sees.
    let planted = [
        temp.join("planted"),
        other.path().join("planted"),
        session.path().join("planted"),
        home.join(".npm/_logs/planted"),
        home.join(".claude/debug/planted"),
        PathBuf::from("/tmp/claude/parallax-sandbox-test"),
    ];
    let mut probe = format!(
        "echo \"tmpdir=$TMPDIR\"\n\
         echo x > \"$TMPDIR/file\"\n\
         cat '{}/secret'\n\
         cat '{}/output'\n",
        other.path().display(),
        session.path().display(),
    );
    for file in &planted {
        writeln!(probe, "echo x > '{}'", file.display()).unwrap();
    }
    fs::write(worktree.join("probe.sh"), probe).unwrap();
    let (stdout, transcript) = run_worker(
        &claude,
        &request,
        &root,
        &home,
        &[("ANTHROPIC_API_KEY", "sk-ant-parallax-sandbox-test")],
    )
    .await;
    let written: Vec<&PathBuf> = planted.iter().filter(|file| file.exists()).collect();
    if made_tmp_claude {
        fs::remove_dir_all("/tmp/claude").unwrap();
    }

    let result = tool_result(&stdout).unwrap_or_else(|| panic!("no Bash result:\n{transcript}"));
    let own = worker_temp(temp).unwrap().join(format!("claude-{uid}"));
    assert!(
        result.contains(&format!("tmpdir={}\n", own.display())),
        "{transcript}"
    );
    assert!(commands_temp(temp).join("file").exists(), "{result}");
    assert!(!stdout.contains(SECRET), "a secret was read:\n{result}");
    assert!(written.is_empty(), "wrote {written:?}:\n{result}");
}
