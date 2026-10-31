import { app, ipcMain, powerMonitor, type WebContents } from "electron";
import { execFile, execFileSync, spawn } from "node:child_process";
import { rmSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { homedir, hostname } from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { promisify } from "node:util";

import {
  ErrorCodes,
  REQUEST_METHODS,
  type AccessRequest,
  type CliKind,
  type DeviceStreamParams,
  type RelayHost,
  type RemoteSessionsResult,
} from "../protocol/generated/protocol";
import {
  HOME_VARS,
  NPM_INSTALLS,
  type AccessPrompt,
  type AccountAccess,
  type ConnectionState,
  type ConnectState,
  type DeviceHost,
  type DeviceIcon,
  iconFor,
  withheldMethods,
  type RendererMethod,
  type RpcResponse,
  type SavedHost,
  type SshHost,
  type SubscribeParams,
  type WatchParams,
} from "../preload/bridge";
import {
  accountId,
  coalesced,
  countPairRun,
  directRoutes,
  lacks,
  mergeListed,
  parseSignIn,
  relayIdOf,
  Routes,
  tokenSubject,
  unionLists,
  type SavedAccount,
} from "./accountHosts";
import {
  addCommand,
  deviceHostId,
  isDeviceAddress,
  isDeviceIcon,
  isSshUser,
  mergeFound,
  type ConnectProgram,
  type SavedDevice,
} from "./connect";
import type { Account } from "./account";
import {
  backoffMs,
  Connection,
  LOCATE_PLXD,
  sshCommand,
  type ConnectionOptions,
} from "./connection";
import { closeDeviceStream, openDeviceStream, sendDeviceStream } from "./devices";
import { HostUpdater } from "./hostUpdate";
import { installPlxd } from "./installPlxd";
import {
  checkHost,
  isRoute,
  readSettings,
  writeSettings,
  type SavedLan,
  type Settings,
} from "./settings";
import { sshSuggestions } from "./sshConfig";
import {
  closeTerminal,
  installCommand,
  isCliKind,
  isInstallable,
  loginCommand,
  hostLogin,
  openTerminal,
  resizeTerminal,
  runInstall,
  writeTerminal,
  type Command,
  type SshTarget,
} from "./terminal";
import {
  dataDir,
  findPlxd,
  plxdVersion,
  refreshCopy,
  replaceServe,
  serviceRuns,
  serviceStep,
} from "./plxd";
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

/** Keeps remote hosts' plxd on the app's version (PLX-700). */
let hostUpdater: HostUpdater | undefined;
/** The version Update everything puts each host's plxd on: the app's next release, else its own. */
let targetVersion = () => app.getVersion();
/**
 * How long `host/update` may take: it downloads plxd, about 30 MB, before it answers. A
 * provider's `providers/upgrade` gets as long.
 */
const UPDATE_TIMEOUT_MS = 15 * 60_000;
/**
 * Longer than plxd's own 3 minute wait for a simulator or emulator to boot. Listing them gets as
 * long: a cold Mac's first `simctl` listing can take over 30 seconds.
 */
const DEVICE_TIMEOUT_MS = 4 * 60_000;

/** How long `providers/list` and `providers/save` may take: each probes agents (PLX-901). */
const PROBE_TIMEOUT_MS = 2 * 60_000;

/**
 * How long `repo/clone` may take (PLX-905). plxd stops a clone git makes no progress on for 5
 * minutes, so this only cuts off a huge repository on a slow link.
 */
const CLONE_TIMEOUT_MS = 60 * 60_000;

/**
 * How long `thread/importable` may take: plxd reads each claude.ai Remote Control session through
 * Claude Code, for up to 2 minutes (PLX-1136). `thread/import` gets `repo/clone`'s, as importing
 * one clones its repository when it isn't here. `thread/remoteControlOrigin` gets this one too, as
 * it reads a session from claude.ai the same way (PLX-1143).
 */
const IMPORTABLE_TIMEOUT_MS = 3 * 60_000;

/**
 * Every host's connection, by host id: `local`, each saved SSH host, each Connect device, and each
 * LAN computer.
 */
const connections = new Map<string, Connection>();
/** Each window's subscriptions, by the key its preload chose. */
const subscriptions = new Map<WebContents, Map<string, () => void>>();

let settings: Settings = { hosts: [] };
/** Why `settings.json` couldn't be read, which blocks saving over it. */
let settingsError: string | undefined;
const settingsFile = () => path.join(app.getPath("userData"), "settings.json");

/**
 * Connects to the local plxd, as host id `local`, and to every saved SSH host at once, and
 * serves the `window.parallax` calls that reach plxd or edit the hosts. `target` is the version
 * Update everything puts remote hosts' plxd on.
 */
export function startHosts(signedIn: Account | undefined, target: () => string): void {
  account = signedIn;
  // Signing in registers every computer this app is connected to (PLX-1146).
  account?.onSignIn(() => {
    for (const [hostId, connection] of connections)
      if (connection.state.status === "connected") void joinRelay(hostId);
    // The account's computers, which a sign-in to another account changes (0091).
    void discoverAccounts();
  });
  targetVersion = target;
  hostUpdater = new HostUpdater({
    packaged: app.isPackaged && !process.env["PLXD_PATH"],
    version: app.getVersion(),
    channel: channel(),
    kindOf: (hostId) => (savedHost(hostId) ? "ssh" : runsOnHost(hostId) ? "remote" : undefined),
    states: () => [...connections].map(([id, each]) => [id, each.state]),
    update: async (hostId, version, now) =>
      (await connections
        .get(hostId)
        ?.request("host/update", { version, ...(now && { now }) }, UPDATE_TIMEOUT_MS)) ?? {
        error: { code: ErrorCodes.InternalError, message: "That host isn't in Parallax anymore." },
      },
    runningAgents: async (hostId) => {
      const answer = await connections.get(hostId)?.request("host/health", {});
      return answer && "result" in answer ? answer.result.runningAgents : undefined;
    },
    installSsh: (hostId) => installPlxdOn(hostId),
    osOf: async (hostId) => {
      const answer = await connections.get(hostId)?.request("host/version", {});
      return answer && "result" in answer ? answer.result.os : undefined;
    },
    emit: (event) => broadcast("parallax:hostUpdate", event),
  });
  addConnection(
    "local",
    () => {
      const plxd = localPlxd();
      return plxd === undefined ? undefined : [plxd, "attach"];
    },
    { env: () => exitWithApp },
  );
  // Connect on or off, so a `plxd connect on|off` run outside the app is followed too, and an
  // installed service is kept current either way.
  setInterval(() => void refreshConnect().then(keepServing), DISCOVERY_MS);
  try {
    settings = readSettings(settingsFile());
  } catch (error) {
    settingsError = `Parallax can't use ${settingsFile()}, so it won't save over it: ${(error as Error).message.replace(/\.$/, "")}. Fix or remove the file, then restart Parallax.`;
    console.error(settingsError);
  }
  for (const host of settings.hosts) addSshConnection(host, host.plxdInstalled);
  for (const computer of settings.lan ?? []) addLanConnection(computer);
  for (const each of savedAccounts()) addAccountConnection(each);

  ipcMain.handle("parallax:connect", () => connectState());
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
  // Settings > Connections and Add computer ask for the account's computers when they open, and
  // the window's focus and the network do too, with no timer (0091).
  ipcMain.handle("parallax:discoverAccount", () => discoverAccounts());
  ipcMain.on("parallax:network", () => void networkChanged());
  app.on("browser-window-focus", () => lookAgain());
  ipcMain.handle("parallax:enterSetupCode", (_event, hostId: unknown, code: unknown) =>
    enterSetupCode(hostId, code),
  );
  ipcMain.handle("parallax:askAgain", (_event, hostId: unknown) => {
    const saved = accountOf(hostId);
    if (saved && accountAccess.get(accountId(saved.hostId))?.step === "ask")
      return signIn(accountId(saved.hostId));
  });
  ipcMain.handle("parallax:accessRequests", () => accessRequests());
  ipcMain.handle("parallax:revokeDevice", (_event, id: unknown) => revokeDevice(id));
  ipcMain.handle("parallax:turnOnReach", (_event, hostId: unknown) => turnOnReach(hostId));
  ipcMain.handle("parallax:answerAccess", (_event, id: unknown, allow: unknown) =>
    typeof id === "string" && typeof allow === "boolean"
      ? answerAccess(id, allow)
      : "invalid request",
  );

  ipcMain.handle("parallax:hosts", () => listedHosts(settings));
  ipcMain.handle("parallax:sshSuggestions", () => sshSuggestions(homedir()));
  ipcMain.handle("parallax:saveHost", (_event, input: unknown, id: unknown) => saveHost(input, id));
  ipcMain.handle("parallax:removeHost", (_event, id: unknown) => removeHost(id));
  ipcMain.handle("parallax:installPlxd", (_event, id: unknown) => installPlxdOn(id));
  ipcMain.handle("parallax:discoverLan", () => discoverLan());
  ipcMain.handle("parallax:pairLan", (_event, target: unknown, code: unknown) =>
    pairLan(target, code),
  );
  ipcMain.handle("parallax:localName", () => localName());
  ipcMain.handle("parallax:registerRelay", () => registerRelay());
  ipcMain.handle("parallax:relayHosts", () => relayHosts());
  ipcMain.handle("parallax:removeRelayHost", (_event, hostId: unknown) =>
    typeof hostId === "string" ? relayHosts(hostId) : "invalid host",
  );
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
      // A provider's own update downloads it, which can take minutes (PLX-746), and an emulator
      // can take minutes to boot, or a cold Mac's simulators to list (PLX-886). A list or save
      // probes agents, each in steps of up to 20 s, which can pass the usual 30 s. A clone runs
      // until git is done, as may an import, which can clone; listing what to import reads
      // claude.ai's sessions.
      const timeout =
        method === "providers/upgrade"
          ? UPDATE_TIMEOUT_MS
          : method === "device/boot" || method === "device/state"
            ? DEVICE_TIMEOUT_MS
            : method === "providers/list" || method === "providers/save"
              ? PROBE_TIMEOUT_MS
              : method === "repo/clone" || method === "thread/import"
                ? CLONE_TIMEOUT_MS
                : method === "thread/importable" || method === "thread/remoteControlOrigin"
                  ? IMPORTABLE_TIMEOUT_MS
                  : undefined;
      return host.request(method as RendererMethod, params as never, timeout);
    },
  );

  ipcMain.handle("parallax:subscribe", (event, hostId: unknown, key: unknown, params: unknown) => {
    if (!isObject(params)) throw new Error("params must be an object");
    const { after, orchestrator, logId, run, shell } = params;
    if (typeof key !== "string") throw new Error("invalid subscription key");
    if (typeof logId !== "string") throw new Error("logId must be a string");
    if (typeof after !== "number" || !Number.isSafeInteger(after) || after < 0) {
      throw new Error("after must be a non-negative integer");
    }
    if (orchestrator !== undefined && typeof orchestrator !== "string")
      throw new Error("invalid orchestrator");
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
        ...(orchestrator !== undefined && { orchestrator }),
        ...(run !== undefined && { run }),
        ...(shell !== undefined && { shell }),
      } satisfies SubscribeParams,
      (message) => {
        if (message.type !== "event") {
          ended = true;
          windowSubscriptions(sender).delete(key);
        }
        forward(sender, key, message);
      },
    );
    // It ends at once when `logId` is stale.
    if (!ended) windowSubscriptions(sender).set(key, unsubscribe);
  });

  ipcMain.handle("parallax:watch", (event, hostId: unknown, key: unknown, params: unknown) => {
    if (typeof key !== "string") throw new Error("invalid subscription key");
    if (!isObject(params)) throw new Error("params must be an object");
    const { shell, threadId } = params;
    const watched: WatchParams | undefined =
      shell === true ? { shell } : typeof threadId === "string" ? { threadId } : undefined;
    if (!watched) throw new Error("params must be {shell: true} or {threadId}");
    const host = connection(hostId);
    const sender = event.sender;
    windowSubscriptions(sender).get(key)?.();
    let ended = false;
    const stop = host.watch(watched, (message) => {
      if (message.type === "error") {
        ended = true;
        windowSubscriptions(sender).delete(key);
      }
      forward(sender, key, message);
    });
    if (!ended) windowSubscriptions(sender).set(key, stop);
  });

  ipcMain.handle("parallax:unsubscribe", (event, key: unknown) => {
    const unsubscribe = subscriptions.get(event.sender)?.get(String(key));
    subscriptions.get(event.sender)?.delete(String(key));
    unsubscribe?.();
  });

  ipcMain.handle("parallax:connectionState", (_event, hostId: unknown) => connection(hostId).state);
  ipcMain.handle("parallax:retry", (_event, hostId: unknown) => connection(hostId).retry());
  ipcMain.handle("parallax:retryHostUpdate", (_event, hostId: unknown) => {
    if (typeof hostId === "string") hostUpdater?.retry(hostId);
  });
  ipcMain.handle("parallax:updateHostNow", async (_event, hostId: unknown) => {
    if (typeof hostId === "string" && connections.has(hostId))
      await hostUpdater?.updateNow(hostId, targetVersion());
  });

  // A window's terminals (terminal.ts), by an id it picks, which plxd runs (PLX-637): a shell in a
  // thread's folder on its host, or on this computer, an SSH host's login, a CLI's or a provider
  // instance's sign-in, or an agent's install by its provider kind. The renderer names the host
  // and the folder, CLI, instance, or kind; only main decides what runs.
  ipcMain.handle(
    "parallax:openTerminal",
    async (event, id: unknown, target: unknown, cols: unknown, rows: unknown) => {
      if (!isTerminalId(id) || !isObject(target) || !isSize(cols) || !isSize(rows)) {
        return "invalid terminal";
      }
      const { hostId, cli, provider, install, path, threadId, terminalId, connect, login } = target;
      if (typeof hostId !== "string") return "invalid terminal";
      if (typeof path === "string") {
        if (threadId !== undefined && typeof threadId !== "string") return "invalid terminal";
        // A thread's script terminal (PLX-650), which plxd started.
        if (
          terminalId !== undefined &&
          !(typeof threadId === "string" && isScriptTerminal(terminalId))
        )
          return "invalid terminal";
        const host = connections.get(hostId);
        if (!host) return "That host isn't in Parallax anymore.";
        const params = {
          threadId: threadId ?? "",
          terminalId: terminalId ?? id,
          cwd: path,
          cols,
          rows,
        };
        return openTerminal(event.sender, id, host, params);
      }
      let command: Command | string | undefined;
      if (login === true) command = hostLogin(hostId, settings.hosts, settings.ssh);
      else if (isObject(connect)) {
        const { device, user, headless } = connect;
        if (
          hostId === "local" &&
          isDeviceAddress(device) &&
          (user === undefined || isSshUser(user)) &&
          (headless === undefined || typeof headless === "boolean")
        )
          command = addCommand(device, user, channel(), headless === true, connectProgram());
      } else if (isInstallable(install)) command = await installOn(hostId, install);
      else if (isCliKind(cli)) command = await signInCommand(hostId, cli);
      else if (typeof provider === "string")
        command = await providerSignInCommand(hostId, provider);
      if (!command) return "invalid terminal";
      if (typeof command === "string") return command;
      // It runs on this computer, over ssh for an SSH host, or on a LAN, account, or Connect
      // computer's own plxd (0064, 0091), under an id of its own, so an earlier one's last output
      // and exit never reach it.
      const { file: program, args, env = {} } = command;
      const runner = runsOnHost(hostId) ? connections.get(hostId) : connection("local");
      if (!runner) return "That host isn't in Parallax anymore.";
      return openTerminal(event.sender, id, runner, {
        threadId: "",
        terminalId: `${id}:${randomUUID()}`,
        command: { program, args, env },
        cols,
        rows,
      });
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
    // runInstall runs here; another computer's install opens in a terminal on its own plxd.
    if (runsOnHost(hostId)) return "On another computer, agents install in a terminal there.";
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
  // A window's device streams (PLX-886), by an id it picks, through its host's plxd.
  ipcMain.handle("parallax:openDeviceStream", (event, hostId: unknown, params: unknown) => {
    if (typeof hostId !== "string" || !isDeviceStreamParams(params)) return "invalid stream";
    const host = connections.get(hostId);
    if (!host) return "That host isn't in Parallax anymore.";
    return openDeviceStream(event.sender, host, params);
  });
  ipcMain.on("parallax:sendDeviceStream", (event, id: unknown, data: unknown) => {
    if (typeof id === "string" && (typeof data === "string" || data instanceof Uint8Array))
      sendDeviceStream(event.sender, id, data);
  });
  ipcMain.on("parallax:closeDeviceStream", (event, id: unknown) => {
    if (typeof id === "string") closeDeviceStream(event.sender, id);
  });

  powerMonitor.on("resume", () => {
    for (const each of connections.values()) each.heartbeat();
  });
  app.on("will-quit", () => {
    for (const each of connections.values()) each.dispose();
  });
}

/**
 * How a host's command terminals reach it from this computer: an SSH host by its destination.
 * Undefined for `local`, and for a computer whose commands run on its own plxd (`runsOnHost`),
 * so a remote host's command never runs here.
 */
function sshOf(hostId: string): SshTarget | undefined {
  const saved = savedHost(hostId);
  return saved ? { destination: saved.destination, ssh: settings.ssh ?? "ssh" } : undefined;
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
  // A remote host's OS decides its shell; this computer's is known.
  const remote = ssh || runsOnHost(hostId);
  const version = remote ? await host.request("host/version", {}) : undefined;
  if (version && "error" in version)
    return `Parallax couldn't ask the host which OS it runs: ${version.error.message}`;
  const os = version && "result" in version ? version.result.os : undefined;
  // Another computer runs it on its own plxd, as if local there, with its own shell.
  if (runsOnHost(hostId)) return installCommand(kind, undefined, platformOf(os), {});
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
  return loginCommand(cli, path, ssh, await hostPlatform(hostId));
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
  const platform = await hostPlatform(hostId);
  return loginCommand(kind, own ? found.path! : program, ssh, platform, args, env);
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

// An html_render page runs its own inline scripts and forms and loads https resources, nothing
// else, and stays sandboxed even if something opens it outside its frame. A form can't send the
// page anywhere.
const renderPolicy = [
  "sandbox allow-scripts allow-forms",
  "form-action 'none'",
  "default-src 'none'",
  "script-src 'unsafe-inline' 'unsafe-eval' https:",
  "style-src 'unsafe-inline' https:",
  "img-src data: blob: https:",
  "font-src data: https:",
  "media-src data: blob: https:",
  "connect-src https:",
].join("; ");

/** A URL's path split at `/`, each part decoded, or "" where it doesn't decode. */
const pathParts = (url: string) =>
  (URL.parse(url)?.pathname ?? "").split("/").map((part) => {
    try {
      return decodeURIComponent(part);
    } catch {
      return "";
    }
  });

/**
 * The html_render page or browser recording (PLX-639) at `plx-render://page/<host>/<run>/<id>`,
 * which that host's plxd keeps with the run's images: a page as a document of its own.
 */
export async function renderPage(url: string): Promise<Response> {
  const [, hostId, runId, imageId] = pathParts(url);
  const host = hostId ? connections.get(hostId) : undefined;
  const page =
    host && runId && imageId
      ? await host.request("agent/image", { runId, imageId }).catch(() => undefined)
      : undefined;
  if (!page || "error" in page)
    return new Response("That page isn't on this host.", { status: 404 });
  const { mediaType, data } = page.result;
  const body = Buffer.from(data, "base64");
  // A browser recording (PLX-639) is only a video.
  if (mediaType === "video/webm")
    return new Response(body, { headers: { "Content-Type": "video/webm" } });
  if (mediaType !== "text/html")
    return new Response("That page isn't on this host.", { status: 404 });
  return new Response(body, {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Content-Security-Policy": renderPolicy,
    },
  });
}

/**
 * A Range header's one byte range (PLX-836): `bytes=a-b` and `bytes=a-` as its first byte and, when
 * given, its last, and `bytes=-n` as the last `suffix` bytes. Undefined without a header, and
 * "invalid" for anything else, more than one range included.
 */
function byteRange(
  header: string | null,
): { start: number; end?: number } | { suffix: number } | "invalid" | undefined {
  if (header === null) return undefined;
  const [, from, to] = /^bytes=(\d*)-(\d*)$/.exec(header.trim()) ?? [];
  if (from === undefined || to === undefined) return "invalid";
  if (from === "") return Number(to) > 0 ? { suffix: Number(to) } : "invalid";
  const start = Number(from);
  if (to === "") return { start };
  return Number(to) >= start ? { start, end: Number(to) } : "invalid";
}

// A streamed file's Content-Type, by its extension. Anything else is bytes.
const streamTypes: Record<string, string> = {
  mp4: "video/mp4",
  m4v: "video/mp4",
  webm: "video/webm",
  mov: "video/quicktime",
};

/**
 * A file in a run's folder at `plx-file://file/<host>/<run>/<path>`, each part encoded, for a
 * `<video>` that plays while it loads and seeks (PLX-836). It's read from that host's plxd in
 * `agent/file` slices (0074), the path passed as given, so plxd's rules decide what it serves and
 * only that host's runs answer. Only a host of this app's with `fileChunks` serves one. A Range
 * request gets 206 and the bytes it asks for, and one without gets 200 and the whole file, read a
 * slice each time the player wants more, so a player that pauses or seeks away reads no further.
 * Each answer runs to the range's end: Chromium takes a non-http response's length as the file's,
 * so a shorter one would end the video there.
 */
export async function streamFile(url: string, range: string | null): Promise<Response> {
  const refuse = (status: number, why: string) => new Response(why, { status });
  const parts = pathParts(url);
  const [, hostId, runId, filePath] = parts;
  if (parts.length !== 4 || !hostId || !runId || !filePath)
    return refuse(400, "That isn't a file's address.");
  const host = connections.get(hostId);
  const chunkBytes =
    host?.state.status === "connected"
      ? host.state.capabilities["fileChunks"]?.["chunkBytes"]
      : undefined;
  if (!host || typeof chunkBytes !== "number" || chunkBytes < 1)
    return refuse(404, "That host can't stream files.");
  const asked = byteRange(range);
  if (asked === "invalid") return refuse(416, "Parallax reads one byte range at a time.");

  // One read of the file: its size and the bytes asked for, or the refusal to answer with. plxd
  // refuses a path its rules don't serve as invalid params, and a run it doesn't have as its own.
  const read = async (more: { offset: number; length: number } | { sizeOnly: true }) => {
    const answer = await host
      .request("agent/file", { runId, path: filePath, side: "working", ...more })
      .catch(() => undefined);
    if (!answer) return refuse(502, "The host didn't answer.");
    if ("error" in answer) {
      const { code, message } = answer.error;
      const status =
        code === ErrorCodes.InvalidParams ? 403 : code === ErrorCodes.ParallaxError ? 404 : 502;
      return refuse(status, message);
    }
    const { exists, size, content } = answer.result;
    if (!exists || size === undefined) return refuse(404, "That file isn't on this host.");
    return { size, bytes: Buffer.from(content ?? "", "base64") };
  };

  let start = 0;
  let last = Infinity;
  if (asked && "suffix" in asked) {
    const stat = await read({ sizeOnly: true });
    if (stat instanceof Response) return stat;
    start = Math.max(0, stat.size - asked.suffix);
  } else if (asked) {
    start = asked.start;
    last = asked.end ?? Infinity;
  }
  const first = await read({ offset: start, length: Math.min(chunkBytes, last - start + 1) });
  if (first instanceof Response) return first;
  const { size } = first;
  if (asked && start >= size)
    return new Response(null, { status: 416, headers: { "Content-Range": `bytes */${size}` } });
  const end = Math.min(last + 1, size);

  let offset = start;
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      const slice =
        offset === start
          ? first
          : await read({ offset, length: Math.min(chunkBytes, end - offset) });
      const bytes = slice instanceof Response ? undefined : slice.bytes.subarray(0, end - offset);
      // A file that shrank, or a host that stopped answering, ends the read short.
      if (!bytes?.length) return controller.error(new Error("The file stopped short."));
      controller.enqueue(bytes);
      offset += bytes.length;
      if (offset >= end) controller.close();
    },
  });
  const extension = /\.([a-z0-9]+)$/i.exec(filePath)?.[1]?.toLowerCase() ?? "";
  return new Response(end > start ? body : null, {
    status: asked ? 206 : 200,
    headers: {
      "Accept-Ranges": "bytes",
      "Content-Type": streamTypes[extension] ?? "application/octet-stream",
      "Content-Length": String(end - start),
      ...(asked && { "Content-Range": `bytes ${start}-${end - 1}/${size}` }),
    },
  });
}

