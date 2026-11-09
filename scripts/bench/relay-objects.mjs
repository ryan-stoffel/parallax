#!/usr/bin/env node
// What a new relay stream object costs (PLX-1358, weakness 5 of PLX-1347): the same request times
// against a new object, an existing object, and the Worker alone. Each sample is one request on a
// new connection, timed from the start to the response's status line, so the differences between
// rows are what matter, not the rows themselves.
//
//     node scripts/bench/relay-objects.mjs https://relay.parallax.codes [--samples 6]
//
// With no token it needs no account: it sends plxd's join to a stream nobody armed, which the
// stream's object refuses with a 404. A random UUID makes that a new named object, the kind every
// stream had before PLX-1358, and one UUID again an existing one. It stores nothing.
//
// A `newUniqueId` object can't be reached that way, since only the relay can make its id. With a
// Clerk token in PLXD_TEST_RELAY_TOKEN it also opens real streams on a throwaway host, which it
// removes at the end: a client's stream with no spare waiting makes a new object, and one with a
// spare waiting takes an existing object. That host uses one of the account's computer slots while
// it runs. Those streams ask for the relay's own stage times (`x-parallax-timing`), and each stage
// gets a row too, so they're read on any relay with no plxd in between (PLX-1493). A local run gets a local Clerk from the relay's e2e script, which also sets the URL:
//
//     cd relay && pnpm install
//     node scripts/e2e.mjs node scripts/bench/relay-objects.mjs
import { randomUUID, subtle, getRandomValues } from "node:crypto";
import http from "node:http";
import https from "node:https";
import { parseArgs } from "node:util";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: { samples: { type: "string", default: "6" } },
});
const relay = positionals[0] ?? process.env.PLXD_TEST_RELAY_URL;
const samples = Number(values.samples);
if (!relay || !(samples > 0)) {
  console.error("usage: relay-objects.mjs <relay url> [--samples 6]");
  process.exit(2);
}
const token = process.env.PLXD_TEST_RELAY_TOKEN;
const bearer = token ? { authorization: `Bearer ${token}` } : {};

const base64url = (bytes) => Buffer.from(bytes).toString("base64url");
const sha256 = async (text) => base64url(await subtle.digest("SHA-256", Buffer.from(text)));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Sends one request on a new connection, and answers its status and milliseconds, up to the status
 * line, with the relay's `Server-Timing` when a WebSocket opened with one. A WebSocket that opens
 * is dropped at once, which closes the relay's side of it.
 */
function timed(path, headers = {}) {
  const url = new URL(path, relay);
  const { request } = url.protocol === "https:" ? https : http;
  return new Promise((resolve, reject) => {
    const start = performance.now();
    const done = (status) => resolve({ status, ms: performance.now() - start });
    const sent = request(url, { agent: false, headers }, (response) => {
      done(response.statusCode);
      response.destroy();
    });
    sent.on("upgrade", (response, socket) => {
      resolve({ status: response.statusCode, ms: performance.now() - start, timing: response.headers["server-timing"] });
      socket.destroy();
    });
    sent.on("error", reject);
    sent.end();
  });
}

const upgrade = {
  connection: "Upgrade",
  upgrade: "websocket",
  "sec-websocket-version": "13",
  "sec-websocket-key": base64url(getRandomValues(new Uint8Array(16))),
};

/** The relay's stages a stream's row is split into, in the order they're printed. `jwks` is there
 *  only when that connect read Clerk's keys, so its samples say how often. */
const STAGES = ["limit", "auth", "jwks", "host_open", "host_hop", "stream_join", "worker"];

/**
 * Runs one warm-up of `steps`, then `samples` of each in turn, so drift hits them all alike. A step
 * with a third entry, a short name, also gets a row for each of the relay's stages it answered.
 */
