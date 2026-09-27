import { app, BrowserWindow, ipcMain, powerMonitor, type WebContents } from "electron";

import { ErrorCodes, type EventsSubscribeParams } from "../protocol/generated/protocol";
import type { ConnectionState, RendererMethod, RpcResponse } from "../preload/bridge";
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

  // Answers `{error}` rather than throwing, so a bad call reads like any failed request.
  ipcMain.handle("wisp:request", (_event, hostId: unknown, method: unknown, params: unknown) => {
    if (typeof method !== "string" || !Object.hasOwn(rendererMethods, method)) {
      return invalid(ErrorCodes.MethodNotFound, `unknown method: ${String(method)}`);
    }
    const host = typeof hostId === "string" ? connections.get(hostId) : undefined;
    if (!host) return invalid(ErrorCodes.InvalidParams, `unknown host: ${String(hostId)}`);
    // wispd validates the params' shape; they only have to be an object to be sent.
    if (!isObject(params)) return invalid(ErrorCodes.InvalidParams, "params must be an object");
    return host.request(method as RendererMethod, params as never);
  });

  ipcMain.handle("wisp:subscribe", (event, hostId: unknown, key: unknown, params: unknown) => {
    if (!isObject(params)) throw new Error("params must be an object");
    const { after, project } = params;
    if (typeof key !== "string") throw new Error("invalid subscription key");
    if (typeof after !== "number" || !Number.isSafeInteger(after) || after < 0) {
      throw new Error("after must be a non-negative integer");
    }
    if (project !== undefined && typeof project !== "string") throw new Error("invalid project");
    const host = connection(hostId);
    const sender = event.sender;
    // A reused key replaces its subscription instead of leaking the old one.
    windowSubscriptions(sender).get(key)?.();
    const unsubscribe = host.subscribe(
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

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function invalid(code: number, message: string): RpcResponse<never> {
  return { error: { code, message } };
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
    // `did-navigate` fires when a main-frame navigation commits, such as a reload. Not
    // `did-start-navigation`, which also fires for link clicks that `will-navigate` cancels.
    sender.on("did-navigate", endAll);
    sender.once("destroyed", () => {
      endAll();
      subscriptions.delete(sender);
    });
    subscriptions.set(sender, created);
    own = created;
  }
  return own;
}
