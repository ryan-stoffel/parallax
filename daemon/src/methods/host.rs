//! `initialize`, `host/health`, `host/version`, `host/folders`, `host/upload`, and
//! `host/settings/*`.
//! `host/update` is in `crate::self_update`.

use std::collections::BTreeMap;
use std::fs;
use std::io::{Read as _, Seek as _, SeekFrom, Write as _};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, PoisonError};
use std::time::{Duration, SystemTime};

use parallax_protocol::framing::MAX_FRAME_BYTES;
use parallax_protocol::jsonrpc::{ErrorObject, Request};
use parallax_protocol::{
    Capabilities, ClientInfo, DEVICE_ICONS, HostFolder, HostFoldersParams, HostFoldersResult,
    HostHealthParams, HostHealthResult, HostQueues, HostReadUploadParams, HostReadUploadResult,
    HostSettings, HostSettingsGetParams, HostSettingsSetParams, HostUploadParams, HostUploadResult,
    HostVersionParams, HostVersionResult, IncompatibleProtocolDetail, InitializeParams,
    InitializeProtocol, InitializeResult, MAX_DEVICE_NAME_CHARS, ProtocolRange, StoreState,
    UploadId,
};
use tracing::{info, warn};
use uuid::Uuid;

use super::Context;
use crate::agents::attached;
use crate::agents::store_error;
use crate::images;
use crate::logging::untrusted;
use crate::server::Daemon;

const SYSTEM_VERSION: &str = "/System/Library/CoreServices/SystemVersion.plist";

/// What `initialize` settled for a connection.
#[derive(Debug)]
pub(crate) struct Session {
    pub protocol: u32,
    pub client: ClientInfo,
    /// The client declared `resyncNotice`: a subscription that falls behind ends with
    /// `events/resync` instead of closing the connection (PLX-455).
    pub resync_notice: bool,
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
        resync_notice: capabilities.0.contains_key("resyncNotice"),
    };
    Ok((session, result))
}

