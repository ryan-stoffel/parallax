// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, test, vi } from "vite-plus/test";

import { Picker, type PickerOption } from "./ui";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
// happy-dom has no popovers. The menu's items are in the DOM either way.
HTMLElement.prototype.hidePopover = () => {};

let root: Root;
afterEach(() => {
  act(() => root.unmount());
  document.body.innerHTML = "";
});

function render(node: React.ReactNode) {
  root ??= createRoot(document.body.appendChild(document.createElement("div")));
  act(() => root.render(node));
}

const options: PickerOption[] = [
  { value: "wisp", label: "wisp" },
  { value: "ember", label: "ember" },
  { value: "photon", label: "photon" },
];
const trigger = () => document.querySelector("button[aria-haspopup]")!.getAttribute("aria-label");
const items = () => [...document.querySelectorAll<HTMLElement>('[role="menuitemradio"]')];

test("a Picker left to itself shows its first option, even when options arrive after it mounts", () => {
  root = createRoot(document.body.appendChild(document.createElement("div")));
  render(<Picker label="Workspace" options={[]} />);
  expect(trigger()).toBe("Workspace: none");
  render(<Picker label="Workspace" options={options} />);
  expect(trigger()).toBe("Workspace: wisp");
  expect(items()[0]!.getAttribute("aria-checked")).toBe("true");
});

test("search narrows the options, and Enter picks the first one left", () => {
  root = createRoot(document.body.appendChild(document.createElement("div")));
  const onChange = vi.fn();
  render(<Picker label="Branch" search="Search branches…" options={options} onChange={onChange} />);
  const box = document.querySelector("input")!;
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(box, "PH");
    box.dispatchEvent(new Event("input", { bubbles: true }));
  });
  expect(items().map((b) => b.textContent)).toEqual(["photon"]);
  act(() => {
    box.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  });
  expect(onChange).toHaveBeenCalledWith("photon");
  expect(trigger()).toBe("Branch: photon");
});

test("Up and Down move between a menu's items, wrapping at the ends", () => {
  root = createRoot(document.body.appendChild(document.createElement("div")));
  render(<Picker label="Workspace" options={options} />);
  const menu = document.querySelector('[role="menu"]')!;
  const press = (key: string) =>
    act(() => {
      document.activeElement!.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
    });
  const focused = () => document.activeElement?.textContent;

  items()[0]!.focus();
  press("ArrowUp");
  expect(focused()).toBe("photon");
  press("ArrowDown");
  expect(focused()).toBe("wisp");
  press("ArrowDown");
  expect(focused()).toBe("ember");
  expect(menu.contains(document.activeElement)).toBe(true);
});
