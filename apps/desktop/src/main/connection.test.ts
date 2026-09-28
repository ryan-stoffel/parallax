import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";

import { afterEach, beforeEach, expect, test, vi } from "vite-plus/test";

import { PROTOCOL_VERSION } from "../protocol/generated/protocol";
import type { ConnectionState, SubscriptionMessage } from "../preload/bridge";
import { backoffMs, Connection } from "./connection";

type Message = Record<string, unknown> & {
  id?: number;
  method?: string;
  params?: Record<string, unknown>;
};

// Real wire messages from wisp-protocol's samples.
const sample = (name: string) =>
  JSON.parse(
    readFileSync(
      new URL(`../../../../crates/wisp-protocol/samples/v1/${name}`, import.meta.url),
      "utf8",
    ),
  ) as Message[];
const initialized = sample("handshake.json")[1]!["result"] as Record<string, unknown>;
const incompatible = sample("handshake-incompatible.json")[1]!["error"];
const resyncRequired = sample("resync.json")[1]!["error"];

/** A `wispd attach` child whose stdio is driven synchronously by the test. */
class FakeChild extends EventEmitter {
  sent: Message[] = [];
  stdin = Object.assign(new EventEmitter(), {
    write: (line: string) => this.sent.push(JSON.parse(line) as Message),
  });
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  kill = vi.fn(() => true);

  /** Sends lines from wispd, all in one chunk. */
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
let states: ConnectionState[];
let located: string | undefined;
const child = () => children.at(-1)!;
const state = () => states.at(-1);

function connect() {
  const connection = new Connection({
    locate: () => located,
    clientVersion: "0.0.1",
    onState: (next) => states.push(next),
    spawn: () => {
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
  states = [];
  located = "/bin/wispd";
});
afterEach(() => {
  vi.useRealTimers();
});

test("handshakes, then heartbeats, and reconnects when wispd goes silent", () => {
  connect();
  expect(child().request("initialize").params).toMatchObject({
    protocol: { min: PROTOCOL_VERSION, max: PROTOCOL_VERSION },
    client: { name: "wisp", version: "0.0.1" },
  });
  expect(state()).toEqual({ status: "connecting" });
  child().handshake();
  expect(state()).toEqual({ status: "connected", wispd: "0.1.0", protocol: 1 });

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
    error: { reason: "incompatibleProtocol" },
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
  child().stderr.emit("data", Buffer.from("wispd attach: timed out\n"));
  child().emit("close", 4, null);
  expect(state()).toMatchObject({
    status: "failed",
    error: { reason: "exited", exitCode: 4, stderr: "wispd attach: timed out" },
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

test("a subscribe after a new logId, with a seq from the old log, resyncs", async () => {
  const connection = connect();
  child().handshake("log-1");
  const answer = connection.request("project/list", {});
  child().reply({ id: child().request("project/list").id, result: { projects: [], seq: 40 } });
  const snapshot = await answer;
  expect(snapshot).toEqual({ result: { projects: [], seq: 40 }, logId: "log-1" });
  if (!("result" in snapshot)) return;

  // wispd starts over with a fresh log before the renderer subscribes.
  child().emit("close", 0, null);
  vi.advanceTimersByTime(1000);
  child().handshake("log-2");
  const listener = vi.fn();
  connection.subscribe({ after: snapshot.result.seq, logId: snapshot.logId }, listener);
  expect(listener).toHaveBeenCalledWith({ type: "resync" });
  expect(child().sent.some((message) => message.method === "events/subscribe")).toBe(false);
});
