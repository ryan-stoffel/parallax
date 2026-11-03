// The window's tabs (PLX-1289). Each tab shows one view: a thread, up to four tiled threads, an
// orchestrator, or New thread. App reads its open host, selection, and split from the active tab,
// so these functions are the only way any of them changes. A thread is in one tab at most.

import type { Selection } from "./App";
import { evenRatio, maxTiles, ratiosWithout } from "./splitLayout";

/**
 * Two to four threads tiled side by side (PLX-587, PLX-1082), in their Fibonacci layout's order,
 * with each cut's share (splitLayout.ts): one fewer ratio than threads. Opening another unmaximizes
 * it.
 */
export interface Split {
  threadIds: string[];
  ratios: number[];
  /** All of them in one tile, the focused one shown, as tabs. */
  maximized?: boolean;
}

/** One tab. With a `split`, `selection` is the focused one of its threads. */
export interface ThreadTab {
  id: string;
  hostId: string;
  selection: Selection;
  split?: Split;
}

export interface Tabs {
  tabs: ThreadTab[];
  /** The id of the tab the window shows. */
  active: string;
}

let lastId = 0;
const newTab = (hostId: string, selection: Selection): ThreadTab => ({
  id: `tab-${++lastId}`,
  hostId,
  selection,
});

/** One New thread tab, as a window opens. */
export function startTabs(hostId: string, selection: Selection = { kind: "new" }): Tabs {
  const tab = newTab(hostId, selection);
  return { tabs: [tab], active: tab.id };
}

export const activeTab = ({ tabs, active }: Tabs) => tabs.find((t) => t.id === active)!;

/** The threads `tab` shows. */
export const threadIdsOf = ({ split, selection }: ThreadTab): string[] =>
  split ? split.threadIds : selection.kind === "thread" ? [selection.threadId] : [];

const holderOf = ({ tabs }: Tabs, hostId: string, threadId: string) =>
  tabs.find((t) => t.hostId === hostId && threadIdsOf(t).includes(threadId));

const updated = (tabs: ThreadTab[], next: ThreadTab) =>
  tabs.map((t) => (t.id === next.id ? next : t));

/** `tab` placed before tab `before`, or last. */
function inserted(tabs: ThreadTab[], tab: ThreadTab, before?: string): ThreadTab[] {
  const at = tabs.findIndex((t) => t.id === before);
  return at === -1 ? [...tabs, tab] : [...tabs.slice(0, at), tab, ...tabs.slice(at)];
}

/** The tab already showing `selection`: its thread's or orchestrator's, or the one New thread tab. */
function showing({ tabs }: Tabs, hostId: string, selection: Selection) {
  if (selection.kind === "new") return tabs.find((t) => t.selection.kind === "new");
  if (selection.kind === "thread")
    return holderOf({ tabs, active: "" }, hostId, selection.threadId);
  return tabs.find(
    (t) =>
      t.hostId === hostId &&
      t.selection.kind === "orchestrator" &&
      t.selection.orchestratorId === selection.orchestratorId,
  );
}

/**
 * Opens `selection`, as a browser follows a link: in the tab already showing it, else in the active
 * tab. A tab with a split keeps its layout and New thread keeps a tab of its own, so those open a
 * new tab after the active one.
 */
export function navigate(state: Tabs, hostId: string, selection: Selection): Tabs {
  const active = activeTab(state);
  const shown = showing(state, hostId, selection);
  if (shown) {
    return {
      tabs: updated(state.tabs, { ...shown, hostId, selection }),
      active: shown.id,
    };
  }
  if (active.split || (selection.kind === "new" && active.selection.kind !== "new")) {
    const tab = newTab(hostId, selection);
    const next = state.tabs[state.tabs.indexOf(active) + 1]?.id;
    return { tabs: inserted(state.tabs, tab, next), active: tab.id };
  }
  return { ...state, tabs: updated(state.tabs, { ...active, hostId, selection }) };
}

/** Thread `threadId` in a tab of its own before tab `before`, or last, or the tab it's in already. */
export function openInTab(state: Tabs, hostId: string, threadId: string, before?: string): Tabs {
  const holder = holderOf(state, hostId, threadId);
  if (holder) return navigate(state, hostId, { kind: "thread", threadId });
  const tab = newTab(hostId, { kind: "thread", threadId });
  const next = before ?? state.tabs[state.tabs.indexOf(activeTab(state)) + 1]?.id;
  return { tabs: inserted(state.tabs, tab, next), active: tab.id };
}

/** Moves tab `id` before tab `before`, or last, without changing which one is active. */
export function moveTab(state: Tabs, id: string, before?: string): Tabs {
  const tab = state.tabs.find((t) => t.id === id);
  if (!tab || id === before) return state;
  return {
    ...state,
    tabs: inserted(
      state.tabs.filter((t) => t.id !== id),
      tab,
      before,
    ),
  };
}

/**
 * Tab `id` closed. The tab after it, or else before it, takes over when it's active. Closing the
 * only tab opens `fallback` in its place on the same host.
 */
