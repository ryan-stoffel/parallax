import { execFile } from "node:child_process";
import { constants } from "node:fs";
import {
  access,
  chmod,
  copyFile,
  lstat,
  mkdir,
  readFile,
  readlink,
  rename,
  rm,
  stat,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import type { CommandStatus } from "../preload/bridge";

/**
 * The `parallax` command (PLX-750): plxd run under that name opens Parallax in the terminal
 * (PLX-740), as `claude` and `codex` open theirs, so a new user types `parallax` and nothing else.
 * No shell's config file is read or written: some are managed, by nix and the like.
 *
 * - macOS: a link at `/usr/local/bin/parallax`, on every Mac's PATH through `/etc/paths`. Linking
 *   there takes an administrator, so the app asks once, as VS Code installs `code`.
 * - Linux: a copy of plxd at `~/.local/bin/parallax`, since an AppImage runs from a mount that
 *   goes away. Most distros put that folder on PATH. Copied again when it differs.
 * - Windows: `parallax.cmd` in `%LOCALAPPDATA%\Parallax\bin`, which goes on the user's PATH.
 */

/**
 * The plxd the command runs: the packaged app's own. None in a dev build or under `PLXD_PATH`,
 * whose plxd is the developer's, and none for a Mac app run from its disk image, which macOS
 * translocates to a path that's gone once it quits.
 */
export function commandSource(lookup: {
  packaged: boolean;
  env: NodeJS.ProcessEnv;
  platform: NodeJS.Platform;
  resourcesPath: string;
  exists: (file: string) => boolean;
}): string | undefined {
  if (!lookup.packaged || lookup.env["PLXD_PATH"]) return undefined;
  const plxd =
    lookup.platform === "win32"
      ? path.win32.join(lookup.resourcesPath, "plxd.exe")
      : path.posix.join(lookup.resourcesPath, "plxd");
  return lookup.exists(plxd) && !plxd.includes("/AppTranslocation/") ? plxd : undefined;
}

/** Where the command goes on `platform`. */
export function commandPath(platform: NodeJS.Platform, env: NodeJS.ProcessEnv, home: string) {
  if (platform === "darwin") return "/usr/local/bin/parallax";
  if (platform === "win32") {
    const local = env["LOCALAPPDATA"] || path.win32.join(home, "AppData", "Local");
    return path.win32.join(local, "Parallax", "bin", "parallax.cmd");
  }
  return path.posix.join(home, ".local", "bin", "parallax");
}

/** The Windows launcher: `plxd.exe tui` with whatever was typed after `parallax`. */
export const windowsLauncher = (plxd: string) => `@"${plxd}" tui %*\r\n`;

/**
 * What's at `file`, the command's place, for the plxd at `plxd`:
 * - `installed`: this app's command.
 * - `stale`: one this app or another Parallax made, for a plxd that has moved or differs.
 * - `missing`: nothing there.
 * - `other`: something else named `parallax`, left alone.
 */
export async function commandState(
  platform: NodeJS.Platform,
  file: string,
  plxd: string,
  record: CommandRecord,
): Promise<CommandStatus["state"]> {
  const found = await lstat(file).catch(() => undefined);
  if (!found) return "missing";
  if (platform === "win32") {
    const text = await readFile(file, "utf8").catch(() => "");
    if (text === windowsLauncher(plxd)) return "installed";
    return /^@".*plxd\.exe" tui %\*\r?\n$/i.test(text) ? "stale" : "other";
  }
  if (platform === "darwin") {
    if (!found.isSymbolicLink()) return "other";
    const target = await readlink(file);
    if (target === plxd) return "installed";
    return target.endsWith(".app/Contents/Resources/plxd") ? "stale" : "other";
  }
  // Linux keeps a copy, the same size and age as the plxd it came from. A file this app didn't
  // copy is someone else's, whatever it holds.
  const source = await stat(plxd).catch(() => undefined);
  if (!found.isFile() || !source || !record.copied) return "other";
  const same = found.size === source.size && Math.abs(found.mtimeMs - source.mtimeMs) < 1;
  return same ? "installed" : "stale";
}

/**
 * Whether to offer the command at launch: only on macOS, where installing it asks for a password,
 * only once, and only when there's nothing named `parallax` yet. Linux and Windows install it
 * without asking.
 */
export const offerAtLaunch = (
  platform: NodeJS.Platform,
  state: CommandStatus["state"],
  asked: boolean,
) => platform === "darwin" && state === "missing" && !asked;

/** What the app keeps about the command: whether it has asked, and whether it copied plxd there. */
export type CommandRecord = { asked?: boolean; copied?: boolean };

/** The record in `file`, or an empty one when it's missing or can't be read. */
export async function readRecord(file: string): Promise<CommandRecord> {
  try {
    const { asked, copied } = JSON.parse(await readFile(file, "utf8")) as Record<string, unknown>;
    return { asked: asked === true, copied: copied === true };
  } catch {
    return {};
  }
}

export const writeRecord = (file: string, record: CommandRecord) =>
  writeFile(file, `${JSON.stringify(record)}\n`);

/**
 * Installs the command for the plxd at `plxd`, replacing a stale one. Throws with a message for
 * people when it can't: on macOS, also when the user cancels the password dialog.
 */
export async function installCommand(
  platform: NodeJS.Platform,
  file: string,
  plxd: string,
): Promise<void> {
  const folder = path.dirname(file);
  if (platform === "darwin") {
    // /usr/local/bin is the user's on some Macs, such as Intel ones with Homebrew.
    if (await writable(folder)) {
      await rm(file, { force: true });
      await symlink(plxd, file);
      return;
    }
    await asAdministrator(
      `mkdir -p ${shellQuote(folder)} && ln -sfn ${shellQuote(plxd)} ${shellQuote(file)}`,
    );
    return;
  }
  await mkdir(folder, { recursive: true });
  if (platform === "win32") {
    await writeFile(file, windowsLauncher(plxd));
    await addToUserPath(folder);
    return;
  }
  // Copied beside, then renamed over, so a `parallax` running from the old copy keeps it.
  const next = `${file}.${process.pid}`;
  await copyFile(plxd, next);
  await chmod(next, 0o755);
  // In seconds, as numbers: a Date would round to the millisecond.
  const { atimeMs, mtimeMs } = await stat(plxd);
  await utimes(next, atimeMs / 1000, mtimeMs / 1000);
  await rename(next, file);
}

/** Removes the command. On macOS, asks for a password when the folder isn't the user's. */
export async function removeCommand(platform: NodeJS.Platform, file: string): Promise<void> {
  if (platform === "darwin" && !(await writable(path.dirname(file)))) {
    await asAdministrator(`rm -f ${shellQuote(file)}`);
    return;
  }
  await rm(file, { force: true });
}

const writable = (folder: string) =>
  access(folder, constants.W_OK).then(
    () => true,
    () => false,
  );

/** `text` as one word for `sh`. */
export const shellQuote = (text: string) => `'${text.replaceAll("'", `'\\''`)}'`;

/** `text` as an AppleScript string. */
export const appleScriptString = (text: string) =>
  `"${text.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;

/** Runs `command` in `sh` as an administrator, through the macOS password dialog. */
async function asAdministrator(command: string): Promise<void> {
  const script = `do shell script ${appleScriptString(command)} with administrator privileges`;
  try {
    await promisify(execFile)("/usr/bin/osascript", ["-e", script]);
  } catch (error) {
    // -128: the user cancelled the dialog.
    const cancelled = /-128/.test(String((error as { stderr?: unknown }).stderr ?? error));
    throw new Error(cancelled ? "Cancelled." : `macOS couldn't install it: ${String(error)}`);
  }
}

/**
 * Puts `folder` on the user's PATH in the registry, keeping its other entries as they are,
 * `%VARIABLES%` and all, then tells running programs the environment changed: new terminals see
 * it. Setting a variable through .NET sends that notice; the one it sets is removed in the same
 * call.
 */
async function addToUserPath(folder: string): Promise<void> {
  const script = [
    "$k = Get-Item 'HKCU:\\Environment'",
    "$p = $k.GetValue('Path', '', 'DoNotExpandEnvironmentNames')",
    "if (($p -split ';') -notcontains $env:PARALLAX_BIN) {",
    '  $n = if ($p) { "$p;$env:PARALLAX_BIN" } else { $env:PARALLAX_BIN }',
    "  Set-ItemProperty -Path 'HKCU:\\Environment' -Name Path -Value $n -Type ExpandString",
    "  [Environment]::SetEnvironmentVariable('PARALLAX_PATH_CHANGED', $null, 'User')",
    "}",
  ].join("\n");
  await promisify(execFile)(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-Command", script],
    { env: { ...process.env, PARALLAX_BIN: folder }, windowsHide: true },
  );
}
