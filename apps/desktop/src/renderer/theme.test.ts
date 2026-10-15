import { readFileSync } from "node:fs";

import { expect, test } from "vite-plus/test";

import { contrast } from "./vscodeThemes";
import { resolveTheme } from "./theme";

test("system follows the OS, and an explicit choice ignores it", () => {
  expect(resolveTheme("system", true)).toBe("dark");
  expect(resolveTheme("system", false)).toBe("light");
  expect(resolveTheme("dark", false)).toBe("dark");
  expect(resolveTheme("light", true)).toBe("light");
});

// index.css's hex tokens, by each rule's selector, comments dropped.
const css = readFileSync(new URL("./index.css", import.meta.url), "utf8").replace(
  /\/\*[\s\S]*?\*\//g,
  "",
);
function tokens(selector: string): Record<string, string> {
  const rule = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].find((m) =>
    m[1]!.split(",").some((s) => s.trim() === selector),
  );
  if (!rule) throw new Error(`no rule for ${selector}`);
  return Object.fromEntries(
    [...rule[2]!.matchAll(/(--[\w-]+):\s*(#[0-9a-f]{6});/g)].map((m) => [m[1], m[2]]),
  );
}

test("Parallax's text keeps 4.5:1, and its Project colors 3:1, in each mode and setting", () => {
  const light = tokens(".scheme-light");
  const dark = { ...light, ...tokens(".scheme-dark") };
  const variants = {
    light,
    "light, more contrast": { ...light, ...tokens(":root.contrast-more") },
    "light, blue & orange": { ...light, ...tokens(":root.diff-blue-orange") },
    dark,
    "dark, more contrast": { ...dark, ...tokens(":root.dark.contrast-more") },
    "dark, blue & orange": { ...dark, ...tokens(":root.dark.diff-blue-orange") },
  };
  const texts = ["foreground", "muted-foreground", "faint-foreground", "accent", "danger", "added"];
  for (const [variant, t] of Object.entries(variants)) {
    for (const text of texts)
      for (const fill of ["background", "sidebar"])
        expect
          .soft(contrast(t[`--${text}`]!, t[`--${fill}`]!), `${variant} --${text} on --${fill}`)
          .toBeGreaterThanOrEqual(4.5);
    for (const project of Object.keys(t).filter((k) => k.startsWith("--project-")))
      expect
        .soft(contrast(t[project]!, t["--sidebar"]!), `${variant} ${project} on --sidebar`)
        .toBeGreaterThanOrEqual(3);
  }
});
