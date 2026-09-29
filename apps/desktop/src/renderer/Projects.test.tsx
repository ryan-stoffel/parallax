// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vite-plus/test";

import type { RpcResponse, SubscriptionMessage, WispBridge } from "../preload/bridge";
import type { AgentRun, LoggedEvent, Project, Repo } from "../protocol/generated/protocol";
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
let deliver: (message: SubscriptionMessage) => void;

beforeEach(() => {
  vi.useFakeTimers({ now, toFake: ["Date"] });
  request.mockClear();
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
      deliver = listener;
      return () => {};
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
  // Claude's models, and no Access: a coordinator never writes.
  expect(button("Model: Claude Opus 5.5")).not.toBeNull();
  expect(document.querySelector('main [aria-label^="Access"]')).toBeNull();

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
