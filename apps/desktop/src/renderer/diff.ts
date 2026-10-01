// A line diff of an edit's old and new text, for the transcript's edit cards (RYA-219).

/** One line of a diff: in both texts, added, or removed. */
export interface DiffLine {
  kind: "same" | "add" | "remove";
  text: string;
}

// Past this many cells, the table would be too big: the middle is then all removed and added.
const maxCells = 4_000_000;

/**
 * The lines of `before` and `after` as a diff, by their longest common subsequence, which is
 * plenty for an edit's few hundred lines. Where lines change, removals come before additions.
 */
export function diffLines(before: string, after: string): DiffLine[] {
  const a = lines(before);
  const b = lines(after);
  // Lines shared at either end need no table.
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let end = 0;
  while (
    end < a.length - start &&
    end < b.length - start &&
    a[a.length - 1 - end] === b[b.length - 1 - end]
  )
    end++;
  const same = (text: string): DiffLine => ({ kind: "same", text });
  const head = a.slice(0, start).map(same);
  const tail = a.slice(a.length - end).map(same);
  const x = a.slice(start, a.length - end);
  const y = b.slice(start, b.length - end);

  const middle: DiffLine[] = [];
  const remove = (text: string) => middle.push({ kind: "remove", text });
  const add = (text: string) => middle.push({ kind: "add", text });
  if (x.length * y.length > maxCells) {
    x.forEach(remove);
    y.forEach(add);
    return [...head, ...middle, ...tail];
  }
  // lcs[i][j]: the longest common subsequence of x from i and y from j.
  const width = y.length + 1;
  const lcs = new Uint32Array((x.length + 1) * width);
  for (let i = x.length - 1; i >= 0; i--)
    for (let j = y.length - 1; j >= 0; j--)
      lcs[i * width + j] =
        x[i] === y[j]
          ? lcs[(i + 1) * width + j + 1]! + 1
          : Math.max(lcs[(i + 1) * width + j]!, lcs[i * width + j + 1]!);
  let i = 0;
  let j = 0;
  while (i < x.length && j < y.length) {
    if (x[i] === y[j]) {
      middle.push(same(x[i]!));
      i++;
      j++;
    } else if (lcs[(i + 1) * width + j]! >= lcs[i * width + j + 1]!) remove(x[i++]!);
    else add(y[j++]!);
  }
  x.slice(i).forEach(remove);
  y.slice(j).forEach(add);
  return [...head, ...middle, ...tail];
}

/** How many lines a diff adds and removes. */
export function diffStats(diff: readonly DiffLine[]): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const line of diff) {
    if (line.kind === "add") added++;
    else if (line.kind === "remove") removed++;
  }
  return { added, removed };
}

/** A text's lines; empty text has none, and a final newline doesn't start another. */
export function lines(text: string): string[] {
  if (text === "") return [];
  const all = text.split("\n");
  if (all.at(-1) === "") all.pop();
  return all;
}
