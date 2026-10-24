// Chromium gives extensions a `browser` namespace beside `chrome`, and electron-chrome-extensions
// fills in only `chrome`, so an extension that uses `browser`, as 1Password does, finds no
// `windows`, toolbar action, and the rest (PLX-888). This points `browser` at the filled-in
// `chrome`, which the library changes in place. Main registers it for the side panel browser's
// frames and service workers (extensions.ts). It does nothing outside an extension's own pages
// and workers, and a worker's preload realm has no location, so the check runs in the page.

import { contextBridge, ipcRenderer } from "electron";

const inExtension: boolean = contextBridge.executeInMainWorld({
  func: () => {
    const scope = globalThis as { location?: { protocol: string }; chrome?: object };
    if (scope.location?.protocol !== "chrome-extension:" || !scope.chrome) return false;
    try {
      Object.defineProperty(globalThis, "browser", {
        value: scope.chrome,
        configurable: true,
        writable: true,
      });
    } catch {
      // A `browser` that can't be replaced stays Chromium's.
    }
    return true;
  },
});

// Electron never fires `runtime.onInstalled`, where an extension such as 1Password opens the page
// that sets it up, so without it 1Password's popup waits forever. An extension's worker asks main,
// as it starts, whether its extension was just added (extensions.ts), and the listeners its script
// registers hear `install` if so.
if (inExtension && process.type === "service-worker")
  contextBridge.executeInMainWorld({
    func: (added: Promise<boolean>) => {
      type Listener = (details: { reason: string }) => void;
      const scope = globalThis as {
        chrome?: { runtime?: { onInstalled?: { addListener(listener: Listener): void } } };
      };
      const event = scope.chrome?.runtime?.onInstalled;
      if (!event) return;
      const listeners: Listener[] = [];
      const add = event.addListener.bind(event);
      event.addListener = (listener) => {
        listeners.push(listener);
        add(listener);
      };
      // As Chrome does, one listener that throws doesn't stop the rest.
      void added.then((yes) => {
        if (!yes) return;
        for (const listener of listeners)
          try {
            listener({ reason: "install" });
          } catch (error) {
            console.error(error);
          }
      });
    },
    // A worker main never registered a handler for hears no.
    args: [ipcRenderer.invoke("parallax:extensionAdded").catch(() => false)],
  });
