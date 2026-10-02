// Generated from crates/parallax-protocol by `cargo run -p parallax-protocol --bin generate-typescript`. Do not edit.
//
// The messages of the protocol between clients and plxd (decision record 0007), without
// the JSON-RPC 2.0 envelope around them.

/** The newest protocol version these types describe. */
export const PROTOCOL_VERSION = 1;

/** The largest frame either side sends or accepts: 8 MiB, not counting the line ending. */
export const MAX_FRAME_BYTES = 8388608;

/** JSON-RPC error codes. A `ParallaxError`'s `data` is an `ErrorData`. */
export const ErrorCodes = {
	ParseError: -32700,
	InvalidRequest: -32600,
	MethodNotFound: -32601,
	InvalidParams: -32602,
	InternalError: -32603,
	ParallaxError: -32000,
	RequestCancelled: -32800,
} as const;

/** Requests, which the client sends and plxd answers, by method. */
export type ParallaxRequests = {
	/**
	 * `initialize`: the handshake. It must be the first request on a connection; plxd
	 * answers anything before it with `notInitialized`.
	 */
	"initialize": { params: InitializeParams, result: InitializeResult },
	/**
	 * `host/health`: uptime, store state, and running agents. The app sends it every
	 * 30 seconds and on wake, as a heartbeat.
	 */
	"host/health": { params: HostHealthParams, result: HostHealthResult },
	/**
	 * `host/version`: plxd's release and protocol versions, operating system, and CPU
	 * architecture.
	 */
	"host/version": { params: HostVersionParams, result: HostVersionResult },
	/**
	 * `project/list`: every project, and the `seq` the list reflects.
	 */
	"project/list": { params: ProjectListParams, result: ProjectListResult },
	/**
	 * `project/create`: creates a project, idempotent on its client-generated id.
	 */
	"project/create": { params: ProjectCreateParams, result: ProjectCreateResult },
	/**
	 * `events/subscribe`: replays the events after a `seq`, then streams new ones as
	 * `events/event` notifications.
	 */
	"events/subscribe": { params: EventsSubscribeParams, result: EventsSubscribeResult },
	/**
	 * `events/unsubscribe`: ends a subscription.
	 */
	"events/unsubscribe": { params: EventsUnsubscribeParams, result: EventsUnsubscribeResult },
	/**
	 * `accounts/keys/add`: stores an API key in the Keychain, idempotent on its
	 * client-generated id. The response returns only the key's masked form.
	 */
	"accounts/keys/add": { params: AccountsKeysAddParams, result: AccountsKeysAddResult },
	/**
	 * `accounts/keys/list`: every key account, with its key masked.
	 */
	"accounts/keys/list": { params: AccountsKeysListParams, result: AccountsKeysListResult },
	/**
	 * `accounts/keys/remove`: removes a key account's key from the Keychain, and its
	 * record. Fails with `accountNotFound` if the id does not exist.
	 */
	"accounts/keys/remove": { params: AccountsKeysRemoveParams, result: AccountsKeysRemoveResult },
	/**
	 * `accounts/list`: the vendor CLIs plxd detects (#114), installed, signed in, and their
	 * plan where exposed. May answer from a short-lived cache. Gated on the `agentClis`
	 * capability.
	 */
	"accounts/list": { params: AccountsListParams, result: AccountsListResult },
	/**
	 * `accounts/refresh`: like `accounts/list`, but always probes again instead of using the
	 * cache. Gated on the `agentClis` capability.
	 */
	"accounts/refresh": { params: AccountsRefreshParams, result: AccountsRefreshResult },
	/**
	 * `usage/get`: per-account tokens and cost for today and this week (local time on this
	 * host), and the latest limit windows.
	 */
	"usage/get": { params: UsageGetParams, result: UsageGetResult },
	/**
	 * `usage/history`: tokens and cost since a time, summed per UTC hour, account, and
	 * model, and each account's run count over the same range.
	 */
	"usage/history": { params: UsageHistoryParams, result: UsageHistoryResult },
	/**
	 * `accounts/defaults/get`: this host's default account for the coordinator role and for
	 * a worker role, absent where none is set (#119).
	 */
	"accounts/defaults/get": { params: AccountsDefaultsGetParams, result: AccountsDefaultsGetResult },
	/**
	 * `accounts/defaults/set`: sets or clears one role's default account, and returns both
	 * roles' defaults as they stand after the change.
	 */
	"accounts/defaults/set": { params: AccountsDefaultsSetParams, result: AccountsDefaultsGetResult },
	/**
	 * `context/list`: a project's shared context files (0005), each with its size, when it
	 * was last modified, and who last wrote it, if known.
	 */
	"context/list": { params: ContextListParams, result: ContextListResult },
	/**
	 * `context/read`: one shared context file's content. Fails with `contextNotFound` if it
	 * does not exist.
	 */
	"context/read": { params: ContextReadParams, result: ContextReadResult },
	/**
	 * `context/write`: writes a shared context file in full, idempotent on its
	 * client-generated id. The last write to a path wins when two race.
	 */
	"context/write": { params: ContextWriteParams, result: ContextWriteResult },
	/**
	 * `agent/start`: starts a worker in its own worktree of the project's repository, with
	 * the worker sandbox (0013) and the shared context folder, idempotent on its
	 * client-generated run id. Gated on the `agents` capability, like every `agent/*`
	 * method.
	 */
	"agent/start": { params: AgentStartParams, result: AgentRunResult },
	/**
	 * `agent/send`: a message to a run (0011): its next turn while it runs, or a resumed
	 * session once it has ended. Idempotent on the message's client-generated turn id.
	 */
	"agent/send": { params: AgentSendParams, result: AgentRunResult },
	/**
	 * `agent/cancel`: stops a running agent. Does nothing to a run that isn't running.
	 */
	"agent/cancel": { params: AgentCancelParams, result: AgentRunResult },
	/**
	 * `agent/list`: every run, or one project's, and the `seq` the list reflects.
	 */
	"agent/list": { params: AgentListParams, result: AgentListResult },
	/**
	 * `agent/events`: one run's events from plxd's log, a page at a time.
	 */
	"agent/events": { params: AgentEventsParams, result: AgentEventsResult },
	/**
	 * `agent/image`: an image sent with one of a run's messages, by an id from its
	 * `turnStarted`. Gated on the `promptImages` capability.
	 */
	"agent/image": { params: AgentImageParams, result: PromptImage },
	/**
	 * `agent/diff`: the files that differ between a run's base and its latest commit, each
	 * with its stats and a size-capped unified diff (#157). Gated on the `agentReview`
	 * capability, like every review method.
	 */
	"agent/diff": { params: AgentDiffParams, result: AgentDiffResult },
	/**
	 * `agent/file`: one file of a run's diff, on its base or head side, base64-encoded and
	 * size-capped, for a diff editor.
	 */
	"agent/file": { params: AgentFileParams, result: AgentFileResult },
	/**
	 * `agent/accept`: merges a run's commit into the project repository's current branch on
	 * the host, fast-forward when possible, then removes its worktree and branch. Never
	 * pushes. Idempotent on its client-generated id.
	 */
	"agent/accept": { params: AgentAcceptParams, result: AgentAcceptResult },
	/**
	 * `agent/requestChanges`: the reviewer's follow-up to a run, sent as `agent/send` sends
	 * a message. Idempotent on its client-generated turn id.
	 */
	"agent/requestChanges": { params: AgentRequestChangesParams, result: AgentRunResult },
	/**
	 * `agent/openPr`: pushes a finished run's branch to the repository's `origin` and opens
	 * a pull request for it with `gh`, or finds the one already open (RYA-168). Gated on the
	 * `openPr` capability.
	 */
	"agent/openPr": { params: AgentOpenPrParams, result: AgentOpenPrResult },
	/**
	 * `agent/approve`: answers a run's permission request, from its `approvalRequested`
	 * item, by allowing or denying the tool call (RYA-222, decision 0031). Idempotent on the
	 * request. Gated on the `approvals` capability.
	 */
	"agent/approve": { params: AgentApproveParams, result: AgentApproveResult },
	/**
	 * `thread/list`: every repo entry and normal thread, and the `seq` the list reflects
	 * (#110). Gated on the `threads` capability, like every `thread/*` and `repo/*` method.
	 */
	"thread/list": { params: ThreadListParams, result: ThreadListResult },
	/**
	 * `repo/add`: registers a repository on the host for normal threads, idempotent on its
	 * client-generated id and on its path.
	 */
	"repo/add": { params: RepoAddParams, result: RepoAddResult },
	/**
	 * `thread/start`: starts a normal thread's agent in a worktree of a repo entry, or in a
	 * scratch repository of its own when no repo is given. Idempotent on its
	 * client-generated run id.
	 */
	"thread/start": { params: ThreadStartParams, result: ThreadStartResult },
	/**
	 * `thread/archive`: archives a normal thread or brings it back.
	 */
	"thread/archive": { params: ThreadArchiveParams, result: ThreadArchiveResult },
	/**
	 * `thread/update`: marks a normal thread seen or snoozes it (0033). Gated on the
	 * `threadAttention` capability.
	 */
	"thread/update": { params: ThreadUpdateParams, result: ThreadUpdateResult },
	/**
	 * `repo/update`: sets a repo entry's icon (0033). Gated on the `threadAttention`
	 * capability.
	 */
	"repo/update": { params: RepoUpdateParams, result: RepoUpdateResult },
	/**
	 * `thread/delete`: deletes a normal thread with its run, worktree, and stored events,
	 * stopping its CLI first if it runs.
	 */
	"thread/delete": { params: ThreadDeleteParams, result: ThreadDeleteResult },
	/**
	 * `project/start`: starts a project's coordinator chat, a no-write run in its repository
	 * with plxd's coordinator tools (0024), idempotent on its client-generated run id. It
	 * replaces the project's last coordinator unless that one is running. Gated on the
	 * `coordinator` capability.
	 */
	"project/start": { params: ProjectStartParams, result: AgentRunResult },
	/**
	 * `project/update`: renames a project or sets its icon, and leaves its `updatedAt` as
	 * it is (0032). Fails with `projectNotFound` for an unknown project. Gated on the
	 * `projectEdit` capability, like `Project.icon`.
	 */
	"project/update": { params: ProjectUpdateParams, result: ProjectUpdateResult },
};

