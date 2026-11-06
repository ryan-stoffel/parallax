import { test } from "node:test";
import assert from "node:assert/strict";
import { count, summary } from "./timing-summary.mjs";
test("same median and nearest-rank p95 on both products, including even samples", () => {
  assert.deepEqual(summary([4, 1, 3, 2]), { n: 4, medianMs: 3, p95Ms: 4 });
  assert.deepEqual(summary(Array.from({ length: 30 }, (_, i) => i + 1)), { n: 30, medianMs: 16, p95Ms: 29 });
  for (const value of ["0", "-1", "1.5", "NaN", "1001"]) assert.throws(() => count(value, "samples"));
  assert.equal(count("30", "samples"), 30);
});
