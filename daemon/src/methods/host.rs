//! `initialize`, `host/health`, and `host/version`.

use std::collections::BTreeMap;
use std::fs;

use parallax_protocol::framing::MAX_FRAME_BYTES;
use parallax_protocol::jsonrpc::{ErrorObject, Request};
use parallax_protocol::{
    Capabilities, ClientInfo, HostHealthParams, HostHealthResult, HostVersionParams,
    HostVersionResult, IncompatibleProtocolDetail, InitializeParams, InitializeProtocol,
    InitializeResult, ProtocolRange,
};
use tracing::info;

use super::Context;
use crate::images;
use crate::logging::untrusted;
use crate::server::Daemon;

const SYSTEM_VERSION: &str = "/System/Library/CoreServices/SystemVersion.plist";

/// What `initialize` settled for a connection.
#[derive(Debug)]
pub(crate) struct Session {
    pub protocol: u32,
    pub client: ClientInfo,
}

/// `initialize`: agrees on a protocol version, or fails with `incompatibleProtocol`.
///
/// The client's range is read first, from the part of the params that never changes shape, so a
/// client from any version gets `incompatibleProtocol` rather than a params error.
pub(crate) fn initialize(
    daemon: &Daemon,
    request: &Request,
) -> Result<(Session, InitializeResult), ErrorObject> {
    let InitializeProtocol { protocol } = request.params()?;
    let Some(version) = ProtocolRange::SUPPORTED.highest_common(protocol) else {
        return Err(ErrorObject::incompatible_protocol(
            &IncompatibleProtocolDetail {
                requested: protocol,
                supported: ProtocolRange::SUPPORTED,
                plxd: crate::version().to_owned(),
            },
        ));
    };
    let InitializeParams {
        client,
        capabilities,
        ..
    } = request.params()?;
    let capability_names = capabilities.0.keys().cloned().collect::<Vec<_>>().join(",");
    info!(
        client = ?untrusted(&client.name),
        client_version = ?untrusted(&client.version),
        protocol = version,
        capabilities = ?untrusted(&capability_names),
        "initialized"
    );
    let result = InitializeResult {
        protocol: version,
        plxd: crate::version().to_owned(),
        log_id: daemon.log.id(),
        capabilities: capabilities_advertised(),
        max_frame_bytes: u64::try_from(MAX_FRAME_BYTES).unwrap_or(u64::MAX),
    };
    let session = Session {
        protocol: version,
        client,
    };
    Ok((session, result))
}

