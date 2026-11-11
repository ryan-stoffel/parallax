// A unified diff, as `gh pr diff` and plxd's checkpoints print it, as files of numbered lines, for
// ChangesDiff. Pure.

/** A line of a diff: added, removed, context, or a hunk's `@@` header, with its line numbers. */
export interface DiffLine {
  op: "+" | "-" | " " | "@";
  text: string;
  old?: number;
  new?: number;
  /** The part of `text` that changed, from and to, when its pair on the other side is similar. */
  mark?: [number, number];
  /** For a hunk's `@@` header: how many unchanged lines come before the hunk. */
  hidden?: number;
  /** For a hunk's `@@` header: the enclosing function or heading git names after it. */
  context?: string;
}

/** One file of a unified diff. */
export interface DiffFile {
  path: string;
  /** Its path before a rename. */
  oldPath?: string;
  added: number;
  removed: number;
  binary: boolean;
  lines: DiffLine[];
}

/** A unified diff as its files, each with its lines numbered on both sides. */
export function parseDiff(diff: string): DiffFile[] {
  const files: DiffFile[] = [];
  let file: DiffFile | undefined;
  let old = 0;
  let now = 0;
  for (const line of diff.split("\n")) {
    if (line.startsWith("diff --git ")) {
      // `a/<path> b/<path>`: the same path twice unless renamed. A `rename to` or `+++` line
      // below, when there is one, says it exactly.
      const rest = line.slice(11).replaceAll('"', "");
      const half = (rest.length - 1) / 2;
      const same = rest.slice(2, half) === rest.slice(half + 3);
      file = {
        path: same ? rest.slice(2, half) : (/ b\/(.*)$/.exec(rest)?.[1] ?? rest),
        added: 0,
        removed: 0,
        binary: false,
        lines: [],
      };
      files.push(file);
    } else if (!file) {
      continue;
    } else if (line.startsWith("@@")) {
      const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)/.exec(line);
      const before = file.lines.length ? now : 1;
      old = Number(m?.[1] ?? 0);
      now = Number(m?.[2] ?? 0);
      file.lines.push({
        op: "@",
        text: line,
        hidden: Math.max(0, now - before),
        context: /^@@[^@]*@@ ?(.*)$/.exec(line)?.[1] || undefined,
      });
    } else if (file.lines.length === 0) {
      // The file's header, before its first hunk.
      // git quotes a path with special characters, and escapes them.
      if (line.startsWith("rename from ")) file.oldPath = line.slice(12).replaceAll('"', "");
      else if (line.startsWith("rename to ")) file.path = line.slice(10).replaceAll('"', "");
      else if (line.startsWith("+++ b/")) file.path = line.slice(6);
      else if (line.startsWith('+++ "b/')) file.path = line.slice(7, -1);
      else if (line.startsWith("Binary files ")) file.binary = true;
    } else if (line.startsWith("+")) {
      file.added++;
      file.lines.push({ op: "+", text: line.slice(1), new: now++ });
    } else if (line.startsWith("-")) {
      file.removed++;
      file.lines.push({ op: "-", text: line.slice(1), old: old++ });
    } else if (line.startsWith(" ")) {
      file.lines.push({ op: " ", text: line.slice(1), old: old++, new: now++ });
    }
  }
  for (const each of files) markChanges(each.lines);
  return files;
}

/** Whether a UTF-16 unit is the first half of a surrogate pair. */
const isHighSurrogate = (unit: number) => unit >= 0xd800 && unit <= 0xdbff;

/**
 * Marks the part that changed in each removed line paired with an added one, as a run's first with
 * its first, and so on: all but the two lines' shared start and end. A pair with little in common
 * stays whole, since marking all of it says nothing.
 */
function markChanges(lines: DiffLine[]) {
  for (let i = 0; i < lines.length;) {
    if (lines[i]!.op !== "-") {
      i++;
      continue;
    }
    let plus = i;
    while (lines[plus]?.op === "-") plus++;
    let end = plus;
    while (lines[end]?.op === "+") end++;
    for (let n = 0; n < Math.min(plus - i, end - plus); n++) {
      const [before, after] = [lines[i + n]!, lines[plus + n]!];
      let start = 0;
      const shortest = Math.min(before.text.length, after.text.length);
      while (start < shortest && before.text[start] === after.text[start]) start++;
      let tail = 0;
      while (
        tail < shortest - start &&
        before.text[before.text.length - 1 - tail] === after.text[after.text.length - 1 - tail]
      )
        tail++;
      // Not inside an emoji, whose two halves the shared parts may split.
      if (start > 0 && isHighSurrogate(before.text.charCodeAt(start - 1))) start--;
      if (tail > 0 && isHighSurrogate(before.text.charCodeAt(before.text.length - tail - 1)))
        tail--;
      // At least a third of the longer line in common.
      if ((start + tail) * 3 < Math.max(before.text.length, after.text.length)) continue;
      before.mark = [start, before.text.length - tail];
      after.mark = [start, after.text.length - tail];
    }
    i = end;
  }
}
