// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vite-plus/test";

import type { ParallaxBridge, RpcError } from "../preload/bridge";
import type { AgentRun } from "../protocol/generated/protocol";
import { ForkMenu } from "./Fork";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
// happy-dom has no popovers.
HTMLElement.prototype.showPopover = () => {};
HTMLElement.prototype.hidePopover = () => {};
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
  // happy-dom has no popovers: the menu gets the event a browser sends as it opens.
  act(() => {
    document
      .getElementById("fork")!
      .dispatchEvent(Object.assign(new Event("beforetoggle"), { newState: "open" }));
  });
}
const menuItems = () => [...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')];
const nameOf = (b: HTMLElement) => b.getAttribute("aria-label") ?? b.textContent;
const item = (name: string) => menuItems().find((b) => nameOf(b) === name)!;

test("Keep sends nothing to change, another model its id, and another provider's its account", async () => {
  const onFork = vi.fn(async () => undefined);
  render(run(), onFork);
  await act(async () => item("Keep Claude Sonnet 5").click());
  expect(onFork).toHaveBeenLastCalledWith({});
  await act(async () => item("Claude Opus 5.5 (Claude)").click());
  expect(onFork).toHaveBeenLastCalledWith({ model: "claude-opus-5-5" });
  await act(async () => item("Claude Sonnet 5 (Cursor)").click());
  expect(onFork).toHaveBeenLastCalledWith({
    model: "claude-sonnet-5-high",
    account: { kind: "subscription", backend: "cursor" },
  });
});
