import type { WebContents } from "electron";
import { execFile } from "node:child_process";
import os from "node:os";

import { NPM_INSTALLS, npmInstallLine } from "../preload/bridge";
import type { CliKind, TerminalKey, TerminalOpenParams } from "../protocol/generated/protocol";
import { SSH_CONTROL_PATH, type Connection } from "./connection";
import { perWindow } from "./windows";

/** Each vendor CLI's own sign-in (0004), as its `--help` gives it. */
const loginArgs: Record<CliKind, string[]> = {
  claude: ["auth", "login"],
  codex: ["login"],
  cursor: ["login"],
};

export const isCliKind = (value: unknown): value is CliKind =>
  typeof value === "string" && Object.hasOwn(loginArgs, value);

/** A program, its arguments, and variables it gets besides those of what runs it. */
export type Command = { file: string; args: string[]; env?: Record<string, string> };

/** An SSH host's destination, checked when it was saved (`checkHost`), and the ssh program. */
export type SshTarget = { destination: string; ssh: string };

/**
 * The command that signs in to an agent of `kind` at `path`, where the host's plxd found it, with
 * `args` (a CLI's own by default) and `env`: run here, or with `ssh -t` on an SSH host.
 * - Windows can't run an npm `.cmd` shim by itself, so one goes through `cmd.exe`, which keeps
 *   the quotes around a path with spaces when they're the only ones.
 * - Over ssh, Codex's browser callback to localhost:1455 is forwarded back here, where the
 *   browser is, and fails at once if that port is taken. Cursor is told not to open a browser on
 *   the host. Claude Code needs neither: with no browser, it asks for a code to paste.
 * ponytail: over ssh, `env` goes as `NAME=value` before the command, for a POSIX shell, unless
 * `path` is a Windows one; a bare program name on a Windows host gets it too, and fails.
 */
export function loginCommand(
  kind: string,
  path: string,
  ssh?: SshTarget,
  platform = process.platform,
  args: string[] = loginArgs[kind as CliKind] ?? [],
  env: Record<string, string> = {},
): Command {
  if (!ssh) {
    const vars = Object.keys(env).length ? { env } : {};
    if (platform === "win32" && /\.(cmd|bat)$/i.test(path)) {
      return {
        file: process.env["ComSpec"] ?? "cmd.exe",
        args: ["/d", "/c", path, ...args],
        ...vars,
      };
    }
    return { file: path, args, ...vars };
  }
  const forward =
    kind === "codex" ? ["-o", "ExitOnForwardFailure=yes", "-L", "1455:localhost:1455"] : [];
  const posix = !/^[a-z]:\\/i.test(path);
  const vars = {
    ...(kind === "cursor" && { NO_OPEN_BROWSER: "1" }),
    ...env,
  };
  const prefix = posix
    ? Object.entries(vars)
        .map(([name, value]) => `${name}=${quote(value)} `)
        .join("")
    : "";
  return overSsh(ssh, `${prefix}${quote(path)} ${args.map(quote).join(" ")}`, forward);
}

/**
 * Antigravity's ACP server, from the ACP Registry's archive for the host's platform: unzipped to
 * `~/.local/opt/agy-acp-server`, with a wrapper on `~/.local/bin` (which plxd searches) that runs
 * it from there, beside the `localharness_external` it ships with.
 * ponytail: pinned to the registry's 1.3.0, as Pi's adapter is pinned; bump it with the registry.
 */
const antigravityPosix = `set -e
case "$(uname -s)-$(uname -m)" in
  Darwin-arm64) build=macos/agy-acp-server-1.3.0-darwin-arm64 ;;
  Darwin-x86_64) build=macos/agy-acp-server-1.3.0-darwin-x86_64 ;;
  Linux-x86_64) build=linux/agy-acp-server-1.3.0-linux-x86_64 ;;
  Linux-aarch64|Linux-arm64) build=linux/agy-acp-server-1.3.0-linux-arm64 ;;
  *) echo "Antigravity's ACP server has no build for $(uname -s) $(uname -m)."; exit 1 ;;
esac
dir="$HOME/.local/opt/agy-acp-server"
zip="$(mktemp -d)/agy.zip"
curl -fL "https://dl.google.com/agy-extensions/releases/$build.zip" -o "$zip"
rm -rf "$dir" && mkdir -p "$dir" "$HOME/.local/bin"
unzip -oq "$zip" -d "$dir"
printf '#!/bin/sh\nexec "%s/agy_acp_server.par" "$@"\n' "$dir" > "$HOME/.local/bin/agy_acp_server.par"
chmod +x "$HOME/.local/bin/agy_acp_server.par"
echo "Installed Antigravity's ACP server in $dir."`;

