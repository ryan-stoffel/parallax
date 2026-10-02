import { app, BrowserWindow, dialog, ipcMain, Menu, nativeTheme, session, shell } from "electron";
import path from "node:path";

import { THEME_PREFERENCES, type OpenTarget, type UpdateState } from "../preload/bridge";
import { startAccount } from "./account";
import {
  detectEditors,
  editorCommand,
  isDirectory,
  isFolderPath,
  launch,
  type Editor,
} from "./editors";
import { frameOptions, titleBarOverlay, windowBackground } from "./frame";
import { savedHost, startHosts } from "./hosts";
import { isBrowsable, isOpenableExternally, mayNavigate } from "./links";
import { createNamer } from "./namer";
import { fallbackName } from "./naming";
import { isNightly, startUpdater } from "./updater";

// The app menu's About, Hide, and Quit items show the app's name, which says a nightly build is
// one, as its bundle's name does (scripts/ci/package-app). userData stays in the package-named
// folder, because `Parallax` would share plxd's `parallax` data folder on a case-insensitive disk,
// and so both builds share it.
app.setPath("userData", app.getPath("userData"));
app.setName(isNightly(app.getVersion()) ? "Parallax (Nightly)" : "Parallax");

// Set by scripts/dev.mjs. Ignored in a packaged app, which only loads its own files.
const devServerUrl = app.isPackaged ? undefined : process.env["PLX_DEV_SERVER_URL"];

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
      // The side panel's browser (Browser.tsx). `will-attach-webview` below guards it.
      webviewTag: true,
      // The preload reads it, so `window.parallax.updatable` is a plain value.
      additionalArguments: updatable ? ["--parallax-updatable"] : [],
    },
  });
  win.once("ready-to-show", () => win.show());

  if (devServerUrl) void win.loadURL(devServerUrl);
  else void win.loadFile(path.join(__dirname, "../renderer/index.html"));
}

// The side panel's browser's session: persistent, and apart from the app's.
const browserPartition = "persist:browser";

// No page of the app's may navigate, except to reload itself, or open windows. Https links go to
// the system browser. `webContents.reload()` (the menu's Reload) never emits `will-navigate`. The
// side panel's browser, a webview, may go to any http or https page, and loads the windows its
// pages open in itself.
app.on("web-contents-created", (_event, contents) => {
  const inBrowser = contents.getType() === "webview";
  contents.on("will-navigate", (event) => {
    if (mayNavigate(event.url, contents.getURL(), inBrowser)) return;
    event.preventDefault();
    if (!inBrowser && isOpenableExternally(event.url)) void shell.openExternal(event.url);
  });
  contents.setWindowOpenHandler(({ url }) => {
    // The view shows a load's error, so the rejection needs no handling here.
    if (inBrowser) {
      if (isBrowsable(url)) contents.loadURL(url).catch(() => {});
    } else if (isOpenableExternally(url)) void shell.openExternal(url);
    return { action: "deny" };
  });
  // A webview may show only an http or https page, in the browser's session, with no preload or
  // Node, so its pages never reach `window.parallax`.
  contents.on("will-attach-webview", (event, webPreferences, params) => {
    if (!isBrowsable(params["src"] ?? "")) return event.preventDefault();
    delete webPreferences.preload;
    Object.assign(webPreferences, {
      nodeIntegration: false,
      nodeIntegrationInSubFrames: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
      partition: browserPartition,
    });
  });
  // Electron has no context menu of its own. Right-click offers the Edit menu's actions: all of
  // them in a text box, Copy on selected text.
  contents.on("context-menu", (_event, { isEditable, selectionText }) => {
    const roles = isEditable ? (["cut", "copy", "paste", "selectAll"] as const) : ["copy" as const];
    if (isEditable || selectionText)
      Menu.buildFromTemplate(roles.map((role) => ({ role }))).popup();
  });
});

ipcMain.handle("parallax:version", () => app.getVersion());

// What the Update button shows. Windows get each change; a (re)loaded renderer asks.
let updateState: UpdateState = {};
function publishUpdate(state: UpdateState) {
  updateState = state;
  for (const win of BrowserWindow.getAllWindows())
    win.webContents.send("parallax:updateState", state);
}
ipcMain.handle("parallax:updateState", () => updateState);

