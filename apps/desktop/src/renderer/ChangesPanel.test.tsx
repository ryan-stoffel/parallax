// @vitest-environment happy-dom
import { act, type ComponentProps } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vite-plus/test";

import type { ParallaxBridge } from "../preload/bridge";
import type { ThreadRun } from "../protocol/generated/protocol";
import { ChangesPanel } from "./ChangesPanel";

// Give the real virtualizer a viewport and row heights in happy-dom, which has no layout.
vi.mock("@tanstack/react-virtual", async (original) => {
  const actual = await original<typeof import("@tanstack/react-virtual")>();
  return {
    ...actual,
    useVirtualizer: (options: Parameters<typeof actual.useVirtualizer>[0]) =>
      actual.useVirtualizer({
        ...options,
        observeElementRect: (_instance, callback) => {
          callback({ width: 400, height: 400 });
          return () => {};
        },
        measureElement: () => 20,
      }),
  };
});

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
let listedRuns = runs;
let largePatch: string | undefined;
const request = vi.fn(async (_host: string, method: string, params: Record<string, unknown>) => {
  if (method === "orchestration/threadRuns") return { logId: "l", result: { runs: listedRuns } };
  if (method === "orchestration/getFullThreadDiff")
    return { logId: "l", result: { diff: largePatch ?? patch("a.txt") + patch("b.txt") } };
  if (method === "orchestration/getTurnDiff")
    return { logId: "l", result: { diff: patch(params["to"] === 2 ? "b.txt" : "a.txt") } };
  return { logId: "l", result: { seq: 9 } };
});
const compose = vi.fn();

beforeEach(async () => {
  listedRuns = runs;
  largePatch = undefined;
  request.mockClear();
  compose.mockClear();
  window.parallax = { platform: "darwin", request } as Partial<ParallaxBridge> as ParallaxBridge;
  const root = createRoot(document.body.appendChild(document.createElement("div")));
  renderPanel = (props = {}) =>
    act(() =>
      root.render(
        <ChangesPanel
          hostId="h"
          runId="r"
          prompt="Add a"
          backend="codex"
          running={false}
          onCompose={compose}
          {...props}
        />,
      ),
    );
  renderPanel();
  unmount = () => {
    root.unmount();
    document.body.innerHTML = "";
  };
  await settle();
});

let renderPanel: (props?: Partial<ComponentProps<typeof ChangesPanel>>) => void;
let unmount = () => {};
afterEach(() => act(() => unmount()));
const settle = async () => {
  for (let i = 0; i < 10; i++) await act(async () => {});
};
const paths = () => [...document.querySelectorAll("span[title]")].map((s) => s.textContent);
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

const selectTurn = async (ordinal: number) => {
  await act(async () => {
    const select = document.querySelector("select")!;
    select.value = String(ordinal);
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await settle();
};

test.each([
  [{ running: true }, "Interrupt the current turn before reverting checkpoints."],
  [
    { backend: "claude" },
    "This provider does not support reverting conversation history. Start a new thread instead.",
  ],
  [
    { backend: "cursor" },
    "This provider does not support reverting conversation history. Start a new thread instead.",
  ],
] as const)("unavailable rollback is disabled and explained: %s", async (props, reason) => {
  renderPanel(props);
  await selectTurn(2);
  const edit = button("Edit from here");
  expect(edit.disabled).toBe(true);
  expect(edit.title).toBe(reason);
  await act(async () => edit.click());
  expect(document.querySelector("dialog")!.open).toBe(false);
  expect(request.mock.calls.some(([, method]) => method === "orchestration/dispatch")).toBe(false);
});

test("ordinal labels survive checkpoint gaps, and rollback never targets an unready checkpoint", async () => {
  listedRuns = [
    runs[0]!,
    { ...runs[1]!, checkpoint: { status: "error" } },
    { ...runs[1]!, id: "t4", ordinal: 4 },
  ];
  renderPanel({ version: 1 });
  await settle();
  expect([...document.querySelector("select")!.options].map((o) => o.text)).toEqual([
    "All turns",
    "Turn 1: Add a",
    "Turn 4: Now b",
  ]);
  await selectTurn(4);
  expect(button("Edit from here").disabled).toBe(true);
  expect(button("Edit from here").title).toBe(
    "The previous turn has no ready checkpoint to revert to.",
  );
});

test("large diffs mount only the visible rows and can still fold", async () => {
  largePatch = patch("large.txt").replace("+hi\n", "+line\n".repeat(160000));
  renderPanel({ runId: "large" });
  await settle();
  expect(document.body.textContent).toContain("+160000");
  expect(document.querySelectorAll("[data-index]").length).toBeLessThan(50);
  // The icon-only header button is named through aria-label.
  await act(async () =>
    document.querySelector<HTMLButtonElement>('[aria-label="Hide large.txt"]')?.click(),
  );
  expect(document.querySelector('[aria-label="Show large.txt"]')).not.toBeNull();
  expect(document.querySelectorAll("[data-index]").length).toBe(1);
});
