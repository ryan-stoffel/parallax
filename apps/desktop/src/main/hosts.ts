import { app, BrowserWindow, ipcMain, powerMonitor, type WebContents } from "electron";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import path from "node:path";

import { ErrorCodes, type CliKind } from "../protocol/generated/protocol";
import {
  UPDATE_CHANNELS,
  type ConnectionState,
  type RendererMethod,
  type RpcResponse,
  type SshHost,
  type SubscribeParams,
  type UpdateChannel,
} from "../preload/bridge";
import { Connection, sshCommand } from "./connection";
import { checkHost, readSettings, writeSettings, type Settings } from "./settings";
import {
  closeAllTerminals,
  closeTerminal,
  isCliKind,
  loginCommand,
  openTerminal,
  resizeTerminal,
  writeTerminal,
  type Command,
} from "./terminal";
import { dataDir, findWispd, replaceServe, wispdVersion } from "./wispd";

// The methods the renderer may call, checked at runtime because the renderer is untrusted
// (0022). Typed so that adding a method to the protocol fails the type-check until it is here.
const rendererMethods: Record<RendererMethod, true> = {
  "host/health": true,
  "host/version": true,
  "project/list": true,
  "project/create": true,
  "project/start": true,
  "project/update": true,
  "accounts/keys/add": true,
  "accounts/keys/list": true,
  "accounts/keys/remove": true,
  "accounts/list": true,
  "accounts/refresh": true,
  "usage/get": true,
  "usage/history": true,
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
  "agent/image": true,
  "agent/diff": true,
  "agent/file": true,
  "agent/accept": true,
  "agent/requestChanges": true,
  "agent/openPr": true,
  "thread/list": true,
  "repo/add": true,
  "thread/start": true,
  "thread/archive": true,
  "thread/delete": true,
};

/** Every host's connection, by host id: `local`, then each saved SSH host. */
const connections = new Map<string, Connection>();
/** Each window's subscriptions, by the key its preload chose. */
const subscriptions = new Map<WebContents, Map<string, () => void>>();

let settings: Settings = { hosts: [] };
/** Why `settings.json` couldn't be read, which blocks saving over it. */
let settingsError: string | undefined;
const settingsFile = () => path.join(app.getPath("userData"), "settings.json");

/**
 * Connects to the local wispd, as host id `local`, and to every saved SSH host at once, and
 * serves the `window.wisp` calls that reach wispd or edit the hosts and the update channel.
 * `onUpdateChannel` gets the channel at start and whenever it's saved.
 */
