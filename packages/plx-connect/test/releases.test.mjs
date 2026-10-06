// @ts-check
import assert from "node:assert/strict";
import test from "node:test";

import { pickAsset, pickRelease } from "../src/releases.mjs";

/** @param {string} tag @param {boolean} prerelease @param {string[]} names */
const release = (tag, prerelease, names, draft = false) => ({
  tag_name: tag,
  prerelease,
  draft,
  assets: names.map((name) => ({ name, browser_download_url: `https://github.com/dl/${tag}/${name}` })),
});

const nightly = "2610.10522.11930-nightly";
const newestNightly = release(`v${nightly}`, true, [
  "nightly-mac.yml",
  `parallax-${nightly}-mac-arm64.dmg`,
  `parallax-${nightly}-mac-arm64.zip`,
  `parallax-${nightly}-win-arm64.exe`,
  `parallax-${nightly}-win-arm64.exe.blockmap`,
  `parallax-${nightly}-win-x64.exe`,
]);
const stable = release("v2609.10101.10000", false, [
  "parallax-2609.10101.10000-mac-arm64.dmg",
  "parallax-2609.10101.10000-linux-x86_64.AppImage",
  "parallax-2609.10101.10000-linux-arm64.AppImage",
]);
const releases = [release("v2610.1.1-nightly", true, [], true), newestNightly, stable];

test("picks the newest non-draft release of each channel", () => {
  assert.equal(pickRelease(releases, "nightly"), newestNightly);
  assert.equal(pickRelease(releases, "stable"), stable);
});

test("with no stable release, says so and suggests nightly", () => {
  assert.throws(() => pickRelease([newestNightly], "stable"), /no stable release yet\. Run again with --channel nightly/);
});

test("picks each OS's installer", () => {
  assert.equal(pickAsset(newestNightly, "macos", "arm64").name, `parallax-${nightly}-mac-arm64.dmg`);
  assert.equal(pickAsset(newestNightly, "windows", "x64").name, `parallax-${nightly}-win-x64.exe`);
  assert.deepEqual(pickAsset(newestNightly, "windows", "arm64"), {
    version: nightly,
    name: `parallax-${nightly}-win-arm64.exe`,
    url: `https://github.com/dl/v${nightly}/parallax-${nightly}-win-arm64.exe`,
  });
  assert.equal(pickAsset(stable, "linux", "x64").name, "parallax-2609.10101.10000-linux-x86_64.AppImage");
  assert.equal(pickAsset(stable, "linux", "arm64").name, "parallax-2609.10101.10000-linux-arm64.AppImage");
  const x64 = release("v1.0.0", false, ["parallax-1.0.0-linux-x64.AppImage"]);
  assert.equal(pickAsset(x64, "linux", "x64").name, "parallax-1.0.0-linux-x64.AppImage");
});

test("a missing build is an error that names the release, OS, and arch", () => {
  assert.throws(() => pickAsset(newestNightly, "linux", "x64"), {
    message: `The newest nightly, v${nightly}, has no Linux x64 build.`,
  });
  assert.throws(() => pickAsset(stable, "windows", "x64"), /The newest release, v2609\.10101\.10000, has no Windows x64 build/);
  assert.throws(() => pickAsset(stable, "macos", "x64"), /no build for Intel Macs/);
});
