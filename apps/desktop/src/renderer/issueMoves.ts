// The Board's bookkeeping for dragged cards, pure so it tests without a page (0107). A move shows
// at once, then settles to what the tracker answered or goes back, and what it shows always wins
// over what the computers last listed, so no read or other move can undo it.
import { categoryOf, type BoardColumn, type IssueEntry } from "./issues";

/** A card as the board last moved it. */
export interface Move {
  /** The issue as the board shows it: as dropped while `pending`, then as its tracker answered. */
  entry: IssueEntry;
  /** Whether its tracker hasn't answered yet. A pending card can't be dragged again. */
  pending: boolean;
  /** What the board showed for it before this move, which a failure puts back. */
  before?: Move;
}

/** Every moved card, by its issue's URL. */
export type Moves = Readonly<Record<string, Move>>;

const without = (moves: Moves, url: string): Moves => {
  const { [url]: _, ...rest } = moves;
  return rest;
};

/** Whether the card for `url` can be dragged: one move per card runs at a time. */
export const canMove = (moves: Moves, url: string) => !moves[url]?.pending;

/**
 * `moves` with `entry`'s card dropped on `column`, shown there at once under the column's `label`
 * until its tracker answers. A card whose move is still pending stays as it is.
 */
export function startMove(
  moves: Moves,
  entry: IssueEntry,
  column: BoardColumn,
  label: string,
): Moves {
  const url = entry.issue.url;
  if (!canMove(moves, url)) return moves;
  const issue = { ...entry.issue, state: { ...entry.issue.state, name: label, category: column } };
  return { ...moves, [url]: { entry: { ...entry, issue }, pending: true, before: moves[url] } };
}

/** `moves` with `url`'s pending move settled as `issue`, what its tracker answered. */
export function settleMove(moves: Moves, url: string, issue: IssueEntry["issue"]): Moves {
  const move = moves[url];
  if (!move?.pending) return moves;
  return { ...moves, [url]: { entry: { ...move.entry, issue }, pending: false } };
}

/** `moves` with `url`'s pending move undone: the card shows what it did before. */
export function failMove(moves: Moves, url: string): Moves {
  const move = moves[url];
  if (!move?.pending) return moves;
  return move.before ? { ...moves, [url]: move.before } : without(moves, url);
}

/**
 * `moves` after Refresh: every settled card is forgotten, so the board shows what the computers
 * list, and a finished card leaves. A pending move stays, and its target wins until it settles.
 */
export const refreshMoves = (moves: Moves): Moves =>
  Object.fromEntries(Object.entries(moves).filter(([, move]) => move.pending));

/** `moves` without `url`'s settled card, as when its issue changed some other way. */
export const forgetMove = (moves: Moves, url: string): Moves =>
  moves[url] && !moves[url].pending ? without(moves, url) : moves;

/**
 * The Board's cards: what the computers `listed`, each as the board moved it, then the moved cards
 * they no longer list, as a finished issue isn't.
 */
export function boardEntries(listed: readonly IssueEntry[], moves: Moves): IssueEntry[] {
  const urls = new Set(listed.map((e) => e.issue.url));
  return [
    ...listed.map((e) => moves[e.issue.url]?.entry ?? e),
    ...Object.entries(moves).flatMap(([url, move]) => (urls.has(url) ? [] : [move.entry])),
  ];
}

/**
 * The List's rows: what the computers `listed`, each as the board moved it, without those moved to
 * Done or Canceled, which the list of open issues never has.
 */
export function listEntries(listed: readonly IssueEntry[], moves: Moves): IssueEntry[] {
  return listed
    .map((e) => moves[e.issue.url]?.entry ?? e)
    .filter((e, i) => {
      const moved = e !== listed[i];
      const category = categoryOf(e.issue.state.category);
      return !moved || (category !== "done" && category !== "canceled");
    });
}
