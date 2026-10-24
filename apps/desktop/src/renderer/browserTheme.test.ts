import { argbFromHex, Hct } from "@material/material-color-utilities";
import { expect, test } from "vite-plus/test";

import { accentText, browserThemes, colorsOf, themeStyle } from "./browserTheme";

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

test("text on every theme's accent reads, at least 4.5:1, in light and dark", () => {
  const luminance = (hex: string) =>
    [1, 3, 5]
      .map((i) => Number.parseInt(hex.slice(i, i + 2), 16) / 255)
      .map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4))
      .reduce((sum, c, i) => sum + c * [0.2126, 0.7152, 0.0722][i]!, 0);
  const contrast = (a: string, b: string) => {
    const [x, y] = [luminance(a), luminance(b)].sort((m, n) => n - m);
    return (x! + 0.05) / (y! + 0.05);
  };
  for (const theme of browserThemes.filter((t) => t.id !== "parallax"))
    for (const dark of [false, true]) {
      const { accent } = colorsOf(theme.id, dark)!;
      expect(contrast(accent, accentText(accent)), `${theme.id} ${dark}`).toBeGreaterThanOrEqual(
        4.5,
      );
    }
});
