use std::cell::Cell;
use std::future::ready;
use std::path::Path;
use std::time::Duration;

use parallax_protocol::PrMediaFile;
use tokio::time::Instant;

use super::{
    BUDGET, Gist, Limit, QUEUE_WAIT, backoff, check, embed, limit, media_name, parse_gist, put,
    repository, turn, upload_all,
};
use crate::backend::process::{Environment, Launcher};
use crate::paths::DataDir;
use crate::worktree::{PrError, WorktreeManager};

fn file(path: &Path, caption: Option<&str>) -> PrMediaFile {
    PrMediaFile {
        path: path.to_string_lossy().into_owned(),
        caption: caption.map(str::to_owned),
    }
}

/// A turn in the queue that the test can tell was taken.
fn counted(turns: &Cell<u32>) -> impl Future<Output = Result<(), PrError>> {
    turns.set(turns.get() + 1);
    ready(Ok(()))
}

fn secondary() -> PrError {
    PrError::Gh("gh: You have exceeded a secondary rate limit (HTTP 403)".to_owned())
}

#[tokio::test]
async fn the_same_bytes_reuse_their_link_without_a_push_or_a_wait() {
    let dir = tempfile::tempdir().unwrap();
    let index = dir.path().join("pr-media.json");
    let shot = dir.path().join("Settings page.png");
    let again = dir.path().join("copy.png");
    std::fs::write(&shot, b"png bytes").unwrap();
    std::fs::write(&again, b"png bytes").unwrap();
    let mut puts = Vec::new();
    let mut put = |name: String, _: Vec<u8>| {
        let url = format!("https://gist/{name}");
        puts.push(name);
        ready(Ok(url))
    };
    let turns = Cell::new(0);

    let first = upload_all(
        &index,
        "ryan/abc",
        vec![check(&file(&shot, Some("After"))).unwrap()],
        async { counted(&turns).await },
        &mut put,
    )
    .await
    .unwrap();
    let url = "https://gist/d013614dc14a-Settings-page.png";
    assert_eq!(first[0].url, url);
    assert_eq!(first[0].markdown, format!("![After]({url})"));
    assert!(!first[0].reused);
    assert_eq!(turns.get(), 1);

    // Another file with the same bytes, read from the saved index, for the same gist: no upload,
    // and no wait for the queue.
    let second = upload_all(
        &index,
        "ryan/abc",
        vec![check(&file(&again, None)).unwrap()],
        async { counted(&turns).await },
        &mut put,
    )
    .await
    .unwrap();
    assert_eq!(second[0].url, url);
    assert_eq!(second[0].markdown, format!("![copy.png]({url})"));
    assert!(second[0].reused);
    assert_eq!(turns.get(), 1);

    // Another gist gets its own copy.
    upload_all(
        &index,
        "ryan/def",
        vec![check(&file(&again, None)).unwrap()],
        async { counted(&turns).await },
        &mut put,
    )
    .await
    .unwrap();
    assert_eq!(
        puts,
        ["d013614dc14a-Settings-page.png", "d013614dc14a-copy.png"]
    );
}

fn run(dir: &Path, args: &[&str]) -> String {
    let output = std::process::Command::new("git")
        .args(args)
        .current_dir(dir)
        .output()
        .unwrap();
    assert!(output.status.success(), "git {args:?}: {output:?}");
    String::from_utf8(output.stdout).unwrap()
}

/// A bare repository standing in for a gist, with a README on `main`, and a checkout of it.
fn fake_gist(dir: &Path) -> (std::path::PathBuf, std::path::PathBuf) {
    let remote = dir.join("gist.git");
    let other = dir.join("other");
    std::fs::create_dir(&remote).unwrap();
    run(
        &remote,
        &["init", "--quiet", "--bare", "--initial-branch=main"],
    );
    // As GitHub does, so the clone is blobless.
    run(&remote, &["config", "uploadpack.allowFilter", "true"]);
    run(
        dir,
        &["clone", "--quiet", &remote.to_string_lossy(), "other"],
    );
    std::fs::write(other.join("README.md"), "# Media\n").unwrap();
    run(&other, &["add", "README.md"]);
    run(
        &other,
        &[
            "-c",
            "user.name=t",
            "-c",
            "user.email=t@t",
            "commit",
            "--quiet",
            "-m",
            "init",
        ],
    );
    run(&other, &["push", "--quiet", "origin", "HEAD:main"]);
    (remote, other)
}

