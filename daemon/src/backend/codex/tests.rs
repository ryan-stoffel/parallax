//! The Codex backend's helpers. A thread on `codex app-server` is tested in `app_server`.

use super::{classify, write_images};
use crate::backend::event::FailureKind;
use crate::backend::{ImageMediaType, PromptImage};

#[test]
fn turn_failures_say_when_routing_should_fall_back() {
    for (message, kind) in [
        (
            "unexpected status 401 Unauthorized: Missing bearer or basic authentication in header",
            FailureKind::NotSignedIn,
        ),
        (
            "Your access token could not be refreshed because your refresh token has expired. \
             Please log out and sign in again.",
            FailureKind::NotSignedIn,
        ),
        (
            "You’ve hit your usage limit. Try again later.",
            FailureKind::RateLimited,
        ),
        (
            "Quota exceeded. Check your plan and billing details.",
            FailureKind::RateLimited,
        ),
        ("rate limit exceeded: slow down", FailureKind::RateLimited),
        (
            "exceeded retry limit, last status: 429 Too Many Requests, request id: req_1",
            FailureKind::RateLimited,
        ),
        (
            "exceeded retry limit, last status: 500 Internal Server Error",
            FailureKind::VendorError,
        ),
        (
            "To use Codex with your ChatGPT plan, upgrade to Plus: \
             https://chatgpt.com/explore/plus.",
            FailureKind::VendorError,
        ),
        (
            "stream disconnected before completion: reset",
            FailureKind::VendorError,
        ),
    ] {
        assert_eq!(classify(message), kind, "{message}");
    }
}

#[test]
fn image_files_hold_the_decoded_bytes_in_a_private_folder() {
    let dir = tempfile::tempdir().unwrap();
    assert!(write_images(dir.path(), &[]).unwrap().is_none());
    let jpeg = PromptImage {
        media_type: ImageMediaType::Jpeg,
        data: "/9j/".into(),
    };
    let (folder, paths) = write_images(dir.path(), &[jpeg]).unwrap().unwrap();
    assert_eq!(paths, [folder.path().join("1.jpg")]);
    assert_eq!(std::fs::read(&paths[0]).unwrap(), b"\xff\xd8\xff");
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mode = std::fs::metadata(folder.path())
            .unwrap()
            .permissions()
            .mode();
        assert_eq!(mode & 0o777, 0o700);
    }
}
