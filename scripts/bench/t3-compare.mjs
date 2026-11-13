#!/usr/bin/env node
// Times T3 Connect and the Parallax relay from this computer, on whatever network it's on (PLX-1167,
// weakness 5 of PLX-1347). Run it on each network being compared.
//
// Once per computer, enroll the relay's test account into a local file. Open the link it prints in
// a private window and sign in as the test account:
//
//     node scripts/bench/relay-probe-enroll.mjs --file ~/.config/parallax/probe-token
//
// Then, on each network:
//
//     node scripts/bench/t3-compare.mjs --token-file ~/.config/parallax/probe-token --out t3-compare.jsonl
//
// Other options: [--parallax-tag <exact-release-tag>] [--gap-ms 2200] [--plxd <path>] [--parallax-only]
// --plxd times a plxd built here instead of a release's. --parallax-only skips T3, for comparing
// two Parallax builds on one network.
// Sampling gap defaults to 2200 ms on both sides to respect the relay's 30 opens/minute.
// Other options: [--connects 30] [--trips 50] [--version latest].
//
// T3 side: it signs in with T3's device grant, which prints a link and a code to approve, and links
// one computer, which holds one of the T3 account's 3 free slots while it runs. It runs `t3 serve` in
// the foreground with its own T3CODE_HOME, so a real ~/.t3 and any background service stay untouched,
// and with no provider CLI on PATH, so no AI usage. It times this computer reaching that server
// through its Cloudflare tunnel, then unlinks, signs out, and deletes the home. With T3CODE_HOME set
// it uses that home and keeps it. Both ends of the tunnel are on this computer, so a slow network
// counts twice. t3-tunnel.mjs finds the tunnel. When it doesn't answer within 4 minutes, the error
// names the last step reached and T3's own verdict from `t3 connect status`.
//
// A connect is a ticket POST on a new connection, then a WebSocket on another, which is T3's path for
// a client that already holds a session. It skips the relay call a client makes to get its first
// session. The first event is the first chunk of subscribeServerLifecycle, and a round trip is
// server.probe on one open socket.
//
// Parallax side: it runs relay-probe.mjs. With --token-file, relay-probe signs in as the test
// account with that file's refresh token and times a real stream to a throwaway computer. A token
// Clerk rotates is written back to the same file. The test account's id comes from the repo
// variable PROBE_CLERK_USER_ID through `gh`, which is where enroll reads it, unless the environment
// sets PROBE_CLERK_USER_ID. The file is its own Clerk session, so CI's stored token isn't rotated
// away. With no token, relay-probe times only the relay's Worker and
// stream objects, not a stream to a computer (PLX-1385).
//
// Nothing printed or written holds a token or ticket, and the tunnel's name stays out of the results.
// A failure or crash at any point still signs out, stops T3, and removes the temporary home.
import { execFile, execFileSync, spawn, spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import https from "node:https";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve as absolute } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import { count, summary } from "./timing-summary.mjs";
import { tunnelHost } from "./t3-tunnel.mjs";

const { values: options } = parseArgs({
  options: {
    connects: { type: "string", default: "30" },
    trips: { type: "string", default: "50" },
    timings: { type: "boolean", default: false },
    "parallax-tag": { type: "string" },
    plxd: { type: "string" },
    "parallax-only": { type: "boolean", default: false },
    "gap-ms": { type: "string", default: "2200" },
    version: { type: "string", default: "latest" },
    out: { type: "string" },
    "token-file": { type: "string" },
  },
});

count(options.connects, "connects");
count(options.trips, "trips");
count(options["gap-ms"], "gap-ms", 60000);

