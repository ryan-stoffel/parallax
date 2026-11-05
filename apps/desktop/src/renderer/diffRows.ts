// How a parsed diff becomes the rows ChangesDiff draws, in unified or split layout. Pure.

import type { DiffFile, DiffLine } from "./parseDiff";
import type { ThreadView } from "./pr/model";

export type DiffLayout = "unified" | "split";

export type DiffSideName = "left" | "right";

/** Lines picked in a file: `start` to `end` on one side, in one hunk, as GitHub requires. */
export type LineRange = { side: DiffSideName; start: number; end: number };

/** Where a comment box is open: under `range`'s last line, or atop the file with no `range`. */
export type CommentTarget = { path: string; range?: LineRange };

/** The side a unified row's line comments go on: removed lines on the old, others on the new. */
export const sideOf = (line: DiffLine): DiffSideName => (line.op === "-" ? "left" : "right");

/** `line`'s number on `side`. */
export const numberOn = (line: DiffLine, side: DiffSideName) =>
  side === "left" ? line.old : line.new;

/**
 * The range from line `from` to line `to` on `side` of `lines`, ends in order, cut to the hunk `from`
 * is in. A comment can't span hunks. Just `from` when it's not in the diff.
 */
export function pickRange(
  lines: readonly DiffLine[],
  side: DiffSideName,
  from: number,
  to: number,
): LineRange {
  let hunk: number[] = [];
  let found: number[] | undefined;
  for (const line of lines) {
    if (line.op === "@") {
      if (found) break;
      hunk = [];
      continue;
    }
    const n = numberOn(line, side);
    if (n === undefined) continue;
    hunk.push(n);
    if (n === from) found = hunk;
  }
  const near = found?.includes(to) ? to : to < from ? found?.[0] : found?.at(-1);
  const end = near ?? from;
  return { side, start: Math.min(from, end), end: Math.max(from, end) };
}

/**
 * One row of the diff window: a file's header, a binary file's note (`file` alone), a unified `line`
 * or hunk band, a split row's `left` and `right` lines, review threads, under their line:
 * `threads` across the whole width, or `sides`, each under its side of a split row, or the comment
 * box, on one side of a split row or else across (`composer`).
 */
export type Row = {
  file: DiffFile;
  header?: boolean;
  line?: DiffLine;
  left?: DiffLine;
  right?: DiffLine;
  threads?: ThreadView[];
  sides?: { left: ThreadView[]; right: ThreadView[] };
  composer?: DiffSideName | "across";
};

/**
 * A file's lines side by side: context on both sides, a removed run's first line beside its added
 * run's first, and so on, with what is left over alone on its side. A hunk's `@@` band stays whole.
 */
export function pairLines(lines: readonly DiffLine[]): Pick<Row, "line" | "left" | "right">[] {
  const rows: Pick<Row, "line" | "left" | "right">[] = [];
  for (let i = 0; i < lines.length;) {
    const line = lines[i]!;
    if (line.op === "@") {
      rows.push({ line });
      i++;
    } else if (line.op === " ") {
      rows.push({ left: line, right: line });
      i++;
    } else {
      let plus = i;
      while (lines[plus]?.op === "-") plus++;
      let end = plus;
      while (lines[end]?.op === "+") end++;
      for (let n = 0; n < Math.max(plus - i, end - plus); n++)
        rows.push({
          left: i + n < plus ? lines[i + n] : undefined,
          right: plus + n < end ? lines[plus + n] : undefined,
        });
      i = end;
    }
  }
  return rows;
}

/** Whether `thread` is on `line`, by its side: a left one by the old number, else by the new. */
const isOn = (thread: Pick<ThreadView, "side" | "line">, line: DiffLine) =>
  thread.side === "left"
    ? line.op !== "+" && line.op !== "@" && line.old === thread.line
    : line.op !== "-" && line.op !== "@" && line.new === thread.line;

/**
 * Every row of `files` in `layout`. A `shut` file is only its header. A thread sits under its line,
 * or under its file's header when plxd doesn't say the line or the diff doesn't show it. The comment
 * box for `target` sits under its range's last line, after any threads there, or atop its file.
 */
export function diffRows(
  files: readonly DiffFile[],
  layout: DiffLayout,
  shut: (path: string) => boolean,
  threads: readonly ThreadView[],
  target?: CommentTarget,
): Row[] {
  const rows: Row[] = [];
  for (const file of files) {
    rows.push({ file, header: true });
    if (shut(file.path)) continue;
    const mine = threads.filter((t) => t.path === file.path);
    const loose = mine.filter((t) => t.line === undefined || !file.lines.some((l) => isOn(t, l)));
    if (loose.length) rows.push({ file, threads: loose });
    const mineTarget = target?.path === file.path ? target : undefined;
    if (mineTarget && !mineTarget.range) rows.push({ file, composer: "across" });
    const at = mineTarget?.range && { side: mineTarget.range.side, line: mineTarget.range.end };
    if (file.binary) rows.push({ file });
    const anchored = mine.filter((t) => !loose.includes(t));
    if (layout === "unified") {
      for (const line of file.lines) {
        rows.push({ file, line });
        const here = anchored.filter((t) => isOn(t, line));
        if (here.length) rows.push({ file, threads: here });
        if (at && isOn(at, line)) rows.push({ file, composer: "across" });
      }
      continue;
    }
    for (const pair of pairLines(file.lines)) {
      rows.push({ file, ...pair });
      const on = (side: DiffSideName) => {
        const line = pair[side];
        return line ? anchored.filter((t) => (t.side ?? "right") === side && isOn(t, line)) : [];
      };
      const sides = { left: on("left"), right: on("right") };
      if (sides.left.length || sides.right.length) rows.push({ file, sides });
      const line = at && pair[at.side];
      if (at && line && isOn(at, line)) rows.push({ file, composer: at.side });
    }
  }
  return rows;
}

/** Where `row` is in `rows`, which may be in the other layout: the same file's header or line. */
export function sameRow(rows: readonly Row[], row: Row): number {
  const line = row.line ?? row.right ?? row.left;
  return rows.findIndex((r) =>
    row.header
      ? r.header && r.file === row.file
      : !!line && (r.line === line || r.left === line || r.right === line),
  );
}
