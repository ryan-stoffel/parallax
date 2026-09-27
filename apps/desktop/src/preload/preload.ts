import { contextBridge, ipcRenderer } from "electron";

import type { WispBridge } from "./bridge";

// The renderer's only way into the app, exposed as `window.wisp`.
const bridge: WispBridge = {
  platform: process.platform,
  version: () => ipcRenderer.invoke("wisp:version") as Promise<string>,
};

contextBridge.exposeInMainWorld("wisp", bridge);