export function startHosts(onUpdateChannel: (channel: UpdateChannel) => void): void {
  addConnection("local", () => {
    const wispd = localWispd();
    return wispd === undefined ? undefined : [wispd, "attach"];
  });
  try {
    settings = readSettings(settingsFile());
  } catch (error) {
    settingsError = `wisp can't use ${settingsFile()}, so it won't save over it: ${(error as Error).message.replace(/\.$/, "")}. Fix or remove the file, then restart wisp.`;
    console.error(settingsError);
  }
  for (const host of settings.hosts) addSshConnection(host);

  ipcMain.handle("wisp:hosts", () => settings.hosts);
  ipcMain.handle("wisp:saveHost", (_event, input: unknown, id: unknown) => saveHost(input, id));
  ipcMain.handle("wisp:removeHost", (_event, id: unknown) => removeHost(id));

  const channel = () => settings.updateChannel ?? "nightly";
  onUpdateChannel(channel());
  ipcMain.handle("wisp:updateChannel", channel);
  ipcMain.handle("wisp:setUpdateChannel", (_event, next: unknown) => {
    // Unlike `ssh`, the renderer may set this, to one of the two channels.
    const chosen = UPDATE_CHANNELS.find((c) => c === next);
    if (!chosen) return "invalid update channel";
    const error = saveSettings({ ...settings, updateChannel: chosen });
    if (!error) onUpdateChannel(chosen);
    return error;
  });

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
    const { after, project, logId } = params;
    if (typeof key !== "string") throw new Error("invalid subscription key");
    if (typeof logId !== "string") throw new Error("logId must be a string");
    if (typeof after !== "number" || !Number.isSafeInteger(after) || after < 0) {
      throw new Error("after must be a non-negative integer");
    }
    if (project !== undefined && typeof project !== "string") throw new Error("invalid project");
    const host = connection(hostId);
    const sender = event.sender;
    // A reused key replaces its subscription instead of leaking the old one.
    windowSubscriptions(sender).get(key)?.();
    let ended = false;
    const unsubscribe = host.subscribe(
      { after, logId, ...(project !== undefined && { project }) } satisfies SubscribeParams,
      (message) => {
        if (message.type !== "event") {
          ended = true;
          windowSubscriptions(sender).delete(key);
        }
        if (!sender.isDestroyed()) sender.send("wisp:subscription", key, message);
      },
    );
    // It ends at once when `logId` is stale.
    if (!ended) windowSubscriptions(sender).set(key, unsubscribe);
  });

  ipcMain.handle("wisp:unsubscribe", (event, key: unknown) => {
    const unsubscribe = subscriptions.get(event.sender)?.get(String(key));
    subscriptions.get(event.sender)?.delete(String(key));
    unsubscribe?.();
  });

  ipcMain.handle("wisp:connectionState", (_event, hostId: unknown) => connection(hostId).state);
  ipcMain.handle("wisp:retry", (_event, hostId: unknown) => connection(hostId).retry());

  // A window's sign-in terminal (terminal.ts). The renderer names the host and the CLI; only
  // main decides what runs.
  ipcMain.handle(
    "wisp:openTerminal",
    (event, hostId: unknown, cli: unknown, cols: unknown, rows: unknown) => {
      if (typeof hostId !== "string" || !isCliKind(cli) || !isSize(cols) || !isSize(rows)) {
        return "invalid terminal";
      }
      return openTerminal(event.sender, () => signInCommand(hostId, cli), cols, rows);
    },
  );
  ipcMain.on("wisp:terminalInput", (event, data: unknown) => {
    if (typeof data === "string") writeTerminal(event.sender, data);
  });
  ipcMain.on("wisp:resizeTerminal", (event, cols: unknown, rows: unknown) => {
    if (isSize(cols) && isSize(rows)) resizeTerminal(event.sender, cols, rows);
  });
  ipcMain.on("wisp:closeTerminal", (event) => closeTerminal(event.sender));

  powerMonitor.on("resume", () => {
    for (const each of connections.values()) each.heartbeat();
  });
  app.on("will-quit", () => {
    for (const each of connections.values()) each.dispose();
    closeAllTerminals();
  });
}

/**
 * What signs in to `cli` on a host: the binary that host's wispd found, which is the one it runs
 * later, reached as the host's connection is. Resolves to an error for people.
 */
async function signInCommand(hostId: string, cli: CliKind): Promise<Command | string> {
  const host = connections.get(hostId);
  if (!host) return "That host isn't in wisp anymore.";
  // Decided before asking, so a remote host's path can never run on this computer.
  const saved = settings.hosts.find((h) => h.id === hostId);
  const ssh = saved && { destination: saved.destination, ssh: settings.ssh ?? "ssh" };
  const answer = await host.request("accounts/list", {});
  if ("error" in answer)
    return `wisp couldn't ask the host where the CLI is: ${answer.error.message}`;
  const path = answer.result.clis.find((each) => each.cli === cli)?.path;
  if (!path) return "That CLI isn't installed on this host anymore.";
  return loginCommand(cli, path, ssh);
}

/** The local `wispd` binary (wispd.ts). */
const localWispd = () =>
  findWispd({
    env: process.env,
    platform: process.platform,
    packaged: app.isPackaged,
    resourcesPath: process.resourcesPath,
    appPath: app.getAppPath(),
  });

/**
 * How often this launch has compared the local `wispd serve`'s version with its wispd's: at most
 * twice, so a re-attach to a serve still shutting down gets one more try.
 */
let serveChecks = 0;

