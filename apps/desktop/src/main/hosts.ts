import { app, ipcMain, powerMonitor, type WebContents } from "electron";
import { execFile, execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { stat } from "node:fs/promises";
import { homedir, hostname } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { ErrorCodes, REQUEST_METHODS, type CliKind } from "../protocol/generated/protocol";
import {
  HOME_VARS,
  NPM_INSTALLS,
  type ConnectState,
  type ConnectionState,
  type DeviceHost,
  type DeviceIcon,
  iconFor,
  withheldMethods,
  type RendererMethod,
  type RpcResponse,
  type SshHost,
  type SubscribeParams,
} from "../preload/bridge";
import {
  addCommand,
  deviceHostId,
  findConnect,
  installConnectCommand,
  isDeviceAddress,
  isDeviceIcon,
  isSshUser,
  mergeFound,
  type SavedDevice,
} from "./connect";
import { Connection, sshCommand } from "./connection";
import { checkHost, readSettings, writeSettings, type Settings } from "./settings";
import { sshSuggestions } from "./sshConfig";
import {
  closeAllTerminals,
  closeTerminal,
  installCommand,
  isCliKind,
  isInstallable,
  loginCommand,
  hostLogin,
  openTerminal,
  resizeTerminal,
  runInstall,
  shellCommand,
  writeTerminal,
  type Command,
  type SshTarget,
} from "./terminal";
import { dataDir, findPlxd, replaceServe, plxdVersion, serviceLoaded } from "./plxd";
import { isNightly } from "./updater";
import { broadcast, perWindow } from "./windows";

// With PLX_IPC_STATS set, the subscription messages sent to renderers and their JSON bytes, for
// the load test (PLX-447), which reads `globalThis.ipcStats` through Playwright's `app.evaluate`.
const ipcStats = process.env["PLX_IPC_STATS"]
  ? ((globalThis as { ipcStats?: { messages: number; bytes: number } }).ipcStats = {
      messages: 0,
      bytes: 0,
    })
  : undefined;

// The methods the renderer may call, checked at runtime because the renderer is untrusted. Per
// 0022 it may call any plxd method, so a new protocol method reaches it by default, unless it's
// added to `withheldMethods` (bridge.ts).
const rendererMethods = new Set<string>(REQUEST_METHODS);
for (const method of withheldMethods) rendererMethods.delete(method);

/** Every host's connection, by host id: `local`, then each saved SSH host. */
const connections = new Map<string, Connection>();
/** Each window's subscriptions, by the key its preload chose. */
const subscriptions = new Map<WebContents, Map<string, () => void>>();

let settings: Settings = { hosts: [] };
/** Why `settings.json` couldn't be read, which blocks saving over it. */
let settingsError: string | undefined;
const settingsFile = () => path.join(app.getPath("userData"), "settings.json");

/**
 * Connects to the local plxd, as host id `local`, and to every saved SSH host at once, and
 * serves the `window.parallax` calls that reach plxd or edit the hosts.
 */
export function startHosts(): void {
  addConnection("local", () => {
    const plxd = localPlxd();
    return plxd === undefined ? undefined : [plxd, "attach"];
  });
  try {
    settings = readSettings(settingsFile());
  } catch (error) {
    settingsError = `Parallax can't use ${settingsFile()}, so it won't save over it: ${(error as Error).message.replace(/\.$/, "")}. Fix or remove the file, then restart Parallax.`;
    console.error(settingsError);
  }
  for (const host of settings.hosts) addSshConnection(host);
  void findConnect(connectProgram(), homedir()).then((found) => {
    connectInstalled = found;
    broadcast("parallax:connect", connectState());
  });

  ipcMain.handle("parallax:connect", () => connectState());
  ipcMain.handle("parallax:installConnect", async () => {
    const failed = await runInstall(installConnectCommand(connectProgram()));
    connectInstalled = failed ? connectInstalled : await findConnect(connectProgram(), homedir());
    broadcast("parallax:connect", connectState());
    return failed;
  });
  ipcMain.handle("parallax:setConnect", (_event, on: unknown) =>
    typeof on === "boolean" ? setConnect(on) : "invalid setting",
  );
  ipcMain.handle("parallax:devices", () => deviceHosts());
  ipcMain.handle("parallax:saveDevice", (_event, hostId: unknown, look: unknown) =>
    saveDevice(hostId, look),
  );
  ipcMain.handle("parallax:setDeviceEnabled", (_event, hostId: unknown, enabled: unknown) =>
    typeof enabled === "boolean" ? setDeviceEnabled(hostId, enabled) : undefined,
  );
  ipcMain.handle("parallax:removeDevice", (_event, hostId: unknown) => removeDevice(hostId));

  ipcMain.handle("parallax:hosts", () => settings.hosts);
  ipcMain.handle("parallax:sshSuggestions", () => sshSuggestions(homedir()));
  ipcMain.handle("parallax:saveHost", (_event, input: unknown, id: unknown) => saveHost(input, id));
  ipcMain.handle("parallax:removeHost", (_event, id: unknown) => removeHost(id));
  ipcMain.handle("parallax:localName", () => localName());
  ipcMain.handle("parallax:renameLocal", (_event, name: unknown) => {
    if (typeof name !== "string") return "invalid name";
    const label = name
      .replace(/\p{Cc}/gu, "")
      .trim()
      .slice(0, 64);
    const { localName: _old, ...rest } = settings;
    const error = saveSettings(label ? { ...rest, localName: label } : rest);
    if (error) return error;
    broadcast("parallax:localName", localName());
    // Other Connect devices show this computer by its plxd's name (0056).
    if (connectOn !== undefined)
      void connections.get("local")?.request("host/settings/set", { deviceName: label });
    return undefined;
  });

  // Answers `{error}` rather than throwing, so a bad call reads like any failed request.
  ipcMain.handle(
    "parallax:request",
    (_event, hostId: unknown, method: unknown, params: unknown) => {
      if (typeof method !== "string" || !rendererMethods.has(method)) {
        return invalid(ErrorCodes.MethodNotFound, `unknown method: ${String(method)}`);
      }
      const host = typeof hostId === "string" ? connections.get(hostId) : undefined;
      if (!host) return invalid(ErrorCodes.InvalidParams, `unknown host: ${String(hostId)}`);
      // plxd validates the params' shape; they only have to be an object to be sent.
      if (!isObject(params)) return invalid(ErrorCodes.InvalidParams, "params must be an object");
      return host.request(method as RendererMethod, params as never);
    },
  );

  ipcMain.handle("parallax:subscribe", (event, hostId: unknown, key: unknown, params: unknown) => {
    if (!isObject(params)) throw new Error("params must be an object");
    const { after, project, logId, run, shell } = params;
    if (typeof key !== "string") throw new Error("invalid subscription key");
    if (typeof logId !== "string") throw new Error("logId must be a string");
    if (typeof after !== "number" || !Number.isSafeInteger(after) || after < 0) {
      throw new Error("after must be a non-negative integer");
    }
    if (project !== undefined && typeof project !== "string") throw new Error("invalid project");
    if (run !== undefined && typeof run !== "string") throw new Error("invalid run");
    if (shell !== undefined && typeof shell !== "boolean") throw new Error("invalid shell");
    const host = connection(hostId);
    const sender = event.sender;
    // A reused key replaces its subscription instead of leaking the old one.
    windowSubscriptions(sender).get(key)?.();
    let ended = false;
    const unsubscribe = host.subscribe(
      {
        after,
        logId,
        ...(project !== undefined && { project }),
        ...(run !== undefined && { run }),
        ...(shell !== undefined && { shell }),
      } satisfies SubscribeParams,
      (message) => {
        if (message.type !== "event") {
          ended = true;
          windowSubscriptions(sender).delete(key);
        }
        if (sender.isDestroyed()) return;
        if (ipcStats) {
          ipcStats.messages += 1;
          ipcStats.bytes += Buffer.byteLength(JSON.stringify(message));
        }
        sender.send("parallax:subscription", key, message);
      },
    );
    // It ends at once when `logId` is stale.
    if (!ended) windowSubscriptions(sender).set(key, unsubscribe);
  });

  ipcMain.handle("parallax:unsubscribe", (event, key: unknown) => {
    const unsubscribe = subscriptions.get(event.sender)?.get(String(key));
    subscriptions.get(event.sender)?.delete(String(key));
    unsubscribe?.();
  });

  ipcMain.handle("parallax:connectionState", (_event, hostId: unknown) => connection(hostId).state);
  ipcMain.handle("parallax:retry", (_event, hostId: unknown) => connection(hostId).retry());

  // A window's terminals (terminal.ts), by an id it picks: an SSH host's login, a CLI's or a
  // provider instance's sign-in, an agent's install by its provider kind, or a shell in a thread's
  // folder. The renderer names the host and the CLI, instance, kind, or folder; only main decides
  // what runs.
  ipcMain.handle(
    "parallax:openTerminal",
    (event, id: unknown, target: unknown, cols: unknown, rows: unknown) => {
      if (!isTerminalId(id) || !isObject(target) || !isSize(cols) || !isSize(rows)) {
        return "invalid terminal";
      }
      const { hostId, cli, provider, install, path, connect, login } = target;
      if (typeof hostId !== "string") return "invalid terminal";
      if (login === true) {
        const command = hostLogin(hostId, settings.hosts, settings.ssh);
        if (!command) return "invalid terminal";
        return openTerminal(event.sender, id, () => Promise.resolve(command), cols, rows);
      }
      if (isObject(connect)) {
        const { device, user } = connect;
        if (
          hostId !== "local" ||
          !isDeviceAddress(device) ||
          (user !== undefined && !isSshUser(user))
        )
          return "invalid terminal";
        const command = addCommand(device, user, channel(), connectProgram());
        return openTerminal(event.sender, id, () => Promise.resolve(command), cols, rows);
      }
      if (isInstallable(install)) {
        return openTerminal(event.sender, id, () => installOn(hostId, install), cols, rows);
      }
      if (isCliKind(cli)) {
        return openTerminal(event.sender, id, () => signInCommand(hostId, cli), cols, rows);
      }
      if (typeof provider === "string") {
        const command = () => providerSignInCommand(hostId, provider);
        return openTerminal(event.sender, id, command, cols, rows);
      }
      if (typeof path !== "string") return "invalid terminal";
      return openTerminal(event.sender, id, () => folderCommand(hostId, path), cols, rows);
    },
  );
  // An npm install of an agent on a host, with no terminal (PLX-558).
  ipcMain.handle("parallax:install", async (_event, hostId: unknown, kind: unknown) => {
    if (
      typeof hostId !== "string" ||
      typeof kind !== "string" ||
      !Object.hasOwn(NPM_INSTALLS, kind)
    )
      return "invalid install";
    return runInstall(await installOn(hostId, kind));
  });
  ipcMain.on("parallax:terminalInput", (event, id: unknown, data: unknown) => {
    if (isTerminalId(id) && typeof data === "string") writeTerminal(event.sender, id, data);
  });
  ipcMain.on("parallax:resizeTerminal", (event, id: unknown, cols: unknown, rows: unknown) => {
    if (isTerminalId(id) && isSize(cols) && isSize(rows))
      resizeTerminal(event.sender, id, cols, rows);
  });
  ipcMain.on("parallax:closeTerminal", (event, id: unknown) => {
    if (isTerminalId(id)) closeTerminal(event.sender, id);
  });

  powerMonitor.on("resume", () => {
    for (const each of connections.values()) each.heartbeat();
  });
  app.on("will-quit", () => {
    for (const each of connections.values()) each.dispose();
    closeAllTerminals();
  });
}

/**
 * How a host's terminals reach it, unless it's this computer: an SSH host by its destination, a
 * Connect device (0056) by ssh to its Tailscale IP, as `plx-connect add` did. Undefined only for
 * `local`, so a remote host's command can never run here.
 */
function sshOf(hostId: string): SshTarget | undefined {
  const ssh = settings.ssh ?? "ssh";
  const saved = settings.hosts.find((h) => h.id === hostId);
  if (saved) return { destination: saved.destination, ssh };
  if (!hostId.startsWith("tailnet:")) return undefined;
  const device = savedDevices().find((d) => deviceHostId(d.id) === hostId);
  // An unknown device has no address; a bare `-` never reaches ssh as one.
  return { destination: device?.ip ?? "-", ssh };
}

/**
 * What installs an agent of provider kind `kind` on a host, in its shell (main's terminal.ts).
 * Resolves to an error for people.
 */
async function installOn(hostId: string, kind: string): Promise<Command | string> {
  // A host that's gone has no ssh target, and mustn't install here instead.
  const host = connections.get(hostId);
  if (!host) return "That host isn't in Parallax anymore.";
  const ssh = sshOf(hostId);
  // An SSH host's OS decides its shell; this computer's is known.
  const version = ssh ? await host.request("host/version", {}) : undefined;
  if (version && "error" in version)
    return `Parallax couldn't ask the host which OS it runs: ${version.error.message}`;
  const os = version && "result" in version ? version.result.os : undefined;
  return installCommand(kind, ssh, process.platform, process.env, os);
}

/**
 * What signs in to `cli` on a host: the binary that host's plxd found, which is the one it runs
 * later, reached as the host's connection is. Resolves to an error for people.
 */
async function signInCommand(hostId: string, cli: CliKind): Promise<Command | string> {
  const host = connections.get(hostId);
  if (!host) return "That host isn't in Parallax anymore.";
  // Decided before asking, so a remote host's path can never run on this computer.
  const ssh = sshOf(hostId);
  const answer = await host.request("accounts/list", {});
  if ("error" in answer)
    return `Parallax couldn't ask the host where the CLI is: ${answer.error.message}`;
  const path = answer.result.clis.find((each) => each.cli === cli)?.path;
  if (!path) return "That CLI isn't installed on this host anymore.";
  return loginCommand(cli, path, ssh);
}

/**
 * What signs in to provider instance `id` on a host: its `login` argv from the host's plxd, run as
 * it is, with its `loginEnv` and its home's variable set, so a second Codex signs in to its own `CODEX_HOME`. A
 * program that's the one plxd found runs from where it found it, as a CLI's sign-in does.
 * Resolves to an error for people.
 */
async function providerSignInCommand(hostId: string, id: string): Promise<Command | string> {
  const host = connections.get(hostId);
  if (!host) return "That host isn't in Parallax anymore.";
  const ssh = sshOf(hostId);
  const answer = await host.request("providers/list", { refresh: false });
  if ("error" in answer)
    return `Parallax couldn't ask the host how to sign in: ${answer.error.message}`;
  const found = answer.result.providers.find((p) => p.instance.id === id);
  if (!found) return "That provider isn't on this host anymore.";
  const [program, ...args] = found.login ?? [];
  if (!program) return "That provider has no sign-in on this host.";
  const { kind, home } = found.instance;
  const homeVar = HOME_VARS[kind];
  const env = {
    ...Object.fromEntries((found.loginEnv ?? []).map((v) => [v.name, v.value ?? ""])),
    ...(homeVar && home ? { [homeVar]: home } : {}),
  };
  const own = found.path && /[^/\\]+$/.exec(found.path)?.[0].replace(/\.\w+$/, "") === program;
  return loginCommand(kind, own ? found.path! : program, ssh, undefined, args, env);
}

/**
 * This computer's name in Parallax: the user's, else the computer's own. macOS's is the Computer
 * Name in System Settings, such as "macbook"; elsewhere, the host name.
 */
function localName(): string {
  return settings.localName || (computerName ??= readComputerName());
}
let computerName: string | undefined;
function readComputerName(): string {
  if (process.platform === "darwin") {
    try {
      const name = execFileSync("scutil", ["--get", "ComputerName"], { encoding: "utf8" }).trim();
      if (name) return name;
    } catch {
      // Falls back to the host name.
    }
  }
  return hostname().replace(/\.local$/, "");
}

/** A saved SSH host by id. Undefined for this computer, `local`, and for an unknown id. */
export const savedHost = (id: string): SshHost | undefined =>
  settings.hosts.find((h) => h.id === id);

/**
 * What opens a shell in `folder` on a host: here, if it's still a folder; on an SSH host, over
 * ssh as the host's connection is. Resolves to an error for people.
 */
async function folderCommand(hostId: string, folder: string): Promise<Command | string> {
  // "~" is the host's home folder: here, the user's; over ssh, the login shell's start folder.
  const ssh = sshOf(hostId);
  if (folder === "~" && !ssh) folder = homedir();
  if (!connections.has(hostId)) return "That host isn't in Parallax anymore.";
  // A Windows path, which can't hold a `"`, goes to the host in double quotes.
  if (ssh && /^[a-z]:\\/i.test(folder) && folder.includes('"')) return `${folder} isn't a folder.`;
  if (ssh) return shellCommand(folder, ssh);
  const isFolder =
    path.isAbsolute(folder) && (await stat(folder).catch(() => undefined))?.isDirectory();
  return isFolder ? shellCommand(folder) : `${folder} isn't a folder on this computer anymore.`;
}

/** The local `plxd` binary (plxd.ts). */
const localPlxd = () =>
  findPlxd({
    env: process.env,
    platform: process.platform,
    packaged: app.isPackaged,
    resourcesPath: process.resourcesPath,
    appPath: app.getAppPath(),
  });

/**
 * How often this launch has compared the local `plxd serve`'s version with its plxd's: at most
 * twice, so a re-attach to a serve still shutting down gets one more try.
 */
let serveChecks = 0;

/**
 * After an update, the local `plxd serve` may still be the previous app's, since attach reuses a
 * running one (0010). A packaged app replaces it when its version differs from the bundled
 * plxd's, older or newer (a move back to Standard), and reconnects, so attach starts the bundled
 * one. Only a serve a packaged Parallax started is replaced (`replaceServe`), never a dev checkout's or
 * a plxd on PATH. Not on Windows, whose installer stops every process running from the app's
 * folder, `plxd.exe` included.
 */
async function replaceOtherServe(state: ConnectionState): Promise<void> {
  if (!app.isPackaged || serveChecks >= 2 || process.platform === "win32") return;
  const running =
    state.status === "connected"
      ? state.plxd
      : state.status === "failed"
        ? state.error.plxd
        : undefined;
  if (running === undefined) return;
  serveChecks++;
  const plxd = localPlxd();
  const bundled = plxd === undefined ? undefined : await plxdVersion(plxd);
  const { stopped, why } = await replaceServe(
    dataDir(process.env, process.platform, homedir()),
    running,
    bundled,
  );
  console.log(`parallax: ${why}`);
  if (stopped) connections.get("local")?.retry();
}

/**
 * Starts a host's connection, replacing any it had. `destination` names an SSH host and `device`
 * a Connect device in its errors.
 */
function addConnection(
  hostId: string,
  command: () => string[] | undefined,
  { destination, device }: { destination?: string; device?: string } = {},
) {
  connections.get(hostId)?.dispose();
  const created = new Connection({
    command,
    ...(destination !== undefined && { destination }),
    ...(device !== undefined && { device }),
    clientVersion: app.getVersion(),
    onState: (state) => {
      // A replaced or removed connection has nothing more to say.
      if (connections.get(hostId) !== created) return;
      // An SSH host without plxd on PATH gets one more try, from where Parallax installs it.
      if (
        destination !== undefined &&
        state.status === "failed" &&
        state.error.exitCode === 127 &&
        !locating.has(hostId)
      ) {
        locating.add(hostId);
        // After `fail` returns, so the new attempt starts from a settled state.
        return queueMicrotask(() => created.retry());
      }
      broadcast("parallax:state", hostId, state);
      if (hostId === "local") void replaceOtherServe(state);
      if (state.status !== "connected") return;
      if (hostId === "local") void refreshConnect();
      else if (hostId.startsWith("tailnet:")) void readLook(hostId);
    },
  });
  connections.set(hostId, created);
  created.start();
}

/**
 * SSH hosts whose `plxd attach` wasn't found, which run `LOCATE_PLXD` instead until the app
 * quits or the host's destination changes.
 */
const locating = new Set<string>();

function addSshConnection({ id, destination }: SshHost): void {
  locating.delete(id);
  addConnection(id, () => sshCommand(destination, settings.ssh, locating.has(id)), {
    destination,
  });
}

/** `window.parallax.saveHost`. Its input comes from the renderer, so it's checked here. */
function saveHost(input: unknown, id: unknown): string | undefined {
  if (!isObject(input) || typeof input["name"] !== "string") return "invalid host";
  if (typeof input["destination"] !== "string") return "invalid host";
  const checked = checkHost({ name: input["name"], destination: input["destination"] });
  if (typeof checked === "string") return checked;
  const old = settings.hosts.find((h) => h.id === id);
  if (id !== undefined && !old) return "That host isn't in Parallax anymore.";
  const host: SshHost = { id: old?.id ?? randomUUID(), ...checked };
  const hosts = old ? settings.hosts.map((h) => (h === old ? host : h)) : [...settings.hosts, host];
  const error = saveSettings({ ...settings, hosts });
  if (error) return error;
  // A rename keeps the connection; a new destination needs a new one.
  if (old?.destination !== host.destination) addSshConnection(host);
  return undefined;
}

/** `window.parallax.removeHost`. Resolves to an error for people, as `saveHost` does. */
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
    return `Parallax couldn't save its settings: ${(error as Error).message}`;
  }
  settings = next;
  broadcast("parallax:hosts", next.hosts);
  return undefined;
}

