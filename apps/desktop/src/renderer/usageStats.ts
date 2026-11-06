// The usage page's numbers: ranges of local days, `usage/daily`'s days summed by agent, model,
// and day, the chart's parts, and limit windows as meters. Pure, so the desktop's UsagePage and
// the mobile app's Usage tab share it.

import type {
  KeyAccount,
  Provider,
  UsageDay,
  UsageLimitWindow,
  UsageSessions,
} from "../protocol/generated/protocol";
import { locale } from "./locale";
import { dayOf } from "./profile";

/** How far back Cost and Tokens look: whole local days ending today. */
export type Range = "today" | "7d" | "30d" | "90d";
export const ranges: { value: Range; name: string }[] = [
  { value: "today", name: "Today" },
  { value: "7d", name: "7 days" },
  { value: "30d", name: "30 days" },
  { value: "90d", name: "90 days" },
];
const rangeDays: Record<Range, number> = { today: 1, "7d": 7, "30d": 30, "90d": 90 };
/** The range, and the one before it, in words. */
export const rangeWords: Record<Range, { past: string; previous: string }> = {
  today: { past: "today", previous: "yesterday" },
  "7d": { past: "in the past 7 days", previous: "in the previous 7 days" },
  "30d": { past: "in the past 30 days", previous: "in the previous 30 days" },
  "90d": { past: "in the past 90 days", previous: "in the previous 90 days" },
};

/** The backends that run accounts (0012), and the agents `usage/daily` counts, in this order. */
export type Backend = "claude" | "codex" | "cursor";
export const backendIds: Backend[] = ["claude", "codex", "cursor"];
const isBackend = (id: string): id is Backend => (backendIds as string[]).includes(id);
const providerBackend: Record<Provider, Backend> = {
  anthropic: "claude",
  openai: "codex",
  cursor: "cursor",
};

/** An account's backend: its own id for a subscription, its provider's for an API key. */
export function backendOf(accountId: string, keys: KeyAccount[]): Backend | undefined {
  if (isBackend(accountId)) return accountId;
  const key = keys.find((k) => k.id === accountId);
  return key && providerBackend[key.provider];
}

