/** Positive bounded sample counts, rejected before any account or process is touched. */
export function count(value, name, max = 1000, min = 1) {
  if (!/^\d+$/.test(value) || Number(value) < min || Number(value) > max) throw new Error(`${name} must be ${min}..${max}`);
  return Number(value);
}

/**
 * Arithmetic median, nearest-rank p95 and p99, and the max, rounded only for reporting. With fewer
 * than 100 samples the nearest-rank p99 is the max.
 */
export function summary(samples) {
  const sorted = samples.toSorted((a, b) => a - b);
  if (!sorted.length) throw new Error("no samples");
  const middle = Math.floor(sorted.length / 2);
  const median = sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
  const rank = (p) => Math.round(sorted[Math.ceil(p * sorted.length) - 1]);
  return { n: sorted.length, medianMs: Math.round(median), p95Ms: rank(0.95), p99Ms: rank(0.99), maxMs: Math.round(sorted.at(-1)) };
}

/**
 * Where one connect's time went, from its stage rows (relay-probe.mjs, PLX-1584). `gap` is the
 * largest difference between consecutive client markers, named by the later one. The first marker,
 * `main`, counts from the dial's spawn, so its gap is an upper bound on launch. `relay` is the
 * largest relay Server-Timing entry, leaving out `worker`, which spans the whole request, and
 * `spare`, a flag. Relay entries overlap, so `relay` sits inside the `relay_upgrade_ready` gap.
 */
export function slowestGap(stages) {
  const client = stages.filter((row) => row.kind === "connect-timing");
  let gap;
  client.forEach((row, index) => {
    const ms = index ? row.ms - client[index - 1].ms : row.observedMs - row.ms;
    if (!gap || ms > gap.ms) gap = { stage: row.stage, ms };
  });
  let relay;
  for (const row of stages) {
    if (row.kind !== "connect-server-timing" || row.stage === "worker" || row.stage === "spare") continue;
    if (!relay || row.ms > relay.ms) relay = { stage: row.stage, ms: row.ms };
  }
  return { gap: gap && { stage: gap.stage, ms: Math.round(gap.ms) }, relay: relay && { stage: relay.stage, ms: Math.round(relay.ms) } };
}
