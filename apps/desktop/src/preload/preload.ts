import { contextBridge, ipcRenderer } from "electron";

import { ErrorCodes } from "../protocol/generated/protocol";
import type {
  ConnectionState,
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

// The renderer's only way into the app, exposed as `window.parallax`.
const bridge: ParallaxBridge = {
  platform: process.platform,
  version: () => ipcRenderer.invoke("parallax:version") as Promise<string>,
  setThemeSource: (preference) => ipcRenderer.send("parallax:theme", preference),
  pickFolder: () => ipcRenderer.invoke("parallax:pickFolder") as Promise<string | null>,
  updatable: process.argv.includes("--parallax-updatable"),
  update: () => ipcRenderer.invoke("parallax:update") as Promise<string>,
  onUpdateState(listener) {
    const forward = (_event: unknown, state: UpdateState) => listener(state);
    ipcRenderer.on("parallax:updateState", forward);
    void (ipcRenderer.invoke("parallax:updateState") as Promise<UpdateState>).then(listener);
    return () => ipcRenderer.removeListener("parallax:updateState", forward);
  },

  updateChannel: () => ipcRenderer.invoke("parallax:updateChannel"),
  setUpdateChannel: (channel) => ipcRenderer.invoke("parallax:setUpdateChannel", channel),

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
  saveHost: (host, id) => ipcRenderer.invoke("parallax:saveHost", host, id),
  removeHost: (id) => ipcRenderer.invoke("parallax:removeHost", id),

  openTerminal: (hostId, cli, cols, rows) =>
    ipcRenderer.invoke("parallax:openTerminal", hostId, cli, cols, rows),
  terminalInput: (data) => ipcRenderer.send("parallax:terminalInput", data),
  resizeTerminal: (cols, rows) => ipcRenderer.send("parallax:resizeTerminal", cols, rows),
  closeTerminal: () => ipcRenderer.send("parallax:closeTerminal"),
  onTerminal(listener) {
    const forward = (_event: unknown, message: TerminalMessage) => listener(message);
    ipcRenderer.on("parallax:terminal", forward);
    return () => ipcRenderer.removeListener("parallax:terminal", forward);
  },
};

contextBridge.exposeInMainWorld("parallax", bridge);