/** Notifications, which get no response, by method. */
export type ParallaxNotifications = {
	/**
	 * `$/cancelRequest`: cancels a request, which still gets exactly one response. Either
	 * side may send it.
	 */
	"$/cancelRequest": CancelRequestParams,
	/**
	 * `events/event`: one event for a subscription. plxd sends it.
	 */
	"events/event": EventsEventParams,
};

/**
 * Params of `initialize`, the first request on every connection.
 *
 * `protocol` and `capabilities` never change shape. To answer `incompatibleProtocol` even to a
 * client whose other params changed, decode `InitializeProtocol` before these.
 */
export type InitializeParams = {
	/**
	 * The protocol versions the client speaks.
	 */
	protocol: ProtocolRange,
	/**
	 * Who is connecting.
	 */
	client: ClientInfo,
	/**
	 * What the client supports.
	 */
	capabilities: Capabilities,
};

/**
 * Capabilities by name, such as `{"agents": {}}`. Each value holds that capability's options,
 * and is empty when it has none. The map never changes shape.
 *
 * Later features are gated on a capability, so a newer client still works with an older plxd.
 */
export type Capabilities = { [key in string]: { [key in string]: JsonValue } };

export type JsonValue = number | string | boolean | Array<JsonValue> | { [key in string]: JsonValue } | null;

/**
 * The client that sent `initialize`.
 */
export type ClientInfo = {
	/**
	 * The client's name, such as `parallax` for the desktop app.
	 */
	name: string,
	/**
	 * The client's release version.
	 */
	version: string,
	/**
	 * Tells apart the machines of one user, for the local runner (M5).
	 */
	machineId?: string,
};

/**
 * A range of protocol versions, both ends included. Its shape never changes.
 */
export type ProtocolRange = {
	/**
	 * The oldest version.
	 */
	min: number,
	/**
	 * The newest version.
	 */
	max: number,
};

/**
 * Result of `initialize`.
 */
export type InitializeResult = {
	/**
	 * The protocol version the connection speaks: the newest in both ranges.
	 */
	protocol: number,
	/**
	 * plxd's release version.
	 */
	plxd: string,
	/**
	 * Identifies plxd's event log. It changes only when the log starts over, and then every
	 * `seq` the client holds is meaningless.
	 */
	logId: LogId,
	/**
	 * What plxd supports.
	 */
	capabilities: Capabilities,
	/**
	 * The largest frame plxd accepts, in bytes, not counting the line ending.
	 */
	maxFrameBytes: number,
};

/**
 * Identifies plxd's event log. It changes only when the log starts over.
 */
export type LogId = string;

/**
 * Params of `host/health`.
 */
export type HostHealthParams = Record<symbol, never>;

/**
 * Result of `host/health`.
 */
export type HostHealthResult = {
	/**
	 * Seconds since plxd started.
	 */
	uptimeSeconds: number,
	/**
	 * Whether plxd can read and write its project store.
	 */
	store: StoreState,
	/**
	 * Agents running on this host. Always 0 before M3.
	 */
	runningAgents: number,
};

/**
 * The state of plxd's project store.
 *
 * A newer plxd may send states that are not listed here. Treat those as unknown, so a `switch`
 * over this type must not end in an exhaustiveness assertion.
 */
export type StoreState = "ok" | "unavailable";

/**
 * Params of `host/version`.
 */
export type HostVersionParams = Record<symbol, never>;

/**
 * Result of `host/version`.
 */
export type HostVersionResult = {
	/**
	 * plxd's release version.
	 */
	plxd: string,
	/**
	 * The protocol versions plxd speaks.
	 */
	protocol: ProtocolRange,
	/**
	 * The operating system and its version, such as `macOS 27.0`.
	 */
	os: string,
	/**
	 * The CPU architecture, such as `aarch64`.
	 */
	arch: string,
};

/**
 * Params of `project/list`.
 */
export type ProjectListParams = Record<symbol, never>;

/**
 * Result of `project/list`: a snapshot of every project.
 */
export type ProjectListResult = {
	/**
	 * Every project, oldest first.
	 */
	projects: Array<Project>,
	/**
	 * The `seq` of the last event the snapshot reflects. Subscribe with `after` set to it.
	 */
	seq: number,
};

/**
 * A project: a body of work on one repository, run by this plxd.
 */
export type Project = {
	/**
	 * The id the client chose when it created the project.
	 */
	id: ProjectId,
	/**
	 * The name shown in the app.
	 */
	name: string,
	/**
	 * The icon the user chose, behind the `projectEdit` capability (RYA-227, 0032). Absent means
	 * the app's default icon.
	 */
	icon?: ProjectIcon,
	/**
	 * The absolute path of the repository on this host.
	 */
	repoPath: string,
	/**
	 * The branch checked out in the repository, or the first 7 digits of the commit when `HEAD`
	 * is detached, read when plxd sends the project. Absent when plxd can't read it.
	 */
	branch?: string,
	/**
	 * The run of the project's coordinator chat, the newest one `project/start` started (0024).
	 * Its transcript, messages, and Stop go through `agent/*` like any run's.
	 */
	coordinator?: RunId,
	/**
	 * When the project was created, in RFC 3339 UTC.
	 */
	createdAt: string,
	/**
	 * When the project last changed, in RFC 3339 UTC. `project/update` leaves it as it is, since
	 * a rename or a new icon is not activity (0032).
	 */
	updatedAt: string,
};

/**
 * A project's icon (RYA-227, 0032): a Lucide icon and a color from the app's palette, both by
 * name. plxd stores them as the client sent them and never reads them.
 */
export type ProjectIcon = {
	/**
	 * The Lucide icon's name in kebab-case, such as `rocket`: 1 to 64 characters of `a-z`, `0-9`,
	 * and `-`.
	 */
	name: string,
	/**
	 * The palette key of its color, such as `green`: 1 to 32 characters of `a-z`, `0-9`, and
	 * `-`. Absent means the app's accent.
	 */
	color?: string,
};

/**
 * A project's id: a version 7 UUID that the client generates once and sends again on every
 * retry of `project/create`.
 */
export type ProjectId = string;

/**
 * An agent run's id: a version 7 UUID that the client generates once and sends again on every
 * retry of `agent/start`, so a retry never starts a second agent.
 */
export type RunId = string;

/**
 * Params of `project/create`.
 *
 * It is idempotent on `id`: if a project with that id exists, plxd returns it instead of
 * creating another, and fails with `idConflict` if `name`, `repoPath`, or `icon` differ. A new
 * project's `repoPath` must be the top folder of a git working tree on this host, or it fails
 * with `notARepository`.
 */
export type ProjectCreateParams = {
	/**
	 * The new project's id, a version 7 UUID generated by the client.
	 */
	id: ProjectId,
	/**
	 * The name shown in the app.
	 */
	name: string,
	/**
	 * The absolute path of the repository on this host.
	 */
	repoPath: string,
	/**
	 * The project's icon, sent only to a plxd that advertises `projectEdit`. Absent means the
	 * app's default icon.
	 */
	icon?: ProjectIcon,
};

/**
 * Result of `project/create`.
 */
export type ProjectCreateResult = {
	/**
	 * The project, new or existing.
	 */
	project: Project,
};

/**
 * Params of `events/subscribe`.
 *
 * plxd replays the events after `after`, then sends new ones as they happen, each as an
 * `events/event` notification. If those events are gone or too many to replay, it fails with
 * `resyncRequired`.
 */
export type EventsSubscribeParams = {
	/**
	 * Replay the events whose `seq` is greater than this: usually the `seq` of a snapshot, such
	 * as `project/list`'s, or of the last event received. `seq` starts at 1.
	 */
	after: number,
	/**
	 * Subscribe to one project's events. Without it, the subscription gets host-level events,
	 * such as `project.created`.
	 */
	project?: ProjectId,
};

/**
 * Result of `events/subscribe`.
 */
export type EventsSubscribeResult = {
	/**
	 * The new subscription, which its `events/event` notifications name.
	 */
	subscription: SubscriptionId,
};

/**
 * Identifies one `events/subscribe` on one connection. plxd generates it.
 */
export type SubscriptionId = string;

/**
 * Params of `events/unsubscribe`.
 */
export type EventsUnsubscribeParams = {
	/**
	 * The subscription to end. Ending one that does not exist succeeds.
	 */
	subscription: SubscriptionId,
};

/**
 * Result of `events/unsubscribe`.
 */
export type EventsUnsubscribeResult = Record<symbol, never>;

/**
 * Params of `accounts/keys/add`.
 *
 * It is idempotent on `id`: adding the same id again with the same `provider`, `label`, and
 * `key` returns the existing account instead of storing the key twice, and fails with
 * `idConflict` if they differ. The key is sent once; plxd stores it in the Keychain and never
 * echoes it back unmasked.
 */
export type AccountsKeysAddParams = {
	/**
	 * The new account's id, a version 7 UUID generated by the client.
	 */
	id: AccountId,
	/**
	 * Who the key is for.
	 */
	provider: Provider,
	/**
	 * A label the user chose, shown in the app.
	 */
	label: string,
	/**
	 * The key. Never logged, never written anywhere but the Keychain, and never sent back.
	 */
	key: RawKey,
};

/**
 * A key account's id: a version 7 UUID that the client generates once and sends again on
 * every retry of `accounts/keys/add`.
 */
export type AccountId = string;

