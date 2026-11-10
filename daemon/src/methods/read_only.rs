//! What a read-only device may call (PLX-1364, 0091). [`methods::dispatch`](super::dispatch) and the
//! connection's notifications ask here first, so nothing else decides.
//!
//! Both matches name every method with no wildcard, so a new method doesn't compile until someone
//! picks its side. A name in neither table is refused.
//!
//! A read here returns data, changes nothing, and takes nothing from the client that picks what
//! runs: a repo or run id, or a path that stays inside its folder. The methods that read but stay
//! refused:
//!
//! - `pr/status`, `pr/failureLog`, and `pr/sharedDiff` read any pull request with the host's `gh`,
//!   linked to a thread or not. `pr/view` and `pr/diff` read only a thread's.
//! - `pr/guide` starts an agent, `agent/commands` starts a CLI in the thread's folder, and
//!   `usage/limits`, `providers/updates`, and `accounts/refresh` start CLIs and tools.
//!   `usage/daily` runs `npx -y ccusage`, which can download what it runs. `accounts/list` and
//!   `providers/list` probe CLIs, up to `codex app-server` and an agent's new session, and
//!   `device/state` runs `adb`, which can start its server.
//! - `schedule/list` carries webhook addresses, which fire agents. `accounts/keys/list` and
//!   `hubs/list` describe stored keys. `repo/remote` is only for cloning a repository elsewhere.
//! - `thread/remoteControl` gives the link to a session on `claude.ai`, and its origin reads
//!   `claude.ai` with the host's sign-in.
//! - `preview/*`, `device/screenshot`, and `terminal/list` show or lead to what only a full-access
//!   device may drive. `computer/status` can ask macOS for permissions.
//! - `memory/sync*` is for another computer of the user's, and `bundle/read` needs `bundle/prepare`.
//! - `repo/gitStatus` and `agent/gitStatus` run a repository's configured clean filter, since
//!   `git status` and its temporary index read changed files through it. `-c` can't turn a filter
//!   off without its name ([`crate::worktree`]), so no read-only device can ask for them.
//!
//! The programs the reads here do run: `git` as `rev-parse`, `ls-files`, `grep`, `for-each-ref`,
//! `check-ignore`, `ls-tree`, `cat-file`, and `diff` between two commits, none of which reads a file
//! through a filter, all with hooks, the filesystem monitor, and any fetch for a partial clone's
//! missing object off, and a diff with external diff, textconv, and nested submodule diffs off too.
//! `gh` with fixed arguments outside any repository. `tailscale status`.

use parallax_protocol::ErrorKind;
use parallax_protocol::jsonrpc::ErrorObject;
use parallax_protocol::methods::{NotificationName, RequestName};

/// What a read-only device gets for anything [`allows_request`] refuses.
pub(super) fn refusal() -> ErrorObject {
    ErrorObject::parallax(
        ErrorKind::ReadOnly,
        "This device is read-only on this computer. It can read threads but not change anything.",
    )
}

/// Whether a read-only device may call the request `method`.
pub(super) fn allows_request(method: &str) -> bool {
    RequestName::from_name(method).is_some_and(is_read)
}

/// Whether a read-only device may send the notification `method`: `$/cancelRequest` only stops its
/// own requests, and the rest write to a terminal or device, or are plxd's to send.
pub(crate) fn allows_notification(method: &str) -> bool {
    match NotificationName::from_name(method) {
        Some(NotificationName::CancelRequest) => true,
        Some(
            NotificationName::EventsEvent
            | NotificationName::EventsResync
            | NotificationName::HostUpdating
            | NotificationName::TerminalWrite
            | NotificationName::TerminalResize
            | NotificationName::TerminalDetach
            | NotificationName::TerminalOutput
            | NotificationName::TerminalExit
            | NotificationName::DeviceSend
            | NotificationName::DeviceClose
            | NotificationName::DeviceData
            | NotificationName::DeviceEnd,
        )
        | None => false,
    }
}