// The sidebar's Update installs releases in a packaged app (updater.ts). Under `pnpm dev`,
// scripts/dev.mjs gives Electron an IPC channel, over which it runs Update with git.
const updater = app.isPackaged ? startUpdater(publishUpdate) : undefined;
const updatable = updater !== undefined || process.send !== undefined;

// Installs, downloads, or checks for a release, or asks scripts/dev.mjs to move the checkout to
// the update channel's branch and rebuild, and resolves to the one-line answer.
ipcMain.handle(
  "parallax:update",
  () =>
    updater?.update() ??
    new Promise<string>((resolve) => {
      if (!process.send) return resolve("Update runs only in a packaged app or under pnpm dev.");
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

// Under `pnpm dev`, the commits the channel's branch has that the checkout lacks, which
// scripts/dev.mjs sends each new app and whenever a check changes it.
process.on("message", (message) => {
  const behind = (message as { behind?: unknown } | null)?.behind;
  if (typeof behind !== "number") return;
  publishUpdate(behind ? { ready: `${behind} commit${behind === 1 ? "" : "s"} to apply` } : {});
});
// A window coming to the front checks now, or asks dev.mjs to, while it's there to ask.
app.on("browser-window-focus", () => {
  if (updater) updater.checkSoon();
  else if (process.connected) process.send?.("check");
});

// Names a new thread and its branch from its first prompt (see namer.ts).
const namer = createNamer(path.join(app.getPath("userData"), "models"));
ipcMain.handle("parallax:nameThread", (_event, prompt: unknown) =>
  typeof prompt === "string" ? namer.name(prompt) : fallbackName(""),
);

// New Thread's "Add repository…": a folder on this Mac, sheet-attached to the asking window.
ipcMain.handle("parallax:pickFolder", async (event) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  const options = { properties: ["openDirectory" as const] };
  const { canceled, filePaths } = await (win
    ? dialog.showOpenDialog(win, options)
    : dialog.showOpenDialog(options));
  return canceled ? null : (filePaths[0] ?? null);
});

// The top bar's Open button (editors.ts). The renderer names the host, target, and folder; main
// checks each and runs only a program it found, never through a shell. Editors are found once.
let editors: Partial<Record<Editor, string>> | undefined;
const installedEditors = () => (editors ??= detectEditors(process.platform, process.env));
// Every editor opens an SSH host's folder over its Remote SSH. The file manager is this computer's.
function openTargets(hostId: unknown): OpenTarget[] {
  const local = hostId === "local";
  if (!local && (typeof hostId !== "string" || !savedHost(hostId))) return [];
  const found = Object.keys(installedEditors()) as Editor[];
  return local ? [...found, "files"] : found;
}
ipcMain.handle("parallax:openTargets", (_event, hostId: unknown) => openTargets(hostId));
ipcMain.handle(
  "parallax:openFolder",
  async (event, hostId: unknown, target: unknown, folder: unknown) => {
    if (!isFolderPath(folder) || !openTargets(hostId).some((t) => t === target)) return;
    const destination = savedHost(hostId as string)?.destination;
    let error: string | undefined;
    // A local folder must be one: `shell.openPath` would run an executable file.
    if (!destination && !isDirectory(folder)) error = "That folder isn't there anymore.";
    else if (target === "files") error = (await shell.openPath(folder)) || undefined;
    else {
      const program = installedEditors()[target as Editor]!;
      error = await launch(editorCommand(program, folder, destination));
    }
    const win = BrowserWindow.fromWebContents(event.sender);
    if (error && win)
      await dialog.showMessageBox(win, {
        type: "warning",
        message: "Parallax couldn't open the folder.",
        detail: error,
      });
  },
);

// The renderer's Appearance setting. Native UI follows it.
ipcMain.on("parallax:theme", (_event, preference: unknown) => {
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
  // Pages in the side panel's browser get no camera, microphone, notifications, and the like.
  const browserSession = session.fromPartition(browserPartition);
  browserSession.setPermissionRequestHandler((_c, _p, grant) => grant(false));
  browserSession.setPermissionCheckHandler(() => false);
  startHosts();
  // Under `pnpm dev`, Update follows develop, the nightly channel's branch (scripts/channels.mjs).
  if (!updater) process.send?.({ channel: "nightly" });
  startAccount();
  // The end-to-end tests launch the app on CI machines, where a 490 MB download isn't wanted.
  if (!process.env["PLX_NO_NAMER"]) namer.warm();
  createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