/**
 * Who a stored API key is for (0004's fallback for a subscription).
 *
 * A newer plxd may send providers that are not listed here. Treat those as unknown, so a
 * `switch` over this type must not end in an exhaustiveness assertion.
 */
export type Provider = "anthropic" | "openai" | "cursor";

/**
 * An API key on the wire.
 *
 * It serializes and deserializes as a plain string (serde's newtype-struct representation is
 * already transparent in JSON, so `#[serde(transparent)]` would be redundant here, and ts-rs 12
 * cannot parse it), but its `Debug` never shows the value, so a stray `{:?}` in a log line can't
 * leak it (#117). Compare plxd's `backend::ApiKey`, which does the same for the key once it
 * reaches a backend.
 */
export type RawKey = string;

/**
 * Result of `accounts/keys/add`.
 */
export type AccountsKeysAddResult = {
	/**
	 * The account, with its key masked.
	 */
	account: KeyAccount,
};

/**
 * A key account: its record in Parallax's store. The key itself lives only in the macOS Keychain
 * (0004); plxd never returns it unmasked.
 */
export type KeyAccount = {
	/**
	 * The id the client chose when it added the key.
	 */
	id: AccountId,
	/**
	 * Who the key is for.
	 */
	provider: Provider,
	/**
	 * A label the user chose, shown in the app.
	 */
	label: string,
	/**
	 * When the key was added, in RFC 3339 UTC.
	 */
	createdAt: string,
	/**
	 * The key, masked: its vendor prefix and last 4 characters, such as `sk-ant-...abcd`.
	 */
	maskedKey: string,
};

/**
 * Params of `accounts/keys/list`.
 */
export type AccountsKeysListParams = Record<symbol, never>;

/**
 * Result of `accounts/keys/list`.
 */
export type AccountsKeysListResult = {
	/**
	 * Every key account, oldest first, with its key masked.
	 */
	accounts: Array<KeyAccount>,
};

/**
 * Params of `accounts/keys/remove`.
 *
 * Removing an id that does not exist fails with `accountNotFound`.
 */
export type AccountsKeysRemoveParams = {
	/**
	 * The account to remove.
	 */
	id: AccountId,
};

/**
 * Result of `accounts/keys/remove`.
 */
export type AccountsKeysRemoveResult = Record<symbol, never>;

/**
 * Params of `accounts/list`.
 */
export type AccountsListParams = Record<symbol, never>;

/**
 * Result of `accounts/list`.
 */
export type AccountsListResult = {
	/**
	 * Every CLI plxd knows how to detect, in a stable order (`claude`, `codex`, `cursor`).
	 */
	clis: Array<DetectedCli>,
	/**
	 * When these results were read. `accounts/list` may answer from a short-lived cache;
	 * `accounts/refresh` always sets this to the time of a fresh probe.
	 */
	checkedAt: string,
};

/**
 * One CLI's detected state.
 *
 * Every field but `cli` and `installed` is best-effort: the status commands 0004 lists are
 * undocumented in places, so a field plxd could not read is `null` rather than a guess.
 */
export type DetectedCli = {
	/**
	 * Which CLI this is.
	 */
	cli: CliKind,
	/**
	 * Whether the binary resolves on the `PATH` plxd itself uses (#96).
	 */
	installed: boolean,
	/**
	 * The resolved absolute path, when installed.
	 */
	path?: string,
	/**
	 * The CLI's version, when the status command happened to expose it.
	 */
	version?: string,
	/**
	 * Whether the user is signed in. `null` when installed but plxd could not tell (a timeout,
	 * unparseable output, or an exit code 0004 doesn't document).
	 */
	signedIn?: boolean,
	/**
	 * How a signed-in CLI authenticates. Only set when `signedIn` is `true`.
	 */
	authKind?: AuthKind,
	/**
	 * The subscription plan or tier, where the status commands expose it (0004: undocumented
	 * for all three vendors).
	 */
	plan?: string,
	/**
	 * Why a field above is missing or uncertain, such as `"timed out after 5s"`. Never set on a
	 * clean read.
	 */
	note?: string,
};

/**
 * How a signed-in CLI authenticates.
 *
 * A newer plxd may send kinds that are not listed here. Treat those as unknown, so a `switch`
 * over this type must not end in an exhaustiveness assertion.
 */
export type AuthKind = "subscription" | "apiKey";

/**
 * A vendor CLI plxd knows how to detect (0004).
 *
 * A newer plxd may send kinds that are not listed here. Treat those as unknown, so a `switch`
 * over this type must not end in an exhaustiveness assertion.
 */
export type CliKind = "claude" | "codex" | "cursor";

/**
 * Params of `accounts/refresh`.
 */
export type AccountsRefreshParams = Record<symbol, never>;

/**
 * Result of `accounts/refresh`.
 */
export type AccountsRefreshResult = {
	/**
	 * Every CLI plxd knows how to detect, freshly probed.
	 */
	clis: Array<DetectedCli>,
	/**
	 * When this probe ran.
	 */
	checkedAt: string,
};

/**
 * Params of `usage/get`.
 *
 * Empty: plxd has no account registry yet (#114, #117, #118 are still open, and #113's
 * `AccountRef` is already just a caller-supplied string), so it reports every account id it has
 * recorded usage or limits for.
 */
export type UsageGetParams = Record<symbol, never>;

/**
 * Result of `usage/get`.
 */
export type UsageGetResult = {
	/**
	 * Every account plxd has recorded usage or limits for, in no particular order.
	 */
	accounts: Array<AccountUsage>,
};

/**
 * One account's usage and latest limit windows.
 */
export type AccountUsage = {
	/**
	 * plxd's id for the account (#114, #117).
	 */
	accountId: string,
	/**
	 * Tokens and cost used today, local time on this host.
	 */
	today: UsagePeriod,
	/**
	 * Tokens and cost used this week (Monday to now), local time on this host.
	 */
	week: UsagePeriod,
	/**
	 * The account's limit windows, as last reported. Empty when the vendor reports none (0004:
	 * Cursor's headless output has no usage API).
	 */
	limits: Array<UsageLimitWindow>,
};

/**
 * One of an account's limit windows, as a vendor last reported it (0004's `rate_limit_event` and
 * Codex's `account/rateLimits/read`).
 */
export type UsageLimitWindow = {
	/**
	 * The vendor's name for the window, such as `five_hour`, `seven_day`, `primary`, or
	 * `secondary`.
	 */
	window: string,
	/**
	 * How much of the window is used, from 0 to 100, when the vendor says.
	 */
	usedPercent?: number,
	/**
	 * When the window resets, when the vendor says.
	 */
	resetsAt?: string,
	/**
	 * When plxd captured this snapshot.
	 */
	capturedAt: string,
};

/**
 * Tokens and cost over a period.
 */
export type UsagePeriod = {
	/**
	 * Input tokens, not counting cache reads and writes.
	 */
	inputTokens: number,
	/**
	 * Output tokens, including reasoning.
	 */
	outputTokens: number,
	/**
	 * Input tokens read from the prompt cache.
	 */
	cacheReadTokens: number,
	/**
	 * Input tokens written to the prompt cache.
	 */
	cacheWriteTokens: number,
	/**
	 * The cost, when the vendor reports one for this account in the period. Absent, not zero,
	 * when it never does (0004: Codex and Cursor report no cost).
	 */
	costUsdMicros?: number,
};

/**
 * Params of `usage/history`.
 */
export type UsageHistoryParams = {
	/**
	 * The start of the range, inclusive. The range ends now.
	 */
	since: string,
};

/**
 * Result of `usage/history`.
 */
export type UsageHistoryResult = {
	/**
	 * Usage summed per UTC hour, account, and model, oldest hour first. Hours with no usage are
	 * left out.
	 */
	hours: Array<UsageHour>,
	/**
	 * How many runs each account used in the range. Accounts with none are left out.
	 */
	runs: Array<AccountRuns>,
};

/**
 * How many distinct runs used an account in a range.
 */
export type AccountRuns = {
	/**
	 * plxd's id for the account (#114, #117).
	 */
	accountId: string,
	/**
	 * Runs with at least one usage delta in the range.
	 */
	runs: number,
};

/**
 * One account's usage of one model within one UTC hour.
 */
export type UsageHour = {
	/**
	 * The start of the UTC hour, such as `2026-09-29T19:00:00Z`.
	 */
	hour: string,
	/**
	 * plxd's id for the account (#114, #117).
	 */
	accountId: string,
	/**
	 * The model, when the vendor named one.
	 */
	model?: string,
	/**
	 * Input tokens, not counting cache reads and writes.
	 */
	inputTokens: number,
	/**
	 * Output tokens, including reasoning.
	 */
	outputTokens: number,
	/**
	 * Input tokens read from the prompt cache.
	 */
	cacheReadTokens: number,
	/**
	 * Input tokens written to the prompt cache.
	 */
	cacheWriteTokens: number,
	/**
	 * The cost, when the vendor reported one in this hour. Absent, not zero, when it did not
	 * (0004: Codex and Cursor report no cost).
	 */
	costUsdMicros?: number,
};

/**
 * Params of `accounts/defaults/get`.
 */
export type AccountsDefaultsGetParams = Record<symbol, never>;

/**
 * Result of `accounts/defaults/get`, and of `accounts/defaults/set`: this host's default account
 * for each role, absent where none is set.
 */
export type AccountsDefaultsGetResult = {
	/**
	 * The coordinator's default account.
	 */
	coordinator?: AccountChoice,
	/**
	 * A worker's default account.
	 */
	worker?: AccountChoice,
};

/**
 * An account a task can be routed to: the user's own login in a vendor CLI, or a stored key.
 *
 * A newer plxd may send a kind this version does not know. Treat that as absent rather than end
 * a `switch` over this type in an exhaustiveness assertion.
 */