/** A saved SSH host by id. Undefined for this computer, `local`, and for an unknown id. */
export const savedHost = (id: string): SshHost | undefined =>
  settings.hosts.find((h) => h.id === id);

/**
 * A dev or test app's (`PLXD_PATH` or `PLXD_FAKE_BACKEND`) `plxd serve` stops when this app exits,
 * even when it's killed (PLX-990), unless `PLXD_EXIT_WITH` already names the process to stop
 * with, as for an e2e test that reopens the app. The installed app's outlives it: it passes an
 * empty one, so a value from the shell that started the app never reaches its `serve`.
 */
const exitWithApp = {
  PLXD_EXIT_WITH:
    process.env["PLXD_PATH"] || process.env["PLXD_FAKE_BACKEND"]
      ? process.env["PLXD_EXIT_WITH"] || String(process.pid)
      : "",
};

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
 * How many times this launch has replaced the local serve, or failed to: at most twice, so a
 * re-attach to a serve still shutting down gets one more try. After that the app keeps whatever
 * runs, and `keepServing` tries again later. External daemons do not use up these attempts.
 */
let serveChecks = 0;

/**
 * After an update, the local `plxd serve` may still be the previous app's, since attach reuses a
 * running one (0010). A packaged app replaces it when its version differs from the one it runs,
 * older or newer (a move back to Standard), and reconnects (`replaceServe`). With plxd's login
 * service installed, that's the copy's: the copy is refreshed and the service restarted on it once
 * no agents are running. Otherwise it's the bundled plxd's, which attach then starts. Only a serve a
 * packaged Parallax started is replaced, never a dev checkout's or a plxd on PATH. Not on Windows,
 * whose installer stops every process running from the app's folder, `plxd.exe` included.
 */
