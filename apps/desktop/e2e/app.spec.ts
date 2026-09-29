import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { _electron, expect, test, type ElectronApplication, type Page } from "@playwright/test";

// The built app against a real wispd whose workers are the fake backend playing agent.json
// (RYA-16). WISPD_PATH defaults to the repo's debug build, which must have the fake backend:
// `cargo build -p wispd --features fake-backend`, then `pnpm build` and `pnpm e2e`.
// Never point it at an installed wispd: without the feature, serve refuses to start.

const desktop = path.join(import.meta.dirname, "..");
const wispd = process.env["WISPD_PATH"] ?? path.join(desktop, "../../target/debug/wispd");

test.describe.configure({ mode: "serial" });

let app: ElectronApplication;
let page: Page;
let dataDir: string;

test.beforeAll(async () => {
  if (!existsSync(wispd)) throw new Error(`no wispd at ${wispd}; see the top of app.spec.ts`);
  dataDir = mkdtempSync(path.join(tmpdir(), "wisp-e2e-"));
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    WISPD_PATH: wispd,
    WISPD_DATA_DIR: dataDir,
    WISPD_FAKE_BACKEND: path.join(import.meta.dirname, "agent.json"),
  };
  // Windows spells it Path, and a second PATH key would leave which one wins to chance.
  const pathKey = Object.keys(env).find((key) => key.toUpperCase() === "PATH") ?? "PATH";
  env[pathKey] = `${fakeCodex()}${path.delimiter}${env[pathKey] ?? ""}`;
  // As in scripts/ci/launch-app: these would run Electron as Node, or load the dev server.
  delete env["ELECTRON_RUN_AS_NODE"];
  delete env["WISP_DEV_SERVER_URL"];
  // Unset variables are undefined in `process.env`, and launch skips them.
  // Its own userData too, so a local run never shares the developer's app profile or hosts.
  const userData = `--user-data-dir=${mkdtempSync(path.join(tmpdir(), "wisp-e2e-app-"))}`;
  app = await _electron.launch({ args: [desktop, userData], env: env as Record<string, string> });
  page = await app.firstWindow();
});

/**
 * A fake Codex, for the sign-in test: signed out until `codex login` has read a line. Returns its
 * folder, which goes first on PATH, so wispd finds it before any real Codex.
 */
function fakeCodex(): string {
  const bin = mkdtempSync(path.join(tmpdir(), "wisp-e2e-bin-"));
  const marker = path.join(bin, "signed-in");
  if (process.platform === "win32") {
    const script = [
      "@echo off",
      `if "%~1 %~2"=="login status" (if exist "${marker}" (exit /b 0) else (exit /b 1))`,
      `if "%~1"=="login" (echo Fake Codex sign-in. Press Enter.& set /p line=& type nul > "${marker}"& exit /b 0)`,
      "exit /b 2",
    ];
    writeFileSync(path.join(bin, "codex.cmd"), script.join("\r\n"));
  } else {
    const script = [
      "#!/bin/sh",
      'case "$*" in',
      `  "login status") test -f '${marker}' ;;`,
      `  login) echo "Fake Codex sign-in. Press Enter."; read -r _; touch '${marker}' ;;`,
      "  *) exit 2 ;;",
      "esac",
    ];
    writeFileSync(path.join(bin, "codex"), script.join("\n"), { mode: 0o755 });
  }
  return bin;
}

test.afterEach(async () => {
  const { status, expectedStatus } = test.info();
  if (status === expectedStatus) return;
  const log = path.join(dataDir, "logs/wispd.log");
  if (existsSync(log)) console.log(`--- ${log}\n${readFileSync(log, "utf8")}`);
  console.log(`--- the window's text\n${await page.locator("body").innerText()}`);
});

test.afterAll(async () => {
  await app?.close();
  // `wispd attach` started a detached `serve`, which outlives the app. Its pid comes from the log,
  // since Windows won't read wispd.lock while serve holds it locked.
  const log = path.join(dataDir, "logs/wispd.log");
  const listening = existsSync(log)
    ? /listening.* pid=(\d+)/.exec(readFileSync(log, "utf8"))
    : null;
  const pid = Number.parseInt(listening?.[1] ?? "", 10);
  // Never pid 0 or below, which process.kill reads as a whole process group.
  if (Number.isSafeInteger(pid) && pid > 1) process.kill(pid, "SIGTERM");
});

test("connects to wispd", async () => {
  await expect(page.getByRole("status").filter({ hasText: "Connected · wispd" })).toBeVisible();
});

test("starts a thread and shows the agent's output", async () => {
  // A fresh host has no default account for threads, and the fake's is `fake`. The app only
  // offers signed-in vendor CLIs, which wispd finds by running them, so set it directly.
  const set = await page.evaluate(`window.wisp.request("local", "accounts/defaults/set", {
    role: "worker",
    account: { kind: "subscription", backend: "fake" },
  })`);
  expect(set).not.toHaveProperty("error");

  await page.getByRole("textbox", { name: "Message" }).fill("Tidy up the README");
  await page.getByRole("button", { name: "Send" }).click();

  const transcript = page.getByRole("log", { name: "Transcript" });
  await expect(transcript.getByText("Tidy up the README")).toBeVisible();
  await expect(transcript.getByText("The fake agent is on it.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Stop" })).toBeVisible();
});

test("stops the thread", async () => {
  await page.getByRole("button", { name: "Stop" }).click();
  await expect(page.getByRole("log", { name: "Transcript" }).getByText("Stopped")).toBeVisible();
  await expect(page.getByRole("button", { name: "Send" })).toBeVisible();
});

test("a follow-up's text is still there after a reload (RYA-92)", async () => {
  await page.getByRole("textbox", { name: "Message" }).fill("Check the links too");
  await page.getByRole("button", { name: "Send" }).click();
  // The resumed fake answers again, after wispd logged the follow-up's turnStarted.
  const said = page.getByRole("log", { name: "Transcript" }).getByText("The fake agent is on it.");
  await expect(said).toHaveCount(2);

  await page.reload();
  await page.getByRole("button", { name: /Tidy up the README/ }).click();
  const transcript = page.getByRole("log", { name: "Transcript" });
  await expect(transcript.getByText("Check the links too")).toBeVisible();
  await expect(transcript.getByText("Follow-up message")).toHaveCount(0);
});

test("signs in to a CLI in a host terminal, then shows it signed in (RYA-35)", async () => {
  await page.getByRole("button", { name: "Settings" }).click();
  await page.getByRole("button", { name: "Providers" }).click();
  await page.getByRole("button", { name: "Sign in to Codex" }).click();

  const terminal = page.getByRole("group", { name: "Codex sign-in terminal" });
  await expect(terminal).toContainText("Fake Codex sign-in. Press Enter.");
  await terminal.click();
  await page.keyboard.press("Enter");
  await expect(page.getByText("Codex sign-in ended.")).toBeVisible();
  // The sign-in's end ran accounts/refresh, which found the fake signed in.
  const host = page.getByRole("region", { name: /^This (Mac|computer)$/ });
  await expect(host.locator("div").filter({ hasText: /^CodexInstalledSigned in$/ })).toBeVisible();
});
