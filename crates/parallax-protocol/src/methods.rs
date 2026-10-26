//! The method table: every method, with its params and result types.
//!
//! Each method is a marker type that implements [`RequestMethod`] or [`NotificationMethod`].
//! The same table produces the generated TypeScript's method maps, so a method cannot exist on
//! one side only. Later milestones add methods here, each gated on a capability.
//!
//! ```
//! use parallax_protocol::HostHealthParams;
//! use parallax_protocol::jsonrpc::{ErrorObject, Request};
//! use parallax_protocol::methods::{HostHealth, Initialize, RequestMethod};
//!
//! let request = Request::new::<HostHealth>(1, HostHealthParams {});
//! assert_eq!(request.method, HostHealth::NAME);
//!
//! let answer = match request.method.as_str() {
//!     Initialize::NAME => Ok("handshake"),
//!     HostHealth::NAME => Ok("health"),
//!     other => Err(ErrorObject::method_not_found(other)),
//! };
//! assert_eq!(answer, Ok("health"));
//! ```

use serde::Serialize;
use serde::de::DeserializeOwned;
use ts_rs::TS;

use crate::jsonrpc::CancelRequestParams;
use crate::schedule::{PrFailureLogParams, PrFailureLogResult};
use crate::{
    AccountsDefaultsGetParams, AccountsDefaultsGetResult, AccountsDefaultsSetParams,
    AccountsKeysAddParams, AccountsKeysAddResult, AccountsKeysListParams, AccountsKeysListResult,
    AccountsKeysRemoveParams, AccountsKeysRemoveResult, AccountsListParams, AccountsListResult,
    AccountsRefreshParams, AccountsRefreshResult, AgentAcceptParams, AgentAcceptResult,
    AgentApproveParams, AgentApproveResult, AgentAttachParams, AgentAttachResult,
    AgentAutoResumeParams, AgentCancelParams, AgentCommandsParams, AgentCommandsResult,
    AgentCommitParams, AgentDiffParams, AgentDiffResult, AgentEventsParams, AgentEventsResult,
    AgentFileCreateParams, AgentFileDeleteParams, AgentFileEditResult, AgentFileParams,
    AgentFileRenameParams, AgentFileResult, AgentFilesParams, AgentFilesResult,
    AgentGitStatusParams, AgentImageParams, AgentListParams, AgentListResult, AgentOpenPrParams,
    AgentOpenPrResult, AgentPushParams, AgentRequestChangesParams, AgentResumeNowParams,
    AgentRunResult, AgentSendParams, AgentStartParams, AgentStopTaskParams, AgentStopTaskResult,
    AgentWaitParams, AgentWaitResult, AreaCreateParams, AreaDeleteParams, AreaDeleteResult,
    AreaResult, AreaUpdateParams, BoardAddParams, BoardItemResult, BoardListParams,
    BoardListResult, BoardRemoveParams, BoardRemoveResult, BoardUpdateParams, ComputerAskParams,
    ComputerAskResult, ComputerForgetParams, ComputerStatus, ComputerStatusParams,
    ConnectDevicesParams, ConnectDevicesResult, ContextListParams, ContextListResult,
    ContextReadBytesParams, ContextReadBytesResult, ContextReadParams, ContextReadResult,
    ContextSaveArtifactParams, ContextWriteParams, ContextWriteResult, CoordinatorFreshParams,
    CursorInstallParams, CursorInstallResult, CursorSignInCancelParams, CursorSignInCancelResult,
    CursorSignInParams, CursorSignInResult, CursorSignOutParams, CursorSignOutResult,
    DelegatedTask, DeviceChromeResult, DeviceCloseParams, DeviceCreateParams, DeviceDataParams,
    DeviceEndParams, DeviceOkResult, DeviceResult, DeviceScreenshotResult, DeviceSetupParams,
    DeviceStateParams, DeviceStateResult, DeviceStreamParams, DeviceStreamResult, DeviceTarget,
    DispatchResult, EventsEventParams, EventsResyncParams, EventsSubscribeParams,
    EventsSubscribeResult, EventsUnsubscribeParams, EventsUnsubscribeResult, FullThreadDiffParams,
    GitStatus, GithubInstallParams, GithubSignIn, GithubSignInCancelParams,
    GithubSignInCancelResult, GithubSignInParams, GithubStatus, GithubStatusParams,
    HostFoldersParams, HostFoldersResult, HostHealthParams, HostHealthResult, HostReadUploadParams,
    HostReadUploadResult, HostSettings, HostSettingsGetParams, HostSettingsSetParams,
    HostUpdateParams, HostUpdateResult, HostUploadParams, HostUploadResult, HostVersionParams,
    HostVersionResult, InboxListParams, InboxListResult, InboxSeenParams, InboxSeenResult,
    InitializeParams, InitializeResult, LandApproveParams, LandQueueParams, LandResult,
    LandSendBackParams, MemoryDeleteParams, MemoryDeleteResult, MemoryListParams, MemoryListResult,
    MemoryProposeParams, MemoryProposeResult, MemoryReadParams, MemoryReadResult,
    MemorySyncListParams, MemorySyncListResult, MemorySyncReadParams, MemorySyncReadResult,
    MemoryWriteParams, MemoryWriteResult, OrchestrationCommand, PrActParams, PrDiffResult,
    PrStatusResult, PrViewParams, PrWatchResult, PrWatchesParams, PrWatchesResult,
    PreviewCallParams, PreviewCallResult, PreviewFrameParams, PreviewFrameResult,
    PreviewInputParams, PreviewInputResult, PreviewListParams, PreviewListResult,
    ProjectCreateParams, ProjectCreateResult, ProjectDeleteParams, ProjectDeleteResult,
    ProjectFromThreadsParams, ProjectFromThreadsResult, ProjectListParams, ProjectListResult,
    ProjectStartParams, ProjectUpdateParams, ProjectUpdateResult, PromptImage, ProvidersListParams,
    ProvidersListResult, ProvidersRemoveParams, ProvidersSaveParams, ProvidersUpdatesParams,
    ProvidersUpdatesResult, ProvidersUpgradeParams, ProvidersUpgradeResult, PullRequest,
    QuestionAnswerParams, QuestionAskParams, QuestionEscalateParams, QuestionListParams,
    QuestionListResult, QuestionResult, QueueCancelParams, QueueEditParams, QueueListParams,
    QueueReorderParams, QueueResult, QueueSteerParams, RelayHostsParams, RelayHostsResult,
    RelayRegisterParams, RelayRemoveParams, RemotePairParams, RemotePairResult, RemoteRevokeParams,
    RemoteSessionsParams, RemoteSessionsResult, RepoAddParams, RepoAddResult, RepoCloneParams,
    RepoCloneProgressParams, RepoCloneProgressResult, RepoFilesParams, RepoFilesResult,
    RepoGitStatusParams, RepoGrepParams, RepoGrepResult, RepoMatchParams, RepoMatchResult,
    RepoRefsParams, RepoRefsResult, RepoRemoteParams, RepoRemoteResult, RepoSaveScriptsParams,
    RepoScriptsParams, RepoScriptsResult, RepoUpdateParams, RepoUpdateResult, ScheduleDeleteResult,
    ScheduleIdParams, ScheduleListParams, ScheduleListResult, ScheduleSaveParams, ScheduledTask,
    SecretAnswerParams, SecretAnswerResult, SecretRequestParams, SecretRequestResult,
    SpaceCreateParams, SpaceCreateResult, SpaceDeleteParams, SpaceDeleteResult,
    SubscribeShellParams, SubscribeShellResult, SubscribeThreadParams, SubscribeThreadResult,
    TaskDelegateParams, TaskStatusParams, TerminalExitParams, TerminalKey, TerminalListParams,
    TerminalListResult, TerminalOpenParams, TerminalOutputParams, TerminalResizeParams,
    TerminalResult, TerminalWriteParams, ThreadArchiveParams, ThreadArchiveResult,
    ThreadDeleteParams, ThreadDeleteResult, ThreadForkParams, ThreadHistoryParams,
    ThreadHistoryResult, ThreadImportChatParams, ThreadImportParams, ThreadImportableParams,
    ThreadImportableResult, ThreadImportedChatsParams, ThreadImportedChatsResult, ThreadListParams,
    ThreadListResult, ThreadMergeBackParams, ThreadMergeBackResult, ThreadRunsParams,
    ThreadRunsResult, ThreadSearchParams, ThreadSearchResult, ThreadStartParams, ThreadStartResult,
    ThreadUpdateParams, ThreadUpdateResult, TurnDiffParams, TurnDiffResult, UsageDailyParams,
    UsageDailyResult, UsageGetParams, UsageGetResult, UsageHistoryParams, UsageHistoryResult,
    UsageLimitsParams, UsageLimitsResult,
};
use crate::{
    BundleApplyParams, BundleBeginParams, BundleBeginResult, BundleDropParams, BundleOkResult,
    BundlePrepareParams, BundlePrepareResult, BundleReadParams, BundleReadResult,
    BundleWriteParams, GitStartMergeParams,
};