export type AccountChoice = { "kind": "subscription",
	/**
	 * The backend's name, as `host/health`'s running agents and plxd's logs use it.
	 */
	backend: string, } | { "kind": "key",
	/**
	 * The key account's id.
	 */
	id: AccountId,
};

/**
 * Params of `accounts/defaults/set`.
 */
export type AccountsDefaultsSetParams = {
	/**
	 * The role to set the default for.
	 */
	role: Role,
	/**
	 * The new default, or `None` to clear it.
	 */
	account?: AccountChoice,
};

/**
 * Which kind of run an account is chosen for (0004).
 */
export type Role = "coordinator" | "worker";

/**
 * Params of `context/list`.
 */
export type ContextListParams = {
	/**
	 * The project whose shared context to list.
	 */
	project: ProjectId,
};

/**
 * Result of `context/list`.
 */
export type ContextListResult = {
	/**
	 * Every file in the project's shared context, ordered by path.
	 */
	files: Array<ContextFile>,
};

/**
 * One shared context file, without its content.
 */
export type ContextFile = {
	/**
	 * The file's name, relative to the project's context folder.
	 */
	path: string,
	/**
	 * Its size in bytes.
	 */
	size: number,
	/**
	 * When it was last modified, in RFC 3339 UTC.
	 */
	modifiedAt: string,
	/**
	 * Who wrote it last, such as `"app"` or an agent's run id, when plxd knows. Absent for a
	 * file plxd has not seen written since it started, such as one already on disk at startup.
	 */
	lastWriter?: string,
};

/**
 * Params of `context/read`.
 */
export type ContextReadParams = {
	/**
	 * The file's project.
	 */
	project: ProjectId,
	/**
	 * The file's path. Fails with `contextNotFound` if it does not exist.
	 */
	path: string,
};

/**
 * Result of `context/read`.
 */
export type ContextReadResult = {
	/**
	 * The file's metadata.
	 */
	file: ContextFile,
	/**
	 * Its content.
	 */
	content: string,
};

/**
 * Params of `context/write`.
 *
 * It is idempotent on `id`: writing the same id again with the same `project`, `path`,
 * `content`, and `writer` returns the same result instead of writing twice or emitting a second
 * `context.changed` event; with different params it fails with `idConflict`. A write to a path
 * with existing content replaces it; the last write to a path wins when two race (0005).
 */
export type ContextWriteParams = {
	/**
	 * The write's id, a version 7 UUID generated by the client.
	 */
	id: ContextWriteId,
	/**
	 * The file's project.
	 */
	project: ProjectId,
	/**
	 * The file's path.
	 */
	path: string,
	/**
	 * The file's new content, in full: `context/write` replaces a file, it does not patch one.
	 */
	content: string,
	/**
	 * A label for who is writing, such as `"app"` or an agent's run id, shown later in
	 * `context/list` and in the `context.changed` event as `lastWriter`. Omitted when the caller
	 * has none to give.
	 */
	writer?: string,
};

/**
 * A `context/write`'s id: a version 7 UUID that the client generates once and sends again on
 * every retry, so a retry never applies the write twice or emits a duplicate `context.changed`
 * event.
 */
export type ContextWriteId = string;

/**
 * Result of `context/write`.
 */
export type ContextWriteResult = {
	/**
	 * The written file's metadata.
	 */
	file: ContextFile,
};

/**
 * Params of `agent/start`.
 *
 * Idempotent on `runId`: starting the same id again with the same params returns the run
 * instead of starting another; with different params it fails with `idConflict`.
 */
export type AgentStartParams = {
	/**
	 * The new run's id, a version 7 UUID generated by the client.
	 */
	runId: RunId,
	/**
	 * The project whose repository the run works in.
	 */
	project: ProjectId,
	/**
	 * The task.
	 */
	prompt: string,
	/**
	 * What the run's tools may do: only `workspaceWrite`. A project's coordinator, the one
	 * `noWrite` run, is started with `project/start`.
	 */
	policy: AgentPolicy,
	/**
	 * The account to run on. Absent means the worker role's default (`accounts/defaults/*`).
	 */
	account?: AccountChoice,
	/**
	 * The coordinator thread starting the run, which `plxd mcp` sets for runs the coordinator
	 * spawns (0019). The run keeps it, and a retry must repeat it.
	 */
	coordinatorThread?: CoordinatorThreadId,
	/**
	 * The model, in the backend's naming, such as `opus`. Absent means the CLI's default. Send
	 * it, `effort`, and `permission` only to a plxd that advertises `runOptions`. The run keeps
	 * all three when it resumes, and a retry must repeat them.
	 */
	model?: string,
	/**
	 * How hard the model thinks. Absent means the CLI's default.
	 */
	effort?: AgentEffort,
	/**
	 * The permission mode (RYA-97, 0027). Absent means `edit`, or for a run with a
	 * `coordinatorThread`, the coordinator's mode when it spawns the run.
	 */
	permission?: AgentPermission,
	/**
	 * Images for the prompt, sent only to a plxd that advertises `promptImages`. Its options
	 * give the caps: `maxImages`, and `maxImageBytes` and `maxTotalBytes` of `data`, past which
	 * the request fails with `imageTooLarge`. With images, the prompt may be empty (RYA-193). A
	 * retry must repeat them; plxd doesn't compare them.
	 */
	images?: Array<PromptImage>,
	/**
	 * Forward the run's permission requests to the client as `approvalRequested` items, which
	 * `agent/approve` answers (RYA-222, decision 0031). Set it only when the client shows and
	 * answers them, and only to a plxd that advertises `approvals`. Absent, a run in Manual,
	 * Auto, or Plan denies what would prompt, as before. A run with a `coordinatorThread` also
	 * gets it when its coordinator has it. The run keeps it when it resumes, and a retry must
	 * repeat it.
	 */
	approvals?: boolean,
};

/**
 * How hard a run's model thinks, behind the `runOptions` capability (RYA-97). Claude Code takes
 * every level as `--effort`, and downgrades `xhigh` on models that lack it. A backend that can't
 * honor a level refuses the run with `unsupportedOption`.
 *
 * A newer peer may send a level this version does not know; treat it as unknown.
 */
export type AgentEffort = "low" | "medium" | "high" | "xhigh" | "max";

/**
 * A run's permission mode, behind the `runOptions` capability (RYA-97): Claude Code's modes,
 * which each backend reports the subset of that it maps (RYA-188, 0027). A worker keeps the
 * worker sandbox (0013) in every mode but [`AgentPermission::Bypass`].
 *
 * A newer peer may send a value this version does not know; treat it as unknown.
 */
export type AgentPermission = "auto" | "manual" | "edit" | "plan" | "bypass";

/**
 * What a run's tools may do. `agent/start` takes only `workspaceWrite`; a project's coordinator,
 * which `project/start` starts, is `noWrite`.
 *
 * A newer plxd may send a policy this version does not know; treat it as unknown.
 */
export type AgentPolicy = "workspaceWrite" | "noWrite";

/**
 * A project's coordinator thread (M4, #195, decision 0019). Runs the coordinator starts
 * through its Parallax tools carry it, so a client can tell them from runs it started itself.
 */
export type CoordinatorThreadId = string;

/**
 * An image sent with a prompt or message, behind the `promptImages` capability (RYA-191,
 * decision 0026). The CLI gets it beside the text, never as a file name or path in it.
 */
export type PromptImage = {
	/**
	 * Its file type, which its bytes must match.
	 */
	mediaType: ImageMediaType,
	/**
	 * The image file's bytes, in standard base64 with padding.
	 */
	data: string,
};

/**
 * An image's file type (RYA-191): the four that Claude and Codex both take.
 *
 * A newer peer may send a type this version does not know; treat it as unknown.
 */
export type ImageMediaType = "image/png" | "image/jpeg" | "image/gif" | "image/webp";

/**
 * Result of `agent/start`, `agent/send`, and `agent/cancel`: the run as it stands.
 */
export type AgentRunResult = {
	/**
	 * The run.
	 */
	run: AgentRun,
};

/**
 * One agent run.
 */
export type AgentRun = {
	/**
	 * The run's id.
	 */
	id: RunId,
	/**
	 * Its project.
	 */
	project: ProjectId,
	/**
	 * The task it was started with.
	 */
	prompt: string,
	/**
	 * What its tools may do.
	 */
	policy: AgentPolicy,
	/**
	 * Where it is.
	 */
	status: AgentStatus,
	/**
	 * The backend running it, such as `claude`.
	 */
	backend: string,
	/**
	 * The account it is charged to now: the backend's name for a subscription, or a key
	 * account's id. It changes on `agent.accountFallback`.
	 */
	accountId: string,
	/**
	 * Its worktree's branch, such as `parallax/1a2b3c4d`, once the worktree exists.
	 */
	branch?: string,
	/**
	 * Its worktree's absolute path on the host, once it exists.
	 */
	worktreePath?: string,
	/**
	 * True when the worktree's base was resolved from a dirty `HEAD` (#257): the repository's
	 * tracked files had uncommitted changes that aren't in this run. Never true for a run whose
	 * worktree doesn't exist yet, or whose caller passed an explicit base.
	 */
	baseDirty?: boolean,
	/**
	 * The vendor's session id, once the CLI reported it.
	 */
	sessionId?: string,
	/**
	 * Why it failed, for people.
	 */
	error?: string,
	/**
	 * Its latest commit, once plxd made one.
	 */
	diff?: DiffSummary,
	/**
	 * The coordinator thread that started it through its Parallax tools. Absent for a run a client
	 * started itself.
	 */
	coordinatorThread?: CoordinatorThreadId,
	/**
	 * Its model: what it was started with, or what `agent/send` last changed it to. Absent
	 * means the CLI's default.
	 */
	model?: string,
	/**
	 * Its effort, as `model`. Absent means the CLI's default.
	 */
	effort?: AgentEffort,
	/**
	 * Its permission, as `model`. Absent means `edit`.
	 */
	permission?: AgentPermission,
	/**
	 * True when it forwards its permission requests to the client, as the start method that
	 * made it asked with `approvals` (RYA-222, decision 0031). It never changes. Absent means
	 * false: its CLI denies what would prompt.
	 */
	approvals?: boolean,
	/**
	 * True for a thread started with `checkout`: it works in its repository's own checkout, so it
	 * has no `branch`, `worktreePath`, or `diff`, and its changes are left uncommitted there.
	 * Absent means false.
	 */
	checkout?: boolean,
	/**
	 * When it was created, in RFC 3339 UTC.
	 */
	createdAt: string,
	/**
	 * When it last changed, in RFC 3339 UTC.
	 */
	updatedAt: string,
};

