import { contextBridge, ipcRenderer, webFrame } from "electron";

import { ErrorCodes } from "../protocol/generated/protocol";
import type {
  ConnectionState,
  Profile,
  SubscriptionMessage,
  TerminalMessage,
  ParallaxBridge,
} from "./bridge";
import { validLocale } from "./bridge";

// Subscription listeners by the key this preload gave them.
const subscriptions = new Map<string, (message: SubscriptionMessage) => void>();
ipcRenderer.on("parallax:subscription", (_event, key: string, message: SubscriptionMessage) => {
  const listener = subscriptions.get(key);
  if (message.type !== "event") subscriptions.delete(key);
  listener?.(message);
});

// Each terminal's listener, by its id: one each, since each id has one view.
const terminals = new Map<string, (message: TerminalMessage) => void>();
ipcRenderer.on("parallax:terminal", (_event, id: string, message: TerminalMessage) =>
  terminals.get(id)?.(message),
);

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
  pickFolder: () => ipcRenderer.invoke("parallax:pickFolder") as Promise<string | null>,
  listFolders: (path) => ipcRenderer.invoke("parallax:listFolders", path),
  createRepo: (name) => ipcRenderer.invoke("parallax:createRepo", name),
  cloneRepo: (slug, dest) => ipcRenderer.invoke("parallax:cloneRepo", slug, dest),
  copyPicture: (rect) => ipcRenderer.invoke("parallax:copyPicture", rect) as Promise<void>,
  updatable: process.argv.includes("--parallax-updatable"),
  locale: validLocale(
    process.argv
      .find((arg) => arg.startsWith("--parallax-locale="))
      ?.slice("--parallax-locale=".length),
  ),
  update: () => ipcRenderer.invoke("parallax:update") as Promise<string>,
  onUpdateState: (listener) => follow("parallax:updateState", listener),

  request: (hostId, method, params) =>
    ipcRenderer.invoke("parallax:request", hostId, method, params),
  subscribe(hostId, params, listener) {
    const key = crypto.randomUUID();
    subscriptions.set(key, listener);
    ipcRenderer.invoke("parallax:subscribe", hostId, key, params).catch((error: Error) => {
      if (subscriptions.delete(key))
        listener({
          type: "error",
          error: { code: ErrorCodes.InvalidParams, message: error.message },
        });
    });
    return () => {
      if (subscriptions.delete(key)) void ipcRenderer.invoke("parallax:unsubscribe", key);
    };
  },
  connectionState: (hostId) => ipcRenderer.invoke("parallax:connectionState", hostId),
  onConnectionState(listener) {
    const forward = (_event: unknown, hostId: string, state: ConnectionState) =>
      listener(hostId, state);
    ipcRenderer.on("parallax:state", forward);
    return () => ipcRenderer.removeListener("parallax:state", forward);
  },
  retry: (hostId) => ipcRenderer.invoke("parallax:retry", hostId),

  hosts: () => ipcRenderer.invoke("parallax:hosts"),
  sshSuggestions: () => ipcRenderer.invoke("parallax:sshSuggestions"),
  onHosts: (listener) => follow("parallax:hosts", listener, false),
  onLocalName: (listener) => follow("parallax:localName", listener),
  renameLocal: (name) => ipcRenderer.invoke("parallax:renameLocal", name),
  saveHost: (host, id) => ipcRenderer.invoke("parallax:saveHost", host, id),
  removeHost: (id) => ipcRenderer.invoke("parallax:removeHost", id),

  onConnect: (listener) => follow("parallax:connect", listener),
  installConnect: () => ipcRenderer.invoke("parallax:installConnect"),
  setConnect: (on) => ipcRenderer.invoke("parallax:setConnect", on),
  onDevices: (listener) => follow("parallax:devices", listener),
  saveDevice: (hostId, look) => ipcRenderer.invoke("parallax:saveDevice", hostId, look),
  setDeviceEnabled: (hostId, enabled) =>
    ipcRenderer.invoke("parallax:setDeviceEnabled", hostId, enabled),
  removeDevice: (hostId) => ipcRenderer.invoke("parallax:removeDevice", hostId),

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

  openTargets: (hostId) => ipcRenderer.invoke("parallax:openTargets", hostId),
  openTargetIcons: () => ipcRenderer.invoke("parallax:openTargetIcons"),
  openFolder: (hostId, target, folder) =>
    ipcRenderer.invoke("parallax:openFolder", hostId, target, folder),
  terminalApp: () => ipcRenderer.invoke("parallax:terminalApp"),
  chooseTerminalApp: () => ipcRenderer.invoke("parallax:chooseTerminalApp"),

  onProfile(listener) {
    const stop = follow("parallax:profile", listener, false);
    // Undefined until main knows: the listener first hears a real answer.
    void (ipcRenderer.invoke("parallax:profile") as Promise<Profile | null | undefined>).then(
      (profile) => profile !== undefined && listener(profile),
    );
    return stop;
  },
  signIn: (create) => ipcRenderer.invoke("parallax:signIn", create),
  saveName: (firstName, lastName) => ipcRenderer.invoke("parallax:saveName", firstName, lastName),
  signOut: () => ipcRenderer.invoke("parallax:signOut"),
  storage: () => ipcRenderer.invoke("parallax:storage"),
  showFolder: (id) => ipcRenderer.invoke("parallax:showFolder", id),
  clearCache: () => ipcRenderer.invoke("parallax:clearCache"),
};

contextBridge.exposeInMainWorld("parallax", bridge);