/// A method that is called with a request and answered with a response.
pub trait RequestMethod {
    /// The method name on the wire.
    const NAME: &'static str;
    /// The request's params.
    type Params: Serialize + DeserializeOwned + TS + 'static;
    /// The result of a successful response.
    type Result: Serialize + DeserializeOwned + TS + 'static;
}

/// A method that is sent as a notification, with no response.
pub trait NotificationMethod {
    /// The method name on the wire.
    const NAME: &'static str;
    /// The notification's params.
    type Params: Serialize + DeserializeOwned + TS + 'static;
}

pub(crate) trait Visitor {
    fn request<M: RequestMethod>(&mut self, docs: &[&str]);
    fn notification<N: NotificationMethod>(&mut self, docs: &[&str]);
}

macro_rules! method_table {
    (
        requests {
            $(
                $(#[doc = $request_doc:literal])*
                $request:ident = $request_name:literal: $params:ty => $result:ty;
            )*
        }
        notifications {
            $(
                $(#[doc = $notification_doc:literal])*
                $notification:ident = $notification_name:literal: $notification_params:ty;
            )*
        }
    ) => {
        $(
            $(#[doc = $request_doc])*
            #[derive(Debug)]
            pub enum $request {}

            impl RequestMethod for $request {
                const NAME: &'static str = $request_name;
                type Params = $params;
                type Result = $result;
            }
        )*

        $(
            $(#[doc = $notification_doc])*
            #[derive(Debug)]
            pub enum $notification {}

            impl NotificationMethod for $notification {
                const NAME: &'static str = $notification_name;
                type Params = $notification_params;
            }
        )*

        pub(crate) fn visit(visitor: &mut impl Visitor) {
            $(visitor.request::<$request>(&[$($request_doc),*]);)*
            $(visitor.notification::<$notification>(&[$($notification_doc),*]);)*
        }
    };
}

method_table! {
    requests {
        /// `initialize`: the handshake. It must be the first request on a connection; plxd
        /// answers anything before it with `notInitialized`.
        Initialize = "initialize": InitializeParams => InitializeResult;
        /// `host/health`: uptime, store state, and running agents. The app sends it every
        /// 30 seconds and on wake, as a heartbeat.
        HostHealth = "host/health": HostHealthParams => HostHealthResult;
        /// `host/version`: plxd's release and protocol versions, operating system, and CPU
        /// architecture.
        HostVersion = "host/version": HostVersionParams => HostVersionResult;
        /// `host/update`: installs plxd `version` from its GitHub release, checked against the
        /// release's SHA-256, and restarts into it once no agent's turn is running, or at once
        /// with `now`. It never downgrades. Gated on the `hostUpdate` capability (PLX-700, decision 0066).
        HostUpdate = "host/update": HostUpdateParams => HostUpdateResult;
        /// `host/folders`: the folders in a folder on the host, for adding a repository there
        /// (PLX-769). Gated on the `hostFolders` capability.
        HostFolders = "host/folders": HostFoldersParams => HostFoldersResult;
        /// `host/upload`: saves a file attached to a message on the host and answers its path
        /// (PLX-779, decision 0071). Gated on the `fileUploads` capability, and a file sent in
        /// pieces on `fileChunks` (decision 0074).
        HostUpload = "host/upload": HostUploadParams => HostUploadResult;
        /// `host/readUpload`: a file `host/upload` saved, for the transcript (PLX-779). Gated on
        /// the `fileUploads` capability, and a slice of it on `fileChunks` (decision 0074).
        HostReadUpload = "host/readUpload": HostReadUploadParams => HostReadUploadResult;
        /// `project/list`: every project, and the event log's `seq` from before the read.
        ProjectList = "project/list": ProjectListParams => ProjectListResult;
        /// `project/create`: creates a project, idempotent on its client-generated id.
        ProjectCreate = "project/create": ProjectCreateParams => ProjectCreateResult;
        /// `events/subscribe`: replays the events after a `seq`, then streams new ones as
        /// `events/event` notifications.
        EventsSubscribe = "events/subscribe": EventsSubscribeParams => EventsSubscribeResult;
        /// `events/unsubscribe`: ends a subscription.
        EventsUnsubscribe = "events/unsubscribe": EventsUnsubscribeParams => EventsUnsubscribeResult;
        /// `accounts/keys/add`: stores an API key in the Keychain, idempotent on its
        /// client-generated id. The response returns only the key's masked form.
        AccountsKeysAdd = "accounts/keys/add": AccountsKeysAddParams => AccountsKeysAddResult;
        /// `accounts/keys/list`: every key account, with its key masked.
        AccountsKeysList = "accounts/keys/list": AccountsKeysListParams => AccountsKeysListResult;
        /// `accounts/keys/remove`: removes a key account's key from the Keychain, and its
        /// record. Fails with `accountNotFound` if the id does not exist.
        AccountsKeysRemove = "accounts/keys/remove": AccountsKeysRemoveParams => AccountsKeysRemoveResult;
        /// `accounts/list`: the vendor CLIs plxd detects (#114), installed, signed in, and their
        /// plan where exposed. May answer from a short-lived cache. Gated on the `agentClis`
        /// capability.
        AccountsList = "accounts/list": AccountsListParams => AccountsListResult;
        /// `accounts/refresh`: like `accounts/list`, but always probes again instead of using the
        /// cache. Gated on the `agentClis` capability.
        AccountsRefresh = "accounts/refresh": AccountsRefreshParams => AccountsRefreshResult;
        /// `providers/list`: this host's provider instances (0040), each with its detected state
        /// and models. May answer from a short-lived cache unless `refresh` is set. Gated on the
        /// `providers` capability.
        ProvidersList = "providers/list": ProvidersListParams => ProvidersListResult;
        /// `providers/save`: adds an instance, or replaces the one with its id, and returns every
        /// instance. A secret variable sent without a value keeps its stored one.
        ProvidersSave = "providers/save": ProvidersSaveParams => ProvidersListResult;
        /// `providers/remove`: removes an instance the user added, and its secrets, and returns
        /// every instance. Fails with `invalidParams` for a built-in one.
        ProvidersRemove = "providers/remove": ProvidersRemoveParams => ProvidersListResult;
        /// `providers/updates`: each installed Claude Code and Codex with a newer release where it
        /// came from: its Homebrew cask or formula, else its npm package. Gated on the
        /// `providerUpdates` capability (PLX-746, PLX-783).
        ProvidersUpdates = "providers/updates": ProvidersUpdatesParams => ProvidersUpdatesResult;
        /// `providers/upgrade`: runs the CLI's own `update` command, which knows how it was
        /// installed, or `brew upgrade`, one upgrade at a time, and answers with the version
        /// installed after it. Gated on the `providerUpdates` capability (PLX-746).
        ProvidersUpgrade = "providers/upgrade": ProvidersUpgradeParams => ProvidersUpgradeResult;
        /// `usage/get`: per-account tokens and cost for today and this week (local time on this
        /// host), and the latest limit windows.
        UsageGet = "usage/get": UsageGetParams => UsageGetResult;
        /// `usage/history`: tokens and cost since a time, summed per UTC hour, account, and
        /// model, and each account's run count over the same range.
        UsageHistory = "usage/history": UsageHistoryParams => UsageHistoryResult;
        /// `usage/daily`: every Claude Code, Codex, and Cursor session's tokens and cost on this
        /// host since a local day, per local day, agent, and model (0039), and each source that
        /// failed.
        UsageDaily = "usage/daily": UsageDailyParams => UsageDailyResult;
        /// `usage/limits`: every subscription account's limit windows, read live from its CLI,
        /// and why a CLI didn't answer.
        UsageLimits = "usage/limits": UsageLimitsParams => UsageLimitsResult;
        /// `accounts/defaults/get`: this host's default account for the coordinator role and for
        /// a worker role, absent where none is set (#119).
        AccountsDefaultsGet = "accounts/defaults/get": AccountsDefaultsGetParams => AccountsDefaultsGetResult;
        /// `accounts/defaults/set`: sets or clears one role's default account, and returns both
        /// roles' defaults as they stand after the change.
        AccountsDefaultsSet = "accounts/defaults/set": AccountsDefaultsSetParams => AccountsDefaultsGetResult;
        /// `context/list`: a project's shared context files (0005), each with its size, when it
        /// was last modified, and who last wrote it, if known.
        ContextList = "context/list": ContextListParams => ContextListResult;
        /// `context/read`: one shared context file's content. Fails with `contextNotFound` if it
        /// does not exist.
        ContextRead = "context/read": ContextReadParams => ContextReadResult;
        /// `context/write`: writes a shared context file in full, idempotent on its
        /// client-generated id. The last write to a path wins when two race.
        ContextWrite = "context/write": ContextWriteParams => ContextWriteResult;
        /// `context/readBytes`: one slice of a shared context file of any type, such as an
        /// artifact, base64-encoded. Behind `projectArtifacts`.
        ContextReadBytes = "context/readBytes": ContextReadBytesParams => ContextReadBytesResult;
        /// `context/saveArtifact`: copies a file from a Project child's working folder into the
        /// Project's `artifacts/<run id>/`. Behind `projectArtifacts`.
        ContextSaveArtifact = "context/saveArtifact": ContextSaveArtifactParams => ContextWriteResult;
        /// `agent/start`: starts a worker in its own worktree of the project's repository, with
        /// the worker sandbox (0013) and the shared context folder, idempotent on its
        /// client-generated run id. Gated on the `agents` capability, like every `agent/*`
        /// method.
        AgentStart = "agent/start": AgentStartParams => AgentRunResult;
        /// `agent/send`: a message to a run (0011): its next turn while it runs, or a resumed
        /// session once it has ended. Idempotent on the message's client-generated turn id.
        AgentSend = "agent/send": AgentSendParams => AgentRunResult;
        /// `agent/cancel`: stops a running agent. Does nothing to a run that isn't running.
        AgentCancel = "agent/cancel": AgentCancelParams => AgentRunResult;
        /// `agent/list`: every run, or one project's, and the event log's `seq` from before the
        /// read.
        AgentList = "agent/list": AgentListParams => AgentListResult;
        /// `agent/events`: one run's events from plxd's log, a page at a time.
        AgentEvents = "agent/events": AgentEventsParams => AgentEventsResult;
        /// `agent/image`: an image sent with one of a run's messages, by an id from its
        /// `turnStarted`. Gated on the `promptImages` capability.
        AgentImage = "agent/image": AgentImageParams => PromptImage;
        /// `agent/attach`: keeps a page or recording a run's browser tools made with its images,
        /// for `agent/image` (PLX-639). `plxd mcp` calls it for `html_render`.
        AgentAttach = "agent/attach": AgentAttachParams => AgentAttachResult;
        /// `preview/call`: one of a thread's `preview_*` browser tools (PLX-639), which its
        /// `plxd mcp` sends here.
        PreviewCall = "preview/call": PreviewCallParams => PreviewCallResult;
        /// `preview/list`: a thread's browser tabs.
        PreviewList = "preview/list": PreviewListParams => PreviewListResult;
        /// `preview/frame`: a tab's newest frame, waiting up to 10 s for a new one.
        PreviewFrame = "preview/frame": PreviewFrameParams => PreviewFrameResult;
        /// `preview/input`: the user's control, mouse, wheel, keys, viewport, or address bar on a
        /// tab.
        PreviewInputSend = "preview/input": PreviewInputParams => PreviewInputResult;
        /// `device/state`: what the host can run, its simulators and emulators, the device hub,
        /// and the devices a thread's agent opened (PLX-886). Gated on the `devices` capability,
        /// like every `device/*` method.
        DeviceState = "device/state": DeviceStateParams => DeviceStateResult;
        /// `device/setup`: starts installing the device hub plxd pins, and answers at once.
        /// `device/state` reports it installing, then installed or why it failed.
        DeviceSetup = "device/setup": DeviceSetupParams => DeviceOkResult;
        /// `device/boot`: starts a simulator or emulator and answers once it has booted.
        DeviceBoot = "device/boot": DeviceTarget => DeviceResult;
        /// `device/shutdown`: powers a simulator or emulator off.
        DeviceShutdown = "device/shutdown": DeviceTarget => DeviceOkResult;
        /// `device/create`: makes an iPhone Simulator on the newest iOS runtime.
        DeviceCreate = "device/create": DeviceCreateParams => DeviceResult;
        /// `device/screenshot`: a PNG of a booted device's screen.
        DeviceScreenshot = "device/screenshot": DeviceTarget => DeviceScreenshotResult;
        /// `device/chrome`: a simulator's bezel and buttons as Xcode's Simulator draws them, from
        /// the host's Xcode, or none for a device it has no artwork for.
        DeviceChrome = "device/chrome": DeviceTarget => DeviceChromeResult;
        /// `device/stream`: opens a stream to a booted device through the device hub, starting it,
        /// and sends its messages to this connection as `device/data`, then `device/end`. Fails
        /// with `invalidParams` while the hub isn't installed.
        DeviceStream = "device/stream": DeviceStreamParams => DeviceStreamResult;
        /// `computer/ask`: whether a thread may use a desktop app with its `computer_*` tools
        /// (PLX-897, decision 0077), asking the user in its transcript when they haven't always
        /// allowed it. `plxd mcp` sends it. Gated on the `computerUse` capability, like every
        /// `computer/*` method.
        ComputerAsk = "computer/ask": ComputerAskParams => ComputerAskResult;
        /// `computer/status`: plxd's macOS permissions for computer use and the apps always
        /// allowed, after asking macOS for the missing permissions with `request`.
        ComputerStatusGet = "computer/status": ComputerStatusParams => ComputerStatus;
        /// `computer/forget`: stops always allowing an app.
        ComputerForget = "computer/forget": ComputerForgetParams => ComputerStatus;
        /// `agent/diff`: the files that differ between a run's base and its latest commit, each
        /// with its stats and a size-capped unified diff (#157). Gated on the `agentReview`
        /// capability, like every review method.
        AgentDiff = "agent/diff": AgentDiffParams => AgentDiffResult;
        /// `agent/file`: one file of a run's diff, on its base or head side, base64-encoded and
        /// size-capped, for a diff editor. Its `working` side, behind the `files` capability,
        /// reads the file on disk now, and behind `fileChunks` (decision 0074), one slice of it.
        AgentFile = "agent/file": AgentFileParams => AgentFileResult;
        /// `agent/files`: one folder of a run's worktree, or a Current checkout thread's
        /// checkout, without `.git` or what git ignores, for browsing (PLX-296). Gated on the
        /// `files` capability.
        AgentFiles = "agent/files": AgentFilesParams => AgentFilesResult;
        /// `agent/fileCreate`: a new empty file or folder in a run's folder (PLX-590). Gated on
        /// the `fileEdit` capability, like `agent/fileRename` and `agent/fileDelete`.
        AgentFileCreate = "agent/fileCreate": AgentFileCreateParams => AgentFileEditResult;
        /// `agent/fileRename`: moves an entry of a run's folder, never over another.
        AgentFileRename = "agent/fileRename": AgentFileRenameParams => AgentFileEditResult;
        /// `agent/fileDelete`: removes an entry of a run's folder, a folder with its contents.
        AgentFileDelete = "agent/fileDelete": AgentFileDeleteParams => AgentFileEditResult;
        /// `agent/accept`: merges a run's commit into the project repository's current branch on
        /// the host, fast-forward when possible, then removes its worktree and branch. Never
        /// pushes. Idempotent on its client-generated id.
        AgentAccept = "agent/accept": AgentAcceptParams => AgentAcceptResult;
        /// `agent/requestChanges`: the reviewer's follow-up to a run, sent as `agent/send` sends
        /// a message. Idempotent on its client-generated turn id.
        AgentRequestChanges = "agent/requestChanges": AgentRequestChangesParams => AgentRunResult;
        /// `agent/openPr`: pushes a finished run's branch to the repository's `origin` and opens
        /// a pull request for it with `gh`, or finds the one already open (PLX-168). Gated on the
        /// `openPr` capability.
        AgentOpenPr = "agent/openPr": AgentOpenPrParams => AgentOpenPrResult;
        /// `agent/gitStatus`: the git state of a run's folder (PLX-298). Gated on the `git`
        /// capability, like `agent/commit` and `agent/push`.
        AgentGitStatus = "agent/gitStatus": AgentGitStatusParams => GitStatus;
        /// `repo/gitStatus`: read-only checkout status, gated on `repoGitStatus`.
        RepoGitStatus = "repo/gitStatus": RepoGitStatusParams => GitStatus;
        /// `agent/commit`: stages everything in a finished run's folder and commits it.
        AgentCommit = "agent/commit": AgentCommitParams => GitStatus;
        /// `agent/push`: pushes a finished run's branch to `origin`, setting its upstream.
        AgentPush = "agent/push": AgentPushParams => GitStatus;
        /// `agent/approve`: answers a run's permission request, from its `approvalRequested`
        /// item, by allowing or denying the tool call (PLX-222, decision 0031). Idempotent on the
        /// request. Gated on the `approvals` capability.
        AgentApprove = "agent/approve": AgentApproveParams => AgentApproveResult;
        /// `thread/list`: every repo entry and normal thread, and the event log's `seq` from before
        /// the read (#110). Gated on the `threads` capability, like every `thread/*` and `repo/*` method.
        ThreadList = "thread/list": ThreadListParams => ThreadListResult;
        /// `repo/add`: registers a repository on the host for normal threads, idempotent on its
        /// client-generated id and on its path.
        RepoAdd = "repo/add": RepoAddParams => RepoAddResult;
        /// `repo/clone`: clones a repository onto the host and registers it (PLX-905). Gated on
        /// the `repoClone` capability, like `repo/cloneProgress` and `repo/remote`.
        RepoClone = "repo/clone": RepoCloneParams => RepoAddResult;
        /// `repo/cloneProgress`: git's latest progress line for a `repo/clone` under way.
        RepoCloneProgress = "repo/cloneProgress": RepoCloneProgressParams => RepoCloneProgressResult;
        /// `repo/remote`: the URL of a repo entry's `origin` remote, for cloning it elsewhere.
        RepoRemote = "repo/remote": RepoRemoteParams => RepoRemoteResult;
        /// `repo/match`: the repo entry whose `origin` names the same repository as another
        /// plxd's (0057). Not behind a capability of its own: a plxd without it answers
        /// `methodNotFound`.
        RepoMatch = "repo/match": RepoMatchParams => RepoMatchResult;
        /// `thread/start`: starts a normal thread's agent in a worktree of a repo entry, or in a
        /// scratch repository of its own when no repo is given. Idempotent on its
        /// client-generated run id.
        ThreadStart = "thread/start": ThreadStartParams => ThreadStartResult;
        /// `thread/fork`: a new thread that continues a thread's conversation from one of its
        /// turns, in a workspace of the same kind (0050). Idempotent on its client-generated
        /// run id. Gated on the `threadFork` capability.
        ThreadFork = "thread/fork": ThreadForkParams => ThreadStartResult;
        /// `thread/importable`: the past sessions the Claude, Codex, and Cursor desktop apps
        /// keep on the host (PLX-881). Gated on the `threadImport` capability.
        ThreadImportable = "thread/importable": ThreadImportableParams => ThreadImportableResult;
        /// `thread/import`: makes one of those sessions a thread, at rest with its
        /// conversation. Idempotent on the session. Gated on the `threadImport` capability.
        ThreadImport = "thread/import": ThreadImportParams => ThreadStartResult;
        /// `thread/importChat`: makes a chat from a `ChatGPT` or `claude.ai` data export an archived
        /// thread (PLX-883). Idempotent on the chat. Gated on the `chatImport` capability.
        ThreadImportChat = "thread/importChat": ThreadImportChatParams => ThreadStartResult;
        /// `thread/importedChats`: which exported chats are imported. Gated on `chatImport`.
        ThreadImportedChats = "thread/importedChats": ThreadImportedChatsParams => ThreadImportedChatsResult;
        /// `thread/archive`: archives a normal thread or brings it back.
        ThreadArchive = "thread/archive": ThreadArchiveParams => ThreadArchiveResult;
        /// `thread/update`: marks a normal thread seen or snoozes it (0033), gated on the
        /// `threadAttention` capability, or sets its title or settled flag (0041), gated on
        /// `threadLineage`.
        ThreadUpdate = "thread/update": ThreadUpdateParams => ThreadUpdateResult;
        /// `repo/update`: sets a repo entry's icon (0033). Gated on the `threadAttention`
        /// capability.
        RepoUpdate = "repo/update": RepoUpdateParams => RepoUpdateResult;
        /// `space/create`: makes a Space, a named group for chats with no repository, backed by a
        /// repository plxd makes (0069). Idempotent on its client-generated id. Gated on the
        /// `spaces` capability.
        SpaceCreate = "space/create": SpaceCreateParams => SpaceCreateResult;
        /// `space/delete`: deletes a Space and the chats in it (0069). Gated on the `spaces`
        /// capability.
        SpaceDelete = "space/delete": SpaceDeleteParams => SpaceDeleteResult;
        /// `area/create`: makes an area, a hand-picked list of threads and Projects (PLX-789).
        /// Idempotent on its client-generated id. Gated on the `areas` capability.
        AreaCreate = "area/create": AreaCreateParams => AreaResult;
        /// `area/update`: renames an area, recolors it, or replaces its members (PLX-789). Gated
        /// on the `areas` capability.
        AreaUpdate = "area/update": AreaUpdateParams => AreaResult;
        /// `area/delete`: deletes an area, leaving its threads and Projects where they are
        /// (PLX-789). Gated on the `areas` capability.
        AreaDelete = "area/delete": AreaDeleteParams => AreaDeleteResult;
        /// `thread/delete`: deletes a normal thread with its run, worktree, and stored events,
        /// stopping its CLI first if it runs.
        ThreadDelete = "thread/delete": ThreadDeleteParams => ThreadDeleteResult;
        /// `project/start`: starts a project's coordinator chat, a no-write run in its repository
        /// with plxd's coordinator tools (0024), idempotent on its client-generated run id. It
        /// replaces the project's last coordinator unless that one is running. Gated on the
        /// `coordinator` capability.
        ProjectStart = "project/start": ProjectStartParams => AgentRunResult;
        /// `coordinator/fresh`: ends a Project's coordinator session, so its next message starts
        /// a new one from the Project's state (PLX-937, 0079). Gated on the `coordinatorEpochs`
        /// capability.
        CoordinatorFresh = "coordinator/fresh": CoordinatorFreshParams => AgentRunResult;
        /// `project/update`: renames a project or sets its icon, and leaves its `updatedAt` as
        /// it is (0032). Fails with `projectNotFound` for an unknown project. Gated on the
        /// `projectEdit` capability, like `Project.icon`.
        ProjectUpdate = "project/update": ProjectUpdateParams => ProjectUpdateResult;
        /// `repo/refs`: a repo entry's local and remote-tracking branches, for picking the ref a
        /// thread starts from. Gated on the `repoRefs` capability.
        RepoRefs = "repo/refs": RepoRefsParams => RepoRefsResult;
        /// `pr/view`: one of a run's linked pull requests as GitHub has it now, read with `gh`
        /// (PLX-318). Gated on the `pullRequests` capability, like `pr/act`.
        PrView = "pr/view": PrViewParams => PullRequest;
        /// `pr/act`: merges, squashes, sets auto-merge on or off, drafts, readies, or closes one
        /// of a run's linked pull requests with `gh`, and returns it as it is after.
        PrAct = "pr/act": PrActParams => PullRequest;
        /// `pr/diff`: one of a run's linked pull requests' unified diff, read with `gh pr diff`
        /// and cut at a size cap (PLX-328). Gated on the `prDiff` capability.
        PrDiff = "pr/diff": PrViewParams => PrDiffResult;
        /// `pr/link`: links a GitHub pull request URL to a run, unless it already is, and reports
        /// the run as `agent.updated` (0041). Fails with `invalidParams` for another URL. Gated
        /// on the `threadTools` capability, like `pr/unlink`.
        PrLink = "pr/link": PrViewParams => AgentRunResult;
        /// `pr/unlink`: removes a pull request URL from a run's links. Unlinking one that isn't
        /// linked changes nothing.
        PrUnlink = "pr/unlink": PrViewParams => AgentRunResult;
        /// `project/delete`: deletes a project with every run in it, stopping their CLIs first
        /// (PLX-338). Fails with `projectNotFound` for an unknown project or a repo entry's id.
        /// Gated on the `projectDelete` capability.
        ProjectDelete = "project/delete": ProjectDeleteParams => ProjectDeleteResult;
        /// `agent/commands`: a CLI's own slash commands and skills, for the composer's `/` menu
        /// (PLX-359). Gated on the `composerMenus` capability, like `repo/files`.
        AgentCommands = "agent/commands": AgentCommandsParams => AgentCommandsResult;
        /// `repo/files`: a thread's files that git tracks or doesn't ignore, capped, for the
        /// composer's `@` menu.
        RepoFiles = "repo/files": RepoFilesParams => RepoFilesResult;
        /// `repo/grep`: the lines of a thread's files that contain a query, for the command
        /// menu's Search project contents (PLX-993). Gated on the `repoGrep` capability.
        RepoGrep = "repo/grep": RepoGrepParams => RepoGrepResult;
        /// `github/status`: the GitHub CLI (`gh`) on the host, whether it is signed in to
        /// github.com, and as whom (PLX-336). Read-only and never prompts. Gated on the
        /// `githubStatus` capability.
        GithubStatusGet = "github/status": GithubStatusParams => GithubStatus;
        /// `thread/search`: the host's threads whose title or messages match a query, title
        /// matches first, then the one with the newest message (PLX-372, PLX-487). Gated on the
        /// `threadContext` capability.
        ThreadSearch = "thread/search": ThreadSearchParams => ThreadSearchResult;
        /// `agent/resumeNow`: resumes a run waiting for its usage limit to reset now (PLX-371,
        /// decision 0049). Gated on the `autoResume` capability, like `agent/autoResume` and
        /// `host/settings/*`.
        AgentResumeNow = "agent/resumeNow": AgentResumeNowParams => AgentRunResult;
        /// `agent/stopTask` (PLX-777): stops one of a live run's background tasks, such as a
        /// Monitor, through the CLI. Fails with `invalidParams` when the run has no live CLI or
        /// its backend can't stop one.
        AgentStopTask = "agent/stopTask": AgentStopTaskParams => AgentStopTaskResult;
        /// `agent/autoResume`: sets or clears a run's auto-resume override.
        AgentAutoResume = "agent/autoResume": AgentAutoResumeParams => AgentRunResult;
        /// `host/settings/get`: this host's settings.
        HostSettingsGet = "host/settings/get": HostSettingsGetParams => HostSettings;
        /// `host/settings/set`: changes this host's settings and returns them.
        HostSettingsSet = "host/settings/set": HostSettingsSetParams => HostSettings;
        /// `connect/devices`: this node and the tailnet's other nodes of its Tailscale user, and
        /// whether plxd answers on each (decision 0056). Gated on the `connect` capability.
        ConnectDevices = "connect/devices": ConnectDevicesParams => ConnectDevicesResult;
        /// `remote/pair`: a new one-time pairing code, which replaces any earlier one (PLX-641,
        /// 0065). Gated on the `remote` capability, like `remote/sessions` and `remote/revoke`.
        RemotePair = "remote/pair": RemotePairParams => RemotePairResult;
        /// `remote/sessions`: the paired clients' sessions.
        RemoteSessions = "remote/sessions": RemoteSessionsParams => RemoteSessionsResult;
        /// `remote/revoke`: ends a session and closes its connections. An unknown id changes
        /// nothing.
        RemoteRevoke = "remote/revoke": RemoteRevokeParams => RemoteSessionsResult;
        /// `relay/register`: registers this host with Parallax Relay under the user of a Clerk
        /// session token, signed with the host key (PLX-652, 0068). Gated on the `relay`
        /// capability.
        RelayRegister = "relay/register": RelayRegisterParams => RemoteSessionsResult;
        /// `relay/hosts`: the hosts the signed-in user has on Parallax Relay (PLX-652, 0068).
        RelayHosts = "relay/hosts": RelayHostsParams => RelayHostsResult;
        /// `relay/remove`: removes one of the user's hosts from the relay, freeing its place, and
        /// answers with the rest.
        RelayRemove = "relay/remove": RelayRemoveParams => RelayHostsResult;
        /// `inbox/list`: a Project's inbox, oldest first, and the event log's `seq` from before the
        /// read (PLX-401, 0043). Gated on the `inbox` capability, like `inbox/seen`.
        InboxList = "inbox/list": InboxListParams => InboxListResult;
        /// `inbox/seen`: marks items of a Project's inbox seen, and returns them as they stand.
        InboxSeen = "inbox/seen": InboxSeenParams => InboxSeenResult;
        /// `github/install`: starts installing `gh` into plxd's data folder, from the latest
        /// GitHub release, and answers at once with `installing` set (PLX-423, 0050). Refused
        /// with `githubSetupFailed` while a `gh` is found. Gated on the `githubSetup` capability,
        /// like `github/signIn` and `github/signInCancel`.
        GithubInstall = "github/install": GithubInstallParams => GithubStatus;
        /// `github/signIn`: starts `gh auth login --web` and answers with its one-time code, or
        /// the pending sign-in's. `github/status` reports it until it ends.
        GithubSignInStart = "github/signIn": GithubSignInParams => GithubSignIn;
        /// `github/signInCancel`: stops a pending sign-in, if there is one.
        GithubSignInCancel = "github/signInCancel": GithubSignInCancelParams => GithubSignInCancelResult;
        /// `queue/list`: a run's waiting messages, first to be sent first (PLX-370). Gated on
        /// the `queue` capability, like every `queue/*` method.
        QueueList = "queue/list": QueueListParams => QueueResult;
        /// `queue/edit`: replaces a waiting message's text.
        QueueEdit = "queue/edit": QueueEditParams => QueueResult;
        /// `queue/reorder`: puts a run's waiting messages in a new order.
        QueueReorder = "queue/reorder": QueueReorderParams => QueueResult;
        /// `queue/cancel`: drops a waiting message, which is never sent.
        QueueCancel = "queue/cancel": QueueCancelParams => QueueResult;
        /// `queue/steer`: sends a waiting message into the turn running now.
        QueueSteer = "queue/steer": QueueSteerParams => QueueResult;
        /// `question/ask`: records a Project child's question and wakes its coordinator; the
        /// child goes on with its assumption (PLX-402, 0043). Gated on the `questions`
        /// capability, like every `question/*` method.
        QuestionAsk = "question/ask": QuestionAskParams => QuestionResult;
        /// `question/answer`: the coordinator's or the user's answer to a question.
        QuestionAnswer = "question/answer": QuestionAnswerParams => QuestionResult;
        /// `question/escalate`: the coordinator passes a question to the user.
        QuestionEscalate = "question/escalate": QuestionEscalateParams => QuestionResult;
        /// `question/list`: a Project's questions, oldest first.
        QuestionList = "question/list": QuestionListParams => QuestionListResult;
        /// `board/list`: a Project's status board items, oldest first (PLX-940). Gated on the
        /// `board` capability.
        BoardList = "board/list": BoardListParams => BoardListResult;
        /// `board/add`: adds an item to a Project's status board and renders `notes.md`
        /// (PLX-940). Gated on the `board` capability.
        BoardAdd = "board/add": BoardAddParams => BoardItemResult;
        /// `board/update`: changes one board item (PLX-940). Gated on the `board` capability.
        BoardUpdate = "board/update": BoardUpdateParams => BoardItemResult;
        /// `board/remove`: removes one board item (PLX-940). Gated on the `board` capability.
        BoardRemove = "board/remove": BoardRemoveParams => BoardRemoveResult;
        /// `memory/list`: a scope's brief, memory entries, knowledge, and proposals, with each
        /// entry's header (PLX-405, 0044). Gated on the `memory` capability, like every
        /// `memory/*` method.
        MemoryList = "memory/list": MemoryListParams => MemoryListResult;
        /// `memory/read`: one memory file's header and body.
        MemoryRead = "memory/read": MemoryReadParams => MemoryReadResult;
        /// `memory/write`: writes the brief, knowledge, or an entry, as the user or a coordinator.
        MemoryWrite = "memory/write": MemoryWriteParams => MemoryWriteResult;
        /// `memory/delete`: deletes a memory file.
        MemoryDelete = "memory/delete": MemoryDeleteParams => MemoryDeleteResult;
        /// `memory/propose`: a thread proposes an entry, for its coordinator or the user.
        MemoryPropose = "memory/propose": MemoryProposeParams => MemoryProposeResult;
        /// `memory/syncList`: every version plxd has recorded in You, for another of the user's
        /// plxds to pull (0082). Gated on the `youSync` capability, like `memory/syncRead`.
        MemorySyncList = "memory/syncList": MemorySyncListParams => MemorySyncListResult;
        /// `memory/syncRead`: the text that syncs of one You entry or knowledge file.
        MemorySyncRead = "memory/syncRead": MemorySyncReadParams => MemorySyncReadResult;
        /// `land/queue`: queues a Project's finished child to land on its integration branch, as
        /// the coordinator's `land` tool does (PLX-410, 0045). Gated on the `landing` capability,
        /// like every `land/*` method.
        LandQueue = "land/queue": LandQueueParams => LandResult;
        /// `land/approve`: lands a child waiting for the user's approval, in its turn.
        LandApprove = "land/approve": LandApproveParams => LandResult;
        /// `land/sendBack`: sends a child waiting for approval the user's message instead.
        LandSendBack = "land/sendBack": LandSendBackParams => LandResult;
        /// `agent/wait`: waits until any or all of up to 50 runs are idle, or for at most 60 s,
        /// without polling (PLX-451). Gated on the `agentWait` capability.
        AgentWait = "agent/wait": AgentWaitParams => AgentWaitResult;
        /// `project/fromThreads`: makes a Project from threads on one repo entry, each with its
        /// own worktree, starts its coordinator, and makes each thread its child (0042).
        /// Idempotent on its client-generated ids. Gated on the `projectFromThreads` capability.
        ProjectFromThreads = "project/fromThreads": ProjectFromThreadsParams => ProjectFromThreadsResult;
        /// `cursor/signIn`: starts a Cursor account login in the browser and answers with its
        /// URL (0053). The app opens it. `providers/list` reports the instance signed in once
        /// the browser login finishes. Gated on the `providers` capability, like
        /// `cursor/signInCancel` and `cursor/signOut`.
        CursorSignIn = "cursor/signIn": CursorSignInParams => CursorSignInResult;
        /// `cursor/signInCancel`: stops a Cursor login that is still waiting on the browser.
        CursorSignInCancel = "cursor/signInCancel": CursorSignInCancelParams => CursorSignInCancelResult;
        /// `cursor/signOut`: forgets the Cursor SDK login stored for the instance.
        CursorSignOut = "cursor/signOut": CursorSignOutParams => CursorSignOutResult;
        /// `cursor/install`: starts installing the Cursor SDK the sidecar pins into plxd's data
        /// folder with npm, and answers at once (0053). `providers/list` reports Cursor
        /// `installing` until it's done, then installed, or why it failed in its `note`.
        CursorInstall = "cursor/install": CursorInstallParams => CursorInstallResult;
        /// `terminal/open`: starts a terminal, or attaches to the running one with its thread and
        /// id, resized, and streams what it prints to this connection as `terminal/output`,
        /// starting with its kept output, then `terminal/exit`, until `terminal/detach` (PLX-637). Gated on the
        /// `terminals` capability, like every `terminal/*` method.
        TerminalOpen = "terminal/open": TerminalOpenParams => TerminalResult;
        /// `terminal/close`: ends a terminal, killing what runs in it. Closing one that isn't
        /// running changes nothing.
        TerminalClose = "terminal/close": TerminalKey => TerminalResult;
        /// `terminal/list`: the running terminals, or one thread's.
        TerminalList = "terminal/list": TerminalListParams => TerminalListResult;
        /// `schedule/list`: every scheduled task on the host (0063). Gated on the `schedules`
        /// capability, like every `schedule/*` method.
        ScheduleList = "schedule/list": ScheduleListParams => ScheduleListResult;
        /// `schedule/save`: creates a scheduled task, or with `id` replaces one, and returns it.
        /// Fails with `invalidParams` for a bad trigger or an unknown id.
        ScheduleSave = "schedule/save": ScheduleSaveParams => ScheduledTask;
        /// `schedule/delete`: deletes a scheduled task. An unknown id changes nothing.
        ScheduleDelete = "schedule/delete": ScheduleIdParams => ScheduleDeleteResult;
        /// `schedule/run`: fires a scheduled task now, paused or not, and returns it.
        ScheduleRun = "schedule/run": ScheduleIdParams => ScheduledTask;
        /// `pr/watch`: links a GitHub pull request URL to a run if it isn't, and watches it for
        /// the run (0063). Fails with `invalidParams` for a pull request that isn't open. Gated
        /// on the `prWatch` capability, like `pr/unwatch`, `pr/watches`, and `pr/status`.
        PrWatch = "pr/watch": PrViewParams => PrWatchResult;
        /// `pr/unwatch`: stops watching a pull request for a run. It stays linked.
        PrUnwatch = "pr/unwatch": PrViewParams => PrWatchResult;
        /// `pr/watches`: the run's watched pull requests.
        PrWatches = "pr/watches": PrWatchesParams => PrWatchesResult;
        /// `pr/status` (PLX-837): reads a GitHub pull request once and says whether it is ready
        /// to merge, and whether the run watches it. It needn't be linked.
        PrStatus = "pr/status": PrViewParams => PrStatusResult;
        /// `pr/failureLog` (PLX-1019): the error lines of each failed check's log on a GitHub
        /// pull request's head, each log read from GitHub once per head and job. Gated on
        /// `prWatch`.
        PrFailureLog = "pr/failureLog": PrFailureLogParams => PrFailureLogResult;
        /// `pr/uploadMedia` (PLX-1020): commits images and videos to the pull request's
        /// repository's `pr-media` branch, one upload at a time per host, and returns links pinned
        /// to the commit. Bytes uploaded to the repository before reuse their link.
        PrUploadMedia = "pr/uploadMedia": crate::PrUploadMediaParams => crate::PrUploadMediaResult;
        /// `repo/scripts`: a repo entry's setup and settle scripts, and those its `parallax.json`
        /// declares (PLX-650). Fails with `repoNotFound` for an unknown entry. Gated on the
        /// `setupScripts` capability, like `repo/saveScripts`.
        RepoScripts = "repo/scripts": RepoScriptsParams => RepoScriptsResult;
        /// `repo/saveScripts`: replaces a repo entry's scripts.
        RepoSaveScripts = "repo/saveScripts": RepoSaveScriptsParams => RepoScriptsResult;
        /// `task/delegate`: starts a thread in another thread's worktree, as a task it delegated
        /// or a top-level thread beside it (0063, PLX-648). Idempotent on `runId`. Gated on the
        /// `delegation` capability, like `task/status` and `thread/mergeBack`.
        TaskDelegate = "task/delegate": TaskDelegateParams => ThreadStartResult;
        /// `task/status`: a delegated task, after acknowledging its result or changing its wake.
        TaskStatus = "task/status": TaskStatusParams => DelegatedTask;
        /// `thread/mergeBack`: a fork's or child's new context goes with the next message of the
        /// thread it came from.
        ThreadMergeBack = "thread/mergeBack": ThreadMergeBackParams => ThreadMergeBackResult;
        /// `secret/request`: asks the user for a secret through the app, or keeps waiting on a
        /// request already made, and answers how it stands (`request_secret`, 0063). Refused
        /// with `keychainUnavailable` on a host with no keystore. Gated on the `secrets`
        /// capability, like `secret/answer`.
        SecretRequest = "secret/request": SecretRequestParams => SecretRequestResult;
        /// `secret/answer`: the user's answer to a secret request, or the agent giving up on it.
        SecretAnswer = "secret/answer": SecretAnswerParams => SecretAnswerResult;
        /// `orchestration/dispatch`: runs one command on a thread (0059, PLX-644), idempotent on
        /// its `commandId`. Gated on the `orchestration` capability, like every
        /// `orchestration/*` method.
        OrchestrationDispatch = "orchestration/dispatch": OrchestrationCommand => DispatchResult;
        /// `orchestration/subscribeShell`: the host's shell at a `seq`, then its shell events as
        /// `events/event` notifications, or with `afterSeq` the events after it when few enough
        /// are left to replay.
        OrchestrationSubscribeShell = "orchestration/subscribeShell": SubscribeShellParams => SubscribeShellResult;
        /// `orchestration/subscribeThread`: one thread at a `seq`, then its events, or with
        /// `afterSeq` the events after it when few enough are left to replay.
        OrchestrationSubscribeThread = "orchestration/subscribeThread": SubscribeThreadParams => SubscribeThreadResult;
        /// `orchestration/threadHistory`: a page of a thread's events before a `seq`.
        OrchestrationThreadHistory = "orchestration/threadHistory": ThreadHistoryParams => ThreadHistoryResult;
        /// `orchestration/threadRuns`: a thread's runs, each with its checkpoint (0062). Gated on
        /// the `checkpoints` capability, like `orchestration/getTurnDiff`,
        /// `orchestration/getFullThreadDiff`, and `checkpoint.rollback`.
        OrchestrationThreadRuns = "orchestration/threadRuns": ThreadRunsParams => ThreadRunsResult;
        /// `orchestration/getTurnDiff`: the diff between two of a thread's checkpoints. Fails
        /// with `invalidParams` for a range whose `to` checkpoint isn't `ready`, or `from` after
        /// `to`.
        OrchestrationGetTurnDiff = "orchestration/getTurnDiff": TurnDiffParams => TurnDiffResult;
        /// `orchestration/getFullThreadDiff`: the diff from a thread's start to a checkpoint.
        OrchestrationGetFullThreadDiff = "orchestration/getFullThreadDiff": FullThreadDiffParams => TurnDiffResult;
        /// `bundle/prepare`: bundles a run's branch, pinned to its tip, for the home plxd to read
        /// (0057). Gated on the `peerGit` capability, like every `bundle/*` method and
        /// `git/startMerge`. Fails with `bundleTooLarge` over 64 MiB.
        BundlePrepare = "bundle/prepare": BundlePrepareParams => BundlePrepareResult;
        /// `bundle/read`: a chunk of a bundle `bundle/prepare` made.
        BundleRead = "bundle/read": BundleReadParams => BundleReadResult;
        /// `bundle/drop`: removes a bundle file.
        BundleDrop = "bundle/drop": BundleDropParams => BundleOkResult;
        /// `bundle/begin`: opens a bundle file for the home plxd to write into a run's repository.
        /// Fails with `bundleTooLarge` over 64 MiB.
        BundleBegin = "bundle/begin": BundleBeginParams => BundleBeginResult;
        /// `bundle/write`: appends a chunk to a bundle `bundle/begin` opened.
        BundleWrite = "bundle/write": BundleWriteParams => BundleOkResult;
        /// `bundle/apply`: checks a written bundle and fetches it into `refs/parallax-sync/<run
        /// id>`. Fails with `bundleMissingCommits` when the repository lacks a commit it needs,
        /// and `bundleFailed` when its hash, its tip, or `git bundle verify` fails.
        BundleApply = "bundle/apply": BundleApplyParams => BundleOkResult;
        /// `git/startMerge`: starts a conflict merge in a run's worktree. Fails with `runBusy`
        /// while the run is starting or running.
        GitStartMerge = "git/startMerge": GitStartMergeParams => BundleOkResult;
    }
    notifications {
        /// `$/cancelRequest`: cancels a request, which still gets exactly one response. Either
        /// side may send it.
        CancelRequest = "$/cancelRequest": CancelRequestParams;
        /// `events/event`: one event for a subscription. plxd sends it.
        EventsEvent = "events/event": EventsEventParams;
        /// `events/resync`: plxd ended a subscription that fell behind, and the connection
        /// stays open. plxd sends it only to a client that declared `resyncNotice` (PLX-455).
        EventsResync = "events/resync": EventsResyncParams;
        /// `terminal/write`: input for a terminal, in the order sent. The client sends it.
        TerminalWrite = "terminal/write": TerminalWriteParams;
        /// `terminal/resize`: a terminal's new size. The client sends it.
        TerminalResize = "terminal/resize": TerminalResizeParams;
        /// `terminal/detach`: stops a terminal's stream to this connection, and leaves it running
        /// with its kept output (PLX-664). The client sends it once nothing shows the terminal. A
        /// terminal running a `command` ignores it, and still ends with its connection.
        TerminalDetach = "terminal/detach": TerminalKey;
        /// `terminal/output`: what a terminal printed. plxd sends it to each connection that
        /// opened the terminal and hasn't detached it.
        TerminalOutput = "terminal/output": TerminalOutputParams;
        /// `terminal/exit`: a terminal's program exited, and the terminal closed.
        TerminalExit = "terminal/exit": TerminalExitParams;
        /// `device/send`: a message on a device stream, in the order sent. The client sends it.
        DeviceSend = "device/send": DeviceDataParams;
        /// `device/close`: closes a device stream. The client sends it.
        DeviceClose = "device/close": DeviceCloseParams;
        /// `device/data`: a message on a device stream. plxd sends it.
        DeviceData = "device/data": DeviceDataParams;
        /// `device/end`: a device stream ended other than by `device/close`. plxd sends it.
        DeviceEnd = "device/end": DeviceEndParams;
    }
}