export function closeTab(state: Tabs, id: string, fallback: Selection = { kind: "new" }): Tabs {
  const at = state.tabs.findIndex((t) => t.id === id);
  if (at === -1) return state;
  const tabs = state.tabs.filter((t) => t.id !== id);
  if (!tabs.length) return startTabs(state.tabs[at]!.hostId, fallback);
  return {
    tabs,
    active: state.active === id ? tabs[Math.min(at, tabs.length - 1)]!.id : state.active,
  };
}

/** Every tab on host `hostId` closed, once it's removed, leaving New thread on `fallbackHost`. */
export function closeHostTabs(state: Tabs, hostId: string, fallbackHost: string): Tabs {
  const tabs = state.tabs.filter((t) => t.hostId !== hostId);
  if (!tabs.length) return startTabs(fallbackHost);
  return { tabs, active: tabs.some((t) => t.id === state.active) ? state.active : tabs[0]!.id };
}

/**
 * Thread `threadId` taken out of its tab, which closes unless the rest of its split stays. The
 * thread tiled before it takes the focus when it had it, and a split left with one thread ends.
 */
export function removeThread(
  state: Tabs,
  hostId: string,
  threadId: string,
  fallback?: Selection,
): Tabs {
  const tab = holderOf(state, hostId, threadId);
  if (!tab) return state;
  if (!tab.split) return closeTab(state, tab.id, fallback);
  const at = tab.split.threadIds.indexOf(threadId);
  const rest = tab.split.threadIds.filter((id) => id !== threadId);
  const focused = tab.selection.kind === "thread" && tab.selection.threadId === threadId;
  return {
    ...state,
    tabs: updated(state.tabs, {
      ...tab,
      selection: focused ? { kind: "thread", threadId: rest[Math.max(0, at - 1)]! } : tab.selection,
      split:
        rest.length > 1
          ? {
              ...tab.split,
              threadIds: rest,
              ratios: ratiosWithout(tab.split.ratios, rest.length + 1, at),
            }
          : undefined,
    }),
  };
}

/**
 * A thread dropped on the tab strip, before tab `before` or last: its tab moves there, or it leaves
 * a split for a tab of its own there.
 */
export function dropInStrip(state: Tabs, hostId: string, threadId: string, before?: string): Tabs {
  const holder = holderOf(state, hostId, threadId);
  if (holder && !holder.split) return { ...moveTab(state, holder.id, before), active: holder.id };
  const rest = holder ? removeThread(state, hostId, threadId) : state;
  const tab = newTab(hostId, { kind: "thread", threadId });
  return { tabs: inserted(rest.tabs, tab, before), active: tab.id };
}

/**
 * Tiles `threadId` beside the active tab's thread and focuses it, moving it out of any other tab:
 * at tile `at`, by default a new last tile while there's room, else the last tile that isn't
 * focused, which it replaces. A thread already tiled is only focused.
 */
export function openBeside(state: Tabs, threadId: string, at?: number): Tabs {
  const tab = activeTab(state);
  if (tab.selection.kind !== "thread" || tab.selection.threadId === threadId) return state;
  const focused = tab.selection.threadId;
  const ids = threadIdsOf(tab);
  const selection: Selection = { kind: "thread", threadId };
  if (ids.includes(threadId)) {
    return { ...state, tabs: updated(state.tabs, { ...tab, selection }) };
  }
  const tile =
    at ?? (ids.length < maxTiles ? ids.length : ids.findLastIndex((id) => id !== focused));
  const threadIds = [...ids];
  const ratios = [...(tab.split?.ratios ?? [])];
  if (tile === ids.length) ratios.push(evenRatio);
  threadIds[tile] = threadId;
  const { tabs } = removeThread(state, tab.hostId, threadId);
  return {
    tabs: updated(tabs, { ...tab, selection, split: { threadIds, ratios } }),
    active: tab.id,
  };
}

/** The active tab with its tiles `a` and `b` swapped, and `a`'s thread, now at `b`, focused. */
export function swapTiles(state: Tabs, a: number, b: number): Tabs {
  const tab = activeTab(state);
  if (!tab.split) return state;
  const threadIds = [...tab.split.threadIds];
  const moved = threadIds[a]!;
  threadIds[a] = threadIds[b]!;
  threadIds[b] = moved;
  return {
    ...state,
    tabs: updated(state.tabs, {
      ...tab,
      selection: { kind: "thread", threadId: moved },
      split: { ...tab.split, threadIds },
    }),
  };
}

/** The active tab with its split changed, as a divider or Maximize does. */
export const withSplit = (state: Tabs, split: Split): Tabs => ({
  ...state,
  tabs: updated(state.tabs, { ...activeTab(state), split }),
});

/** The tab `step` places from the active one, wrapping around. */
export function stepTab(state: Tabs, step: number): Tabs {
  const at = state.tabs.indexOf(activeTab(state));
  const count = state.tabs.length;
  return { ...state, active: state.tabs[(at + step + count) % count]!.id };
}
