// @ts-check
// Replaces a secret's file in one step, for relay-probe.mjs's rotated token (PLX-1452).
import { randomBytes } from "node:crypto";
import { renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";

/**
 * Writes `text` to a new 0600 file beside `file`, then renames it over `file`. A crash leaves the
 * old file or the new one, never an empty or half-written one.
 * @param {string} file
 * @param {string} text
 */
export function replacePrivately(file, text) {
  const temporary = join(dirname(file), `.${basename(file)}.${randomBytes(6).toString("hex")}`);
  try {
    writeFileSync(temporary, text, { mode: 0o600, flag: "wx" });
    renameSync(temporary, file);
  } catch (error) {
    rmSync(temporary, { force: true });
    throw error;
  }
}
