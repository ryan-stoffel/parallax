import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { expect, test, type Page } from "@playwright/test";

import { UPDATE_NOTICE_MS } from "../src/protocol/updateNotice";
import { uuidv7 } from "../src/renderer/uuidv7";
import { close, launch, openThread, plxd, printFailure, servePids, type Launched } from "./launch";

// A real `host/update` of a fake-backend plxd, from a local releases folder (PLX-1418): plxd tells
// its connections, installs, and restarts into the new binary, while the app stays open.
test.skip(process.platform === "win32", "swaps PLXD_PATH for /usr/bin/false");

const OLD = "2611.10000.10000-nightly";
const NEW = "2611.20000.10000-nightly";

let launched: Launched | undefined;
test.afterEach(async () => {
  const { status, expectedStatus } = test.info();
  if (launched && status !== expectedStatus) await printFailure(launched);
  await close(launched);
  delete process.env["PLXD_RELEASES_URL"];
  delete process.env["PLXD_SERVICE_LABEL"];
});

/**
 * A copy of plxd stamped `OLD`, where it can update itself, unlike a Cargo build. A release folder
 * with the same binary as `NEW`. No service has this label, so plxd starts the new `serve` itself
 * and the machine's real service isn't touched. A fake `tailscale` keeps it off the real tailnet.
 */
