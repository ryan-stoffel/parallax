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
 * A program and its arguments, or on Windows its command line, already quoted, and the folder it
 * starts in (the home folder if absent).
 */
export type Command = { file: string; args: string[] | string; cwd?: string };

/** An SSH host's destination, checked when it was saved (`checkHost`), and the ssh program. */
export type SshTarget = { destination: string; ssh: string };

/**
 * The command that signs in to `cli` at `path`, where the host's plxd found it: run here, or
 * with `ssh -t` on an SSH host.
 * - Windows can't run an npm `.cmd` shim by itself, so one goes through `cmd.exe`.
 * - Over ssh, Codex's browser callback to localhost:1455 is forwarded back here, where the
 *   browser is, and fails at once if that port is taken. Cursor is told not to open a browser on
 *   the host. Claude Code needs neither: with no browser, it asks for a code to paste.
 */
export function loginCommand(
  cli: CliKind,
  path: string,
  ssh?: SshTarget,
  platform = process.platform,
): Command {
  const args = loginArgs[cli];
  if (!ssh) {
    if (platform === "win32" && /\.(cmd|bat)$/i.test(path)) {
      const line = `/d /s /c ""${path}" ${args.join(" ")}"`;
      return { file: process.env["ComSpec"] ?? "cmd.exe", args: line };
    }
    return { file: path, args };
  }
  const forward =
    cli === "codex" ? ["-o", "ExitOnForwardFailure=yes", "-L", "1455:localhost:1455"] : [];
  const env = cli === "cursor" && path.startsWith("/") ? "NO_OPEN_BROWSER=1 " : "";
  return overSsh(ssh, `${env}${quote(path)} ${args.join(" ")}`, forward, platform);
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

/** `path` as the host's shell reads it: bare if it can be, else quoted for cmd.exe or POSIX. */
function quote(path: string): string {
  if (/^[\w./\\:-]+$/.test(path)) return path;
  if (/^[a-z]:\\/i.test(path)) return `"${path}"`;
  return `'${path.replaceAll("'", `'\\''`)}'`;
}

/** A terminal. `pty` is unset while its command is still being found. */
type Session = { pty?: IPty };
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
  const session: Session = {};
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
      cols,
      rows,
      cwd: found.cwd ?? os.homedir(),
      env: process.env,
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
    sessions.get(sender)?.get(id)?.pty?.resize(cols, rows);
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