/**
 * Where a run is.
 *
 * A newer plxd may send a status this version does not know; treat it as unknown, and don't
 * end a `switch` over this type in an exhaustiveness assertion.
 */
export type AgentStatus = "starting" | "running" | "completed" | "failed" | "cancelled" | "interrupted" | "accepted";

/**
 * The commit plxd made for a run, compared with the commit its worktree was created from.
 */
export type DiffSummary = {
	/**
	 * The commit's full sha, on the run's branch.
	 */
	commit: string,
	/**
	 * Files changed.
	 */
	files: number,
	/**
	 * Lines added.
	 */
	insertions: number,
	/**
	 * Lines removed.
	 */
	deletions: number,
};

/**
 * Params of `agent/send`: a message to a run (0011).
 *
 * A running agent gets it as its next turn. An agent that ended with a `sessionId` resumes
 * that session in its worktree, with the message as the prompt. Idempotent on `turnId` while
 * plxd runs.
 */
export type AgentSendParams = {
	/**
	 * The run.
	 */
	runId: RunId,
	/**
	 * The message's id, a version 7 UUID generated by the client.
	 */
	turnId: TurnId,
	/**
	 * The message.
	 */
	text: string,
	/**
	 * A new model for the run and every later resume (RYA-163), sent only to a plxd that
	 * advertises `sendModel`. It should be one the run's backend runs, or with `account`, that
	 * account's; plxd can't check that, so another's fails the run with the CLI's own error.
	 * Absent, or the run's own, changes nothing. While the run's CLI is running, a different one
	 * waits with the message until the CLI exits, since it can't change mid-process, as does
	 * every message sent after it; a plxd without `sendAccount` fails it with
	 * `unsupportedOption` instead.
	 */
	model?: string,
	/**
	 * A new effort (RYA-161), as `model`. `sendOptions` is enough for it and `permission`.
	 */
	effort?: AgentEffort,
	/**
	 * A new permission (RYA-161), as `effort`.
	 */
	permission?: AgentPermission,
	/**
	 * A new account for the run and every later resume, sent only to a plxd that advertises
	 * `sendAccount`, and waiting for a running CLI as `model` does. On the run's backend, the
	 * session resumes on it. On another backend, the session can't move, so plxd starts a new
	 * one there in the run's worktree, whose first message carries the conversation so far
	 * before this one: the run keeps its id, transcript, and worktree, and takes the new
	 * backend, with `model`, and the run's effort and permission where the backend maps them.
	 * Absent, or the run's own, changes nothing.
	 */
	account?: AccountChoice,
	/**
	 * Images for the message, as `agent/start`'s.
	 */
	images?: Array<PromptImage>,
};

/**
 * A follow-up turn's id: a version 7 UUID that the client generates once and sends again on
 * every retry of `agent/send`, so a retry never sends the message twice.
 */
export type TurnId = string;

/**
 * Params of `agent/cancel`: stops a running agent, which ends as `cancelled`. Cancelling a run
 * that isn't running does nothing.
 */
export type AgentCancelParams = {
	/**
	 * The run.
	 */
	runId: RunId,
};

/**
 * Params of `agent/list`.
 */
export type AgentListParams = {
	/**
	 * Only this project's runs. Absent lists every run on the host.
	 */
	project?: ProjectId,
};

/**
 * Result of `agent/list`.
 */
export type AgentListResult = {
	/**
	 * The runs, oldest first.
	 */
	runs: Array<AgentRun>,
	/**
	 * The `seq` of the last event the list reflects, to subscribe after.
	 */
	seq: number,
};

/**
 * Params of `agent/events`: one run's events from plxd's log, for rebuilding its transcript
 * after `resyncRequired` or a restart.
 */
export type AgentEventsParams = {
	/**
	 * The run.
	 */
	runId: RunId,
	/**
	 * Return the events whose `seq` is greater than this; 0 for the first page.
	 */
	after: number,
	/**
	 * The most events to return: 500 by default, and at most 1000.
	 */
	limit?: number,
};

/**
 * Result of `agent/events`.
 */
export type AgentEventsResult = {
	/**
	 * The events, oldest first.
	 */
	events: Array<LoggedEvent>,
	/**
	 * Whether more events follow the last one returned. Ask again after its `seq`.
	 */
	more: boolean,
};

/**
 * An event from plxd's log, as `agent/events` returns it.
 */
export type LoggedEvent = {
	/**
	 * The event's position in the log.
	 */
	seq: number,
	/**
	 * When it happened, in RFC 3339 UTC.
	 */
	time: string,
	/**
	 * Its project. Absent for host-level events.
	 */
	project?: ProjectId,
	/**
	 * What happened.
	 */
	event: ParallaxEvent,
};

/**
 * What happened, by `kind`.
 *
 * A newer plxd may send kinds that are not listed here. Skip those events but still count their
 * `seq` as received, and don't end a `switch` over this type in an exhaustiveness assertion.
 */
export type ParallaxEvent = { "kind": "project.created",
	/**
	 * The new project.
	 */
	project: Project, } | { "kind": "project.updated",
	/**
	 * The project as it stands.
	 */
	project: Project, } | { "kind": "context.changed",
	/**
	 * The changed file.
	 */
	file: ContextFile, } | { "kind": "agent.started",
	/**
	 * The run's id.
	 */
	runId: RunId,
	/**
	 * The run as it was created. plxd always sends it.
	 */
	run?: AgentRun, } | { "kind": "agent.updated",
	/**
	 * The run's id.
	 */
	runId: RunId,
	/**
	 * The run's changing fields as they stand now.
	 */
	state: AgentRunState, } | { "kind": "agent.output",
	/**
	 * The run's id.
	 */
	runId: RunId,
	/**
	 * What happened, in order.
	 */
	items: Array<AgentOutputItem>, } | { "kind": "agent.accountFallback",
	/**
	 * The run's id.
	 */
	runId: RunId,
	/**
	 * The account it was on.
	 */
	fromAccount: string,
	/**
	 * The account it is on now.
	 */
	toAccount: string,
	/**
	 * Why it moved.
	 */
	reason: AgentFailureKind, } | { "kind": "agent.finished",
	/**
	 * The run's id.
	 */
	runId: RunId,
	/**
	 * How it ended.
	 */
	outcome: AgentOutcome, } | { "kind": "agent.diffReady",
	/**
	 * The run's id.
	 */
	runId: RunId,
	/**
	 * The commit and its stats against the worktree's base.
	 */
	diff: DiffSummary, } | { "kind": "agent.accepted",
	/**
	 * The run's id.
	 */
	runId: RunId,
	/**
	 * What happened to the project's repository.
	 */
	merge: AgentMerge, } | { "kind": "agent.wakeupsPaused",
	/**
	 * The coordinator's run id.
	 */
	runId: RunId, } | { "kind": "repo.added",
	/**
	 * The entry.
	 */
	repo: Repo, } | { "kind": "repo.updated",
	/**
	 * The entry as it stands.
	 */
	repo: Repo, } | { "kind": "thread.started",
	/**
	 * The thread.
	 */
	thread: Thread, } | { "kind": "thread.updated",
	/**
	 * The thread as it stands.
	 */
	thread: Thread, } | { "kind": "thread.deleted",
	/**
	 * The thread's run id.
	 */
	runId: RunId,
	/**
	 * Its repo entry.
	 */
	repo: RepoId,
};

/**
 * Why a run failed, for code to match on.
 *
 * A newer plxd may send a kind this version does not know; treat it as unknown.
 */
export type AgentFailureKind = "notSignedIn" | "rateLimited" | "policyViolation" | "unexpectedApiKey" | "vendorError" | "crashed" | "spawnFailed" | "commitFailed" | "internal";

/**
 * What `agent/accept` did to the project's repository.
 */
export type AgentMerge = {
	/**
	 * The commit the branch points at now: the run's commit, or plxd's merge commit.
	 */
	commit: string,
	/**
	 * The branch it went into, such as `main`: the repository's current branch when the run
	 * was accepted.
	 */
	into: string,
	/**
	 * How.
	 */
	how: AgentMergeKind,
};

/**
 * How `agent/accept` brought a run's commit into the project's branch.
 *
 * A newer plxd may send a value this version does not know; treat it as unknown.
 */
export type AgentMergeKind = "fastForward" | "merge" | "upToDate";

/**
 * How one CLI process of a run ended.
 *
 * A newer plxd may send a status this version does not know; treat it as unknown.
 */
export type AgentOutcome = { "status": "completed",
	/**
	 * The last turn's final text, when the vendor reports one.
	 */
	result?: string, } | { "status": "cancelled" } | { "status": "failed",
	/**
	 * What went wrong.
	 */
	failure: AgentFailureKind,
	/**
	 * A description for people.
	 */
	message: string, } | { "status": "interrupted"
};

/**
 * One thing in a run's transcript: a normalized event from its CLI (0004), by `kind`.
 *
 * A newer plxd may send kinds that are not listed here; skip them.
 */
