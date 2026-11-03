import { expect, test } from "vite-plus/test";

import type { Selection } from "./App";
import {
  activeTab,
  closeHostTabs,
  closeTab,
  focusedPane,
  moveTab,
  moveToNewPane,
  navigate,
  openBeside,
  openInTab,
  placeView,
  removeThread,
  selectTab,
  startWorkspace,
  stepTab,
  threadOf,
  type ThreadTab,
  type Workspace,
} from "./tabState";

const thread = (threadId: string): Selection => ({ kind: "thread", threadId });
const name = (tab: ThreadTab) => threadOf(tab) ?? tab.selection.kind;
/** Each pane's tabs, its shown one in brackets, the focused pane's with a star. */
const shape = (state: Workspace) =>
  state.panes.map((pane) => {
    const tabs = pane.tabs.map((t) => (t.id === pane.active ? `[${name(t)}]` : name(t)));
    return tabs.join(" ") + (pane.id === state.focused ? " *" : "");
  });
const opened = (...ids: string[]) =>
  ids.reduce(
    (state, id) => openInTab(state, "h", id),
    navigate(startWorkspace("h"), "h", thread(ids[0]!)),
  );
const tabOf = (state: Workspace, threadId: string) =>
  state.panes.flatMap((p) => p.tabs).find((t) => threadOf(t) === threadId)!.id;
const paneAt = (state: Workspace, at: number) => state.panes[at]!.id;

test("a thread opens in the shown tab, and in the tab that already holds it", () => {
  let state = navigate(startWorkspace("h"), "h", thread("a"));
  expect(shape(state)).toEqual(["[a] *"]);
  state = navigate(state, "h", thread("b"));
  expect(shape(state)).toEqual(["[b] *"]);
  state = navigate(openInTab(state, "h", "c"), "h", thread("b"));
  expect(shape(state)).toEqual(["[b] c *"]);
});

test("a thread open in another pane focuses that pane", () => {
  const state = navigate(openBeside(opened("a"), "h", thread("b")), "h", thread("a"));
  expect(shape(state)).toEqual(["[a] *", "[b]"]);
});

test("coming back to a tab doesn't claim its start or reopen a chip's pull request", () => {
  let state = navigate(startWorkspace("h"), "h", {
    kind: "thread",
    threadId: "a",
    started: true,
    pr: { url: "u" },
  });
  state = openInTab(state, "h", "b");
  expect(activeTab(selectTab(state, tabOf(state, "a"))).selection).toEqual(thread("a"));
  // Closing the tab beside it comes back to it the same way.
  const started = navigate(startWorkspace("h"), "h", {
    kind: "thread",
    threadId: "a",
    started: true,
  });
  const both = openInTab(started, "h", "b");
  expect(activeTab(closeTab(both, tabOf(both, "b"))).selection).toEqual(thread("a"));
  // Staying on it keeps them.
  expect(activeTab(selectTab(started, tabOf(started, "a"))).selection).toEqual({
    kind: "thread",
    threadId: "a",
    started: true,
  });
});

test("the same thread id on another host is another tab's thread", () => {
  const state = openInTab(navigate(startWorkspace("h"), "h", thread("a")), "other", "a");
  expect(focusedPane(state).tabs.map((t) => t.hostId)).toEqual(["h", "other"]);
});

test("New thread keeps one tab in a pane, which the next thread opens in", () => {
  let state = navigate(navigate(startWorkspace("h"), "h", thread("a")), "h", { kind: "new" });
  expect(shape(state)).toEqual(["a [new] *"]);
  state = navigate(navigate(state, "h", thread("a")), "h", { kind: "new", groupId: "repo" });
  expect(shape(state)).toEqual(["a [new] *"]);
  expect(activeTab(state).selection).toEqual({ kind: "new", groupId: "repo" });
  expect(shape(navigate(state, "h", thread("b")))).toEqual(["a [b] *"]);
});

test("each pane can have its own New thread tab", () => {
  const state = openBeside(opened("a"), "h", thread("b"));
  const both = navigate(navigate(state, "h", { kind: "new" }), "h", thread("a"));
  expect(shape(navigate(both, "h", { kind: "new" }))).toEqual([
    "[a] new *".replace("[a] new", "a [new]"),
    "b [new]",
  ]);
});

test("beside opens a new last pane with even ratios, moving a tab it already has", () => {
  const state = openBeside(opened("a", "b"), "h", thread("a"));
  expect(shape(state)).toEqual(["[b]", "[a] *"]);
  expect(state.ratios).toEqual([0.5]);
  expect(shape(openBeside(state, "h", thread("c")))).toEqual(["[b]", "[a]", "[c] *"]);
});

test("a full window takes the next thread as a tab", () => {
  let state = opened("a");
  for (const id of ["b", "c", "d"]) state = openBeside(state, "h", thread(id));
  expect(shape(openBeside(state, "h", thread("e")))).toEqual(["[a]", "[b]", "c [e] *", "[d]"]);
  expect(shape(openBeside(state, "h", thread("e"), paneAt(state, 0)))).toEqual([
    "a [e] *",
    "[b]",
    "[c]",
    "[d]",
  ]);
});

