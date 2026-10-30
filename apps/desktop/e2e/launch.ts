import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { expect, _electron, type ElectronApplication, type Page } from "@playwright/test";

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
 * given, records the window as Playwright's option of that name does. `dataDir`, when given, is
 * an earlier launch's, for plxd to start from its data again. plxd stops when the app exits
 * (PLX-990), unless `outliveApp`, for a test that reopens the app on a plxd still running: then it
 * stops when this test process exits, or at `close`. `settings`, when given, is the app's
 * settings.json to start from, such as hosts it already has.
 */
export async function launch(
  script: string,
  bin?: string,
  recordVideo?: { dir: string; size?: { width: number; height: number } },
  dataDir = mkdtempSync(path.join(tmpdir(), "parallax-e2e-")),
  outliveApp = false,
  settings?: object,
): Promise<Launched> {
  if (!existsSync(plxd)) throw new Error(`no plxd at ${plxd}; see the top of launch.ts`);
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PLXD_PATH: plxd,
    PLXD_DATA_DIR: dataDir,
    PLXD_FAKE_BACKEND: path.resolve(import.meta.dirname, script),
    PLX_SKIP_ONBOARDING: "1",
  };
  if (bin) {
    // Windows spells it Path, and a second PATH key would leave which one wins to chance.
    const pathKey = Object.keys(env).find((key) => key.toUpperCase() === "PATH") ?? "PATH";
    env[pathKey] = `${bin}${path.delimiter}${env[pathKey] ?? ""}`;
  }
  // As in scripts/ci/launch-app: these would run Electron as Node, or load the dev server.
  delete env["ELECTRON_RUN_AS_NODE"];
  delete env["PLX_DEV_SERVER_URL"];
  delete env["PLXD_EXIT_WITH"];
  if (outliveApp) env["PLXD_EXIT_WITH"] = String(process.pid);
  // Unset variables are undefined in `process.env`, and launch skips them.
  // Its own userData too, so a local run never shares the developer's app profile or hosts.
  const userDataDir = mkdtempSync(path.join(tmpdir(), "parallax-e2e-app-"));
  if (settings)
    writeFileSync(
      path.join(userDataDir, "settings.json"),
      JSON.stringify({ hosts: [], ...settings }),
    );
  const app = await _electron.launch({
    args: [desktop, `--user-data-dir=${userDataDir}`],
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

/**
 * Opens a thread from its sidebar row, found by its text. A working thread's row waits in the
 * Working drawer, folded until opened (0075), and it can finish between looking and clicking,
 * moving its row, so the pair is retried. The click lands at the row's left edge, since a short
 * row's hover actions cover its middle.
 */
export async function openThread(page: Page, text: RegExp) {
  const row = page.locator("#sidebar li[data-kind='thread'] > button").filter({ hasText: text });
  await expect(async () => {
    const working = page.locator("#sidebar details").filter({ hasText: /^Working/ });
    if ((await working.count()) && (await working.getAttribute("open")) === null)
      await working.locator("summary").click();
    await row.first().click({ position: { x: 8, y: 8 }, timeout: 2000 });
  }).toPass();
}

/** After a test that failed: plxd's log and the window's text. */
export async function printFailure({ page, dataDir }: Launched) {
  const log = path.join(dataDir, "logs/plxd.log");
  if (existsSync(log)) console.log(`--- ${log}\n${readFileSync(log, "utf8")}`);
  console.log(`--- the window's text\n${await page.locator("body").innerText()}`);
}

/** Closes the app, and stops the `serve` that `plxd attach` started. */
export async function close(launched: Launched | undefined) {
  if (!launched) return;
  await launched.app.close();
  await stopServe(launched.dataDir);
}

/** Stops the `serve` that `plxd attach` started for `dataDir`, and waits until it exits. */
export async function stopServe(dataDir: string) {
  const pid = servePids(dataDir).at(-1) ?? 0;
  // Never pid 0 or below, which process.kill reads as a whole process group.
  if (Number.isSafeInteger(pid) && pid > 1) {
    // A dev or test serve stops by itself once its app has exited (PLX-990), so it may be gone.
    try {
      process.kill(pid, "SIGTERM");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
    }
    // Seeding or reopening this data directory must wait until SQLite has closed on Windows.
    await expect.poll(() => alive(pid)).toBe(false);
    // Windows reports the process gone before it has unmapped plxd.sqlite3-shm, and opening the
    // database in that window fails with SQLITE_IOERR_TRUNCATE (PLX-683). Wait until a read works.
    const file = path.join(dataDir, "plxd.sqlite3");
    await expect.poll(() => !existsSync(file) || readable(file)).toBe(true);
  }
}

/** Whether process `pid` is still running, or is a zombie not yet reaped. */
export function alive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
    throw error;
  }
}

/** Whether `file`'s database opens and reads, through its WAL. */
function readable(file: string) {
  try {
    const db = new DatabaseSync(file);
    try {
      db.prepare("SELECT COUNT(*) FROM sqlite_master").get();
    } finally {
      db.close();
    }
    return true;
  } catch {
    return false;
  }
}
