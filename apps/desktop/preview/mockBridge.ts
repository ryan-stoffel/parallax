// A `window.parallax` for the browser preview: every ParallaxBridge member, answering plxd methods
// from fixtures.ts held in memory. Writes that are cheap to fake change that state and emit the
// events plxd would, so a sent message or an answered question shows up as it does in the app.
import { pullRequestHandlers } from "./pullRequests";
import {
  iconFor,
  type AccessPrompt,
  type ConnectionState,
  type ConnectState,
  type DeviceHost,
  type DeviceIcon,
  type HostResponse,
  type LanHost,
  type ParallaxBridge,
  type Profile,
  type RendererMethod,
  type RpcError,
  type SubscribeParams,
  type SubscriptionMessage,
  type TerminalMessage,
  type UpdateState,
  type WatchMessage,
  type WatchParams,
} from "../src/preload/bridge";
import {
  PROTOCOL_VERSION,
  type AgentBackgroundTask,
  type AgentOutputItem,
  type AgentRun,
  type Capabilities,
  type EventsEventParams,
  type ImportableSession,
  type JsonValue,
  type RelayHost,
  type RemoteSession,
  type RepoScript,
  type ScheduledTask,
  type LoggedEvent,
  type MemoryScope,
  type ParallaxEvent,
  type ParallaxRequests,
  type ProviderInfo,
  type ShellSnapshot,
  type Repo,
  type TailnetDevice,
  type Thread,
  type ThreadRun,
  type ThreadSnapshot,
} from "../src/protocol/generated/protocol";
import { createFixtures, HOME, ids, PARALLAX_PATH, uploadSeeds, type RunEvent } from "./fixtures";

const LOCAL = "local";
const LOG_ID = "0199a6f0-0000-7000-8000-preview00log";

/** What plxd's `capabilities_advertised` lists (daemon/src/methods/host.rs), with the same caps. */
const capabilities: Capabilities = Object.fromEntries(
  [
    "accountHomes",
    "accounts",
    "agentClis",
    "agentReview",
    "agentWait",
    "agents",
    "approvals",
    "autoResume",
    "checkpoints",
    "checks",
    "checkout",
    "claudeRemoteControl",
    "claudeRemoteControlMove",
    "commandIds",
    "composerMenus",
    "computerUse",
    "contextAndFast",
    "orchestrator",
    "orchestratorEpochs",
    "eventFilters",
    "files",
    "git",
    "repoGitStatus",
    "repoGrep",
    "githubSetup",
    "githubStatus",
    "hostFolders",
    "inbox",
    "integrationBranch",
    "landing",
    "memory",
    "openPr",
    "orchestration",
    "pins",
    "prActions",
    "prDiff",
    "prGuide",
    "prWatch",
    "orchestratorAutonomy",
    "orchestratorDelete",
    "orchestratorEdit",
    "orchestratorFromThreads",
    "orchestratorPermission",
    "orchestratorPlacement",
    "orchestratorTasks",
    "providerUpdates",
    "providers",
    "pullRequests",
    "queue",
    "questions",
    "repoClone",
    "repoRefs",
    "runOptions",
    "schedules",
    "sendAccount",
    "sendModel",
    "sendOptions",
    "setupScripts",
    "projectContext",
    "projectThreads",
    "projects",
    "threadAttention",
    "threadFork",
    "threadImport",
    "threadImportRemote",
    "threadLineage",
    "threadNaming",
    "threadTools",
    "threads",
  ].map((name) => [name, {}]),
);
capabilities["fileUploads"] = { maxBytes: 6 * 1024 * 1024 };
capabilities["iconImages"] = { maxBytes: 64 * 1024 };
capabilities["promptImages"] = {
  maxImages: 10,
  maxImageBytes: 5 * 1024 * 1024,
  maxTotalBytes: 6 * 1024 * 1024,
};
capabilities["threadContext"] = { maxThreads: 8, maxSummaryBytes: 32 * 1024 };

const connected: ConnectionState = {
  status: "connected",
  plxd: "0.0.0-preview",
  protocol: PROTOCOL_VERSION,
  capabilities,
};

// ---- State -------------------------------------------------------------------------------------

const db = createFixtures();
let seq = 0;
const logs = new Map<string, LoggedEvent[]>();
const runOf = (id: string) => db.runs.find((r) => r.id === id);
/** A run's scope, as its events carry it: its orchestrator, or its thread's repo entry. */
const scopeOf = (runId: string) => runOf(runId)?.project;

function number(runId: string, list: RunEvent[]) {
  const orchestrator = scopeOf(runId);
  logs.set(
    runId,
    list.map((e) => ({
      seq: ++seq,
      time: e.time,
      ...(orchestrator && { orchestrator }),
      event: e.event,
    })),
  );
}
// Oldest run first, so seqs rise with time across runs, roughly as plxd's log does.
for (const run of [...db.runs].sort((a, b) => a.createdAt.localeCompare(b.createdAt)))
  number(run.id, db.events[run.id] ?? []);

type Listener = {
  id: string;
  /** The host it subscribed on: a run's events go to its own host's listeners. */
  host: string;
  /** What it gets of an event, if anything, as plxd's cursor filters and cuts it. */
  view: (logged: LoggedEvent) => LoggedEvent | undefined;
  after: number;
  listener: (m: { type: "event"; event: EventsEventParams }) => void;
};
let subscriptions = 0;
const listeners = new Set<Listener>();

// What "Rework the updater" waits on (PLX-777): a Monitor on its CI, a subagent in the background
// (PLX-929), and plxd's watch of its pull request. Stop ends any, with the event plxd would send.
const background = new Map<string, AgentBackgroundTask[]>([
  [
    ids.updater,
    [
      { taskId: "monitor-1", kind: "monitor", description: "Watching CI on pull request #588" },
      {
        taskId: "agent-1",
        kind: "agent",
        description: "Review the updater channel change",
        callId: "toolu_updater_review",
      },
    ],
  ],
]);
const watching = new Map([[ids.updater, ["https://github.com/ryan-stoffel/parallax/pull/588"]]]);
// "Tahoe icon variants" has a message queued behind its turn, which its composer's tab lists.
const queued = new Map<string, ThreadRun[]>([
  [
    ids.tahoe,
    [
      {
        id: "queued-1",
        status: "queued",
        position: 0,
        text: "Then export a 16 px favicon from the same glyph.",
        images: 0,
        threads: [],
      },
    ],
  ],
]);

/** Logs and delivers an event, as plxd does: a run's to its scope, a host-level one to the host. */
function emit(event: ParallaxEvent, orchestrator?: string) {
  const logged: LoggedEvent = {
    seq: ++seq,
    time: new Date().toISOString(),
    ...(orchestrator && { orchestrator }),
    event,
  };
  if ("runId" in event && event.kind.startsWith("agent.")) {
    const list = logs.get(event.runId) ?? [];
    list.push(logged);
    logs.set(event.runId, list);
  }
  const host =
    "runId" in event ? hostOf(event.runId) : "thread" in event ? hostOf(event.thread.id) : LOCAL;
  for (const l of listeners) {
    const seen = l.host === host && logged.seq > l.after ? l.view(logged) : undefined;
    if (seen)
      setTimeout(() => l.listener({ type: "event", event: { subscription: l.id, ...seen } }));
  }
  return logged;
}

const isRequest = (i: AgentOutputItem) =>
  i.kind === "approvalRequested" ||
  i.kind === "approvalResolved" ||
  i.kind === "secretRequested" ||
  i.kind === "secretResolved";

/** A shell's view of an event, as plxd's `shell` filter has it: output only for its requests. */
function shellView(logged: LoggedEvent): LoggedEvent | undefined {
  const { event } = logged;
  if (event.kind !== "agent.output") return logged;
  const items = event.items.filter(isRequest);
  return items.length ? { ...logged, event: { ...event, items } } : undefined;
}

/** The permission requests `runIds` wait on, each an `agent.output` of its own, oldest first. */
function waiting(runIds: string[]): LoggedEvent[] {
  return runIds.flatMap((id) => {
    const open = new Map<string, LoggedEvent>();
    for (const logged of logs.get(id) ?? []) {
      const { event } = logged;
      if (event.kind === "agent.finished") open.clear();
      if (event.kind !== "agent.output") continue;
      for (const item of event.items) {
        if (item.kind === "approvalRequested")
          open.set(item.approvalId, { ...logged, event: { ...event, items: [item] } });
        if (item.kind === "approvalResolved") open.delete(item.approvalId);
        if (item.kind === "secretRequested")
          open.set(item.requestId, { ...logged, event: { ...event, items: [item] } });
        if (item.kind === "secretResolved") open.delete(item.requestId);
      }
    }
    return [...open.values()];
  });
}

const now = () => new Date().toISOString();

const computer = {
  accessibility: true,
  screenRecording: false,
  program: "plxd",
  apps: ["Notes", "Xcode"],
};

// ---- Checkpoints (0062) ------------------------------------------------------------------------

/** What the updater thread's first turn changed, as `git diff` between its checkpoints. */
const UPDATER_PATCH = `diff --git a/.github/workflows/release.yml b/.github/workflows/release.yml
--- a/.github/workflows/release.yml
+++ b/.github/workflows/release.yml
@@ -88,6 +88,9 @@ jobs:
       - name: Build the installer
         run: corepack pnpm --dir apps/desktop build
+      - name: Stamp the channel
+        # A nightly follows nightlies, a promoted build Latest (0028).
+        run: echo "channel: \${{ inputs.channel }}" >> apps/desktop/dist/app-update.yml
       - name: Sign
         run: scripts/release/sign
diff --git a/apps/desktop/src/main/updater.ts b/apps/desktop/src/main/updater.ts
--- a/apps/desktop/src/main/updater.ts
+++ b/apps/desktop/src/main/updater.ts
@@ -12,11 +12,14 @@ import { autoUpdater } from "electron-updater";
 
 export function startUpdater(window: BrowserWindow) {
-  // Both builds read Latest.
-  autoUpdater.channel = "latest";
+  // The build's own channel, which the release workflow stamps into app-update.yml.
+  const channel = readChannel() ?? "latest";
+  autoUpdater.channel = channel;
+  autoUpdater.allowPrerelease = channel === "nightly";
   autoUpdater.autoDownload = true;
   autoUpdater.on("update-downloaded", () => window.webContents.send("update:ready"));
   void autoUpdater.checkForUpdates();
 }
diff --git a/apps/desktop/src/renderer/Update.tsx b/apps/desktop/src/renderer/Update.tsx
--- a/apps/desktop/src/renderer/Update.tsx
+++ b/apps/desktop/src/renderer/Update.tsx
@@ -30,9 +30,4 @@ export function Update({ version }: { version: string }) {
-  // A nightly's version ends in -nightly; anything else is stable.
-  const nightly = /-nightly(\\.\\d+)?$/.test(version);
-  if (nightly && !ready) return null;
   return (
     <button type="button" onClick={install}>
`;

