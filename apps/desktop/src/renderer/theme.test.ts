import { readFileSync } from "node:fs";

import { expect, test } from "vite-plus/test";

import { colorThemes } from "./appearance";
import { resolveTheme } from "./theme";

test("system follows the OS, and an explicit choice ignores it", () => {
  expect(resolveTheme("system", true)).toBe("dark");
  expect(resolveTheme("system", false)).toBe("light");
  expect(resolveTheme("dark", false)).toBe("dark");
  expect(resolveTheme("light", true)).toBe("light");
});

// index.css's and themes.css's hex tokens, by each rule's selector, comments dropped.
const css = ["./index.css", "./themes.css"]
  .map((file) => readFileSync(new URL(file, import.meta.url), "utf8"))
  .join("\n")
  .replace(/\/\*[\s\S]*?\*\//g, "");
function tokens(selector: string): Record<string, string> {
  const rule = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].find((m) =>
    m[1]!.split(",").some((s) => s.trim() === selector),
  );
  if (!rule) throw new Error(`no rule for ${selector}`);
  return Object.fromEntries(
    [...rule[2]!.matchAll(/(--[\w-]+):\s*(#[0-9a-f]{6});/g)].map((m) => [m[1], m[2]]),
  );
}

// WCAG 2's contrast ratio of two #rrggbb colors.
function contrast(a: string, b: string) {
  const luminance = (hex: string) => {
    const [r, g, b] = [1, 3, 5].map((i) => {
      const c = parseInt(hex.slice(i, i + 2), 16) / 255;
      return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
  };
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi! + 0.05) / (lo! + 0.05);
}

test("every theme's text keeps 4.5:1, and its Project colors 3:1, on its background and sidebar", () => {
  const light = tokens(".scheme-light");
  const base = { light, dark: { ...light, ...tokens(".scheme-dark") } };
  for (const { id, mode } of colorThemes) {
    const t = id.startsWith("parallax-")
      ? base[mode]
      : { ...base[mode], ...tokens(`.scheme-${mode}.theme-${id}`) };
    const texts = [
      "foreground",
      "muted-foreground",
      "faint-foreground",
      "accent",
      "danger",
      "added",
    ];
    for (const text of texts)
      for (const fill of ["background", "sidebar"])
        expect
          .soft(contrast(t[`--${text}`]!, t[`--${fill}`]!), `${id} --${text} on --${fill}`)
          .toBeGreaterThanOrEqual(4.5);
    for (const project of Object.keys(t).filter((k) => k.startsWith("--project-")))
      expect
        .soft(contrast(t[project]!, t["--sidebar"]!), `${id} ${project} on --sidebar`)
        .toBeGreaterThanOrEqual(3);
  }
});
