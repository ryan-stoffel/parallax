// @vitest-environment happy-dom
import { readFileSync } from "node:fs";

import { afterEach, expect, test } from "vite-plus/test";

import { animate, duration, easing } from "./motion";

const css = readFileSync("src/renderer/index.css", "utf8");
const token = (name: string) => new RegExp(`--${name}: ([^;]+);`).exec(css)?.[1];

afterEach(() => document.documentElement.classList.remove("reduce-motion"));

test("JS motion tokens match index.css's", () => {
  for (const [name, ms] of Object.entries(duration))
    expect(token(`transition-duration-${name}`)).toBe(`${ms}ms`);
  expect(token("ease-out")).toBe(easing.out);
  expect(token("ease-in")).toBe(easing.in);
  expect(token("ease-in-out")).toBe(easing.inOut);
  expect(token("ease-spring")).toBe(easing.spring);
});

test("animate plays nothing under reduced motion", () => {
  const el = document.body.appendChild(document.createElement("div"));
  expect(animate(el, [{ opacity: 0 }, { opacity: 1 }])).toBeDefined();
  document.documentElement.classList.add("reduce-motion");
  expect(animate(el, [{ opacity: 0 }, { opacity: 1 }])).toBeUndefined();
});
