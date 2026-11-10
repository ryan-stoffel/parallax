// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, test } from "vite-plus/test";

import type { ParallaxBridge } from "../preload/bridge";
import { orchestratorLoss, parseSections, Sidebar, threadLoss } from "./Sidebar";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

let root: ReturnType<typeof createRoot> | undefined;
afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  document.body.innerHTML = "";
});

test("closing keeps the last visible width when the parent releases the sidebar's space", () => {
  window.parallax = { platform: "darwin" } as ParallaxBridge;
  root = createRoot(document.body.appendChild(document.createElement("div")));
  const render = (open: boolean, width: number) =>
    act(() =>
      root!.render(
        <Sidebar open={open} width={width} onClose={() => {}} onNewThread={() => {}}>
          Threads
        </Sidebar>,
      ),
    );
  const sidebar = () => document.querySelector<HTMLElement>("#sidebar")!;

  render(true, 288);
  render(false, 0);
  expect(sidebar().hidden).toBe(true);
  expect(sidebar().style.getPropertyValue("--sidebar-width")).toBe("288px");

  render(true, 288);
  render(true, 320);
  render(false, 0);
  expect(sidebar().hidden).toBe(true);
  expect(sidebar().style.getPropertyValue("--sidebar-width")).toBe("320px");
});

test("a delete's warning says the worktree and branch stay where the host keeps them", () => {
  expect(threadLoss(false)).toBe(", with its transcript, worktree, and branch.");
  expect(threadLoss(true)).toBe(", with its transcript. Its worktree and branch stay on disk.");
  expect(orchestratorLoss(0, true)).toBe(".");
  expect(orchestratorLoss(1, false)).toContain("transcript, worktree, and branch.");
  expect(orchestratorLoss(1, true)).toContain("Its worktree and branch stay on disk.");
  expect(orchestratorLoss(3, false)).toContain("transcripts, worktrees, and branches.");
  expect(orchestratorLoss(3, true)).toContain("Their worktrees and branches stay on disk.");
});

test("Working starts collapsed whatever was saved, and the other drawers stay as saved", () => {
  expect(
    parseSections({ all: { working: true, archived: true }, "repo:a": { working: true } }, {}),
  ).toEqual({ all: { working: false, archived: true }, "repo:a": { working: false } });
});
