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
let capabilities: Capabilities;
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
  capabilities = {};
  answers = {
    "thread/list": () => ({ result: { repos: [parallax], threads, seq: 7 } }),
    "agent/list": () => ({ result: { runs, seq: 7 } }),
    "project/list": () => ({ result: { projects: [], seq: 7 } }),
    "thread/archive": archiving(),
    "thread/update": (p) => ({
      result: { thread: { ...threads.find((t) => t.id === p["runId"]), ...p } },
    }),
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
  // The app keeps its notifications between tests, so close this test's.
  for (const close of document.querySelectorAll<HTMLButtonElement>(
    '[aria-label="Notifications"] [aria-label="Close"]',
  ))
    act(() => close.click());
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

test("Clear leaves a thread one it started is still working for, or waiting out a usage limit", async () => {
  threads = [
    thread("lead", 30),
    thread("helper", 20, { parent: "lead" }),
    thread("paused", 25),
    thread("limited", 15, { parent: "paused" }),
    thread("plain", 10),
  ];
  runs = [
    run("lead", "completed", 30),
    run("helper", "running", 5),
    run("paused", "completed", 25),
    run("limited", "waiting", 15),
    run("plain", "completed", 10),
  ];
  await renderApp();
  await act(async () => button("Clear")!.click());
  await waitForArchives(1);
  await settle();
  expect(archived()).toEqual(["plain"]);
});
