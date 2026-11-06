use std::cell::Cell;
use std::future::ready;
use std::path::Path;
use std::time::Duration;

use parallax_protocol::PrMediaFile;
use tokio::time::Instant;

use super::{
    BUDGET, Limit, QUEUE_WAIT, backoff, branch_missing, check, embed, limit, raw_url, repository,
    turn, upload_all,
};
use crate::worktree::PrError;

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
async fn the_same_bytes_reuse_their_link_without_a_github_call_or_a_wait() {
    let dir = tempfile::tempdir().unwrap();
    let index = dir.path().join("pr-media.json");
    let shot = dir.path().join("Settings page.png");
    let again = dir.path().join("copy.png");
    std::fs::write(&shot, b"png bytes").unwrap();
    std::fs::write(&again, b"png bytes").unwrap();
    let mut puts = Vec::new();
    let mut put = |path: String, _: Vec<u8>| {
        puts.push(path);
        ready(Ok("abc123".to_owned()))
    };
    let turns = Cell::new(0);

    let first = upload_all(
        &index,
        "Ryan/Parallax",
        vec![check(&file(&shot, Some("After"))).unwrap()],
        "20261025-120000",
        async { counted(&turns).await },
        &mut put,
    )
    .await
    .unwrap();
    let path = "pr-media/20261025-120000-d013614d-Settings-page.png";
    let url = format!("https://raw.githubusercontent.com/Ryan/Parallax/abc123/{path}");
    assert_eq!(first[0].url, url);
    assert_eq!(first[0].markdown, format!("![After]({url})"));
    assert!(!first[0].reused);
    assert_eq!(turns.get(), 1);

    // Another file with the same bytes, read from the saved index, in the same repository
    // however it is cased: no upload, and no wait for the queue.
    let second = upload_all(
        &index,
        "ryan/parallax",
        vec![check(&file(&again, None)).unwrap()],
        "20261025-130000",
        async { counted(&turns).await },
        &mut put,
    )
    .await
    .unwrap();
    assert_eq!(second[0].url, url);
    assert_eq!(second[0].markdown, format!("![copy.png]({url})"));
    assert!(second[0].reused);
    assert_eq!(turns.get(), 1);

    // Another repository uploads its own copy.
    upload_all(
        &index,
        "ryan/other",
        vec![check(&file(&again, None)).unwrap()],
        "20261025-130000",
        async { counted(&turns).await },
        &mut put,
    )
    .await
    .unwrap();
    assert_eq!(puts, [path, "pr-media/20261025-130000-d013614d-copy.png"]);
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
fn links_are_raw_and_pinned_to_the_commit() {
    assert_eq!(
        raw_url("ryan/parallax", "0123abc", "pr-media/x.gif"),
        "https://raw.githubusercontent.com/ryan/parallax/0123abc/pr-media/x.gif"
    );
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
    assert!(branch_missing(
        "`gh api -X` failed: gh: Branch pr-media not found (HTTP 404)"
    ));
    assert!(!branch_missing("gh: Not Found (HTTP 404)"));
}
