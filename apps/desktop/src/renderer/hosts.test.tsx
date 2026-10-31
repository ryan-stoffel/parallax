// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vite-plus/test";

import type { ConnectionState, SshHost, ParallaxBridge } from "../preload/bridge";
import { App } from "./App";
import { fakeWatch } from "./fakeWatch";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
// happy-dom has no popover API; the notification stack opens as one.
HTMLElement.prototype.showPopover = () => {};

// xterm.js needs a real canvas, so the terminal is a stub that records what it runs.
const signInTarget = vi.fn();
vi.mock("./SignInTerminal", () => ({
  SignInTerminal: ({ target, name }: { target: unknown; name: string }) => {
    signInTarget(target);
    return <p>Signing in to {name}…</p>;
  },
}));

const mini: SshHost = { id: "h-mini", name: "Mac mini", destination: "mini" };
const [t0, t1, t2] = ["2026-10-01T09:00:00Z", "2026-10-01T10:00:00Z", "2026-10-01T11:00:00Z"];
const connected: ConnectionState = {
  status: "connected",
  plxd: "0.1.0",
  protocol: 1,
  capabilities: {},
};
const untrusted: ConnectionState = {
  status: "failed",
  retrying: false,
  error: {
    reason: "sshSetup",
    message: "mini's host key isn't trusted yet.",
    exitCode: 255,
    stderr: "Host key verification failed.",
  },
};

let states: Record<string, ConnectionState>;
const listsNothing = async (_host: string, method: string): Promise<unknown> =>
  method === "thread/list" || method === "agent/list" || method === "orchestrator/list"
    ? { result: { repos: [], threads: [], runs: [], orchestrators: [], seq: 1 }, logId: "log" }
    : { error: { code: -32601, message: `${method} isn't faked` } };
const request = vi.fn(listsNothing);

beforeEach(() => {
  request.mockReset();
  request.mockImplementation(listsNothing);
  states = { local: connected, [mini.id]: untrusted };
  window.parallax = {
    onProfile: () => () => {},
    platform: "darwin",
    setThemeSource: vi.fn(),
    connectionState: async (hostId) => states[hostId]!,
    onConnectionState: () => () => {},
    onHostUpdate: () => () => {},
    watch: fakeWatch(() => window.parallax),
    subscribe: () => () => {},
    request: request as unknown as ParallaxBridge["request"],
    hosts: async () => [mini],
    onHosts: () => () => {},
    onConnect: () => () => {},
    onDevices: () => () => {},
    onAccessRequests: () => () => {},
    discoverAccount: async () => [],
    onLocalName: (listener: (name: string) => void) => {
      listener("This Mac");
      return () => {};
    },
    setZoom: () => {},
    version: async () => "1.0.0",
    openTargets: async () => [],
    terminalApps: async () => [],
    command: async () => ({ state: "unavailable", path: "", onPath: true }),
    terminalApp: async () => null,
    openTargetIcons: async () => ({}),
    sshSuggestions: async () => [],
  } as Partial<ParallaxBridge> as ParallaxBridge;
});

let unmount = () => {};
afterEach(() => {
  // Notifications outlive a render, so close this test's.
  for (const close of document.querySelectorAll<HTMLButtonElement>(
    '[aria-label="Notifications"] button[aria-label="Close"]',
  ))
    act(() => close.click());
  act(() => unmount());
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
const click = async (element: HTMLElement) => {
  await act(async () => element.click());
  await settle();
};
const rows = () => [
  ...document.querySelectorAll<HTMLButtonElement>('#sidebar li[data-kind="thread"] > button'),
];
const title = (row: HTMLElement) => row.querySelector("[data-title]")!.textContent;

test("every connected host's threads are one list, newest prompt first, each opening on its host", async () => {
  states[mini.id] = connected;
  const repo = (id: string, name: string) => ({ id, name, path: `/src/${name}`, createdAt: t0 });
  const thread = (id: string, repoId: string, lastPromptAt: string) => ({
    id,
    repo: repoId,
    createdAt: t0,
    lastPromptAt,
  });
  const lists: Record<string, unknown> = {
    local: { repos: [repo("r-1", "parallax")], threads: [thread("t-1", "r-1", t1)], seq: 1 },
    [mini.id]: { repos: [repo("r-2", "api")], threads: [thread("t-2", "r-2", t2)], seq: 1 },
  };
  const runs: Record<string, unknown[]> = {
    local: [{ id: "t-1", project: "r-1", prompt: "Fix the flaky test", status: "completed" }],
    [mini.id]: [{ id: "t-2", project: "r-2", prompt: "Add the endpoint", status: "completed" }],
  };
  request.mockImplementation(async (host: string, method: string) =>
    method === "thread/list"
      ? { result: lists[host], logId: "log" }
      : method === "agent/list"
        ? { result: { runs: runs[host], seq: 1 }, logId: "log" }
        : method === "orchestrator/list"
          ? { result: { orchestrators: [], seq: 1 }, logId: "log" }
          : { error: { code: -32601, message: `${method} isn't faked` } },
  );
  await renderApp();
  expect(rows().map(title)).toEqual(["Add the endpoint", "Fix the flaky test"]);

  await click(rows()[0]!);
  const crumbs = [...document.querySelectorAll('[aria-label="Breadcrumb"] li')];
  expect(crumbs.map((li) => li.textContent)).toEqual(["Mac mini", "api", "Add the endpoint"]);
  expect(rows()[0]!.getAttribute("aria-current")).toBe("page");
});

const openConnections = async () => {
  await renderApp();
  const mac = window.parallax.platform === "darwin";
  await act(async () => {
    window.dispatchEvent(
      new KeyboardEvent("keydown", { key: ",", code: "Comma", metaKey: mac, ctrlKey: !mac }),
    );
  });
  await click(
    [...document.querySelectorAll("button")].find((b) => b.textContent === "Connections")!,
  );
};
const signIn = () =>
  [...document.querySelectorAll("button")].find((b) => b.textContent === "Sign in");

test("Sign in isn't offered for a changed host key", async () => {
  states[mini.id] = {
    status: "failed",
    retrying: false,
    error: {
      reason: "sshSetup",
      message: "mini's host key has changed.",
      exitCode: 255,
      stderr:
        "@@@ WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED! @@@\nHost key verification failed.",
    },
  };
  await openConnections();
  expect(signIn()).toBeUndefined();
});
