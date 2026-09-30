import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { promisify } from "node:util";

export type WispdLookup = {
  env: NodeJS.ProcessEnv;
  platform: NodeJS.Platform;
  /** `app.isPackaged`. */
  packaged: boolean;
  /** `process.resourcesPath`, where a packaged app bundles wispd (RYA-66). */
  resourcesPath: string;
  /** `app.getAppPath()`: `apps/desktop` in development. */
  appPath: string;
  exists?: (file: string) => boolean;
};

/**
 * Where the local `wispd` is, or undefined if it can't be found. In order:
 * 1. `WISPD_PATH`, the path setting. When set, it is the only candidate.
 * 2. The bundled binary in a packaged app, or the repo's Cargo debug build in development.
 * 3. `PATH`.
 */
export function findWispd(lookup: WispdLookup): string | undefined {
  const exists = lookup.exists ?? existsSync;
  const name = lookup.platform === "win32" ? "wispd.exe" : "wispd";
  const override = lookup.env["WISPD_PATH"];
  if (override) return exists(override) ? override : undefined;

  const builtIn = lookup.packaged
    ? path.join(lookup.resourcesPath, name)
    : path.join(lookup.appPath, "../../target/debug", name);
  if (exists(builtIn)) return builtIn;

  // ponytail: a Finder-launched macOS app gets launchd's short PATH, so this finds only system
  // folders there. Add a login-shell PATH probe if users hit it before packaging bundles wispd.
  const dirs = (lookup.env["PATH"] ?? "").split(path.delimiter).filter(Boolean);
  return dirs.map((dir) => path.join(dir, name)).find(exists);
}

/**
 * wispd's data folder on macOS and Linux, as `DataDir::default_location` finds it
 * (daemon/src/paths.rs): `WISPD_DATA_DIR`, else `~/Library/Application Support/wisp` on macOS, and
 * `$XDG_DATA_HOME/wisp` (when absolute) or `~/.local/share/wisp` on Linux.
 */
export function dataDir(env: NodeJS.ProcessEnv, platform: NodeJS.Platform, home: string): string {
  const override = env["WISPD_DATA_DIR"];
  if (override) return override;
  if (platform === "darwin") return path.join(home, "Library/Application Support/wisp");
  const xdg = env["XDG_DATA_HOME"];
  return path.join(xdg && path.isAbsolute(xdg) ? xdg : path.join(home, ".local/share"), "wisp");
}

/** What `<wispd> --version` reports ("wispd 1.2.3" → "1.2.3"), or undefined if it can't run. */
export async function wispdVersion(wispd: string): Promise<string | undefined> {
  try {
    const { stdout } = await promisify(execFile)(wispd, ["--version"], { timeout: 10_000 });
    return stdout.trim().split(/\s+/).at(-1);
  } catch {
    return undefined;
  }
}

/**
 * Stops the `wispd serve` that holds `wispd.lock` in `dir`, by the pid in it, as scripts/dev.mjs's
 * `stopWispd` does, and waits up to 10 s for it to exit. SIGTERM lets serve shut down cleanly,
 * but it ends agent runs in flight. macOS and Linux only (`ps`); does nothing when none runs.
 */
export async function stopServe(dir: string): Promise<void> {
  let pid: number;
  try {
    pid = Number.parseInt(readFileSync(path.join(dir, "wispd.lock"), "utf8"));
    // A crashed serve leaves its pid behind, which another process may have by now.
    const { stdout } = await promisify(execFile)("ps", ["-o", "args=", "-p", String(pid)]);
    if (!/wispd serve\b/.test(stdout)) return;
    process.kill(pid);
  } catch {
    return; // Not running.
  }
  for (let waited = 0; waited < 10_000; waited += 100) {
    try {
      process.kill(pid, 0);
    } catch {
      return; // Gone.
    }
    await sleep(100);
  }
}
