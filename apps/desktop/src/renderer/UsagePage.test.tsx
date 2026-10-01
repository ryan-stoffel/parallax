// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, test, vi } from "vite-plus/test";

import type { WispBridge } from "../preload/bridge";
import type { UsageHour } from "../protocol/generated/protocol";
import {
  attribute,
  buckets,
  change,
  niceTop,
  resetTime,
  stack,
  summarize,
  tokensOf,
  UsagePage,
  type Measures,
  type Range,
} from "./UsagePage";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

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

test("the range before is as long, ends where the range starts, and counts up to as far in", () => {
  const now = Date.parse("2026-09-29T19:42:00Z");
  const day = buckets("24h", now);
  expect(day.previous).toHaveLength(24);
  expect(day.previous.at(-1)).toBe(day.starts[0]! - HOUR);
  expect(day.previous[0]).toBe(Date.parse("2026-09-27T20:00:00Z"));
  expect(day.until).toBe(Date.parse("2026-09-28T19:42:00Z"));

  const month = buckets("30d", now);
  expect(month.previous).toHaveLength(30);
  expect(month.previous.every((s) => midnight(s) === s)).toBe(true);
  const before = new Date(month.starts[0]!);
  before.setDate(before.getDate() - 1);
  expect(month.previous.at(-1)).toBe(before.getTime());
  expect(new Set([...month.previous, ...month.starts]).size).toBe(60);
  // As far into the range before's last day as now is into today.
  expect(month.until - midnight(month.until)).toBe(now - midnight(now));
  expect(midnight(month.until)).toBe(month.previous.at(-1));
});

/** `range`'s summary over a flat `tokens` an hour from well before it to `now`. */
function flat(range: Range, now: number, tokens = 10) {
  const span = buckets(range, now);
  const hours: UsageHour[] = [];
  for (let at = span.previous[0]! - 24 * HOUR; at <= now; at += HOUR)
    hours.push(usage(Math.floor(at / HOUR) * HOUR, "claude", "opus", tokens, tokens * 100));
  const history = {
    hours: hours.filter((h) => Date.parse(h.hour) >= span.starts[0]!),
    runs: [],
    keys: [],
    previous: hours,
  };
  return {
    span,
    summary: summarize([history], span.starts, span.hourly, span.previous, span.until),
  };
}

test("a flat rate shows no change at any time of day, though the range's last bucket isn't over", () => {
  for (const clock of [
    [0, 30],
    [9, 30],
    [16, 5],
    [23, 50],
  ] as const)
    for (const range of ["24h", "7d", "30d"] as const) {
      const now = new Date(2026, 8, 29, ...clock).getTime();
      const { summary } = flat(range, now);
      expect(change(summary.total.cost, summary.previous!.cost)).toBe(0);
    }
});

test("days stay local days across a daylight saving change, and the change stays within an hour", () => {
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
    expect(new Date(span.until).getHours()).toBe(14);
    expect(new Date(span.until).getDate()).toBe(27);
    // The range really is an hour longer than the range before.
    expect(tokensOf(summary.total) - tokensOf(summary.previous!)).toBe(10);
  } finally {
    vi.unstubAllEnvs();
  }
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
  const opus = summary.models.find((m) => m.model === "opus")!;
  expect(opus.byBucket.map((m) => m.cost).slice(-2)).toEqual([2_000_000, 1_000_000]);
  // Without a second answer, there's nothing to compare with.
  expect(summary.previous).toBeUndefined();
});

/** An hour of `tokens` input tokens, costing `cost` micro-dollars when it says. */
const usage = (at: number, accountId: string, model: string, tokens: number, cost?: number) =>
  ({
    hour: new Date(at).toISOString(),
    accountId,
    model,
    inputTokens: tokens,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    ...(cost !== undefined && { costUsdMicros: cost }),
  }) satisfies UsageHour;

