import { expect, test } from "vite-plus/test";

import { markdownBlocks } from "./markdownBlocks";

test("splits at blank lines before a new top-level block", () => {
  expect(markdownBlocks("# Title\n\nOne\ntwo\n\n> quote\n\n\nEnd")).toEqual([
    "# Title\n\n",
    "One\ntwo\n\n",
    "> quote\n\n\n",
    "End",
  ]);
});

test("never splits inside a code fence, until a matching fence closes it", () => {
  const backticks = "````md\nA\n\n```\nstill code\n\n````\n\nAfter";
  expect(markdownBlocks(backticks)).toEqual(["````md\nA\n\n```\nstill code\n\n````\n\n", "After"]);
  const tildes = "~~~\nA\n\n```\n\nB\n~~~\n\nAfter";
  expect(markdownBlocks(tildes)).toEqual(["~~~\nA\n\n```\n\nB\n~~~\n\n", "After"]);
  // An unclosed fence, as a streaming message has, runs to the end.
  expect(markdownBlocks("Intro\n\n```ts\nconst a = 1;\n\nconst b")).toEqual([
    "Intro\n\n",
    "```ts\nconst a = 1;\n\nconst b",
  ]);
  // Backticks in the info string make it inline code, not a fence.
  expect(markdownBlocks("``` a`b\n\nNext")).toEqual(["``` a`b\n\n", "Next"]);
});

test("keeps what a blank line doesn't end in one block", () => {
  // A loose list: items apart by blank lines are one list.
  expect(markdownBlocks("- a\n\n- b\n\n1. c\n\n2) d")).toEqual(["- a\n\n- b\n\n1. c\n\n2) d"]);
  // A list item's continuation, and indented code.
  expect(markdownBlocks("- a\n\n  more\n\n    code\n\n\tcode")).toEqual([
    "- a\n\n  more\n\n    code\n\n\tcode",
  ]);
  // Definitions and raw HTML blocks reach across blocks, so such text stays whole.
  expect(markdownBlocks("See [x].\n\n[x]: https://example.com")).toHaveLength(1);
  expect(markdownBlocks("A[^1]\n\n[^1]: Note")).toHaveLength(1);
  expect(markdownBlocks("<!--\n\nhidden\n\n-->\n\nShown")).toHaveLength(1);
});

test("blanks of whitespace split, and the blocks join to the text", () => {
  const text = "One  \n \t\nTwo\n\n";
  expect(markdownBlocks(text)).toEqual(["One  \n \t\n", "Two\n\n"]);
  expect(markdownBlocks("")).toEqual([""]);
});
