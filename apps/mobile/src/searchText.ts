// What Search matches, and which parts of a result it highlights. Pure, for the test.

/** A query's words, lowercased: what every result must contain. */
export function wordsOf(query: string): string[] {
  return query.toLowerCase().split(/\s+/).filter(Boolean);
}

/** Whether `text` contains every one of `words`, in any order and case. */
export function matchesAll(text: string, words: string[]): boolean {
  const lower = text.toLowerCase();
  return words.every((w) => lower.includes(w));
}

/** `text` in pieces, each one a match of a word or not, with overlapping matches joined. */
export function marks(text: string, words: string[]): { text: string; hit: boolean }[] {
  const lower = text.toLowerCase();
  const hit = new Array<boolean>(text.length).fill(false);
  for (const w of words)
    for (let at = lower.indexOf(w); at !== -1; at = lower.indexOf(w, at + w.length)) hit.fill(true, at, at + w.length);
  const pieces: { text: string; hit: boolean }[] = [];
  for (let i = 0; i < text.length; i++) {
    const last = pieces[pieces.length - 1];
    if (last && last.hit === hit[i]) last.text += text[i];
    else pieces.push({ text: text[i]!, hit: hit[i]! });
  }
  return pieces;
}
