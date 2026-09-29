import { RefreshCw, RotateCw } from "lucide-react";
import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type ComponentType,
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
import { limitCard, limitDetails, useUsage } from "./Usage";

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

type Logo = ComponentType<SVGProps<SVGSVGElement>>;

/** The backends that run accounts (0012). A subscription account's id is its backend's. */
export type Backend = "claude" | "codex" | "cursor";
const backends: Record<Backend, { name: string; Logo: Logo; color: string; fill: string }> = {
  claude: { name: "Claude Code", Logo: ClaudeLogo, color: "#D97757", fill: "bg-[#D97757]/45" },
  codex: {
    name: "Codex",
    Logo: OpenAILogo,
    color: "var(--foreground)",
    fill: "bg-muted-foreground/35",
  },
  cursor: {
    name: "Cursor",
    Logo: CursorLogo,
    color: "var(--muted-foreground)",
    fill: "bg-muted-foreground/35",
  },
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

/** A host's API keys, to name their accounts and tell their backend. Empty until they answer. */
function useKeys(hostId: string, connected: boolean): KeyAccount[] {
  const [keys, setKeys] = useState<KeyAccount[]>([]);
  useEffect(() => {
    if (!connected) return;
    void window.wisp.request(hostId, "accounts/keys/list", {}).then((answer) => {
      if ("result" in answer) setKeys(answer.result.accounts);
    });
  }, [hostId, connected]);
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
 * Past 24h, otherwise whole local days ending today.
 */
export function buckets(range: Range, now: number): { starts: number[]; hourly: boolean } {
  if (range === "24h") {
    // ponytail: UTC hours, which are local hours except in half-hour time zones.
    const hour = Math.floor(now / HOUR) * HOUR;
    return { starts: Array.from({ length: 24 }, (_, i) => hour - (23 - i) * HOUR), hourly: true };
  }
  const days = rangeDays[range];
  const starts = Array.from({ length: days }, (_, i) => {
    const d = new Date(now);
    d.setDate(d.getDate() - (days - 1 - i));
    return dayStart(d.getTime());
  });
  return { starts, hourly: false };
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

function add(m: Measures, h: UsageHour) {
  m.input += h.inputTokens;
  m.output += h.outputTokens;
  m.cacheRead += h.cacheReadTokens;
  m.cacheWrite += h.cacheWriteTokens;
  if (h.costUsdMicros === undefined)
    m.unpriced += h.inputTokens + h.outputTokens + h.cacheReadTokens + h.cacheWriteTokens;
  else m.cost += h.costUsdMicros;
}

/** One host's `usage/history`, with its API keys to tell each account's backend. */
export interface HostHistory {
  hours: UsageHour[];
  runs: AccountRuns[];
  keys: KeyAccount[];
}

export interface Summary {
  total: Measures;
  threads: number;
  /** Per bucket of `starts`. */
  byBucket: Measures[];
  /** In `backends`' order, only those with usage. */
  backends: { backend: Backend; threads: number; total: Measures; byBucket: Measures[] }[];
  models: { backend?: Backend; model: string; total: Measures }[];
}

/**
 * Every host's history summed by backend, model, and bucket. An hour outside the buckets, from
 * an answer for a longer range, is left out.
 */
export function summarize(histories: HostHistory[], starts: number[], hourly: boolean): Summary {
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
      if (!entry) perModel.set(key, (entry = { backend, model, total: zero() }));
      add(entry.total, h);
    }
  }
  return {
    total,
    threads,
    byBucket,
    backends: (Object.keys(backends) as Backend[]).flatMap((b) => perBackend.get(b) ?? []),
    models: [...perModel.values()],
  };
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
              // Keyed by `now`, so Refresh asks again.
              <HostLimits key={`${h.id}/${now}`} host={h} named={hosts.length > 1} />
            ))
          ) : (
            <History hosts={hosts} view={view} range={range} now={now} />
          )}
        </div>
      </div>
    </>
  );
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
  const { starts, hourly } = useMemo(() => buckets(range, now), [range, now]);
  const since = new Date(starts[0]!).toISOString();
  const [loaded, setLoaded] = useState<Record<string, HostHistory | undefined>>({});
  const onLoad = useCallback(
    (hostId: string, history?: HostHistory) => setLoaded((all) => ({ ...all, [hostId]: history })),
    [],
  );
  const histories = hosts.flatMap((h) => loaded[h.id] ?? []);
  const summary = summarize(histories, starts, hourly);

  const cost = view === "cost";
  const measure = (m: Measures) => (cost ? m.cost : tokensOf(m));
  const format = (n: number) => (cost ? dollars(n) : tokenCount.format(n));
  // A backend or model that used tokens but reported no cost has none to show, not $0.
  const shown = (m: Measures) =>
    cost && m.cost === 0 && m.unpriced > 0 ? "—" : format(measure(m));
  const whole = measure(summary.total);
  const label = (start: number, long = false) =>
    new Date(start).toLocaleString(
      "en",
      hourly
        ? { hour: "numeric" }
        : long
          ? { weekday: "short", month: "short", day: "numeric" }
          : { month: "short", day: "numeric" },
    );

  // One element in the same place in every return below, so the loaders are never remounted
  // (which would drop their answers and ask again) as the rest appears.
  const notes = (
    <div>
      {hosts.map((h) => (
        <HostHistoryLoader
          key={h.id}
          host={h}
          named={hosts.length > 1}
          since={since}
          onLoad={onLoad}
        />
      ))}
    </div>
  );
  if (histories.length === 0) return <>{notes}</>;
  if (tokensOf(summary.total) === 0)
    return (
      <>
        {notes}
        <p className="text-[13px] text-muted-foreground">
          No usage in the {ranges.find((r) => r.value === range)!.name.toLowerCase()}.
        </p>
      </>
    );

  let subtitle = `${summary.threads} ${summary.threads === 1 ? "thread" : "threads"}`;
  if (cost && summary.total.unpriced > 0)
    subtitle += ` · ${percent(summary.total.unpriced, tokensOf(summary.total))} of tokens have no reported cost`;

  return (
    <>
      {notes}
      <div className="grid gap-10 @3xl:grid-cols-[minmax(0,5fr)_minmax(0,8fr)]">
        <div>
          <span className="block text-[44px] leading-tight font-semibold tabular-nums">
            {format(whole)}
          </span>
          <p className="mt-1 text-[13px] text-muted-foreground">{subtitle}</p>
          <ul className="mt-7 flex flex-col gap-5">
            {summary.backends.map(({ backend, threads, total }) => {
              const { name, Logo, color } = backends[backend];
              const other = cost
                ? `${tokenCount.format(tokensOf(total))} tokens`
                : total.cost > 0
                  ? dollars(total.cost)
                  : "no reported cost";
              return (
                <li key={backend}>
                  <div className="flex items-center gap-2.5 text-[15px]">
                    <span
                      aria-hidden
                      className="size-2 shrink-0 rounded-full"
                      style={{ background: color }}
                    />
                    <Logo className="size-4.5 shrink-0" />
                    <span className="truncate font-medium">{name}</span>
                    <span className="shrink-0 text-[12.5px] whitespace-nowrap text-muted-foreground">
                      {threads} {threads === 1 ? "thread" : "threads"}
                    </span>
                    <span className="ml-auto pl-3 font-medium whitespace-nowrap tabular-nums">
                      {shown(total)}
                    </span>
                  </div>
                  <p className="mt-1 pl-[18px] text-[12.5px] text-muted-foreground">
                    {percent(measure(total), whole)} of {cost ? "cost" : "tokens"} · {other}
                  </p>
                </li>
              );
            })}
          </ul>
        </div>
        <Chart
          title={`${hourly ? "Hourly" : "Daily"} ${cost ? "cost" : "processed tokens"}`}
          series={summary.backends.map((b) => ({
            color: backends[b.backend].color,
            values: b.byBucket.map(measure),
          }))}
          labels={starts.map((s) => label(s))}
          format={format}
        />
      </div>

      <h2 className="mt-12 mb-4 text-[15px] font-medium">Totals</h2>
      <dl className="grid grid-cols-2 gap-6 @xl:grid-cols-5">
        {(
          [
            ["Processed tokens", tokensOf(summary.total)],
            ["Cached input", summary.total.cacheRead],
            ["Uncached input", summary.total.input],
            ["Cache writes", summary.total.cacheWrite],
            ["Output", summary.total.output],
          ] as const
        ).map(([name, n]) => (
          <div key={name}>
            <dt className="text-[12.5px] text-muted-foreground">{name}</dt>
            <dd title={n.toLocaleString()} className="mt-1 text-[20px] font-medium tabular-nums">
              {tokenCount.format(n)}
            </dd>
          </div>
        ))}
      </dl>

      <Breakdown
        hourly={hourly}
        whole={whole}
        measure={measure}
        shown={shown}
        models={summary.models}
        times={starts
          .map((start, i) => ({ start, total: summary.byBucket[i]! }))
          .filter((t) => tokensOf(t.total) > 0)
          .reverse()
          .map((t) => ({ name: label(t.start, true), total: t.total }))}
        cost={cost}
      />
    </>
  );
}

