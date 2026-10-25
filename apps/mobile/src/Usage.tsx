// Usage, a sheet over Settings, as the desktop's usage page (UsagePage.tsx) has it, for a phone.
// Cost and Tokens sum every connected computer's `usage/daily` over a range: the totals, the
// tokens by kind, a bar chart a tap reads out, a card per provider, and a breakdown by model or
// day. Limits shows each subscription's windows once, from `usage/limits`. The header's refresh
// button, or a pull, asks every computer again.
import { useIsFocused, useNavigation } from "@react-navigation/native";
import * as Haptics from "expo-haptics";
import { RefreshCw, RotateCw } from "lucide-react-native";
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { ActivityIndicator, Pressable, RefreshControl, ScrollView, StyleSheet, View } from "react-native";
import Svg, { Line, Path } from "react-native-svg";

import type { ConnectionState } from "../../desktop/src/preload/bridge";
import type { UsageLimitWindow } from "../../desktop/src/protocol/generated/protocol";
import { dayKey } from "../../desktop/src/renderer/profile";
import {
  attribute,
  buckets,
  dollars,
  limitMeter,
  niceTop,
  percent,
  plural,
  rangeWords,
  ranges,
  stack,
  summarize,
  tokenCount,
  tokensOf,
  wholeUsd,
  type Backend,
  type LimitTone,
  type Measures,
  type Part,
  type Range,
} from "../../desktop/src/renderer/usageStats";
import { useFleet, type Computer } from "./fleet";
import { GlassButton } from "./Glass";
import { ProviderLogo } from "./logos";
import type { Colors } from "./theme";
import { DeviceIcon, Icon, T, useColors } from "./ui";
import {
  accountsOf,
  backendNames,
  gather,
  mergeAccounts,
  usageError,
  type Account,
  type Daily,
} from "./usageData";

type Choice = "cost" | "tokens" | "limits";
const views: { value: Choice; name: string }[] = [
  { value: "cost", name: "Cost" },
  { value: "tokens", name: "Tokens" },
  { value: "limits", name: "Limits" },
];

/** How often Limits asks each computer's CLIs for their windows again, as the desktop does. */
const LIMITS_POLL_MS = 60_000;

/** A computer that isn't answering: its status, as the desktop words it, or undefined once connected. */
function statusOf(state: ConnectionState): string | undefined {
  if (state.status === "connected") return undefined;
  if (state.status === "connecting") return "Connecting…";
  return state.retrying ? "Reconnecting…" : "Disconnected";
}

/** One computer's part of Limits: its accounts once it answers, or why it has none. */
type LimitsAnswer = { accounts: Account[] } | { problem: string };

const timeZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone;

