// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, test, vi } from "vite-plus/test";

import type { WispBridge } from "../preload/bridge";
import { App } from "./App";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
// Only what the frame calls, so new bridge methods don't break this stub.
const bridge: Partial<WispBridge> = {
  platform: "darwin",
  setThemeSource: vi.fn(),
  connectionState: async () => ({ status: "connecting" }),
  onConnectionState: () => () => {},
};
window.wisp = bridge as WispBridge;

let unmount = () => {};
afterEach(() => act(() => unmount()));

function renderApp() {
  const root = createRoot(document.body.appendChild(document.createElement("div")));
  act(() => root.render(<App />));
  unmount = () => root.unmount();
}

test("the side panel toggle reports and flips the panel's state", () => {
  renderApp();
  const toggle = document.querySelector<HTMLButtonElement>('[aria-controls="side-panel"]')!;
  const panel = document.getElementById("side-panel")!;
  expect(toggle.getAttribute("aria-expanded")).toBe("false");
  expect(panel.hidden).toBe(true);

  act(() => toggle.click());
  expect(toggle.getAttribute("aria-expanded")).toBe("true");
  expect(panel.hidden).toBe(false);

  // Mod+Alt+B closes it again.
  act(() => {
    window.dispatchEvent(
      new KeyboardEvent("keydown", { code: "KeyB", metaKey: true, altKey: true }),
    );
  });
  expect(toggle.getAttribute("aria-expanded")).toBe("false");
  expect(panel.hidden).toBe(true);
});

test("a Project is one row that opens its chat, with no thread level", () => {
  renderApp();
  const project = [...document.querySelectorAll<HTMLButtonElement>("#sidebar li button")].find(
    (b) => b.textContent?.startsWith("ember"),
  )!;
  act(() => project.click());

  const crumbs = [...document.querySelectorAll('[aria-label="Breadcrumb"] li')];
  expect(crumbs.map((li) => li.textContent)).toEqual(["This Mac", "ember"]);
  expect(project.getAttribute("aria-current")).toBe("page");
});
