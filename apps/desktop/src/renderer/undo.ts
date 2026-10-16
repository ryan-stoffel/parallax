import { useSyncExternalStore } from "react";

/**
 * A sidebar toast (PLX-789): what just happened, and while it's the newest undoable one, Undo.
 * `undo` puts back what the user changed, never a run's progress. `commit` finishes a change held
 * back for Undo, such as a delete, once Undo can no longer take it back.
 */
export interface Toast {
  id: number;
  text: string;
  undo?: () => void;
  commit?: () => void;
}

/** How long a toast stays. */
export const toastMs = 5000;
/** The most toasts on screen; a newer one pushes out the oldest. */
const maxToasts = 3;

/**
 * `list` with `next` added. Only the newest toast can undo, since undoing an older change would
 * overwrite later ones, so an undoable `next` takes Undo from the rest. Returns those it took
 * Undo from, or pushed out, whose held-back changes must now be committed.
 */
export function pushToast(list: readonly Toast[], next: Toast) {
  const kept = next.undo ? list.map((t) => (t.undo ? { ...t, undo: undefined } : t)) : [...list];
  const settled = next.undo ? list.filter((t) => t.undo) : [];
  const all = [...kept, next];
  const out = all.slice(0, Math.max(0, all.length - maxToasts));
  for (const t of out) if (t.undo && !settled.some((s) => s.id === t.id)) settled.push(t);
  return { list: all.slice(-maxToasts), settled };
}

/** The toast ⌘Z undoes: the newest that still can. */
export const undoable = (list: readonly Toast[]) => list.findLast((t) => t.undo);

let toasts: readonly Toast[] = [];
let lastId = 0;
const listeners = new Set<() => void>();
const set = (next: readonly Toast[]) => {
  toasts = next;
  for (const l of listeners) l();
};
const commitAll = (list: readonly Toast[]) => {
  for (const t of list) t.commit?.();
};

/** Shows a toast, with Undo when `undo` is given. */
export function toast(text: string, undo?: () => void, commit?: () => void) {
  const id = ++lastId;
  const { list, settled } = pushToast(toasts, { id, text, undo, commit });
  set(list);
  commitAll(settled);
  setTimeout(() => dismiss(id), toastMs);
}

/** Takes a toast away, committing what it held back. */
export function dismiss(id: number) {
  const gone = toasts.find((t) => t.id === id);
  if (!gone) return;
  set(toasts.filter((t) => t.id !== id));
  if (gone.undo) gone.commit?.();
}

/** Runs a toast's Undo and takes it away. Without `id`, the newest that can (⌘Z). */
export function undo(id?: number) {
  const t = id === undefined ? undoable(toasts) : toasts.find((x) => x.id === id);
  if (!t?.undo) return false;
  set(toasts.filter((x) => x.id !== t.id));
  t.undo();
  return true;
}

/** Commits every held-back change now, as the window closes. */
export function flushToasts() {
  const held = toasts.filter((t) => t.undo);
  set([]);
  commitAll(held);
}

export const useToasts = () =>
  useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => toasts,
  );
