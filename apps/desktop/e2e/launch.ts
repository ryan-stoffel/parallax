import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { _electron, type ElectronApplication, type Page } from "@playwright/test";

// The built app against a real wispd whose workers are the fake backend playing a script from
// this folder (RYA-16). WISPD_PATH defaults to the repo's debug build, which must have the fake
// backend: `cargo build -p wispd --features fake-backend`, then `pnpm build` and `pnpm e2e`.
// Never point it at an installed wispd: without the feature, serve refuses to start.

const desktop = path.join(import.meta.dirname, "..");
const wispd = process.env["WISPD_PATH"] ?? path.join(desktop, "../../target/debug/wispd");

/** A launched app, and the folder its wispd keeps its data and log in. */
export interface Launched {
  app: ElectronApplication;
  page: Page;
  dataDir: string;
}

/**
 * Launches the app with a wispd of its own, whose workers play `script`, a fake backend script in
 * this folder. `bin`, when given, goes first on PATH.
 */
export async function launch(script: string, bin?: string): Promise<Launched> {
  if (!existsSync(wispd)) throw new Error(`no wispd at ${wispd}; see the top of launch.ts`);
  const dataDir = mkdtempSync(path.join(tmpdir(), "wisp-e2e-"));
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    WISP_NO_NAMER: "1",
    WISPD_PATH: wispd,
    WISPD_DATA_DIR: dataDir,
    WISPD_FAKE_BACKEND: path.join(import.meta.dirname, script),
  };
  if (bin) {
    // Windows spells it Path, and a second PATH key would leave which one wins to chance.
    const pathKey = Object.keys(env).find((key) => key.toUpperCase() === "PATH") ?? "PATH";
    env[pathKey] = `${bin}${path.delimiter}${env[pathKey] ?? ""}`;
  }
  // As in scripts/ci/launch-app: these would run Electron as Node, or load the dev server.
  delete env["ELECTRON_RUN_AS_NODE"];
  delete env["WISP_DEV_SERVER_URL"];
  // Unset variables are undefined in `process.env`, and launch skips them.
  // Its own userData too, so a local run never shares the developer's app profile or hosts.
  const userData = `--user-data-dir=${mkdtempSync(path.join(tmpdir(), "wisp-e2e-app-"))}`;
  const app = await _electron.launch({
    args: [desktop, userData],
    env: env as Record<string, string>,
  });
  return { app, page: await app.firstWindow(), dataDir };
}

/**
 * The pid of each `serve` that `wispd attach` started, oldest first. They come from the log, since
 * Windows won't read wispd.lock while serve holds it locked.
 */
export function servePids(dataDir: string): number[] {
  const log = path.join(dataDir, "logs/wispd.log");
  const text = existsSync(log) ? readFileSync(log, "utf8") : "";
  return [...text.matchAll(/listening.* pid=(\d+)/g)].map((m) => Number.parseInt(m[1]!, 10));
}

/** After a test that failed: wispd's log and the window's text. */
export async function printFailure({ page, dataDir }: Launched) {
  const log = path.join(dataDir, "logs/wispd.log");
  if (existsSync(log)) console.log(`--- ${log}\n${readFileSync(log, "utf8")}`);
  console.log(`--- the window's text\n${await page.locator("body").innerText()}`);
}

/** Closes the app, and the detached `serve` that `wispd attach` started, which outlives it. */
export async function close(launched: Launched | undefined) {
  if (!launched) return;
  await launched.app.close();
  const pid = servePids(launched.dataDir).at(-1) ?? 0;
  // Never pid 0 or below, which process.kill reads as a whole process group.
  if (Number.isSafeInteger(pid) && pid > 1) process.kill(pid, "SIGTERM");
}
