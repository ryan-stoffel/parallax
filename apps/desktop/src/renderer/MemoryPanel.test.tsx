// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vite-plus/test";

import type { ParallaxBridge } from "../preload/bridge";
import type { MemoryFile, MemoryScope } from "../protocol/generated/protocol";
import { MemoryPanel, savedAs, sectionsOf, type Memory } from "./MemoryPanel";
import { Notifications } from "./notifications";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const you: MemoryScope = { kind: "you" };
const repo: MemoryScope = { kind: "repo", id: "r-1" };
const project: MemoryScope = { kind: "project", id: "p-1" };
const file = (path: string, more: Partial<MemoryFile> = {}): MemoryFile => ({
  path,
  size: 10,
  modifiedAt: "2026-10-04T00:00:00Z",
  ...more,
});
const memory = (scope: MemoryScope, path: string, more: Partial<Memory> = {}): Memory => ({
  ...file(path, more),
  ...more,
  scope,
});

test("sections: the Project's brief, entries by their folder, knowledge, then the user's proposals", () => {
  const s = sectionsOf([
    memory(you, "memory/preference/terse.md", { title: "Be terse" }),
    memory(repo, "brief.md"),
    memory(repo, "proposals/use-vitest.md", { writer: "thread t-1" }),
    memory(project, "brief.md"),
    memory(project, "knowledge/ci.md"),
    memory(project, "memory/gotcha/flaky.md"),
    memory(project, "proposals/from-child.md", { writer: "thread c-1" }),
    memory(project, "proposals/rewrite.md", { writer: "coordinator k-1" }),
  ]);
  expect(s.brief?.scope).toEqual(project);
  expect(s.entries.map((g) => [g.label, g.files.map((f) => f.path)])).toEqual([
    ["Preferences", ["memory/preference/terse.md"]],
    ["Conventions", []],
    ["Decisions", []],
    ["Gotchas", ["memory/gotcha/flaky.md"]],
  ]);
  expect(s.knowledge.map((f) => f.path)).toEqual(["knowledge/ci.md"]);
  // A child's proposal waits for its coordinator, not the user.
  expect(s.proposals.map((f) => f.path)).toEqual([
    "proposals/use-vitest.md",
    "proposals/rewrite.md",
  ]);
});

let lists: Record<string, MemoryFile[]>;
let bodies: Record<string, string>;
// Methods that answer with an error.
let failing: Set<string>;
const request = vi.fn(async (_host: string, method: string, params: Record<string, unknown>) => {
  if (failing.has(method))
    return { logId: "log-1", error: { code: -32000, message: `${method} failed` } };
  const scope = params["scope"] as MemoryScope | undefined;
  const key = scope && (scope.kind === "you" ? "you" : scope.id);
  if (method === "agent/list") return { logId: "log-1", result: { runs: [], seq: 1 } };
  if (method === "memory/list") return { logId: "log-1", result: { files: lists[key!] ?? [] } };
  if (method === "memory/read") {
    const path = params["path"] as string;
    return { logId: "log-1", result: { file: file(path), content: bodies[path] ?? "" } };
  }
  if (method === "memory/write")
    return { logId: "log-1", result: { file: file(params["path"] as string) } };
  return { logId: "log-1", result: {} };
});

const subscribe = vi.fn<ParallaxBridge["subscribe"]>(() => () => {});

beforeEach(() => {
  request.mockClear();
  subscribe.mockClear();
  lists = {};
  bodies = {};
  failing = new Set();
  window.parallax = {
    platform: "darwin",
    request,
    subscribe,
  } as Partial<ParallaxBridge> as ParallaxBridge;
});

// happy-dom has no popovers; the notifications' stack shows one.
HTMLElement.prototype.showPopover = () => {};

let unmount = () => {};
afterEach(() => {
  // Notifications outlive a render, so close this test's.
  for (const close of document.querySelectorAll<HTMLButtonElement>(
    '[aria-label="Notifications"] button[aria-label="Close"]',
  ))
    act(() => close.click());
  act(() => unmount());
});

