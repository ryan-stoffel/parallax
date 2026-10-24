import {
  app,
  BrowserWindow,
  clipboard,
  ClipboardItem,
  dialog,
  ipcMain,
  Menu,
  nativeImage,
  nativeTheme,
  net,
  protocol,
  screen,
  session,
  shell,
  webContents,
} from "electron";
import { existsSync, readFileSync, writeFileSync, promises as fs } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

import {
  THEME_PREFERENCES,
  blurSupported,
  type BrowserAction,
  needsTransparentWindow,
  type OpenTarget,
  type RegistryAgent,
  type UpdateState,
  validLocale,
} from "../preload/bridge";
import { passwordStore, startAccount } from "./account";
import {
  commandSource,
  commandState,
  installCommand,
  layout,
  offerAtLaunch,
  onPath,
  readRecord,
  removeCommand,
  writeRecord,
  type Layout,
} from "./command";
import { registerAppScheme, rendererUrl, serveAppScheme } from "./appScheme";
import {
  appBundle,
  detectEditors,
  editorCommand,
  isDirectory,
  isFolderPath,
  launch,
  type Editor,
} from "./editors";
import type { CommandStatus } from "../preload/bridge";
import { frameOptions, titleBarOverlay, windowBackground } from "./frame";
import { renderPage, savedHost, startHosts, streamFile } from "./hosts";
import {
  addTab,
  addUnpacked,
  extensionMenuItems,
  installExtension,
  listExtensions,
  loadExtensions,
  removeExtension,
  selectTab,
  startExtensions,
} from "./extensions";
import { answerStore, chromeUserAgent, storeOrigin } from "./webStore";
import {
  browserShortcut,
  isBrowsable,
  isExtensionPage,
  isOpenableExternally,
  mayNavigate,
} from "./links";
import { appDataDir, dataDir } from "./plxd";
import { createRepo, listFolders } from "./repos";
import {
  detectTerminalApps,
  readTerminalApp,
  terminalCommand,
  terminalName,
  writeTerminalApp,
} from "./terminalApp";
import { startStorage } from "./storage";
import { startTelemetry } from "./telemetry";
import { isNightly, startUpdater } from "./updater";
import { broadcast } from "./windows";
import { readWindowState, writeWindowState } from "./windowState";

// The app menu's About, Hide, and Quit items show the app's name, which says a nightly build is
// one, as its bundle's name does (scripts/ci/package-app). userData is `desktop` in plxd's
// `~/.parallax`, which both builds share, unless `--user-data-dir` (the end-to-end tests) sets it.
if (!app.commandLine.hasSwitch("user-data-dir")) {
  app.setPath("userData", appDataDir(homedir(), app.getPath("userData")));
}
app.setName(isNightly(app.getVersion()) ? "Parallax (Nightly)" : "Parallax");
// Windows ties the taskbar button and notifications to the Start menu shortcut the installer made by
// its AppUserModelID, the appId (electron-builder.yml). Without it, toasts aren't the app's.
if (process.platform === "win32" && app.isPackaged) app.setAppUserModelId("dev.parallax.desktop");
// One copy per userData off macOS, where the OS already brings a running app forward: a second
// launch, from the Start menu or a shortcut, shows the first one's window and quits. Only a
// packaged app, so `pnpm dev` still runs beside an installed Parallax, whose userData it shares.
const secondCopy =
  app.isPackaged && process.platform !== "darwin" && !app.requestSingleInstanceLock();
if (secondCopy) app.quit();
app.on("second-instance", () => {
  const win = BrowserWindow.getAllWindows()[0];
  if (!win) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
});
// Before `ready`, when Chromium picks the keychain safeStorage uses.
const store = passwordStore(
  process.platform,
  process.env,
  app.commandLine.hasSwitch("password-store"),
);
if (store) app.commandLine.appendSwitch("password-store", store);

