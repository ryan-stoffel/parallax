import { expect, test } from "vite-plus/test";

import { markdownBlocks } from "./markdownBlocks";

test("splits at blank lines between top-level blocks", () => {
  expect(markdownBlocks("# Title\n\nOne\ntwo\n\n> quote\n\n\n- a\n- b\n\nEnd")).toEqual([
    "# Title\n\n",
    "One\ntwo\n\n",
    "> quote\n\n\n",
    "- a\n- b\n\n",
    "End",
  ]);
  // Not between blocks with no blank line, nor inside one.
  expect(markdownBlocks("# Title\nText\n\n- a\n\n- b")).toEqual([
    "# Title\nText\n\n",
    "- a\n\n- b",
  ]);
});

test("never splits inside a code fence, as the parser reads it", () => {
  expect(markdownBlocks("````md\nA\n\n```\nstill code\n\n````\n\nAfter")).toEqual([
    "````md\nA\n\n```\nstill code\n\n````\n\n",
    "After",
  ]);
  // An unclosed fence, as a streaming message has, runs to the end.
  expect(markdownBlocks("Intro\n\n```ts\nconst a = 1;\n\nconst b")).toEqual([
    "Intro\n\n",
    "```ts\nconst a = 1;\n\nconst b",
  ]);
  // A column-0 fence after a list item's fence opens a new one, to the end.
  const listFence = "1. Run:\n   ```sh\n   cargo test\n```\n\nThen check.\n\nDone.";
  expect(markdownBlocks(listFence)).toEqual([listFence]);
  // CRLF line endings.
  expect(markdownBlocks("```\r\ncode\r\n\r\nmore\r\n```\r\n\r\nAfter")).toEqual([
    "```\r\ncode\r\n\r\nmore\r\n```\r\n\r\n",
    "After",
  ]);
});

test("keeps an indented block's indent with it", () => {
  expect(markdownBlocks("A\n\n  ```\n  code\n  ```")).toEqual(["A\n\n", "  ```\n  code\n  ```"]);
});

test("doesn't split around raw HTML, or text with a definition", () => {
  expect(markdownBlocks("<details>\n\nText\n\nMore")).toEqual(["<details>\n\nText\n\n", "More"]);
  expect(markdownBlocks("See [x].\n\n> [x]: https://example.com")).toHaveLength(1);
  expect(markdownBlocks("A[^1]\n\nB\n\n- [^1]: Note")).toHaveLength(1);
});

test("a line of other whitespace isn't blank", () => {
  expect(markdownBlocks("a\n \nb")).toEqual(["a\n \nb"]);
  expect(markdownBlocks("a\n \t\nb")).toEqual(["a\n \t\n", "b"]);
  expect(markdownBlocks("")).toEqual([""]);
});
