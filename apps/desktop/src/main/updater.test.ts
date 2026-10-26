import { expect, test } from "vite-plus/test";

import { updaterSettings } from "./updater";

test("a nightly build takes nightly prereleases; any other takes Latest", () => {
  expect(updaterSettings("2610.10205.13230-nightly")).toEqual({
    channel: "nightly",
    allowPrerelease: true,
    allowDowngrade: false,
  });
  expect(updaterSettings("2610.10205.13230")).toEqual({
    channel: "latest",
    allowPrerelease: false,
    allowDowngrade: false,
  });
});
