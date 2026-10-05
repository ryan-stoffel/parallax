// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vite-plus/test";

import type { ParallaxBridge, RpcError } from "../preload/bridge";
import type { AgentRun } from "../protocol/generated/protocol";
import { forkError, ForkMenu } from "./Fork";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const hide = vi.fn();
HTMLElement.prototype.hidePopover = hide;
let root: Root | undefined;
beforeEach(() => {
  // No connection, so the menu lists the built-in catalog.
  window.parallax = {
    connectionState: async () => ({ status: "connecting" as const }),
    onConnectionState: () => () => {},
  } as Partial<ParallaxBridge> as ParallaxBridge;
});
afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  document.body.innerHTML = "";
  vi.clearAllMocks();
});

const run = (over: Partial<AgentRun> = {}): AgentRun =>
  ({
    id: "run",
    status: "completed",
    backend: "claude",
    model: "claude-sonnet-5",
    ...over,
  }) as AgentRun;
function render(r: AgentRun, onFork: (choice: object) => Promise<RpcError | undefined>) {
  root ??= createRoot(document.body.appendChild(document.createElement("div")));
  act(() => root!.render(<ForkMenu id="fork" hostId="local" run={r} onFork={onFork} />));
}
const menuItems = () => [...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')];
const nameOf = (b: HTMLElement) => b.getAttribute("aria-label") ?? b.textContent;
const items = () => menuItems().map(nameOf);
const item = (name: string) => menuItems().find((b) => nameOf(b) === name)!;

test("the menu offers the thread's model first, then the host's others", () => {
  render(run(), async () => undefined);
  expect(items()[0]).toBe("Keep Claude Sonnet 5");
  expect(items()).toContain("Claude Opus 5.5 (Claude)");
  expect(items()).toContain("Claude Sonnet 5 (Cursor)");
  expect(items()).not.toContain("Claude Sonnet 5 (Claude)");
  expect(items().some((name) => name?.endsWith("(Codex)"))).toBe(true);
});

test("a run with no model keeps its CLI's default", () => {
  render(run({ model: undefined }), async () => undefined);
  expect(items()[0]).toBe("Keep the current model");
});

test("Keep sends nothing to change, another model its id, and another provider's its account", async () => {
  const onFork = vi.fn(async () => undefined);
  render(run(), onFork);
  await act(async () => item("Keep Claude Sonnet 5").click());
  expect(onFork).toHaveBeenLastCalledWith({});
  expect(hide).toHaveBeenCalledTimes(1);
  await act(async () => item("Claude Opus 5.5 (Claude)").click());
  expect(onFork).toHaveBeenLastCalledWith({ model: "claude-opus-5-5" });
  await act(async () => item("Claude Sonnet 5 (Cursor)").click());
  expect(onFork).toHaveBeenLastCalledWith({
    model: "claude-sonnet-5-high",
    account: { kind: "subscription", backend: "cursor" },
  });
});

test("plxd's refusal stays in the menu, in words, and the items wait on the request", async () => {
  let answer: (error: RpcError | undefined) => void = () => {};
  render(run({ status: "running" }), () => new Promise((resolve) => (answer = resolve)));
  act(() => item("Keep Claude Sonnet 5").click());
  expect(item("Keep Claude Sonnet 5").disabled).toBe(true);
  await act(async () => answer({ code: -32602, message: "thread run is still running turn t" }));
  expect(item("Keep Claude Sonnet 5").disabled).toBe(false);
  expect(document.querySelector('[role="alert"]')?.textContent).toBe(
    "This turn is still running. Fork it once it finishes.",
  );
  expect(hide).not.toHaveBeenCalled();
});

test("each refusal plxd gives a fork reads plainly", () => {
  const invalid = { code: -32602, message: "thread run has no turn t of its own" };
  expect(forkError(invalid, false)).toBe(
    "This turn was copied from another thread. Fork it from that thread.",
  );
  expect(forkError({ code: -32000, message: "", data: { kind: "idConflict" } }, false)).toBe(
    "That fork's id was already taken. Try again.",
  );
  expect(forkError({ code: -32000, message: "", data: { kind: "threadNotFound" } }, false)).toBe(
    "This thread isn't on this host anymore.",
  );
  expect(forkError({ code: -32000, message: "worktree failed" }, false)).toBe("worktree failed");
});