/**
 * Each agent's own install, by provider kind, as its docs give it: for a POSIX shell, and for
 * PowerShell where it has one.
 */
const installScripts: Record<string, { posix: string; windows?: string }> = {
  claude: {
    posix: "curl -fsSL https://claude.ai/install.sh | bash",
    windows: "irm https://claude.ai/install.ps1 | iex",
  },
  codex: { posix: "npm install -g @openai/codex", windows: "npm install -g @openai/codex" },
  // Pi and OpenCode install with npm, in the background (`runInstall`).
  ...Object.fromEntries(
    Object.entries(NPM_INSTALLS).map(([kind, pkg]) => [
      kind,
      { posix: npmInstallLine(pkg!, false), windows: npmInstallLine(pkg!, true) },
    ]),
  ),
  grokBuild: {
    posix: "curl -fsSL https://x.ai/cli/install.sh | bash",
    windows: "npm install -g @xai-official/grok",
  },
  hermes: {
    posix: "curl -fsSL https://hermes-agent.nousresearch.com/install.sh | bash",
    windows: "iex (irm https://hermes-agent.nousresearch.com/install.ps1)",
  },
  // Its Windows build is an .exe that an instance's binary path names instead.
  antigravity: { posix: antigravityPosix },
};

export const isInstallable = (value: unknown): value is string =>
  typeof value === "string" && Object.hasOwn(installScripts, value);

/**
 * The command that installs an agent of `kind` on a host: its install script in the user's login
 * shell, so it finds `npm` where the user would, or PowerShell on Windows. An SSH host runs it over
 * `ssh -t`, by `hostOs` as its plxd's `host/version` gives it (`windows` on Windows). Resolves to
 * an error for people when it has no install for Windows.
 */
export function installCommand(
  kind: string,
  ssh?: SshTarget,
  platform = process.platform,
  env = process.env,
  hostOs?: string,
): Command | string {
  const script = installScripts[kind]!;
  const windows = ssh ? hostOs === "windows" : platform === "win32";
  if (windows && !script.windows)
    return "Parallax can't install this agent on Windows. Download it, then set its binary path.";
  if (ssh)
    return overSsh(
      ssh,
      windows
        ? `powershell -NoLogo -NoProfile -Command "${script.windows}"`
        : `exec "$SHELL" -lc ${quote(script.posix)}`,
      [],
    );
  if (windows)
    return { file: "powershell.exe", args: ["-NoLogo", "-NoProfile", "-Command", script.windows!] };
  return { file: env["SHELL"] || "/bin/sh", args: ["-lc", script.posix] };
}

/**
 * Runs `command`, an install, with no terminal. Resolves to an error for people, with npm's first
 * error lines (else the end of what it printed), or undefined once it exits with 0.
 */
export function runInstall(command: Command | string): Promise<string | undefined> {
  if (typeof command === "string") return Promise.resolve(command);
  const options = {
    cwd: os.homedir(),
    env: { ...terminalEnv(), ...command.env },
    maxBuffer: 16 * 1024 * 1024,
  };
  return new Promise((resolve) =>
    execFile(command.file, command.args, options, (error, stdout, stderr) => {
      if (!error) return resolve(undefined);
      const lines = (`${stderr}`.trim() || `${stdout}`.trim() || error.message).split("\n");
      // npm's error lines say why, such as `npm error code E404`; it ends with generic advice.
      const npm = lines.filter((line) => /^npm (error|ERR!) /.test(line));
      const why = (npm.length ? npm.slice(0, 3) : lines.slice(-3)).join("\n");
      resolve(`The install failed: ${why}`);
    }),
  );
}

/**
 * Sign in to an SSH host that needs a password or 2FA (0007): ssh as the control master that the
 * host's connections then share (`sshCommand`), run here, where the user answers its prompts.
 * `-f` sends ssh to the background once it has authenticated, so this ends and the master stays,
 * with ControlPersist keeping it after its last client. ServerAlive ends a master whose network
 * went away, such as in sleep, so it can't leave its clients hanging; the user then signs in again.
 * `auto`, not `yes`, so ssh clears a stale socket that a crashed master left, as `yes` would keep
 * it and silently start with no master. Not for Windows, whose OpenSSH has no ControlMaster.
 */
