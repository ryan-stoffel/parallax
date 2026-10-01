import { expect, test } from "vite-plus/test";

import { diffLines, diffStats, lines } from "./diff";

// A diff as text, one line each: " " same, "+" added, "-" removed.
const show = (before: string, after: string) =>
  diffLines(before, after).map((l) => ({ same: " ", add: "+", remove: "-" })[l.kind] + l.text);

test("a changed line in the middle is removed, then added, between the lines both keep", () => {
  expect(show("a\nb\nc", "a\nB\nc")).toEqual([" a", "-b", "+B", " c"]);
});

test("added and removed lines keep their places", () => {
  expect(show("a\nc", "a\nb\nc")).toEqual([" a", "+b", " c"]);
  expect(show("a\nb\nc", "a\nc")).toEqual([" a", "-b", " c"]);
  expect(show("a\nb", "b\nc")).toEqual(["-a", " b", "+c"]);
});

test("a rewrite of several lines groups its removals before its additions", () => {
  expect(show("keep\none\ntwo\nkeep too", "keep\nuno\ndos\ntres\nkeep too")).toEqual([
    " keep",
    "-one",
    "-two",
    "+uno",
    "+dos",
    "+tres",
    " keep too",
  ]);
});

test("a line that moves keeps the longest run of shared lines", () => {
  expect(show("x\na\nb\nc", "a\nb\nc\nx")).toEqual(["-x", " a", " b", " c", "+x"]);
});

test("empty text has no lines, and a final newline adds none", () => {
  expect(show("", "new")).toEqual(["+new"]);
  expect(show("old", "")).toEqual(["-old"]);
  expect(show("", "")).toEqual([]);
  expect(lines("a\nb\n")).toEqual(["a", "b"]);
  expect(lines("a\n\n")).toEqual(["a", ""]);
});

test("the stats count additions and removals", () => {
  expect(diffStats(diffLines("a\nb\nc", "a\nB\nC\nD\nc"))).toEqual({ added: 3, removed: 1 });
  expect(diffStats(diffLines("same", "same"))).toEqual({ added: 0, removed: 0 });
});

test("a diff too big for the table still lists every line", () => {
  const before = Array.from({ length: 3000 }, (_, i) => `old ${i}`).join("\n");
  const after = Array.from({ length: 3000 }, (_, i) => `new ${i}`).join("\n");
  const diff = diffLines(`top\n${before}\nbottom`, `top\n${after}\nbottom`);
  expect(diff).toHaveLength(6002);
  expect(diff[0]).toEqual({ kind: "same", text: "top" });
  expect(diff.at(-1)).toEqual({ kind: "same", text: "bottom" });
  expect(diffStats(diff)).toEqual({ added: 3000, removed: 3000 });
});
