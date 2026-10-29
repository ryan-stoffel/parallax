//! The protocol between the client and `plxd`, from decision record 0007.
//!
//! This crate is the single source of truth for it. The desktop app's TypeScript types are generated
//! from the types here (see [`typescript`]).
//!
//! - [`framing`]: newline-delimited JSON, one compact message per line, at most
//!   [`framing::MAX_FRAME_BYTES`] per line.
//! - [`jsonrpc`]: the JSON-RPC 2.0 envelope, and the error codes that malformed traffic gets.
//! - [`methods`]: the method table, which names every method with its params and result types.
//! - The crate root: the M1 messages, events, and Parallax errors.
//!
//! # Changing the protocol
//!
//! Changes must be additive: new methods, notifications, event kinds, optional fields, and enum
//! values keep [`PROTOCOL_VERSION`]. Receivers ignore anything unknown, and every enum that Rust
//! receives has a fallback variant for values it does not know.
//!
//! The committed samples in `samples/v<N>/`, one directory per protocol version, enforce this in
//! `cargo test`. Each file is one scenario: a JSON array of the messages on the wire, in order.
//!
//! - Samples are append-only. Never edit or delete one; add a new file instead.
//! - Every message must decode into its typed form and encode back to exactly the same JSON. So
//!   renaming, removing, or retyping a field fails a test, and a field added later has to be
//!   optional and left out when absent, which is what an older peer sends anyway.
//! - Files in `lenient/` hold messages from a newer peer, with fields, methods, and values this
//!   version does not know. They only have to decode.
//! - Together, the exact samples must use every method, error code, error kind, event kind, and
//!   store state, so a new one needs a sample.

#![warn(missing_docs)]

mod account;
mod agent;
mod approval;
mod board;
mod bundle;
mod cli_account;
mod composer;
mod computer;
mod connect;
mod context;
mod defaults;
mod delegation;
mod device;
mod error;
mod events;
pub mod framing;
mod git;
mod handshake;
mod host;
mod hub;
mod id;
mod import;
mod inbox;
pub mod jsonrpc;
mod land;
mod memory;
pub mod methods;
mod orchestration;
mod pr_media;
mod preview;
mod project;
mod provider;
mod pull_request;
mod question;
mod queue;
mod remote;
mod remote_control;
mod review;
mod schedule;
mod scripts;
mod terminal;
mod thread;
pub mod typescript;
mod usage;

#[cfg(test)]
mod samples;

