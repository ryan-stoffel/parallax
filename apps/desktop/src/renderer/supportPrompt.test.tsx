// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, test } from "vite-plus/test";

import { Notifications } from "./notifications";
import { countSentPrompt, PROMPTS_BEFORE_ASK } from "./supportPrompt";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
// happy-dom has no popovers.
HTMLElement.prototype.showPopover = () => {};

const toasts = () => document.querySelectorAll('[aria-label="Notifications"] > div');

afterEach(() => {
  for (const close of document.querySelectorAll<HTMLButtonElement>('button[aria-label="Close"]'))
    act(() => close.click());
  localStorage.clear();
});

function renderStack() {
  const root = createRoot(document.body.appendChild(document.createElement("div")));
  act(() => root.render(<Notifications />));
}

test("the 5th prompt asks once, with links to the repo and Ko-fi, and never again", () => {
  renderStack();
  for (let i = 1; i < PROMPTS_BEFORE_ASK; i++) act(() => countSentPrompt());
  expect(toasts()).toHaveLength(0);

  act(() => countSentPrompt());
  expect(toasts()).toHaveLength(1);
  expect([...toasts()[0]!.querySelectorAll("a")].map((a) => a.href)).toEqual([
    "https://github.com/ryan-stoffel/parallax",
    "https://ko-fi.com/parallax_team",
  ]);

  act(() => document.querySelector<HTMLButtonElement>('button[aria-label="Close"]')!.click());
  for (let i = 0; i < PROMPTS_BEFORE_ASK * 2; i++) act(() => countSentPrompt());
  expect(toasts()).toHaveLength(0);
});