export function UsageScreen() {
  const c = useColors();
  const navigation = useNavigation();
  const { computers } = useFleet();
  const focused = useIsFocused();
  const [view, setView] = useState<Choice>("cost");
  const [range, setRange] = useState<Range>("30d");
  // When the range was last chosen or refreshed: what the buckets end at.
  const [now, setNow] = useState(Date.now);
  const [refreshing, setRefreshing] = useState<"pull" | "button">();
  // Each computer's `usage/daily`, by its id and the first day asked for, so a late answer for
  // a range left behind never takes another's place.
  const [daily, setDaily] = useState<Record<string, Daily>>({});
  const [limits, setLimits] = useState<Record<string, LimitsAnswer>>({});

  const connected = computers.filter((m) => m.connected);
  const connectedKey = connected.map((m) => m.machine.id).join();
  const span = buckets(range, now);
  // One request covers the range and the one before it.
  const since = dayKey(span.previous[0]!);

  const loadDaily = useCallback(
    (list: Computer[], from: string) =>
      Promise.all(
        list.map(async (m) => {
          const id = m.machine.id;
          const answer = await window.parallax.request(id, "usage/daily", { since: from, timeZone: timeZone() });
          const value = "result" in answer ? answer.result : { problem: usageError(answer.error) };
          setDaily((all) => ({ ...all, [`${id} ${from}`]: value }));
        }),
      ),
    [],
  );

  const loadLimits = useCallback(
    (list: Computer[]) =>
      Promise.all(
        list.map(async (m) => {
          const id = m.machine.id;
          const [answer, keys, providers] = await Promise.all([
            window.parallax.request(id, "usage/limits", {}),
            window.parallax.request(id, "accounts/keys/list", {}),
            m.state.status === "connected" && "providers" in m.state.capabilities
              ? window.parallax.request(id, "providers/list", { refresh: false })
              : undefined,
          ]);
          const enabled =
            providers && "result" in providers
              ? providers.result.providers.filter((p) => p.instance.enabled).map((p) => p.instance.id)
              : undefined;
          setLimits((all) => {
            // A later failure keeps the last answer.
            if ("error" in answer)
              return all[id] && "accounts" in all[id] ? all : { ...all, [id]: { problem: usageError(answer.error) } };
            const accounts = accountsOf(answer.result.accounts, "result" in keys ? keys.result.accounts : [], enabled);
            return { ...all, [id]: { accounts } };
          });
        }),
      ),
    [],
  );

  useEffect(() => {
    if (focused) void loadDaily(connected, since);
  }, [focused, connectedKey, since]);

  useEffect(() => {
    if (!focused || view !== "limits") return;
    void loadLimits(connected);
    const timer = setInterval(() => void loadLimits(connected), LIMITS_POLL_MS);
    return () => clearInterval(timer);
  }, [focused, view, connectedKey]);

  /** Asks every computer again, from a pull or the header's button, which spins meanwhile. */
  const refresh = async (from: "pull" | "button") => {
    setRefreshing(from);
    // A computer that stopped trying connects again.
    for (const m of computers)
      if (m.state.status === "failed" && !m.state.retrying) void window.parallax.retry(m.machine.id);
    const at = Date.now();
    setNow(at);
    await (view === "limits"
      ? loadLimits(connected)
      : loadDaily(connected, dayKey(buckets(range, at).previous[0]!)));
    setRefreshing(undefined);
  };
  const latest = useRef(refresh);
  latest.current = refresh;

  useLayoutEffect(
    () =>
      navigation.setOptions({
        headerRight: () => (
          <GlassButton label="Refresh usage" onPress={() => void latest.current("button")}>
            {refreshing === "button" ? (
              <ActivityIndicator color={c.foreground} />
            ) : (
              <Icon icon={RefreshCw} size={19} />
            )}
          </GlassButton>
        ),
      }),
    [navigation, refreshing === "button", c],
  );

  return (
    <ScrollView
      style={{ backgroundColor: c.background }}
      contentInsetAdjustmentBehavior="automatic"
      contentContainerStyle={{ paddingTop: 8, paddingBottom: 60 }}
      refreshControl={<RefreshControl refreshing={refreshing === "pull"} onRefresh={() => void refresh("pull")} />}
    >
      <View style={styles.controls}>
        <Segmented label="Usage view" options={views} value={view} onChange={setView} />
        {view !== "limits" && (
          <Segmented
            label="Usage range"
            options={ranges}
            value={range}
            onChange={(next) => {
              setRange(next);
              setNow(Date.now());
            }}
          />
        )}
      </View>
      <View style={styles.page}>
        {computers.length === 0 ? (
          <Empty title="No computers">Pair a computer in Settings to see its usage here.</Empty>
        ) : view === "limits" ? (
          <Limits computers={computers} answers={limits} />
        ) : (
          <History computers={computers} daily={daily} since={since} range={range} span={span} view={view} />
        )}
      </View>
    </ScrollView>
  );
}

/** A row of choices, one chosen, as iOS's segmented control draws it. */
function Segmented<V extends string>({
  label,
  options,
  value,
  onChange,
}: {
  label: string;
  options: { value: V; name: string }[];
  value: V;
  onChange: (value: V) => void;
}) {
  const c = useColors();
  return (
    <View accessibilityRole="tablist" accessibilityLabel={label} style={[styles.segmented, { backgroundColor: c.selected }]}>
      {options.map((o) => {
        const chosen = o.value === value;
        return (
          <Pressable
            key={o.value}
            accessibilityRole="tab"
            accessibilityState={{ selected: chosen }}
            onPress={() => {
              if (chosen) return;
              void Haptics.selectionAsync();
              onChange(o.value);
            }}
            style={[styles.segment, chosen && [styles.chosen, { backgroundColor: c.surface, borderColor: c.border }]]}
          >
            <T medium={chosen} muted={!chosen} numberOfLines={1} style={{ fontSize: 13.5 }}>
              {o.name}
            </T>
          </Pressable>
        );
      })}
    </View>
  );
}

/** What Cost and Tokens draw: a range's buckets, and every computer's days in for them so far. */
interface Frame {
  range: Range;
  span: ReturnType<typeof buckets>;
  days: ReturnType<typeof gather>["days"];
  sessions: ReturnType<typeof gather>["sessions"];
}

/** Cost or Tokens over the range, summed across the computers, or why there's none. */
function History({
  computers,
  daily,
  since,
  range,
  span,
  view,
}: {
  computers: Computer[];
  daily: Record<string, Daily>;
  since: string;
  range: Range;
  span: ReturnType<typeof buckets>;
  view: "cost" | "tokens";
}) {
  const [by, setBy] = useState<BreakdownBy>("model");
  const answer = (id: string) => daily[`${id} ${since}`];
  const { days, sessions, answered } = gather(
    computers.filter((m) => m.connected).map((m) => m.machine.id),
    answer,
  );
  const waiting = computers.some((m) => m.connected && !answer(m.machine.id));
  // The last frame with usage, shown dimmed while another range loads, so nothing jumps.
  const held = useRef<Frame>(undefined);
  const frame: Frame | undefined = answered > 0 ? { range, span, days, sessions } : undefined;
  if (frame) held.current = frame;
  const shown = frame ?? (waiting ? held.current : undefined);
  if (shown) return <Dashboard frame={shown} stale={!frame} view={view} by={by} onBy={setBy} />;
  if (waiting) return <Empty title="Loading usage…" />;
  const problem = computers.map((m) => answer(m.machine.id)).find((a) => a && "problem" in a);
  return (
    <Empty title="No usage">
      {problem && "problem" in problem ? problem.problem : "None of your computers is connected."}
    </Empty>
  );
}

