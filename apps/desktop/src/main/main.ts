import { app, BrowserWindow, dialog, ipcMain, nativeTheme, shell } from "electron";
import path from "node:path";

import { THEME_PREFERENCES } from "../preload/bridge";
import { startHosts } from "./hosts";
import { isOpenableExternally, isReload } from "./links";

// Set by scripts/dev.mjs. Ignored in a packaged app, which only loads its own files.
const devServerUrl = app.isPackaged ? undefined : process.env["WISP_DEV_SERVER_URL"];

// The window's color before the renderer paints. Matches --background in the
// renderer's index.css.
const windowBackground = () => (nativeTheme.shouldUseDarkColors ? "#0d0d0f" : "#ffffff");

function createWindow() {
  const win = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 720,
    minHeight: 480,
    // Hidden until the renderer's first paint, which already has the saved
    // theme, so a theme that differs from the OS's never flashes.
    show: false,
    backgroundColor: windowBackground(),
    // macOS: no title bar, the traffic lights inset over the app's 52px top
    // row, which the renderer makes draggable. Windows and Linux keep the
    // native frame, which follows nativeTheme, and hide the menu bar until Alt.
    ...(process.platform === "darwin"
      ? { titleBarStyle: "hiddenInset", trafficLightPosition: { x: 16, y: 19 } }
      : { autoHideMenuBar: true }),
    webPreferences: {
      preload: path.join(__dirname, "../preload/preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  win.once("ready-to-show", () => win.show());

  if (devServerUrl) void win.loadURL(devServerUrl);
  else void win.loadFile(path.join(__dirname, "../renderer/index.html"));
}

// No page may navigate, except to reload itself, or open windows. Https links go to the
// system browser. `webContents.reload()` (the menu's Reload) never emits `will-navigate`.
app.on("web-contents-created", (_event, contents) => {
  contents.on("will-navigate", (event) => {
    if (isReload(event.url, contents.getURL())) return;
    event.preventDefault();
    if (isOpenableExternally(event.url)) void shell.openExternal(event.url);
  });
  contents.setWindowOpenHandler(({ url }) => {
    if (isOpenableExternally(url)) void shell.openExternal(url);
    return { action: "deny" };
  });
});

ipcMain.handle("wisp:version", () => app.getVersion());

// New Thread's "Add repository…": a folder on this Mac, sheet-attached to the asking window.
ipcMain.handle("wisp:pickFolder", async (event) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  const options = { properties: ["openDirectory" as const] };
  const { canceled, filePaths } = await (win
    ? dialog.showOpenDialog(win, options)
    : dialog.showOpenDialog(options));
  return canceled ? null : (filePaths[0] ?? null);
});

// The renderer's Appearance setting. Native UI follows it.
ipcMain.on("wisp:theme", (_event, preference: unknown) => {
  const source = THEME_PREFERENCES.find((p) => p === preference);
  if (source) nativeTheme.themeSource = source;
});
nativeTheme.on("updated", () => {
  for (const win of BrowserWindow.getAllWindows()) win.setBackgroundColor(windowBackground());
});

void app.whenReady().then(() => {
  startHosts();
  createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
