// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, test, vi } from "vite-plus/test";

import type { ConnectionState, ParallaxBridge } from "../preload/bridge";
import type { ImportableSession, TailnetDevice } from "../protocol/generated/protocol";
import { MoveRemoteControl } from "./MoveRemoteControl";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

let root: Root | undefined;
afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  document.body.innerHTML = "";
});

const local = (over: Partial<ImportableSession> = {}): ImportableSession => ({
  source: "claude",
  id: "5c5f05dc",
  title: "hello from claude rc",
  updatedAt: "2026-10-29T03:43:05Z",
  ...over,
});

const device = (over: Partial<TailnetDevice>): TailnetDevice => ({
  id: "n1",
  hostName: "hp-desktop",
  dnsName: "hp-desktop.tail.ts.net.",
  os: "windows",
  ip: "100.64.0.2",
  online: true,
  parallax: false,
  ...over,
});

type Answers = Record<string, (host: string, params: Record<string, unknown>) => unknown>;

/** The bridge: `answers` by method, `connected` hosts, and `saved` SSH hosts. */
function bridge(answers: Answers, connected: string[], saved: { id: string; name: string }[] = []) {
  const request = vi.fn(async (host: string, method: string, params: Record<string, unknown>) => {
    const answer = answers[method];
    return answer ? answer(host, params) : { error: { code: -32601, message: method } };
  });
  const parallax = {
    connectionState: vi.fn(async (host: string): Promise<ConnectionState> =>
      connected.includes(host)
        ? {
            status: "connected" as const,
            plxd: "1",
            protocol: 1,
            capabilities: { threadImport: {}, claudeRemoteControlMove: {} },
          }
        : { status: "connecting" as const },
    ),
    onConnectionState: () => () => {},
    hosts: async () => saved,
    onHosts: () => () => {},
    onLocalName: () => () => {},
    onDevices: () => () => {},
    onConnect: (listener: (state: unknown) => void) => {
      listener({ on: false, channel: "nightly", icon: "laptop" });
      return () => {};
    },
    setConnect: vi.fn(async () => undefined),
    setDeviceEnabled: vi.fn(async () => {}),
    request,
  };
  window.parallax = parallax as unknown as ParallaxBridge;
  return parallax;
}

const origin = () => ({
  result: {
    origin: { sessionId: "5c5f05dc", cwd: "C:\\Users\\ryan\\learn-rust", platform: "win32" },
  },
});

async function open(props: Partial<Parameters<typeof MoveRemoteControl>[0]> = {}) {
  const handlers = { onKeep: vi.fn(), onClose: vi.fn(), onOpen: vi.fn(), onAddWithSsh: vi.fn() };
  root = createRoot(document.body.appendChild(document.createElement("div")));
  await act(async () =>
    root!.render(
      <MoveRemoteControl
        hostId="local"
        runId="rc1"
        title="Hello from Claude RC"
        {...handlers}
        {...props}
      />,
    ),
  );
  return handlers;
}

const click = async (text: string) => {
  const button = [...document.querySelectorAll("button")].find((b) =>
    b.textContent?.includes(text),
  );
  expect(button, text).toBeTruthy();
  await act(async () => button!.click());
};

const text = () => document.querySelector("dialog")!.textContent;

test("Keep remembers the choice and moves nothing", async () => {
  const parallax = bridge({}, ["local"]);
  const { onKeep } = await open();
  expect(text()).toContain("Keep it on Remote Control");
  expect(text()).toContain("Text and text files only, no images");
  await click("Keep it on Remote Control");
  expect(onKeep).toHaveBeenCalledOnce();
  expect(parallax.request).not.toHaveBeenCalled();
});

test("a session on a connected computer is imported there, brought out of the archive, and this thread archived", async () => {
  const parallax = bridge(
    {
      "thread/remoteControlOrigin": origin,
      "thread/importable": (host) => ({
        // As the Claude desktop app records it: its own id, with Claude Code's beside it.
        result: {
          sessions:
            host === "ssh:hp"
              ? [local({ id: "desktop-1", claudeSession: "5c5f05dc" }), local({ id: "other" })]
              : [],
        },
      }),
      "thread/import": () => ({ result: { thread: { id: "t2" } } }),
      "thread/archive": (_host, p) => ({ result: { thread: { id: p["runId"] } } }),
    },
    ["local", "ssh:hp"],
    [{ id: "ssh:hp", name: "HP desktop" }],
  );
  const { onOpen } = await open();
  await click("Move it to Parallax Connect");
  await act(() => vi.waitFor(() => expect(text()).toContain("Moved to HP desktop")));
  const calls = parallax.request.mock.calls.map(([host, method, params]) => [host, method, params]);
  expect(calls).toContainEqual(["ssh:hp", "thread/import", { source: "claude", id: "desktop-1" }]);
  expect(calls).toContainEqual(["ssh:hp", "thread/archive", { runId: "t2", archived: false }]);
  expect(calls).toContainEqual(["local", "thread/archive", { runId: "rc1", archived: true }]);
  // Found on a connected computer: Connect and Tailscale are left alone.
  expect(parallax.setConnect).not.toHaveBeenCalled();
  await click("Open thread");
  expect(onOpen).toHaveBeenCalledWith("ssh:hp", "t2");
});

