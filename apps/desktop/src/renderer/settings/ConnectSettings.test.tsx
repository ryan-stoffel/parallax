// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vite-plus/test";

import type {
  ConnectionState,
  ConnectState,
  DeviceHost,
  ParallaxBridge,
  TerminalTarget,
} from "../../preload/bridge";
import type { ConnectDevicesResult, TailnetDevice } from "../../protocol/generated/protocol";
import { ConnectSettings, uptime } from "./ConnectSettings";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
// happy-dom has no popovers or modal dialogs.
HTMLElement.prototype.hidePopover = () => {};
HTMLDialogElement.prototype.showModal = function (this: HTMLDialogElement) {
  this.open = true;
};

// xterm.js needs a real canvas. The stand-in names its target and ends with the exit code a test
// picks.
let exitCode = 0;
vi.mock("../Terminal", () => ({
  TerminalView: ({
    target,
    onEnd,
  }: {
    target: TerminalTarget;
    onEnd: (why?: string, code?: number) => void;
  }) => (
    <button
      type="button"
      data-target={JSON.stringify(target)}
      onClick={() => onEnd(undefined, exitCode)}
    >
      Finish
    </button>
  ),
}));

const device = (hostName: string, os: string, ip: string, extra: Partial<TailnetDevice> = {}) => ({
  id: `n-${hostName}`,
  hostName,
  dnsName: `${hostName}.tail.ts.net`,
  os,
  ip,
  online: true,
  parallax: false,
  ...extra,
});
const tailnet: ConnectDevicesResult = {
  tailscale: "running",
  port: 7340,
  listening: true,
  devices: [
    device("ryans-iphone", "iOS", "100.92.3.55"),
    device("mac-mini", "macOS", "100.74.190.83"),
    device("old-air", "macOS", "100.70.8.14", { online: false }),
    device("thinkpad-server", "linux", "100.88.40.21", { parallax: true }),
  ],
};

let connect: ConnectState;
const connectListeners = new Set<(state: ConnectState) => void>();
const announce = (state: ConnectState) => {
  connect = state;
  for (const l of connectListeners) l(state);
};
let devices: DeviceHost[];
const bridge = {
  installConnect: vi.fn(async () => {
    announce({ ...connect, installed: true });
    return undefined;
  }),
  setConnect: vi.fn(async (on: boolean) => {
    announce({ ...connect, on });
    return undefined;
  }),
  saveDevice: vi.fn(async () => undefined),
  setDeviceEnabled: vi.fn(async () => undefined),
  removeDevice: vi.fn(async () => undefined),
  renameLocal: vi.fn(async () => undefined),
};
const connected: ConnectionState = {
  status: "connected",
  plxd: "0.4.0",
  protocol: 1,
  capabilities: {},
};

beforeEach(() => {
  exitCode = 0;
  connect = { installed: false, on: false, icon: "laptop", channel: "nightly" };
  connectListeners.clear();
  devices = [];
  for (const fn of Object.values(bridge)) fn.mockClear();
  window.parallax = {
    platform: "darwin",
    ...bridge,
    onConnect: (listener: (state: ConnectState) => void) => {
      connectListeners.add(listener);
      listener(connect);
      return () => connectListeners.delete(listener);
    },
    onDevices: (listener: (list: DeviceHost[]) => void) => {
      listener(devices);
      return () => {};
    },
    hosts: async () => [],
    onHosts: () => () => {},
    onLocalName: (listener: (name: string) => void) => {
      listener("macbook");
      return () => {};
    },
    connectionState: async () => connected,
    onConnectionState: () => () => {},
    request: (async (_host: string, method: string) => {
      if (method === "connect/devices") return { result: tailnet, logId: "log" };
      if (method === "host/health")
        return { result: { uptimeSeconds: 7260, store: "ok", runningAgents: 2 }, logId: "log" };
      if (method === "host/version")
        return {
          result: {
            plxd: "0.4.0",
            protocol: { min: 1, max: 1 },
            os: "macOS 26.0",
            arch: "aarch64",
          },
          logId: "log",
        };
      return { error: { code: -32601, message: "no" } };
    }) as ParallaxBridge["request"],
  } as Partial<ParallaxBridge> as ParallaxBridge;
});

let unmount = () => {};
afterEach(() => act(() => unmount()));

async function render() {
  const root = createRoot(document.body.appendChild(document.createElement("div")));
  act(() => root.render(<ConnectSettings />));
  unmount = () => {
    root.unmount();
    document.body.innerHTML = "";
  };
  await settle();
}
const settle = async () => {
  for (let i = 0; i < 10; i++) await act(async () => {});
};
const button = (name: string) =>
  [...document.querySelectorAll("button")].find((b) => b.textContent === name)!;
const click = async (element: Element) => {
  await act(async () => (element as HTMLElement).click());
  await settle();
};

