import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { createServer, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";

import { expect, test } from "@playwright/test";

import { close, launch, printFailure, stopServe, type Launched } from "./launch";

// An account computer (0091) as the desktop app reaches it: a second fake-backend plxd, "build-box",
// with Reach from anywhere on, saved as an `account:` host with its loopback route, as discovery
// would list it. It has no session there and nothing vouches for it, so the app asks for the code
// `plx connect` would show, here from `access/setupCode`, pairs with it through `plxd dial
// --account --pair`, and connects. Then an agent's install and a CLI sign-in run in build-box's
// own plxd terminals (PLX-1164). build-box's home has a fake npm and claude, so nothing installs.
// Its terminals run /bin/sh, which Windows lacks.
test.skip(process.platform === "win32", "build-box's terminals run /bin/sh");

const desktop = path.join(import.meta.dirname, "..");
const plxd = process.env["PLXD_PATH"] ?? path.join(desktop, "../../target/debug/plxd");

/** A port nothing listens on now, for build-box's remote listener. */
async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

let launched: Launched | undefined;
let boxData: string;
let attach: ChildProcessWithoutNullStreams | undefined;
test.afterEach(async () => {
  const { status, expectedStatus } = test.info();
  if (launched && status !== expectedStatus) await printFailure(launched);
  await close(launched);
  attach?.kill();
  if (boxData) await stopServe(boxData);
});

/** build-box's plxd, through `plxd attach`, with a home holding a fake npm and claude. */
async function startBuildBox(port: number) {
  boxData = mkdtempSync(path.join(tmpdir(), "parallax-e2e-box-"));
  const home = mkdtempSync(path.join(tmpdir(), "parallax-e2e-box-home-"));
  const bin = path.join(home, ".local", "bin");
  mkdirSync(bin, { recursive: true });
  // A login shell reads .profile, where npm is a function, so `npm install` only says so.
  writeFileSync(path.join(home, ".profile"), 'npm() { echo "build-box npm $*"; }\n');
  const claude = path.join(bin, "claude");
  writeFileSync(
    claude,
    '#!/bin/sh\n[ "$1" = --version ] && { echo "2.0.0 (Claude Code)"; exit 0; }\necho "build-box claude $*"\n',
  );
  chmodSync(claude, 0o755);
  attach = spawn(plxd, ["attach"], {
    env: {
      ...process.env,
      HOME: home,
      PATH: `${bin}${path.delimiter}${process.env["PATH"] ?? ""}`,
      PLXD_DATA_DIR: boxData,
      PLXD_FAKE_BACKEND: path.join(import.meta.dirname, "agent.json"),
      PLXD_REMOTE_PORT: String(port),
      PLXD_EXIT_WITH: String(process.pid),
    },
  });
  const waiting = new Map<number, (message: Record<string, unknown>) => void>();
  createInterface({ input: attach.stdout }).on("line", (line) => {
    const message = JSON.parse(line) as { id?: number };
    if (message.id !== undefined) waiting.get(message.id)?.(message);
  });
  let id = 0;
  const call = (method: string, params: object) =>
    new Promise<Record<string, unknown>>((resolve) => {
      waiting.set(++id, resolve);
      attach!.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });
  const result = async <T>(method: string, params: object) =>
    ((await call(method, params)) as { result: T }).result;
  const protocol = { min: 1, max: 1 };
  await call("initialize", { protocol, client: { name: "e2e", version: "0" }, capabilities: {} });
  await call("host/settings/set", { remote: true, deviceName: "build-box" });
  await expect
    .poll(async () => (await call("remote/sessions", {}))["result"])
    .toMatchObject({ listening: true });
  const { hostId } = await result<{ hostId: string }>("relay/id", {});
  return { hostId, result };
}

/** Runs terminal `target` in the app's window and answers what it printed, once it exits. */
const run = (launched: Launched, target: object) =>
  launched.page.evaluate(`new Promise((resolve) => {
    const id = "e2e-" + Math.random();
    let printed = "";
    window.parallax.onTerminal(id, (message) => {
      if (message.type === "exit") resolve(printed);
      else printed += message.data;
    });
    window.parallax
      .openTerminal(id, ${JSON.stringify(target)}, 120, 30)
      .then((error) => error && resolve("error: " + error));
  })`) as Promise<string>;

test("a new account computer takes its code in a dialog, then installs and signs in on its own plxd", async () => {
  const port = await freePort();
  const box = await startBuildBox(port);
  const { code } = await box.result<{ code: string }>("access/setupCode", {});
  const hostId = `account:${box.hostId}`;
  // The relay is out of reach, so only the loopback route answers.
  process.env["PLXD_RELAY_URL"] = "http://127.0.0.1:9";
  launched = await launch("agent.json", undefined, undefined, undefined, false, {
    accounts: [{ hostId: box.hostId, name: "build-box", routes: [`127.0.0.1:${port}`] }],
  });
  const { page } = launched;

  const dialog = page.getByRole("dialog", { name: "Connect build-box" });
  await expect(dialog).toBeVisible();
  await dialog.getByRole("textbox", { name: "Code" }).fill(`${code.slice(0, 3)} ${code.slice(3)}`);
  // A wrong code is refused, and cleared: each code is good for one try.
  await dialog.getByRole("textbox", { name: "Code" }).fill(code === "000000" ? "111111" : "000000");
  await dialog.getByRole("button", { name: "Connect" }).click();
  await expect(dialog.getByRole("alert")).toHaveText(/wrong, used, or expired/);
  await expect(dialog.getByRole("textbox", { name: "Code" })).toHaveValue("");
  // A wrong guess ends the setup code at the host, so build-box shows a new one.
  const next = await box.result<{ code: string }>("access/setupCode", {});
  await dialog.getByRole("textbox", { name: "Code" }).fill(next.code);
  await dialog.getByRole("button", { name: "Connect" }).click();
  await expect(dialog).toBeHidden();
  const state = () =>
    page.evaluate(`window.parallax.connectionState("${hostId}").then((s) => s.status)`);
  await expect.poll(state).toBe("connected");

  expect(await run(launched, { hostId, install: "opencode" })).toContain(
    "build-box npm install -g",
  );
  expect(await run(launched, { hostId, cli: "claude" })).toContain("build-box claude");

  // Settings > Connections lists it, connected.
  await page.getByRole("button", { name: "Profile", exact: true }).click();
  await page.getByRole("menuitem", { name: "Settings" }).click();
  await page.getByRole("button", { name: "Connections" }).click();
  const card = page.locator(`li[data-device="${hostId}"]`);
  await expect(card).toContainText("build-box");
  await expect(card).toContainText("Connected");
});
