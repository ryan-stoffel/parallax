import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { _electron, type ElectronApplication, type Page } from "@playwright/test";

// The built app against a real plxd whose workers are the fake backend playing a script from
// this folder (PLX-16). PLXD_PATH defaults to the repo's debug build, which must have the fake
// backend: `cargo build -p plxd --features fake-backend`, then `pnpm build` and `pnpm e2e`.
// Never point it at an installed plxd: without the feature, serve refuses to start.

const desktop = path.join(import.meta.dirname, "..");
const plxd = process.env["PLXD_PATH"] ?? path.join(desktop, "../../target/debug/plxd");

/** A launched app, and the folder its plxd keeps its data and log in. */
export interface Launched {
  app: ElectronApplication;
  page: Page;
  dataDir: string;
}

/**
 * Launches the app with a plxd of its own, whose workers play `script`, a fake backend script in
 * this folder or at an absolute path. `bin`, when given, goes first on PATH. `recordVideo`, when
 * given, records the window as Playwright's option of that name does.
 */
export async function launch(
  script: string,
  bin?: string,
  recordVideo?: { dir: string; size?: { width: number; height: number } },
): Promise<Launched> {
  if (!existsSync(plxd)) throw new Error(`no plxd at ${plxd}; see the top of launch.ts`);
  const dataDir = mkdtempSync(path.join(tmpdir(), "parallax-e2e-"));
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PLX_NO_NAMER: "1",
    PLXD_PATH: plxd,
    PLXD_DATA_DIR: dataDir,
    PLXD_FAKE_BACKEND: path.resolve(import.meta.dirname, script),
  };
  if (bin) {
    // Windows spells it Path, and a second PATH key would leave which one wins to chance.
    const pathKey = Object.keys(env).find((key) => key.toUpperCase() === "PATH") ?? "PATH";
    env[pathKey] = `${bin}${path.delimiter}${env[pathKey] ?? ""}`;
  }
  // As in scripts/ci/launch-app: these would run Electron as Node, or load the dev server.
  delete env["ELECTRON_RUN_AS_NODE"];
  delete env["PLX_DEV_SERVER_URL"];
  // Unset variables are undefined in `process.env`, and launch skips them.
  // Its own userData too, so a local run never shares the developer's app profile or hosts.
  const userData = `--user-data-dir=${mkdtempSync(path.join(tmpdir(), "parallax-e2e-app-"))}`;
  const app = await _electron.launch({
    args: [desktop, userData],
    env: env as Record<string, string>,
    ...(recordVideo && { recordVideo }),
  });
  return { app, page: await app.firstWindow(), dataDir };
}

/**
 * The pid of each `serve` that `plxd attach` started, oldest first. They come from the log, since
 * Windows won't read plxd.lock while serve holds it locked.
 */
export function servePids(dataDir: string): number[] {
  const log = path.join(dataDir, "logs/plxd.log");
  const text = existsSync(log) ? readFileSync(log, "utf8") : "";
  return [...text.matchAll(/listening.* pid=(\d+)/g)].map((m) => Number.parseInt(m[1]!, 10));
}

/** After a test that failed: plxd's log and the window's text. */
export async function printFailure({ page, dataDir }: Launched) {
  const log = path.join(dataDir, "logs/plxd.log");
  if (existsSync(log)) console.log(`--- ${log}\n${readFileSync(log, "utf8")}`);
  console.log(`--- the window's text\n${await page.locator("body").innerText()}`);
}

/** Closes the app, and the detached `serve` that `plxd attach` started, which outlives it. */
export async function close(launched: Launched | undefined) {
  if (!launched) return;
  await launched.app.close();
  const pid = servePids(launched.dataDir).at(-1) ?? 0;
  // Never pid 0 or below, which process.kill reads as a whole process group.
  if (Number.isSafeInteger(pid) && pid > 1) process.kill(pid, "SIGTERM");
}
