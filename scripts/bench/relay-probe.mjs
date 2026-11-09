#!/usr/bin/env node
// Tests the deployed relay and reports the result (PLX-1360, weaknesses 5 and 11 of PLX-1347).
// relay-probe.yml runs it on a schedule and on each nightly, whose notes get the result.
//
//     node scripts/bench/relay-probe.mjs [--relay <url>] [--tag <release tag>] [--out <dir>]
//
// With no secret it checks the relay's TLS, routes, and refusals, a release's published assets, and
// times the Worker and its stream objects (relay-objects.mjs). It stores nothing on the relay.
//
// With PROBE_CLERK_REFRESH_TOKEN, a dedicated test account's Clerk refresh token from
// relay-probe-enroll.mjs, it also runs the release's real plxd as a throwaway host on that account:
// sign-in, registration, a new device's approval, and streams through the relay, timing the connect,
// the first event, and a round trip. Without the secret that part says so and skips.
//
// That part runs only on the account PROBE_CLERK_USER_ID names, a repo variable holding the test
// account's Clerk user id. It fails before registering anything when the variable is unset or the
// token is another account's, or when the account lists a computer this test didn't make. It first
// removes what an earlier run left, only hosts with this test's names, and fails before registering
// if the relay refuses or still lists one. It also fails if the account lists a computer at the end,
// since hosts left behind would fill the account's ten slots.
//
// When Clerk rotates the refresh token, the new one replaces PROBE_ROTATED_FILE in one rename, mode
// 0600, for the workflow or t3-compare.mjs to keep (PLX-1452). Tokens reach plxd only through its
// stdin and environment, and nothing printed or written to --out holds one. Exits 1 when a check
// failed. Slow numbers alone don't fail it, since a runner's network varies. Results:
// relay-probe.json, relay-probe.md, and relay-probe-notes.md.
import { execFileSync, spawn } from "node:child_process";
import { createHash, getRandomValues, randomBytes, randomUUID } from "node:crypto";
import { appendFileSync, chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import https from "node:https";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import tls from "node:tls";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import { count, summary } from "./timing-summary.mjs";
import { attach } from "../../packages/plx/src/plxd.mjs";
import { pickAsset, pickRelease, withSha256 } from "../../packages/plx/src/releases.mjs";
import { replacePrivately } from "./private-file.mjs";
import { plxdTrusts, probeClerk } from "./probe-clerk.mjs";

const { values: options } = parseArgs({
  options: {
    relay: { type: "string", default: "https://relay.parallax.codes" },
    connects: { type: "string", default: "5" },
    trips: { type: "string", default: "6" },
    "gap-ms": { type: "string", default: "2200" },
    timings: { type: "boolean", default: false },
    tag: { type: "string" },
    out: { type: "string", default: "." },
  },
});
const relay = options.relay.replace(/\/+$/, "");
const REPO = "ryan-stoffel/parallax";
const SETUP_ISSUE = "PLX-1385";
/** What this test names the hosts it makes, which it alone may remove. */
const PROBE_NAME = "relay-probe";
const HOST_NAMES = new Set([PROBE_NAME, "relay-objects bench"]);
const STREAMS = count(options.connects, "connects");
const ROUND_TRIPS = count(options.trips, "trips");
const GAP_MS = count(options["gap-ms"], "gap-ms", 60000);

// relay-probe.yml sets PROBE_SKIP_SIGNIN to stale when another run stored a rotated token after this
// attempt started, so this one holds a token Clerk already replaced, and Clerk revokes the
// account's tokens when one is used again. It sets unchecked when it couldn't read either time, so
// the token may be that older one. Either way the signed-in part skips (PLX-1460).
const SKIP_REASONS = {
  stale: "another run stored a newer refresh token after this run started",
  unchecked: "this run couldn't check that its refresh token is the newest",
};
const skipReason = SKIP_REASONS[/** @type {keyof typeof SKIP_REASONS} */ (process.env.PROBE_SKIP_SIGNIN ?? "")];
const withoutToken = skipReason ?? "PROBE_CLERK_REFRESH_TOKEN isn't set";
// Out of the environment plxd and relay-objects inherit.
let refreshToken = skipReason ? undefined : process.env.PROBE_CLERK_REFRESH_TOKEN;
const github = process.env.GITHUB_TOKEN;
const rotatedFile = process.env.PROBE_ROTATED_FILE;
const expectedUser = process.env.PROBE_CLERK_USER_ID;
delete process.env.PROBE_CLERK_REFRESH_TOKEN;
delete process.env.GITHUB_TOKEN;

const secrets = new Set(refreshToken ? [refreshToken] : []);
/** `text` with every token this run has seen, and anything shaped like a JWT, taken out. */
function clean(text) {
  let cleaned = String(text).replace(/eyJ[\w-]+\.[\w-]+\.[\w-]+/g, "[token]");
  for (const secret of secrets) cleaned = cleaned.replaceAll(secret, "[token]");
  return cleaned;
}

const checks = [];
const metrics = {};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const ms = (value) => Math.round(value);

/** Runs one named check, records how it went, and answers whether it passed. */
async function check(name, run) {
  try {
    const detail = clean((await run()) ?? "");
    checks.push({ name, ok: true, detail });
    console.log(`ok    ${name}${detail && `: ${detail}`}`);
    return true;
  } catch (error) {
    const detail = clean(error.message);
    checks.push({ name, ok: false, detail });
    console.log(`FAIL  ${name}: ${detail}`);
    return false;
  }
}

/** `work`, or an error naming `what` after `limit` milliseconds. */
function within(limit, what, work) {
  let timer;
  const late = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} took over ${limit / 1000} s`)), limit);
  });
  return Promise.race([work, late]).finally(() => clearTimeout(timer));
}

/** The status of one request on a new connection. A WebSocket that opens is dropped at once. */
function status(method, path, headers = {}) {
  const url = new URL(path, relay);
  const { request } = url.protocol === "https:" ? https : http;
  return new Promise((resolve, reject) => {
    const sent = request(url, { method, agent: false, headers, timeout: 15_000 }, (response) => {
      resolve(response.statusCode);
      response.destroy();
    });
    sent.on("upgrade", (response, socket) => {
      resolve(response.statusCode);
      socket.destroy();
    });
    sent.on("timeout", () => sent.destroy(new Error("no answer in 15 s")));
    sent.on("error", reject);
    sent.end();
  });
}

/** The relay's TLS: version, certificate life, and how long the connection and handshake took. */
function checkTls() {
  const { hostname, port } = new URL(relay);
  return new Promise((resolve, reject) => {
    const started = performance.now();
    let connected = started;
    const socket = tls.connect({ host: hostname, port: Number(port) || 443, servername: hostname }, () => {
      const version = socket.getProtocol();
      const days = (Date.parse(socket.getPeerCertificate().valid_to) - Date.now()) / 86_400_000;
      metrics.tcpMs = ms(connected - started);
      metrics.tlsMs = ms(performance.now() - connected);
      socket.destroy();
      if (version !== "TLSv1.3") reject(new Error(`negotiated ${version}, not TLSv1.3`));
      else if (days < 7) reject(new Error(`the certificate lapses in ${Math.floor(days)} days`));
      else resolve(`${version}, certificate good for ${Math.floor(days)} days`);
    });
    socket.once("connect", () => (connected = performance.now()));
    socket.on("error", reject);
    socket.setTimeout(15_000, () => socket.destroy(new Error("no answer in 15 s")));
  });
}

/** What the relay answers with no account: its pages, and a refusal on everything else. */
async function checkRoutes() {
  const stranger = Buffer.from(getRandomValues(new Uint8Array(32))).toString("base64url");
  const host = `/v1/hosts/${stranger}`;
  const socket = {
    connection: "Upgrade",
    upgrade: "websocket",
    "sec-websocket-version": "13",
    "sec-websocket-key": Buffer.from(getRandomValues(new Uint8Array(16))).toString("base64"),
  };
  const routes = [
    ["the sign-in code page answers", "GET", "/connect/code", {}, 200],
    ["an unknown path is not found", "GET", "/nope", {}, 404],
    ["listing computers needs a token", "GET", "/v1/hosts", {}, 401],
    ["a forged token is refused", "GET", "/v1/hosts", { authorization: "Bearer a.b.c" }, 401],
    ["registering a computer needs a token", "POST", "/v1/hosts", {}, 401],
    ["removing a computer needs a token", "DELETE", host, {}, 401],
    ["a ticket needs a token", "POST", `${host}/tickets`, {}, 401],
    ["registering a phone needs a token", "POST", "/v1/devices", {}, 401],
    ["a client's stream needs a token", "GET", `${host}/connect`, socket, 401],
    ["a client's stream needs a WebSocket", "GET", `${host}/connect`, {}, 426],
    ["a socket for an unknown computer is not found", "GET", `${host}/host`, socket, 404],
    ["a stream nobody armed is not found", "GET", `${host}/streams/${randomUUID()}?token=probe`, socket, 404],
    ["a malformed host id is not found", "GET", "/v1/hosts/short/connect", socket, 404],
    ["a webhook for an unknown computer is not found", "POST", `/v1/hooks/${stranger}/hook/token`, {}, 404],
  ];
  for (const [name, method, path, headers, expected] of routes) {
    await check(`Route: ${name}`, async () => {
      const answered = await status(method, path, headers);
      if (answered !== expected) throw new Error(`expected ${expected}, got ${answered}`);
      return String(answered);
    });
  }
}

/** The release to test: `tag`, else the newest nightly that had an hour to finish publishing. */
async function findRelease(tag) {
  const path = tag ? `releases/tags/${tag}` : "releases?per_page=30";
  const answer = await fetch(`https://api.github.com/repos/${REPO}/${path}`, {
    headers: {
      accept: "application/vnd.github+json",
      "user-agent": "relay-probe",
      ...(github && { authorization: `Bearer ${github}` }),
    },
    signal: AbortSignal.timeout(20_000),
  });
  if (!answer.ok) throw new Error(`GitHub answered ${answer.status} for ${path}`);
  const body = await answer.json();
  if (tag) return body;
  return pickRelease(body.filter((r) => Date.now() - Date.parse(r.published_at) > 3_600_000), "nightly");
}

