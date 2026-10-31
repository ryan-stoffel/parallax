// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, test } from "vite-plus/test";

import type { ParallaxBridge } from "../preload/bridge";
import { Sidebar } from "./Sidebar";

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
