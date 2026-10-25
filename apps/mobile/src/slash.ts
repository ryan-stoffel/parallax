// The prompt box's `/` menu, as the desktop composer's: the `/word` being typed at the cursor,
// the commands that match it, and the text with a picked command in its place. Pure, for the test.

/** A `/` being typed: what follows it, and where it runs in the text. */
export interface Slash {
  query: string;
  from: number;
  to: number;
}

/** The `/word` that ends at `cursor`, at the start of the text or after a space, if any. */
export function slashAt(text: string, cursor: number): Slash | undefined {
  const match = /(?:^|\s)\/(\S*)$/.exec(text.slice(0, cursor));
  if (!match) return undefined;
  const query = match[1]!;
  return { query, from: cursor - query.length - 1, to: cursor };
}

/** `items` whose name starts with `query`, then those that contain it, as the desktop orders them. */
export function byName<T>(items: readonly T[], query: string, name: (item: T) => string): T[] {
  const q = query.toLowerCase();
  const starts = (item: T) => name(item).toLowerCase().startsWith(q);
  return [...items.filter(starts), ...items.filter((item) => !starts(item) && name(item).toLowerCase().includes(q))];
}

/** `text` with `slash` replaced by `insert`, and where the cursor goes after it. */
export function replaceSlash(text: string, slash: Slash, insert: string): { text: string; cursor: number } {
  return { text: text.slice(0, slash.from) + insert + text.slice(slash.to), cursor: slash.from + insert.length };
}
