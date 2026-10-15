import { expect, test } from "vite-plus/test";

import { blurSupported, validLocale } from "./bridge";

test("a locale Intl can't use, as Linux can report, falls back to the default", () => {
  for (const tag of ["c", "ca-ES@valencia", "", undefined])
    expect(validLocale(tag)).toBeUndefined();
  expect(validLocale("de-DE")).toBe("de-DE");
  expect(() => new Date().toLocaleString(validLocale("c"))).not.toThrow();
});

test("blur is on macOS and Windows 11 22H2 or later, never Windows 10 or Linux", () => {
  expect(blurSupported("darwin", "26.0.0")).toBe(true);
  expect(blurSupported("win32", "10.0.22621")).toBe(true);
  expect(blurSupported("win32", "10.0.19045")).toBe(false);
  expect(blurSupported("linux", "6.8.0")).toBe(false);
});
