import { RefreshCw, RotateCw } from "lucide-react";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type ReactNode,
} from "react";

import type { RpcError } from "../preload/bridge";
import {
  ErrorCodes,
  type AccountLimits,
  type KeyAccount,
  type Provider,
  type UsageDailyResult,
  type UsageDay,
  type UsageLimitWindow,
  type UsageSessions,
} from "../protocol/generated/protocol";
import { statusLabel, useConnection } from "./ConnectionStatus";
import { describeError } from "./errors";
import type { Host } from "./hosts";
import { locale } from "./locale";
import { dayKey, dayOf } from "./profile";
import { kinds, type Kind } from "./providers";
import { IconButton, Segmented } from "./ui";
import { limitDetails, limitMeter, usd, type LimitTone } from "./Usage";
import { clockOptions } from "./prefs";

type View = "cost" | "tokens" | "limits";
const views: { value: View; name: string }[] = [
  { value: "cost", name: "Cost" },
  { value: "tokens", name: "Tokens" },
  { value: "limits", name: "Limits" },
];

/** How far back Cost and Tokens look: whole local days ending today. */
export type Range = "today" | "7d" | "30d" | "90d";
const ranges: { value: Range; name: string }[] = [
  { value: "today", name: "Today" },
  { value: "7d", name: "7 days" },
  { value: "30d", name: "30 days" },
  { value: "90d", name: "90 days" },
];
const rangeDays: Record<Range, number> = { today: 1, "7d": 7, "30d": 30, "90d": 90 };
/** The range, and the one before it, in words. */
const rangeWords: Record<Range, { past: string; previous: string }> = {
  today: { past: "today", previous: "yesterday" },
  "7d": { past: "in the past 7 days", previous: "in the previous 7 days" },
  "30d": { past: "in the past 30 days", previous: "in the previous 30 days" },
  "90d": { past: "in the past 90 days", previous: "in the previous 90 days" },
};

/** The backends that run accounts (0012), and the agents `usage/daily` counts. */
export type Backend = "claude" | "codex" | "cursor";
const backends: Record<Backend, Kind> = {
  claude: kinds["claude"]!,
  codex: kinds["codex"]!,
  cursor: kinds["cursor"]!,
};
const providerBackend: Record<Provider, Backend> = {
  anthropic: "claude",
  openai: "codex",
  cursor: "cursor",
};

/** An account's backend: its own id for a subscription, its provider's for an API key. */
function backendOf(accountId: string, keys: KeyAccount[]): Backend | undefined {
  if (accountId in backends) return accountId as Backend;
  const key = keys.find((k) => k.id === accountId);
  return key && providerBackend[key.provider];
}

/**
 * A host's API keys, to name their accounts on Limits and tell their backend, asked again
 * whenever `refresh` changes. Empty until they answer.
 */
function useKeys(hostId: string, connected: boolean, refresh?: number): KeyAccount[] {
  const [keys, setKeys] = useState<KeyAccount[]>([]);
  useEffect(() => {
    if (!connected) return;
    let stopped = false;
    void window.parallax.request(hostId, "accounts/keys/list", {}).then((answer) => {
      if (!stopped && "result" in answer) setKeys(answer.result.accounts);
    });
    return () => {
      stopped = true;
    };
  }, [hostId, connected, refresh]);
  return keys;
}

/** A failed usage request, for people. A plxd without the method is too old. */
function usageError(error: RpcError): string {
  return error.code === ErrorCodes.MethodNotFound
    ? "Update plxd on this host to see its usage here."
    : describeError(error);
}

/** A host that isn't answering: its status, or undefined once it's connected. */
function hostStatus(connection: ReturnType<typeof useConnection>): string | undefined {
  if (connection?.status === "connected") return undefined;
  return connection ? statusLabel(connection) : "Connecting…";
}

const HOUR = 3_600_000;

