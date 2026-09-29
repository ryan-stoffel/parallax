import { contextBridge, ipcRenderer } from "electron";

import { ErrorCodes } from "../protocol/generated/protocol";
import type {
  ConnectionState,
  SshHost,
  SubscriptionMessage,
  TerminalMessage,
  WispBridge,
} from "./bridge";

// Subscription listeners by the key this preload gave them.
const subscriptions = new Map<string, (message: SubscriptionMessage) => void>();
ipcRenderer.on("wisp:subscription", (_event, key: string, message: SubscriptionMessage) => {
  const listener = subscriptions.get(key);
  if (message.type !== "event") subscriptions.delete(key);
  listener?.(message);
});

// The renderer's only way into the app, exposed as `window.wisp`.
const bridge: WispBridge = {
  platform: process.platform,
  version: () => ipcRenderer.invoke("wisp:version") as Promise<string>,
  setThemeSource: (preference) => ipcRenderer.send("wisp:theme", preference),
  pickFolder: () => ipcRenderer.invoke("wisp:pickFolder") as Promise<string | null>,
  updatable: process.argv.includes("--wisp-updatable"),
  update: () => ipcRenderer.invoke("wisp:update") as Promise<string>,

  nameThread: (prompt) => ipcRenderer.invoke("wisp:nameThread", prompt),

  request: (hostId, method, params) => ipcRenderer.invoke("wisp:request", hostId, method, params),
  subscribe(hostId, params, listener) {
    const key = crypto.randomUUID();
    subscriptions.set(key, listener);
    ipcRenderer.invoke("wisp:subscribe", hostId, key, params).catch((error: Error) => {
      if (subscriptions.delete(key))
        listener({
          type: "error",
          error: { code: ErrorCodes.InvalidParams, message: error.message },
        });
    });
    return () => {
      if (subscriptions.delete(key)) void ipcRenderer.invoke("wisp:unsubscribe", key);
    };
  },
  connectionState: (hostId) => ipcRenderer.invoke("wisp:connectionState", hostId),
  onConnectionState(listener) {
    const forward = (_event: unknown, hostId: string, state: ConnectionState) =>
      listener(hostId, state);
    ipcRenderer.on("wisp:state", forward);
    return () => ipcRenderer.removeListener("wisp:state", forward);
  },
  retry: (hostId) => ipcRenderer.invoke("wisp:retry", hostId),

  hosts: () => ipcRenderer.invoke("wisp:hosts"),
  onHosts(listener) {
    const forward = (_event: unknown, hosts: SshHost[]) => listener(hosts);
    ipcRenderer.on("wisp:hosts", forward);
    return () => ipcRenderer.removeListener("wisp:hosts", forward);
  },
  saveHost: (host, id) => ipcRenderer.invoke("wisp:saveHost", host, id),
  removeHost: (id) => ipcRenderer.invoke("wisp:removeHost", id),

  openTerminal: (hostId, cli, cols, rows) =>
    ipcRenderer.invoke("wisp:openTerminal", hostId, cli, cols, rows),
  terminalInput: (data) => ipcRenderer.send("wisp:terminalInput", data),
  resizeTerminal: (cols, rows) => ipcRenderer.send("wisp:resizeTerminal", cols, rows),
  closeTerminal: () => ipcRenderer.send("wisp:closeTerminal"),
  onTerminal(listener) {
    const forward = (_event: unknown, message: TerminalMessage) => listener(message);
    ipcRenderer.on("wisp:terminal", forward);
    return () => ipcRenderer.removeListener("wisp:terminal", forward);
  },
};

contextBridge.exposeInMainWorld("wisp", bridge);
