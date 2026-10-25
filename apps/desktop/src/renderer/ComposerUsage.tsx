import { useEffect, useId, useRef, useState } from "react";

import type { RequestUsage, ThreadUsage } from "./transcript";

/** Missing, zero-denominator, and inconsistent token counts remain unknown. */
export function tokenPercent(numerator?: number, denominator?: number): string | undefined {
  if (
    numerator === undefined ||
    denominator === undefined ||
    !Number.isSafeInteger(numerator) ||
    !Number.isSafeInteger(denominator) ||
    numerator < 0 ||
    denominator <= 0 ||
    numerator > denominator
  )
    return undefined;
  const percent = (numerator / denominator) * 100;
  return percent > 0 && percent < 1 ? "<1%" : `${Math.floor(percent)}%`;
}

/** An approximate output rate, or unknown when either side is missing or invalid. */
export function tokensPerSecond(tokens?: number, ms?: number): number | undefined {
  if (
    tokens === undefined ||
    ms === undefined ||
    !Number.isSafeInteger(tokens) ||
    !Number.isSafeInteger(ms) ||
    tokens <= 0 ||
    ms <= 0
  )
    return undefined;
  return Math.round((tokens / ms) * 1000);
}

/** What each provider's sample measures, since neither is pure generation time. */
const speedSource: Record<string, string> = {
  claude:
    "the time Claude's responses streamed in the last turn, from each one's first token, which leaves out the wait for it and subagents' output (or the turn's API time, when it didn't stream)",
  opencode:
    "the time OpenCode spent streaming text and reasoning in the last model request without tool calls, which leaves out the wait for the first token",
};

/** How full a meter is: amber from 75%, red from 90%, as on the Usage page. */
const tone = (used: number) => (used >= 90 ? "danger" : used >= 75 ? "warning" : "normal");
const fill = { normal: "bg-muted-foreground", warning: "bg-warning", danger: "bg-danger" };

/** The thread's own token and cost totals, as the card writes them. */
interface Totals {
  input: string;
  output: string;
  /** What the tokens come to, its input split by cache. */
  title: string;
  cost?: string;
  costTitle: string;
  /** Earlier turns aren't loaded, so the totals are at least these. */
  partial: boolean;
}

/** What the composer's ring shows about the open thread: its context and its usage so far. */
interface ComposerUsageData {
  context?: string;
  /** Context use, 0 to 100, for the ring. */
  contextUsed?: number;
  contextDetail?: string;
  contextTitle: string;
  cache?: string;
  cacheTitle: string;
  speed?: number;
  speedTitle: string;
  totals?: Totals;
  /** What the ring shows. Absent while there is nothing to say. */
  summary?: Summary;
}

/** How the ring reads. */
interface Summary {
  /** How full the ring is, 0 to 100. */
  used: number;
  /** What the ring says to a screen reader and in its tooltip. */
  label: string;
  tone: "normal" | "warning" | "danger";
}

const compact = (n: number) =>
  new Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 1 }).format(n);

const dollars = (micros: number) =>
  new Intl.NumberFormat(undefined, {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: micros < 10_000 ? 4 : 2,
  }).format(micros / 1_000_000);

/**
 * The open thread's usage for the ring: its latest request's context, cache, and speed, while
 * they're for the provider and account the next message goes to, and its token and cost totals.
 * Nothing without a provider.
 */