test("a tab moves along its pane, or to another, closing a pane it leaves empty", () => {
  let state = opened("a", "b", "c");
  state = moveTab(state, tabOf(state, "c"), state.focused, tabOf(state, "a"));
  expect(shape(state)).toEqual(["[c] a b *"]);
  state = moveToNewPane(state, tabOf(state, "b"));
  expect(shape(state)).toEqual(["[c] a", "[b] *"]);
  state = moveTab(state, tabOf(state, "b"), paneAt(state, 0), tabOf(state, "a"));
  expect(shape(state)).toEqual(["c [b] a *"]);
  expect(state.ratios).toEqual([]);
});

test("a tab dropped before itself stays, as does the only tab moving to a new pane", () => {
  const state = opened("a", "b");
  const a = tabOf(state, "a");
  expect(shape(moveTab(state, a, state.focused, a))).toEqual(["[a] b *"]);
  const alone = opened("a");
  expect(shape(moveToNewPane(alone, tabOf(alone, "a")))).toEqual(["[a] *"]);
});

test("a first pane's only tab moved to a new pane goes last, swapping them", () => {
  const state = openBeside(opened("a"), "h", thread("b"));
  const moved = moveToNewPane(state, tabOf(state, "a"));
  expect(shape(moved)).toEqual(["[b]", "[a] *"]);
  expect(moved.ratios).toEqual([0.5]);
});

test("an orchestrator placed in a pane opens there, and beside opens a pane for it", () => {
  const orchestrator: Selection = { kind: "orchestrator", orchestratorId: "o" };
  const state = openBeside(opened("a"), "h", thread("b"));
  const placed = placeView(state, "h", orchestrator, paneAt(state, 0));
  expect(shape(placed)).toEqual(["a [orchestrator] *", "[b]"]);
  expect(shape(openBeside(state, "h", orchestrator))).toEqual(["[a]", "[b]", "[orchestrator] *"]);
  // The tab already showing it moves.
  expect(shape(placeView(placed, "h", orchestrator, paneAt(placed, 1)))).toEqual([
    "[a]",
    "b [orchestrator] *",
  ]);
});

test("dragging a background tab into view doesn't claim its start or reopen its pull request", () => {
  const start: Selection = { kind: "thread", threadId: "a", started: true, pr: { url: "u" } };
  let state = openInTab(navigate(startWorkspace("h"), "h", start), "h", "b");
  state = openBeside(state, "h", thread("c"));
  const a = tabOf(state, "a");
  expect(activeTab(moveTab(state, a, paneAt(state, 1))).selection).toEqual(thread("a"));
  expect(activeTab(moveToNewPane(state, a)).selection).toEqual(thread("a"));
  // Moving the shown tab along its own pane keeps them.
  const shown = selectTab(state, tabOf(state, "b"));
  const started = navigate(shown, "h", start);
  expect(activeTab(moveTab(started, a, started.focused)).selection).toEqual(start);
});

test("a sidebar thread placed in a pane opens there, or moves the tab it's in", () => {
  let state = opened("a", "b");
  state = placeView(state, "h", thread("c"), state.focused, tabOf(state, "b"));
  expect(shape(state)).toEqual(["a [c] b *"]);
  state = placeView(state, "h", thread("b"), state.focused, tabOf(state, "a"));
  expect(shape(state)).toEqual(["[b] a c *"]);
});

test("closing shows the next tab or else the previous, then closes the pane, then leaves New thread", () => {
  let state = opened("a", "b", "c");
  state = closeTab(selectTab(state, tabOf(state, "a")), tabOf(state, "a"));
  expect(shape(state)).toEqual(["[b] c *"]);
  state = closeTab(selectTab(state, tabOf(state, "c")), tabOf(state, "c"));
  expect(shape(state)).toEqual(["[b] *"]);
  const fallback: Selection = { kind: "new", groupId: "repo" };
  expect(activeTab(closeTab(state, tabOf(state, "b"), fallback)).selection).toEqual(fallback);
  const split = openBeside(openBeside(opened("a"), "h", thread("b")), "h", thread("c"));
  const closed = removeThread(split, "h", "c");
  expect(shape(closed)).toEqual(["[a]", "[b] *"]);
  expect(closed.ratios).toEqual([0.5]);
});

test("a removed host's tabs close", () => {
  const state = openInTab(navigate(startWorkspace("h"), "h", thread("a")), "gone", "b");
  expect(shape(closeHostTabs(state, "gone", "h"))).toEqual(["[a] *"]);
  expect(activeTab(closeHostTabs(startWorkspace("gone"), "gone", "h")).hostId).toBe("h");
});

test("stepping goes through every pane's tabs, wrapping around", () => {
  const state = openBeside(opened("a", "b"), "h", thread("c"));
  expect(shape(stepTab(state, 1))).toEqual(["[a] b *", "[c]"]);
  expect(shape(stepTab(state, -1))).toEqual(["a [b] *", "[c]"]);
});
