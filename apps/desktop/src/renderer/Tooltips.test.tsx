// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, test, vi } from "vite-plus/test";

import { Tooltips } from "./ui";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

// One styled tooltip for a title or an icon-only button's label, in place of the OS's.
test("hovering shows the label and holds the title aside until the pointer leaves", async () => {
  vi.useFakeTimers();
  document.body.innerHTML = `<button title="Settings" data-keys="⌘,"><svg></svg></button><button aria-label="Close">Close</button><div id="root"></div>`;
  const root = createRoot(document.getElementById("root")!);
  await act(async () => root.render(<Tooltips />));
  const [settings, close] = document.querySelectorAll("button");
  const tip = () => document.querySelector('[role="tooltip"]')?.textContent;

  await act(async () => {
    settings!.dispatchEvent(new PointerEvent("pointerover", { bubbles: true }));
    vi.advanceTimersByTime(400);
  });
  expect(tip()).toBe("Settings⌘,");
  expect(settings!.hasAttribute("title")).toBe(false);

  // A button with its own text needs none.
  await act(async () => {
    close!.dispatchEvent(new PointerEvent("pointerover", { bubbles: true }));
    vi.advanceTimersByTime(400);
  });
  expect(tip()).toBeUndefined();
  expect(settings!.getAttribute("title")).toBe("Settings");
  vi.useRealTimers();
});
