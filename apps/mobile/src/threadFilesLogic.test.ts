import { expect, test } from "vitest";

import { inOrder, join, linesOf, nameOf, parentOf, textOf } from "./threadFilesLogic";

test("folders come first, then names, and the listing itself isn't reordered", () => {
  const entries = [
    { name: "b.txt", kind: "file" as const },
    { name: "z", kind: "dir" as const },
    { name: "a.txt", kind: "symlink" as const },
    { name: "c", kind: "dir" as const },
  ];
  expect(inOrder(entries).map((e) => e.name)).toEqual(["c", "z", "a.txt", "b.txt"]);
  expect(entries[0]!.name).toBe("b.txt");
});

test("paths go down a folder and back up to the thread's own", () => {
  expect(join("", "src")).toBe("src");
  expect(join("src", "lib")).toBe("src/lib");
  expect(parentOf("src/lib")).toBe("src");
  expect(parentOf("src")).toBe("");
  expect(nameOf("src/lib.rs")).toBe("lib.rs");
});

test("UTF-8 is text, and a NUL or a bad sequence is binary", () => {
  expect(textOf(btoa("h\xc3\xa9llo"))).toBe("héllo");
  expect(textOf(btoa("a\0b"))).toBeUndefined();
  expect(textOf(btoa("\xff\xfe"))).toBeUndefined();
});

test("rows keep blank lines, drop the last newline, and cut a very long line", () => {
  expect(linesOf("")).toEqual([]);
  expect(linesOf("a\r\n\nb\n")).toEqual(["a", "", "b"]);
  expect(linesOf("x".repeat(4001)).map((row) => row.length)).toEqual([2000, 2000, 1]);
});
