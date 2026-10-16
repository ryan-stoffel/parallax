import { expect, test, vi } from "vite-plus/test";

import type { Area, Thread } from "../protocol/generated/protocol";
import {
  areaNameError,
  inArea,
  jumpTarget,
  nextColor,
  parseScope,
  revertEdit,
  rootIds,
  searchMatch,
  withMember,
} from "./areas";
import { pushToast, undoable, type Toast } from "./undo";

const thread = (id: string, parent?: string): Thread => ({
  id,
  repo: "r",
  createdAt: "2026-10-01T10:00:00Z",
  ...(parent && { parent }),
});
const area = (over: Partial<Area> = {}): Area => ({
  id: "a",
  name: "Launch",
  color: "violet",
  threads: [],
  projects: [],
  ...over,
});

test("a child thread follows its root parent into every area the parent is in", () => {
  const roots = rootIds([thread("p"), thread("c", "p"), thread("g", "c"), thread("o")]);
  const launch = area({ threads: ["p"] });
  const member = (id: string) => ({ kind: "thread", root: roots.get(id)! }) as const;
  expect(inArea(launch, member("p"))).toBe(true);
  expect(inArea(launch, member("c"))).toBe(true);
  expect(inArea(launch, member("g"))).toBe(true);
  expect(inArea(launch, member("o"))).toBe(false);
  expect(inArea(area({ projects: ["pr"] }), { kind: "project", id: "pr" })).toBe(true);
});

test("a loop of parents, or a parent that isn't listed, stops the walk to the root", () => {
  const roots = rootIds([thread("a", "b"), thread("b", "a"), thread("x", "gone")]);
  expect(["a", "b"]).toContain(roots.get("a"));
  expect(roots.get("x")).toBe("x");
});

test("adding and removing a member keeps the rest and never doubles one", () => {
  const a = area({ threads: ["t1"] });
  expect(withMember(a, "thread", "t2", true)).toEqual({ threads: ["t1", "t2"] });
  expect(withMember(a, "thread", "t1", true)).toEqual({ threads: ["t1"] });
  expect(withMember(a, "thread", "t1", false)).toEqual({ threads: [] });
  expect(withMember(a, "project", "p", true)).toEqual({ projects: ["p"] });
});

test("an area name is required, at most 40 characters, and unique ignoring case", () => {
  const areas = [area({ id: "a", name: "Acme client" })];
  expect(areaNameError("  ", areas)).toBe("Give it a name.");
  expect(areaNameError("x".repeat(41), areas)).toMatch(/40 characters/);
  expect(areaNameError("x".repeat(40), areas)).toBeUndefined();
  expect(areaNameError("ACME Client", areas)).toMatch(/already have/);
  // Renaming an area to its own name is fine.
  expect(areaNameError("acme client", areas, "a")).toBeUndefined();
});

test("a new area takes the first color no area uses", () => {
  expect(nextColor([])).toBe("violet");
  expect(nextColor([area({ color: "violet" }), area({ color: "teal" })])).toBe("orange");
});

test("scopes name a host and an id, and the id may hold a slash", () => {
  expect(parseScope("all")).toEqual({ kind: "all" });
  expect(parseScope("area:local/a1")).toEqual({ kind: "area", hostId: "local", id: "a1" });
  expect(parseScope("repo:mini/r/x")).toEqual({ kind: "repo", hostId: "mini", id: "r/x" });
});

test("jumping walks one fixed order and wraps, so repeated jumps reach every thread", () => {
  const order = ["a", "b", "c"];
  const seen: string[] = [];
  let at: string | undefined = "elsewhere";
  for (let i = 0; i < 4; i++) {
    at = jumpTarget(order, at, 1);
    seen.push(at!);
  }
  expect(seen).toEqual(["a", "b", "c", "a"]);
  expect(jumpTarget(order, "a", -1)).toBe("c");
  expect(jumpTarget(order, undefined, -1)).toBe("c");
  expect(jumpTarget([], "a", 1)).toBeUndefined();
});

test("search matches every word across the row's text and its messages", () => {
  const text = "Rework the updater parallax parallax/rework-updater #588";
  const none = () => false;
  expect(searchMatch(["updater", "#588"], text, none)).toEqual([]);
  expect(searchMatch(["rework", "missing"], text, none)).toBeUndefined();
  // A word only in its messages still matches, and is reported for the snippet.
  expect(searchMatch(["rework", "backoff"], text, (w) => w === "backoff")).toEqual(["backoff"]);
  expect(searchMatch([], text, none)).toEqual([]);
});

test("only the newest toast can undo, and one that loses Undo commits what it held back", () => {
  const commit = vi.fn();
  const first: Toast = { id: 1, text: "Deleted", undo: () => {}, commit };
  let { list, settled } = pushToast([], first);
  expect(undoable(list)?.id).toBe(1);
  ({ list, settled } = pushToast(list, { id: 2, text: "Archived", undo: () => {} }));
  expect(list.map((t) => !!t.undo)).toEqual([false, true]);
  expect(undoable(list)?.id).toBe(2);
  expect(settled.map((t) => t.id)).toEqual([1]);
  // A toast with nothing to undo leaves Undo where it was.
  ({ list, settled } = pushToast(list, { id: 3, text: "Nothing needs you" }));
  expect(undoable(list)?.id).toBe(2);
  expect(settled).toEqual([]);
});

test("a toast pushed out of the stack commits its held-back change", () => {
  let list: readonly Toast[] = [];
  const commit = vi.fn();
  list = pushToast(list, { id: 1, text: "Deleted", undo: () => {}, commit }).list;
  for (const id of [2, 3]) list = pushToast(list, { id, text: "note" }).list;
  const { list: next, settled } = pushToast(list, { id: 4, text: "note" });
  expect(next.map((t) => t.id)).toEqual([2, 3, 4]);
  expect(settled.map((t) => t.id)).toEqual([1]);
});

test("undoing an area edit puts back only what the edit changed", () => {
  const before = area({ name: "Acme", threads: ["a", "b"] });
  const after = { ...before, name: "Acme client", threads: ["b", "c"] };
  // Since the edit, "d" joined from New Thread and the color changed elsewhere.
  const now = { ...after, id: before.id, color: "teal", threads: ["b", "c", "d"] };
  expect(revertEdit(before, after, now)).toEqual({
    name: "Acme",
    threads: ["b", "d", "a"],
    projects: [],
  });
});
