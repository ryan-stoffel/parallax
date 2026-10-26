// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, test, vi } from "vite-plus/test";

import type { ProjectIcon as ProjectIconValue } from "../protocol/generated/protocol";
import { IconPicker } from "./IconPicker";
import { Notifications } from "./notifications";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
// happy-dom has no popovers; the notifications' stack shows one.
HTMLElement.prototype.showPopover = () => {};

let root: Root | undefined;
afterEach(() => {
  // Notifications outlive a render, so close this test's.
  for (const close of document.querySelectorAll<HTMLButtonElement>(
    '[aria-label="Notifications"] button[aria-label="Close"]',
  ))
    act(() => close.click());
  act(() => root?.unmount());
  root = undefined;
  document.body.innerHTML = "";
});

function render(value: ProjectIconValue | undefined, onPick = vi.fn(), maxImageBytes?: number) {
  root ??= createRoot(document.body.appendChild(document.createElement("div")));
  act(() =>
    root!.render(
      <>
        <IconPicker id="picker" value={value} onPick={onPick} maxImageBytes={maxImageBytes} />
        <Notifications />
      </>,
    ),
  );
  return onPick;
}

// happy-dom decodes and draws no images: a 300 x 200 bitmap, and a canvas that records the draw
// and encodes to `encoded`.
let encoded = "data:image/webp;base64,UklGRg==";
const draws: unknown[][] = [];
vi.stubGlobal("createImageBitmap", async () => ({ width: 300, height: 200, close() {} }));
HTMLCanvasElement.prototype.getContext = function (this: HTMLCanvasElement) {
  return { drawImage: (...args: unknown[]) => draws.push([this.width, this.height, ...args]) };
} as never;
HTMLCanvasElement.prototype.toDataURL = (type?: string) =>
  type === "image/webp" ? encoded : "data:image/png;base64,";
afterEach(() => {
  encoded = "data:image/webp;base64,UklGRg==";
  draws.length = 0;
});

const panel = () => document.getElementById("picker")!;
// happy-dom has no popovers, so the panel gets the events a browser sends as it opens or closes:
// beforetoggle at once, and toggle in a later task.
const toggle = (newState: "open" | "closed") => {
  for (const type of ["beforetoggle", "toggle"])
    act(() => {
      panel().dispatchEvent(
        Object.assign(new Event(type), {
          oldState: newState === "open" ? "closed" : "open",
          newState,
        }),
      );
    });
};
const options = () => [...panel().querySelectorAll<HTMLButtonElement>('[role="option"]')];
const option = (label: string) => options().find((o) => o.getAttribute("aria-label") === label)!;
const swatch = (label: string) =>
  panel().querySelector<HTMLInputElement>(`input[type="radio"][aria-label="${label}"]`)!;
const click = (element: HTMLElement) => act(() => element.click());

test("a color or an icon picks both together, from the picker's own last pick, and the accent sends no color (0032)", () => {
  const onPick = render({ name: "rocket", color: "green" });
  toggle("open");
  click(swatch("Violet"));
  expect(onPick).toHaveBeenLastCalledWith({ name: "rocket", color: "violet" });
  // Before any answer: the icon keeps the color just picked.
  click(option("Bug"));
  expect(onPick).toHaveBeenLastCalledWith({ name: "bug", color: "violet" });

  // The accent sends no color at all (0032).
  click(swatch("Accent"));
  expect(onPick).toHaveBeenLastCalledWith({ name: "bug" });
  click(option("Star"));
  expect(onPick).toHaveBeenLastCalledWith({ name: "star" });
  expect(onPick).toHaveBeenCalledTimes(4);
});

/** Picks `file` in the picker's file input, as the file dialog does, and waits for its read. */
const upload = (file: File) =>
  act(async () => {
    const input = panel().querySelector<HTMLInputElement>('input[type="file"]')!;
    Object.defineProperty(input, "files", { value: [file], configurable: true });
    input.dispatchEvent(new Event("change", { bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve));
  });
const png = () => new File(["x"], "logo.png", { type: "image/png" });

test("a file that isn't an image plxd takes, can't be read, or is over the cap isn't picked", async () => {
  const onPick = render(undefined, vi.fn(), 8);
  toggle("open");
  await upload(new File(["x"], "logo.svg", { type: "image/svg+xml" }));
  // Over the 8-byte cap once encoded.
  encoded = "data:image/webp;base64,UklGRkJCQkJC";
  await upload(png());
  vi.stubGlobal("createImageBitmap", async () => Promise.reject(new Error("bad image")));
  await upload(png());
  vi.stubGlobal("createImageBitmap", async () => ({ width: 300, height: 200, close() {} }));
  expect(onPick).not.toHaveBeenCalled();
});