type BreakdownBy = "model" | "time";

/** A mix of two #rrggbb colors, `t` of `a` into `b`, as the desktop's `color-mix` makes its fills. */
function mix(a: string, t: number, b: string): string {
  const ch = (hex: string, i: number) => parseInt(hex.slice(1 + i * 2, 3 + i * 2), 16);
  return `#${[0, 1, 2]
    .map((i) => Math.round(ch(a, i) * t + ch(b, i) * (1 - t)).toString(16).padStart(2, "0"))
    .join("")}`;
}

/** The chart's fills for its parts, bottom up, as the desktop's index.css has them. */
const chartFills = (c: Colors) => [c.accent, mix(c.accent, 0.65, c.surface), mix(c.foreground, 0.2, c.surface)];

const dayName = (start: number, long: boolean, n: number) =>
  new Date(start).toLocaleString(
    "en",
    long ? { weekday: "short", month: "short", day: "numeric" } : n <= 7 ? { weekday: "short" } : { month: "short", day: "numeric" },
  );

/**
 * A range's usage, top to bottom: the total, sessions and the busiest model, the tokens by kind,
 * the chart, a card per provider, then a breakdown by model or by day. `stale` dims it while
 * another range loads.
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
  const c = useColors();
  const fills = chartFills(c);
  const { range, span } = frame;
  const { starts } = span;
  const today = range === "today";
  const words = rangeWords[range];
  const summary = summarize(frame.days, starts, span.previous, span.partial, frame.sessions);
  const [picked, setPicked] = useState<number>();
  const cost = view === "cost";
  const measure = (m: Measures) => (cost ? m.cost : tokensOf(m));
  const format = (n: number) => (cost ? dollars(n) : tokenCount.format(n));
  // A backend or model that used tokens but reported no cost has none to show, not $0.
  const unreported = (m: Measures) => cost && m.cost === 0 && m.unpriced > 0;
  const shown = (m: Measures) => (unreported(m) ? "—" : format(measure(m)));
  const other = (m: Measures) =>
    cost ? `${tokenCount.format(tokensOf(m))} tokens` : m.cost > 0 ? dollars(m.cost) : "no reported cost";
  const whole = measure(summary.total);
  const what = cost ? "cost" : "tokens";

  if (tokensOf(summary.total) === 0)
    return (
      <Empty title={`No usage ${words.past}`}>
        Claude Code, Codex, and Cursor usage on your computers shows here.
      </Empty>
    );

  const rows = attribute(summary.models, measure, unreported);
  const parts = stack(rows, measure);
  const lead = rows[0]?.share ? rows[0] : undefined;
  const sessions = summary.sessions;
  const processed = tokensOf(summary.total);

  let note = plural(summary.backends.length, "provider");
  if (!today) note += ` · ${plural(summary.byBucket.filter((m) => tokensOf(m) > 0).length, "active day")}`;
  if (cost && summary.total.unpriced > 0)
    note += ` · ${percent(summary.total.unpriced, processed)} of tokens have no reported cost`;
  const chartTitle = today
    ? `${cost ? "Cost" : "Processed tokens"} by model today`
    : `Daily ${cost ? "cost" : "processed tokens"}`;
  const none = (
    <T faint style={styles.big}>
      —
    </T>
  );

  return (
    <View accessibilityState={{ busy: stale }} style={[styles.stack, stale && { opacity: 0.45 }]}>
      <Card>
        <T muted style={styles.label}>
          {cost ? "Total cost" : "Processed tokens"}
        </T>
        {whole > 0 ? <T style={styles.hero}>{shown(summary.total)}</T> : none}
        <T muted style={styles.note}>
          {note}
        </T>
      </Card>

      <View style={styles.pair}>
        <Card style={{ flex: 1 }}>
          <T muted style={styles.label}>
            Sessions
          </T>
          {sessions ? <T style={styles.big}>{sessions.total.toLocaleString("en")}</T> : none}
          <T muted style={styles.note}>
            {sessions ? `${Math.round(sessions.previous).toLocaleString("en")} ${words.previous}` : "Not counted"}
          </T>
        </Card>
        <Card style={{ flex: 1 }}>
          <T muted style={styles.label}>
            Busiest model
          </T>
          {lead ? (
            <View style={styles.lead}>
              <ProviderLogo kind={lead.model.backend} size={16} />
              <T medium numberOfLines={1} style={{ flex: 1, fontSize: 16 }}>
                {lead.model.model}
              </T>
            </View>
          ) : (
            none
          )}
          <T muted style={styles.note}>
            {lead ? `${percent(measure(lead.model.total), whole)} of ${what} · ${shown(lead.model.total)}` : "No model reported a cost"}
          </T>
        </Card>
      </View>

      <Card padded={false}>
        <View style={styles.kinds}>
          {(
            [
              ["Processed tokens", processed],
              ["Cached input", summary.total.cacheRead],
              ["Uncached input", summary.total.input],
              ["Cache writes", summary.total.cacheWrite],
              ["Output", summary.total.output],
            ] as const
          ).map(([label, n], i) => (
            <View
              key={label}
              style={[
                styles.kind,
                { borderColor: c.border },
                i === 0 ? { width: "100%" } : { width: "50%" },
                i % 2 === 1 && { borderRightWidth: StyleSheet.hairlineWidth },
              ]}
            >
              <T muted numberOfLines={1} style={{ fontSize: 12 }}>
                {label}
              </T>
              <View style={styles.kindValue}>
                <T style={{ fontSize: 18, lineHeight: 22, fontWeight: "600", fontVariant: ["tabular-nums"] }}>
                  {tokenCount.format(n)}
                </T>
                <T faint numberOfLines={1} style={{ fontSize: 12, flexShrink: 1 }}>
                  {i === 0 ? "every kind" : percent(n, processed)}
                </T>
              </View>
            </View>
          ))}
        </View>
      </Card>

      <Card>
        <T medium>{chartTitle}</T>
        {whole === 0 ? (
          <Empty title="No vendor reported a cost in this range" plain>
            Tokens still count: see them under Tokens.
          </Empty>
        ) : today ? (
          // One day is one bar, so Today shows only how it splits.
          <Split parts={parts} whole={whole} format={format} fills={fills} />
        ) : (
          <>
            <Bars
              parts={parts}
              picked={picked}
              fills={fills}
              bars={starts.map((start, i) => ({
                key: start,
                axis: dayName(start, false, starts.length),
                name: dayName(start, true, starts.length),
                note: other(summary.byBucket[i]!),
              }))}
              format={format}
              tick={(n, step) => (cost && step >= 1_000_000 ? wholeUsd.format(n / 1_000_000) : format(n))}
            />
            {parts.length > 1 && (
              <Split parts={parts} whole={whole} format={format} fills={fills} picked={picked} onPick={setPicked} />
            )}
          </>
        )}
      </Card>

      <View style={{ gap: 10 }}>
        <T muted medium style={styles.heading}>
          Providers
        </T>
        {summary.backends.map(({ backend, total }) => {
          const share = unreported(total) || whole === 0 ? undefined : measure(total) / whole;
          return (
            <Card key={backend}>
              <View style={styles.lead}>
                <ProviderLogo kind={backend} size={16} />
                <T medium style={{ fontSize: 14 }}>
                  {backendNames[backend]}
                </T>
              </View>
              <T style={{ ...styles.big, marginTop: 10 }}>{shown(total)}</T>
              <Meter share={share} color={fills[0]!} />
              <T muted numberOfLines={1} style={styles.note}>
                {share === undefined ? "No reported cost" : `${percent(share, 1)} of ${what}`} · {other(total)}
              </T>
            </Card>
          );
        })}
      </View>

      <Breakdown
        by={today ? "model" : by}
        onBy={today ? undefined : onBy}
        what={cost ? "Cost" : "Tokens"}
        rows={
          today || by === "model"
            ? rows.map(({ model, share, part }) => ({
                key: `${model.backend}/${model.model}`,
                name: model.model,
                backend: model.backend,
                value: shown(model.total),
                share,
                fill: fills[part]!,
                other: unreported(model.total) ? `No reported cost · ${other(model.total)}` : other(model.total),
              }))
            : starts
                .map((start, i) => ({ start, total: summary.byBucket[i]! }))
                .filter((t) => tokensOf(t.total) > 0)
                .reverse()
                .map((t) => ({
                  key: String(t.start),
                  name: dayName(t.start, true, starts.length),
                  value: shown(t.total),
                  ...(!unreported(t.total) && whole > 0 && { share: measure(t.total) / whole }),
                  fill: fills[0]!,
                  other: other(t.total),
                }))
        }
      />
    </View>
  );
}

/** A rounded card on the page's surface. */
function Card({ children, style, padded = true }: { children: ReactNode; style?: object; padded?: boolean }) {
  const c = useColors();
  return (
    <View style={[styles.card, padded && styles.padded, { backgroundColor: c.surface, borderColor: c.border }, style]}>
      {children}
    </View>
  );
}