/// The capabilities this plxd advertises. M2 adds `accounts` (#117) and `agentClis` (#114),
/// distinct capabilities since the two features (stored API keys and detected CLIs) can ship
/// independently; M3 adds `agents` (#156): the `agent/*` methods and `agent.*` events,
/// `agentReview` (#157): `agent/diff`, `agent/file`, `agent/accept`, `agent/requestChanges`, and
/// `agent.accepted`, so an editor can tell a host that reviews runs from one that only runs them,
/// `threads` (#110): normal threads, with the `thread/*` and `repo/*` methods and the `repo.*`
/// and `thread.*` events, `runOptions` (PLX-97): `agent/start` and `thread/start` take
/// `model`, `effort`, and `permission`, which an older plxd would silently ignore (0007), and
/// `sendOptions` (PLX-161): `agent/send` takes `effort` and `permission`, likewise, and its
/// successor `sendModel` (PLX-163): `agent/send` also takes `model`, which a `sendOptions`-only
/// plxd would silently ignore, and `sendAccount`: `agent/send` also takes `account`, which can move
/// a run to another backend, a message changing the model, effort, permission, or account waits
/// for a running CLI to exit instead of failing, and `agent.updated` reports the run's `backend`.
/// M4 adds `coordinator` (PLX-41, 0024): `project/start` and
/// `Project.coordinator`, and `openPr` (PLX-168): `agent/openPr`. `promptImages` (PLX-191, 0026):
/// `agent/start`, `agent/send`, `thread/start`, and `project/start` take `images`, which an
/// older plxd would silently drop, `turnStarted` lists them, and `agent/image` serves them. Its
/// options are the caps: `maxImages`, and `maxImageBytes` and `maxTotalBytes` of base64 `data`.
/// `approvals` (PLX-222, 0031): `agent/start`, `thread/start`, and `project/start` take
/// `approvals`, which an older plxd would silently ignore. A run started with it, in Manual,
/// Auto, or Plan, and a thread in Accept Edits too (0034), asks through `approvalRequested`
/// items, which `agent/approve` answers, instead of denying what would prompt.
/// `projectEdit` (PLX-227, 0032): `project/update`, `project.updated`, and `icon` on `Project`
/// and `project/create`, which an older plxd would silently drop.
/// `iconImages` (PLX-339, 0038): `image` on a project's or repo entry's `icon`, which an older
/// plxd would silently drop. Its option `maxBytes` is the cap on the image's base64 `data`.
/// `projectDelete` (PLX-338): `project/delete` and `project.deleted`.
/// `projectPermission` (PLX-394, 0042): a project's `permission`, Auto or Bypass, on `Project`,
/// `project/create`, and `project/update`, which an older plxd would silently drop. Every run in
/// the project, its coordinator included, runs in it.
/// `projectAutonomy` (PLX-403, 0043): a project's `autonomy`, Ask me, Routine, or Full, on
/// `Project`, `project/create`, and `project/update`, which an older plxd would silently drop. In
/// Ask me plxd refuses the coordinator's `answer` and sends every question to Needs you.
/// `integrationBranch` (PLX-409, 0045): `baseBranch` and `integrationBranch` on `Project`,
/// `baseBranch` on `project/create` and `project/update`, and `explore` on `agent/start` and
/// `AgentRun`, which an older plxd would silently drop. A run in a Project is cut from its
/// integration branch's tip.
/// `projectPlacement` (PLX-413, 0046): `maxChildren` and `allowApiKeys` on `Project` and
/// `project/update`, and `reserve` on a provider instance, which an older plxd would silently
/// drop. A Project's child is placed on an instance with room, or waits as `waiting` until one
/// frees up.
/// `projectTasks` (PLX-398, 0042): `thread/start` takes `project`, to start a Project's child
/// under its coordinator, which an older plxd would silently ignore, starting a scratch thread.
/// `projectFromThreads` (PLX-419, 0042): `project/fromThreads`, which makes a Project from
/// threads on one repo entry, each with its own worktree.
/// `areas` (PLX-789, 0073): `area/create`, `area/update`, `area/delete`, `areas.changed`, and
/// `areas` on `thread/list` and the shell snapshot; `pinned` on `Thread` and `thread/update`; and
/// `snippets` on `thread/search`, which an older plxd would silently drop.
/// `spaces` (PLX-732, 0069): `space/create`, `space/delete`, `repo.removed`, `name` on
/// `repo/update`, and `space` on `Repo`.
/// `threadAttention` (PLX-270, 0033): `thread/update`, `repo/update`, `repo.updated`, and
/// `seenAt`, `snoozedUntil`, and `lastPromptAt` on `Thread` and `icon` on `Repo`.
/// `threadLineage` (PLX-369, 0041): `parent`, `forkedFrom`, `title`, and `settled` on `Thread`,
/// `thread/start`'s `parent` and `title`, and `thread/update`'s `title` and `settled`, which an
/// older plxd would silently drop.
/// `threadFork` (PLX-375, 0050): `thread/fork`.
/// `threadImport` (PLX-881): `thread/importable` and `thread/import`, past sessions from the
/// Claude, Codex, and Cursor desktop apps.
/// `threadNaming` (PLX-610, 0058): `thread/start` takes `naming`, which an older plxd would
/// silently ignore, to name the thread and its branch with the user's own model, and
/// `agent.updated` carries `branch` when plxd renamed it.
/// `checkout`: `thread/start` takes `checkout`, to work in the repo's own checkout instead of a
/// new worktree, and `AgentRun` reports it; an older plxd would silently make a worktree.
/// `repoRefs`: `repo/refs`, and `thread/start` takes `base` and `checkoutRef`, which an older plxd
/// would silently ignore, starting from `HEAD` or the branch the checkout has out.
/// `contextAndFast`: `agent/start`, `agent/send`, and `thread/start` take `contextWindow` and
/// `fast`, and `AgentRun` and `agent.updated` report them; an older plxd would silently ignore
/// them.
/// `git` (PLX-298): `agent/gitStatus`, `agent/commit`, and `agent/push`, and `agent/openPr` on a
/// Current checkout thread.
/// `files` (PLX-296): `agent/files`, and `agent/file`'s `working` side, which an older plxd
/// would refuse, to browse a run's folder.
/// `fileEdit` (PLX-590): `agent/fileCreate`, `agent/fileRename`, and `agent/fileDelete`, to change
/// a run's folder from the Files view.
/// `pullRequests` (PLX-318): `pr/view` and `pr/act`, and `pullRequests` on `AgentRun` and
/// `agent.updated`, which an older plxd never fills.
/// `prDiff` (PLX-328): `pr/diff`, and `createdAt`, `closedAt`, `mergedAt`, `mergedBy`, `commits`,
/// and `reviews` on `PullRequest`, which an older plxd never fills.
/// `composerMenus` (PLX-359): `agent/commands` and `repo/files`, for the composer's `/` and `@`
/// menus.
/// `githubStatus` (PLX-336): `github/status`.
/// `threadContext` (PLX-372, 0047): `thread/search`, and `agent/start`, `thread/start`, and
/// `agent/send` take `threads`, which an older plxd would silently drop, and `turnStarted` lists
/// them. Its options are the caps: `maxThreads` per message, and `maxSummaryBytes` of each
/// thread's summary.
/// `autoResume` (PLX-371, 0049): `agent/resumeNow`, `agent/autoResume`, `host/settings/get` and
/// `host/settings/set`, the `waiting` status, and `resumeAt` and `autoResume` on `AgentRun` and
/// `agent.updated`.
/// `providers` (0040): `providers/list`, `providers/save`, and `providers/remove`, and a
/// subscription `AccountChoice` naming any enabled instance. `cursor/signIn`,
/// `cursor/signInCancel`, and `cursor/signOut` (0053) sign a Cursor instance in through the
/// SDK.
/// `githubSetup` (PLX-423, 0050): `github/install`, `github/signIn`, and `github/signInCancel`,
/// and `managed`, `installing`, `signingIn`, and `setupNote` on `github/status`, which an older
/// plxd never fills.
/// `threadTools` (PLX-373, 0041): `agent/send`'s and `agent/cancel`'s `from`, `turnStarted`'s
/// `from` and the `interrupted` item, and `pr/link` and `pr/unlink`, which a thread's Parallax
/// tools use.
/// `inbox` (PLX-401, 0043): `inbox/list`, `inbox/seen`, and `inbox.added`.
/// `landing` (PLX-410, 0045): `land/queue`, `land/approve`, `land/sendBack`, and `autoLand` on
/// `Project` and `project/update`, which an older plxd would silently ignore.
/// `checks` (PLX-411, 0045): `checks` and `proposedChecks` on `Project` and `project/update`,
/// which an older plxd would silently ignore, and the checks running after each landing.
/// `queue` (PLX-370, 0048): `queue/list`, `queue/edit`, `queue/reorder`, `queue/cancel`,
/// `queue/steer`, and `queue.updated`, and `agent/send` takes `delivery`, which an older plxd
/// would silently ignore, queueing a steer.
/// `questions` (PLX-402, 0043): `question/ask`, `question/answer`, `question/escalate`, and
/// `question/list`.
/// `memory` (PLX-405, 0044): `memory/list`, `memory/read`, `memory/write`, `memory/delete`, and
/// `memory/propose`, and shared context paths in 0044's folders.
/// `agentWait` (PLX-451): `agent/wait`.
/// `eventFilters` (PLX-453): `events/subscribe` takes `run` and `shell`, which an older plxd
/// would silently ignore.
/// `eventsBefore` (PLX-490): `agent/events` takes `before`, to page a run's events newest first,
/// and answers it with the run and the log's `seq`; an older plxd would page from the start.
/// `commandIds` (PLX-482, 0052): every request may carry `commandId` in its params. Listed
/// methods keep a receipt so a retry returns the first result.
/// `worktreeCleanup` (PLX-555): `cleanWorktrees` in `host/settings`, which an older plxd would
/// silently ignore, and the sweep that removes a settled thread's merged worktree.
/// `connect` (PLX-574, 0056): `connect`, `deviceName`, and `deviceIcon` in `host/settings`, which
/// an older plxd would silently ignore, `connect/devices`, and the tailnet listener.
/// `terminals` (PLX-637): `terminal/*`, the terminals plxd runs for its clients.
/// `orchestration` (PLX-644, 0059): `orchestration/dispatch`, `orchestration/subscribeShell`,
/// `orchestration/subscribeThread`, and `orchestration/threadHistory`, and `held` on
/// `queue.updated` and `queue/*`'s results.
/// `remote` (PLX-641, 0065): `remote` in `host/settings`, `remote/pair`, `remote/sessions`,
/// `remote/revoke`, and the HTTPS listener.
/// `remoteWeb` (PLX-651): `remoteWeb` in `host/settings`, and the web client and browser pairing
/// the HTTPS listener serves while it's on.
/// `relay` (PLX-652, 0068): `relay` in `host/settings`, `relay/register`, `relay/hosts`,
/// `relay/remove`, and `relay` in `remote/sessions`.
/// `schedules` (0063): `schedule/*`, and the webhooks the HTTPS listener serves.
/// `prWatch` (0063): `pr/watch`, `pr/unwatch`, `pr/watches`, and `pr/status` (PLX-837).
/// `setupScripts` (PLX-650): `repo/scripts`, `repo/saveScripts`, and the `thread.script` event.
/// `fileUploads` (PLX-779, 0071): `host/upload`, which saves a file attached to a message on the
/// host for the agent to read, and `host/readUpload`, which reads it back for the transcript.
/// Its option `maxBytes` is the cap on the file's base64 `data`.
/// `fileChunks` (PLX-833, 0074): `host/upload` takes a file in pieces, with `uploadId`, `offset`,
/// and `last`, and `host/readUpload` and `agent/file`'s `working` side read a slice, with `offset`
/// and `length`, which an older plxd would ignore, sending the whole file or refusing it. Its
/// options are `chunkBytes`, the most file bytes a piece or slice carries, and `maxBytes`, the
/// largest file pieces make.
/// `hostUpdate` (PLX-700, 0066): `host/update`, which installs a newer plxd and restarts into it.
/// `providerUpdates` (PLX-746): `providers/updates` and `providers/upgrade`, and `host/update`'s
/// `now`.
/// `checkpoints` (0062): `orchestration/threadRuns`, `orchestration/getTurnDiff`,
/// `orchestration/getFullThreadDiff`, `checkpoint.rollback`, and the `thread.checkpoint` and
/// `thread.reverted` events.
/// `delegation` (PLX-648, 0063): `task/delegate`, `task/status`, and `thread/mergeBack`.
/// `secrets` (PLX-648, 0063): `secret/request`, `secret/answer`, the `secretRequested` and
/// `secretResolved` transcript items, and `secretRef` in `schedule/save`.
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
        ("agentWait".to_owned(), serde_json::Map::new()),
        ("agents".to_owned(), serde_json::Map::new()),
        ("approvals".to_owned(), serde_json::Map::new()),
        ("areaRepos".to_owned(), serde_json::Map::new()),
        ("areas".to_owned(), serde_json::Map::new()),
        ("autoResume".to_owned(), serde_json::Map::new()),
        ("checkpoints".to_owned(), serde_json::Map::new()),
        ("checks".to_owned(), serde_json::Map::new()),
        ("checkout".to_owned(), serde_json::Map::new()),
        ("commandIds".to_owned(), serde_json::Map::new()),
        ("composerMenus".to_owned(), serde_json::Map::new()),
        ("connect".to_owned(), serde_json::Map::new()),
        ("contextAndFast".to_owned(), serde_json::Map::new()),
        ("coordinator".to_owned(), serde_json::Map::new()),
        ("delegation".to_owned(), serde_json::Map::new()),
        ("eventFilters".to_owned(), serde_json::Map::new()),
        ("eventsBefore".to_owned(), serde_json::Map::new()),
        (
            "fileChunks".to_owned(),
            serde_json::Map::from_iter([
                ("chunkBytes".to_owned(), CHUNK_BYTES.into()),
                ("maxBytes".to_owned(), MAX_FILE_BYTES.into()),
            ]),
        ),
        ("fileEdit".to_owned(), serde_json::Map::new()),
        (
            "fileUploads".to_owned(),
            serde_json::Map::from_iter([("maxBytes".to_owned(), MAX_UPLOAD_BYTES.into())]),
        ),
        ("files".to_owned(), serde_json::Map::new()),
        ("git".to_owned(), serde_json::Map::new()),
        ("repoGitStatus".to_owned(), serde_json::Map::new()),
        (
            "iconImages".to_owned(),
            serde_json::Map::from_iter([("maxBytes".to_owned(), images::MAX_ICON_BYTES.into())]),
        ),
        ("githubSetup".to_owned(), serde_json::Map::new()),
        ("githubStatus".to_owned(), serde_json::Map::new()),
        ("hostFolders".to_owned(), serde_json::Map::new()),
        ("hostUpdate".to_owned(), serde_json::Map::new()),
        ("inbox".to_owned(), serde_json::Map::new()),
        ("integrationBranch".to_owned(), serde_json::Map::new()),
        ("landing".to_owned(), serde_json::Map::new()),
        ("memory".to_owned(), serde_json::Map::new()),
        ("openPr".to_owned(), serde_json::Map::new()),
        ("orchestration".to_owned(), serde_json::Map::new()),
        ("prDiff".to_owned(), serde_json::Map::new()),
        ("projectAutonomy".to_owned(), serde_json::Map::new()),
        ("projectDelete".to_owned(), serde_json::Map::new()),
        ("projectEdit".to_owned(), serde_json::Map::new()),
        ("projectFromThreads".to_owned(), serde_json::Map::new()),
        ("projectPermission".to_owned(), serde_json::Map::new()),
        ("projectPlacement".to_owned(), serde_json::Map::new()),
        ("projectTasks".to_owned(), serde_json::Map::new()),
        ("providerUpdates".to_owned(), serde_json::Map::new()),
        ("providers".to_owned(), serde_json::Map::new()),
        ("promptImages".to_owned(), prompt_images),
        ("prWatch".to_owned(), serde_json::Map::new()),
        ("pullRequests".to_owned(), serde_json::Map::new()),
        ("queue".to_owned(), serde_json::Map::new()),
        ("questions".to_owned(), serde_json::Map::new()),
        ("remote".to_owned(), serde_json::Map::new()),
        ("remoteWeb".to_owned(), serde_json::Map::new()),
        ("relay".to_owned(), serde_json::Map::new()),
        ("repoRefs".to_owned(), serde_json::Map::new()),
        ("runOptions".to_owned(), serde_json::Map::new()),
        ("schedules".to_owned(), serde_json::Map::new()),
        ("secrets".to_owned(), serde_json::Map::new()),
        ("sendAccount".to_owned(), serde_json::Map::new()),
        ("sendModel".to_owned(), serde_json::Map::new()),
        ("sendOptions".to_owned(), serde_json::Map::new()),
        ("setupScripts".to_owned(), serde_json::Map::new()),
        ("spaces".to_owned(), serde_json::Map::new()),
        ("terminals".to_owned(), serde_json::Map::new()),
        ("threadAttention".to_owned(), serde_json::Map::new()),
        (
            "threadContext".to_owned(),
            serde_json::Map::from_iter([
                ("maxThreads".to_owned(), attached::MAX_THREADS.into()),
                ("maxSummaryBytes".to_owned(), attached::SUMMARY_BYTES.into()),
            ]),
        ),
        ("threadFork".to_owned(), serde_json::Map::new()),
        ("threadImport".to_owned(), serde_json::Map::new()),
        ("threadLineage".to_owned(), serde_json::Map::new()),
        ("threadNaming".to_owned(), serde_json::Map::new()),
        ("threadTools".to_owned(), serde_json::Map::new()),
        ("threads".to_owned(), serde_json::Map::new()),
        ("worktreeCleanup".to_owned(), serde_json::Map::new()),
    ]))
}

