import { contextBridge, ipcRenderer } from "electron";

// The renderer's only way into the app, exposed as `window.wisp`.
// Its type is the renderer's type too (see src/renderer/wisp.d.ts).
const bridge = {
  platform: process.platform,
  version: (): Promise<string> => ipcRenderer.invoke("wisp:version"),
};

export type WispBridge = typeof bridge;

contextBridge.exposeInMainWorld("wisp", bridge);
