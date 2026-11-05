// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vite-plus/test";

import type { ParallaxBridge } from "../preload/bridge";
import { SplitTiles, type TileItem } from "./SplitTiles";

Object.assign(globalThis, {
  IS_REACT_ACT_ENVIRONMENT: true,
  ResizeObserver: class {
    observe() {}
    disconnect() {}
  },
});

const item = (paneId: string, cells: TileItem["cells"]): TileItem => ({
  key: paneId,
  paneId,
  cells,
  tabs: [],
  active: "",
  node: <div data-pane={paneId} />,
});
const items = [item("a", 5), item("b", 10)];

let root: Root;
const body = () => document.body;
const render = (focused: number) =>
  act(() =>
    root.render(
      <SplitTiles
        items={items}
        focused={focused}
        cuts={{ x: 0.5, y: 0.5 }}
        onResize={() => {}}
        maximized={false}
        closable
        hideTabs={false}
        onSelectTab={() => {}}
        onCloseTab={() => {}}
        onNewTab={() => {}}
        onDropOnTabs={() => {}}
        details={<aside>{focused === 0 ? "first" : "second"}</aside>}
      />,
    ),
  );
const panel = () => {
  const aside = body().querySelector("aside")!;
  const card = aside.parentElement!.querySelector("[data-pane]")!.getAttribute("data-pane");
  return [card, aside.textContent];
};
const press = (button: number) =>
  act(() => void window.dispatchEvent(new PointerEvent("pointerdown", { button })));

beforeEach(() => {
  vi.useFakeTimers();
  window.parallax = { platform: "darwin" } as Partial<ParallaxBridge> as ParallaxBridge;
  root = createRoot(body().appendChild(document.createElement("div")));
});
afterEach(() => {
  act(() => root.unmount());
  body().innerHTML = "";
  vi.useRealTimers();
});

test.each(["pointerup", "pointercancel", "contextmenu", "blur"])(
  "details stays as it is while a press moves focus, and follows after %s",
  (end) => {
    render(0);
    expect(panel()).toEqual(["a", "first"]);
    press(0);
    render(1);
    expect(panel()).toEqual(["a", "first"]);
    act(() => void window.dispatchEvent(new Event(end)));
    // Not yet: the click that follows a release lands first.
    expect(panel()).toEqual(["a", "first"]);
    act(() => void vi.runAllTimers());
    expect(panel()).toEqual(["b", "second"]);
  },
);

test("a press with another button holds nothing, as its release may never come", () => {
  render(0);
  press(2);
  render(1);
  expect(panel()).toEqual(["b", "second"]);
});
