import { expect, test } from "vite-plus/test";

import { frameOptions, titleBarOverlay, windowBackground } from "./frame";

test("Windows' window buttons take the theme's foreground on a clear background", () => {
  expect(titleBarOverlay("win32", true)).toEqual({
    color: "#0a0a0a00",
    symbolColor: "#ededed",
    height: 52,
  });
  expect(titleBarOverlay("win32", false)).toEqual({
    color: "#ffffff00",
    symbolColor: "#1e1b4b",
    height: 52,
  });
});

test("the overlay's color is the window's background, fully transparent", () => {
  for (const dark of [true, false])
    expect(titleBarOverlay("win32", dark)?.color).toBe(`${windowBackground(dark)}00`);
});

test("the overlay is as tall as the top row at the page's zoom", () => {
  expect(titleBarOverlay("win32", true, 1.5)?.height).toBe(78);
  expect(titleBarOverlay("win32", true, 0.9)?.height).toBe(47);
});

test("only Windows gets an overlay", () => {
  for (const platform of ["darwin", "linux"]) {
    expect(titleBarOverlay(platform, true)).toBeUndefined();
    expect(titleBarOverlay(platform, false)).toBeUndefined();
  }
});

test("Windows hides its title bar and draws the buttons over the app's top row", () => {
  expect(frameOptions("win32", true)).toEqual({
    titleBarStyle: "hidden",
    titleBarOverlay: titleBarOverlay("win32", true),
  });
});

test("macOS keeps the inset traffic lights and Linux the native frame", () => {
  for (const dark of [true, false]) {
    expect(frameOptions("darwin", dark)).toEqual({
      titleBarStyle: "hiddenInset",
      trafficLightPosition: { x: 16, y: 19 },
    });
    expect(frameOptions("linux", dark)).toEqual({ autoHideMenuBar: true });
  }
});
