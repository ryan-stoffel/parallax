import { expect, test } from "vite-plus/test";

import { fittingTiles, ratioAt, ratiosWithout, tileAt, tileLayout } from "./splitLayout";

test("tiles dwindle: left | right, then the right splits top / bottom, then the bottom left | right", () => {
  expect(tileLayout(2, []).tiles).toEqual([
    { left: 0, top: 0, width: 0.5, height: 1 },
    { left: 0.5, top: 0, width: 0.5, height: 1 },
  ]);
  expect(tileLayout(4, []).tiles).toEqual([
    { left: 0, top: 0, width: 0.5, height: 1 },
    { left: 0.5, top: 0, width: 0.5, height: 0.5 },
    { left: 0.5, top: 0.5, width: 0.25, height: 0.5 },
    { left: 0.75, top: 0.5, width: 0.25, height: 0.5 },
  ]);
  expect(tileLayout(3, []).cuts.map((c) => c.vertical)).toEqual([true, false]);
});

test("a cut's ratio is its tile's share of the region it cuts", () => {
  const { tiles, cuts } = tileLayout(3, [0.6, 0.25]);
  expect(tiles[0]!.width).toBeCloseTo(0.6);
  expect(tiles[1]!.height).toBeCloseTo(0.25);
  expect(tiles[2]!.top).toBeCloseTo(0.25);
  // The second cut spans only the right 40%, so x = 0.8 is its middle.
  expect(ratioAt(cuts[1]!, 0.8, 0.5)).toBeCloseTo(0.5);
  expect(ratioAt(cuts[0]!, 0.99, 0)).toBe(0.8);
});

test("the tile under a point, or the last one off every tile", () => {
  const { tiles } = tileLayout(4, []);
  expect(tileAt(tiles, 0.2, 0.9)).toBe(0);
  expect(tileAt(tiles, 0.6, 0.2)).toBe(1);
  expect(tileAt(tiles, 0.9, 0.9)).toBe(3);
  expect(tileAt(tiles, 1, 1)).toBe(3);
});

test("closing a tile keeps the cuts before it, and the ones after it, turned, start even", () => {
  expect(ratiosWithout([0.3, 0.4, 0.6], 4, 1)).toEqual([0.3, 0.5]);
  expect(ratiosWithout([0.3, 0.4, 0.6], 4, 3)).toEqual([0.3, 0.4]);
  // The first of three closing: the 30% top share doesn't become a 30% left share.
  expect(ratiosWithout([0.65, 0.3], 3, 0)).toEqual([0.5]);
  expect(ratiosWithout([0.3], 2, 0)).toEqual([]);
});

test("only the tiles that keep their minimum size fit, and the rest stack in the last", () => {
  // 1340 by 950: the fourth's quarter width is 335px, enough.
  expect(fittingTiles(4, [], 1340, 950)).toBe(4);
  // 1060 by 750: a quarter is 265px, so three tile and the last holds two.
  expect(fittingTiles(4, [], 1060, 750)).toBe(3);
  // A wider first tile leaves less for the rest; a narrower one makes room.
  expect(fittingTiles(4, [0.65], 1340, 950)).toBe(3);
  expect(fittingTiles(4, [0.4], 1100, 950)).toBe(4);
  // Too short for a top and bottom, too narrow for even two.
  expect(fittingTiles(3, [], 1000, 500)).toBe(2);
  expect(fittingTiles(2, [], 600, 900)).toBe(1);
  // Not measured yet.
  expect(fittingTiles(3, [], 0, 0)).toBe(3);
});
