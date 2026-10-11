import { readFileSync } from "node:fs";

import { expect, test } from "vitest";

import { dark, light } from "./theme";

const css = readFileSync(new URL("../../desktop/src/renderer/index.css", import.meta.url), "utf8");
const block = (selector: string) => css.slice(css.indexOf(`${selector} {`)).split("}")[0]!;
// React Native reads `rgba(0, 0, 0, 0.09)`, not CSS's `rgb(0 0 0 / 9%)`.
const native = (css: string) =>
  css.replace(
    /^rgb\((\d+) (\d+) (\d+) \/ ([\d.]+)%\)$/,
    (_, r, g, b, p) => `rgba(${r}, ${g}, ${b}, ${Number(p) / 100})`,
  );
const token = (name: string) => `--${name.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}`;

test("the colors are the desktop's", () => {
  for (const [colors, selector] of [
    [light, ":root"],
    [dark, ":root.dark"],
  ] as const) {
    for (const [name, value] of Object.entries(colors)) {
      const css = new RegExp(`${token(name)}: ([^;]+);`).exec(block(selector))?.[1];
      const declared = css && native(css);
      // Dark repeats only what it changes.
      expect(declared ?? (light as Record<string, string>)[name], name).toBe(value);
    }
  }
});
