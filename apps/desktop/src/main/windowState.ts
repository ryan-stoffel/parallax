import { readFileSync, writeFileSync } from "node:fs";

import type { Rectangle } from "electron";

/** Where the window was and whether it filled the screen, which the next launch opens it as. */
export type WindowState = { bounds: Rectangle; maximized: boolean };

/**
 * The state saved in `file`, or undefined when there's none, it's malformed, or the middle of its
 * top row, where it drags, is on none of `workAreas`, the displays' usable rectangles: a window
 * left on a display that's gone opens at the default place instead.
 */
export function readWindowState(file: string, workAreas: Rectangle[]): WindowState | undefined {
  let state: Partial<WindowState>;
  try {
    state = JSON.parse(readFileSync(file, "utf8")) as Partial<WindowState>;
  } catch {
    return undefined;
  }
  const { bounds, maximized } = state;
  const sides = [bounds?.x, bounds?.y, bounds?.width, bounds?.height];
  if (!bounds || !sides.every((n) => typeof n === "number" && Number.isFinite(n))) return undefined;
  const x = bounds.x + bounds.width / 2;
  const y = bounds.y + 16;
  const shown = workAreas.some(
    (a) => x >= a.x && x < a.x + a.width && y >= a.y && y < a.y + a.height,
  );
  return shown ? { bounds, maximized: maximized === true } : undefined;
}

/** Saves `state` to `file`. Unwritable: the next launch opens at the default place. */
export function writeWindowState(file: string, state: WindowState): void {
  try {
    writeFileSync(file, `${JSON.stringify(state)}\n`);
  } catch {
    // Nothing to do.
  }
}
