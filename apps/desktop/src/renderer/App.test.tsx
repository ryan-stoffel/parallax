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
  hosts: async () => [],
  onHosts: () => () => {},
};
window.wisp = bridge as WispBridge;

let unmount = () => {};
afterEach(() => {
  act(() => unmount());
  delete bridge.updatable;
  delete bridge.update;
});

function renderApp() {
  const root = createRoot(document.body.appendChild(document.createElement("div")));
  act(() => root.render(<App />));
  unmount = () => root.unmount();
}

test("the side panel toggle reports and flips the panel's state", () => {
  renderApp();
  // One toggle shows at a time: the main pane's while closed, the panel's while open.
  const toggle = () =>
    [...document.querySelectorAll<HTMLButtonElement>('[aria-controls="side-panel"]')].find(
      (b) => !b.closest("[hidden]"),
    )!;
  const panel = document.getElementById("side-panel")!;
  expect(toggle().getAttribute("aria-expanded")).toBe("false");
  expect(panel.hidden).toBe(true);

  act(() => toggle().click());
  expect(toggle().getAttribute("aria-expanded")).toBe("true");
  expect(panel.hidden).toBe(false);

  // Mod+Alt+B closes it again.
  act(() => {
    window.dispatchEvent(
      new KeyboardEvent("keydown", { code: "KeyB", metaKey: true, altKey: true }),
    );
  });
  expect(toggle().getAttribute("aria-expanded")).toBe("false");
  expect(panel.hidden).toBe(true);
});

test("the footer's Usage opens the Usage page, and Update shows its answer", async () => {
  const button = (name: string) =>
    document.querySelector<HTMLButtonElement>(`#sidebar button[aria-label="${name}"]`);
  renderApp();
  // Update is only for `pnpm dev`.
  expect(button("Update from develop")).toBeNull();

  act(() => button("Usage")!.click());
  const crumbs = [...document.querySelectorAll('[aria-label="Breadcrumb"] li')];
  expect(crumbs.map((li) => li.textContent)).toEqual(["Usage", "All hosts"]);
  // The sidebar stays on the thread list, and the side panel is a chat's.
  expect(button("Usage")).not.toBeNull();
  expect(document.querySelector('main [aria-controls="side-panel"]')).toBeNull();
  // The range stays in the top bar on Limits, but can't be changed there.
  const range = document.querySelector<HTMLFieldSetElement>('main [aria-label="Usage range"]')!;
  expect(range.disabled).toBe(false);
  act(() => document.querySelector<HTMLInputElement>('main input[value="limits"]')!.click());
  expect(range.disabled).toBe(true);
  act(() => unmount());

  let answer: (text: string) => void = () => {};
  Object.assign(bridge, {
    updatable: true,
    update: () => new Promise<string>((resolve) => (answer = resolve)),
  });
  renderApp();
  act(() => button("Update from develop")!.click());
  // The connection's status line shares the footer.
  const status = () =>
    [...document.querySelectorAll('#sidebar [role="status"]')].map((s) => s.textContent);
  expect(status()).toContain("Updating…");
  expect(button("Update from develop")!.disabled).toBe(true);
  await act(async () => answer("Up to date"));
  expect(status()).toContain("Up to date");
  expect(button("Update from develop")!.disabled).toBe(false);
});
