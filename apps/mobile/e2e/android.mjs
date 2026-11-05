#!/usr/bin/env node
// The phone app on an Android emulator (PLX-1370), run by scripts/ci/android-e2e once the debug APK
// is built and an emulator is up. It starts two fake-backend plxds, Parallax Relay under `wrangler
// dev`, and a stand-in for Clerk, all on this machine, which the emulator reaches at 10.0.2.2. Then:
//
// - pinned-tls's tests run on the emulator, against both a stand-in and a real plxd.
// - The real app, on a Metro bundle naming those stand-ins, signs in and sets up `relay-box`, an
//   account computer it can reach only through the relay, as this blocks its LAN address on the
//   emulator. It pairs with `lan-box` by address and code. It then opens a thread on each.
//
// Screenshots, and logcat on a failure, go in ANDROID_E2E_OUT.
import { execFileSync, spawn } from "node:child_process";
import { createSign, generateKeyPairSync, randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { createServer as createNetServer } from "node:net";
import { tmpdir, networkInterfaces } from "node:os";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

const mobile = dirname(dirname(fileURLToPath(import.meta.url)));
const relayDir = join(mobile, "../../relay");
const out = process.env.ANDROID_E2E_OUT ?? join(mobile, "e2e/out");
mkdirSync(out, { recursive: true });
const scratch = mkdtempSync(join(tmpdir(), "plx-android-e2e-"));
const APP = "dev.parallax.mobile";
const RUNNER = "10.0.2.2";
const plxd = process.env.PLXD_PATH;
if (!plxd) throw new Error("PLXD_PATH must name a plxd built with the fake backend");

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const adb = (...args) => execFileSync("adb", args, { maxBuffer: 64 << 20 });
const cleanups = [];

const freePort = () =>
  new Promise((resolve) => {
    const server = createNetServer().listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });

/** Waits until `check` answers something truthy, and returns it. */
async function until(what, check, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const answer = await check();
    if (answer) return answer;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(250);
  }
}

// --- Clerk's stand-in: a fresh RSA key, the OAuth endpoints the app calls, and the JWKS plxd reads.

const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const jwks = { keys: [{ ...publicKey.export({ format: "jwk" }), kid: "e2e", alg: "RS256" }] };
const clerkPort = await freePort();
const issuer = `http://127.0.0.1:${clerkPort}`;

/** A session token for the test's user, issued now, as plxd takes only a fresh one. */
function mint() {
  const encode = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const now = Math.floor(Date.now() / 1000);
  const claims = { sub: "user_e2e", sid: "sess_e2e", iss: issuer, iat: now, nbf: now, exp: now + 3600 };
  const input = `${encode({ alg: "RS256", kid: "e2e", typ: "JWT" })}.${encode(claims)}`;
  return `${input}.${createSign("RSA-SHA256").update(input).sign(privateKey).toString("base64url")}`;
}

const clerk = createServer((request, response) => {
  const url = new URL(request.url, issuer);
  const json = (body) => {
    response.setHeader("Content-Type", "application/json");
    response.end(JSON.stringify(body));
  };
  if (url.pathname === "/.well-known/jwks.json") return json(jwks);
  if (url.pathname === "/oauth/userinfo") return json({ email: "e2e@parallax.test", given_name: "E2E" });
  if (url.pathname === "/oauth/token")
    return json({ access_token: mint(), refresh_token: "e2e-refresh", expires_in: 3600 });
  if (url.pathname === "/oauth/authorize") {
    const back = new URL(url.searchParams.get("redirect_uri"));
    back.searchParams.set("code", "e2e-code");
    back.searchParams.set("state", url.searchParams.get("state"));
    response.statusCode = 302;
    response.setHeader("Location", back.toString());
    return response.end();
  }
  response.statusCode = 404;
  response.end();
});
await new Promise((resolve) => clerk.listen(clerkPort, "127.0.0.1", resolve));
cleanups.push(() => clerk.close());

// --- Parallax Relay under `wrangler dev`, as relay/scripts/e2e.mjs runs it, trusting that key.

const relayPort = await freePort();
const envFile = join(scratch, ".env");
writeFileSync(envFile, `CLERK_ISSUER=${issuer}\nCLERK_JWKS='${JSON.stringify(jwks)}'\n`);
const wrangler = spawn(
  join(relayDir, "node_modules/.bin/wrangler"),
  ["dev", "--ip", "127.0.0.1", "--port", String(relayPort), "--env-file", envFile,
    "--persist-to", join(scratch, "state"), "--show-interactive-dev-session=false", "--log-level", "warn"],
  { cwd: relayDir, stdio: ["ignore", "inherit", "inherit"], detached: true,
    env: { ...process.env, WRANGLER_SEND_METRICS: "false" } },
);
cleanups.push(() => process.kill(-wrangler.pid, "SIGTERM"));
const relayUrl = `http://127.0.0.1:${relayPort}`;
await until("wrangler dev", async () => {
  const answer = await fetch(`${relayUrl}/v1/hosts`).catch(() => null);
  return answer?.status === 401;
});

