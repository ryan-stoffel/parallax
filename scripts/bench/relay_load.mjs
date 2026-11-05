#!/usr/bin/env node
// Load test of Parallax Relay (PLX-1359): a real plxd and `plxd dial` through `wrangler dev`, with
// a proxy between them and the Worker that counts what the relay counts and can slow the client.
//
//   cargo build -p plxd
//   cd relay && corepack pnpm install --frozen-lockfile && cd ..
//   node relay/scripts/e2e.mjs node scripts/bench/relay_load.mjs <plxd> --scenario NAME \
//     [--rate BYTES_PER_S] [--seconds N] [--file-mib N] [--parallel N] [--out out.json]
//
// One scenario per run, so each has a fresh Worker's memory and a fresh host's daily budget:
//   yes       `yes` in a terminal for --seconds, to a fast client
//   log       1,000 flushed lines a second, as a noisy build prints them, to a fast client
//   flood     build lines as fast as a terminal takes them, to a client at --rate (0: fast)
//   typing    keystrokes into `cat`, and how long each echo takes, idle and in quick bursts
//   beside    the same keystrokes while another terminal runs `yes`
//   noisy     keystrokes into a terminal printing 20 lines a second, 120 ms and 1.5 s apart
//   file      a file read in the app's 256 KiB slices, --parallel at a time, to a client at --rate
//   push      `yes` to a client at --rate: output nothing paces, the worst case for the relay
//   recover   --file-mib MiB of `yes` in a terminal, then keystrokes into `cat` in that terminal
//
// Each reports the frames and counted bytes the relay would add to the host's day (each binary
// frame counts as at least 16 KiB, relay/src/stream.ts), what the client got, `host/health` round
// trips (the app's liveness check gives up after 10 s), the Worker's request latency (GET
// /v1/hosts every 2 s, which runs in the isolate, unlike the control socket's auto-answered ping),
// how long a second client takes to dial (which needs the host's object and control socket), the
// memory of workerd, and any socket that closed, with its close code.
//
// workerd enforces no memory limit locally, so memory here is a measurement, not a reset.
import { execFileSync, spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { connect, createServer } from "node:net";
import { join } from "node:path";

const MIN_FRAME_BYTES = 16 * 1024;
const DAILY_BYTES = 2 * 1024 ** 3;
const SLICE_BYTES = 256 * 1024;
const LIVENESS_MS = 10_000;
const MiB = 1024 ** 2;

const [plxd, ...flags] = process.argv.slice(2);
const flag = (name, fallback) => {
  const at = flags.indexOf(`--${name}`);
  return at < 0 ? fallback : flags[at + 1];
};
const scenario = flag("scenario");
const rate = Number(flag("rate", 256 * 1024));
const seconds = Number(flag("seconds", 20));
const fileMib = Number(flag("file-mib", 16));
const parallel = Number(flag("parallel", 1));
const out = flag("out");
const relayUrl = process.env.PLXD_TEST_RELAY_URL;
const relayToken = process.env.PLXD_TEST_RELAY_TOKEN;
if (!plxd || !scenario || !relayUrl || !relayToken) {
  console.error("run it through relay/scripts/e2e.mjs, with plxd's path and --scenario");
  process.exit(2);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const round = (value, places = 1) => (value == null ? null : Number(value.toFixed(places)));
const pct = (values, p) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted.length ? sorted[Math.min(sorted.length - 1, Math.round((p / 100) * (sorted.length - 1)))] : null;
};
const spread = (values) => ({
  n: values.length,
  p50: round(pct(values, 50)),
  p95: round(pct(values, 95)),
  max: round(pct(values, 100)),
});

/** Calls `onFrame(opcode, payload length, close code)` for each WebSocket frame in what it's fed. */
function frameReader(onFrame) {
  let held = Buffer.alloc(0);
  return (chunk) => {
    held = held.length ? Buffer.concat([held, chunk]) : chunk;
    for (;;) {
      if (held.length < 2) return;
      const masked = held[1] & 0x80;
      let length = held[1] & 0x7f;
      let at = 2;
      if (length === 126) {
        if (held.length < 4) return;
        length = held.readUInt16BE(2);
        at = 4;
      } else if (length === 127) {
        if (held.length < 10) return;
        length = Number(held.readBigUInt64BE(2));
        at = 10;
      }
      const mask = at;
      if (masked) at += 4;
      if (held.length < at + length) return;
      const opcode = held[0] & 0xf;
      let code = null;
      if (opcode === 8 && length >= 2) {
        const high = held[at] ^ (masked ? held[mask] : 0);
        const low = held[at + 1] ^ (masked ? held[mask + 1] : 0);
        code = (high << 8) | low;
      }
      onFrame(opcode, length, code);
      held = held.subarray(at + length);
    }
  };
}

function newStats() {
  const side = () => ({ frames: 0, bytes: 0, counted: 0, under: 0 });
  return { host: side(), client: side(), delivered: 0, closed: [] };
}

/** Writes `chunk` to `to`, holding `from` while `to` is full, so the proxy keeps nothing. */
function forward(from, to, chunk) {
  if (to.write(chunk)) return;
  from.pause();
  to.once("drain", () => from.resume());
}

/** A proxy to the Worker that counts each stream's binary frames as the relay does, slows what a
 *  client receives to `clientRate` bytes a second when set, and logs each socket's close. */
function startProxy(target) {
  const proxy = { clientRate: null, stats: newStats() };
  const count = (side, length) => {
    const counts = proxy.stats[side];
    counts.frames += 1;
    counts.bytes += length;
    counts.counted += Math.max(length, MIN_FRAME_BYTES);
    if (length < MIN_FRAME_BYTES) counts.under += 1;
  };

  /** Passes what the Worker sends down to a client, at `clientRate`. */
  const toClient = (up, down, read) => {
    const queue = [];
    let queued = 0;
    let ended = false;
    const tick = 20;
    const timer = setInterval(() => {
      let budget = proxy.clientRate ? Math.ceil((proxy.clientRate * tick) / 1000) : Infinity;
      while (queue.length && budget > 0) {
        let chunk = queue[0];
        if (chunk.length > budget) {
          queue[0] = chunk.subarray(budget);
          chunk = chunk.subarray(0, budget);
        } else {
          queue.shift();
        }
        budget -= chunk.length;
        queued -= chunk.length;
        proxy.stats.delivered += chunk.length;
        down.write(chunk);
      }
      if (queued < 64 * 1024) up.resume();
      if (ended && !queue.length) {
        clearInterval(timer);
        down.end();
      }
    }, tick);
    up.on("data", (chunk) => {
      read(chunk);
      if (!proxy.clientRate && !queue.length) {
        proxy.stats.delivered += chunk.length;
        return forward(up, down, chunk);
      }
      queue.push(chunk);
      queued += chunk.length;
      if (queued >= 64 * 1024) up.pause();
    });
    up.on("end", () => {
      ended = true;
    });
    down.on("close", () => clearInterval(timer));
  };

  const join2 = (down, up, kind, head) => {
    const opened = Date.now();
    let closeCode = null;
    const fromDown = frameReader((opcode, length, code) => {
      if (opcode === 8) closeCode ??= code;
      if (opcode !== 2) return;
      if (kind === "hostStream") count("host", length);
      if (kind === "clientStream") count("client", length);
    });
    const fromUp = frameReader((opcode, _length, code) => {
      if (opcode === 8) closeCode ??= code;
    });
    let switched = false;
    let upHead = Buffer.alloc(0);
    const readUp = (chunk) => {
      if (kind === "http") return;
      if (switched) return fromUp(chunk);
      upHead = Buffer.concat([upHead, chunk]);
      const end = upHead.indexOf("\r\n\r\n");
      if (end < 0) return;
      switched = true;
      fromUp(upHead.subarray(end + 4));
    };
    const headEnd = head.indexOf("\r\n\r\n") + 4;
    up.write(head);
    if (kind !== "http" && head.length > headEnd) fromDown(head.subarray(headEnd));
    down.on("data", (chunk) => {
      if (kind !== "http") fromDown(chunk);
      forward(down, up, chunk);
    });
    if (kind === "clientStream") {
      toClient(up, down, readUp);
    } else {
      up.on("data", (chunk) => {
        readUp(chunk);
        forward(up, down, chunk);
      });
      up.on("end", () => down.end());
    }
    down.on("end", () => up.end());
    down.on("close", () => {
      up.destroy();
      if (kind !== "http") {
        proxy.stats.closed.push({ kind, code: closeCode, afterS: round((Date.now() - opened) / 1000) });
      }
    });
  };

  const kindOf = (path) => {
    const action = new URL(path, "http://x").pathname.split("/")[4];
    return action === "streams" ? "hostStream" : action === "connect" ? "clientStream" : "control";
  };

  const server = createServer((down) => {
    const address = new URL(target);
    const up = connect(address.port, address.hostname);
    down.setNoDelay(true);
    up.setNoDelay(true);
    let head = Buffer.alloc(0);
    down.on("error", () => up.destroy());
    up.on("error", () => down.destroy());
    const firstChunk = (chunk) => {
      head = Buffer.concat([head, chunk]);
      const end = head.indexOf("\r\n\r\n");
      if (end < 0) return;
      down.off("data", firstChunk);
      const path = head.subarray(0, head.indexOf("\r\n")).toString().split(" ")[1] ?? "";
      const upgrade = /^upgrade: websocket/im.test(head.subarray(0, end).toString());
      join2(down, up, upgrade ? kindOf(path) : "http", head);
    };
    down.on("data", firstChunk);
  });
  return new Promise((resolve) =>
    server.listen(0, "127.0.0.1", () => {
      proxy.url = `http://127.0.0.1:${server.address().port}`;
      proxy.stop = () => server.close();
      resolve(proxy);
    }),
  );
}

/** One JSON-RPC peer over newline-framed streams. */
class Peer {
  constructor(input, output) {
    this.input = input;
    this.nextId = 0;
    this.pending = new Map();
    this.onOutput = () => {};
    let held = [];
    output.on("data", (chunk) => {
      let start = 0;
      for (;;) {
        const end = chunk.indexOf(10, start);
        if (end < 0) break;
        const part = chunk.subarray(start, end);
        const line = held.length ? Buffer.concat([...held, part]) : part;
        held = [];
        this.line(line);
        start = end + 1;
      }
      if (start < chunk.length) held.push(chunk.subarray(start));
    });
  }

  line(line) {
    const message = JSON.parse(line);
    if (message.id !== undefined && this.pending.has(message.id)) {
      const { resolve, reject } = this.pending.get(message.id);
      this.pending.delete(message.id);
      if (message.error) reject(new Error(JSON.stringify(message.error)));
      else resolve(message.result);
    } else if (message.method === "terminal/output") {
      this.onOutput(message.params);
    }
  }

  send(method, params) {
    this.input.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`);
  }

  call(method, params) {
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      if (this.exited != null) return reject(new Error("the connection ended"));
      this.pending.set(id, { resolve, reject });
      this.input.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });
  }

  initialize() {
    return this.call("initialize", {
      protocol: { min: 1, max: 1 },
      client: { name: "relay-load", version: "0" },
      capabilities: {},
    });
  }
}

function freePort() {
  return new Promise((resolve) => {
    const server = createServer().listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

/** The memory in MiB of each workerd under the script that started this one. Others' are skipped. */
function workerdMiB() {
  const rows = execFileSync("ps", ["-axo", "pid=,ppid=,rss=,comm="], { encoding: "utf8" })
    .trim()
    .split("\n")
    .map((row) => row.trim().split(/\s+/))
    .map(([pid, ppid, rss, ...comm]) => ({ pid: +pid, ppid: +ppid, rss: +rss, comm: comm.join(" ") }));
  const ours = new Set([process.ppid]);
  for (let grew = true; grew; ) {
    grew = false;
    for (const row of rows) {
      if (ours.has(row.ppid) && !ours.has(row.pid)) {
        ours.add(row.pid);
        grew = true;
      }
    }
  }
  const workers = rows.filter((row) => ours.has(row.pid) && row.comm.includes("workerd"));
  return workers.reduce((sum, row) => sum + row.rss, 0) / 1024;
}

/** A client: `plxd dial` on the route, as the app runs it. */
function dial(route, fingerprint, env, data) {
  const child = spawn(plxd, ["dial", "--remote", fingerprint, route, "--data-dir", data], {
    env,
    stdio: ["pipe", "pipe", "pipe"],
  });
  const peer = new Peer(child.stdin, child.stdout);
  peer.exited = null;
  peer.said = "";
  child.stderr.on("data", (chunk) => {
    peer.said += chunk;
  });
  child.on("exit", (code) => {
    peer.exited = code ?? -1;
    for (const { reject } of peer.pending.values()) reject(new Error("the connection ended"));
    peer.pending.clear();
  });
  child.stdin.on("error", () => {});
  peer.stop = () => child.kill();
  return peer;
}

/** Samples, while `work` runs, what stays true of a healthy relay and connection. */
async function watched(proxy, client, secondDial, work) {
  proxy.stats = newStats();
  const health = [];
  const worker = [];
  const dials = [];
  const memory = [workerdMiB()];
  let peakBacklog = 0;
  let healthLate = 0;
  let done = false;
  const started = Date.now();
  const sample = (async () => {
    while (!done) {
      await sleep(1000);
      memory.push(workerdMiB());
      peakBacklog = Math.max(peakBacklog, proxy.stats.host.bytes - proxy.stats.delivered);
    }
  })();
  const healthChecks = (async () => {
    while (!done && client.exited === null) {
      const at = Date.now();
      const answered = client.call("host/health", {}).then(() => {
        health.push(Date.now() - at);
        return true;
      });
      const inTime = await Promise.race([answered, sleep(LIVENESS_MS).then(() => false)]);
      if (!inTime) {
        healthLate += 1;
        await answered;
      }
      await sleep(1000);
    }
  })().catch(() => {});
  const workerChecks = (async () => {
    while (!done) {
      const at = Date.now();
      const answer = await fetch(`${relayUrl}/v1/hosts`, {
        headers: { authorization: `Bearer ${relayToken}` },
      }).catch((error) => ({ status: String(error) }));
      await answer.text?.();
      worker.push({ ms: Date.now() - at, status: answer.status });
      await sleep(2000);
    }
  })();
  const dialChecks = (async () => {
    while (!done) {
      await sleep(5000);
      dials.push(await secondDial());
    }
  })();
  const result = await work().catch((error) => ({ failed: error.message }));
  const elapsedS = (Date.now() - started) / 1000;
  done = true;
  const stats = proxy.stats;
  const counted = stats.host.counted + stats.client.counted;
  const measured = {
    ...result,
    elapsedS: round(elapsedS),
    host: stats.host,
    client: stats.client,
    frames: stats.host.frames + stats.client.frames,
    framesPerS: round((stats.host.frames + stats.client.frames) / elapsedS),
    countedMiB: round(counted / MiB),
    relayedMiB: round((stats.host.bytes + stats.client.bytes) / MiB),
    deliveredMiB: round(stats.delivered / MiB),
    relayBacklogMiB: round((stats.host.bytes - stats.delivered) / MiB),
    peakBacklogMiB: round(peakBacklog / MiB, 2),
    minutesToDailyCap: round(DAILY_BYTES / (counted / elapsedS) / 60),
    closed: [...stats.closed],
    dialExit: client.exited,
    dialSaid: client.said.trim().split("\n").slice(1, 4).join(" | "),
  };
  const finished = Promise.all([sample, healthChecks, workerChecks, dialChecks]);
  await Promise.race([finished, sleep(LIVENESS_MS + 5000)]);
  return {
    ...measured,
    healthMs: spread(health),
    healthLate,
    workerMs: spread(worker.map((row) => row.ms)),
    workerStatuses: [...new Set(worker.map((row) => row.status))],
    secondDialMs: spread(dials.filter((ms) => ms !== null)),
    secondDialFailed: dials.filter((ms) => ms === null).length,
    workerdMiB: { start: round(memory[0]), peak: round(Math.max(...memory)), end: round(memory.at(-1)) },
  };
}

/** Runs `command` in a terminal for `ms`, and answers what the client got. */
async function terminal(client, name, command, ms) {
  const got = { messages: 0, bytes: 0, replays: 0 };
  const output = client.onOutput;
  client.onOutput = (params) => {
    if (params.terminalId === name) {
      got.messages += 1;
      got.bytes += params.data.length;
      if (params.replay) got.replays += 1;
    }
    output(params);
  };
  const key = { threadId: "bench", terminalId: name };
  await client.call("terminal/open", { ...key, command, cols: 120, rows: 40 });
  await sleep(ms);
  // Past the point the client can't keep up, the close itself queues behind what's on its way.
  client.call("terminal/close", key).catch(() => {});
  await sleep(1000);
  client.onOutput = output;
  return { messages: got.messages, outputMiB: round(got.bytes / MiB), replays: got.replays };
}

const YES = { program: "yes" };
const LOG_LINES = {
  program: "python3",
  args: [
    "-c",
    `import sys, time
line = "   Compiling some-crate v1.2.3 (/Users/someone/project/crates/some-crate)\\n"
next = time.monotonic()
while True:
    sys.stdout.write(line)
    sys.stdout.flush()
    next += 0.001
    wait = next - time.monotonic()
    if wait > 0:
        time.sleep(wait)
`,
  ],
};

const FLOOD_LINES = {
  program: "python3",
  args: [
    "-c",
    `import sys
line = "   Compiling some-crate v1.2.3 (/Users/someone/project/crates/some-crate)\\n"
while True:
    sys.stdout.write(line)
`,
  ],
};

/** Types into `cat` every `everyMs`, timing each key to its echo, and answers the times.
 *  `before` runs in the terminal first, and `settleMs` is how long it gets. */
async function type(client, name, keys, everyMs, before = "", settleMs = 500) {
  const key = { threadId: "bench", terminalId: name };
  const command = before ? { program: "sh", args: ["-c", `${before} exec cat`] } : { program: "cat" };
  await client.call("terminal/open", { ...key, command, cols: 120, rows: 40 });
  let waiting = null;
  const output = client.onOutput;
  client.onOutput = (params) => {
    if (params.terminalId === name && waiting && params.data.includes(waiting.letter)) {
      waiting.resolve();
      waiting = null;
    }
    output(params);
  };
  await sleep(settleMs);
  const times = [];
  for (let i = 0; i < keys; i++) {
    const letter = String.fromCharCode(97 + (i % 26));
    const at = performance.now();
    const echoed = new Promise((resolve) => {
      waiting = { letter, resolve };
    });
    client.send("terminal/write", { ...key, data: letter });
    await Promise.race([echoed, sleep(5000)]);
    times.push(performance.now() - at);
    if (client.exited !== null) throw new Error("the connection ended");
    await sleep(everyMs);
  }
  client.onOutput = output;
  await client.call("terminal/close", key);
  return spread(times);
}

/** Reads the file at `path` in slices, `parallel` at a time, and checks it. */
async function readSlices(client, path, size, digest) {
  const offsets = [];
  for (let offset = 0; offset < size; offset += SLICE_BYTES) offsets.push(offset);
  const parts = new Array(offsets.length);
  const slices = [];
  let next = 0;
  const reader = async () => {
    while (next < offsets.length) {
      const at = next++;
      const started = Date.now();
      const { data } = await client.call("host/readUpload", { path, offset: offsets[at], length: SLICE_BYTES });
      slices.push(Date.now() - started);
      parts[at] = Buffer.from(data, "base64");
    }
  };
  await Promise.all(Array.from({ length: parallel }, reader));
  const contents = Buffer.concat(parts);
  const intact = createHash("sha256").update(contents).digest("hex") === digest;
  return { fileMiB: round(contents.length / MiB), intact, sliceMs: spread(slices) };
}

async function main() {
  const scratch = realpathSync(mkdtempSync("/tmp/plx-relay-load-"));
  const stubs = join(scratch, "stubs");
  const hostData = join(scratch, "host");
  const clientData = join(scratch, "client");
  mkdirSync(stubs);
  mkdirSync(join(hostData, "uploads"), { recursive: true });
  mkdirSync(clientData);
  // Connect stays off here, and a stray call must not reach the real tailnet.
  const stubPath = join(stubs, "tailscale");
  const tailscaleLog = join(scratch, "tailscale.log");
  writeFileSync(stubPath, `#!/bin/sh\necho "tailscale $*" >> "${tailscaleLog}"\nexit 1\n`);
  chmodSync(stubPath, 0o755);

  const proxy = await startProxy(relayUrl);
  const base = { ...process.env, PATH: `${stubs}:${process.env.PATH}`, PLXD_RELAY_URL: proxy.url };
  const hostEnv = { ...base, PLXD_REMOTE_PORT: String(await freePort()) };
  const host = spawn(plxd, ["serve", "--data-dir", hostData], {
    env: hostEnv,
    stdio: ["ignore", "ignore", "inherit"],
  });
  const results = { scenario, plxd };
  let client;
  try {
    // A new one at the end too, since plxd closes one that's silent for 90 s.
    const openLocal = async () => {
      let local;
      for (let i = 0; i < 200 && !local; i++) {
        local = await new Promise((resolve) => {
          const socket = connect(join(hostData, "plxd.sock"));
          socket.once("connect", () => resolve(socket));
          socket.once("error", () => resolve(null));
        });
        if (!local) await sleep(100);
      }
      if (!local) throw new Error("plxd never listened");
      const peer = new Peer(local, local);
      await peer.initialize();
      return peer;
    };
    const admin = await openLocal();
    await admin.call("host/settings/set", { remote: true });
    await admin.call("host/settings/set", { relay: true });
    await admin.call("relay/register", { token: relayToken });
    let hostId;
    for (let i = 0; i < 200 && !hostId; i++) {
      const { relay } = await admin.call("remote/sessions", {});
      if (relay?.connected) hostId = relay.hookUrl.split("/").at(-1);
      else await sleep(100);
    }
    if (!hostId) throw new Error("the host never reached the relay");
    const route = `relay:${hostId}`;
    const clientEnv = { ...base, PLXD_RELAY_TOKEN: relayToken };

    const { code } = await admin.call("remote/pair", {});
    const pairing = spawn(plxd, ["dial", "--pair", route, "--name", "load", "--data-dir", clientData], {
      env: clientEnv,
      stdio: ["pipe", "pipe", "inherit"],
    });
    pairing.stdin.end(`${code}\n`);
    let paired = "";
    for await (const chunk of pairing.stdout) paired += chunk;
    const { fingerprint } = JSON.parse(paired);

    client = dial(route, fingerprint, clientEnv, clientData);
    await client.initialize();
    const secondDial = () =>
      new Promise((resolve) => {
        const at = Date.now();
        const args = ["dial", "--remote", fingerprint, route, "--probe", "--data-dir", clientData];
        const child = spawn(plxd, args, { env: clientEnv, stdio: "ignore" });
        child.on("exit", (exit) => resolve(exit === 0 ? Date.now() - at : null));
      });
    const run = (work) => watched(proxy, client, secondDial, work);

    if (scenario === "yes") {
      Object.assign(results, await run(() => terminal(client, "yes", YES, seconds * 1000)));
    } else if (scenario === "log") {
      Object.assign(results, await run(() => terminal(client, "log", LOG_LINES, seconds * 1000)));
    } else if (scenario === "flood") {
      proxy.clientRate = rate;
      results.rate = rate;
      Object.assign(results, await run(() => terminal(client, "flood", FLOOD_LINES, seconds * 1000)));
    } else if (scenario === "typing") {
      Object.assign(
        results,
        await run(async () => ({
          echoMs: await type(client, "typing", 60, 120),
          burstEchoMs: await type(client, "burst", 60, 15),
        })),
      );
    } else if (scenario === "beside") {
      Object.assign(
        results,
        await run(async () => {
          const heavy = terminal(client, "heavy", YES, seconds * 1000);
          await sleep(1000);
          const echoMs = await type(client, "typing", 30, 120);
          await heavy;
          return { echoMs };
        }),
      );
    } else if (scenario === "recover") {
      const flood = `yes | head -c ${fileMib * MiB};`;
      Object.assign(
        results,
        await run(async () => ({ echoMs: await type(client, "typing", 30, 120, flood, 3000) })),
      );
    } else if (scenario === "noisy") {
      const noise = "(while :; do echo 0; sleep 0.05; done) &";
      Object.assign(
        results,
        await run(async () => ({
          echoMs: await type(client, "close", 30, 120, noise),
          apartEchoMs: await type(client, "apart", 20, 1500, noise),
        })),
      );
    } else if (scenario === "file") {
      const size = fileMib * MiB;
      const contents = randomBytes(size);
      const digest = createHash("sha256").update(contents).digest("hex");
      const upload = join(hostData, "uploads", "bench.bin");
      writeFileSync(upload, contents);
      proxy.clientRate = rate;
      results.rate = rate;
      results.parallel = parallel;
      Object.assign(results, await run(() => readSlices(client, upload, size, digest)));
    } else if (scenario === "push") {
      proxy.clientRate = rate;
      results.rate = rate;
      Object.assign(results, await run(() => terminal(client, "push", YES, seconds * 1000)));
    } else {
      throw new Error(`no scenario ${scenario}`);
    }
    const { relay } = await (await openLocal()).call("remote/sessions", {});
    results.hostStayedConnected = relay?.connected ?? false;
    results.relayProblem = relay?.problem ?? null;
    results.tailscaleStubCalls = existsSync(tailscaleLog)
      ? readFileSync(tailscaleLog, "utf8").trim().split("\n").length
      : 0;
  } finally {
    client?.stop();
    host.kill();
    proxy.stop();
    await sleep(500);
    rmSync(scratch, { recursive: true, force: true });
  }
  const answer = JSON.stringify(results, null, 2);
  if (out) writeFileSync(out, answer);
  console.log(answer);
  process.exit(0);
}

await main();
