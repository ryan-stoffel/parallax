use std::path::Path;

use parallax_protocol::PrMediaFile;

use super::{branch_missing, check, embed, limited, raw_url, repository, upload_all};

fn file(path: &Path, caption: Option<&str>) -> PrMediaFile {
    PrMediaFile {
        path: path.to_string_lossy().into_owned(),
        caption: caption.map(str::to_owned),
    }
}

#[tokio::test]
async fn the_same_bytes_reuse_their_link_without_a_github_call() {
    let dir = tempfile::tempdir().unwrap();
    let index = dir.path().join("pr-media.json");
    let shot = dir.path().join("Settings page.png");
    let again = dir.path().join("copy.png");
    std::fs::write(&shot, b"png bytes").unwrap();
    std::fs::write(&again, b"png bytes").unwrap();
    let mut puts = Vec::new();
    let mut put = |path: String, _: Vec<u8>| {
        puts.push(path);
        std::future::ready(Ok("abc123".to_owned()))
    };

    let first = upload_all(
        &index,
        "Ryan/Parallax",
        vec![check(&file(&shot, Some("After"))).unwrap()],
        "20261025-120000",
        &mut put,
    )
    .await
    .unwrap();
    let path = "pr-media/20261025-120000-d013614d-Settings-page.png";
    let url = format!("https://raw.githubusercontent.com/Ryan/Parallax/abc123/{path}");
    assert_eq!(first[0].url, url);
    assert_eq!(first[0].markdown, format!("![After]({url})"));
    assert!(!first[0].reused);

    // Another file with the same bytes, read from the saved index, in the same repository
    // however it is cased: no upload.
    let second = upload_all(
        &index,
        "ryan/parallax",
        vec![check(&file(&again, None)).unwrap()],
        "20261025-130000",
        &mut put,
    )
    .await
    .unwrap();
    assert_eq!(second[0].url, url);
    assert_eq!(second[0].markdown, format!("![copy.png]({url})"));
    assert!(second[0].reused);

    // Another repository uploads its own copy.
    upload_all(
        &index,
        "ryan/other",
        vec![check(&file(&again, None)).unwrap()],
        "20261025-130000",
        &mut put,
    )
    .await
    .unwrap();
    assert_eq!(puts, [path, "pr-media/20261025-130000-d013614d-copy.png"]);
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
    let clip = check(&file(&clip, Some("  [a]  "))).unwrap();
    assert!(clip.video);
    assert_eq!(clip.caption, " a ");
}

#[test]
fn gh_errors_are_classified() {
    assert!(limited(
        "gh: API rate limit exceeded for user ID 1. (HTTP 403)"
    ));
    assert!(limited("You have exceeded a secondary rate limit"));
    assert!(!limited("gh: Not Found (HTTP 404)"));
    assert!(branch_missing(
        "`gh api -X` failed: gh: Branch pr-media not found (HTTP 404)"
    ));
    assert!(!branch_missing("gh: Not Found (HTTP 404)"));
}
