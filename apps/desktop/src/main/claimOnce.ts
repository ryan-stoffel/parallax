import { writeFileSync } from "node:fs";

/**
 * True the first time it's called for `file`, across restarts and every copy of the app sharing
 * it, and false after that. Creating the file is atomic, so only one caller ever gets true. False
 * too when the file can't be made, so a failure never repeats what the claim guards.
 */
export function claimOnce(file: string): boolean {
  try {
    writeFileSync(file, "", { flag: "wx" });
    return true;
  } catch {
    return false;
  }
}