export function threadUsageOf({
  connected,
  backend,
  kind,
  accountId,
  usage,
  totals,
}: {
  connected: boolean;
  backend?: string;
  kind?: string;
  accountId?: string;
  usage?: RequestUsage;
  totals?: ThreadUsage;
}): ComposerUsageData | undefined {
  if (!backend || !accountId) return undefined;
  const measured =
    connected && usage?.backend === backend && usage.accountId === accountId
      ? usage.usage
      : undefined;
  const reportedAt = measured && usage ? ` Reported ${new Date(usage.at).toLocaleString()}.` : "";
  const context = tokenPercent(measured?.contextTokens, measured?.contextWindow);
  const contextUsed =
    context === undefined ? undefined : (measured!.contextTokens! / measured!.contextWindow!) * 100;
  const cache = tokenPercent(measured?.cachedInputTokens, measured?.inputTokens);
  const timed = !!kind && !!speedSource[kind];
  const speed = timed ? tokensPerSecond(measured?.outputTokens, measured?.outputMs) : undefined;

  const input = totals && totals.inputTokens + totals.cacheReadTokens + totals.cacheWriteTokens;
  const shownTotals: Totals | undefined =
    totals && (input || totals.outputTokens)
      ? {
          input: compact(input!),
          output: compact(totals.outputTokens),
          title: `Every request this thread made, its subagents' included: ${totals.inputTokens.toLocaleString()} new input, ${totals.cacheReadTokens.toLocaleString()} read from cache, ${totals.cacheWriteTokens.toLocaleString()} written to cache, and ${totals.outputTokens.toLocaleString()} output tokens.${totals.fromStart ? "" : " Earlier turns aren't loaded, so these are lower bounds."}`,
          cost: totals.costUsdMicros === undefined ? undefined : dollars(totals.costUsdMicros),
          costTitle: `What the provider reports these tokens cost at API prices. A subscription isn't billed per token.${totals.fromStart ? "" : " Earlier turns aren't loaded, so this is a lower bound."}`,
          partial: !totals.fromStart,
        }
      : undefined;

  let summary: Summary | undefined;
  if (context !== undefined)
    summary = { used: contextUsed!, tone: tone(contextUsed!), label: `${context} of context used` };
  else if (shownTotals)
    summary = {
      used: 0,
      tone: "normal",
      label: `${shownTotals.input} in, ${shownTotals.output} out this thread`,
    };

  return {
    context,
    contextUsed,
    contextDetail:
      context === undefined
        ? undefined
        : `${compact(measured!.contextTokens!)} / ${compact(measured!.contextWindow!)}`,
    contextTitle: context
      ? `${kind === "claude" ? "Latest request input" : kind === "codex" ? "Latest request tokens" : "Reported context tokens"} / provider-reported context window (${measured?.contextTokens?.toLocaleString()} / ${measured?.contextWindow?.toLocaleString()}).${reportedAt}`
      : "Context utilization unavailable until this provider reports context tokens and its window.",
    cache,
    cacheTitle: cache
      ? `Latest request input served from cache (${measured?.cachedInputTokens?.toLocaleString()} / ${measured?.inputTokens?.toLocaleString()} input tokens).${reportedAt}`
      : "Cache utilization unavailable until this provider reports request input and cached input tokens.",
    speed,
    speedTitle:
      speed !== undefined && kind
        ? `Output speed: ${measured?.outputTokens?.toLocaleString()} output tokens over ${speedSource[kind]} (${((measured?.outputMs ?? 0) / 1000).toFixed(1)} s).${reportedAt}`
        : timed
          ? "Output speed unavailable until this provider reports output tokens and their timing."
          : "Output speed unavailable. This provider does not report model timing, and turn wall-clock time would include tool runs.",
    totals: shownTotals,
    summary,
  };
}

const speedText = (speed: number) => `~${speed.toLocaleString()} tok/s`;

const ringTone = {
  normal: "text-muted-foreground",
  warning: "text-warning",
  danger: "text-danger",
};

/**
 * A ring and its percent by the attach button, filled to the open thread's context, amber from
 * 75% and red from 90%. The percent beside it keeps the partial ring from reading as a loading
 * spinner; with no context reported yet, there's only the empty ring. Hovering or focusing it
 * peeks at a card with the context, then the latest request's speed and cache hit, then the
 * thread's tokens and cost; a click keeps the card open. Each row's tooltip says what it measures.
 * Nothing shows until there is something to say.
 */
