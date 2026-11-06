import { beforeEach, expect, test } from "vite-plus/test";

import { orderOf, pinLayout, placeAt, readLayout } from "./pins";

const pins = ["a", "b", "c", "d"];
beforeEach(() => pinLayout.set({ order: [] }));

test("a layout saved with folders flattens, each folder's pins in its place, nested ones too", () => {
  const saved = {
    order: ["a", "folder:outer", "d"],
    folders: {
      outer: { name: "Outer", items: ["folder:inner", "c"] },
      inner: { name: "Inner", items: ["b"] },
    },
  };
  expect(readLayout(saved, { order: [] })).toEqual({ order: ["a", "b", "c", "d"] });
});

test("a pin dropped before or after another moves there, and pins not yet placed keep their place", () => {
  placeAt(pins, "d", "a", false);
  expect(orderOf(pinLayout.get(), pins)).toEqual(["d", "a", "b", "c"]);
  placeAt(pins, "d", "b", true);
  expect(orderOf(pinLayout.get(), pins)).toEqual(["a", "b", "d", "c"]);
});
