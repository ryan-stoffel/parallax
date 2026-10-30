// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, test, vi } from "vite-plus/test";

import type { ConnectionState, DeviceHost, ParallaxBridge } from "../preload/bridge";
import type { ImportableSession } from "../protocol/generated/protocol";
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

const computer = (over: Partial<DeviceHost>): DeviceHost => ({
  id: "account:a",
  name: "BrandonsHP",
  icon: "laptop",
  hostName: "BrandonsHP",
  detected: "laptop",
  enabled: true,
  ...over,
});

type Answers = Record<string, (host: string, params: Record<string, unknown>) => unknown>;

/**
 * The bridge: `answers` by method, `connected` hosts, `saved` SSH hosts, the account's `devices`,
 * and whether it's `signedIn`.
 */
function bridge(
  answers: Answers,
  connected: string[],
  saved: { id: string; name: string }[] = [],
  { devices = [] as DeviceHost[], signedIn = true } = {},
) {
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
    onDevices: (listener: (devices: DeviceHost[]) => void) => {
      listener(devices);
      return () => {};
    },
    onConnect: (listener: (state: unknown) => void) => {
      listener({ on: false, channel: "nightly", icon: "laptop" });
      return () => {};
    },
    onProfile: (listener: (profile: unknown) => void) => {
      listener(signedIn ? { name: "Ryan", email: "r@example.com" } : null);
      return () => {};
    },
    signIn: vi.fn(async (): Promise<string | undefined> => undefined),
    discoverAccount: vi.fn(async () => {}),
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
  const handlers = { onKeep: vi.fn(), onClose: vi.fn(), onOpen: vi.fn() };
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
  // Found on a connected computer: the account isn't asked.
  expect(parallax.discoverAccount).not.toHaveBeenCalled();
  await click("Open thread");
  expect(onOpen).toHaveBeenCalledWith("ssh:hp", "t2");
});

test("otherwise it lists the account's computers and moves to one through the relay", async () => {
  let reached = false;
  const parallax = bridge(
    {
      "thread/remoteControlOrigin": origin,
      "thread/importable": (host) => ({
        result: { sessions: host === "account:a" ? [local({ thread: "t9" })] : [] },
      }),
      "thread/archive": (_host, p) => ({ result: { thread: { id: p["runId"] } } }),
    },
    ["local"],
    [],
    {
      devices: [
        computer({ id: "account:a", name: "BrandonsHP" }),
        computer({ id: "account:b", name: "mac-mini", access: { step: "needsCode" } }),
        computer({ id: "account:c", name: "tower", access: { step: "pending", code: "123456" } }),
        // A Tailscale-only device isn't offered: the move goes through the account.
        computer({ id: "tailnet:n1", name: "old-pc", ip: "100.64.0.2", os: "windows" }),
      ],
    },
  );
  parallax.setDeviceEnabled.mockImplementation(async () => {
    reached = true;
  });
  parallax.connectionState.mockImplementation(async (host: string) =>
    host === "local" || (host === "account:a" && reached)
      ? { status: "connected", plxd: "1", protocol: 1, capabilities: { threadImport: {} } }
      : { status: "connecting" },
  );
  await open();
  await click("Move it to Parallax Connect");
  await act(() => vi.waitFor(() => expect(text()).toContain("Which computer runs it?")));
  expect(text()).toContain("but it's a Windows computer");
  expect(parallax.discoverAccount).toHaveBeenCalled();
  const rows = [...document.querySelectorAll('ul[aria-label="Your computers"] li')];
  expect(rows.map((r) => r.querySelector("span span")?.textContent)).toEqual([
    "BrandonsHP",
    "mac-mini",
    "tower",
  ]);
  // A new computer asks for its code; one waiting to allow this device can't be picked yet.
  expect(rows[1]!.querySelector("button")!.textContent).toBe("Enter code");
  expect(rows[2]!.querySelector("button")!.disabled).toBe(true);
  expect(rows[2]!.textContent).toContain("Allow this computer on another device");
  await click("Move here");
  await act(() => vi.waitFor(() => expect(text()).toContain("Moved to BrandonsHP")));
  expect(parallax.setDeviceEnabled).toHaveBeenCalledWith("account:a", true);
  // Already imported there: it's brought out of the archive, not imported again.
  const methods = parallax.request.mock.calls.map(([host, method]) => `${host} ${method}`);
  expect(methods).not.toContain("account:a thread/import");
  expect(methods).toContain("account:a thread/archive");
  expect(methods).not.toContain("local connect/devices");
});

test("a computer without the session says so and lists the computers again", async () => {
  const parallax = bridge(
    {
      "thread/remoteControlOrigin": origin,
      "thread/importable": () => ({ result: { sessions: [] } }),
    },
    ["local", "account:a"],
    [],
    { devices: [computer({ id: "account:a", name: "BrandonsHP" })] },
  );
  await open();
  await click("Move it to Parallax Connect");
  await act(() => vi.waitFor(() => expect(text()).toContain("Which computer runs it?")));
  await click("Move here");
  await act(() =>
    vi.waitFor(() =>
      expect(text()).toContain("Claude Code on BrandonsHP has no transcript of this session"),
    ),
  );
  expect(parallax.request.mock.calls.map(([, method]) => method)).not.toContain("thread/import");
});

test("signed out, it asks to sign in, then lists the account's computers", async () => {
  const parallax = bridge(
    {
      "thread/remoteControlOrigin": origin,
      "thread/importable": () => ({ result: { sessions: [] } }),
    },
    ["local"],
    [],
    { signedIn: false },
  );
  parallax.signIn.mockResolvedValueOnce("The browser didn't finish signing in.");
  await open();
  await click("Move it to Parallax Connect");
  await act(() => vi.waitFor(() => expect(text()).toContain("Sign in to reach its computer")));
  expect(parallax.discoverAccount).not.toHaveBeenCalled();
  await click("Sign in");
  await act(() =>
    vi.waitFor(() => expect(text()).toContain("The browser didn't finish signing in.")),
  );
  await click("Sign in");
  await act(() => vi.waitFor(() => expect(text()).toContain("Which computer runs it?")));
  expect(text()).toContain("No other computers on your Parallax account yet");
  expect(parallax.discoverAccount).toHaveBeenCalled();
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

test("closing it while it reads claude.ai asks the account for nothing", async () => {
  let answer: (value: unknown) => void = () => {};
  const parallax = bridge(
    {
      "thread/remoteControlOrigin": () =>
        new Promise((resolve) => {
          answer = resolve;
        }),
      "thread/importable": () => ({ result: { sessions: [] } }),
    },
    ["local"],
  );
  await open();
  await click("Move it to Parallax Connect");
  act(() => root!.unmount());
  root = undefined;
  await act(async () => answer(origin()));
  expect(parallax.discoverAccount).not.toHaveBeenCalled();
});
