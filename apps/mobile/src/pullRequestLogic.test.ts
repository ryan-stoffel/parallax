import { expect, test } from "vitest";

import type { PrReviewThread } from "../../desktop/src/protocol/generated/protocol";
import { diffRows, lineAt, rowOf, threadsAt } from "./pullRequestLogic";

test("a diff splits into files, hunks, and numbered lines", () => {
  const diff = [
    "diff --git a/src/a.ts b/src/a.ts",
    "index 1..2 100644",
    "--- a/src/a.ts",
    "+++ b/src/a.ts",
    "@@ -10,3 +10,3 @@ function a() {",
    " keep",
    "--- a removed line that starts with dashes",
    "+added",
    "\\ No newline at end of file",
    "diff --git a/b.md b/b.md",
    "new file mode 100644",
    "@@ -0,0 +1 @@",
    "+hello",
    "",
  ].join("\n");
  expect(diffRows(diff)).toEqual([
    { kind: "file", path: "src/a.ts", additions: 1, deletions: 1 },
    { kind: "hunk", text: "@@ -10,3 +10,3 @@ function a() {" },
    { kind: "context", text: "keep", line: 10 },
    { kind: "del", text: "-- a removed line that starts with dashes", line: 11 },
    { kind: "add", text: "added", line: 11 },
    { kind: "file", path: "b.md", additions: 1, deletions: 0 },
    { kind: "hunk", text: "@@ -0,0 +1 @@" },
    { kind: "add", text: "hello", line: 1 },
  ]);
});

test("review threads sit under their line on its side, or under their file's header", () => {
  const rows = diffRows(
    [
      "diff --git a/a.ts b/a.ts",
      "@@ -5,2 +5,2 @@",
      " same",
      "-old",
      "+new",
      "diff --git a/b.ts b/b.ts",
      "@@ -1 +1 @@",
      "+b",
      "",
    ].join("\n"),
  );
  const thread = (id: string, path: string, line?: number, side?: "left" | "right") =>
    ({ id, path, line, side, isOutdated: false, isResolved: false, comments: [] }) as PrReviewThread;
  const at = threadsAt(rows, [
    thread("old", "a.ts", 6, "left"),
    thread("new", "a.ts", 6),
    thread("file", "b.ts"),
    thread("gone", "a.ts", 40),
    { ...thread("outdated", "a.ts", 5), isOutdated: true },
  ]);
  expect([...at].map(([i, ts]) => [i, ts.map((t) => t.id)])).toEqual([
    [3, ["old"]],
    [4, ["new"]],
    [5, ["file"]],
  ]);
  expect(lineAt(rows, 3)).toEqual({ path: "a.ts", line: 6, side: "left" });
  expect(lineAt(rows, 1)).toBeUndefined();
  expect(rowOf(rows, "a.ts", 6)).toBe(4);
  expect(rowOf(rows, "b.ts")).toBe(5);
});