export type AgentOutputItem = { "kind": "sessionStarted",
	/**
	 * The vendor's session id.
	 */
	sessionId: string,
	/**
	 * The model, when the CLI says.
	 */
	model?: string, } | { "kind": "turnStarted",
	/**
	 * The turn's id, when the caller gave one.
	 */
	turnId?: TurnId,
	/**
	 * A follow-up's message, as `agent/send` took it, cut short when it is long. Absent for
	 * the prompt's turn, whose text is the run's `prompt`, and in logs from before plxd
	 * recorded it.
	 */
	text?: string,
	/**
	 * True for a wake-up (RYA-42, decision 0025): a turn plxd sent a project's coordinator
	 * on its own, not the user, because runs it started finished. `text` lists them.
	 */
	wake?: boolean,
	/**
	 * The images sent with the turn's message, the prompt's or a follow-up's, in order, for
	 * `agent/image` (RYA-191). Absent when it had none.
	 */
	images?: Array<ImageId>, } | { "kind": "textDelta",
	/**
	 * The vendor's id for the message, when it has one.
	 */
	messageId?: string,
	/**
	 * The new text.
	 */
	text: string, } | { "kind": "text",
	/**
	 * The vendor's id for the message, when it has one.
	 */
	messageId?: string,
	/**
	 * The text.
	 */
	text: string, } | { "kind": "toolCall",
	/**
	 * The call's id, which its `toolResult` repeats.
	 */
	callId: string,
	/**
	 * The tool, in the vendor's naming, such as `Edit`.
	 */
	name: string,
	/**
	 * The tool's input as the vendor sent it, or `{"truncated": true, "bytes": n}` when it
	 * was too large to forward.
	 */
	input: JsonValue, } | { "kind": "toolResult",
	/**
	 * The call's id.
	 */
	callId: string,
	/**
	 * How it ended.
	 */
	status: AgentToolStatus,
	/**
	 * What the tool returned, when the vendor includes it, cut short when it is long.
	 */
	output?: string, } | { "kind": "reasoning",
	/**
	 * The vendor's id for the message, when it has one.
	 */
	messageId?: string,
	/**
	 * The text.
	 */
	text: string, } | { "kind": "todoList",
	/**
	 * The items, in order.
	 */
	items: Array<AgentTodoItem>, } | { "kind": "notice",
	/**
	 * The message.
	 */
	detail: string, } | { "kind": "turnFinished",
	/**
	 * The turn's id, as its `turnStarted` had it.
	 */
	turnId?: TurnId,
	/**
	 * The turn's final text, when the vendor reports one.
	 */
	result?: string, } | { "kind": "followUpDropped",
	/**
	 * The follow-up's turn id.
	 */
	turnId: TurnId, } | { "kind": "usage",
	/**
	 * The model, when the vendor breaks usage down by model.
	 */
	model?: string,
	/**
	 * Input tokens, not counting cache reads and writes.
	 */
	inputTokens: number,
	/**
	 * Output tokens.
	 */
	outputTokens: number,
	/**
	 * Input tokens read from the prompt cache.
	 */
	cacheReadTokens: number,
	/**
	 * Input tokens written to the prompt cache.
	 */
	cacheWriteTokens: number,
	/**
	 * The cost the vendor reported, in millionths of a US dollar, when it reports one.
	 */
	costUsdMicros?: number, } | { "kind": "warning",
	/**
	 * A short description.
	 */
	detail: string, } | { "kind": "approvalRequested",
	/**
	 * The request's id.
	 */
	approvalId: ApprovalId,
	/**
	 * The tool, in the vendor's naming, such as `Bash` or `ExitPlanMode`.
	 */
	toolName: string,
	/**
	 * The tool's input as the vendor sent it, such as `ExitPlanMode`'s `plan`, or
	 * `{"truncated": true, "bytes": n}` when it was too large to forward.
	 */
	input: JsonValue,
	/**
	 * The tool call's id, which its `toolCall` and `toolResult` carry, when the vendor
	 * says.
	 */
	callId?: string,
	/**
	 * Why the CLI asks, such as a safety check's warning, with terminal escapes removed.
	 */
	reason?: string,
	/**
	 * The path that made the CLI ask, when one did.
	 */
	blockedPath?: string,
	/**
	 * The vendor's id for the subagent asking, when one of the agent's own subagents asks.
	 */
	subagent?: string,
	/**
	 * The rules that `always` adds for the rest of the CLI process, such as
	 * `Bash(pnpm test:*)`. Absent when the request offers none.
	 */
	alwaysAllow?: Array<string>,
	/**
	 * True when the request is a question for the user rather than one action to allow,
	 * such as `ExitPlanMode`'s plan: show its input in full.
	 */
	interactive?: boolean,
	/**
	 * When plxd denies it if nobody has answered, in RFC 3339 UTC.
	 */
	expiresAt: string, } | { "kind": "approvalResolved",
	/**
	 * The request's id.
	 */
	approvalId: ApprovalId,
	/**
	 * What it came to.
	 */
	decision: AgentApprovalDecision,
	/**
	 * Who or what decided it.
	 */
	by: AgentApprovalBy,
	/**
	 * True when it was allowed for the rest of the CLI process as well.
	 */
	always?: boolean,
	/**
	 * The user's message to the agent with a denial, cut short when it is long.
	 */
	message?: string,
};

/**
 * Who or what decided a permission request.
 *
 * A newer plxd may send a value this version does not know; treat it as unknown.
 */
export type AgentApprovalBy = "user" | "timeout" | "cancel" | "stop" | "agent";

/**
 * What a permission request came to.
 *
 * A newer plxd may send a value this version does not know; treat it as unknown.
 */
export type AgentApprovalDecision = "allowed" | "denied" | "expired" | "withdrawn";

/**
 * One item of an agent's checklist.
 */
export type AgentTodoItem = {
	/**
	 * What to do.
	 */
	text: string,
	/**
	 * How far along it is.
	 */
	status: AgentTodoStatus,
};

/**
 * How far along a checklist item is.
 *
 * A newer plxd may send a status this version does not know; treat it as unknown.
 */
export type AgentTodoStatus = "pending" | "inProgress" | "completed";

/**
 * How a tool call ended.
 *
 * A newer plxd may send a status this version does not know; treat it as unknown.
 */
export type AgentToolStatus = "ok" | "error" | "denied";

/**
 * A permission request's id: a version 7 UUID that plxd generates when a run's CLI asks.
 * `approvalRequested` carries it, and `agent/approve` and `approvalResolved` name it.
 */
export type ApprovalId = string;

/**
 * A stored image's id (RYA-191, decision 0026): a version 7 UUID that plxd generates once a
 * message's image reaches the CLI. `turnStarted` lists them, and `agent/image` serves them.
 */
export type ImageId = string;

/**
 * The part of a run that changes while it runs, as `agent.updated` reports it. The rest of
 * [`AgentRun`], including its prompt, never changes after `agent.started`.
 */
export type AgentRunState = {
	/**
	 * Where the run is.
	 */
	status: AgentStatus,
	/**
	 * The account it is charged to now.
	 */
	accountId: string,
	/**
	 * The backend it runs on, which `agent/send`'s `account` can move it to. Absent from a plxd
	 * without `sendAccount`, whose runs never move.
	 */
	backend?: string,
	/**
	 * The vendor's session id, once the CLI reported it.
	 */
	sessionId?: string,
	/**
	 * Why it failed, for people. Absent once it runs again.
	 */
	error?: string,
	/**
	 * Its latest commit, once plxd made one.
	 */
	diff?: DiffSummary,
	/**
	 * Its model, which `agent/send` can change (RYA-163). Absent means the CLI's default.
	 */
	model?: string,
	/**
	 * Its effort, which `agent/send` can change (RYA-161). Absent means the CLI's default.
	 */
	effort?: AgentEffort,
	/**
	 * Its permission, which `agent/send` can change (RYA-161). Absent means `edit`.
	 */
	permission?: AgentPermission,
	/**
	 * When it changed, in RFC 3339 UTC.
	 */
	updatedAt: string,
};

/**
 * A repository on the host that normal threads run in.
 */
export type Repo = {
	/**
	 * The entry's id.
	 */
	id: RepoId,
	/**
	 * The name shown in the app: the repository folder's name.
	 */
	name: string,
	/**
	 * The absolute, canonical path of the repository on the host.
	 */
	path: string,
	/**
	 * True for plxd's scratch entry, which holds the threads with no repo. Its `path` is the
	 * folder that holds each such thread's own scratch repository.
	 */
	scratch?: boolean,
	/**
	 * The icon the user chose, in a project's shape (0032), behind the `threadAttention`
	 * capability (0033). Absent means the app's default: the name's initials.
	 */
	icon?: ProjectIcon,
	/**
	 * When the entry was created, in RFC 3339 UTC.
	 */
	createdAt: string,
};

/**
 * A repo entry's id: a version 7 UUID that the client generates once and sends again on
 * every retry of `repo/add`. plxd generates the scratch entry's.
 */
export type RepoId = string;

/**
 * A normal thread: what threads add to its run.
 */
export type Thread = {
	/**
	 * The thread's run id.
	 */
	id: RunId,
	/**
	 * Its repo entry: the scratch entry for a thread with no repo.
	 */
	repo: RepoId,
	/**
	 * Whether the user archived it.
	 */
	archived?: boolean,
	/**
	 * When it was created, in RFC 3339 UTC.
	 */
	createdAt: string,
	/**
	 * When a client last marked it seen with `thread/update` (0033). The app counts a run that
	 * stopped after this as one the user hasn't seen. Absent if never.
	 */
	seenAt?: string,
	/**
	 * Until when the user snoozed it (0033). A time in the past means it isn't snoozed.
	 */
	snoozedUntil?: string,
	/**
	 * When its newest message was sent: its newest turn, or its creation (0033). Absent from a
	 * plxd without `threadAttention`.
	 */
	lastPromptAt?: string,
};

