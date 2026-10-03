import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";

import type { HostInput, SshHost } from "../preload/bridge";

/** `settings.json` in the app's userData folder. Only the main process reads or writes it (0022). */
export type Settings = {
  hosts: SshHost[];
  /**
   * The ssh program, if not `ssh` on PATH (0023). Set by hand in the file: the renderer can't
   * write it, so it can't choose which program the app runs.
   */
  ssh?: string;
  /** This computer's name in Parallax, when the user renamed it. */
  localName?: string;
};

/**
 * Reads the settings. A missing file is empty settings. Throws when the file can't be read, isn't
 * JSON, or holds anything this can't use as is, such as a host that fails `checkHost`, so a save
 * never overwrites what the user wrote. Keys it doesn't know are kept, and saved back.
 */
export function readSettings(file: string): Settings {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { hosts: [] };
    throw error;
  }
  const raw = JSON.parse(text) as unknown;
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error("it isn't a JSON object");
  }
  const { hosts = [], ssh, localName } = raw as Record<string, unknown>;
  if (!Array.isArray(hosts)) throw new Error("`hosts` isn't a list");
  if (ssh !== undefined && typeof ssh !== "string") throw new Error("`ssh` isn't a string");
  if (localName !== undefined && typeof localName !== "string")
    throw new Error("`localName` isn't a string");
  const ids = new Set(["local"]);
  for (const entry of hosts as unknown[]) {
    const { id, name, destination } = (entry ?? {}) as Record<string, unknown>;
    const where = `host ${JSON.stringify(entry)}`;
    if (typeof id !== "string" || !id || ids.has(id)) throw new Error(`${where} has a bad id`);
    ids.add(id);
    if (typeof name !== "string" || typeof destination !== "string") {
      throw new Error(`${where} needs a name and a destination`);
    }
    const checked = checkHost({ name, destination });
    if (typeof checked === "string") throw new Error(`${where}: ${checked}`);
    if (checked.destination !== destination) throw new Error(`${where} has spaces around it`);
  }
  return { ...raw, hosts } as Settings;
}

/** Writes the settings whole, through a temporary file, so a crash never leaves half a file. */
export function writeSettings(file: string, settings: Settings): void {
  mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(settings, null, 2)}\n`);
  renameSync(temporary, file);
}

/**
 * Checks a host as the user typed it. Resolves to it trimmed, with the destination as the name
 * when there's none, or to an error for people. A destination may not start with `-` or contain
 * whitespace or control characters (0007), or the shell metacharacters OpenSSH 9.6 refuses in a
 * user or host name (CVE-2023-51385), since a `%h` or `%r` in the user's ssh config could reach
 * a shell.
 */
export function checkHost({ name, destination }: HostInput): HostInput | string {
  const trimmed = destination.trim();
  if (!trimmed) return "Enter an ssh destination, such as mac-mini or me@192.168.1.20.";
  if (trimmed.startsWith("-") || /[\s\p{Cc}'`"$\\;&<>|(){}]/u.test(trimmed)) {
    return "An ssh destination can't start with “-”, or contain spaces, quotes, or characters such as $ ; & | < > ( ) { } \\.";
  }
  const label = name.replace(/\p{Cc}/gu, "").trim();
  return { name: label || trimmed, destination: trimmed };
}
