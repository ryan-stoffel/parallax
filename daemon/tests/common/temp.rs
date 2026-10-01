//! Temporary data folders short enough for wispd's socket, shared by the tests that start it.
//!
//! Not part of `common`'s module tree, so tests that don't need it don't compile it: include it
//! with `#[path = ".../common/temp.rs"] mod temp;`.

use std::path::Path;

use tempfile::TempDir;
use wispd::paths::MAX_SOCKET_PATH_BYTES;

/// Room for the longest socket path a test builds inside the folder,
/// `/.local/share/wisp/wispd.sock` (29 bytes).
const HEADROOM: usize = 32;

/// A fresh folder, removed when dropped: under `$TMPDIR` when a socket inside it fits the OS
/// limit, which a Claude worker needs since it can write only there (RYA-128), and under `/tmp`
/// otherwise.
pub fn temp_dir() -> TempDir {
    let dir = temp_dir_in(&std::env::temp_dir());
    if dir.path().as_os_str().len() + HEADROOM <= MAX_SOCKET_PATH_BYTES {
        dir
    } else {
        temp_dir_in(Path::new("/tmp"))
    }
}

fn temp_dir_in(base: &Path) -> TempDir {
    tempfile::Builder::new()
        .prefix("wispd-")
        .tempdir_in(base)
        .unwrap_or_else(|err| panic!("create a temp dir under {}: {err}", base.display()))
}