/**
 * Params of `agent/image`: one image sent with a run's messages, by an id from its
 * `turnStarted` (RYA-191). Its result is the [`PromptImage`] as it was sent.
 */
export type AgentImageParams = {
	/**
	 * The run.
	 */
	runId: RunId,
	/**
	 * The image.
	 */
	imageId: ImageId,
};

/**
 * Params of `agent/diff`.
 */
export type AgentDiffParams = {
	/**
	 * The run.
	 */
	runId: RunId,
};

/**
 * Result of `agent/diff`.
 */
export type AgentDiffResult = {
	/**
	 * The commit the run's worktree was created from: the `base` side.
	 */
	base: string,
	/**
	 * The run's latest commit: the `head` side, and what `agent/accept` merges. Equal to `base`
	 * until plxd has committed something for the run.
	 */
	head: string,
	/**
	 * The files that differ, ordered by path.
	 */
	files: Array<AgentDiffFile>,
	/**
	 * Totals over every changed file.
	 */
	stats: AgentDiffStats,
	/**
	 * Whether `files` was cut short because the run changed more files than one answer lists.
	 */
	truncated: boolean,
};

/**
 * One file that differs between the run's base and its latest commit.
 */
export type AgentDiffFile = {
	/**
	 * Its path on the head side, relative to the repository root. For a deleted file, its path
	 * on the base side.
	 */
	path: string,
	/**
	 * Its path on the base side, for a rename or a copy.
	 */
	oldPath?: string,
	/**
	 * How it changed.
	 */
	status: AgentFileStatus,
	/**
	 * Lines added. 0 for a binary file.
	 */
	insertions: number,
	/**
	 * Lines removed. 0 for a binary file.
	 */
	deletions: number,
	/**
	 * Whether git treats it as binary. A binary file has no `diff`.
	 */
	binary: boolean,
	/**
	 * Its unified diff, starting at its `diff --git` line. Absent for a binary file, and for
	 * every file after the result's diffs reached their total size cap; read those files with
	 * `agent/file` instead.
	 */
	diff?: string,
	/**
	 * Whether `diff` was cut short at the per-file size cap.
	 */
	diffTruncated: boolean,
};

/**
 * How a file differs from the base.
 *
 * A newer plxd may send a status this version does not know; treat it as modified.
 */
export type AgentFileStatus = "added" | "modified" | "deleted" | "renamed" | "copied" | "typeChanged";

/**
 * Totals of an `agent/diff`, over every file, including files left out of `files`.
 */
export type AgentDiffStats = {
	/**
	 * Files changed.
	 */
	files: number,
	/**
	 * Lines added.
	 */
	insertions: number,
	/**
	 * Lines removed.
	 */
	deletions: number,
};

/**
 * Params of `agent/file`.
 */
export type AgentFileParams = {
	/**
	 * The run.
	 */
	runId: RunId,
	/**
	 * The file's path, relative to the repository root, as `agent/diff` lists it: no leading
	 * `/`, no `.` or `..` or empty component, no backslash, and nothing under `.git`.
	 */
	path: string,
	/**
	 * Which side to read.
	 */
	side: AgentFileSide,
	/**
	 * Whether to leave the content out and answer only `exists` and `size`, as a file system's
	 * `stat` needs. Absent means false.
	 */
	sizeOnly?: boolean,
};

/**
 * Which side of a run's diff to read.
 *
 * A newer client may send a side this version does not know; plxd refuses it.
 */
export type AgentFileSide = "base" | "head";

/**
 * Result of `agent/file`.
 */
export type AgentFileResult = {
	/**
	 * The path as asked.
	 */
	path: string,
	/**
	 * The side as asked.
	 */
	side: AgentFileSide,
	/**
	 * The commit it was read from.
	 */
	commit: string,
	/**
	 * Whether the file exists on that side. An added file has no base side, and a deleted file
	 * no head side.
	 */
	exists: boolean,
	/**
	 * Its size in bytes, when it exists.
	 */
	size?: number,
	/**
	 * Its exact content, base64-encoded, when it exists, is not too large, and `sizeOnly` was not
	 * asked. A symlink's
	 * content is its target, as git stores it; it is never followed.
	 */
	content?: string,
	/**
	 * Whether it is over `agent/file`'s size cap, so `content` is absent.
	 */
	tooLarge: boolean,
};

/**
 * Params of `agent/accept`.
 *
 * Idempotent on `id`: accepting an accepted run again with the same id returns the same result;
 * with another id it fails with `runAccepted`.
 */
export type AgentAcceptParams = {
	/**
	 * The run.
	 */
	runId: RunId,
	/**
	 * The accept's id, a version 7 UUID generated by the client.
	 */
	id: AcceptId,
	/**
	 * The commit the user reviewed, `agent/diff`'s `head`. When it is given and the run has
	 * committed since, the accept fails with `mergeRefused` instead of merging changes nobody
	 * reviewed.
	 */
	commit?: string,
};

/**
 * An `agent/accept`'s id: a version 7 UUID that the client generates once and sends again on
 * every retry, so a retry after a lost connection gets the same answer.
 */
export type AcceptId = string;

/**
 * Result of `agent/accept`.
 */
export type AgentAcceptResult = {
	/**
	 * The run, now `accepted`.
	 */
	run: AgentRun,
	/**
	 * What happened to the project's repository.
	 */
	merge: AgentMerge,
};

/**
 * Params of `agent/requestChanges`: the reviewer's follow-up to a run, sent to it as
 * `agent/send` sends a message, and idempotent on `turnId` the same way.
 */
export type AgentRequestChangesParams = {
	/**
	 * The run.
	 */
	runId: RunId,
	/**
	 * The message's id, a version 7 UUID generated by the client.
	 */
	turnId: TurnId,
	/**
	 * What to change.
	 */
	text: string,
};

/**
 * Params of `agent/openPr` (RYA-168): plxd pushes the run's branch to the repository's `origin`
 * on the host, as the user, and opens a pull request for it against the GitHub repository's
 * default branch with `gh`.
 *
 * Idempotent: when the branch already has an open pull request, it pushes any new commits and
 * returns that one.
 */
export type AgentOpenPrParams = {
	/**
	 * The run. It must have finished, have a commit, and work in a repository: a thread with no
	 * repo has no `origin`.
	 */
	runId: RunId,
	/**
	 * The pull request's title, such as the thread's. plxd takes its first line, cut to 256
	 * characters.
	 */
	title: string,
	/**
	 * Its description, at most 64 KiB. Absent means empty.
	 */
	body?: string,
};

/**
 * Result of `agent/openPr`.
 */
export type AgentOpenPrResult = {
	/**
	 * The pull request's web URL.
	 */
	url: string,
};

/**
 * Params of `agent/approve`: the user's answer to a run's permission request, from its
 * `approvalRequested`.
 *
 * Idempotent: answering a request that is already resolved changes nothing, and returns how it
 * was resolved, which may be another answer, a timeout, or a cancel. A run started without
 * `approvals` has no requests, so any answer for it fails with `approvalNotFound`.
 */
export type AgentApproveParams = {
	/**
	 * The run.
	 */
	runId: RunId,
	/**
	 * The request.
	 */
	approvalId: ApprovalId,
	/**
	 * Allow or deny.
	 */
	decision: AgentApprovalAnswer,
	/**
	 * With `allow`: the tool's input to run with instead of the one it asked with, a JSON
	 * object of the same shape, at most 1 MiB. Absent runs it as asked.
	 */
	input?: JsonValue,
	/**
	 * With `allow`: also allow what the request's `alwaysAllow` lists, for the rest of the CLI
	 * process. Only for a request whose `alwaysAllow` isn't empty.
	 */
	always?: boolean,
	/**
	 * With `deny`: what to tell the agent, at most 64 KiB. Absent says that the user denied it.
	 */
	message?: string,
};

/**
 * The user's answer to a permission request.
 *
 * A newer peer may send a value this version does not know; treat it as unknown.
 */
export type AgentApprovalAnswer = "allow" | "deny";

/**
 * Result of `agent/approve`: how the request was resolved, as its `approvalResolved` says.
 */
export type AgentApproveResult = {
	/**
	 * What it came to.
	 */
	decision: AgentApprovalDecision,
	/**
	 * Who or what decided it: `user` when this answer, or an earlier one, did.
	 */
	by: AgentApprovalBy,
	/**
	 * True when it was allowed for the rest of the CLI process as well.
	 */
	always?: boolean,
	/**
	 * The user's message to the agent with a denial.
	 */
	message?: string,
};

/**
 * Params of `thread/list`.
 */
export type ThreadListParams = Record<symbol, never>;

/**
 * Result of `thread/list`: every repo entry and every thread. The threads' runs come from
 * `agent/list` with each entry's id.
 */
export type ThreadListResult = {
	/**
	 * Every repo entry, oldest first.
	 */
	repos: Array<Repo>,
	/**
	 * Every thread, oldest first.
	 */
	threads: Array<Thread>,
	/**
	 * The `seq` of the last event the snapshot reflects. Subscribe to host-level events with
	 * `after` set to it.
	 */
	seq: number,
};

/**
 * Params of `repo/add`: registers a repository for normal threads.
 *
 * Idempotent on `id`, and failing with `idConflict` if the same id comes with another path. A
 * path that is already registered returns its existing entry, whatever `id` says. The path must
 * be the top folder of a git working tree on the host, or it fails with `notARepository`.
 */
export type RepoAddParams = {
	/**
	 * The new entry's id, a version 7 UUID generated by the client.
	 */
	id: RepoId,
	/**
	 * The absolute path of the repository on the host.
	 */
	path: string,
};

/**
 * Result of `repo/add`.
 */
export type RepoAddResult = {
	/**
	 * The entry, new or existing.
	 */
	repo: Repo,
};

/**
 * Params of `thread/start`: starts a normal thread's agent in its own worktree, as `agent/start`
 * starts a worker, with the same sandbox (0013).
 *
 * Idempotent on `runId`: the same id with the same params returns the run; with different
 * params it fails with `idConflict`.
 */
