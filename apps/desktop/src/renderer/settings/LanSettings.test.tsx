// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vite-plus/test";

import type { ConnectionState, DeviceHost, ParallaxBridge, SavedHost } from "../../preload/bridge";
import type {
  RelayCheckResult,
  RemoteSession,
  RemoteSessionsResult,
} from "../../protocol/generated/protocol";
import { Notifications } from "../notifications";
import { LanSettings } from "./LanSettings";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
HTMLElement.prototype.showPopover = () => {};

const connected: ConnectionState = {
  status: "connected",
  plxd: "0.4.0",
  protocol: 1,
  capabilities: {},
};
let remote = false;
let remoteWeb = false;
let relay = false;
let sessions: RemoteSession[] = [];
let hosts: SavedHost[] = [];
type Set = { remote?: boolean; remoteWeb?: boolean; relay?: boolean };
const request = vi.fn(async (_host: string, method: string, params: Set) => {
  const settings = () => ({
    result: { autoResume: true, remote, remoteWeb, relay },
    logId: "log",
  });
  if (method === "host/settings/get") return settings();
  if (method === "host/settings/set") {
    remote = params.remote ?? remote;
    remoteWeb = params.remoteWeb ?? remoteWeb;
    relay = params.relay ?? relay;
    return settings();
  }
  if (method === "remote/pair")
    return {
      result: { code: "7KQ-4M2", expiresAt: "", name: "macbook", addresses: ["192.168.1.20"] },
      logId: "log",
    };
  if (method === "remote/sessions")
    return {
      result: {
        sessions,
        listening: remote,
        pairing: remote,
        fingerprint: "ab".repeat(32),
        relay: { connected: relay },
      },
      logId: "log",
    };
  return { error: { code: -32601, message: "no" } };
});
const pairLan = vi.fn(async () => undefined);
const registerRelay = vi.fn(async (): Promise<string | undefined> => undefined);
const host = (hostId: string, thisComputer: boolean) => ({
  hostId,
  name: "macbook",
  online: thisComputer,
  thisComputer,
});
let relayHosts = [host("a", true), host("b", false)];
const removeRelayHost = vi.fn(async (hostId: string) => {
  relayHosts = relayHosts.filter((h) => h.hostId !== hostId);
  return relayHosts;
});
const discoverLan = vi.fn(async () => [{ id: "0", name: "studio" }]);

