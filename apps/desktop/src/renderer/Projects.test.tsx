// @vitest-environment happy-dom
import type { TiptapEditorHTMLElement } from "@tiptap/react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vite-plus/test";

import type {
  ConnectionState,
  RpcResponse,
  SshHost,
  SubscriptionMessage,
  ParallaxBridge,
} from "../preload/bridge";
import type {
  AgentOutputItem,
  AgentRun,
  LoggedEvent,
  Project,
  Repo,
  Thread,
} from "../protocol/generated/protocol";
import { App } from "./App";
import { scopeStore } from "./scope";
import { sectionsStore } from "./Sidebar";
import { sidebarDefaults, sidebarPrefs } from "./sidebarPrefs";
import { fakeWatch } from "./fakeWatch";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
// happy-dom has no popovers. The Workspace menu's items are in the DOM either way. Showing one
// sends only the event that draws an icon picker, and keeps what it was shown under.
HTMLElement.prototype.hidePopover = () => {};
let popoverSources: (HTMLElement | undefined)[];
HTMLElement.prototype.showPopover = function (this: HTMLElement, options?: ShowPopoverOptions) {
  popoverSources.push(options?.source);
  this.dispatchEvent(
    Object.assign(new Event("beforetoggle"), { oldState: "closed", newState: "open" }),
  );
};
// happy-dom lays nothing out: a tall transcript and short rows, so the virtualized list renders all.
Object.defineProperty(HTMLElement.prototype, "offsetHeight", {
  get(this: HTMLElement) {
    return this.getAttribute("role") === "log" ? 10_000 : 20;
  },
});

const parallax: Repo = {
  id: "r-parallax",
  name: "parallax",
  path: "/src/parallax",
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
  host: string,
) => RpcResponse<unknown> | Promise<RpcResponse<unknown>>;
let answers: Record<string, Answer>;
let capabilities: Record<string, object>;
const request = vi.fn(async (host: string, method: string, params: Record<string, unknown>) => {
  const answer = answers[method];
  return answer
    ? { logId: "log-1", ...(await answer(params, host)) }
    : { error: { code: -32601, message: `${method} isn't faked` } };
});
const pickFolder = vi.fn<() => Promise<string | null>>();
const listFolders = vi.fn<ParallaxBridge["listFolders"]>();
const createRepo = vi.fn<ParallaxBridge["createRepo"]>();
// Every subscription gets every event; each keeps what's its own.
let listeners: Set<(message: SubscriptionMessage) => void>;
const deliver = (message: SubscriptionMessage) => listeners.forEach((l) => l(message));
// The saved SSH hosts, and each host's connection state: connected unless set here.
let sshHosts: SshHost[];
let states: Record<string, ConnectionState>;
let stateListeners: Set<(hostId: string, state: ConnectionState) => void>;