// Parallax Connect (0056): while the local plxd's `connect` is on, this app keeps a connection to
// every device `connect/devices` finds answering on the tailnet, as host `tailnet:<node id>`.

/** Whether plx-connect is installed here, undefined until looked for. */
let connectInstalled: boolean | undefined;
/** The local plxd's `connect`, undefined while unknown. */
let connectOn: boolean | undefined;
/** This computer's icon, from its plxd, when the user picked one. */
let localIcon: DeviceIcon | undefined;
let discovery: NodeJS.Timeout | undefined;
const DISCOVERY_MS = 15_000;

const connectProgram = () => ({ platform: process.platform, env: process.env });

/**
 * The channel `plx-connect add` installs: this app's own (0028). A development build follows
 * nightly, the channel with releases.
 */
const channel = () => (isNightly(app.getVersion()) || !app.isPackaged ? "nightly" : "stable");

function connectState(): ConnectState {
  return {
    ...(connectInstalled !== undefined && { installed: connectInstalled }),
    ...(connectOn !== undefined && { on: connectOn }),
    icon: localIcon ?? iconFor(localName()),
    channel: channel(),
  };
}

const savedDevices = () => settings.devices ?? [];

/** The devices as the renderer lists them, by name, less removed ones. None while Connect is off. */
function deviceHosts(): DeviceHost[] {
  if (!connectOn) return [];
  return savedDevices()
    .filter((d) => !d.removed)
    .map((d) => ({
      id: deviceHostId(d.id),
      name: d.name || d.hostName,
      icon: d.icon ?? iconFor(d.hostName),
      detected: iconFor(d.hostName),
      hostName: d.hostName,
      ip: d.ip,
      os: d.os,
      enabled: !d.off,
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** Keeps `devices`, in memory even when settings.json can't be written. */
function keepDevices(devices: SavedDevice[]): void {
  if (saveSettings({ ...settings, devices })) settings = { ...settings, devices };
}

/** Reads the local plxd's `connect` and this computer's icon, then follows them. */
async function refreshConnect(): Promise<void> {
  const answer = await connections.get("local")?.request("host/settings/get", {});
  const result = answer && "result" in answer ? answer.result : undefined;
  followConnect(result?.connect, result?.deviceIcon);
}

/** Connects to the devices and looks for more while `on`; drops their connections otherwise. */
function followConnect(on: boolean | undefined, icon?: string): void {
  connectOn = on;
  localIcon = isDeviceIcon(icon) ? icon : undefined;
  if (on) {
    for (const device of savedDevices()) addDeviceConnection(device);
    if (!discovery) {
      discovery = setInterval(() => void discover(), DISCOVERY_MS);
      void discover();
    }
  } else {
    clearInterval(discovery);
    discovery = undefined;
    for (const [id, each] of connections) {
      if (!id.startsWith("tailnet:")) continue;
      each.dispose();
      connections.delete(id);
    }
  }
  broadcast("parallax:connect", connectState());
  broadcast("parallax:devices", deviceHosts());
}

/** Whether the local plxd runs from its login service (`keepServing`), or a handover is running. */
let serviceState: "unknown" | "handingOver" | "done" = "unknown";

/**
 * While Connect is on, hands a packaged Mac app's local plxd over to its LaunchAgent (PLX-631).
 * Until then plxd is the app's child: macOS lists Parallax as running in the background after it
 * quits, and nothing starts plxd after a restart, so other computers can't reach it. Waits for no
 * agents to be running, since stopping `serve` ends their runs, and is tried at every discovery
 * until it's done. The connection reconnects through the LaunchAgent by itself. Linux's AppImage
 * runs plxd from a temporary mount a service can't point at, so plx-connect installs it there.
 */
async function keepServing(): Promise<void> {
  if (serviceState !== "unknown" || !app.isPackaged || process.platform !== "darwin") return;
  const plxd = localPlxd();
  // A translocated app runs from a random path that's gone once it quits.
  if (!plxd || plxd.includes("/AppTranslocation/")) return;
  serviceState = "handingOver";
  try {
    const run = (...args: string[]) => promisify(execFile)(plxd, args, { timeout: 60_000 });
    if (!serviceLoaded((await run("service", "status")).stdout)) {
      const health = await connections.get("local")?.request("host/health", {});
      if (!health || "error" in health || health.result.runningAgents > 0) {
        serviceState = "unknown";
        return;
      }
      await run("service", "install", "--replace");
      console.log("parallax: plxd runs from its login service now");
    }
    serviceState = "done";
  } catch (error) {
    // Tried again at the next discovery.
    console.warn("parallax: couldn't hand plxd over to its login service:", error);
    serviceState = "unknown";
  }
}

/** A device's connection, `plxd dial` to its current address, unless it has one or is off. */
function addDeviceConnection(device: SavedDevice): void {
  const id = deviceHostId(device.id);
  if (connections.has(id) || device.off || device.removed) return;
  addConnection(
    id,
    () => {
      const plxd = localPlxd();
      const ip = savedDevices().find((d) => d.id === device.id)?.ip;
      return plxd === undefined || !ip ? undefined : [plxd, "dial", ip];
    },
    { device: device.name || device.hostName },
  );
}

/** Asks the local plxd for the tailnet's devices, and connects to any new one. */
async function discover(): Promise<void> {
  const answer = await connections.get("local")?.request("connect/devices", {});
  if (!connectOn || !answer || "error" in answer) return;
  void keepServing();
  const { devices, changed } = mergeFound(savedDevices(), answer.result.devices);
  if (changed) keepDevices(devices);
  for (const device of devices) addDeviceConnection(device);
  // Names and icons given on other computers.
  await Promise.all(devices.map((d) => readLook(deviceHostId(d.id), false)));
  broadcast("parallax:devices", deviceHosts());
}

/** Reads a connected device's name and icon from its plxd, and keeps them. */
async function readLook(hostId: string, announce = true): Promise<void> {
  const host = connections.get(hostId);
  if (host?.state.status !== "connected") return;
  const answer = await host.request("host/settings/get", {});
  if ("error" in answer) return;
  const nodeId = hostId.slice("tailnet:".length);
  const old = savedDevices().find((d) => d.id === nodeId);
  const name = answer.result.deviceName || undefined;
  const icon = isDeviceIcon(answer.result.deviceIcon) ? answer.result.deviceIcon : undefined;
  if (!old || (old.name === name && old.icon === icon)) return;
  const { name: _name, icon: _icon, ...rest } = old;
  const next = { ...rest, ...(name && { name }), ...(icon && { icon }) };
  keepDevices(savedDevices().map((d) => (d === old ? next : d)));
  if (announce) broadcast("parallax:devices", deviceHosts());
}

/** `window.parallax.setConnect`. Resolves to an error for people. */
async function setConnect(on: boolean): Promise<string | undefined> {
  const answer = await connections.get("local")?.request("host/settings/set", { connect: on });
  if (!answer || "error" in answer) {
    const why = answer && "error" in answer ? answer.error.message : "plxd isn't connected";
    return `Parallax couldn't turn Connect ${on ? "on" : "off"}: ${why}`;
  }
  if (answer.result.connect === undefined)
    return "This computer's plxd doesn't have Parallax Connect yet. Update Parallax.";
  followConnect(answer.result.connect, answer.result.deviceIcon);
  return undefined;
}

/** `window.parallax.saveDevice`: a name or icon, saved on the device's own plxd. */
async function saveDevice(hostId: unknown, look: unknown): Promise<string | undefined> {
  if (typeof hostId !== "string" || !isObject(look)) return "invalid device";
  const { name, icon } = look;
  if (name !== undefined && typeof name !== "string") return "invalid device";
  if (icon !== undefined && !isDeviceIcon(icon)) return "invalid device";
  const host = connections.get(hostId);
  if (!host || (hostId !== "local" && !hostId.startsWith("tailnet:")))
    return "That device isn't in Parallax anymore.";
  const answer = await host.request("host/settings/set", {
    ...(name !== undefined && { deviceName: name }),
    ...(icon !== undefined && { deviceIcon: icon }),
  });
  if ("error" in answer) return `Parallax couldn't save it on that device: ${answer.error.message}`;
  if (hostId !== "local") {
    await readLook(hostId);
    return undefined;
  }
  localIcon = isDeviceIcon(answer.result.deviceIcon) ? answer.result.deviceIcon : undefined;
  broadcast("parallax:connect", connectState());
  return undefined;
}

/** Drops a device's connection, if it has one. */
function dropDeviceConnection(hostId: string): void {
  connections.get(hostId)?.dispose();
  connections.delete(hostId);
}

/** A saved device by host id. */
const deviceOf = (hostId: unknown) =>
  typeof hostId === "string"
    ? savedDevices().find((d) => deviceHostId(d.id) === hostId)
    : undefined;

/**
 * `window.parallax.setDeviceEnabled`. On also clears `removed`; for a device not found yet, it
 * looks now, and `discover` adds it.
 */
async function setDeviceEnabled(hostId: unknown, enabled: boolean): Promise<void> {
  const device = deviceOf(hostId);
  if (!device) {
    if (enabled && connectOn) await discover();
    return;
  }
  const { off: _off, removed: _removed, ...rest } = device;
  const next: SavedDevice = enabled ? rest : { ...rest, off: true };
  keepDevices(savedDevices().map((d) => (d === device ? next : d)));
  if (enabled) addDeviceConnection(next);
  else dropDeviceConnection(deviceHostId(device.id));
  broadcast("parallax:devices", deviceHosts());
}

/** `window.parallax.removeDevice`. The device stays saved as removed, so discovery skips it. */
function removeDevice(hostId: unknown): void {
  const device = deviceOf(hostId);
  if (!device) return;
  const { off: _off, ...rest } = device;
  keepDevices(savedDevices().map((d) => (d === device ? { ...rest, removed: true as const } : d)));
  dropDeviceConnection(deviceHostId(device.id));
  broadcast("parallax:devices", deviceHosts());
}

function connection(hostId: unknown): Connection {
  const found = typeof hostId === "string" ? connections.get(hostId) : undefined;
  if (!found) throw new Error(`unknown host: ${String(hostId)}`);
  return found;
}

/** A terminal's id, which its window picks. */
const isTerminalId = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= 500;

/** A terminal's width or height, in character cells. */
const isSize = (value: unknown): value is number =>
  Number.isInteger(value) && (value as number) > 0 && (value as number) <= 1000;

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function invalid(code: number, message: string): RpcResponse<never> {
  return { error: { code, message } };
}

/** A window's subscriptions, ended when it closes or reloads, since its listeners are gone. */
const windowSubscriptions = (sender: WebContents) =>
  perWindow(subscriptions, sender, (own) => {
    for (const unsubscribe of own.values()) unsubscribe();
    own.clear();
  });
