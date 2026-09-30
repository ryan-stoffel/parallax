// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vite-plus/test";

import type { RpcResponse, SubscriptionMessage, WispBridge } from "../preload/bridge";
import type {
  AgentRun,
  LoggedEvent,
  Project,
  Repo,
  WispEvent,
} from "../protocol/generated/protocol";
import { App } from "./App";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
// happy-dom has no popovers. The Repository menu's options are in the DOM either way.
HTMLElement.prototype.hidePopover = () => {};
// happy-dom lays nothing out: a tall transcript and short rows, so the virtualized list renders all.
Object.defineProperty(HTMLElement.prototype, "offsetHeight", {
  get(this: HTMLElement) {
    return this.getAttribute("role") === "log" ? 10_000 : 20;
  },
});

const wisp: Repo = {
  id: "r-wisp",
  name: "wisp",
  path: "/src/wisp",
  createdAt: "2026-09-29T09:00:00Z",
};
const project = (name: string, updatedAt: string): Project => ({
  id: `p-${name}`,
  name,
  repoPath: `/src/${name}`,
  branch: "main",
  createdAt: "2026-09-20T12:00:00Z",
  updatedAt,
});
const now = Date.parse("2026-09-29T12:00:00Z");

type Answer = (
  params: Record<string, unknown>,
) => RpcResponse<unknown> | Promise<RpcResponse<unknown>>;
let answers: Record<string, Answer>;
let capabilities: Record<string, object>;
const request = vi.fn(async (_host: string, method: string, params: Record<string, unknown>) => {
  const answer = answers[method];
  return answer
    ? { logId: "log-1", ...(await answer(params)) }
    : { error: { code: -32601, message: `${method} isn't faked` } };
});
const pickFolder = vi.fn<() => Promise<string | null>>();
// Every subscription gets every event; each keeps what's its own.
let listeners: Set<(message: SubscriptionMessage) => void>;
const deliver = (message: SubscriptionMessage) => listeners.forEach((l) => l(message));

