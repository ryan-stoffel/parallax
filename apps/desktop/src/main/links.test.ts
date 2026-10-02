import { expect, test } from "vite-plus/test";

import { isOpenableExternally, isReload } from "./links";

test("only https links open in the system browser", () => {
  expect(isOpenableExternally("https://github.com/ryan-stoffel/parallax")).toBe(true);

  for (const url of [
    "http://example.com",
    "file:///etc/passwd",
    "javascript:alert(1)",
    "smb://host/share",
    "not a url",
  ]) {
    expect(isOpenableExternally(url), url).toBe(false);
  }
});

test("only a reload of the current page may navigate", () => {
  const page = "file:///Applications/parallax.app/Contents/Resources/app/dist/renderer/index.html";
  expect(isReload(page, page)).toBe(true);
  expect(isReload("http://localhost:5173/", "http://localhost:5173/")).toBe(true);

  for (const url of [
    "https://example.com/",
    "file:///etc/passwd",
    `${page}?x=1`,
    "http://localhost:5174/",
  ]) {
    expect(isReload(url, page), url).toBe(false);
  }
});
