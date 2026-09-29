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

/** A program and its arguments, or on Windows its command line, already quoted. */
export type Command = { file: string; args: string[] | string };

/** An SSH host's destination, checked when it was saved (`checkHost`), and the ssh program. */
export type SshTarget = { destination: string; ssh: string };

/**
 * The command that signs in to `cli` at `path`, where the host's wispd found it: run here, or
 * with `ssh -t` on an SSH host.
 * - Windows can't run an npm `.cmd` shim by itself, so one goes through `cmd.exe`.
 * - Over ssh, Codex's browser callback to localhost:1455 is forwarded back here, where the
 *   browser is, and Cursor is told not to open a browser on the host. Claude Code needs neither:
 *   with no browser, it asks for a code to paste. `-e none` turns off ssh's escape character,
 *   so what's typed only ever reaches the CLI.
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
  const forward = cli === "codex" ? ["-L", "1455:localhost:1455"] : [];
  const env = cli === "cursor" && path.startsWith("/") ? "NO_OPEN_BROWSER=1 " : "";
  // prettier-ignore
  return {
    file: ssh.ssh,
    args: [
      "-t", "-e", "none", "-o", "ControlPath=none", ...forward,
      "--", ssh.destination, `${env}${quote(path)} ${args.join(" ")}`,
    ],
  };
}

/** `path` as the host's shell reads it: bare if it can be, else quoted for cmd.exe or POSIX. */
function quote(path: string): string {
  if (/^[\w./\\:-]+$/.test(path)) return path;
  if (/^[a-z]:\\/i.test(path)) return `"${path}"`;
  return `'${path.replaceAll("'", `'\\''`)}'`;
}

/** A window's terminal. `pty` is unset while its command is still being found. */
type Session = { pty?: IPty };
const sessions = new Map<WebContents, Session>();
const watched = new WeakSet<WebContents>();

/**
 * Starts `sender`'s terminal once `command` says what to run, replacing any terminal it had.
 * Resolves to an error for people, or undefined once it runs. What it prints goes only to
 * `sender`, as `wisp:terminal` messages, and is never logged or kept.
 */
export async function openTerminal(
  sender: WebContents,
  command: () => Promise<Command | string>,
  cols: number,
  rows: number,
): Promise<string | undefined> {
  closeTerminal(sender);
  watch(sender);
  const session: Session = {};
  sessions.set(sender, session);
  const current = () => sessions.get(sender) === session;
  const send = (message: TerminalMessage) => {
    if (current() && !sender.isDestroyed()) sender.send("wisp:terminal", message);
  };

  try {
    // Loaded here, so a broken native module only breaks the terminal, not the app.
    const [found, { spawn }] = await Promise.all([command(), import("node-pty")]);
    if (!current()) return undefined; // Closed or replaced meanwhile.
    if (typeof found === "string") {
      sessions.delete(sender);
      return found;
    }
    const pty = spawn(found.file, found.args, {
      name: "xterm-256color",
      cols,
      rows,
      cwd: os.homedir(),
      env: process.env,
    });
    session.pty = pty;
    pty.onData((data) => send({ type: "data", data }));
    pty.onExit(({ exitCode }) => {
      send({ type: "exit", exitCode });
      if (current()) sessions.delete(sender);
    });
    return undefined;
  } catch (error) {
    if (current()) sessions.delete(sender);
    return `The sign-in couldn't start: ${(error as Error).message}`;
  }
}

export function writeTerminal(sender: WebContents, data: string): void {
  sessions.get(sender)?.pty?.write(data);
}

export function resizeTerminal(sender: WebContents, cols: number, rows: number): void {
  try {
    sessions.get(sender)?.pty?.resize(cols, rows);
  } catch {
    // It exited, and its exit is on the way.
  }
}

/** Ends `sender`'s terminal, killing what runs in it. */
export function closeTerminal(sender: WebContents): void {
  const pty = sessions.get(sender)?.pty;
  sessions.delete(sender);
  try {
    pty?.kill();
  } catch {
    // It already exited.
  }
}

export function closeAllTerminals(): void {
  for (const sender of sessions.keys()) closeTerminal(sender);
}

/** Closes a window's terminal when it reloads or closes, since nothing there can anymore. */
function watch(sender: WebContents): void {
  if (watched.has(sender)) return;
  watched.add(sender);
  const close = () => closeTerminal(sender);
  sender.on("did-navigate", close);
  sender.once("destroyed", close);
}
