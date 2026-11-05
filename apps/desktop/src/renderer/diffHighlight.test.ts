import { expect, test } from "vite-plus/test";

import { languageOf, lineTokens, markTokens } from "./diffHighlight";

test("a file's language comes from its extension, when it has a known one", () => {
  expect(languageOf("src/a.ts")).toBe("ts");
  expect(languageOf("src/a.rs")).toBe("rs");
  expect(languageOf("Makefile")).toBeUndefined();
  expect(languageOf(".gitignore")).toBeUndefined();
  expect(languageOf("a.nope")).toBeUndefined();
});

test("a line's runs keep its text exactly, with classes on what it colors", () => {
  const tokens = lineTokens("ts", 'const a = "b";');
  expect(tokens.map((t) => t.text).join("")).toBe('const a = "b";');
  expect(tokens.find((t) => t.text === "const")?.cls).toBe("hljs-keyword");
});

test("a line with no language is one run", () => {
  expect(lineTokens(undefined, "plain")).toEqual([{ text: "plain" }]);
});

test("a word diff's mark cuts across runs, and the text stays whole", () => {
  const tokens = [{ text: "const ", cls: "k" }, { text: "abc" }];
  const marked = markTokens(tokens, [3, 8]);
  expect(marked.map((t) => [t.text, !!t.marked])).toEqual([
    ["con", false],
    ["st ", true],
    ["ab", true],
    ["c", false],
  ]);
  expect(marked[1]?.cls).toBe("k");
  expect(markTokens(tokens)).toBe(tokens);
});
