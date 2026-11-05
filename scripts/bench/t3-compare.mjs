#!/usr/bin/env node
// Times T3 Connect and the Parallax relay from this computer, on whatever network it's on (PLX-1167,
// weakness 5 of PLX-1347). Run it on each network being compared.
//
//     node scripts/bench/t3-compare.mjs [--connects 30] [--trips 50] [--version latest] [--out file]
//
// T3 side: it signs in with T3's device grant, which prints a link and a code to approve, and links
// one computer, which holds one of the T3 account's 3 free slots while it runs. It runs `t3 serve` in
// the foreground with its own T3CODE_HOME, so a real ~/.t3 and any background service stay untouched,
// and with no provider CLI on PATH, so no AI usage. It times this computer reaching that server
// through its Cloudflare tunnel, then unlinks, signs out, and deletes the home. With T3CODE_HOME set
// it uses that home and keeps it. Both ends of the tunnel are on this computer, so a slow network
// counts twice.
//
// A connect is a ticket POST on a new connection, then a WebSocket on another, which is T3's path for
// a client that already holds a session. It skips the relay call a client makes to get its first
// session. The first event is the first chunk of subscribeServerLifecycle, and a round trip is
// server.probe on one open socket.
//
// Parallax side: it runs relay-probe.mjs. With no PROBE_CLERK_REFRESH_TOKEN that times only the
// relay's Worker and stream objects, not a stream to a computer (PLX-1385).
//
// Nothing printed or written holds a token or ticket, and the tunnel's name stays out of the results.
import { execFile, execFileSync, spawn } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import https from "node:https";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const { values: options } = parseArgs({
  options: {
    connects: { type: "string", default: "30" },
    trips: { type: "string", default: "50" },
    version: { type: "string", default: "latest" },
    out: { type: "string" },
  },
});

