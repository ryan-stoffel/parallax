import { expect, test } from "vite-plus/test";

import {
  allCells,
  cellsFilled,
  cellsLeft,
  cellSplit,
  dividersOf,
  evenCuts,
  fits,
  isRect,
  rectOf,
  tilesOf,
  usedCuts,
  zoneAt,
  zoneCells,
} from "./splitLayout";

const all = { columns: true, rows: true };

test("cells cover their box, at the grid's lines", () => {
  expect(rectOf(allCells, evenCuts)).toEqual({ left: 0, top: 0, width: 1, height: 1 });
  expect(rectOf(zoneCells.left, { x: 0.25, y: 0.5 })).toEqual({
    left: 0,
    top: 0,
    width: 0.25,
    height: 1,
  });
  expect(rectOf(zoneCells.lowerRight, { x: 0.25, y: 0.75 })).toEqual({
    left: 0.25,
    top: 0.75,
    width: 0.75,
    height: 0.25,
  });
});

test("every drop leaves every other pane a rectangle or nothing", () => {
  for (const cells of [1, 2, 4, 8, 3, 12, 5, 10, 15]) {
    for (const taken of Object.values(zoneCells)) {
      const left = cellsLeft(cells, taken);
      expect(left === 0 || isRect(left)).toBe(true);
      expect(left & taken).toBe(0);
    }
  }
});

test("a pane alone that loses a corner keeps the column across from it", () => {
  expect(cellsLeft(allCells, zoneCells.upperLeft)).toBe(zoneCells.right);
  expect(cellsLeft(allCells, zoneCells.lowerRight)).toBe(zoneCells.left);
});

// Every way to fill the grid with rectangles.
const layouts: number[][] = [];
const fill = (free: number, panes: number[]) => {
  if (!free) return void layouts.push(panes);
  const first = free & -free;
  for (const cells of [1, 2, 4, 8, 3, 12, 5, 10, 15]) {
    if (cells & first && (cells & free) === cells) fill(free & ~cells, [...panes, cells]);
  }
};
fill(15, []);

test("closing any pane of any layout leaves the grid full of rectangles", () => {
  expect(layouts).toHaveLength(8);
  for (const panes of layouts) {
    if (panes.length === 1) continue;
    panes.forEach((freed, at) => {
      const next = cellsFilled(
        panes.filter((_, i) => i !== at),
        freed,
      );
      expect(next.every(isRect)).toBe(true);
      expect(next.reduce((a, b) => a | b, 0)).toBe(15);
      expect(next.reduce((sum, c) => sum + (c.toString(2).match(/1/g)?.length ?? 0), 0)).toBe(4);
    });
  }
});

test("closing a pane gives its cells to one pane when it can", () => {
  expect(cellsFilled([zoneCells.right], zoneCells.left)).toEqual([allCells]);
  expect(cellsFilled([zoneCells.upperRight, zoneCells.lowerRight], zoneCells.left)).toEqual([
    zoneCells.top,
    zoneCells.bottom,
  ]);
});

test("a new pane splits a pane to its right, or below", () => {
  expect(cellSplit(allCells)).toBe(zoneCells.right);
  expect(cellSplit(zoneCells.right)).toBe(zoneCells.lowerRight);
  expect(cellSplit(zoneCells.top)).toBe(zoneCells.upperRight);
});

test("what has no room stacks, and overlaps join", () => {
  const quads = [1, 2, 4, 8];
  expect(tilesOf(quads, all).map((t) => t.panes)).toEqual([[0], [1], [2], [3]]);
  expect(tilesOf(quads, { columns: false, rows: true }).map((t) => t.panes)).toEqual([
    [0, 1],
    [2, 3],
  ]);
  expect(tilesOf(quads, { columns: true, rows: false }).map((t) => t.panes)).toEqual([
    [0, 2],
    [1, 3],
  ]);
  const three = [zoneCells.left, zoneCells.upperRight, zoneCells.lowerRight];
  expect(tilesOf(three, { columns: false, rows: true })).toEqual([{ cells: 15, panes: [0, 1, 2] }]);
  expect(tilesOf(three, { columns: false, rows: false })[0]!.cells).toBe(15);
});

test("dividers cover only what they divide", () => {
  const cuts = { x: 0.4, y: 0.6 };
  const three = tilesOf([zoneCells.left, zoneCells.upperRight, zoneCells.lowerRight], all);
  expect(dividersOf(three, cuts)).toEqual([
    { vertical: true, from: 0, to: 1 },
    { vertical: false, from: 0.4, to: 1 },
  ]);
  expect(dividersOf(tilesOf([allCells], all), cuts)).toEqual([]);
  const two = tilesOf([zoneCells.top, zoneCells.bottom], all);
  expect(dividersOf(two, cuts)).toEqual([{ vertical: false, from: 0, to: 1 }]);
});

test("the window's edges and corners are the zones, and its middle none", () => {
  expect(zoneAt(0.1, 0.5, all)).toBe("left");
  expect(zoneAt(0.9, 0.5, all)).toBe("right");
  expect(zoneAt(0.5, 0.1, all)).toBe("top");
  expect(zoneAt(0.5, 0.9, all)).toBe("bottom");
  expect(zoneAt(0.1, 0.1, all)).toBe("upperLeft");
  expect(zoneAt(0.9, 0.1, all)).toBe("upperRight");
  expect(zoneAt(0.1, 0.9, all)).toBe("lowerLeft");
  expect(zoneAt(0.9, 0.9, all)).toBe("lowerRight");
  expect(zoneAt(0.5, 0.5, all)).toBeUndefined();
});

test("a side with no room isn't a zone", () => {
  expect(zoneAt(0.1, 0.1, { columns: false, rows: true })).toBe("top");
  expect(zoneAt(0.1, 0.5, { columns: false, rows: true })).toBeUndefined();
  expect(zoneAt(0.1, 0.1, { columns: false, rows: false })).toBeUndefined();
  expect(fits(evenCuts, 1000, 1000)).toEqual({ columns: true, rows: true });
  expect(fits(evenCuts, 500, 1000)).toEqual({ columns: false, rows: true });
  expect(fits(evenCuts, 0, 0)).toEqual({ columns: true, rows: true });
});

test("a drop sees the lines it would land on: a used one where it sits, a new one even", () => {
  const dragged = { x: 0.3, y: 0.3 };
  const columns = [zoneCells.left, zoneCells.right];
  expect(usedCuts(columns, dragged)).toEqual({ x: 0.3, y: 0.5 });
  expect(usedCuts([allCells], dragged)).toEqual(evenCuts);
  // A narrow window stacks columns left at 0.3, so a side isn't a zone until they have room.
  expect(fits(usedCuts(columns, dragged), 800, 1000).columns).toBe(false);
  expect(zoneAt(0.9, 0.5, fits(usedCuts(columns, dragged), 800, 1000))).toBeUndefined();
});