async function render() {
  const root = createRoot(document.body.appendChild(document.createElement("div")));
  act(() =>
    root.render(
      <>
        <MemoryPanel hostId="local" project="p-1" repo="r-1" />
        <Notifications />
      </>,
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
const button = (text: string) =>
  [...document.querySelectorAll("button")].find((b) => b.textContent?.includes(text));
const click = async (text: string) => {
  await act(async () => button(text)!.click());
  await settle();
};
/** The open editor for the file titled `title`. */
const editor = (title: string) =>
  document.querySelector<HTMLTextAreaElement>(`textarea[aria-label="Edit ${title}"]`);
/** Replaces a text box's text, as typing does. */
const typeInto = (box: HTMLTextAreaElement, text: string) =>
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(box, text);
    box.dispatchEvent(new Event("input", { bubbles: true }));
  });
const calls = (method: string) =>
  request.mock.calls.filter(([, m]) => m === method).map(([, , params]) => params);

test("a proposal saves as an entry at its folder's scope, keeping its title and source", async () => {
  lists = {
    "r-1": [
      file("proposals/use-vitest.md", {
        kind: "convention",
        title: "Use Vitest",
        source: "thread t-1",
        writer: "thread t-1",
      }),
    ],
  };
  bodies = { "proposals/use-vitest.md": "Tests run on Vitest." };
  await render();
  await click("Accept");
  expect(calls("memory/write")).toEqual([
    {
      scope: repo,
      path: "memory/convention/use-vitest.md",
      content: "Tests run on Vitest.",
      title: "Use Vitest",
      source: "thread t-1",
    },
  ]);
  expect(calls("memory/delete")).toEqual([{ scope: repo, path: "proposals/use-vitest.md" }]);
});

test("a failed save of an edited proposal keeps its editor and text, and deletes nothing", async () => {
  lists = {
    "r-1": [file("proposals/use-vitest.md", { kind: "convention", title: "Use Vitest" })],
  };
  bodies = { "proposals/use-vitest.md": "Tests run on Vitest." };
  failing = new Set(["memory/write"]);
  await render();
  await click("Edit");
  typeInto(editor("Use Vitest")!, "Tests run on Vitest 4.");
  await click("Save");
  expect(editor("Use Vitest")!.value).toBe("Tests run on Vitest 4.");
  expect(calls("memory/delete")).toEqual([]);
});

test("savedAs: You, the folder without a repo entry, the entry it replaces, and a coordinator's brief", () => {
  const proposal = (more: Partial<Memory>) =>
    memory(project, "proposals/x.md", { writer: "coordinator k-1", ...more });
  expect(savedAs(proposal({ kind: "gotcha", forScope: "you" }), "r-1")?.scope).toEqual(you);
  expect(savedAs(proposal({ kind: "gotcha", forScope: "repo" }))?.scope).toEqual(project);
  const rewrite = proposal({ kind: "decision", replaces: "memory/decision/vitest.md" });
  expect(savedAs(rewrite)).toEqual({ scope: project, path: "memory/decision/vitest.md" });
  expect(savedAs(proposal({}))).toEqual({ scope: project, path: "brief.md" });
  expect(savedAs(proposal({ writer: "thread t-1" }))).toBeUndefined();
});

const sqlite = () =>
  file("memory/decision/sqlite.md", { kind: "decision", title: "Keep SQLite", source: "user" });

test("promote asks before replacing an entry at the next scope", async () => {
  lists = { "r-1": [{ ...sqlite(), title: "An older note" }], "p-1": [sqlite()] };
  await render();
  await click("Keep SQLite");
  await click("Promote to Repo");
  expect(calls("memory/write")).toEqual([]);

  await click("Cancel");
  expect(document.querySelector('[aria-label="Replace"]')).toBeNull();
  expect(calls("memory/write")).toEqual([]);

  await click("Promote to Repo");
  await click("Replace");
  expect(calls("memory/write").map((p) => p["scope"])).toEqual([repo]);
  expect(calls("memory/delete")).toEqual([{ scope: project, path: "memory/decision/sqlite.md" }]);
});

test("a failed promote write deletes nothing", async () => {
  lists = { "p-1": [sqlite()] };
  failing = new Set(["memory/write"]);
  await render();
  await click("Keep SQLite");
  await click("Promote to Repo");
  expect(calls("memory/write")).toHaveLength(1);
  expect(calls("memory/delete")).toEqual([]);
});

test("entries show as plain text, so a link shows where it goes", async () => {
  lists = { "p-1": [sqlite()] };
  bodies = { "memory/decision/sqlite.md": "See [the docs](https://evil.example)." };
  await render();
  await click("Keep SQLite");
  const decisions = document.querySelector('[aria-label="Decisions"]')!;
  expect(decisions.querySelector("a")).toBeNull();
  expect(decisions.textContent).toContain("[the docs](https://evil.example)");
});
