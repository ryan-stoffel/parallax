import { app, BrowserWindow, ipcMain, shell } from "electron";
import path from "node:path";

import { isOpenableExternally } from "./links";

// Set by scripts/dev.mjs. Ignored in a packaged app, which only loads its own files.
const devServerUrl = app.isPackaged ? undefined : process.env["WISP_DEV_SERVER_URL"];

function createWindow() {
  const win = new BrowserWindow({
    width: 1200,
    height: 800,
    backgroundColor: "#0a0a0a",
    webPreferences: {
      preload: path.join(__dirname, "../preload/preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  if (devServerUrl) void win.loadURL(devServerUrl);
  else void win.loadFile(path.join(__dirname, "../renderer/index.html"));
}

// No page may navigate or open windows. Https links go to the system browser.
app.on("web-contents-created", (_event, contents) => {
  contents.on("will-navigate", (event) => {
    event.preventDefault();
    if (isOpenableExternally(event.url)) void shell.openExternal(event.url);
  });
  contents.setWindowOpenHandler(({ url }) => {
    if (isOpenableExternally(url)) void shell.openExternal(url);
    return { action: "deny" };
  });
});

ipcMain.handle("wisp:version", () => app.getVersion());

void app.whenReady().then(() => {
  createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