/** A slim bar filled to `share` (0 to 1), or empty when there's none. */
function Meter({ share, color }: { share?: number; color: string }) {
  const c = useColors();
  return (
    <View style={[styles.meter, { backgroundColor: c.selected }]}>
      {share !== undefined && (
        <View style={{ width: `${share * 100}%`, minWidth: 3, height: "100%", borderRadius: 2, backgroundColor: color }} />
      )}
    </View>
  );
}

const PLOT = 150;
/** The axis labels' column. */
const TICKS = 46;

/** A rectangle with its top corners rounded by `r`. */
const topRounded = (x: number, y: number, w: number, h: number, r: number) => {
  const k = Math.min(r, w / 2, h);
  return `M${x},${y + h}V${y + k}Q${x},${y} ${x + k},${y}H${x + w - k}Q${x + w},${y} ${x + w},${y + k}V${y + h}Z`;
};

/**
 * The chart: stacked bars over the buckets on a nice axis, a part per model from the bottom, a
 * dashed line at the daily average, and a few names under them. Touching a bar, or sliding along
 * them, shows its numbers above the plot and dims the others. A `picked` part stands out.
 */
function Bars({
  parts,
  picked,
  fills,
  bars,
  format,
  tick,
}: {
  parts: Part[];
  picked?: number;
  fills: string[];
  bars: { key: number; axis: string; name: string; note: string }[];
  format: (n: number) => string;
  tick: (n: number, step: number) => string;
}) {
  const c = useColors();
  const [width, setWidth] = useState(0);
  const [active, setActive] = useState<number>();
  const n = bars.length;
  const totals = bars.map((_, i) => parts.reduce((sum, p) => sum + p.values[i]!, 0));
  const top = niceTop(Math.max(0, ...totals));
  const ticks = [0, 0.5, 1].map((f) => f * top);
  const average = totals.reduce((a, b) => a + b, 0) / n;
  const slot = width / n;
  const barWidth = Math.min(slot * 0.62, 28);
  const radius = n > 45 ? 1.5 : n > 12 ? 3 : 6;
  const every = Math.ceil(n / 5);
  const y = (v: number) => PLOT - (v / top) * PLOT;
  const at = (x: number) => Math.max(0, Math.min(n - 1, Math.floor(x / slot)));
  const shown = active !== undefined ? bars[active] : undefined;

  return (
    <View>
      <View style={styles.readout}>
        {shown && active !== undefined ? (
          <>
            <View style={styles.readoutTop}>
              <T muted style={{ fontSize: 12 }}>
                {shown.name}
              </T>
              <T medium style={{ fontSize: 15, fontVariant: ["tabular-nums"] }}>
                {format(totals[active]!)}
              </T>
            </View>
            <T faint numberOfLines={1} style={{ fontSize: 12 }}>
              {parts.length > 1 && `${parts.map((p) => `${p.name} ${format(p.values[active]!)}`).join(" · ")} · `}
              {shown.note}
            </T>
          </>
        ) : (
          <T faint style={{ fontSize: 12 }}>
            Touch a bar to see its day.
          </T>
        )}
      </View>
      <View style={styles.chart}>
        <View style={{ width: TICKS, height: PLOT, justifyContent: "space-between" }}>
          {[...ticks].reverse().map((t) => (
            <T key={t} faint style={styles.tick}>
              {tick(t, top / 4)}
            </T>
          ))}
        </View>
        <View
          style={{ flex: 1, height: PLOT }}
          onLayout={(e) => setWidth(e.nativeEvent.layout.width)}
          onStartShouldSetResponder={() => true}
          onResponderGrant={(e) => {
            void Haptics.selectionAsync();
            setActive(at(e.nativeEvent.locationX));
          }}
          onResponderMove={(e) => {
            const i = at(e.nativeEvent.locationX);
            if (i !== active) {
              void Haptics.selectionAsync();
              setActive(i);
            }
          }}
          accessible
          accessibilityRole="image"
          accessibilityLabel={bars
            .map((b, i) => `${b.name}: ${format(totals[i]!)}`)
            .filter((_, i) => totals[i]! > 0)
            .join(", ")}
        >
          {width > 0 && (
            <Svg width={width} height={PLOT}>
              {ticks.map((t) => (
                <Line key={t} x1={0} x2={width} y1={y(t)} y2={y(t)} stroke={c.border} strokeWidth={1} />
              ))}
              {bars.map((b, i) => {
                const total = totals[i]!;
                if (total <= 0) return null;
                const x = i * slot + (slot - barWidth) / 2;
                const dim = active !== undefined && active !== i ? 0.4 : 1;
                const last = parts.findLastIndex((p) => p.values[i]! > 0);
                let below = 0;
                return parts.map((p, k) => {
                  const v = p.values[i]!;
                  if (v <= 0) return null;
                  const h = Math.max(1, (v / top) * PLOT - (k === last ? 0 : 1.5));
                  const yTop = y(below + v);
                  below += v;
                  const faded = picked !== undefined && picked !== p.part ? 0.25 : 1;
                  return (
                    <Path
                      key={`${b.key}-${k}`}
                      d={topRounded(x, yTop, barWidth, h, k === last ? radius : 1)}
                      fill={fills[p.part]}
                      opacity={dim * faded}
                    />
                  );
                });
              })}
              {average > 0 && (
                <Line
                  x1={0}
                  x2={width}
                  y1={y(average)}
                  y2={y(average)}
                  stroke={c.foreground}
                  strokeOpacity={0.35}
                  strokeDasharray="4 4"
                  strokeWidth={1}
                />
              )}
            </Svg>
          )}
          {average > 0 && (
            <View style={[styles.average, { top: y(average) - 9, backgroundColor: c.surface, borderColor: c.border }]}>
              <T muted style={{ fontSize: 10.5, lineHeight: 14 }}>
                avg {format(average)}
              </T>
            </View>
          )}
        </View>
      </View>
      {/* Names under every few bars, counted back from the latest so it always has one. */}
      <View style={[styles.axis, { marginLeft: TICKS + 8 }]}>
        {width > 0 &&
          bars.map((b, i) => {
            if ((n - 1 - i) % every !== 0) return null;
            const center = (i + 0.5) * slot;
            return (
              <T
                key={b.key}
                faint
                numberOfLines={1}
                style={{ ...styles.axisName, ...(i === n - 1 ? { right: 0 } : { left: Math.max(0, center - 30) }) }}
              >
                {b.axis}
              </T>
            );
          })}
      </View>
    </View>
  );
}

