// The sidebar's pins (0075): the order and folders of pinned threads, the favorites' order, and an
// icon per pinned thread, with how Today shows its threads. They live on this computer until plxd
// keeps them (PLX-858); a pin itself is `pinned` on the thread, in plxd (0073).
import type { ProjectIcon as ProjectIconValue } from "../protocol/generated/protocol";
import { memory, stored } from "./stored";
import { uuidv7 } from "./uuidv7";

export interface PinFolder {
  name: string;
  /** A project palette key, as an icon's color. */
  color?: string;
  /** Pin keys (`<host>/<id>`) and `folder:<id>` entries for folders inside it, in order. */
  items: string[];
}

/**
 * The pins' top level: pin keys and `folder:<id>` entries, as a folder's items, so folders nest.
 * Pins it doesn't place go last.
 */
export interface PinLayout {
  order: string[];
  folders: Record<string, PinFolder>;
}

const isLayout = (raw: unknown): raw is PinLayout =>
  !!raw &&
  typeof raw === "object" &&
  Array.isArray((raw as PinLayout).order) &&
  typeof (raw as PinLayout).folders === "object";

export const pinLayout = stored<PinLayout>(
  "parallax:pinLayout",
  { order: [], folders: {} },
  (raw, fallback) => (isLayout(raw) ? raw : fallback),
);

/** An icon per pinned thread, by pin key, chosen from its menu. */
export const pinIcons = stored<Record<string, ProjectIconValue>>(
  "parallax:pinIcons",
  {},
  (raw, fallback) =>
    raw && typeof raw === "object" && !Array.isArray(raw)
      ? (raw as Record<string, ProjectIconValue>)
      : fallback,
);

/**
 * The folder a thread being started goes in, set by a folder's New thread and named in the New
 * thread screen's heading until it starts, when it's pinned there (`fileStarted`), or the user
 * leaves the screen or opens a plain New thread.
 */
export const startIn = memory<string | null>(null);

/**
 * Files the thread `key` just started into the folder `startIn` names, last, and says whether it
 * did: not once the folder's gone.
 */
export function fileStarted(key: string): boolean {
  const id = startIn.get();
  startIn.set(null);
  const layout = pinLayout.get();
  const folder = id ? layout.folders[id] : undefined;
  if (!id || !folder) return false;
  pinLayout.set({
    ...layout,
    folders: {
      ...layout.folders,
      [id]: { ...folder, items: [...folder.items.filter((k) => k !== key), key] },
    },
  });
  return true;
}

/** The folder holding pin `key` directly, by the layout `folders`. */
export const folderHolding = (folders: Record<string, PinFolder>, key: string) =>
  Object.values(folders).find((f) => f.items.includes(key));

/** The folders from the top level down to the one holding `key`, outermost first. */
export function folderPath(folders: Record<string, PinFolder>, key: string): PinFolder[] {
  const path: PinFolder[] = [];
  const seen = new Set<string>();
  for (let at = key; ;) {
    const holder = Object.entries(folders).find(([, f]) => f.items.includes(at));
    if (!holder || seen.has(holder[0])) return path;
    seen.add(holder[0]);
    path.unshift(holder[1]);
    at = `folder:${holder[0]}`;
  }
}

const strings = (raw: unknown, fallback: string[]) =>
  Array.isArray(raw) ? raw.filter((k): k is string => typeof k === "string") : fallback;

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

/** Whether the favorites and pins are folded down to a strip and a summary line. */
export const topCollapsed = stored<boolean>("parallax:topCollapsed", false, (raw, fallback) =>
  typeof raw === "boolean" ? raw : fallback,
);

/** Today's groups folded shut, by group key (a repo's, or a day's). */
export const todayFolded = stored<string[]>("parallax:todayFolded", [], strings);

/** The favorites besides the Projects: pinned threads moved up into their squares, by key. */
export const pinFavorites = stored<string[]>("parallax:pinFavorites", [], strings);

/**
 * After how many hours a finished thread you've seen archives itself from Today, as Arc archives
 * tabs, or null for never, the default: T3 Code's users pushed back on auto-settle being on.
 */
export const autoClear = stored<number | null>("parallax:autoClear", null, (raw, fallback) =>
  raw === null || typeof raw === "number" ? raw : fallback,
);

/** Today as one-line rows: icon, title, and status, as T3 Code users ask (#6085). */
export const compactRows = stored<boolean>("parallax:compactRows", false, (raw, fallback) =>
  typeof raw === "boolean" ? raw : fallback,
);

/** Whether the empty pins' "drag a thread here" hint was closed, so it stays away. */
export const pinHintHidden = stored<boolean>("parallax:pinHintHidden", false, (raw, fallback) =>
  typeof raw === "boolean" ? raw : fallback,
);

/** A folder to name in place, as one the add palette just made. */
export const pinNaming = memory<string | null>(null);