/// Picks the side of every request method. See the module's docs for what makes a read.
#[expect(clippy::too_many_lines, reason = "one line per method")]
fn is_read(method: RequestName) -> bool {
    use RequestName as M;
    match method {
        M::Initialize
        | M::HostHealth
        | M::HostVersion
        | M::HostReadUpload
        | M::HostSettingsGet
        | M::OrchestratorList
        | M::EventsSubscribe
        | M::EventsUnsubscribe
        | M::OrchestrationSubscribeShell
        | M::OrchestrationSubscribeThread
        | M::OrchestrationThreadHistory
        | M::OrchestrationThreadRuns
        | M::OrchestrationGetTurnDiff
        | M::OrchestrationGetFullThreadDiff
        | M::ThreadList
        | M::ThreadSearch
        | M::AgentList
        | M::AgentEvents
        | M::AgentImage
        | M::AgentWait
        | M::AgentDiff
        | M::AgentFile
        | M::AgentFiles
        | M::RepoFiles
        | M::RepoGrep
        | M::RepoLogo
        | M::RepoRefs
        | M::ContextList
        | M::ContextRead
        | M::ContextReadBytes
        | M::MemoryList
        | M::MemoryRead
        | M::BoardList
        | M::InboxList
        | M::QueueList
        | M::QuestionList
        | M::PrView
        | M::PrDiff
        | M::PrWatches
        | M::UsageGet
        | M::UsageHistory
        | M::AccountsDefaultsGet
        | M::GithubStatusGet
        | M::RemoteSessions
        | M::RelayId
        // Opens only what its thread's readers can already read (0100), and a read-only phone
        // still gets notifications.
        | M::RelayPushKey
        // Without a waiting request's code: see `methods::remote::access_get`.
        | M::AccessGet => true,

        M::HostUpdate
        | M::HostAnnounceUpdate
        | M::HostFolders
        | M::HostUpload
        | M::HostSettingsSet
        | M::OrchestratorCreate
        | M::OrchestratorStart
        | M::OrchestratorFresh
        | M::OrchestratorUpdate
        | M::OrchestratorDelete
        | M::OrchestratorFromThreads
        | M::AccountsKeysAdd
        | M::AccountsKeysList
        | M::AccountsKeysRemove
        | M::AccountsRefresh
        | M::AccountsDefaultsSet
        | M::ProvidersSave
        | M::ProvidersRemove
        | M::ProvidersUpdates
        | M::ProvidersUpgrade
        | M::HubsList
        | M::HubsSave
        | M::HubsRemove
        | M::HubsAccountsSignIn
        | M::HubsAccountsCallback
        | M::HubsAccountsStatus
        | M::HubsAccountsCancel
        | M::HubsAccountsSetEnabled
        | M::HubsAccountsRemove
        | M::UsageReportClaim
        | M::UsageReportRelease
        | M::UsageLimits
        | M::UsageDaily
        | M::AccountsList
        | M::ProvidersList
        | M::DeviceState
        | M::ContextWrite
        | M::ContextSaveArtifact
        | M::AgentStart
        | M::AgentSend
        | M::AgentCancel
        | M::AgentAttach
        | M::AgentFileCreate
        | M::AgentFileRename
        | M::AgentFileDelete
        | M::AgentFileWrite
        | M::AgentAccept
        | M::AgentRequestChanges
        | M::AgentOpenPr
        | M::AgentGitStatus
        | M::RepoGitStatus
        | M::AgentCommit
        | M::AgentPush
        | M::AgentApprove
        | M::AgentCommands
        | M::AgentResumeNow
        | M::AgentStopTask
        | M::AgentSetPermission
        | M::AgentAutoResume
        | M::PreviewCall
        | M::PreviewList
        | M::PreviewFrame
        | M::PreviewInputSend
        | M::DeviceSetup
        | M::DeviceBoot
        | M::DeviceShutdown
        | M::DeviceCreate
        | M::DeviceScreenshot
        | M::DeviceChrome
        | M::DeviceStream
        | M::ComputerAsk
        | M::ComputerStatusGet
        | M::ComputerForget
        | M::RepoAdd
        | M::RepoClone
        | M::RepoCloneProgress
        | M::RepoRemote
        | M::RepoMatch
        | M::RepoUpdate
        | M::RepoScripts
        | M::RepoSaveScripts
        | M::ThreadStart
        | M::ThreadFork
        | M::ThreadImportable
        | M::ThreadImport
        | M::ThreadImportChat
        | M::ThreadImportedChats
        | M::ThreadRemoteControl
        | M::ThreadRemoteControlOrigin
        | M::ThreadArchive
        | M::ThreadUpdate
        | M::ThreadDelete
        | M::ThreadSetProject
        | M::ThreadMergeBack
        | M::ProjectCreate
        | M::ProjectDelete
        | M::PrAct
        | M::PrLink
        | M::PrUnlink
        | M::PrWatch
        | M::PrUnwatch
        | M::PrStatus
        | M::PrFailureLog
        | M::PrUploadMedia
        | M::PrSharedDiff
        | M::PrWrite
        | M::PrGuide
        | M::PrMergeWhenReady
        | M::VoiceClean
        | M::ConnectDevices
        | M::RemotePair
        | M::RemoteRevoke
        | M::RelayRegister
        | M::RelaySign
        | M::RelayHosts
        | M::RelayCheck
        | M::RelayRemove
        | M::AccessMerge
        | M::AccessSetReadOnly
        | M::AccessApprove
        | M::AccessDeny
        | M::AccessRemove
        | M::AccessForgetHost
        | M::AccessSetupCode
        | M::InboxSeen
        | M::GithubInstall
        | M::GithubSignInStart
        | M::GithubSignInCancel
        | M::QueueEdit
        | M::QueueReorder
        | M::QueueCancel
        | M::QueueSteer
        | M::QuestionAsk
        | M::QuestionAnswer
        | M::QuestionEscalate
        | M::BoardAdd
        | M::BoardUpdate
        | M::BoardRemove
        | M::MemoryWrite
        | M::MemoryDelete
        | M::MemoryPropose
        | M::MemorySyncList
        | M::MemorySyncRead
        | M::LandQueue
        | M::LandApprove
        | M::LandSendBack
        | M::CursorSignIn
        | M::CursorSignInCancel
        | M::CursorSignOut
        | M::CursorInstall
        | M::TerminalOpen
        | M::TerminalClose
        | M::TerminalList
        | M::ScheduleList
        | M::ScheduleSave
        | M::ScheduleDelete
        | M::ScheduleRun
        | M::TaskDelegate
        | M::TaskStatus
        | M::SecretRequest
        | M::SecretAnswer
        | M::OrchestrationDispatch
        | M::BundlePrepare
        | M::BundleRead
        | M::BundleDrop
        | M::BundleBegin
        | M::BundleWrite
        | M::BundleApply
        | M::RepoFetchBase
        | M::PeerComputers
        | M::PeerCall
        | M::PeerStart
        | M::PeerTask
        | M::GitStartMerge => false,
    }
}