test("the range before sums only its own hours, and only when every host reached back", () => {
  const now = Date.parse("2026-09-29T19:42:00Z");
  const { starts, previous, hourly } = buckets("24h", now);
  const earlier = [
    // Before the range before: left out.
    usage(previous[0]! - HOUR, "claude", "opus", 1000, 9_000_000),
    usage(previous[0]!, "claude", "opus", 40, 4_000_000),
    usage(previous.at(-1)!, "codex", "gpt", 10),
    // In the range itself: the longer answer has it too, but it isn't the range before.
    usage(starts[0]!, "claude", "opus", 30, 3_000_000),
  ];
  const host = (hours: UsageHour[], previous?: UsageHour[]) => ({
    hours,
    runs: [],
    keys: [],
    ...(previous && { previous }),
  });
  const summary = summarize(
    [host([usage(starts[0]!, "claude", "opus", 30, 3_000_000)], earlier)],
    starts,
    hourly,
    previous,
  );
  expect(summary.previous).toMatchObject({ input: 50, cost: 4_000_000, unpriced: 10 });
  expect(summary.total).toMatchObject({ input: 30, cost: 3_000_000 });
  expect(
    summarize([host([], earlier), host([])], starts, hourly, previous).previous,
  ).toBeUndefined();
  // Hours from `until` on are past the point the range has reached.
  expect(
    summarize([host([], earlier)], starts, hourly, previous, previous.at(-1)!).previous,
  ).toMatchObject({ input: 40, unpriced: 0 });
});

test("a change is a fraction of the range before, and needs a range before with some", () => {
  expect(change(125, 100)).toBe(0.25);
  expect(change(50, 100)).toBe(-0.5);
  expect(change(100, 100)).toBe(0);
  expect(change(100, 0)).toBeUndefined();
  expect(change(100, undefined)).toBeUndefined();
});

test("models rank by the measure, share the whole, and the chart stacks two and the rest", () => {
  const now = Date.parse("2026-09-29T19:42:00Z");
  const { starts, hourly } = buckets("24h", now);
  const [first, last] = [starts[0]!, starts.at(-1)!];
  const summary = summarize(
    [
      {
        hours: [
          usage(first, "claude", "opus", 100, 6_000_000),
          usage(last, "claude", "opus", 100, 2_000_000),
          usage(first, "claude", "sonnet", 300, 1_000_000),
          usage(last, "claude", "haiku", 50, 500_000),
          usage(first, "claude", "haiku-2", 60, 500_000),
          // No reported cost, but the most tokens.
          usage(last, "codex", "gpt", 1000),
        ],
        runs: [],
        keys: [],
      },
    ],
    starts,
    hourly,
  );
  const cost = (m: Measures) => m.cost;
  const unreported = (m: Measures) => m.cost === 0 && m.unpriced > 0;
  const rows = attribute(summary.models, cost, unreported);
  // Ties on cost go to the model with more tokens.
  expect(rows.map((r) => [r.model.model, r.share, r.part])).toEqual([
    ["opus", 0.8, 0],
    ["sonnet", 0.1, 1],
    ["haiku-2", 0.05, 2],
    ["haiku", 0.05, 2],
    ["gpt", undefined, 2],
  ]);
  // The busiest model is the first with a share.
  expect(rows[0]!.model.model).toBe("opus");

  const parts = stack(rows, cost);
  expect(parts.map((p) => p.name)).toEqual(["opus", "sonnet", "2 other models"]);
  expect(parts[0]!.values.at(0)).toBe(6_000_000);
  expect(parts[0]!.values.at(-1)).toBe(2_000_000);
  expect(parts[2]!.values.at(0)).toBe(500_000);
  expect(parts[2]!.values.at(-1)).toBe(500_000);
  expect(parts.every((p) => p.values.length === starts.length)).toBe(true);

  // By tokens the list reorders, but every model keeps its part, and so its color.
  const byTokens = attribute(summary.models, tokensOf);
  expect(byTokens.map((r) => [r.model.model, r.part])).toEqual([
    ["gpt", 2],
    ["sonnet", 1],
    ["opus", 0],
    ["haiku-2", 2],
    ["haiku", 2],
  ]);
  expect(stack(byTokens, tokensOf).map((p) => [p.name, p.part])).toEqual([
    ["opus", 0],
    ["sonnet", 1],
    ["3 other models", 2],
  ]);
  expect(byTokens.map((r) => r.share!).reduce((a, b) => a + b)).toBeCloseTo(1);

  // With three models, the third part keeps its own name.
  const three = summary.models.filter((m) => m.model.startsWith("haiku") || m.model === "opus");
  expect(stack(attribute(three, tokensOf), tokensOf).map((p) => p.name)).toEqual([
    "opus",
    "haiku-2",
    "haiku",
  ]);

  // A tie on both measures falls to the name, whatever order the hours came in.
  const tied = summarize(
    [
      {
        hours: [
          usage(last, "claude", "b-model", 10, 100),
          usage(last, "claude", "a-model", 10, 100),
        ],
        runs: [],
        keys: [],
      },
    ],
    starts,
    hourly,
  );
  expect(attribute(tied.models, cost).map((r) => [r.model.model, r.part])).toEqual([
    ["a-model", 0],
    ["b-model", 1],
  ]);
});

