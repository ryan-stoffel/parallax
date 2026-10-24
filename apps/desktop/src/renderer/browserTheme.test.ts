import { argbFromHex, Hct } from "@material/material-color-utilities";
import { expect, test } from "vite-plus/test";

import { browserThemes, colorsOf, themeStyle } from "./browserTheme";

const hct = (hex: string) => Hct.fromInt(argbFromHex(hex));

test("Helium's and Chrome's fixed themes keep their own colors, and the app's has none", () => {
  expect(colorsOf("helium", false)).toMatchObject({ frame: "#FFFFFF", omnibox: "#EDEDED" });
  expect(colorsOf("helium", true)).toMatchObject({ frame: "#1E2020", tab: "#343636" });
  expect(colorsOf("default", false)).toMatchObject({ frame: "#D3E3FD", toolbar: "#FFFFFF" });
  expect(colorsOf("parallax", false)).toBeUndefined();
  expect(colorsOf("nonsense", false)).toBeUndefined();
});

test("a seeded theme takes Chrome's tones of its seed's hue", () => {
  const seed = hct("#26A69A");
  for (const [dark, frameTone, toolbarTone] of [
    [false, 90, 98],
    [true, 12, 25],
  ] as const) {
    const colors = colorsOf("aqua", dark)!;
    const frame = hct(colors.frame);
    expect(frame.tone).toBeCloseTo(frameTone, 0);
    expect(Math.abs(frame.hue - seed.hue)).toBeLessThan(8);
    expect(hct(colors.toolbar).tone).toBeCloseTo(toolbarTone, 0);
  }
  // Neutral themes are greyer than tonal ones of the same seed.
  expect(hct(colorsOf("coolGrey", false)!.frame).chroma).toBeLessThan(
    hct(colorsOf("blue", false)!.frame).chroma,
  );
});

test("every theme but the app's paints the app's tokens and the browser's own", () => {
  for (const theme of browserThemes.filter((t) => t.id !== "parallax")) {
    const style = themeStyle(colorsOf(theme.id, true)!) as Record<string, string>;
    expect(style["--pane"]).toMatch(/^#[0-9A-F]{6}$/);
    expect(style["--browser-omnibox"]).toBe(style["--selected"]);
  }
});
