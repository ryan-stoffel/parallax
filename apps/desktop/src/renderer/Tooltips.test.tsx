// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, test, vi } from "vite-plus/test";

import { Tooltips } from "./ui";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let root: Root | undefined;
afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  document.body.innerHTML = "";
  vi.useRealTimers();
});

/** The tooltip's text after hovering an icon-only button with `attrs`, or null when none shows. */
function tipOver(attrs: Record<string, string>) {
  vi.useFakeTimers();
  root = createRoot(document.body.appendChild(document.createElement("div")));
  act(() => root!.render(<Tooltips />));
  const button = document.body.appendChild(document.createElement("button"));
  for (const [name, value] of Object.entries(attrs)) button.setAttribute(name, value);
  act(() => {
    button.dispatchEvent(new PointerEvent("pointerover", { bubbles: true }));
    vi.advanceTimersByTime(400);
  });
  return document.querySelector('[role="tooltip"]')?.textContent ?? null;
}

test("an icon-only button shows its label", () => {
  expect(tipOver({ "aria-label": "Close" })).toBe("Close");
});

test('a button with data-tooltip="off" shows none', () => {
  expect(tipOver({ "aria-label": "Go to prompt 1", "data-tooltip": "off" })).toBeNull();
});
