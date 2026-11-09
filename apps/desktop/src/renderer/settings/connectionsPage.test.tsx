// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vite-plus/test";

import type {
  ConnectionState,
  DeviceHost,
  ParallaxBridge,
  Profile,
  SavedHost,
} from "../../preload/bridge";
import type {
  RelayCheckResult,
  RemoteSession,
  RemoteSessionsResult,
} from "../../protocol/generated/protocol";
import { Notifications } from "../notifications";
import { ConnectionSettings } from "./ConnectionSettings";
import { searchSettings } from "./search";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
HTMLElement.prototype.showPopover = () => {};
HTMLElement.prototype.hidePopover = () => {};
HTMLDialogElement.prototype.showModal = function (this: HTMLDialogElement) {
  this.setAttribute("open", "");
};
HTMLDialogElement.prototype.close = function (this: HTMLDialogElement) {
  this.removeAttribute("open");
};

const connected: ConnectionState = {
  status: "connected",
  plxd: "0.4.0",
  protocol: 1,
  capabilities: {},
};
let remote = false;
let remoteWeb = false;
let relay = false;
// Absent on a plxd without agent work.
let agentWork: boolean | undefined;
let sessions: RemoteSession[] = [];
let hosts: SavedHost[] = [];
type Set = { remote?: boolean; remoteWeb?: boolean; relay?: boolean };
const request = vi.fn(async (_host: string, method: string, params: Set) => {
  const settings = () => ({
    result: {
      autoResume: true,
      remote,
      remoteWeb,
      relay,
      ...(agentWork !== undefined && { agentWork }),
    },
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
const signedIn = { name: "Ryan", firstName: "Ryan", lastName: "", email: "ryan@example.com" };
let profile: Profile | null = signedIn;
const signIn = vi.fn(async (): Promise<string | undefined> => undefined);
const removeHost = vi.fn(async (): Promise<string | undefined> => undefined);
const installPlxd = vi.fn(async (): Promise<string | undefined> => undefined);
// What main tells every listener, as it does when something changes.
const profileListeners = new Set<(profile: Profile | null) => void>();
const deviceListeners = new Set<(devices: DeviceHost[]) => void>();
const stateListeners = new Set<(hostId: string, state: ConnectionState) => void>();
let devices: DeviceHost[] = [];
const showDevices = (next: DeviceHost[]) => {
  devices = next;
  for (const listener of deviceListeners) listener(devices);
};
const device = (id: string, name: string, more: object = {}) =>
  ({
    id,
    name,
    icon: "server",
    detected: "server",
    hostName: name,
    enabled: true,
    ...more,
  }) as DeviceHost;

beforeEach(() => {
  remote = false;
  remoteWeb = false;
  relay = false;
  agentWork = undefined;
  sessions = [];
  hosts = [{ id: `lan:${"ab".repeat(32)}`, name: "studio", routes: ["192.168.1.20"] }];
  profile = signedIn;
  devices = [];
  profileListeners.clear();
  deviceListeners.clear();
  stateListeners.clear();
  signIn.mockReset().mockResolvedValue(undefined);
  removeHost.mockClear();
  installPlxd.mockClear();
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
    onDevices: (listener) => {
      deviceListeners.add(listener);
      listener(devices);
      return () => deviceListeners.delete(listener);
    },
    onLocalName: () => () => {},
    onProfile: (listener) => {
      profileListeners.add(listener);
      listener(profile);
      return () => profileListeners.delete(listener);
    },
    signIn,
    removeHost,
    installPlxd,
    version: async () => "0.4.0",
    discoverAccount: async () => {},
    onKeyStanding: () => () => {},
    onConnectNotice: () => () => {},
    onRelayUsage: () => () => {},
    connectionState: async () => connected,
    onConnectionState: (listener) => {
      stateListeners.add(listener);
      return () => stateListeners.delete(listener);
    },
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
        <ConnectionSettings />
        <Notifications />
      </>,
    ),
  );
  unmount = () => {
    root.unmount();
    document.body.innerHTML = "";
  };
  await settle();

  // The devices' card, since other cards have a Cancel and a Remove of their own.
  const button = (name: string) =>
    [...document.querySelectorAll('section[aria-label="Devices with access"] button')].find(
      (b) => b.textContent === name,
    )!;
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
  // It's marked, and says how to get full access back, for a paired device or a signed-in one.
  const said = document.body.textContent;
  expect(said).toContain("phoneRead-only");
  expect(said).toContain("pair it again or choose Start over with a new key on that device.");
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
  act(() => root.render(<ConnectionSettings />));
  unmount = () => {
    root.unmount();
    document.body.innerHTML = "";
  };
  await settle();
  expect(button("Copy diagnostics")).toBeUndefined();

  await click(button("Check connection"));
  expect(document.body.textContent).toContain("Listener failed. The listener is off. Turn it on.");
  await click(button("Copy diagnostics"));
  expect(writeText).toHaveBeenCalledWith("Result: failed at listener");

  checkRelay.mockResolvedValueOnce({ roundTripMs: 42, diagnostics: "Result: passed" });
  await click(button("Check connection"));
  expect(document.body.textContent).toContain("Working. The connection took 42 ms.");

  // Signed out, or plxd out of reach: only the reason, and nothing to copy.
  checkRelay.mockResolvedValueOnce("Sign in first.");
  await click(button("Check connection"));
  expect(document.body.textContent).toContain("Sign in first.");
  expect(button("Copy diagnostics")).toBeUndefined();
});

test("Reach from anywhere registers this computer with the relay before turning it on", async () => {
  remote = true;
  const root = createRoot(document.body.appendChild(document.createElement("div")));
  act(() =>
    root.render(
      <>
        <ConnectionSettings />
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

  // How many of the account's computers are on the relay.
  expect(document.body.textContent).toContain("2 of 10 computers on your account.");
  // One this app has no device for is listed once, and its menu's Remove frees its place.
  const row = document.querySelector('li[data-device="relay:b"]')!;
  expect(row.textContent).toContain("On your account");
  await click(row.querySelector('[role="menuitem"]')!);
  // It asks first, and Cancel keeps the computer.
  const dialog = row.querySelector("dialog")!;
  expect(dialog.textContent).toContain("none of your computers or devices reach it anymore");
  expect(removeRelayHost).not.toHaveBeenCalled();
  const inDialog = (name: string) =>
    [...dialog.querySelectorAll("button")].find((b) => b.textContent === name)!;
  await click(inDialog("Cancel"));
  expect(removeRelayHost).not.toHaveBeenCalled();
  await click(inDialog("Remove"));
  expect(removeRelayHost).toHaveBeenCalledWith("b");
  expect(document.querySelector('li[data-device="relay:b"]')).toBeNull();
  // This computer is never in the list of the others.
  expect(document.querySelector('li[data-device="relay:a"]')).toBeNull();
});

test("signed out, Reach from anywhere offers Sign in where its switch can't turn on", async () => {
  profile = null;
  const root = createRoot(document.body.appendChild(document.createElement("div")));
  act(() => root.render(<ConnectionSettings />));
  unmount = () => {
    root.unmount();
    document.body.innerHTML = "";
  };
  await settle();
  expect(document.querySelector('[role="switch"][aria-label="Reach from anywhere"]')).toBeNull();
  await click(button("Sign in"));
  expect(signIn).toHaveBeenCalledWith(false);
  expect(registerRelay).not.toHaveBeenCalled();
});

test("a computer that can't take agent work says why, with its switch off", async () => {
  devices = [
    device("account:old", "old-box"),
    device("account:allow", "allow-box", { addedWithAllow: true }),
    device("account:fine", "fine-box"),
  ];
  window.parallax.connectionState = async (id) =>
    id === "account:old" ? connected : { ...connected, capabilities: { agentWork: {} } };
  const root = createRoot(document.body.appendChild(document.createElement("div")));
  act(() => root.render(<ConnectionSettings />));
  unmount = () => {
    root.unmount();
    document.body.innerHTML = "";
  };
  await settle();
  const row = (id: string) => document.querySelector(`li[data-device="account:${id}"]`)!;
  // Each computer's own settings open under its row.
  for (const name of ["old-box", "allow-box", "fine-box"])
    await click(document.querySelector(`[aria-label="${name} settings"]`)!);
  const toggle = (id: string, name: string) =>
    row(id).querySelector<HTMLButtonElement>(
      `[role="switch"][aria-label="Let agents on my other computers work on ${name}"]`,
    )!;
  expect(row("old").textContent).toContain("Needs updating");
  expect(toggle("old", "old-box").disabled).toBe(true);
  expect(row("allow").textContent).toContain("Added with Allow");
  expect(toggle("allow", "allow-box").disabled).toBe(true);
  expect(toggle("fine", "fine-box").disabled).toBe(false);
  // One that can says what turning it on allows, at the switch.
  expect(row("fine").textContent).toContain(
    "Agents on your other computers can run commands there as you. Also turns on pairing there.",
  );
});

test("every Connections setting a search finds is on the page to scroll to", async () => {
  // With everything on, and with pairing off and nothing paired.
  for (const on of [true, false]) {
    remote = on;
    relay = on;
    agentWork = false;
    window.parallax.connectionState = async () => ({
      ...connected,
      capabilities: { agentWork: {} },
    });
    const root = createRoot(document.body.appendChild(document.createElement("div")));
    act(() => root.render(<ConnectionSettings />));
    await settle();
    const found = searchSettings("").filter((r) => r.section === "connections" && r.anchor);
    expect(found.map((r) => r.title)).toEqual(
      expect.arrayContaining(["SSH hosts", "Same network", "Devices with access", "Pair a device"]),
    );
    for (const { title, anchor } of found)
      expect(document.querySelector(`[data-setting="${anchor}"]`), title).not.toBeNull();
    act(() => root.unmount());
    document.body.innerHTML = "";
  }
});

/** Renders the page, with the app's notifications, and waits for it to settle. */
async function show() {
  const root = createRoot(document.body.appendChild(document.createElement("div")));
  act(() =>
    root.render(
      <>
        <ConnectionSettings />
        <Notifications />
      </>,
    ),
  );
  unmount = () => {
    root.unmount();
    document.body.innerHTML = "";
  };
  await settle();
}
const rowOf = (id: string) => document.querySelector(`li[data-device="${id}"]`);
const inRow = (id: string, name: string) =>
  [...rowOf(id)!.querySelectorAll("button")].find((b) => b.textContent === name)!;

test("a computer removed from its row doesn't come back as one the app has no device for", async () => {
  relay = true;
  devices = [device("account:b", "macbook-b")];
  // Main takes it off the relay, then tells the windows it's gone.
  const removeDevice = vi.fn(async (): Promise<string | undefined> => {
    relayHosts = relayHosts.filter((h) => h.hostId !== "b");
    showDevices([]);
    return undefined;
  });
  window.parallax.removeDevice = removeDevice;
  await show();
  expect(document.body.textContent).toContain("2 of 10 computers on your account.");
  expect(rowOf("relay:b")).toBeNull();

  await click(inRow("account:b", "Remove…"));
  await click(inRow("account:b", "Remove"));
  expect(removeDevice).toHaveBeenCalledWith("account:b");
  expect(rowOf("account:b")).toBeNull();
  expect(rowOf("relay:b")).toBeNull();
  expect(document.body.textContent).toContain("1 of 10 computers on your account.");
});

test("the code dialog a row opens follows the computer to its next step", async () => {
  window.parallax.connectionState = async (id) =>
    id === "local" ? connected : { status: "connecting" };
  window.parallax.answerCompare = () => new Promise(() => {});
  const newbox = (step: "compare" | "confirm") =>
    device("account:new", "newbox", { access: { step, code: "482913" } });
  devices = [newbox("compare")];
  await show();
  await click(inRow("account:new", "Compare code"));
  const dialog = () =>
    [...document.querySelectorAll("dialog[open]")].find((d) => d.textContent?.includes("482 913"))!;
  expect(dialog().textContent).toContain("Allow it only if newbox shows this code");

  // Allowed here, it waits on newbox, and says what to do there.
  await act(async () => showDevices([newbox("confirm")]));
  expect(dialog().textContent).toContain("Press Enter in newbox's terminal");
});

test("signing in from Reach from anywhere shows it on once plxd turns it on", async () => {
  profile = null;
  // Signing in registers this computer, which turns its relay on, and tells the windows who it is.
  signIn.mockImplementation(async () => {
    relay = true;
    profile = signedIn;
    for (const listener of profileListeners) listener(profile);
    return undefined;
  });
  await show();
  await click(button("Sign in"));
  const toggle = document.querySelector('[role="switch"][aria-label="Reach from anywhere"]')!;
  expect(toggle.getAttribute("aria-checked")).toBe("true");
  expect(document.body.textContent).toContain("Connected to the relay.");
  expect(button("Check connection")).toBeDefined();
});

test("removing an SSH host or a paired computer asks first", async () => {
  const studio = hosts[0]!.id;
  hosts = [...hosts, { id: "ssh-1", name: "devbox", destination: "ryan@devbox" }];
  await show();
  for (const id of [studio, "ssh-1"]) {
    await click(inRow(id, "Remove…"));
    expect(rowOf(id)!.querySelector("dialog[open]")!.textContent).toContain(
      "Parallax here stops connecting to it",
    );
    await click(inRow(id, "Cancel"));
    expect(removeHost).not.toHaveBeenCalledWith(id);
    await click(inRow(id, "Remove…"));
    await click(inRow(id, "Remove"));
    expect(removeHost).toHaveBeenCalledWith(id);
  }
});

test("Update plxd asks first, says what it stops, and stops asking once it isn't needed", async () => {
  hosts = [{ id: "ssh-1", name: "devbox", destination: "ryan@devbox" }];
  const older = { ...connected, plxd: "0.3.0" };
  window.parallax.connectionState = async (id) => (id === "ssh-1" ? older : connected);
  await show();
  const warning = () => rowOf("ssh-1")!.querySelector('[role="alert"]');
  await click(inRow("ssh-1", "Update plxd"));
  expect(installPlxd).not.toHaveBeenCalled();
  expect(warning()!.textContent).toBe(
    "Updating restarts plxd there, which stops its running agents.",
  );
  await click(inRow("ssh-1", "Cancel"));
  expect(warning()).toBeNull();
  expect(installPlxd).not.toHaveBeenCalled();

  // It updates by itself while the question is up: nothing is left to confirm.
  await click(inRow("ssh-1", "Update plxd"));
  await act(async () => {
    for (const listener of stateListeners) listener("ssh-1", connected);
  });
  expect(warning()).toBeNull();
  expect(inRow("ssh-1", "Update plxd")).toBeUndefined();

  await act(async () => {
    for (const listener of stateListeners) listener("ssh-1", older);
  });
  await click(inRow("ssh-1", "Update plxd"));
  await click(inRow("ssh-1", "Update plxd"));
  expect(installPlxd).toHaveBeenCalledWith("ssh-1");
});

test("this computer's failure is printed under its name, not left to a tooltip", async () => {
  window.parallax.connectionState = async () => ({
    status: "failed",
    retrying: false,
    error: { reason: "exited", message: "plxd exited: its database is locked." },
  });
  await show();
  expect(rowOf("local")!.textContent).toContain("plxd exited: its database is locked.");
});
