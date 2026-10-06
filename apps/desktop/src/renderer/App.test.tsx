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
  onConnect: () => () => {},
  onDevices: () => () => {},
  onLocalName: (listener: (name: string) => void) => {
    listener("This Mac");
    return () => {};
  },
  setZoom: () => {},
  openTargets: async () => [],
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
  expect(crumbs()).toEqual(["Settings", "Usage"]);
  act(() =>
    [...document.querySelectorAll<HTMLButtonElement>("#sidebar button")]
      .find((b) => b.textContent === "Back to app")!
      .click(),
  );

  const title = [...document.querySelectorAll<HTMLButtonElement>("#sidebar button")].find(
    (b) => b.textContent === "Parallax",
  )!;
  act(() => title.click());
  expect(crumbs().at(-1)).toBe("New thread");
});

test("Mod+S toggles the sidebar, and Mod+Alt+U opens Settings > Usage", () => {
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
  expect(crumbs.map((li) => li.textContent)).toEqual(["Settings", "Usage"]);
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

test("the footer's Usage opens Settings > Usage, and Update shows when it's ready and its answer", async () => {
  const button = (name: string) =>
    document.querySelector<HTMLButtonElement>(`#sidebar button[aria-label="${name}"]`);
  renderApp();
  // Update is only for `pnpm dev`.
  expect(button("Update Parallax")).toBeNull();

  act(() => button("Usage")!.click());
  const crumbs = [...document.querySelectorAll('[aria-label="Breadcrumb"] li')];
  expect(crumbs.map((li) => li.textContent)).toEqual(["Settings", "Usage"]);
  // Settings' nav lists it after Account, and the side panel is a chat's.
  const nav = [...document.querySelectorAll("#sidebar button")].map((b) => b.textContent);
  expect(nav.slice(nav.indexOf("Account"), nav.indexOf("Account") + 2)).toEqual([
    "Account",
    "Usage",
  ]);
  expect(document.querySelector('main [aria-controls="side-panel"]')).toBeNull();
  // The range stays in the header on Limits, but can't be changed there.
  const range = document.querySelector<HTMLFieldSetElement>('main [aria-label="Usage range"]')!;
  expect(range.disabled).toBe(false);
  act(() => document.querySelector<HTMLInputElement>('main input[value="limits"]')!.click());
  expect(range.disabled).toBe(true);
  act(() => unmount());

  let answer: (text: string) => void = () => {};
  // The Update button and its notifications each listen.
  const listeners: ((state: UpdateState) => void)[] = [];
  const publish = (state: UpdateState) => listeners.forEach((listener) => listener(state));
  const update = vi.fn(() => new Promise<string>((resolve) => (answer = resolve)));
  Object.assign(bridge, {
    updatable: true,
    update,
    onUpdateState: (listener: (state: UpdateState) => void) => {
      listeners.push(listener);
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

test("a packaged app's release shows its notes on hover, downloads on click, then waits for a restart", () => {
  vi.useFakeTimers();
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
  const available = {
    version: "2610.10205.13230-nightly",
    notes: "• feat: a thing (PLX-1)",
    url: "https://github.com/ryan-stoffel/parallax/releases/tag/v2610.10205.13230-nightly",
  };
  act(() => publish({ available }));
  const offered = button("Update available: Parallax 2610.10205.13230-nightly")!;
  const dot = () => offered.querySelector(".bg-accent");
  expect(dot()).not.toBeNull();
  const card = document.querySelector<HTMLElement>('#sidebar [aria-label="Update"]')!;
  const isOpen = () => card.hasAttribute("data-open");
  const pointer = (type: string, target: Element, relatedTarget: Element | null) =>
    act(() => {
      target.dispatchEvent(new PointerEvent(type, { bubbles: true, relatedTarget }));
      vi.advanceTimersByTime(200);
    });

  // Hovering opens the card with the notes, and nothing downloads.
  pointer("pointerover", offered, document.body);
  expect(isOpen()).toBe(true);
  expect(card.textContent).toContain("Parallax 2610.10205.13230-nightly");
  expect(card.textContent).toContain("• feat: a thing (PLX-1)");
  expect(card.querySelector("a")!.href).toBe(available.url);
  expect(update).not.toHaveBeenCalled();
  // The pointer can move onto the card, and leaving the card closes it.
  pointer("pointerout", offered, card);
  pointer("pointerover", card, offered);
  expect(isOpen()).toBe(true);
  pointer("pointerout", card, document.body);
  expect(isOpen()).toBe(false);

  // A click opens the card and downloads, and the dot goes away.
  act(() => offered.click());
  expect(isOpen()).toBe(true);
  expect(update).toHaveBeenCalledOnce();
  act(() => publish({ available, progress: 42 }));
  expect(card.querySelector('[role="progressbar"]')!.getAttribute("aria-valuenow")).toBe("42");
  expect(offered.getAttribute("aria-label")).toBe(
    "Downloading Parallax 2610.10205.13230-nightly: 42%",
  );
  expect(dot()).toBeNull();

  // Downloaded: a restart icon and a notification, but no dialog until the click.
  const confirm = document.querySelector('button[value="confirm"]')!.closest("dialog")!;
  const toast = () => document.querySelector<HTMLElement>('[aria-label="Notifications"]');
  expect(toast()).toBeNull();
  const ready = { available, ready: `Parallax ${available.version} to install` };
  act(() => publish(ready));
  expect(isOpen()).toBe(false);
  expect(confirm.open).toBe(false);
  expect(toast()!.textContent).toContain("Update downloaded");
  expect(toast()!.querySelector("a")!.href).toBe(available.url);
  // It stays until closed, and the same download doesn't bring it back.
  act(() => void vi.advanceTimersByTime(60_000));
  act(() => toast()!.querySelector<HTMLButtonElement>('button[aria-label="Close"]')!.click());
  expect(toast()).toBeNull();
  act(() => publish({ ...ready }));
  expect(toast()).toBeNull();

  act(() => button("Restart to install Parallax 2610.10205.13230-nightly")!.click());
  expect(confirm.open).toBe(true);
  expect(confirm.textContent).toContain(
    "Install update 2610.10205.13230-nightly and restart Parallax?",
  );
  act(() => confirm.querySelector<HTMLButtonElement>('button[value="confirm"]')!.click());
  expect(update).toHaveBeenCalledTimes(2);
  vi.useRealTimers();
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