// A fresh install, which onboards (PLX-806): no localStorage in userData yet, and no local plxd
// database. PLX_SKIP_ONBOARDING, which the end-to-end tests set, says it isn't one.
const firstRun =
  !process.env["PLX_SKIP_ONBOARDING"] &&
  !existsSync(path.join(app.getPath("userData"), "Local Storage")) &&
  !existsSync(path.join(dataDir(process.env, process.platform, homedir()), "plxd.sqlite3"));

// Set by scripts/dev.mjs. Ignored in a packaged app, which only loads its own files.
const devServerUrl = app.isPackaged ? undefined : process.env["PLX_DEV_SERVER_URL"];
registerAppScheme();

// Whether windows open see-through (Settings > Appearance's Clear background), read at launch. The
// OS fixes a window's transparency when it's created, so a change applies on the next launch.
const clearFile = path.join(app.getPath("userData"), "clear-window.json");
const clearAtLaunch = (() => {
  try {
    return JSON.parse(readFileSync(clearFile, "utf8")) === true;
  } catch {
    return false;
  }
})();

// Where the window was when it last closed, which the next one opens at (windowState.ts).
const windowStateFile = path.join(app.getPath("userData"), "window.json");

function createWindow() {
  const dark = nativeTheme.shouldUseDarkColors;
  const saved = readWindowState(
    windowStateFile,
    screen.getAllDisplays().map((display) => display.workArea),
  );
  const win = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 720,
    minHeight: 480,
    // Hidden until the renderer's first paint, which already has the saved
    // theme, so a theme that differs from the OS's never flashes.
    show: false,
    transparent: clearAtLaunch,
    backgroundColor: clearAtLaunch ? "#00000000" : windowBackground(dark),
    // macOS keeps a blurred window's blur when it isn't focused, rather than going flat gray.
    visualEffectState: "active",
    ...frameOptions(process.platform, dark),
    webPreferences: {
      preload: path.join(__dirname, "../preload/preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      // The side panel's browser (Browser.tsx). `will-attach-webview` below guards it.
      webviewTag: true,
      // The preload reads them, so `window.parallax.updatable`, `.firstRun`, and `.locale` are
      // plain values.
      additionalArguments: [
        `--parallax-locale=${app.getPreferredSystemLanguages()[0] ?? app.getSystemLocale()}`,
        ...(updatable ? ["--parallax-updatable"] : []),
        ...(firstRun ? ["--parallax-first-run"] : []),
        ...(clearAtLaunch ? ["--parallax-transparent"] : []),
      ],
    },
  });
  if (saved) {
    const { width, height } = saved.bounds;
    win.setBounds(saved.bounds);
    // On Windows, a window without a title bar comes out a little larger than the bounds it's
    // given, so a saved window would grow each launch: it's given them again, less the difference.
    const got = win.getBounds();
    if (process.platform === "win32" && (got.width !== width || got.height !== height))
      win.setBounds({
        ...saved.bounds,
        width: 2 * width - got.width,
        height: 2 * height - got.height,
      });
  }
  // Whether the window was last maximized, and its bounds when it last wasn't, which
  // getNormalBounds misreports on Windows. Neither changes while it's minimized or full screen,
  // where Windows reports it unmaximized.
  let bounds = win.getBounds();
  let maximized = saved?.maximized ?? false;
  const track = () => {
    if (win.isMinimized() || win.isFullScreen()) return;
    maximized = win.isMaximized();
    if (!maximized) bounds = win.getBounds();
  };
  win.on("resize", track);
  win.on("move", track);
  win.on("maximize", track);
  win.on("unmaximize", track);
  win.once("ready-to-show", () => {
    if (saved?.maximized) win.maximize();
    win.show();
  });
  win.on("close", () => writeWindowState(windowStateFile, { bounds, maximized }));
  // Full screen hides Windows' window buttons, so the top row needs no room for them (main.tsx).
  win.on("enter-full-screen", () => win.webContents.send("parallax:fullScreen", true));
  win.on("leave-full-screen", () => win.webContents.send("parallax:fullScreen", false));

  void win.loadURL(devServerUrl ?? rendererUrl);
  return win;
}

