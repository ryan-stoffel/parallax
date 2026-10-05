// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vite-plus/test";

import type { ParallaxBridge } from "../preload/bridge";
import type { MemoryFile, MemoryScope } from "../protocol/generated/protocol";
import { MemoryPanel, nextScope, savedAs, sectionsOf, type Memory } from "./MemoryPanel";

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

test("promote goes Project to Repo to You, past a missing Repo", () => {
  expect(nextScope(project, "r-1")).toEqual(repo);
  expect(nextScope(project)).toEqual(you);
  expect(nextScope(repo, "r-1")).toEqual(you);
  expect(nextScope(you, "r-1")).toBeUndefined();
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

let unmount = () => {};
afterEach(() => act(() => unmount()));

async function render() {
  const root = createRoot(document.body.appendChild(document.createElement("div")));
  act(() => root.render(<MemoryPanel hostId="local" project="p-1" repo="r-1" />));
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
const calls = (method: string) =>
  request.mock.calls.filter(([, m]) => m === method).map(([, , params]) => params);

test("watches the Repo and Project folders for context.changed, without their runs' output", async () => {
  await render();
  expect(subscribe.mock.calls.map(([, params]) => params)).toEqual([
    { after: 1, project: "r-1", shell: true, logId: "log-1" },
    { after: 1, project: "p-1", shell: true, logId: "log-1" },
  ]);
});

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
  expect(document.querySelector('[aria-label="Proposals"]')?.textContent).toContain("Use Vitest");

  await click("Use Vitest");
  await click("Save");
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

test("a coordinator's proposal saves at the scope it names", async () => {
  lists = {
    "p-1": [
      file("proposals/use-vitest.md", {
        kind: "convention",
        title: "Use Vitest",
        source: "coordinator k-1",
        writer: "coordinator k-1",
        forScope: "repo",
      }),
    ],
  };
  bodies = { "proposals/use-vitest.md": "Tests run on Vitest." };
  await render();
  await click("Use Vitest");
  await click("Save");
  expect(calls("memory/write")).toEqual([
    {
      scope: repo,
      path: "memory/convention/use-vitest.md",
      content: "Tests run on Vitest.",
      title: "Use Vitest",
      source: "coordinator k-1",
    },
  ]);
  expect(calls("memory/delete")).toEqual([{ scope: project, path: "proposals/use-vitest.md" }]);
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

test("an entry shows its scope, source, and stale mark, and promotes to the next scope", async () => {
  lists = {
    "p-1": [
      file("memory/decision/sqlite.md", { kind: "decision", title: "Keep SQLite", source: "user" }),
    ],
  };
  // PLX-407's flag, which the generated type doesn't have yet.
  (lists["p-1"]![0] as Memory).stale = true;
  bodies = { "memory/decision/sqlite.md": "One writer." };
  await render();
  const decisions = document.querySelector('[aria-label="Decisions"]')!;
  expect(decisions.textContent).toContain("Keep SQLite");
  expect(decisions.textContent).toContain("Stale");
  expect(decisions.textContent).toContain("Project");

  await click("Keep SQLite");
  expect(decisions.textContent).toContain("From user");
  await click("Promote to Repo");
  expect(calls("memory/write")).toEqual([
    {
      scope: repo,
      path: "memory/decision/sqlite.md",
      content: "One writer.",
      title: "Keep SQLite",
      source: "user",
    },
  ]);
  expect(calls("memory/delete")).toEqual([{ scope: project, path: "memory/decision/sqlite.md" }]);
});

const sqlite = () =>
  file("memory/decision/sqlite.md", { kind: "decision", title: "Keep SQLite", source: "user" });

test("promote asks before replacing an entry at the next scope", async () => {
  lists = { "r-1": [{ ...sqlite(), title: "An older note" }], "p-1": [sqlite()] };
  await render();
  await click("Keep SQLite");
  await click("Promote to Repo");
  expect(document.querySelector('[aria-label="Replace"]')?.textContent).toContain(
    "Repo already has memory/decision/sqlite.md",
  );
  expect(calls("memory/write")).toEqual([]);

  await click("Cancel");
  expect(document.querySelector('[aria-label="Replace"]')).toBeNull();
  expect(calls("memory/write")).toEqual([]);

  await click("Promote to Repo");
  await click("Replace");
  expect(calls("memory/write").map((p) => p["scope"])).toEqual([repo]);
  expect(calls("memory/delete")).toEqual([{ scope: project, path: "memory/decision/sqlite.md" }]);
});

test("a failed write deletes nothing, and a failed delete says the copy was made", async () => {
  lists = { "p-1": [sqlite()] };
  failing = new Set(["memory/write"]);
  await render();
  await click("Keep SQLite");
  await click("Promote to Repo");
  expect(document.querySelector('[role="alert"]')?.textContent).toBe("memory/write failed");
  expect(calls("memory/delete")).toEqual([]);

  failing = new Set(["memory/delete"]);
  await click("Promote to Repo");
  expect(document.querySelector('[role="alert"]')?.textContent).toBe(
    "Copied to Repo, but couldn't remove it from Project: memory/delete failed",
  );
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