/** Whether the release has every file an install and an update read, and its update file is its own. */
async function checkAssets(release) {
  const version = release.tag_name.replace(/^v/, "");
  const channel = release.tag_name.endsWith("-nightly") ? "nightly" : "latest";
  const installers = ["mac-arm64.dmg", "mac-arm64.zip", "win-x64.exe", "win-arm64.exe", "linux-x86_64.AppImage", "linux-arm64.AppImage"];
  const plxds = ["mac-arm64", "linux-x64", "linux-arm64", "win-x64.exe", "win-arm64.exe"];
  const manifests = ["", "-mac", "-linux", "-linux-arm64"];
  const expected = [
    ...installers.map((name) => `parallax-${version}-${name}`),
    ...plxds.map((name) => `parallax-plxd-${version}-${name}`),
    ...manifests.map((name) => `${channel}${name}.yml`),
    "SHA256SUMS",
  ];
  const names = new Set(release.assets.map((asset) => asset.name));
  await check("Release: every installer and update file is published", () => {
    const missing = expected.filter((name) => !names.has(name));
    if (release.draft) throw new Error(`${release.tag_name} is still a draft`);
    if (missing.length) throw new Error(`${release.tag_name} lacks ${missing.join(", ")}`);
    return `${expected.length} files on ${release.tag_name}`;
  });
  await check("Release: the update file names this version", async () => {
    const manifest = release.assets.find((asset) => asset.name === `${channel}-mac.yml`);
    if (!manifest) throw new Error(`no ${channel}-mac.yml to read`);
    const answer = await fetch(manifest.browser_download_url, { signal: AbortSignal.timeout(20_000) });
    if (!answer.ok) throw new Error(`downloading it answered ${answer.status}`);
    if (!(await answer.text()).includes(`version: ${version}`)) throw new Error(`it doesn't say ${version}`);
  });
}

