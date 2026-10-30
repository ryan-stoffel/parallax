import { contextBridge, ipcRenderer, webFrame } from "electron";

import { ErrorCodes } from "../protocol/generated/protocol";
import {
  blurSupported,
  validLocale,
  type BrowserAction,
  type ConnectionState,
  type DeviceStreamMessage,
  type Profile,
  type SubscriptionMessage,
  type TerminalMessage,
  type ParallaxBridge,
  type WatchMessage,
  type WatchParams,
} from "./bridge";
import { injectBrowserAction } from "electron-chrome-extensions/browser-action";

// Subscription and watch listeners by the key this preload gave them.
type Message = SubscriptionMessage | WatchMessage;
const subscriptions = new Map<string, (message: Message) => void>();
ipcRenderer.on("parallax:subscription", (_event, key: string, message: Message) => {
  const listener = subscriptions.get(key);
  if (message.type === "resync" || message.type === "error") subscriptions.delete(key);
  listener?.(message);
});

/** Sends `channel` for a new subscription or watch, whose messages go to `listener`. */
function listen(
  channel: string,
  hostId: string,
  params: object,
  listener: (message: Message) => void,
): () => void {
  const key = crypto.randomUUID();
  subscriptions.set(key, listener);
  ipcRenderer.invoke(channel, hostId, key, params).catch((error: Error) => {
    if (subscriptions.delete(key))
      listener({
        type: "error",
        error: { code: ErrorCodes.InvalidParams, message: error.message },
      });
  });
  return () => {
    if (subscriptions.delete(key)) void ipcRenderer.invoke("parallax:unsubscribe", key);
  };
}

// Each terminal's listener, by its id: one each, since each id has one view.
const terminals = new Map<string, (message: TerminalMessage) => void>();
ipcRenderer.on("parallax:terminal", (_event, id: string, message: TerminalMessage) =>
  terminals.get(id)?.(message),
);

// Each device stream's listener, by its id (PLX-886). An end forgets it.
const deviceStreams = new Map<string, (message: DeviceStreamMessage) => void>();
ipcRenderer.on("parallax:device", (_event, id: string, message: DeviceStreamMessage) => {
  const listener = deviceStreams.get(id);
  if (message.type === "end") deviceStreams.delete(id);
  listener?.(message);
});

/**
 * Calls `listener` with each value main sends on `channel`, and first, with `read`, with the
 * current one, which main answers on the same channel. Returns the function that stops it.
 */
function follow<T>(channel: string, listener: (value: T) => void, read = true): () => void {
  const forward = (_event: unknown, value: T) => listener(value);
  ipcRenderer.on(channel, forward);
  if (read) void (ipcRenderer.invoke(channel) as Promise<T>).then(listener);
  return () => ipcRenderer.removeListener(channel, forward);
}

