import {
  ArrowDownRight,
  ArrowUpRight,
  Minus,
  OctagonAlert,
  RefreshCw,
  RotateCw,
  TriangleAlert,
} from "lucide-react";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ComponentType,
  type CSSProperties,
  type KeyboardEvent,
  type ReactNode,
  type SVGProps,
} from "react";

import type { RpcError } from "../preload/bridge";
import {
  ErrorCodes,
  type AccountRuns,
  type KeyAccount,
  type Provider,
  type UsageHour,
  type UsageLimitWindow,
} from "../protocol/generated/protocol";
import { statusLabel, useConnection } from "./ConnectionStatus";
import { describeError } from "./errors";
import type { Host } from "./hosts";
import { ClaudeLogo, CursorLogo, OpenAILogo } from "./logos";
import { Breadcrumb, IconButton, Segmented, TopBar } from "./ui";
import { limitDetails, limitMeter, useUsage, type LimitTone } from "./Usage";

type View = "cost" | "tokens" | "limits";
const views: { value: View; name: string }[] = [
  { value: "cost", name: "Cost" },
  { value: "tokens", name: "Tokens" },
  { value: "limits", name: "Limits" },
];

/** How far back Cost and Tokens look: the past 24 hours by the hour, or whole local days. */
export type Range = "24h" | "7d" | "30d" | "90d";
const ranges: { value: Range; name: string }[] = [
  { value: "24h", name: "Past 24h" },
  { value: "7d", name: "7 days" },
  { value: "30d", name: "30 days" },
  { value: "90d", name: "90 days" },
];
const rangeDays = { "7d": 7, "30d": 30, "90d": 90 };
const rangeWords: Record<Range, string> = {
  "24h": "24 hours",
  "7d": "7 days",
  "30d": "30 days",
  "90d": "90 days",
};

type Logo = ComponentType<SVGProps<SVGSVGElement>>;

