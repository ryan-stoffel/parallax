import { expect, test } from "vitest";

import { counts, editRows, fileRows } from "./diffLogic";

test("an edit's lines: removed before added, and other tools have none", () => {
  const rows = editRows("Edit", { file_path: "a.ts", old_string: "a\nb", new_string: "a\nc" })!;
  expect(rows).toEqual([
    { kind: "context", text: "a" },
    { kind: "del", text: "b" },
    { kind: "add", text: "c" },
  ]);
  expect(counts(rows)).toEqual({ added: 1, removed: 1 });
  expect(counts(editRows("Write", { content: "x\ny" })!)).toEqual({ added: 2, removed: 0 });
  expect(editRows("MultiEdit", { edits: [{ old_string: "a", new_string: "b" }, { old_string: "", new_string: "c" }] })).toEqual([
    { kind: "del", text: "a" },
    { kind: "add", text: "b" },
    { kind: "band", text: "⋯" },
    { kind: "add", text: "c" },
  ]);
  expect(editRows("Edit", { truncated: true, bytes: 9 })).toBeUndefined();
  expect(editRows("Bash", { command: "ls" })).toBeUndefined();
});

test("one file's numbered lines out of a turn's diff", () => {
  const diff = [
    "diff --git a/a.ts b/a.ts",
    "@@ -1,2 +1,2 @@",
    "+other",
    "diff --git a/src/b.ts b/src/b.ts",
    "--- a/src/b.ts",
    "+++ b/src/b.ts",
    "@@ -4,2 +4,2 @@ fn",
    " keep",
    "-old",
    "+new",
  ].join("\n");
  expect(fileRows(diff, "src/b.ts")).toEqual([
    { kind: "band", text: "@@ -4,2 +4,2 @@ fn" },
    { kind: "context", text: "keep", line: 4 },
    { kind: "del", text: "old", line: 5 },
    { kind: "add", text: "new", line: 5 },
  ]);
});