// --- The computers: fake-backend plxds, each with one thread whose agent says where it is.

function uuid7() {
  const bytes = randomBytes(16);
  bytes.writeUIntBE(Date.now(), 0, 6);
  bytes[6] = (bytes[6] & 0x0f) | 0x70;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

async function computer(name, says, relay) {
  const data = mkdtempSync(join(scratch, `${name}-`));
  const script = join(scratch, `${name}.json`);
  writeFileSync(script, JSON.stringify([
    { init: { sessionId: name, model: "fake-model" } },
    { emit: { kind: "text", text: says } },
    { endTurn: {} },
    "awaitFollowUp",
  ]));
  const port = await freePort();
  const attach = spawn(plxd, ["attach"], {
    stdio: ["pipe", "pipe", "inherit"],
    env: {
      ...process.env,
      PLXD_DATA_DIR: data,
      PLXD_FAKE_BACKEND: script,
      PLXD_REMOTE_PORT: String(port),
      PLXD_RELAY_URL: relayUrl,
      PLXD_CLERK_ISSUER: issuer,
      PLXD_EXIT_WITH: String(process.pid),
    },
  });
  cleanups.push(() => attach.kill());
  const waiting = new Map();
  createInterface({ input: attach.stdout }).on("line", (line) => {
    const message = JSON.parse(line);
    if (message.id !== undefined) waiting.get(message.id)?.(message);
  });
  let id = 0;
  const call = (method, params = {}) =>
    new Promise((resolve, reject) => {
      waiting.set(++id, (message) =>
        message.error ? reject(new Error(`${method}: ${JSON.stringify(message.error)}`)) : resolve(message.result),
      );
      attach.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });
  await call("initialize", { protocol: { min: 1, max: 1 }, client: { name: "e2e", version: "0" }, capabilities: {} });
  await call("host/settings/set", { remote: true, deviceName: name, ...(relay ? { relay: true } : {}) });
  await until(`${name}'s listener`, async () => (await call("remote/sessions")).listening);
  await call("accounts/defaults/set", { role: "worker", account: { kind: "subscription", backend: "fake" } });
  if (relay) {
    await call("relay/register", { token: mint() });
    await until(`${name} on the relay`, async () => (await call("remote/sessions")).relay?.connected);
  }
  const { hostId } = await call("relay/id");
  return { call, hostId, port };
}

// --- Driving the emulator.

function gradle(...args) {
  execFileSync("./gradlew", ["--console=plain", "-PreactNativeArchitectures=x86_64", ...args], {
    cwd: join(mobile, "android"),
    stdio: "inherit",
  });
}

/** The screen's elements now: each one's text or description, and where its center is. */
function screen() {
  const xml = adb("exec-out", "uiautomator", "dump", "/dev/tty").toString();
  return [...xml.matchAll(/<node [^>]*?>/g)].map(([node]) => {
    const attribute = (name) => node.match(new RegExp(` ${name}="([^"]*)"`))?.[1] ?? "";
    const [, x1, y1, x2, y2] = attribute("bounds").match(/\[(\d+),(\d+)\]\[(\d+),(\d+)\]/) ?? [];
    return {
      label: attribute("text") || attribute("content-desc"),
      x: (Number(x1) + Number(x2)) >> 1,
      y: (Number(y1) + Number(y2)) >> 1,
    };
  });
}

const shot = (name) => writeFileSync(join(out, `${name}.png`), adb("exec-out", "screencap", "-p"));

/**
 * Waits for an element whose label is `wanted` or matches it, and returns it, tapping any of
 * `dismiss` it sees meanwhile.
 */
async function waitFor(wanted, { timeoutMs = 60_000, dismiss = [] } = {}) {
  const matches = (label) => (typeof wanted === "string" ? label === wanted : wanted.test(label));
  const deadline = Date.now() + timeoutMs;
  let last = [];
  for (;;) {
    try {
      last = screen();
      const found = last.find((element) => matches(element.label));
      if (found) return found;
      const obstacle = last.find((element) => dismiss.includes(element.label));
      if (obstacle) adb("shell", "input", "tap", String(obstacle.x), String(obstacle.y));
    } catch {
      // uiautomator fails while the screen is changing.
    }
    if (Date.now() > deadline)
      throw new Error(`no ${wanted} on screen: ${last.map((e) => e.label).filter(Boolean).join(" | ")}`);
    await sleep(1000);
  }
}

async function tap(wanted, options) {
  const { x, y } = await waitFor(wanted, options);
  adb("shell", "input", "tap", String(x), String(y));
}

/** Types `text` into the field labelled `label`. */
async function type(label, text) {
  await tap(label);
  await sleep(500);
  adb("shell", "input", "text", text);
  await sleep(500);
}

let failed = true;
try {
  const relayBox = await computer("relay-box", "Reached through Parallax Relay.", true);
  const lanBox = await computer("lan-box", "Reached over the LAN.", false);
  await relayBox.call("thread/start", { runId: uuid7(), prompt: "Thread on relay-box" });
  await lanBox.call("thread/start", { runId: uuid7(), prompt: "Thread on lan-box" });

  // The pin check on the emulator's own TLS, Conscrypt as a phone has, not the JVM's.
  const argument = (name, value) => `-Pandroid.testInstrumentationRunnerArguments.${name}=${value}`;
  gradle(
    ":pinned-tls:connectedDebugAndroidTest",
    argument("hostId", relayBox.hostId),
    argument("lanPort", relayBox.port),
    argument("relayUrl", `ws://${RUNNER}:${relayPort}`),
    argument("relayToken", mint()),
  );

  adb("install", "-r", join(mobile, "android/app/build/outputs/apk/debug/app-debug.apk"));
  adb("shell", "pm", "grant", APP, "android.permission.POST_NOTIFICATIONS");
  adb("reverse", "tcp:8081", "tcp:8081");
  // Past Chrome's first-run pages, for the sign-in's Custom Tab.
  adb("shell", "am", "set-debug-app", "--persistent", "com.android.chrome");
  adb("shell", "echo '_ --disable-fre --no-default-browser-check --no-first-run' > /data/local/tmp/chrome-command-line");

  // relay-box's LAN address is this machine's own, which the emulator could reach. Only the relay
  // is left once it can't. 10.0.2.2, where lan-box and the relay are, stays open.
  adb("root");
  await sleep(3000);
  adb("wait-for-device");
  for (const address of Object.values(networkInterfaces()).flat())
    if (address?.family === "IPv4" && !address.internal)
      adb("shell", "iptables", "-A", "OUTPUT", "-d", address.address, "-j", "REJECT");

  const metro = spawn("pnpm", ["exec", "expo", "start", "--port", "8081"], {
    cwd: mobile,
    stdio: "inherit",
    detached: true,
    env: {
      ...process.env,
      CI: "1",
      EXPO_NO_TELEMETRY: "1",
      EXPO_PUBLIC_RELAY_URL: `http://${RUNNER}:${relayPort}`,
      EXPO_PUBLIC_CLERK_API: `http://${RUNNER}:${clerkPort}`,
    },
  });
  cleanups.push(() => process.kill(-metro.pid, "SIGTERM"));
  // An app that starts before Metro answers looks for a bundle in its assets, and a debug APK has none.
  await until("Metro", async () => {
    const answer = await fetch("http://127.0.0.1:8081/status").catch(() => null);
    return (await answer?.text())?.includes("packager-status:running");
  }, 120_000);

  adb("shell", "am", "start", "-n", `${APP}/.MainActivity`);
  await waitFor("Sign in", { timeoutMs: 300_000 });
  shot("1-sign-in");
  await tap("Sign in");
  await waitFor("Your computers", {
    timeoutMs: 120_000,
    dismiss: ["Use without an account", "No thanks", "Accept & continue", "Got it"],
  });

  // An account computer: the code its Settings or `plx connect` shows, typed here.
  await waitFor("relay-box");
  const { code } = await relayBox.call("access/setupCode");
  await tap("Enter a code from plx connect");
  await type("Set up relay-box", code);
  shot("2-setup-code");
  await tap("Set Up");
  await until("relay-box's session for this phone", async () => {
    const { sessions } = await relayBox.call("remote/sessions");
    return sessions.some((session) => session.name === "Android phone");
  }, 120_000);
  shot("3-relay-box-connected");

  // A computer paired on the LAN, by its address and code.
  await tap(/^Pair a computer on this/);
  const { code: pairing } = await lanBox.call("remote/pair");
  await type("Address", `${RUNNER}:${lanBox.port}`);
  await type("Code", pairing.replaceAll("-", ""));
  adb("shell", "input", "keyevent", "111"); // Puts the keyboard away, off the button.
  shot("4-pair-lan-box");
  await tap("Pair");
  await waitFor("lan-box", { timeoutMs: 60_000 });
  shot("5-computers");

  await tap("Continue");
  await tap("Not now");

  await tap("Open sidebar", { timeoutMs: 60_000 });
  await waitFor(/Thread on relay-box/, { timeoutMs: 120_000 });
  await waitFor(/Thread on lan-box/, { timeoutMs: 120_000 });
  shot("6-sidebar");

  await tap(/Thread on relay-box/);
  await waitFor(/Reached through Parallax Relay/, { timeoutMs: 120_000 });
  shot("7-thread-through-relay");

  await tap("Open sidebar");
  await tap(/Thread on lan-box/, { timeoutMs: 60_000 });
  await waitFor(/Reached over the LAN/, { timeoutMs: 120_000 });
  shot("8-thread-over-lan");
  failed = false;
} finally {
  if (failed) {
    try {
      shot("failed");
      writeFileSync(join(out, "logcat.txt"), adb("logcat", "-d"));
    } catch {}
  }
  for (const cleanup of cleanups) {
    try {
      cleanup();
    } catch {}
  }
  rmSync(scratch, { recursive: true, force: true });
  // Metro, wrangler, and plxd hold this process's pipes open otherwise.
  process.exitCode = failed ? 1 : 0;
  setTimeout(() => process.exit(), 2000);
}
