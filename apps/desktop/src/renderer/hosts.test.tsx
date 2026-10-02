// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vite-plus/test";

import type { ConnectionState, HostInput, SshHost, ParallaxBridge } from "../preload/bridge";
import { App } from "./App";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const mini: SshHost = { id: "h-mini", name: "Mac mini", destination: "mini" };
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
const request = vi.fn(async (_host: string, method: string) =>
  method === "thread/list" || method === "agent/list"
    ? { result: { repos: [], threads: [], runs: [], seq: 1 }, logId: "log" }
    : { error: { code: -32601, message: `${method} isn't faked` } },
);
const saveHost = vi.fn<(host: HostInput, id?: string) => Promise<string | undefined>>();

beforeEach(() => {
  request.mockClear();
  saveHost.mockReset();
  states = { local: connected, [mini.id]: untrusted };
  window.parallax = {
    platform: "darwin",
    setThemeSource: vi.fn(),
    connectionState: async (hostId) => states[hostId]!,
    onConnectionState: () => () => {},
    subscribe: () => () => {},
    request: request as unknown as ParallaxBridge["request"],
    hosts: async () => [mini],
    onHosts: () => () => {},
    saveHost,
    // Settings opens on General, which shows the update channel.
    updateChannel: async () => "nightly",
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
const hostRows = () => [
  ...document.querySelectorAll<HTMLButtonElement>(
    '[aria-labelledby="hosts-heading"] > li > button',
  ),
];
const click = async (element: HTMLElement) => {
  await act(async () => element.click());
  await settle();
};

test("every host is listed with its own status, this computer first", async () => {
  await renderApp();
  expect(hostRows().map((row) => row.textContent)).toEqual([
    "This MacConnected",
    "Mac miniDisconnected",
  ]);
  expect(hostRows()[1]!.title).toBe("mini's host key isn't trusted yet.");
  expect(hostRows()[0]!.getAttribute("aria-expanded")).toBe("true");
});

test("opening an SSH host shows its error and loads its threads from it", async () => {
  await renderApp();
  await click(hostRows()[1]!);
  expect(hostRows()[1]!.getAttribute("aria-expanded")).toBe("true");
  const footer = document.querySelector('[role="status"]')!;
  expect(footer.textContent).toContain("mini's host key isn't trusted yet.");
  expect(footer.textContent).toContain("Retry");

  states[mini.id] = connected;
  await click(hostRows()[0]!);
  await click(hostRows()[1]!);
  expect(
    request.mock.calls.some(([host, method]) => host === mini.id && method === "thread/list"),
  ).toBe(true);
  const crumbs = document.querySelectorAll('[aria-label="Breadcrumb"] li');
  expect(crumbs[0]!.textContent).toBe("Mac mini");
});

test("the sidebar's Add host opens the form, which shows the main process's error", async () => {
  await renderApp();
  await click(document.querySelector<HTMLButtonElement>('[aria-label="Add host"]')!);
  expect(document.querySelector("h1")!.textContent).toBe("Hosts");

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
    window.dispatchEvent(new KeyboardEvent("keydown", { key: ",", metaKey: true }));
  });
  await click([...document.querySelectorAll("button")].find((b) => b.textContent === "Hosts")!);
  expect(document.querySelector('form[aria-label="Add host"]')).toBeNull();

  await click([...document.querySelectorAll("button")].find((b) => b.textContent === "Remove")!);
  const alert = document.querySelector('[role="alert"]')!.textContent;
  expect(alert).toBe("Parallax couldn't save its settings: EACCES");
});