async function run(steps) {
  const times = Object.fromEntries(Object.keys(steps).map((name) => [name, []]));
  for (let round = 0; round <= samples; round++) {
    for (const [name, [expected, step, short]] of Object.entries(steps)) {
      const { status, ms, timing } = await step();
      if (status !== expected) throw new Error(`${name}: expected ${expected}, got ${status}`);
      if (round === 0) continue;
      times[name].push(ms);
      for (const [, stage, value] of (short && timing ? timing : "").matchAll(/(\w+);dur=([\d.]+)/g))
        if (STAGES.includes(stage)) (times[`${short}: relay ${stage}`] ??= []).push(Number(value));
    }
  }
  for (const [name, values] of Object.entries(times)) {
    const sorted = values.toSorted((a, b) => a - b);
    const middle = sorted.length / 2;
    const median = sorted.length % 2 ? sorted[Math.floor(middle)] : (sorted[middle - 1] + sorted[middle]) / 2;
    const all = values.map((ms) => ms.toFixed(0)).join(" ");
    console.log(`${name.padEnd(36)} median ${median.toFixed(0).padStart(5)} ms   samples ${all}`);
  }
}

/** A throwaway host key, as `relay/test/helpers.ts` makes one. */
async function newHost() {
  const pair = await subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  const { x, y } = await subtle.exportKey("jwk", pair.publicKey);
  const jwk = { kty: "EC", crv: "P-256", x, y };
  const sign = async (message) =>
    base64url(await subtle.sign({ name: "ECDSA", hash: "SHA-256" }, pair.privateKey, Buffer.from(message)));
  return { id: await sha256(JSON.stringify({ crv: "P-256", kty: "EC", x, y })), jwk, sign };
}

/** Registers a throwaway host and opens its control socket, as plxd does. */
async function online() {
  const host = await newHost();
  const signature = await host.sign(`parallax-relay-register\n${host.id}\n${await sha256(token)}`);
  const registered = await fetch(new URL("/v1/hosts", relay), {
    method: "POST",
    headers: bearer,
    body: JSON.stringify({ hostId: host.id, jwk: host.jwk, name: "relay-objects bench", signature }),
  });
  if (!registered.ok) throw new Error(`registering the bench's host: ${registered.status}`);
  const at = Date.now();
  const proof = `${at}.${await host.sign(`parallax-relay-host\n${host.id}\n${at}`)}`;
  const control = new WebSocket(new URL(`/v1/hosts/${host.id}/host`, relay).href.replace(/^http/, "ws"), {
    headers: { "x-parallax-host-proof": proof },
  });
  const messages = [];
  let waiter;
  control.addEventListener("message", ({ data }) => {
    messages.push(JSON.parse(data));
    waiter?.();
  });
  /** The next control message of type `t`, skipping the `open`s of streams with no spare. */
  const next = async (t) => {
    for (;;) {
      const found = messages.findIndex((message) => message.t === t);
      if (found >= 0) return messages.splice(found, 1)[0];
      await new Promise((resolve, reject) => {
        waiter = resolve;
        setTimeout(() => reject(new Error(`no ${t} from the relay`)), 10_000).unref();
      });
    }
  };
  await next("ready");
  return { host, control, next };
}

console.log(`${relay}, ${samples} samples each, plus one warm-up\n`);

// A host id no one registered: the Worker checks only its shape on this route.
const stranger = base64url(getRandomValues(new Uint8Array(32)));
const known = randomUUID();
const refused = (stream) => timed(`/v1/hosts/${stranger}/streams/${stream}?token=bench`, upgrade);
await run({
  "Worker alone (no object)": [404, () => timed("/bench")],
  // A client's open with no WebSocket: the anonymous limit answers, and then nothing else runs.
  "anonymous limit alone (no object)": [426, () => timed(`/v1/hosts/${stranger}/connect`)],
  "existing named object": [404, () => refused(known)],
  "new named object": [404, () => refused(randomUUID())],
});

if (token) {
  console.log();
  const { host, control, next } = await online();
  const connect = () => timed(`/v1/hosts/${host.id}/connect`, { ...upgrade, ...bearer, "x-parallax-timing": "1" });
  try {
    await run({
      "stream, existing object (spare)": [
        101,
        async () => {
          control.send(JSON.stringify({ t: "spare" }));
          await next("open");
          // Lets the host's object finish arming it, and the last stream's close land.
          await sleep(250);
          return connect();
        },
        "spare",
      ],
      "stream, new object (no spare)": [
        101,
        async () => {
          await sleep(250);
          const answer = await connect();
          await next("open");
          return answer;
        },
        "no spare",
      ],
    });
  } finally {
    control.close();
    await fetch(new URL(`/v1/hosts/${host.id}`, relay), { method: "DELETE", headers: bearer });
  }
}
