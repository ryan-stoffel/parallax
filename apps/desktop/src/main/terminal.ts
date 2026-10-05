import type { WebContents } from "electron";
import type { IPty } from "node-pty";
import os from "node:os";

import type { TerminalMessage } from "../preload/bridge";
import type { CliKind } from "../protocol/generated/protocol";

/** Each vendor CLI's own sign-in (0004), as its `--help` gives it. */
const loginArgs: Record<CliKind, string[]> = {
  claude: ["auth", "login"],
  codex: ["login"],
  cursor: ["login"],
};

export const isCliKind = (value: unknown): value is CliKind =>
  typeof value === "string" && Object.hasOwn(loginArgs, value);

/**
 * A program and its arguments, or on Windows its command line, already quoted, the folder it
 * starts in (the home folder if absent), and variables it gets besides the app's.
 */
export type Command = {
  file: string;
  args: string[] | string;
  cwd?: string;
  env?: Record<string, string>;
};

/** An SSH host's destination, checked when it was saved (`checkHost`), and the ssh program. */
export type SshTarget = { destination: string; ssh: string };

/**
 * The command that signs in to an agent of `kind` at `path`, where the host's plxd found it, with
 * `args` (a CLI's own by default) and `env`: run here, or with `ssh -t` on an SSH host.
 * - Windows can't run an npm `.cmd` shim by itself, so one goes through `cmd.exe`.
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
  const line = args.map(quote).join(" ");
  if (!ssh) {
    const vars = Object.keys(env).length ? { env } : {};
    if (platform === "win32" && /\.(cmd|bat)$/i.test(path)) {
      return {
        file: process.env["ComSpec"] ?? "cmd.exe",
        args: `/d /s /c ""${path}" ${line}"`,
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
  return overSsh(ssh, `${prefix}${quote(path)} ${line}`, forward, platform);
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
  pi: {
    posix: "curl -fsSL https://pi.dev/install.sh | sh",
    windows: "irm https://pi.dev/install.ps1 | iex",
  },
  opencode: {
    posix: "curl -fsSL https://opencode.ai/install | bash",
    windows: "npm install -g opencode-ai@latest",
  },
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
      platform,
    );
  if (windows)
    return { file: "powershell.exe", args: ["-NoLogo", "-NoProfile", "-Command", script.windows!] };
  return { file: env["SHELL"] || "/bin/sh", args: ["-lc", script.posix] };
}

/**
 * The command that opens the user's login shell in `path`, a thread's folder: here, `$SHELL -l`
 * (PowerShell on Windows), or on an SSH host, the host's login shell after a `cd` to it over
 * `ssh -t`. A Windows host's path (`C:\...`) runs under its default shell, cmd.exe.
 */
export function shellCommand(
  path: string,
  ssh?: SshTarget,
  platform = process.platform,
  env = process.env,
): Command {
  if (!ssh) {
    if (platform === "win32") return { file: "powershell.exe", args: ["-NoLogo"], cwd: path };
    return { file: env["SHELL"] || "/bin/sh", args: ["-l"], cwd: path };
  }
  const remote = /^[a-z]:\\/i.test(path)
    ? `cd /d ${quote(path)} && cmd`
    : `cd ${quote(path)} && exec "$SHELL" -l`;
  return overSsh(ssh, remote, [], platform);
}

/**
 * `remote` run on an SSH host with `ssh -t`. `-e none` turns off ssh's escape character, so
 * what's typed only ever reaches the host. node-pty looks a bare name up on PATH without PATHEXT
 * on Windows, so `ssh` becomes `ssh.exe` there.
 */
function overSsh(ssh: SshTarget, remote: string, options: string[], platform: string): Command {
  const bare = platform === "win32" && !/\.\w+$/.test(ssh.ssh);
  return {
    file: bare ? `${ssh.ssh}.exe` : ssh.ssh,
    args: ["-t", "-e", "none", "-o", "ControlPath=none", ...options, "--", ssh.destination, remote],
  };
}

/**
 * What a terminal's program runs with: `env`, plus a UTF-8 `LANG` if `env` sets no locale, as when
 * launchd starts the app. In the C locale, zsh counts each byte of a character like a prompt's
 * U+E0A0 as a column, so its line editor draws in the wrong place.
 */