#[cfg(test)]
mod tests {
    use super::{allows_notification, allows_request};

    #[test]
    fn a_read_only_device_may_read_threads_and_nothing_that_acts() {
        for read in [
            "thread/list",
            "orchestration/subscribeThread",
            "agent/events",
            "agent/diff",
        ] {
            assert!(allows_request(read), "{read}");
        }
        for write in [
            // Writes, agent starts, sends, and approvals.
            "context/write",
            "agent/fileDelete",
            "agent/start",
            "thread/start",
            "agent/send",
            "orchestration/dispatch",
            "agent/approve",
            // Terminals.
            "terminal/open",
            "terminal/close",
            "terminal/list",
            // Settings and secrets.
            "host/settings/set",
            "host/update",
            "accounts/keys/add",
            "accounts/keys/list",
            "secret/answer",
            // Devices, and the codes that would make a new one.
            "access/approve",
            "access/remove",
            "access/merge",
            "access/setReadOnly",
            "remote/revoke",
            "remote/pair",
            "access/setupCode",
            // Reads that start a program or reach past a thread.
            "agent/commands",
            "repo/gitStatus",
            "agent/gitStatus",
            "usage/daily",
            "accounts/list",
            "providers/list",
            "device/state",
            "pr/guide",
            "pr/status",
            "schedule/list",
            // Not a method.
            "no/such/method",
        ] {
            assert!(!allows_request(write), "{write}");
        }
    }

    #[test]
    fn a_read_only_device_writes_to_no_terminal_or_device() {
        assert!(allows_notification("$/cancelRequest"));
        for write in [
            "terminal/write",
            "terminal/resize",
            "terminal/detach",
            "device/send",
            "device/close",
            "no/such/method",
        ] {
            assert!(!allows_notification(write), "{write}");
        }
    }
}
