import { expect, test } from "vite-plus/test";

import { browserShortcut, isOpenableExternally, isReload, mayNavigate } from "./links";

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

test("a browser page takes Chrome's shortcuts with Cmd on macOS and Ctrl elsewhere", () => {
  const press = (
    key: string,
    mods: { meta?: boolean; control?: boolean; shift?: boolean } = {},
  ) => ({
    type: "keyDown",
    key,
    meta: false,
    control: false,
    alt: false,
    shift: false,
    ...mods,
  });
  expect(browserShortcut(press("r", { meta: true }), "darwin")).toBe("reload");
  expect(browserShortcut(press("R", { control: true }), "win32")).toBe("reload");
  expect(browserShortcut(press("[", { meta: true }), "darwin")).toBe("back");
  expect(browserShortcut(press("l", { control: true }), "linux")).toBe("address");
  expect(browserShortcut(press("w", { meta: true }), "darwin")).toBe("closeTab");
  expect(browserShortcut(press("-", { control: true }), "win32")).toBe("zoomOut");
  // The other platform's modifier, Shift, a key it doesn't know, or a key coming up pass through.
  expect(browserShortcut(press("r", { control: true }), "darwin")).toBeUndefined();
  expect(browserShortcut(press("r", { meta: true }), "linux")).toBeUndefined();
  expect(browserShortcut(press("R", { meta: true, shift: true }), "darwin")).toBe("hardReload");
  expect(browserShortcut(press("t", { meta: true, shift: true }), "darwin")).toBe("reopenTab");
  expect(browserShortcut(press("y", { meta: true, shift: true }), "darwin")).toBeUndefined();
  expect(browserShortcut(press("k", { meta: true }), "darwin")).toBeUndefined();
  expect(
    browserShortcut({ ...press("r", { meta: true }), type: "keyUp" }, "darwin"),
  ).toBeUndefined();
});

test("an extension's page may go only to its own pages", () => {
  const popup = "chrome-extension://abc/popup.html";
  expect(mayNavigate("chrome-extension://abc/options.html", popup, true)).toBe(true);
  expect(mayNavigate("chrome-extension://xyz/popup.html", popup, true)).toBe(false);
  expect(mayNavigate(popup, "https://example.com/", true)).toBe(false);
  expect(mayNavigate("https://example.com/", popup, true)).toBe(true);
});

test("a browser page takes Chrome's find, print, bookmark, and tab shortcuts", () => {
  const press = (
    key: string,
    mods: Partial<Record<"meta" | "control" | "alt" | "shift", boolean>>,
  ) => ({
    type: "keyDown",
    key,
    meta: false,
    control: false,
    alt: false,
    shift: false,
    ...mods,
  });
  expect(browserShortcut(press("f", { meta: true }), "darwin")).toBe("find");
  expect(browserShortcut(press("G", { control: true, shift: true }), "win32")).toBe("findPrevious");
  expect(browserShortcut(press("p", { control: true }), "linux")).toBe("print");
  expect(browserShortcut(press("d", { meta: true }), "darwin")).toBe("bookmark");
  expect(browserShortcut(press("3", { meta: true }), "darwin")).toBe("tab3");
  expect(browserShortcut(press("9", { control: true }), "win32")).toBe("lastTab");
  // Ctrl+Tab on every platform, Cmd+Option+arrows on macOS, Ctrl+PageDown and PageUp elsewhere.
  expect(browserShortcut(press("Tab", { control: true }), "darwin")).toBe("nextTab");
  expect(browserShortcut(press("Tab", { control: true, shift: true }), "win32")).toBe(
    "previousTab",
  );
  expect(browserShortcut(press("ArrowRight", { meta: true, alt: true }), "darwin")).toBe("nextTab");
  expect(browserShortcut(press("ArrowLeft", { meta: true, alt: true }), "win32")).toBeUndefined();
  expect(browserShortcut(press("PageUp", { control: true }), "linux")).toBe("previousTab");
  expect(browserShortcut(press("PageUp", { control: true }), "darwin")).toBeUndefined();
});