/**
 * The chart's legend: the range split between its parts as a slim meter, each part named under
 * it. Tapping a part, with `onPick`, picks it out in the bars; tapping it again lets go.
 */
function Split({
  parts,
  whole,
  format,
  fills,
  picked,
  onPick,
}: {
  parts: Part[];
  whole: number;
  format: (n: number) => string;
  fills: string[];
  picked?: number;
  onPick?: (part?: number) => void;
}) {
  const c = useColors();
  const sums = parts.map((p) => p.values.reduce((a, b) => a + b, 0));
  const dim = (part: number) => (picked === undefined || picked === part ? 1 : 0.35);
  return (
    <View style={[styles.split, { borderTopColor: c.border }]}>
      <View style={styles.splitMeter}>
        {parts.map((p, k) => (
          <View
            key={p.part}
            style={{ flexGrow: sums[k]! / whole, flexBasis: 0, minWidth: 3, borderRadius: 3, backgroundColor: fills[p.part], opacity: dim(p.part) }}
          />
        ))}
      </View>
      <View style={{ gap: 8, marginTop: 12 }}>
        {parts.map((p, k) => (
          <Pressable
            key={p.part}
            disabled={!onPick}
            onPress={() => onPick?.(picked === p.part ? undefined : p.part)}
            style={[styles.legend, { opacity: dim(p.part) }]}
          >
            <View style={[styles.swatch, { backgroundColor: fills[p.part] }]} />
            {p.backend && <ProviderLogo kind={p.backend} size={13} />}
            <T muted numberOfLines={1} style={{ flex: 1, fontSize: 13 }}>
              {p.name}
            </T>
            <T medium style={{ fontSize: 13, fontVariant: ["tabular-nums"] }}>
              {format(sums[k]!)}
            </T>
            <T faint style={{ fontSize: 13, width: 48, textAlign: "right", fontVariant: ["tabular-nums"] }}>
              {percent(sums[k]!, whole)}
            </T>
          </Pressable>
        ))}
      </View>
    </View>
  );
}

