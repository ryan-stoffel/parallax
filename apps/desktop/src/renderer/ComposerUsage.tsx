import { t } from "i18next";
import { Minimize2 } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";

import { msg } from "../i18n";
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

/** What each provider's sample measures, since neither is pure generation time, in English for `t`. */
const speedSource: Record<string, string> = {
  claude: msg(
    "the time Claude's responses streamed in the last turn, from each one's first token, which leaves out the wait for it and subagents' output (or the turn's API time, when it didn't stream)",
  ),
  opencode: msg(
    "the time OpenCode spent streaming text and reasoning in the last model request without tool calls, which leaves out the wait for the first token",
  ),
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
export interface ComposerUsageData {
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

// T3 Code's numbers: a Claude thread this full is offered compaction once its prompt cache, an
// hour, has gone.
const compactFrom = 200_000;
const cacheGone = 70 * 60_000;

/**
 * The context tokens to compact before the next message, `now` ms since the epoch: a Claude
 * thread's latest request's, once they're at least 200k and its prompt cache has gone. Else
 * undefined. Any model counts, since another model doesn't share the cache either.
 */
export function staleContext(usage: RequestUsage | undefined, now: number) {
  const tokens = usage?.usage.contextTokens;
  return tokens !== undefined && tokens >= compactFrom && now - Date.parse(usage!.at) >= cacheGone
    ? tokens
    : undefined;
}

/** Tokens as T3 Code writes them beside its Compact button, such as `415k` or `1.2m`. */
export const tokensShort = (n: number) =>
  n >= 999_500 ? `${(n / 1_000_000).toFixed(1).replace(/\.0$/, "")}m` : `${Math.round(n / 1000)}k`;

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
  const reportedAt =
    measured && usage
      ? ` ${t("Reported {{at}}.", { at: new Date(usage.at).toLocaleString() })}`
      : "";
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
          title: `${t(
            "Every request this thread made, its subagents' included: {{input}} new input, {{cacheRead}} read from cache, {{cacheWrite}} written to cache, and {{output}} output tokens.",
            {
              input: totals.inputTokens.toLocaleString(),
              cacheRead: totals.cacheReadTokens.toLocaleString(),
              cacheWrite: totals.cacheWriteTokens.toLocaleString(),
              output: totals.outputTokens.toLocaleString(),
            },
          )}${totals.fromStart ? "" : ` ${t("Earlier turns aren't loaded, so these are lower bounds.")}`}`,
          cost: totals.costUsdMicros === undefined ? undefined : dollars(totals.costUsdMicros),
          costTitle: `${t("What the provider reports these tokens cost at API prices. A subscription isn't billed per token.")}${totals.fromStart ? "" : ` ${t("Earlier turns aren't loaded, so this is a lower bound.")}`}`,
          partial: !totals.fromStart,
        }
      : undefined;

  let summary: Summary | undefined;
  if (context !== undefined)
    summary = {
      used: contextUsed!,
      tone: tone(contextUsed!),
      label: t("{{percent}} of context used", { percent: context }),
    };
  else if (shownTotals)
    summary = {
      used: 0,
      tone: "normal",
      label: t("{{input}} in, {{output}} out this thread", {
        input: shownTotals.input,
        output: shownTotals.output,
      }),
    };

  return {
    context,
    contextUsed,
    contextDetail:
      context === undefined
        ? undefined
        : `${compact(measured!.contextTokens!)} / ${compact(measured!.contextWindow!)}`,
    contextTitle: context
      ? `${t("{{measure}} / provider-reported context window ({{tokens}} / {{window}}).", {
          measure:
            kind === "claude"
              ? t("Latest request input")
              : kind === "codex"
                ? t("Latest request tokens")
                : t("Reported context tokens"),
          tokens: measured?.contextTokens?.toLocaleString(),
          window: measured?.contextWindow?.toLocaleString(),
        })}${reportedAt}`
      : t(
          "Context utilization unavailable until this provider reports context tokens and its window.",
        ),
    cache,
    cacheTitle: cache
      ? `${t("Latest request input served from cache ({{cached}} / {{input}} input tokens).", {
          cached: measured?.cachedInputTokens?.toLocaleString(),
          input: measured?.inputTokens?.toLocaleString(),
        })}${reportedAt}`
      : t(
          "Cache utilization unavailable until this provider reports request input and cached input tokens.",
        ),
    speed,
    speedTitle:
      speed !== undefined && kind
        ? `${t("Output speed: {{tokens}} output tokens over {{source}} ({{seconds}} s).", {
            tokens: measured?.outputTokens?.toLocaleString(),
            source: t(speedSource[kind]!),
            seconds: ((measured?.outputMs ?? 0) / 1000).toFixed(1),
          })}${reportedAt}`
        : timed
          ? t(
              "Output speed unavailable until this provider reports output tokens and their timing.",
            )
          : t(
              "Output speed unavailable. This provider does not report model timing, and turn wall-clock time would include tool runs.",
            ),
    totals: shownTotals,
    summary,
  };
}