/**
 * Asks one host for its history since `since` once it's connected, and hands it to `onLoad`
 * (undefined while it has none). Shows why the host has nothing, if it doesn't.
 */
function HostHistoryLoader({
  host,
  named,
  since,
  onLoad,
}: {
  host: Host;
  named: boolean;
  since: string;
  onLoad: (hostId: string, history?: HostHistory) => void;
}) {
  const connection = useConnection(host.id);
  const connected = connection?.status === "connected";
  const keys = useKeys(host.id, connected);
  const [answer, setAnswer] = useState<Omit<HostHistory, "keys"> | RpcError>();
  useEffect(() => {
    if (!connected) return;
    let stopped = false;
    void window.wisp.request(host.id, "usage/history", { since }).then((a) => {
      if (!stopped) setAnswer("result" in a ? a.result : a.error);
    });
    return () => {
      stopped = true;
    };
  }, [host.id, connected, since]);
  const history = connected && answer && "hours" in answer ? answer : undefined;
  useEffect(
    () => onLoad(host.id, history && { ...history, keys }),
    [host.id, history, keys, onLoad],
  );

  const note =
    hostStatus(connection) ??
    (!answer ? "Loading…" : "hours" in answer ? undefined : usageError(answer));
  if (!note) return null;
  return (
    <p className="mb-6 text-[13px] text-muted-foreground">
      {named && `${host.name}: `}
      {note}
    </p>
  );
}

