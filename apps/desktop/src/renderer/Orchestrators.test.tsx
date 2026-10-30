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
  Orchestrator,
  Repo,
  Thread,
} from "../protocol/generated/protocol";
import { App } from "./App";
import { scopeStore } from "./scope";
import { sectionsStore } from "./Sidebar";
import { moreShown } from "./SidebarNav";
import {
  navDefaults,
  pinnedProjects,
  sidebarDefaults,
  sidebarMode,
  sidebarNav,
  sidebarPrefs,
} from "./sidebarPrefs";
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
// The list reads the transcript's height from clientHeight and each row's from offsetHeight.
Object.defineProperties(HTMLElement.prototype, {
  clientHeight: {
    get(this: HTMLElement) {
      return this.getAttribute("role") === "log" ? 10_000 : 0;
    },
  },
  offsetHeight: {
    get(this: HTMLElement) {
      return this.getAttribute("role") === "log" ? 10_000 : 20;
    },
  },
});

const parallax: Repo = {
  id: "r-parallax",
  name: "parallax",
  path: "/src/parallax",
  createdAt: "2026-09-29T09:00:00Z",
};
const orchestrator = (name: string, updatedAt: string): Orchestrator => ({
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
  sidebarNav.set(navDefaults);
  // These tests are Traditional's head (0090); one below covers Inbox and Traditional's list (0094).
  sidebarMode.set("traditional");
  pinnedProjects.set([]);
  moreShown.set(false);
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
    "orchestrator/list": () => ({
      result: {
        orchestrators: [
          orchestrator("ember", "2026-09-26T12:00:00Z"),
          orchestrator("photon", "2026-09-29T09:00:00Z"),
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
    onAccessRequests: () => () => {},
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
/** Opens the orchestrators page from its sidebar row (0090). */
const openProjectsPage = () =>
  act(() =>
    [...document.querySelectorAll<HTMLButtonElement>("#sidebar button")]
      .find((b) => b.textContent === "Projects")!
      .click(),
  );
// Each orchestrator's row, by name, in its repo's folder in the Traditional sidebar (0093).
const orchestratorRows = () =>
  [...document.querySelectorAll('#sidebar li[data-kind="orchestrator"] [data-title]')].map(
    (t) => t.textContent,
  );
const crumbs = () =>
  [...document.querySelectorAll('[aria-label="Breadcrumb"] li')].map((li) => li.textContent);
const dialog = () => document.querySelector<HTMLDialogElement>('dialog[aria-label="New project"]')!;
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
// The sidebar's row under New thread (0090).
const openPalette = async () => {
  await click(
    [...document.querySelectorAll("#sidebar button")].find((b) => b.textContent === "New project"),
  );
};
// An orchestrator thread starts from New thread's picker.
const openNewOrchestrator = async () => {
  await click(
    [...document.querySelectorAll("#sidebar button")].find((b) =>
      b.textContent?.startsWith("New thread"),
    ),
  );
  const picker = document.querySelector('dialog[aria-label="New thread in"]')!;
  await click(
    [...picker.querySelectorAll('[role="option"]')].find((o) =>
      o.textContent?.startsWith("New orchestrator thread"),
    ),
  );
};
const workspaceButton = () =>
  dialog().querySelector('button[aria-haspopup="menu"]')!.getAttribute("aria-label");

test("lists plxd's orchestrators as rows, most recently active first, and adds one from orchestrator.created", async () => {
  await renderApp();
  expect(orchestratorRows()).toEqual(["photon", "ember"]);

  await act(async () =>
    deliver({
      type: "event",
      event: {
        subscription: "s-1",
        seq: 8,
        time: "2026-09-29T12:00:00Z",
        event: {
          kind: "orchestrator.created",
          orchestrator: orchestrator("parallax", "2026-09-29T12:00:00Z"),
        },
      },
    }),
  );
  expect(orchestratorRows()).toEqual(["parallax", "photon", "ember"]);
});

test("Create orchestrator names it after its repository, shows plxd's error, retries with the same id, then opens it", async () => {
  answers["orchestrator/create"] = () => ({
    error: {
      code: -32000,
      message: "/src/parallax is not the top folder of a git repository: it has no .git.",
      data: { kind: "notARepository" },
    },
  });
  await renderApp();
  await openNewOrchestrator();
  expect(dialog().open).toBe(true);
  // A large name under the orchestrator's icon, then the Workspace: the open host's first
  // repository.
  expect(nameBox().value).toBe("parallax");
  expect(nameBox().placeholder).toBe("New orchestrator");
  expect(workspaceButton()).toBe("Workspace: parallax on This Mac");
  // The orchestrator's model is picked per message (PLX-46), not here.
  expect(dialog().querySelector('[aria-label^="Model"]')).toBeNull();
  typeInto(nameBox(), "");
  expect(inDialog("Create orchestrator")!.disabled).toBe(true);
  typeInto(nameBox(), "parallax");

  await click(inDialog("Create orchestrator"));
  expect(dialog().querySelector('[role="alert"]')?.textContent).toBe(
    "/src/parallax is not the top folder of a git repository: it has no .git.",
  );
  expect(dialog().open).toBe(true);

  answers["orchestrator/create"] = (p) => ({
    result: { orchestrator: { ...orchestrator("parallax", "2026-09-29T12:00:00Z"), id: p["id"] } },
  });
  await click(inDialog("Create orchestrator"));
  const [first, retry] = calls("orchestrator/create");
  expect(first).toEqual({
    id: expect.stringMatching(/^[0-9a-f]{8}-[0-9a-f]{4}-7/),
    name: "parallax",
    repoPath: "/src/parallax",
  });
  expect(retry).toEqual(first);
  expect(hostsOf("orchestrator/create")).toEqual(["local", "local"]);
  expect(dialog().open).toBe(false);
  expect(crumbs()).toEqual(["This Mac", "parallax"]);
  expect(orchestratorRows()).toContain("parallax");
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

/** An orchestrator's row in the Traditional sidebar, by its name (0093). */
const rowButton = (name: string) =>
  [
    ...document.querySelectorAll<HTMLButtonElement>(
      '#sidebar li[data-kind="orchestrator"] button[data-row]',
    ),
  ].find((b) => b.querySelector("[data-title]")?.textContent === name)!;
// An orchestrator row's menu, which a right-click on it opens.
const menuItems = (name: string) => {
  const card = rowButton(name).closest("li")!;
  act(() => void card.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true })));
  return [...card.querySelectorAll<HTMLButtonElement>('[role="menu"] [role="menuitem"]')];
};
const menuItem = (name: string, item: string) =>
  menuItems(name).find((b) => b.textContent === item);

const modeChoice = (within: Element) =>
  [...within.querySelectorAll<HTMLInputElement>('input[type="radio"]')].filter((r) =>
    ["auto", "bypass"].includes(r.value),
  );

test("a press on the add palette's backdrop closes it, and one inside it doesn't", async () => {
  await renderApp();
  await openPalette();
  const press = (target: Element) =>
    act(() => {
      target.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    });
  press(paletteOption("Clone from GitHub")!);
  expect(dialog().open).toBe(true);
  press(dialog());
  expect(dialog().open).toBe(false);
});

test("with orchestratorPermission and orchestratorAutonomy, Create orchestrator asks for full access, on by default, and autonomy, the same on a retry", async () => {
  capabilities = { orchestratorPermission: {}, orchestratorAutonomy: {} };
  let fails = 1;
  answers["orchestrator/create"] = (p) =>
    fails-- > 0
      ? { error: { code: -32000, message: "not a repository" } }
      : {
          result: {
            orchestrator: { ...orchestrator("parallax", "2026-09-29T12:00:00Z"), id: p["id"] },
          },
        };
  await renderApp();
  await openNewOrchestrator();
  expect(modeChoice(dialog())).toEqual([]);
  expect(dialog().textContent).toContain(
    "Agents in this orchestrator run commands and edit files without asking.",
  );
  const fullAccess = dialog().querySelector<HTMLInputElement>('input[role="switch"]')!;
  expect(fullAccess.checked).toBe(true);
  const autonomy = (value: string) =>
    dialog().querySelector<HTMLInputElement>(
      `fieldset[aria-label="Autonomy"] input[value="${value}"]`,
    )!;
  expect(autonomy("routine").checked).toBe(true);

  await click(inDialog("Create orchestrator"));
  await click(fullAccess);
  await click(autonomy("ask"));
  await click(inDialog("Create orchestrator"));
  const [first, second] = calls("orchestrator/create");
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

test("with orchestratorPermission, an orchestrator not in Bypass offers Full access…, a one-way move to Bypass, and one in Bypass offers no mode", async () => {
  capabilities = { orchestratorPermission: {} };
  answers["orchestrator/list"] = () => ({
    result: {
      orchestrators: [
        { ...orchestrator("ember", "2026-09-26T12:00:00Z"), permission: "auto" },
        { ...orchestrator("photon", "2026-09-29T09:00:00Z"), permission: "bypass" },
      ],
      seq: 7,
    },
  });
  answers["orchestrator/update"] = (p) => ({
    result: {
      orchestrator: {
        ...orchestrator("ember", "2026-09-26T12:00:00Z"),
        permission: p["permission"],
      },
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
  expect(calls("orchestrator/update")).toEqual([{ orchestrator: "p-ember", permission: "bypass" }]);
  expect(menuItem("ember", "Full access…")).toBeUndefined();
});

/** An orchestrator run, as `orchestrator/start` answers it (0024). */
const orchestratorRun = (id: string, prompt: string): AgentRun => ({
  id,
  project: "p-ember",
  prompt,
  policy: "noWrite",
  status: "running",
  backend: "claude",
  accountId: "claude",
  orchestratorThread: id,
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

test("an orchestrator's first message starts its orchestrator and shows at once; ones sent meanwhile, later ones, and Stop go to its run", async () => {
  capabilities = { orchestrator: {} };
  let started: AgentRun | undefined;
  answers["accounts/defaults/get"] = () => ({
    result: { orchestrator: { kind: "subscription", backend: "claude" } },
  });
  let release = () => {};
  answers["orchestrator/start"] = async (p) => {
    await new Promise<void>((resolve) => (release = resolve));
    started = orchestratorRun(p["runId"] as string, p["prompt"] as string);
    return { result: { run: started } };
  };
  answers["agent/events"] = serveEvents(() => [started]);
  answers["orchestration/dispatch"] = () => ({ result: { seq: 1 } });
  await renderApp();
  await openEmber();
  // Claude's models and permission modes: an orchestrator runs in the mode it's given (0027).
  expect(button("Model: Claude Opus 5.5")).not.toBeNull();
  expect(button("Access: Auto-accept edits")).not.toBeNull();
  // Every message goes to the orchestrator, with no target to pick.
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
  expect(calls("orchestrator/start")).toEqual([
    {
      orchestrator: "p-ember",
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
  expect(calls("orchestrator/start")).toHaveLength(1);
});

test("with orchestratorPermission, an orchestrator's composers have no permission picker or mode, and send no permission", async () => {
  capabilities = { orchestrator: {}, orchestratorPermission: {} };
  let started: AgentRun | undefined;
  answers["orchestrator/list"] = () => ({
    result: {
      orchestrators: [{ ...orchestrator("ember", "2026-09-26T12:00:00Z"), permission: "bypass" }],
      seq: 7,
    },
  });
  answers["accounts/defaults/get"] = () => ({
    result: { orchestrator: { kind: "subscription", backend: "claude" } },
  });
  answers["orchestrator/start"] = (p) => {
    started = {
      ...orchestratorRun(p["runId"] as string, p["prompt"] as string),
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
  expect(calls("orchestrator/start")).toEqual([
    expect.not.objectContaining({ permission: expect.anything() }),
  ]);
  // The orchestrator's chat too, though its run says another mode.
  expect(access()).toBeNull();
  expect(main()).not.toContain("Bypass");
  type("Start with the settings page");
  await click(button("Send"));
  expect(sentMessages()).toEqual([
    { runId: started!.id, turnId: expect.any(String), text: "Start with the settings page" },
  ]);
});

const orchestratorRunId = "01a0d390-2c3d-7e4f-9a0b-1c2d3e4f5a6b";
/** A subagent of ember's orchestrator, which started it unless `orchestratorThread` is cleared. */
const subagent = (id: string, prompt: string, more: Partial<AgentRun> = {}): AgentRun => ({
  ...orchestratorRun(id, prompt),
  policy: "workspaceWrite",
  orchestratorThread: orchestratorRunId,
  ...more,
});
/** Opens a side panel view from its list, as + does. An orchestrator opens the panel on its own tab. */
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

// --- PLX-196: permission requests in an orchestrator ---

const bashAsk = (approvalId: string): AgentOutputItem => ({
  kind: "approvalRequested",
  approvalId,
  toolName: "Bash",
  input: { command: "git tag v1.2.0" },
  callId: `toolu_${approvalId}`,
  expiresAt: "2026-09-29T12:30:00Z",
});
/**
 * Ember open on its orchestrator, if it has one, with `runs` after it. Each run's log is its start,
 * then `items` for it as one output. plxd advertises approvals, and allows what's answered.
 */
async function openEmberAsking(
  orchestratorRun: AgentRun | undefined,
  runs: AgentRun[],
  items: Record<string, AgentOutputItem[]>,
) {
  capabilities = { orchestrator: {}, approvals: {} };
  const all = [...(orchestratorRun ? [orchestratorRun] : []), ...runs];
  answers["orchestrator/list"] = () => ({
    result: {
      orchestrators: [
        { ...orchestrator("ember", "2026-09-26T12:00:00Z"), run: orchestratorRun?.id },
      ],
      seq: 7,
    },
  });
  answers["agent/list"] = (p) => ({
    result: {
      runs: [undefined, "p-ember"].includes(p["orchestrator"] as string) ? all : [],
      seq: 7,
    },
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

test("with approvals, an orchestrator and a subagent started here ask plxd to forward their requests", async () => {
  capabilities = { orchestrator: {}, approvals: {} };
  answers["accounts/defaults/get"] = () => ({
    result: { orchestrator: { kind: "subscription", backend: "claude" } },
  });
  let started: AgentRun | undefined;
  answers["orchestrator/start"] = (p) => {
    started = orchestratorRun(p["runId"] as string, p["prompt"] as string);
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
  expect(calls("orchestrator/start")).toEqual([expect.objectContaining({ approvals: true })]);

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

test("a subagent's request is pinned in the orchestrator's chat by name, its row says it waits, and Open its chat goes there", async () => {
  const docs = asking(subagent("01a0d391-0000-7000-8000-000000000002", "Write the docs"));
  await openEmberAsking(asking(orchestratorRun(orchestratorRunId, "Plan the release")), [docs], {
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

  // Answered from the orchestrator's chat, for the subagent's run.
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

// The sidebar's orchestrators section (PLX-340).
const flaky: Thread = { id: "t-flaky", repo: parallax.id, createdAt: "2026-09-29T11:00:00Z" };
/** A thread, newer than either orchestrator, and ember's two finished subagents. */
const withThread = () => {
  const done = { status: "completed" as const };
  answers["thread/list"] = () => ({ result: { repos: [parallax], threads: [flaky], seq: 7 } });
  answers["agent/list"] = () => ({
    result: {
      runs: [
        { ...orchestratorRun(flaky.id, "Fix the flaky test"), ...done, project: parallax.id },
        subagent("a-1", "Plan", done),
        subagent("a-2", "Ship", done),
      ],
      seq: 7,
    },
  });
};
/** Every row's title, in the sidebar's order. */
const sidebarTitles = () =>
  [...document.querySelectorAll('#sidebar li[data-kind="thread"] [data-title]')].map(
    (t) => t.textContent,
  );

const deleteDialog = () =>
  [...document.querySelectorAll("dialog")].find((d) =>
    d.querySelector("h2")?.textContent?.startsWith("Delete this"),
  )!;

test("Delete… asks first, shows plxd's error in the dialog, then deletes the open orchestrator and leaves its page", async () => {
  capabilities = { orchestratorEdit: {}, orchestratorDelete: {} };
  withThread();
  answers["orchestrator/delete"] = () => ({
    error: { code: -32000, message: "The orchestrator's worktree is locked." },
  });
  await renderApp();
  await click(rowButton("ember"));
  expect(crumbs()).toEqual(["This Mac", "ember"]);
  expect(menuItems("ember").map((b) => b.textContent)).toEqual([
    "Rename…",
    "Change icon…",
    "Delete…",
  ]);
  expect(menuItem("ember", "Delete…")!.className).toContain("text-danger");

  await click(menuItem("ember", "Delete…"));
  expect(deleteDialog().open).toBe(true);
  expect(deleteDialog().querySelector("h2")!.textContent).toBe("Delete this orchestrator?");
  expect(deleteDialog().querySelector("p")!.textContent).toBe(
    "“ember” goes for good, with its 2 agents' transcripts, worktrees, and branches. Running agents are stopped first.",
  );
  const confirm = () =>
    [...deleteDialog().querySelectorAll("button")].find((b) => b.textContent === "Delete");
  await click(confirm());
  expect(deleteDialog().querySelector('[role="alert"]')!.textContent).toBe(
    "The orchestrator's worktree is locked.",
  );
  expect(deleteDialog().open).toBe(true);

  answers["orchestrator/delete"] = () => ({ result: {} });
  await click(confirm());
  expect(calls("orchestrator/delete")).toEqual([
    { orchestrator: "p-ember" },
    { orchestrator: "p-ember" },
  ]);
  expect(deleteDialog().open).toBe(false);
  expect(crumbs().at(-1)).toBe("New thread");
  expect(sidebarTitles()).toEqual(["Fix the flaky test"]);
  expect(orchestratorRows()).toEqual(["photon"]);
});

test("a card's menu shows a hidden sidebar before it opens a dialog the sidebar holds", async () => {
  const essays: Repo = {
    id: "s-essays",
    name: "Essays",
    path: "/data/spaces/s-essays",
    project: true,
    createdAt: "2026-09-29T11:00:00Z",
  };
  capabilities = { projects: {} };
  answers["thread/list"] = () => ({ result: { repos: [essays], threads: [], seq: 7 } });
  await renderApp();
  const card = projectCard("Essays").closest("li")!;
  await click(document.querySelector('button[aria-label="Hide sidebar"]'));
  const hidden = () => !!document.getElementById("sidebar")!.closest("[hidden]");
  expect(hidden()).toBe(true);
  act(() => void card.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true })));
  await click(
    [...card.querySelectorAll('[role="menu"] [role="menuitem"]')].find(
      (b) => b.textContent === "Rename…",
    ),
  );
  expect(hidden()).toBe(false);
  expect([...document.querySelectorAll("dialog")].some((d) => d.open)).toBe(true);
});

test("without orchestratorDelete there's no Delete…, and another client's orchestrator.deleted removes the open orchestrator's row and leaves its page", async () => {
  capabilities = { orchestratorEdit: {} };
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
        event: { kind: "orchestrator.deleted", orchestrator: "p-ember" },
      },
    }),
  );
  await settle();
  expect(crumbs().at(-1)).toBe("New thread");
  expect(orchestratorRows()).toEqual(["photon"]);
});

/** A Project's card on the Projects page, which this opens, by its name (0090, 0093). */
const projectCard = (name: string) => {
  openProjectsPage();
  return [...document.querySelectorAll<HTMLButtonElement>("main li[data-project] > button")].find(
    (b) => b.querySelector("[data-title]")?.textContent === name,
  )!;
};

/** A sidebar button, by its text. */
const sidebarButton = (text: string) =>
  [...document.querySelectorAll<HTMLButtonElement>("#sidebar button")].find(
    (b) => b.textContent === text,
  );

test("Usage waits under More until Settings shows it in the head, and pinned Projects list by name", async () => {
  const essays: Repo = {
    id: "s-essays",
    name: "Essays",
    path: "/data/spaces/s-essays",
    project: true,
    createdAt: "2026-09-29T11:00:00Z",
  };
  capabilities = { projects: {} };
  answers["thread/list"] = () => ({ result: { repos: [essays], threads: [], seq: 7 } });
  await renderApp();
  // Folded under More, out of reach until it opens.
  const fold = () => sidebarButton("Usage")!.closest<HTMLElement>("[aria-controls], [id]")!;
  expect(fold().id).toBe(sidebarButton("More")!.getAttribute("aria-controls"));
  expect(fold().inert).toBe(true);
  await click(sidebarButton("More"));
  expect(fold().inert).toBe(false);
  await click(sidebarButton("Less"));
  expect(fold().inert).toBe(true);
  // Settings › Appearance › Sidebar's switch for it puts it in the head.
  await act(async () => sidebarNav.set({ ...sidebarNav.get(), usage: true }));
  expect(sidebarButton("Usage")!.closest("[inert]")).toBeNull();

  // Pinning a Project from its card lists it under Pinned in the head, and its row opens it. A
  // pinned orchestrator lists as a card with the pinned threads, out of its folder.
  openProjectsPage();
  await click(document.querySelector('main button[aria-label="Pin Essays"]'));
  expect(pinnedProjects.get()).toEqual(["local/s-essays"]);
  const pinned = document.querySelector('#sidebar section[aria-label="Pinned"]')!;
  expect([...pinned.querySelectorAll("li > button")].map((b) => b.textContent)).toEqual(["Essays"]);
  await click(pinned.querySelector("li > button"));
  expect(crumbs()).toEqual(["This Mac", "Essays"]);
  await act(async () => pinnedProjects.set([...pinnedProjects.get(), "local/p-ember"]));
  const cards = document.querySelector('#sidebar ul[aria-label="Pinned orchestrator threads"]')!;
  expect([...cards.querySelectorAll("[data-title]")].map((t) => t.textContent)).toEqual(["ember"]);
  expect(
    [
      ...document.querySelectorAll(
        '#sidebar ul[aria-label="Threads"] li[data-kind="orchestrator"] [data-title]',
      ),
    ].map((t) => t.textContent),
  ).not.toContain("ember");
  await click(cards.querySelector("button[data-row]"));
  expect(crumbs()).toEqual(["This Mac", "ember"]);
});

test("a Project is made from the Projects page, opens to New thread in it, and keeps its icon, instructions, and files", async () => {
  capabilities = { projects: {}, projectContext: {}, threadAttention: {} };
  const project: Repo = {
    id: "s-essays",
    name: "Essays",
    path: "/data/spaces/s-essays",
    project: true,
    createdAt: "2026-09-29T11:00:00Z",
    files: ["/data/uploads/a/brief.pdf", "/data/uploads/b/notes.md"],
  };
  answers["project/create"] = (p) => ({ result: { repo: { ...project, id: p["id"], files: [] } } });
  answers["repo/update"] = (p) => ({
    result: { repo: { ...project, ...p, id: p["repo"] } },
  });
  await renderApp();
  openProjectsPage();
  const create = [...document.querySelectorAll("dialog")].find(
    (d) => d.querySelector("h2")?.textContent === "Create Project",
  )!;
  await click(
    [...document.querySelectorAll("main button")].find((b) => b.textContent === "New project"),
  );
  typeInto(create.querySelector<HTMLInputElement>('input[aria-label="Name"]')!, " Essays ");
  await act(async () => create.querySelector("form")!.requestSubmit());
  await settle();
  const [made] = calls("project/create");
  expect(made).toEqual({ id: expect.stringMatching(/^[0-9a-f-]{36}$/), name: "Essays" });
  // A Project's page is the Project, so its crumbs end there.
  expect(crumbs()).toEqual(["This Mac", "Essays"]);
  // Its icon in the header opens the icon picker under it.
  const icon = document.querySelector<HTMLElement>('main button[aria-label="Change icon"]')!;
  await click(icon);
  expect(popoverSources.at(-1)).toBe(icon);

  // Its instructions and files, in the tray under the composer.
  await click(document.querySelector('main button[aria-label="Add instructions"]'));
  const editor = [...document.querySelectorAll<HTMLDialogElement>("main dialog")].find(
    (d) => d.querySelector("h2")?.textContent === "Instructions for Essays",
  )!;
  expect(editor.open).toBe(true);
  const box = editor.querySelector("textarea")!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(
      box,
      "Cite a source for every claim.",
    );
    box.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await act(async () => editor.querySelector("form")!.requestSubmit());
  await settle();
  expect(calls("repo/update")).toEqual([
    { repo: made!["id"], instructions: "Cite a source for every claim." },
  ]);

  const files = document.querySelector('main section[aria-label="Files"]')!;
  expect(
    [...files.querySelectorAll('button[aria-label^="Remove "]')].map((b) =>
      b.getAttribute("aria-label"),
    ),
  ).toEqual(["Remove brief.pdf", "Remove notes.md"]);
  await click(files.querySelector('button[aria-label="Remove brief.pdf"]'));
  expect(calls("repo/update").at(-1)).toEqual({
    repo: made!["id"],
    files: ["/data/uploads/b/notes.md"],
  });
});

test("Add puts this computer's other threads in a Project, and each archives from its card", async () => {
  capabilities = { projects: {}, projectThreads: {} };
  const project: Repo = {
    id: "s-essays",
    name: "Essays",
    path: "/data/spaces/s-essays",
    project: true,
    createdAt: "2026-09-29T10:00:00Z",
  };
  const scratch: Repo = {
    id: "r-scratch",
    name: "scratch",
    path: "/data/scratch",
    scratch: true,
    createdAt: "2026-09-29T09:00:00Z",
  };
  const fix = { ...flaky, title: "Fix the flaky test" };
  const draft: Thread = {
    id: "t-draft",
    repo: scratch.id,
    createdAt: "2026-09-29T11:30:00Z",
    title: "Draft the intro",
  };
  const outline: Thread = {
    id: "t-outline",
    repo: project.id,
    createdAt: "2026-09-29T10:30:00Z",
    title: "Outline",
  };
  answers["thread/list"] = () => ({
    result: { repos: [parallax, scratch, project], threads: [fix, draft, outline], seq: 7 },
  });
  answers["thread/setProject"] = (p) => ({
    result: {
      threads: (p["threads"] as string[]).map((id) => ({
        ...[fix, draft].find((t) => t.id === id)!,
        ...(p["project"] ? { project: p["project"] as string } : {}),
      })),
    },
  });
  await renderApp();
  await click(projectCard("Essays"));
  const threads = () =>
    [...document.querySelectorAll('main section[aria-label="Threads"] > ul > li')].map(
      (li) => li.querySelector("button span.font-semibold")?.textContent,
    );
  expect(threads()).toEqual(["Outline"]);

  // The picker lists the threads outside the Project, newest first, but not one started in it.
  await click(document.querySelector('main button[aria-label="Add threads"]'));
  const picker = document.querySelector('ul[aria-label="Threads to add"]')!.closest("dialog")!;
  expect(picker.open).toBe(true);
  const boxes = () => [...picker.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')];
  expect(boxes().map((b) => b.getAttribute("aria-label"))).toEqual([
    "Add Draft the intro",
    "Add Fix the flaky test",
  ]);
  await click(boxes()[0]);
  expect(picker.querySelector('button[type="submit"]')!.textContent).toBe("Add");
  await act(async () => picker.querySelector("form")!.requestSubmit());
  await settle();
  expect(calls("thread/setProject")).toEqual([{ threads: ["t-draft"], project: "s-essays" }]);
  expect(picker.open).toBe(false);
  expect(threads()).toEqual(["Draft the intro", "Outline"]);

  // Each card archives as the sidebar's does.
  answers["thread/archive"] = (p) => ({
    result: { thread: { ...draft, project: project.id, archived: p["archived"] as boolean } },
  });
  const row = document.querySelector('main section[aria-label="Threads"] > ul > li')!;
  await click(row.querySelector('button[title="Archive (E)"]'));
  expect(calls("thread/archive")).toEqual([{ runId: "t-draft", archived: true }]);
  expect(threads()).toEqual(["Outline"]);
});

test("Thread details adds the open thread to a Project, which its crumbs then name, and takes it out", async () => {
  capabilities = { projects: {}, projectThreads: {} };
  const project: Repo = {
    id: "s-essays",
    name: "Essays",
    path: "/data/spaces/s-essays",
    project: true,
    createdAt: "2026-09-29T10:00:00Z",
  };
  const draft: Thread = {
    id: "t-draft",
    repo: parallax.id,
    createdAt: "2026-09-29T11:30:00Z",
    title: "Draft the intro",
  };
  answers["thread/list"] = () => ({
    result: { repos: [parallax, project], threads: [draft], seq: 7 },
  });
  answers["thread/setProject"] = (p) => ({
    result: {
      threads: [{ ...draft, ...(p["project"] ? { project: p["project"] as string } : {}) }],
    },
  });
  await renderApp();
  await click(document.querySelector('#sidebar li[data-kind="thread"] button'));
  expect(crumbs()).toEqual(["This Mac", "parallax", "Draft the intro"]);

  const details = document.getElementById("thread-details")!;
  await click(details.querySelector('button[aria-label="Add to a Project"]'));
  const projects = () => [
    ...details.querySelectorAll<HTMLButtonElement>('[role="menu"][aria-label="Projects"] button'),
  ];
  expect(projects().map((b) => b.textContent)).toEqual(["Essays"]);
  await click(projects()[0]);
  expect(calls("thread/setProject")).toEqual([{ threads: ["t-draft"], project: "s-essays" }]);
  expect(crumbs()).toEqual(["This Mac", "Essays", "Draft the intro"]);
  expect(details.querySelector('button[aria-label="Project: Essays"]')).not.toBeNull();

  await click(projects().find((b) => b.textContent === "Remove from Project"));
  expect(calls("thread/setProject").at(-1)).toEqual({ threads: ["t-draft"] });
  expect(crumbs()).toEqual(["This Mac", "parallax", "Draft the intro"]);
});

test("a sidebar row's actions add its thread to a Project", async () => {
  capabilities = { projects: {}, projectThreads: {} };
  const essays: Repo = {
    id: "s-essays",
    name: "Essays",
    path: "/data/spaces/s-essays",
    project: true,
    createdAt: "2026-09-29T10:00:00Z",
  };
  const draft: Thread = {
    id: "t-draft",
    repo: parallax.id,
    createdAt: "2026-09-29T11:30:00Z",
    title: "Draft the intro",
  };
  answers["thread/list"] = () => ({
    result: { repos: [parallax, essays], threads: [draft], seq: 7 },
  });
  answers["thread/setProject"] = (p) => ({
    result: { threads: [{ ...draft, project: p["project"] as string }] },
  });
  await renderApp();
  const row = document.querySelector('#sidebar li[data-kind="thread"]')!;
  // happy-dom has no popovers: send the actions menu the event a browser sends as it opens.
  await act(async () =>
    row
      .querySelector('[role="menu"][aria-label="Thread actions"]')!
      .dispatchEvent(Object.assign(new Event("beforetoggle"), { newState: "open" })),
  );
  const item = [...row.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find(
    (b) => b.textContent === "Add to Project…",
  );
  await click(item);
  await click(row.querySelector('[role="menu"][aria-label="Projects"] button'));
  expect(calls("thread/setProject")).toEqual([{ threads: ["t-draft"], project: "s-essays" }]);
});

test("a row counts unpushed commits for a repo's thread, and none for a thread with no repo", async () => {
  const scratch: Repo = {
    id: "r-scratch",
    name: "scratch",
    path: "/data/scratch",
    scratch: true,
    createdAt: "2026-09-29T09:00:00Z",
  };
  const chat: Thread = { id: "t-chat", repo: scratch.id, createdAt: "2026-09-29T11:30:00Z" };
  const done = { status: "completed" as const, branch: "parallax/work" };
  answers["thread/list"] = () => ({
    result: { repos: [parallax, scratch], threads: [flaky, chat], seq: 7 },
  });
  answers["agent/list"] = () => ({
    result: {
      runs: [
        { ...orchestratorRun(flaky.id, "Fix the flaky test"), ...done, project: parallax.id },
        { ...orchestratorRun(chat.id, "NFA to DFA help"), ...done, project: scratch.id },
      ],
      seq: 7,
    },
  });
  answers["agent/gitStatus"] = () => ({
    result: { branch: "parallax/work", changes: 0, upstream: null, ahead: 2, behind: 0 },
  });
  await renderApp();
  const unpushed = (title: string) =>
    [...document.querySelectorAll('#sidebar li[data-kind="thread"]')]
      .find((li) => li.querySelector("[data-title]")?.textContent === title)
      ?.querySelector('[title="2 commits not pushed"]');
  expect(unpushed("Fix the flaky test")).not.toBeNull();
  expect(unpushed("NFA to DFA help")).toBeNull();
});

test("Inbox has a Projects button beside its search and Pull requests in the footer but no Projects drawer, and Traditional lists each orchestrator as a row in its folder with Projects in its head", async () => {
  sidebarMode.set("inbox");
  await renderApp();
  const sidebar = document.getElementById("sidebar")!;
  expect(
    [...sidebar.querySelectorAll("details summary")].some((s) =>
      s.textContent?.startsWith("Projects"),
    ),
  ).toBe(false);
  expect(sidebar.querySelector('li[data-kind="orchestrator"]')).toBeNull();
  expect(
    sidebar.querySelector('button[aria-label="New orchestrator or repository"]'),
  ).not.toBeNull();
  expect(sidebar.querySelector('button[aria-label="Pull requests"]')).not.toBeNull();
  const projectsButton = sidebar.querySelector<HTMLButtonElement>('button[aria-label="Projects"]')!;
  await click(projectsButton);
  expect(projectsButton.getAttribute("aria-pressed")).toBe("true");

  await act(async () => sidebarMode.set("traditional"));
  expect(sidebar.querySelector('button[aria-label="Pull requests"]')).toBeNull();
  const list = sidebar.querySelector('ul[aria-label="Threads"]')!;
  expect(
    [...list.querySelectorAll('li[data-kind="orchestrator"] [data-title]')].map(
      (t) => t.textContent,
    ),
  ).toEqual(["photon", "ember"]);
  expect(sidebarButton("Projects")).toBeDefined();
});

test("the add palette offers New Project first where the host makes Projects, and it opens Create Project; New orchestrator thread is in New thread's picker", async () => {
  await renderApp();
  await openPalette();
  expect(paletteOption("New Project")).toBeUndefined();
  act(() => dialog().close());

  capabilities = { projects: {} };
  unmount();
  await renderApp();
  await openPalette();
  expect(paletteOptions().indexOf(paletteOption("New Project")!)).toBe(0);
  expect(paletteOption("New orchestrator thread")).toBeUndefined();
  await click(paletteOption("New Project"));
  expect(dialog().open).toBe(false);
  const create = [...document.querySelectorAll("dialog")].find(
    (d) => d.querySelector("h2")?.textContent === "Create Project",
  )!;
  expect(create.open).toBe(true);
});
