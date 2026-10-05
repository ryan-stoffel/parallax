// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vite-plus/test";

import type { ConnectionState, HostInput, SshHost, ParallaxBridge } from "../preload/bridge";
import { App } from "./App";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

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
  error: { reason: "sshSetup", message: "mini's host key isn't trusted yet." },
};

let states: Record<string, ConnectionState>;
const listsNothing = async (_host: string, method: string): Promise<unknown> =>
  method === "thread/list" || method === "agent/list"
    ? { result: { repos: [], threads: [], runs: [], seq: 1 }, logId: "log" }
    : { error: { code: -32601, message: `${method} isn't faked` } };
const request = vi.fn(listsNothing);
const saveHost = vi.fn<(host: HostInput, id?: string) => Promise<string | undefined>>();

beforeEach(() => {
  request.mockReset();
  request.mockImplementation(listsNothing);
  saveHost.mockReset();
  states = { local: connected, [mini.id]: untrusted };
  window.parallax = {
    onProfile: () => () => {},
    platform: "darwin",
    setThemeSource: vi.fn(),
    connectionState: async (hostId) => states[hostId]!,
    onConnectionState: () => () => {},
    subscribe: () => () => {},
    request: request as unknown as ParallaxBridge["request"],
    hosts: async () => [mini],
    onHosts: () => () => {},
    onLocalName: (listener: (name: string) => void) => {
      listener("This Mac");
      return () => {};
    },
    setZoom: () => {},
    version: async () => "1.0.0",
    openTargets: async () => [],
    openTargetIcons: async () => ({}),
    saveHost,
  } as Partial<ParallaxBridge> as ParallaxBridge;
});

let unmount = () => {};
afterEach(() => act(() => unmount()));

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
        : method === "project/list"
          ? { result: { projects: [], seq: 1 }, logId: "log" }
          : { error: { code: -32601, message: `${method} isn't faked` } },
  );
  await renderApp();
  expect(rows().map(title)).toEqual(["Add the endpoint", "Fix the flaky test"]);
  // No Hosts section: each host is a source of rows, not a heading.
  expect(document.querySelector("#hosts-heading")).toBeNull();

  await click(rows()[0]!);
  const crumbs = [...document.querySelectorAll('[aria-label="Breadcrumb"] li')];
  expect(crumbs.map((li) => li.textContent)).toEqual(["Mac mini", "api", "Add the endpoint"]);
  expect(rows()[0]!.getAttribute("aria-current")).toBe("page");
});

test("a host that can't connect adds nothing to the list, and Connections shows why", async () => {
  await renderApp();
  expect(rows()).toEqual([]);
  expect(request.mock.calls.some(([host]) => host === mini.id)).toBe(false);
  await act(async () => {
    window.dispatchEvent(new KeyboardEvent("keydown", { key: ",", code: "Comma", metaKey: true }));
  });
  await click(
    [...document.querySelectorAll("button")].find((b) => b.textContent === "Connections")!,
  );
  expect(document.querySelector("main")!.textContent).toContain("Mac mini");
});

test("Connections' Add host opens the form, which shows the main process's error", async () => {
  await renderApp();
  await act(async () => {
    window.dispatchEvent(new KeyboardEvent("keydown", { key: ",", code: "Comma", metaKey: true }));
  });
  await click(
    [...document.querySelectorAll("button")].find((b) => b.textContent === "Connections")!,
  );
  await click(
    [...document.querySelectorAll<HTMLButtonElement>("button")].find(
      (b) => b.textContent === "Add host",
    )!,
  );
  expect(document.querySelector("h1")!.textContent).toBe("Connections");

  const form = document.querySelector<HTMLFormElement>('form[aria-label="Add host"]')!;
  form.querySelector<HTMLInputElement>('[name="name"]')!.value = "Studio";
  form.querySelector<HTMLInputElement>('[name="destination"]')!.value = "-oProxyCommand=x";
  saveHost.mockResolvedValue("An ssh destination can't start with “-” or contain spaces.");
  await act(async () => form.requestSubmit());
  await settle();

  expect(saveHost).toHaveBeenCalledWith(
    { name: "Studio", destination: "-oProxyCommand=x" },
    undefined,
  );
  expect(form.querySelector('[role="alert"]')!.textContent).toContain("can't start with “-”");
});

test("a failed remove shows the main process's message", async () => {
  window.parallax.removeHost = async () => "Parallax couldn't save its settings: EACCES";
  await renderApp();
  await act(async () => {
    window.dispatchEvent(new KeyboardEvent("keydown", { key: ",", code: "Comma", metaKey: true }));
  });
  await click(
    [...document.querySelectorAll("button")].find((b) => b.textContent === "Connections")!,
  );
  expect(document.querySelector('form[aria-label="Add host"]')).toBeNull();

  await click([...document.querySelectorAll("button")].find((b) => b.textContent === "Remove")!);
  const alert = document.querySelector('[role="alert"]')!.textContent;
  expect(alert).toBe("Parallax couldn't save its settings: EACCES");
});