/// `host/folders`: the folders in a folder on this host, read on the blocking pool.
pub(crate) async fn folders(
    _: &Context,
    params: HostFoldersParams,
) -> Result<HostFoldersResult, ErrorObject> {
    let home = std::env::home_dir().filter(|home| home.is_absolute());
    super::context::run_blocking(move || list_folders(&params.path, home.as_deref())).await
}

/// The folders in `input`, which may start with `~` for `home`, sorted by name ignoring case. A
/// symbolic link counts when it points at a folder.
fn list_folders(input: &str, home: Option<&Path>) -> Result<HostFoldersResult, ErrorObject> {
    let tilde = input
        .strip_prefix("~/")
        .or_else(|| input.strip_prefix("~\\"))
        .or((input == "~").then_some(""));
    let dir: PathBuf = match (tilde, home) {
        (Some(rest), Some(home)) => home.join(rest),
        (Some(_), None) => return Err(ErrorObject::invalid_params("the home folder is unknown")),
        (None, _) if Path::new(input).is_absolute() => PathBuf::from(input),
        (None, _) => {
            return Err(ErrorObject::invalid_params(format!(
                "{input} is not an absolute path"
            )));
        }
    };
    let cant =
        |error: std::io::Error| ErrorObject::invalid_params(format!("Can't open {input}: {error}"));
    let mut folders: Vec<HostFolder> = fs::read_dir(&dir)
        .map_err(cant)?
        .filter_map(|entry| {
            let entry = entry.ok()?;
            // `metadata` follows a symbolic link, so a linked folder counts too.
            let path = entry.path();
            fs::metadata(&path).ok()?.is_dir().then(|| HostFolder {
                name: entry.file_name().to_string_lossy().into_owned(),
                path: path.to_string_lossy().into_owned(),
            })
        })
        .collect();
    folders.sort_by_cached_key(|f| f.name.to_lowercase());
    Ok(HostFoldersResult {
        path: dir.to_string_lossy().into_owned(),
        folders,
    })
}

