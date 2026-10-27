import { expect, test } from "vite-plus/test";

import { tooNarrowToDock } from "./ThreadDetails";

test("docks only while the transcript keeps its whole column beside the card", () => {
  expect(tooNarrowToDock(1068)).toBe(false);
  expect(tooNarrowToDock(1067)).toBe(true);
  expect(tooNarrowToDock(700)).toBe(true);
  // Not measured yet.
  expect(tooNarrowToDock(0)).toBe(false);
});
