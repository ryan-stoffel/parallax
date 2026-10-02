import { expect, test } from "vite-plus/test";

import { updateError, updaterSettings } from "./updater";

test("nightly takes nightly prereleases; standard takes Latest and may go back to it", () => {
  expect(updaterSettings("nightly")).toEqual({
    channel: "nightly",
    allowPrerelease: true,
    allowDowngrade: false,
  });
  expect(updaterSettings("release")).toEqual({
    channel: "latest",
    allowPrerelease: false,
    allowDowngrade: true,
  });
});

test("errors read as one line for people", () => {
  const error = (message: string, fields: object = {}) =>
    updateError(Object.assign(new Error(message), fields));
  // electron-updater wraps the request's error in its own.
  expect(
    error("Unable to find latest version on GitHub (…): net::ERR_INTERNET_DISCONNECTED", {
      code: "ERR_UPDATER_LATEST_VERSION_NOT_FOUND",
    }),
  ).toBe("Can't reach GitHub to check for updates.");
  expect(error("HttpError: 403 Forbidden\n{}")).toBe(
    "GitHub is limiting update checks. Parallax will try again.",
  );
  expect(error("x", { statusCode: 429 })).toBe(
    "GitHub is limiting update checks. Parallax will try again.",
  );
  // Squirrel.Mac, and electron-updater on Windows.
  expect(error("Code signature at URL file:///… did not pass validation")).toMatch(/signature/);
  expect(error("not signed", { code: "ERR_UPDATER_INVALID_SIGNATURE" })).toMatch(/signature/);
  expect(error("Cannot find nightly-mac.yml", { code: "ERR_UPDATER_CHANNEL_FILE_NOT_FOUND" })).toBe(
    "The newest release has no update for this computer.",
  );
  expect(error("No published versions", { code: "ERR_UPDATER_NO_PUBLISHED_VERSIONS" })).toBe(
    "There's no release on this channel yet.",
  );
  expect(error(`boom\n${"stack ".repeat(50)}`)).toBe("Update failed: boom");
  expect(error("x".repeat(200))).toHaveLength("Update failed: ".length + 120);
});
