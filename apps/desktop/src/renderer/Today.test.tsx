// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vite-plus/test";

import type { RpcResponse, ParallaxBridge } from "../preload/bridge";
import type { AgentRun, Capabilities, Repo, Thread } from "../protocol/generated/protocol";
import { App } from "./App";
import { fakeWatch } from "./fakeWatch";
import { autoClear } from "./pins";
import { flushToasts } from "./undo";

// Today's Clear, auto-archive, and keys (0075).

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
HTMLElement.prototype.showPopover = () => {};
HTMLElement.prototype.hidePopover = () => {};

const parallax: Repo = {
  id: "r-parallax",
  name: "parallax",
  path: "/src/parallax",
  createdAt: "2026-10-01T09:00:00Z",
};
const ago = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();
// Prompted `minutes` ago and seen since.
const thread = (id: string, minutes: number, extra: Partial<Thread> = {}): Thread => ({
  id,
  repo: parallax.id,
  title: id,
  createdAt: ago(minutes),
  seenAt: ago(0),
  ...extra,
});
const run = (id: string, status: string, updated: number) =>
  ({
    id,
    prompt: id,
    status,
    backend: "claude",
    model: "claude-sonnet-5",
    createdAt: ago(updated),
    updatedAt: ago(updated),
  }) as AgentRun;

let threads: Thread[];
let runs: AgentRun[];
type Answer = (params: Record<string, unknown>) => RpcResponse<unknown>;
let answers: Record<string, Answer>;
const request = vi.fn(async (_host: string, method: string, params: Record<string, unknown>) => {
  const answer = answers[method];
  return answer
    ? { logId: "log-1", ...answer(params) }
    : { error: { code: -32601, message: `${method} isn't faked` } };
});
const archiving =
  (refuse?: string): Answer =>
  (p) =>
    p["runId"] === refuse
      ? { error: { code: -32000, message: `${refuse} is busy` } }
      : {
          result: {
            thread: { ...threads.find((t) => t.id === p["runId"]), archived: p["archived"] },
          },
        };

beforeEach(() => {
  request.mockClear();
  localStorage.clear();
  autoClear.set(null);
  const capabilities: Capabilities = {};
  answers = {
    "thread/list": () => ({ result: { repos: [parallax], threads, seq: 7 } }),
    "agent/list": () => ({ result: { runs, seq: 7 } }),
    "project/list": () => ({ result: { projects: [], seq: 7 } }),
    "thread/archive": archiving(),
  };
  window.parallax = {
    onProfile: () => () => {},
    platform: "darwin",
    setThemeSource: vi.fn(),
    connectionState: async () => ({
      status: "connected",
      plxd: "0.1.0",
      protocol: 1,
      capabilities,
    }),
    onConnectionState: () => () => {},
    onHostUpdate: () => () => {},
    watch: fakeWatch(() => window.parallax),
    subscribe: () => () => {},
    request,
    hosts: async () => [],
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
  act(() => unmount());
  flushToasts();
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
const archived = () =>
  request.mock.calls
    .filter(([, m, p]) => m === "thread/archive" && p["archived"])
    .map(([, , p]) => p["runId"]);
const waitForArchives = (n: number) =>
  act(() => vi.waitFor(() => expect(archived()).toHaveLength(n), { timeout: 3000 }));
const row = (title: string) =>
  [...document.querySelectorAll<HTMLElement>('#sidebar li[data-kind="thread"] > button')].find(
    (b) => b.querySelector("[data-title]")?.textContent === title,
  );
const button = (text: string) =>
  [...document.querySelectorAll<HTMLElement>("button")].find((b) => b.textContent === text);

test("Clear archives the finished threads already seen, not one waiting out a usage limit", async () => {
  threads = [thread("older", 30), thread("newer", 20), thread("limited", 10), thread("unread", 5)];
  runs = [
    run("older", "completed", 30),
    run("newer", "completed", 20),
    run("limited", "waiting", 10),
    run("unread", "completed", 5),
  ];
  threads[3]!.seenAt = undefined;
  await renderApp();
  await act(async () => button("Clear")!.click());
  await waitForArchives(2);
  await settle();
  expect(archived()).toEqual(["newer", "older"]);
  expect(document.body.textContent).toContain("Cleared 2 threads");
});

test("a thread Clear can't archive stays, and the sidebar says why", async () => {
  threads = [thread("stuck", 30), thread("done", 20)];
  runs = [run("stuck", "completed", 30), run("done", "completed", 20)];
  answers["thread/archive"] = archiving("stuck");
  await renderApp();
  await act(async () => button("Clear")!.click());
  await waitForArchives(2);
  await settle();
  expect(document.querySelector("#sidebar [role=alert]")?.textContent).toBe("stuck is busy");
  expect(row("stuck")).toBeDefined();
  expect(document.body.textContent).toContain("Cleared 1 thread");
});

test("auto-archive waits for quiet since the last prompt or run, skips usage limits, and an Undo sticks", async () => {
  autoClear.set(1);
  threads = [thread("quiet", 180), thread("ran-late", 180), thread("on-limit", 180)];
  runs = [
    run("quiet", "completed", 180),
    // Prompted hours ago, but it ran until minutes ago.
    run("ran-late", "completed", 10),
    run("on-limit", "waiting", 180),
  ];
  await renderApp();
  await waitForArchives(1);
  expect(archived()).toEqual(["quiet"]);
  expect(document.body.textContent).toContain("Archived 1 thread quiet for over 1 hours");

  await act(async () => button("Undo")!.click());
  // Back from Settings, say, the list mounts again; what was undone stays.
  act(() => unmount());
  await renderApp();
  expect(archived()).toEqual(["quiet"]);
});

test("E on Today's first row moves focus to the next row shown, past the folded pins' summary", async () => {
  threads = [thread("pinned", 40, { pinned: true }), thread("second", 30), thread("first", 20)];
  runs = [
    run("pinned", "completed", 40),
    run("second", "completed", 30),
    run("first", "completed", 20),
  ];
  await renderApp();
  const first = row("first")!;
  await act(async () => {
    first.focus();
    first.dispatchEvent(new KeyboardEvent("keydown", { key: "e", bubbles: true }));
  });
  await waitForArchives(1);
  await settle();
  expect(document.activeElement).toBe(row("second"));
});

test("moving on before plxd answers leaves focus where the user went", async () => {
  threads = [thread("third", 40), thread("second", 30), thread("first", 20)];
  runs = [
    run("third", "completed", 40),
    run("second", "completed", 30),
    run("first", "completed", 20),
  ];
  await renderApp();
  const first = row("first")!;
  await act(async () => {
    first.focus();
    first.dispatchEvent(new KeyboardEvent("keydown", { key: "e", bubbles: true }));
    // Down while the row slides away, before plxd has archived it.
    first.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
  });
  await waitForArchives(1);
  await settle();
  expect(document.activeElement).toBe(row("second"));

  // A search that hides that row later doesn't pull focus back into the list.
  const search = document.querySelector<HTMLInputElement>(
    '#sidebar input[aria-label="Search threads and Projects"]',
  )!;
  await act(async () => {
    search.focus();
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(search, "thi");
    search.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await settle();
  expect(row("third")).toBeDefined();
  expect(document.activeElement).toBe(search);
});
