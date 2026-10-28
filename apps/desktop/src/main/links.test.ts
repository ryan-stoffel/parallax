import { expect, test } from "vite-plus/test";

import { isOpenableExternally, isReload, mayNavigate, shownFilePath } from "./links";

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

test("an extension's page may go only to its own pages", () => {
  const popup = "chrome-extension://abc/popup.html";
  expect(mayNavigate("chrome-extension://abc/options.html", popup, true)).toBe(true);
  expect(mayNavigate("chrome-extension://xyz/popup.html", popup, true)).toBe(false);
  expect(mayNavigate(popup, "https://example.com/", true)).toBe(false);
  expect(mayNavigate("https://example.com/", popup, true)).toBe(true);
});

test("a linked file shows only as an absolute path, or one from the home folder", () => {
  expect(shownFilePath("~/Movies/demo.mp4", "/Users/me")).toBe("/Users/me/Movies/demo.mp4");
  expect(shownFilePath("/tmp/a/../b.txt", "/Users/me")).toBe("/tmp/b.txt");
  for (const value of ["out/a.txt", "../a.txt", "~", "~other/a.txt", "/a\nb", 7, undefined])
    expect(shownFilePath(value, "/Users/me"), String(value)).toBeUndefined();
});
