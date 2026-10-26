import { spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";

import { afterEach, beforeEach, expect, test, vi } from "vite-plus/test";

import { PROTOCOL_VERSION } from "../protocol/generated/protocol";
import type {
  ConnectionError,
  ConnectionState,
  SubscriptionMessage,
  TerminalMessage,
  WatchMessage,
} from "../preload/bridge";
import { backoffMs, Connection, exitError, sshCommand, type ConnectionOptions } from "./connection";

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

function connect(destination?: string, replaceDaemon?: ConnectionOptions["replaceDaemon"]) {
  const connection = new Connection({
    command: () =>
      destination
        ? sshCommand(destination)
        : located === undefined
          ? undefined
          : [located, "attach"],
    ...(destination !== undefined && { destination }),
    clientVersion: "0.0.1",
    ...(replaceDaemon && { replaceDaemon }),
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

test.each([false, true])(
  "replaces the old daemon before publishing its handshake (incompatible: %s)",
  async (mismatch) => {
    let replaced!: (value: boolean) => void;
    const replaceDaemon = vi.fn(() => new Promise<boolean>((resolve) => (replaced = resolve)));
    const connection = connect(undefined, replaceDaemon);
    const old = child();
    connection.watch({ shell: true }, () => {});
    old.reply({
      id: old.request("initialize").id,
      ...(mismatch ? { error: incompatible } : { result: { ...initialized, plxd: "old" } }),
    });
    expect(replaceDaemon).toHaveBeenCalledOnce();
    expect(state()?.status).toBe("connecting");
    expect(old.sent.map((message) => message.method)).toEqual(["initialize"]);
    expect(await connection.request("host/health", {})).toHaveProperty("error");
    // serve exits during replacement. Do not reconnect until its service operation finishes.
    old.emit("close", 0, null);
    await vi.advanceTimersByTimeAsync(2000);
    expect(children).toHaveLength(1);
    replaced(true);
    await Promise.resolve();
    expect(children).toHaveLength(2);
    expect(states.some((next) => next.status === "connected")).toBe(false);
    child().handshake();
    replaced(false);
    await Promise.resolve();
    expect(state()?.status).toBe("connected");
    expect(child().request("orchestration/subscribeShell")).toBeDefined();
    connection.dispose();
  },
);

test("a failed local upgrade exposes its error and keeps retrying", async () => {
  let fails = true;
  const connection = connect(undefined, async () => {
    if (fails) throw new Error("service restart failed");
    return false;
  });
  child().handshake();
  await Promise.resolve();
  expect(state()).toMatchObject({
    status: "failed",
    retrying: true,
    error: { message: "Couldn't update the bundled local plxd: service restart failed" },
  });
  fails = false;
  await vi.advanceTimersByTimeAsync(1000);
  expect(children).toHaveLength(2);
  child().handshake();
  await Promise.resolve();
  expect(state()?.status).toBe("connected");
  connection.dispose();
});

test("the local upgrade asks a compatible plxd for its running agents", async () => {
  let agents: (() => Promise<number | undefined>) | undefined;
  const connection = connect(undefined, async (_version, runningAgents) => {
    agents = runningAgents;
    return false;
  });
  child().handshake();
  const asked = agents!();
  child().reply({
    id: child().request("host/health").id,
    result: { uptimeSeconds: 1, store: "ok", runningAgents: 2 },
  });
  expect(await asked).toBe(2);
  connection.dispose();
  // An incompatible one can't be asked.
  const old = connect(undefined, async (_version, runningAgents) => {
    agents = runningAgents;
    return false;
  });
  child().reply({ id: child().request("initialize").id, error: incompatible });
  expect(agents).toBeUndefined();
  old.dispose();
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

test("reports attach's exit code and stderr, and backs off from 1 s to 10 s", () => {
  expect([0, 1, 2, 3, 4, 5].map((n) => backoffMs(n))).toEqual([
    1000, 2000, 4000, 8000, 10_000, 10_000,
  ]);
  // keepServing's (hosts.ts): at most once every 5 minutes.
  expect([4, 8, 9, 20].map((n) => backoffMs(n, 300_000))).toEqual([
    16_000, 256_000, 300_000, 300_000,
  ]);
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

test("a watch starts from its snapshot, and resumes after its last seq on a reconnect or a resync (0059)", () => {
  const connection = connect();
  child().handshake();
  const messages: WatchMessage[] = [];
  connection.watch({ threadId: "t-1" }, (message) => messages.push(message));
  const first = child().request("orchestration/subscribeThread");
  expect(first.params).toEqual({ threadId: "t-1" });
  const event = (seq: number) => ({
    method: "events/event",
    params: { subscription: "sub-1", seq, time: "2026-09-27T00:00:00Z", event: { kind: "x" } },
  });
  const snapshot = { seq: 4, thread: {}, runs: [], events: [], more: false, requests: [] };
  // The response and its first events in one chunk: none may be lost, and none is a repeat.
  child().reply({ id: first.id, result: { subscription: "sub-1", snapshot } }, event(4), event(5));
  expect(messages.map((m) => (m.type === "event" ? m.event.seq : m.type))).toEqual(["snapshot", 5]);

  // A reconnect asks for the gap after the last seq; plxd replays it, with no snapshot.
  child().emit("close", 0, null);
  vi.advanceTimersByTime(1000);
  child().handshake();
  const resumed = child().request("orchestration/subscribeThread");
  expect(resumed.params).toEqual({ threadId: "t-1", afterSeq: 5 });
  child().reply(
    { id: resumed.id, result: { subscription: "sub-2" } },
    {
      ...event(6),
      params: { ...event(6).params, subscription: "sub-2" },
    },
  );
  expect(messages.at(-1)).toMatchObject({ type: "event", event: { seq: 6 } });

  // Fallen behind, it asks again after its last seq, and plxd answers with a fresh snapshot.
  child().reply({ method: "events/resync", params: { subscription: "sub-2" } });
  const again = child().request("orchestration/subscribeThread");
  expect(again.params).toEqual({ threadId: "t-1", afterSeq: 6 });
  child().reply({
    id: again.id,
    result: { subscription: "sub-3", snapshot: { ...snapshot, seq: 90 } },
  });
  expect(messages.at(-1)).toMatchObject({ type: "snapshot", snapshot: { seq: 90 } });

  // A new log numbers from scratch, so the next one starts from a snapshot.
  child().emit("close", 0, null);
  vi.advanceTimersByTime(1000);
  child().handshake("log-2");
  expect(child().request("orchestration/subscribeThread").params).toEqual({ threadId: "t-1" });
});

test("a disposed connection ends each watch with an error, so its owner opens it again", () => {
  const connection = connect();
  child().handshake();
  const ended = vi.fn();
  connection.watch({ threadId: "t-1" }, ended);
  connection.dispose();
  expect(ended).toHaveBeenCalledWith({
    type: "error",
    error: { code: expect.any(Number), message: expect.any(String) },
  });
});

test("routes a terminal's output, and opens a shell again after a reconnect (PLX-637)", async () => {
  const connection = connect();
  const capabilities = { terminals: {} };
  child().reply({ id: child().request("initialize").id, result: { ...initialized, capabilities } });
  const key = { threadId: "t1", terminalId: "drawer:local/t1" };
  const shell = { ...key, cwd: "/wt", cols: 80, rows: 24 };
  const command = { program: "codex", args: ["login"], env: {} };
  const signIn = { threadId: "", terminalId: "1:sign-in", command, cols: 80, rows: 24 };
  const shown: TerminalMessage[] = [];
  const signedIn: TerminalMessage[] = [];
  connection.attachTerminal(shell, (message) => shown.push(message));
  connection.attachTerminal(signIn, (message) => signedIn.push(message));
  const opened = connection.openTerminal(shell);
  child().reply({ id: child().request("terminal/open").id, result: {} });
  expect(await opened).toBeUndefined();
  child().reply(
    { method: "terminal/output", params: { ...key, data: "$ ", replay: true } },
    { method: "terminal/output", params: { ...key, data: "ls\r\n" } },
  );
  expect(shown).toEqual([
    { type: "replay", data: "$ " },
    { type: "data", data: "ls\r\n" },
  ]);
  connection.writeTerminal(key, "pwd\r");
  expect(child().request("terminal/write").params).toEqual({ ...key, data: "pwd\r" });
  connection.resizeTerminal(key, 100, 30);

  // plxd ends a command with its connection; a shell comes back at its last size.
  child().emit("close", 0, null);
  expect(signedIn).toEqual([{ type: "exit", exitCode: -1 }]);
  vi.advanceTimersByTime(1000);
  child().reply({ id: child().request("initialize").id, result: { ...initialized, capabilities } });
  expect(child().request("terminal/open").params).toEqual({ ...shell, cols: 100, rows: 30 });
  child().reply({ method: "terminal/exit", params: { ...key, exitCode: 0 } });
  expect(shown.at(-1)).toEqual({ type: "exit", exitCode: 0 });
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

test("a mutating request sends commandId and its timeout retry reuses it", async () => {
  const connection = connect();
  child().handshake();
  const params = { project: "01901234-5678-7abc-89ab-cdef01234567" };
  const first = connection.request("project/delete", params);
  const sent = child().request("project/delete");
  expect(sent.params?.["commandId"]).toMatch(
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
  );
  child().reply({ id: sent.id, error: { code: -32800, message: "timeout" } });
  await Promise.resolve();
  const again = child().request("project/delete");
  expect(again.params?.["commandId"]).toBe(sent.params?.["commandId"]);
  child().reply({ id: again.id, result: {} });
  await first;

  const next = connection.request("project/delete", params);
  const third = child().request("project/delete");
  expect(third.params?.["commandId"]).not.toBe(sent.params?.["commandId"]);
  child().reply({ id: third.id, result: {} });
  await next;
});

test("a request retries after reconnect with its original command id", async () => {
  const connection = connect();
  child().handshake();
  const pending = connection.request("project/delete", {
    project: "01901234-5678-7abc-89ab-cdef01234567",
  });
  const sent = child().request("project/delete");
  child().emit("close", 1, null);
  await Promise.resolve();
  connection.retry();
  child().handshake();
  await Promise.resolve();
  const retried = child().request("project/delete");
  expect(retried.params?.["commandId"]).toBe(sent.params?.["commandId"]);
  child().reply({ id: retried.id, result: {} });
  expect(await pending).toEqual({ result: {}, logId: "log-1" });
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
  const control =
    process.platform === "win32"
      ? "ControlPath=none"
      : "ControlMaster=no -o ControlPath=~/.ssh/parallax-%C";
  expect(spawned.map((argv) => argv.join(" "))).toEqual([
    `ssh -T -o BatchMode=yes -o ConnectTimeout=10 -o ${control} -- mini plxd attach`,
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

// The reason decides whether the connection retries (`fail`): only what the user must fix stops it.
test("an exit's reason: setup the user must do, a missing plxd, a refusal, or a passing failure", () => {
  const changed = "@@@ WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED! @@@";
  const denied = "me@mini: Permission denied (publickey,password,keyboard-interactive).";
  const cases: [number, string, ConnectionError["reason"], string?][] = [
    [255, "Host key verification failed.", "sshSetup"],
    [255, `${changed}\nHost key verification failed.`, "sshSetup"],
    [255, denied, "sshSetup"],
    [127, "zsh:1: command not found: plxd", "notFound"],
    // cmd.exe on a Windows host.
    [1, "'plxd' is not recognized as an internal or external command,", "notFound"],
    [255, "ssh: Could not resolve hostname mini: nodename nor servname provided", "exited"],
    [255, "ssh: connect to host mini port 22: Operation timed out", "exited"],
    [4, "plxd attach: timed out", "exited"],
    // A LAN computer that no longer knows this one, and one that's just unreachable.
    [5, "", "refused", "Studio"],
    [4, "", "exited", "Studio"],
  ];
  for (const [code, stderr, reason, lan] of cases) {
    const destination = lan ? undefined : "mini";
    expect(
      exitError(code, null, stderr, destination, "darwin", undefined, lan).reason,
      stderr,
    ).toBe(reason);
  }
});
