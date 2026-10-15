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
 * @property {Asset[]} assets
 */

/**
 * @typedef {object} Asset
 * @property {string} name
 * @property {string} browser_download_url
 * @property {string | null} [digest] GitHub's `sha256:<hex>` of the file, on assets uploaded since
 *   mid-2025.
 */

/**
 * @typedef {object} Installer What an install script downloads.
 * @property {string} version The release's version: its tag without the `v`.
 * @property {string} name The asset's file name.
 * @property {string} url Where to download it.
 * @property {string} sha256 Its SHA-256 as the release reports it, in hex. The script refuses a
 *   file that doesn't match.
 */

/**
 * @typedef {Omit<Installer, "sha256"> & { sha256?: string, sha256Url?: string }} Found
 *   An asset {@link pickAsset} chose: with its SHA-256 from GitHub's digest, or where its
 *   `.sha256` asset is, or neither. {@link withSha256} makes it an {@link Installer}.
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
 * The asset in `release` for `os` and `arch`: the dmg on macOS (arm64 only) and the NSIS exe on
 * Windows, or with `headless`, plxd by itself (`parallax-plxd-<v>-mac-arm64`,
 * `parallax-plxd-<v>-win-<arch>.exe`). Linux always gets plxd by itself (PLX-642's asset), which
 * runs where the AppImage's runtime can't, such as NixOS. Throws a message for people when the
 * release has none.
 * @param {Release} release
 * @param {Os} os
 * @param {Arch} arch
 * @param {boolean} [headless]
 * @returns {Found}
 */
export function pickAsset(release, os, arch, headless = false) {
  const version = release.tag_name.replace(/^v/, "");
  if (os === "macos" && arch !== "arm64") throw new Error("Parallax has no build for Intel Macs, only Apple silicon.");
  const plxdOnly = os === "linux" || headless;
  const tag = { macos: "mac", windows: "win", linux: "linux" }[os];
  const name = plxdOnly
    ? `parallax-plxd-${version}-${tag}-${arch}${os === "windows" ? ".exe" : ""}`
    : `parallax-${version}-${tag}-${arch}.${os === "macos" ? "dmg" : "exe"}`;
  const asset = release.assets.find((a) => a.name === name);
  if (!asset) {
    const kind = release.prerelease ? "nightly" : "release";
    const what = plxdOnly && os !== "linux" ? "plxd" : "build";
    throw new Error(`The newest ${kind}, ${release.tag_name}, has no ${OS_NAMES[os]} ${arch} ${what}.`);
  }
  const digest = /^sha256:([0-9a-f]{64})$/i.exec(asset.digest ?? "")?.[1]?.toLowerCase();
  const sums = release.assets.find((a) => a.name === `${name}.sha256`);
  return {
    version,
    name,
    url: asset.browser_download_url,
    ...(digest ? { sha256: digest } : sums && { sha256Url: sums.browser_download_url }),
  };
}

/**
 * `found` with its SHA-256: GitHub's digest, else the hash its `.sha256` asset lists for it
 * (`<hex>  <name>`, as `shasum -a 256` writes). Throws a message for people when there's neither,
 * so nothing is installed unchecked.
 * @param {Found} found
 * @param {(url: string) => Promise<string>} [fetchText]
 * @returns {Promise<Installer>}
 */
export async function withSha256({ sha256Url, ...found }, fetchText = fetchUrl) {
  if (found.sha256) return { ...found, sha256: found.sha256 };
  const listed = sha256Url
    ? (await fetchText(sha256Url))
        .split(/\r?\n/)
        .map((line) => /^([0-9a-f]{64}) [ *]?(.+)$/i.exec(line.trim()))
        .find((m) => m?.[2] === found.name)?.[1]
    : undefined;
  if (!listed) throw new Error(`The release has no SHA-256 for ${found.name}, so plx-connect won't install it.`);
  return { ...found, sha256: listed.toLowerCase() };
}

/** The text at `url`. @param {string} url */
async function fetchUrl(url) {
  const response = await fetch(url, { headers: { "user-agent": "plx-connect" }, signal: AbortSignal.timeout(20_000) });
  if (!response.ok) throw new Error(`GitHub answered ${response.status} ${response.statusText} for ${url}.`);
  return response.text();
}
