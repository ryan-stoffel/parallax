//! `agent/files` and `agent/file`'s `working` side (RYA-296): browsing a thread's folder on disk,
//! for a thread in a worktree and one in the user's own checkout.

use parallax_protocol::methods::{AgentFile, AgentFiles};
use parallax_protocol::{
    AgentEntry, AgentEntryKind, AgentFileParams, AgentFileResult, AgentFileSide, AgentFilesParams,
};

use super::*;
use crate::agents::decode_base64;

/// A repository with a `.gitignore` and a folder, committed on `main`.
fn repo_with_ignores(dir: &Path) -> PathBuf {
    let path = real_repo(dir, "app");
    std::fs::write(path.join(".gitignore"), "target/\n*.log\n").unwrap();
    std::fs::create_dir(path.join("src")).unwrap();
    std::fs::write(path.join("src/lib.rs"), "pub fn f() {}\n").unwrap();
    git(&path, &["add", "-A"]);
    git(&path, &["commit", "-q", "-m", "ignores"]);
    path
}

/// Files git ignores, symlinks out of `folder`, and a name that looks like pathspec magic.
fn add_ignored_and_links(folder: &Path) {
    std::fs::write(folder.join(":!x"), "").unwrap();
    std::fs::create_dir(folder.join("target")).unwrap();
    std::fs::write(folder.join("target/out"), "built").unwrap();
    std::fs::write(folder.join("debug.log"), "noise").unwrap();
    std::os::unix::fs::symlink("/etc", folder.join("etc")).unwrap();
    std::os::unix::fs::symlink("/etc/hosts", folder.join("hosts")).unwrap();
}

async fn list(
    client: &mut Conn,
    run_id: RunId,
    path: Option<&str>,
) -> Result<Vec<AgentEntry>, ErrorObject> {
    let listed = client
        .call::<AgentFiles>(AgentFilesParams {
            run_id,
            path: path.map(str::to_owned),
        })
        .await?;
    assert!(!listed.truncated);
    Ok(listed.entries)
}

fn names(entries: &[AgentEntry]) -> Vec<(&str, AgentEntryKind)> {
    entries.iter().map(|e| (e.name.as_str(), e.kind)).collect()
}

async fn read(
    client: &mut Conn,
    run_id: RunId,
    path: &str,
    size_only: bool,
) -> Result<AgentFileResult, ErrorObject> {
    client
        .call::<AgentFile>(AgentFileParams {
            run_id,
            path: path.to_owned(),
            side: AgentFileSide::Working,
            size_only: size_only.then_some(true),
        })
        .await
}

async fn text(client: &mut Conn, run_id: RunId, path: &str) -> String {
    let file = read(client, run_id, path, false).await.unwrap();
    assert!(
        file.exists && !file.too_large && file.commit.is_none(),
        "{file:?}"
    );
    String::from_utf8(decode_base64(&file.content.unwrap())).unwrap()
}

