import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createPrivateKey, createPublicKey, createSign } from "node:crypto";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer as createHttp, type Server } from "node:http";
import { createServer, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";

import { expect, test, type Page } from "@playwright/test";

import { close, launch, printFailure, type Launched } from "./launch";

// Starting over with a new key (0091) on real connections: two apps, each with its own plxd. The
// laptop is an account device of the mini's. The mini removes it, then makes its next key
// read-only, and each time the laptop starts over from Settings and is allowed again in the mini's
// app. The only fakes are Clerk, a local server the plxds trust through `PLXD_CLERK_ISSUER`, and
// `tailscale`, first on PATH, since an isolated data folder doesn't isolate the tailnet.

const desktop = path.join(import.meta.dirname, "..");
const plxd = process.env["PLXD_PATH"] ?? path.join(desktop, "../../target/debug/plxd");
const USER = "user_1";

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

function fakeTailscale(): string {
  const bin = mkdtempSync(path.join(tmpdir(), "parallax-e2e-tailscale-"));
  const name = path.join(bin, process.platform === "win32" ? "tailscale.cmd" : "tailscale");
  writeFileSync(name, process.platform === "win32" ? "@exit /b 1\r\n" : "#!/bin/sh\nexit 1\n");
  chmodSync(name, 0o755);
  return bin;
}

/** A Clerk instance on loopback: its JWKS, and tokens signed with plxd's test key. */
async function fakeClerk(): Promise<{ server: Server; issuer: string }> {
  const key = createPrivateKey({
    key: readFileSync(path.join(desktop, "../../daemon/tests/fixtures/clerk-test-key.der")),
    format: "der",
    type: "pkcs1",
  });
  const jwks = { keys: [{ ...createPublicKey(key).export({ format: "jwk" }), kid: "k1" }] };
  const encoded = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");
  let issuer = "";
  const token = () => {
    const now = Math.floor(Date.now() / 1000);
    const input = `${encoded({ alg: "RS256", kid: "k1" })}.${encoded({
      iss: issuer,
      sub: USER,
      sid: "sess",
      iat: now,
      exp: now + 600,
    })}`;
    return `${input}.${createSign("RSA-SHA256").update(input).sign(key).toString("base64url")}`;
  };
  const server = createHttp((req, res) => {
    res.setHeader("Content-Type", "application/json");
    if (req.url === "/oauth/token")
      res.end(
        JSON.stringify({ access_token: token(), refresh_token: "refresh", expires_in: 3600 }),
      );
    else if (req.url === "/oauth/userinfo") res.end(JSON.stringify({ email: "dev@example.com" }));
    else res.end(JSON.stringify(jwks));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  issuer = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { server, issuer };
}

/** Signs `launched`'s app in to the fake Clerk: main's calls to Clerk and its browser go there. */
async function signIn({ app, page }: Launched, issuer: string) {
  await app.evaluate(({ shell, safeStorage }, clerk) => {
    const real = globalThis.fetch;
    globalThis.fetch = (url, init) => {
      // Main fetches by address.
      const { pathname } = new URL(url as string);
      return real(pathname.startsWith("/oauth/") ? `${clerk}${pathname}` : url, init);
    };
    shell.openExternal = async (href) => {
      const asked = new URL(href).searchParams;
      const back = new URL(asked.get("redirect_uri")!);
      back.search = new URLSearchParams({ code: "code", state: asked.get("state")! }).toString();
      await real(back);
    };
    // Nothing here should ask the Keychain for anything.
    safeStorage.encryptString = (text) => Buffer.from(text);
  }, issuer);
  expect(await page.evaluate(`window.parallax.signIn(false)`)).toBeUndefined();
}

/** A JSON-RPC client on the plxd whose data folder is `dataDir`, as its own computer's. */
async function attach(dataDir: string) {
  const child = spawn(plxd, ["attach"], { env: { ...process.env, PLXD_DATA_DIR: dataDir } });
  attached.push(child);
  const waiting = new Map<number, (message: { result?: unknown; error?: unknown }) => void>();
  createInterface({ input: child.stdout }).on("line", (line) => {
    const message = JSON.parse(line) as { id?: number; result?: unknown; error?: unknown };
    if (message.id !== undefined) waiting.get(message.id)?.(message);
  });
  let id = 0;
  const call = async <T>(method: string, params: object) => {
    const answer = await new Promise<{ result?: unknown; error?: unknown }>((resolve) => {
      waiting.set(++id, resolve);
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });
    expect(answer.error).toBeUndefined();
    return answer.result as T;
  };
  const protocol = { min: 1, max: 1 };
  await call("initialize", { protocol, client: { name: "e2e", version: "0" }, capabilities: {} });
  return call;
}

const status = (page: Page, id: string) =>
  page.evaluate<string>(
    `window.parallax.connectionState(${JSON.stringify(id)}).then((s) => s.status)`,
  );

/** What `method` answers on host `id` from `page`: undefined when it went, else why it was refused. */
const refusal = (page: Page, id: string, method: string, params: object) =>
  page.evaluate<string | undefined>(
    `window.parallax.request(${JSON.stringify(id)}, ${JSON.stringify(method)}, ${JSON.stringify(params)})
      .then((a) => a.error && (a.error.data?.kind ?? a.error.message))`,
  );

/** Opens one of Settings' two Connections pages. */
const openSettings = async (page: Page, name: "Computers" | "Sharing & access") => {
  await page.getByRole("button", { name: "Profile", exact: true }).click();
  await page.getByRole("menuitem", { name: "Settings" }).click();
  await page.getByRole("button", { name, exact: true }).click();
};

let mini: Launched | undefined;
let laptop: Launched | undefined;
let clerk: Server | undefined;
const attached: ChildProcessWithoutNullStreams[] = [];
test.afterEach(async () => {
  if (test.info().status !== test.info().expectedStatus)
    for (const each of [mini, laptop]) if (each) await printFailure(each);
  for (const child of attached.splice(0)) child.kill();
  await close(laptop);
  await close(mini);
  clerk?.close();
  for (const name of ["PLXD_CLERK_ISSUER", "PLXD_RELAY_URL"]) delete process.env[name];
});

test("a removed device, then a read-only one, starts over with a new key and gets nothing until it's allowed", async () => {
  test.setTimeout(180_000);
  const shot = (page: Page, name: string) =>
    page.screenshot({ path: test.info().outputPath(`${name}.png`) });
  const bin = fakeTailscale();
  const fake = await fakeClerk();
  clerk = fake.server;
  process.env["PLXD_CLERK_ISSUER"] = fake.issuer;
  // The relay is out of reach, so only the loopback route answers.
  process.env["PLXD_RELAY_URL"] = "http://127.0.0.1:9";

  const port = await freePort();
  process.env["PLXD_REMOTE_PORT"] = String(port);
  // On loopback, so the only route the mini reports is one every OS's runner can reach.
  process.env["PLXD_REMOTE_ADDRESS"] = "127.0.0.1";
  mini = await launch("web.json", bin, undefined, undefined, false, { localName: "mini" });
  delete process.env["PLXD_REMOTE_PORT"];
  delete process.env["PLXD_REMOTE_ADDRESS"];
  const host = mini.page;
  await expect.poll(() => status(host, "local")).toBe("connected");
  const onMini = await attach(mini.dataDir);
  await onMini("relay/sign", { tokenHash: "hash", userId: USER });
  await onMini("host/settings/set", { remote: true, relay: true, deviceName: "mini" });
  await expect.poll(() => onMini("remote/sessions", {})).toMatchObject({ listening: true });
  const { hostId: relayId } = await onMini<{ hostId: string }>("relay/id", {});
  const id = `account:${relayId}`;
  const route = `127.0.0.1:${port}`;
  type Lists = {
    approvedClients: string[];
    removedClients: string[];
    readOnlyClients?: string[];
  };
  const lists = () => onMini<Lists>("access/get", {});

  // The laptop joins with the mini's setup code, then signs in to the account.
  laptop = await launch("web.json", bin, undefined, undefined, false, {
    localName: "laptop",
    accounts: [{ hostId: relayId, name: "mini", routes: [route] }],
  });
  const device = laptop.page;
  const { code: setupCode } = await onMini<{ code: string }>("access/setupCode", {});
  const dialog = device.getByRole("dialog", { name: "Add mini" });
  await dialog.getByRole("textbox", { name: "Code" }).fill(setupCode);
  await dialog.getByRole("button", { name: "Connect" }).click();
  await device
    .getByRole("dialog", { name: "mini is added" })
    .getByRole("button", { name: "Done" })
    .click();
  await expect.poll(() => status(device, id)).toBe("connected");
  await signIn(laptop, fake.issuer);
  const key = () => device.evaluate<string>(`window.parallax.deviceKey()`);
  const firstKey = await key();
  // The laptop's computers, where its key's standing shows, are on Computers.
  await openSettings(device, "Computers");
  const startOver = device.getByRole("button", { name: "Start over with a new key" });
  await expect(startOver).toHaveCount(0);

  // The mini removes it. Its session ends, and its sign-in is refused for good.
  // The devices with access to the mini are on its Sharing & access.
  await openSettings(host, "Sharing & access");
  await host.getByRole("button", { name: "Revoke" }).click();
  await expect(
    device.getByRole("status").filter({ hasText: "This computer was removed" }),
  ).toBeVisible();
  await shot(device, "removed");
  expect((await lists()).removedClients).toEqual([firstKey]);

  // Starting over says what goes, and what comes next.
  await startOver.click();
  await expect(device.getByText(/It shows there as a new device/)).toBeVisible();
  await shot(device, "confirm");
  await device.getByRole("button", { name: "Start over", exact: true }).click();

  // The new key waits: nothing approved it, and its own dial is refused.
  const card = device.locator(`li[data-device="${id}"]`);
  await expect(card).toContainText("Allow this computer on another device");
  const secondKey = await key();
  expect(secondKey).not.toBe(firstKey);
  expect(await status(device, id)).not.toBe("connected");
  const dial = spawnSync(plxd, ["dial", `--account=${relayId}`, "--", route], {
    env: { ...process.env, PLXD_DATA_DIR: laptop.dataDir },
    input: "",
    timeout: 15_000,
  });
  expect(dial.status).toBe(5);
  const waiting = await lists();
  expect(waiting.approvedClients).not.toContain(secondKey);
  expect(waiting.removedClients).toEqual([firstKey]);
  await shot(device, "waiting");

  // The mini's app asks, as for any new device, with the code the laptop shows.
  const allow = host.getByRole("dialog", { name: "Allow laptop?" });
  await expect(allow).toBeVisible();
  const shown = (await card.innerText()).match(/(\d{3}) ?(\d{3})/)!;
  await expect(allow.getByLabel("Code")).toHaveText(`${shown[1]} ${shown[2]}`);
  await shot(host, "allow");
  await allow.getByRole("button", { name: "Allow" }).click();
  await expect.poll(() => status(device, id)).toBe("connected");
  expect(await refusal(device, id, "host/settings/set", { autoResume: true })).toBeUndefined();
  await expect(startOver).toHaveCount(0);
  const allowed = await lists();
  expect(allowed.approvedClients).toEqual([secondKey]);
  expect(allowed.removedClients).toEqual([firstKey]);
  await shot(device, "connected");

  // Now the mini makes the new key read-only. The laptop hears it, and its writes are refused.
  await host.getByRole("button", { name: "Make read-only" }).click();
  await host.getByRole("button", { name: "Make read-only" }).click();
  await expect(
    device.getByRole("status").filter({ hasText: "This computer is read-only" }),
  ).toBeVisible();
  await expect
    .poll(() => refusal(device, id, "host/settings/set", { autoResume: false }))
    .toBe("readOnly");
  await shot(device, "read-only");

  // Starting over asks again, as a new device, and that device's Allow gives full access.
  await startOver.click();
  await device.getByRole("button", { name: "Start over", exact: true }).click();
  await expect(card).toContainText("Allow this computer on another device");
  const thirdKey = await key();
  expect(thirdKey).not.toBe(secondKey);
  expect((await lists()).readOnlyClients).toEqual([secondKey]);
  await allow.getByRole("button", { name: "Allow" }).click();
  await expect.poll(() => status(device, id)).toBe("connected");
  await expect
    .poll(() => refusal(device, id, "host/settings/set", { autoResume: false }))
    .toBeUndefined();

  // The app copies the old key's removal there, which ends its session. Its mark stays with it.
  await expect
    .poll(async () => (await lists()).removedClients.sort())
    .toEqual([firstKey, secondKey].sort());
  const final = await lists();
  expect(final.approvedClients).toEqual([thirdKey]);
  expect(final.readOnlyClients).toEqual([secondKey]);
  const { sessions } = await onMini<{ sessions: unknown[] }>("remote/sessions", {});
  expect(sessions).toHaveLength(1);
});
