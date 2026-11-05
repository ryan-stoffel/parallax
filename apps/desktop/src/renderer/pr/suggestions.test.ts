import { expect, test } from "vite-plus/test";

import {
  linesUnderThread,
  splitSuggestions,
  suggestionBlock,
  suggestionLines,
} from "./suggestions";

test("a body splits around its suggestion, its text kept in order", () => {
  expect(splitSuggestions("Try:\n```suggestion\nconst a = 1;\n```\nThanks")).toEqual([
    { markdown: "Try:" },
    { suggestion: ["const a = 1;"] },
    { markdown: "Thanks" },
  ]);
});

test("a multi-line suggestion keeps its lines, blank ones too", () => {
  expect(splitSuggestions("```suggestion\na\n\nb\n```")).toEqual([{ suggestion: ["a", "", "b"] }]);
});

test("an empty suggestion suggests deleting the lines", () => {
  expect(splitSuggestions("```suggestion\n```")).toEqual([{ suggestion: [] }]);
});

test("a body of plain text, or another code fence, has no suggestion", () => {
  expect(splitSuggestions("Plain")).toEqual([{ markdown: "Plain" }]);
  const code = "```ts\nconst a = 1;\n```";
  expect(splitSuggestions(code)).toEqual([{ markdown: code }]);
});

test("the lines replaced are the hunk's last, new side only", () => {
  const hunk = "@@ -1,4 +1,4 @@\n one\n-old\n+two\n three";
  expect(linesUnderThread(hunk, 1)).toEqual(["three"]);
  expect(linesUnderThread(hunk, 2)).toEqual(["two", "three"]);
  expect(linesUnderThread(undefined, 1)).toEqual([]);
});

test("a single-line suggestion draws one removed and one added line, numbered", () => {
  const lines = suggestionLines(["const a = 1;"], ["const a = 2;"], 12);
  expect(lines.map((l) => [l.op, l.text, l.old, l.new])).toEqual([
    ["-", "const a = 1;", 12, undefined],
    ["+", "const a = 2;", undefined, 12],
  ]);
  expect(lines[0]?.mark).toBeDefined();
});

test("a multi-line suggestion draws its full range", () => {
  const lines = suggestionLines(["a", "b"], ["x", "y", "z"], 5);
  expect(lines.map((l) => l.op).join("")).toBe("--+++");
  expect(lines.at(-1)?.new).toBe(7);
});

test("a delete suggestion draws only removed lines", () => {
  expect(
    suggestionLines(["a", "b"], [], 5)
      .map((l) => l.op)
      .join(""),
  ).toBe("--");
});

test("a block goes after other text with a blank line", () => {
  expect(suggestionBlock(["a"], "")).toBe("```suggestion\na\n```\n");
  expect(suggestionBlock(["a"], "Try")).toBe("\n\n```suggestion\na\n```\n");
  expect(suggestionBlock(["a", "b"], "Try\n\n")).toBe("```suggestion\na\nb\n```\n");
});
