// A `window.parallax` for the browser preview: every ParallaxBridge member, answering plxd methods
// from fixtures.ts held in memory. Writes that are cheap to fake change that state and emit the
// events plxd would, so a sent message or an answered question shows up as it does in the app.
import type {
  ConnectionState,
  HostResponse,
  ParallaxBridge,
  RendererMethod,
  RpcError,
  SubscribeParams,
  SubscriptionMessage,
  UpdateState,
} from "../src/preload/bridge";
import {
  PROTOCOL_VERSION,
  type AgentOutputItem,
  type AgentRun,
  type Capabilities,
  type LoggedEvent,
  type MemoryScope,
  type ParallaxEvent,
  type ParallaxRequests,
  type Thread,
} from "../src/protocol/generated/protocol";
import { createFixtures, HOME, PARALLAX_PATH, type RunEvent } from "./fixtures";

const LOCAL = "local";
const LOG_ID = "0199a6f0-0000-7000-8000-preview00log";

/** What plxd's `capabilities_advertised` lists (daemon/src/methods/host.rs), with the same caps. */
const capabilities: Capabilities = Object.fromEntries(
  [
    "accounts",
    "agentClis",
    "agentReview",
    "agentWait",
    "agents",
    "approvals",
    "autoResume",
    "checks",
    "checkout",
    "composerMenus",
    "contextAndFast",
    "coordinator",
    "eventFilters",
    "files",
    "git",
    "githubSetup",
    "githubStatus",
    "inbox",
    "integrationBranch",
    "landing",
    "memory",
    "openPr",
    "prDiff",
    "projectAutonomy",
    "projectDelete",
    "projectEdit",
    "projectFromThreads",
    "projectPermission",
    "projectPlacement",
    "projectTasks",
    "providers",
    "pullRequests",
    "queue",
    "questions",
    "repoRefs",
    "runOptions",
    "sendAccount",
    "sendModel",
    "sendOptions",
    "threadAttention",
    "threadFork",
    "threadLineage",
    "threadTools",
    "threads",
  ].map((name) => [name, {}]),
);
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
/** A run's scope, as its events carry it: its Project, or its thread's repo entry. */
const scopeOf = (runId: string) => runOf(runId)?.project;

function number(runId: string, list: RunEvent[]) {
  const project = scopeOf(runId);
  logs.set(
    runId,
    list.map((e) => ({ seq: ++seq, time: e.time, ...(project && { project }), event: e.event })),
  );
}
// Oldest run first, so seqs rise with time across runs, roughly as plxd's log does.
for (const run of [...db.runs].sort((a, b) => a.createdAt.localeCompare(b.createdAt)))
  number(run.id, db.events[run.id] ?? []);

type Listener = {
  id: string;
  project?: string;
  after: number;
  listener: (m: SubscriptionMessage) => void;
};
let subscriptions = 0;
const listeners = new Set<Listener>();

/** Logs and delivers an event, as plxd does: a run's to its scope, a host-level one to the host. */
function emit(event: ParallaxEvent, project?: string) {
  const logged: LoggedEvent = {
    seq: ++seq,
    time: new Date().toISOString(),
    ...(project && { project }),
    event,
  };
  if ("runId" in event && event.kind.startsWith("agent.")) {
    const list = logs.get(event.runId) ?? [];
    list.push(logged);
    logs.set(event.runId, list);
  }
  for (const l of listeners)
    if (l.project === project && logged.seq > l.after)
      setTimeout(() => l.listener({ type: "event", event: { subscription: l.id, ...logged } }), 0);
  return logged;
}

const now = () => new Date().toISOString();
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

