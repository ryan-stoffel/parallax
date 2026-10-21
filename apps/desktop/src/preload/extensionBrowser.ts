// Chromium gives extensions a `browser` namespace beside `chrome`, and electron-chrome-extensions
// fills in only `chrome`, so an extension that uses `browser`, as 1Password does, finds no
// `windows`, toolbar action, and the rest (PLX-888). This points `browser` at the filled-in
// `chrome`, which the library changes in place. Main registers it for the side panel browser's
// frames and service workers (extensions.ts). It does nothing outside an extension's own pages
// and workers, and a worker's preload realm has no location, so the check runs in the page.

import { contextBridge } from "electron";

contextBridge.executeInMainWorld({
  func: () => {
    const scope = globalThis as { location?: { protocol: string }; chrome?: object };
    if (scope.location?.protocol !== "chrome-extension:" || !scope.chrome) return;
    try {
      Object.defineProperty(globalThis, "browser", {
        value: scope.chrome,
        configurable: true,
        writable: true,
      });
    } catch {
      // A `browser` that can't be replaced stays Chromium's.
    }
  },
});
