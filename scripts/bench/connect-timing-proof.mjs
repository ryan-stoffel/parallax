#!/usr/bin/env node
// Local real-binary proof. Run through relay/scripts/e2e.mjs, never a production account.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { spawn, execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createServer } from "node:net";
import { attach } from "../../packages/plx/src/plxd.mjs";
const url = process.env.PLXD_TEST_RELAY_URL;
assert(url && new URL(url).hostname === "127.0.0.1", "run via relay/scripts/e2e.mjs");
const scratch = mkdtempSync(join(tmpdir(), "plx-connect-timing-proof-"));
const bin = join(scratch, "bin");
mkdirSync(bin);
writeFileSync(join(bin, "tailscale"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, PLXD_RELAY_URL: url, PLXD_RELAY_TOKEN: process.env.PLXD_TEST_RELAY_TOKEN, PLXD_CONNECT_TIMINGS: "1" };
const plxd = resolve(process.env.PLXD_PROOF_BINARY ?? "target/debug/plxd");
const port = await new Promise(resolve => { const s = createServer().listen(0, "127.0.0.1", () => { const port = s.address().port; s.close(() => resolve(port)); }); });
const children = [];
const timeout = setTimeout(() => { console.error("proof timed out"); for (const child of children) child.kill(); }, 45000).unref();
const start = (args, extra = {}) => { const child = spawn(plxd, args, { env: { ...env, ...extra }, stdio: "pipe" }); children.push(child); return child; };
const run = (args, input) => new Promise((resolve, reject) => {
  const child = start(args); let out = "", err = "";
  child.stdout.on("data", b => out += b); child.stderr.on("data", b => err += b);
  child.on("error", reject); child.on("exit", code => code === 0 ? resolve(JSON.parse(out)) : reject(new Error(`pair exited ${code}`)));
  child.stdin.end(input);
});
let host;
const hostDir = join(scratch, "host"), clientDir = join(scratch, "client");
try {
  start(["serve", "--data-dir", hostDir], { PLXD_REMOTE_PORT: String(port), PLXD_REMOTE_ADDRESS: "127.0.0.1", PLXD_EXIT_WITH: String(process.pid) });
  host = await attach(start(["attach", "--data-dir", hostDir]));
  const { hostId } = await host.call("relay/id");
  await host.call("relay/register", { token: env.PLXD_RELAY_TOKEN });
  await host.call("host/settings/set", { relay: true, remote: true });
  const deadline = Date.now() + 15000;
  while (true) {
    const status = await host.call("remote/sessions");
    if (status.relay?.connected && status.listening) break;
    assert(Date.now() < deadline, "host must come online");
    await new Promise(r => setTimeout(r, 100));
  }
  const route = `relay:${hostId}`;
  const { code } = await host.call("remote/pair", {});
  const paired = await run(["dial", route, "--pair", "--name", "proof", "--data-dir", clientDir], `${code}\n`);
  await new Promise(r => setTimeout(r, 600));
  const repo = join(scratch, "repo");
  mkdirSync(repo);
  execFileSync("git", ["init", "-q", repo]);
  execFileSync("git", ["-c", "user.name=probe", "-c", "user.email=probe@example.com", "commit", "-q", "--allow-empty", "-m", "probe"], { cwd: repo });
  const hex = Date.now().toString(16).padStart(12, "0") + randomBytes(10).toString("hex");
  const id = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-7${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20)}`;
  await host.call("orchestrator/create", { id, name: "proof", repoPath: repo });
  const started = performance.now();
  const child = start(["dial", route, "--remote", paired.fingerprint, "--data-dir", clientDir]);
  let err = "";
  child.stderr.on("data", b => err += b);
  let firstEventMs;
  const event = new Promise((resolve, reject) => {
    child.once("exit", () => reject(new Error("dial exited before first event")));
    let buffer = "";
    child.stdout.on("data", b => {
      buffer += b;
      if (buffer.includes('"method":"events/event"')) { firstEventMs ??= performance.now() - started; resolve(); }
      buffer = buffer.slice(-64);
    });
  });
  event.catch(() => {});
  const app = await attach(child);
  await app.call("events/subscribe", { after: 0 });
  await event;
  await app.call("host/health");
  app.close();
  await new Promise(r => child.once("exit", r));
  const lines = err.split("\n").filter(s => s.startsWith("connect-"));
  for (const stage of ["main", "dial_start", "outer_connect_start", "outer_tcp_proxy_ready", "outer_tls_ready", "relay_upgrade_ready", "stream_ready", "pinned_tls_start", "pinned_tls_ready", "ws_upgrade_start", "ws_upgrade_ready", "connected", "first_frame"]) {
    assert(lines.some(s => s.startsWith(`connect-timing ${stage} `)), `missing ${stage}`);
  }
  assert(lines.some(s => s === "connect-server-timing spare 1.000"));
  assert(lines.length <= 64);
  assert(lines.every(s => /^connect-(server-)?timing [a-z_]+ \d+\.\d{3}$/.test(s)));
  console.log(`Local real-binary connect + initialize + health: ${Math.round(performance.now() - started)} ms`);
  console.log(lines.join("\n"));
  console.log(`External first events/event observed: ${Math.round(firstEventMs)} ms`);
  const normal = start(["dial", route, "--remote", paired.fingerprint, "--data-dir", clientDir], { PLXD_CONNECT_TIMINGS: undefined });
  let normalErr = "";
  normal.stderr.on("data", b => normalErr += b);
  const normalApp = await attach(normal);
  await normalApp.call("host/health");
  assert(!normalErr.includes("connect-timing") && !normalErr.includes("connect-server-timing"));
  normalApp.close();
  console.log("Uninstrumented dial + initialize + health: passed, no timing lines");
} finally {
  if (host) await host.call("relay/remove", { token: env.PLXD_RELAY_TOKEN, hostId: (await host.call("relay/id")).hostId }).catch(() => {});
  host?.close();
  await Promise.all(children.filter(c => c.exitCode === null && c.signalCode === null).map(c => new Promise(resolve => {
    c.once("exit", resolve);
    c.kill();
  })));
  clearTimeout(timeout);
  rmSync(scratch, { recursive: true, force: true });
}
