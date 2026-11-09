// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, test, vi } from "vite-plus/test";

import type { ParallaxBridge } from "../preload/bridge";
import { CrashBoundary } from "./Crash";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

let root: ReturnType<typeof createRoot> | undefined;
afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

function Broken(): never {
  throw new Error("no such column: unarchived_at");
}

test("a render that throws shows the crash screen with Reload and the error under Show details", () => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  window.parallax = {
    version: async () => "2611.1.0",
  } as Partial<ParallaxBridge> as ParallaxBridge;
  root = createRoot(document.body.appendChild(document.createElement("div")));
  act(() =>
    root!.render(
      <CrashBoundary>
        <Broken />
      </CrashBoundary>,
    ),
  );
  expect(document.querySelector("dialog")?.open).toBe(true);
  expect(document.querySelector("h1")?.textContent).toBe("Parallax hit a problem");
  expect([...document.querySelectorAll("button")].some((b) => b.textContent === "Reload")).toBe(
    true,
  );
  const show = [...document.querySelectorAll("button")].find(
    (b) => b.textContent === "Show details",
  );
  act(() => show!.click());
  expect(document.querySelector("pre")?.textContent).toContain("no such column: unarchived_at");
});