export function terminalEnv(env = process.env): NodeJS.ProcessEnv {
  return env["LC_ALL"] || env["LC_CTYPE"] || env["LANG"] ? env : { ...env, LANG: "en_US.UTF-8" };
}

/** `path` as the host's shell reads it: bare if it can be, else quoted for cmd.exe or POSIX. */
function quote(path: string): string {
  if (/^[\w./\\:-]+$/.test(path)) return path;
  if (/^[a-z]:\\/i.test(path)) return `"${path}"`;
  return `'${path.replaceAll("'", `'\\''`)}'`;
}

/**
 * A terminal. `pty` is unset while its command is still being found; `size` is the last one asked
 * for, which it starts at.
 */
type Session = { pty?: IPty; size: { cols: number; rows: number } };
/** Each window's terminals, by the id it gave each. */
const sessions = new Map<WebContents, Map<string, Session>>();

/**
 * Starts `sender`'s terminal `id` once `command` says what to run, replacing any terminal it had
 * with that id. Resolves to an error for people, or undefined once it runs. What it prints goes
 * only to `sender`, as `parallax:terminal` messages with `id`, and is never logged or kept.
 */
export async function openTerminal(
  sender: WebContents,
  id: string,
  command: () => Promise<Command | string>,
  cols: number,
  rows: number,
): Promise<string | undefined> {
  closeTerminal(sender, id);
  const own = windowSessions(sender);
  const session: Session = { size: { cols, rows } };
  own.set(id, session);
  const current = () => own.get(id) === session;
  const send = (message: TerminalMessage) => {
    if (current() && !sender.isDestroyed()) sender.send("parallax:terminal", id, message);
  };

  try {
    // Loaded here, so a broken native module only breaks the terminal, not the app.
    const [found, { spawn }] = await Promise.all([command(), import("node-pty")]);
    if (!current()) return undefined; // Closed or replaced meanwhile.
    if (typeof found === "string") {
      own.delete(id);
      return found;
    }
    const pty = spawn(found.file, found.args, {
      name: "xterm-256color",
      ...session.size,
      cwd: found.cwd ?? os.homedir(),
      env: { ...terminalEnv(), ...found.env },
    });
    session.pty = pty;
    pty.onData((data) => send({ type: "data", data }));
    pty.onExit(({ exitCode }) => {
      send({ type: "exit", exitCode });
      if (current()) own.delete(id);
    });
    return undefined;
  } catch (error) {
    if (current()) own.delete(id);
    return `The terminal couldn't start: ${(error as Error).message}`;
  }
}

export function writeTerminal(sender: WebContents, id: string, data: string): void {
  sessions.get(sender)?.get(id)?.pty?.write(data);
}

export function resizeTerminal(sender: WebContents, id: string, cols: number, rows: number): void {
  try {
    const session = sessions.get(sender)?.get(id);
    if (!session) return;
    session.size = { cols, rows };
    session.pty?.resize(cols, rows);
  } catch {
    // It exited, and its exit is on the way.
  }
}

/** Ends `sender`'s terminal `id`, killing what runs in it. */
export function closeTerminal(sender: WebContents, id: string): void {
  const own = sessions.get(sender);
  const pty = own?.get(id)?.pty;
  own?.delete(id);
  try {
    pty?.kill();
  } catch {
    // It already exited.
  }
}

export function closeAllTerminals(): void {
  for (const [sender, own] of sessions) for (const id of own.keys()) closeTerminal(sender, id);
}

/** A window's terminals, closed when it reloads or closes, since nothing there can use them. */
function windowSessions(sender: WebContents): Map<string, Session> {
  let own = sessions.get(sender);
  if (!own) {
    const created = new Map<string, Session>();
    const closeAll = () => {
      for (const id of created.keys()) closeTerminal(sender, id);
    };
    sender.on("did-navigate", closeAll);
    sender.once("destroyed", () => {
      closeAll();
      sessions.delete(sender);
    });
    sessions.set(sender, created);
    own = created;
  }
  return own;
}
