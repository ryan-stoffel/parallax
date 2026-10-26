// The sidebar's pins (0075): the order of pinned threads, the favorites' order, and an icon per
// pinned thread, with how Today shows its threads. They live on this computer until plxd keeps them
// (PLX-858); a pin itself is `pinned` on the thread, in plxd.
import type { ProjectIcon as ProjectIconValue } from "../protocol/generated/protocol";
import { stored } from "./stored";

/** The pins' order, by pin key (`<host>/<id>`). Pins it doesn't place go last. */
export interface PinLayout {
  order: string[];
}

/**
 * A stored layout, flattening one saved while pins had folders (PLX-1043): each folder's pins, nested
 * folders' too, in the folder's place.
 */
export function readLayout(raw: unknown, fallback: PinLayout): PinLayout {
  if (!raw || typeof raw !== "object" || !Array.isArray((raw as PinLayout).order)) return fallback;
  const folders = (raw as { folders?: Record<string, { items?: unknown }> }).folders ?? {};
  const order: string[] = [];
  const seen = new Set<string>();
  const add = (keys: unknown) => {
    if (!Array.isArray(keys)) return;
    for (const key of keys) {
      if (typeof key !== "string" || seen.has(key)) continue;
      seen.add(key);
      if (key.startsWith("folder:")) add(folders[key.slice("folder:".length)]?.items);
      else order.push(key);
    }
  };
  add((raw as PinLayout).order);
  return { order };
}

export const pinLayout = stored<PinLayout>("parallax:pinLayout", { order: [] }, readLayout);

/** An icon per pinned thread, by pin key, chosen from its menu. */
export const pinIcons = stored<Record<string, ProjectIconValue>>(
  "parallax:pinIcons",
  {},
  (raw, fallback) =>
    raw && typeof raw === "object" && !Array.isArray(raw)
      ? (raw as Record<string, ProjectIconValue>)
      : fallback,
);

const strings = (raw: unknown, fallback: string[]) =>
  Array.isArray(raw) ? raw.filter((k): k is string => typeof k === "string") : fallback;
const bool = (raw: unknown, fallback: boolean) => (typeof raw === "boolean" ? raw : fallback);

/**
 * Threads marked unread, by key, until they're opened again, as Conductor and T3 Code offer. The
 * real version is plxd clearing `seenAt`, which `thread/update` can't do yet.
 */
export const pinUnread = stored<string[]>("parallax:pinUnread", [], strings);

/** How Today groups its threads: not at all, by repo, or by day, as a list over time. */
export type TodayGroup = "none" | "repo" | "day";
export const todayGroup = stored<TodayGroup>("parallax:todayGroup", "none", (raw, fallback) =>
  raw === "none" || raw === "repo" || raw === "day" ? raw : fallback,
);

/** The favorites in the order they were moved into, by key; ones it doesn't name follow. */
export const favoriteOrder = stored<string[]>("parallax:favoriteOrder", [], strings);

/** Whether the Projects, favorites, and pins are folded away, leaving Today. */
export const topCollapsed = stored("parallax:topCollapsed", false, bool);

/** Today's groups folded shut, by group key (a repo's, or a day's). */
export const todayFolded = stored<string[]>("parallax:todayFolded", [], strings);

/** The favorites: pinned threads moved up into their squares, by key. */
export const pinFavorites = stored<string[]>("parallax:pinFavorites", [], strings);

/**
 * After how many hours a finished thread you've seen archives itself from Today, as Arc archives
 * tabs, or null for never, the default: T3 Code's users pushed back on auto-settle being on.
 */
export const autoClear = stored<number | null>("parallax:autoClear", null, (raw, fallback) =>
  raw === null || typeof raw === "number" ? raw : fallback,
);

/** Today as one-line rows: icon, title, and status, as T3 Code users ask (#6085). */
export const compactRows = stored("parallax:compactRows", false, bool);

/**
 * Whether the sidebar lists Projects (PLX-1043). Hidden, they list only while searching, and the
 * open one keeps its row.
 */
export const showProjects = stored("parallax:showProjects", true, bool);

/** Whether the empty pins' "drag a thread here" hint was closed, so it stays away. */
export const pinHintHidden = stored("parallax:pinHintHidden", false, bool);

/** A pin being dragged, read while dragging, when the drag's data can't be. */
export const pinDragType = "application/x-parallax-pin";
let dragging: { key: string; kind: "thread" } | undefined;
export const draggedPin = () => dragging;
export const setDraggedPin = (pin: typeof dragging) => {
  dragging = pin;
};

/** The pins `keys` shows, in the user's order: what the layout places, then the rest in `keys`' order. */
export function orderOf(layout: PinLayout, keys: readonly string[]): string[] {
  const live = new Set(keys);
  const placed = layout.order.filter((k) => live.has(k));
  const known = new Set(placed);
  return [...placed, ...keys.filter((k) => !known.has(k))];
}

/** The layout with the pins shown but not yet placed placed last, where they show. */
const settled = (layout: PinLayout, shown: readonly string[]): PinLayout => {
  const extra = shown.filter((k) => !layout.order.includes(k));
  return extra.length ? { order: [...layout.order, ...extra] } : layout;
};

/** Moves pin `key` just before or after `target`. */
export function placeAt(shown: readonly string[], key: string, target: string, after: boolean) {
  if (key === target) return;
  const order = settled(pinLayout.get(), shown).order.filter((k) => k !== key);
  const at = order.indexOf(target);
  order.splice(at < 0 ? order.length : at + (after ? 1 : 0), 0, key);
  pinLayout.set({ order });
}

/** Moves pin `key` to the end. */
export function moveToEnd(shown: readonly string[], key: string) {
  const order = settled(pinLayout.get(), shown).order.filter((k) => k !== key);
  pinLayout.set({ order: [...order, key] });
}

/** Forgets `key`, as when it's unpinned. */
export function forgetPin(key: string) {
  pinLayout.set({ order: pinLayout.get().order.filter((k) => k !== key) });
}
