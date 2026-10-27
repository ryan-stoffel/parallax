// Where the split's threads tile (PLX-1082): a Fibonacci (dwindle) layout, in which each thread
// takes its share of what the ones before it left, cutting side by side, then top and bottom, in
// turn. Two threads are left | right; a third splits the right; a fourth splits the bottom.

/** The most threads a split holds. */
export const maxTiles = 4;

/** The share of a cut the first tile gets until a divider is dragged. */
export const evenRatio = 0.5;

/**
 * The smallest a tile gets, in pixels: room for its header, a few lines of transcript, and a
 * compact composer. Threads past the tiles that fit stack as tabs in the last one.
 */
export const minTile = { width: 320, height: 360 };

/** How far a divider can be dragged, as a share of the region it cuts. */
const minRatio = 0.2;

/** A box in the split, each side a fraction of it. */
export interface Rect {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** A cut between a tile and the tiles after it, which a divider drags. */
export interface Cut {
  /** Side by side, cut by a vertical line, or top and bottom. */
  vertical: boolean;
  /** The region it cuts: its tile and every tile after it. */
  region: Rect;
}

/** Whether cut `i` puts its tile beside the rest (even cuts) or above them (odd cuts). */
const isVertical = (i: number) => i % 2 === 0;

/**
 * The rects of `count` tiles, in order, and the cuts between them. `ratios[i]` is the share of
 * cut `i`'s region its tile takes; a missing one is even.
 */
export function tileLayout(
  count: number,
  ratios: readonly number[],
): { tiles: Rect[]; cuts: Cut[] } {
  const tiles: Rect[] = [];
  const cuts: Cut[] = [];
  let region: Rect = { left: 0, top: 0, width: 1, height: 1 };
  for (let i = 0; i < count - 1; i++) {
    const vertical = isVertical(i);
    const ratio = ratios[i] ?? evenRatio;
    cuts.push({ vertical, region });
    if (vertical) {
      const width = region.width * ratio;
      tiles.push({ ...region, width });
      region = { ...region, left: region.left + width, width: region.width - width };
    } else {
      const height = region.height * ratio;
      tiles.push({ ...region, height });
      region = { ...region, top: region.top + height, height: region.height - height };
    }
  }
  if (count > 0) tiles.push(region);
  return { tiles, cuts };
}

/** `ratio` kept off its region's edges, so no tile gets too small to use. */
export const clampRatio = (ratio: number) => Math.min(1 - minRatio, Math.max(minRatio, ratio));

/** Cut `cut`'s ratio for a pointer at (`x`, `y`), as fractions of the split, kept off its edges. */
export function ratioAt({ vertical, region }: Cut, x: number, y: number): number {
  return clampRatio(vertical ? (x - region.left) / region.width : (y - region.top) / region.height);
}

/** The tile at (`x`, `y`), as fractions of the split, or the last one when none is. */
export function tileAt(tiles: readonly Rect[], x: number, y: number): number {
  const at = tiles.findIndex(
    (t) => x >= t.left && x < t.left + t.width && y >= t.top && y < t.top + t.height,
  );
  return at === -1 ? tiles.length - 1 : at;
}

/**
 * How many of `count` threads tile in a split `width` by `height` pixels, the most whose tiles all
 * keep `minTile`, at least one. The rest stack in the last tile. Unmeasured, all of them.
 */
export function fittingTiles(
  count: number,
  ratios: readonly number[],
  width: number,
  height: number,
): number {
  if (width <= 0 || height <= 0) return count;
  for (let k = count; k > 1; k--) {
    const { tiles } = tileLayout(k, ratios);
    if (tiles.every((t) => t.width * width >= minTile.width && t.height * height >= minTile.height))
      return k;
  }
  return 1;
}

/** The ratios once tile `index` of `count` closes: its cut goes, or the last one for the last tile. */
export function ratiosWithout(ratios: readonly number[], count: number, index: number): number[] {
  const gone = Math.min(index, count - 2);
  return ratios.filter((_, i) => i !== gone);
}