beforeEach(() => {
  vi.useFakeTimers({ now, toFake: ["Date"] });
  request.mockClear();
  listeners = new Set();
  capabilities = {};
  answers = {
    "thread/list": () => ({ result: { repos: [wisp], threads: [], seq: 7 } }),
    "agent/list": () => ({ result: { runs: [], seq: 7 } }),
    "project/list": () => ({
      result: {
        projects: [
          project("ember", "2026-09-26T12:00:00Z"),
          project("photon", "2026-09-29T09:00:00Z"),
        ],
        seq: 7,
      },
    }),
  };
  window.wisp = {
    platform: "darwin",
    setThemeSource: vi.fn(),
    connectionState: async () => ({
      status: "connected",
      wispd: "0.1.0",
      protocol: 1,
      capabilities,
    }),
    onConnectionState: () => () => {},
    subscribe: (_host, _params, listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    request,
    pickFolder,
    hosts: async () => [],
    onHosts: () => () => {},
  } as Partial<WispBridge> as WispBridge;
});

let unmount = () => {};
afterEach(() => {
  act(() => unmount());
  vi.useRealTimers();
});

async function renderApp() {
  const root = createRoot(document.body.appendChild(document.createElement("div")));
  act(() => root.render(<App />));
  unmount = () => {
    root.unmount();
    document.body.innerHTML = "";
  };
  await settle();
}

const settle = async () => {
  for (let i = 0; i < 10; i++) await act(async () => {});
};
const click = async (element: Element | null | undefined) => {
  await act(async () => (element as HTMLElement).click());
  await settle();
};
const projectRows = () =>
  [...document.querySelectorAll('[aria-labelledby="projects-heading"] li button')].map(
    (b) => b.textContent,
  );
const crumbs = () =>
  [...document.querySelectorAll('[aria-label="Breadcrumb"] li')].map((li) => li.textContent);
const dialog = () =>
  document.querySelector<HTMLDialogElement>('[aria-labelledby="new-project-title"]')!;
const inDialog = (name: string) =>
  [...dialog().querySelectorAll("button")].find(
    (b) => b.textContent === name || b.getAttribute("aria-label") === name,
  );
const nameBox = () => dialog().querySelector("input")!;
const calls = (method: string) =>
  request.mock.calls.filter(([, m]) => m === method).map(([, , params]) => params);

test("lists wispd's projects, most recently active first, and adds one from project.created", async () => {
  await renderApp();
  expect(projectRows()).toEqual(["photon3h", "ember3d"]);

  await act(async () =>
    deliver({
      type: "event",
      event: {
        subscription: "s-1",
        seq: 8,
        time: "2026-09-29T12:00:00Z",
        event: { kind: "project.created", project: project("wisp", "2026-09-29T12:00:00Z") },
      },
    }),
  );
  expect(projectRows()).toEqual(["wispnow", "photon3h", "ember3d"]);
});

test("a Project is one row that opens its chat: its repository and branch, with the composer off on an older wispd", async () => {
  await renderApp();
  const row = [...document.querySelectorAll("#sidebar li button")].find(
    (b) => b.textContent === "ember3d",
  );
  await click(row);
  expect(crumbs()).toEqual(["This Mac", "ember"]);
  expect(row?.getAttribute("aria-current")).toBe("page");
  const main = document.querySelector("main")!;
  expect(main.querySelector("h2")?.textContent).toBe("ember");
  expect(main.textContent).toContain("/src/ember");
  expect(main.textContent).toContain("main");
  expect(main.querySelector("textarea")!.placeholder).toBe(
    "This host's wispd can't run a Project's coordinator yet",
  );
  expect(main.querySelector<HTMLButtonElement>('button[aria-label="Send"]')!.disabled).toBe(true);
});

test("Create Project names it after its repository, shows wispd's error, retries with the same id, then opens it", async () => {
  answers["project/create"] = () => ({
    error: {
      code: -32000,
      message: "/src/wisp is not the top folder of a git repository: it has no .git.",
      data: { kind: "notARepository" },
    },
  });
  await renderApp();
  await click(document.querySelector('#sidebar button[aria-label="New project"]'));
  expect(dialog().open).toBe(true);
  expect(nameBox().value).toBe("wisp");
  // The coordinator's model is picked per message (RYA-46), not here.
  expect(dialog().querySelector('[aria-label^="Model"]')).toBeNull();

  await click(inDialog("Create Project"));
  expect(dialog().querySelector('[role="alert"]')?.textContent).toBe(
    "/src/wisp is not the top folder of a git repository: it has no .git.",
  );
  expect(dialog().open).toBe(true);

  answers["project/create"] = (p) => ({
    result: { project: { ...project("wisp", "2026-09-29T12:00:00Z"), id: p["id"] } },
  });
  await click(inDialog("Create Project"));
  const [first, retry] = calls("project/create");
  expect(first).toEqual({
    id: expect.stringMatching(/^[0-9a-f]{8}-[0-9a-f]{4}-7/),
    name: "wisp",
    repoPath: "/src/wisp",
  });
  expect(retry).toEqual(first);
  expect(dialog().open).toBe(false);
  expect(crumbs()).toEqual(["This Mac", "wisp"]);
  expect(projectRows()[0]).toBe("wispnow");
});

test("Add repository… in Create Project adds a folder and names the project after it until one is typed", async () => {
  pickFolder.mockResolvedValue("/src/other");
  answers["repo/add"] = (p) => ({
    result: { repo: { ...wisp, id: p["id"], name: "other", path: "/src/other" } },
  });
  answers["project/create"] = (p) => ({
    result: { project: { ...project("Other work", "2026-09-29T12:00:00Z"), id: p["id"] } },
  });
  await renderApp();
  await click(document.querySelector('#sidebar button[aria-label="New project"]'));
  await click(
    [...dialog().querySelectorAll('[role="menuitemradio"]')].find(
      (b) => b.textContent === "Add repository…",
    ),
  );
  expect(calls("repo/add")).toEqual([{ id: expect.any(String), path: "/src/other" }]);
  expect(inDialog("Repository: other")).toBeDefined();
  expect(nameBox().value).toBe("other");

  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(
      nameBox(),
      "Other work",
    );
    nameBox().dispatchEvent(new Event("input", { bubbles: true }));
  });
  await click(inDialog("Create Project"));
  expect(calls("project/create")).toEqual([
    { id: expect.any(String), name: "Other work", repoPath: "/src/other" },
  ]);
});

