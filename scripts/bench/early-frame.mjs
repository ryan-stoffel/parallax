#!/usr/bin/env node
// Whether a client's first stream frame can go right behind its `/connect` upgrade request, before
// the relay's 101 (PLX-1568). That frame would carry the pinned TLS ClientHello and save a round trip.
//
//     PROBE_CLERK_USER_ID=<id> node scripts/bench/early-frame.mjs --relay <url> \
//       --token-file ~/.config/parallax/probe-token [--runs 5]
//
// It signs in as the relay probe's test account (relay-probe-enroll.mjs --file), keeps a rotated
// refresh token in the same file, and registers a throwaway host named as relay-objects.mjs names
// its own, which it removes at the end. The host is this script: it joins each stream as plxd
// does and echoes the first binary frame back. The client is a raw TLS socket that writes the
// upgrade request and a masked binary frame of ClientHello size, either at once (`early`) or after
// the relay's `ready` (`today`). Three cases: a spare waiting, so plxd joined before the client
// came, with each order, and no spare, so plxd joins after. Each run says what the host got, in
// what order, how the stream ended, and the milliseconds from the client's TLS to the echo.
import { getRandomValues, randomBytes, subtle } from "node:crypto";
import { readFileSync } from "node:fs";
import https from "node:https";
import tls from "node:tls";
import { parseArgs } from "node:util";

import { replacePrivately } from "./private-file.mjs";
import { probeClerk } from "./probe-clerk.mjs";

const { values: options } = parseArgs({
  options: {
    relay: { type: "string" },
    "token-file": { type: "string" },
    runs: { type: "string", default: "5" },
  },
});
const runs = Number(options.runs);
const user = process.env.PROBE_CLERK_USER_ID?.trim();
if (!options.relay || !options["token-file"] || !user || !(runs > 0)) {
  console.error("usage: PROBE_CLERK_USER_ID=<id> early-frame.mjs --relay <url> --token-file <file> [--runs 5]");
  process.exit(2);
}
const relay = new URL(options.relay);
const tokenFile = options["token-file"];
let refreshToken = readFileSync(tokenFile, "utf8").trim();
/** The only name this test gives a host, which the relay probe's sweep also removes. */
const HOST_NAME = "relay-objects bench";

const base64url = (bytes) => Buffer.from(bytes).toString("base64url");
const sha256 = async (text) => base64url(await subtle.digest("SHA-256", Buffer.from(text)));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const clerk = probeClerk(process.env);

/** A new Clerk session token for the test account. A rotated refresh token replaces the file's. */
async function clerkToken() {
  const answer = await fetch(`${clerk.api}/oauth/token`, {
    method: "POST",
    body: new URLSearchParams({ client_id: clerk.clientId, grant_type: "refresh_token", refresh_token: refreshToken }),
    signal: AbortSignal.timeout(15_000),
  });
  const body = await answer.json().catch(() => ({}));
  if (!answer.ok || typeof body.access_token !== "string") throw new Error(`Clerk gave no token (${answer.status} ${body.error ?? ""})`);
  if (typeof body.refresh_token === "string" && body.refresh_token !== refreshToken) {
    refreshToken = body.refresh_token;
    replacePrivately(tokenFile, refreshToken);
  }
  const claims = JSON.parse(Buffer.from(body.access_token.split(".")[1], "base64url").toString());
  if (claims.sub !== user) throw new Error("the token isn't for the account PROBE_CLERK_USER_ID names");
  return body.access_token;
}

/** Refuses an account with a computer this test didn't make, and removes its own leftovers. */
async function sweep(token) {
  const answer = await fetch(new URL("/v1/hosts", relay), { headers: { authorization: `Bearer ${token}` } });
  if (!answer.ok) throw new Error(`listing the account's computers: ${answer.status}`);
  const { hosts } = await answer.json();
  if (hosts.some((host) => !["relay-probe", HOST_NAME].includes(host.name))) throw new Error("the account has computers this test didn't make");
  for (const { hostId, online } of hosts) {
    if (!online) await fetch(new URL(`/v1/hosts/${hostId}`, relay), { method: "DELETE", headers: { authorization: `Bearer ${token}` } });
  }
}