/** An empty folder, last, at the top level from the add palette, or inside folder `inside`. */
export function createFolder(inside?: string): string {
  const id = uuidv7();
  const layout = pinLayout.get();
  const holder = inside && layout.folders[inside] ? inside : undefined;
  const next = withItems(layout, holder, [...itemsOf(layout, holder), `folder:${id}`]);
  pinLayout.set({ ...next, folders: { ...next.folders, [id]: { name: "New folder", items: [] } } });
  return id;
}

/** A pin or folder being dragged, read while dragging, when the drag's data can't be. */
export const pinDragType = "application/x-parallax-pin";
let dragging: { key: string; kind: "thread" | "project" | "folder" } | undefined;
export const draggedPin = () => dragging;
export const setDraggedPin = (pin: typeof dragging) => {
  dragging = pin;
};

export type PinEntry =
  | { kind: "pin"; key: string }
  | {
      kind: "folder";
      id: string;
      folder: PinFolder;
      /** What's directly in it, pins and folders, as shown. */
      children: PinEntry[];
      /** Every pin shown anywhere inside it, for its status and count. */
      keys: string[];
    };

/** Whether folder `id`'s tree, nested folders included, names any pin at all. */
function holdsPins(layout: PinLayout, id: string, seen = new Set<string>()): boolean {
  if (seen.has(id)) return false;
  seen.add(id);
  return (layout.folders[id]?.items ?? []).some((k) =>
    k.startsWith("folder:") ? holdsPins(layout, k.slice("folder:".length), seen) : true,
  );
}

/**
 * The entries for the pins `keys` shows, as a tree in the user's order: what the layout places,
 * where it places it, then the rest at the top level in `keys`' order. A folder shows while
 * anything inside it does, or while it holds no pins at all, as one just made; one whose pins are
 * only filtered out doesn't.
 */
export function entriesOf(layout: PinLayout, keys: readonly string[]): PinEntry[] {
  const live = new Set(keys);
  const placed = new Set<string>();
  const seen = new Set<string>();
  const build = (ids: readonly string[]): PinEntry[] =>
    ids.flatMap((id): PinEntry[] => {
      if (id.startsWith("folder:")) {
        const folderId = id.slice("folder:".length);
        const folder = layout.folders[folderId];
        // A folder named twice, or inside itself, shows once.
        if (!folder || seen.has(folderId)) return [];
        seen.add(folderId);
        const children = build(folder.items);
        const inside = children.flatMap((c) => (c.kind === "pin" ? [c.key] : c.keys));
        return inside.length || !holdsPins(layout, folderId)
          ? [{ kind: "folder", id: folderId, folder, children, keys: inside }]
          : [];
      }
      if (!live.has(id) || placed.has(id)) return [];
      placed.add(id);
      return [{ kind: "pin", key: id }];
    });
  const out = build(layout.order);
  for (const k of keys) if (!placed.has(k)) out.push({ kind: "pin", key: k });
  return out;
}

/** The items of folder `id`, or of the top level for undefined. */
function itemsOf(layout: PinLayout, id: string | undefined): string[] {
  return id ? (layout.folders[id]?.items ?? []) : layout.order;
}

/** The layout with folder `id`'s items, or the top level's for undefined, set to `items`. */
function withItems(layout: PinLayout, id: string | undefined, items: string[]): PinLayout {
  if (!id) return { ...layout, order: items };
  const folder = layout.folders[id];
  return folder
    ? { ...layout, folders: { ...layout.folders, [id]: { ...folder, items } } }
    : layout;
}

/** The folder whose items hold `key`, a pin or `folder:<id>`, or undefined for the top level. */
export const containerOf = (layout: PinLayout, key: string) =>
  Object.entries(layout.folders).find(([, f]) => f.items.includes(key))?.[0];

/** Whether folder `id` is folder `outer` or anywhere inside it, so `outer` can't move into it. */
export function folderWithin(layout: PinLayout, id: string | undefined, outer: string): boolean {
  for (
    const seen = new Set<string>();
    id && !seen.has(id);
    id = containerOf(layout, `folder:${id}`)
  ) {
    if (id === outer) return true;
    seen.add(id);
  }
  return false;
}

/** The layout with the top-level pins shown but not yet placed placed last, where they show. */
function settled(layout: PinLayout, entries: readonly PinEntry[]): PinLayout {
  const placed = new Set([
    ...layout.order,
    ...Object.values(layout.folders).flatMap((f) => f.items),
  ]);
  const extra = entries.flatMap((e) => (e.kind === "pin" && !placed.has(e.key) ? [e.key] : []));
  return extra.length ? { ...layout, order: [...layout.order, ...extra] } : layout;
}

