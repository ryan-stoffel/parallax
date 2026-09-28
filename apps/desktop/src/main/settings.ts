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
};

/**
 * Reads the settings. A missing file is empty settings, and a host that doesn't pass `checkHost`
 * is dropped. Throws when the file can't be read or isn't JSON, so a save never overwrites it.
 */
export function readSettings(file: string): Settings {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { hosts: [] };
    throw error;
  }
  const raw = JSON.parse(text) as { hosts?: unknown; ssh?: unknown } | null;
  const hosts = (Array.isArray(raw?.hosts) ? raw.hosts : []).flatMap((entry: unknown) => {
    const { id, name, destination } = (entry ?? {}) as Record<string, unknown>;
    if (typeof id !== "string" || !id || id === "local") return [];
    if (typeof name !== "string" || typeof destination !== "string") return [];
    const checked = checkHost({ name, destination });
    return typeof checked === "string" ? [] : [{ id, ...checked }];
  });
  return { hosts, ...(typeof raw?.ssh === "string" && raw.ssh && { ssh: raw.ssh }) };
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
 * whitespace or control characters (0007).
 */
export function checkHost({ name, destination }: HostInput): HostInput | string {
  const trimmed = destination.trim();
  if (!trimmed) return "Enter an ssh destination, such as mac-mini or me@192.168.1.20.";
  if (trimmed.startsWith("-") || /[\s\p{Cc}]/u.test(trimmed)) {
    return "An ssh destination can't start with “-” or contain spaces.";
  }
  const label = name.replace(/\p{Cc}/gu, "").trim();
  return { name: label || trimmed, destination: trimmed };
}
