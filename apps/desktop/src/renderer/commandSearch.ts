// The command menu's ranking (PLX-993): fuzzy, word by word, so typos of omission, initials, and
// words out of order still find what's meant.

/** A query's words, lowercased. */
export const queryWords = (query: string) =>
  query.trim().toLowerCase().split(/\s+/).filter(Boolean);

// Where a word starts: the text's start, after a separator, or a lowercase-to-uppercase step.
const separators = new Set([" ", "-", "_", ".", "/", "\\", ":", "(", "[", "#", "@", "'", '"']);
const startsWord = (text: string, i: number) =>
  i === 0 ||
  separators.has(text[i - 1]!) ||
  (/[a-z0-9]/.test(text[i - 1]!) && /[A-Z]/.test(text[i]!));

// A letter matched may skip at most this many letters since the last one, unless it starts a word.
const maxGap = 3;

/**
 * How well `word`, lowercased, matches `text`: higher is better, undefined for no match. A
 * substring scores highest, more at a word's start and most at the text's start. Otherwise each
 * letter must follow the last within a few letters, or start a word, as initials do; consecutive
 * letters and word starts score more.
 */
export function wordScore(word: string, text: string): number | undefined {
  if (!word) return 0;
  const lower = text.toLowerCase();
  let best: number | undefined;
  for (let at = lower.indexOf(word); at !== -1; at = lower.indexOf(word, at + 1)) {
    const score = 100 + word.length * 4 + (startsWord(text, at) ? 40 : 0) + (at === 0 ? 30 : 0);
    best = Math.max(best ?? 0, score - Math.min(at, 30) / 10);
  }
  if (best !== undefined) return best;

  // The best score of `word` up to letter i, with letter i at each position of `text`.
  let row = new Map<number, number>();
  for (let j = 0; j < lower.length; j++)
    if (lower[j] === word[0]) row.set(j, startsWord(text, j) ? 8 : 1);
  for (let i = 1; i < word.length && row.size; i++) {
    const next = new Map<number, number>();
    for (let j = 0; j < lower.length; j++) {
      if (lower[j] !== word[i]) continue;
      const boundary = startsWord(text, j);
      let top: number | undefined;
      for (const [k, score] of row) {
        if (k >= j) continue;
        const gap = j - k - 1;
        if (gap > maxGap && !boundary) continue;
        const step = gap === 0 ? 6 : boundary ? 5 - Math.min(gap, 4) / 4 : 1 - gap / 2;
        top = Math.max(top ?? -Infinity, score + step);
      }
      if (top !== undefined) next.set(j, top);
    }
    row = next;
  }
  if (!row.size) return undefined;
  // Below any substring's score, so a real substring always ranks first.
  return Math.min(Math.max(...row.values()), 90);
}

/**
 * How well every word of a query matches an item's fields, each `[text, weight]`: each word scores
 * its best field, times that field's weight, and the item gets their sum, plus a bonus when the
 * whole query is in its first field. Undefined when any word matches no field.
 */
export function itemScore(
  words: readonly string[],
  fields: readonly (readonly [string, number])[],
): number | undefined {
  let total = 0;
  for (const word of words) {
    let best: number | undefined;
    for (const [text, weight] of fields) {
      const score = wordScore(word, text);
      if (score !== undefined) best = Math.max(best ?? -Infinity, score * weight);
    }
    if (best === undefined) return undefined;
    total += best;
  }
  const first = fields[0]?.[0].toLowerCase() ?? "";
  if (words.length > 1 && first.includes(words.join(" "))) total += 50;
  return total;
}

/**
 * `items` that match `words`, best first, each with its score; ties keep `items`' order. With no
 * words, every item, in order.
 */
export function rank<T>(
  items: readonly T[],
  words: readonly string[],
  fields: (item: T) => readonly (readonly [string, number])[],
): { item: T; score: number }[] {
  if (!words.length) return items.map((item) => ({ item, score: 0 }));
  return items
    .flatMap((item, i) => {
      const score = itemScore(words, fields(item));
      return score === undefined ? [] : [{ item, score, i }];
    })
    .sort((a, b) => b.score - a.score || a.i - b.i)
    .map(({ item, score }) => ({ item, score }));
}

/**
 * `text` split into runs, each marked where a query's word matched it as a substring, for
 * highlighting. A fuzzy match marks nothing.
 */
export function marks(text: string, words: readonly string[]): { text: string; mark: boolean }[] {
  const lower = text.toLowerCase();
  const marked = Array.from({ length: text.length }, () => false);
  for (const word of words)
    for (let at = lower.indexOf(word); at !== -1 && word; at = lower.indexOf(word, at + 1))
      marked.fill(true, at, at + word.length);
  const runs: { text: string; mark: boolean }[] = [];
  for (let i = 0; i < text.length; i++) {
    const last = runs.at(-1);
    if (last && last.mark === marked[i]) last.text += text[i];
    else runs.push({ text: text[i]!, mark: marked[i]! });
  }
  return runs;
}
