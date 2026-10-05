import { spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";

import { afterEach, beforeEach, expect, test, vi } from "vite-plus/test";

import { PROTOCOL_VERSION } from "../protocol/generated/protocol";
import type { ConnectionState, SubscriptionMessage } from "../preload/bridge";
import { backoffMs, Connection, exitError, sshCommand } from "./connection";

type Message = Record<string, unknown> & {
  id?: number;
  method?: string;
  params?: Record<string, unknown>;
};

// Real wire messages from parallax-protocol's samples.
const sample = (name: string) =>
  JSON.parse(
    readFileSync(
      new URL(`../../../../crates/parallax-protocol/samples/v1/${name}`, import.meta.url),
      "utf8",
    ),
  ) as Message[];
const initialized = sample("handshake.json")[1]!["result"] as Record<string, unknown>;
const incompatible = sample("handshake-incompatible.json")[1]!["error"];
const resyncRequired = sample("resync.json")[1]!["error"];

/** A `plxd attach` child whose stdio is driven synchronously by the test. */
class FakeChild extends EventEmitter {
  sent: Message[] = [];
  stdin = Object.assign(new EventEmitter(), {
    write: (line: string) => this.sent.push(JSON.parse(line) as Message),
  });
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  kill = vi.fn(() => true);

  /** Sends lines from plxd, all in one chunk. */
  reply(...messages: object[]) {
    const lines = messages.map((message) => `${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
    this.stdout.emit("data", Buffer.from(lines.join("")));
  }
  request(method: string) {
    return this.sent.findLast((message) => message.method === method)!;
  }
  handshake(logId = "log-1") {
    this.reply({ id: this.request("initialize").id, result: { ...initialized, logId } });
  }
}

let children: FakeChild[];
/** Each spawn's program and arguments. */
let spawned: string[][];
let states: ConnectionState[];
let located: string | undefined;
const child = () => children.at(-1)!;
const state = () => states.at(-1);

function connect(destination?: string) {
  const connection = new Connection({
    command: () =>
      destination
        ? sshCommand(destination)
        : located === undefined
          ? undefined
          : [located, "attach"],
    ...(destination !== undefined && { destination }),
    clientVersion: "0.0.1",
    onState: (next) => states.push(next),
    spawn: (file, args) => {
      spawned.push([file, ...args]);
      children.push(new FakeChild());
      return child() as unknown as ChildProcessWithoutNullStreams;
    },
  });
  connection.start();
  return connection;
}

beforeEach(() => {
  vi.useFakeTimers();
  children = [];
  spawned = [];
  states = [];
  located = "/bin/plxd";
});
afterEach(() => {
  vi.useRealTimers();
});

test("handshakes, then heartbeats, and reconnects when plxd goes silent", () => {
  connect();
  expect(child().request("initialize").params).toMatchObject({
    protocol: { min: PROTOCOL_VERSION, max: PROTOCOL_VERSION },
    client: { name: "parallax", version: "0.0.1" },
  });
  expect(state()).toEqual({ status: "connecting" });
  child().handshake();
  expect(state()).toEqual({ status: "connected", plxd: "0.1.0", protocol: 1, capabilities: {} });

  vi.advanceTimersByTime(30_000);
  const health = child().request("host/health");
  child().reply({ id: health.id, result: { uptimeSeconds: 30, store: "ok", runningAgents: 0 } });
  vi.advanceTimersByTime(10_000);
  expect(state()?.status).toBe("connected");

  vi.advanceTimersByTime(20_000 + 10_000); // The next heartbeat gets no answer.
  expect(child().kill).toHaveBeenCalled();
  expect(state()).toMatchObject({
    status: "failed",
    error: { reason: "unresponsive" },
    retrying: true,
  });
  vi.advanceTimersByTime(1000);
  expect(children).toHaveLength(2);
});

test("an incompatible protocol stops retrying until retry()", () => {
  const connection = connect();
  child().reply({ id: child().request("initialize").id, error: incompatible });
  expect(state()).toMatchObject({
    status: "failed",
    // Its version rides along, so a packaged app can replace an old plxd (hosts.ts).
    error: { reason: "incompatibleProtocol", plxd: "0.1.0" },
    retrying: false,
  });
  vi.advanceTimersByTime(60_000);
  expect(children).toHaveLength(1);
  connection.retry();
  expect(children).toHaveLength(2);
});

test("a usage error from attach (exit 2) stops retrying", () => {
  connect();
  child().emit("close", 2, null);
  expect(state()).toMatchObject({ status: "failed", error: { exitCode: 2 }, retrying: false });
  vi.advanceTimersByTime(60_000);
  expect(children).toHaveLength(1);
});

test("not found fails without spawning anything", () => {
  located = undefined;
  connect();
  expect(children).toHaveLength(0);
  expect(state()).toMatchObject({
    status: "failed",
    error: { reason: "notFound" },
    retrying: false,
  });
});

test("reports attach's exit code and stderr, and backs off from 1 s to 10 s", () => {
  expect([0, 1, 2, 3, 4, 5].map(backoffMs)).toEqual([1000, 2000, 4000, 8000, 10_000, 10_000]);
  connect();
  child().stderr.emit("data", Buffer.from("plxd attach: timed out\n"));
  child().emit("close", 4, null);
  expect(state()).toMatchObject({
    status: "failed",
    error: { reason: "exited", exitCode: 4, stderr: "plxd attach: timed out" },
    retrying: true,
  });
  vi.advanceTimersByTime(999);
  expect(children).toHaveLength(1);
  vi.advanceTimersByTime(1);
  expect(children).toHaveLength(2);
  child().emit("close", 4, null);
  expect(state()).toMatchObject({ error: { exitCode: 4 } });
  expect(state()).not.toHaveProperty("error.stderr"); // The first run's stderr isn't carried over.
  vi.advanceTimersByTime(1999);
  expect(children).toHaveLength(2);
  vi.advanceTimersByTime(1);
  expect(children).toHaveLength(3);
});

test("resumes a subscription from the last seq after a reconnect", () => {
  const connection = connect();
  child().handshake();
  const messages: SubscriptionMessage[] = [];
  connection.subscribe({ after: 0, logId: "log-1" }, (message) => messages.push(message));
  const subscribe = child().request("events/subscribe");
  expect(subscribe.params).toEqual({ after: 0 });

  // The response and its first events in one chunk: none may be lost.
  const event = (seq: number) => ({
    method: "events/event",
    params: { subscription: "sub-1", seq, time: "2026-09-27T00:00:00Z", event: { kind: "x" } },
  });
  child().reply({ id: subscribe.id, result: { subscription: "sub-1" } }, event(1), event(2));
  expect(messages.map((message) => message.type === "event" && message.event.seq)).toEqual([1, 2]);

  child().emit("close", 0, null);
  vi.advanceTimersByTime(1000);
  child().handshake();
  expect(child().request("events/subscribe").params).toEqual({ after: 2 });
});

test("resyncRequired ends the subscription with a resync", () => {
  const connection = connect();
  child().handshake();
  const listener = vi.fn();
  connection.subscribe({ after: 1, logId: "log-1" }, listener);
  child().reply({ id: child().request("events/subscribe").id, error: resyncRequired });
  expect(listener).toHaveBeenCalledWith({ type: "resync" });
});

test("events/resync ends only its subscription, and the connection stays up", () => {
  const connection = connect();
  expect(child().request("initialize").params).toMatchObject({
    capabilities: { resyncNotice: {} },
  });
  child().handshake();
  const lagging = vi.fn();
  const other = vi.fn();
  connection.subscribe({ after: 0, logId: "log-1" }, lagging);
  const first = child().request("events/subscribe");
  connection.subscribe({ after: 0, logId: "log-1" }, other);
  const second = child().request("events/subscribe");
  child().reply(
    { id: first.id, result: { subscription: "sub-1" } },
    { id: second.id, result: { subscription: "sub-2" } },
    { method: "events/resync", params: { subscription: "sub-1" } },
    {
      method: "events/event",
      params: { subscription: "sub-2", seq: 7, time: "2026-09-27T00:00:00Z", event: { kind: "x" } },
    },
  );
  expect(lagging.mock.calls).toEqual([[{ type: "resync" }]]);
  expect(other).toHaveBeenCalledWith(expect.objectContaining({ type: "event" }));
  expect(other).not.toHaveBeenCalledWith({ type: "resync" });
  expect(state()?.status).toBe("connected");
  expect(children).toHaveLength(1);
});

test("a new logId after a reconnect ends every subscription with a resync", () => {
  const connection = connect();
  child().handshake("log-1");
  const listener = vi.fn();
  connection.subscribe({ after: 5, logId: "log-1" }, listener);
  child().emit("close", 0, null);
  vi.advanceTimersByTime(1000);
  child().handshake("log-2");
  expect(listener).toHaveBeenCalledWith({ type: "resync" });
  expect(child().sent.some((message) => message.method === "events/subscribe")).toBe(false);
});

test("a mutating request sends commandId and a failed retry reuses it", async () => {
  const connection = connect();
  child().handshake();
  const params = { project: "01901234-5678-7abc-89ab-cdef01234567" };
  const first = connection.request("project/delete", params);
  const sent = child().request("project/delete");
  expect(sent.params?.commandId).toMatch(
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
  );
  child().reply({ id: sent.id, error: { code: -32603, message: "lost" } });
  await first;

  const retry = connection.request("project/delete", params);
  const again = child().request("project/delete");
  expect(again.params?.commandId).toBe(sent.params?.commandId);
  child().reply({ id: again.id, result: {} });
  await retry;

  const next = connection.request("project/delete", params);
  const third = child().request("project/delete");
  expect(third.params?.commandId).not.toBe(sent.params?.commandId);
  child().reply({ id: third.id, result: {} });
  await next;
});

test("a subscribe after a new logId, with a seq from the old log, resyncs", async () => {
  const connection = connect();
  child().handshake("log-1");
  const answer = connection.request("project/list", {});
  child().reply({ id: child().request("project/list").id, result: { projects: [], seq: 40 } });
  const snapshot = await answer;
  expect(snapshot).toEqual({ result: { projects: [], seq: 40 }, logId: "log-1" });
  if (!("result" in snapshot)) return;

  // plxd starts over with a fresh log before the renderer subscribes.
  child().emit("close", 0, null);
  vi.advanceTimersByTime(1000);
  child().handshake("log-2");
  const listener = vi.fn();
  connection.subscribe({ after: snapshot.result.seq, logId: snapshot.logId }, listener);
  expect(listener).toHaveBeenCalledWith({ type: "resync" });
  expect(child().sent.some((message) => message.method === "events/subscribe")).toBe(false);
});

test("an SSH host runs attach through ssh with 0022's options", () => {
  connect("mini");
  expect(spawned.map((argv) => argv.join(" "))).toEqual([
    "ssh -T -o BatchMode=yes -o ConnectTimeout=10 -o ControlPath=none -- mini plxd attach",
  ]);
  child().handshake();
  expect(state()).toMatchObject({ status: "connected" });
});

// Proves this OS's ssh, Windows' OpenSSH included, accepts the options (0023). `-G` only prints
// the resolved config, so nothing connects.
test.skipIf(spawnSync("ssh", ["-V"]).error)("this OS's ssh accepts the command line", () => {
  const [ssh, ...args] = sshCommand("example.invalid");
  const run = spawnSync(ssh!, ["-G", ...args], { encoding: "utf8" });
  expect(run.stderr).not.toMatch(/Bad configuration option|unsupported option/i);
  expect(run.status).toBe(0);
});

test("text from the host's shell before the handshake fails at once, without retrying", () => {
  connect("mini");
  child().stdout.emit("data", Buffer.from("Welcome to mini!\n"));
  expect(child().kill).toHaveBeenCalled();
  expect(state()).toMatchObject({
    status: "failed",
    error: { reason: "sshSetup", message: expect.stringContaining("mini's shell printed text") },
    retrying: false,
  });
  vi.advanceTimersByTime(60_000);
  expect(children).toHaveLength(1);
});

test("a stray line after the handshake is skipped", () => {
  connect("mini");
  child().handshake();
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  child().stdout.emit("data", Buffer.from("not json\n"));
  expect(state()).toMatchObject({ status: "connected" });
  expect(warn).toHaveBeenCalled();
  warn.mockRestore();
});

test("an ssh error that needs the user stops retrying until retry()", () => {
  const connection = connect("mini");
  child().stderr.emit("data", Buffer.from("Host key verification failed.\r\n"));
  child().emit("close", 255, null);
  expect(state()).toMatchObject({
    status: "failed",
    error: { reason: "sshSetup", exitCode: 255, stderr: "Host key verification failed." },
    retrying: false,
  });
  vi.advanceTimersByTime(60_000);
  expect(children).toHaveLength(1);
  connection.retry();
  expect(children).toHaveLength(2);
});

test("ssh failures read as what to do", () => {
  const ssh = (code: number, stderr: string, platform: NodeJS.Platform = "darwin") =>
    exitError(code, null, stderr, "mini", platform);
  expect(ssh(255, "Host key verification failed.")).toMatchObject({
    reason: "sshSetup",
    message: "mini's host key isn't trusted yet. To accept it, run `ssh mini` once in a terminal.",
  });
  const changed = "@@@ WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED! @@@";
  expect(ssh(255, `${changed}\nHost key verification failed.`)).toMatchObject({
    reason: "sshSetup",
    message: expect.stringContaining("host key has changed"),
  });

  const denied = "me@mini: Permission denied (publickey,password,keyboard-interactive).";
  expect(ssh(255, denied)).toMatchObject({
    reason: "sshSetup",
    message: expect.stringContaining("If your key has a passphrase, run `ssh-add`."),
  });
  expect(ssh(255, denied, "win32").message).toContain("start the ssh-agent service");

  const notOnPath = "plxd isn't on mini's PATH for ssh commands.";
  expect(ssh(127, "zsh:1: command not found: plxd")).toMatchObject({
    reason: "notFound",
    message: expect.stringContaining(notOnPath),
  });
  const cmd = "'plxd' is not recognized as an internal or external command,";
  expect(ssh(1, cmd).message).toContain(notOnPath);

  const unknown = "ssh: Could not resolve hostname mini: nodename nor servname provided";
  expect(ssh(255, unknown)).toMatchObject({
    reason: "exited",
    message: "Couldn't find mini. Check its name, or your ssh config.",
  });
  expect(ssh(255, "ssh: connect to host mini port 22: Operation timed out").message).toBe(
    "Couldn't reach mini. Check that it's on and accepts ssh.",
  );
  // attach's own exit on the host keeps its meaning.
  expect(ssh(4, "plxd attach: timed out").message).toBe(
    "plxd couldn't be reached or started on mini",
  );
});
