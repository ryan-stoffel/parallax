// @vitest-environment happy-dom
import { act, type ComponentType } from "react";
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
import { SharingSettings } from "./SharingSettings";

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
const editRoutes = vi.fn(async (): Promise<string | undefined> => undefined);
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
  editRoutes.mockClear();
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
    editRoutes,
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
  vi.useRealTimers();
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

/** Renders one of the two Connections pages, with the app's notifications, and waits for it to settle. */
async function show(Page: ComponentType) {
  const root = createRoot(document.body.appendChild(document.createElement("div")));
  act(() =>
    root.render(
      <>
        <Page />
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
/** A computer's card on Computers, and a button in it. */
const cardOf = (id: string) => document.querySelector(`li[data-device="${id}"]`);
const inCard = (id: string, name: string) =>
  [...cardOf(id)!.querySelectorAll("button")].find((b) => b.textContent === name)!;
/** Picks `name` in Sharing & access' Showing access for. */
const showAccessFor = (name: string) =>
  click(
    [
      ...document.querySelectorAll(
        '[role="menu"][aria-label="Showing access for"] [role^="menuitem"]',
      ),
    ].find((option) => option.textContent === name)!,
  );

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
  await show(SharingSettings);

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
  await show(SharingSettings);
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
  await show(SharingSettings);
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
});

test("an account computer this app has no device for has a card, and its Remove asks first", async () => {
  relay = true;
  await show(ConnectionSettings);
  // It's listed once, and its menu's Remove frees its place on the account.
  const card = cardOf("relay:b")!;
  expect(card.textContent).toContain("On your account");
  await click(card.querySelector('[role="menuitem"]')!);
  // It asks first, and Cancel keeps the computer.
  const dialog = card.querySelector("dialog")!;
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
  await show(SharingSettings);
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
  await show(SharingSettings);
  // Showing access for picks whose settings the page shows: this computer's at first.
  expect(document.querySelector('[data-setting="pair-computers-on-this-network"]')).not.toBeNull();
  const toggle = (name: string) =>
    document.querySelector<HTMLButtonElement>(
      `[role="switch"][aria-label="Let agents on my other computers work on ${name}"]`,
    )!;
  const row = () => document.querySelector('[data-setting="agents-can-work-here"]')!;
  await showAccessFor("old-box");
  expect(row().textContent).toContain("Needs updating");
  expect(toggle("old-box").disabled).toBe(true);
  await showAccessFor("allow-box");
  expect(row().textContent).toContain("Added with Allow");
  expect(toggle("allow-box").disabled).toBe(true);
  await showAccessFor("fine-box");
  expect(toggle("fine-box").disabled).toBe(false);
  // One that can says what turning it on allows, at the switch.
  expect(row().textContent).toContain(
    "Agents on your other computers can run commands on fine-box as you. Turning this on also turns on pairing there.",
  );
  // Another computer's page has none of this computer's own switches.
  expect(document.querySelector('[data-setting="pair-computers-on-this-network"]')).toBeNull();
});

test("every setting a search finds on Computers or Sharing & access is on that page", async () => {
  // With everything on and signed in, and with pairing off, nothing paired and signed out.
  for (const on of [true, false]) {
    remote = on;
    relay = on;
    agentWork = false;
    profile = on ? signedIn : null;
    window.parallax.connectionState = async () => ({
      ...connected,
      capabilities: { agentWork: {} },
    });
    for (const [section, Page] of [
      ["connections", ConnectionSettings],
      ["sharing", SharingSettings],
    ] as const) {
      await show(Page);
      const found = searchSettings("").filter((r) => r.section === section && r.anchor);
      expect(found.map((r) => r.title)).toEqual(
        expect.arrayContaining(
          section === "connections"
            ? ["SSH hosts", "Add computer", "Load Balancer"]
            : ["Same network", "Devices with access", "Pair a device", "Setup code", "Tailscale"],
        ),
      );
      for (const { title, anchor } of found)
        expect(document.querySelector(`[data-setting="${anchor}"]`), title).not.toBeNull();
      act(() => unmount());
    }
  }
  // Nothing still points at the one page there was.
  expect(searchSettings("reach from anywhere")[0]).toMatchObject({ section: "sharing" });
  expect(searchSettings("ssh hosts")[0]).toMatchObject({ section: "connections" });
});

test("a computer removed from its card doesn't come back as one the app has no device for", async () => {
  relay = true;
  devices = [device("account:b", "macbook-b")];
  // Main takes it off the relay, then tells the windows it's gone.
  const removeDevice = vi.fn(async (): Promise<string | undefined> => {
    relayHosts = relayHosts.filter((h) => h.hostId !== "b");
    showDevices([]);
    return undefined;
  });
  window.parallax.removeDevice = removeDevice;
  await show(ConnectionSettings);
  expect(cardOf("relay:b")).toBeNull();

  await click(inCard("account:b", "Remove…"));
  await click(inCard("account:b", "Remove"));
  expect(removeDevice).toHaveBeenCalledWith("account:b");
  expect(cardOf("account:b")).toBeNull();
  expect(cardOf("relay:b")).toBeNull();
});

test("the code dialog a card opens follows the computer to its next step", async () => {
  window.parallax.connectionState = async (id) =>
    id === "local" ? connected : { status: "connecting" };
  window.parallax.answerCompare = () => new Promise(() => {});
  const newbox = (step: "compare" | "confirm") =>
    device("account:new", "newbox", { access: { step, code: "482913" } });
  devices = [newbox("compare")];
  await show(ConnectionSettings);
  await click(inCard("account:new", "Compare code"));
  const dialog = () =>
    [...document.querySelectorAll("dialog[open]")].find((d) => d.textContent?.includes("482 913"))!;
  expect(dialog().textContent).toContain("Allow it only if newbox shows this code");

  // Allowed here, it waits on newbox, and says what to do there.
  await act(async () => showDevices([newbox("confirm")]));
  expect(dialog().textContent).toContain("Press Enter in newbox's terminal");

  // It connects another way, so there's no code to take. Asking again later opens nothing by itself.
  await act(async () => showDevices([device("account:new", "newbox")]));
  expect(dialog()).toBeUndefined();
  await act(async () => showDevices([newbox("compare")]));
  expect(dialog()).toBeUndefined();
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
  await show(SharingSettings);
  await click(button("Sign in"));
  const toggle = document.querySelector('[role="switch"][aria-label="Reach from anywhere"]')!;
  expect(toggle.getAttribute("aria-checked")).toBe("true");
  expect(document.body.textContent).toContain("Connected to the relay.");
  expect(button("Check connection")).toBeDefined();
});

/** Signs in from the row, with plxd turning the relay on `after` ms later, or never. */
async function signInSlowly(after?: number) {
  signIn.mockImplementation(async () => {
    if (after !== undefined) setTimeout(() => (relay = true), after);
    profile = signedIn;
    for (const listener of profileListeners) listener(profile);
    return undefined;
  });
  await click(button("Sign in"));
}
const settingsReads = () =>
  request.mock.calls.filter(([, method]) => method === "host/settings/get").length;
/** Lets `ms` pass half a second at a time, so each timer's update renders before the next. */
const pass = async (ms: number) => {
  for (let t = 0; t < ms; t += 500)
    await act(async () => void (await vi.advanceTimersByTimeAsync(500)));
};

test("after a sign-in, the page reads the settings until Reach from anywhere is on, then stops", async () => {
  vi.useFakeTimers();
  profile = null;
  await show(SharingSettings);
  await signInSlowly(2000);
  const toggle = () => document.querySelector('[role="switch"][aria-label="Reach from anywhere"]')!;
  // The read at the sign-in and the one 1.5 s later are both too early.
  await pass(1500);
  expect(toggle().getAttribute("aria-checked")).toBe("false");
  await pass(1500);
  expect(toggle().getAttribute("aria-checked")).toBe("true");
  const reads = settingsReads();
  await pass(10_000);
  expect(settingsReads()).toBe(reads);
});

test("the reads after a sign-in stop after half a minute, and at a sign-out", async () => {
  vi.useFakeTimers();
  profile = null;
  await show(SharingSettings);
  await signInSlowly();
  await pass(30_000);
  const reads = settingsReads();
  expect(reads).toBeGreaterThan(10);
  await pass(10_000);
  expect(settingsReads()).toBe(reads);

  // Signed in again, it reads again, and a sign-out stops it.
  const signOut = () =>
    act(async () => {
      for (const listener of profileListeners) listener(null);
    });
  await signOut();
  await act(async () => {
    for (const listener of profileListeners) listener(signedIn);
  });
  await pass(3000);
  expect(settingsReads()).toBeGreaterThan(reads);
  await signOut();
  const after = settingsReads();
  await pass(10_000);
  expect(settingsReads()).toBe(after);
});

test("removing an SSH host or a paired computer asks first", async () => {
  const studio = hosts[0]!.id;
  hosts = [...hosts, { id: "ssh-1", name: "devbox", destination: "ryan@devbox" }];
  await show(ConnectionSettings);
  for (const id of [studio, "ssh-1"]) {
    await click(inCard(id, "Remove…"));
    expect(cardOf(id)!.querySelector("dialog[open]")!.textContent).toContain(
      "Parallax here stops connecting to it",
    );
    await click(inCard(id, "Cancel"));
    expect(removeHost).not.toHaveBeenCalledWith(id);
    await click(inCard(id, "Remove…"));
    await click(inCard(id, "Remove"));
    expect(removeHost).toHaveBeenCalledWith(id);
  }
});

test("Update plxd asks first, says what it stops, and stops asking once it isn't needed", async () => {
  hosts = [{ id: "ssh-1", name: "devbox", destination: "ryan@devbox" }];
  const older = { ...connected, plxd: "0.3.0" };
  window.parallax.connectionState = async (id) => (id === "ssh-1" ? older : connected);
  await show(ConnectionSettings);
  const warning = () => cardOf("ssh-1")!.querySelector('[role="alert"]');
  await click(inCard("ssh-1", "Update plxd"));
  expect(installPlxd).not.toHaveBeenCalled();
  expect(warning()!.textContent).toBe(
    "Updating restarts plxd there, which stops its running agents.",
  );
  await click(inCard("ssh-1", "Cancel"));
  expect(warning()).toBeNull();
  expect(installPlxd).not.toHaveBeenCalled();

  // It updates by itself while the question is up: nothing is left to confirm.
  await click(inCard("ssh-1", "Update plxd"));
  await act(async () => {
    for (const listener of stateListeners) listener("ssh-1", connected);
  });
  expect(warning()).toBeNull();
  expect(inCard("ssh-1", "Update plxd")).toBeUndefined();

  await act(async () => {
    for (const listener of stateListeners) listener("ssh-1", older);
  });
  await click(inCard("ssh-1", "Update plxd"));
  await click(inCard("ssh-1", "Update plxd"));
  expect(installPlxd).toHaveBeenCalledWith("ssh-1");
});

test("this computer's failure is printed in its Version row, not left to a tooltip", async () => {
  window.parallax.connectionState = async () => ({
    status: "failed",
    retrying: false,
    error: { reason: "exited", message: "plxd exited: its database is locked." },
  });
  await show(SharingSettings);
  expect(document.querySelector('[data-setting="version"]')!.textContent).toContain(
    "plxd exited: its database is locked.",
  );
});

test("Sharing & access opened just after a sign-in on Computers still waits for Reach from anywhere", async () => {
  vi.useFakeTimers();
  profile = null;
  await show(ConnectionSettings);
  // Add computer's Sign in. plxd turns the relay on two seconds later.
  signIn.mockImplementation(async () => {
    setTimeout(() => (relay = true), 2000);
    profile = signedIn;
    for (const listener of profileListeners) listener(profile);
    return undefined;
  });
  await click(
    [...document.querySelectorAll('[role="menuitem"]')].find((item) =>
      item.textContent?.startsWith("Sign in to Parallax"),
    )!,
  );
  act(() => unmount());
  await show(SharingSettings);
  const toggle = () => document.querySelector('[role="switch"][aria-label="Reach from anywhere"]')!;
  expect(toggle().getAttribute("aria-checked")).toBe("false");
  await pass(3000);
  expect(toggle().getAttribute("aria-checked")).toBe("true");
});

test("a card opens to its routes, and an account computer's can be moved, added and removed", async () => {
  devices = [
    device("account:b", "build-box", {
      routes: ["192.168.1.20:7341", "box.example.com:7400", "relay:b"],
      addedRoutes: ["box.example.com:7400"],
      route: "192.168.1.20:7341",
    }),
  ];
  await show(ConnectionSettings);
  // Each card's summary counts its routes, and that count opens them.
  const routes = (id: string) =>
    [...cardOf(id)!.querySelectorAll("li[data-route]")].map((li) => li.textContent);
  expect(routes("account:b")).toEqual([]);
  await click(cardOf("account:b")!.querySelector('[aria-label="3 routes to build-box"]')!);
  expect(routes("account:b")).toEqual([
    "Same network192.168.1.20:7341 · Connected",
    "Directbox.example.com:7400 · Added",
    "Parallax Relay",
  ]);
  const labelled = (label: string) =>
    cardOf("account:b")!.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);
  await click(labelled("Move Parallax Relay up")!);
  expect(editRoutes).toHaveBeenCalledWith("account:b", { move: "relay:b", by: -1 });
  // Only a route the user added can be removed.
  expect(labelled("Remove Parallax Relay")).toBeNull();
  await click(labelled("Remove box.example.com:7400")!);
  expect(editRoutes).toHaveBeenCalledWith("account:b", { remove: "box.example.com:7400" });
  // Add route asks for an address, and says why one won't do.
  editRoutes.mockResolvedValueOnce("Enter an address, with a port if it isn't 7341.");
  await click(inCard("account:b", "Add route"));
  await click(inCard("account:b", "Add"));
  expect(editRoutes).toHaveBeenCalledWith("account:b", { add: "" });
  expect(cardOf("account:b")!.querySelector('[role="alert"]')!.textContent).toContain(
    "Enter an address",
  );

  // A paired computer's routes are only listed.
  const studio = hosts[0]!.id;
  await click(cardOf(studio)!.querySelector('[aria-label="1 route to studio"]')!);
  expect(routes(studio)).toEqual(["Same network192.168.1.20 · Connected"]);
  expect(cardOf(studio)!.querySelector('button[aria-label^="Move"]')).toBeNull();
});