beforeEach(() => {
  remote = false;
  remoteWeb = false;
  relay = false;
  sessions = [];
  hosts = [{ id: `lan:${"ab".repeat(32)}`, name: "studio", routes: ["192.168.1.20"] }];
  request.mockClear();
  pairLan.mockClear();
  registerRelay.mockClear();
  relayHosts = [host("a", true), host("b", false)];
  window.parallax = {
    platform: "darwin",
    request: request as unknown as ParallaxBridge["request"],
    pairLan,
    registerRelay,
    relayHosts: async () => relayHosts,
    removeRelayHost,
    discoverLan,
    hosts: async () => hosts,
    onHosts: () => () => {},
    onConnect: () => () => {},
    onDevices: () => () => {},
    onLocalName: () => () => {},
    connectionState: async () => connected,
    onConnectionState: () => () => {},
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

const settle = async () => {
  for (let i = 0; i < 10; i++) await act(async () => {});
};
const button = (name: string) =>
  [...document.querySelectorAll("button")].find((b) => b.textContent === name)!;
const click = async (element: Element) => {
  await act(async () => (element as HTMLElement).click());
  await settle();
};

test("making a device read-only asks first, says it's for good, and a failure says why", async () => {
  const session = { id: "s1", name: "phone", createdAt: "2026-11-04T00:00:00Z" };
  const makeDeviceReadOnly = vi.fn(async (): Promise<RemoteSessionsResult | string> => ({
    sessions: [{ ...session, readOnly: true }],
    listening: true,
    pairing: false,
  }));
  window.parallax.makeDeviceReadOnly = makeDeviceReadOnly;
  window.parallax.connectionState = async () => ({
    ...connected,
    capabilities: { readOnlyDevices: {} },
  });
  sessions = [session];
  const root = createRoot(document.body.appendChild(document.createElement("div")));
  act(() =>
    root.render(
      <>
        <LanSettings />
        <Notifications />
      </>,
    ),
  );
  unmount = () => {
    root.unmount();
    document.body.innerHTML = "";
  };
  await settle();

  // The first click only asks. Cancel leaves it as it was.
  await click(button("Make read-only"));
  expect(makeDeviceReadOnly).not.toHaveBeenCalled();
  expect(document.body.textContent).toContain("This can't be undone.");
  await click(button("Cancel"));
  expect(document.body.textContent).not.toContain("This can't be undone.");

  makeDeviceReadOnly.mockResolvedValueOnce("the store is locked");
  await click(button("Make read-only"));
  await click(button("Make read-only"));
  expect(document.querySelector('[aria-label="Notifications"]')?.textContent).toContain(
    "the store is locked",
  );

  await click(button("Make read-only"));
  await click(button("Make read-only"));
  expect(makeDeviceReadOnly).toHaveBeenCalledWith("s1");
  const said = document.body.textContent;
  expect(said).toContain("Read-only: it reads threads");
  expect(said).toContain("Start over with a new key");
  // Nothing offers to undo it, only Revoke.
  expect(button("Make read-only")).toBeUndefined();
  expect(button("Revoke")).toBeDefined();
});

test("Check connection names the part that failed and copies the report", async () => {
  relay = true;
  const writeText = vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue();
  const checkRelay = vi.fn(async (): Promise<RelayCheckResult | string> => ({
    failed: "listener",
    problem: "The listener is off.",
    fix: "Turn it on.",
    diagnostics: "Result: failed at listener",
  }));
  window.parallax.checkRelay = checkRelay;
  const root = createRoot(document.body.appendChild(document.createElement("div")));
  act(() => root.render(<LanSettings />));
  unmount = () => {
    root.unmount();
    document.body.innerHTML = "";
  };
  await settle();
  expect(button("Copy diagnostics")).toBeUndefined();

  await click(button("Check"));
  expect(document.body.textContent).toContain("Listener failed. The listener is off. Turn it on.");
  await click(button("Copy diagnostics"));
  expect(writeText).toHaveBeenCalledWith("Result: failed at listener");

  checkRelay.mockResolvedValueOnce({ roundTripMs: 42, diagnostics: "Result: passed" });
  await click(button("Check"));
  expect(document.body.textContent).toContain("Working. The connection took 42 ms.");

  // Signed out, or plxd out of reach: only the reason, and nothing to copy.
  checkRelay.mockResolvedValueOnce("Sign in first.");
  await click(button("Check"));
  expect(document.body.textContent).toContain("Sign in first.");
  expect(button("Copy diagnostics")).toBeUndefined();
});

test("Reach from anywhere registers this computer with the relay before turning it on", async () => {
  remote = true;
  const root = createRoot(document.body.appendChild(document.createElement("div")));
  act(() =>
    root.render(
      <>
        <LanSettings />
        <Notifications />
      </>,
    ),
  );
  unmount = () => {
    root.unmount();
    document.body.innerHTML = "";
  };
  await settle();
  const toggle = document.querySelector('[role="switch"][aria-label="Reach from anywhere"]')!;
  expect(toggle.getAttribute("aria-checked")).toBe("false");

  // Signed out: nothing changes, and a notification says why.
  registerRelay.mockResolvedValueOnce("Sign in to Parallax from Profile in the sidebar first.");
  await click(toggle);
  expect(request).not.toHaveBeenCalledWith("local", "host/settings/set", { relay: true });
  expect(document.querySelector('[aria-label="Notifications"]')?.textContent).toBe(
    "Couldn't turn Reach from anywhere onSign in to Parallax from Profile in the sidebar first.",
  );

  await click(toggle);
  expect(registerRelay).toHaveBeenCalledTimes(2);
  expect(request).toHaveBeenCalledWith("local", "host/settings/set", { relay: true });
  expect(toggle.getAttribute("aria-checked")).toBe("true");
  expect(document.body.textContent).toContain("Connected to the relay.");

  // The account's computers on the relay, each other one with Remove, which frees its place.
  expect(document.body.textContent).toContain("On the relay, this computer. Connected.");
  await click(document.querySelectorAll('[aria-label="Remove macbook from your account"]')[0]!);
  // It asks first, and Cancel keeps the computer.
  expect(document.body.textContent).toContain("None of your computers or devices reach it anymore");
  expect(removeRelayHost).not.toHaveBeenCalled();
  await click(button("Cancel"));
  expect(removeRelayHost).not.toHaveBeenCalled();
  await click(document.querySelectorAll('[aria-label="Remove macbook from your account"]')[0]!);
  // The confirming Remove is the one without the row's label.
  const confirmRemove = [...document.querySelectorAll("button")].find(
    (b) => b.textContent === "Remove" && !b.hasAttribute("aria-label"),
  )!;
  await click(confirmRemove);
  expect(removeRelayHost).toHaveBeenCalledWith("b");
  // This computer has no Remove: it can only be removed from another one.
  expect(document.querySelectorAll('[aria-label="Remove macbook from your account"]')).toHaveLength(
    0,
  );
});

test("a computer that can't take agent work says why, with its switch off", async () => {
  const device = (id: string, name: string, more: object = {}) => ({
    id,
    name,
    icon: "server",
    detected: "server",
    hostName: name,
    enabled: true,
    ...more,
  });
  window.parallax.onDevices = (listener) => {
    listener([
      device("account:old", "old-box"),
      device("account:allow", "allow-box", { addedWithAllow: true }),
      device("account:fine", "fine-box"),
    ] as DeviceHost[]);
    return () => {};
  };
  window.parallax.connectionState = async (id) =>
    id === "account:old" ? connected : { ...connected, capabilities: { agentWork: {} } };
  const root = createRoot(document.body.appendChild(document.createElement("div")));
  act(() => root.render(<LanSettings />));
  unmount = () => root.unmount();
  await settle();
  const row = (id: string) => document.querySelector(`[data-computer="account:${id}"]`)!;
  const toggle = (id: string) => row(id).querySelector<HTMLButtonElement>('[role="switch"]')!;
  expect(row("old").textContent).toContain("Needs updating");
  expect(toggle("old").disabled).toBe(true);
  expect(row("allow").textContent).toContain("Added with Allow");
  expect(toggle("allow").disabled).toBe(true);
  expect(toggle("fine").disabled).toBe(false);
});
