import { autoUpdater } from "electron-updater";

import type { UpdateChannel, UpdateState } from "../preload/bridge";

/**
 * electron-updater's settings for a channel (0028). Nightly takes the newest GitHub prerelease
 * whose version's first prerelease identifier is `nightly`, from its `nightly*.yml`; Standard the
 * release marked Latest, from its `latest*.yml`, and may go back to it from a newer nightly.
 */
export function updaterSettings(channel: UpdateChannel) {
  return channel === "nightly"
    ? { channel: "nightly", allowPrerelease: true, allowDowngrade: false }
    : { channel: "latest", allowPrerelease: false, allowDowngrade: true };
}

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
    return "GitHub is limiting update checks. wisp will try again.";
  if (code === "ERR_UPDATER_INVALID_SIGNATURE" || /code signature/i.test(message))
    return "The update's signature doesn't match this app's, so it can't be installed.";
  if (noUpdateFile.includes(code)) return "The newest release has no update for this computer.";
  if (noRelease.includes(code)) return "There's no release on this channel yet.";
  const line = message.split("\n")[0] ?? "";
  return `Update failed: ${line.length > 120 ? `${line.slice(0, 119)}…` : line}`;
}

/**
 * The packaged app's updater (RYA-68): checks the channel's GitHub releases (see
 * `updaterSettings`) through the `app-update.yml` electron-builder packs, downloads what it finds
 * in the background, and installs it when Update is clicked or wisp quits. `publish` gets what the
 * Update button shows on every change. Nothing is checked until `follow` names a channel; then it
 * checks every minute, and on `checkSoon` at most every 10 s, while nothing is downloaded yet.
 */
export function startUpdater(publish: (state: UpdateState) => void) {
  // Updates replace the AppImage file; an unpacked Linux build has nothing to replace.
  const unsupported =
    process.platform === "linux" && !process.env["APPIMAGE"]
      ? "Updates work only in the AppImage."
      : undefined;
  // The version downloaded and ready to install.
  let downloaded: string | undefined;
  let following = false;
  let checkedAt = 0;

  const check = () => {
    if (!following || unsupported) return;
    checkedAt = Date.now();
    // Its errors also reach the "error" event below.
    autoUpdater.checkForUpdates().catch(() => {});
  };

  // autoDownload and autoInstallOnAppQuit are electron-updater's defaults.
  autoUpdater.on("update-available", ({ version }) => {
    if (version !== downloaded) publish({ note: `Downloading wisp ${version}…` });
  });
  autoUpdater.on("update-not-available", () => {
    downloaded = undefined;
    publish({});
  });
  autoUpdater.on("update-downloaded", ({ version }) => {
    downloaded = version;
    publish({ ready: `wisp ${version} to install` });
  });
  // Also Squirrel.Mac's, such as a signature it rejects after the download.
  autoUpdater.on("error", (error: Error) => {
    downloaded = undefined;
    publish({ note: updateError(error) });
  });
  if (unsupported) publish({ note: unsupported });
  // A downloaded update waits for a click or quit; checking again would fetch it again.
  setInterval(() => downloaded ?? check(), 60_000);

  return {
    /** Takes the channel's settings and checks at once, also at start. */
    follow(channel: UpdateChannel) {
      // Setting `channel` also sets allowDowngrade, so the settings go in this order.
      const settings = updaterSettings(channel);
      autoUpdater.channel = settings.channel;
      autoUpdater.allowPrerelease = settings.allowPrerelease;
      autoUpdater.allowDowngrade = settings.allowDowngrade;
      following = true;
      if (!unsupported) publish({});
      check();
    },
    /** A window came to the front. */
    checkSoon() {
      if (downloaded === undefined && Date.now() - checkedAt > 10_000) check();
    },
    /** The Update button: installs what's downloaded, else checks now. Resolves to one line. */
    async update(): Promise<string> {
      if (unsupported) return unsupported;
      if (downloaded) {
        // After the answer reaches the window.
        setTimeout(() => autoUpdater.quitAndInstall(), 100);
        return `Restarting to install wisp ${downloaded}…`;
      }
      checkedAt = Date.now();
      try {
        const result = await autoUpdater.checkForUpdates();
        if (!result?.isUpdateAvailable) return "Up to date";
        return `Downloading wisp ${result.updateInfo.version}…`;
      } catch (error) {
        return updateError(error as Error);
      }
    },
  };
}
