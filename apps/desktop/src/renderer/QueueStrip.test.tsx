// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, test, vi } from "vite-plus/test";

import type { ParallaxBridge } from "../preload/bridge";
import type { QueuedMessage } from "../protocol/generated/protocol";
import { Notifications } from "./notifications";
import { QueueStrip } from "./QueueStrip";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
// happy-dom has no popovers.
HTMLElement.prototype.showPopover = () => {};
let root: Root | undefined;
afterEach(() => {
  // Notifications outlive a render, so close this test's.
  for (const close of document.querySelectorAll<HTMLButtonElement>(
    '[aria-label="Notifications"] button[aria-label="Close"]',
  ))
    act(() => close.click());
  act(() => root?.unmount());
  root = undefined;
  document.body.innerHTML = "";
});
const messages: QueuedMessage[] = [
  { id: "a", text: "Add tests", images: 1, threads: ["thread"] },
  { id: "b", text: "Update README", images: 0, threads: [] },
  { id: "c", text: "Run checks", images: 0, threads: [] },
];
function render(list = messages, running = true, held = false) {
  root ??= createRoot(document.body.appendChild(document.createElement("div")));
  act(() =>
    root!.render(
      <>
        <QueueStrip hostId="local" runId="run" messages={list} held={held} running={running} />
        <Notifications />
      </>,
    ),
  );
}
function setup() {
  const request = vi.fn(async () => ({ result: { messages }, logId: "log" }));
  window.parallax = { request } as Partial<ParallaxBridge> as ParallaxBridge;
  render();
  return request;
}
const button = (label: string) =>
  document.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)!;

test("edits text without replacing images or attached threads, and follows authoritative queue changes", async () => {
  const request = setup();
  act(() => button("Edit queued message 1").click());
  const box = document.querySelector("textarea")!;
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(
      box,
      "Add focused tests",
    );
    box.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await act(async () =>
    document
      .querySelector("form")!
      .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })),
  );
  expect(request).toHaveBeenCalledWith("local", "orchestration/dispatch", {
    type: "queued-run.edit",
    threadId: "run",
    runId: "a",
    text: "Add focused tests",
  });
  // The RPC result does not replace the live server state.
  expect(document.body.textContent).toContain("Add tests");
  render([{ ...messages[0]!, text: "Changed in another window" }]);
  expect(document.body.textContent).toContain("Changed in another window");
  expect(document.querySelector('[aria-label="1 images attached"]')).not.toBeNull();
  expect(document.querySelector('[aria-label="1 threads attached"]')).not.toBeNull();
});
