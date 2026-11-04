// The window's panes and their tabs (PLX-1289). The window holds up to four panes, rectangles on a
// grid (splitLayout.ts), and each pane holds tabs and shows one of them. A tab shows one view: a
// thread, an orchestrator, or New thread. App reads its open host and selection from the
// focused pane's shown tab, so these functions are the only way either changes. A thread is in one
// tab at most.

import type { Selection } from "./App";
import {
  allCells,
  cellsFilled,
  cellsLeft,
  cellSplit,
  evenCuts,
  lowestCell,
  maxTiles,
  usedCuts,
  zoneCells,
  type Cells,
  type GridCuts,
  type Zone,
} from "./splitLayout";

export interface ThreadTab {
  id: string;
  hostId: string;
  selection: Selection;
}

export interface TabPane {
  id: string;
  /** Where it sits on the grid. */
  cells: Cells;
  tabs: ThreadTab[];
  /** The id of the tab it shows. */
  active: string;
}

export interface Workspace {
  /** In reading order, by the first cell each covers. */
  panes: TabPane[];
  cuts: GridCuts;
  /** The id of the pane App reads from. */
  focused: string;
  /** All the panes in one tile, the focused one shown. */
  maximized?: boolean;
}

let lastId = 0;
const newTab = (hostId: string, selection: Selection): ThreadTab => ({
  id: `tab-${++lastId}`,
  hostId,
  selection,
});
const newPane = (tab: ThreadTab, cells: Cells): TabPane => ({
  id: `pane-${++lastId}`,
  cells,
  tabs: [tab],
  active: tab.id,
});

/** One pane with one New thread tab, as a window opens. */
export function startWorkspace(hostId: string, selection: Selection = { kind: "new" }): Workspace {
  const pane = newPane(newTab(hostId, selection), allCells);
  return { panes: [pane], cuts: evenCuts, focused: pane.id };
}

export const focusedPane = ({ panes, focused }: Workspace) => panes.find((p) => p.id === focused)!;

export const shownTab = ({ tabs, active }: TabPane) => tabs.find((t) => t.id === active)!;

/** The tab App reads its open host and selection from. */
export const activeTab = (state: Workspace) => shownTab(focusedPane(state));

export const threadOf = ({ selection }: ThreadTab) =>
  selection.kind === "thread" ? selection.threadId : undefined;

const allTabs = ({ panes }: Workspace) => panes.flatMap((p) => p.tabs);

const paneOf = ({ panes }: Workspace, tabId: string) =>
  panes.find((p) => p.tabs.some((t) => t.id === tabId));

const holderOf = (state: Workspace, hostId: string, threadId: string) =>
  allTabs(state).find((t) => t.hostId === hostId && threadOf(t) === threadId);

const withPane = (state: Workspace, pane: TabPane): Workspace => ({
  ...state,
  panes: state.panes.map((p) => (p.id === pane.id ? pane : p)),
});

/**
 * `state` with `panes` in reading order. A line the grid didn't have before starts even, not where
 * it last sat.
 */
function laidOut(state: Workspace, panes: TabPane[]): Workspace {
  return {
    ...state,
    panes: panes.toSorted((a, b) => lowestCell(a.cells) - lowestCell(b.cells)),
    cuts: usedCuts(
      state.panes.map((p) => p.cells),
      state.cuts,
    ),
  };
}

/** `tabs` with `tab` before tab `before`, or last. */
function placed(tabs: ThreadTab[], tab: ThreadTab, before?: string) {
  const at = tabs.findIndex((t) => t.id === before);
  return at === -1 ? [...tabs, tab] : tabs.toSpliced(at, 0, tab);
}

/** `tab` opened after the focused pane's shown tab. */
function openedNext(state: Workspace, tab: ThreadTab): Workspace {
  const pane = focusedPane(state);
  const tabs = pane.tabs.toSpliced(pane.tabs.indexOf(shownTab(pane)) + 1, 0, tab);
  return withPane(state, { ...pane, tabs, active: tab.id });
}

/**
 * `selection` without what only holds as it opens: a thread just started, and the pull request a
 * chip opened, which coming back to its tab shouldn't claim or reopen.
 */
function settled(selection: Selection): Selection {
  if (selection.kind !== "thread") return selection;
  const { threadId, subagent } = selection;
  return subagent ? { kind: "thread", threadId, subagent } : { kind: "thread", threadId };
}

/** `state` with its shown tab settled, when it isn't the one `before` showed. */
function arrived(state: Workspace, before: ThreadTab): Workspace {
  const shown = activeTab(state);
  if (shown.id === before.id) return state;
  const pane = focusedPane(state);
  const tabs = pane.tabs.map((t) =>
    t.id === shown.id ? { ...t, selection: settled(t.selection) } : t,
  );
  return withPane(state, { ...pane, tabs });
}

