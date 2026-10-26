import { expect, test } from "vite-plus/test";

import { validLocale } from "./bridge";

test("a locale Intl can't use, as Linux can report, falls back to the default", () => {
  for (const tag of ["c", "ca-ES@valencia", "", undefined])
    expect(validLocale(tag)).toBeUndefined();
  expect(validLocale("de-DE")).toBe("de-DE");
  expect(() => new Date().toLocaleString(validLocale("c"))).not.toThrow();
});
