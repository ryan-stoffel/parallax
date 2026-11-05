import { expect, test } from "vite-plus/test";

import { tooNarrowToDock } from "./ThreadDetails";

test("docks while a thread keeps enough room, and floats only when it can't", () => {
  expect(tooNarrowToDock(1056)).toBe(false);
  expect(tooNarrowToDock(688)).toBe(false);
  expect(tooNarrowToDock(687)).toBe(true);
  // Not measured yet.
  expect(tooNarrowToDock(0)).toBe(false);
});

test("in a split, the tile it docks in has to keep that room", () => {
  expect(tooNarrowToDock(1376, 0.5)).toBe(false);
  expect(tooNarrowToDock(1375, 0.5)).toBe(true);
});
