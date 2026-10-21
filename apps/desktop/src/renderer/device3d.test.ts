import { expect, test } from "vite-plus/test";

import { appleModel } from "./device3d";

test("each iOS device gets Apple's model of it, and one Apple has none of gets none", () => {
  for (const [name, file] of [
    ["iPhone 17 Pro", "iphone-17-pro"],
    ["iPhone 17 Pro Max", "iphone-17-pro-max"],
    ["iPhone SE (3rd generation)", "iphone-se-3"],
    ["iPad Air 13-inch (M3)", "ipad-air-m4"],
    ["iPad Pro 13-inch (M5) (16GB)", "ipad-pro-m5"],
    ["iPad (A16)", "ipad-a16"],
    ["iPhone Duo", "iphone-duo"],
  ]) {
    expect(appleModel(name!)).toBe(`/src/renderer/assets/devices/${file}.glb`);
  }
  for (const none of ["iPhone 11 Pro Max", "iPad Pro 11-inch (M5)", "iPhone Xs", "Ryan's iPhone"]) {
    expect(appleModel(none)).toBeUndefined();
  }
});
