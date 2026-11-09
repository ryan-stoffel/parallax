#!/usr/bin/env node
// Counts serial round trips from `plxd dial` to the first event (PLX-1480). Run from the repo root
// with a built debug plxd: `node scripts/bench/round-trips.mjs [samples]`. For each added delay it
// starts `wrangler dev` through relay/scripts/e2e.mjs, which puts a TLS front and a fixed delay on
// each direction of every outer connection, the host's and the client's. A client-relay round trip
// then grows by 2 x delay and a client-host one by 4 x delay, so a stage's slope over 2 x delay is
// its count of client-relay round trips. Real plxd processes, disposable data dirs, a failing
// `tailscale` first on PATH, local signed test tokens. Never a production account.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { spawn, execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createServer } from "node:net";
import { attach } from "../../packages/plx/src/plxd.mjs";

const DELAYS = [0, 20, 50];
/** Stage boundaries, in the order `plxd dial` marks them. */
const SPANS = [
  ["outer TCP", "outer_connect_start", "outer_tcp_proxy_ready"],
  ["outer TLS", "outer_tcp_proxy_ready", "outer_tls_ready"],
  ["relay upgrade", "outer_tls_ready", "relay_upgrade_ready"],
  ["stream ready", "relay_upgrade_ready", "stream_ready"],
  ["inner TLS", "pinned_tls_start", "pinned_tls_ready"],
  ["inner WebSocket", "ws_upgrade_start", "ws_upgrade_ready"],
];
const median = values => {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};

if (!process.env.PLXD_TEST_RELAY_URL) {
  // Driver: one wrangler per delay, then slopes.
  const samples = process.argv[2] ?? "10";
  const results = {};
  for (const delay of DELAYS) {
    const out = execFileSync(process.execPath, ["relay/scripts/e2e.mjs", process.execPath, "scripts/bench/round-trips.mjs", samples],
      { env: { ...process.env, PLX_E2E_DELAY_MS: String(delay) }, stdio: ["ignore", "pipe", "inherit"], encoding: "utf8" });
    const line = out.split("\n").find(l => l.startsWith("{\"medians\""));
    assert(line, `no result at ${delay} ms`);
    results[delay] = JSON.parse(line).medians;
    console.error(`added ${delay} ms per direction: ${JSON.stringify(results[delay])}`);
  }
  const rows = Object.keys(results[0]);
  const slope = row => {
    const xs = DELAYS.map(d => 2 * d), ys = DELAYS.map(d => results[d][row]);
    const mx = xs.reduce((a, b) => a + b) / xs.length, my = ys.reduce((a, b) => a + b) / ys.length;
    return xs.reduce((s, x, i) => s + (x - mx) * (ys[i] - my), 0) / xs.reduce((s, x) => s + (x - mx) ** 2, 0);
  };
  console.log(`| Stage | ${DELAYS.map(d => `+${d} ms`).join(" | ")} | Client-relay round trips |`);
  console.log(`| --- | ${DELAYS.map(() => "---").join(" | ")} | --- |`);
  for (const row of rows) console.log(`| ${row} | ${DELAYS.map(d => results[d][row].toFixed(0)).join(" | ")} | ${slope(row).toFixed(2)} |`);
  process.exit(0);
}

const url = process.env.PLXD_TEST_RELAY_URL;
assert(new URL(url).hostname === "127.0.0.1", "run via relay/scripts/e2e.mjs");
const count = Number(process.argv[2] ?? 10);
const scratch = mkdtempSync(join(tmpdir(), "plx-round-trips-"));
const bin = join(scratch, "bin");
mkdirSync(bin);
writeFileSync(join(bin, "tailscale"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, PLXD_RELAY_URL: url, PLXD_RELAY_TOKEN: process.env.PLXD_TEST_RELAY_TOKEN };
const plxd = resolve(process.env.PLXD_PROOF_BINARY ?? "target/debug/plxd");
const port = await new Promise(resolve => { const s = createServer().listen(0, "127.0.0.1", () => { const port = s.address().port; s.close(() => resolve(port)); }); });
const children = [];
const start = (args, extra = {}) => { const child = spawn(plxd, args, { env: { ...env, ...extra }, stdio: "pipe" }); children.push(child); return child; };
const run = (args, input) => new Promise((resolve, reject) => {
  const child = start(args); let out = "";
  child.stdout.on("data", b => out += b);
  child.on("error", reject); child.on("exit", code => code === 0 ? resolve(JSON.parse(out)) : reject(new Error(`exited ${code}`)));
  child.stdin.end(input);
});
const sleep = ms => new Promise(r => setTimeout(r, ms));
const initialize = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocol: { min: 1, max: 1 }, client: { name: "round-trips", version: "0" }, capabilities: {} } });
const subscribe = JSON.stringify({ jsonrpc: "2.0", id: 2, method: "events/subscribe", params: { after: 0 } });
// The apps' first watch on a cold connect, the shell's thread list, done at its snapshot.
const shell = JSON.stringify({ jsonrpc: "2.0", id: 2, method: "orchestration/subscribeShell", params: {} });

