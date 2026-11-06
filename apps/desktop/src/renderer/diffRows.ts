// How a parsed diff becomes the rows ChangesDiff draws, in unified or split layout. Pure.

import type { DiffFile, DiffLine } from "./parseDiff";
import type { ThreadView } from "./pr/model";

export type DiffLayout = "unified" | "split";

/**
 * One row of the diff window: a file's header, a binary file's note (`file` alone), a unified `line`
 * or hunk band, a split row's `left` and `right` lines, or review threads, under their line:
 * `threads` across the whole width, or `sides`, each under its side of a split row.
 */
export type Row = {
  file: DiffFile;
  header?: boolean;
  line?: DiffLine;
  left?: DiffLine;
  right?: DiffLine;
  threads?: ThreadView[];
  sides?: { left: ThreadView[]; right: ThreadView[] };
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
const isOn = (thread: ThreadView, line: DiffLine) =>
  thread.side === "left"
    ? line.op !== "+" && line.op !== "@" && line.old === thread.line
    : line.op !== "-" && line.op !== "@" && line.new === thread.line;

/**
 * Every row of `files` in `layout`. A `shut` file is only its header. A thread sits under its line,
 * or under its file's header when plxd doesn't say the line or the diff doesn't show it.
 */
export function diffRows(
  files: readonly DiffFile[],
  layout: DiffLayout,
  shut: (path: string) => boolean,
  threads: readonly ThreadView[],
): Row[] {
  const rows: Row[] = [];
  for (const file of files) {
    rows.push({ file, header: true });
    if (shut(file.path)) continue;
    const mine = threads.filter((t) => t.path === file.path);
    const loose = mine.filter((t) => t.line === undefined || !file.lines.some((l) => isOn(t, l)));
    if (loose.length) rows.push({ file, threads: loose });
    if (file.binary) rows.push({ file });
    const anchored = mine.filter((t) => !loose.includes(t));
    if (layout === "unified") {
      for (const line of file.lines) {
        rows.push({ file, line });
        const here = anchored.filter((t) => isOn(t, line));
        if (here.length) rows.push({ file, threads: here });
      }
      continue;
    }
    for (const pair of pairLines(file.lines)) {
      rows.push({ file, ...pair });
      const on = (side: "left" | "right") => {
        const at = pair[side];
        return at ? anchored.filter((t) => (t.side ?? "right") === side && isOn(t, at)) : [];
      };
      const sides = { left: on("left"), right: on("right") };
      if (sides.left.length || sides.right.length) rows.push({ file, sides });
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
