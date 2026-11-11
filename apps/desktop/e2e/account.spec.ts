import { execFileSync, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { createServer as createTlsServer } from "node:tls";

import { expect, test } from "@playwright/test";

import { uuidv7 } from "../src/renderer/uuidv7";
import { close, launch, printFailure, stopServe, type Launched } from "./launch";

// An account computer (0091) as the desktop app reaches it: a second fake-backend plxd, "build-box",
// with Reach from anywhere on, saved as an `account:` host with its loopback route, as discovery
// would list it. It has no session there and nothing vouches for it, so the app asks for the code
// `plx connect` would show, here from `access/setupCode`, pairs with it through `plxd dial
// --account --pair`, and connects. Then an agent's install and a CLI sign-in run in build-box's
// own plxd terminals (PLX-1164). build-box's home has a fake npm and claude, so nothing installs.
// Its terminals run /bin/sh, which Windows lacks.
test.skip(process.platform === "win32", "build-box's terminals run /bin/sh");
// A step that can't happen fails naming that step, not at the test's own timeout.
test.use({ actionTimeout: 30_000 });

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

/** A `tailscale` in `dir` that always fails, for `dir` to go first on PATH. */
function writeFakeTailscale(dir: string) {
  const tailscale = path.join(dir, "tailscale");
  writeFileSync(tailscale, "#!/bin/sh\nexit 1\n");
  chmodSync(tailscale, 0o755);
}

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
  // Isolated data folders don't isolate the tailnet, so this plxd never finds the real one.
  writeFakeTailscale(bin);
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

  // Settings > Computers lists it, connected.
  await page.getByRole("button", { name: "Profile", exact: true }).click();
  await page.getByRole("menuitem", { name: "Settings" }).click();
  await page.getByRole("button", { name: "Computers", exact: true }).click();
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
  await page.getByRole("button", { name: "Computers", exact: true }).click();
  // Its card opens to its routes: only the relay, so far.
  const card = page.locator(`li[data-device="${hostId}"]`);
  await card.getByRole("button", { name: "1 route to build-box" }).click();
  const routes = card.locator("li[data-route]");
  const shot = (name: string) => page.screenshot({ path: test.info().outputPath(`${name}.png`) });
  const row = (route: string) => card.locator(`li[data-route="${route}"]`);
  await card.getByRole("button", { name: "Add route" }).click();
  const address = card.getByRole("textbox", { name: "Address" });
  const add = async (text: string) => {
    await address.fill(text);
    await card.getByRole("button", { name: "Add", exact: true }).click();
  };

  // Bad input says what's wrong, and the relay can't be removed.
  await add("");
  await expect(card.getByRole("alert")).toHaveText(/Enter an address/);
  await add("https://build-box.example.com");
  await expect(card.getByRole("alert")).toHaveText(/no https:\/\/ or path/);
  await expect(row(`relay:${box.hostId}`)).toContainText("Parallax Connect");
  await expect(card.getByRole("button", { name: "Remove Parallax Connect" })).toHaveCount(0);
  await shot("routes-bad-input");

  // A DNS name is what first reaches it: its code is asked for, and it connects over that.
  const named = `localhost:${port}`;
  await add(named);
  await expect(card.getByRole("alert")).toHaveCount(0);
  const { code } = await box.result<{ code: string }>("access/setupCode", {});
  const prompt = page.getByRole("dialog", { name: "Add build-box" });
  await prompt.getByRole("textbox", { name: "Code" }).fill(code);
  await prompt.getByRole("button", { name: "Connect" }).click();
  await page
    .getByRole("dialog", { name: "build-box is added" })
    .getByRole("button", { name: "Done" })
    .click();
  await expect(routes.filter({ hasText: "Connected" })).toHaveCount(1);
  await expect(row(named)).toContainText("Added");

  // Pairing learned the name as a route too, until build-box's own report replaces that, which puts
  // what it reports above the name. Moving routes before then would order the wrong list.
  const relay = `relay:${box.hostId}`;
  const reported = (await box.result<{ routes: string[] }>("relay/id", {})).routes;
  const shown = () => routes.evaluateAll((rows) => rows.map((li) => li.getAttribute("data-route")));
  await expect
    .poll(shown)
    .toEqual([...reported.filter((route) => !route.startsWith("relay:")), named, relay]);

  // With no order, those routes race the name and may win. In an order, with the relay on top,
  // which fails at once here, the name is next and the connection moves to it.
  const moveToTop = (route: string) =>
    expect(async () => {
      if ((await routes.first().getAttribute("data-route")) === route) return;
      // Its handle, moved one step with the keyboard.
      await row(route)
        .getByRole("button", { name: /^Move / })
        .press("ArrowUp", { timeout: 1000 });
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

// Agents across computers (0101), from the app's side, with both plxds real. build-box is added as
// above. The relay is out of reach, so this shows what the app sends and shows, not a peer session.
test("the setting, naming a computer and its thread, and the Load Balancer", async () => {
  test.setTimeout(90_000);
  const port = await freePort();
  const box = await startBuildBox(port);
  const { code } = await box.result<{ code: string }>("access/setupCode", {});
  const fake = { role: "worker", account: { kind: "subscription", backend: "fake" } };
  await box.result("accounts/defaults/set", fake);
  const threadOnBox = uuidv7();
  await box.result("thread/start", { runId: threadOnBox, prompt: "Fix the flaky upload test" });
  process.env["PLXD_RELAY_URL"] = "http://127.0.0.1:9";
  // This computer's listener, for the setting to turn on, away from any real plxd's port.
  process.env["PLXD_REMOTE_PORT"] = String(await freePort());
  const bin = mkdtempSync(path.join(tmpdir(), "parallax-e2e-bin-"));
  writeFakeTailscale(bin);
  launched = await launch("agent.json", bin, undefined, undefined, false, {
    localName: "studio",
    accounts: [{ hostId: box.hostId, name: "build-box", routes: [`127.0.0.1:${port}`] }],
  });
  delete process.env["PLXD_REMOTE_PORT"];
  const { page } = launched;
  const request = <T>(hostId: string, method: string, params: object) =>
    page.evaluate(
      `window.parallax.request(${JSON.stringify(hostId)}, ${JSON.stringify(method)}, ${JSON.stringify(params)})`,
    ) as Promise<{ result: T }>;

  const dialog = page.getByRole("dialog", { name: "Add build-box" });
  await dialog.getByRole("textbox", { name: "Code" }).fill(code);
  await dialog.getByRole("button", { name: "Connect" }).click();
  await page
    .getByRole("dialog", { name: "build-box is added" })
    .getByRole("button", { name: "Done" })
    .click();
  await request("local", "accounts/defaults/set", fake);
  const message = page.getByRole("textbox", { name: "Message" });

  // With agent work off there, `@` lists build-box, off, and none of its threads.
  const buildBox = page.getByRole("option", { name: /build-box/ }).first();
  await message.click();
  await page.keyboard.type("@");
  await expect(buildBox).toContainText("Agents can't work here");
  await expect(buildBox).toHaveAttribute("aria-disabled", "true");
  await expect(page.getByRole("option", { name: /Fix the flaky upload test/ })).toBeHidden();
  await page.keyboard.press("Backspace");

  // The setting: on each computer, and it and pairing change each other.
  await page.getByRole("button", { name: "Profile", exact: true }).click();
  await page.getByRole("menuitem", { name: "Settings" }).click();
  await page.getByRole("button", { name: "Computers", exact: true }).click();
  // The fake tailscale kept the tailnet's real computers out.
  await expect(page.locator("li[data-device]")).toHaveCount(1);
  // This computer's is on Sharing & access, and another's is in its card on Computers.
  await page.getByRole("button", { name: "Sharing & access" }).click();
  const here = page.getByRole("switch", { name: "Let agents on my other computers work here" });
  const pairing = page.getByRole("switch", { name: "Pair on this network" });
  await expect(here).not.toBeChecked();
  await here.click();
  await expect(here).toBeChecked();
  await expect(pairing).toBeChecked();
  await pairing.click();
  await expect(pairing).not.toBeChecked();
  await expect(here).not.toBeChecked();
  // build-box's is in its card, opened.
  await page.getByRole("button", { name: "Computers", exact: true }).click();
  await page.getByRole("button", { name: /routes? to build-box$/ }).click();
  const there = page.getByRole("switch", {
    name: "Let agents on my other computers work on build-box",
  });
  await there.click();
  await expect(there).toBeChecked();
  expect(await box.result("host/settings/get", {})).toMatchObject({
    agentWork: true,
    remote: true,
  });

  // A provider each can run, since a test machine may have none. A thread still runs on the fake.
  const runnable = (id: string) => ({
    instance: {
      id,
      kind: "acp",
      name: id,
      enabled: true,
      program: "true",
      args: [],
      env: [],
      models: [{ id: `${id}-model`, name: id }],
    },
  });
  await box.result("providers/save", runnable("both"));
  await request("local", "providers/save", runnable("both"));

  // The Load Balancer, under the computers. Both plxds read this one machine, so load can't decide
  // here: each case leaves one computer that can take the thread, and it may be too busy to, when it
  // says so.
  await page.getByRole("button", { name: "Computers", exact: true }).click();
  await page.getByRole("switch", { name: "Balance new threads across my computers" }).click();
  await page.getByRole("switch", { name: "Balance new threads onto studio" }).click();
  const often = "How often build-box takes new threads";
  await page.getByRole("button", { name: new RegExp(`^${often}`) }).click();
  await page
    .getByRole("menu", { name: often })
    .getByRole("menuitemradio", { name: "Prefer" })
    .click();
  // Its summary comes from the same scoring: studio is left out.
  const summary = page.getByRole("region", { name: "Load Balancer" }).locator("[aria-live]");
  await expect(summary).toHaveText(/Next thread goes to build-box|No computer can take/);
  await page.getByRole("button", { name: "Close settings" }).click();

  // A new draft moves to its pick with no click, and never to a computer left out.
  await page.getByRole("button", { name: "New thread", exact: true }).click();
  await page
    .getByRole("dialog", { name: "New thread in" })
    .getByRole("option", { name: /^No repo/ })
    .click();
  const onBox = page.getByRole("button", {
    name: /^Runs on: build-box, picked by the Load Balancer/,
  });
  const none = page.getByRole("button", { name: /^Runs on: Pick a computer/ });
  // A busy machine can take its full 6 s to check.
  const checked = { timeout: 15_000 };
  await expect(onBox.or(none)).toBeVisible(checked);
  // A manual pick can still be one left out, and holds.
  const runsOn = page.getByRole("button", { name: /^Runs on:/ });
  const balancer = page.getByRole("menuitem", { name: "Let the Load Balancer choose" });
  const studio = page.getByRole("menuitemradio", { name: /^studio/ });
  const onStudio = page.getByRole("button", { name: "Runs on: studio", exact: true });
  await runsOn.click();
  await expect(studio).toContainText("Left out");
  await studio.click();
  await expect(onStudio).toBeVisible();
  await page.waitForTimeout(500);
  await expect(onStudio).toBeVisible();
  // Choosing it again checks again.
  await balancer.click();
  await expect(onBox.or(none)).toBeVisible(checked);
  await studio.click();
  await expect(onStudio).toBeVisible();
  await page.keyboard.press("Escape");

  // `@` now takes build-box and its thread. Each goes to `thread/start`, by relay id.
  await message.click();
  await page.keyboard.type("@");
  await expect(buildBox).not.toHaveAttribute("aria-disabled", "true");
  await buildBox.click();
  await page.keyboard.type("@flaky");
  await page.getByRole("option", { name: /Fix the flaky upload test/ }).click();
  await page.keyboard.type("compare these");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  const transcript = page.getByRole("log", { name: "Transcript" });
  await expect(transcript.getByText("The fake agent is on it.")).toBeVisible();
  // The chip comes back from plxd's log, as does the thread's, which opens build-box's thread.
  await expect(transcript.getByTitle("Computer: build-box")).toBeVisible();
  const openThread = transcript.getByTitle("Open Fix the flaky upload test");
  await expect(openThread).toBeVisible();
  await expect(transcript).not.toContainText('@"');

  const { runs } = (await request<{ runs: { id: string }[] }>("local", "agent/list", {})).result;
  const logged = async () =>
    JSON.stringify(
      (await request("local", "agent/events", { runId: runs[0]!.id, after: 0 })).result,
    );
  const named = `"computers":["${box.hostId}"]`;
  const attached = `"remoteThreads":[{"computer":"${box.hostId}","runId":"${threadOnBox}","title":"Fix the flaky upload test"}]`;
  expect(await logged()).toContain(named);
  expect(await logged()).toContain(attached);

  // A follow-up names build-box too, through `agent/send`.
  await page.getByRole("button", { name: "Stop" }).click();
  await expect(page.getByRole("button", { name: "Send", exact: true })).toBeVisible();
  await message.click();
  await page.keyboard.type("@build");
  await buildBox.click();
  await page.keyboard.type("and run it there");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect(transcript.getByTitle("Computer: build-box")).toHaveCount(2);
  await expect.poll(async () => (await logged()).split(named).length - 1).toBe(2);

  // The thread's chip opens it on build-box.
  await openThread.click();
  await expect(transcript.getByText("Fix the flaky upload test", { exact: true })).toBeVisible();
  await expect(transcript.getByTitle("Computer: build-box")).toHaveCount(0);

  // A computer that can't run the provider a new thread defaults to is skipped, though it's the
  // only other one and studio takes part again at Less often.
  await request("local", "providers/save", runnable("studio-only"));
  await page.evaluate(`{
    localStorage.setItem("parallax.newThreads", JSON.stringify({ model: { provider: "studio-only", id: "studio-only-model" } }));
    const balancer = JSON.parse(localStorage.getItem("parallax.loadBalancer"));
    localStorage.setItem("parallax.loadBalancer", JSON.stringify({ ...balancer, leftOut: [] }));
  }`);
  await page.reload();
  await page.getByRole("button", { name: "New thread", exact: true }).click();
  await page
    .getByRole("dialog", { name: "New thread in" })
    .getByRole("option", { name: /^No repo/ })
    .click();
  const staysHere = page.getByRole("button", {
    name: /^Runs on: studio, picked by the Load Balancer/,
  });
  await expect(staysHere.or(none)).toBeVisible(checked);
  await runsOn.click();
  // A machine too busy to answer in time leaves it out as well.
  await expect(page.getByRole("menuitemradio", { name: /^build-box/ })).toContainText(
    /Provider unavailable|Didn't answer/,
  );
});
