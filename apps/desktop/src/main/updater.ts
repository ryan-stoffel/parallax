import { app } from "electron";
import { autoUpdater, type UpdateInfo } from "electron-updater";

import type { UpdateState } from "../preload/bridge";

/** Whether this build is a nightly (0030): its version's prerelease identifier is `nightly`. */
export const isNightly = (version: string) => version.includes("-nightly");

/**
 * electron-updater's settings for the build's own channel (0028). A nightly takes the newest
 * GitHub prerelease whose version's first prerelease identifier is `nightly`, from its
 * `nightly*.yml`; any other build the release marked Latest, from its `latest*.yml`.
 */
export function updaterSettings(version: string) {
  const nightly = isNightly(version);
  return {
    channel: nightly ? "nightly" : "latest",
    allowPrerelease: nightly,
    allowDowngrade: false,
  };
}

const entities: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', "#39": "'" };

/**
 * A release's notes as plain text, one line per paragraph or list item. electron-updater reads
 * them from GitHub's releases feed as HTML. The "Full Changelog" line is left out: the update's
 * popover links the release instead.
 */
export function notesText(notes: UpdateInfo["releaseNotes"]): string {
  const html = typeof notes === "string" ? notes : (notes ?? []).map((n) => n.note).join("\n");
  return html
    .replace(/<li>/g, "• ")
    .replace(/<\/(p|li|h\d)>|<br\s*\/?>/g, "\n")
    .replace(/<[^>]*>/g, "")
    .replace(/&(amp|lt|gt|quot|#39);/g, (_, name: string) => entities[name]!)
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("Full Changelog"))
    .join("\n");
}

const releasePage = (version: string) =>
  `https://github.com/ryan-stoffel/parallax/releases/tag/v${version}`;

// Chromium's errors for a request that never reached GitHub.
const offline =
  /net::ERR_(INTERNET_DISCONNECTED|NAME_NOT_RESOLVED|NETWORK_|CONNECTION_|ADDRESS_|TIMED_OUT)/;
const rateLimited = /\b(403 Forbidden|429 Too Many Requests)\b/;
const noUpdateFile = ["ERR_UPDATER_CHANNEL_FILE_NOT_FOUND", "ERR_UPDATER_ZIP_FILE_NOT_FOUND"];
const noRelease = ["ERR_UPDATER_NO_PUBLISHED_VERSIONS", "ERR_UPDATER_LATEST_VERSION_NOT_FOUND"];

/** One short line for people about an error from electron-updater or Squirrel.Mac. */
export function updateError(error: Error & { code?: string; statusCode?: number }): string {
  // electron-updater wraps the request's error in its own, so the message is checked first.
  const { message, code = "", statusCode } = error;
  if (offline.test(message)) return "Can't reach GitHub to check for updates.";
  if (statusCode === 403 || statusCode === 429 || rateLimited.test(message))
    return "GitHub is limiting update checks. Parallax will try again.";
  if (code === "ERR_UPDATER_INVALID_SIGNATURE" || /code signature/i.test(message))
    return "The update's signature doesn't match this app's, so it can't be installed.";
  if (noUpdateFile.includes(code)) return "The newest release has no update for this computer.";
  if (noRelease.includes(code)) return "There's no release on this channel yet.";
  const line = message.split("\n")[0] ?? "";
  return `Update failed: ${line.length > 120 ? `${line.slice(0, 119)}…` : line}`;
}

/**
 * The packaged app's updater (PLX-68, PLX-286): checks the build's channel (see `updaterSettings`)
 * through the `app-update.yml` electron-builder packs. A newer release shows on the Update button
 * with its notes; `update` downloads it, publishing the progress, and once it's downloaded
 * installs it, which also happens when Parallax quits. `publish` gets what the Update button
 * shows on every change. It checks at start, every 30 min, and on `checkSoon` at most every 10 s,
 * until a download starts. The checks read github.com's releases feed and download URLs, not the
 * REST API, so they spend no API quota (PLX-211).
 */
export function startUpdater(publish: (state: UpdateState) => void) {
  // Updates replace the AppImage file; an unpacked Linux build has nothing to replace.
  const unsupported =
    process.platform === "linux" && !process.env["APPIMAGE"]
      ? "Updates work only in the AppImage."
      : undefined;
  // The newest release found, the download's percent while it runs, and the version downloaded
  // and ready to install.
  let available: UpdateState["available"];
  let progress: number | undefined;
  let downloaded: string | undefined;
  let checkedAt = 0;

  const check = () => {
    if (unsupported || progress !== undefined || downloaded) return;
    checkedAt = Date.now();
    // Its errors also reach the "error" event below.
    autoUpdater.checkForUpdates().catch(() => {});
  };

  // `note` is the latest check's or download's line.
  const show = (note?: string) =>
    publish({
      ...(available && { available }),
      ...(progress !== undefined && { progress }),
      ...(downloaded !== undefined && { ready: `Parallax ${downloaded} to install` }),
      ...(note !== undefined && { note }),
    });

  // Setting `channel` also sets allowDowngrade, so the settings go in this order.
  const settings = updaterSettings(app.getVersion());
  autoUpdater.channel = settings.channel;
  autoUpdater.allowPrerelease = settings.allowPrerelease;
  autoUpdater.allowDowngrade = settings.allowDowngrade;
  // Downloads wait for a click. autoInstallOnAppQuit, the default, installs a download on quit.
  autoUpdater.autoDownload = false;
  autoUpdater.on("update-available", ({ version, releaseNotes }) => {
    // A check that was in flight when a download started doesn't replace what's downloading.
    if (version === available?.version || progress !== undefined || downloaded) return;
    available = { version, notes: notesText(releaseNotes), url: releasePage(version) };
    show();
  });
  autoUpdater.on("update-not-available", () => {
    if (progress !== undefined || downloaded) return;
    available = undefined;
    show();
  });
  autoUpdater.on("download-progress", ({ percent }) => {
    progress = Math.floor(percent);
    show();
  });
  autoUpdater.on("update-downloaded", ({ version }) => {
    downloaded = version;
    progress = undefined;
    show();
  });
  autoUpdater.on("error", (error: Error) => {
    // Squirrel.Mac's own errors (they carry an NSError `domain`), such as a signature it rejects,
    // mean the download won't install. A failed check leaves it waiting.
    if ("domain" in error) downloaded = undefined;
    show(updateError(error));
  });
  if (unsupported) publish({ note: unsupported });
  void app.whenReady().then(check);
  setInterval(check, 30 * 60_000);

  return {
    /** A window came to the front. */
    checkSoon() {
      if (Date.now() - checkedAt > 10_000) check();
    },
    /**
     * The Update button: installs what's downloaded, else downloads what's available, else checks
     * now. Resolves to one line.
     */
    async update(): Promise<string> {
      if (unsupported) return unsupported;
      if (downloaded) {
        // After the answer reaches the window.
        setTimeout(() => autoUpdater.quitAndInstall(), 100);
        return `Restarting to install Parallax ${downloaded}…`;
      }
      if (available) {
        if (progress === undefined) {
          progress = 0;
          show();
          // A failed download ends here, after the "error" event; a failed check doesn't.
          autoUpdater.downloadUpdate().catch((error: Error) => {
            progress = undefined;
            show(updateError(error));
          });
        }
        return `Downloading Parallax ${available.version}…`;
      }
      checkedAt = Date.now();
      try {
        const result = await autoUpdater.checkForUpdates();
        if (!result?.isUpdateAvailable) return "Up to date";
        return `Parallax ${result.updateInfo.version} is available`;
      } catch (error) {
        return updateError(error as Error);
      }
    },
  };
}
