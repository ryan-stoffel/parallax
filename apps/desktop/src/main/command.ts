import { execFile } from "node:child_process";
import { constants } from "node:fs";
import {
  access,
  cp,
  lstat,
  mkdir,
  readFile,
  readlink,
  rename,
  rm,
  symlink,
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
 * - macOS: a link at `/usr/local/bin/parallax` to the bundled plxd, on every Mac's PATH through
 *   `/etc/paths`. Linking there takes an administrator, so the app asks once, as VS Code installs
 *   `code`.
 * - Linux: an AppImage runs from a mount that goes away, so plxd and what it reads beside itself
 *   (its version, the agent SDKs) are copied to `~/.local/share/parallax/app`, and
 *   `~/.local/bin/parallax` links to that plxd. Copied again when the app's version differs.
 * - Windows: `parallax.cmd` in `%LOCALAPPDATA%\Parallax\bin`, which goes on the user's PATH. It
 *   names the command with `PLXD_INVOKED_AS`, since a batch file can't name the program.
 *
 * plxd follows the link to itself before it starts `serve`, so `serve` finds those files.
 */

/**
 * What plxd reads beside itself, which the Linux copy carries: its version and the agent SDKs
 * (scripts/ci/package-app), and the web client it serves (`remote_web_dir`).
 */
const BESIDE_PLXD = [
  "plxd",
  "plxd.version",
  "claude-agent-sdk",
  "cursor-sdk",
  "app.asar.unpacked/dist/renderer",
];

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

/** Where the command and what it runs go on one OS, for the bundled plxd at `plxd`. */
export type Layout = {
  platform: NodeJS.Platform;
  /** The command: a link, or on Windows, a launcher. */
  file: string;
  /** The bundled plxd. */
  plxd: string;
  /** Linux: the copy of the bundled files, whose plxd the link points at. */
  copy?: string;
  /** Windows: `%LOCALAPPDATA%`, which the launcher names its path by. */
  localAppData?: string;
};

export function layout(
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
  home: string,
  plxd: string,
): Layout {
  if (platform === "darwin") return { platform, file: "/usr/local/bin/parallax", plxd };
  if (platform === "win32") {
    const localAppData = env["LOCALAPPDATA"] || path.win32.join(home, "AppData", "Local");
    const file = path.win32.join(localAppData, "Parallax", "bin", "parallax.cmd");
    return { platform, file, plxd, localAppData };
  }
  const data = env["XDG_DATA_HOME"] || path.posix.join(home, ".local", "share");
  const copy = path.posix.join(data, "parallax", "app");
  return { platform, file: path.posix.join(home, ".local", "bin", "parallax"), plxd, copy };
}

/** What the link points at: the bundled plxd, or on Linux, its copy. */
const linkTarget = (at: Layout) => (at.copy ? path.posix.join(at.copy, "plxd") : at.plxd);

/**
 * The Windows launcher. The path goes by `%LOCALAPPDATA%` where it can: `cmd.exe` reads a batch
 * file in the console's code page, which mangles a user name such as José written out.
 */
export function windowsLauncher(at: Layout): string {
  const local = at.localAppData ?? "";
  const under = local && at.plxd.toLowerCase().startsWith(`${local.toLowerCase()}\\`);
  const plxd = under ? `%LOCALAPPDATA%${at.plxd.slice(local.length)}` : at.plxd;
  return `@setlocal\r\n@set PLXD_INVOKED_AS=parallax\r\n@"${plxd}" %*\r\n`;
}

/**
 * What's at the command's place:
 * - `installed`: this app's command, up to date.
 * - `stale`: one this app or another Parallax made, for a plxd that has moved or changed.
 * - `missing`: nothing there.
 * - `other`: something else named `parallax`, left alone.
 */
export async function commandState(at: Layout): Promise<CommandStatus["state"]> {
  const found = await lstat(at.file).catch(() => undefined);
  if (!found) return "missing";
  if (at.platform === "win32") {
    const text = await readFile(at.file, "utf8").catch(() => "");
    if (text === windowsLauncher(at)) return "installed";
    return text.includes("PLXD_INVOKED_AS=parallax") ? "stale" : "other";
  }
  if (!found.isSymbolicLink()) return "other";
  const target = await readlink(at.file);
  if (at.platform === "darwin") {
    if (target === at.plxd) return "installed";
    return target.endsWith(".app/Contents/Resources/plxd") ? "stale" : "other";
  }
  if (target !== linkTarget(at)) return "other";
  // The copy is current when it holds the bundled plxd's version.
  const version = (file: string) => readFile(file, "utf8").catch(() => undefined);
  const copied = await version(path.posix.join(at.copy!, "plxd.version"));
  const bundled = await version(path.posix.join(path.posix.dirname(at.plxd), "plxd.version"));
  return copied !== undefined && copied === bundled ? "installed" : "stale";
}

/** Whether the command's folder is on `pathVariable`. */
export const onPath = (at: Layout, pathVariable: string | undefined) => {
  const separator = at.platform === "win32" ? ";" : ":";
  const folder = (at.platform === "win32" ? path.win32 : path.posix).dirname(at.file);
  return (pathVariable ?? "").split(separator).some((entry) => entry === folder);
};

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

/**
 * What the app keeps about the command: whether it has asked, and whether the user removed it,
 * after which launch leaves it removed.
 */
export type CommandRecord = { asked?: boolean; removed?: boolean };

/** The record in `file`, or an empty one when it's missing or can't be read. */
export async function readRecord(file: string): Promise<CommandRecord> {
  try {
    const { asked, removed } = JSON.parse(await readFile(file, "utf8")) as Record<string, unknown>;
    return { asked: asked === true, removed: removed === true };
  } catch {
    return {};
  }
}

export const writeRecord = (file: string, record: CommandRecord) =>
  writeFile(file, `${JSON.stringify(record)}\n`);

/**
 * Installs the command, replacing a stale one. Throws with a message for people when it can't:
 * on macOS, also when the user cancels the password dialog.
 */
export async function installCommand(at: Layout): Promise<void> {
  const folder = path.dirname(at.file);
  if (at.platform === "darwin") {
    // /usr/local/bin is the user's on some Macs, such as Intel ones with Homebrew.
    if (await writable(folder)) {
      await rm(at.file, { force: true });
      await symlink(at.plxd, at.file);
      return;
    }
    await asAdministrator(
      `mkdir -p ${shellQuote(folder)} && ln -sfn ${shellQuote(at.plxd)} ${shellQuote(at.file)}`,
    );
    return;
  }
  await mkdir(folder, { recursive: true });
  if (at.platform === "win32") {
    await writeFile(at.file, windowsLauncher(at));
    await changeUserPath(folder, true);
    return;
  }
  await copyBundle(at);
  // A link of another program's at this name was left alone by commandState's `other`.
  await rm(at.file, { force: true });
  await symlink(linkTarget(at), at.file);
}

/**
 * Copies plxd and what it reads beside itself into the Linux copy: into a new folder first, then
 * renamed into place over the old one, which is removed. A `serve` still running from the old
 * copy is an older version, which the app replaces as it would its own (`isBundledServe`).
 */
async function copyBundle(at: Layout): Promise<void> {
  const copy = at.copy!;
  const next = `${copy}.next`;
  const old = `${copy}.old`;
  await rm(next, { recursive: true, force: true });
  await mkdir(next, { recursive: true });
  const bundle = path.posix.dirname(at.plxd);
  for (const name of BESIDE_PLXD) {
    await cp(path.posix.join(bundle, name), path.posix.join(next, name), {
      recursive: true,
    }).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
    });
  }
  await rm(old, { recursive: true, force: true });
  await rename(copy, old).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "ENOENT") throw error;
  });
  await rename(next, copy);
  await rm(old, { recursive: true, force: true });
}

