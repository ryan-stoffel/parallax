import { expect, test, vi } from "vite-plus/test";

import { jumpTarget, parseScope, searchMatch } from "./scope";
import { pushToast, undoable, type Toast } from "./undo";

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
