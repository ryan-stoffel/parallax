// @vitest-environment happy-dom
import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vite-plus/test";

import type { SubscriptionMessage, WispBridge } from "../preload/bridge";
import type { ContextFile } from "../protocol/generated/protocol";
import { ContextPanel } from "./ContextPanel";
import { SidePanel } from "./SidePanel";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const now = Date.parse("2026-09-29T12:00:00Z");
const file = (path: string, modifiedAt: string): ContextFile => ({ path, size: 10, modifiedAt });
let files: ContextFile[];
let contents: Record<string, string>;
let listeners: Set<(message: SubscriptionMessage) => void>;
const request = vi.fn(async (_host: string, method: string, params: Record<string, unknown>) => {
  if (method === "agent/list") return { logId: "log-1", result: { runs: [], seq: 7 } };
  if (method === "context/list") return { logId: "log-1", result: { files } };
  const path = params["path"] as string;
  return { logId: "log-1", result: { file: file(path, ""), content: contents[path] } };
});

beforeEach(() => {
  vi.useFakeTimers({ now, toFake: ["Date"] });
  request.mockClear();
  listeners = new Set();
  files = [];
  contents = {};
  window.wisp = {
    platform: "darwin",
    request,
    subscribe: (_host, _params, listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  } as Partial<WispBridge> as WispBridge;
});

let unmount = () => {};
afterEach(() => {
  act(() => unmount());
  vi.useRealTimers();
});

async function render(context?: ReactNode) {
  const root = createRoot(document.body.appendChild(document.createElement("div")));
  act(() =>
    root.render(
      <SidePanel
        open
        onClose={() => {}}
        expanded={false}
        onExpandedChange={() => {}}
        context={context}
      />,
    ),
  );
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
const panel = () => document.getElementById("side-panel")!;
const listButton = (name: string) =>
  [...panel().querySelectorAll("nav button")].find((b) => b.textContent?.startsWith(name));
const tabs = () =>
  [...panel().querySelectorAll('[role="tab"]')].map(
    (t) => `${t.textContent}${t.getAttribute("aria-selected") === "true" ? "*" : ""}`,
  );
const shown = () => panel().querySelector<HTMLElement>('[role="tabpanel"]:not([hidden])');
const listShown = () => panel().querySelector("nav") !== null;
const changed = (seq: number, f: ContextFile) =>
  act(async () =>
    listeners.forEach((l) =>
      l({
        type: "event",
        event: { subscription: "s-1", seq, time: "", event: { kind: "context.changed", file: f } },
      }),
    ),
  );

test("views open as tabs: + shows the list, a view's letter opens it, and picking an open one focuses its tab", async () => {
  await render();
  expect(tabs()).toEqual([]);
  expect(listShown()).toBe(true);

  await click(listButton("Changes"));
  expect(tabs()).toEqual(["Changes*"]);
  expect(listShown()).toBe(false);
  expect(shown()!.textContent).toContain("No changes yet");

  await click(panel().querySelector('button[aria-label="Open a view"]'));
  expect(listShown()).toBe(true);
  act(() => {
    panel().dispatchEvent(new KeyboardEvent("keydown", { key: "a", bubbles: true }));
  });
  expect(tabs()).toEqual(["Changes", "Agents*"]);
  expect(shown()!.textContent).toContain("No agents running");

  await click(panel().querySelector('button[aria-label="Open a view"]'));
  await click(listButton("Changes"));
  expect(tabs()).toEqual(["Changes*", "Agents"]);
});

test("closing the shown tab shows its neighbour, and closing the last shows the list", async () => {
  await render();
  for (const name of ["Changes", "Context", "Agents"]) {
    await click(listButton(name));
    await click(panel().querySelector('button[aria-label="Open a view"]'));
  }
  await click(panel().querySelector('[role="tab"]'));
  expect(tabs()).toEqual(["Changes*", "Context", "Agents"]);

  await click(panel().querySelector('button[aria-label="Close Changes"]'));
  expect(tabs()).toEqual(["Context*", "Agents"]);
  await click(panel().querySelector('button[aria-label="Close Agents"]'));
  expect(tabs()).toEqual(["Context*"]);
  // Off a Project, Context says so, rather than waiting for notes that won't come.
  expect(shown()!.textContent).toContain("No shared context");

  await click(panel().querySelector('button[aria-label="Close Context"]'));
  expect(tabs()).toEqual([]);
  expect(listShown()).toBe(true);
});

test("a Project's Context lists its files by path and opens one as Markdown, both kept live", async () => {
  files = [file("plan.md", "2026-09-29T09:00:00Z"), file("tests.md", "2026-09-29T11:00:00Z")];
  contents = { "plan.md": "# Plan\n\nShip <b>it</b>." };
  await render(<ContextPanel hostId="local" project="p-ember" connected />);
  await click(listButton("Context"));
  const rows = () =>
    [...panel().querySelectorAll('[aria-label="Context files"] button')].map((b) => b.textContent);
  expect(rows()).toEqual(["plan.md3h", "tests.md1h"]);

  // An agent's write, detected on disk, joins the list in path order.
  await changed(8, file("notes.md", "2026-09-29T12:00:00Z"));
  expect(rows()).toEqual(["notes.mdnow", "plan.md3h", "tests.md1h"]);

  await click(
    [...panel().querySelectorAll("li button")].find((b) => b.textContent === "plan.md3h"),
  );
  const article = () => panel().querySelector('article[aria-label="plan.md"]')!;
  expect(article().querySelector("h1")?.textContent).toBe("Plan");
  // Raw HTML stays text.
  expect(article().querySelector("b")).toBeNull();
  expect(article().textContent).toContain("Ship <b>it</b>.");

  contents["plan.md"] = "# Plan\n\nShipped.";
  await changed(9, file("plan.md", "2026-09-29T12:00:00Z"));
  expect(article().textContent).toContain("Shipped.");

  await click(
    [...panel().querySelectorAll('[role="tabpanel"] button')].find((b) =>
      b.textContent?.endsWith("plan.md"),
    ),
  );
  expect(rows()).toEqual(["notes.mdnow", "plan.mdnow", "tests.md1h"]);
});
