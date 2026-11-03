import { expect, test } from "vite-plus/test";

import type { Selection } from "./App";
import {
  activeTab,
  closeHostTabs,
  closeTab,
  dropInStrip,
  moveTab,
  navigate,
  openBeside,
  openInTab,
  removeThread,
  startTabs,
  stepTab,
  swapTiles,
  threadIdsOf,
  type Tabs,
} from "./tabState";

const thread = (threadId: string): Selection => ({ kind: "thread", threadId });
/** The tabs on host "h" as their threads, "new" for New thread, the active one in brackets. */
const shape = (state: Tabs) =>
  state.tabs.map((t) => {
    const name = threadIdsOf(t).join("+") || t.selection.kind;
    return t.id === state.active ? `[${name}]` : name;
  });
const opened = (...ids: string[]) =>
  ids.reduce(
    (state, id) => openInTab(state, "h", id),
    navigate(startTabs("h"), "h", thread(ids[0]!)),
  );
const idOf = (state: Tabs, threadId: string) =>
  state.tabs.find((t) => threadIdsOf(t).includes(threadId))!.id;

test("a thread opens in the active tab, and in the tab that already holds it", () => {
  let state = navigate(startTabs("h"), "h", thread("a"));
  expect(shape(state)).toEqual(["[a]"]);
  state = navigate(state, "h", thread("b"));
  expect(shape(state)).toEqual(["[b]"]);
  state = navigate(openInTab(state, "h", "c"), "h", thread("b"));
  expect(shape(state)).toEqual(["[b]", "c"]);
});

test("the same thread id on another host is another tab's thread", () => {
  const state = openInTab(navigate(startTabs("h"), "h", thread("a")), "other", "a");
  expect(state.tabs.map((t) => t.hostId)).toEqual(["h", "other"]);
});

test("New thread keeps one tab, which the next thread opens in", () => {
  let state = navigate(startTabs("h"), "h", thread("a"));
  state = navigate(state, "h", { kind: "new" });
  expect(shape(state)).toEqual(["a", "[new]"]);
  state = navigate(navigate(state, "h", thread("a")), "h", { kind: "new", groupId: "repo" });
  expect(shape(state)).toEqual(["a", "[new]"]);
  expect(activeTab(state).selection).toEqual({ kind: "new", groupId: "repo" });
  expect(shape(navigate(state, "h", thread("b")))).toEqual(["a", "[b]"]);
});

test("opening another thread from a split keeps the split in its tab", () => {
  const state = navigate(openBeside(opened("a"), "b"), "h", thread("c"));
  expect(shape(state)).toEqual(["a+b", "[c]"]);
  expect(shape(navigate(state, "h", thread("a")))).toEqual(["[a+b]", "c"]);
});

test("tiling a thread from another tab moves it, closing that tab", () => {
  const state = opened("a", "b", "c");
  const tiled = openBeside({ ...state, active: idOf(state, "a") }, "c");
  expect(shape(tiled)).toEqual(["[a+c]", "b"]);
  expect(activeTab(tiled).split?.ratios).toEqual([0.5]);
  expect(activeTab(tiled).selection).toEqual(thread("c"));
});

test("a full split replaces its last unfocused tile, or the tile a drop names", () => {
  let state = opened("a");
  for (const id of ["b", "c", "d"]) state = openBeside(state, id);
  expect(threadIdsOf(activeTab(openBeside(state, "e")))).toEqual(["a", "b", "e", "d"]);
  expect(threadIdsOf(activeTab(openBeside(state, "e", 0)))).toEqual(["e", "b", "c", "d"]);
});

test("a tile dropped on the strip leaves the split for its own tab", () => {
  let state = openBeside(openBeside(opened("a"), "b"), "c");
  state = dropInStrip(state, "h", "b");
  expect(shape(state)).toEqual(["a+c", "[b]"]);
  state = dropInStrip({ ...state, active: idOf(state, "a") }, "h", "c", idOf(state, "a"));
  expect(shape(state)).toEqual(["[c]", "a", "b"]);
  expect(state.tabs.find((t) => threadIdsOf(t).includes("a"))!.split).toBeUndefined();
});

test("a sidebar thread dropped on the strip opens there, or moves the tab it's in", () => {
  let state = opened("a", "b");
  state = dropInStrip(state, "h", "c", idOf(state, "b"));
  expect(shape(state)).toEqual(["a", "[c]", "b"]);
  state = dropInStrip(state, "h", "b", idOf(state, "a"));
  expect(shape(state)).toEqual(["[b]", "a", "c"]);
});

test("moving a tab keeps the active one, and dropping it before itself changes nothing", () => {
  const state = opened("a", "b", "c");
  const a = idOf(state, "a");
  expect(shape(moveTab(state, a))).toEqual(["b", "[c]", "a"]);
  expect(shape(moveTab(state, idOf(state, "c"), a))).toEqual(["[c]", "a", "b"]);
  expect(moveTab(state, a, a)).toBe(state);
});

test("closing the active tab hands off to the next, the previous, or New thread", () => {
  let state = opened("a", "b", "c");
  state = closeTab({ ...state, active: idOf(state, "a") }, idOf(state, "a"));
  expect(shape(state)).toEqual(["[b]", "c"]);
  state = closeTab({ ...state, active: idOf(state, "c") }, idOf(state, "c"));
  expect(shape(state)).toEqual(["[b]"]);
  expect(shape(closeTab(state, state.active))).toEqual(["[new]"]);
  const fallback: Selection = { kind: "new", groupId: "repo" };
  expect(activeTab(closeTab(state, state.active, fallback)).selection).toEqual(fallback);
});

test("a removed thread closes its tile, handing the focus to the tile before it", () => {
  let state = openBeside(openBeside(opened("a"), "b"), "c");
  state = removeThread(state, "h", "c");
  expect(shape(state)).toEqual(["[a+b]"]);
  expect(activeTab(state).selection).toEqual(thread("b"));
  state = removeThread(state, "h", "b");
  expect(shape(state)).toEqual(["[a]"]);
  expect(activeTab(state).split).toBeUndefined();
});

test("a removed host's tabs close", () => {
  const state = openInTab(navigate(startTabs("h"), "h", thread("a")), "gone", "b");
  expect(shape(closeHostTabs(state, "gone", "h"))).toEqual(["[a]"]);
  const only = closeHostTabs(startTabs("gone"), "gone", "h");
  expect(activeTab(only).hostId).toBe("h");
});

test("swapping tiles keeps the dragged thread focused", () => {
  const state = swapTiles(openBeside(openBeside(opened("a"), "b"), "c"), 0, 2);
  expect(threadIdsOf(activeTab(state))).toEqual(["c", "b", "a"]);
  expect(activeTab(state).selection).toEqual(thread("a"));
});

test("stepping wraps around the strip", () => {
  const state = opened("a", "b");
  expect(shape(stepTab(state, 1))).toEqual(["[a]", "b"]);
  expect(shape(stepTab(state, -1))).toEqual(["[a]", "b"]);
});
