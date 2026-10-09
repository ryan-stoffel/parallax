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
let hosts: SavedHost[] = [];
const request = vi.fn(async (_host: string, method: string, params: { remote?: boolean }) => {
  if (method === "host/settings/get") return { result: { autoResume: true, remote }, logId: "log" };
  if (method === "host/settings/set") {
    remote = params.remote ?? remote;
    return { result: { autoResume: true, remote }, logId: "log" };
  }
  if (method === "remote/pair")
    return {
      result: { code: "7KQ-4M2", expiresAt: "", name: "macbook", addresses: ["192.168.1.20"] },
      logId: "log",
    };
  if (method === "remote/sessions")
    return { result: { sessions: [], listening: remote }, logId: "log" };
  return { error: { code: -32601, message: "no" } };
});
const pairLan = vi.fn(async () => undefined);
const discoverLan = vi.fn(async () => [{ id: "0", name: "studio" }]);

beforeEach(() => {
  remote = false;
  hosts = [{ id: `lan:${"ab".repeat(32)}`, name: "studio", routes: ["192.168.1.20"] }];
  request.mockClear();
  pairLan.mockClear();
  window.parallax = {
    platform: "darwin",
    request: request as unknown as ParallaxBridge["request"],
    pairLan,
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
