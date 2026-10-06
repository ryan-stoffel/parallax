// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vite-plus/test";

import type { ParallaxBridge, RpcResponse } from "../preload/bridge";
import type { AgentRun, Repo, Thread } from "../protocol/generated/protocol";
import { App } from "./App";

// Two threads side by side (PLX-587).

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
// happy-dom has no popovers. The menus' items are in the DOM either way.
HTMLElement.prototype.showPopover = () => {};
HTMLElement.prototype.hidePopover = () => {};

const parallax: Repo = {
  id: "r-parallax",
  name: "parallax",
  path: "/src/parallax",
  createdAt: "2026-10-01T09:00:00Z",
};
const thread = (id: string, minute: number, title: string): Thread => ({
  id,
  repo: parallax.id,
  title,
  createdAt: `2026-10-01T10:0${minute}:00Z`,
  seenAt: "2026-10-01T12:00:00Z",
});
const run = (id: string): AgentRun =>
  ({
    id,
    prompt: `${id} prompt`,
    status: "completed",
    backend: "claude",
    model: "claude-sonnet-5",
    createdAt: "2026-10-01T10:00:00Z",
    updatedAt: "2026-10-01T11:00:00Z",
  }) as AgentRun;

type Answer = (params: Record<string, unknown>) => RpcResponse<unknown>;
const answers: Record<string, Answer> = {
  "thread/list": () => ({
    result: {
      repos: [parallax],
      threads: [thread("a", 1, "Write the parser"), thread("b", 2, "Fix the README")],
      seq: 7,
    },
  }),
  "agent/list": () => ({ result: { runs: [run("a"), run("b")], seq: 7 } }),
  "project/list": () => ({ result: { projects: [], seq: 7 } }),
};
const request = vi.fn(async (_host: string, method: string, params: Record<string, unknown>) => {
  const answer = answers[method];
  return answer
    ? { logId: "log-1", ...answer(params) }
    : { error: { code: -32601, message: `${method} isn't faked` } };
});

beforeEach(() => {
  localStorage.clear();
  window.parallax = {
    onProfile: () => () => {},
    platform: "darwin",
    setThemeSource: vi.fn(),
    connectionState: async () => ({
      status: "connected",
      plxd: "0.1.0",
      protocol: 1,
      capabilities: {},
    }),
    onConnectionState: () => () => {},
    subscribe: () => () => {},
    request,
    nameThread: async () => ({}),
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
  } as Partial<ParallaxBridge> as ParallaxBridge;
});

let unmount = () => {};
afterEach(() => act(() => unmount()));

async function renderApp() {
  const root = createRoot(document.body.appendChild(document.createElement("div")));
  act(() => root.render(<App />));
  unmount = () => {
    root.unmount();
    document.body.innerHTML = "";
  };
  await settle();
}
const settle = async () => {
  for (let i = 0; i < 10; i++) await act(async () => {});
};
const click = async (element: Element | null | undefined) => {
  await act(async () => (element as HTMLElement).click());
  await settle();
};
const ctrl = async (code: string) => {
  await act(async () => {
    window.dispatchEvent(new KeyboardEvent("keydown", { code, ctrlKey: true }));
  });
  await settle();
};

const threadRow = (title: string) =>
  [...document.querySelectorAll('#sidebar li[data-kind="thread"]')].find(
    (li) => li.querySelector("[data-title]")?.textContent === title,
  )!;
const menuItem = (row: Element, label: string) =>
  [...row.querySelectorAll('[role="menuitem"]')].find((b) => b.textContent === label);
// Each side's title, the focused one starred.
const panes = () =>
  [...document.querySelectorAll("main section[data-pane]")].map(
    (p) => `${p.getAttribute("aria-label")}${p.hasAttribute("data-focused") ? "*" : ""}`,
  );
const group = () => document.querySelector('#sidebar ul[aria-label="Side by side"]');
const currentCrumb = () =>
  [...document.querySelectorAll('[aria-label="Breadcrumb"] li')].at(-1)?.textContent;

test("a thread opens beside the open one, and Ctrl+1 and Ctrl+2 move focus between them", async () => {
  await renderApp();
  // With no thread open, there's nothing to open beside.
  expect(menuItem(threadRow("Fix the README"), "Open side by side")).toBeUndefined();

  await click(threadRow("Write the parser").querySelector("button"));
  // Not on the open thread itself.
  expect(menuItem(threadRow("Write the parser"), "Open side by side")).toBeUndefined();
  await click(menuItem(threadRow("Fix the README"), "Open side by side"));

  expect(panes()).toEqual(["Write the parser", "Fix the README*"]);
  expect(currentCrumb()).toBe("Fix the README");
  expect(document.querySelectorAll('main [aria-label="Message"]')).toHaveLength(2);
  expect([...group()!.querySelectorAll("li")].map((li) => li.textContent)).toEqual([
    "⌃1Write the parser",
    "⌃2Fix the README",
  ]);

  await ctrl("Digit1");
  expect(panes()).toEqual(["Write the parser*", "Fix the README"]);
  expect(currentCrumb()).toBe("Write the parser");
  await ctrl("Digit2");
  expect(panes()).toEqual(["Write the parser", "Fix the README*"]);

  // Clicking in a side focuses it.
  await act(async () => {
    document
      .querySelector("main section[data-pane='0']")!
      .dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
  });
  await settle();
  expect(panes()).toEqual(["Write the parser*", "Fix the README"]);
});

test("closing a side, in its pane or the sidebar, leaves the other open alone", async () => {
  await renderApp();
  await click(threadRow("Write the parser").querySelector("button"));
  await click(menuItem(threadRow("Fix the README"), "Open side by side"));

  await click(
    document.querySelector("main section[data-pane='1'] button[aria-label='Close this side']"),
  );
  expect(panes()).toEqual([]);
  expect(group()).toBeNull();
  expect(currentCrumb()).toBe("Write the parser");
  expect(document.querySelectorAll('main [aria-label="Message"]')).toHaveLength(1);

  await click(menuItem(threadRow("Fix the README"), "Open side by side"));
  await click(group()!.querySelector("button[aria-label='Close Write the parser']"));
  expect(group()).toBeNull();
  expect(currentCrumb()).toBe("Fix the README");
});

test("opening another thread hides the split until one of its threads opens again", async () => {
  await renderApp();
  await click(threadRow("Write the parser").querySelector("button"));
  await click(menuItem(threadRow("Fix the README"), "Open side by side"));

  await click(
    [...document.querySelectorAll<HTMLButtonElement>("#sidebar button")].find(
      (b) => b.textContent === "Parallax",
    ),
  );
  expect(panes()).toEqual([]);
  expect(group()).not.toBeNull();

  await click(group()!.querySelector("button"));
  expect(panes()).toEqual(["Write the parser*", "Fix the README"]);
});
