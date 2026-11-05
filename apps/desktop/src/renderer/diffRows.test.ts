import { expect, test } from "vite-plus/test";

import { diffRows, pairLines, pickRange, sameRow, type Row } from "./diffRows";
import { parseDiff, type DiffFile } from "./parseDiff";
import type { ThreadView } from "./pr/model";

const hunk = (...lines: string[]) =>
  parseDiff(["diff --git a/a.ts b/a.ts", "+++ b/a.ts", "@@ -1,9 +1,9 @@", ...lines].join("\n"))[0]!;

/** A pair's text on each side, or null where that side is empty. */
const sides = (file: DiffFile) =>
  pairLines(file.lines)
    .slice(1)
    .map((r) => [r.left?.text ?? null, r.right?.text ?? null]);

const open = () => false;
const thread = (t: Partial<ThreadView>): ThreadView => ({
  path: "a.ts",
  resolved: false,
  comments: [],
  ...t,
});

test("a modified run pairs line by line, and context sits on both sides", () => {
  expect(sides(hunk(" same", "-old one", "-old two", "+new one", "+new two"))).toEqual([
    ["same", "same"],
    ["old one", "new one"],
    ["old two", "new two"],
  ]);
});

test("what a modified run has left over sits alone on its side", () => {
  expect(sides(hunk("-a", "-b", "-c", "+x"))).toEqual([
    ["a", "x"],
    ["b", null],
    ["c", null],
  ]);
  expect(sides(hunk("-a", "+x", "+y"))).toEqual([
    ["a", "x"],
    [null, "y"],
  ]);
});

test("an added-only or removed-only run has one side", () => {
  expect(sides(hunk(" c", "+x", "+y", " d"))).toEqual([
    ["c", "c"],
    [null, "x"],
    [null, "y"],
    ["d", "d"],
  ]);
  expect(sides(hunk(" c", "-x", " d"))).toEqual([
    ["c", "c"],
    ["x", null],
    ["d", "d"],
  ]);
});

test("a hunk's band stays one row across both sides", () => {
  const [band] = pairLines(hunk(" c").lines);
  expect(band?.line?.op).toBe("@");
  expect(band?.left).toBeUndefined();
});

test("a split row's lines keep the numbers of their own side", () => {
  const [, pair] = pairLines(hunk("-old", "+new").lines);
  expect([pair?.left?.old, pair?.right?.new]).toEqual([1, 1]);
});

test("a thread sits under its line on its side", () => {
  const file = hunk(" c", "-old", "+new");
  const left = thread({ line: 2, side: "left" });
  const right = thread({ line: 2, side: "right" });
  const rows = diffRows([file], "split", open, [left, right]);
  const at = rows.findIndex((r) => r.sides);
  expect(rows[at]?.sides).toEqual({ left: [left], right: [right] });
  expect(rows[at - 1]?.left?.text).toBe("old");
  expect(rows[at - 1]?.right?.text).toBe("new");
});

test("a thread on a removed line sits under it in unified too, not above the file", () => {
  const file = hunk(" c", "-old", "+new");
  const on = thread({ line: 2, side: "left" });
  const rows = diffRows([file], "unified", open, [on]);
  const at = rows.findIndex((r) => r.threads?.includes(on));
  expect(rows[at - 1]?.line?.text).toBe("old");
});

test("a thread without a side is on the new side, as older plxd reports it", () => {
  const file = hunk(" c", "+new");
  const on = thread({ line: 2 });
  const rows = diffRows([file], "split", open, [on]);
  expect(rows.find((r) => r.sides)?.sides).toEqual({ left: [], right: [on] });
});

test("a thread on no shown line sits under its file's header", () => {
  const rows = diffRows([hunk(" c")], "split", open, [thread({ line: 99 }), thread({})]);
  expect(rows[0]?.header).toBe(true);
  expect(rows[1]?.threads).toHaveLength(2);
});

test("a shut file is only its header", () => {
  const rows = diffRows([hunk(" c")], "split", () => true, [thread({ line: 1 })]);
  expect(rows).toHaveLength(1);
});

test("sameRow finds a line in the other layout", () => {
  const file = hunk(" c", "-old", "+new");
  const unified = diffRows([file], "unified", open, []);
  const split = diffRows([file], "split", open, []);
  const added = unified.find((r: Row) => r.line?.text === "new")!;
  expect(split[sameRow(split, added)]?.right?.text).toBe("new");
  expect(sameRow(split, unified[0]!)).toBe(0);
});

const twoHunks = () =>
  parseDiff(
    [
      "diff --git a/a.ts b/a.ts",
      "+++ b/a.ts",
      "@@ -1,3 +1,3 @@",
      " one",
      "-two",
      "+TWO",
      " three",
      "@@ -20,2 +20,2 @@",
      " twenty",
      "+new",
    ].join("\n"),
  )[0]!;

test("a range keeps its ends in order, on one side", () => {
  const { lines } = twoHunks();
  expect(pickRange(lines, "right", 3, 1)).toEqual({ side: "right", start: 1, end: 3 });
  expect(pickRange(lines, "right", 1, 2)).toEqual({ side: "right", start: 1, end: 2 });
  expect(pickRange(lines, "left", 2, 2)).toEqual({ side: "left", start: 2, end: 2 });
});

test("a range stops at the end of its hunk, in either direction", () => {
  const { lines } = twoHunks();
  expect(pickRange(lines, "right", 2, 20)).toEqual({ side: "right", start: 2, end: 3 });
  expect(pickRange(lines, "right", 21, 3)).toEqual({ side: "right", start: 20, end: 21 });
});

test("a range from a line the diff doesn't show is just that line", () => {
  expect(pickRange(twoHunks().lines, "right", 99, 2)).toEqual({
    side: "right",
    start: 99,
    end: 99,
  });
});

test("the comment box sits under its range's last line, after the threads there", () => {
  const file = twoHunks();
  const on = thread({ line: 3 });
  const range = { side: "right", start: 2, end: 3 } as const;
  const rows = diffRows([file], "unified", open, [on], { path: "a.ts", range });
  const box = rows.findIndex((r) => r.composer);
  expect(rows[box]?.composer).toBe("across");
  expect(rows[box - 1]?.threads).toEqual([on]);
  expect(rows[box - 2]?.line?.text).toBe("three");
});

test("in split the comment box sits on its side, for an old or a new line", () => {
  const file = twoHunks();
  const left = { side: "left", start: 2, end: 2 } as const;
  const rows = diffRows([file], "split", open, [], { path: "a.ts", range: left });
  const box = rows.findIndex((r) => r.composer);
  expect(rows[box]?.composer).toBe("left");
  expect(rows[box - 1]?.left?.text).toBe("two");
});

test("a whole-file comment box sits atop the file, and another file's isn't here", () => {
  const rows = diffRows([twoHunks()], "split", open, [], { path: "a.ts" });
  expect(rows[1]?.composer).toBe("across");
  const other = diffRows([twoHunks()], "split", open, [], { path: "b.ts" });
  expect(other.some((r) => r.composer)).toBe(false);
});
