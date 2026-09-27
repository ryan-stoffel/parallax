import { app, BrowserWindow, ipcMain, powerMonitor, type WebContents } from "electron";

import type { EventsSubscribeParams } from "../protocol/generated/protocol";
import type { ConnectionState, RendererMethod } from "../preload/bridge";
import { Connection } from "./connection";
import { findWispd } from "./wispd";

// The methods the renderer may call, checked at runtime because the renderer is untrusted
// (0022). Typed so that adding a method to the protocol fails the type-check until it is here.
const rendererMethods: Record<RendererMethod, true> = {
  "host/health": true,
  "host/version": true,
  "project/list": true,
  "project/create": true,
  "accounts/keys/add": true,
  "accounts/keys/list": true,
  "accounts/keys/remove": true,
  "accounts/list": true,
  "accounts/refresh": true,
  "usage/get": true,
  "accounts/defaults/get": true,
  "accounts/defaults/set": true,
  "context/list": true,
  "context/read": true,
  "context/write": true,
  "agent/start": true,
  "agent/send": true,
  "agent/cancel": true,
  "agent/list": true,
  "agent/events": true,
  "agent/diff": true,
  "agent/file": true,
  "agent/accept": true,
  "agent/requestChanges": true,
  "thread/list": true,
  "repo/add": true,
  "thread/start": true,
  "thread/archive": true,
  "thread/delete": true,
};

const connections = new Map<string, Connection>();
/** Each window's subscriptions, by the key its preload chose. */
const subscriptions = new Map<WebContents, Map<string, () => void>>();

/**
 * Connects to the local wispd, as host id `local`, and serves the `window.wisp` calls that
 * reach wispd. SSH hosts (RYA-26) become more entries in `connections`.
 */
export function startHosts(): void {
  const local = new Connection({
    locate: () =>
      findWispd({
        env: process.env,
        platform: process.platform,
        packaged: app.isPackaged,
        resourcesPath: process.resourcesPath,
        appPath: app.getAppPath(),
      }),
    clientVersion: app.getVersion(),
    onState: (state) => broadcastState("local", state),
  });
  connections.set("local", local);
  local.start();

  ipcMain.handle("wisp:request", (_event, hostId: unknown, method: unknown, params: unknown) => {
    if (typeof method !== "string" || !Object.hasOwn(rendererMethods, method)) {
      throw new Error(`unknown method: ${String(method)}`);
    }
    // wispd validates the params' shape; they only have to be an object to be sent.
    return connection(hostId).request(method as RendererMethod, object(params) as never);
  });

  ipcMain.handle("wisp:subscribe", (event, hostId: unknown, key: unknown, params: unknown) => {
    const { after, project } = object(params);
    if (typeof key !== "string" || typeof after !== "number") throw new Error("invalid subscribe");
    if (project !== undefined && typeof project !== "string") throw new Error("invalid project");
    const sender = event.sender;
    const unsubscribe = connection(hostId).subscribe(
      { after, ...(project !== undefined && { project }) } satisfies EventsSubscribeParams,
      (message) => {
        if (message.type !== "event") windowSubscriptions(sender).delete(key);
        if (!sender.isDestroyed()) sender.send("wisp:subscription", key, message);
      },
    );
    windowSubscriptions(sender).set(key, unsubscribe);
  });

  ipcMain.handle("wisp:unsubscribe", (event, key: unknown) => {
    const unsubscribe = subscriptions.get(event.sender)?.get(String(key));
    subscriptions.get(event.sender)?.delete(String(key));
    unsubscribe?.();
  });

  ipcMain.handle("wisp:connectionState", (_event, hostId: unknown) => connection(hostId).state);
  ipcMain.handle("wisp:retry", (_event, hostId: unknown) => connection(hostId).retry());

  powerMonitor.on("resume", () => {
    for (const each of connections.values()) each.heartbeat();
  });
  app.on("will-quit", () => {
    for (const each of connections.values()) each.dispose();
  });
}

function connection(hostId: unknown): Connection {
  const found = typeof hostId === "string" ? connections.get(hostId) : undefined;
  if (!found) throw new Error(`unknown host: ${String(hostId)}`);
  return found;
}

function object(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("params must be an object");
  }
  return value as Record<string, unknown>;
}

function broadcastState(hostId: string, state: ConnectionState): void {
  for (const window of BrowserWindow.getAllWindows()) {
    window.webContents.send("wisp:state", hostId, state);
  }
}

/** A window's subscriptions, ended when it closes or reloads, since its listeners are gone. */
function windowSubscriptions(sender: WebContents): Map<string, () => void> {
  let own = subscriptions.get(sender);
  if (!own) {
    const created = new Map<string, () => void>();
    const endAll = () => {
      for (const unsubscribe of created.values()) unsubscribe();
      created.clear();
    };
    sender.on("did-start-navigation", (details) => {
      if (details.isMainFrame && !details.isSameDocument) endAll();
    });
    sender.once("destroyed", () => {
      endAll();
      subscriptions.delete(sender);
    });
    subscriptions.set(sender, created);
    own = created;
  }
  return own;
}
