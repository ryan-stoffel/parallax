import { DEVICE_ICONS, type DeviceIcon } from "../preload/bridge";
import type { TailnetDevice } from "../protocol/generated/protocol";
import { quote, type Command } from "./terminal";

// Parallax Connect's pieces in main (0056) that need no Electron: what hosts.ts keeps of each
// device, and the command that runs plx.

/** A Connect device as `settings.json` keeps it, so it's listed and retried while offline. */
export type SavedDevice = {
  /** Its Tailscale node ID. */
  id: string;
  hostName: string;
  ip: string;
  os: string;
  /** Its plxd's `deviceName` and `deviceIcon`, last read, for while it's offline. */
  name?: string;
  icon?: DeviceIcon;
  /** Turned off in this app: listed, with no connection. */
  off?: true;
  /** Removed from this app's list. Kept, so finding it again doesn't add it back. */
  removed?: true;
  /**
   * Reached as the account computer with this relay id now (0091), so its `tailnet:` connection
   * is gone for good.
   */
  migrated?: string;
};

/** A device's host id, by its Tailscale node ID. */
export const deviceHostId = (nodeId: string) => `tailnet:${nodeId}`;

export const isDeviceIcon = (value: unknown): value is DeviceIcon =>
  (DEVICE_ICONS as readonly unknown[]).includes(value);

/**
 * `saved` with what `connect/devices` just found: a known device's address, name, and OS
 * updated, and any device that answers on Connect's port added. `changed` says whether to save.
 */
export function mergeFound(
  saved: SavedDevice[],
  found: TailnetDevice[],
): { devices: SavedDevice[]; changed: boolean } {
  let changed = false;
  const devices = saved.map((device) => {
    const now = found.find((f) => f.id === device.id);
    if (!now || (now.ip === device.ip && now.hostName === device.hostName && now.os === device.os))
      return device;
    changed = true;
    return { ...device, ip: now.ip, hostName: now.hostName, os: now.os };
  });
  for (const f of found) {
    if (!f.parallax || devices.some((d) => d.id === f.id)) continue;
    devices.push({ id: f.id, hostName: f.hostName, ip: f.ip, os: f.os });
    changed = true;
  }
  return { devices, changed };
}

/** A Tailscale IP or host name `plx add` may get, which no shell can read as more. */
export const isDeviceAddress = (value: unknown): value is string =>
  typeof value === "string" && /^[\w][\w.:-]{0,252}$/.test(value);

/** An ssh user name `plx add` may get. */
export const isSshUser = (value: unknown): value is string =>
  typeof value === "string" && /^[\w][\w.-]{0,63}$/.test(value);

/**
 * How main runs plx: the copy in this build, `script`, or `PLX_CONNECT_PATH`, run by the
 * app's own Electron as Node (`ELECTRON_RUN_AS_NODE`; the app sets no fuses), so this computer
 * needs no Node or npm, and plx always matches the app.
 */
export type ConnectProgram = {
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
  /** The app's Electron, `process.execPath`. */
  execPath: string;
  /** `bin/plx.mjs` in the app's resources, which package-app copies, or the repo's in a dev build. */
  script: string;
};

/**
 * What sets up `device` for Connect: `plx add` in a terminal, where ssh can ask for a
 * password, through the login shell, so ssh is found where the user would find it, or PowerShell
 * on Windows. Electron is a GUI program there, which PowerShell doesn't wait for unless its output
 * is piped, so it's piped to the host, read as UTF-8 for plx's ✓ and ✗. Its paths are
 * PowerShell string literals, in which `$` and backticks are plain characters.
 */
export function addCommand(
  device: string,
  user: string | undefined,
  channel: "stable" | "nightly",
  headless: boolean,
  { platform, env, execPath, script }: ConnectProgram,
): Command {
  const args = `add ${device} --channel ${channel}${user ? ` --user ${user}` : ""}${headless ? " --headless" : ""}`;
  const plxConnect = env["PLX_CONNECT_PATH"] || script;
  if (platform === "win32")
    return {
      file: "powershell.exe",
      args: [
        "-NoLogo",
        "-NoProfile",
        "-Command",
        `[Console]::OutputEncoding = [Text.Encoding]::UTF8; $env:ELECTRON_RUN_AS_NODE = '1'; & ${psQuote(execPath)} ${psQuote(plxConnect)} ${args} | Out-Host; exit $LASTEXITCODE`,
      ],
    };
  return {
    file: env["SHELL"] || "/bin/sh",
    args: ["-lc", `ELECTRON_RUN_AS_NODE=1 exec ${quote(execPath)} ${quote(plxConnect)} ${args}`],
  };
}

/** `value` as a PowerShell string literal. */
const psQuote = (value: string) => `'${value.replaceAll("'", "''")}'`;
