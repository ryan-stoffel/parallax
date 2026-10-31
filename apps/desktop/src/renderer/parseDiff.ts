// A unified diff, as `gh pr diff` and plxd's checkpoints print it, as files of numbered lines, for
// ChangesDiff. Pure.

/** A line of a diff: added, removed, context, or a hunk's `@@` header, with its line numbers. */
export interface DiffLine {
  op: "+" | "-" | " " | "@";
  text: string;
  old?: number;
  new?: number;
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
      old = Number(m?.[1] ?? 0);
      now = Number(m?.[2] ?? 0);
      file.lines.push({ op: "@", text: line });
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
  return files;
}
