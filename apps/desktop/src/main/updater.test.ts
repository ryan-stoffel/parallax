import { expect, test } from "vite-plus/test";

import { isDev, updaterSettings } from "./updater";

test("a nightly build takes nightly prereleases; any other takes Latest, a dev build its repo's", () => {
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
  // electron-updater's private provider reads only `latest*.yml` from the newest Latest.
  expect(updaterSettings("2611.11111.12312-dev")).toEqual({
    channel: "latest",
    allowPrerelease: false,
    allowDowngrade: false,
  });
});

test("only a version ending in -dev is a dev build", () => {
  expect(isDev("2611.11111.12312-dev")).toBe(true);
  expect(isDev("2611.11111.12312-nightly")).toBe(false);
  expect(isDev("0.0.0")).toBe(false);
});