/** Registers a throwaway host and opens its control socket, as relay-objects.mjs does. */
async function online(token) {
  const pair = await subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  const { x, y } = await subtle.exportKey("jwk", pair.publicKey);
  const sign = async (message) => base64url(await subtle.sign({ name: "ECDSA", hash: "SHA-256" }, pair.privateKey, Buffer.from(message)));
  const id = await sha256(JSON.stringify({ crv: "P-256", kty: "EC", x, y }));
  const signature = await sign(`parallax-relay-register\n${id}\n${await sha256(token)}`);
  const registered = await fetch(new URL("/v1/hosts", relay), {
    method: "POST",
    headers: { authorization: `Bearer ${token}` },
    body: JSON.stringify({ hostId: id, jwk: { kty: "EC", crv: "P-256", x, y }, name: HOST_NAME, signature }),
  });
  if (!registered.ok) throw new Error(`registering the host: ${registered.status}`);
  const at = Date.now();
  const control = new WebSocket(new URL(`/v1/hosts/${id}/host`, relay).href.replace(/^http/, "ws"), {
    headers: { "x-parallax-host-proof": `${at}.${await sign(`parallax-relay-host\n${id}\n${at}`)}` },
  });
  const messages = [];
  let waiter;
  control.addEventListener("message", ({ data }) => {
    messages.push(JSON.parse(data));
    waiter?.();
  });
  /** The next control message of type `t`. */
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
  return { id, control, next };
}

/**
 * plxd's end of a stream: joins it, records each message in order, and echoes the first binary
 * frame. Answers once it joined, with what it saw.
 */
function joinAsHost(hostId, { stream, token }) {
  const seen = { events: [], payload: undefined, close: undefined };
  const socket = new WebSocket(new URL(`/v1/hosts/${hostId}/streams/${stream}?token=${encodeURIComponent(token)}`, relay).href.replace(/^http/, "ws"));
  socket.binaryType = "arraybuffer";
  socket.addEventListener("message", ({ data }) => {
    if (typeof data === "string") return seen.events.push(data);
    seen.events.push(`binary ${data.byteLength}`);
    if (!seen.payload) {
      seen.payload = Buffer.from(data);
      socket.send(data);
    }
  });
  socket.addEventListener("close", ({ code, reason }) => (seen.close ??= `${code} ${reason}`));
  return new Promise((resolve, reject) => {
    socket.addEventListener("open", () => resolve({ seen, socket }));
    // Asks once more by hand, only to say what the relay answered.
    socket.addEventListener("error", () => {
      const url = new URL(`/v1/hosts/${hostId}/streams/${stream}?token=${encodeURIComponent(token)}`, relay);
      const headers = { upgrade: "websocket", connection: "Upgrade", "sec-websocket-version": "13", "sec-websocket-key": base64url(randomBytes(16)) };
      const again = https.request(url, { headers, agent: false }, (response) => {
        let body = "";
        response.on("data", (chunk) => (body += chunk));
        response.on("end", () => reject(new Error(`the host couldn't join its stream: ${response.statusCode} ${body.slice(0, 200)}`)));
      });
      again.on("upgrade", (_, raw) => {
        raw.destroy();
        reject(new Error("the host couldn't join its stream, though a second try opened"));
      });
      again.on("error", (error) => reject(new Error(`the host couldn't join its stream: ${error.message}`)));
      again.end();
    });
  });
}

/** A client's masked binary frame of `payload`. */
function maskedBinary(payload) {
  const mask = randomBytes(4);
  const length = payload.length;
  const head = length < 126 ? Buffer.from([0x82, 0x80 | length]) : Buffer.from([0x82, 0x80 | 126, length >> 8, length & 0xff]);
  const body = Buffer.from(payload.map((byte, at) => byte ^ mask[at % 4]));
  return Buffer.concat([head, mask, body]);
}

/** Reads unmasked server frames from `bytes`, answering the frames and what's left over. */
function serverFrames(bytes) {
  const frames = [];
  let at = 0;
  for (;;) {
    if (bytes.length < at + 2) break;
    const opcode = bytes[at] & 0x0f;
    let length = bytes[at + 1] & 0x7f;
    let start = at + 2;
    if (length === 126) {
      if (bytes.length < start + 2) break;
      length = bytes.readUInt16BE(start);
      start += 2;
    } else if (length === 127) {
      if (bytes.length < start + 8) break;
      length = Number(bytes.readBigUInt64BE(start));
      start += 8;
    }
    if (bytes.length < start + length) break;
    frames.push({ opcode, data: bytes.subarray(start, start + length) });
    at = start + length;
  }
  return { frames, rest: bytes.subarray(at) };
}

/**
 * One client stream over a raw TLS socket. With `early`, the frame goes right behind the upgrade
 * request. Otherwise it goes after `ready`, as plxd sends its ClientHello today. Answers what
 * happened, timed from the socket's TLS being ready.
 */
