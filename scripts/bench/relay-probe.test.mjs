import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { EventEmitter } from "node:events";
import vm from "node:vm";
import { summary } from "./timing-summary.mjs";

// Exercise the production sampling/check/report path without signing in or launching a daemon.
const source = readFileSync(process.env.RELAY_PROBE_SOURCE ?? new URL("./relay-probe.mjs", import.meta.url), "utf8");
const section = (start, end) => {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from);
  assert.ok(from >= 0 && to > from, `missing source section: ${start}`);
  return source.slice(from, to);
};
const streamCheck = section('    await check("Stream:', '\n    return true;');
const helpers = [
  section("async function check(name, run)", "/** `work`, or an error"),
  section("function stderrOf(child)", "/**\n * The real thing"),
  section("const number =", "\nlet release;"),
].join("\n");

test("later connect/RPC failure retains completed samples and stage evidence while failing the report", async (t) => {
  for (const failure of ["connect", "rpc"]) await t.test(failure, async () => {
    let attempt = -1;
    let healthCalls = 0;
    let clock = 0;
    const closed = [];
    const files = new Map();
    const checks = [];
    const metrics = {};
    const context = vm.createContext({
      checks, metrics, summary,
      options: { timings: true, out: "proof" },
      STREAMS: 3, ROUND_TRIPS: 3, GAP_MS: 1, PROBE_NAME: "fixture",
      performance: { now: () => (clock += 10) }, Buffer, console: { log() {}, error() {} },
      sleep: async () => {},
      ms: Math.round,
      makeRepo() {}, repo: "unused", uuid7: () => "unused",
      host: { call: async () => {} }, clerkToken: async () => "fake",
      within: async (_limit, what, work) => {
        if (failure === "connect" && attempt === 3 && what === "connecting") throw new Error("connecting timed out");
        return work;
      },
      dialStream: () => {
        const child = new EventEmitter();
        child.stderr = new EventEmitter();
        child.stdout = new EventEmitter();
        child.attempt = ++attempt;
        child.kill = () => closed.push(child.attempt);
        return child;
      },
      attach: async (child) => {
        // Stage evidence also exists on the failing connect attempt.
        child.stderr.emit("data", "connect-timing dial_start 1.000\n");
        if (!(failure === "connect" && child.attempt === 3)) {
          child.stderr.emit("data", "connected over relay: fixture\n");
        }
        return {
          call: async (method) => {
            if (method === "events/subscribe") child.stdout.emit("data", '{"method":"events/event"}\n');
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
    const n = failure === "connect" ? 2 : 3;
    assert.equal(metrics.connect?.n, n);
    assert.equal(metrics.firstEvent?.n, n);
    assert.equal(metrics.connect.medianMs, 20);
    assert.equal(metrics.firstEvent.medianMs, 30);
    assert.equal(metrics.stages?.length, 3);
    assert.ok(metrics.stages.every((stages) => stages.length === 1));
    assert.equal(metrics.stages[2][0].stage, "dial_start");
    if (failure === "connect") assert.equal(metrics.roundTrip, undefined);
    else assert.deepEqual(metrics.roundTrip, { n: 1, medianMs: 10, p95Ms: 10 }); // Excludes the warm-up and failed RPC.
    assert.deepEqual(closed, [0, 1, 2, 3]); // Includes the failed sampled connection.
    assert.equal(vm.runInContext("report(undefined, true)", context), false);
    const json = JSON.parse(files.get("proof/relay-probe.json"));
    assert.equal(json.ok, false); // The CLI maps this verdict to exit status 1.
    assert.equal(json.metrics.connect.n, n);
    assert.doesNotMatch(files.get("proof/relay-probe-notes.md"), /undefined|round trip 0 ms/);
  });
});