/** A Project's coordinator run, as `project/start` answers it (0024). */
const coordinatorRun = (id: string, prompt: string): AgentRun => ({
  id,
  project: "p-ember",
  prompt,
  policy: "noWrite",
  status: "running",
  backend: "claude",
  accountId: "claude",
  coordinatorThread: id,
  createdAt: "2026-09-29T12:00:00Z",
  updatedAt: "2026-09-29T12:00:00Z",
});
/** `agent/events` for whichever of `runs` is asked for: it started, then said it would plan. */
const serveEvents = (runs: () => (AgentRun | undefined)[]) => (params: Record<string, unknown>) => {
  const r = runs().find((run) => run?.id === params["runId"])!;
  const events: LoggedEvent[] = [
    { seq: 8, time: "", event: { kind: "agent.started", runId: r.id, run: r } },
    {
      seq: 9,
      time: "",
      event: {
        kind: "agent.output",
        runId: r.id,
        items: [{ kind: "text", text: "I'll plan it." }],
      },
    },
  ];
  return { result: { events: events.filter((e) => e.seq > Number(params["after"])), more: false } };
};
const openEmber = () =>
  click(
    [...document.querySelectorAll("#sidebar li button")].find((b) => b.textContent === "ember3d"),
  );
const type = (text: string) => {
  const box = document.querySelector("main textarea")!;
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(box, text);
    box.dispatchEvent(new Event("input", { bubbles: true }));
  });
};
const button = (label: string) =>
  document.querySelector<HTMLButtonElement>(`main button[aria-label="${label}"]`);
const transcript = () => document.querySelector('[role="log"]')?.textContent ?? "";

test("a Project's first message starts its coordinator; later ones and Stop go to its run", async () => {
  capabilities = { coordinator: {} };
  let started: AgentRun | undefined;
  answers["accounts/defaults/get"] = () => ({
    result: { coordinator: { kind: "subscription", backend: "claude" } },
  });
  let release = () => {};
  answers["project/start"] = async (p) => {
    await new Promise<void>((resolve) => (release = resolve));
    started = coordinatorRun(p["runId"] as string, p["prompt"] as string);
    return { result: { run: started } };
  };
  answers["agent/events"] = serveEvents(() => [started]);
  answers["agent/send"] = () => ({ result: { run: started } });
  answers["agent/cancel"] = () => ({ result: { run: started } });
  await renderApp();
  await openEmber();
  // Claude's models and permission modes: a coordinator runs in the mode it's given (0026).
  expect(button("Model: Claude Opus 5.5")).not.toBeNull();
  expect(button("Access: Accept Edits")).not.toBeNull();

  type("Add a dark mode");
  await click(button("Send"));
  // Off while it starts, so a second Send can't race the first.
  expect(document.querySelector<HTMLTextAreaElement>("main textarea")!.placeholder).toBe(
    "Starting the coordinator…",
  );
  await act(async () => release());
  await settle();
  expect(calls("project/start")).toEqual([
    {
      project: "p-ember",
      runId: expect.stringMatching(/^[0-9a-f]{8}-[0-9a-f]{4}-7/),
      prompt: "Add a dark mode",
      model: "claude-opus-5-5",
      effort: "high",
      permission: "edit",
    },
  ]);
  expect(transcript()).toContain("Add a dark mode");
  expect(transcript()).toContain("I'll plan it.");
  // The tab is the Project's repository, not a thread's worktree.
  const main = document.querySelector("main")!;
  expect(main.textContent).toContain("/src/ember");
  expect(main.textContent).not.toContain("Worktree");

  type("Start with the settings page");
  await click(button("Send"));
  expect(calls("agent/send")).toEqual([
    { runId: started!.id, turnId: expect.any(String), text: "Start with the settings page" },
  ]);
  await click(button("Stop"));
  expect(calls("agent/cancel")).toEqual([{ runId: started!.id }]);
  expect(calls("project/start")).toHaveLength(1);
});

