// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vite-plus/test";

import type { Host } from "./hosts";
import type { ParallaxBridge } from "../preload/bridge";
import {
  THREAD_DETAILS_KEY,
  ThreadDetails,
  ThreadDetailsButton,
  tooNarrowToDock,
  useThreadDetails,
} from "./ThreadDetails";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

// The row's width, and the observer that tells the hook it changed.
let width = 1200;
let resized = () => {};
class FakeResizeObserver {
  constructor(callback: () => void) {
    resized = callback;
  }
  observe() {}
  disconnect() {}
}
let unmount = () => {};
afterEach(() =>
  act(() => {
    unmount();
    document.body.innerHTML = "";
    vi.restoreAllMocks();
  }),
);
beforeEach(() => {
  localStorage.clear();
  width = 1200;
  Object.assign(globalThis, { ResizeObserver: FakeResizeObserver });
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (
    this: HTMLElement,
  ) {
    return { width: this.dataset["row"] !== undefined ? width : 0 } as DOMRect;
  });
  window.parallax = {
    platform: "darwin",
    openTargets: async () => ["cursor", "files"],
    terminalApps: async () => [],
    terminalApp: async () => null,
    openTargetIcons: async () => ({}),
  } as Partial<ParallaxBridge> as ParallaxBridge;
});

function Harness({ row = true }: { row?: boolean }) {
  const { mode, toggle, ref } = useThreadDetails();
  const details = (
    <ThreadDetails mode={mode} host={{ id: "local", name: "macbook" }} folder="/repo" />
  );
  return (
    <>
      <ThreadDetailsButton open={mode !== "hidden"} onToggle={toggle} />
      {row ? (
        <div ref={ref} data-row>
          {details}
        </div>
      ) : (
        <div>Pull requests</div>
      )}
    </>
  );
}
let rerender = async (_row: boolean) => {};
async function render() {
  const root = createRoot(document.body.appendChild(document.createElement("div")));
  unmount = () => root.unmount();
  rerender = (row) => act(async () => root.render(<Harness row={row} />));
  await rerender(true);
}
const panel = () => document.querySelector<HTMLElement>("aside[aria-label='Thread details']")!;
const button = () => document.querySelector<HTMLButtonElement>("button[aria-controls]")!;
const resize = (to: number) =>
  act(async () => {
    width = to;
    resized();
  });

test("the thread keeps at least 60% of its row beside a docked card", () => {
  expect(tooNarrowToDock(1200)).toBe(false);
  expect(tooNarrowToDock(670)).toBe(false);
  expect(tooNarrowToDock(660)).toBe(true);
  expect(tooNarrowToDock(0)).toBe(false);
});

test("with room, the button docks the panel until pressed again, and a restart keeps it", async () => {
  await render();
  // Mounted while hidden, so its shortcuts still work.
  expect(panel().hidden).toBe(true);
  expect(button().getAttribute("aria-pressed")).toBe("false");

  await act(async () => button().click());
  expect(panel().hidden).toBe(false);
  expect(panel().dataset["mode"]).toBe("docked");
  expect(panel().textContent).toContain("macbook");
  expect(button().getAttribute("aria-pressed")).toBe("true");
  expect(localStorage.getItem(THREAD_DETAILS_KEY)).toBe("open");
  // A click elsewhere leaves it docked.
  await act(async () => document.body.click());
  expect(panel().hidden).toBe(false);

  await act(async () => unmount());
  await render();
  expect(panel().dataset["mode"]).toBe("docked");

  await act(async () => button().click());
  expect(panel().hidden).toBe(true);
  expect(localStorage.getItem(THREAD_DETAILS_KEY)).toBe("closed");
});

test("without room it starts collapsed, and the button floats it over the thread", async () => {
  localStorage.setItem(THREAD_DETAILS_KEY, "open");
  width = 600;
  await render();
  expect(panel().hidden).toBe(true);

  await act(async () => button().click());
  expect(panel().dataset["mode"]).toBe("floating");
  expect(button().getAttribute("aria-pressed")).toBe("true");
  // Floating leaves the kept choice alone.
  expect(localStorage.getItem(THREAD_DETAILS_KEY)).toBe("open");
  await act(async () => button().click());
  expect(panel().hidden).toBe(true);

  // Room again docks it as kept; narrowing collapses it, and a floating card closes on widening.
  await resize(1200);
  expect(panel().dataset["mode"]).toBe("docked");
  await resize(600);
  expect(panel().hidden).toBe(true);
  await act(async () => button().click());
  expect(panel().dataset["mode"]).toBe("floating");
  await resize(1200);
  expect(panel().dataset["mode"]).toBe("docked");
  await resize(600);
  expect(panel().hidden).toBe(true);
});

test("a row that unmounts and returns narrower is measured again", async () => {
  localStorage.setItem(THREAD_DETAILS_KEY, "open");
  await render();
  expect(panel().dataset["mode"]).toBe("docked");
  // The Pull requests page replaces the thread; the window narrows meanwhile.
  await rerender(false);
  width = 600;
  await rerender(true);
  expect(panel().hidden).toBe(true);
});

test("workspace header keeps both icons and host on one row with the path only in its tooltip", async () => {
  await render();
  const header = panel().querySelector('[aria-label="Workspace"] > div')!;
  expect(header.textContent).toBe("macbook");
  expect(header.getAttribute("title")).toBe("/repo");
  expect(header.querySelectorAll("svg")).toHaveLength(2);
  expect(panel().textContent).not.toContain("/repo");
});

test("workspace uses the Connect device icon, updates it, and falls back by host transport", async () => {
  const root = createRoot(document.body.appendChild(document.createElement("div")));
  unmount = () => root.unmount();
  const show = (host: Host) =>
    act(async () => root.render(<ThreadDetails mode="docked" host={host} folder="/repo" />));
  const icon = () => panel().querySelector('[aria-label="Workspace"] > div > span svg')!;
  await show({ id: "device", name: "Mac mini", icon: "mini", routes: ["wss://fixture"] });
  expect(icon().querySelector("rect")?.getAttribute("height")).toBe("10");
  expect(icon().querySelector("path")?.getAttribute("d")).toBe("M6 13h.01");
  expect(icon().closest("span")?.getAttribute("aria-hidden")).toBe("true");
  await show({ id: "device", name: "Mac mini", icon: "desktop" });
  expect(icon().classList.contains("lucide-monitor")).toBe(true);
  await show({ id: "local", name: "macbook" });
  expect(icon().classList.contains("lucide-laptop")).toBe(true);
  await show({ id: "ssh", name: "Remote", destination: "fixture" });
  expect(icon().classList.contains("lucide-server")).toBe(true);
  await show({ id: "lan", name: "Remote", routes: ["wss://fixture"] });
  expect(icon().classList.contains("lucide-server")).toBe(true);
});