async function replaceOtherServe(
  running: string,
  runningAgents?: () => Promise<number | undefined>,
): Promise<boolean> {
  const plxd = process.platform === "win32" ? undefined : bundledPlxd();
  if (!plxd) return false;
  try {
    const installed = /^installed: true$/m.test((await serviceStatus(plxd)) ?? "");
    const copy = installed ? await refreshCopy(plxd, homedir()) : undefined;
    const wanted = copy ? copy.version : await plxdVersion(plxd);
    if (wanted !== undefined && wanted !== running && serveChecks >= 2) {
      console.warn(`parallax: kept plxd serve ${running}, not ${wanted}, after two tries`);
      return false;
    }
    const { stopped, why } = await replaceServe(
      dataDir(process.env, process.platform, homedir()),
      running,
      wanted,
      undefined,
      copy && {
        status: async () => {
          const status = (await serviceStatus(plxd)) ?? "";
          const pid = /^pid: (\d+)$/m.exec(status)?.[1];
          return {
            ...(pid && { pid: Number(pid) }),
            ready: /^answers initialize: true$/m.test(status),
          };
        },
        replace: async () => {
          await runPlxd(copy.plxd, "service", "install", "--replace");
        },
      },
      runningAgents,
    );
    console.log(`parallax: ${why}`);
    if (stopped) serveChecks++;
    return stopped;
  } catch (error) {
    // A failure that repeats, such as a full disk for the copy, mustn't keep plxd from connecting.
    if (++serveChecks < 2) throw error;
    console.warn(`parallax: kept plxd serve ${running} after failing to replace it twice:`, error);
    return false;
  }
}

/**
 * Starts a host's connection, replacing any it had. `destination` names an SSH host and `device`
 * a Connect device in its errors.
 */
function addConnection(
  hostId: string,
  command: () => string[] | undefined,
  options: Pick<
    ConnectionOptions,
    "destination" | "device" | "lan" | "account" | "onRoute" | "env"
  > = {},
) {
  const { destination } = options;
  connections.get(hostId)?.dispose();
  const created = new Connection({
    command,
    ...options,
    clientVersion: app.getVersion(),
    ...(hostId === "local" && { replaceDaemon: replaceOtherServe }),
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
      hostUpdater?.onState(hostId, state);
      followAccess(hostId, state);
      if (state.status !== "connected") return;
      void joinRelay(hostId);
      if (hostId === "local") {
        // A new local plxd, such as after `host/update` or a service uninstall, is checked again.
        if (serviceState === "done") serviceState = "check";
        void refreshConnect().then(keepServing);
      } else if (hostId.startsWith("tailnet:") || hostId.startsWith("account:"))
        void readLook(hostId);
    },
  });
  connections.set(hostId, created);
  created.start();
}