test("otherwise it turns Connect on, lists the tailnet's computers of the session's OS, and moves to one that runs Connect", async () => {
  let reached = false;
  const parallax = bridge(
    {
      "thread/remoteControlOrigin": origin,
      "thread/importable": (host) => ({
        result: { sessions: host === "tailnet:n2" ? [local({ thread: "t9" })] : [] },
      }),
      "connect/devices": () => ({
        result: {
          tailscale: "running",
          port: 7340,
          listening: true,
          self: device({ id: "me", hostName: "macbook", os: "macOS" }),
          devices: [
            device({ id: "n1", hostName: "mac-mini", os: "macOS" }),
            device({ id: "n2", hostName: "hp-desktop", parallax: true }),
            device({ id: "n3", hostName: "old-pc", online: false }),
          ],
        },
      }),
      "thread/archive": (_host, p) => ({ result: { thread: { id: p["runId"] } } }),
    },
    ["local"],
  );
  parallax.setDeviceEnabled.mockImplementation(async () => {
    reached = true;
  });
  parallax.connectionState.mockImplementation(async (host: string) =>
    host === "local" || (host === "tailnet:n2" && reached)
      ? { status: "connected", plxd: "1", protocol: 1, capabilities: { threadImport: {} } }
      : { status: "connecting" },
  );
  await open();
  await click("Move it to Parallax Connect");
  await act(() => vi.waitFor(() => expect(text()).toContain("Which computer runs it?")));
  expect(parallax.setConnect).toHaveBeenCalledWith(true);
  const rows = [...document.querySelectorAll('ul[aria-label="Your computers"] li')];
  // Windows computers only, online first; the Mac and this computer aren't listed.
  expect(rows.map((r) => r.querySelector("span span")?.textContent)).toEqual([
    "hp-desktop",
    "old-pc",
  ]);
  expect(rows[1]!.querySelector("button")!.disabled).toBe(true);
  await click("Move here");
  await act(() => vi.waitFor(() => expect(text()).toContain("Moved to hp-desktop")));
  expect(parallax.setDeviceEnabled).toHaveBeenCalledWith("tailnet:n2", true);
  // Already imported there: it's brought out of the archive, not imported again.
  const methods = parallax.request.mock.calls.map(([host, method]) => `${host} ${method}`);
  expect(methods).not.toContain("tailnet:n2 thread/import");
  expect(methods).toContain("tailnet:n2 thread/archive");
});

test("with no Tailscale, or no computer of its OS, it says why and offers the tailnet and SSH", async () => {
  let tailscale = "missing";
  bridge(
    {
      "thread/remoteControlOrigin": origin,
      "thread/importable": () => ({ result: { sessions: [] } }),
      "connect/devices": () => ({
        result: {
          tailscale,
          port: 7340,
          listening: false,
          devices: [device({ id: "n1", hostName: "mac-mini", os: "macOS" })],
        },
      }),
    },
    ["local"],
  );
  const { onAddWithSsh } = await open();
  await click("Move it to Parallax Connect");
  await act(() => vi.waitFor(() => expect(text()).toContain("Tailscale isn't running here")));
  expect(text()).toContain("Install Tailscale here and on that computer");
  expect(document.querySelector('a[href="https://tailscale.com/download"]')).toBeTruthy();
  tailscale = "running";
  await click("Try again");
  await act(() => vi.waitFor(() => expect(text()).toContain("Its computer isn't on your tailnet")));
  expect(text()).toContain("No Windows computer on Tailscale but this one");
  await click("Add with SSH");
  expect(onAddWithSsh).toHaveBeenCalledOnce();
});

test("closing it while it looks moves nothing", async () => {
  let answer: (value: unknown) => void = () => {};
  const parallax = bridge(
    {
      "thread/remoteControlOrigin": origin,
      "thread/importable": () =>
        new Promise((resolve) => {
          answer = resolve;
        }),
    },
    ["local"],
  );
  await open();
  await click("Move it to Parallax Connect");
  await act(() => vi.waitFor(() => expect(text()).toContain("Looking for it on your computers")));
  act(() => root!.unmount());
  root = undefined;
  await act(async () => answer({ result: { sessions: [local()] } }));
  const methods = parallax.request.mock.calls.map(([, method]) => method);
  expect(methods).not.toContain("thread/import");
  expect(methods).not.toContain("thread/archive");
});