const scratch = mkdtempSync(join(tmpdir(), "t3-compare-"));
const home = process.env.T3CODE_HOME ?? join(scratch, "t3");
const fakes = join(scratch, "bin");
mkdirSync(fakes);
// T3 and plxd look at Tailscale, and a service install would need launchctl. Neither may be real.
for (const name of ["tailscale", "launchctl"]) {
  writeFileSync(join(fakes, name), "#!/bin/sh\nexit 1\n");
  chmodSync(join(fakes, name), 0o755);
}
const env = {
  ...process.env,
  T3CODE_HOME: home,
  PATH: [fakes, dirname(process.execPath), "/usr/bin", "/bin"].join(":"),
  DO_NOT_TRACK: "1",
  T3CODE_TELEMETRY_ENABLED: "false",
  NO_COLOR: "1",
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const secrets = new Set();
function clean(text) {
  let cleaned = String(text).replace(/wsTicket=[^&\s"]+/g, "wsTicket=[ticket]");
  for (const secret of secrets) cleaned = cleaned.replaceAll(secret, "[secret]");
  return cleaned;
}

function within(limit, what, work) {
  let timer;
  const late = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} took over ${limit / 1000} s`)), limit);
  });
  return Promise.race([work, late]).finally(() => clearTimeout(timer));
}

/** Runs to the end with the terminal attached, for a sign-in that prints a link and may ask to install cloudflared. */
function attached(command, args, childEnv = env) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { env: childEnv, stdio: "inherit" });
    child.once("error", reject);
    child.once("exit", (code) => (code === 0 ? resolve() : reject(new Error(`${args.join(" ")} exited ${code}`))));
  });
}

/** The output of a `t3` command, with its logs thrown away. */
const quiet = (t3, args) =>
  new Promise((resolve, reject) => {
    execFile(t3, [...args, "--log-level", "error"], { env }, (error, stdout) =>
      error ? reject(new Error(`t3 ${args[0]} ${args[1]} failed`)) : resolve(stdout),
    );
  });

const freePort = () =>
  new Promise((resolve) => {
    const server = createServer().listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });

/** The pid of the cloudflared `root` started, or null while it hasn't. */
function connectorOf(root) {
  const rows = execFileSync("ps", ["-axo", "pid=,ppid=,comm="], { encoding: "utf8" })
    .split("\n")
    .map((line) => line.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/))
    .filter(Boolean)
    .map(([, pid, ppid, comm]) => ({ pid: Number(pid), ppid: Number(ppid), comm }));
  const family = new Set([root]);
  for (let grew = true; grew; ) {
    grew = false;
    for (const row of rows) {
      if (family.has(row.ppid) && !family.has(row.pid)) {
        family.add(row.pid);
        grew = true;
      }
    }
  }
  return rows.find((row) => family.has(row.pid) && row.comm.endsWith("cloudflared"))?.pid ?? null;
}

/** Waits for the tunnel to be up and answering, and returns its public hostname. */
async function tunnelHost(serverPid) {
  const deadline = Date.now() + 240_000;
  for (; Date.now() < deadline; await sleep(1000)) {
    const pid = connectorOf(serverPid);
    if (!pid) continue;
    let listing = "";
    try {
      // lsof exits 1 until the connector listens on its metrics port.
      listing = execFileSync("lsof", ["-nP", "-a", "-p", String(pid), "-iTCP", "-sTCP:LISTEN", "-Fn"], { encoding: "utf8" });
    } catch {
      continue;
    }
    const port = /:(\d+)$/m.exec(listing)?.[1];
    if (!port) continue;
    const config = await fetch(`http://127.0.0.1:${port}/config`).then((answer) => answer.json()).catch(() => null);
    const hostname = config?.config?.ingress?.find((rule) => rule.hostname)?.hostname;
    if (!hostname) continue;
    const answer = await fetch(`https://${hostname}/.well-known/t3/environment`).catch(() => null);
    if (answer?.status === 200) return hostname;
  }
  throw new Error("T3's tunnel didn't answer in 4 minutes");
}

/** Posts for a ticket on a new connection, with no keep-alive to reuse. */
function ticket(base, token) {
  const url = new URL("/api/auth/websocket-ticket/rpc", base);
  const headers = { authorization: `Bearer ${token}`, "content-length": 0 };
  return new Promise((resolve, reject) => {
    const sent = https.request(url, { method: "POST", agent: false, headers }, (response) => {
      let body = "";
      response.on("data", (chunk) => (body += chunk));
      response.on("end", () =>
        response.statusCode === 200 ? resolve(JSON.parse(body).ticket) : reject(new Error(`the ticket answered ${response.statusCode}`)),
      );
    });
    sent.on("error", reject);
    sent.end();
  });
}

/** One socket, routing each RPC answer and chunk to its request. */
function open(base, wsTicket) {
  const url = new URL("/ws", base);
  url.protocol = "wss:";
  url.searchParams.set("wsTicket", wsTicket);
  url.searchParams.set("orchestrationProtocol", "2");
  url.searchParams.set("clientSurface", "web");
  const socket = new WebSocket(url);
  const waiting = new Map();
  let nextId = 1;
  socket.addEventListener("message", ({ data }) => {
    for (const message of [JSON.parse(data)].flat()) {
      if (message._tag === "Ping") socket.send(JSON.stringify({ _tag: "Pong" }));
      const answer = waiting.get(message.requestId);
      if (!answer) continue;
      if (message._tag === "Chunk") socket.send(JSON.stringify({ _tag: "Ack", requestId: message.requestId }));
      answer(message);
    }
  });
  const call = (tag, onMessage) => {
    const id = String(nextId++);
    waiting.set(id, onMessage);
    socket.send(JSON.stringify({ _tag: "Request", id, tag, payload: {}, headers: [] }));
  };
  const opened = new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve, { once: true });
    socket.addEventListener("error", () => reject(new Error("the socket failed")), { once: true });
  });
  return { socket, call, opened };
}

const probe = (session) =>
  new Promise((resolve, reject) =>
    session.call("server.probe", ({ _tag, exit }) => {
      if (_tag !== "Exit") return;
      if (exit?._tag === "Success") resolve();
      else reject(new Error("server.probe failed"));
    }),
  );

async function connectOnce(base, token) {
  const start = performance.now();
  const session = open(base, await within(30_000, "the ticket", ticket(base, token)));
  await within(30_000, "the socket", session.opened);
  const connectMs = performance.now() - start;
  const firstEvent = new Promise((resolve, reject) =>
    session.call("subscribeServerLifecycle", ({ _tag }) => {
      if (_tag === "Chunk") resolve(performance.now() - start);
      else if (_tag === "Exit") reject(new Error("the lifecycle stream ended"));
    }),
  );
  return { session, connectMs, firstEventMs: await within(30_000, "the first event", firstEvent) };
}

function summary(samples) {
  const sorted = samples.toSorted((a, b) => a - b);
  const middle = sorted.length / 2;
  const median = sorted.length % 2 ? sorted[Math.floor(middle)] : (sorted[middle - 1] + sorted[middle]) / 2;
  const p95 = sorted[Math.max(0, Math.ceil(0.95 * sorted.length) - 1)];
  return { n: sorted.length, medianMs: Math.round(median), p95Ms: Math.round(p95) };
}

