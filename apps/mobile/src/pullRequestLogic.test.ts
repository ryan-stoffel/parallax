import { expect, test } from "vitest";

import { diffRows } from "./pullRequestLogic";

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