/// The longest an uploaded file's `data` may be, in bytes of base64, about 4.5 MiB of file: what
/// fits in one of 0007's 8 MiB frames with the envelope.
pub(crate) const MAX_UPLOAD_BYTES: usize = 6 * 1024 * 1024;

/// The most file bytes one piece of `host/upload`, or one slice of `host/readUpload` or
/// `agent/file`, carries (`fileChunks`, 0074): about 1.4 MiB of base64, which a slow link sends
/// well inside the app's request timeout.
pub(crate) const CHUNK_BYTES: u64 = 1024 * 1024;

/// The largest file `host/upload` assembles from pieces (`fileChunks`, 0074).
pub(crate) const MAX_FILE_BYTES: u64 = 1024 * 1024 * 1024;

/// How long an unfinished upload waits for its next piece before [`sweep_uploads`] removes it.
const ABANDONED_AFTER: Duration = Duration::from_hours(1);

/// What an unfinished upload's folder adds to its id, until its last piece renames it.
const PARTIAL: &str = ".partial";

/// Held while a piece is checked and written, and while the sweep runs, so each piece sees the
/// length the one before it left.
// ponytail: one lock for every upload; one per upload if many large uploads run at once.
static PIECES: Mutex<()> = Mutex::new(());

/// The `(offset, length)` a slice's `offset` and `length` ask for, or `None` without either.
pub(crate) fn slice(
    offset: Option<u64>,
    length: Option<u64>,
) -> Result<Option<(u64, u64)>, ErrorObject> {
    if offset.is_none() && length.is_none() {
        return Ok(None);
    }
    let length = length.unwrap_or(CHUNK_BYTES);
    if length > CHUNK_BYTES {
        return Err(ErrorObject::invalid_params(format!(
            "length is {length}; a slice is at most {CHUNK_BYTES} bytes"
        )));
    }
    Ok(Some((offset.unwrap_or(0), length)))
}

/// `host/upload`: saves the file in a new folder of the data folder's `uploads/` and answers its
/// path, which the app puts in the message for the agent to read (0071). A piece of a larger file
/// goes to [`save_piece`] instead (0074).
// ponytail: finished uploads are never removed; prune them with their thread if the folder grows.
pub(crate) async fn upload(
    context: &Context,
    params: HostUploadParams,
) -> Result<HostUploadResult, ErrorObject> {
    let uploads = context.daemon.data_dir.uploads_dir();
    if params.upload_id.is_some() || params.offset.is_some() || params.last.is_some() {
        return super::context::run_blocking(move || save_piece(&uploads, &params)).await;
    }
    let dir = uploads.join(Uuid::now_v7().to_string());
    super::context::run_blocking(move || save_upload(&dir, &params)).await
}

