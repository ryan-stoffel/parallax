import { contextBridge, ipcRenderer } from "electron";

import { ErrorCodes } from "../protocol/generated/protocol";
import type { ConnectionState, SshHost, SubscriptionMessage, WispBridge } from "./bridge";

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
};

contextBridge.exposeInMainWorld("wisp", bridge);