// Read before T3 starts, so a missing file or account fails in seconds, not after T3's run.
const probeEnv = {};
if (options["token-file"]) {
  const tokenFile = absolute(options["token-file"]);
  let token = "";
  try {
    token = readFileSync(tokenFile, "utf8").trim();
  } catch {}
  if (!token) {
    console.error(`No token in ${tokenFile}. Run: node scripts/bench/relay-probe-enroll.mjs --file ${tokenFile}`);
    process.exit(1);
  }
  let user = process.env.PROBE_CLERK_USER_ID?.trim();
  if (!user) {
    const variable = spawnSync("gh", ["variable", "get", "PROBE_CLERK_USER_ID", "--repo", "ryan-stoffel/parallax"], { encoding: "utf8" });
    user = variable.status === 0 ? variable.stdout.trim() : "";
  }
  if (!user) {
    console.error("Set PROBE_CLERK_USER_ID, or the repo variable of that name, to the test account's Clerk user id.");
    process.exit(1);
  }
  Object.assign(probeEnv, { PROBE_CLERK_REFRESH_TOKEN: token, PROBE_ROTATED_FILE: tokenFile, PROBE_CLERK_USER_ID: user });
}

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

/**
 * What `t3 connect status` says of the tunnel. T3's status and cause are labels such as
 * "unreachable" and "dns_failed", and anything else is left out, so no hostname can be printed.
 */
async function connectVerdict() {
  const label = (/** @type {unknown} */ value) => (typeof value === "string" && /^[a-z_]{1,40}$/.test(value) ? value : null);
  try {
    const { reachability } = JSON.parse(await within(60_000, "t3 connect status", quiet(t3, ["connect", "status", "--json"])));
    if (!reachability) return "T3 didn't check the tunnel";
    const cause = label(reachability.cause);
    return `T3 says it's ${label(reachability.status) ?? "in an unknown state"}${cause ? ` (${cause})` : ""}`;
  } catch {
    return "T3's own status couldn't be read";
  }
}

