// @vitest-environment happy-dom
import { act, createRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vite-plus/test";

import type { ParallaxBridge } from "../preload/bridge";
import type { Thread } from "../protocol/generated/protocol";
import { CommandMenu, type CommandMenuHandle, type MenuItem } from "./CommandMenu";
import type { HostThreads } from "./Sidebar";
import { emptyThreads, idleThreads } from "./threads";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
HTMLDialogElement.prototype.showModal = function () {
  this.open = true;
};
HTMLDialogElement.prototype.close = function () {
  this.open = false;
  this.dispatchEvent(new Event("close"));
};

let root: Root | undefined;
const request = vi.fn();
beforeEach(() => {
  vi.useFakeTimers();
  window.parallax = { platform: "darwin", request } as Partial<ParallaxBridge> as ParallaxBridge;
});
afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  document.body.innerHTML = "";
  vi.useRealTimers();
  vi.clearAllMocks();
});

const thread = (id: string, at: string, over: Partial<Thread> = {}) =>
  ({ id, repo: "r1", createdAt: at, lastPromptAt: at, ...over }) as Thread;
const hosts: HostThreads[] = [
  {
    host: { id: "local", name: "This Mac" } as HostThreads["host"],
    view: {
      ...idleThreads,
      capabilities: { threadContext: {} },
      state: {
        ...emptyThreads,
        threads: [
          thread("t1", "2026-10-01T00:00:00Z"),
          thread("t2", "2026-10-02T00:00:00Z"),
          thread("t3", "2026-10-03T00:00:00Z"),
        ],
        titles: { t1: "Fix the login form", t2: "Command menu search", t3: "Release notes" },
      },
    },
  },
];

function render(actions: MenuItem[] = []) {
  const menu = createRef<CommandMenuHandle>();
  const props = {
    onOpenThread: vi.fn(),
    onOpenProject: vi.fn(),
    onOpenFile: vi.fn(),
    onThemeChange: vi.fn(),
  };
  root ??= createRoot(document.body.appendChild(document.createElement("div")));
  act(() =>
    root!.render(
      <CommandMenu
        ref={menu}
        hosts={hosts}
        actions={actions}
        repos={[]}
        files={{ hostId: "local", runId: "t2" }}
        grep
        theme="system"
        {...props}
      />,
    ),
  );
  act(() => menu.current!.open());
  return { menu, ...props };
}

const input = () => document.querySelector<HTMLInputElement>('[role="combobox"]')!;
const options = () =>
  [...document.querySelectorAll('[role="option"]')].map(
    (o) => o.querySelector("span.block")!.textContent,
  );
async function type(text: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input(), text);
    input().dispatchEvent(new Event("input", { bubbles: true }));
  });
}
const press = (key: string) =>
  act(() => {
    input().dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
  });
const wait = (ms: number) => act(() => vi.advanceTimersByTimeAsync(ms));

test("with no query it lists the actions, then the most recent threads", () => {
  render([{ id: "a", label: "Change theme", text: "Change theme", icon: null, page: "theme" }]);
  expect(options()).toEqual([
    "Change theme",
    "Release notes",
    "Command menu search",
    "Fix the login form",
  ]);
});

test("typing ranks threads fuzzily, adds message matches, and Enter opens the first", async () => {
  request.mockResolvedValue({
    result: {
      threads: [{ id: "t3" }],
      snippets: { t3: "…we should search the menu…" },
    },
  });
  const { onOpenThread } = render();
  await type("cmd srch");
  expect(options()).toEqual(["Command menu search"]);
  await wait(200);
  expect(request).toHaveBeenCalledWith("local", "thread/search", { query: "cmd srch", limit: 20 });
  expect(options()).toEqual(["Command menu search", "Release notes"]);
  expect(document.body.textContent).toContain("…we should search the menu…");
  press("Enter");
  expect(onOpenThread).toHaveBeenCalledWith("local", "t2");
  expect(document.querySelector("dialog")!.open).toBe(false);
});

test("an action's page opens in place, Backspace goes back, and a pick runs after closing", async () => {
  const run = vi.fn(() => expect(document.querySelector("dialog")!.open).toBe(false));
  render([
    {
      id: "appearance",
      label: "Change appearance",
      text: "Change appearance",
      icon: null,
      page: "appearance",
    },
    { id: "settings", label: "Settings", text: "Settings", icon: null, run },
  ]);
  press("Enter");
  expect(options()).toEqual(["Light", "Dark", "System"]);
  press("Backspace");
  await type("sett");
  press("Enter");
  expect(run).toHaveBeenCalledOnce();
});

test("Search project contents greps the open thread and opens the file picked", async () => {
  request.mockResolvedValue({
    result: {
      matches: [{ path: "src/app.ts", line: 4, text: "const menu = 1;" }],
      truncated: false,
    },
  });
  const { menu, onOpenFile } = render();
  act(() => menu.current!.open("contents"));
  await type("menu");
  await wait(250);
  expect(request).toHaveBeenCalledWith("local", "repo/grep", { runId: "t2", query: "menu" });
  expect(document.body.textContent).toContain("src/app.ts:4");
  press("Enter");
  expect(onOpenFile).toHaveBeenCalledWith("t2", "src/app.ts");
});
