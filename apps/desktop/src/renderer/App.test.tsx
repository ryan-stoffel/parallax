// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, test, vi } from "vite-plus/test";

import type { UpdateState, ParallaxBridge } from "../preload/bridge";
import { App } from "./App";
import { appShortcut, terminalAppShortcut } from "./ui";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
// Only what the frame calls, so new bridge methods don't break this stub.
const bridge: Partial<ParallaxBridge> = {
  platform: "darwin",
  setThemeSource: vi.fn(),
  connectionState: async () => ({ status: "connecting" }),
  onConnectionState: () => () => {},
  hosts: async () => [],
  onHosts: () => () => {},
  onLocalName: (listener: (name: string) => void) => {
    listener("This Mac");
    return () => {};
  },
  setZoom: () => {},
  setAppIcon: () => {},
  openTargets: async () => [],
  openTargetIcons: async () => ({}),
  onProfile: () => () => {},
};
window.parallax = bridge as ParallaxBridge;
// happy-dom has no popovers.
HTMLElement.prototype.showPopover = () => {};
HTMLElement.prototype.hidePopover = () => {};

let unmount = () => {};
afterEach(() => {
  act(() => unmount());
  delete bridge.updatable;
  delete bridge.update;
  delete bridge.onUpdateState;
});

function renderApp() {
  const root = createRoot(document.body.appendChild(document.createElement("div")));
  act(() => root.render(<App />));
  unmount = () => root.unmount();
}

test("the side panel toggle reports and flips the panel's state", () => {
  renderApp();
  // One toggle shows at a time: the main pane's while closed, the panel's while open.
  const toggle = () =>
    [...document.querySelectorAll<HTMLButtonElement>('[aria-controls="side-panel"]')].find(
      (b) => !b.closest("[hidden]"),
    )!;
  const panel = document.getElementById("side-panel")!;
  expect(toggle().getAttribute("aria-expanded")).toBe("false");
  expect(panel.hidden).toBe(true);

  act(() => toggle().click());
  expect(toggle().getAttribute("aria-expanded")).toBe("true");
  expect(panel.hidden).toBe(false);

  // Mod+Alt+B closes it again.
  act(() => {
    window.dispatchEvent(
      new KeyboardEvent("keydown", { code: "KeyB", metaKey: true, altKey: true }),
    );
  });
  expect(toggle().getAttribute("aria-expanded")).toBe("false");
  expect(panel.hidden).toBe(true);
});

test("the sidebar's title opens a new thread", () => {
  renderApp();
  const crumbs = () =>
    [...document.querySelectorAll('[aria-label="Breadcrumb"] li')].map((li) => li.textContent);
  act(() =>
    document.querySelector<HTMLButtonElement>('#sidebar button[aria-label="Usage"]')!.click(),
  );
  expect(crumbs()[0]).toBe("Usage");

  const title = [...document.querySelectorAll<HTMLButtonElement>("#sidebar button")].find(
    (b) => b.textContent === "Parallax",
  )!;
  act(() => title.click());
  expect(crumbs().at(-1)).toBe("New thread");
});

test("Mod+S toggles the sidebar, and Mod+Alt+U opens the Usage page", () => {
  renderApp();
  const press = (init: KeyboardEventInit) =>
    act(() => {
      window.dispatchEvent(new KeyboardEvent("keydown", { metaKey: true, ...init }));
    });
  const showSidebar = () => document.querySelector('main button[aria-label="Show sidebar"]');
  expect(showSidebar()).toBeNull();
  press({ code: "KeyS" });
  expect(showSidebar()).not.toBeNull();
  press({ code: "KeyS" });
  expect(showSidebar()).toBeNull();

  press({ code: "KeyU", altKey: true });
  const crumbs = [...document.querySelectorAll('[aria-label="Breadcrumb"] li')];
  expect(crumbs.map((li) => li.textContent)).toEqual(["Usage", "All hosts"]);
});

test("Ctrl+Shift+` toggles the terminal on macOS too, and Mod+Alt+O opens, not Mod+O or Mod+B", () => {
  const press = (init: KeyboardEventInit) => appShortcut(new KeyboardEvent("keydown", init));
  expect(press({ code: "Backquote", ctrlKey: true, shiftKey: true })).toBe("terminal");
  expect(press({ code: "Backquote", metaKey: true, shiftKey: true })).toBeUndefined();
  expect(press({ code: "KeyO", metaKey: true, altKey: true })).toBe("open");
  expect(press({ code: "KeyO", metaKey: true })).toBeUndefined();
  expect(press({ code: "KeyB", metaKey: true })).toBeUndefined();
  // With Shift they're free for repository actions.
  expect(press({ code: "KeyS", metaKey: true, shiftKey: true })).toBeUndefined();
  expect(press({ code: "KeyO", metaKey: true, altKey: true, shiftKey: true })).toBeUndefined();
});

