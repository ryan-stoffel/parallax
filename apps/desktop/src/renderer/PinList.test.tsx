// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, test } from "vite-plus/test";

import { PinList } from "./PinList";
import { createFolder, pinLayout } from "./pins";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

let root: Root | undefined;
beforeEach(() => pinLayout.set({ order: [], folders: {} }));
afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  document.body.innerHTML = "";
});

function render() {
  const noop = () => {};
  root ??= createRoot(document.body.appendChild(document.createElement("div")));
  act(() =>
    root!.render(
      <PinList
        pins={[]}
        searching={false}
        onOpen={noop}
        onPinThread={noop}
        onUnpin={noop}
        onRename={noop}
        onRest={noop}
        onLeave={noop}
        onNewThread={noop}
        onFavorite={noop}
        onPlaced={noop}
        onMarkUnread={noop}
      />,
    ),
  );
}

const field = () => document.querySelector<HTMLInputElement>('input[aria-label="Folder name"]');
const startRename = () =>
  act(() => {
    document
      .querySelector("[data-folder-name]")!
      .dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
  });
const type = (input: HTMLInputElement, value: string) => {
  // React tracks an input's value; set it past the tracker so the change registers.
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
};
const press = (input: HTMLInputElement, key: string) =>
  act(() => {
    input.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
    // The blur that follows as the field goes, as a browser may send.
    input.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
  });

test("double-clicking a folder's name renames it in place, without its hover buttons", () => {
  const id = createFolder();
  render();
  startRename();
  expect(field()?.value).toBe("New folder");
  expect(document.querySelector('[aria-label="New thread in New folder"]')).toBeNull();
  type(field()!, "School");
  press(field()!, "Enter");
  expect(field()).toBeNull();
  expect(pinLayout.get().folders[id]?.name).toBe("School");
});

test("Escape keeps the old name, though the field's blur follows", () => {
  const id = createFolder();
  render();
  startRename();
  type(field()!, "Typo");
  press(field()!, "Escape");
  expect(field()).toBeNull();
  expect(pinLayout.get().folders[id]?.name).toBe("New folder");
});