/** The layout with `key` taken out of the top level and every folder. */
const without = (layout: PinLayout, key: string): PinLayout => ({
  order: layout.order.filter((k) => k !== key),
  folders: Object.fromEntries(
    Object.entries(layout.folders).map(([id, f]) => [
      id,
      { ...f, items: f.items.filter((k) => k !== key) },
    ]),
  ),
});

/** The layout with `key` in `target`'s place, wherever `target` is, and `target` gone. */
function replacing(layout: PinLayout, target: string, key: string): PinLayout {
  const holder = containerOf(layout, target);
  const items = [...itemsOf(layout, holder)];
  const at = items.indexOf(target);
  if (at < 0) items.push(key);
  else items.splice(at, 1, key);
  return withItems(layout, holder, items);
}

/** A folder of `target` and `dragged`, in `target`'s place, nested where `target` was. */
export function makeFolder(entries: readonly PinEntry[], target: string, dragged: string): string {
  const id = uuidv7();
  const base = replacing(
    without(settled(pinLayout.get(), entries), dragged),
    target,
    `folder:${id}`,
  );
  pinLayout.set({
    ...base,
    folders: { ...base.folders, [id]: { name: "New folder", items: [target, dragged] } },
  });
  return id;
}

/** A folder of `key` alone, in its place, from a pin's menu. Returns the new folder's id. */
export function wrapInFolder(entries: readonly PinEntry[], key: string): string {
  const id = uuidv7();
  const base = replacing(settled(pinLayout.get(), entries), key, `folder:${id}`);
  pinLayout.set({
    ...base,
    folders: { ...base.folders, [id]: { name: "New folder", items: [key] } },
  });
  return id;
}

/** Folders left open, by id, kept on this computer so they stay open across launches. */
export const pinOpen = stored<string[]>("parallax:pinOpen", [], (raw, fallback) =>
  Array.isArray(raw) ? raw.filter((id): id is string => typeof id === "string") : fallback,
);

/**
 * Moves `key`, a pin or `folder:<id>`, just before or after `target`, in whatever folder holds
 * `target`. A folder never moves into itself.
 */
export function placeAt(entries: readonly PinEntry[], key: string, target: string, after: boolean) {
  if (key === target) return;
  const layout = settled(pinLayout.get(), entries);
  const holder = containerOf(layout, target);
  if (key.startsWith("folder:") && folderWithin(layout, holder, key.slice("folder:".length)))
    return;
  const base = without(layout, key);
  const items = [...itemsOf(base, holder)];
  const at = items.indexOf(target);
  items.splice(at < 0 ? items.length : at + (after ? 1 : 0), 0, key);
  pinLayout.set(withItems(base, holder, items));
}

/**
 * Moves `key`, a pin or `folder:<id>`, into folder `id`, last, or `first`. A folder never moves
 * into itself.
 */
export function addToFolder(entries: readonly PinEntry[], id: string, key: string, first = false) {
  const layout = settled(pinLayout.get(), entries);
  if (!layout.folders[id]) return;
  if (key.startsWith("folder:") && folderWithin(layout, id, key.slice("folder:".length))) return;
  const base = without(layout, key);
  const items = itemsOf(base, id);
  pinLayout.set(withItems(base, id, first ? [key, ...items] : [...items, key]));
}

/** Moves `key` to the end of the top level. */
export function moveToEnd(entries: readonly PinEntry[], key: string) {
  const base = without(settled(pinLayout.get(), entries), key);
  pinLayout.set({ ...base, order: [...base.order, key] });
}

/** Moves `key` out of its folder, just after that folder, one level up. */
export function moveOut(entries: readonly PinEntry[], key: string) {
  const layout = settled(pinLayout.get(), entries);
  const holder = containerOf(layout, key);
  if (!holder) return;
  placeAt(entries, key, `folder:${holder}`, true);
}

/** Forgets `key`, as when it's unpinned. */
export function forgetPin(key: string) {
  pinLayout.set(without(pinLayout.get(), key));
}

/** Changes folder `id`'s name or color. */
export function updateFolder(id: string, change: Partial<Pick<PinFolder, "name" | "color">>) {
  const layout = pinLayout.get();
  const folder = layout.folders[id];
  if (folder)
    pinLayout.set({ ...layout, folders: { ...layout.folders, [id]: { ...folder, ...change } } });
}

/** Takes a folder apart, what's in it, nested folders included, in its place. */
export function ungroup(entries: readonly PinEntry[], id: string) {
  const layout = settled(pinLayout.get(), entries);
  const items = layout.folders[id]?.items ?? [];
  const holder = containerOf(layout, `folder:${id}`);
  const list = itemsOf(layout, holder).flatMap((k) => (k === `folder:${id}` ? items : [k]));
  const { [id]: _gone, ...folders } = withItems(layout, holder, list).folders;
  pinLayout.set({ ...withItems(layout, holder, list), folders });
}