/** One fresh `plxd dial`: stage marks, and when initialize's answer and the first event came,
 *  or, `app`, the shell watch's snapshot. */
async function sample(route, fingerprint, clientDir, pipelined, app = false) {
  const first = app ? shell : subscribe;
  const started = performance.now();
  const child = start(["dial", route, "--remote", fingerprint, "--data-dir", clientDir], { PLXD_CONNECT_TIMINGS: "1" });
  let err = "", buffer = "";
  const at = {};
  child.stderr.on("data", b => {
    err += b;
    if (at.connected === undefined && err.includes("connected over")) at.connected = performance.now() - started;
  });
  child.stdin.write(`${initialize}\n${pipelined ? `${first}\n` : ""}`);
  await new Promise((resolve, reject) => {
    child.once("exit", () => reject(new Error(`dial exited early: ${err}`)));
    child.stdout.on("data", b => {
      buffer += b;
      let newline;
      while ((newline = buffer.indexOf("\n")) >= 0) {
        const message = JSON.parse(buffer.slice(0, newline));
        buffer = buffer.slice(newline + 1);
        if (message.id === 1) {
          assert(message.result, "initialize failed");
          at.initialized = performance.now() - started;
          if (!pipelined) child.stdin.write(`${first}\n`);
        }
        if (app && message.id === 2) assert(message.result?.snapshot, "no shell snapshot");
        const done = app ? message.id === 2 : message.method === "events/event";
        if (done && at.event === undefined) {
          at.event = performance.now() - started;
          resolve();
        }
      }
    });
  });
  child.removeAllListeners("exit");
  child.stdin.end();
  await new Promise(r => child.exitCode === null ? child.once("exit", r) : r());
  const marks = {};
  for (const line of err.split("\n")) {
    const match = /^connect-timing ([a-z_]+) (\d+\.\d+)$/.exec(line);
    if (match && !(match[1] in marks)) marks[match[1]] = Number(match[2]);
  }
  const row = {};
  for (const [name, from, to] of SPANS) row[name] = marks[to] - marks[from];
  // From the external spawn timer, which includes process launch.
  row["spawn to connected"] = at.connected;
  row["connected to initialize answer"] = at.initialized - at.connected;
  row["connected to first event"] = at.event - at.connected;
  row["spawn to first event"] = at.event;
  return row;
}

let host;
const hostDir = join(scratch, "host"), clientDir = join(scratch, "client");
try {
  start(["serve", "--data-dir", hostDir], { PLXD_REMOTE_PORT: String(port), PLXD_REMOTE_ADDRESS: "127.0.0.1", PLXD_EXIT_WITH: String(process.pid) });
  host = await attach(start(["attach", "--data-dir", hostDir]));
  const { hostId } = await host.call("relay/id");
  await host.call("relay/register", { token: env.PLXD_RELAY_TOKEN });
  await host.call("host/settings/set", { relay: true, remote: true });
  const deadline = Date.now() + 15000;
  while (!((s) => s.relay?.connected && s.listening)(await host.call("remote/sessions"))) {
    assert(Date.now() < deadline, "host must come online");
    await sleep(100);
  }
  const route = `relay:${hostId}`;
  const { code } = await host.call("remote/pair", {});
  const paired = await run(["dial", route, "--pair", "--name", "round-trips", "--data-dir", clientDir], `${code}\n`);
  const repo = join(scratch, "repo");
  mkdirSync(repo);
  execFileSync("git", ["init", "-q", repo]);
  execFileSync("git", ["-c", "user.name=probe", "-c", "user.email=probe@example.com", "commit", "-q", "--allow-empty", "-m", "probe"], { cwd: repo });
  const hex = Date.now().toString(16).padStart(12, "0") + randomBytes(10).toString("hex");
  const id = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-7${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20)}`;
  await host.call("orchestrator/create", { id, name: "round-trips", repoPath: repo });
  // One uncounted warm-up, then alternate modes. The gap lets the host's spare refill and keeps
  // opens under the relay's 30 a minute.
  await sample(route, paired.fingerprint, clientDir, false);
  const modes = ["sequential", "pipelined", "app sequential", "app pipelined"];
  const rows = Object.fromEntries(modes.map(mode => [mode, []]));
  for (let i = 0; i < modes.length * count; i++) {
    await sleep(2100);
    const mode = modes[i % modes.length];
    rows[mode].push(await sample(route, paired.fingerprint, clientDir, mode.endsWith("pipelined"), mode.startsWith("app")));
  }
  const medians = {};
  for (const name of Object.keys(rows.sequential[0])) medians[name] = median(rows.sequential.map(r => r[name]));
  for (const name of ["connected to initialize answer", "connected to first event", "spawn to first event"]) {
    medians[`${name} (pipelined)`] = median(rows.pipelined.map(r => r[name]));
  }
  medians["app: connected to shell snapshot"] = median(rows["app sequential"].map(r => r["connected to first event"]));
  medians["app: connected to shell snapshot (pipelined)"] = median(rows["app pipelined"].map(r => r["connected to first event"]));
  console.log(JSON.stringify({ medians }));
} finally {
  host?.close();
  for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill();
  rmSync(scratch, { recursive: true, force: true });
}
