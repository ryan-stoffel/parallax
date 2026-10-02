import { expect, test } from "vite-plus/test";

import { isOpenableExternally, isReload, mayNavigate } from "./links";

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

test("the side panel's browser may go to any http or https page, the app's pages only reload", () => {
  const app = "file:///Applications/parallax.app/Contents/Resources/app/dist/renderer/index.html";
  for (const url of ["http://localhost:5173/", "https://example.com/a?b=1"]) {
    expect(mayNavigate(url, "http://localhost:5173/", true), url).toBe(true);
    expect(mayNavigate(url, app, false), url).toBe(false);
  }
  for (const url of ["file:///etc/passwd", "javascript:alert(1)", "parallax://x", "not a url"]) {
    expect(mayNavigate(url, "http://localhost:5173/", true), url).toBe(false);
  }
  expect(mayNavigate(app, app, false)).toBe(true);
});
