import { contextBridge, ipcRenderer, webFrame } from "electron";

import { ErrorCodes } from "../protocol/generated/protocol";
import type {
  ConnectionState,
  Profile,
  SshHost,
  SubscriptionMessage,
  TerminalMessage,
  UpdateState,
  ParallaxBridge,
} from "./bridge";

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

// The renderer's only way into the app, exposed as `window.parallax`.
const bridge: ParallaxBridge = {
  platform: process.platform,
  version: () => ipcRenderer.invoke("parallax:version") as Promise<string>,
  setThemeSource: (preference) => ipcRenderer.send("parallax:theme", preference),
  setZoom: (factor) => webFrame.setZoomFactor(factor),
  pickFolder: () => ipcRenderer.invoke("parallax:pickFolder") as Promise<string | null>,
  copyPicture: (rect) => ipcRenderer.invoke("parallax:copyPicture", rect) as Promise<void>,
  updatable: process.argv.includes("--parallax-updatable"),
  update: () => ipcRenderer.invoke("parallax:update") as Promise<string>,
  onUpdateState(listener) {
    const forward = (_event: unknown, state: UpdateState) => listener(state);
    ipcRenderer.on("parallax:updateState", forward);
    void (ipcRenderer.invoke("parallax:updateState") as Promise<UpdateState>).then(listener);
    return () => ipcRenderer.removeListener("parallax:updateState", forward);
  },

  nameThread: (prompt) => ipcRenderer.invoke("parallax:nameThread", prompt),

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
  onHosts(listener) {
    const forward = (_event: unknown, hosts: SshHost[]) => listener(hosts);
    ipcRenderer.on("parallax:hosts", forward);
    return () => ipcRenderer.removeListener("parallax:hosts", forward);
  },
  onLocalName(listener) {
    const forward = (_event: unknown, name: string) => listener(name);
    ipcRenderer.on("parallax:localName", forward);
    void (ipcRenderer.invoke("parallax:localName") as Promise<string>).then(listener);
    return () => ipcRenderer.removeListener("parallax:localName", forward);
  },
  renameLocal: (name) => ipcRenderer.invoke("parallax:renameLocal", name),
  saveHost: (host, id) => ipcRenderer.invoke("parallax:saveHost", host, id),
  removeHost: (id) => ipcRenderer.invoke("parallax:removeHost", id),

  acpRegistry: () => ipcRenderer.invoke("parallax:acpRegistry"),

  openTerminal: (id, target, cols, rows) =>
    ipcRenderer.invoke("parallax:openTerminal", id, target, cols, rows),
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

  onProfile(listener) {
    const forward = (_event: unknown, profile: Profile | null) => listener(profile);
    ipcRenderer.on("parallax:profile", forward);
    // Undefined until main knows: the listener first hears a real answer.
    void (ipcRenderer.invoke("parallax:profile") as Promise<Profile | null | undefined>).then(
      (profile) => profile !== undefined && listener(profile),
    );
    return () => ipcRenderer.removeListener("parallax:profile", forward);
  },
  signIn: (create) => ipcRenderer.invoke("parallax:signIn", create),
  saveName: (firstName, lastName) => ipcRenderer.invoke("parallax:saveName", firstName, lastName),
  signOut: () => ipcRenderer.invoke("parallax:signOut"),
  storage: () => ipcRenderer.invoke("parallax:storage"),
  showFolder: (id) => ipcRenderer.invoke("parallax:showFolder", id),
  clearCache: () => ipcRenderer.invoke("parallax:clearCache"),
};

contextBridge.exposeInMainWorld("parallax", bridge);