test("Install, then the switch turns Connect on and opens Add computer", async () => {
  await render();
  await click(button("Install"));
  expect(bridge.installConnect).toHaveBeenCalled();
  const toggle = document.querySelector('[role="switch"]')!;
  expect(toggle.getAttribute("aria-checked")).toBe("false");
  await click(toggle);
  expect(bridge.setConnect).toHaveBeenCalledWith(true);
  expect(document.querySelector("dialog h2")?.textContent).toBe("Add a computer");
});

test("Add computer lists the tailnet, sets one up in a terminal, and confirms", async () => {
  connect = { ...connect, installed: true, on: true };
  await render();
  await click(button("Add computer"));
  const rows = [...document.querySelectorAll('[aria-label="Your computers"] li')];
  // Online computers Parallax runs on first; a phone can't, and an offline one waits.
  expect(rows.map((r) => r.querySelector("p")?.textContent)).toEqual([
    "mac-mini",
    "thinkpad-server",
    "ryans-iphone",
    "old-air",
  ]);
  // It runs Connect but this app doesn't list it, so it's added rather than set up.
  await click(rows[1]!.querySelector("button")!);
  expect(bridge.setDeviceEnabled).toHaveBeenCalledWith("tailnet:n-thinkpad-server", true);
  expect(rows[2]!.textContent).toContain("Can't run Parallax");
  expect(rows[3]!.querySelector("button")?.disabled).toBe(true);

  await click(rows[0]!.querySelector("button")!);
  expect(document.querySelector("dialog")!.textContent).toContain("Signs in over SSH");
  const user = document.querySelector<HTMLInputElement>('input[name="user"]')!;
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(user, "ryan");
    user.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await click(button("Install"));
  const terminal = button("Finish");
  expect(JSON.parse(terminal.dataset["target"]!)).toEqual({
    hostId: "local",
    connect: { device: "100.74.190.83", user: "ryan" },
  });

  exitCode = 1;
  await click(terminal);
  expect(document.querySelector('[role="alert"]')?.textContent).toContain("wasn't set up");
  exitCode = 0;
  await click(button("Try again"));
  await click(button("Finish"));
  expect(document.querySelector("dialog h2")!.textContent).toBe("mac-mini is set up");
  expect(button("Add another computer")).toBeTruthy();
});

test("Devices show their health; the menu renames, changes the icon, and removes", async () => {
  connect = { installed: true, on: true, icon: "laptop", channel: "nightly" };
  devices = [
    {
      id: "tailnet:n-mini",
      name: "Mac mini",
      icon: "mini",
      detected: "mini",
      hostName: "mac-mini",
      ip: "100.74.190.83",
      os: "macOS",
      enabled: true,
    },
  ];
  await render();
  const row = document.querySelector('[data-device="tailnet:n-mini"]')!;
  expect(row.textContent).toContain("Mac mini");
  expect(row.textContent).toContain(
    "macOS 26.0 · aarch64 · 100.74.190.83 · Connected · plxd 0.4.0",
  );
  expect(row.textContent).toContain("up 2h 1m · 2 agents running");
  expect(document.querySelector('[data-device="local"]')?.textContent).toContain("This computer");

  const item = (name: string) =>
    [...row.querySelectorAll<HTMLElement>('[role^="menuitem"]')].find((b) =>
      b.textContent?.startsWith(name),
    )!;
  await click(item("Rename"));
  const name = row.querySelector<HTMLInputElement>('input[name="name"]')!;
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(name, "Studio");
    name.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await click(button("Save"));
  expect(bridge.saveDevice).toHaveBeenCalledWith("tailnet:n-mini", { name: "Studio" });

  // The icon its host name suggests is marked.
  expect(item("Mini PC").textContent).toContain("detected");
  await click(item("PC"));
  expect(bridge.saveDevice).toHaveBeenCalledWith("tailnet:n-mini", { icon: "desktop" });

  await click(row.querySelector('[role="switch"]')!);
  expect(bridge.setDeviceEnabled).toHaveBeenCalledWith("tailnet:n-mini", false);

  await click(item("Remove from this device"));
  await click(button("Remove"));
  expect(bridge.removeDevice).toHaveBeenCalledWith("tailnet:n-mini");
});

test("A device turned off can't be renamed or re-iconed, and reads Off", async () => {
  connect = { installed: true, on: true, icon: "laptop", channel: "nightly" };
  devices = [
    {
      id: "tailnet:n-pc",
      name: "Gaming PC",
      icon: "desktop",
      detected: "desktop",
      hostName: "ryans-gaming-pc",
      ip: "100.101.12.7",
      os: "windows",
      enabled: false,
    },
  ];
  await render();
  const row = document.querySelector('[data-device="tailnet:n-pc"]')!;
  expect(row.textContent).toContain("100.101.12.7 · Off");
  const items = [...row.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')];
  expect(items.filter((b) => b.disabled).map((b) => b.textContent)).toEqual(["Icon", "Rename"]);
  expect(items[0]!.title).toBe("Turn Gaming PC on to change it.");
});

test("uptime reads in days, hours, or minutes", () => {
  expect(uptime(59)).toBe("0m");
  expect(uptime(7260)).toBe("2h 1m");
  expect(uptime(93_780)).toBe("1d 2h");
});
