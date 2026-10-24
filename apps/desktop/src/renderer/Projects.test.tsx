// @vitest-environment happy-dom
import type { TiptapEditorHTMLElement } from "@tiptap/react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, onTestFinished, test, vi } from "vite-plus/test";

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
  InboxItem,
  InboxKind,
  LoggedEvent,
  Project,
  Question,
  Repo,
  ParallaxEvent,
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
const setState = (hostId: string, state: ConnectionState) => {
  states[hostId] = state;
  stateListeners.forEach((l) => l(hostId, state));
};

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

/** The newest notification's title and body. */
const notice = () => {
  const toast = document.querySelector('[aria-label="Notifications"] > div');
  return toast && [toast.querySelector("span")!.textContent, toast.querySelector("p")?.textContent];
};

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
const press = (key: string) =>
  act(() => {
    document.activeElement!.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
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
const workspaceMenu = () =>
  dialog().querySelector<HTMLElement>('[role="menu"][aria-label="Workspace"]')!;
// happy-dom has no popovers, so the menu gets the toggle event a browser sends when it opens.
const openWorkspaces = async () => {
  await act(async () => {
    workspaceMenu().dispatchEvent(
      Object.assign(new Event("toggle"), { oldState: "closed", newState: "open" }),
    );
  });
  await settle();
};
/** Each of the Workspace menu's groups: its host, then its items' text. */
const workspaceGroups = () =>
  [...workspaceMenu().querySelectorAll('[role="group"]')].map((g) => [
    g.getAttribute("aria-label"),
    ...[...g.querySelectorAll('[role^="menuitem"]')].map((b) => b.textContent),
  ]);
const workspaceItem = (text: string) =>
  [...workspaceMenu().querySelectorAll<HTMLButtonElement>('[role^="menuitem"]')].find(
    (b) => b.textContent === text,
  );
/** What a host's group says about it, such as that it's connecting. */
const hostNote = (host: string) =>
  workspaceMenu().querySelector(`[role="group"][aria-label="${host}"] p:not([aria-hidden])`)
    ?.textContent;
const searchBox = () =>
  workspaceMenu().querySelector<HTMLInputElement>('input[aria-label="Search repositories"]')!;

const mini: SshHost = { id: "h-mini", name: "Mac mini", destination: "mini" };
const repo = (name: string, path = `/srv/${name}`): Repo => ({
  id: `r-${name}`,
  name,
  path,
  createdAt: "2026-09-29T09:00:00Z",
});
const scratch: Repo = { ...repo("scratch"), scratch: true };
/** `thread/list` answering each host with its own repositories, this computer's by default. */
const reposOn =
  (byHost: Record<string, Repo[]>): Answer =>
  (_params, host) => ({ result: { repos: byHost[host] ?? [parallax], threads: [], seq: 7 } });
const connected: ConnectionState = {
  status: "connected",
  plxd: "0.1.0",
  protocol: 1,
  capabilities: {},
};

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

test("a Project is one row that opens its chat: its repository and branch, with the composer off on an older plxd", async () => {
  await renderApp();
  const row = rowButton("ember");
  await click(row);
  expect(crumbs()).toEqual(["This Mac", "ember"]);
  expect(row?.getAttribute("aria-current")).toBe("page");
  const main = document.querySelector("main")!;
  expect(main.querySelector("h2")?.textContent).toBe("ember");
  // In a short window it gives way to a pinned card and the composer, wrapping out of view whole
  // rather than cut in two (PLX-259).
  const welcome = main.querySelector("h2")!.parentElement!.parentElement!;
  for (const name of ["min-h-0", "flex-wrap", "overflow-hidden"])
    expect(welcome.classList.contains(name)).toBe(true);
  expect(main.querySelector('[aria-label="This Mac · Local checkout"]')).not.toBeNull();
  expect(main.textContent).toContain("main");
  expect(main.textContent).not.toContain("/src/ember");
  expect(composer()!.getAttribute("aria-placeholder")).toBe(
    "This host's plxd can't run a Project's coordinator yet",
  );
  expect(main.querySelector<HTMLButtonElement>('button[aria-label="Send"]')!.disabled).toBe(true);
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

test("Local folder browses from ~/, filters as you type, opens with Enter, goes up with Backspace, and adds with Mod+Enter", async () => {
  listFolders.mockImplementation(listTree);
  answers["repo/add"] = (p) => ({
    result: { repo: { ...parallax, id: p["id"], name: "photon", path: p["path"] } },
  });
  await renderApp();
  await openPalette();
  expect(paletteOptions().map((o) => o.textContent)).toEqual([
    "New repositoryStart an empty repository in ~/.parallax/projects",
    "Local folderAdd a repository that's already on this computer",
    "Clone from GitHubClone a repository by its owner/name",
    "New ProjectA focused chat where agents coordinate work",
    "New folderKeep chats and threads together in the sidebar",
  ]);
  await click(paletteOption("Local folder"));
  expect(field().value).toBe("~/");
  expect(listFolders).toHaveBeenLastCalledWith("~/");
  // Hidden folders show only once a "." is typed.
  expect(paletteOptions().map((o) => o.textContent)).toEqual(["Desktop", "Developer", "Documents"]);

  typeInto(field(), "~/dev");
  expect(paletteOptions().map((o) => o.textContent)).toEqual(["Developer"]);
  pressKey("Enter");
  await settle();
  expect(field().value).toBe("~/Developer/");
  expect(listFolders).toHaveBeenLastCalledWith("~/Developer/");
  expect(paletteOptions().map((o) => o.textContent)).toEqual(["parallax", "photon"]);

  pressKey("Backspace");
  await settle();
  expect(field().value).toBe("~/");
  typeInto(field(), "~/Developer/");
  await settle();
  pressKey("ArrowDown");
  expect(paletteOption("photon")!.getAttribute("aria-selected")).toBe("true");
  pressKey("Enter");
  await settle();
  expect(field().value).toBe("~/Developer/photon/");
  // Enter only opens a folder; Mod+Enter adds the open one.
  expect(calls("repo/add")).toEqual([]);
  pressKey("Enter", { metaKey: true });
  await settle();
  expect(calls("repo/add")).toEqual([
    { id: expect.any(String), path: "/Users/me/Developer/photon" },
  ]);
  expect(hostsOf("repo/add")).toEqual(["local"]);
  expect(dialog().open).toBe(false);
});

test("with more than one computer, Local folder asks which, then browses and adds on that one", async () => {
  const nas: SshHost = { id: "h-nas", name: "NAS", destination: "nas" };
  sshHosts = [mini, nas];
  states[nas.id] = { status: "connecting" };
  capabilities = { hostFolders: {} };
  answers["host/folders"] = async (p) => ({ result: await listTree(p["path"] as string) });
  answers["repo/add"] = (p) => ({
    result: { repo: { ...repo("photon"), id: p["id"], path: p["path"] } },
  });
  await renderApp();
  await openPalette();
  expect(paletteOption("Local folder")!.textContent).toBe(
    "Local folderAdd a repository that's already on one of your computers",
  );
  await click(paletteOption("Local folder"));
  expect(paletteOptions().map((o) => o.textContent)).toEqual([
    "This MacThis computer",
    "Mac miniSSH · mini",
    "NASOffline",
  ]);
  // An offline computer can't be browsed.
  await click(paletteOption("NAS"));
  expect(field().getAttribute("aria-label")).toBe("Computer");

  await click(paletteOption("Mac mini"));
  expect(field().value).toBe("~/");
  expect(calls("host/folders")).toEqual([{ path: "~/" }]);
  expect(hostsOf("host/folders")).toEqual([mini.id]);
  expect(dialog().textContent).toContain("Folders on Mac mini");
  expect(paletteOptions().map((o) => o.textContent)).toEqual(["Desktop", "Developer", "Documents"]);
  // Finder only opens this computer's folders.
  expect(action("Choose in Finder")).toBeUndefined();

  typeInto(field(), "~/Developer/photon/");
  await settle();
  pressKey("Enter", { metaKey: true });
  await settle();
  expect(calls("repo/add")).toEqual([
    { id: expect.any(String), path: "/Users/me/Developer/photon" },
  ]);
  expect(hostsOf("repo/add")).toEqual([mini.id]);
  expect(dialog().open).toBe(false);
});

test("New repository creates it in ~/.parallax/projects and registers it, and a failed repo/add retries only the registering", async () => {
  createRepo.mockResolvedValue({ path: "/Users/me/.parallax/projects/photon" });
  let fail = true;
  answers["repo/add"] = (p) =>
    fail
      ? { error: { code: -32000, message: "plxd is busy" } }
      : { result: { repo: { ...parallax, id: p["id"], name: "photon", path: p["path"] } } };
  await renderApp();
  const before = crumbs();
  await openPalette();
  await click(paletteOption("New repository"));
  typeInto(field(), "bad name");
  expect(dialog().textContent).toContain("Use letters, digits, ., _, and - only.");
  expect(action("Create")!.disabled).toBe(true);
  typeInto(field(), "photon");
  expect(dialog().textContent).toContain("Creates ~/.parallax/projects/photon as a git repository");

  // A second Enter while the first is under way is dropped.
  pressKey("Enter");
  pressKey("Enter");
  await settle();
  expect(dialog().querySelector('[role="alert"]')?.textContent).toBe("plxd is busy");
  fail = false;
  pressKey("Enter");
  await settle();
  expect(createRepo.mock.calls).toEqual([["photon"]]);
  expect(calls("repo/add")).toEqual([
    { id: expect.any(String), path: "/Users/me/.parallax/projects/photon" },
    { id: expect.any(String), path: "/Users/me/.parallax/projects/photon" },
  ]);
  // It opens nothing: no Project, no thread.
  expect(dialog().open).toBe(false);
  expect(crumbs()).toEqual(before);
});

test("a clone that finishes after its palette closed is registered but leaves a palette opened since alone", async () => {
  listFolders.mockImplementation(listTree);
  const clone = Promise.withResolvers<{ path: string }>();
  answers["repo/clone"] = async () => ({
    result: {
      repo: { ...parallax, id: "r-photon", name: "photon", path: (await clone.promise).path },
    },
  });
  answers["repo/add"] = (p) => ({
    result: { repo: { ...parallax, id: "r-photon", name: "photon", path: p["path"] } },
  });
  await renderApp();
  await openPalette();
  await click(paletteOption("Clone from GitHub"));
  typeInto(field(), "ryan-stoffel/photon");
  pressKey("Enter");
  await settle();
  await click(action("Clone"));
  await act(async () => dialog().close());

  await openNewProject();
  await act(async () => clone.resolve({ path: "/Users/me/photon" }));
  await settle();
  expect(calls("repo/add")).toEqual([{ id: expect.any(String), path: "/Users/me/photon" }]);
  expect(dialog().open).toBe(true);
  expect(workspaceButton()).toBe("Workspace: parallax on This Mac");
});

test("Create Project's Workspace can be cloned from GitHub in the palette, which comes back to the form with it chosen", async () => {
  listFolders.mockImplementation(listTree);
  answers["repo/clone"] = () => ({
    result: {
      repo: { ...parallax, id: "r-photon", name: "photon", path: "/Users/me/Developer/photon" },
    },
  });
  answers["repo/add"] = (p) => ({
    result: { repo: { ...parallax, id: "r-photon", name: "photon", path: p["path"] } },
  });
  answers["project/create"] = (p) => ({
    result: { project: { ...project("Photon", "2026-09-29T12:00:00Z"), id: p["id"] } },
  });
  await renderApp();
  await openNewProject();
  typeInto(nameBox(), "Photon");
  await openWorkspaces();
  await click(workspaceItem("Clone a repository…"));

  expect(action("Next")!.disabled).toBe(true);
  typeInto(field(), "https://github.com/ryan-stoffel/photon.git");
  expect(dialog().textContent).toContain("https://github.com/ryan-stoffel/photon");
  pressKey("Enter");
  await settle();
  expect(field().value).toBe("~/photon");
  expect(dialog().textContent).toContain("Select where to clone");
  await click(paletteOption("Developer"));
  expect(field().value).toBe("~/Developer/photon");
  // Backspace on the untouched name goes up a folder, keeping the name.
  pressKey("Backspace");
  await settle();
  expect(field().value).toBe("~/photon");
  typeInto(field(), "~/Developer/photon");
  await settle();
  await click(action("Clone"));
  // plxd clones it, over HTTPS, into the path as typed (PLX-905).
  expect(calls("repo/clone")).toEqual([
    {
      id: expect.any(String),
      url: "https://github.com/ryan-stoffel/photon.git",
      path: "~/Developer/photon",
    },
  ]);
  expect(calls("repo/add")).toEqual([
    { id: expect.any(String), path: "/Users/me/Developer/photon" },
  ]);

  // Back on the form, with what was typed kept.
  expect(dialog().open).toBe(true);
  expect(workspaceButton()).toBe("Workspace: photon on This Mac");
  expect(nameBox().value).toBe("Photon");
  await click(inDialog("Create Project"));
  expect(calls("project/create")).toEqual([
    { id: expect.any(String), name: "Photon", repoPath: "/Users/me/Developer/photon" },
  ]);
});

test("a repository on another host creates the Project there, then opens that host and the Project", async () => {
  sshHosts = [mini];
  const api = repo("api");
  answers["thread/list"] = reposOn({ [mini.id]: [api, scratch] });
  const created: Project[] = [];
  const projectsHere = answers["project/list"]!;
  answers["project/list"] = (p, host) =>
    host === mini.id ? { result: { projects: created, seq: 7 } } : projectsHere(p, host);
  let fail = true;
  answers["project/create"] = (p) => {
    if (fail)
      return {
        error: {
          code: -32000,
          message: "/srv/api is not the top folder of a git repository: it has no .git.",
          data: { kind: "notARepository" },
        },
      };
    created.push({ ...project("api", "2026-09-29T12:00:00Z"), id: p["id"] as string });
    return { result: { project: created[0] } };
  };
  await renderApp();
  await openNewProject();
  await openWorkspaces();
  // This computer, then each SSH host, then GitHub, each host listing its own repositories with
  // no scratch entry. Browsing an SSH host isn't available yet (PLX-32).
  expect(workspaceGroups()).toEqual([
    ["This Mac", "parallax", "New repository…", "Choose folder…"],
    ["Mac mini", "api", "Browse foldersNot available yet"],
    ["GitHub", "Clone a repository…"],
  ]);
  expect(hostsOf("thread/list")).toContain(mini.id);
  expect(workspaceItem("parallax")!.getAttribute("aria-checked")).toBe("true");
  expect(workspaceItem("Browse foldersNot available yet")!.disabled).toBe(true);

  await click(workspaceItem("api"));
  expect(workspaceButton()).toBe("Workspace: api on Mac mini");
  expect(workspaceItem("api")!.getAttribute("aria-checked")).toBe("true");
  expect(nameBox().value).toBe("api");
  await click(inDialog("Create Project"));
  expect(dialog().querySelector('[role="alert"]')?.textContent).toBe(
    "/srv/api is not the top folder of a git repository: it has no .git.",
  );
  expect(dialog().open).toBe(true);

  fail = false;
  await click(inDialog("Create Project"));
  const [first, retry] = calls("project/create");
  expect(first).toEqual({ id: expect.any(String), name: "api", repoPath: "/srv/api" });
  expect(retry).toEqual(first);
  expect(hostsOf("project/create")).toEqual([mini.id, mini.id]);
  expect(dialog().open).toBe(false);
  // Mac mini became the open host, then the Project opened once Mac mini listed it.
  expect(crumbs()).toEqual(["Mac mini", "api"]);
  expect(projectRows()).toContain("api");
});

test("a host that is connecting or can't be reached says so in its group, and lists once it connects", async () => {
  const studio: SshHost = { id: "h-studio", name: "Studio", destination: "studio" };
  sshHosts = [mini, studio];
  states[mini.id] = {
    status: "failed",
    retrying: false,
    error: { reason: "sshSetup", message: "ssh couldn't reach mini: no route to host." },
  };
  states[studio.id] = { status: "connecting" };
  answers["thread/list"] = reposOn({ [studio.id]: [repo("ember")] });
  await renderApp();
  await openNewProject();
  await openWorkspaces();
  expect(workspaceGroups()).toEqual([
    ["This Mac", "parallax", "New repository…", "Choose folder…"],
    ["Mac mini", "Browse foldersNot available yet"],
    ["Studio", "Browse foldersNot available yet"],
    ["GitHub", "Clone a repository…"],
  ]);
  expect(hostNote("Mac mini")).toBe("Can't connect: ssh couldn't reach mini: no route to host.");
  expect(hostNote("Studio")).toBe("Connecting…");
  expect(hostNote("This Mac")).toBeUndefined();
  expect(hostsOf("thread/list")).not.toContain(mini.id);

  await act(async () => setState(studio.id, connected));
  await settle();
  expect(workspaceGroups()[2]).toEqual(["Studio", "ember", "Browse foldersNot available yet"]);
  expect(hostNote("Studio")).toBeUndefined();
});

test("the Workspace menu searches every host's repositories, Enter picks the first match, and Up and Down pass unavailable entries", async () => {
  sshHosts = [mini];
  answers["thread/list"] = reposOn({
    local: [parallax, repo("api-docs", "/src/api-docs")],
    [mini.id]: [repo("api"), repo("web")],
  });
  await renderApp();
  await openNewProject();
  await openWorkspaces();
  expect(document.activeElement).toBe(searchBox());

  typeInto(searchBox(), "API");
  expect(workspaceGroups()).toEqual([
    ["This Mac", "api-docs"],
    ["Mac mini", "api"],
  ]);
  typeInto(searchBox(), "we");
  expect(workspaceGroups()).toEqual([["Mac mini", "web"]]);
  press("Enter");
  expect(workspaceButton()).toBe("Workspace: web on Mac mini");
  expect(nameBox().value).toBe("web");
  expect(calls("project/create")).toEqual([]);

  typeInto(searchBox(), "zzz");
  expect(workspaceGroups()).toEqual([]);
  expect(workspaceMenu().textContent).toContain("No matches");

  typeInto(searchBox(), "");
  press("ArrowDown");
  expect(document.activeElement?.textContent).toBe("parallax");
  // From the top, Up wraps to GitHub's Clone a repository….
  press("ArrowUp");
  expect(document.activeElement?.textContent).toBe("Clone a repository…");
  press("ArrowUp");
  expect(document.activeElement?.textContent).toBe("web");
  press("ArrowDown");
  expect(document.activeElement?.textContent).toBe("Clone a repository…");
  press("ArrowDown");
  expect(document.activeElement?.textContent).toBe("parallax");
});

const favorites = () => document.querySelector<HTMLElement>('#sidebar [aria-label="Favorites"]')!;
/** A Project's favorite square in the sidebar, by its name (0075). */
const rowButton = (name: string) =>
  favorites().querySelector<HTMLButtonElement>(`button[aria-label="${name}"]`)!;
const projectRow = (name: string) => rowButton(name).closest("li")!;
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
const renameDialog = () =>
  document.querySelector<HTMLDialogElement>('dialog[aria-label="Rename Project"]');
const nameEditor = () => renameDialog()?.querySelector<HTMLInputElement>("input") ?? null;
const submitIn = (dialog: Element | null) => click(dialog?.querySelector('button[type="submit"]'));
const cancelIn = (dialog: Element | null) =>
  click([...(dialog?.querySelectorAll("button") ?? [])].find((b) => b.textContent === "Cancel"));
// The open icon picker: it draws its grid only while open.
const openPicker = () =>
  [...document.querySelectorAll<HTMLElement>('[role="dialog"][aria-label="Project icon"]')].find(
    (p) => p.childElementCount > 0,
  )!;
/** The Lucide glyph and color an icon draws, from its classes. */
const looks = (svg: Element | null | undefined) => {
  const classes = [...(svg?.classList ?? [])];
  return [
    classes.find((c) => c.startsWith("lucide-"))?.slice("lucide-".length),
    classes.find((c) => c.startsWith("text-")),
  ];
};
const rowIcon = (name: string) => looks(rowButton(name).querySelector("svg"));
const iconPicker = (within: Element) =>
  within.matches('[role="dialog"][aria-label="Project icon"]')
    ? (within as HTMLElement)
    : within.querySelector<HTMLElement>('[role="dialog"][aria-label="Project icon"]');
const pickIcon = (within: Element, label: string) =>
  click(iconPicker(within)!.querySelector(`[role="option"][aria-label="${label}"]`));
const pickColor = (within: Element, label: string) =>
  click(iconPicker(within)!.querySelector(`input[type="radio"][aria-label="${label}"]`));
const projectEvent = (seq: number, kind: "project.updated", p: Project) =>
  act(async () =>
    deliver({
      type: "event",
      event: { subscription: "s-1", seq, time: "", event: { kind, project: p } },
    }),
  );
/** `project/update` answering with ember or photon as changed. */
const updates: Answer = (p) => {
  const before = [
    project("ember", "2026-09-26T12:00:00Z"),
    project("photon", "2026-09-29T09:00:00Z"),
  ].find((x) => x.id === p["project"])!;
  const { name, icon } = p as { name?: string; icon?: Project["icon"] };
  return { result: { project: { ...before, ...(name && { name }), ...(icon && { icon }) } } };
};

test("a Project's favorite opens its menu on a right-click, and Rename… saves a new name, while Cancel, an empty name, or the same name save nothing", async () => {
  capabilities = { projectEdit: {} };
  answers["project/update"] = updates;
  await renderApp();
  expect(menuItems("ember").map((b) => b.textContent)).toEqual([
    "Open",
    "Move left",
    "Move right",
    "Rename…",
    "Change icon…",
  ]);
  // Right-clicking the square opens the menu: on the button's release where it comes while the
  // button is down (macOS, Linux), since the release would close a menu shown before it.
  const trigger = projectRow("ember").querySelector<HTMLButtonElement>("button[popovertarget]")!;
  const opened = vi.fn();
  trigger.addEventListener("click", opened);
  const pressed = new MouseEvent("contextmenu", { bubbles: true, cancelable: true, buttons: 2 });
  act(() => void rowButton("ember").dispatchEvent(pressed));
  expect(pressed.defaultPrevented).toBe(true);
  expect(opened).not.toHaveBeenCalled();
  act(() => void window.dispatchEvent(new Event("pointerup")));
  expect(opened).toHaveBeenCalledTimes(1);

  await click(menuItem("ember", "Rename…"));
  expect(renameDialog()!.open).toBe(true);
  expect(nameEditor()!.value).toBe("ember");
  typeInto(nameEditor()!, "  ember app ");
  await submitIn(renameDialog());
  expect(calls("project/update")).toEqual([{ project: "p-ember", name: "ember app" }]);
  expect(renameDialog()).toBeNull();
  expect(projectRows()).toEqual(["ember app", "photon"]);

  // Cancel, an empty name, and the same name each close the dialog and save nothing.
  await click(menuItem("photon", "Rename…"));
  typeInto(nameEditor()!, "photon two");
  await cancelIn(renameDialog());
  await click(menuItem("photon", "Rename…"));
  typeInto(nameEditor()!, "   ");
  await submitIn(renameDialog());
  await click(menuItem("photon", "Rename…"));
  await submitIn(renameDialog());
  expect(renameDialog()).toBeNull();
  expect(calls("project/update")).toHaveLength(1);
});

test("a rename left as it opened sends nothing, even after another client renamed the project", async () => {
  capabilities = { projectEdit: {} };
  answers["project/update"] = updates;
  await renderApp();
  await click(menuItem("ember", "Rename…"));
  await projectEvent(8, "project.updated", {
    ...project("ember", "2026-09-26T12:00:00Z"),
    name: "ember (renamed elsewhere)",
  });
  expect(nameEditor()!.value).toBe("ember");
  await submitIn(renameDialog());
  expect(calls("project/update")).toEqual([]);
  expect(projectRows()).toEqual(["ember (renamed elsewhere)", "photon"]);
});

test("a rename plxd refuses keeps the name and says plxd's error in a notification", async () => {
  capabilities = { projectEdit: {} };
  answers["project/update"] = () => ({
    error: { code: -32602, message: "Invalid params: name must be at most 256 bytes" },
  });
  await renderApp();
  await click(menuItem("ember", "Rename…"));
  typeInto(nameEditor()!, "a very long name");
  await submitIn(renameDialog());
  expect(projectRows()).toEqual(["ember", "photon"]);
  expect(notice()).toEqual([
    "Couldn't change the Project",
    "Invalid params: name must be at most 256 bytes",
  ]);
});

test("Change icon… opens the picker under the Project's square, and each pick saves the glyph and color together at once", async () => {
  capabilities = { projectEdit: {} };
  // Held until released, as over a slow ssh link.
  const pending: (() => void)[] = [];
  answers["project/update"] = async (p, host) => {
    await new Promise<void>((resolve) => pending.push(resolve));
    return updates(p, host);
  };
  await renderApp();
  expect(rowIcon("ember")).toEqual(["layers", "text-accent"]);

  await click(menuItem("ember", "Change icon…"));
  expect(popoverSources).toEqual([projectRow("ember")]);
  const picker = openPicker();
  expect(
    iconPicker(picker)!
      .querySelector('[role="option"][aria-selected="true"]')!
      .getAttribute("aria-label"),
  ).toBe("Layers");

  // A color, then an icon before the first answer: the second keeps the color.
  await pickColor(picker, "Violet");
  await pickIcon(picker, "Rocket");
  expect(calls("project/update")).toEqual([
    { project: "p-ember", icon: { name: "layers", color: "violet" } },
    { project: "p-ember", icon: { name: "rocket", color: "violet" } },
  ]);
  expect(hostsOf("project/update")).toEqual(["local", "local"]);
  // The picker stays open for the next pick.
  expect(iconPicker(picker)!.childElementCount).toBeGreaterThan(0);

  await act(async () => pending.forEach((resolve) => resolve()));
  await settle();
  expect(rowIcon("ember")).toEqual(["rocket", "text-project-violet"]);

  // The accent sends the icon with no color (0032).
  await pickColor(picker, "Accent");
  expect(calls("project/update").at(-1)).toEqual({ project: "p-ember", icon: { name: "rocket" } });
});

test("another client's project.updated renames a row and changes its icon, in the breadcrumb and the chat too", async () => {
  capabilities = { projectEdit: {} };
  await renderApp();
  await click(rowButton("ember"));
  await projectEvent(8, "project.updated", {
    ...project("ember", "2026-09-26T12:00:00Z"),
    name: "ember app",
    icon: { name: "rocket", color: "green" },
  });
  expect(projectRows()).toEqual(["ember app", "photon"]);
  expect(rowIcon("ember app")).toEqual(["rocket", "text-project-green"]);
  expect(crumbs()).toEqual(["This Mac", "ember app"]);
  const crumbIcon = document.querySelector('[aria-label="Breadcrumb"] li:last-child svg');
  expect(looks(crumbIcon)).toEqual(["rocket", "text-project-green"]);
  expect(looks(document.querySelector("main svg.size-10"))).toEqual([
    "rocket",
    "text-project-green",
  ]);
});

test("with iconImages, Change icon uploads an image, and a Project's and its repo's images draw in the row, the Repos filter, the breadcrumb, and the chat", async () => {
  capabilities = { projectEdit: {}, iconImages: { maxBytes: 65536 } };
  const logo = { mediaType: "image/webp" as const, data: "UklGRg==" };
  const repoLogo = { mediaType: "image/png" as const, data: "iVBORw==" };
  answers["thread/list"] = () => ({
    result: {
      repos: [{ ...repo("ember", "/src/ember"), icon: { name: "rocket", image: repoLogo } }],
      threads: [],
      seq: 7,
    },
  });
  answers["project/update"] = updates;
  // happy-dom decodes and draws no images.
  onTestFinished(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });
  vi.stubGlobal("createImageBitmap", async () => ({ width: 64, height: 64, close() {} }));
  // The image upload draws the picture.
  const noop = () => {};
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
    drawImage: noop,
  } as never);
  vi.spyOn(HTMLCanvasElement.prototype, "toDataURL").mockReturnValue(
    `data:image/webp;base64,${logo.data}`,
  );
  await renderApp();

  await click(menuItem("ember", "Change icon…"));
  const input = iconPicker(openPicker())!.querySelector<HTMLInputElement>('input[type="file"]')!;
  Object.defineProperty(input, "files", {
    value: [new File(["x"], "logo.png", { type: "image/png" })],
  });
  await act(async () => {
    input.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await settle();
  expect(calls("project/update")).toEqual([
    { project: "p-ember", icon: { name: "layers", image: logo } },
  ]);

  const drawn = (within: Element | null | undefined) =>
    [...(within?.querySelectorAll("svg[data-icon-image] image") ?? [])].map((i) =>
      i.getAttribute("href"),
    );
  const projectUrl = `data:image/webp;base64,${logo.data}`;
  const repoUrl = `data:image/png;base64,${repoLogo.data}`;
  // The square has no repo line (PLX-340), so the repo's image draws in the Repos filter.
  expect(drawn(rowButton("ember"))).toEqual([projectUrl]);
  expect(drawn(document.querySelector('#sidebar [role="menu"][aria-label="Repos"]'))).toEqual([
    repoUrl,
  ]);
  await click(rowButton("ember"));
  expect(drawn(document.querySelector('[aria-label="Breadcrumb"]'))).toEqual([projectUrl]);
  expect(drawn(document.querySelector("main svg.size-10")?.parentElement)).toEqual([projectUrl]);
});

test("an icon name or color this app doesn't know draws Layers or the accent in its place", async () => {
  answers["project/list"] = () => ({
    result: {
      projects: [
        {
          ...project("ember", "2026-09-26T12:00:00Z"),
          icon: { name: "not-an-icon", color: "red" },
        },
        {
          ...project("photon", "2026-09-29T09:00:00Z"),
          icon: { name: "bug", color: "chartreuse" },
        },
        { ...project("parallax", "2026-09-28T09:00:00Z"), icon: { name: "nope" } },
      ],
      seq: 7,
    },
  });
  await renderApp();
  expect(rowIcon("ember")).toEqual(["layers", "text-project-red"]);
  expect(rowIcon("photon")).toEqual(["bug", "text-accent"]);
  expect(rowIcon("parallax")).toEqual(["layers", "text-accent"]);
  await click(rowButton("ember"));
  const crumbIcon = document.querySelector('[aria-label="Breadcrumb"] li:last-child svg');
  expect(looks(crumbIcon)).toEqual(["layers", "text-project-red"]);
  expect(looks(document.querySelector("main svg.size-10"))).toEqual(["layers", "text-project-red"]);
});

const iconButton = () =>
  dialog().querySelector<HTMLButtonElement>('button[aria-label="Choose icon"]');
const dialogIcon = () => looks(dialog().querySelector("svg.size-8"));
// happy-dom has no popovers, so the picker gets the event a browser sends as its button opens it.
const openDialogPicker = async () => {
  const picker = iconPicker(dialog())!;
  expect(iconButton()!.getAttribute("popovertarget")).toBe(picker.id);
  await act(async () => {
    picker.dispatchEvent(
      Object.assign(new Event("beforetoggle"), { oldState: "closed", newState: "open" }),
    );
  });
};

test("Create Project's icon opens the picker, project/create sends the chosen icon, and a new icon is a new try", async () => {
  capabilities = { projectEdit: {} };
  let fails = 2;
  answers["project/create"] = (p) =>
    fails-- > 0
      ? {
          error: {
            code: -32000,
            message: "/src/parallax is not the top folder of a git repository",
          },
        }
      : {
          result: {
            project: {
              ...project("parallax", "2026-09-29T12:00:00Z"),
              id: p["id"],
              icon: p["icon"],
            },
          },
        };
  await renderApp();
  await openNewProject();
  expect(dialogIcon()).toEqual(["layers", "text-accent"]);
  await openDialogPicker();
  await pickColor(dialog(), "Teal");
  await pickIcon(dialog(), "Rocket");
  expect(dialogIcon()).toEqual(["rocket", "text-project-teal"]);
  // Choosing in the dialog sends nothing until Create.
  expect(calls("project/update")).toEqual([]);

  await click(inDialog("Create Project"));
  await pickIcon(dialog(), "Bug");
  await click(inDialog("Create Project"));
  await click(inDialog("Create Project"));
  const [first, second, retry] = calls("project/create");
  expect(first).toEqual({
    id: expect.any(String),
    name: "parallax",
    repoPath: "/src/parallax",
    icon: { name: "rocket", color: "teal" },
  });
  expect(second).toEqual({
    ...first,
    id: expect.any(String),
    icon: { name: "bug", color: "teal" },
  });
  expect(second!["id"]).not.toBe(first!["id"]);
  expect(retry).toEqual(second);
  expect(dialog().open).toBe(false);
  expect(rowIcon("parallax")).toEqual(["bug", "text-project-teal"]);

  // It opens again on the default.
  await openNewProject();
  expect(dialogIcon()).toEqual(["layers", "text-accent"]);
});

test("without projectEdit, a Project's menu has no Rename or Change icon, Create Project's icon is no button, and nothing sends an icon", async () => {
  await renderApp();
  expect(menuItems("ember").map((b) => b.textContent)).toEqual(["Open", "Move left", "Move right"]);

  await openNewProject();
  expect(iconButton()).toBeNull();
  expect(iconPicker(dialog())).toBeNull();
  expect(dialogIcon()).toEqual(["layers", "text-accent"]);
});

test("Create Project's icon follows the Workspace's host: an icon only where that host's plxd keeps one", async () => {
  sshHosts = [mini];
  states[mini.id] = { ...connected, capabilities: { projectEdit: {} } };
  const api = repo("api");
  answers["thread/list"] = reposOn({ [mini.id]: [api] });
  answers["project/create"] = () => ({
    error: { code: -32000, message: "not a repository", data: { kind: "notARepository" } },
  });
  await renderApp();
  await openNewProject();
  // This computer's plxd has no projectEdit here.
  expect(iconButton()).toBeNull();

  await openWorkspaces();
  await click(workspaceItem("api"));
  expect(workspaceButton()).toBe("Workspace: api on Mac mini");
  await openDialogPicker();
  await pickIcon(dialog(), "Rocket");
  expect(dialogIcon()).toEqual(["rocket", "text-accent"]);
  await click(inDialog("Create Project"));

  await click(workspaceItem("parallax"));
  expect(iconButton()).toBeNull();
  expect(dialogIcon()).toEqual(["layers", "text-accent"]);
  await click(inDialog("Create Project"));

  expect(calls("project/create")).toEqual([
    { id: expect.any(String), name: "api", repoPath: "/srv/api", icon: { name: "rocket" } },
    { id: expect.any(String), name: "parallax", repoPath: "/src/parallax" },
  ]);
  expect(hostsOf("project/create")).toEqual([mini.id, "local"]);
});

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

test("without projectPermission, Create Project shows no mode and sends none, and a row has no Full access…", async () => {
  capabilities = { projectEdit: {} };
  await renderApp();
  expect(menuItem("ember", "Full access…")).toBeUndefined();
  expect(menuItem("ember", "Autonomy…")).toBeUndefined();
  await openNewProject();
  expect(modeChoice(dialog())).toEqual([]);
  expect(dialog().textContent).not.toContain("no second check");
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

test("with no coordinator account, the coordinator runs on the host's Claude Code login", async () => {
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
  expect(document.querySelector('main [role="status"]')).toBeNull();
  expect(transcript()).toContain("I'll plan it.");
});

const oldId = "01a0d390-2c3d-7e4f-9a0b-1c2d3e4f5a6b";

test("Fresh session in a Project's menu ends its coordinator's session, which shows as a divider", async () => {
  capabilities = { coordinator: {}, coordinatorEpochs: {} };
  const run = { ...coordinatorRun(oldId, "Add a dark mode"), status: "completed" as const };
  answers["project/list"] = () => ({
    result: { projects: [{ ...project("ember", "2026-09-26T12:00:00Z"), coordinator: oldId }] },
  });
  answers["agent/events"] = () => ({
    result: {
      events: [
        { seq: 8, time: "", event: { kind: "agent.started", runId: oldId, run } },
        {
          seq: 9,
          time: "",
          event: {
            kind: "agent.output",
            runId: oldId,
            items: [{ kind: "epoch", epoch: 2, reason: "userFresh" }],
          },
        },
      ],
      more: false,
    },
  });
  answers["coordinator/fresh"] = () => ({ result: { run } });
  await renderApp();
  await click(menuItem("ember", "Fresh session"));
  expect(calls("coordinator/fresh")).toEqual([{ project: "p-ember" }]);

  await openEmber();
  expect(transcript()).toContain("New session, picked up from the Project's state");
  expect(transcript()).not.toContain("Start over");
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
  branch: "parallax/login",
  diff: { commit: "c1", files: 2, insertions: 12, deletions: 3 },
  sessionId: "s-1",
});
const docs = subagent("01a0d391-0000-7000-8000-000000000002", "Write the docs", {
  coordinatorThread: undefined,
  accountId: "01a0d34b-3c4d-7e5f-a061-7b8c9d0e1f22",
  branch: "parallax/docs",
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
/**
 * Ember with a coordinator and `runs` after it, served by `agent/list` and `agent/events`, open
 * with its Agents view, on `capabilities` with `coordinator` and `openPr`. Photon has no runs.
 */
async function openEmberAgents(...runs: AgentRun[]) {
  capabilities = { coordinator: {}, openPr: {}, ...capabilities };
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
    result: { runs: [undefined, "p-ember"].includes(p["project"] as string) ? all : [], seq: 7 },
  });
  answers["agent/events"] = serveEvents(() => all);
  await renderApp();
  await openEmber();
  await openView("Agents");
}
const agentRows = () =>
  [...document.querySelectorAll('#side-panel [aria-label="Agents"] button')].map(
    (b) => b.textContent,
  );
const agentRow = (title: string) =>
  [...document.querySelectorAll('#side-panel [aria-label="Agents"] button')].find((b) =>
    b.textContent?.startsWith(title),
  );

test("a Project's Agents view lists its children Needs you, Working, Done, Failed, newest first within each, without its coordinator, and keeps them live", async () => {
  const release = subagent("01a0d391-0000-7000-8000-000000000004", "Cut the release", {
    status: "failed",
  });
  await openEmberAgents(login, docs, release);
  expect(agentRows()).toEqual([
    "Write the docsby youWorkingparallax/docsAPI key",
    "Fix the login bugby coordinatorDoneparallax/login+12 −3Claude subscription",
    "Cut the releaseby coordinatorFailedClaude subscription",
  ]);

  const event = (seq: number, e: ParallaxEvent) =>
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
    "Write the docsby youDoneparallax/docs+4 −0API key",
    "Fix the login bugby coordinatorDoneparallax/login+12 −3Claude subscription",
    "Cut the releaseby coordinatorFailedClaude subscription",
  ]);

  // A finished child that asks again goes to the top.
  await event(10, { kind: "agent.output", runId: login.id, items: [bashAsk("s1")] });
  expect(agentRows()[0]).toBe(
    "Fix the login bugby coordinatorNeeds approvalparallax/login+12 −3Claude subscription",
  );
});

test("opening a subagent shows its chat, with Open PR, and the Project crumb goes back to the coordinator", async () => {
  // The finished subagent picks up the message.
  answers["orchestration/dispatch"] = () => ({ result: { seq: 1 } });
  await openEmberAgents(login, docs);
  await click(agentRow("Fix the login bug"));
  expect(crumbs()).toEqual(["This Mac", "ember", "Fix the login bug"]);
  expect(agentRow("Fix the login bug")!.getAttribute("aria-current")).toBe("page");
  // The Project stays selected in the sidebar.
  const ember = rowButton("ember");
  expect(ember!.getAttribute("aria-current")).toBe("page");
  expect(transcript()).toContain("Fix the login bug");
  const main = document.querySelector("main")!;
  expect(main.textContent).toContain("Open PR");

  type("Cover the logout path too");
  await click(button("Send"));
  expect(sentMessages()).toEqual([
    { runId: login.id, turnId: expect.any(String), text: "Cover the logout path too" },
  ]);

  await click(document.querySelector('[aria-label="Breadcrumb"] button'));
  expect(crumbs()).toEqual(["This Mac", "ember"]);
  expect(transcript()).toContain("Plan the release");
});

test("opening a subagent from an expanded side panel shrinks it, so the chat shows", async () => {
  await openEmberAgents(login);
  await click(document.querySelector('#side-panel button[aria-label="Full screen"]'));
  expect(document.querySelector("main")!.hidden).toBe(true);
  await click(agentRow("Fix the login bug"));
  expect(document.querySelector("main")!.hidden).toBe(false);
  expect(crumbs()).toEqual(["This Mac", "ember", "Fix the login bug"]);
});

test("a running subagent's chat stops it", async () => {
  answers["orchestration/dispatch"] = () => ({ result: { seq: 1 } });
  await openEmberAgents(docs);
  await click(agentRow("Write the docs"));
  await click(button("Stop"));
  expect(stops()).toEqual([{ runId: docs.id }]);
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
  expect(notice()).toEqual([
    "Couldn't start the subagent",
    "Choose an account to run threads on this host.",
  ]);

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
  // It lists once its agent.started reaches the shell, as plxd sends it.
  const run = subagent(first!["runId"] as string, "Bump the version");
  await act(async () =>
    deliver({
      type: "event",
      event: {
        subscription: "s-1",
        seq: 8,
        time: "",
        project: "p-ember",
        event: { kind: "agent.started", runId: run.id, run },
      },
    }),
  );
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

  await click(rowButton("photon"));
  expect(crumbs()).toEqual(["This Mac", "photon"]);
  // Each Project's panel has its own tabs (PLX-872).
  await openView("Agents");
  expect(box().value).toBe("");
  await act(async () => release());
  await settle();
  expect(agentRows()).toEqual([]);
});

const bar = () => document.querySelector<HTMLElement>('main section[aria-label="Agents"]');
/** Opens the agents bar's card, as clicking it does in a browser. */
const openBar = () =>
  act(async () => {
    bar()!
      .querySelector("[popover]")!
      .dispatchEvent(Object.assign(new Event("beforetoggle"), { newState: "open" }));
  });
const cardGroup = (label: string) =>
  [...bar()!.querySelectorAll(`[popover] section[aria-label="${label}"] li button`)].map(
    (b) => b.querySelector("span span")?.textContent,
  );

test("the agents bar over a Project's composer shows its first three providers, +N, the lead child, and opens a card of Working and Done whose rows open their chats", async () => {
  const going = (n: number, prompt: string, backend: string) =>
    subagent(`01a0d391-0000-7000-8000-00000000001${n}`, prompt, { backend });
  const children = [
    going(0, "Write the docs", "claude"),
    going(1, "Add the tests", "codex"),
    going(2, "Check the links", "cursor"),
    going(3, "Tag the release", "claude"),
  ];
  capabilities = { inbox: {} };
  answers["inbox/list"] = () => ({ result: { items: [], seq: 7 } });
  await openEmberAgents(login, ...children);
  // The newest going child leads, and each going child's provider is a logo, three at most.
  expect(bar()!.querySelector("button")!.textContent).toBe(
    "+14 agents going: Tag the release4 working",
  );
  expect(bar()!.querySelectorAll("button > span:first-child svg")).toHaveLength(3);

  await openBar();
  expect(cardGroup("Working")).toEqual([
    "Tag the release",
    "Check the links",
    "Add the tests",
    "Write the docs",
  ]);
  expect(cardGroup("Done")).toEqual(["Fix the login bug"]);
  // Done is the green check normal threads show.
  expect(bar()!.querySelector('[popover] section[aria-label="Done"] li')!.textContent).toContain(
    "Done",
  );
  await click(
    [...bar()!.querySelectorAll("[popover] li button")].find((b) =>
      b.textContent?.startsWith("Add the tests"),
    ),
  );
  expect(crumbs()).toEqual(["This Mac", "ember", "Add the tests"]);

  // A child with a question leads, and the bar counts who needs the user.
  await click(document.querySelector('[aria-label="Breadcrumb"] button'));
  await act(async () =>
    deliver({
      type: "event",
      event: {
        subscription: "s",
        seq: 8,
        time: "",
        event: {
          kind: "inbox.added",
          item: inboxItem("i-asks", "needsYou", "Write the docs: asks which tone", {
            run: children[0]!.id,
          }),
        },
      },
    }),
  );
  expect(bar()!.querySelector("button")!.textContent).toBe(
    "+14 agents going, 1 waiting on you: Write the docs1 need you",
  );
  // The app keeps its notifications between tests, so close the question's.
  const closeToast = () =>
    document.querySelector<HTMLButtonElement>('[aria-label="Notifications"] [aria-label="Close"]');
  while (closeToast()) act(() => closeToast()!.click());

  // Another Project with nothing going has no bar.
  await click(rowButton("photon"));
  expect(bar()).toBeNull();
});

test("a child's chat says whose it is, and its Open parent button, the top bar's back arrow, and Go to parent return to the coordinator", async () => {
  await openEmberAgents(login);
  const strip = () => document.querySelector('main section[aria-label="Child thread"]');
  const back = async () => {
    await click(agentRow("Fix the login bug"));
    expect(crumbs()).toEqual(["This Mac", "ember", "Fix the login bug"]);
  };
  expect(strip()).toBeNull();
  await back();
  expect(strip()!.textContent).toBe("A child thread of emberOpen parent⌥⌘↑");
  await click(strip()!.querySelector("button")!);
  expect(crumbs()).toEqual(["This Mac", "ember"]);
  expect(strip()).toBeNull();

  await back();
  await click(
    [...strip()!.querySelectorAll("button")].find((b) => b.textContent?.startsWith("Open parent")),
  );
  expect(crumbs()).toEqual(["This Mac", "ember"]);
  expect(strip()).toBeNull();

  await back();
  await click(document.querySelector('button[aria-label="Back to the coordinator"]'));
  expect(crumbs()).toEqual(["This Mac", "ember"]);

  await back();
  await act(async () => {
    window.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "ArrowUp",
        code: "ArrowUp",
        metaKey: true,
        altKey: true,
      }),
    );
  });
  await settle();
  expect(crumbs()).toEqual(["This Mac", "ember"]);
  expect(transcript()).toContain("Plan the release");
});