/** Each thread's turns with their checkpoints: the updater thread's, from its log. */
const checkpointRuns = new Map<string, ThreadRun[]>();
const sessionOf = (threadId: string) => runOf(threadId)?.sessionId;
function turnsOf(threadId: string): ThreadRun[] {
  if (db.threads.find((t) => t.id === threadId)?.title !== "Rework the updater") return [];
  if (!checkpointRuns.has(threadId)) {
    const started = (logs.get(threadId) ?? []).flatMap(({ event }) =>
      event.kind === "agent.output" ? event.items.filter((i) => i.kind === "turnStarted") : [],
    );
    checkpointRuns.set(
      threadId,
      started.map((turn, i) => ({
        id: turn.turnId ?? `${threadId}-1`,
        status: "completed",
        ordinal: i + 1,
        ...(turn.text && { text: turn.text }),
        images: 0,
        threads: [],
        // Where Claude's session stood after the turn, which Edit from here goes back to.
        cursor: `entry-${i + 1}`,
        ...(sessionOf(threadId) && { sessionId: sessionOf(threadId) }),
        checkpoint: {
          status: "ready",
          files:
            i === 0
              ? [
                  { path: ".github/workflows/release.yml", additions: 3, deletions: 0 },
                  { path: "apps/desktop/src/main/updater.ts", additions: 4, deletions: 2 },
                  { path: "apps/desktop/src/renderer/Update.tsx", additions: 0, deletions: 3 },
                ]
              : [],
        },
      })),
    );
  }
  return checkpointRuns.get(threadId)!;
}
const later = (ms: number, f: () => void) => setTimeout(f, ms);

function patchRun(id: string, change: Partial<AgentRun>) {
  const run = runOf(id);
  if (!run) return undefined;
  Object.assign(run, change, { updatedAt: now() });
  const {
    status,
    accountId,
    backend,
    sessionId,
    error,
    diff,
    model,
    effort,
    contextWindow,
    fast,
    permission,
    pullRequests,
    updatedAt,
  } = run;
  emit(
    {
      kind: "agent.updated",
      runId: id,
      state: {
        status,
        accountId,
        backend,
        sessionId,
        error,
        diff,
        model,
        effort,
        contextWindow,
        fast,
        permission,
        pullRequests,
        updatedAt,
      },
    },
    run.project,
  );
  return run;
}

function output(runId: string, ...items: AgentOutputItem[]) {
  emit({ kind: "agent.output", runId, items }, scopeOf(runId));
}

/** What every faked turn answers: plxd isn't here, so nothing reached an agent. */
const previewReply =
  "This is the Parallax preview: there's no plxd behind it, so nothing was sent to an agent. Everything you see is fixture data.";

let fakeCall = 0;

/**
 * Runs a faked turn on `runId`: its message, then a few seconds of work as an agent's would come
 * in (a thought, calls and their results, a message between them), a short reply, and its end.
 */
function fakeTurn(runId: string, turnId: string | undefined, text: string | undefined) {
  patchRun(runId, { status: "running" });
  output(runId, { kind: "turnStarted", ...(turnId && { turnId }), ...(text && { text }) });
  const call = (at: number, ms: number, name: string, input: JsonValue) => {
    const callId = `toolu_preview_${++fakeCall}`;
    later(at, () => output(runId, { kind: "toolCall", callId, name, input }));
    later(at + ms, () => output(runId, { kind: "toolResult", callId, status: "ok", output: "…" }));
  };
  // Each model request reports its context and cache use as Claude's would, with the last turn's
  // speed sample until this turn's result brings a new one.
  const run = runOf(runId);
  const last = [...(logs.get(runId) ?? [])]
    .reverse()
    .flatMap((e) => (e.event.kind === "agent.output" ? [...e.event.items].reverse() : []))
    .find((item) => item.kind === "requestUsage");
  const base = last?.kind === "requestUsage" ? last.usage : undefined;
  const request = (at: number, grow: number, speed?: [number, number]) =>
    run &&
    later(at, () => {
      const contextTokens = (base?.contextTokens ?? 40_000) + grow;
      output(runId, {
        kind: "requestUsage",
        backend: run.backend,
        accountId: run.accountId,
        usage: {
          ...base,
          model: run.model,
          contextTokens,
          inputTokens: contextTokens,
          cachedInputTokens: contextTokens - 2_400,
          contextWindow: run.contextWindow,
          ...(speed && { outputTokens: speed[0], outputMs: speed[1] }),
        },
      });
    });
  request(1000, 2_100);
  request(2050, 5_600);
  request(3400, 9_800);
  request(5200, 14_300);
  request(7500, 16_900, [2_460, 26_800]);
  later(600, () =>
    output(runId, {
      kind: "reasoning",
      text: "Start with what changed on the branch, then read the file the message names.",
    }),
  );
  call(1100, 900, "Bash", { command: "git status --short" });
  call(2100, 600, "Read", { file_path: "apps/desktop/src/renderer/AgentChat.tsx" });
  call(2800, 500, "Grep", { pattern: "groupWork", path: "apps/desktop/src" });
  later(3500, () =>
    output(runId, { kind: "text", text: "Found where the work rows are built. Editing it now." }),
  );
  call(4200, 900, "Edit", { file_path: "apps/desktop/src/renderer/transcript.ts" });
  call(5300, 1800, "Bash", { command: "pnpm exec vp test run src/renderer" });
  later(7600, () => {
    output(runId, { kind: "text", text: previewReply }, { kind: "turnFinished" });
    const run = patchRun(runId, { status: "completed" });
    if (run) emit({ kind: "agent.finished", runId, outcome: { status: "completed" } }, run.project);
  });
}

function startRun(run: AgentRun, thread?: Thread) {
  db.runs.push(run);
  logs.set(run.id, []);
  emit({ kind: "agent.started", runId: run.id, run }, run.project);
  if (thread) {
    db.threads.push(thread);
    emit({ kind: "thread.started", thread });
  }
  later(300, () => fakeTurn(run.id, undefined, undefined));
}

const scopeKey = (scope: MemoryScope) =>
  scope.kind === "you" ? "you" : `${scope.kind}:${scope.id}`;

// ---- Requests ----------------------------------------------------------------------------------

type Method = RendererMethod;
type Params<M extends Method> = ParallaxRequests[M]["params"];
type Result<M extends Method> = ParallaxRequests[M]["result"];
type Handler<M extends Method> = (params: Params<M>) => Result<M> | RpcError;

const fail = (message: string, kind?: string): RpcError => ({
  code: -32000,
  message,
  ...(kind && { data: { kind } as RpcError["data"] }),
});
const isError = (v: unknown): v is RpcError =>
  !!v && typeof v === "object" && "code" in v && "message" in v && !("result" in v);

const runResult = (runId: string) => {
  const run = runOf(runId);
  return run ? { run } : fail(`no run has id ${runId}`, "runNotFound");
};
const threadResult = (runId: string, change: Partial<Thread> = {}) => {
  const thread = db.threads.find((t) => t.id === runId);
  if (!thread) return fail(`no thread has run id ${runId}`, "threadNotFound");
  Object.assign(thread, change);
  emit({ kind: "thread.updated", thread });
  return { thread };
};

// Remote pairing (PLX-641): this computer's switch and the sessions of computers paired with it,
// and the computers this app paired with.
const lan = { on: false, relay: false, sessions: [] as RemoteSession[], hosts: [] as LanHost[] };
let relayHosts: RelayHost[] = [
  {
    hostId: "tX7O-_vCPIBZoydFYwEZwysPFXJgEwKcg_pLNX-XhFE",
    name: "macbook",
    online: true,
    thisComputer: true,
  },
  {
    hostId: "alfEbFC1hWlmHpbBo55sMKZ0PQ_RqGqTzdoMYJy-m6o",
    name: "macbook",
    online: false,
    thisComputer: false,
  },
];
const relayStatus = () => ({
  connected: true,
  hookUrl: "https://relay.parallax.codes/v1/hooks/tX7O-_vCPIBZoydFYwEZwysPFXJgEwKcg_pLNX-XhFE",
});
const hostsListeners = new Set<(hosts: LanHost[]) => void>();
const isLanHost = (hostId: string) => lan.hosts.some((h) => h.id === hostId);

// Scheduled tasks (0063), as agents create them with `schedule_task`.
const minutesFromNow = (minutes: number) => new Date(Date.now() + minutes * 60_000).toISOString();
let schedules: ScheduledTask[] = [
  {
    id: "0199c7a0-5f1e-7b3a-8c4d-2e6f8a0b1c2d",
    title: "Babysit the nightly build",
    prompt: "Check last night's nightly release. If a job failed, find why and open a fix.",
    enabled: true,
    schedule: { type: "fixed_time", timeOfDay: "07:30", weekdays: [1, 2, 3, 4, 5] },
    thread: db.threads[0]?.id,
    nextRunAt: minutesFromNow(14 * 60),
    lastRunAt: minutesFromNow(-10 * 60),
    lastRunStatus: "succeeded",
    runCount: 12,
    createdAt: minutesFromNow(-20 * 24 * 60),
  },
  {
    id: "0199c7a0-5f1e-7b3a-8c4d-2e6f8a0b1c2e",
    title: "Release notes",
    prompt: "Write release notes for {{body.release.tag_name}} from its merged pull requests.",
    enabled: true,
    schedule: {
      type: "webhook",
      signature: { header: "x-hub-signature-256", encoding: "hex", prefix: "sha256=" },
    },
    lastRunAt: minutesFromNow(-3 * 24 * 60),
    lastRunStatus: "succeeded",
    runCount: 4,
    webhook: {
      path: "/api/hooks/0199c7a0-5f1e-7b3a-8c4d-2e6f8a0b1c2e/k3Jx9Qm2bW7",
      url: "https://192.168.1.20:7341/api/hooks/0199c7a0-5f1e-7b3a-8c4d-2e6f8a0b1c2e/k3Jx9Qm2bW7",
      hasSecret: true,
    },
    createdAt: minutesFromNow(-9 * 24 * 60),
  },
  {
    id: "0199c7a0-5f1e-7b3a-8c4d-2e6f8a0b1c2f",
    title: "Dependency sweep",
    prompt: "Update outdated dependencies and run the tests.",
    enabled: false,
    schedule: { type: "interval", everyMs: 7 * 24 * 60 * 60_000 },
    lastRunAt: minutesFromNow(-8 * 24 * 60),
    lastRunStatus: "failed",
    lastRunError: "no account was named, and the worker role has no default",
    runCount: 1,
    createdAt: minutesFromNow(-30 * 24 * 60),
  },
];

