import { expect, test } from "vite-plus/test";

import { blurSupported, needsTransparentWindow, validLocale } from "./bridge";

test("a locale Intl can't use, as Linux can report, falls back to the default", () => {
  for (const tag of ["c", "ca-ES@valencia", "", undefined])
    expect(validLocale(tag)).toBeUndefined();
  expect(validLocale("de-DE")).toBe("de-DE");
  expect(() => new Date().toLocaleString(validLocale("c"))).not.toThrow();
});

test("blur is on macOS, Windows 11 22H2 or later, and Linux's compositors, never Windows 10", () => {
  expect(blurSupported("darwin", "26.0.0")).toBe(true);
  expect(blurSupported("win32", "10.0.22621")).toBe(true);
  expect(blurSupported("win32", "10.0.19045")).toBe(false);
  expect(blurSupported("linux", "6.8.0")).toBe(true);
});

test("clear needs a see-through window everywhere, and blurred only on Linux", () => {
  expect(needsTransparentWindow("clear", "darwin")).toBe(true);
  expect(needsTransparentWindow("blur", "darwin")).toBe(false);
  expect(needsTransparentWindow("blur", "win32")).toBe(false);
  expect(needsTransparentWindow("blur", "linux")).toBe(true);
  expect(needsTransparentWindow("opaque", "linux")).toBe(false);
});
