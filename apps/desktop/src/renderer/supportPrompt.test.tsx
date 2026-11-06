// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, test } from "vite-plus/test";

import { Notifications } from "./notifications";
import { countSentPrompt, PROMPTS_BEFORE_ASK } from "./supportPrompt";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
// happy-dom has no popovers.
HTMLElement.prototype.showPopover = () => {};

const toasts = () => document.querySelectorAll('[aria-label="Notifications"] > div');

// Main's claim file: true once, whatever localStorage holds.
beforeEach(() => {
  let claimed = false;
  Object.assign(window, {
    parallax: {
      claimSupportAsk: async () => {
        const first = !claimed;
        claimed = true;
        return first;
      },
    },
  });
});

afterEach(() => {
  for (const close of document.querySelectorAll<HTMLButtonElement>('button[aria-label="Close"]'))
    act(() => close.click());
  localStorage.clear();
});

function renderStack() {
  const root = createRoot(document.body.appendChild(document.createElement("div")));
  act(() => root.render(<Notifications />));
}

const send = (times = 1) =>
  act(async () => {
    for (let i = 0; i < times; i++) await countSentPrompt();
  });

test("the 5th prompt asks once, with links to the repo and Ko-fi, and never again", async () => {
  renderStack();
  await send(PROMPTS_BEFORE_ASK - 1);
  expect(toasts()).toHaveLength(0);

  await send();
  expect(toasts()).toHaveLength(1);
  expect([...toasts()[0]!.querySelectorAll("a")].map((a) => a.href)).toEqual([
    "https://github.com/ryan-stoffel/parallax",
    "https://ko-fi.com/parallax_team",
  ]);

  act(() => document.querySelector<HTMLButtonElement>('button[aria-label="Close"]')!.click());
  await send(PROMPTS_BEFORE_ASK * 2);
  expect(toasts()).toHaveLength(0);
});

test("a count localStorage lost doesn't ask again (PLX-1243)", async () => {
  renderStack();
  await send(PROMPTS_BEFORE_ASK);
  act(() => document.querySelector<HTMLButtonElement>('button[aria-label="Close"]')!.click());

  localStorage.clear();
  await send(PROMPTS_BEFORE_ASK);
  expect(toasts()).toHaveLength(0);
});

test("someone asked before the claim existed isn't asked by a copy that lost the count", async () => {
  renderStack();
  localStorage.setItem("parallax.promptsBeforeSupportAsk", String(PROMPTS_BEFORE_ASK));
  await send();
  expect(toasts()).toHaveLength(0);

  localStorage.clear();
  await send(PROMPTS_BEFORE_ASK);
  expect(toasts()).toHaveLength(0);
});