/** Runs a faked turn on `runId`: its message, a short reply, and its end. */
function fakeTurn(runId: string, turnId: string | undefined, text: string | undefined) {
  patchRun(runId, { status: "running" });
  output(runId, { kind: "turnStarted", ...(turnId && { turnId }), ...(text && { text }) });
  later(900, () => {
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

const handlers: { [M in Method]?: Handler<M> } = {
  "host/settings/get": () => ({ autoResume: true }),
  "host/settings/set": (p) => ({ autoResume: p.autoResume ?? true }),

  "project/list": () => ({ projects: db.projects, seq }),
  "project/create": (p) => {
    const project = {
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
    db.projects.push(project);
    db.inbox[p.id] = [];
    db.questions[p.id] = [];
    db.context[p.id] = [];
    emit({ kind: "project.created", project });
    return { project };
  },
  "project/update": (p) => {
    const project = db.projects.find((x) => x.id === p.project);
    if (!project) return fail("no such project", "projectNotFound");
    const { project: _, ...change } = p;
    Object.assign(project, change);
    emit({ kind: "project.updated", project });
    return { project };
  },
  "project/delete": (p) => {
    db.projects = db.projects.filter((x) => x.id !== p.project);
    emit({ kind: "project.deleted", project: p.project });
    return {};
  },
  "project/start": (p) => {
    const project = db.projects.find((x) => x.id === p.project);
    if (!project) return fail("no such project", "projectNotFound");
    const run: AgentRun = {
      id: p.runId,
      project: p.project,
      prompt: p.prompt,
      policy: "noWrite",
      status: "starting",
      backend: "claude",
      accountId: "claude",
      model: p.model ?? "claude-opus-5-5",
      effort: p.effort ?? "high",
      contextWindow: 1_000_000,
      permission: project.permission ?? "auto",
      approvals: !!p.approvals,
      worktreePath: project.repoPath,
      createdAt: now(),
      updatedAt: now(),
    };
    project.coordinator = run.id;
    startRun(run);
    return { run };
  },

  "thread/list": () => ({ repos: db.repos, threads: db.threads, seq }),
  "thread/start": (p) => {
    const project = p.project ? db.projects.find((x) => x.id === p.project) : undefined;
    const repo = p.project ?? p.repo ?? db.repos.find((r) => r.scratch)!.id;
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
      permission: project ? (project.permission ?? "auto") : (p.permission ?? "edit"),
      approvals: !!p.approvals || !!project,
      createdAt: now(),
      updatedAt: now(),
    };
    const thread: Thread = {
      id: p.runId,
      repo,
      createdAt: now(),
      lastPromptAt: now(),
      ...(p.title && { title: p.title }),
      ...(project?.coordinator && { parent: project.coordinator }),
      ...(p.parent && { parent: p.parent }),
    };
    startRun(run, thread);
    return { thread, run };
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
  "thread/delete": (p) => {
    const thread = db.threads.find((t) => t.id === p.runId);
    db.threads = db.threads.filter((t) => t.id !== p.runId);
    if (thread) emit({ kind: "thread.deleted", runId: p.runId, repo: thread.repo });
    return {};
  },
  "thread/search": (p) => {
    const q = p.query.toLowerCase();
    return {
      threads: db.threads.filter(
        (t) => t.title?.toLowerCase().includes(q) || runOf(t.id)?.prompt.toLowerCase().includes(q),
      ),
    };
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
    repo.icon = p.icon;
    emit({ kind: "repo.updated", repo });
    return { repo };
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
  "agent/cancel": (p) => {
    const run = patchRun(p.runId, { status: "cancelled" });
    if (!run) return fail("no such run", "runNotFound");
    emit({ kind: "agent.finished", runId: p.runId, outcome: { status: "cancelled" } }, run.project);
    return { run };
  },
  "agent/resumeNow": (p) => runResult(p.runId),
  "agent/autoResume": (p) => {
    const run = patchRun(p.runId, {
      ...(p.autoResume !== undefined && { autoResume: p.autoResume }),
    });
    return run ? { run } : fail("no such run", "runNotFound");
  },
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
  "agent/image": () => fail("The preview keeps no images.", "imageNotFound"),
  "agent/commands": () => ({ commands: db.commands }),
  "agent/gitStatus": (p) => {
    const run = runOf(p.runId);
    return {
      branch: run?.branch ?? "develop",
      changes: run?.status === "running" ? 3 : 0,
      upstream: run?.diff ? null : "origin/develop",
      ahead: run?.diff ? 1 : 0,
      origin: true,
    };
  },
  "agent/commit": (p) => ({
    branch: runOf(p.runId)?.branch ?? null,
    changes: 0,
    upstream: null,
    ahead: 1,
    origin: true,
  }),
  "agent/push": (p) => ({
    branch: runOf(p.runId)?.branch ?? null,
    changes: 0,
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
    content: `# ${p.path}\n\nPreview content: plxd isn't running, so this file isn't read from disk.\n`,
    tooLarge: false,
  }),

  "accounts/list": () => ({ clis: db.clis, checkedAt: now() }),
  "accounts/refresh": () => ({ clis: db.clis, checkedAt: now() }),
  "accounts/keys/list": () => ({ accounts: db.keys }),
  "accounts/defaults/get": () => ({
    coordinator: { kind: "subscription", backend: "claude" },
    worker: { kind: "subscription", backend: "claude" },
  }),
  "accounts/defaults/set": () => ({
    coordinator: { kind: "subscription", backend: "claude" },
    worker: { kind: "subscription", backend: "claude" },
  }),
  "providers/list": () => ({ providers: db.providers, checkedAt: now() }),
  "providers/save": (p) => {
    const i = db.providers.findIndex((x) => x.instance.id === p.instance.id);
    if (i >= 0) db.providers[i] = { ...db.providers[i]!, instance: p.instance };
    return { providers: db.providers, checkedAt: now() };
  },
  "providers/remove": (p) => {
    db.providers = db.providers.filter((x) => x.instance.id !== p.id);
    return { providers: db.providers, checkedAt: now() };
  },
  "usage/get": () => ({ accounts: db.usage }),
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
  "usage/daily": (p) => ({ days: db.usageDays.filter((d) => d.date >= p.since), problems: [] }),

  "context/list": (p) => ({ files: (db.context[p.project] ?? []).map((d) => d.file) }),
  "context/read": (p) => {
    const doc = db.context[p.project]?.find((d) => d.file.path === p.path);
    return doc
      ? { file: doc.file, content: doc.content }
      : fail(`no context file ${p.path}`, "contextNotFound");
  },

  "inbox/list": (p) => ({ items: db.inbox[p.project] ?? [], seq }),
  "inbox/seen": (p) => {
    const items = (db.inbox[p.project] ?? []).filter((i) => p.items.includes(i.id));
    for (const i of items) i.seenAt ??= now();
    return { items };
  },
  "question/list": (p) => ({ questions: db.questions[p.project] ?? [] }),
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

  "queue/list": () => ({ messages: [] }),
  "queue/edit": () => ({ messages: [] }),
  "queue/reorder": () => ({ messages: [] }),
  "queue/cancel": () => ({ messages: [] }),
  "queue/steer": () => ({ messages: [] }),

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

// ---- The bridge --------------------------------------------------------------------------------

const delay = <T>(value: T, ms = 40) =>
  new Promise<T>((resolve) => setTimeout(() => resolve(value), ms));
const noop = () => {};

let localName = "macbook";
const localNameListeners = new Set<(name: string) => void>();
const connectionListeners = new Set<(hostId: string, state: ConnectionState) => void>();

const updateState: UpdateState = {};

export const mockBridge: ParallaxBridge = {
  platform: "darwin",
  version: () => delay("0.0.0-preview"),
  setThemeSource: noop,
  setAppIcon: noop,
  setZoom: (factor) => {
    document.documentElement.style.zoom = String(factor);
  },
  pickFolder: () => delay(`${HOME}/Developer/personal/new-repo`),
  copyPicture: () => delay(undefined),
  updatable: false,
  update: () => delay("Up to date"),
  onUpdateState: (listener) => {
    listener(updateState);
    return noop;
  },
  nameThread: (prompt) => {
    const words = prompt.trim().split(/\s+/).slice(0, 6);
    const title = words.join(" ").replace(/[.,:;]$/, "");
    const slug = words
      .slice(0, 4)
      .join("-")
      .toLowerCase()
      .replace(/[^a-z0-9-]/g, "");
    return delay({ title, slug: slug || undefined });
  },

  request<M extends RendererMethod>(
    hostId: string,
    method: M,
    params: ParallaxRequests[M]["params"],
  ): Promise<HostResponse<ParallaxRequests[M]["result"]>> {
    if (hostId !== LOCAL)
      return delay({ error: fail(`no host has id ${hostId}`) } as HostResponse<Result<M>>);
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
    return delay(response as HostResponse<Result<M>>);
  },

  subscribe(hostId: string, params: SubscribeParams, listener: (m: SubscriptionMessage) => void) {
    if (hostId !== LOCAL) return noop;
    const entry: Listener = {
      id: `sub-${++subscriptions}`,
      project: params.project,
      after: params.after,
      listener,
    };
    listeners.add(entry);
    return () => listeners.delete(entry);
  },
  connectionState: (hostId) =>
    hostId === LOCAL ? delay(connected, 10) : Promise.reject(new Error(`no host ${hostId}`)),
  onConnectionState: (listener) => {
    connectionListeners.add(listener);
    return () => connectionListeners.delete(listener);
  },
  retry: () => delay(undefined),

  hosts: () => delay([]),
  onHosts: () => noop,
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
  removeHost: () => delay(undefined),
  acpRegistry: () => delay([]),

  openTerminal: () => delay("Terminals don't run in the preview."),
  terminalInput: noop,
  resizeTerminal: noop,
  closeTerminal: noop,
  onTerminal: () => noop,

  openTargets: (hostId) => delay(hostId === LOCAL ? ["cursor", "vscode", "files"] : []),
  openTargetIcons: () => delay({}),
  openFolder: () => delay(undefined),

  onProfile: (listener) => {
    listener({
      name: "Ryan Stoffel",
      firstName: "Ryan",
      lastName: "Stoffel",
      email: "ryan@example.com",
    });
    return noop;
  },
  signIn: () => delay(undefined),
  saveName: () => delay(undefined),
  signOut: () => delay(undefined),

  storage: () =>
    delay([
      {
        id: "history",
        name: "Thread history",
        folder: `${HOME}/Library/Application Support/Parallax/plxd`,
        bytes: 48_211_000,
      },
      {
        id: "worktrees",
        name: "Worktrees",
        folder: `${HOME}/.parallax/worktrees`,
        bytes: 1_204_000_000,
      },
      { id: "logs", name: "Logs", folder: `${HOME}/Library/Logs/Parallax`, bytes: 9_820_000 },
      {
        id: "app",
        name: "App data",
        folder: `${HOME}/Library/Application Support/Parallax`,
        bytes: 31_400_000,
      },
      { id: "cache", name: "Cache", folder: `${HOME}/Library/Caches/Parallax`, bytes: 112_000_000 },
    ]),
  showFolder: () => delay(undefined),
  clearCache: () => delay(undefined),
};

/** For the console: the mock's state, to poke at while looking at the preview. */
export const previewState = { db, logs, repoPath: PARALLAX_PATH };
