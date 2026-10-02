import { app, ipcMain, session, shell } from "electron";
import { lstat, readdir } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

import type { StorageItem, StorageItemId } from "../preload/bridge";
import { dataDir } from "./plxd";

/** The total size of `target` in bytes, a folder's files included. Symlinks count as themselves. */
export async function sizeOf(target: string): Promise<number> {
  const stats = await lstat(target).catch(() => undefined);
  if (!stats) return 0;
  if (!stats.isDirectory()) return stats.size;
  const entries = await readdir(target).catch(() => []);
  const sizes = await Promise.all(entries.map((entry) => sizeOf(path.join(target, entry))));
  return sizes.reduce((sum, size) => sum + size, stats.size);
}

type Folder = Exclude<StorageItemId, "cache">;

/** What Parallax keeps on this computer, by id, with where it is and the files that are it. */
function items(): Record<Folder, { name: string; folder: string; files: string[] }> {
  const plxd = dataDir(process.env, process.platform, homedir());
  const userData = app.getPath("userData");
  return {
    history: {
      name: "Threads and history",
      folder: plxd,
      files: ["plxd.sqlite3", "plxd.sqlite3-wal", "plxd.sqlite3-shm"].map((f) =>
        path.join(plxd, f),
      ),
    },
    worktrees: {
      name: "Worktrees",
      folder: path.join(plxd, "worktrees"),
      files: [path.join(plxd, "worktrees")],
    },
    logs: { name: "Logs", folder: path.join(plxd, "logs"), files: [path.join(plxd, "logs")] },
    app: { name: "App data", folder: userData, files: [userData] },
  };
}

/** Chromium's caches in userData, which Clear empties. App data's size leaves them out. */
const cacheFolders = () =>
  ["Cache", "Code Cache"].map((f) => path.join(app.getPath("userData"), f));

/** Serves Settings > Storage: sizes, Show in folder by id (never a path), and Clear cache. */
export function startStorage(): void {
  ipcMain.handle("parallax:storage", async (): Promise<StorageItem[]> => {
    const all = Object.entries(items()) as [Folder, ReturnType<typeof items>[Folder]][];
    const listed = await Promise.all(
      all.map(async ([id, { name, folder, files }]) => ({
        id,
        name,
        folder,
        bytes: (await Promise.all(files.map(sizeOf))).reduce((a, b) => a + b, 0),
      })),
    );
    const cache = (await Promise.all(cacheFolders().map(sizeOf))).reduce((a, b) => a + b, 0);
    const appData = listed.find((item) => item.id === "app")!;
    appData.bytes -= cache;
    return [...listed, { id: "cache", name: "Cache", folder: "", bytes: cache }];
  });
  ipcMain.handle("parallax:showFolder", async (_event, id: unknown) => {
    const item = Object.hasOwn(items(), String(id)) && items()[id as Folder];
    if (item) await shell.openPath(item.folder);
  });
  ipcMain.handle("parallax:clearCache", async () => {
    await session.defaultSession.clearCache();
    await session.defaultSession.clearCodeCaches({});
  });
}
