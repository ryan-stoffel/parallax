// @ts-check
// Which Parallax installer to download, from the repo's GitHub Releases (0028, 0029, 0030).

/** @typedef {"stable" | "nightly"} Channel */
/** @typedef {"macos" | "linux" | "windows"} Os */
/** @typedef {"arm64" | "x64"} Arch */

/**
 * @typedef {object} Release The fields plx-connect reads from GitHub's release list.
 * @property {string} tag_name
 * @property {boolean} prerelease
 * @property {boolean} [draft]
 * @property {{ name: string, browser_download_url: string }[]} assets
 */

/**
 * @typedef {object} Installer
 * @property {string} version The release's version: its tag without the `v`.
 * @property {string} name The asset's file name.
 * @property {string} url Where to download it.
 */

export const RELEASES_URL = "https://api.github.com/repos/ryan-stoffel/parallax/releases?per_page=30";

const OS_NAMES = { macos: "macOS", linux: "Linux", windows: "Windows" };

/** The app's name for a channel: a nightly build is "Parallax (Nightly)" (PLX-286). @param {Channel} channel */
export const appName = (channel) => (channel === "nightly" ? "Parallax (Nightly)" : "Parallax");

/** The release list, newest first, from GitHub's API. */
export async function fetchReleases() {
  const response = await fetch(RELEASES_URL, {
    headers: { accept: "application/vnd.github+json", "user-agent": "plx-connect" },
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) throw new Error(`GitHub answered ${response.status} ${response.statusText} for the release list.`);
  return /** @type {Release[]} */ (await response.json());
}

/**
 * The newest release of `channel` in `releases` (GitHub lists newest first): for nightly, a
 * prerelease tagged `*-nightly`; for stable, any release that isn't a prerelease. Throws a message
 * for people when there's none.
 * @param {Release[]} releases
 * @param {Channel} channel
 */
export function pickRelease(releases, channel) {
  const release = releases.find(
    (r) => !r.draft && (channel === "nightly" ? r.prerelease && r.tag_name.endsWith("-nightly") : !r.prerelease),
  );
  if (release) return release;
  if (channel === "stable") throw new Error("Parallax has no stable release yet. Run again with --channel nightly.");
  throw new Error("Parallax has no nightly release.");
}

/**
 * The installer in `release` for `os` and `arch`: the dmg on macOS (arm64 only), the NSIS exe on
 * Windows, the AppImage on Linux (`x86_64` is electron-builder's AppImage name for x64; `x64` is
 * accepted too). Throws a message for people when the release has none.
 * @param {Release} release
 * @param {Os} os
 * @param {Arch} arch
 * @returns {Installer}
 */
export function pickAsset(release, os, arch) {
  const version = release.tag_name.replace(/^v/, "");
  const prefix = `parallax-${version}`;
  /** @type {string[]} */
  let names;
  if (os === "macos") {
    if (arch !== "arm64") throw new Error("Parallax has no build for Intel Macs, only Apple silicon.");
    names = [`${prefix}-mac-arm64.dmg`];
  } else if (os === "windows") {
    names = [`${prefix}-win-${arch}.exe`];
  } else {
    names = arch === "x64" ? [`${prefix}-linux-x86_64.AppImage`, `${prefix}-linux-x64.AppImage`] : [`${prefix}-linux-arm64.AppImage`];
  }
  const asset = release.assets.find((a) => names.includes(a.name));
  if (!asset) {
    const kind = release.prerelease ? "nightly" : "release";
    throw new Error(`The newest ${kind}, ${release.tag_name}, has no ${OS_NAMES[os]} ${arch} build.`);
  }
  return { version, name: asset.name, url: asset.browser_download_url };
}