/** How many breakdown rows show before Show more. */
const BREAKDOWN_ROWS = 5;

/**
 * The range's usage by model (largest first) or by day (latest first), each with a share bar,
 * the first `BREAKDOWN_ROWS` until Show more. Without `onBy`, only by model.
 */
function Breakdown({
  by,
  onBy,
  what,
  rows,
}: {
  by: BreakdownBy;
  onBy?: (by: BreakdownBy) => void;
  what: string;
  rows: {
    key: string;
    name: string;
    backend?: Backend;
    value: string;
    share?: number;
    fill: string;
    other: string;
  }[];
}) {
  const c = useColors();
  const [all, setAll] = useState(false);
  const hidden = rows.length - BREAKDOWN_ROWS;
  return (
    <Card>
      <View style={styles.breakdownTop}>
        <T medium style={{ flex: 1 }}>
          Breakdown
        </T>
        {onBy && (
          <View style={{ width: 150 }}>
            <Segmented
              label="Breakdown by"
              options={[
                { value: "model", name: "Model" },
                { value: "time", name: "Day" },
              ]}
              value={by}
              onChange={onBy}
            />
          </View>
        )}
      </View>
      <View style={[styles.breakdownHead, { borderColor: c.border }]}>
        <T faint style={{ flex: 1, fontSize: 12 }}>
          {by === "model" ? "Model" : "Day"}
        </T>
        <T faint style={{ fontSize: 12 }}>
          {what} · Share
        </T>
      </View>
      {(all ? rows : rows.slice(0, BREAKDOWN_ROWS)).map((r, i, shown) => (
        <View
          key={r.key}
          style={[styles.breakdownRow, i < shown.length - 1 && { borderBottomColor: c.border, borderBottomWidth: StyleSheet.hairlineWidth }]}
        >
          <View style={styles.lead}>
            {r.backend && <ProviderLogo kind={r.backend} size={14} />}
            <T numberOfLines={1} style={{ flex: 1, fontSize: 14 }}>
              {r.name}
            </T>
            <T medium style={{ fontSize: 14, fontVariant: ["tabular-nums"] }}>
              {r.value}
            </T>
          </View>
          <View style={[styles.lead, { marginTop: 2 }]}>
            <T faint numberOfLines={1} style={{ flex: 1, fontSize: 12 }}>
              {r.other}
            </T>
            <T muted style={{ fontSize: 12, fontVariant: ["tabular-nums"] }}>
              {r.share === undefined ? "—" : percent(r.share, 1)}
            </T>
          </View>
          <Meter share={r.share} color={r.fill} />
        </View>
      ))}
      {hidden > 0 && (
        <Pressable accessibilityRole="button" onPress={() => setAll(!all)} style={[styles.more, { borderTopColor: c.border }]}>
          <T muted medium style={{ fontSize: 13 }}>
            {all ? "Show less" : `Show ${hidden} more`}
          </T>
        </Pressable>
      )}
    </Card>
  );
}