// The side panel's browser's session: persistent, and apart from the app's.
const browserPartition = "persist:browser";

// No page of the app's may navigate, except to reload itself, or open windows. Https links go to
// the system browser. `webContents.reload()` (the menu's Reload) never emits `will-navigate`. The
// side panel's browser, a webview, may go to any http or https page, and the windows its pages
// open become new tabs (Browser.tsx).
app.on("web-contents-created", (_event, contents) => {
  const inBrowser = contents.getType() === "webview";
  const tell = (action: BrowserAction) => tellTab(contents, action);
  // Each page's webview is a tab to the extensions (extensions.ts).
  if (!inBrowser)
    contents.on("did-attach-webview", (_event, tab) => {
      const window = BrowserWindow.fromWebContents(contents);
      if (window) addTab(tab, window);
    });
  contents.on("will-navigate", (event) => {
    if (mayNavigate(event.url, contents.getURL(), inBrowser)) return;
    event.preventDefault();
    if (!inBrowser && isOpenableExternally(event.url)) void shell.openExternal(event.url);
  });
  contents.setWindowOpenHandler(({ url }) => {
    if (inBrowser) {
      if (isBrowsable(url)) tell({ kind: "open", url });
    } else if (isOpenableExternally(url)) void shell.openExternal(url);
    return { action: "deny" };
  });
  // A webview may show only an http or https page, or an extension's own page such as its options,
  // in the browser's session, with no preload or Node, so its pages never reach `window.parallax`.
  contents.on("will-attach-webview", (event, webPreferences, params) => {
    const src = params["src"] ?? "";
    if (!isBrowsable(src) && !isExtensionPage(src)) return event.preventDefault();
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
  // Chrome's page shortcuts, which also keep the default menu's Cmd+R and Cmd+W from reloading
  // or closing the app while a page has focus.
  if (inBrowser)
    contents.on("before-input-event", (event, input) => {
      const shortcut = browserShortcut(input, process.platform);
      if (!shortcut) return;
      event.preventDefault();
      const history = contents.navigationHistory;
      if (shortcut === "reload") contents.reload();
      else if (shortcut === "hardReload") contents.reloadIgnoringCache();
      else if (shortcut === "back") history.goBack();
      else if (shortcut === "forward") history.goForward();
      // Chrome's zoom, a level at a time, which the session keeps for the page's site.
      else if (shortcut === "zoomIn") contents.setZoomLevel(contents.getZoomLevel() + 1);
      else if (shortcut === "zoomOut") contents.setZoomLevel(contents.getZoomLevel() - 1);
      else if (shortcut === "resetZoom") contents.setZoomLevel(0);
      else tell({ kind: shortcut });
    });
  // The app's CSP takes no image from the web, so main fetches a page's favicon and hands its tab
  // the image inline.
  if (inBrowser)
    contents.on("page-favicon-updated", (_event, favicons) => {
      void favicon(favicons.find(isBrowsable)).then((url) => url && tell({ kind: "icon", url }));
    });
  // Electron has no context menu of its own. Right-click offers the Edit menu's actions: all of
  // them in a text box, Copy on selected text. A browser page's menu is Chrome's: a link's, the
  // page's Back, Forward, and Reload when there's nothing to edit or copy, and Inspect.
  contents.on("context-menu", (_event, params) => {
    const { isEditable, selectionText, linkURL, x, y } = params;
    const roles = isEditable ? (["cut", "copy", "paste", "selectAll"] as const) : ["copy" as const];
    const edit = isEditable || selectionText ? roles.map((role) => ({ role })) : [];
    if (!inBrowser) {
      if (edit.length) Menu.buildFromTemplate(edit).popup();
      return;
    }
    const history = contents.navigationHistory;
    const separator = { type: "separator" } as const;
    const link = isBrowsable(linkURL)
      ? [
          { label: "Open Link in New Tab", click: () => tell({ kind: "open", url: linkURL }) },
          { label: "Copy Link Address", click: () => clipboard.writeText(linkURL) },
          separator,
        ]
      : [];
    const page = [
      { label: "Back", enabled: history.canGoBack(), click: () => history.goBack() },
      { label: "Forward", enabled: history.canGoForward(), click: () => history.goForward() },
      { label: "Reload", click: () => contents.reload() },
      separator,
    ];
    Menu.buildFromTemplate([
      ...link,
      ...(edit.length ? [...edit, separator] : link.length ? [] : page),
      ...extensionMenuItems(contents, params),
      { label: "Inspect", click: () => contents.inspectElement(x, y) },
    ]).popup();
  });
});

/**
 * A favicon as a data url, or undefined for none, an error, an answer that isn't an image, or one
 * over 256 KB, which it stops reading there, so a page can't make main buffer an endless body.
 */
async function favicon(url: string | undefined) {
  if (!url) return undefined;
  try {
    // In the app's own session, which extensions' request hooks can't break.
    const answer = await net.fetch(url);
    const type = answer.headers.get("content-type") ?? "";
    if (!answer.ok || !type.startsWith("image/") || !answer.body) return undefined;
    const chunks: Uint8Array[] = [];
    let size = 0;
    // Leaving the loop early cancels the rest of the body.
    for await (const chunk of answer.body) {
      size += chunk.length;
      if (size > 256 * 1024) return undefined;
      chunks.push(chunk);
    }
    return `data:${type};base64,${Buffer.concat(chunks).toString("base64")}`;
  } catch {
    return undefined;
  }
}

ipcMain.handle("parallax:version", () => app.getVersion());

// What the Update button shows. Windows get each change, not the same state again after each
// check; a (re)loaded renderer asks.
let updateState: UpdateState = {};
function publishUpdate(state: UpdateState) {
  if (JSON.stringify(state) === JSON.stringify(updateState)) return;
  updateState = state;
  broadcast("parallax:updateState", state);
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

/** Asks the browser tab that shows `tab`'s page for something, over `onBrowser` (bridge.ts). */
function tellTab(tab: Electron.WebContents, action: BrowserAction) {
  const host = tab.isDestroyed() ? undefined : tab.hostWebContents;
  if (host && !host.isDestroyed()) host.send("parallax:browser", tab.id, action);
}

// The side panel browser's Chrome extensions (extensions.ts).
const browserSession = () => session.fromPartition(browserPartition);
ipcMain.on("parallax:selectBrowserTab", (_event, id: unknown) => {
  const tab = typeof id === "number" ? webContents.fromId(id) : undefined;
  // Every webview is in the browser's session (will-attach-webview below).
  if (tab && tab.getType() === "webview") selectTab(tab);
});
ipcMain.handle("parallax:extensions", () => listExtensions(browserSession()));
ipcMain.handle("parallax:installExtension", (_event, text: unknown) =>
  installExtension(browserSession(), typeof text === "string" ? text : ""),
);
ipcMain.handle("parallax:loadUnpackedExtension", async (event) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  const options = { properties: ["openDirectory" as const], buttonLabel: "Load Extension" };
  const { canceled, filePaths } = await (win
    ? dialog.showOpenDialog(win, options)
    : dialog.showOpenDialog(options));
  return canceled || !filePaths[0] ? undefined : addUnpacked(browserSession(), filePaths[0]);
});
ipcMain.handle("parallax:removeExtension", (_event, id: unknown) =>
  typeof id === "string" ? removeExtension(browserSession(), id) : undefined,
);
// The Chrome Web Store page's install calls (webStore.ts), from its own origin only.
ipcMain.handle("parallax:webStore", (event, method: unknown, ...args: unknown[]) =>
  event.senderFrame?.origin === storeOrigin && typeof method === "string"
    ? answerStore(browserSession(), event, method, args)
    : undefined,
);

// New Thread's "Add repository…" and the add palette's "Choose in Finder": a folder on this Mac,
// sheet-attached to the asking window.
ipcMain.handle("parallax:pickFolder", async (event) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  const options = { properties: ["openDirectory" as const] };
  const { canceled, filePaths } = await (win
    ? dialog.showOpenDialog(win, options)
    : dialog.showOpenDialog(options));
  return canceled ? null : (filePaths[0] ?? null);
});

// The add palette's folder browser and New repository (repos.ts). Clone from GitHub is plxd's
// `repo/clone` (PLX-905).
ipcMain.handle("parallax:listFolders", (_event, input: unknown) =>
  listFolders(typeof input === "string" ? input : "~"),
);
ipcMain.handle("parallax:createRepo", (_event, name: unknown) => createRepo(String(name)));

// The Account dialog's Share: a picture of part of the asking window, onto the clipboard.
ipcMain.handle("parallax:copyPicture", async (event, rect: unknown) => {
  const { x, y, width, height } = (rect ?? {}) as Record<string, unknown>;
  const sides = [x, y, width, height];
  if (!sides.every((n) => typeof n === "number" && Number.isFinite(n) && n >= 0))
    throw new Error("copyPicture needs a rect");
  // The renderer measures in CSS pixels, which the window's zoom scales.
  const zoom = event.sender.getZoomFactor();
  const [left, top, w, h] = (sides as number[]).map((n) => Math.round(n * zoom)) as [
    number,
    number,
    number,
    number,
  ];
  // An empty rect would capture the whole window.
  if (!w || !h) throw new Error("copyPicture needs a rect");
  const picture = await event.sender.capturePage({ x: left, y: top, width: w, height: h });
  const png = new Blob([picture.toPNG()], { type: "image/png" });
  await clipboard.write([new ClipboardItem({ "image/png": png })]);
});

// The top bar's Open button (editors.ts). The renderer names the host, target, and folder; main
// checks each and runs only a program it found, never through a shell. Editors are found once.
let editors: Partial<Record<Editor, string>> | undefined;
const installedEditors = () => (editors ??= detectEditors(process.platform, process.env));
// The terminal app chosen in Settings > General (terminalApp.ts), read once.
const terminalFile = () => path.join(app.getPath("userData"), "terminal.json");
const savedTerminal = readTerminalApp(terminalFile());
const installedTerminals = () => detectTerminalApps(process.platform, process.env, savedTerminal);
let terminal =
  installedTerminals().find((app) => app.path === savedTerminal)?.path ??
  installedTerminals()[0]?.path;
// Every editor opens an SSH host's folder over its Remote SSH. The file manager and terminal are
// this computer's.
function openTargets(hostId: unknown): OpenTarget[] {
  const local = hostId === "local";
  if (!local && (typeof hostId !== "string" || !savedHost(hostId))) return [];
  const found = Object.keys(installedEditors()) as Editor[];
  if (!local) return found;
  return terminal ? [...found, "files", "terminal"] : [...found, "files"];
}
ipcMain.handle("parallax:openTargets", (_event, hostId: unknown) => openTargets(hostId));
ipcMain.handle(
  "parallax:terminalApp",
  () => installedTerminals().find((app) => app.path === terminal)?.name ?? null,
);
ipcMain.handle("parallax:terminalApps", () => installedTerminals());
ipcMain.handle("parallax:selectTerminalApp", async (event, selected: unknown) => {
  const chosen = installedTerminals().find((app) => app.path === selected);
  if (!chosen) return null;
  try {
    writeTerminalApp(terminalFile(), chosen.path);
  } catch (error) {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (win)
      await dialog.showMessageBox(win, {
        type: "warning",
        message: "Parallax couldn't save your terminal.",
        detail: (error as Error).message,
      });
    return null;
  }
  terminal = chosen.path;
  targetIcons = undefined;
  return chosen.name;
});
// The `parallax` command (PLX-750, command.ts).
const commandRecordFile = () => path.join(app.getPath("userData"), "command.json");
/** Where the command goes on this computer, or none where this app can't offer it. */
function commandLayout(): Layout | undefined {
  const plxd = commandSource({
    packaged: app.isPackaged,
    env: process.env,
    platform: process.platform,
    resourcesPath: process.resourcesPath,
    exists: existsSync,
  });
  return plxd ? layout(process.platform, process.env, homedir(), plxd) : undefined;
}
async function commandStatus(): Promise<CommandStatus> {
  const at = commandLayout();
  if (!at) return { state: "unavailable", path: "", onPath: true };
  // macOS's /usr/local/bin is on PATH by /etc/paths, though not in a Finder-launched app's own,
  // and Windows' folder goes on the registry's PATH, which this app's own doesn't follow.
  const found = process.platform !== "linux" || onPath(at, process.env["PATH"]);
  return { state: await commandState(at), path: at.file, onPath: found };
}
/** Installs the command, which the user wants from now on. */
async function putCommand(): Promise<string | null> {
  const at = commandLayout();
  if (!at) return "This copy of Parallax can't install the command.";
  try {
    await installCommand(at);
    await writeRecord(commandRecordFile(), { asked: true, removed: false });
    return null;
  } catch (error) {
    return (error as Error).message;
  }
}
ipcMain.handle("parallax:command", commandStatus);
ipcMain.handle("parallax:installCommand", putCommand);
/** Removes the command, which launch then leaves removed. */
ipcMain.handle("parallax:removeCommand", async () => {
  const at = commandLayout();
  if (!at) return null;
  try {
    await removeCommand(at);
    await writeRecord(commandRecordFile(), { asked: true, removed: true });
    return null;
  } catch (error) {
    return (error as Error).message;
  }
});
/**
 * At launch: on Linux and Windows, installs the command or brings it up to date, without asking.
 * On macOS, where it takes a password, offers it once, when there's nothing named `parallax`.
 * Something named `parallax` that this app didn't make is left alone, and so is a command the
 * user removed in Settings.
 */
async function setUpCommand(win: BrowserWindow): Promise<void> {
  const { state } = await commandStatus();
  if (state === "unavailable" || state === "other" || state === "installed") return;
  const record = await readRecord(commandRecordFile());
  if (record.removed) return;
  if (process.platform !== "darwin") {
    const error = await putCommand();
    if (error) console.warn("could not install the parallax command:", error);
    return;
  }
  if (!offerAtLaunch(process.platform, state, record.asked ?? false)) return;
  await writeRecord(commandRecordFile(), { ...record, asked: true });
  const { response } = await dialog.showMessageBox(win, {
    type: "question",
    message: "Use Parallax from your terminal?",
    detail:
      "This installs the parallax command in /usr/local/bin, so typing parallax in any terminal opens Parallax there. macOS asks for your password. You can change this in Settings > General.",
    buttons: ["Install", "Not Now"],
    defaultId: 0,
    cancelId: 1,
  });
  if (response !== 0) return;
  const error = await putCommand();
  if (error && error !== "Cancelled.")
    await dialog.showMessageBox(win, {
      type: "warning",
      message: "Parallax couldn't install the parallax command.",
      detail: error,
    });
}

// The Open targets' own app icons on macOS, as data URLs, found once. Quick Look, since
// `app.getFileIcon` gives a `.app` bundle a placeholder icon. A target without one keeps its mark.
let targetIcons: Promise<Partial<Record<OpenTarget, string>>> | undefined;
async function openTargetIcons(): Promise<Partial<Record<OpenTarget, string>>> {
  if (process.platform !== "darwin") return {};
  const apps = {
    ...installedEditors(),
    files: "/System/Library/CoreServices/Finder.app",
    ...(terminal ? { terminal: terminal } : {}),
  };
  const icons = await Promise.all(
    Object.entries(apps).map(async ([target, program]) => {
      try {
        const bundle = appBundle(program);
        if (!bundle) return [];
        const icon = await nativeImage.createThumbnailFromPath(bundle, { width: 64, height: 64 });
        return [[target, icon.toDataURL()]];
      } catch {
        return [];
      }
    }),
  );
  return Object.fromEntries(icons.flat());
}
ipcMain.handle("parallax:openTargetIcons", () => (targetIcons ??= openTargetIcons()));
ipcMain.handle(
  "parallax:openFolder",
  async (event, hostId: unknown, target: unknown, folder: unknown) => {
    if (!isFolderPath(folder) || !openTargets(hostId).some((t) => t === target)) return;
    const destination = savedHost(hostId as string)?.destination;
    let error: string | undefined;
    // A local folder must be one: `shell.openPath` would run an executable file.
    if (!destination && !isDirectory(folder)) error = "That folder isn't there anymore.";
    else if (target === "files") error = (await shell.openPath(folder)) || undefined;
    // `open -a` starts without complaint when the app is gone, so check it's still there.
    else if (target === "terminal")
      error = existsSync(terminal!)
        ? await launch(terminalCommand(process.platform, terminal!, folder))
        : `${terminalName(terminal!)} isn't there anymore. Choose your terminal again in Settings.`;
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

// Settings > Providers' Add provider: the ACP Registry's agents, fetched once while the app runs,
// or again after a failure. Only entries with an id and a name pass, and only https links.
const registryUrl = "https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json";
let registry: Promise<RegistryAgent[] | string> | undefined;
async function fetchRegistry(): Promise<RegistryAgent[] | string> {
  try {
    const response = await net.fetch(registryUrl);
    if (!response.ok) throw new Error(`it answered ${response.status}`);
    const { agents } = (await response.json()) as { agents?: unknown };
    if (!Array.isArray(agents)) throw new Error("it lists no agents");
    const text = (value: unknown) => (typeof value === "string" ? value : "");
    const https = (url: unknown) =>
      typeof url === "string" && url.startsWith("https://") ? url : undefined;
    // The renderer masks with each icon, and a CSS mask needs CORS the CDN doesn't send, so the
    // icons go over as data URLs. One that fails to load is left out.
    const icon = async (url: unknown) => {
      const from = https(url);
      if (!from) return undefined;
      const svg = await net.fetch(from).then(
        (r) => (r.ok ? r.text() : ""),
        () => "",
      );
      return svg ? `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}` : undefined;
    };
    const icons = await Promise.all(agents.map((a: Record<string, unknown>) => icon(a?.["icon"])));
    return agents.flatMap((a: Record<string, unknown>, i) =>
      typeof a?.["id"] === "string" && typeof a["name"] === "string"
        ? [
            {
              id: a["id"],
              name: a["name"],
              version: text(a["version"]),
              description: text(a["description"]),
              icon: icons[i],
              repository: https(a["repository"]),
              website: https(a["website"]),
              distribution: (a["distribution"] ?? {}) as RegistryAgent["distribution"],
            },
          ]
        : [],
    );
  } catch (error) {
    registry = undefined;
    return `Parallax couldn't read the ACP Registry: ${(error as Error).message}.`;
  }
}
ipcMain.handle("parallax:acpRegistry", () => (registry ??= fetchRegistry()));

// The renderer's Appearance setting. Native UI follows it.
ipcMain.on("parallax:theme", (_event, preference: unknown) => {
  const source = THEME_PREFERENCES.find((p) => p === preference);
  if (source) nativeTheme.themeSource = source;
});
// Settings > Appearance's window background for the asking window: opaque; clear, which shows the
// desktop where the window was created transparent (the next launch's windows are); or blurred,
// with macOS's vibrancy or Windows 11's acrylic where the OS can. Its panes let either through.
const seeThrough = new WeakSet<BrowserWindow>();
ipcMain.on("parallax:windowLook", (event, look: unknown) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  const { material } = (look ?? {}) as { material?: unknown };
  if (!win || (material !== "opaque" && material !== "clear" && material !== "blur")) return;
  const clear = needsTransparentWindow(material, process.platform);
  try {
    writeFileSync(clearFile, JSON.stringify(clear));
  } catch {
    // Unwritable: the next launch opens as this one did.
  }
  // Linux's blur is its compositor's, of a see-through window.
  const blur =
    material === "blur" &&
    process.platform !== "linux" &&
    blurSupported(process.platform, process.getSystemVersion());
  const through = blur || (clear && clearAtLaunch);
  if (through) seeThrough.add(win);
  else seeThrough.delete(win);
  if (process.platform === "darwin") win.setVibrancy(blur ? "under-window" : null);
  else if (process.platform === "win32") win.setBackgroundMaterial(blur ? "acrylic" : "none");
  win.setBackgroundColor(through ? "#00000000" : windowBackground(nativeTheme.shouldUseDarkColors));
});
// Restarts Parallax, for a window background that applies at launch.
ipcMain.on("parallax:relaunch", () => {
  app.relaunch();
  app.quit();
});
// Fires for the setting above, and for an OS theme change while it's "system".
nativeTheme.on("updated", () => {
  const dark = nativeTheme.shouldUseDarkColors;
  for (const win of BrowserWindow.getAllWindows()) {
    if (!seeThrough.has(win)) win.setBackgroundColor(windowBackground(dark));
    const overlay = titleBarOverlay(process.platform, dark, win.webContents.getZoomFactor());
    if (overlay) win.setTitleBarOverlay(overlay);
  }
});
ipcMain.handle(
  "parallax:fullScreen",
  (event) => BrowserWindow.fromWebContents(event.sender)?.isFullScreen() ?? false,
);
// The page's zoom changed (main.tsx): Windows' window buttons grow or shrink with the top row. The
// page names its zoom, since main's copy can lag behind it.
ipcMain.on("parallax:zoomed", (event, zoom: unknown) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (!win || typeof zoom !== "number" || !(zoom > 0 && zoom < 10)) return;
  const overlay = titleBarOverlay(process.platform, nativeTheme.shouldUseDarkColors, zoom);
  if (overlay) win.setTitleBarOverlay(overlay);
});

void app.whenReady().then(async () => {
  if (secondCopy) return;
  if (!devServerUrl) await serveAppScheme();
  protocol.handle("plx-render", (request) => renderPage(request.url));
  protocol.handle("plx-file", (request) => streamFile(request.url, request.headers.get("range")));
  // Pages in the side panel's browser get no camera, microphone, notifications, and the like.
  const browserSession = session.fromPartition(browserPartition);
  browserSession.setPermissionRequestHandler((_c, _p, grant) => grant(false));
  browserSession.setPermissionCheckHandler(() => false);
  // Its user agent is Chrome's, without Electron's and the app's tokens, so sites such as the
  // Chrome Web Store treat it as Chrome (PLX-962). Its Accept-Language is the OS's languages, as
  // before the app shipped only Chromium's en-US locale (PLX-613). Its pages'
  // `navigator.language` is en-US all the same.
  const languages = app.getPreferredSystemLanguages().filter((tag) => validLocale(tag));
  browserSession.setUserAgent(
    chromeUserAgent(browserSession.getUserAgent()),
    languages.length > 0 ? languages.join(",") : undefined,
  );
  // Before any window, so a page's content scripts are there when it loads.
  startExtensions(browserSession, tellTab);
  await loadExtensions(browserSession);
  startHosts(startAccount(), () => updateState.available?.version ?? app.getVersion());
  startStorage();
  startTelemetry();
  // Under `pnpm dev`, Update follows main (scripts/channels.mjs). Nightly and stable are tags on it.
  if (!updater) process.send?.({ channel: "nightly" });
  const win = createWindow();
  // Once the window shows, so the offer has somewhere to appear.
  win.once("ready-to-show", () => {
    void setUpCommand(win).catch((error: unknown) =>
      console.warn("could not set up the parallax command:", error),
    );
  });
  // The on-device thread namer's model, which earlier versions downloaded: plxd names threads
  // now (0058). Reclaims its 469 MB without holding up the window.
  void fs
    .rm(path.join(app.getPath("userData"), "models"), { recursive: true, force: true })
    .catch((error: unknown) => console.warn("could not remove the old namer's model:", error));
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
