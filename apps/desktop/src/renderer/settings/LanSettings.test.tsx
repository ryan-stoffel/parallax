// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vite-plus/test";

import type { ConnectionState, ParallaxBridge, SavedHost } from "../../preload/bridge";
import { LanSettings } from "./LanSettings";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const connected: ConnectionState = {
  status: "connected",
  plxd: "0.4.0",
  protocol: 1,
  capabilities: {},
};
let remote = false;
let remoteWeb = false;
let relay = false;
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
        sessions: [],
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
afterEach(() => act(() => unmount()));

const settle = async () => {
  for (let i = 0; i < 10; i++) await act(async () => {});
};
const button = (name: string) =>
  [...document.querySelectorAll("button")].find((b) => b.textContent === name)!;
const click = async (element: Element) => {
  await act(async () => (element as HTMLElement).click());
  await settle();
};
const type = async (label: string, value: string) => {
  const input = document.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
};

test("the switch turns pairing on, Pair a device shows a code, and Add computer pairs with one found or typed", async () => {
  const root = createRoot(document.body.appendChild(document.createElement("div")));
  act(() => root.render(<LanSettings />));
  unmount = () => {
    root.unmount();
    document.body.innerHTML = "";
  };
  await settle();
  const toggle = document.querySelector('[role="switch"]')!;
  expect(toggle.getAttribute("aria-checked")).toBe("false");
  expect(document.body.textContent).toContain("192.168.1.20");
  await click(toggle);
  expect(request).toHaveBeenCalledWith("local", "host/settings/set", { remote: true });
  expect(document.body.textContent).toContain("full control of this one");
  await click(button("Pair a device"));
  expect(document.querySelector('[aria-label="Pairing code"]')?.textContent).toBe("7KQ-4M2");
  // Open in a browser serves the app at the addresses the code reaches, off until turned on.
  const web = document.querySelector('[role="switch"][aria-label="Open in a browser"]')!;
  expect(web.getAttribute("aria-checked")).toBe("false");
  expect(document.body.textContent).toContain("https://192.168.1.20:7341");
  expect(document.querySelector('[aria-label="Certificate fingerprint"]')?.textContent).toBe(
    Array(32).fill("AB").join(" "),
  );
  await click(web);
  expect(request).toHaveBeenCalledWith("local", "host/settings/set", { remoteWeb: true });
  expect(web.getAttribute("aria-checked")).toBe("true");

  // Add computer finds the computers showing a code, by name, and picks the only one.
  await click(button("Add computer"));
  expect(button("studio").getAttribute("aria-checked")).toBe("true");
  await type("Code", "7kq-4m2");
  await click(button("Pair"));
  expect(pairLan).toHaveBeenCalledWith({ found: "0" }, "7kq-4m2");

  // An address typed in, for when mDNS can't find it.
  await click(button("Add computer"));
  await click(button("Enter an address instead"));
  await type("Address", "192.168.1.30");
  await type("Code", "7KQ4M2");
  await click(button("Pair"));
  expect(pairLan).toHaveBeenLastCalledWith({ address: "192.168.1.30" }, "7KQ4M2");
});

test("Reach from anywhere registers this computer with the relay before turning it on", async () => {
  remote = true;
  const root = createRoot(document.body.appendChild(document.createElement("div")));
  act(() => root.render(<LanSettings />));
  unmount = () => {
    root.unmount();
    document.body.innerHTML = "";
  };
  await settle();
  const toggle = document.querySelector('[role="switch"][aria-label="Reach from anywhere"]')!;
  expect(toggle.getAttribute("aria-checked")).toBe("false");

  // Signed out: nothing changes, and the switch says why.
  registerRelay.mockResolvedValueOnce("Sign in to Parallax from Profile in the sidebar first.");
  await click(toggle);
  expect(request).not.toHaveBeenCalledWith("local", "host/settings/set", { relay: true });
  expect(document.querySelector('[role="alert"]')?.textContent).toContain("Sign in");

  await click(toggle);
  expect(registerRelay).toHaveBeenCalledTimes(2);
  expect(request).toHaveBeenCalledWith("local", "host/settings/set", { relay: true });
  expect(toggle.getAttribute("aria-checked")).toBe("true");
  expect(document.body.textContent).toContain("Connected to the relay.");

  // The account's computers on the relay, each with Remove, which frees its place.
  expect(document.body.textContent).toContain("On the relay, this computer. Connected.");
  await click(document.querySelectorAll('[aria-label="Remove macbook from the relay"]')[1]!);
  // It asks first, and Cancel keeps the computer.
  expect(document.body.textContent).toContain(
    "until its Reach from anywhere switch is turned back on",
  );
  expect(removeRelayHost).not.toHaveBeenCalled();
  await click(button("Cancel"));
  expect(removeRelayHost).not.toHaveBeenCalled();
  await click(document.querySelectorAll('[aria-label="Remove macbook from the relay"]')[1]!);
  // The confirming Remove is the one without the row's label.
  const confirmRemove = [...document.querySelectorAll("button")].find(
    (b) => b.textContent === "Remove" && !b.hasAttribute("aria-label"),
  )!;
  await click(confirmRemove);
  expect(removeRelayHost).toHaveBeenCalledWith("b");
  expect(document.querySelectorAll('[aria-label="Remove macbook from the relay"]')).toHaveLength(1);
});
