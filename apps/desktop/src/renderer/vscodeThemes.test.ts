import { strToU8, zipSync } from "fflate";
import { expect, test } from "vite-plus/test";

import {
  contrast,
  parseJsonc,
  themeCss,
  themesFromVsix,
  tokensOf,
  type Tokens,
} from "./vscodeThemes";

// Parallax's tokens a theme falls back on, as far as these tests need them.
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

test("a theme's faint text, links, and errors move until they read on its background and sidebar", () => {
  for (const [mode, colors] of [
    [
      "dark",
      {
        "editor.background": "#282a36",
        "sideBar.background": "#21222c",
        "editor.foreground": "#6272a4",
        "textLink.foreground": "#3a3d4f",
        errorForeground: "#5a2020",
      },
    ],
    [
      "light",
      {
        "editor.background": "#f2e9e1",
        "sideBar.background": "#e6dcd2",
        "editor.foreground": "#9893a5",
        "textLink.foreground": "#c4a7e7",
        errorForeground: "#eb6f92",
      },
    ],
  ] as const) {
    const { tokens, blueOrange } = tokensOf({ colors }, mode, defaults[mode]);
    const texts = {
      ...tokens,
      ...Object.fromEntries(
        Object.entries(blueOrange).map(([k, v]) => [`${k} (blue & orange)`, v]),
      ),
    };
    for (const name of [
      "--foreground",
      "--muted-foreground",
      "--faint-foreground",
      "--accent",
      "--danger",
      "--added",
      "--added (blue & orange)",
      "--danger (blue & orange)",
    ])
      for (const fill of [tokens["--background"]!, tokens["--sidebar"]!])
        expect(contrast(texts[name]!, fill), `${mode} ${name}`).toBeGreaterThanOrEqual(4.5);
    expect(contrast(tokens["--project-orange"]!, tokens["--sidebar"]!)).toBeGreaterThanOrEqual(3);
  }
});

test("a translucent color is painted over the background, and a scope takes its most specific rule", () => {
  const { tokens } = tokensOf(
    {
      colors: { "editor.background": "#ffffff", "sideBar.background": "#00000080" },
      tokenColors: [
        { scope: "keyword", settings: { foreground: "#111111" } },
        { scope: "keyword.control", settings: { foreground: "#222222" } },
        { scope: ["string", "keyword.control.flow"], settings: { foreground: "#333333" } },
      ],
    },
    "light",
    { ...defaults.light, "--syntax-keyword": "#000000", "--syntax-string": "#000000" },
  );
  expect(tokens["--sidebar"]).toBe("#7f7f7f");
  expect(tokens["--syntax-keyword"]).toBe("#222222");
  expect(tokens["--syntax-string"]).toBe("#333333");
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

test("a theme's CSS sets its mode's tokens, in the app and in previews, and its Blue & orange", () => {
  const css = themeCss([
    {
      id: "moon.theme",
      name: "Moon",
      themes: [
        {
          id: "moon-night",
          name: "Moon Night",
          mode: "dark",
          tokens: { "--background": "#101020" },
          blueOrange: { "--added": "#58a6ff" },
        },
      ],
    },
  ]);
  expect(css).toContain(
    ":root.dark:where(.theme-moon-night),\n.scheme-dark.theme-moon-night {\n  --background: #101020;\n}",
  );
  expect(css).toContain(
    ":root.dark.diff-blue-orange:where(.theme-moon-night) {\n  --added: #58a6ff;\n}",
  );
});