export function UsageRing({ data }: { data: ComposerUsageData }) {
  const [peek, setPeek] = useState(false);
  const [kept, setKept] = useState(false);
  const open = peek || kept;
  const closing = useRef<ReturnType<typeof setTimeout>>(undefined);
  const card = useId();
  const show = () => {
    clearTimeout(closing.current);
    setPeek(true);
  };
  // A short delay lets the pointer cross from the item to the card.
  const hide = () => {
    clearTimeout(closing.current);
    closing.current = setTimeout(() => setPeek(false), 150);
  };
  const close = () => {
    clearTimeout(closing.current);
    setPeek(false);
    setKept(false);
  };
  useEffect(() => () => clearTimeout(closing.current), []);
  const { summary, totals } = data;
  if (!summary) return null;
  const more = totals?.partial ? "+" : "";
  // The card's groups under the context, each a list of rows apart from the last.
  const groups = [
    [
      data.speed !== undefined && {
        label: "Output speed",
        title: data.speedTitle,
        value: speedText(data.speed),
      },
      data.cache && { label: "Cache hit", title: data.cacheTitle, value: data.cache },
    ],
    [
      totals && {
        label: "Tokens",
        title: totals.title,
        value: `${totals.input}${more} in · ${totals.output}${more} out`,
      },
      totals?.cost && {
        label: "API cost",
        title: totals.costTitle,
        value: `${totals.cost}${more}`,
      },
    ],
  ]
    .map((rows) =>
      rows.filter((row): row is { label: string; title: string; value: string } => !!row),
    )
    .filter((rows) => rows.length > 0);
  return (
    <div
      className="relative ml-auto"
      onMouseEnter={show}
      onMouseLeave={hide}
      onFocus={show}
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) close();
      }}
      onKeyDown={(e) => {
        if (e.key === "Escape" && open) {
          e.stopPropagation();
          close();
        }
      }}
    >
      <button
        type="button"
        aria-label={`Usage: ${summary.label}`}
        aria-expanded={open}
        aria-controls={card}
        title={open ? undefined : summary.label}
        onClick={() => (kept ? close() : setKept(true))}
        className={`flex h-7 items-center gap-1.5 rounded-full px-2 text-meta tabular-nums hover:bg-hover ${open ? "bg-hover" : ""} ${ringTone[summary.tone]}`}
      >
        <svg aria-hidden viewBox="0 0 20 20" className="size-3.5 -rotate-90">
          <circle
            cx="10"
            cy="10"
            r="7.5"
            fill="none"
            strokeWidth="3"
            className="stroke-faint-foreground/30"
          />
          {summary.used > 0 && (
            <circle
              cx="10"
              cy="10"
              r="7.5"
              fill="none"
              stroke="currentColor"
              strokeWidth="3"
              pathLength={100}
              strokeDasharray={`${Math.max(summary.used, 3)} 100`}
            />
          )}
        </svg>
        {data.context !== undefined && <span aria-hidden>{data.context}</span>}
      </button>
      <div
        id={card}
        role="group"
        aria-label="Usage"
        hidden={!open}
        className="absolute right-0 bottom-full z-20 mb-2 w-72 rounded-xl border border-border bg-surface p-3.5 text-body text-foreground shadow-composer tabular-nums"
      >
        {data.context !== undefined && (
          <div title={data.contextTitle}>
            <div className="flex justify-between gap-3">
              <span className="text-muted-foreground">Context</span>
              <span>
                {data.contextDetail} · {data.context}
              </span>
            </div>
            <span aria-hidden className="mt-2 block h-1 overflow-hidden rounded-full bg-selected">
              <span
                className={`block h-full rounded-full ${fill[tone(data.contextUsed!)]}`}
                style={{ width: `${data.contextUsed}%` }}
              />
            </span>
          </div>
        )}
        {groups.map((rows, i) => (
          <div
            key={i}
            className={
              i > 0 || data.context !== undefined
                ? "mt-3 space-y-1.5 border-t border-border pt-2.5"
                : "space-y-1.5"
            }
          >
            {rows.map((row) => (
              <div key={row.label} title={row.title} className="flex justify-between gap-3">
                <span className="text-muted-foreground">{row.label}</span>
                <span>{row.value}</span>
              </div>
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}