test("a reset says its day when it isn't today", () => {
  const at = (day: number, hour: number) => new Date(2026, 9, day, hour).getTime();
  // Thursday, October 1, at 10 PM.
  const now = at(1, 22);
  expect(resetTime(at(1, 23), now)).toMatch(/^11:00\sPM$/);
  expect(resetTime(at(2, 17), now)).toMatch(/^tomorrow 5:00\sPM$/);
  expect(resetTime(at(4, 9), now)).toMatch(/^Sun 9:00\sAM$/);
  expect(resetTime(at(11, 9), now)).toBe("Oct 11");
});

test("a chart's axis tops out at four even steps", () => {
  expect(niceTop(367)).toBe(400);
  expect(niceTop(950_000_000)).toBe(1_000_000_000);
  expect(niceTop(72)).toBe(80);
  expect(niceTop(0)).toBe(1);
});

let unmount = () => {};
afterEach(() => act(() => unmount()));

/** Renders the page for one connected host whose methods answer with `answers`. */
async function renderPage(
  answers: Record<string, (params: Record<string, unknown>) => unknown>,
): Promise<void> {
  window.wisp = {
    platform: "darwin",
    connectionState: async () => ({
      status: "connected",
      wispd: "0.9.0",
      protocol: 1,
      capabilities: {},
    }),
    onConnectionState: () => () => {},
    request: async (_host: string, method: string, params: Record<string, unknown>) => {
      const answer = answers[method];
      return answer
        ? { result: await answer(params), logId: "log" }
        : { error: { code: -32601, message: `no ${method}` } };
    },
  } as unknown as WispBridge;
  const root = createRoot(document.body.appendChild(document.createElement("div")));
  await act(async () =>
    root.render(<UsagePage hosts={[{ id: "local", name: "This Mac" }]} topBarClassName="" />),
  );
  unmount = () => root.unmount();
  await settle();
}
const settle = () => act(() => new Promise((resolve) => setTimeout(resolve, 0)));
const history =
  (hours: UsageHour[]) =>
  ({ since }: Record<string, unknown>) => ({
    hours: hours.filter((h) => h.hour >= (since as string)),
    runs: [{ accountId: "claude", runs: 2 }],
  });

// The last whole hour, which every range covers.
const lastHour = Math.floor(Date.now() / HOUR) * HOUR - HOUR;

test("Cost leads with the total, its change, and the busiest model, and reads each bar out", async () => {
  await renderPage({
    "accounts/keys/list": () => ({ accounts: [] }),
    "usage/history": history([
      // In the 30 days before.
      usage(lastHour - 40 * 24 * HOUR, "claude", "opus", 80, 2_000_000),
      usage(lastHour, "claude", "opus", 100, 2_000_000),
      usage(lastHour, "claude", "sonnet", 50, 1_000_000),
    ]),
  });
  const strip = document.querySelector("dl")!.textContent;
  expect(strip).toContain("Total cost$3.00");
  expect(strip).toContain("+50%From $2.00 in the previous 30 days");
  expect(strip).toContain("Busiest modelopus66.7% of cost · $2.00");

  // Every bar says its numbers; the latest is the one in the tab order.
  const bars = [...document.querySelectorAll<HTMLElement>("[data-bar]")];
  expect(bars).toHaveLength(30);
  expect(bars.filter((b) => b.tabIndex === 0)).toEqual([bars.at(-1)]);
  const labels = bars.map((b) => b.getAttribute("aria-label")!);
  expect(
    labels.filter((l) => l.endsWith(": $3.00 (opus $2.00, sonnet $1.00), 150 tokens")),
  ).toHaveLength(1);
  expect(labels.filter((l) => l.includes(": $0.00 "))).toHaveLength(29);

  // Arrow keys, Home, and End move along the bars, stopping at either end, and the focused one
  // shows its numbers.
  const press = (key: string) =>
    act(() => {
      document.activeElement!.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
    });
  const readout = () => document.querySelector("[data-readout]")?.textContent;
  act(() => bars.at(-1)!.focus());
  press("ArrowLeft");
  expect(document.activeElement).toBe(bars.at(-2));
  expect(bars.at(-2)!.tabIndex).toBe(0);
  expect(bars.at(-2)!.hasAttribute("data-active")).toBe(true);
  expect(readout()).toContain(bars.at(-2)!.getAttribute("aria-label")!.split(":")[0]);
  press("Home");
  press("ArrowLeft");
  expect(document.activeElement).toBe(bars[0]);
  press("End");
  press("ArrowRight");
  expect(document.activeElement).toBe(bars.at(-1));
  expect(readout()).toContain(bars.at(-1)!.getAttribute("aria-label")!.split(":")[0]);

  // Escape hides the numbers and leaves focus where it was.
  press("Escape");
  expect(readout()).toBeUndefined();
  expect(document.activeElement).toBe(bars.at(-1));
});