/// `params`' bytes, after checking its name and the length of its base64.
fn upload_bytes(params: &HostUploadParams) -> Result<Vec<u8>, ErrorObject> {
    let name = params.name.as_str();
    // `:` too: on Windows `C:x` is a path on drive C, which `join` would put outside `dir`.
    if name.is_empty() || name == "." || name == ".." || name.contains(['/', '\\', ':', '\0']) {
        return Err(ErrorObject::invalid_params(format!(
            "{:?} is not a plain file name",
            untrusted(name)
        )));
    }
    if params.data.len() > MAX_UPLOAD_BYTES {
        return Err(ErrorObject::invalid_params(format!(
            "the file is {} bytes of base64; it must be at most {MAX_UPLOAD_BYTES}",
            params.data.len()
        )));
    }
    images::decode(&params.data)
        .ok_or_else(|| ErrorObject::invalid_params("data is not standard base64 with padding"))
}

fn save_failed(error: &std::io::Error) -> ErrorObject {
    ErrorObject::internal_error(format!("could not save the file: {error}"))
}

/// Writes `params`' file as `<dir>/<name>`, after checking its name and size.
fn save_upload(dir: &Path, params: &HostUploadParams) -> Result<HostUploadResult, ErrorObject> {
    let bytes = upload_bytes(params)?;
    let path = dir.join(&params.name);
    fs::create_dir_all(dir)
        .and_then(|()| fs::write(&path, bytes))
        .map_err(|error| save_failed(&error))?;
    Ok(HostUploadResult {
        path: path.to_string_lossy().into_owned(),
        upload_id: None,
    })
}

/// Appends a piece of a file to its upload in `uploads`, `<id>.partial/<name>`, which a first
/// piece starts, and on the last piece renames the folder to `<id>`, so the final path only ever
/// holds a whole file. The piece that landed last, sent again as a retry sends it, answers as it
/// did without being written twice, even once its `last` finished the file.
fn save_piece(uploads: &Path, params: &HostUploadParams) -> Result<HostUploadResult, ErrorObject> {
    let bytes = upload_bytes(params)?;
    let offset = params.offset.unwrap_or(0);
    let size = bytes.len() as u64;
    if size > CHUNK_BYTES {
        return Err(ErrorObject::invalid_params(format!(
            "the piece is {size} bytes; it must be at most {CHUNK_BYTES}"
        )));
    }
    if offset.saturating_add(size) > MAX_FILE_BYTES {
        return Err(ErrorObject::invalid_params(format!(
            "the file would be over {MAX_FILE_BYTES} bytes"
        )));
    }
    if params.upload_id.is_none() && offset != 0 {
        return Err(ErrorObject::invalid_params(
            "a piece after the first must name its uploadId",
        ));
    }
    let id = params.upload_id.unwrap_or_else(UploadId::generate);
    let last = params.last == Some(true);
    let partial = uploads.join(format!("{id}{PARTIAL}"));
    let path = partial.join(&params.name);
    let done = uploads.join(id.to_string());
    let answer = HostUploadResult {
        path: done.join(&params.name).to_string_lossy().into_owned(),
        upload_id: Some(id),
    };
    let _held = PIECES.lock().unwrap_or_else(PoisonError::into_inner);
    let mut file = if params.upload_id.is_none() {
        fs::create_dir_all(&partial)
            .and_then(|()| fs::File::create_new(&path))
            .map_err(|error| save_failed(&error))?
    } else {
        // Only a file a first piece made, and never through a symlink.
        let plain = |path: &Path, options: &mut fs::OpenOptions| {
            open_plain(path, options)
                .ok()
                .filter(|file| file.metadata().is_ok_and(|meta| meta.is_file()))
        };
        match plain(&path, fs::OpenOptions::new().read(true).append(true)) {
            Some(file) => file,
            None if last
                && plain(&done.join(&params.name), fs::OpenOptions::new().read(true))
                    .is_some_and(|file| ends_with(&file, offset, &bytes)) =>
            {
                return Ok(answer);
            }
            None => {
                return Err(ErrorObject::invalid_params(format!(
                    "upload {id} has no unfinished file named {:?}",
                    untrusted(&params.name)
                )));
            }
        }
    };
    let received = file.metadata().map_err(|error| save_failed(&error))?.len();
    if received == offset {
        if let Err(error) = file.write_all(&bytes) {
            // So the piece can be sent again.
            let _ = file.set_len(offset);
            return Err(save_failed(&error));
        }
    } else if !ends_with(&file, offset, &bytes) {
        return Err(ErrorObject::invalid_params(format!(
            "upload {id} has {received} bytes, so its next piece starts there, not at {offset}"
        )));
    }
    drop(file);
    if last {
        fs::rename(&partial, &done).map_err(|error| save_failed(&error))?;
    }
    Ok(answer)
}

/// Whether `file` is `offset` bytes followed by exactly `bytes`: the piece that landed last.
fn ends_with(mut file: &fs::File, offset: u64, bytes: &[u8]) -> bool {
    let mut tail = Vec::with_capacity(bytes.len());
    file.metadata()
        .is_ok_and(|meta| meta.len() == offset + bytes.len() as u64)
        && file.seek(SeekFrom::Start(offset)).is_ok()
        && file.read_to_end(&mut tail).is_ok()
        && tail == bytes
}

/// Opens `path` with `options` without following a symlink at its end, or waiting on a FIFO.
fn open_plain(path: &Path, options: &mut fs::OpenOptions) -> std::io::Result<fs::File> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt as _;
        options.custom_flags(
            (rustix::fs::OFlags::NOFOLLOW | rustix::fs::OFlags::NONBLOCK)
                .bits()
                .cast_signed(),
        );
    }
    options.open(path)
}

/// Removes the uploads no piece has reached for [`ABANDONED_AFTER`]. `agents::cleanup` runs it
/// at start and on every recheck sweep, about every 15 minutes.
pub(crate) async fn sweep_uploads(daemon: &Daemon) {
    let uploads = daemon.data_dir.uploads_dir();
    let cutoff = SystemTime::now() - ABANDONED_AFTER;
    let _ = tokio::task::spawn_blocking(move || sweep_uploads_at(&uploads, cutoff)).await;
}

