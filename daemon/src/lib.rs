//! The Parallax host daemon, `plxd`.
//!
//! `plxd serve` listens on a per-user Unix socket on macOS and Linux, or a per-user named pipe on
//! Windows (0023), and speaks the
//! protocol from the `parallax-protocol` crate (decision record 0007). The editor reaches it through
//! `plxd attach`, locally or over SSH.
//!
//! The library holds what the subcommands share:
//!
//! - [`paths`]: the data folder, the files in it, and the socket path rule, which `serve` and
//!   `attach` both follow.
//! - [`transport`]: connecting to `serve` as a client, with the peer checks each OS needs.
//! - [`logging`]: the log file and its level.
//! - [`server`]: the server behind `plxd serve`.
//! - [`attach`]: reaching the server and bridging stdio to it, behind `plxd attach`.
//! - [`backend`]: the interface over the vendor CLIs that run agents (0004), and the process
//!   supervision they share.
//! - `context`: each project's shared context folder (0005, #155): `context/list`, `context/read`,
//!   `context/write`, and a watcher that turns an agent's own writes on disk into
//!   `context.changed` events.
//! - `detect`: detecting which vendor CLIs are installed and signed in, without touching their
//!   credentials (#114).
//! - [`mcp`]: `plxd mcp`, the coordinator's Parallax tools as an MCP server on stdio, bound to one
//!   project and one coordinator thread (#195, 0019).
//! - [`peer`]: the client of a plxd, over the local socket or a tailnet device's TCP port (0057).
//! - [`launch_agent`]: the service that `attach` starts plxd through, when it is installed. On
//!   Windows there is none yet, so `attach` starts `serve` itself (0023).
//! - [`service`]: installs, removes, and reports on the per-user service that keeps `serve`
//!   running: a `LaunchAgent` on macOS (#61), a systemd user unit on Linux (PLX-18). Unix only.
//! - [`keystore`]: where API keys live: the macOS login Keychain (#117), the Secret Service on
//!   Linux (PLX-19), and no store yet on Windows.
//! - [`usage`]: turns backend usage events into `parallax-store` rows (#120).
//! - `routing`: picks a task's backend and account, forces the coordinator's no-write policy,
//!   and falls a failed subscription run back to a key account (#119).
//! - [`worktree`]: creates, inspects, and removes the git worktrees agent runs use (#154).
//! - `agents`: the M3 runner behind `agent/*` (#156): starts a worker in its worktree, streams
//!   its events, commits its changes, and resumes it after a restart.
//! - `threads`: normal threads behind `thread/*` and `repo/*` (#110): runs with no coordinator
//!   that belong to a repo entry, or to a scratch repository for a thread with no repo.
//! - `images`: the caps and checks for images sent with a prompt or message (PLX-191).
//! - `terminals`: the terminals plxd runs for its clients, by thread and terminal id (PLX-637).
//! - `setup_scripts`: a repository's setup and settle scripts, run in a thread's terminals
//!   (PLX-650).
//! - [`tailnet`]: Tailscale's view of this node and its peers, and which peers Parallax Connect
//!   lets in (0056).
//! - [`remote`]: remote access on the LAN over HTTPS with a pinned key, and its client (PLX-641).
//! - [`windows`]: every Win32 call plxd makes, and the only module with `unsafe` code. Windows
//!   only.

#![warn(missing_docs)]

mod agents;
pub mod attach;
pub mod backend;
mod browser;
mod commands;
mod context;
mod delegation;
mod detect;
mod event_log;
mod github;
mod graph;
mod images;
mod json;
pub mod keystore;
pub mod launch_agent;
pub mod logging;
pub mod mcp;
mod methods;
mod naming;
mod orchestrator;
pub mod paths;
pub mod peer;
mod pr_watch;
pub(crate) mod preview;
pub mod providers;
#[cfg(unix)]
mod public_proxy;
pub mod remote;
mod repo;
pub mod routing;
mod schedules;
mod secrets;
pub mod server;
#[cfg(unix)]
pub mod service;
mod setup_scripts;
#[cfg(unix)]
mod spawn;
mod store;
pub mod tailnet;
mod terminals;
mod threads;
pub mod transport;
pub mod usage;
#[cfg(windows)]
pub mod windows;
pub mod worktree;

/// The file next to a packaged `plxd` that holds its release version (0030). The app's package
/// step writes it, so one `plxd` build can ship in many app versions.
pub const VERSION_FILE: &str = "plxd.version";

/// plxd's release version, reported by `plxd --version`, the protocol handshake
/// (`initialize` and `host/version`), and the `LaunchAgent`'s probe.
///
/// It is the first line of [`VERSION_FILE`] next to the running executable, or the crate's own
/// placeholder in `Cargo.toml` when there is none (a cargo build). Read once, on first use, which
/// `main` makes the start of the process: a `serve` that outlives an app update keeps reporting the
/// version it started as, which is how the app knows to replace it (PLX-68).
pub fn version() -> &'static str {
    static VERSION: std::sync::OnceLock<String> = std::sync::OnceLock::new();
    VERSION.get_or_init(|| {
        std::env::current_exe()
            .ok()
            // Through any symlink to the real file; the path as given if that fails.
            .map(|exe| std::fs::canonicalize(&exe).unwrap_or(exe))
            .and_then(|exe| stamped_version(&exe))
            .unwrap_or_else(|| env!("CARGO_PKG_VERSION").to_owned())
    })
}

/// `bytes`' SHA-256, in lowercase hex.
pub(crate) fn sha256_hex(bytes: &[u8]) -> String {
    use sha2::{Digest, Sha256};
    use std::fmt::Write as _;
    Sha256::digest(bytes)
        .iter()
        .fold(String::new(), |mut hex, byte| {
            let _ = write!(hex, "{byte:02x}");
            hex
        })
}

/// The version in [`VERSION_FILE`] beside `exe`, if the file is there and not blank.
fn stamped_version(exe: &std::path::Path) -> Option<String> {
    let text = std::fs::read_to_string(exe.with_file_name(VERSION_FILE)).ok()?;
    let version = text.lines().next()?.trim();
    (!version.is_empty()).then(|| version.to_owned())
}

#[cfg(test)]
mod tests {
    use super::{VERSION_FILE, stamped_version};

    #[test]
    fn the_version_file_beside_the_executable_wins_when_it_has_one() {
        let dir = tempfile::tempdir().unwrap();
        let exe = dir.path().join("plxd");
        assert_eq!(stamped_version(&exe), None, "no file");

        std::fs::write(dir.path().join(VERSION_FILE), " \n").unwrap();
        assert_eq!(stamped_version(&exe), None, "a blank file");

        std::fs::write(dir.path().join(VERSION_FILE), "2609.13017.14512-nightly\n").unwrap();
        assert_eq!(
            stamped_version(&exe).as_deref(),
            Some("2609.13017.14512-nightly")
        );
    }
}
