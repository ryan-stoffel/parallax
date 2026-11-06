import { readFileSync, writeFileSync } from "node:fs";

import type { Rectangle } from "electron";

/** Where the window was and whether it filled the screen, which the next launch opens it as. */
type WindowState = { bounds: Rectangle; maximized: boolean };

/**
 * The state saved in `file`, or undefined when there's none, it's malformed, or the middle of its
 * top row, where it drags, is on none of `workAreas`, the displays' usable rectangles: a window
 * left on a display that's gone opens at the default place instead. A window larger than the
 * display it's on, saved on a bigger one, is made to fit it.
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
  const area = workAreas.find(
    (a) => x >= a.x && x < a.x + a.width && y >= a.y && y < a.y + a.height,
  );
  if (!area) return undefined;
  const width = Math.min(bounds.width, area.width);
  const height = Math.min(bounds.height, area.height);
  const fitted = {
    x: Math.min(Math.max(bounds.x, area.x), area.x + area.width - width),
    y: Math.min(Math.max(bounds.y, area.y), area.y + area.height - height),
    width,
    height,
  };
  return { bounds: fitted, maximized: maximized === true };
}

/** Saves `state` to `file`. Unwritable: the next launch opens at the default place. */
export function writeWindowState(file: string, state: WindowState): void {
  try {
    writeFileSync(file, `${JSON.stringify(state)}\n`);
  } catch {
    // Nothing to do.
  }
}
