// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, test } from "vite-plus/test";

import type { ParallaxBridge } from "../preload/bridge";
import { OpenMenu } from "./OpenMenu";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

let unmount = () => {};
afterEach(() => act(() => unmount()));

test("draws a target's app icon where main has one, and its mark where it doesn't", async () => {
  localStorage.clear();
  window.parallax = {
    platform: "darwin",
    openTargets: async () => ["cursor", "vscode", "files"],
    openTargetIcons: async () => ({ cursor: "data:image/png;base64,Y3Vyc29y" }),
  } as Partial<ParallaxBridge> as ParallaxBridge;
  const root = createRoot(document.body.appendChild(document.createElement("div")));
  unmount = () => root.unmount();
  await act(async () => root.render(<OpenMenu hostId="local" folder="/repo" />));

  const button = document.querySelector('[aria-label="Open in Cursor"]')!;
  expect(button.querySelector("img")?.getAttribute("src")).toBe("data:image/png;base64,Y3Vyc29y");
  const items = [...document.querySelectorAll('[role="menuitem"]')];
  expect(
    items.map((item) => [
      item.querySelector("span")?.textContent,
      item.querySelector("img") ? "img" : "svg",
    ]),
  ).toEqual([
    ["Cursor", "img"],
    ["VS Code", "svg"],
    ["Finder", "svg"],
  ]);
});