/// Removes every unfinished upload in `uploads` written last before `cutoff`.
fn sweep_uploads_at(uploads: &Path, cutoff: SystemTime) {
    let Ok(entries) = fs::read_dir(uploads) else {
        return;
    };
    let _held = PIECES.lock().unwrap_or_else(PoisonError::into_inner);
    for entry in entries.flatten() {
        if !entry.file_name().to_string_lossy().ends_with(PARTIAL) {
            continue;
        }
        let path = entry.path();
        // A piece changes its file's time, and the first one made the folder.
        let newest = fs::read_dir(&path)
            .into_iter()
            .flatten()
            .flatten()
            .chain([entry])
            .filter_map(|entry| entry.metadata().ok()?.modified().ok())
            .max();
        if newest.is_some_and(|newest| newest >= cutoff) {
            continue;
        }
        match fs::remove_dir_all(&path) {
            Ok(()) => info!(path = %path.display(), "removed an unfinished upload"),
            Err(error) => {
                warn!(%error, path = %path.display(), "could not remove an unfinished upload");
            }
        }
    }
}

/// `host/readUpload`: a file [`upload`] saved, or a slice of it, as base64.
pub(crate) async fn read_upload(
    context: &Context,
    params: HostReadUploadParams,
) -> Result<HostReadUploadResult, ErrorObject> {
    let root = context.daemon.data_dir.uploads_dir();
    let slice = slice(params.offset, params.length)?;
    super::context::run_blocking(move || read_upload_at(&root, &params.path, slice)).await
}

/// The file at `path`, as base64, if it's inside `root` once links are followed. A slice, `(offset,
/// length)`, is also refused through a link inside `root`.
fn read_upload_at(
    root: &Path,
    path: &str,
    slice: Option<(u64, u64)>,
) -> Result<HostReadUploadResult, ErrorObject> {
    let refuse =
        || ErrorObject::invalid_params(format!("{:?} is not an uploaded file", untrusted(path)));
    let given = root;
    let root = fs::canonicalize(given).map_err(|_| refuse())?;
    let file = fs::canonicalize(path).map_err(|_| refuse())?;
    let Some((offset, length)) = slice else {
        // Only what `host/upload` could have saved in one piece, which fits in a frame.
        let fits = fs::metadata(&file)
            .is_ok_and(|meta| meta.is_file() && meta.len() <= (MAX_UPLOAD_BYTES / 4 * 3) as u64);
        if !file.starts_with(&root) || !fits {
            return Err(refuse());
        }
        let bytes = fs::read(&file).map_err(|_| refuse())?;
        return Ok(HostReadUploadResult {
            data: images::encode(&bytes),
            size: None,
        });
    };
    // Below `root`, the path must already be the file's real one, so no link is followed. The
    // file is opened once, without following one, and checked on that handle, so a file swapped
    // in since is refused.
    let asked = Path::new(path);
    let below = asked
        .strip_prefix(given)
        .or_else(|_| asked.strip_prefix(&root))
        .map_err(|_| refuse())?;
    if !file.starts_with(&root) || root.join(below) != file {
        return Err(refuse());
    }
    let mut opened = open_plain(&file, fs::OpenOptions::new().read(true)).map_err(|_| refuse())?;
    let size = opened
        .metadata()
        .ok()
        .filter(fs::Metadata::is_file)
        .ok_or_else(refuse)?
        .len();
    let mut bytes = Vec::new();
    // Past the end is empty, however far: a seek to 2^63 or more fails.
    if offset < size {
        opened
            .seek(SeekFrom::Start(offset))
            .and_then(|_| (&opened).take(length).read_to_end(&mut bytes))
            .map_err(|_| refuse())?;
    }
    Ok(HostReadUploadResult {
        data: images::encode(&bytes),
        size: Some(size),
    })
}