// The renderer's only way into the app, exposed as `window.parallax`.
const bridge: ParallaxBridge = {
  platform: process.platform,
  version: () => ipcRenderer.invoke("parallax:version") as Promise<string>,
  setThemeSource: (preference) => ipcRenderer.send("parallax:theme", preference),
  setZoom: (factor) => webFrame.setZoomFactor(factor),
  zoomed: () => ipcRenderer.send("parallax:zoomed", webFrame.getZoomFactor()),
  onFullScreen: (listener) => follow("parallax:fullScreen", listener),
  setWindowLook: (look) => ipcRenderer.send("parallax:windowLook", look),
  canBlur: blurSupported(process.platform, process.getSystemVersion()),
  transparent: process.argv.includes("--parallax-transparent"),
  relaunch: () => ipcRenderer.send("parallax:relaunch"),
  pickFolder: () => ipcRenderer.invoke("parallax:pickFolder") as Promise<string | null>,
  listFolders: (path) => ipcRenderer.invoke("parallax:listFolders", path),
  createRepo: (name) => ipcRenderer.invoke("parallax:createRepo", name),
  copyPicture: (rect) => ipcRenderer.invoke("parallax:copyPicture", rect) as Promise<void>,
  onBrowser(listener) {
    const forward = (_event: unknown, id: number, action: BrowserAction) => listener(id, action);
    ipcRenderer.on("parallax:browser", forward);
    return () => ipcRenderer.removeListener("parallax:browser", forward);
  },
  extensions: () => ipcRenderer.invoke("parallax:extensions"),
  installExtension: (text) => ipcRenderer.invoke("parallax:installExtension", text),
  loadUnpackedExtension: () => ipcRenderer.invoke("parallax:loadUnpackedExtension"),
  removeExtension: (id) => ipcRenderer.invoke("parallax:removeExtension", id),
  onExtensionsChanged: (listener) => follow("parallax:extensionsChanged", listener, false),
  selectBrowserTab: (id) => ipcRenderer.send("parallax:selectBrowserTab", id),
  clearBrowsingData: (what) => ipcRenderer.invoke("parallax:clearBrowsingData", what),
  downloads: () => ipcRenderer.invoke("parallax:downloads"),
  googleAccount: () => ipcRenderer.invoke("parallax:googleAccount"),
  siteIcon: (page) => ipcRenderer.invoke("parallax:siteIcon", page),
  onDownloads: (listener) => follow("parallax:downloads", listener, false),
  onGoogleAccount: (listener) => follow("parallax:googleAccount", listener, false),
  downloadAction: (id, action) => ipcRenderer.send("parallax:downloadAction", id, action),
  setDownloadPrefs: (prefs) => ipcRenderer.send("parallax:downloadPrefs", prefs),
  updatable: process.argv.includes("--parallax-updatable"),
  firstRun: process.argv.includes("--parallax-first-run"),
  locale: validLocale(
    process.argv
      .find((arg) => arg.startsWith("--parallax-locale="))
      ?.slice("--parallax-locale=".length),
  ),
  update: () => ipcRenderer.invoke("parallax:update") as Promise<string>,
  onUpdateState: (listener) => follow("parallax:updateState", listener),

  request: (hostId, method, params) =>
    ipcRenderer.invoke("parallax:request", hostId, method, params),
  subscribe: (hostId, params, listener) =>
    listen("parallax:subscribe", hostId, params, listener as (message: Message) => void),
  watch: (hostId: string, params: WatchParams, listener: (message: never) => void) =>
    listen("parallax:watch", hostId, params, listener as (message: Message) => void),
  connectionState: (hostId) => ipcRenderer.invoke("parallax:connectionState", hostId),
  onConnectionState(listener) {
    const forward = (_event: unknown, hostId: string, state: ConnectionState) =>
      listener(hostId, state);
    ipcRenderer.on("parallax:state", forward);
    return () => ipcRenderer.removeListener("parallax:state", forward);
  },
  retry: (hostId) => ipcRenderer.invoke("parallax:retry", hostId),
  onHostUpdate: (listener) => follow("parallax:hostUpdate", listener, false),
  retryHostUpdate: (hostId) => ipcRenderer.invoke("parallax:retryHostUpdate", hostId),
  updateHostNow: (hostId) => ipcRenderer.invoke("parallax:updateHostNow", hostId),

  hosts: () => ipcRenderer.invoke("parallax:hosts"),
  sshSuggestions: () => ipcRenderer.invoke("parallax:sshSuggestions"),
  onHosts: (listener) => follow("parallax:hosts", listener, false),
  onLocalName: (listener) => follow("parallax:localName", listener),
  renameLocal: (name) => ipcRenderer.invoke("parallax:renameLocal", name),
  saveHost: (host, id) => ipcRenderer.invoke("parallax:saveHost", host, id),
  removeHost: (id) => ipcRenderer.invoke("parallax:removeHost", id),
  installPlxd: (id) => ipcRenderer.invoke("parallax:installPlxd", id),
  discoverLan: () => ipcRenderer.invoke("parallax:discoverLan"),
  pairLan: (target, code) => ipcRenderer.invoke("parallax:pairLan", target, code),
  registerRelay: () => ipcRenderer.invoke("parallax:registerRelay"),
  relayHosts: () => ipcRenderer.invoke("parallax:relayHosts"),
  removeRelayHost: (hostId) => ipcRenderer.invoke("parallax:removeRelayHost", hostId),

  onConnect: (listener) => follow("parallax:connect", listener),
  setConnect: (on) => ipcRenderer.invoke("parallax:setConnect", on),
  onDevices: (listener) => follow("parallax:devices", listener),
  saveDevice: (hostId, look) => ipcRenderer.invoke("parallax:saveDevice", hostId, look),
  setDeviceEnabled: (hostId, enabled) =>
    ipcRenderer.invoke("parallax:setDeviceEnabled", hostId, enabled),
  removeDevice: (hostId) => ipcRenderer.invoke("parallax:removeDevice", hostId),
  discoverAccount: () => ipcRenderer.invoke("parallax:discoverAccount"),
  enterSetupCode: (hostId, code) => ipcRenderer.invoke("parallax:enterSetupCode", hostId, code),
  askAgain: (hostId) => ipcRenderer.invoke("parallax:askAgain", hostId),
  onAccessRequests: (listener) => follow("parallax:accessRequests", listener),
  answerAccess: (id, allow) => ipcRenderer.invoke("parallax:answerAccess", id, allow),

  acpRegistry: () => ipcRenderer.invoke("parallax:acpRegistry"),

  openTerminal: (id, target, cols, rows) =>
    ipcRenderer.invoke("parallax:openTerminal", id, target, cols, rows),
  install: (hostId, kind) => ipcRenderer.invoke("parallax:install", hostId, kind),
  terminalInput: (id, data) => ipcRenderer.send("parallax:terminalInput", id, data),
  resizeTerminal: (id, cols, rows) => ipcRenderer.send("parallax:resizeTerminal", id, cols, rows),
  closeTerminal: (id) => ipcRenderer.send("parallax:closeTerminal", id),
  onTerminal(id, listener) {
    terminals.set(id, listener);
    return () => {
      if (terminals.get(id) === listener) terminals.delete(id);
    };
  },

  async openDeviceStream(hostId, params, listener) {
    deviceStreams.set(params.streamId, listener);
    const error = (await ipcRenderer.invoke("parallax:openDeviceStream", hostId, params)) as
      | string
      | undefined;
    if (error && deviceStreams.get(params.streamId) === listener) {
      deviceStreams.delete(params.streamId);
    }
    return error;
  },
  sendDeviceStream: (id, data) => ipcRenderer.send("parallax:sendDeviceStream", id, data),
  closeDeviceStream(id) {
    deviceStreams.delete(id);
    ipcRenderer.send("parallax:closeDeviceStream", id);
  },

  openTargets: (hostId) => ipcRenderer.invoke("parallax:openTargets", hostId),
  openFolder: (hostId, target, folder, terminal) =>
    ipcRenderer.invoke("parallax:openFolder", hostId, target, folder, terminal),
  showFile: (path) => ipcRenderer.invoke("parallax:showFile", path),
  terminalApp: () => ipcRenderer.invoke("parallax:terminalApp"),
  terminalApps: () => ipcRenderer.invoke("parallax:terminalApps"),
  selectTerminalApp: (path) => ipcRenderer.invoke("parallax:selectTerminalApp", path),
  command: () => ipcRenderer.invoke("parallax:command"),
  installCommand: () => ipcRenderer.invoke("parallax:installCommand"),
  removeCommand: () => ipcRenderer.invoke("parallax:removeCommand"),

  onProfile(listener) {
    const stop = follow("parallax:profile", listener, false);
    // Undefined until main knows: the listener first hears a real answer.
    void (ipcRenderer.invoke("parallax:profile") as Promise<Profile | null | undefined>).then(
      (profile) => profile !== undefined && listener(profile),
    );
    return stop;
  },
  signIn: (create) => ipcRenderer.invoke("parallax:signIn", create),
  editProfile: (page) => ipcRenderer.invoke("parallax:editProfile", page),
  signOut: () => ipcRenderer.invoke("parallax:signOut"),
  storage: () => ipcRenderer.invoke("parallax:storage"),
  showFolder: (id) => ipcRenderer.invoke("parallax:showFolder", id),
  clearCache: () => ipcRenderer.invoke("parallax:clearCache"),
};

contextBridge.exposeInMainWorld("parallax", bridge);

// Main has no network events, so each window tells it when the network comes back or changes:
// account discovery and route re-checks run then (0091).
const networkChanged = () => ipcRenderer.send("parallax:network");
const page = globalThis as unknown as EventTarget & { navigator: { connection?: EventTarget } };
page.addEventListener("online", networkChanged);
page.navigator.connection?.addEventListener("change", networkChanged);

// <browser-action-list>, the side panel browser's extension buttons (Extensions.tsx).
injectBrowserAction();