#[tokio::test]
async fn files_are_committed_to_the_gist_on_top_of_other_uploads() {
    let dir = tempfile::tempdir().unwrap();
    let (remote, other) = fake_gist(dir.path());
    let data = dir.path().join("data");
    std::fs::create_dir(&data).unwrap();
    let gh = WorktreeManager::new(
        Launcher::new(DataDir::new(&data).unwrap(), Environment::inherited()),
        &data,
    );
    let clone = data.join("pr-media-gist.git");
    // file://, not a path, so git clones through upload-pack and honors the filter.
    let url = format!("file://{}", remote.display());
    std::fs::write(dir.path().join("one"), "one").unwrap();
    let expected = run(dir.path(), &["hash-object", "one"]);

    let blob = put(&gh, &clone, &url, "a-shot.png", b"one".to_vec())
        .await
        .unwrap();
    assert_eq!(blob, expected.trim());
    let tree = run(&remote, &["ls-tree", "main"]);
    assert!(tree.contains(&format!("blob {blob}\ta-shot.png")), "{tree}");
    assert!(
        tree.contains("README.md"),
        "the files already there stay: {tree}"
    );
    let missing = run(
        &clone,
        &["rev-list", "--objects", "--missing=print", "main"],
    );
    let readme = run(&remote, &["rev-parse", "main:README.md"]);
    assert!(
        missing.contains(&format!("?{}", readme.trim())),
        "the clone never fetches the files already there: {missing}"
    );

    // The same file again needs no commit.
    let head = run(&remote, &["rev-parse", "main"]);
    put(&gh, &clone, &url, "a-shot.png", b"one".to_vec())
        .await
        .unwrap();
    assert_eq!(run(&remote, &["rev-parse", "main"]), head);

    // Another uploader pushed meanwhile: this one fetches its commit and builds on it.
    run(&other, &["pull", "--quiet", "origin", "main"]);
    std::fs::write(other.join("b-other.png"), "two").unwrap();
    run(&other, &["add", "b-other.png"]);
    run(
        &other,
        &[
            "-c",
            "user.name=t",
            "-c",
            "user.email=t@t",
            "commit",
            "--quiet",
            "-m",
            "b",
        ],
    );
    run(&other, &["push", "--quiet", "origin", "HEAD:main"]);
    put(&gh, &clone, &url, "c-third.png", b"three".to_vec())
        .await
        .unwrap();
    let tree = run(&remote, &["ls-tree", "--name-only", "main"]);
    assert_eq!(tree, "README.md\na-shot.png\nb-other.png\nc-third.png\n");
}

#[tokio::test(start_paused = true)]
async fn a_queued_caller_and_a_backoff_stay_inside_the_budget() {
    // A caller behind a held queue gives up after QUEUE_WAIT, saying to call again.
    let queue = tokio::sync::Mutex::new(());
    let held = queue.lock().await;
    let start = Instant::now();
    let busy = turn(&queue).await.unwrap_err();
    assert_eq!(start.elapsed(), QUEUE_WAIT);
    assert!(busy.to_string().contains("call upload_pr_media again"));
    drop(held);

    // A caller that got its turn just before giving up meets a secondary limit that never lifts:
    // it backs off only as far as the budget allows, then says to call again.
    let start = Instant::now();
    let deadline = start + BUDGET;
    tokio::time::sleep(QUEUE_WAIT.saturating_sub(Duration::from_secs(1))).await;
    let attempts = Cell::new(0);
    let limited = backoff(deadline, || {
        attempts.set(attempts.get() + 1);
        ready(Err(secondary()))
    })
    .await
    .unwrap_err();
    assert!(start.elapsed() < BUDGET, "{:?}", start.elapsed());
    assert_eq!(attempts.get(), 2);
    assert!(limited.to_string().contains("call upload_pr_media again"));

    // With the whole budget, both waits fit.
    let start = Instant::now();
    attempts.set(0);
    backoff(start + BUDGET, || {
        attempts.set(attempts.get() + 1);
        ready(Err(secondary()))
    })
    .await
    .unwrap_err();
    assert_eq!(attempts.get(), 3);
    assert!(start.elapsed() < BUDGET);
}

