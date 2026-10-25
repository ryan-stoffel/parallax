import { expect, test } from "vite-plus/test";

import { itemScore, marks, queryWords, rank, wordScore } from "./commandSearch";

const titles = (items: string[], query: string) =>
  rank(items, queryWords(query), (t) => [[t, 1]]).map((r) => r.item);

test("a substring ranks above a fuzzy match, and a word's start above its middle", () => {
  expect(titles(["Unthreaded", "New thread", "Thread pool"], "thread")).toEqual([
    "Thread pool",
    "New thread",
    "Unthreaded",
  ]);
  expect(wordScore("thread", "new thread")!).toBeGreaterThan(wordScore("thrd", "thread")!);
});

test("initials and dropped letters match, but scattered letters don't", () => {
  expect(wordScore("ntwp", "New thread without a project")).toBeDefined();
  expect(wordScore("nwthr", "new thread")).toBeDefined();
  expect(wordScore("chtm", "Change theme")).toBeDefined();
  // `x`, `y`, and `z` are each far apart, mid-word.
  expect(wordScore("xyz", "axbbbbbybbbbbz")).toBeUndefined();
  expect(wordScore("abc", "cba")).toBeUndefined();
});

test("every word must match, in any order and in any field", () => {
  expect(itemScore(["theme", "change"], [["Change theme", 1]])).toBeDefined();
  expect(itemScore(["theme", "nope"], [["Change theme", 1]])).toBeUndefined();
  // The title is weighed above the repository.
  const found = rank(
    [
      { title: "Fix login", repo: "parallax" },
      { title: "Parallax logo", repo: "site" },
    ],
    ["parallax"],
    (t) => [
      [t.title, 1],
      [t.repo, 0.6],
    ],
  );
  expect(found.map((r) => r.item.title)).toEqual(["Parallax logo", "Fix login"]);
});

test("a query's words together in the title rank above them apart", () => {
  expect(titles(["Search the new menu", "New search menu"], "new search")).toEqual([
    "New search menu",
    "Search the new menu",
  ]);
});

test("no query keeps every item in order", () => {
  expect(titles(["b", "a"], "  ")).toEqual(["b", "a"]);
});

test("marks cover each word's substring matches, ignoring case", () => {
  expect(marks("New Thread", ["thr", "new"])).toEqual([
    { text: "New", mark: true },
    { text: " ", mark: false },
    { text: "Thr", mark: true },
    { text: "ead", mark: false },
  ]);
});
