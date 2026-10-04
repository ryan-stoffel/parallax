// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vite-plus/test";

import type { ParallaxBridge } from "../preload/bridge";
import { SidePanel } from "./SidePanel";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const now = Date.parse("2026-09-29T12:00:00Z");
beforeEach(() => {
  vi.useFakeTimers({ now, toFake: ["Date"] });
  window.parallax = { platform: "darwin" } as Partial<ParallaxBridge> as ParallaxBridge;
});

let unmount = () => {};
afterEach(() => {
  act(() => unmount());
  vi.useRealTimers();
});

async function render() {
  const root = createRoot(document.body.appendChild(document.createElement("div")));
  act(() =>
    root.render(<SidePanel open onClose={() => {}} expanded={false} onExpandedChange={() => {}} />),
  );
  unmount = () => {
    root.unmount();
    document.body.innerHTML = "";
  };
  await settle();
}
const settle = async () => {
  for (let i = 0; i < 10; i++) await act(async () => {});
};
const click = async (element: Element | null | undefined) => {
  await act(async () => (element as HTMLElement).click());
  await settle();
};
const panel = () => document.getElementById("side-panel")!;
const listButton = (name: string) =>
  [...panel().querySelectorAll("nav button")].find((b) => b.textContent?.startsWith(name));
// Each open view's tab, the shown one marked *.
const tabs = () =>
  [...panel().querySelectorAll('[aria-label="Open views"] button[id]')].map(
    (t) => `${t.textContent}${t.getAttribute("aria-current") === "true" ? "*" : ""}`,
  );
const tab = (key: string) => panel().querySelector<HTMLElement>(`#side-panel-tab-${key}`);
const openAView = () => panel().querySelector<HTMLElement>('button[aria-label="Open a view"]');
const shown = () => panel().querySelector<HTMLElement>(":scope > div:not(.titlebar):not([hidden])");
const press = (key: string) =>
  act(() => {
    document.activeElement!.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
  });
const listShown = () => panel().querySelector("nav") !== null;

test("views open as tabs: + shows the list, a view's letter opens it, and picking an open one focuses its tab", async () => {
  await render();
  expect(tabs()).toEqual([]);
  expect(listShown()).toBe(true);

  await click(listButton("Changes"));
  expect(tabs()).toEqual(["Changes*"]);
  expect(listShown()).toBe(false);
  expect(shown()!.textContent).toContain("No changes yet");

  await click(openAView());
  expect(listShown()).toBe(true);
  openAView()!.focus();
  press("a");
  expect(tabs()).toEqual(["Changes", "Agents*"]);
  expect(shown()!.textContent).toContain("No agents running");

  await click(openAView());
  await click(listButton("Changes"));
  expect(tabs()).toEqual(["Changes*", "Agents"]);
});

test("closing the shown tab shows its neighbour, and closing the last shows the list", async () => {
  await render();
  for (const name of ["Changes", "Knowledge", "Agents"]) {
    await click(listButton(name));
    await click(openAView());
  }
  await click(tab("D"));
  expect(tabs()).toEqual(["Changes*", "Knowledge", "Agents"]);

  await click(panel().querySelector('button[aria-label="Close Changes"]'));
  expect(tabs()).toEqual(["Knowledge*", "Agents"]);
  await click(panel().querySelector('button[aria-label="Close Agents"]'));
  expect(tabs()).toEqual(["Knowledge*"]);
  // Off a Project and a repository, Knowledge says there is nothing to show.
  expect(shown()!.textContent).toContain("Nothing known here yet");

  await click(panel().querySelector('button[aria-label="Close Knowledge"]'));
  expect(tabs()).toEqual([]);
  expect(listShown()).toBe(true);
});

test("closing a tab keeps focus in the panel, so the list's letters work after closing the last", async () => {
  await render();
  await click(listButton("Changes"));
  await click(openAView());
  await click(listButton("Agents"));
  await click(panel().querySelector('button[aria-label="Close Agents"]'));
  expect(document.activeElement).toBe(tab("D"));

  await click(panel().querySelector('button[aria-label="Close Changes"]'));
  expect(document.activeElement).toBe(openAView());
  expect(listShown()).toBe(true);
  press("k");
  expect(tabs()).toEqual(["Knowledge*"]);
});