const speedText = (speed: number) => t("~{{speed}} tok/s", { speed: speed.toLocaleString() });

const ringTone = {
  normal: "text-muted-foreground",
  warning: "text-warning",
  danger: "text-danger",
};

/**
 * A ring by the attach button, filled to the open thread's context, amber from 75% and red from
 * 90%; with no context reported yet, there's only the empty ring. Its tooltip says the percent.
 * Hovering or focusing it
 * peeks at a card with the context, then the latest request's speed and cache hit, then the
 * thread's tokens and cost; a click keeps the card open. Each row's tooltip says what it measures.
 * With `onCompact`, the card ends with a button that compacts the thread's context, as T3 Code's
 * meter does. Nothing shows until there is something to say.
 */
export function UsageRing({
  data,
  onCompact,
}: {
  data: ComposerUsageData;
  onCompact?: () => void;
}) {
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
  const { summary } = data;
  if (!summary) return null;
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
        aria-label={t("Usage: {{summary}}", { summary: summary.label })}
        aria-expanded={open}
        aria-controls={card}
        title={open ? undefined : summary.label}
        onClick={() => (kept ? close() : setKept(true))}
        className={`grid size-9 place-items-center rounded-full hover:bg-hover ${open ? "bg-hover" : ""} ${ringTone[summary.tone]}`}
      >
        <svg aria-hidden viewBox="0 0 20 20" className="size-6 -rotate-90">
          <circle
            cx="10"
            cy="10"
            r="7.5"
            fill="none"
            strokeWidth="2.5"
            className="stroke-foreground/20"
          />
          {summary.used > 0 && (
            <circle
              cx="10"
              cy="10"
              r="7.5"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.5"
              strokeLinecap="round"
              pathLength={100}
              strokeDasharray={`${Math.max(summary.used, 3)} 100`}
            />
          )}
        </svg>
      </button>
      <div
        id={card}
        role="group"
        aria-label={t("Usage")}
        hidden={!open}
        className="absolute right-0 bottom-full z-20 mb-2 w-72 rounded-xl border border-border bg-surface p-3.5 text-body text-foreground shadow-composer tabular-nums"
      >
        <UsageRows data={data} />
        {onCompact && (
          <button
            type="button"
            onClick={() => {
              close();
              onCompact();
            }}
            className="mt-3 flex h-8 w-full items-center justify-center gap-1.5 rounded-md border border-border text-body hover:bg-hover [&_svg]:size-4 [&_svg]:text-muted-foreground"
          >
            <Minimize2 aria-hidden />
            {t("Compact context")}
          </button>
        )}
      </div>
    </div>
  );
}

/**
 * The context as a meter, then the latest request's speed and cache hit, then the thread's tokens
 * and cost, as the ring's card and Thread details show them. Each row's tooltip says what it
 * measures.
 */
export function UsageRows({ data }: { data: ComposerUsageData }) {
  const { totals } = data;
  const more = totals?.partial ? "+" : "";
  // The card's groups under the context, each a list of rows apart from the last.
  const groups = [
    [
      data.speed !== undefined && {
        label: t("Output speed"),
        title: data.speedTitle,
        value: speedText(data.speed),
      },
      data.cache && { label: t("Cache hit"), title: data.cacheTitle, value: data.cache },
    ],
    [
      totals && {
        label: t("Tokens"),
        title: totals.title,
        value: t("{{input}} in · {{output}} out", {
          input: `${totals.input}${more}`,
          output: `${totals.output}${more}`,
        }),
      },
      totals?.cost && {
        label: t("API cost"),
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
    <>
      {data.context !== undefined && (
        <div title={data.contextTitle}>
          <div className="flex justify-between gap-3">
            <span className="text-muted-foreground">{t("Context")}</span>
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
    </>
  );
}
