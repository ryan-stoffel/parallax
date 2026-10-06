// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, test } from "vite-plus/test";

import type { ParallaxBridge } from "../preload/bridge";
import { TranscriptView } from "./AgentChat";
import { findHits, occurrences, searchText } from "./Find";
import type { Item } from "./transcript";

let unmount = () => {};
afterEach(() => act(() => unmount()));

test("a search ignores case and Markdown syntax, and counts each match once", () => {
  expect(occurrences("Aa aA aaa", "aa")).toEqual([
    [0, 2],
    [3, 5],
    [6, 8],
  ]);
  expect(occurrences("anything", "")).toEqual([]);
  expect(searchText("## Fix **the** [build](https://x.dev) in `main`\n- done")).toBe(
    "Fix the build in main\ndone",
  );
  expect(findHits(["a b a", "", "a"], "a")).toEqual([
    { row: 0, nth: 0 },
    { row: 0, nth: 1 },
    { row: 2, nth: 0 },
  ]);
});

test("Cmd+F opens a find box that counts matches, steps through them, wraps, and closes", () => {
  window.parallax = { platform: "darwin" } as ParallaxBridge;
  const rows: Item[] = [
    { kind: "user", key: "u", text: "Where is the **cache**?" },
    { kind: "assistant", key: "a", text: "The cache is in `cache.ts`, and the Cache is warm." },
  ];
  const root = createRoot(document.body.appendChild(document.createElement("div")));
  act(() => root.render(<TranscriptView rows={rows} sent={new Map()} live={false} />));
  unmount = () => {
    root.unmount();
    document.body.innerHTML = "";
  };
  const press = (init: KeyboardEventInit, target: EventTarget = window) =>
    act(() => {
      target.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, ...init }));
    });
  const box = () => document.querySelector<HTMLInputElement>('input[aria-label="Find in thread"]');
  const status = () => document.querySelector('[role="status"]')!.textContent;
  const type = (value: string) =>
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(
        box()!,
        value,
      );
      box()!.dispatchEvent(new Event("input", { bubbles: true }));
    });

  expect(box()).toBeNull();
  press({ key: "f", code: "KeyF", metaKey: true });
  expect(box()).not.toBeNull();

  type("cache");
  expect(status()).toBe("1/4");
  press({ key: "Enter", code: "Enter" }, box()!);
  expect(status()).toBe("2/4");
  press({ key: "Enter", code: "Enter", shiftKey: true }, box()!);
  press({ key: "Enter", code: "Enter", shiftKey: true }, box()!);
  expect(status()).toBe("4/4");
  press({ key: "g", code: "KeyG", metaKey: true });
  expect(status()).toBe("1/4");

  type("nothing like this");
  expect(status()).toBe("No results");

  press({ key: "Escape", code: "Escape" }, box()!);
  expect(box()).toBeNull();
});
