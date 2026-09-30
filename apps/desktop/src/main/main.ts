import { app, BrowserWindow, dialog, ipcMain, Menu, nativeTheme, shell } from "electron";
import path from "node:path";

import { THEME_PREFERENCES } from "../preload/bridge";
import { frameOptions, titleBarOverlay, windowBackground } from "./frame";
import { startHosts } from "./hosts";
import { isOpenableExternally, isReload } from "./links";
import { createNamer } from "./namer";
import { fallbackName } from "./naming";

// Set by scripts/dev.mjs. Ignored in a packaged app, which only loads its own files.
const devServerUrl = app.isPackaged ? undefined : process.env["WISP_DEV_SERVER_URL"];
// scripts/dev.mjs gives Electron an IPC channel, over which it runs the sidebar's Update.
const updatable = process.send !== undefined;

function createWindow() {
  const dark = nativeTheme.shouldUseDarkColors;
  const win = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 720,
    minHeight: 480,
    // Hidden until the renderer's first paint, which already has the saved
    // theme, so a theme that differs from the OS's never flashes.
    show: false,
    backgroundColor: windowBackground(dark),
    ...frameOptions(process.platform, dark),
    webPreferences: {
      preload: path.join(__dirname, "../preload/preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      // The preload reads it, so `window.wisp.updatable` is a plain value.
      additionalArguments: updatable ? ["--wisp-updatable"] : [],
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
  // Electron has no context menu of its own. Right-click offers the Edit menu's actions: all of
  // them in a text box, Copy on selected text.
  contents.on("context-menu", (_event, { isEditable, selectionText }) => {
    const roles = isEditable ? (["cut", "copy", "paste", "selectAll"] as const) : ["copy" as const];
    if (isEditable || selectionText)
      Menu.buildFromTemplate(roles.map((role) => ({ role }))).popup();
  });
});

ipcMain.handle("wisp:version", () => app.getVersion());

// Asks scripts/dev.mjs to pull develop and rebuild, and resolves to its one-line answer.
ipcMain.handle(
  "wisp:update",
  () =>
    new Promise<string>((resolve) => {
      if (!process.send) return resolve("Update runs only under pnpm dev.");
      const onMessage = (message: unknown) => {
        const text = (message as { update?: unknown } | null)?.update;
        if (typeof text !== "string") return;
        process.off("message", onMessage);
        resolve(text);
      };
      process.on("message", onMessage);
      process.send("update");
    }),
);

// The commits develop has that the checkout lacks, which scripts/dev.mjs sends each new app and
// whenever a check changes it. Windows get each change; a (re)loaded renderer asks.
let behind = 0;
process.on("message", (message) => {
  const count = (message as { behind?: unknown } | null)?.behind;
  if (typeof count !== "number") return;
  behind = count;
  for (const win of BrowserWindow.getAllWindows()) win.webContents.send("wisp:behind", behind);
});
ipcMain.handle("wisp:behind", () => behind);
// A window coming to the front asks dev.mjs to check now, while it's there to ask.
app.on("browser-window-focus", () => process.connected && process.send?.("check"));

// Names a new thread and its branch from its first prompt (see namer.ts).
const namer = createNamer(path.join(app.getPath("userData"), "models"));
ipcMain.handle("wisp:nameThread", (_event, prompt: unknown) =>
  typeof prompt === "string" ? namer.name(prompt) : fallbackName(""),
);

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
// Fires for the setting above, and for an OS theme change while it's "system".
nativeTheme.on("updated", () => {
  const dark = nativeTheme.shouldUseDarkColors;
  const overlay = titleBarOverlay(process.platform, dark);
  for (const win of BrowserWindow.getAllWindows()) {
    win.setBackgroundColor(windowBackground(dark));
    if (overlay) win.setTitleBarOverlay(overlay);
  }
});

void app.whenReady().then(() => {
  startHosts();
  // The end-to-end tests launch the app on CI machines, where a 490 MB download isn't wanted.
  if (!process.env["WISP_NO_NAMER"]) namer.warm();
  createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