/**
 * SSH hosts that run `LOCATE_PLXD` instead of `plxd attach` from PATH: those the app installed plxd
 * on (`plxdInstalled`, PLX-642), and those where PATH had none, until the app quits or the host's
 * destination changes.
 */
const locating = new Set<string>();

/** Starts an SSH host's connection, with `locate` through `LOCATE_PLXD` from the start. */
function addSshConnection({ id, destination }: SshHost, locate?: boolean): void {
  if (locate) locating.add(id);
  else locating.delete(id);
  addConnection(
    id,
    () => sshCommand(destination, settings.ssh, locating.has(id) ? [LOCATE_PLXD] : undefined),
    { destination },
  );
}

/**
 * `window.parallax.installPlxd`: installs this app's plxd on an SSH host (`installPlxd`), saves
 * that on the host, then reconnects it through `LOCATE_PLXD`, which runs that one first, from now
 * on. Resolves to an error for people.
 */
async function installPlxdOn(id: unknown): Promise<string | undefined> {
  const host = typeof id === "string" ? savedHost(id) : undefined;
  if (!host) return "That host isn't in Parallax anymore.";
  const error = await installPlxd(host.destination, app.getVersion(), settings.ssh);
  // Removed or edited meanwhile: its connection isn't this one's to restart.
  const now = savedHost(host.id);
  if (error || now?.destination !== host.destination) return error;
  const installed: SshHost = { ...now, plxdInstalled: true };
  addSshConnection(installed, true);
  return saveSettings({
    ...settings,
    hosts: settings.hosts.map((h) => (h === now ? installed : h)),
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
  const host: SshHost = {
    id: old?.id ?? randomUUID(),
    ...checked,
    // The plxd Parallax installed is on the old destination's host.
    ...(old?.plxdInstalled && old.destination === checked.destination && { plxdInstalled: true }),
  };
  const hosts = old ? settings.hosts.map((h) => (h === old ? host : h)) : [...settings.hosts, host];
  const error = saveSettings({ ...settings, hosts });
  if (error) return error;
  // A rename keeps the connection; a new destination needs a new one.
  if (old?.destination !== host.destination) addSshConnection(host);
  return undefined;
}

/** `window.parallax.removeHost`, an SSH host or a LAN computer. Resolves to an error for people. */
function removeHost(id: unknown): string | undefined {
  if (typeof id !== "string") return undefined;
  const lan = settings.lan ?? [];
  const isLan = lan.some((c) => lanHostId(c.fingerprint) === id);
  if (!isLan && !settings.hosts.some((h) => h.id === id)) return undefined;
  const error = saveSettings(
    isLan
      ? { ...settings, lan: lan.filter((c) => lanHostId(c.fingerprint) !== id) }
      : { ...settings, hosts: settings.hosts.filter((h) => h.id !== id) },
  );
  if (error) return error;
  connections.get(id)?.dispose();
  connections.delete(id);
  // Its session token and DPoP key go with it.
  if (isLan) {
    const fingerprint = id.slice("lan:".length);
    const dir = dataDir(process.env, process.platform, homedir());
    rmSync(path.join(dir, "remote-hosts", fingerprint), { force: true });
  }
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
  broadcast("parallax:hosts", listedHosts(next));
  return undefined;
}

// Remote pairing on the LAN (PLX-641, 0065): each paired computer is host `lan:<its certificate
// fingerprint>`, reached with `plxd dial --remote`, which pins the certificate and tries its
// routes in order. Its session token and DPoP key stay in the local plxd's data folder.

const lanHostId = (fingerprint: string) => `lan:${fingerprint}`;

/** The saved hosts as the renderer lists them: SSH hosts, then LAN computers. */
const listedHosts = (from: Settings): SavedHost[] => [
  ...from.hosts,
  ...(from.lan ?? []).map(({ fingerprint, name, routes }) => ({
    id: lanHostId(fingerprint),
    name,
    routes,
  })),
];

/** Whether `hostId` is a computer paired on the LAN. */
const isLanHost = (hostId: string) =>
  (settings.lan ?? []).some((c) => lanHostId(c.fingerprint) === hostId);

/**
 * Whether `hostId` is a computer whose commands, such as an agent's install or sign-in, run in
 * its own plxd's terminals (0064): one paired on the LAN, on the account (0091), or on the tailnet.
 */
const runsOnHost = (hostId: string) =>
  isLanHost(hostId) || hostId.startsWith("account:") || hostId.startsWith("tailnet:");

/** A platform for plxd's `host/version` OS, such as `macOS 26.0`, `windows`, or `linux`. */
const platformOf = (os?: string): NodeJS.Platform =>
  /^windows/i.test(os ?? "") ? "win32" : /^macos/i.test(os ?? "") ? "darwin" : "linux";

/** The platform of a computer a command runs on (`runsOnHost`); this computer's otherwise. */
async function hostPlatform(hostId: string): Promise<NodeJS.Platform> {
  if (!runsOnHost(hostId)) return process.platform;
  const answer = await connections.get(hostId)?.request("host/version", {});
  return platformOf(answer && "result" in answer ? answer.result.os : undefined);
}

/** A route's address without its port: `192.168.1.20` for `192.168.1.20:7341`. */
const routeHost = (route: string) =>
  route.startsWith("[")
    ? route.slice(1, route.indexOf("]"))
    : route.split(":").length === 2
      ? route.split(":")[0]!
      : route;

function addLanConnection({ fingerprint, name, routes }: SavedLan): void {
  addConnection(
    lanHostId(fingerprint),
    () => {
      const plxd = localPlxd();
      return plxd === undefined
        ? undefined
        : [plxd, "dial", "--remote", fingerprint, "--", ...routes];
    },
    { lan: name, env: relayEnv },
  );
}

/** The signed-in Parallax account, whose token reaches plxd only, never a renderer. */
let account: Account | undefined;

/** `plxd dial`'s sign-in for a `relay:` route (PLX-652), while one is fresh. */
function relayEnv(): Record<string, string> | undefined {
  const token = account?.currentToken();
  return token ? { PLXD_RELAY_TOKEN: token } : undefined;
}

/**
 * `window.parallax.relayHosts` and `removeRelayHost`: the signed-in account's hosts on Parallax
 * Relay, after removing `remove` if given (PLX-652). Main sends the account's token to plxd, which
 * asks the relay. Answers the hosts, or why not.
 */
async function relayHosts(remove?: string): Promise<RelayHost[] | string> {
  const token = await account?.accessToken();
  if (!token) return "Sign in to Parallax from Profile in the sidebar first.";
  const local = connections.get("local");
  const answer = remove
    ? await local?.request("relay/remove", { token, hostId: remove })
    : await local?.request("relay/hosts", { token });
  if (!answer) return "Parallax isn't connected to this computer's plxd.";
  return "error" in answer ? answer.error.message : answer.result.hosts;
}

/**
 * `window.parallax.registerRelay`: registers this computer's plxd with Parallax Relay under the
 * signed-in account (PLX-652). Main sends the account's token straight to plxd. Answers why not.
 */
async function registerRelay(): Promise<string | undefined> {
  const token = await account?.accessToken();
  if (!token) return "Sign in to Parallax from Profile in the sidebar first.";
  const answer = await connections.get("local")?.request("relay/register", { token });
  return !answer
    ? "Parallax isn't connected to this computer's plxd."
    : "error" in answer
      ? answer.error.message
      : undefined;
}

/**
 * Registers computer `hostId` with Parallax Relay under the signed-in account, so its threads
 * notify the phone with no switch to turn on (PLX-1146): this computer's plxd and each Parallax
 * Connect computer's. Another computer's plxd signs the registration over the token's hash and
 * this one's posts it, so the token never leaves this computer. With it goes the token's Clerk
 * user id, which that plxd records as its account (0091): without one, it refuses every account
 * sign-in. Quiet when signed out, for any other kind of host, and for a plxd too old to sign.
 */
async function joinRelay(hostId: string): Promise<void> {
  if (hostId !== "local" && !hostId.startsWith("tailnet:")) return;
  const token = await account?.accessToken();
  const local = connections.get("local");
  if (!token || local?.state.status !== "connected") return;
  if (hostId === "local") {
    await local.request("relay/register", { token });
    return;
  }
  const tokenHash = createHash("sha256").update(token).digest("base64url");
  const userId = tokenSubject(token);
  const signed = await connections
    .get(hostId)
    ?.request("relay/sign", { tokenHash, ...(userId && { userId }) });
  if (signed && "result" in signed)
    await local.request("relay/register", { token, signed: signed.result });
}

/** The hosts the last `discoverLan` found, by the id the renderer picks one with. */
let found = new Map<string, { name: string; routes: string[] }>();

/**
 * `window.parallax.discoverLan`: runs `plxd dial --discover`, which listens a few seconds for
 * computers advertising a pairing code over mDNS. The renderer gets their names only.
 */
async function discoverLan(): Promise<{ id: string; name: string }[] | string> {
  const plxd = localPlxd();
  if (!plxd) return "plxd wasn't found. Set PLXD_PATH to the plxd binary.";
  let stdout: string;
  try {
    ({ stdout } = await runPlxd(plxd, "dial", "--discover"));
  } catch (error) {
    return `Parallax couldn't look for computers: ${(error as { stderr?: string }).stderr?.trim() || "plxd failed"}`;
  }
  const hosts = JSON.parse(stdout) as { name?: unknown; routes?: unknown }[];
  found = new Map();
  for (const [index, host] of hosts.entries()) {
    const routes = Array.isArray(host.routes) ? host.routes.filter(isRoute) : [];
    if (typeof host.name === "string" && routes.length)
      found.set(String(index), { name: host.name, routes });
  }
  return [...found].map(([id, { name }]) => ({ id, name }));
}

/** A pairing code as typed: letters, digits, spaces, and dashes. */
const isCode = (value: unknown): value is string =>
  typeof value === "string" && /^[\w -]{1,20}$/.test(value);

/**
 * `window.parallax.pairLan`: runs `plxd dial --pair` to the computer `discoverLan` found as
 * `target.found`, or at `target.address`, with the code on its stdin, so no other user sees it in
 * the process list. It prints the computer's fingerprint, name, and routes; this keeps the
 * computer and connects. Resolves to an error for people.
 */
async function pairLan(target: unknown, code: unknown): Promise<string | undefined> {
  const { found: id, address }: Record<string, unknown> = isObject(target) ? target : {};
  const routes =
    typeof id === "string"
      ? found.get(id)?.routes
      : typeof address === "string" && isRoute(address.trim())
        ? [address.trim()]
        : undefined;
  if (!routes) return "Pick a computer, or enter its address, such as 192.168.1.20.";
  if (!isCode(code)) return "Enter the code the other computer shows.";
  const plxd = localPlxd();
  if (!plxd) return "plxd wasn't found. Set PLXD_PATH to the plxd binary.";
  let stdout: string;
  try {
    const running = runPlxd(plxd, "dial", "--pair", `--name=${localName()}`, "--", ...routes);
    running.child.stdin?.end(`${code}\n`);
    ({ stdout } = await running);
  } catch (error) {
    const exit = (error as { code?: unknown }).code;
    if (exit === 5)
      return "That code is wrong, used, or expired. Check it, or make a new one on the other computer.";
    if (exit === 4)
      return "Couldn't reach the other computer. Check that it's on this network and still showing its code.";
    return `Parallax couldn't pair: ${(error as { stderr?: string }).stderr?.trim() || "plxd failed"}`;
  }
  const paired = JSON.parse(stdout) as { fingerprint?: unknown; name?: unknown; routes?: unknown };
  const { fingerprint, name } = paired;
  const kept = Array.isArray(paired.routes) ? paired.routes.filter(isRoute) : [];
  if (typeof fingerprint !== "string" || !/^[0-9a-f]{64}$/.test(fingerprint) || !kept.length)
    return "plxd answered without the computer's fingerprint and routes.";
  const computer: SavedLan = {
    fingerprint,
    name: (typeof name === "string" && name) || routeHost(kept[0]!),
    routes: kept,
  };
  const lan = [...(settings.lan ?? []).filter((c) => c.fingerprint !== fingerprint), computer];
  const failed = saveSettings({ ...settings, lan });
  if (failed) return failed;
  addLanConnection(computer);
  return undefined;
}

// Parallax Connect (0056): while the local plxd's `connect` is on, this app keeps a connection to
// every device `connect/devices` finds answering on the tailnet, as host `tailnet:<node id>`.

/** The local plxd's `connect`, undefined while unknown. */
let connectOn: boolean | undefined;
/** This computer's icon, from its plxd, when the user picked one. */
let localIcon: DeviceIcon | undefined;
const DISCOVERY_MS = 15_000;

/** plx in this build: package-app's copy in the resources, or a dev build's repo's. */
const connectProgram = (): ConnectProgram => ({
  platform: process.platform,
  env: process.env,
  execPath: process.execPath,
  script: app.isPackaged
    ? path.join(process.resourcesPath, "plx", "bin", "plx.mjs")
    : path.join(app.getAppPath(), "..", "..", "packages", "plx", "bin", "plx.mjs"),
});

/**
 * The channel `plx add` installs: this app's own (0028). A development build follows
 * nightly, the channel with releases.
 */
const channel = () => (isNightly(app.getVersion()) || !app.isPackaged ? "nightly" : "stable");

function connectState(): ConnectState {
  return {
    ...(connectOn !== undefined && { on: connectOn }),
    icon: localIcon ?? iconFor(localName()),
    channel: channel(),
  };
}

const savedDevices = () => settings.devices ?? [];

/**
 * The devices as the renderer lists them, by name, less removed ones: the account's computers
 * (0091), then, while Connect is on, the tailnet's not yet reached through the account.
 */
function deviceHosts(): DeviceHost[] {
  const accounts = savedAccounts()
    .filter((a) => !a.removed)
    .map((a): DeviceHost => {
      const access = accountAccess.get(accountId(a.hostId));
      return {
        id: accountId(a.hostId),
        name: a.name,
        icon: a.icon ?? iconFor(a.name),
        detected: iconFor(a.name),
        hostName: a.name,
        enabled: !a.off,
        ...(access && { access }),
      };
    });
  const tailnet = connectOn
    ? savedDevices()
        .filter((d) => !d.removed && !d.migrated)
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
    : [];
  return [...accounts, ...tailnet].sort((a, b) => a.name.localeCompare(b.name));
}

/** Keeps `devices`, in memory even when settings.json can't be written. */
function keepDevices(devices: SavedDevice[]): void {
  if (saveSettings({ ...settings, devices })) settings = { ...settings, devices };
}

/**
 * Reads the local plxd's `connect` and this computer's icon, then follows them, at each local
 * connect and every 15 s. Only an answer counts: an error or a timeout keeps the devices.
 */
async function refreshConnect(): Promise<void> {
  const answer = await connections.get("local")?.request("host/settings/get", {});
  if (answer && "result" in answer) followConnect(answer.result.connect, answer.result.deviceIcon);
}

/** Connects to the devices and looks for more while `on`; drops their connections otherwise. */
function followConnect(on: boolean | undefined, icon?: string): void {
  const look = isDeviceIcon(icon) ? icon : undefined;
  const changed = on !== connectOn || look !== localIcon;
  connectOn = on;
  localIcon = look;
  if (on) {
    for (const device of savedDevices()) addDeviceConnection(device);
    void discover();
  } else {
    for (const [id, each] of connections) {
      if (!id.startsWith("tailnet:")) continue;
      each.dispose();
      connections.delete(id);
    }
  }
  if (!changed) return;
  // Connect decides whether `keepServing` installs a service, so it checks again now.
  if (serviceState === "done") serviceState = "check";
  void keepServing();
  broadcast("parallax:connect", connectState());
  broadcast("parallax:devices", deviceHosts());
}

/**
 * Where `keepServing` is: `check` until the service runs the copy; `busy` while a step runs;
 * `installed` after an `install --replace`, until a check confirms it; `done` until the local plxd
 * connects again.
 */
type ServiceState = "check" | "busy" | "installed" | "done";
let serviceState: ServiceState = "check";
/** `keepServing`'s failures in a row, and when it may try again. */
let serviceFailures = 0;
let serviceRetryAt = 0;

/** Runs the local plxd with `args`, for its `service` commands. */
const runPlxd = (plxd: string, ...args: string[]) =>
  promisify(execFile)(plxd, args, { timeout: 60_000 });

/** Runs `plxd dial` with `args`, and the relay's sign-in for a `relay:` route (PLX-652). */
const dialPlxd = (plxd: string, args: string[], token?: string) =>
  promisify(execFile)(plxd, ["dial", ...args], {
    timeout: 60_000,
    env: { ...process.env, ...(token && { PLXD_RELAY_TOKEN: token }) },
  });

/**
 * The packaged app's own plxd, which its copy comes from. Undefined in a dev build, under
 * `PLXD_PATH`, and for a plxd from PATH, which is externally managed even in a packaged app.
 */
function bundledPlxd(): string | undefined {
  if (!app.isPackaged || process.env["PLXD_PATH"]) return undefined;
  const plxd = localPlxd();
  const name = process.platform === "win32" ? "plxd.exe" : "plxd";
  return plxd === path.join(process.resourcesPath, name) ? plxd : undefined;
}

/** `plxd service status`'s output, or undefined where plxd has none (Windows before PLX-576). */
async function serviceStatus(plxd: string): Promise<string | undefined> {
  try {
    return (await runPlxd(plxd, "service", "status")).stdout;
  } catch (error) {
    if (/unrecognized subcommand/.test(String((error as { stderr?: unknown }).stderr)))
      return undefined;
    throw error;
  }
}

/**
 * While Connect is on, keeps this computer's plxd under its login service (0072), so other
 * computers reach it after the app quits and after a restart. With Connect off, only a service
 * that's already installed is kept: on the current copy, and repaired when it runs anything else,
 * such as a plxd that's gone. Runs at each local connect and every 15 s: refreshes the copy
 * (`refreshCopy`), then `serviceStep` decides, running the copy's `install --replace` only when
 * `host/health` just said no agents were running (one could start in the moment before `serve`
 * stops). The next check confirms the service runs the copy; the connection reconnects through it
 * by itself. A failed step is tried again later, backing off to once every 5 minutes.
 */
async function keepServing(): Promise<void> {
  const plxd = bundledPlxd();
  if (!plxd || serviceState === "busy" || serviceState === "done") return;
  if (Date.now() < serviceRetryAt) return;
  const installed = serviceState === "installed";
  serviceState = "busy";
  let next: ServiceState = "check";
  try {
    const status = await serviceStatus(plxd);
    // No service here (Windows before PLX-576), or none to keep while Connect is off.
    if (status === undefined || (!connectOn && !/^installed: true$/m.test(status))) {
      next = "done";
      return;
    }
    const copy = await refreshCopy(plxd, homedir());
    const local = connections.get("local")?.state;
    const runsCopy =
      local?.status === "connected" &&
      local.plxd === copy.version &&
      (await serviceRuns(status, copy.plxd, (file) => readFile(file, "utf8")));
    const health = await connections.get("local")?.request("host/health", {});
    const agents = health && "result" in health ? health.result.runningAgents : undefined;
    const step = serviceStep(status, runsCopy, agents, installed);
    if (step === "failed")
      throw new Error(`it still isn't running ${copy.plxd} ${copy.version}:\n${status}`);
    if (step === "install") {
      await runPlxd(copy.plxd, "service", "install", "--replace");
      next = "installed";
    } else if (step === "done") {
      serviceFailures = 0;
      next = "done";
    }
  } catch (error) {
    const wait = backoffMs(serviceFailures++, 5 * 60_000);
    serviceRetryAt = Date.now() + wait;
    console.warn(
      `parallax: couldn't keep plxd under its login service, trying again in ${wait / 1000} s at the earliest:`,
      error,
    );
  } finally {
    serviceState = next;
  }
}

/**
 * A device's connection, `plxd dial` to its current address, unless it's off. One that stopped
 * retrying, such as one refused as `incompatibleProtocol` before its plxd was updated, tries again.
 */
function addDeviceConnection(device: SavedDevice): void {
  const id = deviceHostId(device.id);
  if (device.off || device.removed || device.migrated) return;
  const existing = connections.get(id);
  if (existing) {
    if (existing.state.status === "failed" && !existing.state.retrying) existing.retry();
    return;
  }
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
  const name = answer.result.deviceName || undefined;
  const icon = isDeviceIcon(answer.result.deviceIcon) ? answer.result.deviceIcon : undefined;
  const relayId = relayIdOf(hostId);
  if (relayId) {
    // An account computer keeps the name it registered with until its plxd has one.
    const saved = savedAccounts().find((a) => a.hostId === relayId);
    if (!saved || ((!name || saved.name === name) && saved.icon === icon)) return;
    const { icon: _icon, ...rest } = saved;
    updateAccount(relayId, () => ({ ...rest, ...(name && { name }), ...(icon && { icon }) }));
    if (announce) broadcast("parallax:devices", deviceHosts());
    return;
  }
  const old = deviceOf(hostId);
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
  if (
    !host ||
    (hostId !== "local" && !hostId.startsWith("tailnet:") && !hostId.startsWith("account:"))
  )
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
  const saved = accountOf(hostId);
  if (saved) {
    const { off: _off, removed: _removed, ...rest } = saved;
    const next = updateAccount(saved.hostId, () => (enabled ? rest : { ...rest, off: true }));
    if (next && enabled) addAccountConnection(next);
    else dropAccountConnection(accountId(saved.hostId));
    broadcast("parallax:devices", deviceHosts());
    return;
  }
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
  const saved = accountOf(hostId);
  if (saved) {
    const { off: _off, ...rest } = saved;
    updateAccount(saved.hostId, () => ({ ...rest, removed: true }));
    dropAccountConnection(accountId(saved.hostId));
    broadcast("parallax:devices", deviceHosts());
    return;
  }
  const device = deviceOf(hostId);
  if (!device) return;
  const { off: _off, ...rest } = device;
  keepDevices(savedDevices().map((d) => (d === device ? { ...rest, removed: true as const } : d)));
  dropDeviceConnection(deviceHostId(device.id));
  broadcast("parallax:devices", deviceHosts());
}

// Parallax Connect over the relay (0091): while signed in, this app keeps a connection to every
// other computer on the account, as host `account:<relay id>`, with `plxd dial --account`, which
// pins the computer's key to its id over every route. One it has no session with signs in with a
// fresh Clerk token, or, if none of the user's computers vouches for it yet, takes the code its
// `plx connect` shows. The app also shows the user's other devices asking to sign in, and copies
// who's approved between the computers it reaches.

const savedAccounts = () => settings.accounts ?? [];

/** A saved account computer by its host id in the app, `account:<relay id>`. */
const accountOf = (hostId: unknown) =>
  typeof hostId === "string"
    ? savedAccounts().find((a) => accountId(a.hostId) === hostId)
    : undefined;

/** Keeps `accounts`, in memory even when settings.json can't be written. */
function keepAccounts(accounts: SavedAccount[]): void {
  if (saveSettings({ ...settings, accounts })) settings = { ...settings, accounts };
}

/** Replaces the saved account computer `relayId` with `change` of it, and answers the new one. */
function updateAccount(
  relayId: string,
  change: (saved: SavedAccount) => SavedAccount,
): SavedAccount | undefined {
  const old = savedAccounts().find((a) => a.hostId === relayId);
  if (!old) return undefined;
  const next = change(old);
  keepAccounts(savedAccounts().map((a) => (a === old ? next : a)));
  return next;
}

/** Each account computer's routes (accountHosts.ts), by host id. */
const accountRoutes = new Map<string, Routes>();
/** Each account computer's sign-in, by host id, while it needs the user or runs. */
const accountAccess = new Map<string, AccountAccess>();
/** Account computers this app signed in to since they last answered, so a refusal asks once. */
const signedIn = new Set<string>();
/** The requests this app's own sign-ins are waiting on, which it never prompts itself about. */
const ownRequests = new Set<string>();
/** Each connected `tailnet:` device's relay id, from `relay/id`, which migration matches by. */
const tailnetRelayIds = new Map<string, string>();

function setAccess(id: string, access: AccountAccess | undefined): void {
  if (access) accountAccess.set(id, access);
  else if (!accountAccess.delete(id)) return;
  broadcast("parallax:devices", deviceHosts());
}

/**
 * An account computer's connection, unless it's off or removed. One that stopped retrying, such
 * as one refused as `incompatibleProtocol` before its plxd was updated, tries again; one refused
 * for want of a session picks up its sign-in.
 */
function addAccountConnection(saved: SavedAccount): void {
  const id = accountId(saved.hostId);
  if (saved.off || saved.removed) return;
  const existing = connections.get(id);
  if (existing) {
    if (existing.state.status !== "failed" || existing.state.retrying) return;
    if (existing.state.error.reason === "refused") void beginAccess(id);
    else existing.retry();
    return;
  }
  const routes = new Routes({
    hostId: saved.hostId,
    learned: () => accountOf(id)?.routes ?? [],
    probe: (direct) => probeRoutes(saved.hostId, direct),
    move: () => connections.get(id)?.reconnect(),
  });
  accountRoutes.set(id, routes);
  addConnection(
    id,
    () => {
      const plxd = localPlxd();
      return plxd === undefined
        ? undefined
        : [plxd, "dial", "--account", saved.hostId, "--", ...routes.dial()];
    },
    { account: saved.name, env: relayEnv, onRoute: (route) => (routes.route = route) },
  );
}

function dropAccountConnection(id: string): void {
  connections.get(id)?.dispose();
  connections.delete(id);
  accountRoutes.get(id)?.dispose();
  accountRoutes.delete(id);
  signedIn.delete(id);
  setAccess(id, undefined);
}

/**
 * Asks the local plxd for the account's computers (`relay/hosts`), keeps them, and connects to
 * each, reviving any that stopped. Runs on a sign-in, the network coming back or changing, focus,
 * and Settings > Connections or Add computer opening, with no timer, as T3 Connect does.
 */
const discoverAccounts = coalesced(async () => {
  const token = await account?.accessToken();
  const local = connections.get("local");
  if (!token || local?.state.status !== "connected") return;
  const answer = await local.request("relay/hosts", { token });
  if ("error" in answer) return;
  const { accounts, changed } = mergeListed(savedAccounts(), answer.result.hosts);
  if (changed) {
    for (const old of savedAccounts())
      if (!accounts.some((a) => a.hostId === old.hostId))
        dropAccountConnection(accountId(old.hostId));
    keepAccounts(accounts);
  }
  offlineAccounts.clear();
  for (const each of answer.result.hosts)
    if (!each.online) offlineAccounts.add(accountId(each.hostId));
  for (const each of accounts) addAccountConnection(each);
  // A new computer that was offline may answer now.
  for (const [id, access] of accountAccess)
    if (access.step === "needsCode" && access.offline && !offlineAccounts.has(id))
      void askForCode(id);
  broadcast("parallax:devices", deviceHosts());
});

/** Focus or a network change: the account's computers again, and each relay route's re-check. */
function lookAgain(): void {
  void discoverAccounts();
  for (const routes of accountRoutes.values()) void routes.recheck();
}

/** A network change: as `lookAgain`, with each account computer's routes read again first. */
async function networkChanged(): Promise<void> {
  void discoverAccounts();
  await Promise.all([...accountRoutes.keys()].map(readRoutes));
  for (const routes of accountRoutes.values()) void routes.recheck();
}

/**
 * Reads connected account computer `id`'s routes from its plxd (`relay/id`), and keeps its direct
 * ones in place of those saved, LAN then Tailscale. The dial adds the relay itself. An older plxd
 * reports none, so what the sign-in or pairing learned stays.
 */
async function readRoutes(id: string): Promise<void> {
  const relayId = relayIdOf(id);
  const host = connections.get(id);
  if (!relayId || host?.state.status !== "connected") return;
  const answer = await host.request("relay/id", {});
  if ("error" in answer || answer.result.hostId !== relayId || !answer.result.routes) return;
  const routes = directRoutes(answer.result.routes);
  const saved = savedAccounts().find((a) => a.hostId === relayId);
  if (saved && saved.routes.join("\n") !== routes.join("\n"))
    updateAccount(relayId, (each) => ({ ...each, routes }));
}

/** The first of `routes` to present account computer `relayId`'s key, sent nothing (0091). */
async function probeRoutes(relayId: string, routes: string[]): Promise<string | undefined> {
  const plxd = localPlxd();
  if (!plxd) return undefined;
  try {
    const args = ["--probe", "--account", relayId, "--", ...routes];
    const { stdout } = await dialPlxd(plxd, args, await account?.accessToken());
    const { route } = JSON.parse(stdout) as { route?: unknown };
    return typeof route === "string" ? route : undefined;
  } catch {
    return undefined;
  }
}

/** A connection's state, as account access follows it: sign-ins, prompts, and migration. */
function followAccess(hostId: string, state: ConnectionState): void {
  const relayId = relayIdOf(hostId);
  if (relayId) accountRoutes.get(hostId)?.onStatus(state.status);
  if (relayId && state.status === "failed" && state.error.reason === "refused")
    void beginAccess(hostId);
  if (state.status !== "connected") return;
  if (relayId) {
    signedIn.delete(hostId);
    setAccess(hostId, undefined);
    finishMigration(relayId);
    void readRoutes(hostId);
  }
  if (hostId === "local") {
    void discoverAccounts();
    // Sign-ins that waited for the local plxd's lists.
    for (const [id, each] of connections)
      if (relayIdOf(id) && each.state.status === "failed" && each.state.error.reason === "refused")
        void beginAccess(id);
  }
  if (hostId.startsWith("tailnet:")) void matchTailnet(hostId);
  if (hostId === "local" || relayId || hostId.startsWith("tailnet:")) {
    watchAccess(hostId);
    void syncAccess();
  }
}

/**
 * The user's computers this app has a session with, connected, whose plxd keeps who may sign in
 * (`accountAccess`): this computer, the account's, and the tailnet's.
 */
const accessHosts = () =>
  [...connections].filter(
    ([id, each]) =>
      (id === "local" || relayIdOf(id) || id.startsWith("tailnet:")) &&
      each.state.status === "connected" &&
      each.state.capabilities["accountAccess"],
  );

/**
 * The relay ids the user's computers vouch for (0091): each connected one's `approvedHosts`, and
 * the `tailnet:` devices', which Tailscale vouches for. Undefined until the local plxd answers.
 */
async function vouchedHosts(): Promise<Set<string> | undefined> {
  const asked = accessHosts();
  if (!asked.some(([id]) => id === "local")) return undefined;
  const answers = await Promise.all(asked.map(([, each]) => each.request("access/get", {})));
  const vouched = new Set(tailnetRelayIds.values());
  for (const answer of answers)
    if ("result" in answer) for (const id of answer.result.approvedHosts) vouched.add(id);
  return vouched;
}

/**
 * What an account computer that refused this app for want of a session needs: a sign-in when the
 * user's computers vouch for it, else the code its `plx connect` shows. One sign-in runs on its
 * own after each time the computer answered; after that, a denied or lapsed request waits for
 * the user to ask again, since a new request starts only when the user asks (0091).
 */
async function beginAccess(id: string): Promise<void> {
  const step = accountAccess.get(id)?.step;
  if (step === "signingIn" || step === "pairing" || step === "pending" || step === "ask") return;
  const relayId = relayIdOf(id);
  const vouched = await vouchedHosts();
  if (!relayId || !vouched || connections.get(id)?.state.status !== "failed") return;
  if (!vouched.has(relayId)) return askForCode(id);
  if (signedIn.has(id))
    return setAccess(id, { step: "ask", why: "It hasn't let this computer in. Ask again." });
  await signIn(id);
}

/** Account computers the relay last listed as offline, by host id. */
const offlineAccounts = new Set<string>();
/** New account computers whose routes `askForCode` is probing, so one trigger probes once. */
const probing = new Set<string>();

/**
 * Marks new account computer `id` as needing the code its `plx connect` shows. The dialog asks
 * for it only once the computer answers: one the relay lists as offline, or none of whose routes
 * presents its key, as an old install's leftover entry never does, stays `offline`, listed in
 * Settings > Connections, where Enter code still asks (0091). Discovery checks again.
 */
async function askForCode(id: string): Promise<void> {
  const relayId = relayIdOf(id);
  const routes = accountRoutes.get(id);
  if (!relayId || !routes || probing.has(id)) return;
  probing.add(id);
  const answers =
    !offlineAccounts.has(id) && (await probeRoutes(relayId, routes.dial())) !== undefined;
  probing.delete(id);
  const now = accountAccess.get(id);
  // Something moved on meanwhile, or nothing changed, which keeps a wrong code's error.
  if ((now && now.step !== "needsCode") || (now && !now.offline === answers)) return;
  setAccess(id, { step: "needsCode", ...(!answers && { offline: true as const }) });
}

/**
 * Signs in to account computer `id` with a fresh Clerk token (0091) through `plxd dial --account
 * --sign-in`, which saves the session it gets. While the computer waits for one of the user's
 * devices to allow this one, its code shows here too; during migration, the `tailnet:` connection
 * to the same computer allows it, so no code is asked for.
 */
async function signIn(id: string): Promise<void> {
  const relayId = relayIdOf(id);
  const routes = accountRoutes.get(id);
  const plxd = localPlxd();
  if (!relayId || !routes || !plxd) return;
  signedIn.add(id);
  setAccess(id, { step: "signingIn" });
  const token = await account?.freshToken();
  if (!token)
    return setAccess(id, {
      step: "ask",
      why: "Sign in to Parallax from Profile in the sidebar first.",
    });
  const relayToken = await account?.accessToken();
  const child = spawn(
    plxd,
    ["dial", "--account", relayId, "--sign-in", `--name=${localName()}`, "--", ...routes.dial()],
    {
      windowsHide: true,
      env: { ...process.env, ...(relayToken && { PLXD_RELAY_TOKEN: relayToken }) },
    },
  );
  child.stdin.on("error", () => {});
  child.stdin.end(`${token}\n`);
  let stderr = "";
  child.stderr.on("data", (chunk: Buffer) => (stderr = (stderr + String(chunk)).slice(-2000)));
  let request: string | undefined;
  createInterface({ input: child.stdout }).on("line", (line) => {
    const answer = parseSignIn(line);
    if (answer?.status === "pending") {
      request = answer.request;
      ownRequests.add(request);
      setAccess(id, { step: "pending", code: answer.code });
      void allowOverTailnet(relayId, answer.request);
    } else if (answer) learn(relayId, answer.name, answer.routes);
  });
  const code = await new Promise<number | null>((resolve) => {
    child.on("error", () => resolve(-1));
    child.on("close", resolve);
  });
  if (request) ownRequests.delete(request);
  if (code === 0) {
    setAccess(id, undefined);
    connections.get(id)?.retry();
    return;
  }
  setAccess(id, {
    step: "ask",
    why:
      code === 5
        ? "It didn't let this computer in: the request was denied or lapsed."
        : `Parallax couldn't sign in there: ${stderr.replace(/^plxd dial: /gm, "").trim() || "plxd failed"}`,
  });
}

/** Keeps what account computer `relayId` said of itself while signing in or pairing. */
function learn(relayId: string, name: string, routes: string[]): void {
  updateAccount(relayId, (saved) => ({
    ...saved,
    ...(name && { name }),
    ...(routes.length && { routes }),
  }));
}

/**
 * `window.parallax.enterSetupCode`: pairs with new account computer `hostId` with the 6-digit code
 * its `plx connect` shows (0091), through `plxd dial --account --pair`. Each typed code gets one
 * run, at most `MAX_PAIR_RUNS` an hour per computer, since a computer the relay made up sets no
 * limit of its own. Then this app vouches for it to the user's other computers. Resolves to an
 * error for people.
 */
async function enterSetupCode(hostId: unknown, code: unknown): Promise<string | undefined> {
  const saved = accountOf(hostId);
  if (!saved) return "That computer isn't on your account anymore.";
  const id = accountId(saved.hostId);
  const digits = typeof code === "string" ? code.replace(/\s/g, "") : "";
  if (!/^\d{6}$/.test(digits)) return "Enter the 6 digits it shows.";
  const plxd = localPlxd();
  const routes = accountRoutes.get(id);
  if (!plxd || !routes) return "plxd wasn't found. Set PLXD_PATH to the plxd binary.";
  const runs = countPairRun(saved.pairRuns, Date.now());
  const fail = (why: string) => (setAccess(id, { step: "needsCode", error: why }), why);
  if (!runs) return fail("That's 5 tries with this computer this hour. Try again later.");
  updateAccount(saved.hostId, (each) => ({ ...each, pairRuns: runs }));
  setAccess(id, { step: "pairing" });
  let stdout: string;
  try {
    const args = ["--account", saved.hostId, "--pair", `--name=${localName()}`, "--"];
    const running = dialPlxd(plxd, [...args, ...routes.dial()], await account?.accessToken());
    running.child.stdin?.end(`${digits}\n`);
    ({ stdout } = await running);
  } catch (error) {
    const exit = (error as { code?: unknown }).code;
    if (exit === 5)
      return fail("That code is wrong, used, or expired. Check it, then type it again.");
    if (exit === 4)
      return fail("Couldn't reach it. Check that it's on and still showing its code.");
    const why = (error as { stderr?: string }).stderr?.replace(/^plxd dial: /gm, "").trim();
    return fail(`Parallax couldn't pair: ${why || "plxd failed"}`);
  }
  const paired = JSON.parse(stdout) as { name?: unknown; routes?: unknown };
  learn(
    saved.hostId,
    typeof paired.name === "string" ? paired.name : "",
    directRoutes(paired.routes),
  );
  // This computer vouches for it now, and `syncAccess` tells the rest once it connects.
  await connections.get("local")?.request("access/merge", {
    approvedClients: [],
    removedClients: [],
    approvedHosts: [saved.hostId],
  });
  setAccess(id, undefined);
  connections.get(id)?.retry();
  return undefined;
}

/** Reads a `tailnet:` device's relay id, which matches it to its account computer (0091). */
async function matchTailnet(tailnetId: string): Promise<void> {
  const answer = await connections.get(tailnetId)?.request("relay/id", {});
  if (!answer || "error" in answer) return;
  const relayId = answer.result.hostId;
  tailnetRelayIds.set(tailnetId, relayId);
  const id = accountId(relayId);
  if (connections.get(id)?.state.status === "connected") return finishMigration(relayId);
  // Tailscale vouches for it, so a computer that asked for its code signs in instead.
  if (accountAccess.get(id)?.step === "needsCode") {
    setAccess(id, undefined);
    void beginAccess(id);
  }
}

/** Allows this app's own request at account computer `relayId` over its `tailnet:` connection. */
async function allowOverTailnet(relayId: string, request: string): Promise<void> {
  for (const [tailnetId, matched] of tailnetRelayIds)
    if (matched === relayId)
      await connections.get(tailnetId)?.request("access/approve", { request });
}

/** Once account computer `relayId` answers, its `tailnet:` connection goes for good (0091). */
function finishMigration(relayId: string): void {
  const migrating = [...tailnetRelayIds].filter(([, matched]) => matched === relayId);
  if (!migrating.length) return;
  const ids = new Set(migrating.map(([tailnetId]) => tailnetId));
  keepDevices(
    savedDevices().map((d) => (ids.has(deviceHostId(d.id)) ? { ...d, migrated: relayId } : d)),
  );
  for (const tailnetId of ids) {
    tailnetRelayIds.delete(tailnetId);
    dropDeviceConnection(tailnetId);
  }
  broadcast("parallax:devices", deviceHosts());
}

/**
 * New devices' requests waiting on the user's computers (0091), by request id, with the hosts
 * showing each. One device asks one computer, but this app may reach it more than one way.
 */
const prompts = new Map<string, { prompt: AccessPrompt; hosts: Set<string> }>();
/** The connection each host's waiting `access/get` runs on. */
const watchedAccess = new Map<string, Connection>();
/** How long one `access/get {after}` waits before it's asked again: plxd answers on a change. */
const ACCESS_WAIT_MS = 60 * 60_000;

const accessRequests = (): AccessPrompt[] => [...prompts.values()].map((p) => p.prompt);

/**
 * Keeps one `access/get {after}` waiting on connected host `hostId` (0091), which answers when
 * who may sign in there changes, so a new device's request shows here at once.
 */
function watchAccess(hostId: string): void {
  const host = connections.get(hostId);
  if (
    !host ||
    host.state.status !== "connected" ||
    !host.state.capabilities["accountAccess"] ||
    watchedAccess.get(hostId) === host
  )
    return;
  watchedAccess.set(hostId, host);
  void (async () => {
    let after: number | undefined;
    while (connections.get(hostId) === host && host.state.status === "connected") {
      const params = after === undefined ? {} : { after };
      const answer = await host.request("access/get", params, ACCESS_WAIT_MS);
      // Only a wait that ran out is asked again; anything else ends with the connection.
      if ("error" in answer) {
        if (/timed out/.test(answer.error.message)) continue;
        break;
      }
      after = answer.result.version;
      showRequest(hostId, answer.result.pending);
    }
    if (watchedAccess.get(hostId) === host) watchedAccess.delete(hostId);
    showRequest(hostId, undefined);
  })();
}

/** Host `hostId`'s waiting request, shown once it has its code, and no other of that host's. */
function showRequest(hostId: string, pending: AccessRequest | undefined): void {
  const before = JSON.stringify(accessRequests());
  for (const [id, each] of prompts) {
    if (id === pending?.id) continue;
    each.hosts.delete(hostId);
    if (!each.hosts.size) prompts.delete(id);
  }
  if (pending?.code && !ownRequests.has(pending.id)) {
    const host =
      hostId === "local"
        ? localName()
        : (accountOf(hostId)?.name ?? deviceOf(hostId)?.name ?? deviceOf(hostId)?.hostName ?? "");
    const shown = prompts.get(pending.id) ?? {
      prompt: { id: pending.id, name: pending.name, code: pending.code, host },
      hosts: new Set<string>(),
    };
    shown.hosts.add(hostId);
    prompts.set(pending.id, shown);
  }
  if (JSON.stringify(accessRequests()) !== before)
    broadcast("parallax:accessRequests", accessRequests());
}

/**
 * `window.parallax.answerAccess`: allows or denies a new device's request on a computer showing
 * it. Allowing copies the device's key to the user's other computers. Resolves to an error for
 * people.
 */
async function answerAccess(id: string, allow: boolean): Promise<string | undefined> {
  const shown = prompts.get(id);
  if (!shown) return "That request isn't waiting anymore.";
  let why = "Parallax isn't connected to that computer.";
  for (const hostId of shown.hosts) {
    const method = allow ? "access/approve" : "access/deny";
    const answer = await connections.get(hostId)?.request(method, { request: id });
    if (!answer) continue;
    if ("error" in answer) {
      why = answer.error.message;
      continue;
    }
    if (allow) void syncAccess();
    return undefined;
  }
  return `Parallax couldn't ${allow ? "allow" : "deny"} it: ${why}`;
}

/**
 * Copies who may sign in between the user's computers this app reaches (0091): every connected
 * one's approved and removed keys and approved host ids, and their own relay ids, merged into
 * each that lacks any. A computer that was offline catches up the next time it connects.
 */
const syncAccess = coalesced(async () => {
  const read = await Promise.all(
    accessHosts().map(async ([, host]) => {
      const [state, own] = await Promise.all([
        host.request("access/get", {}),
        host.request("relay/id", {}),
      ]);
      return "result" in state && "result" in own
        ? { host, state: state.result, relayId: own.result.hostId }
        : undefined;
    }),
  );
  const known = read.filter((each) => each !== undefined);
  if (known.length < 2) return;
  const union = unionLists(
    known.map((each) => each.state),
    known.map((each) => each.relayId),
  );
  await Promise.all(
    known
      .filter((each) => lacks(each.state, union))
      .map((each) => each.host.request("access/merge", union)),
  );
});

/**
 * `window.parallax.turnOnReach`: for a `tailnet:` device the user kept on Tailscale only, registers
 * it with the relay under the signed-in account (`joinRelay`), turns on its `relay` and `remote`,
 * and asks the account for its computers, so it moves to an `account:` connection before the
 * Tailscale-only path goes (0091). Resolves to an error for people.
 */
async function turnOnReach(hostId: unknown): Promise<string | undefined> {
  const host =
    typeof hostId === "string" && hostId.startsWith("tailnet:")
      ? connections.get(hostId)
      : undefined;
  if (host?.state.status !== "connected") return "Parallax can't reach that computer right now.";
  if (!(await account?.accessToken()))
    return "Sign in to Parallax from Profile in the sidebar first.";
  await joinRelay(hostId as string);
  const answer = await host.request("host/settings/set", { relay: true, remote: true });
  if ("error" in answer) return `Parallax couldn't turn it on there: ${answer.error.message}`;
  void discoverAccounts();
  return undefined;
}

/** The key thumbprints host `host` keeps as removed; none when it can't say. */
async function removedKeys(host: Connection): Promise<Set<string>> {
  if (host.state.status !== "connected" || !host.state.capabilities["accountAccess"])
    return new Set();
  const answer = await host.request("access/get", {});
  return new Set("result" in answer ? answer.result.removedClients : []);
}

/**
 * `window.parallax.revokeDevice`: ends a device's session on this computer (`remote/revoke`).
 * A device signed in with the account then has its key removed here, which plxd does with the
 * revoke, and on every other computer this app has a session with (`access/remove`), so it gets
 * a session nowhere (0091). A computer offline now learns of it from `syncAccess` once it
 * connects. Answers this computer's sessions, or why not, for people.
 */
async function revokeDevice(id: unknown): Promise<RemoteSessionsResult | string> {
  if (typeof id !== "string") return "invalid session";
  const local = connections.get("local");
  if (local?.state.status !== "connected")
    return "Parallax isn't connected to this computer's plxd.";
  const before = await removedKeys(local);
  const answer = await local.request("remote/revoke", { id });
  if ("error" in answer) return answer.error.message;
  const removed = [...(await removedKeys(local))].filter((key) => !before.has(key));
  const others = accessHosts().filter(([hostId]) => hostId !== "local");
  await Promise.all(
    others.flatMap(([, host]) =>
      removed.map((thumbprint) => host.request("access/remove", { thumbprint })),
    ),
  );
  return answer.result;
}

function connection(hostId: unknown): Connection {
  const found = typeof hostId === "string" ? connections.get(hostId) : undefined;
  if (!found) throw new Error(`unknown host: ${String(hostId)}`);
  return found;
}

/** A terminal's id, which its window picks. */
const isTerminalId = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= 500;

/** A device stream to open: its window's id for it, a device, and what it carries (PLX-886). */
const isDeviceStreamParams = (value: unknown): value is DeviceStreamParams =>
  isObject(value) &&
  isTerminalId(value["streamId"]) &&
  typeof value["deviceId"] === "string" &&
  (value["platform"] === "ios" || value["platform"] === "android") &&
  (value["kind"] === "video" || value["kind"] === "control");

/** A thread's setup or settle script terminal's plxd id: `setup-<id>` or `settle-<id>-<8 hex>`. */
const isScriptTerminal = (value: unknown): value is string =>
  typeof value === "string" && /^(setup|settle)-[a-z0-9-]{1,48}$/.test(value);

/** A terminal's width or height, in character cells. */
const isSize = (value: unknown): value is number =>
  typeof value === "number" && Number.isInteger(value) && value > 0 && value <= 1000;

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function invalid(code: number, message: string): RpcResponse<never> {
  return { error: { code, message } };
}

/** Sends a subscription's or watch's message to its window, counted in `ipcStats`. */
function forward(sender: WebContents, key: string, message: unknown): void {
  if (sender.isDestroyed()) return;
  if (ipcStats) {
    ipcStats.messages += 1;
    ipcStats.bytes += Buffer.byteLength(JSON.stringify(message));
  }
  sender.send("parallax:subscription", key, message);
}

/** A window's subscriptions, ended when it closes or reloads, since its listeners are gone. */
const windowSubscriptions = (sender: WebContents) =>
  perWindow(subscriptions, sender, (own) => {
    for (const unsubscribe of own.values()) unsubscribe();
    own.clear();
  });