/**
 * Every computer's subscriptions' limit windows, read live from their CLIs: a section per
 * provider set up in Settings, a card per window. Each provider shows once (`mergeAccounts`).
 */
function Limits({ computers, answers }: { computers: Computer[]; answers: Record<string, LimitsAnswer> }) {
  const c = useColors();
  // A computer that isn't connected gives its status, not its last answer, whose resets are stale.
  const own = computers.map((m) => ({ m, status: statusOf(m.state), answer: answers[m.machine.id] }));
  const accounts = mergeAccounts(
    own.flatMap(({ status, answer }) => (!status && answer && "accounts" in answer ? [answer.accounts] : [])),
  );
  const problems = own.flatMap(({ m, status, answer }) => {
    const problem = status ?? (answer && "problem" in answer ? answer.problem : undefined);
    return problem ? [{ m, problem }] : [];
  });
  const waiting = own.some(({ status, answer }) => !status && !answer);
  const answered = own.some(({ status, answer }) => !status && answer && "accounts" in answer);
  const now = Date.now();
  return (
    <View style={styles.stack}>
      {problems.map(({ m, problem }) => (
        <View key={m.machine.id} style={styles.lead}>
          <DeviceIcon name={m.machine.name} size={14} color={c.faintForeground} />
          <T muted style={{ flex: 1, fontSize: 13 }}>
            {computers.length > 1 && `${m.machine.name}: `}
            {problem}
          </T>
        </View>
      ))}
      {accounts.length > 0 ? (
        accounts.map(({ accountId, limits, problem, backend, name }) => (
          <View key={accountId} style={{ gap: 10 }}>
            <View style={[styles.lead, { paddingHorizontal: 4 }]}>
              <ProviderLogo kind={backend} size={17} />
              <T medium style={{ fontSize: 16 }}>
                {name}
              </T>
            </View>
            {limits.length === 0 ? (
              <Card>
                <T muted style={{ fontSize: 13 }}>
                  {problem ? `Couldn't read its limits: ${problem}` : "No limits for this login."}
                </T>
              </Card>
            ) : (
              limits.map((limit) => <LimitMeter key={limit.window} limit={limit} backend={backend} now={now} />)
            )}
          </View>
        ))
      ) : waiting ? (
        <Empty title="Loading…" />
      ) : answered ? (
        <Empty title="No subscriptions">
          Limits show here for Claude Code and Codex once they're set up in Settings &gt; Providers.
        </Empty>
      ) : null}
    </View>
  );
}

/** A meter's fill by tone, and Claude's own tint, mixed into the surface as the desktop's are. */
function meterFill(c: Colors, tone: LimitTone, backend?: Backend): string {
  if (tone === "warning") return mix(c.warning, 0.45, c.surface);
  if (tone === "danger") return mix(c.danger, 0.45, c.surface);
  return backend === "claude" ? mix("#D97757", 0.4, c.surface) : mix(c.foreground, 0.22, c.surface);
}

/**
 * One limit window as a card: its name and how much is left, then a bar filled to what's left,
 * with how long until it resets.
 */
function LimitMeter({ limit, backend, now }: { limit: UsageLimitWindow; backend?: Backend; now: number }) {
  const c = useColors();
  const { name, left, tone, resetsIn } = limitMeter(limit, now);
  return (
    <Card>
      <T medium numberOfLines={1} style={{ fontSize: 14 }}>
        {name}
      </T>
      <View style={[styles.readoutTop, { marginTop: 4 }]}>
        <T style={{ ...styles.hero, fontSize: 32, lineHeight: 38, ...(left === 0 && { color: c.danger }) }}>
          {left === undefined ? "—" : `${left}%`}
        </T>
        <T muted style={{ fontSize: 13 }}>
          {left === undefined ? "use not reported" : "left"}
        </T>
      </View>
      <View
        accessible={left !== undefined}
        accessibilityRole="progressbar"
        accessibilityLabel={name}
        accessibilityValue={left === undefined ? undefined : { min: 0, max: 100, now: left, text: `${left}% left` }}
        style={[styles.limitBar, { backgroundColor: c.selected }]}
      >
        {!!left && <View style={{ width: `${left}%`, height: "100%", borderRadius: 8, backgroundColor: meterFill(c, tone, backend) }} />}
        {left !== undefined && <T style={styles.limitLeft}>{left}%</T>}
        {resetsIn && (
          <View style={[styles.reset, { backgroundColor: c.background }]}>
            <Icon icon={RotateCw} size={11} />
            <T medium style={{ fontSize: 12, lineHeight: 15 }}>
              {resetsIn}
            </T>
          </View>
        )}
      </View>
    </Card>
  );
}