/** The backends that run accounts (0012). A subscription account's id is its backend's. */
export type Backend = "claude" | "codex" | "cursor";
const backends: Record<Backend, { name: string; Logo: Logo }> = {
  claude: { name: "Claude Code", Logo: ClaudeLogo },
  codex: { name: "Codex", Logo: OpenAILogo },
  cursor: { name: "Cursor", Logo: CursorLogo },
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
 * A host's API keys, to name their accounts and tell their backend, asked again whenever
 * `refresh` changes. Empty until they answer.
 */
function useKeys(hostId: string, connected: boolean, refresh?: number): KeyAccount[] {
  const [keys, setKeys] = useState<KeyAccount[]>([]);
  useEffect(() => {
    if (!connected) return;
    let stopped = false;
    void window.wisp.request(hostId, "accounts/keys/list", {}).then((answer) => {
      if (!stopped && "result" in answer) setKeys(answer.result.accounts);
    });
    return () => {
      stopped = true;
    };
  }, [hostId, connected, refresh]);
  return keys;
}

/** A failed usage request, for people. A wispd without the method is too old. */
function usageError(error: RpcError): string {
  return error.code === ErrorCodes.MethodNotFound
    ? "Update wispd on this host to see its usage here."
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
 * Where `range` starts at `now`, and its chart's buckets by start time: the last 24 hours for
 * Past 24h, otherwise whole local days ending today. `previous` are the buckets of the range of
 * the same length just before it, to compare with. Its last bucket is only compared up to
 * `until`, as far into it as `now` is into the range's last, since that one isn't over yet.
 */
export function buckets(
  range: Range,
  now: number,
): { starts: number[]; previous: number[]; until: number; hourly: boolean } {
  if (range === "24h") {
    // ponytail: UTC hours, which are local hours except in half-hour time zones.
    const hour = Math.floor(now / HOUR) * HOUR;
    const run = (back: number) =>
      Array.from({ length: 24 }, (_, i) => hour - (back + 23 - i) * HOUR);
    return { starts: run(0), previous: run(24), until: now - 24 * HOUR, hourly: true };
  }
  const days = rangeDays[range];
  const run = (back: number) =>
    Array.from({ length: days }, (_, i) => {
      const d = new Date(now);
      d.setDate(d.getDate() - (back + days - 1 - i));
      return dayStart(d.getTime());
    });
  // By the calendar, so the clock time holds across a daylight saving change.
  const until = new Date(now);
  until.setDate(until.getDate() - days);
  return { starts: run(0), previous: run(days), until: until.getTime(), hourly: false };
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

/** Adds `h` to `m`, or the `scale` of it that falls in a span, as if spread over its hour. */
function add(m: Measures, h: UsageHour, scale = 1) {
  m.input += h.inputTokens * scale;
  m.output += h.outputTokens * scale;
  m.cacheRead += h.cacheReadTokens * scale;
  m.cacheWrite += h.cacheWriteTokens * scale;
  if (h.costUsdMicros === undefined)
    m.unpriced += (h.inputTokens + h.outputTokens + h.cacheReadTokens + h.cacheWriteTokens) * scale;
  else m.cost += h.costUsdMicros * scale;
}

/**
 * One host's `usage/history`, with its API keys to tell each account's backend. `previous` is a
 * second answer's hours, reaching back over the range before, when the host gave one.
 */
export interface HostHistory {
  hours: UsageHour[];
  runs: AccountRuns[];
  keys: KeyAccount[];
  previous?: UsageHour[];
}

export interface Summary {
  total: Measures;
  /** The range before, of the same length, when every history reaches back over it. */
  previous?: Measures;
  threads: number;
  /** Per bucket of `starts`. */
  byBucket: Measures[];
  /** In `backends`' order, only those with usage. */
  backends: { backend: Backend; threads: number; total: Measures; byBucket: Measures[] }[];
  models: { backend?: Backend; model: string; total: Measures; byBucket: Measures[] }[];
}

/**
 * Every host's history summed by backend, model, and bucket, and over the `previous` buckets up
 * to `until`. The hour that holds `until` counts only for the part of it before, as the range's
 * own last hour holds only the part so far. An hour outside the buckets, from an answer for a
 * longer range, is left out.
 */
export function summarize(
  histories: HostHistory[],
  starts: number[],
  hourly: boolean,
  previous: number[] = [],
  until = Infinity,
): Summary {
  const index = new Map(starts.map((start, i) => [start, i]));
  const total = zero();
  const byBucket = starts.map(zero);
  const perBackend = new Map<Backend, Summary["backends"][number]>();
  const perModel = new Map<string, Summary["models"][number]>();
  const backendEntry = (backend: Backend) => {
    let entry = perBackend.get(backend);
    if (!entry)
      perBackend.set(
        backend,
        (entry = { backend, threads: 0, total: zero(), byBucket: starts.map(zero) }),
      );
    return entry;
  };
  let threads = 0;
  for (const { hours, runs, keys } of histories) {
    for (const r of runs) {
      threads += r.runs;
      const backend = backendOf(r.accountId, keys);
      if (backend) backendEntry(backend).threads += r.runs;
    }
    for (const h of hours) {
      const at = Date.parse(h.hour);
      const i = index.get(hourly ? at : dayStart(at));
      if (i === undefined) continue;
      add(total, h);
      add(byBucket[i]!, h);
      const backend = backendOf(h.accountId, keys);
      if (backend) {
        const entry = backendEntry(backend);
        add(entry.total, h);
        add(entry.byBucket[i]!, h);
      }
      const model = h.model ?? "Unknown model";
      const key = `${backend}/${model}`;
      let entry = perModel.get(key);
      if (!entry)
        perModel.set(key, (entry = { backend, model, total: zero(), byBucket: starts.map(zero) }));
      add(entry.total, h);
      add(entry.byBucket[i]!, h);
    }
  }
  let before: Measures | undefined;
  if (previous.length > 0 && histories.length > 0 && histories.every((h) => h.previous)) {
    const earlier = new Set(previous);
    before = zero();
    for (const h of histories.flatMap((h) => h.previous!)) {
      const at = Date.parse(h.hour);
      if (at < until && earlier.has(hourly ? at : dayStart(at)))
        add(before, h, Math.min(1, (until - at) / HOUR));
    }
  }
  return {
    total,
    ...(before && { previous: before }),
    threads,
    byBucket,
    backends: (Object.keys(backends) as Backend[]).flatMap((b) => perBackend.get(b) ?? []),
    models: [...perModel.values()],
  };
}

/** How much `now` changed from `before`, as a fraction (0.25 is a quarter more), if any before. */
export function change(now: number, before?: number): number | undefined {
  return before ? (now - before) / before : undefined;
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
      `${a.backend}/${a.model}`.localeCompare(`${b.backend}/${b.model}`),
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

const usd = new Intl.NumberFormat("en", { style: "currency", currency: "USD" });
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
const signedPercent = new Intl.NumberFormat("en", {
  style: "percent",
  maximumFractionDigits: 1,
  signDisplay: "exceptZero",
});
/** "+18.2%", or "−6.7%" with a true minus. */
const signed = (fraction: number) => signedPercent.format(fraction).replace("-", "−");

/** The chart's fills for its parts, bottom up (index.css). */
const fills = ["bg-chart-1", "bg-chart-2", "bg-chart-3"];
const card = "rounded-xl border border-border bg-surface";

/**
 * The Usage page, from the sidebar's Usage button. The top bar always has the view, the range
 * (disabled on Limits, which is always now), and Refresh. Cost and Tokens sum `usage/history`
 * across every host; Limits shows each host's accounts' windows from `usage/get`.
 */
export function UsagePage({
  hosts,
  leading,
  topBarClassName,
}: {
  hosts: Host[];
  /** Before the breadcrumb, such as Show sidebar. */
  leading?: ReactNode;
  topBarClassName: string;
}) {
  const [view, setView] = useState<View>("cost");
  const [range, setRange] = useState<Range>("30d");
  // When the range was last chosen or refreshed: what the buckets end at.
  const [now, setNow] = useState(Date.now);
  return (
    <>
      <TopBar className={topBarClassName}>
        {leading}
        <Breadcrumb items={[{ label: "Usage" }, { label: "All hosts" }]} />
        <div className="ml-auto flex items-center gap-2">
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
          <IconButton label="Refresh" onClick={() => setNow(Date.now())}>
            <RefreshCw />
          </IconButton>
        </div>
      </TopBar>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {/* A container, so the layout follows the pane's width rather than the window's. */}
        <div className="@container mx-auto max-w-5xl px-8 pt-6 pb-16">
          {view === "limits" ? (
            hosts.map((h) => (
              <HostLimits key={h.id} host={h} named={hosts.length > 1} refresh={now} />
            ))
          ) : (
            <History hosts={hosts} view={view} range={range} now={now} />
          )}
        </div>
      </div>
    </>
  );
}

/** A host's history for `since`, or, without one, that it's on its way. */
interface Loaded {
  since: string;
  history?: HostHistory;
}

/** What Cost and Tokens draw: a range's buckets, and the histories in for them so far. */
interface Frame {
  range: Range;
  span: ReturnType<typeof buckets>;
  histories: HostHistory[];
  loading: boolean;
}

/** Cost or Tokens over `range`, summed across `hosts`, each host's trouble noted on top. */
function History({
  hosts,
  view,
  range,
  now,
}: {
  hosts: Host[];
  view: "cost" | "tokens";
  range: Range;
  now: number;
}) {
  const span = useMemo(() => buckets(range, now), [range, now]);
  const since = new Date(span.starts[0]!).toISOString();
  const before = new Date(span.previous[0]!).toISOString();
  const [loaded, setLoaded] = useState<Record<string, Loaded | undefined>>({});
  // Here rather than in Breakdown, which unmounts while a new range loads.
  const [by, setBy] = useState<BreakdownBy>("model");
  const onLoad = useCallback(
    (hostId: string, state?: Loaded) => setLoaded((all) => ({ ...all, [hostId]: state })),
    [],
  );
  const frame = useMemo<Frame>(() => {
    const histories: HostHistory[] = [];
    let loading = false;
    for (const h of hosts) {
      const state = loaded[h.id];
      if (state?.history && state.since === since) histories.push(state.history);
      else if (state) loading = true;
    }
    return { range, span, histories, loading };
  }, [hosts, loaded, since, range, span]);
  // The last frame with usage, shown dimmed while another range loads, so nothing jumps.
  const [held, setHeld] = useState<Frame>();
  useEffect(() => {
    if (frame.histories.length > 0) setHeld(frame);
  }, [frame]);
  const shown = frame.histories.length > 0 ? frame : frame.loading ? held : undefined;

  return (
    <>
      {/* The loaders stay first and in place, so they're never remounted (which would drop
          their answers and ask again) as the rest appears. Refresh reaches them through `now`. */}
      <div>
        {hosts.map((h) => (
          <HostHistoryLoader
            key={h.id}
            host={h}
            named={hosts.length > 1}
            since={since}
            before={before}
            refresh={now}
            onLoad={onLoad}
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
 * Asks one host for its history since `since`, and since `before` for the range before it, once
 * it's connected, and again whenever they or `refresh` change, and hands it to `onLoad` (without
 * a history while it waits, and undefined when it has none to give). A refresh keeps the last
 * answer until the next arrives; a new `since` drops it, since its hours and run counts are for
 * another range. Shows why the host has nothing, if it doesn't.
 */
function HostHistoryLoader({
  host,
  named,
  since,
  before,
  refresh,
  onLoad,
}: {
  host: Host;
  named: boolean;
  since: string;
  before: string;
  refresh: number;
  onLoad: (hostId: string, state?: Loaded) => void;
}) {
  const connection = useConnection(host.id);
  const connected = connection?.status === "connected";
  const keys = useKeys(host.id, connected, refresh);
  const [answer, setAnswer] = useState<{
    since: string;
    value: Omit<HostHistory, "keys"> | RpcError;
  }>();
  useEffect(() => {
    if (!connected) return;
    let stopped = false;
    // The range's own answer, for its run counts; the longer one is only for the range before.
    void Promise.all([
      window.wisp.request(host.id, "usage/history", { since }),
      window.wisp.request(host.id, "usage/history", { since: before }),
    ]).then(([range, longer]) => {
      if (stopped) return;
      setAnswer({
        since,
        value:
          "result" in range
            ? { ...range.result, ...("result" in longer && { previous: longer.result.hours }) }
            : range.error,
      });
    });
    return () => {
      stopped = true;
    };
  }, [host.id, connected, since, before, refresh]);
  const current = answer?.since === since ? answer.value : undefined;
  const history = connected && current && "hours" in current ? current : undefined;
  const waiting = connected && !current;
  useEffect(
    () =>
      onLoad(
        host.id,
        history ? { since, history: { ...history, keys } } : waiting ? { since } : undefined,
      ),
    [host.id, since, history, waiting, keys, onLoad],
  );

  // One host's wait is the page's skeleton; with several, each says so.
  const note =
    hostStatus(connection) ??
    (!current
      ? named
        ? "Loading…"
        : undefined
      : "hours" in current
        ? undefined
        : usageError(current));
  if (!note) return null;
  return (
    <p className="mb-6 text-[13px] text-muted-foreground">
      {named && `${host.name}: `}
      {note}
    </p>
  );
}

type BreakdownBy = "model" | "time";

/**
 * A range's usage: a summary strip, the stacked bars, then a breakdown by model or by bucket
 * beside the providers and the tokens by kind. `stale` dims it while another range loads.
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
  const { range, span, histories } = frame;
  const { starts, hourly } = span;
  // Once per answer, not on every render; Cost and Tokens share it.
  const summary = useMemo(
    () => summarize(histories, starts, hourly, span.previous, span.until),
    [histories, starts, hourly, span],
  );
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
      hourly
        ? long
          ? { weekday: "short", hour: "numeric" }
          : { hour: "numeric" }
        : long
          ? { weekday: "short", month: "short", day: "numeric" }
          : starts.length <= 7
            ? { weekday: "short" }
            : { month: "short", day: "numeric" },
    );

  if (tokensOf(summary.total) === 0)
    return (
      <Empty title={`No usage in the past ${rangeWords[range]}`}>
        Tokens and cost show here once an agent runs.
      </Empty>
    );

  const rows = attribute(summary.models, measure, unreported);
  const parts = stack(rows, measure);
  const lead = rows[0]?.share ? rows[0] : undefined;
  // A range with no reported cost has no change to show, rather than −100%.
  const delta =
    whole > 0 ? change(whole, summary.previous && measure(summary.previous)) : undefined;

  let note = `${summary.threads} ${summary.threads === 1 ? "thread" : "threads"}`;
  if (cost && summary.total.unpriced > 0)
    note += ` · ${percent(summary.total.unpriced, tokensOf(summary.total))} of tokens have no reported cost`;

  const DeltaIcon = !delta ? Minus : delta > 0 ? ArrowUpRight : ArrowDownRight;
  const LeadLogo = lead?.model.backend && backends[lead.model.backend].Logo;
  const none = <span className="text-[26px] text-faint-foreground">—</span>;
  const chartTitle = `${hourly ? "Hourly" : "Daily"} ${cost ? "cost" : "processed tokens"}`;

  return (
    <div
      aria-busy={stale || undefined}
      className={`flex flex-col gap-5 transition-opacity ${stale ? "opacity-45" : ""}`}
    >
      <dl className="grid gap-px overflow-hidden rounded-xl border border-border bg-border @2xl:grid-cols-[minmax(0,5fr)_minmax(0,4fr)_minmax(0,5fr)]">
        <Stat label={cost ? "Total cost" : "Processed tokens"} note={note}>
          {whole > 0 ? (
            <span className="text-[40px] font-semibold tracking-tight">{shown(summary.total)}</span>
          ) : (
            none
          )}
        </Stat>
        <Stat
          label="Change"
          note={
            whole === 0
              ? "No reported cost in this range"
              : !summary.previous
                ? "Nothing to compare with"
                : delta === undefined
                  ? `No ${cost ? "reported cost" : "usage"} in the previous ${rangeWords[range]}`
                  : `From ${format(measure(summary.previous))} in the previous ${rangeWords[range]}`
          }
        >
          {delta === undefined ? (
            none
          ) : (
            <span className="flex items-center gap-2.5">
              <span className="grid size-7 place-items-center rounded-full bg-selected text-muted-foreground [&_svg]:size-4">
                <DeltaIcon aria-hidden />
              </span>
              <span className="text-[26px] font-semibold tracking-tight">{signed(delta)}</span>
            </span>
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

      {whole > 0 ? (
        <Bars
          // Its own per range, so a new range's bars rise together.
          key={range}
          title={chartTitle}
          parts={parts}
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
          {parts.length > 1 && <Split parts={parts} whole={whole} format={format} />}
        </Bars>
      ) : (
        <figure className={`${card} min-w-0 px-6 pt-5 pb-5`}>
          <figcaption className="text-[14px] font-medium">{chartTitle}</figcaption>
          <Empty title="No vendor reported a cost in this range" plain>
            Tokens still count: see them under Tokens.
          </Empty>
        </figure>
      )}

      <div className="grid items-start gap-5 @3xl:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
        <Breakdown
          by={by}
          onBy={onBy}
          unit={hourly ? "Hour" : "Day"}
          what={cost ? "Cost" : "Tokens"}
          rows={
            by === "model"
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
        <div className="flex flex-col gap-5">
          <section aria-label="Providers" className={`${card} px-6 py-4`}>
            <h2 className="pt-1 pb-2 text-[14px] font-medium">Providers</h2>
            <ul>
              {summary.backends.map(({ backend, threads, total }) => {
                const { name, Logo } = backends[backend];
                return (
                  <li key={backend} className="border-t border-border py-3">
                    <div className="flex items-center gap-2.5 text-[13.5px]">
                      <Logo aria-hidden className="size-4.5 shrink-0" />
                      <span className="truncate font-medium">{name}</span>
                      <span className="shrink-0 text-[12.5px] whitespace-nowrap text-muted-foreground">
                        {threads} {threads === 1 ? "thread" : "threads"}
                      </span>
                      <span className="ml-auto pl-3 font-medium whitespace-nowrap tabular-nums">
                        {shown(total)}
                      </span>
                    </div>
                    <p className="mt-1 pl-7 text-[12.5px] text-muted-foreground">
                      {unreported(total)
                        ? "No reported cost"
                        : `${percent(measure(total), whole)} of ${what}`}{" "}
                      · {other(total)}
                    </p>
                  </li>
                );
              })}
            </ul>
          </section>
          <section aria-label="Tokens by kind" className={`${card} px-6 py-4`}>
            <h2 className="pt-1 pb-2 text-[14px] font-medium">Tokens by kind</h2>
            <dl>
              {(
                [
                  ["Processed tokens", tokensOf(summary.total)],
                  ["Cached input", summary.total.cacheRead],
                  ["Uncached input", summary.total.input],
                  ["Cache writes", summary.total.cacheWrite],
                  ["Output", summary.total.output],
                ] as const
              ).map(([name, n]) => (
                <div
                  key={name}
                  className="flex items-center justify-between border-t border-border py-2.5 text-[13px]"
                >
                  <dt className="text-muted-foreground">{name}</dt>
                  <dd title={n.toLocaleString()} className="font-medium tabular-nums">
                    {tokenCount.format(n)}
                  </dd>
                </div>
              ))}
            </dl>
          </section>
        </div>
      </div>
    </div>
  );
}

/** One figure in the summary strip: a label, the figure, and a line under it. */
function Stat({ label, note, children }: { label: string; note: string; children: ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col bg-surface px-6 pt-5 pb-5">
      <dt className="text-[12.5px] text-muted-foreground">{label}</dt>
      <dd className="mt-3 flex h-11 min-w-0 items-center leading-none">{children}</dd>
      <dd className="mt-2 text-[12.5px] text-pretty text-muted-foreground">{note}</dd>
    </div>
  );
}

/**
 * The chart's card: stacked bars over the buckets on a nice axis, a part per model from the
 * bottom, with a few names under them, then `children`. Pointing at a bar or focusing it (arrow
 * keys move along) shows its numbers above the plot, over its column, where they never cover a
 * bar; Escape hides them. Screen readers get the same numbers from each bar's label.
 */
function Bars({
  title,
  parts,
  bars,
  format,
  tick,
  children,
}: {
  title: string;
  parts: Part[];
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

  // Escape hides the numbers, wherever focus is, without moving it or the pointer.
  useEffect(() => {
    if (active === undefined) return;
    const hide = (e: globalThis.KeyboardEvent) => {
      if (e.key === "Escape") setActive(undefined);
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
        <div aria-hidden className="relative mt-1 mb-4 h-10">
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
          className="relative h-56 text-right text-[11px] text-faint-foreground tabular-nums"
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
        <div ref={plot} role="group" aria-label={title} className="relative flex h-56">
          {ticks.map((t) => (
            <div
              key={t}
              aria-hidden
              className="absolute inset-x-0 border-t border-border"
              style={{ top: `${100 - (t / top) * 100}%` }}
            />
          ))}
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
                onFocus={() => {
                  focused.current = i;
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
                    className={`usage-rise relative w-[min(62%,2.5rem)] overflow-hidden motion-safe:transition-[height] motion-safe:duration-300 ${bar}`}
                    style={
                      {
                        height: `max(3px, ${(total / top) * 100}%)`,
                        "--delay": `${Math.round((i * 360) / n)}ms`,
                      } as CSSProperties
                    }
                  >
                    {/* Each part sits exactly at its share of the bar, a 2px gap cut from its
                        top; a sliver keeps 1px. A bar too short to split is one part, its
                        largest, and the readout has the rest. */}
                    {total / top < 0.035 ? (
                      <div className={`absolute inset-0 ${fills[parts[largest]!.part]}`} />
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
                            className={`absolute inset-x-0 ${joint} ${fills[parts[k]!.part]}`}
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
      className={`absolute bottom-0 flex max-w-full flex-col ${end ? "items-end" : "items-start"}`}
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

/** The chart's legend: the range split between its parts as a slim meter, each part named under it. */
function Split({
  parts,
  whole,
  format,
}: {
  parts: Part[];
  whole: number;
  format: (n: number) => string;
}) {
  const sums = parts.map((p) => p.values.reduce((a, b) => a + b, 0));
  return (
    <div className="mt-5 border-t border-border pt-5">
      <div aria-hidden className="usage-fill flex h-1.5 gap-[2px]">
        {sums.map((s, k) => (
          <div
            key={parts[k]!.part}
            className={`min-w-[3px] basis-0 rounded-full ${fills[parts[k]!.part]}`}
            style={{ flexGrow: s / whole }}
          />
        ))}
      </div>
      <ul className="mt-3.5 flex flex-wrap gap-x-7 gap-y-2 text-[12.5px]">
        {parts.map((p, k) => {
          const Logo = p.backend && backends[p.backend].Logo;
          return (
            <li key={p.part} className="flex min-w-0 items-center gap-2">
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

/** The range's usage by model (largest first) or by day or hour (latest first), each with a share bar. */
function Breakdown({
  by,
  onBy,
  unit,
  what,
  rows,
}: {
  by: BreakdownBy;
  onBy: (by: BreakdownBy) => void;
  unit: string;
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
  return (
    <section aria-label="Breakdown" className={`${card} min-w-0 px-6 py-4`}>
      <div className="flex items-center justify-between gap-3 pb-3">
        <h2 className="text-[14px] font-medium">Breakdown</h2>
        <Segmented
          label="Breakdown by"
          options={[
            { value: "model", name: "Model" },
            { value: "time", name: unit },
          ]}
          value={by}
          onChange={onBy}
        />
      </div>
      <div className="flex gap-2.5 border-t border-border pt-3 pb-1 text-[12px] text-faint-foreground">
        <span>{by === "model" ? "Model" : unit}</span>
        <span className="ml-auto">{what}</span>
        <span className="w-16 text-right">Share</span>
      </div>
      <ul>
        {rows.map((r) => (
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
    </section>
  );
}

/** Seven quiet rounded bars, standing in for a chart: still when there's nothing, pulsing while it loads. */
function GhostBars({ pulse = false }: { pulse?: boolean }) {
  return (
    <div
      aria-hidden
      className={`flex h-20 items-end justify-center gap-2 ${pulse ? "motion-safe:animate-pulse" : ""}`}
    >
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
      <div className="grid gap-px overflow-hidden rounded-xl border border-border bg-border @2xl:grid-cols-[minmax(0,5fr)_minmax(0,4fr)_minmax(0,5fr)]">
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
        <div className="mt-6 flex h-56 items-end">
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

/**
 * One host's accounts' limit windows, under the host's name when there are several, asked again
 * in place when `refresh` changes.
 */
function HostLimits({ host, named, refresh }: { host: Host; named: boolean; refresh: number }) {
  const connection = useConnection(host.id);
  const connected = connection?.status === "connected";
  const { usage, error } = useUsage(host.id, connected, refresh);
  const keys = useKeys(host.id, connected, refresh);

  // A host that isn't connected shows its status, not its last answer, whose resets are stale.
  const status = hostStatus(connection);
  const accounts = [...((!status && usage?.values()) || [])].map((a) => {
    const key = keys.find((k) => k.id === a.accountId);
    const backend = backendOf(a.accountId, keys);
    const info = backend && backends[backend];
    return { usage: a, name: key?.label ?? info?.name ?? a.accountId, Logo: info?.Logo };
  });
  accounts.sort((a, b) => a.name.localeCompare(b.name));
  const now = Date.now();

  return (
    <section aria-label={host.name} className="mb-10">
      {named && <h2 className="mb-4 text-[13px] font-medium text-muted-foreground">{host.name}</h2>}
      {/* Always there, so a screen reader hears its text change. */}
      <p role="status" className="sr-only">
        {!status && !usage && !error ? "Loading…" : ""}
      </p>
      {status || (!usage && error) ? (
        <p className="text-[13px] text-muted-foreground">{status ?? usageError(error!)}</p>
      ) : !usage ? (
        <LimitsSkeleton />
      ) : usage.size === 0 ? (
        <Empty title="No usage yet">It shows here once an agent runs.</Empty>
      ) : (
        <div className="flex flex-col gap-5">
          {accounts.map(({ usage: a, name, Logo }) => (
            <section key={a.accountId} aria-label={name} className={`${card} overflow-hidden`}>
              <h3 className="flex items-center gap-2.5 px-6 pt-4 pb-3.5 text-[14px] font-medium">
                {Logo && <Logo aria-hidden className="size-4.5 shrink-0" />}
                {name}
              </h3>
              {a.limits.length === 0 ? (
                <p className="border-t border-border px-6 py-4 text-[13px] text-muted-foreground">
                  No limits reported for this account.
                </p>
              ) : (
                <div className="grid grid-cols-[repeat(auto-fit,minmax(13rem,1fr))] gap-px border-t border-border bg-border">
                  {a.limits.map((limit) => (
                    <LimitMeter key={limit.window} limit={limit} now={now} />
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

const meterTrack: Record<LimitTone, string> = {
  normal: "bg-accent/15",
  warning: "bg-warning/18",
  danger: "bg-danger/18",
};
const meterFill: Record<LimitTone, string> = {
  normal: "bg-accent",
  warning: "bg-warning",
  danger: "bg-danger",
};

/**
 * When a window resets, on the clock: a time today, "tomorrow" and a time, a weekday and time
 * within the week, else a date.
 */
export function resetTime(at: number, now: number): string {
  // By local calendar days; rounding absorbs a 23- or 25-hour day.
  const days = Math.round((dayStart(at) - dayStart(now)) / (24 * HOUR));
  const when = new Date(at);
  const time = when.toLocaleString("en", { hour: "numeric", minute: "2-digit" });
  if (days === 0) return time;
  if (days === 1) return `tomorrow ${time}`;
  if (days < 7) return `${when.toLocaleString("en", { weekday: "short" })} ${time}`;
  return when.toLocaleString("en", { month: "short", day: "numeric" });
}

/**
 * One limit window as a meter: how much is used, the bar in the accent (amber, then red, near
 * the cap, with a word and an icon to say so), and when it resets.
 */
function LimitMeter({ limit, now }: { limit: UsageLimitWindow; now: number }) {
  const { name, used, tone, resets } = limitMeter(limit, now);
  const at = limit.resetsAt === undefined ? undefined : Date.parse(limit.resetsAt);
  const Warning = tone === "danger" ? OctagonAlert : TriangleAlert;
  return (
    <div title={limitDetails(limit)} className="min-w-0 bg-surface px-6 pt-4 pb-5">
      <div className="flex items-center gap-2 text-[13px]">
        <span className="truncate font-medium">{name}</span>
        {tone !== "normal" && (
          <span className="ml-auto flex shrink-0 items-center gap-1 text-[12px] text-muted-foreground">
            <Warning
              aria-hidden
              className={`size-3.5 ${tone === "danger" ? "text-danger" : "text-warning"}`}
            />
            {used === 100
              ? "Limit reached"
              : tone === "danger"
                ? "Almost reached"
                : "Near the limit"}
          </span>
        )}
      </div>
      <p className="mt-3 flex items-baseline gap-1.5">
        <span
          className={`text-[30px] leading-none font-semibold tracking-tight ${used === 100 ? "text-danger" : ""}`}
        >
          {used === undefined ? "—" : `${used}%`}
        </span>
        <span className="text-[13px] text-muted-foreground">
          {used === undefined ? "use not reported" : "used"}
        </span>
      </p>
      <div
        {...(used !== undefined && {
          role: "meter",
          "aria-label": name,
          "aria-valuemin": 0,
          "aria-valuemax": 100,
          "aria-valuenow": used,
          "aria-valuetext": `${used}% used`,
        })}
        className={`mt-4 h-1.5 overflow-hidden rounded-full ${meterTrack[tone]}`}
      >
        {!!used && (
          <div
            className={`usage-fill h-full min-w-1.5 rounded-full ${meterFill[tone]}`}
            style={{ width: `${used}%` }}
          />
        )}
      </div>
      <p className="mt-3 flex min-w-0 items-center gap-1.5 text-[12.5px] text-muted-foreground [&_svg]:size-3.5 [&_svg]:shrink-0">
        <RotateCw aria-hidden />
        <span className="truncate">
          {resets}
          {at !== undefined && at > now && (
            <span className="text-faint-foreground"> · {resetTime(at, now)}</span>
          )}
        </span>
      </p>
    </div>
  );
}

/** An account card's shape while its host's first answer is on its way. */
function LimitsSkeleton() {
  const block = "rounded-md bg-selected";
  return (
    <div aria-hidden className={`${card} overflow-hidden motion-safe:animate-pulse`}>
      <div className="flex items-center gap-2.5 px-6 pt-4 pb-3.5">
        <div className={`size-4.5 rounded-full bg-selected`} />
        <div className={`h-3.5 w-28 ${block}`} />
      </div>
      <div className="grid grid-cols-[repeat(auto-fit,minmax(13rem,1fr))] gap-px border-t border-border bg-border">
        {[0, 1, 2].map((i) => (
          <div key={i} className="bg-surface px-6 pt-4 pb-5">
            <div className={`h-3 w-20 ${block}`} />
            <div className={`mt-4 h-7 w-24 ${block}`} />
            <div className="mt-4 h-1.5 rounded-full bg-selected" />
            <div className={`mt-3.5 h-3 w-32 ${block}`} />
          </div>
        ))}
      </div>
    </div>
  );
}