pub use account::{
    AccountId, AccountsKeysAddParams, AccountsKeysAddResult, AccountsKeysListParams,
    AccountsKeysListResult, AccountsKeysRemoveParams, AccountsKeysRemoveResult, KeyAccount,
    Provider, RawKey,
};
pub use agent::{
    AgentAttachParams, AgentAttachResult, AgentAutoResumeParams, AgentBackgroundKind,
    AgentBackgroundTask, AgentCancelParams, AgentEffort, AgentEventsParams, AgentEventsResult,
    AgentFailureKind, AgentImageParams, AgentListParams, AgentListResult, AgentOutcome,
    AgentOutputItem, AgentPermission, AgentPolicy, AgentRequestUsage, AgentResumeNowParams,
    AgentRun, AgentRunResult, AgentRunState, AgentSendParams, AgentSetPermissionParams,
    AgentStartParams, AgentStatus, AgentStopTaskParams, AgentStopTaskResult, AgentSubagentStatus,
    AgentTodoItem, AgentTodoStatus, AgentToolStatus, AgentWaitParams, AgentWaitResult,
    AgentWaitUntil, CoordinatorSessionEnd, CoordinatorThreadId, DiffSummary, ImageId,
    ImageMediaType, LoggedEvent, PromptImage, RunId, SecretStatus, TurnId,
};
pub use approval::{
    AgentApprovalAnswer, AgentApprovalBy, AgentApprovalDecision, AgentApproveParams,
    AgentApproveResult, ApprovalId,
};
pub use board::{
    BoardAddParams, BoardItem, BoardItemResult, BoardLinks, BoardListParams, BoardListResult,
    BoardRemoveParams, BoardRemoveResult, BoardSection, BoardStatus, BoardUpdateParams,
};
pub use bundle::{
    BundleApplyParams, BundleBeginParams, BundleBeginResult, BundleDropParams, BundleFile,
    BundleId, BundleOkResult, BundlePrepareParams, BundlePrepareResult, BundleReadParams,
    BundleReadResult, BundleWriteParams, GitStartMergeParams,
};
pub use cli_account::{
    AccountsListParams, AccountsListResult, AccountsRefreshParams, AccountsRefreshResult, AuthKind,
    CliKind, DetectedCli, GithubInstallParams, GithubSignIn, GithubSignInCancelParams,
    GithubSignInCancelResult, GithubSignInParams, GithubStatus, GithubStatusParams,
};
pub use composer::{
    AgentCommand, AgentCommandsParams, AgentCommandsResult, GrepMatch, RepoFilesParams,
    RepoFilesResult, RepoGrepParams, RepoGrepResult,
};
pub use computer::{
    ComputerAnswer, ComputerAskParams, ComputerAskResult, ComputerForgetParams, ComputerStatus,
    ComputerStatusParams,
};
pub use connect::{
    CONNECT_PORT, ConnectDevicesParams, ConnectDevicesResult, DEVICE_ICONS, MAX_DEVICE_NAME_CHARS,
    TailnetDevice, TailscaleState,
};
pub use context::{
    ContextFile, ContextListParams, ContextListResult, ContextReadBytesParams,
    ContextReadBytesResult, ContextReadParams, ContextReadResult, ContextSaveArtifactParams,
    ContextWriteId, ContextWriteParams, ContextWriteResult,
};
pub use defaults::{
    AccountChoice, AccountsDefaultsGetParams, AccountsDefaultsGetResult, AccountsDefaultsSetParams,
    Role,
};
pub use delegation::{
    CompletionWake, DelegatedTask, SecretAnswerParams, SecretAnswerResult, SecretChoice,
    SecretRequestParams, SecretRequestResult, TaskDelegateParams, TaskDelivery, TaskStatusParams,
    ThreadMergeBackParams, ThreadMergeBackResult,
};
pub use device::{
    DeviceChrome, DeviceChromeLayer, DeviceChromeResult, DeviceCloseParams, DeviceCreateParams,
    DeviceDataParams, DeviceEndParams, DeviceHubState, DeviceInfo, DeviceOkResult, DevicePlatform,
    DevicePlatformState, DeviceRect, DeviceResult, DeviceScreenshotResult, DeviceSetupParams,
    DeviceStateParams, DeviceStateResult, DeviceStreamKind, DeviceStreamParams, DeviceStreamResult,
    DeviceTarget,
};
pub use error::{ErrorData, ErrorKind, IncompatibleProtocolDetail};
pub use events::{
    Compacted, EventsEventParams, EventsResyncParams, EventsSubscribeParams, EventsSubscribeResult,
    EventsUnsubscribeParams, EventsUnsubscribeResult, LogId, ParallaxEvent, SubscriptionId,
};
pub use git::{
    AgentCommitParams, AgentGitStatusParams, AgentPushParams, GitStatus, RepoGitStatusParams,
};
pub use handshake::{
    Capabilities, ClientInfo, InitializeParams, InitializeProtocol, InitializeResult, ProtocolRange,
};
pub use host::{
    HostFolder, HostFoldersParams, HostFoldersResult, HostHealthParams, HostHealthResult,
    HostQueues, HostReadUploadParams, HostReadUploadResult, HostSettings, HostSettingsGetParams,
    HostSettingsSetParams, HostUpdateParams, HostUpdateRestart, HostUpdateResult, HostUploadParams,
    HostUploadResult, HostVersionParams, HostVersionResult, QueueStats, StoreState, UploadId,
};
pub use hub::{
    Hub, HubAccount, HubAccountRemoveParams, HubAccountSetEnabledParams, HubService, HubSignIn,
    HubSignInCallbackParams, HubSignInParams, HubSignInState, HubSignInStateParams,
    HubSignInStatus, HubsListParams, HubsListResult, HubsRemoveParams, HubsSaveParams,
};
pub use id::InvalidId;
pub use import::{
    ChatMessage, ChatRef, ChatRole, ImportSource, ImportableSession, MAX_CHAT_MESSAGES,
    ThreadImportChatParams, ThreadImportParams, ThreadImportableParams, ThreadImportableResult,
    ThreadImportedChatsParams, ThreadImportedChatsResult,
};
pub use inbox::{
    InboxItem, InboxItemId, InboxKind, InboxListParams, InboxListResult, InboxSeenParams,
    InboxSeenResult,
};
pub use land::{
    LandApproveParams, LandQueueParams, LandResult, LandSendBackParams, Landing, LandingStatus,
};
pub use memory::{
    MemoryDeleteParams, MemoryDeleteResult, MemoryFile, MemoryKind, MemoryListParams,
    MemoryListResult, MemoryMachine, MemoryProposalTo, MemoryProposeParams, MemoryProposeResult,
    MemoryReadParams, MemoryReadResult, MemoryScope, MemoryScopeKind, MemorySyncEntry,
    MemorySyncListParams, MemorySyncListResult, MemorySyncReadParams, MemorySyncReadResult,
    MemoryWriteParams, MemoryWriteResult,
};
pub use orchestration::{
    CheckpointFile, CheckpointStatus, DispatchMode, DispatchResult, FullThreadDiffParams,
    MAX_REPLAY_BYTES, MAX_REPLAY_EVENTS, OrchestrationCommand, RunWaiting, ShellSnapshot,
    SubscribeShellParams, SubscribeShellResult, SubscribeThreadParams, SubscribeThreadResult,
    ThreadHistoryParams, ThreadHistoryResult, ThreadRun, ThreadRunStatus, ThreadRunsParams,
    ThreadRunsResult, ThreadSnapshot, TurnCheckpoint, TurnDiffParams, TurnDiffResult,
};
pub use pr_media::{PrMediaFile, PrMediaUploaded, PrUploadMediaParams, PrUploadMediaResult};
pub use preview::{
    PreviewCallParams, PreviewCallResult, PreviewFrameParams, PreviewFrameResult, PreviewInput,
    PreviewInputParams, PreviewInputResult, PreviewListParams, PreviewListResult, PreviewMouse,
    PreviewTab,
};
pub use project::{
    CoordinatorFreshParams, Project, ProjectAutonomy, ProjectCreateParams, ProjectCreateResult,
    ProjectDeleteParams, ProjectDeleteResult, ProjectFromThreadsParams, ProjectFromThreadsResult,
    ProjectIcon, ProjectId, ProjectListParams, ProjectListResult, ProjectPermission,
    ProjectStartParams, ProjectUpdateParams, ProjectUpdateResult,
};
pub use provider::{
    CursorInstallParams, CursorInstallResult, CursorSignInCancelParams, CursorSignInCancelResult,
    CursorSignInParams, CursorSignInResult, CursorSignOutParams, CursorSignOutResult,
    ProviderEnvVar, ProviderInfo, ProviderInstance, ProviderKind, ProviderModel, ProviderUpdate,
    ProvidersListParams, ProvidersListResult, ProvidersRemoveParams, ProvidersSaveParams,
    ProvidersUpdatesParams, ProvidersUpdatesResult, ProvidersUpgradeParams, ProvidersUpgradeResult,
};
pub use pull_request::{
    PrActParams, PrAction, PrCheck, PrCheckState, PrComment, PrCommit, PrDiffResult, PrFile,
    PrMergeMethod, PrMergeState, PrMergeWhenReadyParams, PrReview, PrReviewEvent, PrReviewState,
    PrState, PrViewParams, PrWrite, PrWriteParams, PrWriteResult, PullRequest,
};
pub use question::{
    Question, QuestionAnswerParams, QuestionAskParams, QuestionEscalateParams, QuestionId,
    QuestionListParams, QuestionListResult, QuestionResult, QuestionStatus,
};
pub use queue::{
    AgentDelivery, QueueCancelParams, QueueEditParams, QueueListParams, QueueReorderParams,
    QueueResult, QueueSteerParams, QueuedMessage,
};
pub use remote::{
    RelayHost, RelayHostsParams, RelayHostsResult, RelayRegisterParams, RelayRemoveParams,
    RelaySignParams, RelaySignResult, RelayStatus, RemotePairParams, RemotePairResult,
    RemoteRevokeParams, RemoteSession, RemoteSessionsParams, RemoteSessionsResult,
};
pub use remote_control::{
    RemoteControlOrigin, RemoteControlSession, RemoteControlState, ThreadRemoteControlOriginParams,
    ThreadRemoteControlOriginResult, ThreadRemoteControlParams, ThreadRemoteControlResult,
};
pub use review::{
    AcceptId, AgentAcceptParams, AgentAcceptResult, AgentDiffFile, AgentDiffParams,
    AgentDiffResult, AgentDiffStats, AgentEntry, AgentEntryKind, AgentFileCreateParams,
    AgentFileDeleteParams, AgentFileEditResult, AgentFileParams, AgentFileRenameParams,
    AgentFileResult, AgentFileSide, AgentFileStatus, AgentFilesParams, AgentFilesResult,
    AgentMerge, AgentMergeKind, AgentOpenPrParams, AgentOpenPrResult, AgentRequestChangesParams,
};
pub use schedule::{
    PrFailureLog, PrFailureLogParams, PrFailureLogResult, PrStatusCheck, PrStatusFile,
    PrStatusResult, PrStatusThread, PrWatchResult, PrWatchesParams, PrWatchesResult, Schedule,
    ScheduleDeleteResult, ScheduleIdParams, ScheduleListParams, ScheduleListResult,
    ScheduleRunStatus, ScheduleSaveParams, ScheduleWebhook, ScheduledTask, SignatureEncoding,
    WebhookSignature,
};
pub use scripts::{
    RepoSaveScriptsParams, RepoScript, RepoScriptsParams, RepoScriptsResult, ScriptStatus,
    ScriptTrigger,
};
pub use terminal::{
    TerminalCommand, TerminalExitParams, TerminalKey, TerminalListParams, TerminalListResult,
    TerminalOpenParams, TerminalOutputParams, TerminalResizeParams, TerminalResult,
    TerminalWriteParams,
};
pub use thread::{
    ForkedFrom, MAX_SPACE_FILES, MAX_SPACE_INSTRUCTIONS_BYTES, MAX_SPACE_NAME_BYTES,
    MAX_THREAD_TITLE_BYTES, Repo, RepoAddParams, RepoAddResult, RepoCloneParams,
    RepoCloneProgressParams, RepoCloneProgressResult, RepoId, RepoMatchParams, RepoMatchResult,
    RepoRef, RepoRefsParams, RepoRefsResult, RepoRemoteParams, RepoRemoteResult, RepoUpdateParams,
    RepoUpdateResult, SpaceCreateParams, SpaceCreateResult, SpaceDeleteParams, SpaceDeleteResult,
    Thread, ThreadArchiveParams, ThreadArchiveResult, ThreadDeleteParams, ThreadDeleteResult,
    ThreadForkParams, ThreadListParams, ThreadListResult, ThreadNaming, ThreadSearchParams,
    ThreadSearchResult, ThreadSetSpaceParams, ThreadSetSpaceResult, ThreadStartParams,
    ThreadStartResult, ThreadUpdateParams, ThreadUpdateResult,
};
pub use usage::{
    AccountLimits, AccountRuns, AccountUsage, UsageDailyParams, UsageDailyResult, UsageDay,
    UsageGetParams, UsageGetResult, UsageHistoryParams, UsageHistoryResult, UsageHour,
    UsageLimitWindow, UsageLimitsParams, UsageLimitsResult, UsagePeriod, UsageProblem,
    UsageSessions, UsageSource,
};

/// The newest protocol version this crate speaks. Versions start at 1.
///
/// Additive changes keep it. Removals, renames, and type changes bump it, and the previous
/// version stays supported for at least one release.
pub const PROTOCOL_VERSION: u32 = 1;
