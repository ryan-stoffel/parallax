// @vitest-environment happy-dom
import { act, type ComponentProps } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vite-plus/test";

import type { ParallaxBridge } from "../preload/bridge";
import type { ThreadRun } from "../protocol/generated/protocol";
import { ChangesPanel } from "./ChangesPanel";

// happy-dom has no popovers. The Turn menu's items are in the DOM either way.
HTMLElement.prototype.hidePopover = () => {};

vi.mock("./providers", () => ({
  useProviders: () => ({
    providers: [
      { instance: { id: "codex-work", kind: "codex" } },
      { instance: { id: "claude-work", kind: "claude" } },
      { instance: { id: "codex", kind: "claude" } },
    ],
  }),
}));

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
/** `runs`, with where Claude's turn 1 ended, in session `s1`. */
const cursored = runs.map((r) => (r.id === "t1" ? { ...r, cursor: "c1", sessionId: "s1" } : r));
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
  window.parallax = {
    platform: "darwin",
    request,
    watch: () => () => {},
  } as Partial<ParallaxBridge> as ParallaxBridge;
  const root = createRoot(document.body.appendChild(document.createElement("div")));
  renderPanel = (props = {}) =>
    act(() =>
      root.render(
        <ChangesPanel
          hostId="h"
          runId="r"
          prompt="Add a"
          backend="fake"
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
const button = (name: string) =>
  [...document.querySelectorAll("button")].find((b) => b.textContent === name)!;
// The Turn menu's options (ui.tsx's Picker).
const turnItems = () => [
  ...document.querySelectorAll<HTMLElement>(
    '[role="menu"][aria-label="Turn"] [role="menuitemradio"]',
  ),
];
const selectTurn = async (ordinal: number) => {
  await act(async () =>
    turnItems()
      .find((o) => o.textContent?.startsWith(`Turn ${ordinal}:`))!
      .click(),
  );
  await settle();
};

test("Edit from here reverts to the turn before, keeping files, and returns its message", async () => {
  listedRuns = cursored;
  renderPanel({ backend: "claude-work", sessionId: "s1", version: 1 });
  await selectTurn(2);
  await act(async () => button("Edit from here").click());
  await act(async () => button("Revert and keep changes").click());
  await settle();
  expect(request).toHaveBeenCalledWith("h", "orchestration/dispatch", {
    type: "checkpoint.rollback",
    threadId: "r",
    ordinal: 1,
  });
  expect(compose).toHaveBeenCalledWith("Now b");
});

test("a running turn can't be rolled back", async () => {
  renderPanel({ running: true });
  await selectTurn(2);
  const edit = button("Edit from here");
  expect(edit.disabled).toBe(true);
  await act(async () => edit.click());
  expect(request.mock.calls.some(([, method]) => method === "orchestration/dispatch")).toBe(false);
});

test.each([
  ["no cursor", runs],
  [
    "a cursor from another session",
    cursored.map((r) => (r.id === "t1" ? { ...r, sessionId: "s0" } : r)),
  ],
] as const)(
  "Claude's Edit from here needs a cursor in the thread's session: %s",
  async (_, listed) => {
    listedRuns = [...listed];
    renderPanel({ backend: "claude-work", sessionId: "s1", version: 1 });
    await selectTurn(2);
    expect(button("Edit from here").disabled).toBe(true);
  },
);

test("rollback never targets an unready checkpoint", async () => {
  listedRuns = [
    runs[0]!,
    { ...runs[1]!, checkpoint: { status: "error" } },
    { ...runs[1]!, id: "t4", ordinal: 4 },
  ];
  renderPanel({ version: 1 });
  await settle();
  await selectTurn(4);
  expect(button("Edit from here").disabled).toBe(true);
});
