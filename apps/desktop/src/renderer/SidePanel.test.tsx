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
const subscribe = vi.fn<WispBridge["subscribe"]>((_host, _params, listener) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
});
const request = vi.fn(async (_host: string, method: string, params: Record<string, unknown>) => {
  if (method === "agent/list") return { logId: "log-1", result: { runs: [], seq: 7 } };
  if (method === "context/list") return { logId: "log-1", result: { files } };
  const path = params["path"] as string;
  return { logId: "log-1", result: { file: file(path, ""), content: contents[path] } };
});

beforeEach(() => {
  vi.useFakeTimers({ now, toFake: ["Date"] });
  request.mockClear();
  subscribe.mockClear();
  listeners = new Set();
  files = [];
  contents = {};
  window.wisp = {
    platform: "darwin",
    request,
    subscribe,
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
// Each open view's tab, the shown one marked *.
const tabs = () =>
  [...panel().querySelectorAll('[aria-label="Open views"] button[id]')].map(
    (t) => `${t.textContent}${t.getAttribute("aria-current") === "true" ? "*" : ""}`,
  );
const tab = (key: string) => panel().querySelector<HTMLElement>(`#side-panel-tab-${key}`);
const openAView = () => panel().querySelector<HTMLElement>('button[aria-label="Open a view"]');
const shown = () => panel().querySelector<HTMLElement>(":scope > div:not(.titlebar):not([hidden])");
const press = (key: string) =>
  act(() => {
    document.activeElement!.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
  });
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

  await click(openAView());
  expect(listShown()).toBe(true);
  openAView()!.focus();
  press("a");
  expect(tabs()).toEqual(["Changes", "Agents*"]);
  expect(shown()!.textContent).toContain("No agents running");

  await click(openAView());
  await click(listButton("Changes"));
  expect(tabs()).toEqual(["Changes*", "Agents"]);
});

test("closing the shown tab shows its neighbour, and closing the last shows the list", async () => {
  await render();
  for (const name of ["Changes", "Context", "Agents"]) {
    await click(listButton(name));
    await click(openAView());
  }
  await click(tab("D"));
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

test("closing a tab keeps focus in the panel, so the list's letters work after closing the last", async () => {
  await render();
  await click(listButton("Changes"));
  await click(openAView());
  await click(listButton("Agents"));
  await click(panel().querySelector('button[aria-label="Close Agents"]'));
  expect(document.activeElement).toBe(tab("D"));

  await click(panel().querySelector('button[aria-label="Close Changes"]'));
  expect(document.activeElement).toBe(openAView());
  expect(listShown()).toBe(true);
  press("c");
  expect(tabs()).toEqual(["Context*"]);
});

/** Renders ember's Context view and opens it. */
async function openContext() {
  await render(<ContextPanel hostId="local" project="p-ember" name="ember" connected />);
  await click(listButton("Context"));
}
const rows = (list: string) =>
  [...panel().querySelectorAll(`[aria-label="${list}"] button`)].map((b) => b.textContent);
const button = (label: string) =>
  panel().querySelector<HTMLElement>(`button[aria-label="${label}"]`);
const doc = (path: string) => panel().querySelector(`article[aria-label="${path}"]`);

test("without a board, Context opens on All files and Recents, and opens a file as Markdown, all kept live", async () => {
  files = [file("plan.md", "2026-09-29T09:00:00Z"), file("tests.md", "2026-09-29T11:00:00Z")];
  contents = { "plan.md": "# Plan\n\nShip <b>it</b>.", "tests.md": "Run the tests." };
  await openContext();
  expect(panel().querySelector("h2")?.textContent).toBe("ember");
  expect(panel().textContent).toContain("The coordinator writes a status board to notes.md");
  expect(button("All files")!.getAttribute("aria-pressed")).toBe("true");
  expect(rows("All files")).toEqual(["plan.md3h", "tests.md1h"]);
  expect(rows("Recents")).toEqual(["tests.md1h", "plan.md3h"]);
  // Each card previews its file, rendered, with nothing in it to click.
  const cards = () => [...panel().querySelectorAll('[aria-label="Recents"] li')];
  expect(cards()[1]!.querySelector(".context-preview h1")?.textContent).toBe("Plan");
  expect(cards()[1]!.querySelectorAll("button")).toHaveLength(1);
  // Subscribed after `agent/list`'s seq, taken before the list (RYA-187).
  expect(request.mock.calls.map(([, method]) => method).slice(0, 2)).toEqual([
    "agent/list",
    "context/list",
  ]);
  expect(subscribe).toHaveBeenCalledWith(
    "local",
    { after: 7, project: "p-ember", logId: "log-1" },
    expect.any(Function),
  );

  // An agent's write, detected on disk, joins the list in path order and leads Recents.
  contents["research.md"] = "Findings.";
  await changed(8, file("research.md", "2026-09-29T12:00:00Z"));
  expect(rows("All files")).toEqual(["plan.md3h", "research.mdnow", "tests.md1h"]);
  expect(rows("Recents")[0]).toBe("research.mdnow");
  expect(cards()[0]!.textContent).toContain("Findings.");

  await click(
    [...panel().querySelectorAll("li button")].find((b) => b.textContent === "plan.md3h"),
  );
  expect(doc("plan.md")!.querySelector("h1")?.textContent).toBe("Plan");
  // Raw HTML stays text.
  expect(doc("plan.md")!.querySelector("b")).toBeNull();
  expect(doc("plan.md")!.textContent).toContain("Ship <b>it</b>.");

  contents["plan.md"] = "# Plan\n\nShipped.";
  await changed(9, file("plan.md", "2026-09-29T12:00:00Z"));
  expect(doc("plan.md")!.textContent).toContain("Shipped.");

  // Back to the list.
  await click([...panel().querySelectorAll("button")].find((b) => b.textContent === "plan.md"));
  expect(rows("All files")).toEqual(["plan.mdnow", "research.mdnow", "tests.md1h"]);
});

const notes = `## Release

- [ ] Unify launcher modes ([#17](https://github.com/o/r/issues/17))
- [x] Welcome window ([#12](https://github.com/o/r/pull/12))

Older items: [archived](archived.md), [gone](gone.md)`;

test("the board shows tasks as circles, GitHub links with their icons, and opens other context files", async () => {
  files = [file("archived.md", "2026-09-29T09:00:00Z"), file("notes.md", "2026-09-29T11:00:00Z")];
  contents = { "notes.md": notes, "archived.md": "- [x] Old work" };
  await openContext();
  const board = doc("notes.md")!;
  expect(board.querySelector("h2")?.textContent).toBe("Release");
  expect(board.querySelector("input")).toBeNull();
  const tasks = [...board.querySelectorAll("li")].map((li) => [
    li.querySelector("svg")?.getAttribute("aria-label"),
    li.textContent,
  ]);
  expect(tasks).toEqual([
    ["Open", " Unify launcher modes (#17)"],
    ["Done", " Welcome window (#12)"],
  ]);
  expect(board.querySelector('a[href$="/pull/12"] svg.lucide-git-merge')).not.toBeNull();
  const issue = board.querySelector('a[href$="/issues/17"]')!;
  expect(issue.querySelector("svg:not(.lucide)")).not.toBeNull();
  expect(issue.getAttribute("target")).toBe("_blank");

  // A missing file's link is off; an existing one opens in the view, with a way back.
  const link = (name: string) =>
    [...board.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent === name)!;
  expect(link("gone").disabled).toBe(true);
  await click(link("archived"));
  expect(doc("archived.md")!.textContent).toContain("Old work");
  await click([...panel().querySelectorAll("button")].find((b) => b.textContent === "archived.md"));
  expect(doc("notes.md")).not.toBeNull();

  // It follows the coordinator's rewrites.
  contents["notes.md"] = notes.replace("- [ ] Unify", "- [x] Unify");
  await changed(8, file("notes.md", "2026-09-29T12:00:00Z"));
  expect(doc("notes.md")!.querySelectorAll('svg[aria-label="Done"]')).toHaveLength(2);
});

test("the book toggles between the board and All files, and search filters the files by name", async () => {
  files = [file("archived.md", "2026-09-29T09:00:00Z"), file("notes.md", "2026-09-29T11:00:00Z")];
  contents = { "notes.md": notes, "archived.md": "Old work" };
  await openContext();
  expect(button("All files")!.getAttribute("aria-pressed")).toBe("false");

  await click(button("All files"));
  expect(doc("notes.md")).toBeNull();
  expect(rows("All files")).toEqual(["archived.md3h", "notes.md1h"]);
  expect(panel().textContent).not.toContain("The coordinator writes a status board");
  await click(button("All files"));
  expect(doc("notes.md")).not.toBeNull();

  await click(button("Search files"));
  const box = panel().querySelector<HTMLInputElement>('input[aria-label="Search files"]')!;
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(box, "ARCH");
    box.dispatchEvent(new Event("input", { bubbles: true }));
  });
  expect(rows("All files")).toEqual(["archived.md3h"]);
  expect(panel().querySelector('[aria-label="Recents"]')).toBeNull();
  act(() => {
    box.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  });
  expect(doc("notes.md")).not.toBeNull();
  expect(panel().querySelector("h2")?.textContent).toBe("ember");
});
