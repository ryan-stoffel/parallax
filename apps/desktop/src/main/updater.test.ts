import { expect, test } from "vite-plus/test";

import { notesText, updateError, updaterSettings } from "./updater";

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

test("release notes read as plain lines, without the Full Changelog line", () => {
  // As GitHub's releases feed has them.
  const html = `<h2>What&#39;s Changed</h2>
<ul>
<li>feat: show &lt;b&gt; tags &amp; more (RYA-1) by <a href="https://github.com/me">@me</a> in <a href="https://github.com/o/r/pull/1">#1</a></li>
</ul>
<p><strong>Full Changelog</strong>: <a href="https://github.com/o/r/compare/a...b"><tt>a...b</tt></a></p>`;
  expect(notesText(html)).toBe("What's Changed\n• feat: show <b> tags & more (RYA-1) by @me in #1");
  expect(notesText([{ version: "1", note: "<p>one</p>" }])).toBe("one");
  expect(notesText(null)).toBe("");
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