test("the footer's Usage opens the Usage page, and Update shows when it's ready and its answer", async () => {
  const button = (name: string) =>
    document.querySelector<HTMLButtonElement>(`#sidebar button[aria-label="${name}"]`);
  renderApp();
  // Update is only for `pnpm dev`.
  expect(button("Update Parallax")).toBeNull();

  act(() => button("Usage")!.click());
  const crumbs = [...document.querySelectorAll('[aria-label="Breadcrumb"] li')];
  expect(crumbs.map((li) => li.textContent)).toEqual(["Usage", "All hosts"]);
  // The sidebar stays on the thread list, and the side panel is a chat's.
  expect(button("Usage")).not.toBeNull();
  expect(document.querySelector('main [aria-controls="side-panel"]')).toBeNull();
  // The range stays in the top bar on Limits, but can't be changed there.
  const range = document.querySelector<HTMLFieldSetElement>('main [aria-label="Usage range"]')!;
  expect(range.disabled).toBe(false);
  act(() => document.querySelector<HTMLInputElement>('main input[value="limits"]')!.click());
  expect(range.disabled).toBe(true);
  act(() => unmount());

  let answer: (text: string) => void = () => {};
  let publish: (state: UpdateState) => void = () => {};
  const update = vi.fn(() => new Promise<string>((resolve) => (answer = resolve)));
  Object.assign(bridge, {
    updatable: true,
    update,
    onUpdateState: (listener: (state: UpdateState) => void) => {
      publish = listener;
      return () => {};
    },
  });
  renderApp();
  // A background check's note, such as an error, is the button's label.
  act(() => publish({ note: "Can't reach GitHub to check for updates." }));
  expect(button("Can't reach GitHub to check for updates.")).not.toBeNull();
  // Under `pnpm dev`, a click takes main's commits, with the answer in the popover.
  act(() => publish({ ready: "3 commits to apply" }));
  act(() => button("Update ready: 3 commits to apply")!.click());
  const status = () =>
    document.querySelector('#sidebar [aria-label="Update"] [role="status"]')?.textContent;
  expect(status()).toBe("Updating…");
  expect(button("Update Parallax")!.disabled).toBe(true);
  await act(async () => answer("Updated to abc1234"));
  act(() => publish({}));
  expect(status()).toBe("Updated to abc1234");
  expect(button("Update Parallax")!.disabled).toBe(false);
});

test("a packaged app's release shows its notes and download in a popover, then asks to restart", () => {
  const button = (name: string) =>
    document.querySelector<HTMLButtonElement>(`#sidebar button[aria-label="${name}"]`);
  let publish: (state: UpdateState) => void = () => {};
  const update = vi.fn(async () => "");
  Object.assign(bridge, {
    updatable: true,
    update,
    onUpdateState: (listener: (state: UpdateState) => void) => {
      publish = listener;
      return () => {};
    },
  });
  renderApp();
  const available = {
    version: "2610.10205.13230-nightly",
    notes: "• feat: a thing (RYA-1)",
    url: "https://github.com/ryan-stoffel/parallax/releases/tag/v2610.10205.13230-nightly",
  };
  act(() => publish({ available }));
  // Nothing downloads until the click.
  expect(update).not.toHaveBeenCalled();
  act(() => button("Update available: Parallax 2610.10205.13230-nightly")!.click());
  expect(update).toHaveBeenCalledOnce();
  const popover = document.querySelector('#sidebar [aria-label="Update"]')!;
  expect(popover.textContent).toContain("Parallax 2610.10205.13230-nightly");
  expect(popover.textContent).toContain("• feat: a thing (RYA-1)");
  expect(popover.querySelector("a")!.href).toBe(available.url);

  act(() => publish({ available, progress: 42 }));
  expect(popover.querySelector('[role="progressbar"]')!.getAttribute("aria-valuenow")).toBe("42");

  const restart = document.querySelector('button[value="restart"]')!.closest("dialog")!;
  expect(restart.open).toBe(false);
  act(() => publish({ available, ready: `Parallax ${available.version} to install` }));
  expect(restart.open).toBe(true);
  act(() => restart.querySelector<HTMLButtonElement>('button[value="restart"]')!.click());
  expect(update).toHaveBeenCalledTimes(2);
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