test("an answer for a range left behind doesn't replace the range shown", async () => {
  let release = () => {};
  let hold: Promise<void> | undefined;
  const answer = history([usage(lastHour, "claude", "opus", 100, 2_000_000)]);
  await renderPage({
    "accounts/keys/list": () => ({ accounts: [] }),
    "usage/history": async (params) => {
      // Only the requests made while it's set wait for it.
      const wait = hold;
      await wait;
      return answer(params);
    },
  });
  hold = new Promise((resolve) => (release = resolve));
  act(() => document.querySelector<HTMLInputElement>('input[value="7d"]')!.click());
  await settle();
  hold = undefined;
  act(() => document.querySelector<HTMLInputElement>('input[value="90d"]')!.click());
  await settle();
  expect(document.querySelectorAll("[data-bar]")).toHaveLength(90);

  // 7 days' answer comes last, and is dropped.
  release();
  await settle();
  expect(document.querySelectorAll("[data-bar]")).toHaveLength(90);
  expect(document.querySelector('[aria-busy="true"]')).toBeNull();
});

test("a new range keeps the last one in view, dimmed, until its answer comes", async () => {
  let release = () => {};
  let hold: Promise<void> | undefined;
  const answer = history([usage(lastHour, "claude", "opus", 100, 2_000_000)]);
  await renderPage({
    "accounts/keys/list": () => ({ accounts: [] }),
    "usage/history": async (params) => {
      await hold;
      return answer(params);
    },
  });
  hold = new Promise((resolve) => (release = resolve));
  act(() => document.querySelector<HTMLInputElement>('input[value="7d"]')!.click());
  await settle();
  const held = document.querySelector('[aria-busy="true"]')!;
  expect(held.querySelectorAll("[data-bar]")).toHaveLength(30);
  expect(document.querySelector('[role="status"]')!.textContent).toBe("Loading usage…");

  release();
  await settle();
  expect(document.querySelector('[aria-busy="true"]')).toBeNull();
  expect(document.querySelectorAll("[data-bar]")).toHaveLength(7);
});

test("Limits show each window as a meter, in amber and then red near its cap", async () => {
  const limit = (window: string, usedPercent: number) => ({
    window,
    usedPercent,
    resetsAt: new Date(Date.now() + 2 * HOUR + 30_000).toISOString(),
    capturedAt: new Date().toISOString(),
  });
  const none = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
  await renderPage({
    "accounts/keys/list": () => ({ accounts: [] }),
    "usage/history": history([]),
    "usage/get": () => ({
      accounts: [
        {
          accountId: "claude",
          today: none,
          week: none,
          limits: [limit("five_hour", 37.4), limit("seven_day", 80), limit("seven_day_opus", 100)],
        },
      ],
    }),
  });
  act(() => document.querySelector<HTMLInputElement>('input[value="limits"]')!.click());
  await settle();
  const meters = [...document.querySelectorAll('[role="meter"]')];
  expect(
    meters.map((m) => [m.getAttribute("aria-label"), m.getAttribute("aria-valuenow")]),
  ).toEqual([
    ["Session", "37"],
    ["Weekly", "80"],
    ["Weekly · Opus", "100"],
  ]);
  const card = document.querySelector('section[aria-label="Claude Code"]')!.textContent;
  expect(card).toContain("Session37%used");
  expect(card).toContain("Near the limit80%used");
  expect(card).toContain("Limit reached100%used");
  expect(card).toContain("Resets in 2 h 1 min");
});