/** Posts for a ticket on a new connection, with no keep-alive to reuse. */
function ticket(base, token) {
  const url = new URL("/api/auth/websocket-ticket/rpc", base);
  const headers = { authorization: `Bearer ${token}`, "content-length": 0 };
  return new Promise((resolve, reject) => {
    const sent = https.request(url, { method: "POST", agent: false, headers }, (response) => {
      let body = "";
      response.on("data", (chunk) => (body += chunk));
      response.on("end", () => {
        if (response.statusCode !== 200) return reject(new Error(`the ticket answered ${response.statusCode}`));
        // JSON.parse's error quotes the text it read, which could be part of a ticket.
        try {
          resolve(JSON.parse(body).ticket);
        } catch {
          reject(new Error("the ticket's answer wasn't JSON"));
        }
      });
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
    try {
      for (const message of [JSON.parse(data)].flat()) {
        if (message._tag === "Ping") socket.send(JSON.stringify({ _tag: "Pong" }));
        const answer = waiting.get(message.requestId);
        if (!answer) continue;
        if (message._tag === "Chunk") socket.send(JSON.stringify({ _tag: "Ack", requestId: message.requestId }));
        answer(message);
      }
    } catch {
      // A frame this can't read fails whatever is waiting, with nothing from the frame in the error.
      for (const answer of waiting.values()) answer({ _tag: "Exit" });
      socket.close();
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

/** Times `connects` connects with their first events, then `trips` round trips on one socket. */
async function measure(base, token) {
  const [connects, firstEvents, trips] = [[], [], []];
  // One warm-up, not counted, so a cold DNS lookup doesn't land in the samples.
  (await connectOnce(base, token)).session.socket.close();
  for (let run = 0; run < Number(options.connects); run++) {
    await sleep(Number(options["gap-ms"]));
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
let cleaning;
/** Unlinks while the server still runs, so its tunnel stops, then stops the server and removes what this made. Runs once. */
function cleanUp() {
  cleaning ??= unlinkAndStop();
  return cleaning;
}
async function unlinkAndStop() {
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
// Anything thrown outside the try below, as in an event handler, still signs out and stops T3. Only
// the error's name is printed, since its message can quote what a server sent.
for (const event of ["uncaughtException", "unhandledRejection"]) {
  process.on(event, (error) => {
    console.error(`t3-compare crashed (${error?.name ?? "unknown error"}), so it's cleaning up and stopping.`);
    cleanUp().finally(() => process.exit(1));
  });
}

let failed = false;
if (options["parallax-only"]) {
  console.log("--parallax-only, so T3 isn't timed.");
  await cleanUp();
} else try {
  // Only this step sees the real PATH, since npx needn't sit beside node. It just downloads T3.
  await attached("npx", ["--yes", `t3@${options.version}`, "--version"], { ...env, PATH: `${env.PATH}:${process.env.PATH}` });
  const version = readdirSync(join(home, "runtime", "versions")).filter((name) => !name.includes(".staging")).at(-1);
  t3 = join(home, "runtime", "versions", version, "t3");
  linked = true;
  await attached(t3, ["connect", "link", "--headless"]);

  const work = join(scratch, "work");
  mkdirSync(work);
  // Its output holds a pairing token, so it goes nowhere.
  const port = await freePort();
  server = spawn(t3, ["serve", "--port", String(port), "--no-browser", work], { env, stdio: "ignore" });
  console.log("Waiting for T3's tunnel...");
  const host = await tunnelHost(port, home).catch(async (error) => {
    throw new Error(`${error.message}. ${await connectVerdict()}`);
  });
  const base = `https://${host}`;
  const issued = await quiet(t3, ["auth", "session", "issue", "--token-only", "--ttl", "1h", "--label", "t3-compare"]);
  const token = issued.split("\n").find((line) => line.trim() && !line.includes(" ")).trim();
  secrets.add(token);

  console.log(`Timing T3 ${version} through its tunnel: ${options.connects} connects, ${options.trips} round trips...`);
  const results = {
    at: new Date().toISOString(),
    t3Version: version,
    route: "this computer, Cloudflare tunnel, this computer",
    sampling: { connects: Number(options.connects), trips: Number(options.trips), gapMs: Number(options["gap-ms"]), warmups: 1 },
    caveats: [
      "Both ends of the tunnel are on this computer, so a slow network counts twice.",
      "A connect skips the relay call a client makes to get its first session.",
      "Parallax includes a new dial process per connect, pinned inner TLS and DPoP. T3 uses this existing Node process and Cloudflare terminates TLS.",
      "Parallax dials as its desktop app does away from home: a LAN route that doesn't answer, then the relay 200 ms later, so its connect includes that head start (PLX-1549).",
      "First events and RPCs differ: T3 lifecycle/server.probe; Parallax event replay/host/health. Setup, approval and tunnel provisioning are excluded.",
      "One warm-up precedes counted connects and RPCs. OS DNS and host state may be warm; each Parallax dial starts fresh. Spares are not guaranteed by a fixed gap.",
    ],
    ...(await measure(base, token)),
  };
  console.log(JSON.stringify(results, null, 2));
  if (options.out) writeFileSync(options.out, `${JSON.stringify(results)}\n`, { flag: "a" });
} catch (error) {
  failed = true;
  console.error(clean(error?.message ?? error));
} finally {
  await cleanUp();
}

console.log("\nParallax relay:");
if (!probeEnv.PROBE_CLERK_REFRESH_TOKEN && !process.env.PROBE_CLERK_REFRESH_TOKEN) {
  console.log("No --token-file, so these times stop at the relay's Worker and stream objects. They time no stream to a computer, so they aren't comparable with T3's numbers (PLX-1385).");
}
const probeFile = join(dirname(fileURLToPath(import.meta.url)), "relay-probe.mjs");
const outDir = mkdtempSync(join(tmpdir(), "t3-compare-probe-"));
try {
  execFileSync(process.execPath, [probeFile, "--out", outDir, "--connects", options.connects, "--trips", options.trips, "--gap-ms", options["gap-ms"], ...(options.timings ? ["--timings"] : []), ...(options["parallax-tag"] ? ["--tag", options["parallax-tag"]] : []), ...(options.plxd ? ["--plxd", absolute(options.plxd)] : [])], {
    env: { ...process.env, ...probeEnv, PATH: env.PATH },
    stdio: "inherit",
  });
} catch {
  failed = true;
} finally {
  try {
    const result = JSON.parse(readFileSync(join(outDir, "relay-probe.json"), "utf8"));
    if (options.out) writeFileSync(options.out, `${JSON.stringify({ product: "parallax", ...result })}\n`, { flag: "a" });
  } catch {}
  rmSync(outDir, { recursive: true, force: true });
}
process.exit(failed ? 1 : 0);