/// The capabilities this plxd advertises. M2 adds `accounts` (#117) and `agentClis` (#114),
/// distinct capabilities since the two features (stored API keys and detected CLIs) can ship
/// independently; M3 adds `agents` (#156): the `agent/*` methods and `agent.*` events,
/// `agentReview` (#157): `agent/diff`, `agent/file`, `agent/accept`, `agent/requestChanges`, and
/// `agent.accepted`, so an editor can tell a host that reviews runs from one that only runs them,
/// `threads` (#110): normal threads, with the `thread/*` and `repo/*` methods and the `repo.*`
/// and `thread.*` events, `runOptions` (RYA-97): `agent/start` and `thread/start` take
/// `model`, `effort`, and `permission`, which an older plxd would silently ignore (0007), and
/// `sendOptions` (RYA-161): `agent/send` takes `effort` and `permission`, likewise, and its
/// successor `sendModel` (RYA-163): `agent/send` also takes `model`, which a `sendOptions`-only
/// plxd would silently ignore, and `sendAccount`: `agent/send` also takes `account`, which can move
/// a run to another backend, a message changing the model, effort, permission, or account waits
/// for a running CLI to exit instead of failing, and `agent.updated` reports the run's `backend`.
/// M4 adds `coordinator` (RYA-41, 0024): `project/start` and
/// `Project.coordinator`, and `openPr` (RYA-168): `agent/openPr`. `promptImages` (RYA-191, 0026):
/// `agent/start`, `agent/send`, `thread/start`, and `project/start` take `images`, which an
/// older plxd would silently drop, `turnStarted` lists them, and `agent/image` serves them. Its
/// options are the caps: `maxImages`, and `maxImageBytes` and `maxTotalBytes` of base64 `data`.
/// `approvals` (RYA-222, 0031): `agent/start`, `thread/start`, and `project/start` take
/// `approvals`, which an older plxd would silently ignore. A run started with it, in Manual,
/// Auto, or Plan, and a thread in Accept Edits too (0034), asks through `approvalRequested`
/// items, which `agent/approve` answers, instead of denying what would prompt.
/// `projectEdit` (RYA-227, 0032): `project/update`, `project.updated`, and `icon` on `Project`
/// and `project/create`, which an older plxd would silently drop.
/// `threadAttention` (RYA-270, 0033): `thread/update`, `repo/update`, `repo.updated`, and
/// `seenAt`, `snoozedUntil`, and `lastPromptAt` on `Thread` and `icon` on `Repo`.
/// `checkout`: `thread/start` takes `checkout`, to work in the repo's own checkout instead of a
/// new worktree, and `AgentRun` reports it; an older plxd would silently make a worktree.
/// `repoRefs`: `repo/refs`, and `thread/start` takes `base` and `checkoutRef`, which an older plxd
/// would silently ignore, starting from `HEAD` or the branch the checkout has out.
/// `contextAndFast`: `agent/start`, `agent/send`, and `thread/start` take `contextWindow` and
/// `fast`, and `AgentRun` and `agent.updated` report them; an older plxd would silently ignore
/// them.
/// `git` (RYA-298): `agent/gitStatus`, `agent/commit`, and `agent/push`, and `agent/openPr` on a
/// Current checkout thread.
/// `files` (RYA-296): `agent/files`, and `agent/file`'s `working` side, which an older plxd
/// would refuse, to browse a run's folder.
/// `pullRequests` (PLX-318): `pr/view` and `pr/act`, and `pullRequests` on `AgentRun` and
/// `agent.updated`, which an older plxd never fills.
fn capabilities_advertised() -> Capabilities {
    let prompt_images = serde_json::Map::from_iter([
        ("maxImages".to_owned(), images::MAX_IMAGES.into()),
        ("maxImageBytes".to_owned(), images::MAX_IMAGE_BYTES.into()),
        ("maxTotalBytes".to_owned(), images::MAX_TOTAL_BYTES.into()),
    ]);
    Capabilities(BTreeMap::from([
        ("accounts".to_owned(), serde_json::Map::new()),
        ("agentClis".to_owned(), serde_json::Map::new()),
        ("agentReview".to_owned(), serde_json::Map::new()),
        ("agents".to_owned(), serde_json::Map::new()),
        ("approvals".to_owned(), serde_json::Map::new()),
        ("checkout".to_owned(), serde_json::Map::new()),
        ("contextAndFast".to_owned(), serde_json::Map::new()),
        ("coordinator".to_owned(), serde_json::Map::new()),
        ("files".to_owned(), serde_json::Map::new()),
        ("git".to_owned(), serde_json::Map::new()),
        ("openPr".to_owned(), serde_json::Map::new()),
        ("projectEdit".to_owned(), serde_json::Map::new()),
        ("promptImages".to_owned(), prompt_images),
        ("pullRequests".to_owned(), serde_json::Map::new()),
        ("repoRefs".to_owned(), serde_json::Map::new()),
        ("runOptions".to_owned(), serde_json::Map::new()),
        ("sendAccount".to_owned(), serde_json::Map::new()),
        ("sendModel".to_owned(), serde_json::Map::new()),
        ("sendOptions".to_owned(), serde_json::Map::new()),
        ("threadAttention".to_owned(), serde_json::Map::new()),
        ("threads".to_owned(), serde_json::Map::new()),
    ]))
}

pub(crate) fn health(context: &Context, _: HostHealthParams) -> HostHealthResult {
    let daemon = &context.daemon;
    HostHealthResult {
        uptime_seconds: daemon.started.elapsed().as_secs(),
        store: daemon.store.state(),
        running_agents: daemon.agents.running(),
    }
}

pub(crate) fn version(context: &Context, _: HostVersionParams) -> HostVersionResult {
    HostVersionResult {
        plxd: crate::version().to_owned(),
        protocol: ProtocolRange::SUPPORTED,
        os: context.daemon.os.clone(),
        arch: std::env::consts::ARCH.to_owned(),
    }
}

/// The operating system and its version, such as `macOS 27.0`, read once at startup.
pub(crate) fn os_version() -> String {
    fs::read_to_string(SYSTEM_VERSION)
        .ok()
        .and_then(|plist| {
            let name = plist_string(&plist, "ProductName")?;
            let version = plist_string(&plist, "ProductVersion")?;
            Some(format!("{name} {version}"))
        })
        .unwrap_or_else(|| std::env::consts::OS.to_owned())
}

// The <string> after <key>key</key> in an XML property list.
fn plist_string<'a>(plist: &'a str, key: &str) -> Option<&'a str> {
    let after_key = &plist[plist.find(&format!("<key>{key}</key>"))?..];
    let start = after_key.find("<string>")? + "<string>".len();
    let end = start + after_key[start..].find("</string>")?;
    Some(after_key[start..end].trim())
}

#[cfg(test)]
mod tests {
    use super::plist_string;

    #[test]
    fn reads_strings_from_a_property_list() {
        let plist = "<dict>\n\t<key>ProductBuildVersion</key>\n\t<string>27A1</string>\n\
                     \t<key>ProductName</key>\n\t<string>macOS</string>\n\
                     \t<key>ProductVersion</key>\n\t<string>27.0</string>\n</dict>";
        assert_eq!(plist_string(plist, "ProductName"), Some("macOS"));
        assert_eq!(plist_string(plist, "ProductVersion"), Some("27.0"));
        assert_eq!(plist_string(plist, "Missing"), None);
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn the_os_version_names_macos() {
        let version = super::os_version();
        assert!(version.starts_with("macOS "), "{version}");
    }
}