pub(crate) fn health(context: &Context, _: HostHealthParams) -> HostHealthResult {
    let daemon = &context.daemon;
    HostHealthResult {
        uptime_seconds: daemon.started.elapsed().as_secs(),
        // Lists and search read through `reader`, so the store is only usable with both.
        store: match (daemon.store.state(), daemon.reader.state()) {
            (StoreState::Ok, StoreState::Ok) => StoreState::Ok,
            _ => StoreState::Unavailable,
        },
        running_agents: daemon.agents.running(),
        queues: Some(HostQueues {
            store: daemon.store.queue_stats(),
        }),
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

/// `host/settings/get`.
pub(crate) async fn settings(
    context: &Context,
    _: HostSettingsGetParams,
) -> Result<HostSettings, ErrorObject> {
    context
        .daemon
        .reader
        .run(&context.cancel, |db| read_settings(db))
        .await
}

/// `host/settings/set`: stores the settings it names, then answers with them all. A change to
/// `connect` wakes the tailnet listener, one to `remote` the remote listener, and one to `remote`
/// or `relay` the relay connection.
pub(crate) async fn set_settings(
    context: &Context,
    params: HostSettingsSetParams,
) -> Result<HostSettings, ErrorObject> {
    let HostSettingsSetParams {
        auto_resume,
        continue_after_restart,
        clean_worktrees,
        connect,
        remote,
        remote_web,
        relay,
        device_name,
        device_icon,
    } = params;
    let device_name = device_name.as_deref().map(clean_device_name);
    let device_icon = device_icon
        .map(|icon| check_device_icon(&icon))
        .transpose()?;
    let settings = context
        .daemon
        .store
        .run(&context.cancel, move |db| {
            if let Some(on) = auto_resume {
                db.set_auto_resume(on).map_err(|e| store_error(&e))?;
                info!(auto_resume = on, "changed the host's auto-resume setting");
            }
            if let Some(on) = continue_after_restart {
                db.set_continue_after_restart(on)
                    .map_err(|e| store_error(&e))?;
                info!(
                    continue_after_restart = on,
                    "changed the host's continue-after-restart setting"
                );
            }
            if let Some(on) = clean_worktrees {
                db.set_clean_worktrees(on).map_err(|e| store_error(&e))?;
                info!(
                    clean_worktrees = on,
                    "changed the host's worktree cleanup setting"
                );
            }
            if let Some(on) = connect {
                db.set_connect(on).map_err(|e| store_error(&e))?;
                info!(connect = on, "changed the host's Parallax Connect setting");
            }
            if let Some(on) = remote {
                db.set_remote(on).map_err(|e| store_error(&e))?;
                info!(remote = on, "changed the host's remote setting");
            }
            if let Some(on) = remote_web {
                db.set_remote_web(on).map_err(|e| store_error(&e))?;
                info!(remote_web = on, "changed the host's web client setting");
            }
            if let Some(on) = relay {
                db.set_relay(on).map_err(|e| store_error(&e))?;
                info!(relay = on, "changed the host's relay setting");
            }
            if let Some(name) = device_name {
                db.set_device_name(name.as_deref())
                    .map_err(|e| store_error(&e))?;
            }
            if let Some(icon) = device_icon {
                db.set_device_icon(icon.as_deref())
                    .map_err(|e| store_error(&e))?;
            }
            read_settings(db)
        })
        .await?;
    if connect.is_some() {
        context.daemon.connect.changed.notify_one();
    }
    if remote.is_some() {
        context.daemon.remote.changed.notify_one();
    }
    if remote.is_some() || relay.is_some() {
        context.daemon.relay.changed.notify_one();
    }
    if remote_web == Some(false) {
        crate::server::remote::close_browsers(&context.daemon).await;
    }
    Ok(settings)
}

/// `deviceName` as stored: without control characters, trimmed, and at most
/// [`MAX_DEVICE_NAME_CHARS`] characters. `None` clears it, as `""` does.
fn clean_device_name(name: &str) -> Option<String> {
    let name: String = name.chars().filter(|c| !c.is_control()).collect();
    let name: String = name.trim().chars().take(MAX_DEVICE_NAME_CHARS).collect();
    let name = name.trim_end();
    (!name.is_empty()).then(|| name.to_owned())
}

/// `deviceIcon` as stored: one of [`DEVICE_ICONS`], or `None` for `""`, which clears it.
fn check_device_icon(icon: &str) -> Result<Option<String>, ErrorObject> {
    if icon.is_empty() {
        Ok(None)
    } else if DEVICE_ICONS.contains(&icon) {
        Ok(Some(icon.to_owned()))
    } else {
        Err(ErrorObject::invalid_params(
            "deviceIcon must be laptop, desktop, mini, or server",
        ))
    }
}

fn read_settings(db: &parallax_store::Store) -> Result<HostSettings, ErrorObject> {
    Ok(HostSettings {
        auto_resume: db.auto_resume().map_err(|e| store_error(&e))?,
        continue_after_restart: Some(db.continue_after_restart().map_err(|e| store_error(&e))?),
        clean_worktrees: Some(db.clean_worktrees().map_err(|e| store_error(&e))?),
        connect: Some(db.connect().map_err(|e| store_error(&e))?),
        remote: Some(db.remote().map_err(|e| store_error(&e))?),
        remote_web: Some(db.remote_web().map_err(|e| store_error(&e))?),
        relay: Some(db.relay().map_err(|e| store_error(&e))?),
        device_name: db.device_name().map_err(|e| store_error(&e))?,
        device_icon: db.device_icon().map_err(|e| store_error(&e))?,
    })
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
    use std::time::{Duration, SystemTime};

    use parallax_protocol::{HostUploadParams, UploadId};

    use super::{
        CHUNK_BYTES, MAX_FILE_BYTES, MAX_UPLOAD_BYTES, check_device_icon, clean_device_name,
        list_folders, plist_string, read_upload_at, save_piece, save_upload, slice,
        sweep_uploads_at,
    };
    use crate::images;

    #[test]
    fn device_names_are_cleaned_and_icons_checked() {
        assert_eq!(
            clean_device_name("  Studio\n\u{7}  ").as_deref(),
            Some("Studio")
        );
        assert_eq!(clean_device_name(""), None);
        assert_eq!(clean_device_name(" \t "), None);
        let long = "é".repeat(70);
        assert_eq!(clean_device_name(&long).unwrap().chars().count(), 64);

        assert_eq!(check_device_icon("mini").unwrap().as_deref(), Some("mini"));
        assert_eq!(check_device_icon("").unwrap(), None);
        assert_eq!(check_device_icon("phone").unwrap_err().code, -32602);
    }

    #[test]
    fn lists_folders_and_linked_folders_by_name() {
        let home = tempfile::tempdir().unwrap();
        let src = home.path().join("src");
        for name in ["beta", "Alpha", ".hidden"] {
            std::fs::create_dir_all(src.join(name)).unwrap();
        }
        std::fs::write(src.join("notes.txt"), "").unwrap();
        #[cfg(unix)]
        std::os::unix::fs::symlink(src.join("beta"), src.join("gamma")).unwrap();

        let listed = list_folders("~/src", Some(home.path())).unwrap();
        assert_eq!(listed.path, src.to_string_lossy());
        let names: Vec<_> = listed.folders.iter().map(|f| f.name.as_str()).collect();
        #[cfg(unix)]
        assert_eq!(names, [".hidden", "Alpha", "beta", "gamma"]);
        #[cfg(not(unix))]
        assert_eq!(names, [".hidden", "Alpha", "beta"]);
        assert_eq!(listed.folders[1].path, src.join("Alpha").to_string_lossy());

        assert_eq!(
            list_folders("~/missing", Some(home.path()))
                .unwrap_err()
                .code,
            -32602
        );
        assert_eq!(
            list_folders("relative", Some(home.path()))
                .unwrap_err()
                .code,
            -32602
        );
    }

    #[test]
    fn saves_an_upload_under_its_own_name_and_refuses_paths() {
        let dir = tempfile::tempdir().unwrap();
        let upload = |name: &str, data: &str| {
            save_upload(
                &dir.path().join("id"),
                &HostUploadParams {
                    name: name.to_owned(),
                    data: data.to_owned(),
                    ..HostUploadParams::default()
                },
            )
        };

        let saved = upload("paper v3.pdf", "JVBERi0=").unwrap();
        let path = dir.path().join("id").join("paper v3.pdf");
        assert_eq!(saved.path, path.to_string_lossy());
        assert_eq!(std::fs::read(path).unwrap(), b"%PDF-");

        for name in ["", ".", "..", "../x", "a/b", "a\\b", "C:x"] {
            assert_eq!(upload(name, "").unwrap_err().code, -32602, "{name}");
        }
        assert_eq!(upload("x", "not base64").unwrap_err().code, -32602);

        // Read back by its path, and nothing outside the uploads folder, whole or sliced.
        let read = |path: &std::path::Path, slice| {
            read_upload_at(dir.path(), &path.to_string_lossy(), slice)
        };
        let saved = std::path::Path::new(&saved.path);
        assert_eq!(read(saved, None).unwrap().data, "JVBERi0=");
        let outside = tempfile::NamedTempFile::new().unwrap();
        for slice in [None, Some((0, CHUNK_BYTES))] {
            assert_eq!(read(outside.path(), slice).unwrap_err().code, -32602);
            assert_eq!(
                read(&dir.path().join("id/../id/missing"), slice)
                    .unwrap_err()
                    .code,
                -32602
            );
            assert_eq!(
                read(&dir.path().join("id"), slice).unwrap_err().code,
                -32602
            );
        }

        // A slice, of any size of file, and the file's size.
        let sliced = read(saved, Some((1, 3))).unwrap();
        assert_eq!(
            (sliced.data, sliced.size),
            (images::encode(b"PDF"), Some(5))
        );
        for offset in [9, 1 << 63, u64::MAX] {
            let past = read(saved, Some((offset, 3))).unwrap();
            assert_eq!((past.data, past.size), (String::new(), Some(5)), "{offset}");
        }
        let big = dir.path().join("id/big.bin");
        let size = MAX_UPLOAD_BYTES / 4 * 3 + 1;
        std::fs::write(&big, vec![7; size]).unwrap();
        assert_eq!(read(&big, None).unwrap_err().code, -32602);
        let tail = read(&big, Some((size as u64 - 1, CHUNK_BYTES))).unwrap();
        assert_eq!(
            (tail.data, tail.size),
            (images::encode(&[7]), Some(size as u64))
        );

        // A whole read follows a link inside the uploads folder, as it always has; a slice never
        // does.
        #[cfg(unix)]
        {
            let link = dir.path().join("id/link.pdf");
            std::os::unix::fs::symlink(saved, &link).unwrap();
            assert_eq!(read(&link, None).unwrap().data, "JVBERi0=");
            assert_eq!(read(&link, Some((0, 3))).unwrap_err().code, -32602);
        }
    }

    #[test]
    fn a_slice_is_at_most_chunk_bytes() {
        assert_eq!(slice(None, None).unwrap(), None);
        assert_eq!(slice(Some(5), None).unwrap(), Some((5, CHUNK_BYTES)));
        assert_eq!(slice(None, Some(3)).unwrap(), Some((0, 3)));
        assert_eq!(slice(None, Some(CHUNK_BYTES + 1)).unwrap_err().code, -32602);
    }

    #[test]
    fn assembles_an_upload_from_ordered_pieces_and_removes_abandoned_ones() {
        let uploads = tempfile::tempdir().unwrap();
        let piece = |upload_id, offset, bytes: &[u8], last: bool| {
            save_piece(
                uploads.path(),
                &HostUploadParams {
                    name: "data.bin".to_owned(),
                    data: images::encode(bytes),
                    upload_id,
                    offset: Some(offset),
                    last: last.then_some(true),
                },
            )
        };
        let refused = |result: Result<_, parallax_protocol::jsonrpc::ErrorObject>| {
            result.unwrap_err().code == -32602
        };

        let first = piece(None, 0, &[0, 1, 2], false).unwrap();
        let id = first.upload_id.unwrap();
        let done = uploads.path().join(id.to_string()).join("data.bin");
        assert_eq!(first.path, done.to_string_lossy());
        assert!(!done.exists(), "only a whole file is at its path");

        // A gap, a different piece where one landed, a later piece without its upload, and an
        // upload plxd never started.
        assert!(refused(piece(Some(id), 4, &[4], false)));
        assert!(refused(piece(Some(id), 0, &[0], false)));
        assert!(refused(piece(None, 3, &[3], false)));
        assert!(refused(piece(Some(UploadId::generate()), 3, &[3], false)));
        // Pieces over the chunk size, or past the cap.
        assert!(refused(piece(None, 0, &vec![0; 1024 * 1024 + 1], false)));
        assert!(refused(piece(Some(id), MAX_FILE_BYTES, &[0], false)));

        // The piece that landed last, sent again, answers as it did and isn't written twice.
        let next = piece(Some(id), 3, &[3], false).unwrap();
        assert_eq!(piece(Some(id), 3, &[3], false).unwrap(), next);
        assert!(refused(piece(Some(id), 3, &[9], false)));
        let last = piece(Some(id), 4, &[4], true).unwrap();
        assert_eq!((&last.path, last.upload_id), (&first.path, Some(id)));
        assert_eq!(std::fs::read(&done).unwrap(), [0, 1, 2, 3, 4]);
        // So does the last piece, after it finished the file.
        assert_eq!(piece(Some(id), 4, &[4], true).unwrap(), last);
        assert_eq!(std::fs::read(&done).unwrap(), [0, 1, 2, 3, 4]);
        assert!(refused(piece(Some(id), 4, &[8], true)));
        assert!(refused(piece(Some(id), 5, &[5], false)), "it's finished");

        // An upload no piece reached for an hour is removed; a finished one stays.
        let abandoned = piece(None, 0, &[0], false).unwrap();
        let partial = uploads
            .path()
            .join(format!("{}.partial", abandoned.upload_id.unwrap()));
        sweep_uploads_at(uploads.path(), SystemTime::now() - Duration::from_hours(1));
        assert!(partial.exists());
        sweep_uploads_at(uploads.path(), SystemTime::now() + Duration::from_mins(1));
        assert!(!partial.exists());
        assert!(done.exists());
    }

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
