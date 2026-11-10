//! `agent/files` and `agent/file`'s `working` side (PLX-296): browsing a worktree thread's folder
//! on disk; and `agent/fileCreate`, `agent/fileRename`, and `agent/fileDelete` (PLX-590)
//! changing it.

use parallax_protocol::methods::{
    AgentFile, AgentFileCreate, AgentFileDelete, AgentFileRename, AgentFileWrite, AgentFiles,
    RepoLogo, RepoUpdate,
};
use parallax_protocol::{
    AgentEntry, AgentEntryKind, AgentFileCreateParams, AgentFileDeleteParams, AgentFileParams,
    AgentFileRenameParams, AgentFileResult, AgentFileSide, AgentFileWriteParams,
    AgentFileWriteResult, AgentFilesParams, ChosenIcon, RepoLogoParams, RepoUpdateParams,
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

/// A finished thread in a worktree of [`repo_with_ignores`], with [`add_ignored_and_links`]'s
/// entries: its host, a client subscribed to its events, its repo entry, its run, and its
/// worktree.
async fn worktree_thread() -> (Host, Conn, RepoId, RunId, PathBuf) {
    let host = Host::start(fake(editing()));
    let path = repo_with_ignores(host.work.path());
    let mut client = host.client().await;
    let repo = client.add(&path).await;
    client.subscribe(0, Some(scope(repo.id))).await;
    let started = client
        .call::<ThreadStart>(start_params(Some(repo.id), "Write some notes"))
        .await
        .unwrap();
    client.until(updated_to(AgentStatus::Completed)).await;
    let worktree = PathBuf::from(started.run.worktree_path.unwrap());
    add_ignored_and_links(&worktree);
    (host, client, repo.id, started.run.id, worktree)
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
            offset: None,
            length: None,
            hash: None,
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
    let (_host, mut client, _, run_id, worktree) = worktree_thread().await;

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

async fn create(
    client: &mut Conn,
    run_id: RunId,
    path: &str,
    folder: bool,
) -> Result<(), ErrorObject> {
    let params = AgentFileCreateParams {
        run_id,
        path: path.to_owned(),
        folder,
    };
    client.call::<AgentFileCreate>(params).await.map(drop)
}

async fn rename(client: &mut Conn, run_id: RunId, from: &str, to: &str) -> Result<(), ErrorObject> {
    let params = AgentFileRenameParams {
        run_id,
        from: from.to_owned(),
        to: to.to_owned(),
    };
    client.call::<AgentFileRename>(params).await.map(drop)
}

async fn delete(client: &mut Conn, run_id: RunId, path: &str) -> Result<(), ErrorObject> {
    let params = AgentFileDeleteParams {
        run_id,
        path: path.to_owned(),
    };
    client.call::<AgentFileDelete>(params).await.map(drop)
}

#[tokio::test]
async fn files_and_folders_are_created_renamed_and_deleted_inside_the_threads_folder() {
    let (_host, mut client, _, run_id, worktree) = worktree_thread().await;

    create(&mut client, run_id, "src/util", true).await.unwrap();
    create(&mut client, run_id, "src/util/mod.rs", false)
        .await
        .unwrap();
    assert_eq!(
        names(&list(&mut client, run_id, Some("src/util")).await.unwrap()),
        [("mod.rs", AgentEntryKind::File)]
    );
    assert_eq!(text(&mut client, run_id, "src/util/mod.rs").await, "");

    // A folder moves with its contents; a change of case alone is allowed.
    rename(&mut client, run_id, "src/util", "src/helpers")
        .await
        .unwrap();
    assert!(worktree.join("src/helpers/mod.rs").is_file());
    rename(
        &mut client,
        run_id,
        "src/helpers/mod.rs",
        "src/helpers/Mod.rs",
    )
    .await
    .unwrap();
    assert_eq!(
        names(
            &list(&mut client, run_id, Some("src/helpers"))
                .await
                .unwrap()
        ),
        [("Mod.rs", AgentEntryKind::File)]
    );

    // Nothing is overwritten, and nothing moves into itself.
    for error in [
        create(&mut client, run_id, "README.md", false).await,
        create(&mut client, run_id, "src", true).await,
        create(&mut client, run_id, "hosts", false).await,
        create(&mut client, run_id, "nope/new.md", false).await,
        rename(&mut client, run_id, "README.md", "NOTES.md").await,
        rename(&mut client, run_id, "src", "src/helpers/src").await,
        rename(&mut client, run_id, "nope", "nope2").await,
        delete(&mut client, run_id, "nope").await,
    ] {
        assert_eq!(error.unwrap_err().code, INVALID_PARAMS);
    }
    assert_eq!(text(&mut client, run_id, "README.md").await, "hello\n");

    // A symlink goes, never what it points to; a folder goes with everything in it.
    delete(&mut client, run_id, "hosts").await.unwrap();
    assert!(std::path::Path::new("/etc/hosts").exists());
    delete(&mut client, run_id, "src").await.unwrap();
    assert!(!worktree.join("src").exists());

    // Nothing outside the folder, through a symlink, or inside .git.
    for escape in ["../x", "/tmp/x", ".git/x", ".GIT", "etc/x", "a\\..\\b", ""] {
        let error = create(&mut client, run_id, escape, false)
            .await
            .unwrap_err();
        assert_eq!(error.code, INVALID_PARAMS, "{escape:?}: {error:?}");
        let error = rename(&mut client, run_id, "README.md", escape)
            .await
            .unwrap_err();
        assert_eq!(error.code, INVALID_PARAMS, "{escape:?}: {error:?}");
        let error = delete(&mut client, run_id, escape).await.unwrap_err();
        assert_eq!(error.code, INVALID_PARAMS, "{escape:?}: {error:?}");
    }
    assert!(worktree.join(".git").exists());
}

/// Saves `content` to `path`, as edited from the content whose SHA-256 is `expected_sha256`.
async fn save(
    client: &mut Conn,
    run_id: RunId,
    path: &str,
    content: &str,
    expected_sha256: Option<String>,
) -> Result<AgentFileWriteResult, ErrorObject> {
    client
        .call::<AgentFileWrite>(AgentFileWriteParams {
            run_id,
            path: path.to_owned(),
            content: data_encoding::BASE64.encode(content.as_bytes()),
            expected_sha256,
        })
        .await
}

/// `path`'s SHA-256, read as a client checks a file for changes: with no content.
async fn hash_of(client: &mut Conn, run_id: RunId, path: &str) -> Option<String> {
    let file = client
        .call::<AgentFile>(AgentFileParams {
            run_id,
            path: path.to_owned(),
            side: AgentFileSide::Working,
            size_only: Some(true),
            offset: None,
            length: None,
            hash: Some(true),
        })
        .await
        .unwrap();
    assert!(file.content.is_none(), "{file:?}");
    file.sha256
}

#[tokio::test]
async fn a_save_replaces_a_file_only_if_it_has_not_changed_since_it_was_read() {
    let (_host, mut client, _repo, run_id, worktree) = worktree_thread().await;
    let file = worktree.join("src/lib.rs");
    let read = hash_of(&mut client, run_id, "src/lib.rs").await;
    assert_eq!(read.as_ref().map(String::len), Some(64));

    let saved = save(&mut client, run_id, "src/lib.rs", "one\n", read.clone())
        .await
        .unwrap();
    assert!(!saved.conflict);
    assert_eq!(std::fs::read_to_string(&file).unwrap(), "one\n");
    assert_eq!(
        saved.sha256,
        hash_of(&mut client, run_id, "src/lib.rs").await
    );

    // The agent writes it: a save from the old read changes nothing and says what's there now.
    std::fs::write(&file, "the agent's\n").unwrap();
    let conflict = save(&mut client, run_id, "src/lib.rs", "two\n", saved.sha256)
        .await
        .unwrap();
    assert!(conflict.conflict);
    assert_eq!(std::fs::read_to_string(&file).unwrap(), "the agent's\n");
    assert_eq!(
        conflict.sha256,
        hash_of(&mut client, run_id, "src/lib.rs").await
    );

    // Overwrite is the same call with that SHA-256.
    let replaced = save(&mut client, run_id, "src/lib.rs", "two\n", conflict.sha256)
        .await
        .unwrap();
    assert!(!replaced.conflict);
    assert_eq!(std::fs::read_to_string(&file).unwrap(), "two\n");

    // The agent deletes it: a conflict with no SHA-256, and no SHA-256 expected puts it back.
    std::fs::remove_file(&file).unwrap();
    let gone = save(
        &mut client,
        run_id,
        "src/lib.rs",
        "three\n",
        replaced.sha256,
    )
    .await
    .unwrap();
    assert_eq!((gone.conflict, gone.sha256), (true, None));
    assert!(!file.exists());
    assert!(
        !save(&mut client, run_id, "src/lib.rs", "three\n", None)
            .await
            .unwrap()
            .conflict
    );
    assert_eq!(std::fs::read_to_string(&file).unwrap(), "three\n");

    // A file that exists isn't replaced by a save expecting none.
    assert!(
        save(&mut client, run_id, "src/lib.rs", "four\n", None)
            .await
            .unwrap()
            .conflict
    );
    // No temp file stays behind.
    let left: Vec<_> = std::fs::read_dir(worktree.join("src"))
        .unwrap()
        .map(|entry| entry.unwrap().file_name())
        .collect();
    assert_eq!(left, ["lib.rs"]);
}

#[tokio::test]
async fn a_save_keeps_permissions_and_refuses_what_is_not_a_regular_file() {
    use std::os::unix::fs::PermissionsExt as _;
    let (_host, mut client, _repo, run_id, worktree) = worktree_thread().await;
    let script = worktree.join("run.sh");
    std::fs::write(&script, "#!/bin/sh\n").unwrap();
    std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o750)).unwrap();
    let read = hash_of(&mut client, run_id, "run.sh").await;
    save(&mut client, run_id, "run.sh", "#!/bin/sh\necho\n", read)
        .await
        .unwrap();
    assert_eq!(
        std::fs::metadata(&script).unwrap().permissions().mode() & 0o777,
        0o750
    );

    // A symlink isn't followed, whatever SHA-256 comes with it.
    let target = std::fs::read("/etc/hosts").unwrap();
    let error = save(&mut client, run_id, "hosts", "no\n", None)
        .await
        .unwrap_err();
    assert!(error.message.contains("not a regular file"), "{error:?}");
    assert_eq!(std::fs::read("/etc/hosts").unwrap(), target);
    assert!(
        std::fs::symlink_metadata(worktree.join("hosts"))
            .unwrap()
            .is_symlink()
    );
    let error = save(&mut client, run_id, "src", "no\n", None)
        .await
        .unwrap_err();
    assert!(error.message.contains("not a regular file"), "{error:?}");
    // Nor does a path leave the folder, or a save reach `.git`.
    for path in ["../out", ".git/config", "etc/out"] {
        assert!(
            save(&mut client, run_id, path, "no\n", None).await.is_err(),
            "{path}"
        );
    }
    // Content that isn't base64 is refused before anything is touched.
    let error = client
        .call::<AgentFileWrite>(AgentFileWriteParams {
            run_id,
            path: "run.sh".to_owned(),
            content: "%%".to_owned(),
            expected_sha256: None,
        })
        .await
        .unwrap_err();
    assert!(error.message.contains("base64"), "{error:?}");
}