#[tokio::test]
async fn a_worktree_threads_files_list_by_folder_without_git_or_ignored_entries() {
    let host = Host::start(fake(editing()));
    let path = repo_with_ignores(host.work.path());
    let mut client = host.client().await;
    let repo = client.add(&path).await;
    client.subscribe(0, Some(scope(repo.id))).await;
    let started = client
        .call::<ThreadStart>(start_params(Some(repo.id), "Write some notes"))
        .await
        .unwrap();
    let run_id = started.run.id;
    client.until(updated_to(AgentStatus::Completed)).await;
    let worktree = PathBuf::from(started.run.worktree_path.unwrap());
    add_ignored_and_links(&worktree);

    let root = list(&mut client, run_id, None).await.unwrap();
    assert_eq!(
        names(&root),
        [
            (".gitignore", AgentEntryKind::File),
            (":!x", AgentEntryKind::File),
            ("NOTES.md", AgentEntryKind::File),
            ("README.md", AgentEntryKind::File),
            ("etc", AgentEntryKind::Symlink),
            ("hosts", AgentEntryKind::Symlink),
            ("src", AgentEntryKind::Dir),
        ],
        "no .git, target/, or debug.log"
    );
    assert_eq!(root[3].size, Some(6));
    assert_eq!(root[6].size, None);
    let src = list(&mut client, run_id, Some("src")).await.unwrap();
    assert_eq!(names(&src), [("lib.rs", AgentEntryKind::File)]);

    // The working side reads the file on disk, uncommitted edits included.
    std::fs::write(worktree.join("src/lib.rs"), "pub fn g() {}\n").unwrap();
    assert_eq!(
        text(&mut client, run_id, "src/lib.rs").await,
        "pub fn g() {}\n"
    );
    assert_eq!(
        text(&mut client, run_id, "hosts").await,
        "/etc/hosts",
        "a symlink is its target"
    );
    let stat = read(&mut client, run_id, "NOTES.md", true).await.unwrap();
    assert_eq!(
        (stat.exists, stat.size, stat.content),
        (true, Some(21), None)
    );
    let missing = read(&mut client, run_id, "nope/nope.md", false)
        .await
        .unwrap();
    assert!(!missing.exists);
    std::fs::write(worktree.join("big.bin"), vec![0; 4 * 1024 * 1024 + 1]).unwrap();
    let big = read(&mut client, run_id, "big.bin", false).await.unwrap();
    assert!(
        big.exists && big.too_large && big.content.is_none(),
        "{big:?}"
    );

    // Nothing outside the folder, through a symlink, or inside .git.
    for escape in [
        "../../../../etc",
        "/etc",
        "..",
        "./src",
        "src/..",
        ".git",
        ".GIT/refs",
        "a\\..\\..\\b",
        "",
        "etc",
        "README.md",
        "nope",
    ] {
        let error = list(&mut client, run_id, Some(escape)).await.unwrap_err();
        assert_eq!(error.code, INVALID_PARAMS, "{escape:?}: {error:?}");
    }
    for escape in ["../README.md", ".git/config", "etc/hosts", "src", ""] {
        let error = read(&mut client, run_id, escape, false).await.unwrap_err();
        assert_eq!(error.code, INVALID_PARAMS, "{escape:?}: {error:?}");
    }
    let unknown = list(&mut client, RunId::generate(), None)
        .await
        .unwrap_err();
    assert_eq!(kind(&unknown), ErrorKind::RunNotFound);
}

#[tokio::test]
async fn a_checkout_threads_files_are_its_repositorys_checkout() {
    let host = Host::start(fake(editing()));
    let path = repo_with_ignores(host.work.path());
    std::fs::write(path.join("README.md"), "edited by the user\n").unwrap();
    add_ignored_and_links(&path);
    let mut client = host.client().await;
    let repo = client.add(&path).await;
    client.subscribe(0, Some(scope(repo.id))).await;
    let params = ThreadStartParams {
        checkout: true,
        ..start_params(Some(repo.id), "Write some notes")
    };
    let run_id = client.call::<ThreadStart>(params).await.unwrap().run.id;
    client.until(updated_to(AgentStatus::Completed)).await;

    let root = list(&mut client, run_id, None).await.unwrap();
    assert_eq!(
        names(&root),
        [
            (".gitignore", AgentEntryKind::File),
            (":!x", AgentEntryKind::File),
            ("NOTES.md", AgentEntryKind::File),
            ("README.md", AgentEntryKind::File),
            ("etc", AgentEntryKind::Symlink),
            ("hosts", AgentEntryKind::Symlink),
            ("src", AgentEntryKind::Dir),
        ]
    );
    assert_eq!(
        text(&mut client, run_id, "README.md").await,
        "edited by the user\n"
    );
    assert_eq!(
        text(&mut client, run_id, "NOTES.md").await,
        "Written in a thread.\n"
    );
    let error = list(&mut client, run_id, Some("etc")).await.unwrap_err();
    assert_eq!(error.code, INVALID_PARAMS);
}
