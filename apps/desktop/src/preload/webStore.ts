// The Chrome Web Store's `chrome.webstorePrivate` and `chrome.management`, which Chrome gives the
// store's pages alone, so its Add to Chrome button installs into the side panel's browser
// (PLX-962). Main registers it for the browser's frames (extensions.ts) and answers its calls
// only from the store's origin (webStore.ts in main). It does nothing on any other page. The
// calls the store makes are the ones electron-chrome-web-store answers.

import { contextBridge, ipcRenderer } from "electron";

// The preload's types have no DOM, so `location` is read as the page's.
const { location } = globalThis as { location?: { origin: string } };

if (location?.origin === "https://chromewebstore.google.com") {
  const ask = (method: string, ...args: unknown[]) =>
    ipcRenderer.invoke("parallax:webStore", method, ...args) as Promise<unknown>;
  type Callback = (result: unknown) => void;
  // Each call resolves and also calls the store's callback, which it passes as the last argument.
  const call =
    (answer: (...args: unknown[]) => unknown) =>
    async (...args: unknown[]) => {
      const callback = typeof args.at(-1) === "function" ? (args.pop() as Callback) : undefined;
      const result = await answer(...args);
      callback?.(result);
      return result;
    };
  const constant = (value: unknown) => call(() => value);

  const installed = new Set<Callback>();
  const uninstalled = new Set<Callback>();
  const event = (listeners: Set<Callback>) => ({
    addListener: (listener: Callback) => void listeners.add(listener),
    removeListener: (listener: Callback) => void listeners.delete(listener),
  });

  const webstorePrivate = {
    beginInstallWithManifest3: call(async (details) => {
      const answer = (await ask("beginInstall", details)) as { result: string; info?: unknown };
      if (answer.info) for (const listener of installed) listener(answer.info);
      return answer.result;
    }),
    completeInstall: constant("success"),
    enableAppLauncher: constant(true),
    getBrowserLogin: constant(""),
    getExtensionStatus: call((id, manifest) => ask("getExtensionStatus", id, manifest)),
    getFullChromeVersion: constant({ version_number: process.versions.chrome }),
    getIsLauncherEnabled: constant(true),
    getMV2DeprecationStatus: constant("soft_disable"),
    getReferrerChain: constant("EgIIAA=="),
    getStoreLogin: constant(""),
    getWebGLStatus: constant("webgl_allowed"),
    install: constant("success"),
    isInIncognitoMode: constant(false),
    isPendingCustodianApproval: constant(false),
    setStoreLogin: constant(true),
  };
  const management = {
    getAll: call(() => ask("getAll")),
    setEnabled: constant(true),
    uninstall: call(async (id) => {
      await ask("uninstall", id);
      for (const listener of uninstalled) listener(id);
    }),
    onInstalled: event(installed),
    onUninstalled: event(uninstalled),
  };

  contextBridge.executeInMainWorld({
    func: (store: object, manage: object) => {
      const scope = globalThis as { chrome?: Record<string, object | undefined> };
      const chrome = (scope.chrome ??= {});
      chrome["webstorePrivate"] = store;
      chrome["management"] = Object.assign(chrome["management"] ?? {}, manage);
      chrome["runtime"] ??= {};
    },
    args: [webstorePrivate, management],
  });
}