/**
 * After an update, the local `wispd serve` may still be the previous app's, since attach reuses a
 * running one (0010). A packaged app replaces it when its version differs from the bundled
 * wispd's, older or newer (a move back to Standard), and reconnects, so attach starts the bundled
 * one. Only a serve a packaged wisp started is replaced (`replaceServe`), never a dev checkout's or
 * a wispd on PATH. Not on Windows, whose installer stops every process running from the app's
 * folder, `wispd.exe` included.
 */
async function replaceOtherServe(state: ConnectionState): Promise<void> {
  if (!app.isPackaged || serveChecks >= 2 || process.platform === "win32") return;
  const running =
    state.status === "connected"
      ? state.wispd
      : state.status === "failed"
        ? state.error.wispd
        : undefined;
  if (running === undefined) return;
  serveChecks++;
  const wispd = localWispd();
  const bundled = wispd === undefined ? undefined : await wispdVersion(wispd);
  const { stopped, why } = await replaceServe(
    dataDir(process.env, process.platform, homedir()),
    running,
    bundled,
  );
  console.log(`wisp: ${why}`);
  if (stopped) connections.get("local")?.retry();
}

/** Starts a host's connection, replacing any it had. */
function addConnection(hostId: string, command: () => string[] | undefined, destination?: string) {
  connections.get(hostId)?.dispose();
  const created = new Connection({
    command,
    ...(destination !== undefined && { destination }),
    clientVersion: app.getVersion(),
    onState: (state) => {
      // A replaced or removed connection has nothing more to say.
      if (connections.get(hostId) !== created) return;
      broadcast("wisp:state", hostId, state);
      if (hostId === "local") void replaceOtherServe(state);
    },
  });
  connections.set(hostId, created);
  created.start();
}

function addSshConnection({ id, destination }: SshHost): void {
  addConnection(id, () => sshCommand(destination, settings.ssh), destination);
}

/** `window.wisp.saveHost`. Its input comes from the renderer, so it's checked here. */
function saveHost(input: unknown, id: unknown): string | undefined {
  if (!isObject(input) || typeof input["name"] !== "string") return "invalid host";
  if (typeof input["destination"] !== "string") return "invalid host";
  const checked = checkHost({ name: input["name"], destination: input["destination"] });
  if (typeof checked === "string") return checked;
  const old = settings.hosts.find((h) => h.id === id);
  if (id !== undefined && !old) return "That host isn't in wisp anymore.";
  const host: SshHost = { id: old?.id ?? randomUUID(), ...checked };
  const hosts = old ? settings.hosts.map((h) => (h === old ? host : h)) : [...settings.hosts, host];
  const error = saveSettings({ ...settings, hosts });
  if (error) return error;
  // A rename keeps the connection; a new destination needs a new one.
  if (old?.destination !== host.destination) addSshConnection(host);
  return undefined;
}

/** `window.wisp.removeHost`. Resolves to an error for people, as `saveHost` does. */
function removeHost(id: unknown): string | undefined {
  if (typeof id !== "string" || !settings.hosts.some((h) => h.id === id)) return undefined;
  const error = saveSettings({ ...settings, hosts: settings.hosts.filter((h) => h.id !== id) });
  if (error) return error;
  connections.get(id)?.dispose();
  connections.delete(id);
  return undefined;
}

/** Writes the settings and tells every window about the hosts. Resolves to an error for people. */
function saveSettings(next: Settings): string | undefined {
  if (settingsError) return settingsError;
  try {
    writeSettings(settingsFile(), next);
  } catch (error) {
    return `wisp couldn't save its settings: ${(error as Error).message}`;
  }
  settings = next;
  broadcast("wisp:hosts", next.hosts);
  return undefined;
}

function connection(hostId: unknown): Connection {
  const found = typeof hostId === "string" ? connections.get(hostId) : undefined;
  if (!found) throw new Error(`unknown host: ${String(hostId)}`);
  return found;
}

/** A terminal's width or height, in character cells. */
const isSize = (value: unknown): value is number =>
  Number.isInteger(value) && (value as number) > 0 && (value as number) <= 1000;

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function invalid(code: number, message: string): RpcResponse<never> {
  return { error: { code, message } };
}

function broadcast(channel: string, ...args: unknown[]): void {
  for (const window of BrowserWindow.getAllWindows()) window.webContents.send(channel, ...args);
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
