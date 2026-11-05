#!/usr/bin/env node
// The phone app on an Android emulator (PLX-1370), run by scripts/ci/android-e2e once the debug APK
// is built and an emulator is up. It starts two fake-backend plxds, Parallax Relay under `wrangler
// dev`, and a stand-in for Clerk, all on this machine, which the emulator reaches at 10.0.2.2. Then:
//
// - pinned-tls's tests run on the emulator, against both a stand-in and a real plxd.
// - The real app, on a Metro bundle naming those stand-ins, signs in and sets up `relay-box`, an
//   account computer it can reach only through the relay, as this blocks its LAN address on the
//   emulator. It pairs with `lan-box` by address and code first, then takes
//   `relay-box`'s code, and each computer must report the phone's session.
//
// A failure in the tests fails this. A failure in the app's drive leaves ui-drive-failed.txt instead,
// which the CI job reports without blocking a merge. Screenshots, and logcat on a failure, go in
// ANDROID_E2E_OUT.
import { execFileSync, spawn } from "node:child_process";
import { createSign, generateKeyPairSync } from "node:crypto";
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

const started = Date.now();
const log = (message) => console.log(`[android e2e +${Math.round((Date.now() - started) / 1000)}s] ${message}`);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Every blocking call has a limit: an adb call with none once hung for 47 minutes while Chrome drew,
// past every wait here, until the job's own limit cancelled it with nothing to show.
const adbWithin = (timeout, ...args) =>
  execFileSync("adb", args, { maxBuffer: 64 << 20, timeout, killSignal: "SIGKILL", stdio: ["ignore", "pipe", "pipe"] });
const adb = (...args) => adbWithin(30_000, ...args);
const cleanups = [];

/** The app, the browser, or whatever else has the screen, for a failure to name. */
function focused() {
  try {
    return adb("shell", "dumpsys window | grep mCurrentFocus").toString().trim();
  } catch (e) {
    return `unknown: ${e.message}`;
  }
}

const freePort = () =>
  new Promise((resolve) => {
    const server = createNetServer().listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });

/** Waits until `check` answers something truthy, and returns it. */
async function until(what, check, timeoutMs = 60_000) {
  log(`waiting for ${what}, up to ${timeoutMs / 1000}s`);
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
  const answer = await fetch(`${relayUrl}/v1/hosts`, { signal: AbortSignal.timeout(5000) }).catch(() => null);
  return answer?.status === 401;
});

// --- The computers: fake-backend plxds.

async function computer(name, relay) {
  const data = mkdtempSync(join(scratch, `${name}-`));
  const port = await freePort();
  const attach = spawn(plxd, ["attach"], {
    stdio: ["pipe", "pipe", "inherit"],
    env: {
      ...process.env,
      PLXD_DATA_DIR: data,
      PLXD_REMOTE_PORT: String(port),
      PLXD_RELAY_URL: relayUrl,
      PLXD_CLERK_ISSUER: issuer,
      PLXD_EXIT_WITH: String(process.pid),
    },
  });
  const waiting = new Map();
  // Why the connection ended, for every call after it, as nothing would answer them.
  let gone;
  attach.stdin.on("error", () => {}); // A write after it ended: `gone` says why.
  attach.on("exit", (code, signal) => {
    gone = `${name}'s plxd attach ended with ${code ?? signal}`;
    for (const settle of waiting.values()) settle({ error: gone });
  });
  createInterface({ input: attach.stdout }).on("line", (line) => {
    const message = JSON.parse(line);
    if (message.id !== undefined) waiting.get(message.id)?.(message);
  });
  let id = 0;
  const call = (method, params = {}) =>
    new Promise((resolve, reject) => {
      if (gone) return reject(new Error(`${method}: ${gone}`));
      const timer = setTimeout(() => reject(new Error(`${name} didn't answer ${method} in 30s`)), 30_000);
      const asked = ++id;
      waiting.set(asked, (message) => {
        clearTimeout(timer);
        waiting.delete(asked);
        if (message.error) reject(new Error(`${name}: ${method}: ${JSON.stringify(message.error)}`));
        else resolve(message.result);
      });
      attach.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: asked, method, params })}\n`);
    });
  // plxd closes a connection silent for 90 seconds, so this says something as the app does.
  const heartbeat = setInterval(() => void call("host/health").catch(() => {}), 30_000);
  cleanups.push(() => {
    clearInterval(heartbeat);
    attach.kill();
  });
  await call("initialize", { protocol: { min: 1, max: 1 }, client: { name: "e2e", version: "0" }, capabilities: {} });
  await call("host/settings/set", { remote: true, deviceName: name, ...(relay ? { relay: true } : {}) });
  await until(`${name}'s listener`, async () => (await call("remote/sessions")).listening);
  if (relay) {
    await call("relay/register", { token: mint() });
    await until(`${name} on the relay`, async () => (await call("remote/sessions")).relay?.connected);
  }
  const { hostId } = await call("relay/id");
  return { name, call, hostId, port };
}

// --- Driving the emulator.