/** Tab `tabId` shown, and its pane focused. */
export function selectTab(state: Workspace, tabId: string): Workspace {
  const pane = paneOf(state, tabId);
  if (!pane) return state;
  const next = { ...withPane(state, { ...pane, active: tabId }), focused: pane.id };
  return arrived(next, activeTab(state));
}

/** The tab already showing `selection`: its thread's or orchestrator's, or the pane's New thread. */
function showing(state: Workspace, hostId: string, selection: Selection) {
  if (selection.kind === "new")
    return focusedPane(state).tabs.find((t) => t.selection.kind === "new");
  if (selection.kind === "thread") return holderOf(state, hostId, selection.threadId);
  return allTabs(state).find(
    (t) =>
      t.hostId === hostId &&
      t.selection.kind === "orchestrator" &&
      t.selection.orchestratorId === selection.orchestratorId,
  );
}

/**
 * Opens `selection`, as a browser follows a link: in the tab already showing it, else in the focused
 * pane's shown tab. New thread keeps a tab of its own, so it opens a new one there.
 */
export function navigate(state: Workspace, hostId: string, selection: Selection): Workspace {
  const shown = showing(state, hostId, selection);
  if (shown) {
    const pane = paneOf(state, shown.id)!;
    const tabs = pane.tabs.map((t) => (t.id === shown.id ? { ...t, hostId, selection } : t));
    return { ...withPane(state, { ...pane, tabs, active: shown.id }), focused: pane.id };
  }
  const pane = focusedPane(state);
  if (selection.kind === "new" && shownTab(pane).selection.kind !== "new")
    return openedNext(state, newTab(hostId, selection));
  const tabs = pane.tabs.map((t) => (t.id === pane.active ? { ...t, hostId, selection } : t));
  return withPane(state, { ...pane, tabs });
}

/** Thread `threadId` in a new tab of the focused pane, or the tab it's in already. */
export function openInTab(state: Workspace, hostId: string, threadId: string): Workspace {
  const selection: Selection = { kind: "thread", threadId };
  if (holderOf(state, hostId, threadId)) return navigate(state, hostId, selection);
  return openedNext(state, newTab(hostId, selection));
}

/**
 * Tab `tabId` closed. The tab after it, or else before it, shows in its place. A pane left with no
 * tabs closes, handing the focus to the pane before it. Closing the window's only tab opens
 * `fallback` in its place on the same host.
 */
export function closeTab(
  state: Workspace,
  tabId: string,
  fallback: Selection = { kind: "new" },
): Workspace {
  const pane = paneOf(state, tabId);
  if (!pane) return state;
  const at = pane.tabs.findIndex((t) => t.id === tabId);
  const tabs = pane.tabs.filter((t) => t.id !== tabId);
  if (tabs.length) {
    const active = pane.active === tabId ? tabs[Math.min(at, tabs.length - 1)]!.id : pane.active;
    return arrived(withPane(state, { ...pane, tabs, active }), activeTab(state));
  }
  if (state.panes.length === 1) return startWorkspace(pane.tabs[0]!.hostId, fallback);
  const side = state.panes.indexOf(pane);
  const rest = state.panes.filter((p) => p !== pane);
  const cells = cellsFilled(
    rest.map((p) => p.cells),
    pane.cells,
  );
  const panes = rest.map((p, i) => ({ ...p, cells: cells[i]! }));
  return arrived(
    {
      ...laidOut(state, panes),
      focused: state.focused === pane.id ? rest[Math.max(0, side - 1)]!.id : state.focused,
    },
    activeTab(state),
  );
}

/** Every tab on host `hostId` closed, once it's removed, leaving New thread on `fallbackHost`. */
export function closeHostTabs(state: Workspace, hostId: string, fallbackHost: string): Workspace {
  const next = allTabs(state)
    .filter((t) => t.hostId === hostId)
    .reduce<Workspace>((rest, t) => closeTab(rest, t.id), state);
  return allTabs(next).some((t) => t.hostId === hostId) ? startWorkspace(fallbackHost) : next;
}

/** Thread `threadId`'s tab closed, if it has one, as `closeTab` closes it. */
export function removeThread(
  state: Workspace,
  hostId: string,
  threadId: string,
  fallback?: Selection,
): Workspace {
  const tab = holderOf(state, hostId, threadId);
  return tab ? closeTab(state, tab.id, fallback) : state;
}

/**
 * Tab `tabId` moved to pane `paneId`, before tab `before` or else last, and shown. A pane it leaves
 * empty closes.
 */
