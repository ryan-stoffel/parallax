/** Positive bounded sample counts, rejected before any account or process is touched. */
export function count(value, name, max = 1000) {
  if (!/^\d+$/.test(value) || Number(value) < 1 || Number(value) > max) throw new Error(`${name} must be 1..${max}`);
  return Number(value);
}

/** Arithmetic median and nearest-rank p95, rounded only for reporting. */
export function summary(samples) {
  const sorted = samples.toSorted((a, b) => a - b);
  if (!sorted.length) throw new Error("no samples");
  const middle = Math.floor(sorted.length / 2);
  const median = sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
  return { n: sorted.length, medianMs: Math.round(median), p95Ms: Math.round(sorted[Math.ceil(0.95 * sorted.length) - 1]) };
}