/** A line chart per series over the buckets, on a nice axis, with a few dates under it. */
function Chart({
  title,
  series,
  labels,
  format,
}: {
  title: string;
  series: { color: string; values: number[] }[];
  labels: string[];
  format: (n: number) => string;
}) {
  const top = niceTop(Math.max(0, ...series.flatMap((s) => s.values)));
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((f) => f * top);
  const last = labels.length - 1;
  const x = (i: number) => (i / last) * 100;
  const y = (v: number) => 100 - (v / top) * 100;
  return (
    <figure className="min-w-0">
      <figcaption className="mb-4 text-[15px] font-medium">{title}</figcaption>
      <div className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3">
        <div className="relative h-56 text-right text-[11px] text-faint-foreground tabular-nums">
          {/* Sizes the column to the widest label; the real ones sit on their lines. */}
          <span className="invisible">{format(top)}</span>
          {ticks.map((t) => (
            <span key={t} className="absolute right-0 -translate-y-1/2" style={{ top: `${y(t)}%` }}>
              {format(t)}
            </span>
          ))}
        </div>
        <div className="relative h-56">
          {ticks.map((t) => (
            <div
              key={t}
              className="absolute inset-x-0 border-t border-border"
              style={{ top: `${y(t)}%` }}
            />
          ))}
          <svg
            viewBox="0 0 100 100"
            preserveAspectRatio="none"
            role="img"
            aria-label={title}
            className="absolute inset-0 size-full overflow-visible"
          >
            {series.map((s, k) => {
              const line = s.values.map((v, i) => `${x(i)},${y(v)}`).join(" L");
              return (
                <g key={k}>
                  <path d={`M0,100 L${line} L100,100 Z`} style={{ fill: s.color }} opacity={0.12} />
                  <path
                    d={`M${line}`}
                    fill="none"
                    style={{ stroke: s.color }}
                    strokeWidth={1.5}
                    strokeLinejoin="round"
                    vectorEffect="non-scaling-stroke"
                  />
                </g>
              );
            })}
          </svg>
        </div>
        <div />
        <div className="mt-2 flex justify-between text-[11px] tracking-wide text-faint-foreground uppercase">
          <span>{labels[0]}</span>
          <span>{labels[Math.floor(last / 2)]}</span>
          <span>{labels[last]}</span>
        </div>
      </div>
    </figure>
  );
}

