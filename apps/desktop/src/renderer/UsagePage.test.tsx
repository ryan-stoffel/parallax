import { expect, test, vi } from "vite-plus/test";

import type { UsageDay } from "../protocol/generated/protocol";
import { buckets, summarize, tokensOf, type Range } from "./usageStats";
import { dayKey } from "./profile";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const midnight = (at: number) => new Date(at).setHours(0, 0, 0, 0);

/** A day of `tokens` input tokens on `at`'s local day, costing `cost` micro-dollars when it says. */
const usage = (at: number, agent: string, model: string, tokens: number, cost?: number) =>
  ({
    date: dayKey(at),
    agent: agent as UsageDay["agent"],
    model,
    inputTokens: tokens,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    ...(cost !== undefined && { costUsdMicros: cost }),
  }) satisfies UsageDay;

test("ranges are whole local days ending today, and the range before is as long", () => {
  const now = new Date(2026, 8, 29, 18, 0).getTime();
  const today = buckets("today", now);
  expect(today.starts).toEqual([midnight(now)]);
  expect(today.previous).toEqual([midnight(now - DAY)]);
  expect(today.partial).toBe(0.75);

  const month = buckets("30d", now);
  expect(month.starts).toHaveLength(30);
  expect(month.starts.at(-1)).toBe(midnight(now));
  expect(month.previous).toHaveLength(30);
  expect([...month.previous, ...month.starts].every((s) => midnight(s) === s)).toBe(true);
  expect(new Set([...month.previous, ...month.starts]).size).toBe(60);
  expect(month.previous.at(-1)).toBe(midnight(month.starts[0]! - HOUR));
  expect(dayKey(month.previous[0]!)).toBe("2026-08-01");
});

/** `range`'s summary over a flat `tokens` a day, today holding only the part of it so far. */
function flat(range: Range, now: number, tokens = 100) {
  const span = buckets(range, now);
  const days = [...span.previous, ...span.starts].map((start) =>
    usage(start, "claude", "opus", start === span.starts.at(-1) ? tokens * span.partial : tokens),
  );
  return { span, summary: summarize(days, span.starts, span.previous, span.partial) };
}

test("days stay local days across a daylight saving change", () => {
  // Node follows a change to TZ at once.
  vi.stubEnv("TZ", "America/New_York");
  try {
    // New York falls back on Sunday, November 1, 2026: that day has 25 hours.
    const now = new Date(2026, 10, 3, 14, 30).getTime();
    expect(new Date(now).getTimezoneOffset()).toBe(300);
    const { span, summary } = flat("7d", now);
    expect(span.starts.every((s) => new Date(s).getHours() === 0)).toBe(true);
    const lengths = span.starts.slice(1).map((s, i) => (s - span.starts[i]!) / HOUR);
    expect(lengths.sort((a, b) => a - b)).toEqual([24, 24, 24, 24, 24, 25]);
    expect(summary.byBucket.every((m) => tokensOf(m) > 0)).toBe(true);
  } finally {
    vi.unstubAllEnvs();
  }
});

test("days sum by agent, model, and bucket, keep unreported cost apart, and count the range before", () => {
  const now = new Date(2026, 8, 29, 12, 0).getTime();
  const { starts, previous, partial } = buckets("7d", now);
  const last = starts.at(-1)!;
  const summary = summarize(
    [
      // Before the range before: left out.
      usage(previous[0]! - DAY, "claude", "opus", 1000, 9_000_000),
      usage(previous[0]!, "claude", "opus", 40, 4_000_000),
      // The range before's last day counts only as far as today has come.
      usage(previous.at(-1)!, "codex", "gpt", 10),
      usage(last - DAY, "claude", "opus", 100, 2_000_000),
      usage(last, "claude", "opus", 50, 1_000_000),
      usage(last, "codex", "gpt", 10),
      usage(last, "cursor", "composer", 5, 500_000),
    ],
    starts,
    previous,
    partial,
  );
  expect(tokensOf(summary.total)).toBe(100 + 50 + 10 + 5);
  expect(summary.total.cost).toBe(3_500_000);
  expect(summary.total.unpriced).toBe(10);
  expect(summary.previous).toMatchObject({ input: 45, cost: 4_000_000, unpriced: 5 });
  expect(summary.backends.map((b) => [b.backend, tokensOf(b.total)])).toEqual([
    ["claude", 150],
    ["codex", 10],
    ["cursor", 5],
  ]);
  expect(tokensOf(summary.byBucket.at(-1)!)).toBe(65);
  expect(tokensOf(summary.byBucket.at(-2)!)).toBe(100);
  expect(summary.models.map((m) => m.model).sort()).toEqual(["composer", "gpt", "opus"]);
  const opus = summary.models.find((m) => m.model === "opus")!;
  expect(opus.byBucket.map((m) => m.cost).slice(-2)).toEqual([2_000_000, 1_000_000]);
});