test("a Project whose coordinator ran before opens on its transcript", async () => {
  capabilities = { coordinator: {} };
  const run = coordinatorRun("01a0d390-2c3d-7e4f-9a0b-1c2d3e4f5a6b", "Add a dark mode");
  answers["project/list"] = () => ({
    result: { projects: [{ ...project("ember", "2026-09-26T12:00:00Z"), coordinator: run.id }] },
  });
  answers["agent/events"] = serveEvents(() => [run]);
  await renderApp();
  await openEmber();
  expect(transcript()).toContain("Add a dark mode");
  expect(transcript()).toContain("I'll plan it.");
  expect(calls("project/start")).toEqual([]);
});

test("with no coordinator account, the coordinator runs on the host's Claude Code login and says so", async () => {
  capabilities = { coordinator: {} };
  let started: AgentRun | undefined;
  answers["accounts/defaults/get"] = () => ({ result: {} });
  answers["accounts/list"] = () => ({ result: { clis: [{ cli: "claude", signedIn: true }] } });
  answers["accounts/keys/list"] = () => ({ result: { accounts: [] } });
  answers["project/start"] = (p) => {
    if (!p["account"])
      return {
        error: {
          code: -32000,
          message: "no account was named",
          data: { kind: "noDefaultAccount" },
        },
      };
    started = coordinatorRun(p["runId"] as string, p["prompt"] as string);
    return { result: { run: started } };
  };
  answers["agent/events"] = serveEvents(() => [started]);
  await renderApp();
  await openEmber();
  type("Add a dark mode");
  await click(button("Send"));

  // On the run, not as the host's default.
  const [first, retry] = calls("project/start");
  expect(retry).toEqual({ ...first, account: { kind: "subscription", backend: "claude" } });
  expect(calls("accounts/defaults/set")).toEqual([]);
  expect(document.querySelector('main [role="status"]')?.textContent).toBe(
    "Using Claude Code for this Project's coordinator.",
  );
  expect(transcript()).toContain("I'll plan it.");
});

const startOverButton = () =>
  [...document.querySelectorAll("main button")].find((b) => b.textContent === "Start over");
/** Ember, whose coordinator is `old`, which `agent/events` serves along with any new one. */
function emberWith(old: AgentRun) {
  capabilities = { coordinator: {} };
  const runs: AgentRun[] = [old];
  answers["project/list"] = () => ({
    result: { projects: [{ ...project("ember", "2026-09-26T12:00:00Z"), coordinator: old.id }] },
  });
  answers["agent/events"] = serveEvents(() => runs);
  answers["project/start"] = (p) => {
    runs.push(coordinatorRun(p["runId"] as string, p["prompt"] as string));
    return { result: { run: runs.at(-1) } };
  };
}
const oldId = "01a0d390-2c3d-7e4f-9a0b-1c2d3e4f5a6b";

test("a coordinator wispd can't resume offers Start over, which replaces it with the refused message", async () => {
  emberWith({
    ...coordinatorRun(oldId, "Add a dark mode"),
    status: "completed",
    sessionId: "s-1",
    model: "claude-sonnet-5",
    effort: "low",
  });
  answers["agent/send"] = () => ({
    error: {
      code: -32000,
      message: `run ${oldId} can't be resumed: its session's account claude no longer exists`,
      data: { kind: "runNotResumable" },
    },
  });
  await renderApp();
  await openEmber();
  expect(startOverButton()).toBeUndefined();

  type("Keep going");
  await click(button("Send"));
  expect(startOverButton()!.parentElement!.textContent).toBe(
    `This chat can't continue: run ${oldId} can't be resumed: its session's account claude no longer exists Start over`,
  );
  await click(startOverButton());
  // A new run id, which 0024 lets replace a coordinator that isn't running, on the old one's model.
  expect(calls("project/start")).toEqual([
    {
      project: "p-ember",
      runId: expect.not.stringMatching(oldId),
      prompt: "Keep going",
      model: "claude-sonnet-5",
      effort: "low",
    },
  ]);
  expect(transcript()).toContain("Keep going");
  expect(startOverButton()).toBeUndefined();
});