/** Runs relay-objects.mjs, with the test account's token when there is one, and keeps its medians. */
function checkObjects(token) {
  return check("Relay: stream object times", () =>
    within(240_000, "relay-objects", new Promise((resolve, reject) => {
      const script = fileURLToPath(new URL("relay-objects.mjs", import.meta.url));
      const child = spawn(process.execPath, [script, relay], {
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, ...(token && { PLXD_TEST_RELAY_TOKEN: token }) },
      });
      let [out, err] = ["", ""];
      child.stdout.on("data", (chunk) => (out += chunk));
      child.stderr.on("data", (chunk) => (err += chunk));
      child.on("error", reject);
      child.on("close", (code) => {
        const rows = [...out.matchAll(/^(.+?)\s+median\s+(\d+) ms/gm)];
        metrics.objects = Object.fromEntries(rows.map(([, name, median]) => [name, Number(median)]));
        if (code === 0 && rows.length) resolve(`${rows.length} rows`);
        else reject(new Error(err.trim().split("\n").slice(-3).join(" ") || `it exited ${code}`));
      });
    })),
  );
}

// The test account's instance, development's until PLX-1457 (probe-clerk.mjs).
const clerk = probeClerk(process.env);
let rotated = false;

/** A new Clerk token for the test account, and the next refresh token if Clerk rotated it. */
async function clerkToken() {
  const answer = await fetch(`${clerk.api}/oauth/token`, {
    method: "POST",
    body: new URLSearchParams({ client_id: clerk.clientId, grant_type: "refresh_token", refresh_token: refreshToken }),
    signal: AbortSignal.timeout(15_000),
  });
  const body = await answer.json().catch(() => ({}));
  if (!answer.ok || typeof body.access_token !== "string") {
    // Clerk answers invalid_grant with one description for a malformed, expired, or revoked token
    // (PLX-1460), and a token already used can't be told apart from those, so this quotes Clerk.
    const said = typeof body.error_description === "string" ? ` ("${body.error_description}")` : "";
    const why =
      body.error === "invalid_grant"
        ? `it refused the stored refresh token with invalid_grant${said}. That answer doesn't say whether the token was already used, which points to two runs at once, or expired or was revoked. Run relay-probe-enroll.mjs again (${SETUP_ISSUE})`
        : `it answered ${answer.status}`;
    throw new Error(`Clerk gave no token: ${why}`);
  }
  secrets.add(body.access_token);
  if (typeof body.refresh_token === "string" && body.refresh_token !== refreshToken) {
    refreshToken = body.refresh_token;
    secrets.add(refreshToken);
    rotated = true;
    if (rotatedFile) replacePrivately(rotatedFile, refreshToken);
  }
  return body.access_token;
}