export type ThreadStartParams = {
	/**
	 * The new run's id, a version 7 UUID generated by the client.
	 */
	runId: RunId,
	/**
	 * The repo entry to work in. Absent starts a thread with no repo, in a scratch repository
	 * of its own.
	 */
	repo?: RepoId,
	/**
	 * The first message.
	 */
	prompt: string,
	/**
	 * The account to run on. Absent means the worker role's default (`accounts/defaults/*`).
	 */
	account?: AccountChoice,
	/**
	 * The model, as `agent/start` takes it. Absent means the CLI's default.
	 */
	model?: string,
	/**
	 * How hard the model thinks, as `agent/start` takes it.
	 */
	effort?: AgentEffort,
	/**
	 * How the agent may act inside its sandbox, as `agent/start` takes it.
	 */
	permission?: AgentPermission,
	/**
	 * Names the worktree's branch `parallax/<branchSlug>`: lowercase letters, digits, and hyphens,
	 * no leading or trailing hyphen, at most 40 bytes. A branch that already has the name gets
	 * the run's short id after it. Absent names it `parallax/<short run id>`. Not part of what makes
	 * a retry with the same run id conflict.
	 */
	branchSlug?: string,
	/**
	 * Images for the first message, as `agent/start`'s.
	 */
	images?: Array<PromptImage>,
	/**
	 * Forward the agent's permission requests to the client, as `agent/start` takes it.
	 */
	approvals?: boolean,
	/**
	 * Work in the repo entry's own checkout, on whatever branch it has out, instead of in a new
	 * worktree: the agent's changes land there, uncommitted, and `branchSlug` is ignored. Needs a
	 * `repo`. Behind the `checkout` capability, since an older plxd would silently ignore it and
	 * make a worktree.
	 */
	checkout?: boolean,
};

/**
 * Result of `thread/start`.
 */
export type ThreadStartResult = {
	/**
	 * The thread.
	 */
	thread: Thread,
	/**
	 * Its run, as it stands.
	 */
	run: AgentRun,
};

/**
 * Params of `thread/archive`: archives a thread or brings it back.
 */
export type ThreadArchiveParams = {
	/**
	 * The thread's run id.
	 */
	runId: RunId,
	/**
	 * True to archive it, false to bring it back.
	 */
	archived: boolean,
};

/**
 * Result of `thread/archive`.
 */
export type ThreadArchiveResult = {
	/**
	 * The thread as it stands.
	 */
	thread: Thread,
};

/**
 * Params of `thread/update`: marks a thread seen, or snoozes it (0033), behind the
 * `threadAttention` capability.
 *
 * `seen` sets `seenAt` to plxd's clock now. `snoozedUntil` replaces the snooze; a time in the
 * past ends it. A change appends `thread.updated`; an update that changes nothing appends none.
 * Fails with `threadNotFound` for an unknown thread.
 */
export type ThreadUpdateParams = {
	/**
	 * The thread's run id.
	 */
	runId: RunId,
	/**
	 * True to mark it seen now.
	 */
	seen?: boolean,
	/**
	 * Snoozes it until this time, in RFC 3339 UTC.
	 */
	snoozedUntil?: string,
};

/**
 * Result of `thread/update`.
 */
export type ThreadUpdateResult = {
	/**
	 * The thread as it stands.
	 */
	thread: Thread,
};

/**
 * Params of `repo/update`: sets a repo entry's icon, which replaces the whole icon (0033),
 * behind the `threadAttention` capability. A change appends `repo.updated`. Fails with
 * `repoNotFound` for an unknown entry.
 */
export type RepoUpdateParams = {
	/**
	 * The entry's id.
	 */
	repo: RepoId,
	/**
	 * Its new icon, checked as `project/update` checks a project's.
	 */
	icon: ProjectIcon,
};

/**
 * Result of `repo/update`.
 */
export type RepoUpdateResult = {
	/**
	 * The entry as it stands.
	 */
	repo: Repo,
};

/**
 * Params of `thread/delete`: deletes a thread, its run, its worktree and branch, a thread with
 * no repo's scratch repository, and its stored events.
 *
 * A running CLI is cancelled first, and the delete answers once it has exited and its changes
 * were committed. Deleting a thread that doesn't exist fails with `threadNotFound`.
 */
export type ThreadDeleteParams = {
	/**
	 * The thread's run id.
	 */
	runId: RunId,
};

/**
 * Result of `thread/delete`.
 */
export type ThreadDeleteResult = Record<symbol, never>;

/**
 * Params of `project/start`: starts the project's coordinator chat (0024), behind the
 * `coordinator` capability.
 *
 * The coordinator is a run with policy `noWrite` in the project's repository, whose
 * `coordinatorThread` is its own id. Later messages, Stop, and its transcript go through
 * `agent/send`, `agent/cancel`, and `agent/events`, and its events are the project's `agent.*`
 * events. Idempotent on `runId` like `agent/start`: the same params return the run, and
 * different ones fail with `idConflict`. A project's coordinator is its newest one, which
 * `Project.coordinator` names. A new `runId` starts over: it replaces the coordinator unless that
 * one is starting or running, when it fails with `idConflict`. So a coordinator whose session
 * can't be resumed never locks its project.
 */
export type ProjectStartParams = {
	/**
	 * The project.
	 */
	project: ProjectId,
	/**
	 * The coordinator run's id, a version 7 UUID generated by the client.
	 */
	runId: RunId,
	/**
	 * The user's first message.
	 */
	prompt: string,
	/**
	 * The account to run on. Absent means the coordinator role's default
	 * (`accounts/defaults/*`). Only a backend that can coordinate takes it: Claude Code.
	 */
	account?: AccountChoice,
	/**
	 * The model, as `agent/start`'s. Absent means the CLI's default.
	 */
	model?: string,
	/**
	 * How hard the model thinks, as `agent/start`'s. Absent means the CLI's default.
	 */
	effort?: AgentEffort,
	/**
	 * The permission mode, as `agent/start`'s (RYA-188). Absent means the backend's default.
	 */
	permission?: AgentPermission,
	/**
	 * Images for the first message, as `agent/start`'s.
	 */
	images?: Array<PromptImage>,
	/**
	 * Forward the coordinator's permission requests to the client, as `agent/start` takes it.
	 * The runs it spawns forward theirs too.
	 */
	approvals?: boolean,
};

/**
 * Params of `project/update`: renames a project or sets its icon, behind the `projectEdit`
 * capability (RYA-227, 0032).
 *
 * A field that is absent stays as it is, and `icon` replaces the whole icon. `name` follows
 * `project/create`'s rules, and the repository can't change. A rename or a new icon is not
 * activity, so `updatedAt` stays as it is. Fails with `projectNotFound` for an unknown project.
 * A change appends `project.updated`; an update that changes nothing appends no event.
 */
export type ProjectUpdateParams = {
	/**
	 * The project.
	 */
	project: ProjectId,
	/**
	 * The new name. Absent keeps the name.
	 */
	name?: string,
	/**
	 * The new icon. Absent keeps the icon, and so does `null`: an icon can't be removed (0032).
	 */
	icon?: ProjectIcon,
};

/**
 * Result of `project/update`.
 */
export type ProjectUpdateResult = {
	/**
	 * The project as it stands after the update.
	 */
	project: Project,
};

/**
 * Params of `$/cancelRequest`.
 */
export type CancelRequestParams = {
	/**
	 * The id of the request to cancel.
	 */
	id: RequestId,
};

/**
 * A request id, chosen by the sender: an integer or a string.
 */
export type RequestId = number | string;

/**
 * Params of `events/event`: one event from plxd's event log.
 */
export type EventsEventParams = {
	/**
	 * The subscription it belongs to.
	 */
	subscription: SubscriptionId,
	/**
	 * The event's position in plxd's log. It increases by one for every change on the host,
	 * across all projects.
	 */
	seq: number,
	/**
	 * When the change happened, in RFC 3339 UTC.
	 */
	time: string,
	/**
	 * The project it belongs to. Absent for host-level events.
	 */
	project?: ProjectId,
	/**
	 * What happened.
	 */
	event: ParallaxEvent,
};

/**
 * The `data` of a Parallax error (code -32000).
 */
export type ErrorData = {
	/**
	 * What went wrong.
	 */
	kind: ErrorKind,
	/**
	 * More about it, in a shape that depends on `kind`.
	 */
	detail?: JsonValue,
};

/**
 * What went wrong, in a Parallax error's `data.kind`. Receivers match on it, never on the message.
 *
 * A newer plxd may send kinds that are not listed here. Treat those as unknown errors, so a
 * `switch` over this type must not end in an exhaustiveness assertion.
 */
export type ErrorKind = "notInitialized" | "incompatibleProtocol" | "resyncRequired" | "projectNotFound" | "accountNotFound" | "keychainUnavailable" | "idConflict" | "contextNotFound" | "contextTooLarge" | "notARepository" | "runNotFound" | "runNotResumable" | "workerUnavailable" | "worktreeFailed" | "runAccepted" | "mergeRefused" | "mergeConflict" | "repoNotFound" | "threadNotFound" | "noDefaultAccount" | "unsupportedOption" | "prRefused" | "pushFailed" | "ghUnavailable" | "prFailed" | "imageTooLarge" | "imageNotFound" | "approvalNotFound";

/**
 * The `detail` of `incompatibleProtocol`. Its shape never changes, so every client can read it
 * from every plxd.
 */
export type IncompatibleProtocolDetail = {
	/**
	 * The versions the client asked for.
	 */
	requested: ProtocolRange,
	/**
	 * The versions plxd speaks.
	 */
	supported: ProtocolRange,
	/**
	 * plxd's release version, so the client can say which side to update.
	 */
	plxd: string,
};
