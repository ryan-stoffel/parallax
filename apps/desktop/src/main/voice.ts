import { app, BrowserWindow, ipcMain, session, type WebContents } from "electron";
import { createRequire } from "node:module";
import path from "node:path";
import type { VoiceKey } from "../preload/bridge";

interface FnMonitor {
  start(listener: (key: VoiceKey) => void): void;
  setEnabled(enabled: boolean): void;
  stop(): void;
}

/** Own-renderer audio only. Fn is observed locally while a thread in the focused window owns it. */
export function startVoice(): void {
  let monitor: FnMonitor | undefined;
  let failure: string | undefined;
  let owner: WebContents | undefined;
  let ownerToken: string | undefined;
  const ownWindow = (contents: WebContents) => {
    const window = BrowserWindow.fromWebContents(contents);
    return window?.webContents === contents ? window : undefined;
  };
  const focused = (contents: WebContents) => ownWindow(contents)?.isFocused() === true;
  const refresh = () => monitor?.setEnabled(!!owner && !owner.isDestroyed() && focused(owner));
  const forget = (contents: WebContents) => {
    if (owner !== contents) return;
    // Discard queued native callbacks belonging to the previous composer.
    monitor?.stop();
    owner = undefined;
    ownerToken = undefined;
  };
  ipcMain.handle("parallax:voiceHotkey", (event, enabled: unknown, token: unknown) => {
    const window = ownWindow(event.sender);
    if (
      !window ||
      event.senderFrame !== event.sender.mainFrame ||
      typeof enabled !== "boolean" ||
      typeof token !== "string" ||
      token.length > 128
    )
      return { available: false, error: "Voice input is available only in the app's thread view." };
    if (process.platform !== "darwin") return { available: false };
    if (!enabled) {
      if (ownerToken === token) forget(event.sender);
      return { available: !failure };
    }
    if (!monitor && !failure) {
      try {
        const file = app.isPackaged
          ? path.join(process.resourcesPath, "fn-key.node")
          : path.join(app.getAppPath(), "native/fn-key.node");
        monitor = createRequire(__filename)(file) as FnMonitor;
      } catch (error) {
        monitor = undefined;
        failure = `Hold Fn is unavailable. Use the microphone button. ${error instanceof Error ? error.message : "The native key monitor could not load."}`;
        console.warn(failure);
      }
    }
    if (failure) return { available: false, error: failure };
    if (owner !== event.sender || ownerToken !== token) {
      if (owner) forget(owner);
      try {
        monitor!.start((key) => {
          if (owner && !owner.isDestroyed()) owner.send("parallax:voiceKey", key);
        });
      } catch {
        failure = "The app-local Fn key monitor could not start.";
        return { available: false, error: failure };
      }
      owner = event.sender;
      ownerToken = token;
    }
    refresh();
    return { available: true };
  });
  app.on("browser-window-focus", refresh);
  app.on("browser-window-blur", () => {
    monitor?.setEnabled(false);
    // Covers mic-button sessions as well as Fn, before a hidden window could retain capture.
    if (owner && !owner.isDestroyed()) owner.send("parallax:voiceKey", "cancel");
  });
  app.on("web-contents-created", (_event, contents) => {
    contents.on("did-navigate", () => forget(contents));
    contents.once("destroyed", () => forget(contents));
  });
  app.once("will-quit", () => monitor?.stop());
  const mayUseMic = (contents: WebContents | null) => !!contents && focused(contents);
  session.defaultSession.setPermissionRequestHandler((contents, permission, grant, details) => {
    grant(
      mayUseMic(contents) &&
        ((permission === "media" &&
          "mediaTypes" in details &&
          details.mediaTypes?.length === 1 &&
          details.mediaTypes[0] === "audio") ||
          permission === "clipboard-sanitized-write"),
    );
  });
  session.defaultSession.setPermissionCheckHandler(
    (contents, permission, _origin, details) =>
      mayUseMic(contents) &&
      ((permission === "media" && details.mediaType === "audio") ||
        permission === "clipboard-sanitized-write"),
  );
}
