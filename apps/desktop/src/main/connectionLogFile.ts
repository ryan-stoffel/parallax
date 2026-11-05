import { appendFileSync, mkdirSync, renameSync, rmSync, statSync } from "node:fs";
import path from "node:path";

// The desktop's connection log, `connection.log` in the user data folder's `logs`
// (`~/.parallax/desktop/logs/` unless `--user-data-dir` moves it), whose lines
// `protocol/connectionLog.ts` documents. Past 1 MiB it moves to `connection.log.1`, and the older
// one to `.2`. Logging never gets in a connection's way, so a failed write is dropped.

const MAX_BYTES = 1024 * 1024;
const KEPT = 2;

let file: string | undefined;

/** Starts writing to `dir`. Until this runs, as in tests, lines go nowhere. */
export function startConnectionLog(dir: string): void {
  mkdirSync(dir, { recursive: true });
  file = path.join(dir, "connection.log");
}

/** Appends `line`, first rotating a full file. */
export function writeConnectionLine(line: string): void {
  if (!file) return;
  try {
    if (size(file) >= MAX_BYTES) rotate(file);
    appendFileSync(file, `${line}\n`, { mode: 0o600 });
  } catch {
    // See above.
  }
}

const size = (at: string) => statSync(at, { throwIfNoEntry: false })?.size ?? 0;

function rotate(at: string): void {
  rmSync(`${at}.${KEPT}`, { force: true });
  for (let n = KEPT - 1; n >= 1; n--) {
    if (size(`${at}.${n}`) > 0) renameSync(`${at}.${n}`, `${at}.${n + 1}`);
  }
  renameSync(at, `${at}.1`);
}
