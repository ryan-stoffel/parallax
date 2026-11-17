import { test } from "node:test";
import assert from "node:assert/strict";
import { count, slowestGap, summary } from "./timing-summary.mjs";
test("same median, nearest-rank p95 and p99, and max on both products, including even samples", () => {
  assert.deepEqual(summary([4, 1, 3, 2]), { n: 4, medianMs: 3, p95Ms: 4, p99Ms: 4, maxMs: 4 });
  assert.deepEqual(summary(Array.from({ length: 30 }, (_, i) => i + 1)), { n: 30, medianMs: 16, p95Ms: 29, p99Ms: 30, maxMs: 30 });
  assert.deepEqual(summary(Array.from({ length: 200 }, (_, i) => i + 1)), { n: 200, medianMs: 101, p95Ms: 190, p99Ms: 198, maxMs: 200 });
  for (const value of ["0", "-1", "1.5", "NaN", "1001"]) assert.throws(() => count(value, "samples"));
  assert.equal(count("30", "samples"), 30);
  assert.throws(() => count("1999", "gap-ms", 60000, 2000));
});
test("a connect's slowest client gap and relay stage", () => {
  const row = (kind, stage, ms, observedMs = 0) => ({ dial: "relay", kind, stage, ms, observedMs });
  const stages = [
    row("connect-timing", "main", 0.001, 16),
    row("connect-timing", "outer_tls_ready", 69.2),
    row("connect-server-timing", "worker", 700),
    row("connect-server-timing", "stream_join", 607),
    row("connect-server-timing", "host_open", 43),
    row("connect-timing", "relay_upgrade_ready", 761.6),
    row("connect-timing", "connected", 800.1),
  ];
  assert.deepEqual(slowestGap(stages), { gap: { stage: "relay_upgrade_ready", ms: 692 }, relay: { stage: "stream_join", ms: 607 } });
  assert.deepEqual(slowestGap([]), { gap: undefined, relay: undefined });
});