/** `at`'s local midnight. */
function dayStart(at: number): number {
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
  /** In `backends`' order, only those with usage. */
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
    const backend = d.agent in backends ? (d.agent as Backend) : undefined;
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
    backends: (Object.keys(backends) as Backend[]).flatMap((b) => perBackend.get(b) ?? []),
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

const tokenCount = new Intl.NumberFormat("en", {
  notation: "compact",
  maximumSignificantDigits: 3,
});
const dollars = (micros: number) => usd.format(micros / 1_000_000);
const percent = (part: number, whole: number) =>
  `${whole > 0 ? ((part / whole) * 100).toFixed(1) : "0.0"}%`;
const wholeUsd = new Intl.NumberFormat("en", {
  style: "currency",
  currency: "USD",
  maximumFractionDigits: 0,
});
const plural = (n: number, one: string) => `${n} ${n === 1 ? one : `${one}s`}`;

/** The chart's fills for its parts, bottom up (index.css). */
const fills = ["bg-chart-1", "bg-chart-2", "bg-chart-3"];
const card = "rounded-xl border border-border bg-surface";
/** A strip of figures in one card, split by hairlines. */
const strip = "grid gap-px overflow-hidden rounded-xl border border-border bg-border";
const heading = "mb-2.5 text-[13px] font-medium text-muted-foreground";

/** Counts a request in flight until it settles, so Refresh can show it's working. */
type Track = <T>(request: Promise<T>) => Promise<T>;

/**
 * Settings > Usage, also opened by the sidebar's Usage button. The header always has the view, the
 * range (disabled on Limits, which is always now), and Refresh, which spins while any request is
 * in flight. Cost and Tokens sum `usage/daily` across every host; Limits shows each host's
 * subscriptions' windows from `usage/limits`.
 */
export function UsagePage({ hosts }: { hosts: Host[] }) {
  const [view, setView] = useState<View>("cost");
  const [range, setRange] = useState<Range>("30d");
  // When the range was last chosen or refreshed: what the buckets end at.
  const [now, setNow] = useState(Date.now);
  const [inFlight, setInFlight] = useState(0);
  const track = useCallback<Track>((request) => {
    setInFlight((n) => n + 1);
    return request.finally(() => setInFlight((n) => n - 1));
  }, []);
  return (
    <>
      <div className="mb-6 flex flex-wrap items-center gap-2">
        <h1 className="mr-auto text-xl font-semibold">Usage</h1>
        <Segmented label="Usage view" options={views} value={view} onChange={setView} />
        <Segmented
          label="Usage range"
          options={ranges}
          value={range}
          onChange={(next) => {
            setRange(next);
            setNow(Date.now());
          }}
          disabled={view === "limits"}
        />
        <IconButton label="Refresh" aria-busy={inFlight > 0} onClick={() => setNow(Date.now())}>
          <RefreshCw className={inFlight > 0 ? "motion-safe:animate-spin" : ""} />
        </IconButton>
      </div>
      {/* A container, so the layout follows the pane's width rather than the window's. */}
      <div className="@container">
        {view === "limits" ? (
          hosts.map((h) => (
            <HostLimits key={h.id} host={h} named={hosts.length > 1} refresh={now} track={track} />
          ))
        ) : (
          <History hosts={hosts} view={view} range={range} now={now} track={track} />
        )}
      </div>
    </>
  );
}

/** A host's days (and sessions, if it counted them) since `since`, or, without days, that they're on their way. */
interface Loaded {
  since: string;
  days?: UsageDay[];
  sessions?: UsageSessions[];
}

/** What Cost and Tokens draw: a range's buckets, and the days in for them so far. */
interface Frame {
  range: Range;
  span: ReturnType<typeof buckets>;
  /** Every host's that answered, together. */
  days: UsageDay[];
  /** Every host's, or undefined unless every host that answered counted them. */
  sessions?: UsageSessions[];
  answered: number;
  loading: boolean;
  /** Goes up with each answer, so the chart rises again with new numbers. */
  version: number;
}

/** Cost or Tokens over `range`, summed across `hosts`, each host's trouble noted on top. */
function History({
  hosts,
  view,
  range,
  now,
  track,
}: {
  hosts: Host[];
  view: "cost" | "tokens";
  range: Range;
  now: number;
  track: Track;
}) {
  const span = useMemo(() => buckets(range, now), [range, now]);
  // One request covers the range and the one before it.
  const since = dayKey(span.previous[0]!);
  const [loaded, setLoaded] = useState<Record<string, Loaded | undefined>>({});
  // Here rather than in Breakdown, which unmounts while a new range loads.
  const [by, setBy] = useState<BreakdownBy>("model");
  const [version, setVersion] = useState(0);
  const onLoad = useCallback((hostId: string, state?: Loaded) => {
    setLoaded((all) => ({ ...all, [hostId]: state }));
    if (state?.days) setVersion((v) => v + 1);
  }, []);
  const frame = useMemo<Frame>(() => {
    const days: UsageDay[] = [];
    let sessions: UsageSessions[] | undefined = [];
    let answered = 0;
    let loading = false;
    for (const h of hosts) {
      const state = loaded[h.id];
      if (state?.days && state.since === since) {
        days.push(...state.days);
        // A host that didn't count them would make the total look whole when it isn't.
        sessions = state.sessions && sessions?.concat(state.sessions);
        answered++;
      } else if (state) loading = true;
    }
    return {
      range,
      span,
      days,
      sessions: answered ? sessions : undefined,
      answered,
      loading,
      version,
    };
  }, [hosts, loaded, since, range, span, version]);
  // The last frame with usage, shown dimmed while another range loads, so nothing jumps.
  const [held, setHeld] = useState<Frame>();
  if (frame.answered > 0 && held !== frame) setHeld(frame);
  const shown = frame.answered > 0 ? frame : frame.loading ? held : undefined;

  return (
    <>
      {/* The loaders stay first and in place, so they're never remounted (which would drop
          their answers and ask again) as the rest appears. Refresh reaches them through `now`. */}
      <div>
        {hosts.map((h) => (
          <HostUsageLoader
            key={h.id}
            host={h}
            named={hosts.length > 1}
            since={since}
            refresh={now}
            onLoad={onLoad}
            track={track}
          />
        ))}
      </div>
      {/* Always there, so a screen reader hears its text change. */}
      <p role="status" className="sr-only">
        {frame.loading && shown !== frame ? "Loading usage…" : ""}
      </p>
      {shown ? (
        <Dashboard frame={shown} stale={shown !== frame} view={view} by={by} onBy={setBy} />
      ) : (
        frame.loading && <DashboardSkeleton />
      )}
    </>
  );
}

/**
 * Asks one host for its days since `since` in this time zone once it's connected, and again
 * whenever `since` or `refresh` change, and hands them to `onLoad` (without days while it waits,
 * and undefined when it has none to give). A refresh keeps the last answer until the next
 * arrives; a new `since` drops it, since its days are for another range. Shows why the host has
 * nothing, if it doesn't, and each source it couldn't read.
 */
function HostUsageLoader({
  host,
  named,
  since,
  refresh,
  onLoad,
  track,
}: {
  host: Host;
  named: boolean;
  since: string;
  refresh: number;
  onLoad: (hostId: string, state?: Loaded) => void;
  track: Track;
}) {
  const connection = useConnection(host.id);
  const connected = connection?.status === "connected";
  const [answer, setAnswer] = useState<{ since: string; value: UsageDailyResult | RpcError }>();
  useEffect(() => {
    if (!connected) return;
    let stopped = false;
    const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    void track(window.parallax.request(host.id, "usage/daily", { since, timeZone })).then(
      (answer) => {
        if (!stopped)
          setAnswer({ since, value: "result" in answer ? answer.result : answer.error });
      },
    );
    return () => {
      stopped = true;
    };
  }, [host.id, connected, since, refresh, track]);
  const current = answer?.since === since ? answer.value : undefined;
  const result = connected && current && "days" in current ? current : undefined;
  const waiting = connected && !current;
  useEffect(
    () =>
      onLoad(
        host.id,
        result
          ? { since, days: result.days, sessions: result.sessions }
          : waiting
            ? { since }
            : undefined,
      ),
    [host.id, since, result, waiting, onLoad],
  );

  // One host's wait is the page's skeleton; with several, each says so.
  const status =
    hostStatus(connection) ??
    (!current
      ? named
        ? "Loading…"
        : undefined
      : "days" in current
        ? undefined
        : usageError(current));
  const notes = status ? [status] : (result?.problems.map((p) => p.message) ?? []);
  return notes.map((note) => (
    <p key={note} className="mb-6 text-[13px] text-muted-foreground">
      {named && `${host.name}: `}
      {note}
    </p>
  ));
}

type BreakdownBy = "model" | "time";

/**
 * A range's usage, each part a full-width row: a summary strip, the tokens by kind, the chart, a
 * card per provider, then a breakdown by model or by day. The strips stay short so the chart fits
 * on screen without scrolling. `stale` dims it while another range loads.
 */
function Dashboard({
  frame,
  stale,
  view,
  by,
  onBy,
}: {
  frame: Frame;
  stale: boolean;
  view: "cost" | "tokens";
  by: BreakdownBy;
  onBy: (by: BreakdownBy) => void;
}) {
  const { range, span, days } = frame;
  const { starts } = span;
  const today = range === "today";
  const words = rangeWords[range];
  // Once per answer, not on every render; Cost and Tokens share it.
  const summary = useMemo(
    () => summarize(days, starts, span.previous, span.partial, frame.sessions),
    [days, starts, span, frame.sessions],
  );
  // The chart part a legend item points at, to pick it out in every bar.
  const [picked, setPicked] = useState<number>();
  // New numbers can drop the legend from under the pointer, so nothing stays picked.
  useEffect(() => setPicked(undefined), [frame.version]);
  const cost = view === "cost";
  const measure = (m: Measures) => (cost ? m.cost : tokensOf(m));
  const format = (n: number) => (cost ? dollars(n) : tokenCount.format(n));
  // A backend or model that used tokens but reported no cost has none to show, not $0.
  const unreported = (m: Measures) => cost && m.cost === 0 && m.unpriced > 0;
  const shown = (m: Measures) => (unreported(m) ? "—" : format(measure(m)));
  const other = (m: Measures) =>
    cost
      ? `${tokenCount.format(tokensOf(m))} tokens`
      : m.cost > 0
        ? dollars(m.cost)
        : "no reported cost";
  const whole = measure(summary.total);
  const what = cost ? "cost" : "tokens";
  const name = (start: number, long = false) =>
    new Date(start).toLocaleString(
      "en",
      long
        ? { weekday: "short", month: "short", day: "numeric" }
        : starts.length <= 7
          ? { weekday: "short" }
          : { month: "short", day: "numeric" },
    );

  if (tokensOf(summary.total) === 0)
    return (
      <Empty title={`No usage ${words.past}`}>
        Claude Code, Codex, and Cursor usage on your hosts shows here.
      </Empty>
    );

  const rows = attribute(summary.models, measure, unreported);
  const parts = stack(rows, measure);
  const lead = rows[0]?.share ? rows[0] : undefined;
  const sessions = summary.sessions;

  let note = plural(summary.backends.length, "provider");
  if (!today)
    note += ` · ${plural(summary.byBucket.filter((m) => tokensOf(m) > 0).length, "active day")}`;
  if (cost && summary.total.unpriced > 0)
    note += ` · ${percent(summary.total.unpriced, tokensOf(summary.total))} of tokens have no reported cost`;

  const LeadLogo = lead?.model.backend && backends[lead.model.backend].Logo;
  const none = <span className="text-[26px] text-faint-foreground">—</span>;
  const chartTitle = today
    ? `${cost ? "Cost" : "Processed tokens"} by model today`
    : `Daily ${cost ? "cost" : "processed tokens"}`;
  const processed = tokensOf(summary.total);

  return (
    <div
      aria-busy={stale || undefined}
      className={`flex flex-col gap-4 transition-opacity ${stale ? "opacity-45" : ""}`}
    >
      <dl className={`${strip} @2xl:grid-cols-[minmax(0,5fr)_minmax(0,4fr)_minmax(0,5fr)]`}>
        <Stat label={cost ? "Total cost" : "Processed tokens"} note={note}>
          {whole > 0 ? (
            <span className="text-[40px] font-semibold tracking-tight">{shown(summary.total)}</span>
          ) : (
            none
          )}
        </Stat>
        <Stat
          label="Sessions"
          title="Claude Code and Codex sessions, each counted on the day it was last active. Cursor doesn't report sessions."
          note={
            !sessions
              ? "Not counted"
              : `${Math.round(sessions.previous).toLocaleString(locale())} ${words.previous}`
          }
        >
          {sessions ? (
            <span className="text-[40px] font-semibold tracking-tight tabular-nums">
              {sessions.total.toLocaleString(locale())}
            </span>
          ) : (
            none
          )}
        </Stat>
        <Stat
          label="Busiest model"
          note={
            lead
              ? `${percent(measure(lead.model.total), whole)} of ${what} · ${shown(lead.model.total)}`
              : "No model reported a cost"
          }
        >
          {lead ? (
            <span className="flex min-w-0 items-center gap-2.5 text-[18px] font-medium">
              {LeadLogo && <LeadLogo aria-hidden className="size-5 shrink-0" />}
              <span className="truncate">{lead.model.model}</span>
            </span>
          ) : (
            none
          )}
        </Stat>
      </dl>

      {/* Short, one line per kind, so the chart below still fits on screen. */}
      <dl aria-label="Tokens by kind" className={`${strip} grid-cols-2 @2xl:grid-cols-5`}>
        {(
          [
            ["Processed tokens", processed],
            ["Cached input", summary.total.cacheRead],
            ["Uncached input", summary.total.input],
            ["Cache writes", summary.total.cacheWrite],
            ["Output", summary.total.output],
          ] as const
        ).map(([label, n], i) => (
          <div
            key={label}
            // The total spans the row while the kinds sit two to a row.
            className={`min-w-0 bg-surface px-6 py-3 ${i === 0 ? "col-span-2 @2xl:col-span-1" : ""}`}
          >
            <dt className="truncate text-[12px] text-muted-foreground">{label}</dt>
            <dd className="mt-1.5 flex items-baseline gap-2 whitespace-nowrap">
              <span
                title={n.toLocaleString(locale())}
                className="text-[18px] leading-none font-semibold tracking-tight tabular-nums"
              >
                {tokenCount.format(n)}
              </span>
              <span className="truncate text-[12px] text-faint-foreground tabular-nums">
                {i === 0 ? "every kind" : percent(n, processed)}
              </span>
            </dd>
          </div>
        ))}
      </dl>

      {whole === 0 ? (
        <figure className={`${card} min-w-0 px-6 pt-5 pb-5`}>
          <figcaption className="text-[14px] font-medium">{chartTitle}</figcaption>
          <Empty title="No vendor reported a cost in this range" plain>
            Tokens still count: see them under Tokens.
          </Empty>
        </figure>
      ) : today ? (
        // One day is one bar, so Today shows only how it splits.
        <figure className={`${card} min-w-0 px-6 pt-5 pb-5`}>
          <figcaption className="text-[14px] font-medium">{chartTitle}</figcaption>
          <Split parts={parts} whole={whole} format={format} />
        </figure>
      ) : (
        <Bars
          // Its own per answer, so new numbers rise together.
          key={frame.version}
          title={chartTitle}
          parts={parts}
          picked={picked}
          bars={starts.map((start, i) => ({
            key: start,
            axis: name(start),
            name: name(start, true),
            note: other(summary.byBucket[i]!),
          }))}
          format={format}
          tick={(n, step) =>
            cost && step >= 1_000_000 ? wholeUsd.format(n / 1_000_000) : format(n)
          }
        >
          {parts.length > 1 && (
            <Split parts={parts} whole={whole} format={format} picked={picked} onPick={setPicked} />
          )}
        </Bars>
      )}

      <section aria-label="Providers">
        <h2 className={heading}>Providers</h2>
        {/* One row of equal cards when there's room, however many providers. */}
        <ul
          className="grid gap-5 @2xl:grid-cols-[repeat(var(--n),minmax(0,1fr))]"
          style={{ "--n": summary.backends.length } as CSSProperties}
        >
          {summary.backends.map(({ backend, total }) => {
            const { name, Logo } = backends[backend];
            const share = unreported(total) || whole === 0 ? undefined : measure(total) / whole;
            return (
              <li key={backend} aria-label={name} className={`${card} min-w-0 px-6 pt-4.5 pb-5`}>
                <div className="flex items-center gap-2.5 text-[13.5px] font-medium">
                  <Logo aria-hidden className="size-4.5 shrink-0" />
                  <span className="truncate">{name}</span>
                </div>
                <p className="mt-3.5 text-[26px] leading-none font-semibold tracking-tight tabular-nums">
                  {shown(total)}
                </p>
                <div aria-hidden className="mt-4 h-1 overflow-hidden rounded-full bg-selected">
                  {share !== undefined && (
                    <div
                      className="usage-fill h-full min-w-[3px] rounded-full bg-chart-1"
                      style={{ width: `${share * 100}%` }}
                    />
                  )}
                </div>
                <p className="mt-2.5 truncate text-[12.5px] text-muted-foreground">
                  {share === undefined ? "No reported cost" : `${percent(share, 1)} of ${what}`} ·{" "}
                  {other(total)}
                </p>
              </li>
            );
          })}
        </ul>
      </section>

      <Breakdown
        by={today ? "model" : by}
        onBy={onBy}
        unit={today ? undefined : "Day"}
        what={cost ? "Cost" : "Tokens"}
        rows={
          today || by === "model"
            ? rows.map(({ model, share, part }) => {
                const Logo = model.backend && backends[model.backend].Logo;
                return {
                  key: `${model.backend}/${model.model}`,
                  name: model.model,
                  icon: Logo && <Logo aria-hidden className="size-4 shrink-0" />,
                  value: shown(model.total),
                  share,
                  fill: fills[part]!,
                  other: unreported(model.total)
                    ? `No reported cost · ${other(model.total)}`
                    : other(model.total),
                };
              })
            : starts
                .map((start, i) => ({ start, total: summary.byBucket[i]! }))
                .filter((t) => tokensOf(t.total) > 0)
                .reverse()
                .map((t) => ({
                  key: String(t.start),
                  name: name(t.start, true),
                  value: shown(t.total),
                  ...(!unreported(t.total) && whole > 0 && { share: measure(t.total) / whole }),
                  fill: fills[0]!,
                  other: other(t.total),
                }))
        }
      />
    </div>
  );
}

/** One figure in a strip: a label, the figure, and a line under it. `title` explains the label. */
function Stat({
  label,
  title,
  note,
  children,
}: {
  label: string;
  title?: string;
  note: string;
  children: ReactNode;
}) {
  return (
    <div className="flex min-w-0 flex-col bg-surface px-6 pt-4 pb-4">
      <dt title={title} className="text-[12.5px] text-muted-foreground">
        {label}
      </dt>
      <dd className="mt-2.5 flex h-11 min-w-0 items-center leading-none">{children}</dd>
      <dd className="mt-1.5 text-[12.5px] text-pretty text-muted-foreground">{note}</dd>
    </div>
  );
}

/**
 * The chart's card: stacked bars over the buckets on a nice axis, a part per model from the
 * bottom, with a few names under them and a dashed line at the daily average, then `children`.
 * The bars rise in a wave from left to right as it mounts. Pointing at a bar or focusing it (arrow
 * keys move along) shows its numbers above the plot, over its column, where they never cover a
 * bar, and dims the others; Escape hides them. A `picked` part stands out in every bar. Screen
 * readers get the same numbers from each bar's label.
 */
function Bars({
  title,
  parts,
  picked,
  bars,
  format,
  tick,
  children,
}: {
  title: string;
  parts: Part[];
  /** The part to pick out, from the legend. */
  picked?: number;
  /** Per bucket: its name under the bar (shortest) and in full, and a line for its readout. */
  bars: { key: number; axis: string; name: string; note: string }[];
  format: (n: number) => string;
  /** An axis label, given the axis's step, so whole steps can drop their cents. */
  tick: (n: number, step: number) => string;
  children?: ReactNode;
}) {
  const n = bars.length;
  const totals = bars.map((_, i) => parts.reduce((sum, p) => sum + p.values[i]!, 0));
  const top = niceTop(Math.max(0, ...totals));
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((f) => f * top);
  const average = totals.reduce((a, b) => a + b, 0) / n;
  const [active, setActive] = useState<number>();
  // The one bar in the tab order, the latest at first.
  const [stop, setStop] = useState(n - 1);
  // The bar with keyboard focus, whose numbers come back when the pointer leaves.
  const focused = useRef<number>(undefined);
  const plot = useRef<HTMLDivElement>(null);
  // A bar is rounded at its top, barely at the baseline, and its parts barely where they meet.
  const [bar, joint] =
    n > 45
      ? ["rounded-t-[3px] rounded-b-[1px]", ""]
      : n > 12
        ? ["rounded-t-[5px] rounded-b-[2px]", "rounded-[2px]"]
        : ["rounded-t-[8px] rounded-b-[3px]", "rounded-[3px]"];
  const every = Math.ceil(n / 7);
  const dim = (part: number) =>
    picked === undefined || picked === part ? "" : "opacity-25 transition-opacity";

  // Escape hides the numbers, wherever focus is, without moving it or the pointer.
  useEffect(() => {
    if (active === undefined) return;
    const hide = (e: globalThis.KeyboardEvent) => {
      if (e.key !== "Escape") return;
      focused.current = undefined;
      setActive(undefined);
    };
    window.addEventListener("keydown", hide);
    return () => window.removeEventListener("keydown", hide);
  }, [active]);

  const move = (e: KeyboardEvent, i: number) => {
    const to = { ArrowLeft: i - 1, ArrowRight: i + 1, Home: 0, End: n - 1 }[e.key];
    if (to === undefined) return;
    e.preventDefault();
    plot.current
      ?.querySelectorAll<HTMLElement>("[data-bar]")
      [Math.max(0, Math.min(n - 1, to))]?.focus();
  };

  return (
    // The numbers stay while the pointer is anywhere on the card, so it can move onto them.
    <figure
      onPointerLeave={() => setActive(focused.current)}
      className={`${card} min-w-0 px-6 pt-5 pb-5`}
    >
      <figcaption className="text-[14px] font-medium">{title}</figcaption>
      <div className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3">
        <div />
        <div aria-hidden className="relative mt-1 mb-3 h-10">
          {active !== undefined && active < n && (
            <Readout
              at={active}
              n={n}
              name={bars[active]!.name}
              note={bars[active]!.note}
              total={totals[active]!}
              parts={parts}
              format={format}
            />
          )}
        </div>
        <div
          aria-hidden
          className="relative h-48 text-right text-[11px] text-faint-foreground tabular-nums"
        >
          {/* Sizes the column to the widest label; the real ones sit on their lines. */}
          <span className="invisible">{tick(top, top / 4)}</span>
          {ticks.map((t) => (
            <span
              key={t}
              className="absolute right-0 -translate-y-1/2"
              style={{ top: `${100 - (t / top) * 100}%` }}
            >
              {tick(t, top / 4)}
            </span>
          ))}
        </div>
        <div ref={plot} role="group" aria-label={title} className="relative flex h-48">
          {ticks.map((t) => (
            <div
              key={t}
              aria-hidden
              className="usage-grid absolute inset-x-0 border-t border-border"
              style={{ top: `${100 - (t / top) * 100}%` }}
            />
          ))}
          {average > 0 && (
            <div
              aria-hidden
              className="usage-average pointer-events-none absolute inset-x-0 z-10 border-t border-dashed border-foreground/35"
              style={{ top: `${100 - (average / top) * 100}%` }}
            >
              <span className="absolute right-0 -translate-y-1/2 rounded-md border border-border bg-surface px-1.5 py-0.5 text-[11px] text-muted-foreground tabular-nums">
                avg {format(average)}
              </span>
            </div>
          )}
          {bars.map((b, i) => {
            const total = totals[i]!;
            const values = parts.map((p) => p.values[i]!);
            const largest = values.indexOf(Math.max(...values));
            const label =
              `${b.name}: ${format(total)}` +
              (parts.length > 1
                ? ` (${parts.map((p, k) => `${p.name} ${format(values[k]!)}`).join(", ")})`
                : "") +
              `, ${b.note}`;
            // The topmost part takes no gap above it.
            const last = values.findLastIndex((v) => v > 0);
            let below = 0;
            return (
              <div
                key={b.key}
                data-bar
                role="img"
                aria-label={label}
                tabIndex={i === Math.min(stop, n - 1) ? 0 : -1}
                data-active={active === i || undefined}
                onPointerEnter={() => setActive(i)}
                onFocus={(e) => {
                  if (e.currentTarget.matches(":focus-visible")) focused.current = i;
                  setActive(i);
                  setStop(i);
                }}
                onBlur={() => {
                  focused.current = undefined;
                  setActive(undefined);
                }}
                onKeyDown={(e) => move(e, i)}
                // Focus shows as the column's wash and a mark under the axis, not as a ring,
                // which on a narrow column would look like a bar of its own.
                className="group relative flex h-full min-w-0 flex-1 items-end justify-center rounded-md outline-none focus-visible:bg-selected data-active:not-focus-visible:bg-hover"
              >
                <span
                  aria-hidden
                  className="absolute -bottom-2 left-1/2 hidden h-[3px] w-3 -translate-x-1/2 rounded-full bg-foreground group-focus-visible:block"
                />
                {total > 0 && (
                  <div
                    className={`usage-rise relative w-[min(62%,2.5rem)] overflow-hidden transition-[opacity,filter] duration-200 motion-safe:transition-[height,opacity,filter] ${bar} ${
                      active === undefined ? "" : active === i ? "brightness-125" : "opacity-40"
                    }`}
                    style={
                      {
                        height: `max(3px, ${(total / top) * 100}%)`,
                        "--delay": `${Math.round((i * 520) / n)}ms`,
                      } as CSSProperties
                    }
                  >
                    {/* Each part sits exactly at its share of the bar, a 2px gap cut from its
                        top; a sliver keeps 1px. A bar too short to split is one part, its
                        largest, and the readout has the rest. */}
                    {total / top < 0.035 ? (
                      <div
                        className={`absolute inset-0 ${fills[parts[largest]!.part]} ${dim(parts[largest]!.part)}`}
                      />
                    ) : (
                      values.map((v, k) => {
                        if (v <= 0) return null;
                        const share = (v / total) * 100;
                        const style = {
                          bottom: `${(below / total) * 100}%`,
                          height:
                            k === last ? `max(1px, ${share}%)` : `max(1px, calc(${share}% - 2px))`,
                        };
                        below += v;
                        return (
                          <div
                            key={k}
                            className={`absolute inset-x-0 ${joint} ${fills[parts[k]!.part]} ${dim(parts[k]!.part)}`}
                            style={style}
                          />
                        );
                      })
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
        <div />
        {/* Names under every few bars, counted back from the latest so it always has one. */}
        <div aria-hidden className="relative mt-2.5 h-4 text-[11px] text-faint-foreground">
          {bars.map((b, i) => {
            if ((n - 1 - i) % every !== 0) return null;
            const center = ((i + 0.5) / n) * 100;
            const edge = center < 6 ? "start" : center > 94 ? "end" : "center";
            return (
              <span
                key={b.key}
                className="absolute whitespace-nowrap"
                style={
                  edge === "start"
                    ? { left: `${(i / n) * 100}%` }
                    : edge === "end"
                      ? { right: `${((n - 1 - i) / n) * 100}%` }
                      : { left: `${center}%`, translate: "-50% 0" }
                }
              >
                {b.axis}
              </span>
            );
          })}
        </div>
      </div>
      {children}
    </figure>
  );
}

/**
 * A bar's numbers, above the plot over its column: its name and total, then each part keyed by
 * a short stroke, and the other measure. It leans toward the side its bar is on, so it always
 * fits. Screen readers read the bar's label instead.
 */
function Readout({
  at,
  n,
  name,
  note,
  total,
  parts,
  format,
}: {
  at: number;
  n: number;
  name: string;
  note: string;
  total: number;
  parts: Part[];
  format: (n: number) => string;
}) {
  // At p% across the plot, its own p% point sits over the bar: flush left at the first bar,
  // centered in the middle, flush right at the last.
  const p = ((at + 0.5) / n) * 100;
  const end = p > 50;
  return (
    <div
      data-readout
      className={`absolute bottom-0 flex max-w-full flex-col motion-safe:transition-[left,translate] motion-safe:duration-150 motion-safe:ease-out ${end ? "items-end" : "items-start"}`}
      style={{ left: `${p}%`, translate: `-${p}% 0` }}
    >
      <p className="flex items-baseline gap-2 whitespace-nowrap">
        <span className="text-[12px] text-muted-foreground">{name}</span>
        <span className="text-[15px] font-semibold tabular-nums">{format(total)}</span>
      </p>
      <p className="mt-1 flex max-w-full items-center gap-3 overflow-hidden text-[12px] whitespace-nowrap text-muted-foreground">
        {parts.length > 1 &&
          parts.map((part) => (
            <span key={part.part} className="flex shrink-0 items-center gap-1.5">
              <span className={`h-[3px] w-2.5 rounded-full ${fills[part.part]}`} />
              {part.name}
              <span className="text-foreground tabular-nums">{format(part.values[at]!)}</span>
            </span>
          ))}
        <span className="min-w-0 truncate text-faint-foreground">{note}</span>
      </p>
    </div>
  );
}

/**
 * The chart's legend: the range split between its parts as a slim meter, each part named under it.
 * Pointing at a part, with `onPick`, picks it out in the meter and the bars.
 */
function Split({
  parts,
  whole,
  format,
  picked,
  onPick,
}: {
  parts: Part[];
  whole: number;
  format: (n: number) => string;
  picked?: number;
  onPick?: (part?: number) => void;
}) {
  const dim = (part: number) => (picked === undefined || picked === part ? "" : "opacity-35");
  const sums = parts.map((p) => p.values.reduce((a, b) => a + b, 0));
  return (
    <div className="mt-4 border-t border-border pt-4">
      <div aria-hidden className="usage-fill flex h-1.5 gap-[2px]">
        {sums.map((s, k) => (
          <div
            key={parts[k]!.part}
            className={`min-w-[3px] basis-0 rounded-full transition-opacity ${fills[parts[k]!.part]} ${dim(parts[k]!.part)}`}
            style={{ flexGrow: s / whole }}
          />
        ))}
      </div>
      <ul
        onPointerLeave={() => onPick?.(undefined)}
        className="mt-3.5 flex flex-wrap gap-x-7 gap-y-2 text-[12.5px]"
      >
        {parts.map((p, k) => {
          const Logo = p.backend && backends[p.backend].Logo;
          return (
            <li
              key={p.part}
              onPointerEnter={() => onPick?.(p.part)}
              className={`flex min-w-0 items-center gap-2 transition-opacity ${onPick ? "cursor-default" : ""} ${dim(p.part)}`}
            >
              <span aria-hidden className={`size-2.5 shrink-0 rounded-[3px] ${fills[p.part]}`} />
              {Logo && <Logo aria-hidden className="size-3.5 shrink-0" />}
              <span className="truncate text-muted-foreground">{p.name}</span>
              <span className="font-medium whitespace-nowrap tabular-nums">{format(sums[k]!)}</span>
              <span className="text-faint-foreground tabular-nums">{percent(sums[k]!, whole)}</span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/** How many breakdown rows show before Show more. */
const BREAKDOWN_ROWS = 5;

/**
 * The range's usage by model (largest first) or by `unit` (latest first), each with a share bar,
 * the first `BREAKDOWN_ROWS` until Show more. Without a `unit`, only by model.
 */
function Breakdown({
  by,
  onBy,
  unit,
  what,
  rows,
}: {
  by: BreakdownBy;
  onBy: (by: BreakdownBy) => void;
  unit?: string;
  /** What the value is: "Cost" or "Tokens". */
  what: string;
  rows: {
    key: string;
    name: string;
    icon?: ReactNode;
    value: string;
    /** Of the range, 0 to 1; none when the value isn't counted. */
    share?: number;
    fill: string;
    /** The other measure, quietly after the name. */
    other: string;
  }[];
}) {
  const [all, setAll] = useState(false);
  const hidden = rows.length - BREAKDOWN_ROWS;
  return (
    <section aria-label="Breakdown" className={`${card} min-w-0 px-6 py-4`}>
      <div className="flex items-center justify-between gap-3 pb-3">
        <h2 className="text-[14px] font-medium">Breakdown</h2>
        {unit && (
          <Segmented
            label="Breakdown by"
            options={[
              { value: "model", name: "Model" },
              { value: "time", name: unit },
            ]}
            value={by}
            onChange={onBy}
          />
        )}
      </div>
      <div className="flex gap-2.5 border-t border-border pt-3 pb-1 text-[12px] text-faint-foreground">
        <span>{by === "model" ? "Model" : unit}</span>
        <span className="ml-auto">{what}</span>
        <span className="w-16 text-right">Share</span>
      </div>
      <ul>
        {(all ? rows : rows.slice(0, BREAKDOWN_ROWS)).map((r) => (
          <li key={r.key} className="border-b border-border py-3 last:border-0">
            <div className="flex items-baseline gap-2.5 text-[13.5px]">
              {r.icon && <span className="self-center">{r.icon}</span>}
              <span className="min-w-0 truncate">{r.name}</span>
              {/* Gives way first when the row is narrow. */}
              <span className="min-w-0 shrink-[10] truncate text-[12px] text-faint-foreground">
                {r.other}
              </span>
              <span className="ml-auto pl-3 font-medium whitespace-nowrap tabular-nums">
                {r.value}
              </span>
              <span className="w-16 shrink-0 text-right text-muted-foreground tabular-nums">
                {r.share === undefined ? "—" : percent(r.share, 1)}
              </span>
            </div>
            <div aria-hidden className="mt-2.5 h-1 overflow-hidden rounded-full bg-selected">
              {r.share !== undefined && (
                <div
                  className={`usage-fill h-full min-w-[3px] rounded-full ${r.fill}`}
                  style={{ width: `${r.share * 100}%` }}
                />
              )}
            </div>
          </li>
        ))}
      </ul>
      {hidden > 0 && (
        <button
          type="button"
          aria-expanded={all}
          onClick={() => setAll(!all)}
          className="mt-1 w-full border-t border-border pt-3 pb-1 text-[12.5px] font-medium text-muted-foreground hover:text-foreground"
        >
          {all ? "Show less" : `Show ${hidden} more`}
        </button>
      )}
    </section>
  );
}

/** Seven quiet rounded bars, standing in for a chart when there's nothing. */
function GhostBars() {
  return (
    <div aria-hidden className="flex h-20 items-end justify-center gap-2">
      {[34, 58, 42, 76, 50, 66, 28].map((h, i) => (
        <div key={i} className="w-4 rounded-[5px] bg-selected" style={{ height: `${h}%` }} />
      ))}
    </div>
  );
}

/** Nothing to show yet: a title and why, under ghost bars, on its own card unless `plain`. */
function Empty({
  title,
  plain = false,
  children,
}: {
  title: string;
  plain?: boolean;
  children: ReactNode;
}) {
  return (
    <div
      className={`flex flex-col items-center px-6 text-center ${plain ? "py-8" : `${card} py-14`}`}
    >
      <GhostBars />
      <p className="mt-6 text-[14px] font-medium">{title}</p>
      <p className="mt-1 max-w-sm text-[13px] text-muted-foreground">{children}</p>
    </div>
  );
}

/** The dashboard's shape while the first answer is on its way. */
function DashboardSkeleton() {
  const block = "rounded-md bg-selected";
  return (
    <div aria-hidden className="flex flex-col gap-5 motion-safe:animate-pulse">
      <div className={`${strip} @2xl:grid-cols-[minmax(0,5fr)_minmax(0,4fr)_minmax(0,5fr)]`}>
        {[36, 24, 32].map((w, i) => (
          <div key={i} className="bg-surface px-6 py-5">
            <div className={`h-3 w-24 ${block}`} />
            <div className={`mt-4 h-9 ${block}`} style={{ width: `${w * 4}px` }} />
            <div className={`mt-3 h-3 w-36 ${block}`} />
          </div>
        ))}
      </div>
      <div className={`${card} px-6 pt-5 pb-8`}>
        <div className={`h-3.5 w-28 ${block}`} />
        <div className="mt-6 flex h-48 items-end">
          {Array.from({ length: 30 }, (_, i) => (
            <div key={i} className="flex h-full flex-1 items-end justify-center">
              <div
                className="w-[62%] rounded-t-[5px] rounded-b-[2px] bg-selected"
                style={{ height: `${20 + 50 * Math.abs(Math.sin(i * 1.3 + 0.4))}%` }}
              />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

/** How often the Limits view asks each host's CLIs for their windows again. */
const LIMITS_POLL_MS = 60_000;

/**
 * A host's `usage/limits`, asked again `LIMITS_POLL_MS` after each answer while `connected`, and
 * at once whenever `refresh` changes. `limits` is undefined until it first answers; a later
 * failure keeps the last answer.
 */
function useLimits(
  hostId: string,
  connected: boolean,
  refresh: number,
  track: Track,
): { limits?: AccountLimits[]; error?: RpcError } {
  const [limits, setLimits] = useState<AccountLimits[]>();
  const [error, setError] = useState<RpcError>();
  useEffect(() => {
    if (!connected) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const load = async () => {
      const answer = await track(window.parallax.request(hostId, "usage/limits", {}));
      if (stopped) return;
      if ("result" in answer) {
        setLimits(answer.result.accounts);
        setError(undefined);
      } else setError(answer.error);
      timer = setTimeout(() => void load(), LIMITS_POLL_MS);
    };
    void load();
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [hostId, connected, refresh, track]);
  return { limits, error };
}

/**
 * One host's subscriptions' limit windows, read live from their CLIs, under the host's name when
 * there are several: a section per account, a row per window.
 */
function HostLimits({
  host,
  named,
  refresh,
  track,
}: {
  host: Host;
  named: boolean;
  refresh: number;
  track: Track;
}) {
  const connection = useConnection(host.id);
  const connected = connection?.status === "connected";
  const { limits, error } = useLimits(host.id, connected, refresh, track);
  const keys = useKeys(host.id, connected, refresh);

  // A host that isn't connected shows its status, not its last answer, whose resets are stale.
  const status = hostStatus(connection);
  const accounts = (!status && limits ? limits : []).map((a) => {
    const backend = backendOf(a.accountId, keys);
    const info = backend && backends[backend];
    return { ...a, backend, name: info?.name ?? a.accountId, Logo: info?.Logo };
  });
  accounts.sort((a, b) => a.name.localeCompare(b.name, locale()));
  const now = Date.now();

  return (
    <section aria-label={host.name} className="mb-10">
      {named && <h2 className="mb-4 text-[13px] font-medium text-muted-foreground">{host.name}</h2>}
      {/* Always there, so a screen reader hears its text change. */}
      <p role="status" className="sr-only">
        {!status && !limits && !error ? "Loading…" : ""}
      </p>
      {status || (!limits && error) ? (
        <p className="text-[13px] text-muted-foreground">{status ?? usageError(error!)}</p>
      ) : !limits ? (
        <LimitsSkeleton />
      ) : accounts.length === 0 ? (
        <Empty title="No subscriptions">Limits show here for Claude Code and Codex.</Empty>
      ) : (
        <div className="flex flex-col gap-8">
          {accounts.map(({ accountId, limits, problem, backend, name, Logo }) => (
            <section key={accountId} aria-label={name}>
              <h3 className="mb-3 flex items-center gap-2.5 px-1 text-[15px] font-medium">
                {Logo && <Logo aria-hidden className="size-4.5 shrink-0" />}
                {name}
              </h3>
              {limits.length === 0 ? (
                <p className={`${card} px-6 py-4 text-[13px] text-muted-foreground`}>
                  {problem ? `Couldn't read its limits: ${problem}` : "No limits for this login."}
                </p>
              ) : (
                <div className="flex flex-col gap-3">
                  {limits.map((limit) => (
                    <LimitMeter key={limit.window} limit={limit} backend={backend} now={now} />
                  ))}
                </div>
              )}
            </section>
          ))}
        </div>
      )}
    </section>
  );
}

/**
 * A meter's fill: the backend's own tint, amber and then red near the cap, mixed into the
 * surface so it's opaque over the stripes.
 */
const meterFill: Record<LimitTone, string> = {
  normal: "bg-[color-mix(in_oklab,var(--color-foreground)_22%,var(--color-surface))]",
  warning: "bg-[color-mix(in_oklab,var(--color-warning)_45%,var(--color-surface))]",
  danger: "bg-[color-mix(in_oklab,var(--color-danger)_45%,var(--color-surface))]",
};
const backendFill: Partial<Record<Backend, string>> = {
  claude: "bg-[color-mix(in_oklab,#D97757_40%,var(--color-surface))]",
};

/** The part of a meter that's used: thin diagonal stripes. */
const stripes: CSSProperties = {
  backgroundImage:
    "repeating-linear-gradient(-45deg, var(--color-border) 0 1px, transparent 1px 7px)",
};

/**
 * When a window resets, on the clock: a time today, "tomorrow" and a time, a weekday and time
 * within the week, else a date.
 */
export function resetTime(at: number, now: number): string {
  // By local calendar days; rounding absorbs a 23- or 25-hour day.
  const days = Math.round((dayStart(at) - dayStart(now)) / (24 * HOUR));
  const when = new Date(at);
  const time = when.toLocaleString("en", clockOptions());
  if (days === 0) return time;
  if (days === 1) return `tomorrow ${time}`;
  if (days < 7) return `${when.toLocaleString("en", { weekday: "short" })} ${time}`;
  return when.toLocaleString("en", { month: "short", day: "numeric" });
}

/**
 * One limit window as a row: its name and how much is left, then a bar filled to what's left,
 * striped where it's used, with how long until it resets.
 */
function LimitMeter({
  limit,
  backend,
  now,
}: {
  limit: UsageLimitWindow;
  backend?: Backend;
  now: number;
}) {
  const { name, left, tone, resetsIn } = limitMeter(limit, now);
  const at = limit.resetsAt === undefined ? undefined : Date.parse(limit.resetsAt);
  const fill =
    tone === "normal" ? (backend && backendFill[backend]) || meterFill.normal : meterFill[tone];
  return (
    <div
      title={limitDetails(limit)}
      className={`${card} flex min-w-0 flex-col gap-4 px-6 py-5 @2xl:flex-row @2xl:items-center @2xl:gap-8`}
    >
      <div className="shrink-0 @2xl:w-56">
        <p className="truncate text-[14px] font-medium">{name}</p>
        <p className="mt-1.5 flex items-baseline gap-1.5">
          <span
            className={`text-[34px] leading-none font-semibold tracking-tight ${left === 0 ? "text-danger" : ""}`}
          >
            {left === undefined ? "—" : `${left}%`}
          </span>
          <span className="text-[13px] text-muted-foreground">
            {left === undefined ? "use not reported" : "left"}
          </span>
        </p>
      </div>
      <div
        {...(left !== undefined && {
          role: "meter",
          "aria-label": name,
          "aria-valuemin": 0,
          "aria-valuemax": 100,
          "aria-valuenow": left,
          "aria-valuetext": `${left}% left`,
        })}
        style={stripes}
        className="relative h-10 min-w-0 flex-1 overflow-hidden rounded-lg bg-selected/40"
      >
        {!!left && (
          <div className={`usage-fill h-full rounded-lg ${fill}`} style={{ width: `${left}%` }} />
        )}
        <span className="absolute inset-y-0 left-3 flex items-center text-[12.5px] font-semibold">
          {left === undefined ? "" : `${left}%`}
        </span>
        {resetsIn && (
          <span
            title={at === undefined ? undefined : `Resets ${resetTime(at, now)}`}
            className="absolute inset-y-1.5 right-1.5 flex items-center gap-1 rounded-md bg-background/85 px-2 text-[12px] font-medium [&_svg]:size-3"
          >
            <RotateCw aria-hidden />
            {resetsIn}
          </span>
        )}
      </div>
    </div>
  );
}

/** An account's shape while its host's first answer is on its way. */
function LimitsSkeleton() {
  const block = "rounded-md bg-selected";
  return (
    <div aria-hidden className="flex flex-col gap-3 motion-safe:animate-pulse">
      <div className="mb-0 flex items-center gap-2.5 px-1">
        <div className="size-4.5 rounded-full bg-selected" />
        <div className={`h-3.5 w-28 ${block}`} />
      </div>
      {[0, 1].map((i) => (
        <div key={i} className={`${card} flex items-center gap-8 px-6 py-5`}>
          <div className="w-56 shrink-0">
            <div className={`h-3 w-20 ${block}`} />
            <div className={`mt-3 h-8 w-28 ${block}`} />
          </div>
          <div className="h-10 flex-1 rounded-lg bg-selected" />
        </div>
      ))}
    </div>
  );
}