// --- PLX-196: permission requests in a Project ---

const plan = "## Plan\n\n1. Cut the release branch\n2. Write the changelog";
const bashAsk = (approvalId: string): AgentOutputItem => ({
  kind: "approvalRequested",
  approvalId,
  toolName: "Bash",
  input: { command: "git tag v1.2.0" },
  callId: `toolu_${approvalId}`,
  expiresAt: "2026-09-29T12:30:00Z",
});
const planAsk = (input: Record<string, string>): AgentOutputItem[] => [
  { kind: "toolCall", callId: "toolu_p1", name: "ExitPlanMode", input: {} },
  {
    kind: "approvalRequested",
    approvalId: "p1",
    toolName: "ExitPlanMode",
    input,
    callId: "toolu_p1",
    interactive: true,
    expiresAt: "2026-09-29T12:30:00Z",
  },
];
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

for (const [name, input, shows] of [
  [
    "with its plan",
    { plan, planFilePath: "/home/me/.claude/plans/release.md" },
    "Cut the release branch",
  ],
  ["without one", {}, "The plan didn't come with the request."],
] as const)
  test(`a coordinator's ExitPlanMode ${name} is pinned in its chat, and Approve plan allows it as asked`, async () => {
    const coordinator = asking({
      ...coordinatorRun(coordinatorId, "Plan the release"),
      permission: "plan",
    });
    await openEmberAsking(coordinator, [], { [coordinatorId]: planAsk(input) });
    expect(pinned()!.textContent).toContain("Proposed plan");
    expect(pinned()!.textContent).toContain(shows);
    // Its own request, so it names no other run.
    expect(pinned()!.textContent).not.toContain("Coordinator");
    await click(pinnedButton("Approve plan"));
    expect(calls("agent/approve")).toEqual([
      { runId: coordinatorId, approvalId: "p1", decision: "allow" },
    ]);
    expect(pinned()).toBeNull();
    expect(transcript()).toContain("Approved the plan");
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

test("a subagent's chat pins the coordinator's request too, and a Project with no coordinator pins its subagents'", async () => {
  const docs = asking(subagent("01a0d391-0000-7000-8000-000000000002", "Write the docs"));
  await openEmberAsking(asking(coordinatorRun(coordinatorId, "Plan the release")), [docs], {
    [coordinatorId]: [bashAsk("c1")],
  });
  expect(pinned()!.textContent).not.toContain("Coordinator");
  await openView("Agents");
  await click(agentRow("Write the docs"));
  expect(pinned()!.textContent).toContain("Coordinator");
  act(() => unmount());

  const byHand = asking(
    subagent("01a0d391-0000-7000-8000-000000000003", "Tag the release", {
      coordinatorThread: undefined,
    }),
  );
  await openEmberAsking(undefined, [byHand], { [byHand.id]: [bashAsk("h1")] });
  expect(pinned()!.textContent).toContain("Subagent: Tag the release");
  await click(pinnedButton("Approve"));
  expect(calls("agent/approve")).toContainEqual({
    runId: byHand.id,
    approvalId: "h1",
    decision: "allow",
  });
  expect(pinned()).toBeNull();
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

test("side panel visibility belongs to each thread, while entering a Project still opens it", async () => {
  const second = { ...flaky, id: "t-second" };
  answers["thread/list"] = () => ({
    result: { repos: [parallax], threads: [flaky, second], seq: 7 },
  });
  answers["agent/list"] = () => ({
    result: {
      runs: [flaky, second].map((t, i) => ({
        ...coordinatorRun(t.id, `Thread ${i + 1}`),
        project: parallax.id,
        status: "completed",
      })),
      seq: 7,
    },
  });
  await renderApp();
  const threadButton = (name: string) =>
    [
      ...document.querySelectorAll<HTMLButtonElement>('#sidebar li[data-kind="thread"] > button'),
    ].find((b) => b.querySelector("[data-title]")?.textContent === name)!;
  const panel = () => document.getElementById("side-panel")!;
  const close = () =>
    click(document.querySelector('#side-panel button[aria-label="Hide side panel"]'));
  await click(threadButton("Thread 1"));
  await click(button("Show side panel"));
  expect(panel().hidden).toBe(false);
  await click(threadButton("Thread 2"));
  expect(panel().hidden).toBe(true);
  await click(button("Show side panel"));
  await click(threadButton("Thread 1"));
  expect(panel().hidden).toBe(false);
  await close();
  await click(threadButton("Thread 2"));
  expect(panel().hidden).toBe(false);
  await click(threadButton("Thread 1"));
  expect(panel().hidden).toBe(true);
  await openEmber();
  expect(panel().hidden).toBe(false);
  await close();
  await click(threadButton("Thread 2"));
  expect(panel().hidden).toBe(false);
  await openEmber();
  expect(panel().hidden).toBe(false);
  await click(threadButton("Thread 1"));
  expect(panel().hidden).toBe(true);
});
const newProjectButtons = () => [
  ...document.querySelectorAll('#sidebar button[aria-label="New project"]'),
];
const statusOf = (title: string) =>
  [...document.querySelectorAll("#sidebar li[data-kind]")]
    .find((li) => li.querySelector("[data-title]")?.textContent === title)
    ?.querySelector("[data-status]")?.textContent;
const keyDown = (init: KeyboardEventInit) =>
  act(async () => void window.dispatchEvent(new KeyboardEvent("keydown", init)));
const deleteDialog = () =>
  [...document.querySelectorAll("dialog")].find((d) =>
    d.querySelector("h2")?.textContent?.startsWith("Delete this"),
  )!;

const drawer = (name: string) =>
  [...document.querySelectorAll<HTMLDetailsElement>("#sidebar details")].find((d) =>
    d.querySelector("summary")?.textContent?.startsWith(name),
  );
const drawerTitles = (name: string) =>
  [...(drawer(name)?.querySelectorAll("[data-title]") ?? [])].map((t) => t.textContent);
const threadTitles = () =>
  [...document.querySelectorAll('#sidebar [aria-label="Threads"] [data-title]')].map(
    (t) => t.textContent,
  );

test("a working thread waits in Working, folded until opened, then comes back to Today when it finishes; a thread it started never lists", async () => {
  const running: Thread = {
    id: "t-run",
    repo: parallax.id,
    title: "Ship the sidebar",
    createdAt: "2026-09-29T11:30:00Z",
  };
  const child: Thread = {
    id: "t-child",
    repo: parallax.id,
    parent: running.id,
    title: "Write the notes",
    createdAt: "2026-09-29T11:40:00Z",
  };
  const idle: Thread = {
    id: "t-idle",
    repo: parallax.id,
    title: "Read the docs",
    createdAt: "2026-09-29T11:00:00Z",
    seenAt: "2026-09-29T12:00:00Z",
  };
  answers["thread/list"] = () => ({
    result: { repos: [parallax], threads: [running, child, idle], seq: 7 },
  });
  answers["agent/list"] = () => ({
    result: {
      runs: [
        // Not a Project's run, so the sidebar lists the thread instead of folding it into one.
        { ...coordinatorRun(running.id, "Ship the sidebar"), project: parallax.id },
        {
          ...coordinatorRun(child.id, "Write the notes"),
          project: parallax.id,
          status: "completed",
        },
        {
          ...coordinatorRun(idle.id, "Read the docs"),
          project: parallax.id,
          status: "completed",
          updatedAt: "2026-09-29T11:00:00Z",
        },
      ],
      seq: 7,
    },
  });
  capabilities = { threadLineage: {} };
  await renderApp();
  // Working starts folded (0075).
  expect(drawer("Working")!.open).toBe(false);
  await click(drawer("Working")!.querySelector("summary"));
  expect(drawerTitles("Working")).toEqual(["Ship the sidebar"]);
  expect(threadTitles()).toEqual(["Read the docs"]);

  await act(async () =>
    deliver({
      type: "event",
      event: {
        subscription: "s-1",
        seq: 8,
        time: "2026-09-29T12:10:00Z",
        event: {
          kind: "agent.updated",
          runId: running.id,
          state: {
            status: "completed",
            accountId: "claude",
            updatedAt: "2026-09-29T12:10:00Z",
          },
        },
      },
    }),
  );
  await settle();
  expect(drawer("Working")).toBeUndefined();
  expect(threadTitles()).toEqual(["Ship the sidebar", "Read the docs"]);

  sidebarPrefs.set({ ...sidebarDefaults, workingSection: false });
  act(() => unmount());
  await renderApp();
  expect(drawer("Working")).toBeUndefined();
  expect(threadTitles()).toEqual(["Ship the sidebar", "Read the docs"]);
  // Finishing the run notifies, and the app keeps that notice for the next test.
  const closeToast = () =>
    document.querySelector<HTMLButtonElement>('[aria-label="Notifications"] [aria-label="Close"]');
  while (closeToast()) act(() => closeToast()!.click());
});

test("Archived lists 25 threads, Show more reveals the next page, and the summary stays out of the scroller", async () => {
  const threads = Array.from({ length: 60 }, (_, n) => ({
    id: `t-arch-${n}`,
    repo: parallax.id,
    title: `Archived ${String(n).padStart(2, "0")}`,
    archived: true,
    createdAt: new Date(Date.parse("2026-09-01T00:00:00Z") + n * 60_000).toISOString(),
  }));
  answers["thread/list"] = () => ({ result: { repos: [parallax], threads, seq: 7 } });
  answers["agent/list"] = () => ({ result: { runs: [], seq: 7 } });
  await renderApp();
  const archived = drawer("Archived")!;
  expect(archived.querySelector("summary")!.textContent).toContain("(60)");
  // Its rows render only while it's open.
  expect(drawerTitles("Archived")).toEqual([]);
  await click(archived.querySelector("summary"));
  // The drawer itself scrolls, and its summary sticks to the top of that scroll.
  expect(archived.className).toContain("overflow-y-auto");
  expect(archived.querySelector("summary")!.className).toContain("sticky");
  expect(drawerTitles("Archived")).toEqual(
    Array.from({ length: 25 }, (_, n) => `Archived ${String(59 - n).padStart(2, "0")}`),
  );
  const more = () =>
    [...archived.querySelectorAll("button")].find((b) => b.textContent?.startsWith("Show"));
  expect(more()!.textContent).toBe("Show 25 more");

  await click(more());
  expect(drawerTitles("Archived")).toHaveLength(50);
  expect(more()!.textContent).toBe("Show 10 more");
  await click(more());
  expect(drawerTitles("Archived")).toHaveLength(60);
  expect(more()).toBeUndefined();

  sidebarPrefs.set({ ...sidebarDefaults, pageArchived: false });
  act(() => unmount());
  await renderApp();
  // The drawer stays open, as this scope left it (PLX-789).
  expect(drawerTitles("Archived")).toHaveLength(60);
  expect(
    [...drawer("Archived")!.querySelectorAll("button")].some((b) =>
      b.textContent?.startsWith("Show"),
    ),
  ).toBe(false);
});

test("the footer's Pull requests button opens a page of every linked pull request, and a row opens its thread", async () => {
  const sample = {
    state: "open",
    draft: false,
    author: "ryan",
    updatedAt: "2026-09-29T12:00:00Z",
    baseBranch: "develop",
    headBranch: "feature/x",
    changedFiles: 1,
    additions: 1,
    deletions: 0,
    body: "",
    comments: [],
    reviewRequests: [],
    checks: [],
    repo: "ryan-stoffel/parallax",
  };
  answers["pr/view"] = (params) => ({
    result: {
      ...sample,
      number: Number(String(params["url"]).split("/").pop()),
      url: params["url"],
      title: `Title of ${String(params["url"]).split("/").pop()}`,
      labels: [],
    },
  });
  const withPrs = (id: string, title: string, pullRequests?: string[]) => ({
    ...coordinatorRun(id, title),
    project: parallax.id,
    status: "completed" as const,
    pullRequests,
  });
  answers["thread/list"] = () => ({
    result: {
      repos: [parallax],
      threads: [
        {
          id: "t-a",
          repo: parallax.id,
          title: "Fix the flaky test",
          createdAt: "2026-09-29T11:00:00Z",
        },
        { id: "t-b", repo: parallax.id, title: "Read the docs", createdAt: "2026-09-29T11:10:00Z" },
      ],
      seq: 7,
    },
  });
  answers["agent/list"] = () => ({
    result: {
      runs: [
        withPrs("t-a", "Fix the flaky test", [
          "https://github.com/ryan-stoffel/parallax/pull/7",
          "https://github.com/ryan-stoffel/parallax/pull/9",
        ]),
        withPrs("t-b", "Read the docs"),
      ],
      seq: 7,
    },
  });
  await renderApp();
  await click(document.querySelector('#sidebar [aria-label="Pull requests"]'));
  expect(crumbs()).toEqual(["Pull Requests"]);
  const rows = () => [...document.querySelectorAll('ul[aria-label="Pull requests"] > li')];
  // Each ends with its age, which follows the clock.
  expect(
    rows().map((r) => r.querySelector("button")!.textContent!.replace(/(now|\d+\w)$/, "")),
  ).toEqual([
    "#7Title of 7ryan-stoffel/parallaxFix the flaky test",
    "#9Title of 9ryan-stoffel/parallaxFix the flaky test",
  ]);
  await click(rows()[0]!.querySelector("button"));
  expect(crumbs().at(-1)).toBe("Fix the flaky test");
});

test("a thread's sidebar row shows its linked pull requests, colored by their majority state, with its number or +N for more, instead of its diff", async () => {
  const diff = { commit: "c1", files: 2, insertions: 12, deletions: 3 };
  const url = (n: number) => `https://github.com/ryan-stoffel/parallax/pull/${n}`;
  // 1 is open, 2 and 3 merged, 4 closed.
  const states: Record<number, string> = { 1: "open", 2: "merged", 3: "merged", 4: "closed" };
  answers["pr/view"] = (params) => {
    const number = Number(String(params["url"]).split("/").pop());
    return {
      result: {
        state: states[number],
        draft: false,
        author: "ryan",
        updatedAt: "2026-09-29T12:00:00Z",
        baseBranch: "develop",
        headBranch: "feature/x",
        changedFiles: 1,
        additions: 1,
        deletions: 0,
        body: "",
        comments: [],
        reviewRequests: [],
        checks: [],
        repo: "ryan-stoffel/parallax",
        number,
        url: params["url"],
        title: `Title of ${number}`,
        labels: [],
      },
    };
  };
  const run = (id: string, pullRequests?: string[]) => ({
    ...coordinatorRun(id, id),
    project: parallax.id,
    status: "completed" as const,
    diff,
    pullRequests,
  });
  capabilities = { pullRequests: {} };
  const ids = ["t-none", "t-open", "t-merged", "t-closed"];
  answers["thread/list"] = () => ({
    result: {
      repos: [parallax],
      threads: ids.map((id) => ({
        id,
        repo: parallax.id,
        title: id,
        createdAt: "2026-09-29T11:00:00Z",
      })),
      seq: 7,
    },
  });
  answers["agent/list"] = () => ({
    result: {
      runs: [
        run("t-none"),
        run("t-open", [url(1)]),
        run("t-merged", [url(1), url(2), url(3)]),
        run("t-closed", [url(4)]),
      ],
      seq: 7,
    },
  });
  await renderApp();
  const detail = (title: string) =>
    [...document.querySelectorAll('#sidebar [data-kind="thread"]')]
      .find((r) => r.querySelector("[data-title]")?.textContent === title)
      ?.querySelector("button > span:last-child");
  const chip = (title: string) => detail(title)?.querySelector("span[title*='linked']");
  expect(detail("t-none")?.textContent).not.toContain("+12");
  expect(chip("t-none")).toBeNull();
  expect(chip("t-open")?.className).toContain("text-added");
  expect(chip("t-open")?.textContent).toBe("#1");
  // Two merged of three outvote the open one.
  expect(chip("t-merged")?.className).toContain("text-project-violet");
  expect(chip("t-merged")?.textContent).toBe("+2");
  expect(chip("t-closed")?.className).toContain("text-danger");

  // Clicking a lone PR's number opens the thread with that PR in its side panel, not GitHub.
  const open = vi.fn();
  window.open = open;
  await click(chip("t-open")?.querySelector("span.hover\\:underline"));
  expect(open).not.toHaveBeenCalled();
  expect(chip("t-open")?.closest("button")?.getAttribute("aria-current")).toBe("page");
  const tab = document.querySelector(
    '#side-panel [aria-label="Open views"] button[aria-current="true"]',
  );
  expect(tab?.textContent).toBe("#1");
});

test("with no Projects there are no favorites, and the toolbar's one button opens the add palette", async () => {
  answers["project/list"] = () => ({ result: { projects: [], seq: 7 } });
  await renderApp();
  expect(document.querySelector('#sidebar [aria-label="Favorites"]')).toBeNull();
  expect(newProjectButtons()).toHaveLength(0);
  await openPalette();
  expect(dialog().open).toBe(true);
  expect(paletteOptions()).toHaveLength(5);
  await act(async () => dialog().close());

  await act(async () =>
    deliver({
      type: "event",
      event: {
        subscription: "s-1",
        seq: 8,
        time: "",
        event: { kind: "project.created", project: project("ember", "2026-09-29T12:00:00Z") },
      },
    }),
  );
  expect(projectRows()).toEqual(["ember"]);
  expect(newProjectButtons()).toHaveLength(0);
});

test("search, the repo filter, and Mod+number cover the favorites and Today", async () => {
  withThread();
  await renderApp();
  const search = document.querySelector<HTMLInputElement>(
    '#sidebar input[aria-label="Search threads and Projects"]',
  )!;
  typeInto(search, "fla");
  expect(sidebarTitles()).toEqual(["Fix the flaky test"]);
  expect(projectRows()).toEqual([]);
  typeInto(search, "emb");
  expect(sidebarTitles()).toEqual([]);
  expect(projectRows()).toEqual(["ember"]);
  typeInto(search, "");

  const repoChoice = (name: string) =>
    [
      ...document.querySelectorAll<HTMLElement>(
        '#sidebar [role="menu"][aria-label="Repos"] [role="menuitemradio"]',
      ),
    ].find((b) => b.textContent === name);
  // Neither Project's folder is a listed repository.
  await click(repoChoice("No repo"));
  expect(projectRows()).toEqual(["ember", "photon"]);
  expect(sidebarTitles()).toEqual([]);
  await click(repoChoice("parallax"));
  expect(projectRows()).toEqual([]);
  expect(sidebarTitles()).toEqual(["Fix the flaky test"]);
  await click(repoChoice("All threads"));

  // The favorites' Projects first, then Today's threads.
  await keyDown({ key: "Meta", metaKey: true });
  expect([rowButton("ember").textContent, rowButton("photon").textContent]).toEqual(["⌘1", "⌘2"]);
  expect(statusOf("Fix the flaky test")).toBe("⌘3");
  await keyDown({ key: "2", code: "Digit2", metaKey: true });
  await settle();
  expect(crumbs()).toEqual(["This Mac", "photon"]);
  await keyDown({ key: "3", code: "Digit3", metaKey: true });
  await settle();
  expect(crumbs()).toEqual(["This Mac", "parallax", "Fix the flaky test"]);

  // Folded away, the Projects give up their numbers to Today's threads (PLX-922).
  await click(document.querySelector('[aria-label="Fold favorites and pins"]'));
  await keyDown({ key: "Meta", metaKey: true });
  expect(statusOf("Fix the flaky test")).toBe("⌘1");
  await click(rowButton("photon"));
  await keyDown({ key: "1", code: "Digit1", metaKey: true });
  await settle();
  expect(crumbs()).toEqual(["This Mac", "parallax", "Fix the flaky test"]);
});

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

test("Autonomy… opens on the Project's level, one line on each, and Save sends the new one", async () => {
  capabilities = { projectAutonomy: {}, projectPermission: {} };
  answers["project/list"] = () => ({
    result: {
      projects: [
        { ...project("ember", "2026-09-26T12:00:00Z"), autonomy: "full", permission: "bypass" },
      ],
      seq: 7,
    },
  });
  answers["project/update"] = (p) => ({
    result: { project: { ...project("ember", "2026-09-26T12:00:00Z"), autonomy: p["autonomy"] } },
  });
  await renderApp();
  // A Project in Bypass offers no mode.
  expect(menuItem("ember", "Full access…")).toBeUndefined();
  await click(menuItem("ember", "Autonomy…"));
  const settings = document.querySelector<HTMLDialogElement>(
    'dialog[aria-label="ember autonomy"]',
  )!;
  expect(settings.open).toBe(true);
  const levels = [...settings.querySelectorAll<HTMLInputElement>('input[type="radio"]')];
  expect(levels.map((r) => [r.value, r.checked])).toEqual([
    ["ask", false],
    ["routine", false],
    ["full", true],
  ]);
  expect(settings.textContent).toContain("Every question waits on you.");

  await click(levels[0]);
  await click([...settings.querySelectorAll("button")].find((b) => b.textContent === "Save"));
  expect(settings.open).toBe(false);
  expect(calls("project/update")).toEqual([{ project: "p-ember", autonomy: "ask" }]);
});

const inboxItem = (id: string, kind: InboxKind, text: string, more: Partial<InboxItem> = {}) =>
  ({ id, kind, run: login.id, text, createdAt: "2026-09-29T11:00:00Z", ...more }) as InboxItem;
const escalated: Question = {
  id: "q-1",
  run: login.id,
  question: 'Which "theme" key?',
  assumption: "dark",
  status: "escalated",
  createdAt: "2026-09-29T10:00:00Z",
};
// Ember's children, one per group of its Project tab. Login asks a question, and release failed:
// both wait on the user. Docs works. Tests finished unread, and old finished and was read.
const release = subagent("01a0d391-0000-7000-8000-000000000004", "Cut the release", {
  status: "failed",
});
const tests = subagent("01a0d391-0000-7000-8000-000000000005", "Add the tests", {
  status: "completed",
});
const old = subagent("01a0d391-0000-7000-8000-000000000006", "Bump the version", {
  status: "completed",
});
const inboxItems = [
  inboxItem("i-login-done", "done", "Fix the login bug: done, 2 files +12 -3"),
  // plxd quotes the child's words as JSON.
  inboxItem(
    "i-needs",
    "needsYou",
    'Fix the login bug: asks "Which \\"theme\\" key?", went on assuming "dark"',
  ),
  inboxItem("i-failed", "failed", "Cut the release: failed", { run: release.id }),
  inboxItem("i-tests", "done", "Add the tests: done, 1 file +4 -0", { run: tests.id }),
  inboxItem("i-old", "done", "Bump the version: done", {
    run: old.id,
    seenAt: "2026-09-29T11:30:00Z",
  }),
];
/** Serves ember's runs, inbox, and questions, with `inbox/seen` marking what it's sent. */
const serveInbox = () => {
  const runs = [
    coordinatorRun(coordinatorId, "Plan the release"),
    login,
    docs,
    release,
    tests,
    old,
  ];
  answers["project/list"] = () => ({
    result: {
      projects: [{ ...project("ember", "2026-09-26T12:00:00Z"), coordinator: coordinatorId }],
      seq: 7,
    },
  });
  answers["agent/list"] = (p) => ({
    result: { runs: [undefined, "p-ember"].includes(p["project"] as string) ? runs : [], seq: 7 },
  });
  answers["agent/events"] = serveEvents(() => runs);
  answers["inbox/list"] = () => ({ result: { items: inboxItems, seq: 8 } });
  answers["question/list"] = () => ({ result: { questions: [escalated] } });
  answers["inbox/seen"] = (p) => ({
    result: {
      items: inboxItems
        .filter((i) => (p["items"] as string[]).includes(i.id))
        .map((i) => ({ ...i, seenAt: "2026-09-29T12:00:00Z" })),
    },
  });
};
const projectTab = () =>
  [...document.querySelectorAll("#side-panel li button")].find((b) =>
    b.textContent?.startsWith("Project"),
  );
const home = () => document.querySelector<HTMLElement>("#side-panel")!;
/** The titles of the children under `root`, in order. */
const titlesIn = (root: ParentNode | null) =>
  [...(root?.querySelectorAll("li > button [data-title]") ?? [])].map((t) => t.textContent);
/** The children in the Project tab's Running, and in its log of finished ones. */
const runningTitles = () => titlesIn(home().querySelector('section[aria-label="Running"]'));
const logTitles = () => titlesIn(home()).filter((t) => !runningTitles().includes(t));
const childButton = (title: string) =>
  [...home().querySelectorAll("li > button")].find(
    (b) => b.querySelector("[data-title]")?.textContent === title,
  );
/** Whether a finished child's title is dimmed, as it is once what it reported is read. */
const dim = (title: string) =>
  childButton(title)!.querySelector("[data-title]")!.classList.contains("text-muted-foreground");

test("a Project opens its side panel on the Project tab: who works and waits in Running, then the finished ones in its log, with the header's count on the tab", async () => {
  capabilities = { coordinator: {}, inbox: {} };
  serveInbox();
  const subscribe = vi.spyOn(window.parallax, "subscribe");
  await renderApp();
  await openEmber();
  // The inbox follows its events after `inbox/list`'s seq, without the runs' output.
  expect(subscribe).toHaveBeenCalledWith(
    "local",
    { after: 8, project: "p-ember", shell: true, logId: "log-1" },
    expect.any(Function),
  );
  expect(projectTab()!.getAttribute("aria-current")).toBe("true");
  expect(projectTab()!.textContent).toBe("Project2");
  expect(home().querySelector("h2")!.textContent).toBe("ember");
  expect(home().querySelector("header p")!.textContent).toBe("4 open threads · 2 done this week");
  expect(
    [...home().querySelectorAll('[aria-label="Open threads"] li')].map((c) => c.textContent),
  ).toEqual(["1working", "2need you", "1to review"]);
  expect(runningTitles()).toEqual(["Fix the login bug", "Write the docs", "Cut the release"]);
  // The log has each finished child once, bright until what it reported is read.
  expect(logTitles()).toEqual(["Add the tests", "Bump the version"]);
  expect(dim("Add the tests")).toBe(false);
  expect(dim("Bump the version")).toBe(true);
  // A row says what its child last reported, without its title. Without `questions`, a question
  // is only that line.
  expect(childButton("Fix the login bug")!.textContent).toContain(
    'asks "Which \\"theme\\" key?", went on assuming "dark"',
  );
  expect(home().querySelector("input")).toBeNull();
  // The words inbox and mail aren't shown.
  expect(home().textContent).not.toMatch(/inbox|mail/i);

  // Opening a child opens its chat and marks what it reported read, but not its question.
  await click(childButton("Add the tests"));
  expect(crumbs()).toEqual(["This Mac", "ember", "Add the tests"]);
  expect(calls("inbox/seen")).toEqual([{ project: "p-ember", items: ["i-tests"] }]);
  expect(dim("Add the tests")).toBe(true);
  await click(childButton("Fix the login bug"));
  expect(calls("inbox/seen")).toEqual([
    { project: "p-ember", items: ["i-tests"] },
    { project: "p-ember", items: ["i-login-done"] },
  ]);
  expect(runningTitles()).toEqual(["Fix the login bug", "Write the docs", "Cut the release"]);
});

test("the Project tab leads with the coordinator's board, and its book opens All files, a file in place, and back", async () => {
  capabilities = { coordinator: {}, inbox: {} };
  serveInbox();
  const file = (path: string) => ({ path, size: 10, modifiedAt: "2026-09-29T11:00:00Z" });
  answers["context/list"] = () => ({ result: { files: [file("notes.md"), file("plan.md")] } });
  answers["context/read"] = (p) => ({
    result: {
      file: file(p["path"] as string),
      content: p["path"] === "notes.md" ? "## Now\n- [ ] **Ship it**: today" : "# The plan",
    },
  });
  await renderApp();
  await openEmber();
  const board = home().querySelector('[aria-label="Where it stands"] [aria-label="notes.md"]')!;
  expect(board.querySelector("strong")!.textContent).toBe("Ship it");
  expect(board.querySelector("h4")!.textContent).toBe("Now");

  await click(home().querySelector('button[aria-label="All files"]'));
  const listed = () =>
    [...home().querySelectorAll('ul[aria-label="All files"] button')].map(
      (b) => b.querySelector(".font-mono")!.textContent,
    );
  expect(listed()).toEqual(["notes.md", "plan.md"]);
  await click(
    [...home().querySelectorAll('ul[aria-label="All files"] button')].find((b) =>
      b.textContent?.startsWith("plan.md"),
    ),
  );
  expect(home().querySelector('article[aria-label="plan.md"]')!.textContent).toContain("The plan");
  // Back from the file goes to All files, and back from there to the tab's head and board.
  await click([...home().querySelectorAll("button")].find((b) => b.textContent === "plan.md"));
  expect(listed()).toEqual(["notes.md", "plan.md"]);
  await click([...home().querySelectorAll("button")].find((b) => b.textContent === "ember"));
  expect(home().querySelector("h2")!.textContent).toBe("ember");
});

test("the side panel's one full screen button fills the window from any tab, and Knowledge sits beside the Project tab", async () => {
  capabilities = { coordinator: {}, inbox: {} };
  serveInbox();
  await renderApp();
  await openEmber();
  const fullScreen = () =>
    document.querySelectorAll('#side-panel button[aria-label="Full screen"]');
  const tabNames = () =>
    [...document.querySelectorAll("#side-panel li button[id^='side-panel-tab-']")].map(
      (b) => b.textContent,
    );
  // The Project's own tabs are pinned, with no close buttons.
  expect(tabNames()).toEqual(["Project2", "Knowledge"]);
  expect(document.querySelector('#side-panel button[aria-label="Close Knowledge"]')).toBeNull();
  for (const tab of ["Knowledge", "Changes", "Project"]) {
    if (tab === "Changes") await openView(tab);
    else
      await click(
        [...document.querySelectorAll("#side-panel li button")].find((b) =>
          b.textContent?.startsWith(tab),
        ),
      );
    expect(fullScreen()).toHaveLength(1);
    await click(fullScreen()[0]);
    expect(document.querySelector("main")!.hidden).toBe(true);
    await click(document.querySelector('#side-panel button[aria-label="Exit full screen"]'));
    expect(document.querySelector("main")!.hidden).toBe(false);
  }
});

test("a question on the Project tab offers the child's pick as choice 1 and a free answer as choice 2", async () => {
  capabilities = { coordinator: {}, inbox: {}, questions: {} };
  serveInbox();
  let fail = true;
  answers["question/answer"] = (p) =>
    fail
      ? { error: { code: -32000, message: "the question was already answered" } }
      : { result: { question: { ...escalated, status: "answered", answer: p["text"] } } };
  await renderApp();
  await openEmber();
  const row = () => childButton("Fix the login bug")!.parentElement!;
  expect(row().textContent).toContain('Which "theme" key?');
  const pick = [...row().querySelectorAll("button")].find((b) =>
    b.textContent?.includes("Its pick so far"),
  )!;
  expect(pick.textContent).toBe("1darkIts pick so far");
  const free = [...row().querySelectorAll("input")].find(
    (i) => i.getAttribute("aria-label") === 'Answer: Which "theme" key?',
  )!;
  expect(free.placeholder).toBe("Something else");

  // A failed answer says why and keeps the question.
  typeInto(free, "theme.dark");
  await act(async () => free.form!.requestSubmit());
  await settle();
  expect(notice()).toEqual(["Couldn't send your answer", "the question was already answered"]);
  fail = false;
  await click(pick);
  expect(calls("question/answer")).toEqual([
    { question: "q-1", text: "theme.dark" },
    { question: "q-1", text: "dark" },
  ]);
  expect(calls("inbox/seen")).toEqual([{ project: "p-ember", items: ["i-needs"] }]);
  expect(runningTitles()).toEqual(["Write the docs", "Cut the release"]);
  expect(projectTab()!.textContent).toBe("Project1");
});

test("a new Needs you item notifies with Open Project, from the OS while the window is in the background, and joins its Project tab", async () => {
  capabilities = { inbox: {} };
  // One scope, as the fake sends every event to every subscription.
  answers["thread/list"] = () => ({ result: { repos: [], threads: [], seq: 7 } });
  answers["project/list"] = () => ({
    result: { projects: [project("ember", "2026-09-26T12:00:00Z")], seq: 7 },
  });
  answers["agent/list"] = (p) => ({
    result: {
      runs: [undefined, "p-ember"].includes(p["project"] as string) ? [login, docs] : [],
      seq: 7,
    },
  });
  answers["agent/events"] = serveEvents(() => [login, docs]);
  answers["inbox/list"] = () => ({ result: { items: [], seq: 7 } });
  const notes: { title: string; body: string; onclick: (() => void) | null }[] = [];
  vi.stubGlobal(
    "Notification",
    class {
      onclick = null;
      constructor(title: string, { body }: { body: string }) {
        notes.push(Object.assign(this, { title, body }));
      }
    },
  );
  onTestFinished(() => void vi.unstubAllGlobals());
  const added = (seq: number, item: InboxItem) =>
    act(async () =>
      deliver({
        type: "event",
        event: {
          subscription: "s-1",
          seq,
          time: "",
          project: "p-ember",
          event: { kind: "inbox.added", item },
        },
      }),
    );
  const toast = () => document.querySelector('[aria-label="Notifications"] > div');
  await renderApp();
  await added(8, inboxItem("i-done", "done", "Fix the login bug: done"));
  expect(toast()).toBeNull();

  // In the focused window, a notification in the app, whose Open Project opens it.
  await added(9, inboxItem("i-needs", "needsYou", "Fix the login bug: wake-ups paused"));
  expect(notes).toEqual([]);
  expect(toast()!.textContent).toBe(
    "emberNeeds you: Fix the login bug: wake-ups pausedOpen Project",
  );
  const open = [...toast()!.querySelectorAll("button")].find(
    (b) => b.textContent === "Open Project",
  );
  await act(async () => open!.click());
  await settle();
  expect(crumbs()).toEqual(["This Mac", "ember"]);
  expect(toast()).toBeNull();

  // In the background, the OS's too, which opens it when clicked.
  vi.spyOn(document, "hasFocus").mockReturnValue(false);
  onTestFinished(() => void vi.restoreAllMocks());
  await added(
    10,
    inboxItem("i-asks", "needsYou", "Write the docs: asks which tone", { run: docs.id }),
  );
  expect(notes.map((n) => [n.title, n.body])).toEqual([
    ["ember", "Needs you: Write the docs: asks which tone"],
  ]);
  await act(async () => notes[0]!.onclick?.());
  await settle();
  expect(crumbs()).toEqual(["This Mac", "ember"]);
  expect(runningTitles()).toEqual(["Write the docs"]);
  expect(childButton("Write the docs")!.textContent).toContain("asks which tone");
  act(() => toast()!.querySelector<HTMLButtonElement>('[aria-label="Close"]')!.click());
});

test("on a host without pins or titles, P and R on a row do nothing (PLX-789)", async () => {
  withThread();
  await renderApp();
  const row = document.querySelector<HTMLElement>(`#sidebar [data-row$="/${flaky.id}"]`)!;
  act(() => row.focus());
  press("p");
  press("r");
  await settle();
  expect(calls("thread/update")).toEqual([]);
  expect(document.querySelector('input[aria-label="Thread name"]')).toBeNull();
});
