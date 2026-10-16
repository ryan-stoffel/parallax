// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, test, vi } from "vite-plus/test";

import { moveFocus, openOnContextMenu, Picker, type PickerOption } from "./ui";

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
  { value: "parallax", label: "parallax" },
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
  expect(trigger()).toBe("Workspace: parallax");
  expect(items()[0]!.getAttribute("aria-checked")).toBe("true");
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
  expect(focused()).toBe("parallax");
  press("ArrowDown");
  expect(focused()).toBe("ember");
  expect(menu.contains(document.activeElement)).toBe(true);
});

test("Up and Down pass a menu's disabled items", () => {
  root = createRoot(document.body.appendChild(document.createElement("div")));
  render(
    <div role="menu" onKeyDown={moveFocus}>
      <button type="button" role="menuitem">
        Choose folder…
      </button>
      <button type="button" role="menuitem" disabled>
        Browse folders
      </button>
      <button type="button" role="menuitem">
        parallax
      </button>
    </div>,
  );
  const press = (key: string) =>
    act(() => {
      document.activeElement!.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
    });
  const focused = () => document.activeElement?.textContent;

  document.querySelector<HTMLElement>('[role="menuitem"]')!.focus();
  press("ArrowDown");
  expect(focused()).toBe("parallax");
  press("ArrowUp");
  expect(focused()).toBe("Choose folder…");
});

test("a right-click that arrives with a button down opens its menu on the release, and a lost release opens nothing", () => {
  root = createRoot(document.body.appendChild(document.createElement("div")));
  const trigger = document.createElement("button");
  const opened = vi.fn();
  trigger.addEventListener("click", opened);
  render(
    <button type="button" onContextMenu={(e) => openOnContextMenu(e, trigger)}>
      ember
    </button>,
  );
  const contextMenu = (buttons: number) => {
    const event = new MouseEvent("contextmenu", { bubbles: true, cancelable: true, buttons });
    act(() => void document.querySelector("button")!.dispatchEvent(event));
    return event;
  };
  const windowEvent = (type: string) => act(() => void window.dispatchEvent(new Event(type)));

  // Released already (Windows, the menu key): at once.
  expect(contextMenu(0).defaultPrevented).toBe(true);
  expect(opened).toHaveBeenCalledTimes(1);
  // A right-click on macOS and Linux holds the right button; Control-click on macOS, the left.
  for (const [i, buttons] of [2, 1].entries()) {
    expect(contextMenu(buttons).defaultPrevented).toBe(true);
    expect(opened).toHaveBeenCalledTimes(1 + i);
    windowEvent("pointerup");
    expect(opened).toHaveBeenCalledTimes(2 + i);
  }
  // A release the window never sees, as when the button is held through switching apps, ends the
  // wait at the window's blur, a cancelled pointer, or the next press, so a later click opens
  // nothing.
  for (const type of ["blur", "pointercancel", "pointerdown"]) {
    contextMenu(2);
    windowEvent(type);
    windowEvent("pointerup");
  }
  expect(opened).toHaveBeenCalledTimes(3);
});

test("a field Picker's search filters its groups, and Enter takes the first match or the typed name", () => {
  root = createRoot(document.body.appendChild(document.createElement("div")));
  const onChange = vi.fn();
  const close = vi.fn();
  render(
    <Picker
      field
      label="Font"
      value=""
      onChange={onChange}
      options={[
        { value: "", label: "System" },
        { value: "Inter Variable", label: "Inter", group: "Included with Parallax" },
        { value: "Menlo", label: "Menlo", group: "Installed" },
      ]}
      search="Search fonts"
      custom={(name) => ({ value: name, label: name })}
      footer={(c) => (
        <button type="button" onClick={() => (close(), c())}>
          Add
        </button>
      )}
    />,
  );
  const search = document.querySelector<HTMLInputElement>('input[type="search"]')!;
  const type = (text: string) =>
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(search, text);
      search.dispatchEvent(new Event("input", { bubbles: true }));
    });
  const enter = () =>
    act(() => {
      search.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    });
  const headings = () =>
    [...document.querySelectorAll('[role="menu"] .text-faint-foreground')].map(
      (h) => h.textContent,
    );

  expect(headings()).toEqual(["Included with Parallax", "Installed"]);
  // Enter with nothing typed keeps the choice.
  enter();
  expect(onChange).not.toHaveBeenCalled();
  type("men");
  // The typed name comes after the matches, and Enter takes the first match.
  expect(items().map((i) => i.textContent)).toEqual(["Menlo", "men"]);
  expect(headings()).toEqual(["Installed"]);
  enter();
  expect(onChange).toHaveBeenLastCalledWith("Menlo");
  type("Berkeley Mono");
  expect(items()[0]!.textContent).toBe("Berkeley Mono");
  enter();
  expect(onChange).toHaveBeenLastCalledWith("Berkeley Mono");
  act(() => [...document.querySelectorAll("button")].find((b) => b.textContent === "Add")!.click());
  expect(close).toHaveBeenCalled();
});
