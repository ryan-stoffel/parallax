import { stored } from "./stored";

// What Thread details shows, how it's arranged, kept on this computer (PLX-1343).

// Ids are stored, so never rename one.
export const THREAD_DETAILS_ITEMS = [
  { id: "environment", label: "Computer and folder" },
  { id: "openIn", label: "Open in editor and terminal" },
  { id: "actions", label: "Repository actions" },
  { id: "project", label: "Project" },
  { id: "branch", label: "Branch" },
  { id: "changes", label: "Changes" },
  { id: "gitActions", label: "Git actions" },
  { id: "prs", label: "Pull requests" },
  { id: "context", label: "Context" },
  { id: "lineage", label: "Lineage" },
] as const;

export type ThreadDetailsItemId = (typeof THREAD_DETAILS_ITEMS)[number]["id"];

/** The cards that can be collapsed and reordered. The workspace card stays first. */
export type ThreadDetailsCardId = "git" | "prs" | "context" | "lineage";
const CARD_ORDER: ThreadDetailsCardId[] = ["git", "prs", "context", "lineage"];

type Prefs = {
  /** Only the items hidden, so one added later shows. */
  hidden: ThreadDetailsItemId[];
  collapsed: ThreadDetailsCardId[];
  order: ThreadDetailsCardId[];
};
const defaults: Prefs = { hidden: [], collapsed: [], order: CARD_ORDER };

/** A stored list of `known` values, without any it doesn't know. */
const known = <T extends string>(raw: unknown, allowed: readonly T[]): T[] =>
  Array.isArray(raw) ? raw.filter((value): value is T => allowed.includes(value)) : [];

const prefs = stored<Prefs>("parallax.threadDetails.prefs", defaults, (raw) => {
  const { hidden, collapsed, order } = (raw ?? {}) as Partial<Record<keyof Prefs, unknown>>;
  return {
    hidden: known(
      hidden,
      THREAD_DETAILS_ITEMS.map((item) => item.id),
    ),
    collapsed: known(collapsed, CARD_ORDER),
    order: known(order, CARD_ORDER),
  };
});

/** Which items show, how to ask about a card, and whether anything differs from the default. */
export function useThreadDetailsPrefs() {
  const { hidden, collapsed, order } = prefs.use();
  return {
    shows: (item: ThreadDetailsItemId) => !hidden.includes(item),
    isCollapsed: (card: ThreadDetailsCardId) => collapsed.includes(card),
    /** Where a card sits in the stack, after the workspace card. One new to `order` goes last. */
    position: (card: ThreadDetailsCardId) => {
      const at = order.indexOf(card);
      return (at < 0 ? order.length : at) + 1;
    },
    customized: hidden.length > 0 || collapsed.length > 0 || order.join() !== CARD_ORDER.join(),
  };
}

const toggled = <T>(list: T[], value: T) =>
  list.includes(value) ? list.filter((other) => other !== value) : [...list, value];

export const toggleItem = (item: ThreadDetailsItemId) =>
  prefs.set({ ...prefs.get(), hidden: toggled(prefs.get().hidden, item) });

export const toggleCollapsed = (card: ThreadDetailsCardId) =>
  prefs.set({ ...prefs.get(), collapsed: toggled(prefs.get().collapsed, card) });

/** Puts `moved` right before `before`. */
export function moveCard(moved: ThreadDetailsCardId, before: ThreadDetailsCardId) {
  if (moved === before) return;
  const current = prefs.get();
  const order = [...new Set([...current.order, ...CARD_ORDER])].filter((card) => card !== moved);
  order.splice(order.indexOf(before), 0, moved);
  prefs.set({ ...current, order });
}

export const resetThreadDetails = () => prefs.set(defaults);

/** Whether `value` names a card, as a drag's data does. */
export const isCard = (value: string): value is ThreadDetailsCardId =>
  (CARD_ORDER as string[]).includes(value);