/** The hosts on the test account, from the relay. */
async function listHosts(token) {
  const answer = await fetch(`${relay}/v1/hosts`, {
    headers: { authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(15_000),
  });
  if (!answer.ok) throw new Error(`the relay answered ${answer.status} for the account's computers`);
  return (await answer.json()).hosts;
}

/** The Clerk user a token speaks for, from its claims. Clerk just issued it, so it isn't verified. */
function userOf(token) {
  try {
    return JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString()).sub;
  } catch {
    return undefined;
  }
}

/**
 * Stops on an account with a computer this test didn't make, removes what an earlier run left, and
 * stops if any remain, so a relay that can't remove them doesn't get another on each run.
 */
async function sweep(token) {
  const hosts = await listHosts(token);
  const others = hosts.filter((host) => !HOST_NAMES.has(host.name));
  if (others.length) {
    throw new Error(`the account has computers this test didn't make (${others.length}), so it isn't a test account`);
  }
  const left = hosts.filter((host) => !host.online);
  for (const { hostId } of left) {
    const answer = await fetch(`${relay}/v1/hosts/${hostId}`, {
      method: "DELETE",
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(15_000),
    });
    // A 404 is a host that's already gone.
    if (!answer.ok && answer.status !== 404) {
      throw new Error(`the relay answered ${answer.status} to removing a computer an earlier run left`);
    }
  }
  const remaining = await listHosts(token);
  if (remaining.length) throw new Error(`the relay still lists ${remaining.length} of this test's computers, so nothing was registered`);
  return left.length ? `removed ${left.length} left by an earlier run` : "no computers left by an earlier run";
}