function setUp() {
  const dir = mkdtempSync(path.join(tmpdir(), "parallax-update-"));
  const program = path.join(dir, "plxd");
  copyFileSync(plxd, program);
  chmodSync(program, 0o755);
  writeFileSync(path.join(dir, "plxd.version"), `${OLD}\n`);

  const os = process.platform === "darwin" ? "mac" : "linux";
  const arch = process.arch === "arm64" ? "arm64" : "x64";
  const name = `parallax-plxd-${NEW}-${os}-${arch}`;
  const release = path.join(dir, "releases", `v${NEW}`);
  mkdirSync(release, { recursive: true });
  copyFileSync(plxd, path.join(release, name));
  const hash = createHash("sha256").update(readFileSync(plxd)).digest("hex");
  writeFileSync(path.join(release, `${name}.sha256`), `${hash}  ${name}\n`);
  process.env["PLXD_RELEASES_URL"] = pathToFileURL(path.join(dir, "releases")).href;
  process.env["PLXD_SERVICE_LABEL"] = `com.parallax.e2e.${path.basename(dir)}`;

  const bin = path.join(dir, "bin");
  mkdirSync(bin);
  writeFileSync(path.join(bin, "tailscale"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
  return { program, bin };
}

/**
 * Sends `host/update` from a client of its own, through `plxd attach`, as a client with no idea of
 * `host/updating` would. Resolves with every method plxd sent it once plxd closes on it.
 */
function updateFromAnotherClient(program: string, dataDir: string): Promise<string[]> {
  const attach = spawn(program, ["attach"], {
    env: { ...process.env, PLXD_DATA_DIR: dataDir },
    stdio: ["pipe", "pipe", "ignore"],
  });
  const send = (id: number, method: string, params: unknown) =>
    attach.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
  send(1, "initialize", {
    protocol: { min: 1, max: 1 },
    client: { name: "older", version: "0" },
    capabilities: {},
  });
  send(2, "host/update", { version: NEW, now: true });
  let text = "";
  attach.stdout.on("data", (chunk: Buffer) => (text += chunk.toString()));
  return new Promise((resolve) => {
    attach.on("close", () =>
      resolve(
        text
          .split("\n")
          .filter(Boolean)
          .map((line) => (JSON.parse(line) as { method?: string }).method ?? "answer"),
      ),
    );
  });
}

/** Opens a thread, and notes each frame's words about the connection in `seen`. */
async function openAndWatch(page: Page) {
  await expect.poll(() => connection(page)).toMatchObject({ status: "connected", plxd: OLD });
  const set = await page.evaluate(`window.parallax.request("local", "accounts/defaults/set", {
    role: "worker",
    account: { kind: "subscription", backend: "fake" },
  })`);
  expect(set).not.toHaveProperty("error");
  const prompt = "Keep going while plxd updates";
  const started = await page.evaluate(
    `window.parallax.request("local", "thread/start", ${JSON.stringify({ runId: uuidv7(), prompt })})`,
  );
  expect(started).not.toHaveProperty("error");
  await openThread(page, new RegExp(prompt));
  await expect(page.getByRole("log", { name: "Transcript" })).toContainText("on it");
  await page.evaluate(`(() => {
    const seen = new Set();
    globalThis.seen = seen;
    const words = ["Updating…", "plxd is restarting for an update…", "Reconnecting", "Disconnected", "Connecting", "Lost connection", "Reconnected"];
    const look = () => {
      const text = document.body.innerText;
      for (const word of words) if (text.includes(word)) seen.add(word);
      requestAnimationFrame(look);
    };
    look();
  })()`);
}

const seen = (page: Page) =>
  page.evaluate(() => [...(globalThis as unknown as { seen: Set<string> }).seen]);

/** The real connection state, as what loads and syncs reads it. */
const connection = (page: Page) =>
  page.evaluate(`window.parallax.connectionState("local")`) as Promise<{
    status: string;
    plxd?: string;
    updating?: boolean;
  }>;

test("a real update restart shows Updating, raises no notice, and comes back on the new plxd", async () => {
  const { program, bin } = setUp();
  launched = await launch("agent.json", bin, undefined, undefined, false, undefined, program);
  const { page, dataDir } = launched;
  await openAndWatch(page);
  const firstServe = servePids(dataDir).at(-1);

  const told = updateFromAnotherClient(program, dataDir);
  const status = page.getByRole("status").filter({ hasText: "Updating…" });
  await expect(status).toContainText("plxd is restarting for an update…", { timeout: 30_000 });
  // Only the display changed: the real state says it's down, and why.
  expect((await connection(page)).status).not.toBe("connected");
  expect((await connection(page)).updating).toBe(true);

  await expect.poll(() => connection(page)).toMatchObject({ status: "connected", plxd: NEW });
  await expect(status).toHaveCount(0);
  expect(servePids(dataDir).at(-1)).not.toBe(firstServe);
  expect(await seen(page)).toEqual(
    expect.arrayContaining(["Updating…", "plxd is restarting for an update…"]),
  );
  for (const word of ["Reconnecting", "Disconnected", "Connecting", "Lost connection"])
    expect(await seen(page)).not.toContain(word);

  // A client that doesn't know the notification got it, and its answer, and took no harm.
  expect(await told).toEqual(["answer", "answer", "host/updating"]);
});

test("a plxd not back within the notice shows the real state, and its notice", async () => {
  test.setTimeout(UPDATE_NOTICE_MS + 60_000);
  const { program, bin } = setUp();
  launched = await launch("agent.json", bin, undefined, undefined, false, undefined, program);
  const { app, page, dataDir } = launched;
  await openAndWatch(page);

  // `attach` fails each try, so to this app plxd never comes back.
  await app.evaluate(() => void (process.env["PLXD_PATH"] = "/usr/bin/false"));
  void updateFromAnotherClient(program, dataDir);
  const updating = page.getByRole("status").filter({ hasText: "Updating…" });
  await expect(updating).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText("Lost connection to")).toHaveCount(0);

  await expect(page.getByText("Lost connection to")).toBeVisible({
    timeout: UPDATE_NOTICE_MS + 5_000,
  });
  await expect(updating).toHaveCount(0);
  await expect(
    page.getByRole("status").filter({ hasText: /Reconnecting|Connecting/ }),
  ).toBeVisible();

  await app.evaluate((_, path) => void (process.env["PLXD_PATH"] = path), program);
  await expect(page.getByText("Reconnected to")).toBeVisible({ timeout: 20_000 });
});
