// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vite-plus/test";

import type { ParallaxBridge } from "../preload/bridge";
import type { PreviewTab } from "../protocol/generated/protocol";
import type { AgentTabs } from "./Browser";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

// What the browser's toolbar asks of main: unsubscribes for its listeners, and nothing to report.
const bridge = new Proxy(
  { platform: "darwin", downloads: async () => [], extensions: async () => [] },
  {
    get: (target, name) =>
      name in target
        ? target[name as keyof typeof target]
        : String(name).startsWith("on")
          ? () => () => {}
          : async () => undefined,
  },
);

let root: Root | undefined;
beforeEach(() => {
  vi.resetModules();
  localStorage.clear();
  Object.assign(window, { parallax: bridge as unknown as ParallaxBridge });
  Object.assign(HTMLElement.prototype, { hidePopover() {}, showPopover() {} });
  const observer = class {
    observe() {}
    disconnect() {}
  };
  Object.assign(globalThis, { ResizeObserver: observer });
});
afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  document.body.innerHTML = "";
});

const tab = (tabId: string, title: string): PreviewTab =>
  ({ tabId, title, url: `https://${tabId}.test/` }) as PreviewTab;

/** A thread's panel, which `draw` redraws with new props. */
async function panel() {
  const { SidePanel } = await import("./SidePanel");
  const onClose = vi.fn();
  const element = document.createElement("div");
  document.body.append(element);
  root = createRoot(element);
  const draw = (props: {
    open?: boolean;
    browse?: { url?: string; agentTab?: string };
    agentTabs?: AgentTabs;
  }) =>
    act(() =>
      root!.render(
        <SidePanel
          scope="thread"
          open
          onClose={onClose}
          expanded={false}
          onExpandedChange={() => {}}
          {...props}
        />,
      ),
    );
  return { draw, onClose };
}

const strip = () =>
  [...document.querySelectorAll<HTMLElement>('ul[aria-label="Open views"] li')].map(
    (li) => li.querySelector("span")?.textContent,
  );
const click = (name: string) =>
  act(() =>
    [...document.querySelectorAll("button")]
      .find((b) => (b.getAttribute("aria-label") ?? b.textContent)?.startsWith(name))!
      .click(),
  );

test("the list's Browser opens a tab, and closing the last one collapses the panel with no blank tab", async () => {
  const { draw, onClose } = await panel();
  draw({});
  click("Browser");
  expect(strip()).toEqual(["New Tab"]);
  expect(document.querySelector('input[aria-label="Address"]')).not.toBeNull();

  // Another empty tab reuses the blank one.
  click("Open a view");
  click("Browser");
  expect(strip()).toEqual(["New Tab"]);

  click("Close New Tab");
  expect(strip()).toEqual([]);
  expect(onClose).toHaveBeenCalledOnce();
  expect(document.querySelector('input[aria-label="Address"]')).toBeNull();
});

test("the user's and the agent's tabs share the strip in the order opened, and an empty request shows the last one", async () => {
  const { draw } = await panel();
  const close = vi.fn();
  const agentTabs = (tabs: PreviewTab[]): AgentTabs => ({
    hostId: "local",
    runId: "run",
    tabs,
    close,
  });
  draw({});
  // Each new request object opens another.
  draw({ browse: { url: "https://mine.test/" } });
  draw({ browse: { url: "https://mine.test/" } });
  expect(strip()).toHaveLength(2);

  const opened = { agentTab: "a" };
  draw({ browse: opened, agentTabs: agentTabs([tab("a", "Agent page")]) });
  expect(strip().at(-1)).toBe("Agent page");
  const front = () => document.querySelector('[aria-current="true"] span')?.textContent;
  expect(front()).toBe("Agent page");

  // A view in front, then the shortcut's empty request, comes back to it.
  click("Open a view");
  draw({ browse: {}, agentTabs: agentTabs([tab("a", "Agent page")]) });
  expect(front()).toBe("Agent page");

  click("Close Agent page");
  expect(close).toHaveBeenCalledWith("a");
});

test("saved tabs come back into the strip, and open their page only once shown in an open panel", async () => {
  localStorage.setItem(
    "parallax.browserTabs",
    JSON.stringify({
      thread: {
        tabs: [
          { url: "https://one.test/", title: "One" },
          { url: "https://two.test/", title: "Two" },
        ],
        current: 1,
      },
    }),
  );
  const { draw } = await panel();
  draw({ open: false });
  expect(strip()).toEqual(["One", "Two"]);
  expect(document.querySelector("webview")).toBeNull();

  draw({ open: true });
  await act(async () => {});
  const views = [...document.querySelectorAll("webview")].map((v) => v.getAttribute("src"));
  expect(views).toEqual(["https://two.test/"]);

  // Closing one saves the rest.
  click("Close Two");
  const saved = JSON.parse(localStorage.getItem("parallax.browserTabs")!) as {
    thread: { tabs: { url: string }[] };
  };
  expect(saved.thread.tabs.map((t) => t.url)).toEqual(["https://one.test/"]);
});