/** Seven quiet rounded bars, standing in for a chart when there's nothing. */
function GhostBars() {
  const c = useColors();
  return (
    <View style={styles.ghost}>
      {[34, 58, 42, 76, 50, 66, 28].map((h, i) => (
        <View key={i} style={{ width: 14, height: `${h}%`, borderRadius: 5, backgroundColor: c.selected }} />
      ))}
    </View>
  );
}

/** Nothing to show yet: a title and why, under ghost bars, on its own card unless `plain`. */
function Empty({ title, plain = false, children }: { title: string; plain?: boolean; children?: ReactNode }) {
  const body = (
    <View style={[styles.empty, plain && { paddingVertical: 20 }]}>
      <GhostBars />
      <T medium style={{ marginTop: 18, textAlign: "center" }}>
        {title}
      </T>
      {children && (
        <T muted style={{ marginTop: 4, fontSize: 13, lineHeight: 18, textAlign: "center" }}>
          {children}
        </T>
      )}
    </View>
  );
  return plain ? body : <Card>{body}</Card>;
}

const styles = StyleSheet.create({
  controls: { gap: 8, paddingHorizontal: 16, paddingBottom: 14 },
  page: { paddingHorizontal: 16 },
  stack: { gap: 12 },
  segmented: { flexDirection: "row", borderRadius: 9, padding: 2 },
  segment: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    paddingVertical: 6,
    borderRadius: 7,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: "transparent",
  },
  chosen: {
    shadowColor: "#000",
    shadowOpacity: 0.08,
    shadowRadius: 3,
    shadowOffset: { width: 0, height: 1 },
  },
  card: { borderRadius: 14, borderWidth: StyleSheet.hairlineWidth, overflow: "hidden" },
  padded: { paddingHorizontal: 16, paddingVertical: 14 },
  label: { fontSize: 12.5, lineHeight: 17 },
  hero: { fontSize: 38, lineHeight: 46, fontWeight: "600", letterSpacing: -0.5, fontVariant: ["tabular-nums"] },
  big: { fontSize: 26, lineHeight: 34, fontWeight: "600", letterSpacing: -0.3, fontVariant: ["tabular-nums"] },
  note: { fontSize: 12.5, lineHeight: 17, marginTop: 4 },
  pair: { flexDirection: "row", gap: 12 },
  lead: { flexDirection: "row", alignItems: "center", gap: 8 },
  kinds: { flexDirection: "row", flexWrap: "wrap" },
  kind: {
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderColor: "transparent",
  },
  kindValue: { flexDirection: "row", alignItems: "baseline", gap: 6, marginTop: 4 },
  heading: { fontSize: 13, paddingHorizontal: 4 },
  meter: { height: 4, borderRadius: 2, overflow: "hidden", marginTop: 8 },
  readout: { height: 40, justifyContent: "flex-end", marginTop: 8, marginBottom: 10 },
  readoutTop: { flexDirection: "row", alignItems: "baseline", gap: 8 },
  chart: { flexDirection: "row", gap: 8 },
  tick: { fontSize: 10.5, lineHeight: 12, textAlign: "right", fontVariant: ["tabular-nums"], marginVertical: -6 },
  average: {
    position: "absolute",
    right: 0,
    paddingHorizontal: 5,
    borderRadius: 6,
    borderWidth: StyleSheet.hairlineWidth,
  },
  axis: { height: 16, marginTop: 8 },
  axisName: { position: "absolute", fontSize: 10.5, lineHeight: 14, width: 60, textAlign: "center" },
  split: { marginTop: 14, paddingTop: 14, borderTopWidth: StyleSheet.hairlineWidth },
  splitMeter: { flexDirection: "row", height: 6, gap: 2 },
  legend: { flexDirection: "row", alignItems: "center", gap: 8 },
  swatch: { width: 10, height: 10, borderRadius: 3 },
  breakdownTop: { flexDirection: "row", alignItems: "center", gap: 12, paddingBottom: 10 },
  breakdownHead: { flexDirection: "row", paddingTop: 10, paddingBottom: 4, borderTopWidth: StyleSheet.hairlineWidth },
  breakdownRow: { paddingVertical: 10 },
  more: { alignItems: "center", paddingTop: 12, marginTop: 2, borderTopWidth: StyleSheet.hairlineWidth },
  limitBar: { height: 36, borderRadius: 8, overflow: "hidden", marginTop: 12, justifyContent: "center" },
  limitLeft: { position: "absolute", left: 12, fontSize: 12.5, fontWeight: "600" },
  reset: {
    position: "absolute",
    right: 6,
    top: 6,
    bottom: 6,
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    paddingHorizontal: 8,
    borderRadius: 6,
  },
  ghost: { flexDirection: "row", alignItems: "flex-end", justifyContent: "center", gap: 8, height: 64 },
  empty: { alignItems: "center", paddingVertical: 28, paddingHorizontal: 12 },
});