/// `repo/logo` (PLX-1272): nothing for a repository with no logo, then its own favicon as it is on
/// disk, past an ignored file and a symlink that would each rank first.
#[tokio::test]
async fn repo_logo_reads_the_best_regular_file_git_does_not_ignore() {
    let host = Host::start(fake(editing()));
    let path = real_repo(host.work.path(), "app");
    let mut client = host.client().await;
    let repo = client.add(&path).await.id;
    let found = client.call::<RepoLogo>(RepoLogoParams { repo }).await;
    assert_eq!(found.unwrap().logo, None);

    std::fs::write(path.join(".gitignore"), "ignored/\n").unwrap();
    std::fs::create_dir(path.join("ignored")).unwrap();
    std::fs::write(path.join("ignored/favicon.svg"), "<svg/>").unwrap();
    std::fs::create_dir(path.join("public")).unwrap();
    std::fs::write(path.join("public/favicon.png"), b"png").unwrap();
    #[cfg(unix)]
    std::os::unix::fs::symlink("/etc/hosts", path.join("favicon.svg")).unwrap();

    let found = client.call::<RepoLogo>(RepoLogoParams { repo }).await;
    let logo = found.unwrap().logo.unwrap();
    assert_eq!(logo.path, "public/favicon.png");
    assert_eq!(logo.media_type, "image/png");
    assert_eq!(decode_base64(&logo.data), b"png");

    // Setting it only if unset takes it on a bare entry, and leaves one the user picked.
    let set = |name: &str| RepoUpdateParams {
        repo,
        icon: Some(ChosenIcon {
            name: name.to_owned(),
            color: None,
            image: None,
        }),
        icon_if_unset: true,
        name: None,
        instructions: None,
        files: None,
    };
    let first = client.call::<RepoUpdate>(set("rocket")).await.unwrap();
    assert_eq!(first.repo.icon.unwrap().name, "rocket");
    let second = client.call::<RepoUpdate>(set("folder")).await.unwrap();
    assert_eq!(second.repo.icon.unwrap().name, "rocket");
}

/// A pick records when it was made (PLX-1498), again when it is the icon already there, so an app
/// can draw the newest pick on every computer's copy of a repository. A logo set only if unset
/// isn't a pick.
#[tokio::test]
async fn picking_a_repo_icon_records_when() {
    let host = Host::start(fake(editing()));
    let path = real_repo(host.work.path(), "app");
    let mut client = host.client().await;
    let repo = client.add(&path).await.id;
    let set = |name: &str, icon_if_unset: bool| RepoUpdateParams {
        repo,
        icon: Some(ChosenIcon {
            name: name.to_owned(),
            color: None,
            image: None,
        }),
        icon_if_unset,
        name: None,
        instructions: None,
        files: None,
    };
    let logo = client
        .call::<RepoUpdate>(set("rocket", true))
        .await
        .unwrap();
    assert_eq!(logo.repo.icon_at, None);

    let picked = client
        .call::<RepoUpdate>(set("flame", false))
        .await
        .unwrap();
    let first = picked.repo.icon_at.expect("a pick has a time");
    let again = client
        .call::<RepoUpdate>(set("flame", false))
        .await
        .unwrap();
    assert!(again.repo.icon_at.unwrap() > first);
}
