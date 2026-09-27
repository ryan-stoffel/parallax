import { existsSync } from "node:fs";
import path from "node:path";

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