/** `at`'s local midnight. */
export function dayStart(at: number): number {
  const d = new Date(at);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/**
 * `range`'s whole local days ending today at `now`, by start time. `previous` are the days of
 * the range of the same length just before it, to compare with. Its last day counts only its
 * `partial` (0 to 1), as far into it as `now` is into today, since today isn't over.
 */
export function buckets(
  range: Range,
  now: number,
): { starts: number[]; previous: number[]; partial: number } {
  const days = rangeDays[range];
  // By the calendar, so midnight holds across a daylight saving change.
  const run = (back: number) =>
    Array.from({ length: days }, (_, i) => {
      const d = new Date(now);
      d.setDate(d.getDate() - (back + days - 1 - i));
      return dayStart(d.getTime());
    });
  const today = dayStart(now);
  const tomorrow = new Date(today);
  tomorrow.setDate(tomorrow.getDate() + 1);
  return {
    starts: run(0),
    previous: run(days),
    partial: (now - today) / (tomorrow.getTime() - today),
  };
}

/** Tokens by kind and the cost reported for them. `unpriced` counts tokens no cost came with. */
export interface Measures {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  /** In micro-dollars. */
  cost: number;
  unpriced: number;
}
const zero = (): Measures => ({
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  cost: 0,
  unpriced: 0,
});
export const tokensOf = (m: Measures) => m.input + m.output + m.cacheRead + m.cacheWrite;

/** Adds `d` to `m`, or the `scale` of it that falls in a part of its day. */
function add(m: Measures, d: UsageDay, scale = 1) {
  m.input += d.inputTokens * scale;
  m.output += d.outputTokens * scale;
  m.cacheRead += d.cacheReadTokens * scale;
  m.cacheWrite += d.cacheWriteTokens * scale;
  if (d.costUsdMicros === undefined)
    m.unpriced += (d.inputTokens + d.outputTokens + d.cacheReadTokens + d.cacheWriteTokens) * scale;
  else m.cost += d.costUsdMicros * scale;
}

export interface Summary {
  total: Measures;
  /** The range before, of the same length, its last day only as far as today has come. */
  previous: Measures;
  /** Per bucket of `starts`. */
  byBucket: Measures[];
  /** In `backendIds`' order, only those with usage. */
  backends: { backend: Backend; total: Measures; byBucket: Measures[] }[];
  models: { backend?: Backend; model: string; total: Measures; byBucket: Measures[] }[];
  /** Sessions in the range and the range before, or undefined when no host counted them. */
  sessions?: { total: number; previous: number };
}

/**
 * Every host's days summed by agent, model, and bucket, and over the `previous` buckets, the
 * last of them only its `partial`, and the same for `sessions` when there are any. A day outside
 * both is left out.
 */
export function summarize(
  days: UsageDay[],
  starts: number[],
  previous: number[],
  partial: number,
  sessions?: UsageSessions[],
): Summary {
  const index = new Map(starts.map((start, i) => [start, i]));
  const earlier = new Set(previous);
  const total = zero();
  const before = zero();
  const byBucket = starts.map(zero);
  const perBackend = new Map<Backend, Summary["backends"][number]>();
  const perModel = new Map<string, Summary["models"][number]>();
  for (const d of days) {
    const at = dayOf(d.date).getTime();
    if (earlier.has(at)) add(before, d, at === previous.at(-1) ? partial : 1);
    const i = index.get(at);
    if (i === undefined) continue;
    add(total, d);
    add(byBucket[i]!, d);
    const backend = isBackend(d.agent) ? d.agent : undefined;
    if (backend) {
      let entry = perBackend.get(backend);
      if (!entry)
        perBackend.set(backend, (entry = { backend, total: zero(), byBucket: starts.map(zero) }));
      add(entry.total, d);
      add(entry.byBucket[i]!, d);
    }
    const key = `${backend}/${d.model}`;
    let entry = perModel.get(key);
    if (!entry)
      perModel.set(
        key,
        (entry = { backend, model: d.model, total: zero(), byBucket: starts.map(zero) }),
      );
    add(entry.total, d);
    add(entry.byBucket[i]!, d);
  }
  let counted: Summary["sessions"];
  if (sessions) {
    counted = { total: 0, previous: 0 };
    for (const s of sessions) {
      const at = dayOf(s.date).getTime();
      if (index.has(at)) counted.total += s.sessions;
      else if (earlier.has(at))
        counted.previous += s.sessions * (at === previous.at(-1) ? partial : 1);
    }
  }
  return {
    total,
    previous: before,
    byBucket,
    sessions: counted,
    backends: backendIds.flatMap((b) => perBackend.get(b) ?? []),
    models: [...perModel.values()],
  };
}

/** A model's place in the range: its share of the whole (0 to 1), and its part of the chart. */
export interface Attribution {
  model: Summary["models"][number];
  share?: number;
  part: number;
}

/** Models by `measure`, most first, then by tokens, then by name, so ties hold still. */
function rank(models: Summary["models"], measure: (m: Measures) => number) {
  return [...models].sort(
    (a, b) =>
      measure(b.total) - measure(a.total) ||
      tokensOf(b.total) - tokensOf(a.total) ||
      `${a.backend}/${a.model}`.localeCompare(`${b.backend}/${b.model}`, locale()),
  );
}

/**
 * The range's models by `measure`, most first, each with its share of the whole and the part of
 * the chart's stack it's drawn in. The parts are the same in Cost and Tokens, so a model keeps
 * its color: ranked by cost when any model reported one, else by tokens, the first two have
 * their own and the rest share a third, unless there are only three. A model `unreported` says
 * `measure` can't count, such as one with no reported cost, has no share.
 */
export function attribute(
  models: Summary["models"],
  measure: (m: Measures) => number,
  unreported: (m: Measures) => boolean = () => false,
): Attribution[] {
  const whole = models.reduce((sum, m) => sum + measure(m.total), 0);
  const priced = models.some((m) => m.total.cost > 0);
  const stacked = rank(models, priced ? (m) => m.cost : tokensOf);
  const parts = new Map(stacked.map((m, i) => [m, stacked.length <= 3 ? i : Math.min(i, 2)]));
  return rank(models, measure).map((model) => ({
    model,
    ...(whole > 0 && !unreported(model.total) && { share: measure(model.total) / whole }),
    part: parts.get(model)!,
  }));
}

/** A part of the chart's stacked bars: one model, or several as one. */
export interface Part {
  name: string;
  backend?: Backend;
  /** Its place in the stack, from the bottom, which picks its fill. */
  part: number;
  /** Per bucket. */
  values: number[];
}

/**
 * The chart's parts, bottom up, from `attribute`'s rows: each part's `measure` per bucket. A
 * part `measure` has none of, such as a model with no reported cost on Cost, is left out.
 */
export function stack(rows: Attribution[], measure: (m: Measures) => number): Part[] {
  const parts: (Part & { models: number })[] = [];
  for (const { model, part } of rows) {
    if (measure(model.total) <= 0) continue;
    const values = model.byBucket.map(measure);
    const into = parts[part];
    if (!into) parts[part] = { name: model.model, backend: model.backend, part, values, models: 1 };
    else {
      into.values = into.values.map((v, i) => v + values[i]!);
      into.models++;
    }
  }
  return parts
    .filter(Boolean)
    .map(({ models, ...p }) =>
      models > 1 ? { name: `${models} other models`, part: p.part, values: p.values } : p,
    );
}

/** The top of a chart's axis: four even steps of 1, 2, 2.5, or 5 times a power of ten. */
export function niceTop(max: number): number {
  if (max <= 0) return 1;
  const unit = 10 ** Math.floor(Math.log10(max / 4));
  return [1, 2, 2.5, 5, 10].map((m) => m * unit).find((step) => step * 4 >= max)! * 4;
}

export const usd = new Intl.NumberFormat("en", { style: "currency", currency: "USD" });
export const tokenCount = new Intl.NumberFormat("en", {
  notation: "compact",
  maximumSignificantDigits: 3,
});
export const dollars = (micros: number) => usd.format(micros / 1_000_000);
export const percent = (part: number, whole: number) =>
  `${whole > 0 ? ((part / whole) * 100).toFixed(1) : "0.0"}%`;
export const wholeUsd = new Intl.NumberFormat("en", {
  style: "currency",
  currency: "USD",
  maximumFractionDigits: 0,
});
export const plural = (n: number, one: string) => `${n} ${n === 1 ? one : `${one}s`}`;

export const capitalize = (s: string) => {
  const words = s.replaceAll("_", " ");
  return words.charAt(0).toUpperCase() + words.slice(1);
};

/** "42 min", "2 h 14 min", "3 d 4 h", rounded up to the minute; `short`, "42m", "2h 14m", "3d 4h". */
export function duration(ms: number, short = false): string {
  const [m, h, d] = short ? ["m", "h", "d"] : [" min", " h", " d"];
  const minutes = Math.max(1, Math.ceil(ms / 60_000));
  if (minutes < 60) return `${minutes}${m}`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return minutes % 60 ? `${hours}${h} ${minutes % 60}${m}` : `${hours}${h}`;
  const days = Math.floor(hours / 24);
  return hours % 24 ? `${days}${d} ${hours % 24}${h}` : `${days}${d}`;
}

/** How close a limit window is to its cap: amber from 75% used, red from 90%. */
export type LimitTone = "normal" | "warning" | "danger";

/**
 * A limit window for its row on the Usage page: a short name ("Session", "Weekly · Opus"), how
 * much is left (0 to 100, from the rounded-down percent used) when the vendor says, its tone, and
 * how long until it resets ("4h 40m"). Once the reset time has passed, the last percent is stale
 * and all of the window is left.
 */
export function limitMeter(
  limit: UsageLimitWindow,
  now: number,
): { name: string; left?: number; tone: LimitTone; resetsIn?: string } {
  const weekly = /^seven_day(?:_(.+))?$/.exec(limit.window);
  const name =
    limit.window === "five_hour"
      ? "Session"
      : weekly
        ? weekly[1]
          ? `Weekly · ${capitalize(weekly[1])}`
          : "Weekly"
        : capitalize(limit.window);
  const resets = limit.resetsAt === undefined ? undefined : Date.parse(limit.resetsAt);
  if (resets !== undefined && resets <= now) return { name, left: 100, tone: "normal" };
  const used =
    limit.usedPercent === undefined
      ? undefined
      : Math.min(100, Math.max(0, Math.floor(limit.usedPercent)));
  const tone = used === undefined || used < 75 ? "normal" : used < 90 ? "warning" : "danger";
  return {
    name,
    ...(used !== undefined && { left: 100 - used }),
    tone,
    ...(resets !== undefined && { resetsIn: duration(resets - now, true) }),
  };
}