/** Runs a Gradle task, without blocking this process, whose connections to plxd need their heartbeats. */
function gradle(...args) {
  log(`gradle ${args[0]}`);
  return new Promise((resolve, reject) => {
    const run = spawn("./gradlew", ["--console=plain", "-PreactNativeArchitectures=x86_64", ...args], {
      cwd: join(mobile, "android"),
      stdio: "inherit",
    });
    const limit = setTimeout(() => run.kill("SIGKILL"), 10 * 60_000);
    run.on("exit", (code, signal) => {
      clearTimeout(limit);
      if (code === 0) resolve();
      else reject(new Error(`gradle ${args[0]} ended with ${code ?? signal}`));
    });
  });
}

/**
 * The screen's elements now: each one's text, description, whether it's a text field, and its center.
 * An empty field reports its placeholder as its text, so `label` alone can hide what it's labelled.
 */
function screen() {
  const xml = adbWithin(20_000, "exec-out", "uiautomator", "dump", "/dev/tty").toString();
  return [...xml.matchAll(/<node [^>]*?>/g)].map(([node]) => {
    const attribute = (name) => node.match(new RegExp(` ${name}="([^"]*)"`))?.[1] ?? "";
    const [, x1, y1, x2, y2] = attribute("bounds").match(/\[(\d+),(\d+)\]\[(\d+),(\d+)\]/) ?? [];
    return {
      right: Number(x2),
      height: Number(y2) - Number(y1),
      label: attribute("text") || attribute("content-desc"),
      description: attribute("content-desc"),
      field: attribute("class") === "android.widget.EditText",
      x: (Number(x1) + Number(x2)) >> 1,
      y: (Number(y1) + Number(y2)) >> 1,
    };
  });
}

const shot = (name) => writeFileSync(join(out, `${name}.png`), adb("exec-out", "screencap", "-p"));

/**
 * Waits for an element whose label is `wanted` or matches it, and returns it, tapping any of
 * `dismiss` it sees meanwhile. With `field`, only a text field counts, as a dialog's title can share
 * its field's label.
 */
async function waitFor(wanted, { timeoutMs = 60_000, dismiss = [], field = false } = {}) {
  const matches = (element) =>
    (!field || element.field) &&
    [element.label, element.description].some((label) =>
      typeof wanted === "string" ? label === wanted : wanted.test(label),
    );
  log(`waiting for ${wanted} on screen, up to ${timeoutMs / 1000}s`);
  const deadline = Date.now() + timeoutMs;
  let last = [];
  let problem;
  for (;;) {
    try {
      last = screen();
      problem = undefined;
      const found = last.find(matches);
      if (found) return found;
      // A busy emulator can leave a system "isn't responding" dialog over everything. Wait leaves another
      // app's window stuck, and the dialog comes back.
      const stuck = last.find((element) => element.label.endsWith("isn't responding"));
      const answer = stuck?.label.startsWith("Parallax") ? "Wait" : "Close app";
      const obstacle = last.find(
        (element) => dismiss.includes(element.label) || (stuck && element.label === answer),
      );
      if (stuck) log(stuck.label);
      if (obstacle) adb("shell", "input", "tap", String(obstacle.x), String(obstacle.y));
    } catch (e) {
      // uiautomator fails or hangs while the screen is changing. One that hung would block the next.
      problem = e.message;
      try {
        adb("shell", "pkill -f uiautomator");
      } catch {}
    }
    if (Date.now() > deadline)
      throw new Error(
        `no ${wanted} on screen after ${timeoutMs / 1000}s. In front: ${focused()}. Last read${problem ? ` failed: ${problem}` : ""}: ${last.map((e) => e.label).filter(Boolean).join(" | ")}`,
      );
    await sleep(1000);
  }
}

/** The screen now, or nothing while uiautomator can't read it. */
function readScreen() {
  try {
    return screen();
  } catch {
    return [];
  }
}

/**
 * Closes a debug build's warning toast, whose body opens the debugger and which covers the bottom of
 * the screen. Its close button is a square at its right end.
 */
function closeToast() {
  const toast = readScreen().find((element) => element.label.endsWith("Open debugger to view warnings."));
  if (toast)
    adb("shell", "input", "tap", String(toast.right - (toast.height >> 1)), String(toast.y));
}

async function tap(wanted, options) {
  closeToast();
  const { x, y } = await waitFor(wanted, options);
  log(`tapping ${wanted}`);
  adb("shell", "input", "tap", String(x), String(y));
}

/**
 * Waits until `box` has a session named for this phone, which only reaching it can make. The app's
 * own refusal, a notice gone in 5 seconds, fails this at once with its words.
 */
const phoneSession = (box) =>
  until(`${box.name} to report this phone's session`, async () => {
    const { sessions } = await box.call("remote/sessions");
    if (sessions.some((session) => session.name === "Android phone")) return true;
    const elements = readScreen();
    const refusal = elements.findIndex((element) => /^(Couldn't|Parallax couldn't)/.test(element.label));
    if (refusal >= 0) {
      shot("refused");
      throw new Error(`the app says: ${elements.slice(refusal, refusal + 2).map((e) => e.label).join(": ")}`);
    }
    return false;
  }, 120_000);