// Each repository's saved scripts, and the parallax.json the docs site checks in (PLX-650).
const repoScripts = new Map<string, RepoScript[]>([
  [
    db.repos[1]!.id,
    [
      {
        id: "install",
        name: "Install",
        command: "pnpm install --frozen-lockfile",
        runOnWorktreeCreate: true,
        async: false,
      },
      { id: "clean", name: "Clean", command: "rm -rf dist .astro", runOnSettle: true },
    ],
  ],
]);
const fileScripts: RepoScript[] = [
  { id: "dev-server", name: "Dev server", command: "pnpm dev --port 4321" },
  { id: "link-check", name: "Link check", command: "pnpm lychee docs", runOnSettle: true },
];

// Files `host/upload` took, by path, for `host/readUpload`.
const uploads = new Map<string, string>(Object.entries(uploadSeeds));

/**
 * The Claude Code sessions `claude remote-control` served on other computers, which claude.ai
 * keeps (`thread/importable` with `remote`, PLX-1136). plxd reads each through Claude Code, so
 * listing them takes a moment.
 */
const remoteImportable: ImportableSession[] = [
  {
    source: "claude",
    id: "session_01r1",
    title: "Hello from Claude RC",
    cwd: "/Users/ryan/Developer/learn-rust",
    updatedAt: ago(5),
    remote: true,
  },
  {
    source: "claude",
    id: "session_01r2",
    title: "Upgrade the homelab Postgres",
    cwd: "C:\\Users\\ryan\\life\\orchestrators\\homelab",
    updatedAt: ago(40),
    remote: true,
  },
  {
    source: "claude",
    id: "session_01r3",
    title: "Port the lexer to Rust",
    cwd: "/Users/ryan/Developer/learn-rust",
    updatedAt: ago(190),
    remote: true,
  },
  {
    source: "claude",
    id: "session_01r4",
    title: "Write the backup cron script",
    cwd: "C:\\Users\\ryan\\life\\orchestrators\\homelab",
    updatedAt: ago(60 * 30),
    remote: true,
  },
];

/** This computer's past Claude, Codex, and Cursor app sessions (`thread/importable`). */
const importable: ImportableSession[] = [
  {
    source: "claude",
    id: "c1",
    title: "Rework the updater",
    cwd: `${HOME}/Developer/parallax`,
    updatedAt: ago(12),
  },
  {
    source: "codex",
    id: "x1",
    title: "Draft the M4 release notes",
    cwd: `${HOME}/Developer/parallax`,
    updatedAt: ago(140),
  },
  {
    source: "claude",
    id: "c2",
    title: "Fix flaky webhook retry test",
    cwd: `${HOME}/Developer/acme-api`,
    updatedAt: ago(860),
  },
  {
    source: "cursor",
    id: "u1",
    title: "Tidy the docs-site sidebar",
    cwd: `${HOME}/Developer/docs-site`,
    updatedAt: ago(2000),
  },
];

