import { expect, test } from "vite-plus/test";

import { filePath, fileReference, unloadedImages } from "./markdownLinks";

test("recognizes inline code that names a file, and nothing else", () => {
  for (const code of [
    "src/App.tsx",
    "./run.sh",
    "../x/y.md",
    "~/notes.txt",
    "/Users/r/a.txt",
    "C:\\x\\y.ts",
    "a/b.rs:3:7",
  ])
    expect(filePath.test(code), code).toBe(true);
  for (const code of [
    "App.tsx",
    "ui.tsx:12",
    "npm run build",
    "https://x.dev/a.ts",
    "a.b",
    "#1284",
    "useState()",
    "127.0.0.1:8080",
    "api.example.com:443",
    "v1.2/3.4",
  ])
    expect(filePath.test(code), code).toBe(false);
});

test("a recognized path names its file without its line", () => {
  expect(fileReference("src/ui.tsx:12:3")).toBe("src/ui.tsx");
  expect(fileReference("http://localhost:8080")).toBe("http://localhost:8080");
});

test("an image that doesn't load is a link with its alt text, and code is left alone", () => {
  const onGh = (url: string) => url.startsWith("https://github.com/");
  expect(
    unloadedImages("See ![chart](https://x.dev/c.png) and ![](https://github.com/a.png)", onGh),
  ).toBe("See [chart](https://x.dev/c.png) and ![](https://github.com/a.png)");
  expect(unloadedImages('![](<a b.png> "t")', () => false)).toBe('[Image](<a b.png> "t")');
  expect(unloadedImages("`![a](x.png)`\n\n```md\n![b](y.png)\n```\n![c](z.png)", () => false)).toBe(
    "`![a](x.png)`\n\n```md\n![b](y.png)\n```\n[c](z.png)",
  );
});

test("an image is alone on its line, past quote marks, or among other text, and by reference a link", () => {
  const seen: [string, boolean][] = [];
  const shown = (url: string, alone: boolean) => (seen.push([url, alone]), true);
  unloadedImages('![a](a.png)\n> ![b](b.png "t")\nSee ![c](c.png) here\n- ![d](d.png)', shown);
  expect(seen).toEqual([
    ["a.png", true],
    ["b.png", true],
    ["c.png", false],
    ["d.png", false],
  ]);
  expect(unloadedImages("![chart][1]\n\n[1]: https://x.dev/c.png", () => true)).toBe(
    "[chart][1]\n\n[1]: https://x.dev/c.png",
  );
});
