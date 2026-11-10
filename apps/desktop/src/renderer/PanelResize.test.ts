import { expect, test } from "vite-plus/test";

import { panelWidths } from "./PanelResize";

test("panels drag further in a wider window, and the chat keeps its 400px", () => {
  // A 49" ultrawide: a fifth of the window, and half of it.
  expect(panelWidths(5120, 9999, 9999)).toEqual([1024, 2560]);
  // A small window keeps the limits it had.
  expect(panelWidths(1280, 9999, 0)).toEqual([400, 0]);
  expect(panelWidths(1280, 0, 9999)).toEqual([0, 640]);
  // Both at their widest would leave the chat 350px.
  const [left, right] = panelWidths(1500, 9999, 9999);
  expect(left + right).toBeCloseTo(1100);
});