beforeEach(() => {
  vi.useFakeTimers({ now, toFake: ["Date"] });
  request.mockClear();
  localStorage.clear();
  sidebarPrefs.set(sidebarDefaults);
  sectionsStore.set({});
  scopeStore.set("all");
  popoverSources = [];
  listeners = new Set();
  capabilities = {};
  sshHosts = [];
  states = {};
  stateListeners = new Set();
  answers = {
    "thread/list": () => ({ result: { repos: [parallax], threads: [], seq: 7 } }),
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
  window.parallax = {
    onHostUpdate: () => () => {},
    onProfile: () => () => {},
    platform: "darwin",
    setThemeSource: vi.fn(),
    connectionState: async (hostId) =>
      states[hostId] ?? { status: "connected", plxd: "0.1.0", protocol: 1, capabilities },
    onConnectionState: (listener) => {
      stateListeners.add(listener);
      return () => stateListeners.delete(listener);
    },
    watch: fakeWatch(() => window.parallax),
    subscribe: (_host, _params, listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    request,
    pickFolder,
    listFolders,
    createRepo,
    hosts: async () => sshHosts,
    onHosts: () => () => {},
    onConnect: () => () => {},
    onDevices: () => () => {},
    onLocalName: (listener: (name: string) => void) => {
      listener("This Mac");
      return () => {};
    },
    setZoom: () => {},
    openTargets: async () => [],
    terminalApps: async () => [],
    terminalApp: async () => null,
    openTargetIcons: async () => ({}),
  } as Partial<ParallaxBridge> as ParallaxBridge;
});

let unmount = () => {};
afterEach(() => {
  // The app keeps its notifications between tests, so close this test's.
  for (const close of document.querySelectorAll<HTMLButtonElement>(
    '[aria-label="Notifications"] [aria-label="Close"]',
  ))
    act(() => close.click());
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
// Each Project's favorite, by name, in the sidebar's order (0075).
const projectRows = () =>
  [...document.querySelectorAll('#sidebar [aria-label="Favorites"] button[data-row]')].map((b) =>
    b.getAttribute("aria-label"),
  );
const crumbs = () =>
  [...document.querySelectorAll('[aria-label="Breadcrumb"] li')].map((li) => li.textContent);
const dialog = () =>
  document.querySelector<HTMLDialogElement>('dialog[aria-label="New project or repository"]')!;
const inDialog = (name: string) =>
  [...dialog().querySelectorAll("button")].find(
    (b) => b.textContent === name || b.getAttribute("aria-label") === name,
  );
const nameBox = () => dialog().querySelector<HTMLInputElement>('input[aria-label="Name"]')!;
// The main pane's composer, whose editor Tiptap keeps on its element for tests.
const composer = () =>
  document.querySelector<TiptapEditorHTMLElement>('main [role="textbox"][aria-label="Message"]');
const calls = (method: string) =>
  request.mock.calls.filter(([, m]) => m === method).map(([, , params]) => params);
/** The messages sent, as `message.dispatch` commands (0059), with the ids `agent/send` named. */
const sentMessages = () =>
  calls("orchestration/dispatch")
    .filter((p) => p["type"] === "message.dispatch")
    .map((p) => ({ runId: p["threadId"], turnId: p["messageId"], text: p["text"] }));
/** The runs Stop interrupted, as `run.interrupt` commands. */
const stops = () =>
  calls("orchestration/dispatch")
    .filter((p) => p["type"] === "run.interrupt")
    .map((p) => ({ runId: p["threadId"] }));
/** The host each `method` call went to, in order. */
const hostsOf = (method: string) =>
  request.mock.calls.filter(([, m]) => m === method).map(([host]) => host);
const typeInto = (box: HTMLInputElement, text: string) =>
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(box, text);
    box.dispatchEvent(new Event("input", { bubbles: true }));
  });

/** The add palette's options, or the folders of its folder step, by name. */
const paletteOptions = () => [
  ...dialog().querySelectorAll<HTMLButtonElement>('[role="listbox"] [role="option"]'),
];
const paletteOption = (name: string) =>
  paletteOptions().find((b) => b.textContent?.startsWith(name));
const openPalette = () =>
  click(document.querySelector('#sidebar button[aria-label="New project or repository"]'));
const openNewProject = async () => {
  await openPalette();
  await click(paletteOption("New Project"));
};
const workspaceButton = () =>
  dialog().querySelector('button[aria-haspopup="menu"]')!.getAttribute("aria-label");

test("lists plxd's Projects as favorites by name, keeping the order they're moved into, and adds one from project.created", async () => {
  await renderApp();
  expect(projectRows()).toEqual(["ember", "photon"]);

  await act(async () =>
    deliver({
      type: "event",
      event: {
        subscription: "s-1",
        seq: 8,
        time: "2026-09-29T12:00:00Z",
        event: { kind: "project.created", project: project("parallax", "2026-09-29T12:00:00Z") },
      },
    }),
  );
  expect(projectRows()).toEqual(["ember", "parallax", "photon"]);
  // Moved, it stays put, however busy the others get.
  act(
    () =>
      void rowButton("photon").dispatchEvent(
        new KeyboardEvent("keydown", { key: "ArrowLeft", altKey: true, bubbles: true }),
      ),
  );
  await settle();
  expect(projectRows()).toEqual(["ember", "photon", "parallax"]);
});

test("Create Project names it after its repository, shows plxd's error, retries with the same id, then opens it", async () => {
  answers["project/create"] = () => ({
    error: {
      code: -32000,
      message: "/src/parallax is not the top folder of a git repository: it has no .git.",
      data: { kind: "notARepository" },
    },
  });
  await renderApp();
  await openNewProject();
  expect(dialog().open).toBe(true);
  // A large name under the Project's icon, then the Workspace: the open host's first repository.
  expect(nameBox().value).toBe("parallax");
  expect(nameBox().placeholder).toBe("New Project");
  expect(workspaceButton()).toBe("Workspace: parallax on This Mac");
  // The coordinator's model is picked per message (PLX-46), not here.
  expect(dialog().querySelector('[aria-label^="Model"]')).toBeNull();
  typeInto(nameBox(), "");
  expect(inDialog("Create Project")!.disabled).toBe(true);
  typeInto(nameBox(), "parallax");

  await click(inDialog("Create Project"));
  expect(dialog().querySelector('[role="alert"]')?.textContent).toBe(
    "/src/parallax is not the top folder of a git repository: it has no .git.",
  );
  expect(dialog().open).toBe(true);

  answers["project/create"] = (p) => ({
    result: { project: { ...project("parallax", "2026-09-29T12:00:00Z"), id: p["id"] } },
  });
  await click(inDialog("Create Project"));
  const [first, retry] = calls("project/create");
  expect(first).toEqual({
    id: expect.stringMatching(/^[0-9a-f]{8}-[0-9a-f]{4}-7/),
    name: "parallax",
    repoPath: "/src/parallax",
  });
  expect(retry).toEqual(first);
  expect(hostsOf("project/create")).toEqual(["local", "local"]);
  expect(dialog().open).toBe(false);
  expect(crumbs()).toEqual(["This Mac", "parallax"]);
  expect(projectRows()).toContain("parallax");
});

/** A folder listing for `listFolders`, under /Users/me. */
const folders = (dir: string, names: string[]) => ({
  path: dir,
  folders: names.map((name) => ({ name, path: `${dir}/${name}` })),
});
const tree: Record<string, string[]> = {
  "/Users/me": ["Desktop", "Developer", "Documents", ".config"],
  "/Users/me/Developer": ["parallax", "photon"],
};
const listTree = async (input: string) => {
  const dir = input.replace(/^~/, "/Users/me").replace(/\/$/, "");
  return folders(dir, tree[dir] ?? []);
};
const field = () => dialog().querySelector<HTMLInputElement>("input")!;
const action = (label: string) =>
  [...dialog().querySelectorAll("button")].find((b) => b.textContent?.startsWith(label));
const pressKey = (key: string, init: KeyboardEventInit = {}) =>
  act(() => {
    document.activeElement!.dispatchEvent(
      new KeyboardEvent("keydown", { key, bubbles: true, ...init }),
    );
  });

test("a failed clone says why above the folders, where a long list can't push it out of view (PLX-1007)", async () => {
  listFolders.mockImplementation(listTree);
  answers["repo/clone"] = () => ({
    error: {
      code: -32000,
      message: "repository 'https://github.com/ryan-stoffel/photon.git/' not found",
      data: { kind: "cloneFailed" },
    },
  });
  await renderApp();
  await openPalette();
  await click(paletteOption("Clone from GitHub"));
  typeInto(field(), "ryan-stoffel/photon");
  pressKey("Enter");
  await settle();
  await click(action("Clone"));

  const alert = dialog().querySelector('[role="alert"]')!;
  expect(alert.textContent).toBe(
    "repository 'https://github.com/ryan-stoffel/photon.git/' not found",
  );
  const folders = dialog().querySelector('[role="listbox"][aria-label="Folders"]')!;
  expect(alert.compareDocumentPosition(folders) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(dialog().open).toBe(true);
});

const favorites = () => document.querySelector<HTMLElement>('#sidebar [aria-label="Favorites"]')!;
/** A Project's favorite square in the sidebar, by its name (0075). */
const rowButton = (name: string) =>
  favorites().querySelector<HTMLButtonElement>(`button[aria-label="${name}"]`)!;
// The favorites' menu, as a right-click on `name`'s square fills it in.
const menuItems = (name: string) => {
  act(() => void rowButton(name).dispatchEvent(new MouseEvent("contextmenu", { bubbles: true })));
  return [
    ...document.querySelectorAll<HTMLButtonElement>(
      '[role="menu"][aria-label="Favorite"] [role="menuitem"]',
    ),
  ];
};
const menuItem = (name: string, item: string) =>
  menuItems(name).find((b) => b.textContent === item);

const modeChoice = (within: Element) =>
  [...within.querySelectorAll<HTMLInputElement>('input[type="radio"]')].filter((r) =>
    ["auto", "bypass"].includes(r.value),
  );

test("with projectPermission and projectAutonomy, Create Project asks for full access, on by default, and autonomy, the same on a retry", async () => {
  capabilities = { projectPermission: {}, projectAutonomy: {} };
  let fails = 1;
  answers["project/create"] = (p) =>
    fails-- > 0
      ? { error: { code: -32000, message: "not a repository" } }
      : { result: { project: { ...project("parallax", "2026-09-29T12:00:00Z"), id: p["id"] } } };
  await renderApp();
  await openNewProject();
  expect(modeChoice(dialog())).toEqual([]);
  expect(dialog().textContent).toContain(
    "Agents in this Project run commands and edit files without asking.",
  );
  const fullAccess = dialog().querySelector<HTMLInputElement>('input[role="switch"]')!;
  expect(fullAccess.checked).toBe(true);
  const autonomy = (value: string) =>
    dialog().querySelector<HTMLInputElement>(
      `fieldset[aria-label="Autonomy"] input[value="${value}"]`,
    )!;
  expect(autonomy("routine").checked).toBe(true);

  await click(inDialog("Create Project"));
  await click(fullAccess);
  await click(autonomy("ask"));
  await click(inDialog("Create Project"));
  const [first, second] = calls("project/create");
  expect(first).toEqual({
    id: expect.any(String),
    name: "parallax",
    repoPath: "/src/parallax",
    permission: "bypass",
    autonomy: "routine",
  });
  expect(second).toEqual({ ...first, id: expect.any(String), permission: "auto", autonomy: "ask" });
  expect(second!["id"]).not.toBe(first!["id"]);
  expect(dialog().open).toBe(false);
});

test("with projectPermission, a Project not in Bypass offers Full access…, a one-way move to Bypass, and one in Bypass offers no mode", async () => {
  capabilities = { projectPermission: {} };
  answers["project/list"] = () => ({
    result: {
      projects: [
        { ...project("ember", "2026-09-26T12:00:00Z"), permission: "auto" },
        { ...project("photon", "2026-09-29T09:00:00Z"), permission: "bypass" },
      ],
      seq: 7,
    },
  });
  answers["project/update"] = (p) => ({
    result: {
      project: { ...project("ember", "2026-09-26T12:00:00Z"), permission: p["permission"] },
    },
  });
  await renderApp();
  expect(menuItem("photon", "Full access…")).toBeUndefined();
  await click(menuItem("ember", "Full access…"));
  const access = document.querySelector<HTMLDialogElement>(
    'dialog[aria-label="ember full access"]',
  )!;
  expect(access.open).toBe(true);
  expect(access.textContent).toContain("Agents running now keep asking until they next start.");
  expect(access.textContent).toContain("You can't switch back.");
  expect(modeChoice(access)).toEqual([]);
  await click(
    [...access.querySelectorAll("button")].find((b) => b.textContent === "Give full access"),
  );
  expect(access.open).toBe(false);
  expect(calls("project/update")).toEqual([{ project: "p-ember", permission: "bypass" }]);
  expect(menuItem("ember", "Full access…")).toBeUndefined();
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
const openEmber = () => click(rowButton("ember"));
const type = (text: string) => act(() => void composer()!.editor!.commands.setContent(text));
const button = (label: string) =>
  document.querySelector<HTMLButtonElement>(`main button[aria-label="${label}"]`);
const transcript = () => document.querySelector('[role="log"]')?.textContent ?? "";

test("a Project's first message starts its coordinator and shows at once; ones sent meanwhile, later ones, and Stop go to its run", async () => {
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
  answers["orchestration/dispatch"] = () => ({ result: { seq: 1 } });
  await renderApp();
  await openEmber();
  // Claude's models and permission modes: a coordinator runs in the mode it's given (0027).
  expect(button("Model: Claude Opus 5.5")).not.toBeNull();
  expect(button("Access: Auto-accept edits")).not.toBeNull();
  // Every message goes to the coordinator, with no target to pick.
  expect(document.querySelector('main button[aria-label^="Sends to: "]')).toBeNull();

  type("Add a dark mode");
  await click(button("Send"));
  // The message shows at once, as a thread's does, and the box takes the next one.
  expect(transcript()).toContain("Add a dark mode");
  expect(composer()!.getAttribute("aria-placeholder")).toBe(
    "Reply, add detail, or steer what it does next",
  );
  type("Fix the login bug");
  await click(button("Send"));
  expect(transcript()).toContain("Fix the login bug");
  expect(sentMessages()).toEqual([]);
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
  // The tab is the host and checkout, not a thread's worktree or the full path.
  const main = document.querySelector("main")!;
  expect(main.querySelector('[aria-label="This Mac · Local checkout"]')).not.toBeNull();
  expect(main.querySelector('[aria-label$="Worktree"]')).toBeNull();
  expect(main.textContent).not.toContain("/src/ember");

  type("Start with the settings page");
  await click(button("Send"));
  expect(sentMessages()).toEqual([
    { runId: started!.id, turnId: expect.any(String), text: "Fix the login bug" },
    { runId: started!.id, turnId: expect.any(String), text: "Start with the settings page" },
  ]);
  await click(button("Stop"));
  expect(stops()).toEqual([{ runId: started!.id }]);
  expect(calls("project/start")).toHaveLength(1);
});

test("with projectPermission, a Project's composers have no permission picker or mode, and send no permission", async () => {
  capabilities = { coordinator: {}, projectPermission: {} };
  let started: AgentRun | undefined;
  answers["project/list"] = () => ({
    result: {
      projects: [{ ...project("ember", "2026-09-26T12:00:00Z"), permission: "bypass" }],
      seq: 7,
    },
  });
  answers["accounts/defaults/get"] = () => ({
    result: { coordinator: { kind: "subscription", backend: "claude" } },
  });
  answers["project/start"] = (p) => {
    started = {
      ...coordinatorRun(p["runId"] as string, p["prompt"] as string),
      permission: "edit",
    };
    return { result: { run: started } };
  };
  answers["agent/events"] = serveEvents(() => [started]);
  answers["orchestration/dispatch"] = () => ({ result: { seq: 1 } });
  const access = () => document.querySelector('main button[aria-label^="Access:"]');
  const main = () => document.querySelector("main")!.textContent;
  await renderApp();
  await openEmber();
  expect(access()).toBeNull();
  expect(main()).not.toContain("Bypass");

  type("Add a dark mode");
  await click(button("Send"));
  expect(calls("project/start")).toEqual([
    expect.not.objectContaining({ permission: expect.anything() }),
  ]);
  // The coordinator's chat too, though its run says another mode.
  expect(access()).toBeNull();
  expect(main()).not.toContain("Bypass");
  type("Start with the settings page");
  await click(button("Send"));
  expect(sentMessages()).toEqual([
    { runId: started!.id, turnId: expect.any(String), text: "Start with the settings page" },
  ]);
});

const coordinatorId = "01a0d390-2c3d-7e4f-9a0b-1c2d3e4f5a6b";
/** A subagent of ember's coordinator, which started it unless `coordinatorThread` is cleared. */
const subagent = (id: string, prompt: string, more: Partial<AgentRun> = {}): AgentRun => ({
  ...coordinatorRun(id, prompt),
  policy: "workspaceWrite",
  coordinatorThread: coordinatorId,
  ...more,
});
/** Opens a side panel view from its list, as + does. A Project opens the panel on its own tab. */
async function openView(name: string) {
  await click(document.querySelector('#side-panel button[aria-label="Open a view"]'));
  await click(
    [...document.querySelectorAll("#side-panel nav button")].find((b) =>
      b.textContent?.startsWith(name),
    ),
  );
}
const agentRow = (title: string) =>
  [...document.querySelectorAll('#side-panel [aria-label="Agents"] button')].find((b) =>
    b.textContent?.startsWith(title),
  );

// --- PLX-196: permission requests in a Project ---

const bashAsk = (approvalId: string): AgentOutputItem => ({
  kind: "approvalRequested",
  approvalId,
  toolName: "Bash",
  input: { command: "git tag v1.2.0" },
  callId: `toolu_${approvalId}`,
  expiresAt: "2026-09-29T12:30:00Z",
});
/**
 * Ember open on its coordinator, if it has one, with `runs` after it. Each run's log is its start,
 * then `items` for it as one output. plxd advertises approvals, and allows what's answered.
 */
async function openEmberAsking(
  coordinator: AgentRun | undefined,
  runs: AgentRun[],
  items: Record<string, AgentOutputItem[]>,
) {
  capabilities = { coordinator: {}, approvals: {} };
  const all = [...(coordinator ? [coordinator] : []), ...runs];
  answers["project/list"] = () => ({
    result: {
      projects: [{ ...project("ember", "2026-09-26T12:00:00Z"), coordinator: coordinator?.id }],
      seq: 7,
    },
  });
  answers["agent/list"] = (p) => ({
    result: { runs: [undefined, "p-ember"].includes(p["project"] as string) ? all : [], seq: 7 },
  });
  answers["agent/events"] = (params) => {
    const r = all.find((run) => run.id === params["runId"])!;
    const events: LoggedEvent[] = [
      {
        seq: 8,
        time: "2026-09-29T12:00:00Z",
        event: { kind: "agent.started", runId: r.id, run: r },
      },
    ];
    if (items[r.id])
      events.push({
        seq: 9,
        time: "2026-09-29T12:00:01Z",
        event: { kind: "agent.output", runId: r.id, items: items[r.id]! },
      });
    return {
      result: { events: events.filter((e) => e.seq > Number(params["after"])), more: false },
    };
  };
  answers["agent/approve"] = () => ({ result: { decision: "allowed", by: "user" } });
  await renderApp();
  await openEmber();
}
const pinned = () => document.querySelector('main section[aria-label="Approval requests"]');
const pinnedButton = (name: string) =>
  [...(pinned()?.querySelectorAll("button") ?? [])].find((b) => b.textContent === name);
const asking = (run: AgentRun): AgentRun => ({ ...run, approvals: true });

test("with approvals, a coordinator and a subagent started here ask plxd to forward their requests", async () => {
  capabilities = { coordinator: {}, approvals: {} };
  answers["accounts/defaults/get"] = () => ({
    result: { coordinator: { kind: "subscription", backend: "claude" } },
  });
  let started: AgentRun | undefined;
  answers["project/start"] = (p) => {
    started = coordinatorRun(p["runId"] as string, p["prompt"] as string);
    return { result: { run: started } };
  };
  answers["agent/start"] = (p) => ({
    result: { run: subagent(p["runId"] as string, p["prompt"] as string) },
  });
  answers["agent/events"] = serveEvents(() => [started]);
  await renderApp();
  await openEmber();
  type("Add a dark mode");
  await click(button("Send"));
  expect(calls("project/start")).toEqual([expect.objectContaining({ approvals: true })]);

  await openView("Agents");
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
  await click(document.querySelector('#side-panel button[aria-label="Start subagent"]'));
  expect(calls("agent/start")).toEqual([
    expect.objectContaining({ prompt: "Bump the version", approvals: true }),
  ]);
});

test("a subagent's request is pinned in the coordinator's chat by name, its row says it waits, and Open its chat goes there", async () => {
  const docs = asking(subagent("01a0d391-0000-7000-8000-000000000002", "Write the docs"));
  await openEmberAsking(asking(coordinatorRun(coordinatorId, "Plan the release")), [docs], {
    [docs.id]: [bashAsk("s1")],
  });
  expect(pinned()!.textContent).toContain("Subagent: Write the docs");
  expect(pinned()!.textContent).toContain("git tag v1.2.0");
  await openView("Agents");
  expect(agentRow("Write the docs")!.textContent).toContain("Needs approval");

  await click(pinnedButton("Open its chat"));
  expect(crumbs()).toEqual(["This Mac", "ember", "Write the docs"]);
  // Its own chat pins it as its own.
  expect(pinned()!.textContent).not.toContain("Subagent:");
  await click(document.querySelector('[aria-label="Breadcrumb"] button'));

  // Answered from the coordinator's chat, for the subagent's run.
  await click(pinnedButton("Approve"));
  expect(calls("agent/approve")).toEqual([{ runId: docs.id, approvalId: "s1", decision: "allow" }]);
  expect(pinned()).toBeNull();
  await act(async () =>
    deliver({
      type: "event",
      event: {
        subscription: "s",
        seq: 10,
        time: "",
        event: {
          kind: "agent.output",
          runId: docs.id,
          items: [{ kind: "approvalResolved", approvalId: "s1", decision: "allowed", by: "user" }],
        },
      },
    }),
  );
  expect(agentRow("Write the docs")!.textContent).not.toContain("Needs approval");
});

// The sidebar's Projects section (PLX-340).
const flaky: Thread = { id: "t-flaky", repo: parallax.id, createdAt: "2026-09-29T11:00:00Z" };
/** A thread, newer than either Project, and ember's two finished subagents. */
const withThread = () => {
  const done = { status: "completed" as const };
  answers["thread/list"] = () => ({ result: { repos: [parallax], threads: [flaky], seq: 7 } });
  answers["agent/list"] = () => ({
    result: {
      runs: [
        { ...coordinatorRun(flaky.id, "Fix the flaky test"), ...done, project: parallax.id },
        subagent("a-1", "Plan", done),
        subagent("a-2", "Ship", done),
      ],
      seq: 7,
    },
  });
};
/** Every row's title, in the sidebar's order. */
const sidebarTitles = () =>
  [...document.querySelectorAll("#sidebar li[data-kind] [data-title]")].map((t) => t.textContent);

const deleteDialog = () =>
  [...document.querySelectorAll("dialog")].find((d) =>
    d.querySelector("h2")?.textContent?.startsWith("Delete this"),
  )!;

test("Delete… asks first, shows plxd's error in the dialog, then deletes the open Project and leaves its page", async () => {
  capabilities = { projectEdit: {}, projectDelete: {} };
  withThread();
  answers["project/delete"] = () => ({
    error: { code: -32000, message: "The project's worktree is locked." },
  });
  await renderApp();
  await click(rowButton("ember"));
  expect(crumbs()).toEqual(["This Mac", "ember"]);
  expect(menuItems("ember").map((b) => b.textContent)).toEqual([
    "Open",
    "Move left",
    "Move right",
    "Rename…",
    "Change icon…",
    "Delete…",
  ]);
  expect(menuItem("ember", "Delete…")!.className).toContain("text-danger");

  await click(menuItem("ember", "Delete…"));
  expect(deleteDialog().open).toBe(true);
  expect(deleteDialog().querySelector("h2")!.textContent).toBe("Delete this Project?");
  expect(deleteDialog().querySelector("p")!.textContent).toBe(
    "“ember” goes for good, with its 2 agents' transcripts, worktrees, and branches. Running agents are stopped first.",
  );
  const confirm = () =>
    [...deleteDialog().querySelectorAll("button")].find((b) => b.textContent === "Delete");
  await click(confirm());
  expect(deleteDialog().querySelector('[role="alert"]')!.textContent).toBe(
    "The project's worktree is locked.",
  );
  expect(deleteDialog().open).toBe(true);

  answers["project/delete"] = () => ({ result: {} });
  await click(confirm());
  expect(calls("project/delete")).toEqual([{ project: "p-ember" }, { project: "p-ember" }]);
  expect(deleteDialog().open).toBe(false);
  expect(projectRows()).toEqual(["photon"]);
  expect(sidebarTitles()).toEqual(["Fix the flaky test"]);
  expect(crumbs().at(-1)).toBe("New thread");
});

test("without projectDelete there's no Delete…, and another client's project.deleted removes the open Project's row and leaves its page", async () => {
  capabilities = { projectEdit: {} };
  await renderApp();
  expect(menuItem("ember", "Delete…")).toBeUndefined();
  await click(rowButton("ember"));
  expect(crumbs()).toEqual(["This Mac", "ember"]);

  await act(async () =>
    deliver({
      type: "event",
      event: {
        subscription: "s-1",
        seq: 8,
        time: "",
        event: { kind: "project.deleted", project: "p-ember" },
      },
    }),
  );
  await settle();
  expect(projectRows()).toEqual(["photon"]);
  expect(crumbs().at(-1)).toBe("New thread");
});
