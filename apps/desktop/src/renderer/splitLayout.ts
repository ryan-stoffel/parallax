// Where the window's panes tile (PLX-1082, PLX-1289): rectangles on a grid of two columns and two
// rows, so a pane takes a whole side or half, or one corner. One vertical cut and one horizontal cut
// set the grid's lines.
import { msg } from "../i18n";

/** The most panes a window holds, one to a cell. */
export const maxTiles = 4;

/** Where a cut starts. */
export const evenRatio = 0.5;

/**
 * The smallest a tile gets, in pixels: room for its tabs, a few lines of transcript, and a compact
 * composer. Past that, columns or rows stack, their panes' tabs together in one tile.
 */
export const minTile = { width: 320, height: 360 };

/** How far a divider can be dragged, as a share of the window. */
const minRatio = 0.2;

/** A box in the window, each side a fraction of it. */
export interface Rect {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** Cells as a bitmask: upper left 1, upper right 2, lower left 4, lower right 8. */
export type Cells = number;

const upperLeft = 1;
const upperRight = 2;
const lowerLeft = 4;
const lowerRight = 8;
const leftColumn = upperLeft | lowerLeft;
const rightColumn = upperRight | lowerRight;
const topRow = upperLeft | upperRight;
const bottomRow = lowerLeft | lowerRight;

/** Every cell: a pane alone in the window. */
export const allCells: Cells = 15;

/** Where a drop places a pane. */
export type Zone =
  | "left"
  | "right"
  | "top"
  | "bottom"
  | "upperLeft"
  | "upperRight"
  | "lowerLeft"
  | "lowerRight";

export const zoneCells: Record<Zone, Cells> = {
  left: leftColumn,
  right: rightColumn,
  top: topRow,
  bottom: bottomRow,
  upperLeft,
  upperRight,
  lowerLeft,
  lowerRight,
};

/** Each zone's name, marked with `msg`: show it with `t`. */
export const zoneNames: Record<Zone, string> = {
  left: msg("Left"),
  right: msg("Right"),
  top: msg("Top"),
  bottom: msg("Bottom"),
  upperLeft: msg("Upper left"),
  upperRight: msg("Upper right"),
  lowerLeft: msg("Lower left"),
  lowerRight: msg("Lower right"),
};

/** Where the grid's lines sit, as shares of the window. */
export interface GridCuts {
  x: number;
  y: number;
}

export const evenCuts: GridCuts = { x: evenRatio, y: evenRatio };

/** Whether `cells` make a rectangle: one cell, a side, a half, or all of them. */
export const isRect = (cells: Cells) => [1, 2, 4, 8, 3, 12, 5, 10, 15].includes(cells);

/** The box `cells` cover. */
export function rectOf(cells: Cells, { x, y }: GridCuts): Rect {
  const left = cells & leftColumn ? 0 : x;
  const right = cells & rightColumn ? 1 : x;
  const top = cells & topRow ? 0 : y;
  const bottom = cells & bottomRow ? 1 : y;
  return { left, top, width: right - left, height: bottom - top };
}

/**
 * What a pane keeps of its `cells` once `taken` goes to another. A pane alone that loses a corner
 * would be an L, so it keeps the column across from that corner.
 */
export function cellsLeft(cells: Cells, taken: Cells): Cells {
  const left = cells & ~taken;
  if (isRect(left) || !left) return left;
  return taken & leftColumn ? rightColumn : leftColumn;
}

/**
 * Who takes each of the `freed` cells of a closed pane, as each pane's cells. One pane takes them all
 * when that stays a rectangle, else they go cell by cell to the neighbor across, then the one above
 * or below.
 */
export function cellsFilled(panes: readonly Cells[], freed: Cells): Cells[] {
  const whole = panes.findIndex((cells) => isRect(cells | freed));
  if (whole !== -1) return panes.map((cells, i) => (i === whole ? cells | freed : cells));
  const next = [...panes];
  for (const cell of [upperLeft, upperRight, lowerLeft, lowerRight]) {
    if (!(freed & cell)) continue;
    const across = cell & leftColumn ? cell << 1 : cell >> 1;
    const atop = cell & topRow ? cell << 2 : cell >> 2;
    const taker = [across, atop]
      .map((neighbor) => next.findIndex((cells) => cells & neighbor && isRect(cells | cell)))
      .find((i) => i !== -1);
    if (taker !== undefined) next[taker]! |= cell;
  }
  return next;
}

/** The cell a new pane takes from a pane's `cells`: the right of a whole row, the lower of a column. */
export function cellSplit(cells: Cells): Cells {
  if (cells === allCells) return rightColumn;
  return cells & topRow && cells & bottomRow ? cells & bottomRow : cells & rightColumn;
}

/** `cuts` for panes on `cells`, with a line none of them use back at even, where a new one starts. */
export function usedCuts(cells: readonly Cells[], { x, y }: GridCuts): GridCuts {
  const splits = (side: Cells) => cells.some((c) => !(c & side) || !(c & (allCells & ~side)));
  return { x: splits(leftColumn) ? x : evenRatio, y: splits(topRow) ? y : evenRatio };
}

/** Whether two columns, and two rows, each keep `minTile` in a window `width` by `height` pixels. */
export function fits({ x, y }: GridCuts, width: number, height: number) {
  // Unmeasured, everything fits.
  if (width <= 0 || height <= 0) return { columns: true, rows: true };
  return {
    columns: Math.min(x, 1 - x) * width >= minTile.width,
    rows: Math.min(y, 1 - y) * height >= minTile.height,
  };
}

/** One tile: the cells it covers, and the panes, by index, that show in it. */
export interface Tile {
  cells: Cells;
  panes: number[];
}

/**
 * The tiles of panes on `cells`: one each, unless the columns or rows have no room, when what shared a
 * row or a column stacks together.
 */
export function tilesOf(
  cells: readonly Cells[],
  { columns, rows }: { columns: boolean; rows: boolean },
): Tile[] {
  const grown = (c: Cells) => {
    let next = c;
    if (!columns) {
      if (next & topRow) next |= topRow;
      if (next & bottomRow) next |= bottomRow;
    }
    if (!rows) {
      if (next & leftColumn) next |= leftColumn;
      if (next & rightColumn) next |= rightColumn;
    }
    return next;
  };
  const tiles: Tile[] = [];
  cells.forEach((c, i) => {
    let tile: Tile = { cells: grown(c), panes: [i] };
    // Anything this overlaps joins it, which may make it overlap more.
    for (let at = tiles.findIndex((t) => t.cells & tile.cells); at !== -1;) {
      const [other] = tiles.splice(at, 1);
      tile = { cells: other!.cells | tile.cells, panes: [...other!.panes, ...tile.panes] };
      at = tiles.findIndex((t) => t.cells & tile.cells);
    }
    tiles.push(tile);
  });
  return tiles.sort((a, b) => lowestCell(a.cells) - lowestCell(b.cells));
}

/** Cells' first in reading order, which orders panes and tiles. */
export const lowestCell = (cells: Cells) => cells & -cells;

/** A divider between tiles: which line it drags, and the part of that line it covers. */
export interface Divider {
  vertical: boolean;
  from: number;
  to: number;
}

/** The dividers between `tiles`. */
export function dividersOf(tiles: readonly Tile[], { x, y }: GridCuts): Divider[] {
  const tileAtCell = (cell: Cells) => tiles.find((t) => t.cells & cell);
  const dividers: Divider[] = [];
  const upper = tileAtCell(upperLeft) !== tileAtCell(upperRight);
  const lower = tileAtCell(lowerLeft) !== tileAtCell(lowerRight);
  if (upper || lower) dividers.push({ vertical: true, from: upper ? 0 : y, to: lower ? 1 : y });
  const leftSide = tileAtCell(upperLeft) !== tileAtCell(lowerLeft);
  const rightSide = tileAtCell(upperRight) !== tileAtCell(lowerRight);
  if (leftSide || rightSide)
    dividers.push({ vertical: false, from: leftSide ? 0 : x, to: rightSide ? 1 : x });
  return dividers;
}

/** `ratio` kept off the window's edges, so no tile gets too small to use. */
export const clampRatio = (ratio: number) => Math.min(1 - minRatio, Math.max(minRatio, ratio));

/** How far in from an edge a drop means that side, as a share of the window. */
const edge = 0.28;

/**
 * The zone a pointer at (`x`, `y`), as fractions of the window, drops in, or undefined for the middle.
 * A side with no room for two columns or rows doesn't count.
 */
export function zoneAt(
  x: number,
  y: number,
  { columns, rows }: { columns: boolean; rows: boolean },
): Zone | undefined {
  const side = !columns ? undefined : x < edge ? "left" : x > 1 - edge ? "right" : undefined;
  const end = !rows ? undefined : y < edge ? "top" : y > 1 - edge ? "bottom" : undefined;
  if (side && end) {
    const corner = `${end === "top" ? "upper" : "lower"}${side === "left" ? "Left" : "Right"}`;
    return corner as Zone;
  }
  return side ?? end;
}
