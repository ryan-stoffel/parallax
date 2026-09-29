import { expect, test } from "vite-plus/test";

import { frameOptions, titleBarOverlay, windowBackground } from "./frame";

test("Windows' window buttons take the theme's foreground on a clear background", () => {
  expect(titleBarOverlay("win32", true)).toEqual({
    color: "#0d0d0f00",
    symbolColor: "#ececef",
    height: 52,
  });
  expect(titleBarOverlay("win32", false)).toEqual({
    color: "#ffffff00",
    symbolColor: "#18181b",
    height: 52,
  });
});

test("the overlay's color is the window's background, fully transparent", () => {
  for (const dark of [true, false])
    expect(titleBarOverlay("win32", dark)?.color).toBe(`${windowBackground(dark)}00`);
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
