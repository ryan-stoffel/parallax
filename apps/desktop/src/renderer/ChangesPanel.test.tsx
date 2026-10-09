// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vite-plus/test";

import type { ParallaxBridge } from "../preload/bridge";
import type { ThreadRun } from "../protocol/generated/protocol";
import { ChangesPanel } from "./ChangesPanel";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
HTMLDialogElement.prototype.showModal = function () {
  this.open = true;
};
HTMLDialogElement.prototype.close = function () {
  this.open = false;
};

const ready = { status: "ready" as const };
const runs: ThreadRun[] = [
  { id: "t1", status: "completed", ordinal: 1, images: 0, threads: [], checkpoint: ready },
  {
    id: "t2",
    status: "completed",
    ordinal: 2,
    text: "Now b",
    images: 0,
    threads: [],
    checkpoint: ready,
  },
  { id: "t3", status: "rolledBack", ordinal: 3, text: "Undone", images: 0, threads: [] },
];
const patch = (path: string) =>
  `diff --git a/${path} b/${path}\nnew file mode 100644\n--- /dev/null\n+++ b/${path}\n@@ -0,0 +1 @@\n+hi\n`;
const request = vi.fn(async (_host: string, method: string, params: Record<string, unknown>) => {
  if (method === "orchestration/threadRuns") return { logId: "l", result: { runs } };
  if (method === "orchestration/getFullThreadDiff")
    return { logId: "l", result: { diff: patch("a.txt") + patch("b.txt") } };
  if (method === "orchestration/getTurnDiff")
    return { logId: "l", result: { diff: patch(params["to"] === 2 ? "b.txt" : "a.txt") } };
  return { logId: "l", result: { seq: 9 } };
});
const compose = vi.fn();

beforeEach(async () => {
  request.mockClear();
  compose.mockClear();
  window.parallax = { platform: "darwin", request } as Partial<ParallaxBridge> as ParallaxBridge;
  const root = createRoot(document.body.appendChild(document.createElement("div")));
  act(() => root.render(<ChangesPanel hostId="h" runId="r" prompt="Add a" onCompose={compose} />));
  unmount = () => {
    root.unmount();
    document.body.innerHTML = "";
  };
  await settle();
});

let unmount = () => {};
afterEach(() => act(() => unmount()));
const settle = async () => {
  for (let i = 0; i < 10; i++) await act(async () => {});
};
const paths = () => [...document.querySelectorAll("li span[title]")].map((s) => s.textContent);
const button = (name: string) =>
  [...document.querySelectorAll("button")].find((b) => b.textContent === name)!;

test("every turn's diff shows first, then one turn's, with undone turns left out", async () => {
  expect(paths()).toEqual(["a.txt", "b.txt"]);
  const select = document.querySelector("select")!;
  expect([...select.options].map((o) => o.text)).toEqual([
    "All turns",
    "Turn 1: Add a",
    "Turn 2: Now b",
  ]);
  await act(async () => {
    select.value = "2";
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await settle();
  expect(request).toHaveBeenCalledWith("h", "orchestration/getTurnDiff", {
    threadId: "r",
    from: 1,
    to: 2,
  });
  expect(paths()).toEqual(["b.txt"]);
});

test("Edit from here reverts to the turn before, keeping files, and returns its message", async () => {
  const select = document.querySelector("select")!;
  await act(async () => {
    select.value = "2";
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await settle();
  await act(async () => button("Edit from here").click());
  expect(document.querySelector("dialog")!.open).toBe(true);
  await act(async () => button("Revert and keep changes").click());
  await settle();
  expect(request).toHaveBeenCalledWith("h", "orchestration/dispatch", {
    type: "checkpoint.rollback",
    threadId: "r",
    ordinal: 1,
  });
  expect(compose).toHaveBeenCalledWith("Now b");
  expect(document.querySelector("dialog")!.open).toBe(false);
});
