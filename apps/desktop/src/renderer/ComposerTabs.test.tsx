// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, test } from "vite-plus/test";

import { ComposerTabs } from "./ComposerTabs";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let root: Root | undefined;
afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  document.body.innerHTML = "";
});

const tab = (label: string) => ({ key: label, label, node: <section>{label}</section> });
const render = (labels: string[]) =>
  act(() => root!.render(<ComposerTabs tabs={labels.map(tab)} />));
const shown = () =>
  [...document.querySelectorAll('[aria-label="Composer tabs"] > div:not([hidden]) section')].map(
    (s) => s.textContent,
  );
const more = () => document.querySelector<HTMLButtonElement>('[aria-label="More tabs"] button');

test("the front two tabs show, the rest fold behind one that names them, and it opens them all", () => {
  root = createRoot(document.body.appendChild(document.createElement("div")));
  render(["Parent thread", "Subagents", "Plan", "Queued"]);
  expect(shown()).toEqual(["2 moreParent thread, Subagents", "Plan", "Queued"]);
  // Each tab further back sits 10px further in.
  const insets = [...document.querySelectorAll<HTMLElement>('[aria-label="Composer tabs"] > div')]
    .filter((d) => !d.hidden)
    .map((d) => d.style.marginInline);
  expect(insets).toEqual(["40px", "30px", "20px"]);

  act(() => more()!.click());
  expect(shown()).toEqual(["Show fewer", "Parent thread", "Subagents", "Plan", "Queued"]);
  act(() => more()!.click());
  expect(shown()).toEqual(["2 moreParent thread, Subagents", "Plan", "Queued"]);

  // Two or fewer show as they are, and none renders nothing.
  render(["Plan", "Queued"]);
  expect(more()).toBeNull();
  expect(shown()).toEqual(["Plan", "Queued"]);
  render([]);
  expect(document.querySelector('[aria-label="Composer tabs"]')).toBeNull();
});
