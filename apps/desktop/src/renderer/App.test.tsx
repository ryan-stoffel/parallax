// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, test, vi } from "vite-plus/test";

import type { UpdateState, ParallaxBridge } from "../preload/bridge";
import { App } from "./App";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
// Only what the frame calls, so new bridge methods don't break this stub.
const bridge: Partial<ParallaxBridge> = {
  platform: "darwin",
  setThemeSource: vi.fn(),
  connectionState: async () => ({ status: "connecting" }),
  onConnectionState: () => () => {},
  hosts: async () => [],
  onHosts: () => () => {},
};
window.parallax = bridge as ParallaxBridge;

let unmount = () => {};
afterEach(() => {
  act(() => unmount());
  delete bridge.updatable;
  delete bridge.update;
  delete bridge.onUpdateState;
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

test("the footer's Usage opens the Usage page, and Update shows when it's ready and its answer", async () => {
  const button = (name: string) =>
    document.querySelector<HTMLButtonElement>(`#sidebar button[aria-label="${name}"]`);
  renderApp();
  // Update is only for `pnpm dev`.
  expect(button("Update Parallax")).toBeNull();

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
  let publish: (state: UpdateState) => void = () => {};
  Object.assign(bridge, {
    updatable: true,
    update: () => new Promise<string>((resolve) => (answer = resolve)),
    onUpdateState: (listener: (state: UpdateState) => void) => {
      publish = listener;
      return () => {};
    },
  });
  renderApp();
  // A background check's note, such as a download or an error, is the button's label.
  act(() => publish({ note: "Can't reach GitHub to check for updates." }));
  expect(button("Can't reach GitHub to check for updates.")).not.toBeNull();
  act(() => publish({ ready: "3 commits to apply" }));
  act(() => button("Update ready: 3 commits to apply")!.click());
  // The connection's status line shares the footer.
  const status = () =>
    [...document.querySelectorAll('#sidebar [role="status"]')].map((s) => s.textContent);
  expect(status()).toContain("Updating…");
  expect(button("Update Parallax")!.disabled).toBe(true);
  await act(async () => answer("Updated to abc1234"));
  act(() => publish({}));
  expect(status()).toContain("Updated to abc1234");
  expect(button("Update Parallax")!.disabled).toBe(false);
});