const handlers: { [M in Method]?: Handler<M> } = {
  "repo/scripts": (p) => ({
    scripts: repoScripts.get(p.repo) ?? [],
    fileScripts: p.repo === db.repos[1]!.id ? fileScripts : [],
  }),
  "repo/saveScripts": (p) => {
    const ids = new Set<string>();
    const scripts = p.scripts.map((script) => {
      const base = script.name.toLowerCase().replace(/[^a-z0-9]+/g, "-") || "script";
      let id = base;
      for (let n = 2; ids.has(id); n++) id = `${base}-${n}`;
      ids.add(id);
      return { ...script, id };
    });
    repoScripts.set(p.repo, scripts);
    return { scripts, fileScripts: p.repo === db.repos[1]!.id ? fileScripts : [] };
  },
  "schedule/list": () => ({ tasks: schedules }),
  "schedule/save": (p) => {
    const task = { ...schedules.find((t) => t.id === p.id)!, ...p, id: p.id! };
    schedules = schedules.map((t) => (t.id === task.id ? task : t));
    return task;
  },
  "schedule/run": (p) => {
    const task = schedules.find((t) => t.id === p.id)!;
    Object.assign(task, { lastRunAt: new Date().toISOString(), runCount: task.runCount + 1 });
    return task;
  },
  "schedule/delete": (p) => {
    schedules = schedules.filter((t) => t.id !== p.id);
    return { deleted: true };
  },
  "host/settings/get": () => ({
    autoResume: true,
    connect: !!connect.on,
    remote: lan.on,
    relay: lan.relay,
    deviceIcon: connect.icon,
  }),
  "host/settings/set": (p) => {
    lan.on = p.remote ?? lan.on;
    lan.relay = p.relay ?? lan.relay;
    return {
      autoResume: p.autoResume ?? true,
      connect: p.connect ?? !!connect.on,
      remote: lan.on,
      relay: lan.relay,
      deviceIcon: connect.icon,
    };
  },
  "remote/pair": () => {
    // The other computer pairs a few seconds later, as someone pasting the link would.
    setTimeout(() => {
      if (lan.sessions.length) return;
      const createdAt = new Date().toISOString();
      lan.sessions.push({ id: "s1", name: "Ryan's MacBook Air", createdAt });
    }, 6000);
    return {
      code: "7KQ-4M2",
      expiresAt: new Date(Date.now() + 300_000).toISOString(),
      name: "macbook",
      addresses: ["192.168.1.20", "100.87.92.42"],
    };
  },
  "remote/sessions": () => ({
    sessions: lan.sessions,
    listening: lan.on,
    pairing: lan.on && !lan.sessions.length,
    ...(lan.relay && { relay: relayStatus() }),
  }),
  "connect/devices": () => ({
    tailscale: "running",
    port: 7340,
    listening: !!connect.on,
    self: {
      id: "nBook3Vd8",
      hostName: "macbook",
      dnsName: "macbook.tail1a2b3.ts.net",
      os: "macOS",
      ip: "100.87.92.42",
      online: true,
      parallax: !!connect.on,
    },
    devices: tailnet.map(
      ({ name: _n, icon: _i, threads: _t, repos: _p, off: _o, removed: _r, ...device }) => device,
    ),
  }),

  "orchestrator/list": () => ({ orchestrators: db.orchestrators, seq }),
  "orchestrator/create": (p) => {
    const orchestrator = {
      id: p.id,
      name: p.name,
      repoPath: p.repoPath,
      branch: "main",
      ...(p.icon && { icon: p.icon }),
      permission: p.permission ?? "auto",
      autonomy: p.autonomy ?? "ask",
      createdAt: now(),
      updatedAt: now(),
    };
    db.orchestrators.push(orchestrator);
    db.inbox[p.id] = [];
    db.questions[p.id] = [];
    db.context[p.id] = [];
    emit({ kind: "orchestrator.created", orchestrator });
    return { orchestrator };
  },
  "orchestrator/update": (p) => {
    const orchestrator = db.orchestrators.find((x) => x.id === p.orchestrator);
    if (!orchestrator) return fail("no such orchestrator", "orchestratorNotFound");
    const { orchestrator: _, ...change } = p;
    Object.assign(orchestrator, change);
    emit({ kind: "orchestrator.updated", orchestrator });
    return { orchestrator };
  },
  "orchestrator/delete": (p) => {
    db.orchestrators = db.orchestrators.filter((x) => x.id !== p.orchestrator);
    emit({ kind: "orchestrator.deleted", orchestrator: p.orchestrator });
    return {};
  },
  // Ends the orchestrator's session: its next message starts the next epoch (0079).
  "orchestrator/fresh": (p) => {
    const orchestrator = db.orchestrators.find((x) => x.id === p.orchestrator);
    if (!orchestrator) return fail("no such orchestrator", "orchestratorNotFound");
    const run = orchestrator.run ? runOf(orchestrator.run) : undefined;
    if (!run) return fail("no orchestrator run", "runNotFound");
    const epochs = (logs.get(run.id) ?? []).filter(
      (l) => l.event.kind === "agent.output" && l.event.items.some((i) => i.kind === "epoch"),
    ).length;
    patchRun(run.id, { sessionId: undefined });
    emit(
      {
        kind: "agent.output",
        runId: run.id,
        items: [{ kind: "epoch", epoch: epochs + 2, reason: "userFresh" }],
      },
      run.project,
    );
    return { run: { ...run } };
  },
  "orchestrator/start": (p) => {
    const orchestrator = db.orchestrators.find((x) => x.id === p.orchestrator);
    if (!orchestrator) return fail("no such orchestrator", "orchestratorNotFound");
    const run: AgentRun = {
      id: p.runId,
      project: p.orchestrator,
      prompt: p.prompt,
      policy: "noWrite",
      status: "starting",
      backend: "claude",
      accountId: "claude",
      model: p.model ?? "claude-opus-5-5",
      effort: p.effort ?? "high",
      contextWindow: 1_000_000,
      permission: orchestrator.permission ?? "auto",
      approvals: !!p.approvals,
      worktreePath: orchestrator.repoPath,
      createdAt: now(),
      updatedAt: now(),
    };
    orchestrator.run = run.id;
    startRun(run);
    return { run };
  },

  "thread/list": () => ({ repos: db.repos, threads: db.threads, seq }),
  "thread/start": (p) => {
    const orchestrator = p.orchestrator
      ? db.orchestrators.find((x) => x.id === p.orchestrator)
      : undefined;
    const repo = p.orchestrator ?? p.repo ?? db.repos.find((r) => r.scratch)!.id;
    const slug = p.branchSlug ?? p.runId.slice(-8);
    const run: AgentRun = {
      id: p.runId,
      project: repo,
      prompt: p.prompt,
      policy: "workspaceWrite",
      status: "starting",
      backend: p.account?.kind === "subscription" ? p.account.backend : "claude",
      accountId: p.account?.kind === "subscription" ? p.account.backend : "claude",
      ...(!p.checkout && {
        branch: `parallax/${slug}`,
        worktreePath: `${HOME}/.parallax/worktrees/${slug}`,
      }),
      ...(p.checkout && { checkout: true }),
      model: p.model ?? "claude-opus-5-5",
      effort: p.effort ?? "high",
      contextWindow: p.contextWindow ?? 1_000_000,
      ...(p.fast !== undefined && { fast: p.fast }),
      permission: orchestrator ? (orchestrator.permission ?? "auto") : (p.permission ?? "edit"),
      approvals: !!p.approvals || !!orchestrator,
      createdAt: now(),
      updatedAt: now(),
    };
    const thread: Thread = {
      id: p.runId,
      repo,
      createdAt: now(),
      lastPromptAt: now(),
      ...(p.title && { title: p.title }),
      ...(orchestrator?.run && { parent: orchestrator.run }),
      ...(p.parent && { parent: p.parent }),
    };
    startRun(run, thread);
    // As plxd does (0058): a title and a branch from the naming model, a moment later.
    if (p.naming && !p.checkout && p.prompt.trim())
      later(1500, () => {
        const words = p.prompt.trim().split(/\s+/).slice(0, 5);
        threadResult(run.id, { title: words.join(" ").replace(/[.,:;!?]$/, "") });
        const branch = `parallax/${words
          .join("-")
          .toLowerCase()
          .replace(/[^a-z0-9-]/g, "")}`;
        run.branch = branch;
        const { status, accountId } = run;
        emit(
          {
            kind: "agent.updated",
            runId: run.id,
            state: { status, accountId, branch, updatedAt: now() },
          },
          run.project,
        );
      });
    return { thread, run };
  },
  // This computer's past app sessions to import, kept until the page reloads. An import only
  // marks its session imported: the preview makes no archived thread for it.
  "thread/importable": (p) => ({ sessions: p.remote ? remoteImportable : importable }),
  // A Claude Remote Control thread's session, as plxd last listed it (PLX-1140).
  "thread/remoteControl": (p) => ({ session: db.remoteControl[p.runId] }),
  // Where it runs (PLX-1143): Claude Code's own session on the Gaming PC, which that computer's
  // plxd lists once it's set up.
  "thread/remoteControlOrigin": (p) =>
    db.remoteControl[p.runId]
      ? {
          origin: {
            sessionId: `local-${p.runId}`,
            cwd: "C:\\Users\\ryan\\Developer\\learn-rust",
            platform: "win32",
          },
        }
      : {},
  "thread/import": (p) => {
    const session = (p.remote ? remoteImportable : importable).find(
      (s) => s.source === p.source && s.id === p.id,
    );
    if (!session) return fail("no such session");
    session.thread = `imported-${p.id}`;
    return {} as never;
  },
  "thread/fork": (p) => {
    const parent = runOf(p.runId);
    const from = db.threads.find((t) => t.id === p.runId);
    if (!parent || !from) return fail("no such thread", "threadNotFound");
    const run: AgentRun = {
      ...parent,
      id: p.newRunId,
      status: "completed",
      createdAt: now(),
      updatedAt: now(),
    };
    const thread: Thread = {
      id: p.newRunId,
      repo: from.repo,
      createdAt: now(),
      forkedFrom: { run: p.runId, turn: p.turnId ?? "latest" },
      ...(from.title && { title: `${from.title} (fork)` }),
    };
    db.runs.push(run);
    db.threads.push(thread);
    logs.set(
      run.id,
      [...(logs.get(p.runId) ?? [])].map((e) => ({ ...e, event: retarget(e.event, run) })),
    );
    emit({ kind: "thread.started", thread });
    return { thread, run };
  },
  "thread/archive": (p) => threadResult(p.runId, { archived: p.archived }),
  "thread/update": (p) => {
    const { runId, seen, ...rest } = p;
    return threadResult(runId, { ...rest, ...(seen && { seenAt: now() }) });
  },
  "thread/setProject": (p) => {
    const threads = p.threads.map((runId) => {
      const thread = db.threads.find((t) => t.id === runId);
      if (!thread) return undefined;
      if (p.project) thread.project = p.project;
      else delete thread.project;
      emit({ kind: "thread.updated", thread });
      return thread;
    });
    return { threads: threads.filter((t) => t !== undefined) };
  },
  "thread/delete": (p) => {
    const thread = db.threads.find((t) => t.id === p.runId);
    db.threads = db.threads.filter((t) => t.id !== p.runId);
    if (thread) emit({ kind: "thread.deleted", runId: p.runId, repo: thread.repo });
    return {};
  },
  "thread/search": (p) => {
    const q = p.query.toLowerCase();
    const snippets: Record<string, string> = {};
    const threads = db.threads.filter((t) => {
      const prompt = runOf(t.id)?.prompt ?? "";
      const at = prompt.toLowerCase().indexOf(q);
      if (at >= 0)
        snippets[t.id] = (at > 20 ? "…" : "") + prompt.slice(Math.max(0, at - 20), at + 100);
      return t.title?.toLowerCase().includes(q) || at >= 0;
    });
    return { threads, snippets };
  },

  // Every computer has the same folders in the preview.
  "host/folders": (p) => listing(p.path),

  // Kept in memory, at the path plxd would save it at.
  "host/upload": (p) => {
    const path = `${HOME}/.parallax/uploads/${crypto.randomUUID()}/${p.name}`;
    uploads.set(path, p.data);
    return { path };
  },
  "host/readUpload": (p) => {
    const data = uploads.get(p.path);
    if (data === undefined) throw new Error(`${p.path} is not an uploaded file`);
    return { data };
  },

  "repo/add": (p) => {
    const found = db.repos.find((r) => r.path === p.path);
    if (found) return { repo: found };
    const repo = {
      id: p.id,
      name: p.path.split("/").filter(Boolean).at(-1) ?? p.path,
      path: p.path,
      createdAt: now(),
    };
    db.repos.push(repo);
    emit({ kind: "repo.added", repo });
    return { repo };
  },
  "repo/update": (p) => {
    const repo = db.repos.find((r) => r.id === p.repo);
    if (!repo) return fail("no such repo");
    if (p.icon) repo.icon = p.icon;
    if (p.name) repo.name = p.name;
    if (p.instructions !== undefined) {
      const text = p.instructions.trim();
      if (text) repo.instructions = text;
      else delete repo.instructions;
    }
    if (p.files) {
      if (p.files.length) repo.files = [...new Set(p.files)];
      else delete repo.files;
    }
    emit({ kind: "repo.updated", repo });
    return { repo };
  },
  "project/create": (p) => {
    const found = db.repos.find((r) => r.id === p.id);
    if (found) return { repo: found };
    const repo = {
      id: p.id,
      name: p.name.trim(),
      path: `${HOME}/.parallax/spaces/${p.id}`,
      project: true,
      ...(p.icon && { icon: p.icon }),
      createdAt: now(),
    };
    db.repos.push(repo);
    emit({ kind: "repo.added", repo });
    return { repo };
  },
  "project/delete": (p) => {
    db.threads = db.threads.filter((t) => t.repo !== p.project);
    db.repos = db.repos.filter((r) => r.id !== p.project);
    emit({ kind: "repo.removed", repo: p.project });
    return {};
  },
  "repo/refs": () => ({
    refs: [
      { name: "develop", default: true, current: true },
      { name: "main" },
      { name: "parallax/parallax", worktree: true },
      { name: "origin/develop", remote: true, default: true },
      { name: "origin/main", remote: true },
    ],
  }),
  "repo/files": () => ({ files: db.repoFiles, truncated: false }),
  // The fixtures hold no file contents, so every file's path is its one line.
  "repo/grep": (p) => ({
    matches: db.repoFiles
      .filter((path) => path.toLowerCase().includes(p.query.toLowerCase()))
      .map((path) => ({ path, line: 1, text: path })),
    truncated: false,
  }),

  "agent/list": (p) => ({
    runs: p.project ? db.runs.filter((r) => r.project === p.project) : db.runs,
    seq,
  }),
  "agent/events": (p) => {
    const all = (logs.get(p.runId) ?? []).filter((e) => e.seq > p.after);
    const limit = Math.min(p.limit ?? 500, 1000);
    return { events: all.slice(0, limit), more: all.length > limit };
  },
  "agent/start": (p) => {
    const run: AgentRun = {
      id: p.runId,
      project: p.project,
      prompt: p.prompt,
      policy: p.policy,
      status: "starting",
      backend: "claude",
      accountId: "claude",
      branch: `parallax/${p.runId.slice(-8)}`,
      model: p.model ?? "claude-opus-5-5",
      effort: p.effort ?? "high",
      contextWindow: 1_000_000,
      approvals: !!p.approvals,
      createdAt: now(),
      updatedAt: now(),
    };
    startRun(run);
    return { run };
  },
  "agent/send": (p) => {
    const run = runOf(p.runId);
    if (!run) return fail("no such run", "runNotFound");
    const {
      runId: _,
      turnId,
      text,
      images: __,
      threads: ___,
      from: ____,
      delivery: _____,
      ...options
    } = p;
    const change: Partial<AgentRun> = { status: "running" };
    for (const [k, v] of Object.entries(options))
      if (v !== undefined && k !== "account") Object.assign(change, { [k]: v });
    patchRun(p.runId, change);
    later(150, () => fakeTurn(p.runId, turnId, text));
    return { run: { ...run } };
  },
  // Only a message runs here, as agent/send does, and a revert (0062), which undoes the turns
  // after its target and says so, as plxd does. The queue and its other commands aren't faked.
  "orchestration/dispatch": (p) => {
    if (p.type === "checkpoint.rollback") {
      const runs = turnsOf(p.threadId);
      const undone = runs.filter((r) => r.ordinal! > p.ordinal && r.status !== "rolledBack");
      for (const r of undone)
        Object.assign(r, { status: "rolledBack", checkpoint: { status: "stale" } });
      const turns = undone.map((r) => r.id);
      emit(
        {
          kind: "thread.reverted",
          runId: p.threadId,
          ordinal: p.ordinal,
          turns,
          restoreFiles: !!p.restoreFiles,
        },
        scopeOf(p.threadId),
      );
      return { seq };
    }
    if (p.type !== "message.dispatch") return fail(`The preview doesn't fake ${p.type}.`);
    const run = runOf(p.threadId);
    if (!run) return fail("no such run", "runNotFound");
    patchRun(run.id, { status: "running" });
    later(150, () => fakeTurn(run.id, p.messageId, p.text));
    return { seq: 0 };
  },
  "agent/cancel": (p) => {
    const run = patchRun(p.runId, { status: "cancelled" });
    if (!run) return fail("no such run", "runNotFound");
    emit({ kind: "agent.finished", runId: p.runId, outcome: { status: "cancelled" } }, run.project);
    return { run };
  },
  "agent/resumeNow": (p) => runResult(p.runId),
  "agent/stopTask": (p) => {
    const tasks = (background.get(p.runId) ?? []).filter((t) => t.taskId !== p.taskId);
    background.set(p.runId, tasks);
    later(300, () => emit({ kind: "agent.background", runId: p.runId, tasks }));
    return {};
  },
  "pr/unwatch": (p) => {
    const before = watching.get(p.runId) ?? [];
    const urls = before.filter((url) => url !== p.url);
    watching.set(p.runId, urls);
    emit({ kind: "pr.watches", runId: p.runId, urls });
    return { url: p.url, watching: false, wasWatching: urls.length < before.length };
  },
  "agent/autoResume": (p) => {
    const run = patchRun(p.runId, {
      ...(p.autoResume !== undefined && { autoResume: p.autoResume }),
    });
    return run ? { run } : fail("no such run", "runNotFound");
  },
  // Made-up pull requests, as plxd reports them (pullRequests.ts).
  ...pullRequestHandlers,
  "agent/approve": (p) => {
    const decision = p.decision === "allow" ? "allowed" : "denied";
    output(p.runId, {
      kind: "approvalResolved",
      approvalId: p.approvalId,
      decision,
      by: "user",
      ...(p.always && { always: true }),
      ...(p.message && { message: p.message }),
    });
    return { decision, by: "user", ...(p.always && { always: true }) };
  },
  // The value goes nowhere: only how the request ended is logged, as plxd logs it (0063).
  "secret/answer": (p) => {
    const status =
      p.answer.type === "save" ? "saved" : p.answer.type === "decline" ? "declined" : "cancelled";
    output(p.runId, { kind: "secretResolved", requestId: p.requestId, status });
    return {};
  },
  "agent/image": () => fail("The preview keeps no images.", "imageNotFound"),
  "agent/commands": () => ({ commands: db.commands }),
  "repo/gitStatus": () => ({
    branch: "develop",
    changes: 2,
    insertions: 715,
    deletions: 4,
    upstream: "origin/develop",
    ahead: 0,
    origin: true,
  }),
  "agent/gitStatus": (p) => {
    const run = runOf(p.runId);
    return {
      branch: run?.branch ?? "develop",
      changes: run?.status === "running" ? 3 : 0,
      insertions: run?.status === "running" ? 715 : 0,
      deletions: 0,
      upstream: run?.diff ? null : "origin/develop",
      ahead: run?.diff ? 1 + (run.diff.files % 3) : 0,
      origin: true,
    };
  },
  "agent/commit": (p) => ({
    branch: runOf(p.runId)?.branch ?? null,
    changes: 0,
    insertions: 0,
    deletions: 0,
    upstream: null,
    ahead: 1,
    origin: true,
  }),
  "agent/push": (p) => ({
    branch: runOf(p.runId)?.branch ?? null,
    changes: 0,
    insertions: 0,
    deletions: 0,
    upstream: `origin/${runOf(p.runId)?.branch ?? "develop"}`,
    ahead: 0,
    origin: true,
  }),
  "agent/files": (p) => {
    if (p.path)
      return { entries: [{ name: "index.ts", kind: "file", size: 2_310 }], truncated: false };
    return {
      entries: [
        { name: "apps", kind: "dir" },
        { name: "crates", kind: "dir" },
        { name: "daemon", kind: "dir" },
        { name: "docs", kind: "dir" },
        { name: "AGENTS.md", kind: "file", size: 6_412 },
        { name: "Cargo.toml", kind: "file", size: 812 },
        { name: "README.md", kind: "file", size: 2_904 },
      ],
      truncated: false,
    };
  },
  "agent/file": (p) => ({
    path: p.path,
    side: p.side,
    exists: true,
    size: 120,
    // Base64, as plxd sends it.
    content: btoa(
      `# ${p.path}\n\nPreview content: plxd isn't running, so this file isn't read from disk.\n`,
    ),
    tooLarge: false,
  }),

  "accounts/list": () => ({ clis: db.clis, checkedAt: now() }),
  "accounts/refresh": () => ({ clis: db.clis, checkedAt: now() }),
  "accounts/keys/list": () => ({ accounts: db.keys }),
  "accounts/defaults/get": () => ({
    orchestrator: { kind: "subscription", backend: "claude" },
    worker: { kind: "subscription", backend: "claude" },
  }),
  "accounts/defaults/set": () => ({
    orchestrator: { kind: "subscription", backend: "claude" },
    worker: { kind: "subscription", backend: "claude" },
  }),
  "providers/list": () => ({ providers: db.providers, checkedAt: now() }),
  "providers/updates": () => ({
    updates: [{ cli: "codex", version: "0.162.0", latest: "0.163.0" }],
  }),
  "providers/upgrade": () => ({ version: "0.163.0" }),
  "providers/save": (p) => {
    const i = db.providers.findIndex((x) => x.instance.id === p.instance.id);
    if (i >= 0) db.providers[i] = { ...db.providers[i]!, instance: p.instance };
    else {
      // Another account of an agent on this Mac, such as a second Codex with its own home: the
      // same CLI, signed out until its sign-in.
      const same = db.providers.find((x) => x.instance.kind === p.instance.kind && x.installed);
      // A new one: OpenCode is on this Mac, the rest aren't.
      db.providers.push(
        same
          ? { ...same, instance: p.instance, signedIn: false, account: undefined, models: [] }
          : {
              instance: p.instance,
              installed: p.instance.kind === "opencode",
              ...(p.instance.kind === "opencode" && { version: "1.4.2" }),
              models: [],
              permissions: [],
              efforts: false,
              orchestrator: false,
            },
      );
    }
    return { providers: db.providers, checkedAt: now() };
  },
  "providers/remove": (p) => {
    db.providers = db.providers.filter((x) => x.instance.id !== p.id);
    return { providers: db.providers, checkedAt: now() };
  },
  // Cursor's browser sign-in (0053): the account is signed in a few seconds after the URL.
  "cursor/signIn": (p) => {
    setTimeout(() => setCursor(p.instance ?? "cursor", true), 3000);
    return { url: "https://cursor.com/loginDeepControl?preview=1" };
  },
  "cursor/signInCancel": () => ({}),
  // plxd's npm install of the SDK in the background (0053): installing for a few seconds, then
  // every Cursor instance is installed and signed out.
  "cursor/install": () => {
    const set = (change: Partial<ProviderInfo>) =>
      (db.providers = db.providers.map((x) =>
        x.instance.kind === "cursor" ? { ...x, ...change } : x,
      ));
    set({ installing: true, note: "Installing the Cursor SDK…" });
    setTimeout(
      () =>
        set({
          installing: false,
          note: undefined,
          installed: true,
          path: "/usr/local/bin/node",
          version: "1.0.35",
          signedIn: false,
        }),
      3000,
    );
    return {};
  },
  "cursor/signOut": (p) => {
    setCursor(p.instance ?? "cursor", false);
    return {};
  },
  "usage/get": () => ({ accounts: db.usage }),
  "usage/limits": () => ({ accounts: db.limits }),
  "usage/history": (p) => {
    const hours = db.usageHours.filter((h) => h.hour >= p.since);
    return {
      hours,
      runs: [
        { accountId: "claude", runs: 23 },
        { accountId: "codex", runs: 4 },
      ],
    };
  },
  "usage/daily": (p) => ({
    days: db.usageDays.filter((d) => d.date >= p.since),
    problems: [],
    sessions: db.usageSessions.filter((d) => d.date >= p.since),
  }),

  "context/list": (p) => ({ files: (db.context[p.project] ?? []).map((d) => d.file) }),
  "context/read": (p) => {
    const doc = db.context[p.project]?.find((d) => d.file.path === p.path);
    return doc
      ? { file: doc.file, content: doc.content }
      : fail(`no context file ${p.path}`, "contextNotFound");
  },

  "inbox/list": (p) => ({ items: db.inbox[p.orchestrator] ?? [], seq }),
  "inbox/seen": (p) => {
    const items = (db.inbox[p.orchestrator] ?? []).filter((i) => p.items.includes(i.id));
    for (const i of items) i.seenAt ??= now();
    return { items };
  },
  "question/list": (p) => ({ questions: db.questions[p.orchestrator] ?? [] }),
  "question/answer": (p) => {
    const question = Object.values(db.questions)
      .flat()
      .find((q) => q.id === p.question);
    if (!question) return fail("no such question", "invalidParams");
    question.answer = p.text;
    question.status = p.from ? "decided" : "answered";
    return { question };
  },

  "memory/list": (p) => ({
    files: (db.memory[scopeKey(p.scope)] ?? [])
      .map((d) => d.file)
      .sort((a, b) => a.path.localeCompare(b.path)),
  }),
  "memory/read": (p) => {
    const doc = db.memory[scopeKey(p.scope)]?.find((d) => d.file.path === p.path);
    return doc
      ? { file: doc.file, content: doc.content }
      : fail(`no memory file ${p.path}`, "contextNotFound");
  },
  "memory/write": (p) => {
    const list = (db.memory[scopeKey(p.scope)] ??= []);
    const kind = /^memory\/(preference|convention|decision|gotcha)\//.exec(p.path)?.[1] as
      | "preference"
      | "convention"
      | "decision"
      | "gotcha"
      | undefined;
    const file = {
      path: p.path,
      size: p.content.length,
      modifiedAt: now(),
      ...(kind && { kind, date: now().slice(0, 10), writer: "user", source: p.source ?? "user" }),
      ...(p.title && { title: p.title }),
    };
    const i = list.findIndex((d) => d.file.path === p.path);
    if (i >= 0) list[i] = { file, content: p.content };
    else list.push({ file, content: p.content });
    if (p.scope.kind !== "you") emit({ kind: "context.changed", file }, p.scope.id);
    return { file };
  },
  "memory/delete": (p) => {
    const key = scopeKey(p.scope);
    const list = db.memory[key] ?? [];
    const doc = list.find((d) => d.file.path === p.path);
    if (!doc) return fail(`no memory file ${p.path}`, "contextNotFound");
    db.memory[key] = list.filter((d) => d !== doc);
    if (p.scope.kind !== "you") emit({ kind: "context.changed", file: doc.file }, p.scope.id);
    return {};
  },

  "orchestration/threadRuns": (p) => ({ runs: turnsOf(p.threadId) }),
  "orchestration/getTurnDiff": (p) => ({ diff: p.from === 0 ? UPDATER_PATCH : "" }),
  "orchestration/getFullThreadDiff": () => ({ diff: UPDATER_PATCH }),
  "queue/list": () => ({ messages: [] }),

  // Computer use (PLX-897): plxd has Accessibility but not Screen Recording yet, and Notes is
  // always allowed, as the groceries thread left it.
  "computer/status": (p) => {
    if (p.request) computer.screenRecording = true;
    return { ...computer, apps: [...computer.apps] };
  },
  "computer/forget": (p) => {
    computer.apps = computer.apps.filter((app) => app !== p.app);
    return { ...computer, apps: [...computer.apps] };
  },

  "github/status": () => ({
    installed: true,
    version: "2.100.0",
    signedIn: true,
    account: "ryanstoffel",
    checkedAt: now(),
  }),
};

