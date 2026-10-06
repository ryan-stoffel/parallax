import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";

import { DEVICE_ICONS, npmInstallLine, type DeviceIcon } from "../preload/bridge";
import type { TailnetDevice } from "../protocol/generated/protocol";
import { quote, type Command } from "./terminal";

// Parallax Connect's pieces in main (0056) that need no Electron: what hosts.ts keeps of each
// device, and the commands that install and run plx-connect.

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

/** A Tailscale IP or host name `plx-connect add` may get, which no shell can read as more. */
export const isDeviceAddress = (value: unknown): value is string =>
  typeof value === "string" && /^[\w][\w.:-]{0,252}$/.test(value);

/** An ssh user name `plx-connect add` may get. */
export const isSshUser = (value: unknown): value is string =>
  typeof value === "string" && /^[\w][\w.-]{0,63}$/.test(value);

/**
 * How main runs plx-connect: `PLX_CONNECT_PATH`, a checkout's `bin/plx-connect.mjs` run with
 * node, else `plx-connect` as npm installed it, found by the login shell (or PowerShell), so it
 * finds `node` where the user would. On POSIX npm installs it in `~/.local/bin`
 * (`npmInstallLine`), which a stock macOS login shell doesn't have on PATH, so it goes first.
 */
export type ConnectProgram = { platform: NodeJS.Platform; env: NodeJS.ProcessEnv };

const program = ({ env }: ConnectProgram) => {
  const override = env["PLX_CONNECT_PATH"];
  return override ? `node ${quote(override)}` : "plx-connect";
};

/** `line` in the user's login shell, or in PowerShell on Windows. */
function shell(line: string, { platform, env }: ConnectProgram): Command {
  if (platform === "win32")
    return { file: "powershell.exe", args: ["-NoLogo", "-NoProfile", "-Command", line] };
  return { file: env["SHELL"] || "/bin/sh", args: ["-lc", line] };
}

/** What installs plx-connect on this computer with npm, as an agent's npm install does (PLX-558). */
export const installConnectCommand = (where: ConnectProgram): Command =>
  shell(npmInstallLine("plx-connect", where.platform === "win32"), where);

/** What sets up `device` for Connect: `plx-connect add` in a terminal, where ssh can ask for a password. */
export function addCommand(
  device: string,
  user: string | undefined,
  channel: "stable" | "nightly",
  where: ConnectProgram,
): Command {
  const userArg = user ? ` --user ${user}` : "";
  const line = `${program(where)} add ${device} --channel ${channel}${userArg}`;
  return shell(
    where.platform === "win32" ? line : `PATH="$HOME/.local/bin:$PATH" exec ${line}`,
    where,
  );
}

/** Whether plx-connect is installed here: `PLX_CONNECT_PATH`, npm's `~/.local/bin`, or on the shell's PATH. */
export function findConnect(where: ConnectProgram, home: string): Promise<boolean> {
  const override = where.env["PLX_CONNECT_PATH"];
  if (override) return Promise.resolve(existsSync(override));
  if (where.platform !== "win32" && existsSync(path.join(home, ".local/bin/plx-connect")))
    return Promise.resolve(true);
  const look =
    where.platform === "win32"
      ? shell("Get-Command plx-connect -ErrorAction Stop | Out-Null", where)
      : shell("command -v plx-connect", where);
  const args = Array.isArray(look.args) ? look.args : [look.args];
  return new Promise((resolve) =>
    execFile(look.file, args, { timeout: 10_000 }, (error) => resolve(!error)),
  );
}
