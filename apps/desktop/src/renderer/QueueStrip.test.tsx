// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, test, vi } from "vite-plus/test";

import type { ParallaxBridge } from "../preload/bridge";
import type { QueuedMessage } from "../protocol/generated/protocol";
import { QueueStrip } from "./QueueStrip";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let root: Root | undefined;
afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  document.body.innerHTML = "";
});
const messages: QueuedMessage[] = [
  { id: "a", text: "Add tests", images: 1, threads: ["thread"] },
  { id: "b", text: "Update README", images: 0, threads: [] },
  { id: "c", text: "Run checks", images: 0, threads: [] },
];
function render(list = messages, running = true) {
  root ??= createRoot(document.body.appendChild(document.createElement("div")));
  act(() =>
    root!.render(<QueueStrip hostId="local" runId="run" messages={list} running={running} />),
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
  expect(request).toHaveBeenCalledWith("local", "queue/edit", {
    runId: "run",
    id: "a",
    text: "Add focused tests",
  });
  // The RPC result does not replace the live server state.
  expect(document.body.textContent).toContain("Add tests");
  render([{ ...messages[0]!, text: "Changed in another window" }]);
  expect(document.body.textContent).toContain("Changed in another window");
  expect(document.querySelector('[aria-label="1 images attached"]')).not.toBeNull();
  expect(document.querySelector('[aria-label="1 threads attached"]')).not.toBeNull();
});

test("cancels, steers, and reorders by stable message IDs", async () => {
  const request = setup();
  await act(async () => button("Cancel queued message 2").click());
  expect(request).toHaveBeenLastCalledWith("local", "queue/cancel", { runId: "run", id: "b" });
  await act(async () => button("Steer queued message 1 now").click());
  expect(request).toHaveBeenLastCalledWith("local", "queue/steer", { runId: "run", id: "a" });
  await act(async () => button("Move queued message 3 up").click());
  expect(request).toHaveBeenLastCalledWith("local", "queue/reorder", {
    runId: "run",
    ids: ["a", "c", "b"],
  });
  const drop = new Event("drop", { bubbles: true, cancelable: true });
  Object.defineProperty(drop, "dataTransfer", { value: { getData: () => "c" } });
  await act(async () => document.querySelector("li")!.dispatchEvent(drop));
  expect(request).toHaveBeenLastCalledWith("local", "queue/reorder", {
    runId: "run",
    ids: ["c", "a", "b"],
  });
  render(messages, false);
  expect(button("Steer queued message 1 now").disabled).toBe(true);
});

test("shows rejected changes without losing the queued message", async () => {
  const request = setup();
  request.mockResolvedValueOnce({ error: { code: -32000, message: "Already delivered" } } as never);
  await act(async () => button("Cancel queued message 1").click());
  expect(document.querySelector('[role="alert"]')?.textContent).toBe("Already delivered");
  expect(document.body.textContent).toContain("Add tests");
});