/** A logged event moved onto `run`, for a fork's copied transcript. */
function retarget(event: ParallaxEvent, run: AgentRun): ParallaxEvent {
  if (event.kind === "agent.started") return { ...event, runId: run.id, run };
  return "runId" in event ? ({ ...event, runId: run.id } as ParallaxEvent) : event;
}

// ---- Parallax Connect (0056) ---------------------------------------------------------------------

// Ryan's computers on the tailnet. Three of the fixtures' plain threads run on them, so the
// sidebar shows threads from every computer. `#connect` in the URL starts with Connect set up;
// otherwise it's off, and Add computer's fake install sets each one up.
const tailnet: (TailnetDevice & {
  name?: string;
  icon?: DeviceIcon;
  threads?: string[];
  /** Its repositories, from this computer's; absent means the same ones. */
  repos?: (here: Repo[]) => Repo[];
  off?: boolean;
  removed?: boolean;
  /** Reach from anywhere turned on from Settings. */
  reach?: boolean;
})[] = [
  {
    id: "nMini7Q2kX",
    hostName: "mac-mini",
    dnsName: "mac-mini.tail1a2b3.ts.net",
    os: "macOS",
    ip: "100.74.190.83",
    online: true,
    parallax: false,
    name: "Mac mini",
    threads: ["Tahoe icon variants"],
    // A repository only the Mac mini has, so New Thread lists it under the Mac mini. It lacks
    // acme-web, which picking it clones at the same path (PLX-905).
    repos: (here) => [
      ...here.filter((r) => r.name !== "acme-web"),
      {
        id: "0199a6f0-0000-7000-8000-mini0homelab",
        name: "homelab",
        path: "/Users/ryan/src/homelab",
        createdAt: here[0]!.createdAt,
      },
    ],
  },
  {
    id: "nPc4HfR9a",
    hostName: "ryans-gaming-pc",
    dnsName: "ryans-gaming-pc.tail1a2b3.ts.net",
    os: "windows",
    ip: "100.101.12.7",
    online: true,
    parallax: false,
    name: "Gaming PC",
    threads: ["Compare SSE vs WebSocket for plxd attach"],
    // No docs-site, so the Computer menu says so with docs-site picked. It's Windows, with no
    // /Users, so picking it asks where to clone docs-site (PLX-905).
    repos: (here) => here.filter((r) => r.name !== "docs-site"),
  },
  {
    id: "nTpad8Lw3",
    hostName: "thinkpad-server",
    dnsName: "thinkpad-server.tail1a2b3.ts.net",
    os: "linux",
    ip: "100.88.40.21",
    online: true,
    parallax: false,
    name: "ThinkPad",
    threads: ["Onboarding copy pass"],
  },
  {
    id: "nPhone2Zt",
    hostName: "ryans-iphone",
    dnsName: "ryans-iphone.tail1a2b3.ts.net",
    os: "iOS",
    ip: "100.92.3.55",
    online: true,
    parallax: false,
  },
  {
    id: "nOld5Kc1",
    hostName: "old-macbook-air",
    dnsName: "old-macbook-air.tail1a2b3.ts.net",
    os: "macOS",
    ip: "100.70.8.14",
    online: false,
    parallax: false,
  },
];
const connectSetUp = location.hash.includes("connect");
// `#onboarding` opens first-launch onboarding (PLX-806), signed out, with Cursor signed out too.
const onboarding = location.hash.includes("onboarding");
if (onboarding)
  db.providers = db.providers.map((x) =>
    x.instance.kind === "cursor"
      ? { ...x, installed: true, version: "1.0.35", signedIn: false }
      : x,
  );