/**
 * Removes the command: the link, or on Windows, the launcher and its folder on PATH. On macOS,
 * asks for a password when the folder isn't the user's. Linux's copy stays: a `serve` that
 * `parallax` started may still run from it, and the next install replaces it.
 */
export async function removeCommand(at: Layout): Promise<void> {
  if (at.platform === "darwin" && !(await writable(path.dirname(at.file)))) {
    await asAdministrator(`rm -f ${shellQuote(at.file)}`);
    return;
  }
  await rm(at.file, { force: true });
  if (at.platform === "win32") await changeUserPath(path.win32.dirname(at.file), false);
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
    throw new Error(cancelled ? "Cancelled." : `macOS couldn't do it: ${String(error)}`);
  }
}

/**
 * Adds `folder` to the user's PATH in the registry, or with `add` false, takes it off, keeping the
 * other entries as they are, `%VARIABLES%` and all. Then tells running programs the environment
 * changed, so new terminals see it: setting a variable through .NET sends that notice, and the
 * one it sets is removed in the same call.
 */
async function changeUserPath(folder: string, add: boolean): Promise<void> {
  const script = [
    "$k = Get-Item 'HKCU:\\Environment'",
    "$p = $k.GetValue('Path', '', 'DoNotExpandEnvironmentNames')",
    "$e = @($p -split ';' | Where-Object { $_ -and $_ -ne $env:PARALLAX_BIN })",
    "if ($env:PARALLAX_ADD -eq '1') { $e += $env:PARALLAX_BIN }",
    "$n = $e -join ';'",
    "if ($n -ne $p) {",
    "  Set-ItemProperty -Path 'HKCU:\\Environment' -Name Path -Value $n -Type ExpandString",
    "  [Environment]::SetEnvironmentVariable('PARALLAX_PATH_CHANGED', $null, 'User')",
    "}",
  ].join("\n");
  await promisify(execFile)(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-Command", script],
    {
      env: { ...process.env, PARALLAX_BIN: folder, PARALLAX_ADD: add ? "1" : "0" },
      windowsHide: true,
    },
  );
}