/** Times `connects` connects with their first events, then `trips` round trips on one socket. */
async function measure(base, token) {
  const [connects, firstEvents, trips] = [[], [], []];
  // One warm-up, not counted, so a cold DNS lookup doesn't land in the samples.
  (await connectOnce(base, token)).session.socket.close();
  for (let run = 0; run < Number(options.connects); run++) {
    await sleep(500);
    const { session, connectMs, firstEventMs } = await connectOnce(base, token);
    connects.push(connectMs);
    firstEvents.push(firstEventMs);
    session.socket.close();
  }
  const { session } = await connectOnce(base, token);
  await probe(session);
  for (let trip = 0; trip < Number(options.trips); trip++) {
    await sleep(100);
    const sent = performance.now();
    await within(15_000, "a round trip", probe(session));
    trips.push(performance.now() - sent);
  }
  session.socket.close();
  return { connect: summary(connects), firstEvent: summary(firstEvents), roundTrip: summary(trips) };
}

let server;
let t3;
let linked = false;
/** Unlinks while the server still runs, so its tunnel stops, then stops the server and removes what this made. */
async function cleanUp() {
  if (linked && t3) {
    linked = false;
    // Logout exits 0 even when the relay refused, so its words are the only sign the computer left.
    const said = await within(60_000, "signing out", quiet(t3, ["connect", "logout"])).catch((error) => clean(error.message));
    console.log(
      said.includes("Revoked the relay-side environment record")
        ? "T3 Connect: this computer is unlinked and signed out."
        : "T3 Connect: signed out here, but the relay didn't confirm the unlink. Deregister this computer on T3's account page, under T3 Connect.",
    );
  }
  if (server?.exitCode === null) {
    const stopped = new Promise((resolve) => server.once("exit", resolve));
    server.kill("SIGTERM");
    await within(15_000, "stopping T3", stopped).catch(() => server.kill("SIGKILL"));
  }
  rmSync(scratch, { recursive: true, force: true });
}
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => cleanUp().finally(() => process.exit(130)));
}

let failed = false;
try {
  // Only this step sees the real PATH, since npx needn't sit beside node. It just downloads T3.
  await attached("npx", ["--yes", `t3@${options.version}`, "--version"], { ...env, PATH: `${env.PATH}:${process.env.PATH}` });
  const version = readdirSync(join(home, "runtime", "versions")).filter((name) => !name.includes(".staging")).at(-1);
  t3 = join(home, "runtime", "versions", version, "t3");
  linked = true;
  await attached(t3, ["connect", "link", "--headless"]);

  const work = join(scratch, "work");
  mkdirSync(work);
  // Its output holds a pairing token, so it goes nowhere.
  server = spawn(t3, ["serve", "--port", String(await freePort()), "--no-browser", work], { env, stdio: "ignore" });
  console.log("Waiting for T3's tunnel...");
  const base = `https://${await tunnelHost(server.pid)}`;
  const issued = await quiet(t3, ["auth", "session", "issue", "--token-only", "--ttl", "1h", "--label", "t3-compare"]);
  const token = issued.split("\n").find((line) => line.trim() && !line.includes(" ")).trim();
  secrets.add(token);

  console.log(`Timing T3 ${version} through its tunnel: ${options.connects} connects, ${options.trips} round trips...`);
  const results = { at: new Date().toISOString(), t3Version: version, route: "this computer, Cloudflare tunnel, this computer", ...(await measure(base, token)) };
  console.log(JSON.stringify(results, null, 2));
  if (options.out) writeFileSync(options.out, `${JSON.stringify(results)}\n`, { flag: "a" });
} catch (error) {
  failed = true;
  console.error(clean(error?.message ?? error));
} finally {
  await cleanUp();
}

console.log("\nParallax relay:");
const probeFile = join(dirname(fileURLToPath(import.meta.url)), "relay-probe.mjs");
const outDir = mkdtempSync(join(tmpdir(), "t3-compare-probe-"));
try {
  execFileSync(process.execPath, [probeFile, "--out", outDir], {
    env: { ...process.env, PATH: env.PATH },
    stdio: "inherit",
  });
} catch {
  failed = true;
} finally {
  rmSync(outDir, { recursive: true, force: true });
}
process.exit(failed ? 1 : 0);