const profileListeners = new Set<(profile: Profile | null) => void>();
const profile: Profile = {
  name: "Ryan Stoffel",
  firstName: "Ryan",
  lastName: "Stoffel",
  email: "ryan@example.com",
};
const connect: ConnectState = { on: connectSetUp, icon: "laptop", channel: "nightly" };
// Set up, they carry the names given on them; new, they're known by their host names.
if (connectSetUp) for (const d of tailnet.slice(0, 3)) d.parallax = true;
else for (const d of tailnet) delete d.name;
const deviceId = (d: TailnetDevice) => `tailnet:${d.id}`;
const deviceOf = (hostId: string) => tailnet.find((d) => deviceId(d) === hostId);
const connectListeners = new Set<(state: ConnectState) => void>();
const deviceListeners = new Set<(devices: DeviceHost[]) => void>();

/** Threads started on a device from the console (`previewState.startOnDevice`), by run id. */
const deviceRuns = new Map<string, string>();

/** The host a run is on: a device's, for the fixture threads it runs. */
function hostOf(runId: string): string {
  const started = deviceRuns.get(runId);
  if (started) return started;
  const title = db.threads.find((t) => t.id === runId)?.title;
  const device = tailnet.find((d) => d.parallax && title && d.threads?.includes(title));
  return device ? deviceId(device) : LOCAL;
}

// `#accounts` (0091): two computers on the account, one connected and one new that asks for its
// code (482913 works), and a phone asking to sign in.
const accountsShown = location.hash.includes("accounts");
const accounts: DeviceHost[] = accountsShown
  ? [
      {
        id: "account:alfEbFC1hWlmHpbBo55sMKZ0PQ_RqGqTzdoMYJy-m6o",
        name: "studio",
        icon: "desktop",
        detected: "laptop",
        hostName: "studio",
        enabled: true,
      },
      {
        id: "account:Q2s9vX1k7d0b8Lr4mT6pWc3eYh5uNz2aFgJ_iK-oPqR",
        name: "build-box",
        icon: "server",
        detected: "server",
        hostName: "build-box",
        enabled: true,
        access: { step: "needsCode" },
      },
    ]
  : [];
let accessRequests: AccessPrompt[] = accountsShown
  ? [{ id: "req-1", name: "Ryan's iPhone", code: "731905", host: "studio" }]
  : [];
const accessListeners = new Set<(requests: AccessPrompt[]) => void>();