/**
 * Replaces what's in the field labelled `label` with `text`, waits to see it in that field, then puts
 * the keyboard away, as it covers the rest of the form and takes taps meant for what's under it.
 */
async function type(label, text) {
  await tap(label, { field: true });
  await sleep(500);
  adb("shell", "input", "keyevent", "KEYCODE_MOVE_END", ...Array(40).fill("KEYCODE_DEL"));
  adb("shell", "input", "text", text);
  await until(`${text} in the field ${label}`, () =>
    readScreen().some((element) => element.field && element.description === label && element.label === text),
  15_000);
  adb("shell", "input", "keyevent", "KEYCODE_ESCAPE");
  await sleep(500);
}

// The pin tests' failure fails the job. The app's, past them, leaves ui-drive-failed.txt for the CI step
// that reports it without blocking a merge: an emulator on a shared runner is too slow to be sure.
let phase = "setup";
let failure;
// Past every step's own limit, in case of something none of them covers. Well inside the CI step's.
const watchdog = setTimeout(() => {
  console.error(`android e2e: over its 20 minutes. In front: ${focused()}`);
  if (phase === "app") {
    writeFileSync(join(out, "ui-drive-failed.txt"), "over its 20 minutes");
    process.exit(0);
  }
  process.exit(1);
}, 20 * 60_000);
try {
  const relayBox = await computer("relay-box", true);
  const lanBox = await computer("lan-box", false);

  // An unresponsive app is closed, not asked about in a dialog that takes every tap.
  adb("shell", "settings", "put", "global", "hide_error_dialogs", "1");

  // The pin check on the emulator's own TLS, Conscrypt as a phone has, not the JVM's.
  const argument = (name, value) => `-Pandroid.testInstrumentationRunnerArguments.${name}=${value}`;
  await gradle(
    ":pinned-tls:connectedDebugAndroidTest",
    argument("hostId", relayBox.hostId),
    argument("lanPort", relayBox.port),
    argument("relayUrl", `ws://${RUNNER}:${relayPort}`),
    argument("relayToken", mint()),
  );

  phase = "app";
  log("installing the app");
  adbWithin(3 * 60_000, "install", "-r", join(mobile, "android/app/build/outputs/apk/debug/app-debug.apk"));
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
    const answer = await fetch("http://127.0.0.1:8081/status", { signal: AbortSignal.timeout(5000) }).catch(() => null);
    return (await answer?.text())?.includes("packager-status:running");
  }, 120_000);

  // The launcher can be stuck from a slow boot, with its dialog up from before the setting above.
  adb("shell", "am", "force-stop", "com.google.android.apps.nexuslauncher");
  adb("shell", "am", "start", "-n", `${APP}/.MainActivity`);
  await waitFor("Sign in", { timeoutMs: 300_000 });
  shot("1-sign-in");
  await tap("Sign in");
  await waitFor("Your computers", {
    timeoutMs: 120_000,
    dismiss: ["Use without an account", "No thanks", "Accept & continue", "Got it"],
  });

  // A computer paired on the LAN, by its address and code. It advertises over mDNS once it has a
  // code. When the phone's look ends, one computer found fills the address: its real one, which is
  // blocked here, so 10.0.2.2 replaces it.
  const { code: pairing } = await lanBox.call("remote/pair");
  await tap(/^Pair a computer on this/);
  await waitFor("Look again");
  shot("2-found-on-this-network");
  await type("Address", `${RUNNER}:${lanBox.port}`);
  await type("Code", pairing.replaceAll("-", ""));
  shot("3-pair-lan-box");
  await tap("Pair");
  await phoneSession(lanBox);
  log("the LAN path reached lan-box");
  await waitFor("lan-box");
  shot("4-lan-box-paired");

  // An account computer: the code its Settings or `plx connect` shows, typed here, through the relay.
  await waitFor("relay-box");
  const { code } = await relayBox.call("access/setupCode");
  await tap("Enter a code from plx connect");
  await type("Set up relay-box", code);
  shot("5-setup-code");
  await tap("Set Up");
  await phoneSession(relayBox);
  log("the relay path reached relay-box");
  await waitFor("Ready");
  shot("6-relay-box-ready");
} catch (e) {
  failure = e;
} finally {
  clearTimeout(watchdog);
  if (failure) {
    console.error(failure);
    log(`failed. In front: ${focused()}. On screen: ${readScreen().map((e) => e.label).filter(Boolean).join(" | ")}`);
    try {
      shot("failed");
      writeFileSync(join(out, "logcat.txt"), adbWithin(60_000, "logcat", "-d"));
    } catch {}
    if (phase === "app") writeFileSync(join(out, "ui-drive-failed.txt"), String(failure.stack ?? failure));
  }
  for (const cleanup of cleanups) {
    try {
      cleanup();
    } catch {}
  }
  rmSync(scratch, { recursive: true, force: true });
  // Metro, wrangler, and plxd hold this process's pipes open otherwise.
  process.exitCode = failure && phase !== "app" ? 1 : 0;
  setTimeout(() => process.exit(), 2000);
}
