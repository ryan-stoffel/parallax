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

const tab = (label: string) => ({
  key: label,
  node: <section>{label}</section>,
  compact: <section>{label} short</section>,
});
const render = (labels: string[]) =>
  act(() => root!.render(<ComposerTabs tabs={labels.map(tab)} />));
const shown = () =>
  [...document.querySelectorAll('[aria-label="Composer tabs"] section')].map((s) => s.textContent);

test("the first tab shows in full and the rest beside it in short, on one line", () => {
  root = createRoot(document.body.appendChild(document.createElement("div")));
  render(["Subagents", "Plan", "Queued"]);
  expect(shown()).toEqual(["Subagents", "Plan short", "Queued short"]);

  // One shows in full, and none renders nothing.
  render(["Plan"]);
  expect(shown()).toEqual(["Plan"]);
  render([]);
  expect(document.querySelector('[aria-label="Composer tabs"]')).toBeNull();
});
