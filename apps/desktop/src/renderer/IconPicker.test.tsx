// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, test, vi } from "vite-plus/test";

import type { ProjectIcon as ProjectIconValue } from "../protocol/generated/protocol";
import { IconPicker } from "./IconPicker";
import { projectIcons } from "./projectIcons";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

let root: Root | undefined;
afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  document.body.innerHTML = "";
});

function render(value: ProjectIconValue | undefined, onPick = vi.fn(), maxImageBytes?: number) {
  root ??= createRoot(document.body.appendChild(document.createElement("div")));
  act(() =>
    root!.render(
      <IconPicker id="picker" value={value} onPick={onPick} maxImageBytes={maxImageBytes} />,
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
const searchBox = () =>
  panel().querySelector<HTMLInputElement>('input[aria-label="Search icons"]')!;
const options = () => [...panel().querySelectorAll<HTMLButtonElement>('[role="option"]')];
const option = (label: string) => options().find((o) => o.getAttribute("aria-label") === label)!;
const selected = () =>
  options()
    .filter((o) => o.getAttribute("aria-selected") === "true")
    .map((o) => o.getAttribute("aria-label"));
const swatch = (label: string) =>
  panel().querySelector<HTMLInputElement>(`input[type="radio"][aria-label="${label}"]`)!;
const checkedColor = () =>
  panel()
    .querySelector<HTMLInputElement>('input[type="radio"]:checked')
    ?.getAttribute("aria-label");
const grid = () => panel().querySelector<HTMLElement>('[role="listbox"]')!;
const type = (text: string) =>
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(
      searchBox(),
      text,
    );
    searchBox().dispatchEvent(new Event("input", { bubbles: true }));
  });
const press = (key: string) =>
  act(() => {
    document.activeElement!.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
  });
const click = (element: HTMLElement) => act(() => element.click());

test("it draws nothing until it opens, then focuses its search box with the default checked", () => {
  render(undefined);
  expect(panel().getAttribute("role")).toBe("dialog");
  expect(panel().getAttribute("aria-label")).toBe("Project icon");
  expect(panel().childElementCount).toBe(0);

  toggle("open");
  expect(document.activeElement).toBe(searchBox());
  expect(options()).toHaveLength(projectIcons.length);
  expect(selected()).toEqual(["Folder kanban"]);
  // The accent is the default, so it's checked when no color is set.
  expect(checkedColor()).toBe("Accent");
  expect(grid().className).toContain("text-accent");

  toggle("closed");
  expect(panel().childElementCount).toBe(0);
});

test("search matches names and keywords, Enter picks the first match, and nothing left says so", () => {
  const onPick = render({ name: "rocket", color: "green" });
  toggle("open");
  type("GIT");
  expect(options().map((o) => o.getAttribute("aria-label"))).toEqual([
    "Folder git",
    "Git branch",
    "Git merge",
    "Git pull request",
  ]);
  type("launch");
  expect(options().map((o) => o.getAttribute("aria-label"))).toEqual(["Rocket"]);
  type("pet");
  press("Enter");
  expect(onPick).toHaveBeenLastCalledWith({ name: "cat", color: "green" });

  type("zzz");
  expect(options()).toEqual([]);
  expect(panel().textContent).toContain("No icons match");
});

test("Enter in an empty search box picks nothing, so opening and pressing Enter keeps the icon", () => {
  const onPick = render({ name: "rocket", color: "green" });
  toggle("open");
  press("Enter");
  type("   ");
  press("Enter");
  expect(onPick).not.toHaveBeenCalled();
  expect(selected()).toEqual(["Rocket"]);

  // Nor while an input method composes.
  type("bug");
  act(() => {
    searchBox().dispatchEvent(
      new KeyboardEvent("keydown", { key: "Enter", isComposing: true, bubbles: true }),
    );
  });
  expect(onPick).not.toHaveBeenCalled();
  press("Enter");
  expect(onPick).toHaveBeenCalledWith({ name: "bug", color: "green" });
});

test("a color or an icon picks both together, from the picker's own last pick, and it stays open", () => {
  const onPick = render({ name: "rocket", color: "green" });
  toggle("open");
  expect(selected()).toEqual(["Rocket"]);
  expect(checkedColor()).toBe("Green");
  expect(grid().className).toContain("text-project-green");

  click(swatch("Violet"));
  expect(onPick).toHaveBeenLastCalledWith({ name: "rocket", color: "violet" });
  // Before any answer: the icon keeps the color just picked.
  click(option("Bug"));
  expect(onPick).toHaveBeenLastCalledWith({ name: "bug", color: "violet" });
  expect(selected()).toEqual(["Bug"]);
  expect(checkedColor()).toBe("Violet");
  expect(grid().className).toContain("text-project-violet");
  expect(panel().childElementCount).toBeGreaterThan(0);

  // The accent sends no color at all (0032).
  click(swatch("Accent"));
  expect(onPick).toHaveBeenLastCalledWith({ name: "bug" });
  click(option("Star"));
  expect(onPick).toHaveBeenLastCalledWith({ name: "star" });
  expect(onPick).toHaveBeenCalledTimes(4);
});

test("each time it opens, it starts again from its value", () => {
  const onPick = render({ name: "rocket" });
  toggle("open");
  click(swatch("Pink"));
  type("cat");
  toggle("closed");

  render({ name: "rocket", color: "teal" }, onPick);
  toggle("open");
  expect(searchBox().value).toBe("");
  expect(selected()).toEqual(["Rocket"]);
  expect(checkedColor()).toBe("Teal");
});

test("a name or color it doesn't know marks nothing, and a pick keeps the other part", () => {
  const onPick = render({ name: "not-an-icon", color: "chartreuse" });
  toggle("open");
  expect(selected()).toEqual([]);
  expect(checkedColor()).toBeUndefined();
  click(option("Rocket"));
  expect(onPick).toHaveBeenLastCalledWith({ name: "rocket", color: "chartreuse" });
});

test("Down goes from the search box to the current icon, arrows move in the grid, and Up from its top row goes back", () => {
  render({ name: "folder" });
  toggle("open");
  expect(options().filter((o) => o.tabIndex === 0)).toEqual([option("Folder")]);
  press("ArrowDown");
  expect(document.activeElement).toBe(option("Folder"));
  press("ArrowRight");
  expect(document.activeElement).toBe(options()[2]);
  press("ArrowDown");
  expect(document.activeElement).toBe(options()[11]);
  press("ArrowLeft");
  expect(document.activeElement).toBe(options()[10]);
  press("ArrowUp");
  expect(document.activeElement).toBe(options()[1]);
  press("ArrowLeft");
  press("ArrowLeft");
  expect(document.activeElement).toBe(options()[0]);
  press("ArrowUp");
  expect(document.activeElement).toBe(searchBox());

  // With a search, the first match is the one Tab and Down stop at.
  type("pet");
  press("ArrowDown");
  expect(document.activeElement?.getAttribute("aria-label")).toBe("Cat");
  press("ArrowRight");
  expect(document.activeElement?.getAttribute("aria-label")).toBe("Dog");
  // Past the last match, it stays put.
  press("ArrowRight");
  press("ArrowDown");
  expect(document.activeElement?.getAttribute("aria-label")).toBe("Dog");
});

const uploadButton = () =>
  panel().querySelector<HTMLButtonElement>('button[aria-label="Upload image"]');
/** Picks `file` in the picker's file input, as the file dialog does, and waits for its read. */
const upload = (file: File) =>
  act(async () => {
    const input = panel().querySelector<HTMLInputElement>('input[type="file"]')!;
    Object.defineProperty(input, "files", { value: [file], configurable: true });
    input.dispatchEvent(new Event("change", { bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve));
  });
const png = () => new File(["x"], "logo.png", { type: "image/png" });

test("Upload image shows only with the host's cap, and sends the image cropped square as a 128 px WebP", async () => {
  render({ name: "rocket", color: "green" });
  toggle("open");
  expect(uploadButton()).toBeNull();
  toggle("closed");

  const onPick = render({ name: "rocket", color: "green" }, vi.fn(), 65536);
  toggle("open");
  expect(uploadButton()!.getAttribute("aria-pressed")).toBe("false");
  expect(panel().querySelector('input[type="file"]')!.getAttribute("accept")).toBe(
    "image/png,image/jpeg,image/gif,image/webp",
  );
  await upload(png());
  // The 300 x 200 image's middle 200 x 200, onto a 128 px canvas.
  expect(draws).toEqual([[128, 128, expect.anything(), 50, 0, 200, 200, 0, 0, 128, 128]]);
  // The glyph and color stay under it (0038).
  expect(onPick).toHaveBeenLastCalledWith({
    name: "rocket",
    color: "green",
    image: { mediaType: "image/webp", data: "UklGRg==" },
  });
  // The upload is the one selected.
  expect(uploadButton()!.getAttribute("aria-pressed")).toBe("true");
  expect(uploadButton()!.querySelector("img")!.getAttribute("src")).toBe(encoded);
  expect(selected()).toEqual([]);
  expect(checkedColor()).toBeUndefined();
});

test("a glyph or a color picked after an upload replaces the image", async () => {
  const image = { mediaType: "image/webp" as const, data: "UklGRg==" };
  const onPick = render({ name: "rocket", color: "green", image }, vi.fn(), 65536);
  toggle("open");
  expect(uploadButton()!.getAttribute("aria-pressed")).toBe("true");
  click(option("Bug"));
  expect(onPick).toHaveBeenLastCalledWith({ name: "bug", color: "green" });
  expect(uploadButton()!.getAttribute("aria-pressed")).toBe("false");
  expect(selected()).toEqual(["Bug"]);

  await upload(png());
  click(swatch("Violet"));
  expect(onPick).toHaveBeenLastCalledWith({ name: "bug", color: "violet" });
});

test("a file that isn't an image plxd takes, can't be read, or is over the cap says so in the picker", async () => {
  const onPick = render(undefined, vi.fn(), 8);
  toggle("open");
  const alert = () => panel().querySelector('[role="alert"]')?.textContent;

  await upload(new File(["x"], "logo.svg", { type: "image/svg+xml" }));
  expect(alert()).toBe("Only PNG, JPEG, GIF, and WebP images can be used.");

  encoded = "data:image/webp;base64,UklGRkJCQkJC";
  await upload(png());
  expect(alert()).toBe("That image is too large for an icon.");

  vi.stubGlobal("createImageBitmap", async () => Promise.reject(new Error("bad image")));
  await upload(png());
  expect(alert()).toBe("That image couldn't be read.");
  vi.stubGlobal("createImageBitmap", async () => ({ width: 300, height: 200, close() {} }));
  expect(onPick).not.toHaveBeenCalled();

  // A pick clears it.
  click(option("Star"));
  expect(alert()).toBeUndefined();
});