type Breakdown = "model" | "time";

/** The range's usage by model (largest first) or by day or hour (latest first), as a table. */
function Breakdown({
  hourly,
  whole,
  measure,
  shown,
  models,
  times,
  cost,
}: {
  hourly: boolean;
  whole: number;
  measure: (m: Measures) => number;
  shown: (m: Measures) => string;
  models: Summary["models"];
  times: { name: string; total: Measures }[];
  /** Whether the view measures cost; the last column is then tokens, and cost otherwise. */
  cost: boolean;
}) {
  const [by, setBy] = useState<Breakdown>("model");
  const unit = hourly ? "Hour" : "Day";
  const rows =
    by === "model"
      ? [...models]
          .sort(
            (a, b) => measure(b.total) - measure(a.total) || tokensOf(b.total) - tokensOf(a.total),
          )
          .map((m) => {
            const Logo = m.backend && backends[m.backend].Logo;
            return {
              key: `${m.backend}/${m.model}`,
              name: (
                <>
                  {Logo && <Logo className="size-4 shrink-0" />}
                  {m.model}
                </>
              ),
              total: m.total,
            };
          })
      : times.map((t) => ({ key: t.name, name: t.name, total: t.total }));
  const cell = "py-3 text-right tabular-nums";
  return (
    <>
      <div className="mt-12 mb-2 flex items-center justify-between">
        <h2 className="text-[15px] font-medium">Breakdown</h2>
        <Segmented
          label="Breakdown by"
          options={[
            { value: "model", name: "Model" },
            { value: "time", name: unit },
          ]}
          value={by}
          onChange={setBy}
        />
      </div>
      <table className="w-full text-[13.5px]">
        <thead className="text-[12.5px] text-muted-foreground">
          <tr className="border-b border-border">
            <th className="py-3 text-left font-normal">{by === "model" ? "Model" : unit}</th>
            <th className="py-3 text-right font-normal">{cost ? "Cost" : "Tokens"}</th>
            <th className="py-3 text-right font-normal">Share</th>
            <th className="py-3 text-right font-normal">{cost ? "Tokens" : "Cost"}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.key} className="border-b border-border last:border-0">
              <td className="py-3">
                <span className="flex items-center gap-2.5">{r.name}</span>
              </td>
              <td className={cell}>{shown(r.total)}</td>
              <td className={`${cell} text-muted-foreground`}>
                {percent(measure(r.total), whole)}
              </td>
              <td className={cell}>
                {cost
                  ? tokenCount.format(tokensOf(r.total))
                  : r.total.cost > 0
                    ? dollars(r.total.cost)
                    : "—"}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}

