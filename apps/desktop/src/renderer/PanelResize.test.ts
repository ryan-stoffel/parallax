import { expect, test } from "vite-plus/test";
import { panelWidths } from "./PanelResize";

test("panel widths protect chat space and enforce panel limits", () => {
  expect(panelWidths(1600, 900, 900)).toEqual([400, 640]);
  for (const viewport of [1280, 1000, 800, 600, 320]) {
    const [left, right] = panelWidths(viewport, 400, 640);
    expect(left + right).toBeLessThanOrEqual(viewport - Math.min(400, viewport / 2) + 0.001);
    expect(left).toBeGreaterThanOrEqual(Math.min(200, viewport / 4));
    expect(right).toBeGreaterThanOrEqual(Math.min(200, viewport / 4));
  }
});
test("hidden panels consume no width", () => {
  expect(panelWidths(1000, 256, 0)).toEqual([256, 0]);
  expect(panelWidths(1000, 0, 416)).toEqual([0, 416]);
});
