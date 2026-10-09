import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";

import { _electron, expect, test, type ElectronApplication, type Page } from "@playwright/test";

import { stopServe } from "./launch";

// The web client (PLX-651): plxd serves the renderer build over HTTPS on its remote listener, and
// a browser pairs with the code the host shows. The browser is Electron's Chromium (browser.cjs),
// trusting plxd's self-signed certificate as a user who accepted it would.

const desktop = path.join(import.meta.dirname, "..");
const plxd = process.env["PLXD_PATH"] ?? path.join(desktop, "../../target/debug/plxd");
const url = "https://127.0.0.1:7341/";

test.describe.configure({ mode: "serial" });

let dataDir: string;
let attach: ChildProcessWithoutNullStreams;
let call: (method: string, params: object) => Promise<Record<string, unknown>>;
let browser: ElectronApplication;
let page: Page;

test.beforeAll(async () => {
  dataDir = mkdtempSync(path.join(tmpdir(), "parallax-e2e-web-"));
  attach = spawn(plxd, ["attach"], {
    env: {
      ...process.env,
      PLXD_DATA_DIR: dataDir,
      PLXD_FAKE_BACKEND: path.join(import.meta.dirname, "web.json"),
      PLXD_WEB_DIR: path.join(desktop, "dist/renderer"),
    },
  });
  const waiting = new Map<number, (message: Record<string, unknown>) => void>();
  createInterface({ input: attach.stdout }).on("line", (line) => {
    const message = JSON.parse(line) as { id?: number };
    if (message.id !== undefined) waiting.get(message.id)?.(message);
  });
  let id = 0;
  call = (method, params) =>
    new Promise((resolve) => {
      waiting.set(++id, resolve);
      attach.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });
  const protocol = { min: 1, max: 1 };
  await call("initialize", { protocol, client: { name: "e2e", version: "0" }, capabilities: {} });
  await call("host/settings/set", { remote: true, remoteWeb: true });
  await call("accounts/defaults/set", {
    role: "worker",
    account: { kind: "subscription", backend: "fake" },
  });
  await expect
    .poll(async () => (await call("remote/sessions", {}))["result"])
    .toMatchObject({ listening: true });
  const env: NodeJS.ProcessEnv = { ...process.env, PLX_WEB_URL: url };
  delete env["ELECTRON_RUN_AS_NODE"]; // As launch.ts does: it would run Electron as Node.
  browser = await _electron.launch({
    args: [
      path.join(import.meta.dirname, "browser.cjs"),
      "--ignore-certificate-errors",
      `--user-data-dir=${mkdtempSync(path.join(tmpdir(), "parallax-e2e-browser-"))}`,
    ],
    env: env as Record<string, string>,
  });
  page = await browser.firstWindow();
});

test.afterAll(async () => {
  await browser?.close();
  attach?.kill();
  await stopServe(dataDir);
});

test("a browser that hasn't paired gets nothing but the pairing screen", async () => {
  await expect(page.getByRole("heading", { name: "Pair this browser" })).toBeVisible();
  const refused = await page.evaluate(async () => {
    const ticket = await fetch("/api/auth/websocket-ticket", { method: "POST" });
    const socket = await new Promise((resolve) => {
      const ws = new WebSocket("wss://127.0.0.1:7341/ws?wsTicket=guess");
      ws.onopen = () => resolve("open");
      ws.onerror = () => resolve("refused");
    });
    return { ticket: ticket.status, socket };
  });
  expect(refused).toEqual({ ticket: 401, socket: "refused" });
  const code = page.getByRole("textbox", { name: "Code" });
  await code.fill("AAA-AAA");
  await page.getByRole("button", { name: "Pair" }).click();
  await expect(page.getByRole("alert")).toHaveText(/wrong, used, or expired/);
  await page.screenshot({ path: test.info().outputPath("web-refused.png") });
});

test("a paired browser lists threads, opens one, and sends a message", async () => {
  const { result } = (await call("remote/pair", {})) as { result: { code: string } };
  await page.getByRole("textbox", { name: "Code" }).fill(result.code);
  await page.screenshot({ path: test.info().outputPath("web-pairing.png") });
  await page.getByRole("button", { name: "Pair" }).click();
  // The page reloads into the app.
  const state = `window.parallax?.connectionState("local").then((s) => s.status)`;
  await expect.poll(() => page.evaluate(state).catch(() => "reloading")).toBe("connected");
  // Two threads, started from the browser.
  const box = page.getByRole("textbox", { name: "Message", exact: true });
  for (const prompt of ["Add a README", "Fix the flaky test"]) {
    await page.getByRole("button", { name: "New thread", exact: true }).first().click();
    await box.fill(prompt);
    await box.press("Enter");
    await expect(page.getByText("The fake agent is on it.")).toBeVisible();
  }
  const thread = (title: string) =>
    page.getByRole("navigation").getByRole("button", { name: new RegExp(title) });
  await expect(thread("Add a README")).toBeVisible();
  await expect(thread("Fix the flaky test")).toBeVisible();
  await page.screenshot({ path: test.info().outputPath("web-threads.png") });
  await thread("Add a README").click();
  const transcript = page.getByRole("log", { name: "Transcript" });
  await expect(transcript.getByText("Add a README", { exact: true })).toBeVisible();
  await box.fill("Mention the web client");
  await box.press("Enter");
  await expect(transcript.getByText("Mention the web client").first()).toBeVisible();
  await page.screenshot({ path: test.info().outputPath("web-sent.png") });
  const sessions = (await call("remote/sessions", {}))["result"] as { sessions: unknown[] };
  expect(sessions.sessions).toHaveLength(1);
  // Settings shows the switch that serves this page, on, and this browser among the paired.
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("button", { name: "Connections" }).click();
  await expect(page.getByRole("switch", { name: "Pair computers on this network" })).toBeChecked();
  await expect(page.getByRole("switch", { name: "Open in a browser" })).toBeChecked();
  await expect(page.getByText(/^Browser on /)).toBeVisible();
  await page.screenshot({
    path: test.info().outputPath("web-settings.png"),
    animations: "disabled",
  });
});