test("a coordinator that stopped before its session started offers Start over with its first message", async () => {
  emberWith({ ...coordinatorRun(oldId, "Add a dark mode"), status: "failed" });
  await renderApp();
  await openEmber();
  await click(startOverButton());
  expect(calls("project/start")).toMatchObject([{ prompt: "Add a dark mode" }]);
  expect(calls("agent/send")).toEqual([]);
});

const coordinatorId = "01a0d390-2c3d-7e4f-9a0b-1c2d3e4f5a6b";
/** A subagent of ember's coordinator, which started it unless `coordinatorThread` is cleared. */
const subagent = (id: string, prompt: string, more: Partial<AgentRun> = {}): AgentRun => ({
  ...coordinatorRun(id, prompt),
  policy: "workspaceWrite",
  coordinatorThread: coordinatorId,
  ...more,
});
const login = subagent("01a0d391-0000-7000-8000-000000000001", "Fix the login bug\nwith a test", {
  status: "completed",
  branch: "wisp/login",
  diff: { commit: "c1", files: 2, insertions: 12, deletions: 3 },
  sessionId: "s-1",
});
const docs = subagent("01a0d391-0000-7000-8000-000000000002", "Write the docs", {
  coordinatorThread: undefined,
  accountId: "01a0d34b-3c4d-7e5f-a061-7b8c9d0e1f22",
  branch: "wisp/docs",
});
/**
 * Ember with a coordinator and `runs` after it, served by `agent/list` and `agent/events`, open
 * with its Agents view. Photon has no runs.
 */
async function openEmberAgents(...runs: AgentRun[]) {
  capabilities = { coordinator: {}, openPr: {} };
  const all = [coordinatorRun(coordinatorId, "Plan the release"), ...runs];
  answers["project/list"] = () => ({
    result: {
      projects: [
        { ...project("ember", "2026-09-26T12:00:00Z"), coordinator: coordinatorId },
        project("photon", "2026-09-29T09:00:00Z"),
      ],
    },
  });
  answers["agent/list"] = (p) => ({
    result: { runs: p["project"] === "p-ember" ? all : [], seq: 7 },
  });
  answers["agent/events"] = serveEvents(() => all);
  await renderApp();
  await openEmber();
  await click(button("Show side panel"));
  await click(
    [...document.querySelectorAll("#side-panel button")].find((b) =>
      b.textContent?.startsWith("Agents"),
    ),
  );
}
const agentRows = () =>
  [...document.querySelectorAll('#side-panel [aria-label="Agents"] button')].map(
    (b) => b.textContent,
  );
const agentRow = (title: string) =>
  [...document.querySelectorAll('#side-panel [aria-label="Agents"] button')].find((b) =>
    b.textContent?.startsWith(title),
  );

test("a Project's Agents view lists its subagents newest first, without its coordinator, and keeps them live", async () => {
  await openEmberAgents(login, docs);
  expect(agentRows()).toEqual([
    "Write the docsby youWorkingwisp/docsAPI key",
    "Fix the login bugby coordinatorDonewisp/login+12 −3Claude subscription",
  ]);

  const event = (seq: number, e: WispEvent) =>
    act(async () =>
      deliver({ type: "event", event: { subscription: "s-2", seq, time: "", event: e } }),
    );
  const tests = subagent("01a0d391-0000-7000-8000-000000000003", "Add the tests");
  await event(8, { kind: "agent.started", runId: tests.id, run: tests });
  await event(9, {
    kind: "agent.updated",
    runId: docs.id,
    state: {
      status: "completed",
      accountId: docs.accountId,
      diff: { commit: "c2", files: 1, insertions: 4, deletions: 0 },
      updatedAt: "2026-09-29T12:05:00Z",
    },
  });
  expect(agentRows()).toEqual([
    "Add the testsby coordinatorWorkingClaude subscription",
    "Write the docsby youDonewisp/docs+4 −0API key",
    "Fix the login bugby coordinatorDonewisp/login+12 −3Claude subscription",
  ]);
});

