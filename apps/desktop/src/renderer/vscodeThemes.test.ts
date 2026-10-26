import { strToU8, zipSync } from "fflate";
import { expect, test } from "vite-plus/test";

import {
  customColors,
  customColorsCss,
  parseJsonc,
  themesFromVsix,
  type Tokens,
} from "./vscodeThemes";

// Fallback tokens for a theme that lacks a color, shaped like Parallax's (its real ones are in index.css).
const defaults: Record<"light" | "dark", Tokens> = {
  light: {
    "--background": "#fcfcfc",
    "--foreground": "#27272a",
    "--accent": "#2b5cff",
    "--danger": "#c42b2b",
    "--warning": "#d97706",
    "--added": "#15803d",
    "--project-orange": "#ea580c",
  },
  dark: {
    "--background": "#0a0a0a",
    "--foreground": "#f4f4f5",
    "--accent": "#4b78ff",
    "--danger": "#ff8f8a",
    "--warning": "#f59e0b",
    "--added": "#4ade80",
    "--project-orange": "#fb923c",
  },
};

test("theme files may have comments and trailing commas, but a string's // stays", () => {
  expect(
    parseJsonc(`{
      // a comment
      "url": "https://example.com", /* another */
      "list": [1, 2,],
    }`),
  ).toEqual({ url: "https://example.com", list: [1, 2] });
});

test("a .vsix's themes are read from its manifest, with included files merged under them", () => {
  const vsix = zipSync({
    "extension/package.json": strToU8(
      JSON.stringify({
        contributes: {
          themes: [{ label: "Moon Night", uiTheme: "vs-dark", path: "./themes/moon night.json" }],
        },
      }),
    ),
    "extension/themes/moon night.json": strToU8(
      `{ "include": "./base.json", "colors": { "editor.foreground": "#eeeeee" } }`,
    ),
    "extension/themes/base.json": strToU8(`{ "colors": { "editor.background": "#101020" } }`),
  });
  const [theme, ...rest] = themesFromVsix(vsix, "moon.theme", defaults);
  expect(rest).toEqual([]);
  expect(theme).toMatchObject({ id: "moon-theme-moon-night", name: "Moon Night", mode: "dark" });
  expect(theme!.tokens["--background"]).toBe("#101020");
  expect(theme!.tokens["--foreground"]).toBe("#eeeeee");

  const iconsOnly = zipSync({ "extension/package.json": strToU8(`{ "contributes": {} }`) });
  expect(() => themesFromVsix(iconsOnly, "icons", defaults)).toThrow("no color themes");
});

test("Edit as JSON takes token names and VS Code's color keys, and names what it can't take", () => {
  expect(
    customColors({
      accent: "#ff4a1f",
      "--code": "rgb(0 0 0 / 20%)",
      "sideBar.background": "#101010",
      border: "#ffffff14",
    }),
  ).toEqual({
    tokens: {
      "--accent": "#ff4a1f",
      "--code": "rgb(0 0 0 / 20%)",
      "--sidebar": "#101010",
      "--border": "#ffffff14",
    },
    errors: [],
  });
  expect(
    customColors({ "activityBar.background": "#000", accent: "red; } body { display: none" })
      .errors,
  ).toEqual([
    "activityBar.background isn't a color Parallax has.",
    'accent: "red; } body { display: none" isn\'t a color.',
  ]);
});

test("changed colors go under their theme's mode, leaving out unknown themes and bad colors", () => {
  const css = customColorsCss(
    {
      "parallax-dark": { "--accent": "#ff4a1f", "--sidebar": "url(x)}" },
      gone: { "--accent": "#000000" },
    },
    { "parallax-dark": "dark" },
  );
  expect(css).toBe(
    ":root.dark:where(.theme-parallax-dark),\n.scheme-dark.theme-parallax-dark {\n  --accent: #ff4a1f !important;\n}",
  );
});
