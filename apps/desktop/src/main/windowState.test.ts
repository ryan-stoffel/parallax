import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { expect, test } from "vite-plus/test";

import { readWindowState, writeWindowState } from "./windowState";

const file = () => path.join(mkdtempSync(path.join(tmpdir(), "window-state-")), "window.json");
const screen = { x: 0, y: 0, width: 1920, height: 1040 };

test("a saved window reopens where it was, maximized if it was", () => {
  const at = file();
  const state = { bounds: { x: 100, y: 50, width: 1400, height: 900 }, maximized: true };
  writeWindowState(at, state);
  expect(readWindowState(at, [screen])).toEqual(state);
});

test("a window whose top row is on no display opens at the default place", () => {
  const at = file();
  writeWindowState(at, { bounds: { x: 2200, y: 100, width: 1200, height: 800 }, maximized: false });
  expect(readWindowState(at, [screen])).toBeUndefined();
  const right = { x: 1920, y: 0, width: 2560, height: 1400 };
  expect(readWindowState(at, [screen, right])?.bounds.x).toBe(2200);
});

test("a window larger than its display, saved on a bigger one, fits the display", () => {
  const at = file();
  writeWindowState(at, { bounds: { x: 100, y: 0, width: 2400, height: 1300 }, maximized: false });
  expect(readWindowState(at, [screen])?.bounds).toEqual(screen);
  writeWindowState(at, { bounds: { x: 1000, y: 500, width: 1200, height: 800 }, maximized: false });
  expect(readWindowState(at, [screen])?.bounds).toEqual({
    x: 720,
    y: 240,
    width: 1200,
    height: 800,
  });
});

test("no file, or a malformed one, opens at the default place", () => {
  const at = file();
  expect(readWindowState(at, [screen])).toBeUndefined();
  writeFileSync(at, "{");
  expect(readWindowState(at, [screen])).toBeUndefined();
  writeFileSync(at, JSON.stringify({ bounds: { x: 0, y: 0, width: "wide" } }));
  expect(readWindowState(at, [screen])).toBeUndefined();
});
