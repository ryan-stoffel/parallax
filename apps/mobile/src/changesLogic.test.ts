import { expect, test } from "vitest";

import type { ThreadRun } from "../../desktop/src/protocol/generated/protocol";
import { parseDiff } from "../../desktop/src/renderer/parseDiff";
import { changeRows, turnChoices } from "./changesLogic";

const run = (fields: object) => ({ status: "completed", checkpoint: { status: "ready" }, ...fields }) as ThreadRun;

test("only started, kept turns with a ready checkpoint can be chosen", () => {
  const choices = turnChoices(
    [
      run({ ordinal: 1 }),
      run({ ordinal: 2, text: "Second\nand more" }),
      run({ ordinal: 3, text: "Undone", status: "rolledBack" }),
      run({ ordinal: 4, text: "Capturing", checkpoint: { status: "missing" } }),
      run({ text: "Queued" }),
      run({ ordinal: 5, text: "" }),
    ],
    "The prompt",
  );
  expect(choices.map((c) => [c.value, c.description])).toEqual([
    ["1", "The prompt"],
    ["2", "Second"],
    ["5", "(no text)"],
  ]);
});

const diff = [
  "diff --git a/src/a.ts b/src/a.ts",
  "--- a/src/a.ts",
  "+++ b/src/a.ts",
  "@@ -10,2 +10,2 @@",
  " keep",
  "-old",
  "+new",
  "diff --git a/logo.png b/logo.png",
  "Binary files a/logo.png and b/logo.png differ",
  "",
].join("\n");

test("a diff's files become numbered rows, and a folded file keeps only its header", () => {
  const files = parseDiff(diff);
  expect(changeRows(files, new Set()).map((r) => (r.kind === "file" ? r.file.path : r.kind === "line" ? r.row : r.text))).toEqual([
    "src/a.ts",
    { kind: "hunk", text: "@@ -10,2 +10,2 @@" },
    { kind: "context", text: "keep", line: 10 },
    { kind: "del", text: "old", line: 11 },
    { kind: "add", text: "new", line: 11 },
    "logo.png",
    "Binary file not shown",
  ]);
  expect(changeRows(files, new Set(["src/a.ts"])).map((r) => (r.kind === "file" ? [r.file.path, r.open] : r.kind))).toEqual([
    ["src/a.ts", false],
    ["logo.png", true],
    "note",
  ]);
});

test("a very long line is cut", () => {
  const files = parseDiff(`diff --git a/m.js b/m.js\n@@ -0,0 +1 @@\n+${"x".repeat(5000)}\n`);
  const rows = changeRows(files, new Set());
  const last = rows[rows.length - 1]!;
  expect(last.kind === "line" && last.row.kind === "add" && last.row.text.length).toBe(2001);
});
