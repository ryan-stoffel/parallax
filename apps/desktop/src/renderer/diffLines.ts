// A line diff of two texts, as a permission request and the transcript show an edit: aligned by
// the longest common run, far unchanged lines folded. Pure, so the mobile app shares it.

/** One line of a diff: unchanged, added, or removed, or a run of unchanged lines left out. */
export type DiffLine = { op: " " | "+" | "-"; text: string } | { op: "gap"; count: number };

// Past this many cells, the line diff below gives up on alignment: all removed, then all added.
const maxDiffCells = 250_000;

/**
 * The lines from `before` to `after`, aligned by their longest common run, with unchanged runs
 * longer than `context` lines either side of a change left out as a gap.
 */
export function diffLines(before: string, after: string, context = 2): DiffLine[] {
  const a = before === "" ? [] : before.split("\n");
  const b = after === "" ? [] : after.split("\n");
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head++;
  let tail = 0;
  while (
    tail < a.length - head &&
    tail < b.length - head &&
    a[a.length - 1 - tail] === b[b.length - 1 - tail]
  )
    tail++;
  const x = a.slice(head, a.length - tail);
  const y = b.slice(head, b.length - tail);
  const middle: { op: " " | "+" | "-"; text: string }[] = [];
  if (x.length * y.length > maxDiffCells) {
    middle.push(...x.map((text) => ({ op: "-" as const, text })));
    middle.push(...y.map((text) => ({ op: "+" as const, text })));
  } else {
    // lcs[i * w + j]: the longest common run of x[i..] and y[j..].
    const w = y.length + 1;
    const lcs = new Uint32Array((x.length + 1) * w);
    for (let i = x.length - 1; i >= 0; i--)
      for (let j = y.length - 1; j >= 0; j--)
        lcs[i * w + j] =
          x[i] === y[j]
            ? lcs[(i + 1) * w + j + 1]! + 1
            : Math.max(lcs[(i + 1) * w + j]!, lcs[i * w + j + 1]!);
    // Removed lines go before added ones, as diffs read.
    let i = 0;
    let j = 0;
    while (i < x.length || j < y.length) {
      if (i < x.length && j < y.length && x[i] === y[j]) {
        middle.push({ op: " ", text: x[i]! });
        i++;
        j++;
      } else if (i < x.length && (j === y.length || lcs[(i + 1) * w + j]! >= lcs[i * w + j + 1]!))
        middle.push({ op: "-", text: x[i++]! });
      else middle.push({ op: "+", text: y[j++]! });
    }
  }
  const all = [
    ...a.slice(0, head).map((text) => ({ op: " " as const, text })),
    ...middle,
    ...a.slice(a.length - tail).map((text) => ({ op: " " as const, text })),
  ];
  // Unchanged lines more than `context` away from every change go, a run of them as one gap.
  const changed = all.flatMap((l, i) => (l.op === " " ? [] : [i]));
  const near = (i: number) => changed.some((c) => Math.abs(c - i) <= context);
  const out: DiffLine[] = [];
  all.forEach((line, i) => {
    if (line.op !== " " || near(i)) return out.push(line);
    const last = out.at(-1);
    if (last?.op === "gap") last.count++;
    else out.push({ op: "gap", count: 1 });
  });
  return out;
}
