// @vitest-environment happy-dom
import { expect, test } from "vite-plus/test";

import { applyAppearance, defaults, setBuild, tint } from "./appearance";

test("the theme covers less of an OS blur, which has a tint of its own", () => {
  expect(tint("clear", 75, "darwin")).toBe(75);
  expect(tint("blur", 75, "darwin")).toBe(30);
  expect(tint("blur", 75, "win32")).toBe(30);
  // Linux's blur is the compositor's, of a clear window.
  expect(tint("blur", 75, "linux")).toBe(75);
});

test("a nightly's art shows until Nightly style is turned off", () => {
  const { classList } = document.documentElement;
  setBuild("2611.11712.10000-nightly");
  expect(classList.contains("nightly")).toBe(true);
  expect(classList.contains("stage")).toBe(true);
  applyAppearance({ ...defaults, buildArt: false });
  expect(classList.contains("nightly")).toBe(false);
  expect(classList.contains("stage")).toBe(false);
});