export function masterCommand(ssh: SshTarget): Command {
  return {
    file: ssh.ssh,
    // prettier-ignore
    args: [
      "-o", "ControlMaster=auto", "-o", "ControlPersist=yes", "-o", `ControlPath=${SSH_CONTROL_PATH}`,
      "-o", "ServerAliveInterval=15", "-o", "ServerAliveCountMax=3",
      "-N", "-f", "--", ssh.destination,
    ],
  };
}

/**
 * The Sign in command for the window's `hostId`: only a saved SSH host has a login to share, and
 * not on Windows (`masterCommand`). `ssh` is the program the settings name, if any. Undefined
 * for anything else, such as "local" or a tailnet device.
 */
export function hostLogin(
  hostId: string,
  saved: { id: string; destination: string }[],
  ssh = "ssh",
  platform = process.platform,
): Command | undefined {
  const host = saved.find((h) => h.id === hostId);
  return host && platform !== "win32"
    ? masterCommand({ destination: host.destination, ssh })
    : undefined;
}

/**
 * `remote` run on an SSH host with `ssh -t`. `-e none` turns off ssh's escape character, so
 * what's typed only ever reaches the host.
 */
function overSsh(ssh: SshTarget, remote: string, options: string[]): Command {
  return {
    file: ssh.ssh,
    args: ["-t", "-e", "none", "-o", "ControlPath=none", ...options, "--", ssh.destination, remote],
  };
}

/**
 * What an install runs with: `env`, plus a UTF-8 `LANG` if `env` sets no locale, as when launchd
 * starts the app. In the C locale, zsh counts each byte of a character like a prompt's
 * U+E0A0 as a column, so its line editor draws in the wrong place.
 */
export function terminalEnv(env = process.env): NodeJS.ProcessEnv {
  return env["LC_ALL"] || env["LC_CTYPE"] || env["LANG"] ? env : { ...env, LANG: "en_US.UTF-8" };
}

/** `path` as the host's shell reads it: bare if it can be, else quoted for cmd.exe or POSIX. */
export function quote(path: string): string {
  if (path === "~") return path;
  if (/^[\w./\\:-]+$/.test(path)) return path;
  if (/^[a-z]:\\/i.test(path)) return `"${path}"`;
  return `'${path.replaceAll("'", `'\\''`)}'`;
}

/** A window's terminal: the connection to the plxd that runs it, and plxd's name for it. */
type Opened = { connection: Connection; key: TerminalKey; command: boolean; detach: () => void };
/** Each window's terminals, by the id it gave each. */
const opened = new Map<WebContents, Map<string, Opened>>();

/**
 * Opens `sender`'s terminal `id` as plxd's terminal `params` (PLX-637), in place of any it had with
 * that id: attached to it if it runs, else started. Resolves to an error for people, or undefined
 * once it runs. What it prints goes only to `sender`, as `parallax:terminal` messages with `id`,
 * and is never logged or kept here.
 */
export async function openTerminal(
  sender: WebContents,
  id: string,
  connection: Connection,
  params: TerminalOpenParams,
): Promise<string | undefined> {
  const own = windowTerminals(sender);
  own.get(id)?.detach();
  const { threadId, terminalId } = params;
  const detach = connection.attachTerminal(params, (message) => {
    if (!sender.isDestroyed()) sender.send("parallax:terminal", id, message);
  });
  const entry: Opened = {
    connection,
    key: { threadId, terminalId },
    command: !!params.command,
    detach,
  };
  own.set(id, entry);
  const error = await connection.openTerminal(params);
  if (error && own.get(id) === entry) {
    own.delete(id);
    detach();
  }
  return error;
}

export function writeTerminal(sender: WebContents, id: string, data: string): void {
  const entry = opened.get(sender)?.get(id);
  entry?.connection.writeTerminal(entry.key, data);
}

export function resizeTerminal(sender: WebContents, id: string, cols: number, rows: number): void {
  const entry = opened.get(sender)?.get(id);
  entry?.connection.resizeTerminal(entry.key, cols, rows);
}

/** Ends `sender`'s terminal `id`, killing what runs in it. */
export function closeTerminal(sender: WebContents, id: string): void {
  const entry = opened.get(sender)?.get(id);
  opened.get(sender)?.delete(id);
  entry?.detach();
  entry?.connection.closeTerminal(entry.key);
}

/**
 * A window's terminals. When it reloads or closes, a shell keeps running in plxd for the next
 * window to open, and a command, such as a sign-in, ends.
 */
const windowTerminals = (sender: WebContents) =>
  perWindow(opened, sender, (own) => {
    for (const [id, entry] of own) {
      if (entry.command) closeTerminal(sender, id);
      else entry.detach();
    }
    own.clear();
  });
