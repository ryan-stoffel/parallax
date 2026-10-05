import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { promisify } from "node:util";

export type PlxdLookup = {
  env: NodeJS.ProcessEnv;
  platform: NodeJS.Platform;
  /** `app.isPackaged`. */
  packaged: boolean;
  /** `process.resourcesPath`, where a packaged app bundles plxd (PLX-66). */
  resourcesPath: string;
  /** `app.getAppPath()`: `apps/desktop` in development. */
  appPath: string;
  exists?: (file: string) => boolean;
};

/**
 * Where the local `plxd` is, or undefined if it can't be found. In order:
 * 1. `PLXD_PATH`, the path setting. When set, it is the only candidate.
 * 2. The bundled binary in a packaged app, or the repo's Cargo debug build in development.
 * 3. `PATH`.
 */
export function findPlxd(lookup: PlxdLookup): string | undefined {
  const exists = lookup.exists ?? existsSync;
  const name = lookup.platform === "win32" ? "plxd.exe" : "plxd";
  const override = lookup.env["PLXD_PATH"];
  if (override) return exists(override) ? override : undefined;

  const builtIn = lookup.packaged
    ? path.join(lookup.resourcesPath, name)
    : path.join(lookup.appPath, "../../target/debug", name);
  if (exists(builtIn)) return builtIn;

  // ponytail: a Finder-launched macOS app gets launchd's short PATH, so this finds only system
  // folders there. Add a login-shell PATH probe if users hit it before packaging bundles plxd.
  const dirs = (lookup.env["PATH"] ?? "").split(path.delimiter).filter(Boolean);
  return dirs.map((dir) => path.join(dir, name)).find(exists);
}

/** Where versions before `~/.parallax` kept plxd's data folder. */
function legacyDataDir(env: NodeJS.ProcessEnv, platform: NodeJS.Platform, home: string): string {
  if (platform === "darwin") return path.join(home, "Library/Application Support/parallax");
  if (platform === "win32")
    return path.join(env["LOCALAPPDATA"] ?? path.join(home, "AppData", "Local"), "parallax");
  const xdg = env["XDG_DATA_HOME"];
  return path.join(xdg && path.isAbsolute(xdg) ? xdg : path.join(home, ".local/share"), "parallax");
}

/**
 * plxd's data folder, as `DataDir::default_location` finds it (daemon/src/paths.rs):
 * `PLXD_DATA_DIR`, else `~/.parallax`, unless that doesn't exist and the older OS folder does
 * (`~/Library/Application Support/parallax`, `%LOCALAPPDATA%\parallax`, or
 * `$XDG_DATA_HOME/parallax`), which keeps working because the store holds absolute worktree paths.
 */
export function dataDir(
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
  home: string,
  exists: (dir: string) => boolean = existsSync,
): string {
  const override = env["PLXD_DATA_DIR"];
  if (override) return override;
  const current = path.join(home, ".parallax");
  const legacy = legacyDataDir(env, platform, home);
  return !exists(current) && exists(legacy) ? legacy : current;
}

/**
 * The app's own data (Electron's userData): `~/.parallax/desktop`, unless that doesn't exist and
 * `legacy`, where Electron kept it before, does.
 */
export function appDataDir(
  home: string,
  legacy: string,
  exists: (dir: string) => boolean = existsSync,
): string {
  const current = path.join(home, ".parallax", "desktop");
  return !exists(current) && exists(legacy) ? legacy : current;
}

/** What `<plxd> --version` reports ("plxd 1.2.3" → "1.2.3"), or undefined if it can't run. */
export async function plxdVersion(plxd: string): Promise<string | undefined> {
  try {
    const { stdout } = await promisify(execFile)(plxd, ["--version"], { timeout: 10_000 });
    return stdout.trim().split(/\s+/).at(-1);
  } catch {
    return undefined;
  }
}

/** What `replaceServe` needs from the system. Tests pass fakes. */
export type ServeSystem = {
  /** The pid in `dir`'s `plxd.lock`. Throws when there's none. */
  lockPid: (dir: string) => number;
  /** The process's command line, as `ps -o args=` prints it. Rejects when it isn't running. */
  args: (pid: number) => Promise<string>;
  /** `process.kill`: SIGTERM by default; signal 0 throws once the process is gone. */
  kill: (pid: number, signal?: 0) => void;
  sleep: (ms: number) => Promise<void>;
};

const processes: ServeSystem = {
  lockPid: (dir) => Number.parseInt(readFileSync(path.join(dir, "plxd.lock"), "utf8")),
  args: async (pid) =>
    (await promisify(execFile)("ps", ["-o", "args=", "-p", String(pid)])).stdout.trim(),
  kill: (pid, signal) => process.kill(pid, signal),
  sleep: (ms) => sleep(ms),
};

/**
 * Whether a serve's command line is a packaged Parallax app's bundled plxd, the path `findPlxd`
 * returns there: `….app/Contents/Resources/plxd serve` on macOS, `…/resources/plxd serve` in
 * an AppImage's mount. A Cargo build or a plxd on PATH is someone else's.
 */
export const isBundledServe = (args: string) =>
  /(\.app\/Contents\/Resources|\/resources)\/plxd serve(\s|$)/.test(args);

/**
 * After an update, stops the `plxd serve` holding `dir`'s lock when its version (`running`)
 * differs from the app's bundled plxd's (`bundled`, undefined when unknown) and a packaged Parallax
 * app started it (`isBundledServe`), then waits up to 10 s for it to exit. SIGTERM lets serve shut
 * down cleanly, but it ends agent runs in flight. Every other serve is left alone; a real protocol
 * mismatch with one still shows as the connection's error. macOS and Linux only (`ps`). `why` is
 * for the log.
 */
export async function replaceServe(
  dir: string,
  running: string,
  bundled: string | undefined,
  system = processes,
): Promise<{ stopped: boolean; why: string }> {
  const keep = (why: string) => ({ stopped: false, why: `kept plxd serve ${running}: ${why}` });
  if (bundled === undefined) return keep("the bundled plxd's version is unknown");
  if (bundled === running) return keep("it is the bundled version");
  let pid: number;
  let args: string;
  try {
    pid = system.lockPid(dir);
    // A crashed serve leaves its pid behind, which another process may have by now.
    args = await system.args(pid);
  } catch {
    return keep("it isn't running");
  }
  if (!isBundledServe(args)) return keep(`no packaged Parallax started it (${args})`);
  try {
    system.kill(pid);
  } catch {
    return keep("it already exited");
  }
  for (let waited = 0; waited < 10_000; waited += 100) {
    try {
      system.kill(pid, 0);
    } catch {
      break; // Gone.
    }
    await system.sleep(100);
  }
  return { stopped: true, why: `stopped plxd serve ${running} for the bundled ${bundled}` };
}