function client(hostId, token, early) {
  const payload = Buffer.concat([Buffer.from([0x16, 0x03, 0x01]), randomBytes(514)]);
  const frame = maskedBinary(payload);
  const key = base64url(getRandomValues(new Uint8Array(16)));
  const request =
    `GET /v1/hosts/${hostId}/connect HTTP/1.1\r\nHost: ${relay.host}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n` +
    `Sec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\nAuthorization: Bearer ${token}\r\nx-parallax-timing: 1\r\n\r\n`;
  return new Promise((resolve) => {
    const result = { status: undefined, spare: undefined, events: [], echoed: false, close: undefined };
    let started = 0;
    let buffer = Buffer.alloc(0);
    let headed = false;
    const socket = tls.connect({ host: relay.hostname, port: Number(relay.port || 443), servername: relay.hostname, ALPNProtocols: ["http/1.1"] });
    const finish = (why) => {
      result.close ??= why;
      socket.destroy();
      resolve(result);
    };
    const timer = setTimeout(() => finish("timed out after 10 s"), 10_000);
    socket.on("secureConnect", () => {
      started = performance.now();
      socket.write(early ? Buffer.concat([Buffer.from(request), frame]) : request);
    });
    socket.on("data", (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      if (!headed) {
        const end = buffer.indexOf("\r\n\r\n");
        if (end < 0) return;
        const head = buffer.subarray(0, end).toString();
        result.status = Number(head.split(" ")[1]);
        result.upgradeMs = Math.round(performance.now() - started);
        result.spare = /spare;dur=1/.test(head) ? true : /spare;dur=0/.test(head) ? false : undefined;
        buffer = buffer.subarray(end + 4);
        headed = true;
        if (result.status !== 101) return finish(`HTTP ${result.status}: ${buffer.toString().slice(0, 120)}`);
      }
      const { frames, rest } = serverFrames(buffer);
      buffer = rest;
      for (const { opcode, data } of frames) {
        if (opcode === 1) {
          result.events.push(data.toString());
          if (data.toString() === "ready") {
            result.readyMs = Math.round(performance.now() - started);
            if (!early) socket.write(frame);
          }
        } else if (opcode === 2) {
          result.events.push(`binary ${data.length}`);
          result.echoed = data.equals(payload);
          result.echoMs = Math.round(performance.now() - started);
          clearTimeout(timer);
          return finish("echoed");
        } else if (opcode === 8) {
          clearTimeout(timer);
          return finish(`closed ${data.length >= 2 ? data.readUInt16BE(0) : ""} ${data.subarray(2).toString()}`);
        }
      }
    });
    socket.on("error", (error) => finish(`error ${error.message}`));
    socket.on("close", () => finish("socket closed"));
  });
}

const token = await clerkToken();
await sweep(token);
const host = await online(token);
const results = [];
try {
  for (let run = 0; run < runs; run++) {
    // A spare: plxd's end is on the stream before the client comes, so the frame has a peer.
    for (const early of [true, false]) {
      host.control.send(JSON.stringify({ t: "spare" }));
      const opened = await host.next("open");
      const joined = await joinAsHost(host.id, opened);
      await sleep(400);
      const seen = await client(host.id, await clerkToken(), early);
      await sleep(300);
      joined.socket.close();
      results.push({ case: early ? "spare, early" : "spare, today", ...seen, host: joined.seen });
      await sleep(1500);
    }
    // No spare: the client's stream is new, and plxd joins once the relay announces it.
    const answer = client(host.id, await clerkToken(), true);
    // The stream may already have ended over the early frame, and plxd's join then gets a 404.
    const joined = await joinAsHost(host.id, await host.next("open")).catch((error) => ({
      seen: { events: [], close: error.message.replace("the host couldn't join its stream: ", "join refused ") },
    }));
    const seen = await answer;
    await sleep(300);
    joined.socket?.close();
    results.push({ case: "no spare, early", ...seen, host: joined.seen });
    await sleep(1500);
  }
} finally {
  host.control.close();
  const fresh = await clerkToken();
  const removed = await fetch(new URL(`/v1/hosts/${host.id}`, relay), { method: "DELETE", headers: { authorization: `Bearer ${fresh}` } });
  console.error(`removed the throwaway host: ${removed.status}`);
}

for (const result of results) {
  const hostSaw = result.host.events.join(" > ") || "nothing";
  const intact = result.host.payload ? "intact" : "no payload";
  console.log(
    `${result.case.padEnd(16)} ${String(result.status).padEnd(4)} spare=${result.spare} upgrade=${result.upgradeMs}ms ready=${result.readyMs}ms echo=${result.echoMs ?? "-"}ms ` +
      `echoed=${result.echoed} client: ${result.events.join(" > ")} | ${result.close} || host: ${hostSaw} (${intact}) | ${result.host.close ?? "open"}`,
  );
}
const median = (values) => {
  const sorted = values.filter((value) => value !== undefined).toSorted((a, b) => a - b);
  return sorted.length ? sorted[Math.floor((sorted.length - 1) / 2)] : undefined;
};
for (const name of ["spare, early", "spare, today", "no spare, early"]) {
  const rows = results.filter((result) => result.case === name);
  console.log(`${name}: ${rows.filter((row) => row.echoed).length}/${rows.length} echoed, median echo ${median(rows.map((row) => row.echoMs))} ms`);
}