function deviceHosts(): DeviceHost[] {
  if (!connect.on) return [...accounts];
  return tailnet
    .filter((d) => d.parallax && !d.removed)
    .map((d) => ({
      id: deviceId(d),
      name: d.name ?? d.hostName,
      icon: d.icon ?? iconFor(d.hostName),
      detected: iconFor(d.hostName),
      hostName: d.hostName,
      ip: d.ip,
      os: d.os,
      enabled: !d.off,
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

function connectChanged() {
  for (const l of connectListeners) l({ ...connect });
  const devices = deviceHosts();
  for (const l of deviceListeners) l(devices);
  for (const d of devices) if (d.enabled) for (const l of connectionListeners) l(d.id, connected);
}

/** What a device's plxd answers itself; the rest of a device's calls share the fixtures. */
function deviceRequest(hostId: string, method: string, params: Record<string, unknown>) {
  const device = deviceOf(hostId)!;
  const own = (id: string) => hostOf(id) === hostId;
  switch (method) {
    case "thread/list":
      return {
        repos: [
          ...(device.repos?.(db.repos) ?? db.repos),
          ...db.repos.filter((r) => cloned.has(`${hostId}:${r.path}`)),
        ],
        threads: db.threads.filter((t) => own(t.id)),
        seq,
      };
    case "agent/list":
      return { runs: db.runs.filter((r) => own(r.id)), seq };
    case "orchestrator/list":
      return { orchestrators: [], seq };
    // The Gaming PC runs the Remote Control threads' sessions (PLX-1143).
    case "thread/importable":
      return {
        sessions:
          device.os === "windows"
            ? Object.keys(db.remoteControl).map((runId) => ({
                source: "claude" as const,
                id: `local-${runId}`,
                title: db.threads.find((t) => t.id === runId)?.title ?? "A session",
                cwd: "C:\\Users\\ryan\\Developer\\learn-rust",
                updatedAt: now(),
                ...(db.threads.some((t) => t.id === `moved-${runId}`) && {
                  thread: `moved-${runId}`,
                }),
              }))
            : [],
      };
    case "thread/import": {
      // A copy of the Remote Control thread, now running Claude Code on the device.
      const from = String(params["id"]).replace(/^local-/, "");
      const id = `moved-${from}`;
      const run: AgentRun = { ...runOf(from)!, id, sessionId: String(params["id"]) };
      const thread: Thread = { ...db.threads.find((t) => t.id === from)!, id, archived: true };
      if (!db.threads.some((t) => t.id === id)) {
        deviceRuns.set(id, hostId);
        logs.set(id, structuredClone(logs.get(from) ?? []));
        db.runs.push(run);
        db.threads.push(thread);
        emit({ kind: "agent.started", runId: id, run });
        emit({ kind: "thread.started", thread });
      }
      return { thread, run };
    }
    // The Windows PC was kept on Tailscale only, so Settings offers Reach from anywhere (0091).
    case "host/settings/get":
      return {
        autoResume: true,
        connect: true,
        relay: device.os !== "windows" || !!device.reach,
        remote: true,
        deviceName: device.name,
        deviceIcon: device.icon,
      };
    case "host/version":
      return {
        plxd: "0.0.0-preview",
        protocol: { min: PROTOCOL_VERSION, max: PROTOCOL_VERSION },
        os: (
          {
            macOS: "macOS 26.0",
            windows: "Windows 11 Pro 24H2",
            linux: "Ubuntu 24.04.3 LTS",
          } as Record<string, string>
        )[device.os]!,
        arch: device.os === "windows" ? "x86_64" : device.os === "macOS" ? "aarch64" : "x86_64",
      };
    case "host/health":
      return {
        uptimeSeconds: (
          { macOS: 93_780, windows: 12_420, linux: 1_204_300 } as Record<string, number>
        )[device.os]!,
        store: "ok",
        runningAgents: db.runs.filter((r) => own(r.id) && r.status === "running").length,
      };
    case "host/settings/set": {
      if (typeof params["deviceName"] === "string") device.name = params["deviceName"] || undefined;
      if (typeof params["deviceIcon"] === "string")
        device.icon = (params["deviceIcon"] || undefined) as DeviceIcon | undefined;
      setTimeout(connectChanged, 0);
      return { autoResume: true, connect: true, deviceName: device.name, deviceIcon: device.icon };
    }
  }
  return undefined;
}

/** What a failed setup script leaves in its shell (PLX-650). */
const fakeSetup = [
  "\x1b[1m~/.parallax/worktrees/docs-links\x1b[0m % ( pnpm install --frozen-lockfile\r\n",
  "Lockfile is up to date, resolution step is skipped\r\n",
  "Progress: resolved 412, reused 398, downloaded 0, added 0\r\n",
  "\x1b[31m ERR_PNPM_FETCH_404\x1b[0m GET https://registry.npmjs.org/@docs%2Ftheme: Not Found - 404\r\n",
  "\r\n",
  "\x1b[1m~/.parallax/worktrees/docs-links\x1b[0m % ",
];

/** What `plx add` prints, a line at a time with a pause after each. */
function fakeAdd(device: TailnetDevice, user: string | undefined): [string, number][] {
  const who = `${user ?? "ryan"}@${device.ip}`;
  const name = device.hostName;
  const version = "2610.10522.11930-nightly";
  const app = "Parallax (Nightly)";
  const os = (
    {
      macOS: [
        "Mac mini: macOS 26.0 (arm64)",
        "mac-arm64.dmg",
        `  Installed ${app}.app ${version} in /Applications`,
      ],
      windows: [
        "DESKTOP-RYAN: Windows 11 Pro 24H2 (x64)",
        "win-x64.exe",
        `  Installed ${app} in C:\\Users\\ryan\\AppData\\Local\\Programs\\parallax-desktop`,
      ],
      linux: [
        "thinkpad-server: Ubuntu 24.04.3 LTS (x86_64)",
        "linux-x86_64.AppImage",
        "  Installed ~/Applications/Parallax-Nightly.AppImage and ~/.local/bin/plxd",
      ],
    } as Record<string, string[]>
  )[device.os]!;
  const lines: [string, number][] = [
    [`→ Connecting to ${name} (${who}) over SSH`, 500],
    [`${who}'s password: `, 1500],
    [`✓ Connected to ${name}`, 300],
    [`→ Finding ${name}'s OS`, 600],
    [`✓ ${os[0]}`, 300],
    [`→ Finding the newest nightly release`, 700],
    [`✓ ${app} ${version}: parallax-${version}-${os[1]}`, 300],
    [`→ Installing ${app} on ${name}`, 300],
    [
      `  Downloading https://github.com/ryan-stoffel/parallax/releases/download/v${version}/parallax-${version}-${os[1]}`,
      1600,
    ],
    [os[2]!, 300],
    [`  Turning on Parallax Connect`, 300],
    [`  Parallax Connect is on.`, 300],
    ...((device.os === "windows"
      ? [
          [`  Allowed plxd through Windows Firewall on TCP 7340`, 400],
          [`  Starting plxd`, 400],
          [
            `  warning: Windows has no plxd login service yet, so plxd runs until you sign out. Opening Parallax starts it again.`,
            300,
          ],
        ]
      : [[`  Installing plxd's login service`, 500]]) as [string, number][]),
    [`  Installed plx-cli in ~/.local`, 600],
    [`✓ Installed ${app} ${version} and turned on Parallax Connect`, 300],
    [`→ Waiting for ${name} to answer on port 7340`, 900],
    [`✓ ${name} is connected to Parallax.`, 300],
  ];
  // The password prompt waits on its line, and the typed password isn't echoed.
  return lines.map(([line, ms], i) => [
    line.endsWith(": ") ? line : `${lines[i - 1]?.[0].endsWith(": ") ? "\r\n" : ""}${line}\r\n`,
    ms,
  ]);
}

const terminalListeners = new Map<string, (message: TerminalMessage) => void>();

// ---- Cloning onto a computer (PLX-905) ------------------------------------------------------------

/** How long a clone takes in the preview. */
const CLONE_MS = 6000;
/** Each clone under way's start, by id. */
const clones = new Map<string, number>();
/** The repositories cloned onto a device, as `<host id>:<path>`. */
const cloned = new Set<string>();

/**
 * `repo/clone`, `repo/cloneProgress`, `repo/remote`, and a device's `repo/add` and `host/folders`
 * where its repository or folder isn't there: a device lacks the repositories its `repos` leaves
 * out until they're cloned there, and Windows has no /Users.
 */
function cloneRequest(hostId: string, method: string, params: Record<string, unknown>) {
  const device = hostId === LOCAL ? undefined : deviceOf(hostId);
  const path = typeof params["path"] === "string" ? expand(params["path"]) : "";
  switch (method) {
    case "repo/remote": {
      const repo = db.repos.find((r) => r.id === params["repo"]);
      return { result: { url: `git@github.com:ryan-stoffel/${repo?.name}.git` } };
    }
    case "repo/cloneProgress": {
      const started = clones.get(String(params["id"]));
      if (started === undefined) return { result: {} };
      const done = Math.min(1, (Date.now() - started) / CLONE_MS);
      const objects = Math.round(done * 4812);
      return {
        result: {
          progress: `Receiving objects:  ${Math.round(done * 100)}% (${objects}/4812), ${(done * 38.6).toFixed(2)} MiB | 6.20 MiB/s`,
        },
      };
    }
    case "repo/clone": {
      const id = String(params["id"]);
      clones.set(id, Date.now());
      cloned.add(`${hostId}:${path}`);
      setTimeout(() => clones.delete(id), CLONE_MS);
      const repo = db.repos.find((r) => r.path === path) ?? {
        id,
        name: path.split("/").at(-1)!,
        path,
        createdAt: now(),
      };
      return { result: { repo }, ms: CLONE_MS };
    }
    case "repo/add":
      return device?.repos &&
        !device.repos(db.repos).some((r) => r.path === path) &&
        !cloned.has(`${hostId}:${path}`)
        ? { error: fail(`${path} doesn't exist on this host.`, "notARepository") }
        : undefined;
    case "host/folders":
      return device?.os === "windows" && String(params["path"]).startsWith("/")
        ? { error: fail(`Can't open ${path}: The system cannot find the path specified.`) }
        : undefined;
  }
  return undefined;
}

const delay = <T>(value: T, ms = 40) =>
  new Promise<T>((resolve) => setTimeout(() => resolve(value), ms));
const noop = () => {};

let localName = "macbook";
const localNameListeners = new Set<(name: string) => void>();
const connectionListeners = new Set<(hostId: string, state: ConnectionState) => void>();

const updateState: UpdateState = {};

function setCursor(id: string, signedIn: boolean) {
  db.providers = db.providers.map((x) =>
    x.instance.id === id
      ? { ...x, signedIn, account: signedIn ? "ryan@example.com" : undefined }
      : x,
  );
}

// The folders the add palette browses: a home folder and what's under Developer.
const folderTree: Record<string, string[]> = {
  [HOME]: [
    "Applications",
    "Desktop",
    "Developer",
    "Documents",
    "Downloads",
    "Library",
    "Movies",
    "Music",
    "Pictures",
  ],
  [`${HOME}/Developer`]: ["personal", "work"],
  [`${HOME}/Developer/personal`]: ["parallax", "photon", "dotfiles"],
};
/** The folders in `input`, which may start with `~`, from `folderTree`. */
const listing = (input: string) => {
  const dir = expand(input);
  return {
    path: dir,
    folders: (folderTree[dir] ?? []).map((name) => ({ name, path: `${dir}/${name}` })),
  };
};
const expand = (p: string) => p.replace(/^~(?=\/|$)/, HOME).replace(/\/+$/, "") || "/";

// The terminal app Settings > General chose, once Choose… is clicked.
let mockTerminal: string | null = "Ghostty";

function ago(minutes: number) {
  return new Date(Date.now() - minutes * 60_000).toISOString();
}

export const mockBridge: ParallaxBridge = {
  platform: "darwin",
  version: () => delay("0.0.0-preview"),
  setThemeSource: noop,
  setZoom: (factor) => {
    document.documentElement.style.zoom = String(factor);
  },
  zoomed: noop,
  onFullScreen: () => () => {},
  pickFolder: () => delay(`${HOME}/Developer/personal/new-repo`),
  listFolders: (input) => delay(listing(input)),
  createRepo: (name) => delay({ path: `${HOME}/.parallax/projects/${name}` }, 400),
  copyPicture: () => delay(undefined),
  onBrowser: () => () => {},
  extensions: () => delay([]),
  installExtension: () => delay("Extensions need the desktop app."),
  loadUnpackedExtension: () => delay(undefined),
  removeExtension: () => delay(undefined),
  onExtensionsChanged: () => () => {},
  selectBrowserTab: () => {},
  clearBrowsingData: () => delay(undefined),
  downloads: () => delay([]),
  onDownloads: () => () => {},
  googleAccount: () => delay(undefined),
  siteIcon: () => delay(undefined),
  onGoogleAccount: () => () => {},
  downloadAction: () => {},
  setDownloadPrefs: () => {},
  updatable: false,
  firstRun: onboarding,
  locale: undefined,
  update: () => delay("Up to date"),
  onUpdateState: (listener) => {
    listener(updateState);
    return noop;
  },

  request<M extends RendererMethod>(
    hostId: string,
    method: M,
    params: ParallaxRequests[M]["params"],
  ): Promise<HostResponse<ParallaxRequests[M]["result"]>> {
    // A LAN computer runs nothing in the preview.
    if (isLanHost(hostId))
      return delay({
        result: { repos: [], threads: [], runs: [], orchestrators: [], seq },
        logId: LOG_ID,
      } as unknown as HostResponse<Result<M>>);
    if (hostId !== LOCAL && !deviceOf(hostId)?.parallax)
      return delay({ error: fail(`no host has id ${hostId}`) } as HostResponse<Result<M>>);
    const clone = cloneRequest(hostId, method, params as Record<string, unknown>);
    if (clone)
      return delay(
        ("error" in clone
          ? { error: clone.error }
          : { result: structuredClone(clone.result), logId: LOG_ID }) as HostResponse<Result<M>>,
        "ms" in clone ? clone.ms : 40,
      );
    if (hostId !== LOCAL) {
      const own = deviceRequest(hostId, method, params as Record<string, unknown>);
      if (own)
        return delay({ result: structuredClone(own), logId: LOG_ID } as HostResponse<Result<M>>);
      // A thread started on a device runs there, as plxd would have it.
      if (method === "thread/start") deviceRuns.set((params as { runId: string }).runId, hostId);
    } else if (method === "thread/list" || method === "agent/list") {
      // This computer's own threads: the fixtures', less the ones the devices run.
      const all = handlers[method]!(params as never) as { threads?: Thread[]; runs?: AgentRun[] };
      const mine = <T extends { id: string }>(list?: T[]) =>
        list?.filter((x) => hostOf(x.id) === LOCAL);
      return delay({
        result: structuredClone({
          ...all,
          ...(all.threads && { threads: mine(all.threads) }),
          ...(all.runs && { runs: mine(all.runs) }),
        }),
        logId: LOG_ID,
      } as HostResponse<Result<M>>);
    }
    const handler = handlers[method] as Handler<M> | undefined;
    if (!handler) {
      console.warn("preview: unhandled", method, params);
      return delay({
        error: { code: -32601, message: `The preview doesn't fake ${method}.` },
      } as HostResponse<Result<M>>);
    }
    let answer: Result<M> | RpcError;
    try {
      answer = handler(params);
    } catch (e) {
      console.error("preview: handler threw", method, e);
      answer = fail(String(e));
    }
    // A copy, so the renderer never holds the mock's own objects.
    const response = isError(answer)
      ? { error: answer }
      : { result: structuredClone(answer), logId: LOG_ID };
    // plxd runs ccusage and pages Cursor's API for usage/daily, which takes a second or two.
    // plxd reads claude.ai's sessions through Claude Code for thread/importable's remote.
    const slow =
      method === "usage/daily" ||
      (method === "thread/importable" && (params as { remote?: boolean }).remote);
    return delay(response as HostResponse<Result<M>>, slow ? 1800 : 40);
  },

  subscribe(hostId: string, params: SubscribeParams, listener: (m: SubscriptionMessage) => void) {
    if (hostId !== LOCAL && !deviceOf(hostId)) return noop;
    const entry: Listener = {
      id: `sub-${++subscriptions}`,
      host: hostId,
      view: (logged) => (logged.project === params.project ? logged : undefined),
      after: params.after,
      listener,
    };
    listeners.add(entry);
    return () => listeners.delete(entry);
  },
  // A snapshot from the fixtures, then the events emitted after it.
  watch(hostId: string, params: WatchParams, listen: (m: never) => void) {
    // Each overload's listener takes its own snapshot's type.
    const listener = listen as (m: WatchMessage) => void;
    const own = (id: string) => hostOf(id) === hostId;
    const thread = "threadId" in params ? params.threadId : undefined;
    let snapshot: ShellSnapshot | ThreadSnapshot;
    if (thread === undefined) {
      const known = hostId === LOCAL || !!deviceOf(hostId);
      const runs = known ? db.runs.filter((r) => own(r.id)) : [];
      snapshot = {
        seq,
        orchestrators: hostId === LOCAL ? db.orchestrators : [],
        repos: known ? (deviceOf(hostId)?.repos?.(db.repos) ?? db.repos) : [],
        threads: known ? db.threads.filter((t) => own(t.id)) : [],
        runs,
        requests: waiting(runs.map((r) => r.id)),
        waiting: runs.flatMap((r) =>
          background.get(r.id)?.length || watching.get(r.id)?.length
            ? [{ runId: r.id, background: background.get(r.id), watching: watching.get(r.id) }]
            : [],
        ),
      };
    } else {
      const run = runOf(thread);
      if (!run) {
        setTimeout(() =>
          listener({ type: "error", error: fail(`no run ${thread}`, "runNotFound") }),
        );
        return noop;
      }
      snapshot = {
        seq,
        thread: run,
        runs: queued.get(thread) ?? [],
        events: logs.get(thread) ?? [],
        more: false,
        requests: [],
        background: background.get(thread) ?? [],
        watching: watching.get(thread) ?? [],
      };
    }
    const entry: Listener = {
      id: `sub-${++subscriptions}`,
      host: hostId,
      view: (logged) =>
        thread === undefined
          ? shellView(logged)
          : "runId" in logged.event && logged.event.runId === thread
            ? logged
            : undefined,
      after: seq,
      listener,
    };
    listeners.add(entry);
    setTimeout(() => listener({ type: "snapshot", snapshot: structuredClone(snapshot) }), 40);
    return () => listeners.delete(entry);
  },
  connectionState: (hostId) =>
    hostId === LOCAL || deviceOf(hostId) || isLanHost(hostId)
      ? delay(connected, 10)
      : Promise.reject(new Error(`no host ${hostId}`)),
  onConnectionState: (listener) => {
    connectionListeners.add(listener);
    return () => connectionListeners.delete(listener);
  },
  retry: () => delay(undefined),
  onHostUpdate: () => () => {},
  retryHostUpdate: () => delay(undefined),
  updateHostNow: () => delay(undefined),

  hosts: () => delay([...lan.hosts]),
  sshSuggestions: () => delay(["mac-mini", "devbox", "100.87.92.42", "github.com"]),
  onHosts: (listener) => {
    hostsListeners.add(listener);
    return () => hostsListeners.delete(listener);
  },
  onLocalName: (listener) => {
    listener(localName);
    localNameListeners.add(listener);
    return () => localNameListeners.delete(listener);
  },
  renameLocal: (name) => {
    localName = name.trim() || "macbook";
    for (const l of localNameListeners) l(localName);
    return delay(undefined);
  },
  saveHost: () => delay("Hosts can't be added in the preview."),
  removeHost: (id) => {
    lan.hosts = lan.hosts.filter((h) => h.id !== id);
    for (const l of hostsListeners) l([...lan.hosts]);
    return delay(undefined);
  },
  installPlxd: () => delay("plxd can't be installed in the preview."),
  discoverLan: () => delay([{ id: "0", name: "studio" }], 900),
  pairLan: async (target, code) => {
    await delay(undefined, 600);
    if (code.replace(/[\s-]/g, "").length !== 6)
      return "That code is wrong, used, or expired. Check it, or make a new one on the other computer.";
    const first = "address" in target ? target.address : "192.168.1.31";
    lan.hosts.push({ id: "lan:studio", name: "studio", routes: [first, "100.74.190.83"] });
    for (const l of hostsListeners) l([...lan.hosts]);
    return undefined;
  },
  registerRelay: () => delay(undefined, 400),
  relayHosts: () => delay([...relayHosts], 300),
  removeRelayHost: (hostId) => {
    relayHosts = relayHosts.filter((h) => h.hostId !== hostId);
    return delay([...relayHosts], 300);
  },

  onConnect: (listener) => {
    listener({ ...connect });
    connectListeners.add(listener);
    return () => connectListeners.delete(listener);
  },
  setConnect: async (on) => {
    await delay(undefined, 300);
    connect.on = on;
    connectChanged();
    return undefined;
  },
  onDevices: (listener) => {
    listener(deviceHosts());
    deviceListeners.add(listener);
    return () => deviceListeners.delete(listener);
  },
  saveDevice: (hostId, look) => {
    if (hostId === LOCAL) {
      if (look.icon) connect.icon = look.icon;
    } else
      void mockBridge.request(hostId, "host/settings/set", {
        deviceName: look.name,
        deviceIcon: look.icon,
      });
    connectChanged();
    return delay(undefined);
  },
  setDeviceEnabled: (hostId, enabled) => {
    const device = deviceOf(hostId);
    if (device) Object.assign(device, { off: !enabled, removed: false });
    connectChanged();
    return delay(undefined);
  },
  removeDevice: (hostId) => {
    const device = deviceOf(hostId);
    if (device) device.removed = true;
    connectChanged();
    return delay(undefined);
  },
  discoverAccount: () => delay([...accounts]),
  enterSetupCode: async (hostId, code) => {
    await delay(undefined, 600);
    const computer = accounts.find((a) => a.id === hostId);
    if (code !== "482913" || !computer)
      return "That code is wrong, used, or expired. Check it, then type it again.";
    delete computer.access;
    connectChanged();
    return undefined;
  },
  askAgain: () => delay(undefined),
  turnOnReach: (hostId) => {
    const device = deviceOf(hostId);
    if (device) device.reach = true;
    return delay(undefined, 400);
  },
  revokeDevice: (id) => {
    lan.sessions = lan.sessions.filter((s) => s.id !== id);
    return delay({ sessions: lan.sessions, listening: lan.on, pairing: false });
  },
  onAccessRequests: (listener) => {
    listener([...accessRequests]);
    accessListeners.add(listener);
    return () => accessListeners.delete(listener);
  },
  answerAccess: async (id) => {
    await delay(undefined, 400);
    accessRequests = accessRequests.filter((r) => r.id !== id);
    for (const l of accessListeners) l([...accessRequests]);
    return undefined;
  },

  acpRegistry: () => delay([]),

  openTerminal: (id, target) => {
    // A thread's setup script (PLX-650) shows what a failed install leaves in its shell.
    if ("terminalId" in target && target.terminalId) {
      for (const [i, data] of fakeSetup.entries())
        later(80 * (i + 1), () => terminalListeners.get(id)?.({ type: "data", data }));
      return delay(undefined);
    }
    if (!("connect" in target)) return delay("Terminals don't run in the preview.");
    const device = tailnet.find((d) => d.ip === target.connect.device)!;
    let wait = 0;
    for (const [data, ms] of fakeAdd(device, target.connect.user)) {
      wait += ms;
      later(wait, () => terminalListeners.get(id)?.({ type: "data", data }));
    }
    later(wait + 300, () => {
      device.parallax = true;
      connectChanged();
      terminalListeners.get(id)?.({ type: "exit", exitCode: 0 });
    });
    return delay(undefined);
  },
  install: () => delay("Installs don't run in the preview."),
  terminalInput: noop,
  resizeTerminal: noop,
  closeTerminal: noop,
  onTerminal: (id, listener) => {
    terminalListeners.set(id, listener);
    return () => terminalListeners.delete(id);
  },
  openDeviceStream: () => delay("Devices don't stream in the preview."),
  sendDeviceStream: noop,
  closeDeviceStream: noop,

  openTargets: (hostId) =>
    delay(
      hostId !== LOCAL
        ? []
        : [
            { target: "vscode" as const, name: "VS Code" },
            { target: "cursor" as const, name: "Cursor" },
            { target: "zed" as const, name: "Zed" },
            { target: "xcode" as const, name: "Xcode" },
            { target: "files" as const, name: "Finder" },
            ...(mockTerminal ? [{ target: "terminal" as const, name: mockTerminal }] : []),
          ],
    ),
  openFolder: () => delay(undefined),
  showFile: () => delay(undefined),
  terminalApp: () => delay(mockTerminal),
  terminalApps: () =>
    delay([
      { path: "/Applications/Ghostty.app", name: "Ghostty" },
      { path: "/System/Applications/Utilities/Terminal.app", name: "Terminal" },
    ]),
  selectTerminalApp: (path) =>
    delay((mockTerminal = path.includes("Ghostty") ? "Ghostty" : "Terminal")),
  command: () =>
    delay({ state: "missing" as const, path: "/usr/local/bin/parallax", onPath: true }),
  installCommand: () => delay(null),
  removeCommand: () => delay(null),

  onProfile: (listener) => {
    profileListeners.add(listener);
    listener(onboarding ? null : profile);
    return () => profileListeners.delete(listener);
  },
  // The browser's sign-in, done a moment later.
  signIn: async () => {
    await delay(undefined, 1500);
    for (const listener of profileListeners) listener(profile);
    return undefined;
  },
  editProfile: () => delay(undefined),
  signOut: () => delay(undefined),

  storage: () =>
    delay([
      {
        id: "history",
        name: "Thread history",
        folder: `${HOME}/.parallax`,
        bytes: 48_211_000,
      },
      {
        id: "worktrees",
        name: "Worktrees",
        folder: `${HOME}/.parallax/worktrees`,
        bytes: 1_204_000_000,
      },
      { id: "logs", name: "Logs", folder: `${HOME}/.parallax/logs`, bytes: 9_820_000 },
      {
        id: "app",
        name: "App data",
        folder: `${HOME}/.parallax/desktop`,
        bytes: 31_400_000,
      },
      { id: "cache", name: "Cache", folder: `${HOME}/Library/Caches/Parallax`, bytes: 112_000_000 },
    ]),
  showFolder: () => delay(undefined),
  clearCache: () => delay(undefined),
};

/** For the console: the mock's state, to poke at while looking at the preview. */
export const previewState = {
  db,
  logs,
  repoPath: PARALLAX_PATH,
  /** Starts a thread on a Connect device, as if someone started it there. */
  startOnDevice(hostName: string, title: string, prompt: string, backend = "codex") {
    const device = tailnet.find((d) => d.hostName === hostName)!;
    const runId = crypto.randomUUID();
    deviceRuns.set(runId, deviceId(device));
    handlers["thread/start"]!({
      runId,
      prompt,
      title,
      repo: db.repos.find((r) => !r.scratch)!.id,
      account: { kind: "subscription", backend },
    });
  },
};
