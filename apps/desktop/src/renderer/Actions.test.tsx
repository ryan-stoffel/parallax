// @vitest-environment happy-dom
import { act, useEffect, useRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vite-plus/test";

import type { ParallaxBridge } from "../preload/bridge";
import { Actions, readActions } from "./Actions";
import { keybindingOf } from "./keybindings";
import { runInDrawer, TerminalDrawer, type ThreadFolder } from "./ThreadTerminal";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
// happy-dom has no popovers. The menus are in the DOM either way.
HTMLElement.prototype.hidePopover = () => {};
HTMLElement.prototype.showPopover = () => {};

// xterm.js doesn't run in happy-dom: a terminal here starts as soon as it mounts, and `shell.exit`
// ends the last one started.
const shell = vi.hoisted(() => ({ exit: () => {} }));
vi.mock("./Terminal", () => ({
  TerminalView: ({ onStart, onEnd }: { onStart?: () => void; onEnd?: () => void }) => {
    // Once per mount, as the real one opens its terminal.
    const props = useRef({ onStart, onEnd });
    useEffect(() => {
      props.current.onStart?.();
      shell.exit = () => props.current.onEnd?.();
    }, []);
    return null;
  },
}));

const terminalInput = vi.fn();
beforeEach(() => {
  localStorage.clear();
  terminalInput.mockClear();
  window.parallax = {
    platform: "darwin",
    terminalInput,
    closeTerminal: () => {},
    extensions: () => Promise.resolve([]),
    onExtensionsChanged: () => () => {},
    downloads: async () => [],
    onDownloads: () => () => {},
    googleAccount: async () => undefined,
    onGoogleAccount: () => () => {},
    // `terminal/list`: plxd runs no terminals.
    request: () => Promise.resolve({ result: { terminals: [] }, logId: "log" }),
  } as Partial<ParallaxBridge> as ParallaxBridge;
});

let root: Root | undefined;
afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  document.body.innerHTML = "";
});

function render(node: React.ReactNode) {
  root ??= createRoot(document.body.appendChild(document.createElement("div")));
  act(() => root!.render(node));
}

const button = (name: string) =>
  [...document.querySelectorAll<HTMLButtonElement>("button")].find(
    (b) => b.textContent === name || b.getAttribute("aria-label") === name,
  )!;
const dialog = () => document.querySelector("dialog");
const field = (selector: string) => dialog()!.querySelector<HTMLInputElement>(selector)!;
const keybindingField = () => field('input[placeholder="Press a shortcut"]');
const fill = (el: HTMLInputElement | HTMLTextAreaElement, value: string) =>
  act(() => {
    Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), "value")!.set!.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
const press = (target: EventTarget, init: KeyboardEventInit) =>
  act(() => void target.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, ...init })));

test("a keybinding is its modifiers and key code, written the OS's way", () => {
  const e = (init: KeyboardEventInit) => new KeyboardEvent("keydown", init);
  expect(keybindingOf(e({ key: "T", code: "KeyT", metaKey: true, shiftKey: true }))).toBe(
    "Shift+Meta+KeyT",
  );
  // A lone modifier, or a press that would type, isn't one.
  expect(keybindingOf(e({ key: "Meta", code: "MetaLeft", metaKey: true }))).toBeUndefined();
  expect(keybindingOf(e({ key: "t", code: "KeyT", shiftKey: true }))).toBeUndefined();
  window.parallax = { platform: "linux" } as ParallaxBridge;
  // Off macOS, AltGr arrives as Ctrl+Alt and types a character.
  const altGr = e({ key: "@", code: "KeyQ", ctrlKey: true, altKey: true });
  altGr.getModifierState = (key: string) => key === "AltGraph";
  expect(keybindingOf(altGr)).toBeUndefined();
});

test("stored entries that aren't actions are dropped", () => {
  localStorage.setItem(
    "parallax:actions:local/r1",
    JSON.stringify([null, 3, { id: "a", name: "Test" }, { id: "b", name: "Dev", command: "x" }]),
  );
  expect(readActions("local", "r1").map((a) => a.id)).toEqual(["b"]);
});

test("Add action saves an action for the repository, refusing the app's shortcuts", () => {
  const onRun = vi.fn();
  render(<Actions hostId="local" repoId="r1" canRun onRun={onRun} />);
  act(() => button("Add action").click());
  expect(dialog()!.open).toBe(true);
  expect(button("Save action").disabled).toBe(true);

  fill(field('input[placeholder="Test"]'), "Test");
  fill(field("textarea"), "pnpm test");
  // Cmd+S is the sidebar's, and nothing else hears it while it's pressed here.
  const sidebar = vi.fn();
  window.addEventListener("keydown", sidebar);
  press(keybindingField(), { key: "s", code: "KeyS", metaKey: true });
  window.removeEventListener("keydown", sidebar);
  expect(sidebar).not.toHaveBeenCalled();
  press(keybindingField(), { key: "c", code: "KeyC", metaKey: true });
  press(keybindingField(), { key: "Enter", code: "Enter", metaKey: true });
  expect(keybindingField().value).toBe("");
  press(keybindingField(), { key: "t", code: "KeyT", metaKey: true, shiftKey: true });
  expect(keybindingField().value).toBe("⇧⌘T");
  press(keybindingField(), { key: "Backspace", code: "Backspace" });
  expect(keybindingField().value).toBe("");
  press(keybindingField(), { key: "t", code: "KeyT", metaKey: true, shiftKey: true });

  // The preview opens only with an http or https URL.
  const toggle = field('input[type="checkbox"]');
  expect(toggle.disabled).toBe(true);
  fill(field('input[placeholder="localhost:5173"]'), "file:///etc");
  expect(button("Save action").disabled).toBe(true);
  fill(field('input[placeholder="localhost:5173"]'), "localhost:5173");
  act(() => toggle.click());
  act(() => button("Save action").click());

  expect(dialog()).toBeNull();
  expect(readActions("local", "r1")).toEqual([
    {
      id: expect.any(String),
      icon: "play",
      name: "Test",
      command: "pnpm test",
      keybinding: "Shift+Meta+KeyT",
      previewUrl: "localhost:5173",
      openPreview: true,
    },
  ]);
  // Another repository has its own.
  expect(readActions("local", "r2")).toEqual([]);
});

test("a command waits for the drawer's shell to start, then runs in it", async () => {
  const folder: ThreadFolder = { key: "local/t1", hostId: "local", path: "/wt/t1", threadId: "t1" };
  const drawer = (open: boolean) => (
    <TerminalDrawer open={open} folder={folder} deleted={() => false} onClose={() => {}} />
  );
  render(drawer(false));
  runInDrawer(folder, "pnpm test");
  expect(terminalInput).not.toHaveBeenCalled();
  render(drawer(true));
  await act(async () => {});
  expect(terminalInput).toHaveBeenCalledWith("drawer:local/t1", "pnpm test\r");
  runInDrawer(folder, "pnpm dev");
  expect(terminalInput).toHaveBeenLastCalledWith("drawer:local/t1", "pnpm dev\r");

  // Once the shell exits, commands wait for Restart, which runs only the latest.
  act(() => shell.exit());
  runInDrawer(folder, "pnpm lint");
  runInDrawer(folder, "pnpm build");
  expect(terminalInput).toHaveBeenCalledTimes(2);
  act(() => button("Restart").click());
  expect(terminalInput).toHaveBeenCalledTimes(3);
  expect(terminalInput).toHaveBeenLastCalledWith("drawer:local/t1", "pnpm build\r");
});