export function moveTab(
  state: Workspace,
  tabId: string,
  paneId: string,
  before?: string,
): Workspace {
  const from = paneOf(state, tabId);
  const tab = from?.tabs.find((t) => t.id === tabId);
  if (!from || !tab) return state;
  if (before === tabId) return selectTab(state, tabId);
  if (from.id === paneId) {
    const tabs = placed(
      from.tabs.filter((t) => t.id !== tabId),
      tab,
      before,
    );
    const next = { ...withPane(state, { ...from, tabs, active: tabId }), focused: paneId };
    return arrived(next, activeTab(state));
  }
  const rest = closeTab(state, tabId);
  const pane = rest.panes.find((p) => p.id === paneId)!;
  const tabs = placed(pane.tabs, tab, before);
  const next = { ...withPane(rest, { ...pane, tabs, active: tabId }), focused: paneId };
  return arrived(next, activeTab(state));
}

/**
 * `tab`, in no pane yet, in a new pane on `taken`, focused. A pane that takes covers joins it as tabs
 * before it, and the rest keep what's left. A corner taken from a pane alone leaves a cell no rectangle
 * can fill, which gets a New thread pane.
 */
function claim(state: Workspace, tab: ThreadTab, taken: Cells): Workspace {
  const covered = state.panes.filter((p) => !cellsLeft(p.cells, taken));
  const pane: TabPane = {
    ...newPane(tab, taken),
    tabs: [...covered.flatMap((p) => p.tabs), tab],
  };
  const kept = state.panes
    .filter((p) => !covered.includes(p))
    .map((p) => ({ ...p, cells: cellsLeft(p.cells, taken) }));
  const free = kept.reduce((cells, p) => cells & ~p.cells, allCells & ~taken);
  const empty = free ? [newPane(newTab(tab.hostId, { kind: "new" }), free)] : [];
  return { ...laidOut(state, [...kept, pane, ...empty]), focused: pane.id, maximized: false };
}

/**
 * Tab `tabId` moved to zone `zone`, in a new pane there. The window's only tab stays. A pane it leaves
 * empty closes first, its room going to its neighbors, so a pane's last tab can trade places.
 */
export function moveToZone(state: Workspace, tabId: string, zone: Zone): Workspace {
  const from = paneOf(state, tabId);
  const tab = from?.tabs.find((t) => t.id === tabId);
  if (!from || !tab) return state;
  if (state.panes.length === 1 && from.tabs.length === 1) return selectTab(state, tabId);
  return arrived(claim(closeTab(state, tabId), tab, zoneCells[zone]), activeTab(state));
}

/** `selection`, a thread or an orchestrator, in a new pane at zone `zone`, moving a tab showing it. */
export function openInZone(
  state: Workspace,
  hostId: string,
  selection: Selection,
  zone: Zone,
): Workspace {
  const holder = showing(state, hostId, selection);
  if (holder) return moveToZone(state, holder.id, zone);
  return claim(state, newTab(hostId, selection), zoneCells[zone]);
}

/**
 * `selection`, a thread or an orchestrator, placed in pane `paneId`, before tab `before` or else last:
 * the tab showing it moves there, or a new one opens.
 */
export function placeView(
  state: Workspace,
  hostId: string,
  selection: Selection,
  paneId: string,
  before?: string,
): Workspace {
  const holder = showing(state, hostId, selection);
  if (holder) return moveTab(state, holder.id, paneId, before);
  const pane = state.panes.find((p) => p.id === paneId)!;
  const tab = newTab(hostId, selection);
  const tabs = placed(pane.tabs, tab, before);
  return { ...withPane(state, { ...pane, tabs, active: tab.id }), focused: paneId };
}

/**
 * Thread `threadId` beside the focused pane, in a new pane that splits it, or else the last pane with
 * room. A tab already alone in its pane is only shown. Once the window has all its panes, it's a tab in
 * the last pane that isn't focused.
 */
export function openBeside(state: Workspace, hostId: string, threadId: string): Workspace {
  const selection: Selection = { kind: "thread", threadId };
  const holder = holderOf(state, hostId, threadId);
  if (holder && paneOf(state, holder.id)!.tabs.length === 1) return selectTab(state, holder.id);
  const rest = holder ? closeTab(state, holder.id) : state;
  if (rest.panes.length >= maxTiles) {
    return placeView(
      state,
      hostId,
      selection,
      state.panes.findLast((p) => p.id !== state.focused)!.id,
    );
  }
  const single = (cells: Cells) => (cells & -cells) === cells;
  const focused = focusedPane(rest);
  const target = single(focused.cells) ? rest.panes.findLast((p) => !single(p.cells))! : focused;
  const tab = holder ?? newTab(hostId, selection);
  return arrived(claim(rest, tab, cellSplit(target.cells)), activeTab(state));
}

/** The tab `step` places from the shown one, across every pane in order, wrapping around. */
export function stepTab(state: Workspace, step: number): Workspace {
  const tabs = allTabs(state);
  const at = tabs.indexOf(activeTab(state));
  return selectTab(state, tabs[(at + step + tabs.length) % tabs.length]!.id);
}
