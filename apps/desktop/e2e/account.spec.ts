import { execFileSync, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { createServer as createTlsServer } from "node:tls";

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
  // Isolated data folders don't isolate the tailnet: this keeps a real one out of the run.
  const tailscale = path.join(bin, "tailscale");
  writeFileSync(tailscale, "#!/bin/sh\nexit 1\n");
  chmodSync(tailscale, 0o755);
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
  return { hostId, result, bin };
}

/**
 * A TLS server with a key of its own, as a stale or hostile address the user added would be: its
 * port, how many clients connected, and how many bytes any sent once TLS was up.
 */
async function wrongKeyServer() {
  const dir = mkdtempSync(path.join(tmpdir(), "parallax-e2e-wrong-key-"));
  const [key, cert] = [path.join(dir, "key.pem"), path.join(dir, "cert.pem")];
  execFileSync(
    "openssl",
    "req -x509 -newkey ec -pkeyopt ec_paramgen_curve:P-256 -nodes -subj /CN=parallax -days 1"
      .split(" ")
      .concat("-keyout", key, "-out", cert),
    { stdio: "ignore" },
  );
  const seen = { connections: 0, bytes: 0 };
  const server = createTlsServer({ key: readFileSync(key), cert: readFileSync(cert) }, (socket) => {
    socket.on("data", (data) => (seen.bytes += data.length));
    socket.on("error", () => {});
  });
  server.on("connection", () => (seen.connections += 1));
  server.on("tlsClientError", () => {});
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { port: (server.address() as AddressInfo).port, seen, close: () => server.close() };
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
  launched = await launch("agent.json", box.bin, undefined, undefined, false, {
    accounts: [{ hostId: box.hostId, name: "build-box", routes: [`127.0.0.1:${port}`] }],
  });
  const { page } = launched;

  const dialog = page.getByRole("dialog", { name: "Add build-box" });
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
  await page
    .getByRole("dialog", { name: "build-box is added" })
    .getByRole("button", { name: "Done" })
    .click();
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

test("an added route reaches a computer, a reorder moves it, and another key gets nothing", async () => {
  const port = await freePort();
  const box = await startBuildBox(port);
  const stranger = await wrongKeyServer();
  const hostId = `account:${box.hostId}`;
  // The relay is out of reach and it has no route, so at first nothing reaches it.
  process.env["PLXD_RELAY_URL"] = "http://127.0.0.1:9";
  launched = await launch("agent.json", box.bin, undefined, undefined, false, {
    accounts: [{ hostId: box.hostId, name: "build-box", routes: [] }],
  });
  const { page, app } = launched;

  await page.getByRole("button", { name: "Profile", exact: true }).click();
  await page.getByRole("menuitem", { name: "Settings" }).click();
  await page.getByRole("button", { name: "Connections" }).click();
  const card = page.locator(`li[data-device="${hostId}"]`);
  await card.getByRole("button", { name: "build-box options" }).click();
  await card.getByRole("menuitem", { name: "Routes" }).click();
  const dialog = page.getByRole("dialog", { name: "Routes to build-box" });
  const shot = (name: string) => page.screenshot({ path: test.info().outputPath(`${name}.png`) });
  const row = (route: string) => dialog.locator(`li[data-route="${route}"]`);
  const address = dialog.getByRole("textbox", { name: "Address" });
  const add = async (text: string) => {
    await address.fill(text);
    await dialog.getByRole("button", { name: "Add route" }).click();
  };

  // Bad input says what's wrong, and the relay can't be removed.
  await add("");
  await expect(dialog.getByRole("alert")).toHaveText(/Enter an address/);
  await add("https://build-box.example.com");
  await expect(dialog.getByRole("alert")).toHaveText(/no https:\/\/ or path/);
  await expect(row(`relay:${box.hostId}`)).toContainText("Parallax Relay");
  await expect(dialog.getByRole("button", { name: "Remove Parallax Relay" })).toHaveCount(0);
  await shot("routes-bad-input");

  // A DNS name is what first reaches it: its code is asked for, and it connects over that.
  const named = `localhost:${port}`;
  await add(named);
  await expect(dialog.getByRole("alert")).toHaveCount(0);
  const { code } = await box.result<{ code: string }>("access/setupCode", {});
  const prompt = page.getByRole("dialog", { name: "Add build-box" });
  await prompt.getByRole("textbox", { name: "Code" }).fill(code);
  await prompt.getByRole("button", { name: "Connect" }).click();
  await page
    .getByRole("dialog", { name: "build-box is added" })
    .getByRole("button", { name: "Done" })
    .click();
  await expect(dialog.getByText("Connected")).toBeVisible();
  await expect(row(named)).toContainText("Added");

  // Pairing learned the name as a route too, until build-box's own report replaces that, which puts
  // what it reports above the name. Moving routes before then would order the wrong list.
  const relay = `relay:${box.hostId}`;
  const reported = (await box.result<{ routes: string[] }>("relay/id", {})).routes;
  const shown = () =>
    dialog.locator("li").evaluateAll((rows) => rows.map((li) => li.getAttribute("data-route")));
  await expect
    .poll(shown)
    .toEqual([...reported.filter((route) => !route.startsWith("relay:")), named, relay]);

  // With no order, those routes race the name and may win. In an order, with the relay on top,
  // which fails at once here, the name is next and the connection moves to it.
  const moveToTop = (route: string) =>
    expect(async () => {
      if ((await dialog.locator("li").first().getAttribute("data-route")) === route) return;
      await row(route).getByRole("button", { name: /up$/ }).click({ timeout: 1000 });
      throw new Error("one step up");
    }).toPass();
  await moveToTop(named);
  await moveToTop(relay);
  await expect(row(named)).toContainText("Connected");
  await shot("routes-connected-over-added");

  // Another address of it goes to the top: the connection moves there.
  const direct = `127.0.0.1:${port}`;
  await add(direct);
  await moveToTop(direct);
  await expect(row(direct)).toContainText("Connected");
  await shot("routes-moved-after-reorder");

  // A server with another key, put first, gets a TLS handshake and nothing else. Moving the route
  // in use below the other address makes a real dial past it, which lands on that address.
  const wrong = `127.0.0.1:${stranger.port}`;
  await add(wrong);
  await moveToTop(wrong);
  await expect.poll(() => stranger.seen.connections).toBeGreaterThan(0);
  await moveToTop(named);
  await moveToTop(wrong);
  await expect(row(named)).toContainText("Connected");
  await shot("routes-wrong-key-first");
  expect(stranger.seen.connections).toBeGreaterThan(1);
  expect(stranger.seen.bytes).toBe(0);
  stranger.close();

  // Only an added route is removed, and the order and the rest stay, saved in this app.
  await row(wrong)
    .getByRole("button", { name: `Remove ${wrong}` })
    .click();
  await expect(row(wrong)).toHaveCount(0);
  await expect(row(named)).toContainText("Connected");
  const userData = await app.evaluate(({ app }) => app.getPath("userData"));
  const saved = JSON.parse(readFileSync(path.join(userData, "settings.json"), "utf8")) as {
    accounts: { addedRoutes: string[]; routeOrder: string[] }[];
  };
  expect(saved.accounts[0]!.addedRoutes).toEqual([named, direct]);
  expect(saved.accounts[0]!.routeOrder.slice(0, 2)).toEqual([named, direct]);
});

test("a computer waiting on its code stops asking once another computer vouches for it", async () => {
  const port = await freePort();
  const box = await startBuildBox(port);
  // The relay is out of reach, so only the loopback route answers.
  process.env["PLXD_RELAY_URL"] = "http://127.0.0.1:9";
  launched = await launch("agent.json", box.bin, undefined, undefined, false, {
    accounts: [{ hostId: box.hostId, name: "build-box", routes: [`127.0.0.1:${port}`] }],
  });
  const { page, dataDir } = launched;
  const dialog = page.getByRole("dialog", { name: "Add build-box" });
  await expect(dialog).toBeVisible();

  // The other computer's app copies its list here, as `syncAccess` does once it has joined.
  const local = spawn(plxd, ["attach"], { env: { ...process.env, PLXD_DATA_DIR: dataDir } });
  try {
    const answered = new Promise<void>((resolve) =>
      createInterface({ input: local.stdout }).on("line", (line) => {
        if ((JSON.parse(line) as { id?: number }).id === 2) resolve();
      }),
    );
    const send = (id: number, method: string, params: object) =>
      local.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    send(1, "initialize", {
      protocol: { min: 1, max: 1 },
      client: { name: "e2e", version: "0" },
      capabilities: {},
    });
    send(2, "access/merge", {
      approvedClients: [],
      removedClients: [],
      approvedHosts: [box.hostId],
    });
    await answered;
    await expect(dialog).toBeHidden();
  } finally {
    local.kill();
  }
});
