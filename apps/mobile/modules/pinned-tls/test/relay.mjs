#!/usr/bin/env node
// The native test of TLS inside a relay stream (0091), on a Mac: compiles Pinning.swift and
// RelayBridge.swift with main.swift, then runs it against a local relay that speaks the real
// relay's client protocol (`/v1/hosts/<id>/connect`, the Clerk token in `Authorization`, `ready`,
// then binary frames) and joins each stream to a plxd stand-in: TLS with a P-256 key whose JWK
// thumbprint is the host id. It also checks that the relay saw only TLS records, at TLS 1.3.
//
//   node modules/pinned-tls/test/relay.mjs
import { execFileSync, spawn } from "node:child_process";
import { createHash, createPublicKey } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer, connect } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import tls from "node:tls";

const here = dirname(fileURLToPath(import.meta.url));
const scratch = mkdtempSync(join(tmpdir(), "pinned-tls-"));
const TOKEN = "clerk-test-token";

// A named curve, as plxd's key has: Apple's TLS refuses a key with explicit curve parameters.
execFileSync("openssl", ["ecparam", "-name", "prime256v1", "-genkey", "-noout", "-out", join(scratch, "key.pem")]);
execFileSync("openssl", [
  "req", "-new", "-x509", "-key", join(scratch, "key.pem"), "-subj", "/CN=parallax", "-days", "1",
  "-out", join(scratch, "cert.pem"),
], { stdio: "ignore" });
const key = readFileSync(join(scratch, "key.pem"));
const cert = readFileSync(join(scratch, "cert.pem"));
const { x, y } = createPublicKey(cert).export({ format: "jwk" });
const hostId = createHash("sha256")
  .update(JSON.stringify({ crv: "P-256", kty: "EC", x, y }))
  .digest("base64url");

/** plxd's stand-in: one request per connection, answered with its descriptor. */
const protocols = [];
const host = (options) =>
  tls.createServer({ key, cert, ...options }, (socket) => {
    protocols.push(socket.getProtocol());
    socket.once("data", () => {
      const body = JSON.stringify({ hostId, name: "studio", routes: [`relay:${hostId}`] });
      socket.end(
        `HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: ${body.length}\r\nConnection: close\r\n\r\n${body}`,
      );
    });
  });
const listen = (server) => new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server.address().port)));
const hosts = {
  [hostId]: await listen(host({ minVersion: "TLSv1.3" })),
  tls12: await listen(host({ maxVersion: "TLSv1.2" })),
};

/** One WebSocket frame. Server frames aren't masked. */
function frame(opcode, payload) {
  const length = payload.length;
  const head = length < 126 ? Buffer.from([0x80 | opcode, length])
    : length < 65536 ? Buffer.from([0x80 | opcode, 126, length >> 8, length & 255])
    : Buffer.concat([Buffer.from([0x80 | opcode, 127]), (() => { const b = Buffer.alloc(8); b.writeBigUInt64BE(BigInt(length)); return b; })()]);
  return Buffer.concat([head, payload]);
}

/** Calls `onFrame(opcode, payload)` for each whole frame the client sends on `socket`. */
function frames(socket, onFrame) {
  let buffer = Buffer.alloc(0);
  socket.on("data", (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    for (;;) {
      if (buffer.length < 2) return;
      let length = buffer[1] & 127;
      let offset = 2;
      if (length === 126) { if (buffer.length < 4) return; length = buffer.readUInt16BE(2); offset = 4; }
      else if (length === 127) { if (buffer.length < 10) return; length = Number(buffer.readBigUInt64BE(2)); offset = 10; }
      if (buffer.length < offset + 4 + length) return;
      const mask = buffer.subarray(offset, offset + 4);
      const payload = Buffer.from(buffer.subarray(offset + 4, offset + 4 + length));
      for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i % 4];
      onFrame(buffer[0] & 15, payload);
      buffer = buffer.subarray(offset + 4 + length);
    }
  });
}

/** The relay: checks the path and the token in the header, then joins the stream to the host. */
let streams = 0;
const firstBytes = [];
const relay = createServer((socket) => {
  socket.once("data", (head) => {
    const text = head.toString("latin1");
    const [, path] = text.match(/^GET (\S+) HTTP/) ?? [];
    const hostKey = path?.match(/^\/v1\/hosts\/([^/]+)\/connect$/)?.[1];
    const auth = text.match(/\r\nauthorization: Bearer (\S+)\r\n/i)?.[1];
    const accept = text.match(/\r\nsec-websocket-key: (\S+)\r\n/i)?.[1];
    if (!hostKey || !(hostKey in hosts)) return socket.end("HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\n\r\n");
    if (auth !== TOKEN) return socket.end("HTTP/1.1 401 Unauthorized\r\nContent-Length: 0\r\n\r\n");
    streams++;
    const digest = createHash("sha1").update(accept + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").digest("base64");
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${digest}\r\n\r\n`);
    const plxd = connect(hosts[hostKey], "127.0.0.1", () => socket.write(frame(1, Buffer.from("ready"))));
    let first = true;
    frames(socket, (opcode, payload) => {
      if (opcode === 2) {
        if (first) firstBytes.push(payload[0]);
        first = false;
        plxd.write(payload);
      } else if (opcode === 8) {
        plxd.end();
        socket.end(frame(8, Buffer.alloc(0)));
      }
    });
    plxd.on("data", (bytes) => socket.write(frame(2, bytes)));
    plxd.on("close", () => socket.end(frame(8, Buffer.alloc(0))));
    plxd.on("error", () => socket.destroy());
    socket.on("error", () => plxd.destroy());
  });
});
const relayPort = await listen(relay);

const binary = join(scratch, "relay-test");
execFileSync("swiftc", [
  "-O", join(here, "../ios/Pinning.swift"), join(here, "../ios/RelayBridge.swift"), join(here, "main.swift"),
  "-o", binary,
], { stdio: "inherit" });
// Not spawnSync: the relay and the hosts run on this process's event loop.
const status = await new Promise((resolve) =>
  spawn(binary, [`ws://127.0.0.1:${relayPort}`, hostId, TOKEN], { stdio: "inherit" }).on("exit", resolve),
);

let failed = status !== 0;
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "ok" : "FAIL"} ${name}${detail ? `: ${detail}` : ""}`);
  if (!ok) failed = true;
};
check("each request opened its own stream", streams >= 3, `${streams} streams`);
check("the relay saw only TLS records", firstBytes.length > 0 && firstBytes.every((b) => b === 0x16), firstBytes.join(","));
check("the pinned host spoke TLS 1.3", protocols.filter((p) => p === "TLSv1.3").length >= 2, protocols.join(","));

relay.close();
rmSync(scratch, { recursive: true, force: true });
process.exit(failed ? 1 : 0);
