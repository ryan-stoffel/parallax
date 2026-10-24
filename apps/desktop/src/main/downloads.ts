import { existsSync } from "node:fs";
import path from "node:path";

import { app, BrowserWindow, shell, type DownloadItem, type Session } from "electron";

import type { DownloadInfo } from "../preload/bridge";

// The browser's downloads (PLX-975): each saves to the downloads folder under a name of its own,
// as Chrome's do, or where the user picks when they'd rather be asked (Settings › Browser), and
// every window hears how they're going. The list lasts until the app quits.

/** Where downloads go and whether to ask, from Settings › Browser; the OS's folder when empty. */
let prefs = { dir: "", ask: false };
export const setDownloadPrefs = (next: { dir: string; ask: boolean }) => (prefs = next);

const downloads = new Map<string, { item: DownloadItem; info: DownloadInfo }>();
let lastId = 0;

/**
 * A path in `dir` for `name` that nothing has yet, as Chrome numbers them: "report.pdf", then
 * "report (1).pdf", "report (2).pdf".
 */
export function uniquePath(
  dir: string,
  name: string,
  exists: (file: string) => boolean = existsSync,
): string {
  const ext = path.extname(name);
  const base = path.basename(name, ext);
  let candidate = path.join(dir, name);
  for (let n = 1; exists(candidate); n++) candidate = path.join(dir, `${base} (${n})${ext}`);
  return candidate;
}

const list = () => [...downloads.values()].map((d) => d.info).reverse();

// Progress reaches the windows at most every 200 ms; a start or an end at once.
let pending: ReturnType<typeof setTimeout> | undefined;
function send(now = false) {
  const flush = () => {
    pending = undefined;
    for (const window of BrowserWindow.getAllWindows())
      window.webContents.send("parallax:downloads", list());
  };
  if (now) {
    clearTimeout(pending);
    flush();
  } else pending ??= setTimeout(flush, 200);
}

/** Takes over the browser session's downloads. */
export function startDownloads(session: Session) {
  session.on("will-download", (_event, item) => {
    // Without a path, Electron asks where to save, which is what "ask" wants.
    if (!prefs.ask)
      item.setSavePath(uniquePath(prefs.dir || app.getPath("downloads"), item.getFilename()));
    const id = String(++lastId);
    const info: DownloadInfo = {
      id,
      name: item.getFilename(),
      url: item.getURL(),
      state: "progressing",
      received: 0,
      total: item.getTotalBytes(),
    };
    downloads.set(id, { item, info });
    const update = () => {
      info.name = path.basename(item.getSavePath()) || item.getFilename();
      info.path = item.getSavePath() || undefined;
      info.received = item.getReceivedBytes();
      info.total = item.getTotalBytes();
      info.paused = item.isPaused();
    };
    item.on("updated", (_e, state) => {
      update();
      if (state === "interrupted") info.state = "interrupted";
      send();
    });
    item.once("done", (_e, state) => {
      update();
      info.state = state;
      send(true);
    });
    send(true);
  });
}

/** The downloads so far, the newest first. */
export const downloadList = list;

/** Opens a download's file, shows it in its folder, or cancels it; or clears the finished ones. */
export function downloadAction(id: string | undefined, action: string) {
  if (action === "clear") {
    for (const [key, d] of downloads) if (d.info.state !== "progressing") downloads.delete(key);
    return send(true);
  }
  const download = id ? downloads.get(id) : undefined;
  if (!download) return;
  const file = download.info.path;
  if (action === "open" && file && download.info.state === "completed") void shell.openPath(file);
  else if (action === "show" && file) shell.showItemInFolder(file);
  else if (action === "cancel" && download.info.state === "progressing") download.item.cancel();
}