test("opening a subagent shows its chat, with Open PR, and the Project crumb goes back to the coordinator", async () => {
  answers["agent/send"] = () => ({ result: { run: login } });
  await openEmberAgents(login, docs);
  await click(agentRow("Fix the login bug"));
  expect(crumbs()).toEqual(["This Mac", "ember", "Fix the login bug"]);
  expect(agentRow("Fix the login bug")!.getAttribute("aria-current")).toBe("page");
  // The Project stays selected in the sidebar.
  const ember = [...document.querySelectorAll("#sidebar li button")].find(
    (b) => b.textContent === "ember3d",
  );
  expect(ember!.getAttribute("aria-current")).toBe("page");
  expect(transcript()).toContain("Fix the login bug");
  const main = document.querySelector("main")!;
  expect(main.textContent).toContain("Open PR");

  type("Cover the logout path too");
  await click(button("Send"));
  expect(calls("agent/send")).toEqual([
    { runId: login.id, turnId: expect.any(String), text: "Cover the logout path too" },
  ]);

  await click(document.querySelector('[aria-label="Breadcrumb"] button'));
  expect(crumbs()).toEqual(["This Mac", "ember"]);
  expect(transcript()).toContain("Plan the release");
});

test("opening a subagent from an expanded side panel shrinks it, so the chat shows", async () => {
  await openEmberAgents(login);
  await click(document.querySelector('#side-panel button[aria-label="Expand panel"]'));
  expect(document.querySelector("main")!.hidden).toBe(true);
  await click(agentRow("Fix the login bug"));
  expect(document.querySelector("main")!.hidden).toBe(false);
  expect(crumbs()).toEqual(["This Mac", "ember", "Fix the login bug"]);
});

test("a running subagent's chat stops it", async () => {
  answers["agent/cancel"] = () => ({ result: { run: docs } });
  await openEmberAgents(docs);
  await click(agentRow("Write the docs"));
  await click(button("Stop"));
  expect(calls("agent/cancel")).toEqual([{ runId: docs.id }]);
});

test("the Agents view starts a subagent by hand, reusing its id to retry", async () => {
  let fail = true;
  answers["agent/start"] = (p) =>
    fail
      ? {
          error: {
            code: -32000,
            message: "no account was named",
            data: { kind: "noDefaultAccount" },
          },
        }
      : { result: { run: subagent(p["runId"] as string, p["prompt"] as string) } };
  await openEmberAgents();
  const box = document.querySelector<HTMLTextAreaElement>(
    '#side-panel textarea[aria-label="New subagent\'s task"]',
  )!;
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(
      box,
      "Bump the version",
    );
    box.dispatchEvent(new Event("input", { bubbles: true }));
  });
  const start = document.querySelector('#side-panel button[aria-label="Start subagent"]');
  await click(start);
  expect(document.querySelector('#side-panel [role="alert"]')?.textContent).toBe(
    "Choose an account to run threads on this host.",
  );

  fail = false;
  await click(start);
  const [first, retry] = calls("agent/start");
  expect(first).toEqual({
    runId: expect.stringMatching(/^[0-9a-f]{8}-[0-9a-f]{4}-7/),
    project: "p-ember",
    prompt: "Bump the version",
    policy: "workspaceWrite",
  });
  expect(retry).toEqual(first);
  expect(box.value).toBe("");
  expect(agentRows()[0]).toMatch(/^Bump the version/);
});

test("another Project's Agents view starts with an empty box and never gets a late start", async () => {
  let release = () => {};
  answers["agent/start"] = async (p) => {
    await new Promise<void>((resolve) => (release = resolve));
    return { result: { run: subagent(p["runId"] as string, p["prompt"] as string) } };
  };
  await openEmberAgents();
  const box = () =>
    document.querySelector<HTMLTextAreaElement>(
      '#side-panel textarea[aria-label="New subagent\'s task"]',
    )!;
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(
      box(),
      "Bump the version",
    );
    box().dispatchEvent(new Event("input", { bubbles: true }));
  });
  await click(document.querySelector('#side-panel button[aria-label="Start subagent"]'));

  await click(
    [...document.querySelectorAll("#sidebar li button")].find((b) => b.textContent === "photon3h"),
  );
  expect(crumbs()).toEqual(["This Mac", "photon"]);
  expect(box().value).toBe("");
  await act(async () => release());
  await settle();
  expect(agentRows()).toEqual([]);
});
