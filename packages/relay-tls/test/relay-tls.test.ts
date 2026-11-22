// RelayTls against a real plxd listener (PLX-1615). A WebSocket server stands in for the relay: it
// carries each binary frame to plxd's TCP listener and back, as a relay stream does, and keeps
// what the client sent, to check that nothing but the handshake reaches a host with another key.
// PLXD_PATH names the plxd to run, by default the workspace's debug build.

import assert from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { connect, createServer, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { after, before, test } from "node:test";

import { WebSocketServer } from "ws";

import { loadRelayTls, RelayTls, type RelayPin } from "../src/relay-tls.ts";

const root = path.join(import.meta.dirname, "../../..");
const plxd = process.env["PLXD_PATH"] ?? path.join(root, "target/debug/plxd");

let attach: ChildProcessWithoutNullStreams;
let dataDir: string;
let bridge: WebSocketServer;
let bridgeUrl: string;
let hostId: string;
let fingerprint: string;
/** What each connection through the bridge sent toward plxd, in order of connection. */
const sent: Buffer[][] = [];

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

before(async () => {
  await loadRelayTls(readFileSync(path.join(import.meta.dirname, "../pkg/parallax_browser_tls_bg.wasm")));
  dataDir = mkdtempSync(path.join(tmpdir(), "parallax-relay-tls-"));
  // A tailscale that finds no tailnet, so this plxd never reaches a real one.
  const bin = path.join(dataDir, "bin");
  mkdirSync(bin);
  writeFileSync(path.join(bin, "tailscale"), "#!/bin/sh\nexit 1\n");
  chmodSync(path.join(bin, "tailscale"), 0o755);
  const port = await freePort();
  attach = spawn(plxd, ["attach"], {
    env: {
      ...process.env,
      PATH: `${bin}${path.delimiter}${process.env["PATH"] ?? ""}`,
      PLXD_DATA_DIR: dataDir,
      PLXD_REMOTE_PORT: String(port),
    },
  });
  const waiting = new Map<number, (message: Record<string, unknown>) => void>();
  createInterface({ input: attach.stdout }).on("line", (line) => {
    const message = JSON.parse(line) as { id?: number };
    if (message.id !== undefined) waiting.get(message.id)?.(message);
  });
  let id = 0;
  const call = (method: string, params: object) =>
    new Promise<Record<string, any>>((resolve) => {
      waiting.set(++id, resolve);
      attach.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });
  await call("initialize", { protocol: { min: 1, max: 1 }, client: { name: "relay-tls", version: "0" }, capabilities: {} });
  await call("host/settings/set", { remote: true });
  for (let tries = 0; ; tries++) {
    const { result } = await call("remote/sessions", {});
    if (result.listening) {
      fingerprint = result.fingerprint;
      break;
    }
    if (tries > 100) throw new Error(`plxd isn't listening: ${JSON.stringify(result)}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  hostId = (await call("relay/id", {})).result.hostId;

  bridge = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  bridge.on("connection", (socket) => {
    const toHost: Buffer[] = [];
    sent.push(toHost);
    const tcp = connect(port, "127.0.0.1");
    const queued: Buffer[] = [];
    tcp.on("connect", () => queued.splice(0).forEach((bytes) => tcp.write(bytes)));
    socket.on("message", (data: Buffer) => {
      toHost.push(data);
      if (tcp.connecting) queued.push(data);
      else tcp.write(data);
    });
    tcp.on("data", (data) => socket.send(data));
    tcp.on("close", () => socket.close());
    tcp.on("error", () => socket.close());
    socket.on("close", () => tcp.end());
  });
  await new Promise((resolve) => bridge.once("listening", resolve));
  bridgeUrl = `ws://127.0.0.1:${(bridge.address() as AddressInfo).port}`;
});

/** Whether process `pid` is still running. */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

after(async () => {
  bridge?.close();
  attach?.kill();
  // `plxd attach` started a serve for this data folder. Stop only that one, then remove the folder.
  const log = readFileSync(path.join(dataDir, "logs/plxd.log"), "utf8");
  const serves = [...log.matchAll(/listening.* pid=(\d+)/g)].map(([, pid]) => Number(pid));
  for (const pid of serves.filter((pid) => pid > 1 && alive(pid))) {
    process.kill(pid, "SIGTERM");
    for (let tries = 0; tries < 50 && alive(pid); tries++) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  rmSync(dataDir, { recursive: true, force: true });
});

const request = (route: string) =>
  new TextEncoder().encode(`GET ${route} HTTP/1.1\r\nHost: parallax\r\nConnection: close\r\n\r\n`);

/** Everything plxd sends until it closes the connection. */
async function readAll(tls: RelayTls): Promise<string> {
  const decoder = new TextDecoder();
  let text = "";
  for (let chunk = await tls.read(); chunk; chunk = await tls.read()) text += decoder.decode(chunk, { stream: true });
  return text;
}

/** The descriptor, read through pinned TLS. */
async function descriptor(pin: RelayPin, early: boolean) {
  const options = early ? { first: request("/.well-known/parallax") } : {};
  const tls = await RelayTls.connect(new WebSocket(bridgeUrl), pin, options);
  const { alpn, resumed, earlyAccepted } = tls;
  if (!early) tls.write(request("/.well-known/parallax"));
  const response = await readAll(tls);
  tls.close();
  return { alpn, resumed, earlyAccepted, response };
}

test("reaches plxd pinned to its host id, offering plxd-early-ws first", async () => {
  const { alpn, resumed, response } = await descriptor({ hostId }, false);
  assert.equal(alpn, "plxd-early-ws");
  assert.equal(resumed, false);
  assert.match(response, /^HTTP\/1\.1 200 /);
  assert.equal(JSON.parse(response.slice(response.indexOf("\r\n\r\n") + 4)).hostId, fingerprint);
});

test("a second connect to the same pin resumes with the request as early data", async () => {
  const { resumed, earlyAccepted, response } = await descriptor({ hostId }, true);
  assert.equal(resumed, true);
  assert.equal(earlyAccepted, true);
  assert.match(response, /^HTTP\/1\.1 200 /);
});

test("another pin to the same host has no ticket, and its first request waits for the handshake", async () => {
  const { resumed, earlyAccepted, response } = await descriptor({ fingerprint }, true);
  assert.equal(resumed, false);
  assert.equal(earlyAccepted, false);
  assert.match(response, /^HTTP\/1\.1 200 /);
});

test("a host with another key fails the handshake before any byte of HTTP is sent", async () => {
  const before = sent.length;
  const wrong = { hostId: "A".repeat(43) };
  await assert.rejects(
    RelayTls.connect(new WebSocket(bridgeUrl), wrong, { first: request("/.well-known/parallax") }),
    /the host's key isn't the pinned one/,
  );
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(sent.length, before + 1);
  // TLS records: a 5-byte header (type, version, length) and the body. The client's ClientHello
  // is a handshake record (22). After it, the only encrypted record (23) it may send is its alert,
  // 2 bytes and the inner type under a 16-byte tag: 19. Its Finished alone would be 53.
  const bytes = Buffer.concat(sent[before]!);
  const records: { type: number; length: number }[] = [];
  for (let at = 0; at < bytes.length; ) {
    const length = bytes.readUInt16BE(at + 3);
    records.push({ type: bytes[at]!, length });
    at += 5 + length;
  }
  assert.equal(records[0]?.type, 22);
  for (const record of records.slice(1)) {
    assert.ok(record.type === 20 || (record.type === 23 && record.length === 19), JSON.stringify(records));
  }
});
