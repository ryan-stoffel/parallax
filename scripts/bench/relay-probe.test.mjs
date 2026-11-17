import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { EventEmitter } from "node:events";
import vm from "node:vm";
import { slowestGap, summary } from "./timing-summary.mjs";

// Exercise the production sampling/check/report path without signing in or launching a daemon.
const source = readFileSync(process.env.RELAY_PROBE_SOURCE ?? new URL("./relay-probe.mjs", import.meta.url), "utf8");
const section = (start, end) => {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from);
  assert.ok(from >= 0 && to > from, `missing source section: ${start}`);
  return source.slice(from, to);
};
const streamCheck = section('    await check("Stream:', '\n    return true;');
const standIns = section("const STAND_INS", "\n// relay-probe.yml sets");
const helpers = [
  standIns,
  section("async function check(name, run)", "/** `work`, or an error"),
  section("function stderrOf(child)", "/**\n * The real thing"),
  section("const number =", "\nlet release;"),
].join("\n");

test("later connect/RPC failure retains completed samples and stage evidence while failing the report", async (t) => {
  for (const failure of ["connect", "rpc"]) await t.test(failure, async () => {
    let attempt = -1;
    const FAILING = 5;
    let healthCalls = 0;
    let clock = 0;
    const closed = [];
    const files = new Map();
    const checks = [];
    const metrics = {};
    const context = vm.createContext({
      checks, metrics, summary, slowestGap,
      networkInterfaces: () => ({ lo0: [{ family: "IPv4", address: "127.0.0.1", netmask: "255.0.0.0" }] }),
      options: { timings: true, out: "proof" },
      STREAMS: 3, ROUND_TRIPS: 3, GAP_MS: 1, PROBE_NAME: "fixture",
      performance: { now: () => (clock += 10) }, Buffer, console: { log() {}, error() {} },
      sleep: async () => {},
      ms: Math.round,
      makeRepo() {}, repo: "unused", uuid7: () => "unused",
      host: { call: async () => {} }, clerkToken: async () => "fake",
      within: async (_limit, what, work) => {
        if (failure === "connect" && attempt === FAILING && what === "connecting") throw new Error("connecting timed out");
        return work;
      },
      route: "relay:fixture",
      dial: (_args, _token, routes = ["relay:fixture"]) => {
        const child = new EventEmitter();
        child.stderr = new EventEmitter();
        child.stdout = new EventEmitter();
        child.attempt = ++attempt;
        child.app = routes.length > 1;
        child.kill = () => closed.push(child.attempt);
        return child;
      },
      dialRelay: (token) => context.dial([], token),
      attach: async (child) => {
        // Stage evidence also exists on the failing connect attempt.
        child.stderr.emit("data", "connect-timing dial_start 1.000\n");
        // A plxd from before PLX-1549, in the rpc case, never says it opened the relay early.
        if (child.app && failure === "connect") child.stderr.emit("data", "plxd dial: opened the relay's connection during the head start\n");
        if (!(failure === "connect" && child.attempt === FAILING)) {
          child.stderr.emit("data", "connected over relay: fixture\n");
          // The first subscription went behind `initialize`, so its event comes unasked.
          child.stdout.emit("data", '{"method":"events/event"}\n');
        }
        return {
          call: async (method) => {
            if (method === "host/health" && ++healthCalls === 3) throw new Error("RPC failed");
          },
          close: () => child.kill(),
        };
      },
      process: { env: {} }, relay: "http://fixture.invalid", skipReason: undefined,
      withoutToken: "unused", rotated: false, clean: String,
      join: (...parts) => parts.join("/"), mkdirSync() {}, appendFileSync() {},
      writeFileSync: (path, data) => files.set(path, data),
    });
    await vm.runInContext(`${helpers}\n(async () => { ${streamCheck} })()`, context);
    assert.equal(checks.length, 1);
    assert.equal(checks[0].ok, false);
    assert.match(checks[0].detail, failure === "connect" ? /connecting timed out/ : /RPC failed/);
    // Attempts: 0 warm-up; run 0 relay 1, app 2; run 1 app 3, relay 4; run 2 relay 5, which fails.
    const n = failure === "connect" ? 2 : 3;
    assert.equal(metrics.connect?.n, n);
    assert.equal(metrics.firstEvent?.n, n);
    assert.equal(metrics.appConnect?.n, 2);
    assert.equal(metrics.appFirstEvent?.n, 2);
    assert.deepEqual({ ...metrics.appDial }, { early: failure === "connect" ? 2 : 0, of: 2, route: "10.255.255.1:7341", headStart: 0 });
    assert.equal(metrics.connect.medianMs, metrics.appConnect.medianMs);
    assert.equal(metrics.stages?.length, 5);
    assert.ok(metrics.stages.every((stages) => stages.length === 1));
    assert.deepEqual([...metrics.stages].map((stages) => stages[0].dial), ["relay", "app", "app", "relay", "relay"]);
    if (failure === "connect") assert.equal(metrics.roundTrip, undefined);
    else assert.deepEqual({ ...metrics.roundTrip }, { n: 1, medianMs: 10, p95Ms: 10, p99Ms: 10, maxMs: 10 }); // Excludes the warm-up and failed RPC.
    // Every counted dial that connected, in attempt order beside its stages, and each round trip.
    const { connects, roundTrips } = metrics.samples;
    assert.deepEqual([...connects].map((sample) => sample.dial), ["relay", "app", "app", "relay", "relay"].slice(0, n + 2));
    assert.ok(connects.every((sample, i) => sample.gap.stage === "dial_start" && sample.atMs > (connects[i - 1]?.atMs ?? 0)));
    assert.equal(roundTrips.length, failure === "connect" ? 0 : 1);
    assert.deepEqual(closed, [0, 1, 2, 3, 4, 5]); // Includes the failed sampled connection.
    assert.equal(vm.runInContext("report(undefined, true)", context), false);
    const json = JSON.parse(files.get("proof/relay-probe.json"));
    assert.equal(json.ok, false); // The CLI maps this verdict to exit status 1.
    assert.equal(json.metrics.connect.n, n);
    const notes = files.get("proof/relay-probe-notes.md");
    assert.doesNotMatch(notes, /undefined|round trip 0 ms/);
    if (failure === "connect") assert.match(notes, /opened early on 2 of 2/);
    else assert.doesNotMatch(notes, /opened early/);
    assert.match(notes, /the relay started at once on each/);
    assert.match(notes, /connect p95 \d+ ms, p99 \d+ ms, max \d+ ms/);
    assert.match(notes, /App dial away from home/);
  });
});

test("the app dial's LAN route is a private address on none of this computer's networks", () => {
  const offNetwork = vm.runInNewContext(`${standIns}; offNetwork`);
  const net = (address, netmask) => ({ family: "IPv4", address, netmask });
  assert.equal(offNetwork({ en0: [net("192.168.1.50", "255.255.255.0")] }), "10.255.255.1");
  // A runner on 10/16 is off 10.255/16, and one on 10/8 moves on.
  assert.equal(offNetwork({ eth0: [net("10.1.0.4", "255.255.0.0")] }), "10.255.255.1");
  assert.equal(offNetwork({ eth0: [net("10.1.0.4", "255.0.0.0")] }), "172.31.255.1");
  assert.equal(offNetwork({ a: [net("10.1.0.4", "255.0.0.0")], b: [net("172.16.0.1", "255.240.0.0")] }), "192.168.255.1");
  assert.equal(offNetwork({ a: [net("10.0.0.1", "255.0.0.0"), net("172.31.0.1", "255.255.0.0"), net("192.168.0.1", "255.255.0.0")] }), undefined);
});
