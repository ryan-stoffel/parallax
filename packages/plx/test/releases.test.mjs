// @ts-check
import assert from "node:assert/strict";
import test from "node:test";

import { pickAsset, pickRelease, withSha256 } from "../src/releases.mjs";

/** Each asset's GitHub digest, made up from its name. @param {string} name */
const digest = (name) => `sha256:${Buffer.from(name).toString("hex").padEnd(64, "0").slice(0, 64)}`;

/** @param {string} tag @param {boolean} prerelease @param {string[]} names */
const release = (tag, prerelease, names, draft = false) => ({
  tag_name: tag,
  prerelease,
  draft,
  assets: names.map((name) => ({ name, browser_download_url: `https://github.com/dl/${tag}/${name}`, digest: digest(name) })),
});

const nightly = "2610.10522.11930-nightly";
const newestNightly = release(`v${nightly}`, true, [
  "nightly-mac.yml",
  `parallax-${nightly}-mac-arm64.dmg`,
  `parallax-${nightly}-mac-arm64.zip`,
  `parallax-${nightly}-win-arm64.exe`,
  `parallax-${nightly}-win-arm64.exe.blockmap`,
  `parallax-${nightly}-win-x64.exe`,
  `parallax-plxd-${nightly}-mac-arm64`,
  `parallax-plxd-${nightly}-win-arm64.exe`,
  `parallax-plxd-${nightly}-win-x64.exe`,
]);
const stable = release("v2609.10101.10000", false, [
  "parallax-2609.10101.10000-mac-arm64.dmg",
  "parallax-2609.10101.10000-linux-x86_64.AppImage",
  "parallax-plxd-2609.10101.10000-linux-x64",
  "parallax-plxd-2609.10101.10000-linux-arm64",
]);
const releases = [release("v2610.1.1-nightly", true, [], true), newestNightly, stable];

test("picks the newest non-draft release of each channel", () => {
  assert.equal(pickRelease(releases, "nightly"), newestNightly);
  assert.equal(pickRelease(releases, "stable"), stable);
});

test("picks each OS's installer, or plxd alone when headless", () => {
  assert.equal(pickAsset(newestNightly, "macos", "arm64").name, `parallax-${nightly}-mac-arm64.dmg`);
  assert.equal(pickAsset(newestNightly, "windows", "x64").name, `parallax-${nightly}-win-x64.exe`);
  assert.deepEqual(pickAsset(newestNightly, "windows", "arm64"), {
    version: nightly,
    name: `parallax-${nightly}-win-arm64.exe`,
    url: `https://github.com/dl/v${nightly}/parallax-${nightly}-win-arm64.exe`,
    sha256: digest(`parallax-${nightly}-win-arm64.exe`).slice(7),
  });
  assert.equal(pickAsset(stable, "linux", "x64").name, "parallax-plxd-2609.10101.10000-linux-x64");
  assert.equal(pickAsset(stable, "linux", "arm64").name, "parallax-plxd-2609.10101.10000-linux-arm64");
  // An AppImage alone isn't enough: running it to unpack plxd fails on NixOS.
  const appImageOnly = release("v1.0.0", false, ["parallax-1.0.0-linux-x86_64.AppImage"]);
  assert.throws(() => pickAsset(appImageOnly, "linux", "x64"), /has no Linux x64 build/);
  // Headless picks plxd alone on macOS and Windows, and Linux is the same either way.
  assert.equal(pickAsset(newestNightly, "macos", "arm64", true).name, `parallax-plxd-${nightly}-mac-arm64`);
  assert.equal(pickAsset(newestNightly, "windows", "x64", true).name, `parallax-plxd-${nightly}-win-x64.exe`);
  assert.equal(pickAsset(newestNightly, "windows", "arm64", true).name, `parallax-plxd-${nightly}-win-arm64.exe`);
  assert.deepEqual(pickAsset(stable, "linux", "x64", true), pickAsset(stable, "linux", "x64"));
  assert.throws(() => pickAsset(stable, "windows", "x64", true), /v2609\.10101\.10000, has no Windows x64 plxd/);
  assert.throws(() => pickAsset(newestNightly, "macos", "x64", true), /no build for Intel Macs/);
});

test("the SHA-256 is GitHub's digest, else the .sha256 asset's, else nothing installs", async () => {
  const name = "parallax-plxd-1.0.0-linux-x64";
  const hex = "a".repeat(64);
  const asset = (/** @type {string} */ n, /** @type {string | null} */ d = null) => ({ name: n, browser_download_url: `https://dl/${n}`, digest: d });
  const fetched = /** @type {string[]} */ ([]);
  const fetchText = async (/** @type {string} */ url) => {
    fetched.push(url);
    return `${"b".repeat(64)}  other\n${hex.toUpperCase()}  ${name}\n`;
  };

  const withDigest = pickAsset(release("v1.0.0", false, [name]), "linux", "x64");
  assert.equal((await withSha256(withDigest, fetchText)).sha256, digest(name).slice(7));
  assert.deepEqual(fetched, []);

  const withSums = pickAsset({ tag_name: "v1.0.0", prerelease: false, assets: [asset(name), asset(`${name}.sha256`)] }, "linux", "x64");
  assert.deepEqual(await withSha256(withSums, fetchText), {
    version: "1.0.0",
    name,
    url: `https://dl/${name}`,
    sha256: hex,
  });
  assert.deepEqual(fetched, [`https://dl/${name}.sha256`]);

  const neither = pickAsset({ tag_name: "v1.0.0", prerelease: false, assets: [asset(name)] }, "linux", "x64");
  await assert.rejects(withSha256(neither, fetchText), {
    message: `The release has no SHA-256 for ${name}, so plx-connect won't install it.`,
  });
  // A .sha256 that doesn't list the file is no checksum either.
  await assert.rejects(withSha256(withSums, async () => `${hex}  something-else\n`), /no SHA-256/);
});
