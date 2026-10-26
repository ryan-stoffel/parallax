// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, test, vi } from "vite-plus/test";

import type { UpdateState, ParallaxBridge } from "../preload/bridge";
import { App } from "./App";
import { terminalAppShortcut } from "./ui";
import { updatePrefs, updateRun } from "./updateEverything";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
// Only what the frame calls, so new bridge methods don't break this stub.
const bridge: Partial<ParallaxBridge> = {
  platform: "darwin",
  version: async () => "0.0.0",
  request: async () => ({ error: { code: -32601, message: "Not in this test." } }),
  setThemeSource: vi.fn(),
  connectionState: async () => ({ status: "connecting" }),
  onConnectionState: () => () => {},
  onHostUpdate: () => () => {},
  hosts: async () => [],
  onHosts: () => () => {},
  onConnect: () => () => {},
  onDevices: () => () => {},
  onLocalName: (listener: (name: string) => void) => {
    listener("This Mac");
    return () => {};
  },
  setZoom: () => {},
  openTargets: async () => [],
  terminalApps: async () => [],
  terminalApp: async () => null,
  openTargetIcons: async () => ({}),
  onProfile: () => () => {},
};
window.parallax = bridge as ParallaxBridge;
// happy-dom has no popovers. `togglePopover` marks an open one `data-open`.
HTMLElement.prototype.showPopover = () => {};
HTMLElement.prototype.hidePopover = () => {};
HTMLElement.prototype.togglePopover = function (this: HTMLElement, options) {
  const force = typeof options === "boolean" ? options : options?.force;
  return this.toggleAttribute("data-open", force);
};

let unmount = () => {};
afterEach(() => {
  act(() => unmount());
  delete bridge.updatable;
  delete bridge.update;
  delete bridge.onUpdateState;
  updateRun.set({ statuses: {}, taken: undefined, tried: new Set() });
});

function renderApp() {
  const root = createRoot(document.body.appendChild(document.createElement("div")));
  act(() => root.render(<App />));
  unmount = () => root.unmount();
}

test("a packaged app's release downloads only once it's confirmed, then restarts to install", async () => {
  const button = (name: string) =>
    document.querySelector<HTMLButtonElement>(`#sidebar button[aria-label="${name}"]`);
  // The Update button and its notifications each listen.
  const listeners: ((state: UpdateState) => void)[] = [];
  const publish = (state: UpdateState) => listeners.forEach((listener) => listener(state));
  const update = vi.fn(async () => "");
  Object.assign(bridge, {
    updatable: true,
    update,
    onUpdateState: (listener: (state: UpdateState) => void) => {
      listeners.push(listener);
      return () => {};
    },
  });
  renderApp();
  await act(async () => {});
  const available = {
    version: "2610.10205.13230-nightly",
    notes: "• feat: a thing (PLX-1)",
    url: "https://github.com/ryan-stoffel/parallax/releases/tag/v2610.10205.13230-nightly",
  };
  act(() => publish({ available }));

  // A click opens the review dialog, and nothing downloads until it's confirmed.
  const confirm = document.querySelector('button[value="confirm"]')!.closest("dialog")!;
  await act(async () => button("Update available: Parallax 2610.10205.13230-nightly")!.click());
  expect(confirm.open).toBe(true);
  expect(update).not.toHaveBeenCalled();
  await act(async () =>
    confirm.querySelector<HTMLButtonElement>('button[value="confirm"]')!.click(),
  );
  expect(update).toHaveBeenCalledOnce();

  // Downloaded, Update restarts to install it.
  await act(async () => publish({ available, ready: `Parallax ${available.version} to install` }));
  expect(update).toHaveBeenCalledTimes(2);
});

test("with automatic downloads on, a release downloads once on its own", () => {
  const prefs = updatePrefs.get();
  updatePrefs.set({ ...prefs, autoDownload: true });
  const listeners: ((state: UpdateState) => void)[] = [];
  const publish = (state: UpdateState) => listeners.forEach((listener) => listener(state));
  const update = vi.fn(async () => "");
  Object.assign(bridge, {
    updatable: true,
    update,
    onUpdateState: (listener: (state: UpdateState) => void) => {
      listeners.push(listener);
      return () => {};
    },
  });
  renderApp();
  const available = { version: "2610.10205.13230-nightly", notes: "", url: "https://x" };
  act(() => publish({ available }));
  expect(update).toHaveBeenCalledOnce();
  // A failed download isn't tried again on the next check.
  act(() => publish({ available, note: "Update failed: reset" }));
  act(() => publish({ available }));
  expect(update).toHaveBeenCalledOnce();
  updatePrefs.set(prefs);
});

test("in a terminal off macOS, plain Ctrl+letter shortcuts stay the shell's", () => {
  bridge.platform = "linux";
  const press = (init: KeyboardEventInit) =>
    terminalAppShortcut(new KeyboardEvent("keydown", init));
  expect(press({ code: "KeyN", ctrlKey: true })).toBe(false);
  expect(press({ code: "KeyS", ctrlKey: true })).toBe(false);
  expect(press({ code: "KeyN", ctrlKey: true, shiftKey: true })).toBe(true);
  expect(press({ code: "KeyJ", ctrlKey: true })).toBe(true);
  expect(press({ code: "Digit2", ctrlKey: true })).toBe(true);
  bridge.platform = "darwin";
  expect(press({ code: "KeyN", metaKey: true })).toBe(true);
});
