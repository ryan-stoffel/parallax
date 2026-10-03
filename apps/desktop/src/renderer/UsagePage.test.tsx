// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, test, vi } from "vite-plus/test";

import type { ParallaxBridge } from "../preload/bridge";
import type { UsageDay } from "../protocol/generated/protocol";
import {
  attribute,
  buckets,
  change,
  localDate,
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
const DAY = 24 * HOUR;
const midnight = (at: number) => new Date(at).setHours(0, 0, 0, 0);

/** A day of `tokens` input tokens on `at`'s local day, costing `cost` micro-dollars when it says. */
const usage = (at: number, agent: string, model: string, tokens: number, cost?: number) =>
  ({
    date: localDate(at),
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
  expect(localDate(month.previous[0]!)).toBe("2026-08-01");
});

/** `range`'s summary over a flat `tokens` a day, today holding only the part of it so far. */
function flat(range: Range, now: number, tokens = 100) {
  const span = buckets(range, now);
  const days = [...span.previous, ...span.starts].map((start) =>
    usage(start, "claude", "opus", start === span.starts.at(-1) ? tokens * span.partial : tokens),
  );
  return { span, summary: summarize(days, span.starts, span.previous, span.partial) };
}

test("a flat rate shows no change at any time of day, though today isn't over", () => {
  for (const clock of [
    [0, 30],
    [9, 5],
    [16, 55],
    [23, 50],
  ] as const)
    for (const range of ["today", "7d", "30d"] as const) {
      const now = new Date(2026, 8, 29, ...clock).getTime();
      const { summary } = flat(range, now);
      expect(change(tokensOf(summary.total), tokensOf(summary.previous))).toBeCloseTo(0, 10);
    }
});

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

test("a change is a fraction of the range before, and needs a range before with some", () => {
  expect(change(125, 100)).toBe(0.25);
  expect(change(50, 100)).toBe(-0.5);
  expect(change(100, 100)).toBe(0);
  expect(change(100, 0)).toBeUndefined();
  expect(change(100, undefined)).toBeUndefined();
});

test("models rank by the measure, share the whole, and the chart stacks two and the rest", () => {
  const now = Date.parse("2026-09-29T19:42:00Z");
  const { starts, previous, partial } = buckets("7d", now);
  const sum = (days: UsageDay[]) => summarize(days, starts, previous, partial);
  const [first, last] = [starts[0]!, starts.at(-1)!];
  const summary = sum([
    usage(first, "claude", "opus", 100, 6_000_000),
    usage(last, "claude", "opus", 100, 2_000_000),
    usage(first, "claude", "sonnet", 300, 1_000_000),
    usage(last, "claude", "haiku", 50, 500_000),
    usage(first, "claude", "haiku-2", 60, 500_000),
    // No reported cost, but the most tokens.
    usage(last, "codex", "gpt", 1000),
  ]);
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

  // A tie on both measures falls to the name, whatever order the days came in.
  const tied = sum([
    usage(last, "claude", "b-model", 10, 100),
    usage(last, "claude", "a-model", 10, 100),
  ]);
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
  window.parallax = {
    platform: "darwin",
    connectionState: async () => ({
      status: "connected",
      plxd: "0.9.0",
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
  } as unknown as ParallaxBridge;
  const root = createRoot(document.body.appendChild(document.createElement("div")));
  await act(async () =>
    root.render(<UsagePage hosts={[{ id: "local", name: "This Mac" }]} topBarClassName="" />),
  );
  unmount = () => root.unmount();
  await settle();
}
const settle = () => act(() => new Promise((resolve) => setTimeout(resolve, 0)));
/** `usage/daily`'s answer from `days`, with `problems`. */
const daily =
  (days: UsageDay[], problems: { source: "ccusage" | "cursor"; message: string }[] = []) =>
  ({ since }: Record<string, unknown>) => ({
    days: days.filter((d) => d.date >= (since as string)),
    problems,
  });

const now = Date.now();

test("Cost leads with the total, its change, and the busiest model, and reads each bar out", async () => {
  await renderPage({
    "accounts/keys/list": () => ({ accounts: [] }),
    "usage/daily": daily([
      // In the 30 days before.
      usage(now - 40 * DAY, "claude", "opus", 80, 2_000_000),
      usage(now, "claude", "opus", 100, 2_000_000),
      usage(now, "claude", "sonnet", 50, 1_000_000),
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

  // Pointing at a bar shows its numbers instead, while the pointer is on the card. React makes
  // enter and leave from `pointerover` and `pointerout`.
  const figure = document.querySelector("figure")!;
  const enter = (bar: HTMLElement) =>
    act(() => {
      bar.dispatchEvent(
        new MouseEvent("pointerover", { bubbles: true, relatedTarget: document.body }),
      );
    });
  const leave = () =>
    act(() => {
      figure.dispatchEvent(
        new MouseEvent("pointerout", { bubbles: true, relatedTarget: document.body }),
      );
    });
  const nameOf = (bar: HTMLElement) => bar.getAttribute("aria-label")!.split(":")[0]!;

  // Escape hides the numbers and leaves focus where it was, and leaving the card after it
  // doesn't bring them back.
  press("Escape");
  expect(readout()).toBeUndefined();
  expect(document.activeElement).toBe(bars.at(-1));
  enter(bars[3]!);
  expect(readout()).toContain(nameOf(bars[3]!));
  leave();
  expect(readout()).toBeUndefined();

  // Otherwise leaving the card goes back to the focused bar's numbers, and with nothing
  // focused, to none.
  press("ArrowLeft");
  enter(bars[3]!);
  expect(readout()).toContain(nameOf(bars[3]!));
  leave();
  expect(readout()).toContain(nameOf(bars.at(-2)!));
  act(() => bars.at(-2)!.blur());
  enter(bars[3]!);
  expect(readout()).toContain(nameOf(bars[3]!));
  leave();
  expect(readout()).toBeUndefined();
});

test("an answer for a range left behind doesn't replace the range shown", async () => {
  let release = () => {};
  let hold: Promise<void> | undefined;
  const answer = daily([usage(now, "claude", "opus", 100, 2_000_000)]);
  await renderPage({
    "accounts/keys/list": () => ({ accounts: [] }),
    "usage/daily": async (params) => {
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
  const answer = daily([usage(now, "claude", "opus", 100, 2_000_000)]);
  await renderPage({
    "accounts/keys/list": () => ({ accounts: [] }),
    "usage/daily": async (params) => {
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

test("Today shows how the day splits, not one bar, and a source's problem beside the rest", async () => {
  await renderPage({
    "usage/daily": daily(
      [
        usage(now, "claude", "opus", 100, 3_000_000),
        usage(now, "cursor", "composer", 50, 1_000_000),
      ],
      [{ source: "ccusage", message: "Install Node.js or ccusage on this host." }],
    ),
  });
  act(() => document.querySelector<HTMLInputElement>('input[value="today"]')!.click());
  await settle();
  expect(document.body.textContent).toContain("Install Node.js or ccusage on this host.");
  expect(document.querySelectorAll("[data-bar]")).toHaveLength(0);
  expect(document.querySelector("figure")!.textContent).toContain("Cost by model today");
  expect(document.querySelector("figure")!.textContent).toContain("composer$1.0025.0%");
  // One day has nothing to break down by day.
  expect(document.querySelector('fieldset[aria-label="Breakdown by"]')).toBeNull();
  const providers = [...document.querySelectorAll('section[aria-label="Providers"] li')];
  expect(providers.map((p) => p.textContent)).toEqual([
    "Claude Code$3.0075.0% of cost · 100 tokens",
    "Cursor$1.0025.0% of cost · 50 tokens",
  ]);
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
    "usage/daily": daily([]),
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
  // The accent, then amber from 75%, then red from 90%.
  const fill = (m: Element) =>
    /\bbg-(accent|warning|danger)\b/.exec(m.firstElementChild!.className)?.[1];
  expect(meters.map(fill)).toEqual(["accent", "warning", "danger"]);
  const card = document.querySelector('section[aria-label="Claude Code"]')!.textContent;
  expect(card).toContain("Session37%used");
  expect(card).toContain("Near the limit80%used");
  expect(card).toContain("Limit reached100%used");
  expect(card).toContain("Resets in 2 h 1 min");
});
