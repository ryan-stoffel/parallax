import { expect, test } from "vite-plus/test";

import type { UsageHour } from "../protocol/generated/protocol";
import { buckets, niceTop, summarize, tokensOf } from "./UsagePage";

const HOUR = 3_600_000;
const midnight = (at: number) => new Date(at).setHours(0, 0, 0, 0);

test("ranges end now: the last 24 hours, or whole local days ending today", () => {
  const now = Date.parse("2026-09-29T19:42:00Z");
  const day = buckets("24h", now);
  expect(day.hourly).toBe(true);
  expect(day.starts).toHaveLength(24);
  expect(day.starts.at(-1)).toBe(Date.parse("2026-09-29T19:00:00Z"));
  expect(day.starts[0]).toBe(Date.parse("2026-09-28T20:00:00Z"));

  const week = buckets("7d", now);
  expect(week.hourly).toBe(false);
  expect(week.starts).toHaveLength(7);
  expect(week.starts.at(-1)).toBe(midnight(now));
  expect(week.starts.every((s) => midnight(s) === s)).toBe(true);
});

test("history sums by backend, model, and bucket, and keeps unreported cost apart", () => {
  const now = Date.parse("2026-09-29T19:42:00Z");
  const { starts, hourly } = buckets("24h", now);
  const hour = (at: number, accountId: string, model: string, tokens: number, cost?: number) =>
    ({
      hour: new Date(at).toISOString(),
      accountId,
      model,
      inputTokens: tokens,
      outputTokens: 0,
      cacheReadTokens: tokens,
      cacheWriteTokens: 0,
      ...(cost !== undefined && { costUsdMicros: cost }),
    }) satisfies UsageHour;
  const last = starts.at(-1)!;
  const summary = summarize(
    [
      {
        hours: [
          // Before the range: from an answer for a longer one.
          hour(starts[0]! - HOUR, "claude", "opus", 1000, 1_000_000),
          hour(last - HOUR, "claude", "opus", 100, 2_000_000),
          hour(last, "claude", "opus", 50, 1_000_000),
          hour(last, "codex", "gpt", 10),
          // An API key's account counts under its provider's backend.
          hour(last, "key-1", "sonnet", 5, 500_000),
        ],
        runs: [
          { accountId: "claude", runs: 3 },
          { accountId: "codex", runs: 1 },
        ],
        keys: [
          {
            id: "key-1",
            provider: "anthropic",
            label: "Work",
            maskedKey: "sk-…1",
            createdAt: "2026-09-01T00:00:00Z",
          },
        ],
      },
    ],
    starts,
    hourly,
  );
  expect(tokensOf(summary.total)).toBe(2 * (100 + 50 + 10 + 5));
  expect(summary.total.cost).toBe(3_500_000);
  expect(summary.total.unpriced).toBe(20);
  expect(summary.threads).toBe(4);
  expect(summary.backends.map((b) => [b.backend, b.threads, tokensOf(b.total)])).toEqual([
    ["claude", 3, 310],
    ["codex", 1, 20],
  ]);
  expect(tokensOf(summary.byBucket.at(-1)!)).toBe(130);
  expect(tokensOf(summary.byBucket.at(-2)!)).toBe(200);
  expect(summary.models.map((m) => m.model).sort()).toEqual(["gpt", "opus", "sonnet"]);
});

test("a chart's axis tops out at four even steps", () => {
  expect(niceTop(367)).toBe(400);
  expect(niceTop(950_000_000)).toBe(1_000_000_000);
  expect(niceTop(72)).toBe(80);
  expect(niceTop(0)).toBe(1);
});