/** The release's plxd for this OS, checked against its SHA-256, at `dir/plxd`. */
async function downloadPlxd(release, dir) {
  const os = { linux: "linux", darwin: "macos" }[process.platform];
  if (!os) throw new Error(`no plxd to test on ${process.platform}`);
  const { url, sha256 } = await withSha256(pickAsset(release, os, process.arch, true));
  const answer = await fetch(url, { signal: AbortSignal.timeout(180_000) });
  if (!answer.ok) throw new Error(`downloading it answered ${answer.status}`);
  const bytes = Buffer.from(await answer.arrayBuffer());
  if (createHash("sha256").update(bytes).digest("hex") !== sha256) throw new Error("its SHA-256 doesn't match the release's");
  const path = join(dir, "plxd");
  writeFileSync(path, bytes);
  chmodSync(path, 0o755);
  return path;
}

const freePort = () =>
  new Promise((resolve) => {
    const server = createServer().listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });

/** A UUIDv7, the form plxd takes for a new orchestrator's id. */
function uuid7() {
  const hex = Date.now().toString(16).padStart(12, "0") + randomBytes(10).toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-7${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20)}`;
}

/** A git repository for the orchestrator whose creation gives a stream an event to replay. */
function makeRepo(path) {
  mkdirSync(path);
  const git = (...args) => execFileSync("git", ["-c", "user.name=probe", "-c", "user.email=probe@example.com", ...args], { cwd: path, stdio: "ignore" });
  git("init", "-q", "--initial-branch=main");
  git("commit", "-q", "--allow-empty", "-m", "probe");
}

/** Keeps the end of a child's stderr, which says why it stopped. */
function stderrOf(child) {
  let said = "";
  child.stderr.on("data", (chunk) => (said = (said + chunk).slice(-500)));
  return () => said.trim();
}

/** One new stream: plxd dial over the relay, timed from its start. Answers the open connection. */
async function openStream(dial, token, stages = []) {
  const started = performance.now();
  const child = dial([], token);
  let diagnostic = "";
  child.stderr.on("data", (chunk) => {
    diagnostic = (diagnostic + chunk).slice(-8192);
    const lines = diagnostic.split("\n");
    diagnostic = lines.pop();
    for (const line of lines) {
      const match = /^(connect-(?:server-)?timing) ([a-z_]{1,40}) (\d{1,6}\.\d{3})$/.exec(line);
      if (match && stages.length < 64) stages.push({ kind: match[1], stage: match[2], ms: Number(match[3]), observedMs: ms(performance.now() - started) });
    }
  });
  const said = stderrOf(child);
  const exited = new Promise((_, reject) =>
    child.once("exit", (code) => reject(new Error(`plxd dial exited ${code}: ${said()}`))),
  );
  const connected = new Promise((resolve) => {
    let text = "";
    child.stderr.on("data", (chunk) => {
      text += chunk;
      if (text.includes("connected over relay:")) resolve(performance.now() - started);
    });
  });
  const firstEvent = new Promise((resolve) => {
    let text = "";
    child.stdout.on("data", (chunk) => {
      text += chunk;
      if (text.includes('"method":"events/event"')) resolve(performance.now() - started);
      text = text.slice(-30);
    });
  });
  // Handle exit even when an RPC fails before the next race with this promise.
  exited.catch(() => {});
  let app;
  try {
    // The first subscription goes behind `initialize`, as the apps send it (PLX-1480).
    app = await within(30_000, "the stream's first answer", Promise.race([attach(child, { subscribe: { after: 0 } }), exited]));
    const connectMs = await within(30_000, "connecting", Promise.race([connected, exited]));
    await app.subscribed;
    const firstEventMs = await within(30_000, "the first event", Promise.race([firstEvent, exited]));
    return { app, connectMs, firstEventMs, stages };
  } catch (error) {
    if (app) app.close();
    else child.kill();
    throw error;
  }
}

/**
 * The real thing with the test account: sign-in, a throwaway host running this release's plxd, a
 * new device's approval on it, then streams through the relay. Answers whether the account can be
 * used, so relay-objects stays off one that can't.
 */
async function checkSignedIn(release) {
  let token;
  if (!(await check("Sign-in: Clerk gives a token for the expected test account", async () => {
    if (!expectedUser) throw new Error(`PROBE_CLERK_USER_ID isn't set, so nothing says which account is the test account (${SETUP_ISSUE})`);
    const started = performance.now();
    token = await clerkToken();
    metrics.clerkMs = ms(performance.now() - started);
    if (userOf(token) !== expectedUser) throw new Error("the stored token isn't for the account PROBE_CLERK_USER_ID names, so nothing was registered");
  }))) return false;
  if (!(await check("Sign-in: only this test's computers, and old ones are gone", () => sweep(token)))) return false;

  const scratch = mkdtempSync(join(tmpdir(), "relay-probe-"));
  const [hostDir, clientDir, repo] = ["host", "client", "repo"].map((name) => join(scratch, name));
  let serve;
  let host;
  let hostId;
  try {
    let plxd;
    if (!(await check(`Host: download ${release.tag_name}'s plxd`, async () => {
      plxd = await downloadPlxd(release, scratch);
    }))) return true;
    // The release's plxd takes the test account's tokens, whatever instance it defaults to.
    const fakes = join(scratch, "bin");
    mkdirSync(fakes);
    writeFileSync(join(fakes, "tailscale"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
    const env = { ...process.env, PATH: `${fakes}:${process.env.PATH}`, ...plxdTrusts(clerk), PLXD_RELAY_URL: relay, PLXD_RELAY_TOKEN: undefined };

    const online = await check("Host: registers and comes online on the relay", async () => {
      const started = performance.now();
      serve = spawn(plxd, ["serve", "--data-dir", hostDir], {
        stdio: "ignore",
        env: { ...env, PLXD_REMOTE_PORT: String(await freePort()), PLXD_EXIT_WITH: String(process.pid) },
      });
      host = await attach(spawn(plxd, ["attach", "--data-dir", hostDir], { stdio: "pipe", env }));
      ({ hostId } = await host.call("relay/id"));
      await host.call("host/settings/set", { deviceName: PROBE_NAME });
      await host.call("relay/register", { token });
      await host.call("host/settings/set", { relay: true, remote: true });
      for (const deadline = Date.now() + 60_000; ; await sleep(250)) {
        const state = await host.call("remote/sessions");
        if (state.relay?.connected && state.listening) break;
        if (Date.now() > deadline) throw new Error(state.relay?.problem ?? state.problem ?? "it didn't connect in 60 s");
      }
      metrics.hostOnlineMs = ms(performance.now() - started);
      const listed = (await listHosts(token)).find((listedHost) => listedHost.hostId === hostId);
      if (!listed?.online) throw new Error("the relay doesn't list it online");
    });
    if (!online) return true;

    const route = `relay:${hostId}`;
    const dial = (args, relayToken) =>
      spawn(plxd, ["dial", route, `--account=${hostId}`, "--data-dir", clientDir, ...args], {
        stdio: "pipe",
        env: { ...env, PLXD_RELAY_TOKEN: relayToken, PLXD_CONNECT_TIMINGS: options.timings ? "1" : undefined },
      });

    const approved = await check("Approval: a new device waits, then is approved with a matching code", async () => {
      const started = performance.now();
      const child = dial(["--sign-in", "--name", PROBE_NAME], await clerkToken());
      const said = stderrOf(child);
      child.stdin.end(`${await clerkToken()}\n`);
      const out = createInterface({ input: child.stdout })[Symbol.asyncIterator]();
      const nextLine = async (what) => {
        const { value } = await within(60_000, what, out.next());
        if (!value) throw new Error(`plxd dial stopped before ${what}: ${said()}`);
        return JSON.parse(value);
      };
      const asked = await nextLine("its request");
      if (asked.status !== "pending") throw new Error(`a new device should wait, but it's ${asked.status}`);
      let state = await host.call("access/get");
      while (!state.pending?.code) {
        state = await within(30_000, "the request's code", host.call("access/get", { after: state.version }));
      }
      if (state.pending.code !== asked.code) throw new Error("the host and the device show different codes");
      await host.call("access/approve", { request: state.pending.id });
      const answered = await nextLine("its approval");
      if (answered.status !== "approved") throw new Error(`after approval it's ${answered.status}`);
      metrics.approvalMs = ms(performance.now() - started);
    });
    if (!approved) return true;

    await check("Stream: connect, first event, and round trip through the relay", async () => {
      makeRepo(repo);
      await host.call("orchestrator/create", { id: uuid7(), name: PROBE_NAME, repoPath: repo });
      const relayToken = await clerkToken();
      const [connect, firstEvent, trips] = [[], [], []];
      const stageSamples = [];
      try {
        await sleep(GAP_MS);
        (await openStream(dial, relayToken)).app.close(); // One uncounted warm-up, as on T3.

        for (let run = 0; run < STREAMS; run++) {
          // As in the relay's budget test: the app connects long after plxd opened its spare stream.
          await sleep(GAP_MS);
          const stages = [];
          if (options.timings) stageSamples.push(stages);
          const { app, connectMs, firstEventMs } = await openStream(dial, relayToken, stages);
          connect.push(connectMs);
          firstEvent.push(firstEventMs);
          try {
            if (run === STREAMS - 1) {
              await app.call("host/health"); // One uncounted RPC warm-up, as on T3.
              for (let trip = 0; trip < ROUND_TRIPS; trip++) {
                await sleep(100);
                const sent = performance.now();
                await within(15_000, "a round trip", app.call("host/health"));
                trips.push(performance.now() - sent);
              }
            }
          } finally {
            app.close();
          }
        }
      } finally {
        // A failed attempt must not discard earlier measurements or its own stage evidence.
        if (options.timings) metrics.stages = stageSamples;
        for (const [name, samples] of [["connect", connect], ["firstEvent", firstEvent], ["roundTrip", trips]]) {
          if (samples.length) {
            metrics[name] = summary(samples);
            metrics[`${name}Ms`] = metrics[name].medianMs;
          }
        }
      }
      return `medians of ${STREAMS} streams and ${ROUND_TRIPS} round trips`;
    });
    return true;
  } finally {
    await check("Cleanup: the throwaway host leaves the account", async () => {
      if (!host || !hostId) return "there was no host";
      const fresh = await clerkToken();
      await host.call("relay/remove", { token: fresh, hostId });
      const left = (await listHosts(fresh)).filter((listedHost) => listedHost.hostId === hostId);
      if (left.length) throw new Error("the relay still lists it");
    });
    host?.close();
    if (serve) {
      const gone = new Promise((resolve) => serve.once("exit", resolve));
      serve.kill();
      await within(15_000, "plxd stopping", gone).catch(() => serve.kill("SIGKILL"));
    }
    rmSync(scratch, { recursive: true, force: true });
  }
}

const number = (value, label) => (value === undefined ? undefined : `${label} ${value} ms`);
const line = (...parts) => parts.filter(Boolean).join(", ");

/** The results as the three files, and the job summary when there is one. */
function report(release, signedIn) {
  const ok = checks.every((item) => item.ok);
  const failed = checks.filter((item) => !item.ok);
  const run = process.env.GITHUB_RUN_ID
    ? `${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}`
    : undefined;
  const revokes = skipReason ? ", and an older token would make Clerk revoke the test account's tokens" : "";
  const skipped = `${withoutToken}${revokes}, so real sign-in, approval, and streams weren't tested`;
  // A run without the signed-in part didn't test sign-in, approval, or streams, so it doesn't say
  // passed, and it says why (PLX-1460).
  const outcome = ok ? (signedIn ? "passed" : "signed-in test skipped") : signedIn ? "FAILED" : "FAILED, signed-in test skipped";
  const verdict = `Connect check: ${outcome}${signedIn ? "" : ` (${withoutToken})`}`;
  const objects = metrics.objects ?? {};
  const relayLine = line(
    number(objects["Worker alone (no object)"], "Worker"),
    number(objects["stream, new object (no spare)"], "new stream"),
    number(objects["stream, existing object (spare)"], "spare stream"),
    number(objects["new named object"], "new named object"),
    number(objects["existing named object"], "existing named object"),
    number(metrics.tlsMs, "TLS"),
  );
  const accountLine = line(
    number(metrics.connectMs, "connect"),
    number(metrics.firstEventMs, "first event"),
    number(metrics.roundTripMs, "round trip"),
    number(metrics.approvalMs, "approval"),
    metrics.connect && `p95 connect ${metrics.connect.p95Ms} ms, first event ${metrics.firstEvent.p95Ms} ms`,
    metrics.roundTrip && `p95 round trip ${metrics.roundTrip.p95Ms} ms`,
  );

  const notes = [
    run ? `**${verdict}** ([run](${run}))` : `**${verdict}**`,
    "",
    ...failed.map(({ name, detail }) => `- Failed: ${name}: ${detail}`),
    relayLine && `- Relay: ${relayLine}`,
    signedIn ? accountLine && `- Signed in: ${accountLine}` : `- Signed-in test skipped: ${skipped}`,
  ].filter((text, index) => text || index === 1);

  const table = [
    `## ${verdict}`,
    "",
    `${relay}, ${new Date().toISOString()}${release ? `, ${release.tag_name}` : ""}`,
    "",
    ...(signedIn ? [] : [`**Signed-in test skipped:** ${skipped}. ${skipReason ? "See PLX-1460" : `Setup is on ${SETUP_ISSUE}`}.`, ""]),
    ...(rotated ? ["Clerk rotated the refresh token on this run.", ""] : []),
    "| Check | Result | Detail |",
    "| --- | --- | --- |",
    ...checks.map(({ name, ok: passed, detail }) => `| ${name} | ${passed ? "ok" : "**FAILED**"} | ${detail.replaceAll("|", "/")} |`),
    "",
    "| Number | Milliseconds |",
    "| --- | --- |",
    ...Object.entries({ ...metrics, stages: undefined, objects: undefined, ...objects })
      .filter(([, value]) => value !== undefined)
      .map(([name, value]) => `| ${name} | ${typeof value === "object" ? JSON.stringify(value) : value} |`),
    "",
  ];

  const json = { sampling: { connects: STREAMS, trips: ROUND_TRIPS, gapMs: GAP_MS, warmups: 1 }, at: new Date().toISOString(), relay, release: release?.tag_name, ok, signedIn, rotated, checks, metrics };
  mkdirSync(options.out, { recursive: true });
  writeFileSync(join(options.out, "relay-probe.json"), clean(`${JSON.stringify(json, null, 2)}\n`));
  writeFileSync(join(options.out, "relay-probe.md"), clean(table.join("\n")));
  writeFileSync(join(options.out, "relay-probe-notes.md"), clean(`${notes.join("\n")}\n`));
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, clean(table.join("\n")));
  console.log(`\n${clean(notes.join("\n"))}`);
  return ok;
}

let release;
if (new URL(relay).protocol === "https:") await check("TLS: the relay's certificate and version", checkTls);
await checkRoutes();
await check("Release: found", async () => {
  release = await findRelease(options.tag);
  return release.tag_name;
});
if (release) await checkAssets(release);

const signedIn = Boolean(refreshToken);
let usable = false;
let token;
if (signedIn && release) {
  usable = await checkSignedIn(release);
  if (usable) token = await clerkToken().catch(() => undefined);
} else if (!signedIn) {
  const where = process.env.GITHUB_ACTIONS ? (skipReason ? "::warning::" : "::notice::") : "";
  console.log(`${where}Signed-in test skipped: ${withoutToken} (${skipReason ? "PLX-1460" : SETUP_ISSUE}).`);
}
await checkObjects(token);
if (usable) {
  await check("Cleanup: the test account has no computers left", async () => {
    const left = await listHosts(await clerkToken());
    if (left.length) throw new Error(`the relay still lists ${left.length}, which the next run tries to remove`);
  });
}

process.exit(report(release, signedIn) ? 0 : 1);
