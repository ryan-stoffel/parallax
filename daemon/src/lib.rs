//! The wisp host daemon, `wispd`.
//!
//! `wispd serve` listens on a per-user Unix socket on macOS and Linux, or a per-user named pipe on
//! Windows (0023), and speaks the
//! protocol from the `wisp-protocol` crate (decision record 0007). The editor reaches it through
//! `wispd attach`, locally or over SSH.
//!
//! The library holds what the subcommands share:
//!
//! - [`paths`]: the data folder, the files in it, and the socket path rule, which `serve` and
//!   `attach` both follow.
//! - [`transport`]: connecting to `serve` as a client, with the peer checks each OS needs.
//! - [`logging`]: the log file and its level.
//! - [`server`]: the server behind `wispd serve`.
//! - [`attach`]: reaching the server and bridging stdio to it, behind `wispd attach`.
//! - [`backend`]: the interface over the vendor CLIs that run agents (0004), and the process
//!   supervision they share.
//! - `context`: each project's shared context folder (0005, #155): `context/list`, `context/read`,
//!   `context/write`, and a watcher that turns an agent's own writes on disk into
//!   `context.changed` events.
//! - `detect`: detecting which vendor CLIs are installed and signed in, without touching their
//!   credentials (#114).
//! - [`mcp`]: `wispd mcp`, the coordinator's wisp tools as an MCP server on stdio, bound to one
//!   project and one coordinator thread (#195, 0019).
//! - [`launch_agent`]: the service that `attach` starts wispd through, when it is installed. On
//!   Windows there is none yet, so `attach` starts `serve` itself (0023).
//! - [`service`]: installs, removes, and reports on the per-user service that keeps `serve`
//!   running: a `LaunchAgent` on macOS (#61), a systemd user unit on Linux (RYA-18). Unix only.
//! - [`keystore`]: where API keys live: the macOS login Keychain (#117), the Secret Service on
//!   Linux (RYA-19), and no store yet on Windows.
//! - [`usage`]: turns backend usage events into `wisp-store` rows (#120).
//! - `routing`: picks a task's backend and account, forces the coordinator's no-write policy,
//!   and falls a failed subscription run back to a key account (#119).
//! - [`worktree`]: creates, inspects, and removes the git worktrees agent runs use (#154).
//! - `agents`: the M3 runner behind `agent/*` (#156): starts a worker in its worktree, streams
//!   its events, commits its changes, and resumes it after a restart.
//! - `threads`: normal threads behind `thread/*` and `repo/*` (#110): runs with no coordinator
//!   that belong to a repo entry, or to a scratch repository for a thread with no repo.
//! - [`windows`]: every Win32 call wispd makes, and the only module with `unsafe` code. Windows
//!   only.

#![warn(missing_docs)]

mod agents;
pub mod attach;
pub mod backend;
mod context;
mod detect;
mod event_log;
mod json;
pub mod keystore;
pub mod launch_agent;
pub mod logging;
pub mod mcp;
mod methods;
pub mod paths;
mod repo;
pub mod routing;
pub mod server;
#[cfg(unix)]
pub mod service;
#[cfg(unix)]
mod spawn;
mod store;
mod threads;
pub mod transport;
pub mod usage;
#[cfg(windows)]
pub mod windows;
pub mod worktree;

/// wispd's release version, reported by `wispd --version`, the protocol handshake
/// (`initialize` and `host/version`), and the `LaunchAgent`'s probe.
///
/// A build can set `WISP_VERSION` at compile time; without it, this falls back to the crate's own
/// placeholder in `Cargo.toml`.
pub const VERSION: &str = match option_env!("WISP_VERSION") {
    Some(version) => version,
    None => env!("CARGO_PKG_VERSION"),
};
