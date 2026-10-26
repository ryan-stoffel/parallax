import { expect, test } from "vite-plus/test";

import { codeRuns } from "./markdownBlocks";

test("code blocks are runs of their own, and the Markdown between them is joined", () => {
  expect(codeRuns("Intro\n\n- a\n\n```ts\nlet a = 1;\n```\n\nThen\n\n    indented\n")).toEqual([
    { code: false, text: "Intro\n\n- a\n\n" },
    { code: true, text: "```ts\nlet a = 1;\n```" },
    { code: false, text: "\n\nThen\n\n" },
    { code: true, text: "    indented" },
  ]);
  // A code block inside a list stays in the list's run.
  expect(codeRuns("- a\n\n  ```\n  b\n  ```")).toEqual([
    { code: false, text: "- a\n\n  ```\n  b\n  ```" },
  ]);
});