#[test]
fn links_are_pinned_to_the_blob_in_the_gist() {
    let gist = parse_gist("ryan-stoffel/066c6f34").unwrap();
    assert_eq!(
        gist,
        Gist {
            owner: "ryan-stoffel".to_owned(),
            id: "066c6f34".to_owned()
        }
    );
    assert_eq!(gist.key(), "ryan-stoffel/066c6f34");
    assert_eq!(gist.remote(), "https://gist.github.com/066c6f34.git");
    assert_eq!(
        gist.raw_url("0123abc", "d013614dc14a-x.gif"),
        "https://gist.githubusercontent.com/ryan-stoffel/066c6f34/raw/0123abc/d013614dc14a-x.gif"
    );
    assert_eq!(
        media_name("d013614dc14a0000", "x.gif"),
        "d013614dc14a-x.gif"
    );
    for bad in [
        "",
        "ryan",
        "ryan/",
        "/066c",
        "ryan/066c/x",
        "ry an/066c",
        "ryan/xyz",
        "../x/066c",
    ] {
        assert_eq!(parse_gist(bad), None, "{bad:?}");
    }
    assert_eq!(
        embed("Demo", "https://u/x.gif", false),
        "![Demo](https://u/x.gif)"
    );
    assert_eq!(
        embed("Demo", "https://u/x.mp4", true),
        "[Demo](https://u/x.mp4)"
    );
    assert_eq!(
        repository("https://github.com/ryan/parallax/pull/7").as_deref(),
        Some("ryan/parallax")
    );
    assert_eq!(
        repository("https://github.com/ryan/parallax/issues/7"),
        None
    );
}

#[test]
fn only_absolute_media_files_under_the_cap_are_taken() {
    let dir = tempfile::tempdir().unwrap();
    let text = dir.path().join("notes.txt");
    std::fs::write(&text, b"x").unwrap();
    let big = dir.path().join("big.mp4");
    std::fs::File::create(&big)
        .unwrap()
        .set_len(super::MAX_BYTES + 1)
        .unwrap();
    let clip = dir.path().join("clip.MOV");
    std::fs::write(&clip, b"x").unwrap();

    assert!(check(&file(Path::new("shot.png"), None)).is_err());
    assert!(check(&file(&text, None)).is_err());
    assert!(check(&file(&big, None)).is_err());
    assert!(check(&file(&dir.path().join("missing.png"), None)).is_err());
    #[cfg(unix)]
    {
        let link = dir.path().join("link.png");
        std::os::unix::fs::symlink(&clip, &link).unwrap();
        assert!(check(&file(&link, None)).is_err());
    }
    let clip = check(&file(&clip, Some("  [a]  "))).unwrap();
    assert!(clip.video);
    assert_eq!(clip.caption, " a ");
}

#[test]
fn gh_errors_are_classified() {
    assert_eq!(
        limit("gh: API rate limit exceeded for user ID 1. (HTTP 403)"),
        Some(Limit::Primary)
    );
    assert_eq!(
        limit("You have exceeded a secondary rate limit"),
        Some(Limit::Secondary)
    );
    assert_eq!(
        limit("You have triggered an abuse detection mechanism"),
        Some(Limit::Secondary)
    );
    assert_eq!(
        limit("gh: Too Many Requests (HTTP 429)"),
        Some(Limit::Secondary)
    );
    assert_eq!(limit("gh: Not Found (HTTP 404)"), None);
}