/** One host's accounts' limit windows, under the host's name when there are several. */
function HostLimits({ host, named }: { host: Host; named: boolean }) {
  const connection = useConnection(host.id);
  const connected = connection?.status === "connected";
  const { usage, error } = useUsage(host.id, connected);
  const keys = useKeys(host.id, connected);

  // A host that isn't connected shows its status, not its last answer, whose resets are stale.
  let note = hostStatus(connection);
  if (!note && !usage) note = error ? usageError(error) : "Loading…";
  else if (!note && usage?.size === 0) note = "No usage yet. It shows here once an agent runs.";

  const accounts = [...((!note && usage?.values()) || [])].map((a) => {
    const key = keys.find((k) => k.id === a.accountId);
    const backend = backendOf(a.accountId, keys);
    const info = backend && backends[backend];
    return { usage: a, name: key?.label ?? info?.name ?? a.accountId, info };
  });
  accounts.sort((a, b) => a.name.localeCompare(b.name));

  return (
    <section aria-label={host.name} className="mb-10">
      {named && <h2 className="mb-4 text-[13px] font-medium text-muted-foreground">{host.name}</h2>}
      {note && <p className="text-[13px] text-muted-foreground">{note}</p>}
      {accounts.map(({ usage: a, name, info }) => (
        <section key={a.accountId} aria-label={name} className="mb-8">
          <h3 className="mb-3 flex items-center gap-2.5 text-[15px] font-medium">
            {info && <info.Logo className="size-5" />}
            {name}
          </h3>
          {a.limits.length === 0 ? (
            <p className="text-[13px] text-muted-foreground">
              No limits reported for this account.
            </p>
          ) : (
            <div className="flex flex-col gap-3">
              {a.limits.map((limit) => (
                <LimitCard
                  key={limit.window}
                  limit={limit}
                  account={name}
                  fill={info?.fill ?? "bg-muted-foreground/35"}
                />
              ))}
            </div>
          )}
        </section>
      ))}
    </section>
  );
}

/**
 * One limit window: how much is left in large type and what comes back when, then a bar of
 * what's left over a hatched track of what's used.
 */
function LimitCard({
  limit,
  account,
  fill,
}: {
  limit: UsageLimitWindow;
  account: string;
  fill: string;
}) {
  const { name, left, line, badge } = limitCard(limit, Date.now());
  return (
    <div
      title={limitDetails(limit)}
      className="flex items-center gap-8 rounded-xl border border-border bg-surface px-5 py-4"
    >
      <div className="w-40 shrink-0">
        <span className="block text-[13px] font-medium">{name}</span>
        {left !== undefined && (
          <span
            className={`mt-1 block text-[32px] leading-tight font-semibold tabular-nums ${left === 0 ? "text-danger" : ""}`}
          >
            {left}%
            <span className="ml-1.5 text-[14px] font-normal text-muted-foreground">left</span>
          </span>
        )}
        <span className="mt-1 flex items-center gap-1.5 text-[12.5px] text-muted-foreground [&_svg]:size-3.5">
          <RotateCw aria-hidden />
          {line}
        </span>
      </div>
      {/* The hatch is the used part; the fill, from the left, what's left. */}
      <div
        aria-hidden
        className="relative h-11 min-w-0 flex-1 overflow-hidden rounded-lg bg-[repeating-linear-gradient(135deg,var(--selected)_0_1.5px,transparent_1.5px_7px)]"
      >
        {/* Over the surface, so the hatch doesn't show through the translucent fill. */}
        <div className="h-full rounded-lg bg-surface" style={{ width: `${left ?? 0}%` }}>
          <div className={`size-full rounded-lg ${fill}`} />
        </div>
        <span className="absolute inset-y-0 left-3 flex items-center text-[13px] font-medium">
          {account}
          {left !== undefined && <span className="ml-2 tabular-nums">{left}%</span>}
        </span>
        {badge && (
          <span className="absolute inset-y-0 right-2 flex items-center">
            <span className="flex items-center gap-1 rounded-md bg-background/85 px-2 py-0.5 text-[12px] [&_svg]:size-3">
              <RotateCw />
              {badge}
            </span>
          </span>
        )}
      </div>
    </div>
  );
}
