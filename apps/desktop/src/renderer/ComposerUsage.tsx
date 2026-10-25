import { useEffect, useId, useRef, useState } from "react";

import type { AccountLimits, UsageLimitWindow } from "../protocol/generated/protocol";
import type { RequestUsage } from "./transcript";
import { clockOptions } from "./prefs";
import { limitDetails, limitName } from "./Usage";

const refreshMs = 60_000;
const staleMs = 90_000;

type LimitsAnswer = Awaited<ReturnType<typeof readLimits>>;
/** Each host's last answer read without error, so a composer that mounts or changes host shows
 * its limits on its first render. */
const answered = new Map<string, LimitsAnswer>();
/** Each host's last answer and the read under way, shared by every strip: plxd starts the
 * providers' CLIs for each read, so open threads and remounts must not multiply them. */
const limitReads = new Map<string, { at: number; answer: Promise<LimitsAnswer> }>();
function readLimits(hostId: string) {
  return window.parallax.request(hostId, "usage/limits", {});
}
function sharedLimits(hostId: string, now = Date.now()): Promise<LimitsAnswer> {
  const last = limitReads.get(hostId);
  if (last && now - last.at < refreshMs) return last.answer;
  const answer = readLimits(hostId);
  limitReads.set(hostId, { at: now, answer });
  // A failed read, or an error answer, is retried by the next strip instead of being kept.
  const forget = () => limitReads.get(hostId)?.answer === answer && limitReads.delete(hostId);
  answer.then((response) => "error" in response && forget(), forget);
  return answer;
}
/** For tests: forgets every host's shared answer. */
export function forgetLimits() {
  limitReads.clear();
  answered.clear();
}

/** Only current, valid provider observations can fill a limit meter. */
export function currentLimit(limit: UsageLimitWindow, now: number): number | undefined {
  const captured = Date.parse(limit.capturedAt);
  const reset = limit.resetsAt === undefined ? undefined : Date.parse(limit.resetsAt);
  const used = limit.usedPercent;
  if (
    !Number.isFinite(captured) ||
    captured > now ||
    now - captured > staleMs ||
    (reset !== undefined && (!Number.isFinite(reset) || reset <= now)) ||
    used === undefined ||
    !Number.isFinite(used) ||
    used < 0 ||
    used > 100
  )
    return undefined;
  return used;
}

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
    "Claude's API time for the last turn, which includes waiting for each request's first token and any subagent requests",
  opencode:
    "the time OpenCode spent streaming text and reasoning in the last model request without tool calls, which leaves out the wait for the first token",
};

const windowName = (name: string) =>
  name === "five_hour"
    ? "5h"
    : name === "seven_day"
      ? "Week"
      : // "Weekly Fable limit" reads as "Fable": every named window here is a week.
        limitName(name)
          .replace(/ limit$/, "")
          .replace(/^Weekly /, "");

/** How full a meter is: amber from 75%, red from 90%, as on the Usage page. */
const tone = (used: number) => (used >= 90 ? "danger" : used >= 75 ? "warning" : "normal");
const fill = { normal: "bg-muted-foreground", warning: "bg-warning", danger: "bg-danger" };

/** One subscription window, current or shown as unknown. */
interface Window {
  key: string;
  name: string;
  /** Percent used, when the observation is current. */
  used?: number;
  title: string;
  resetsAt?: string;
}

/** What the composer shows about a provider, from live account windows and request telemetry. */
export interface ComposerUsageData {
  account: string;
  /** The clock the readings were judged by, so reset times agree with them. */
  now: number;
  windows: Window[];
  /** Why there are no windows. Absent while there are some. */
  limitsNote?: { text: string; title: string };
  context?: string;
  /** Context use, 0 to 100, for the ring. */
  contextUsed?: number;
  contextDetail?: string;
  contextTitle: string;
  cache?: string;
  cacheTitle: string;
  speed?: number;
  speedTitle: string;
  /** What the ring shows: the fullest current window, or the context when no window is known. */
  summary?: Summary;
}

/** The tray's one line, and how it reads. */
interface Summary {
  /** How full the ring is, 0 to 100. */
  used: number;
  /** What the ring says to a screen reader and in its tooltip. */
  label: string;
  tone: "normal" | "warning" | "danger";
}

/** "of week", "of 5h", or a named window's own name. */
const ofWindow = (key: string) =>
  key === "five_hour"
    ? "of 5h"
    : key === "seven_day"
      ? "of week"
      : key.startsWith("seven_day_")
        ? `of ${windowName(key)} week`
        : `of ${windowName(key)}`;

const compact = (n: number) =>
  new Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 1 }).format(n);

/** "4:20 PM" within the day, "Thu 9:00 AM" within the week, "Oct 17, 9:00 AM" six or more days
 * out, where a weekday alone could read as today. */
function resetTime(iso: string, now: number): string {
  const at = Date.parse(iso);
  const day = 24 * 60 * 60 * 1000;
  const ahead = at - now;
  return new Date(at).toLocaleString(undefined, {
    ...(ahead >= 6 * day
      ? { month: "short", day: "numeric" }
      : ahead > 20 * 60 * 60 * 1000 && { weekday: "short" }),
    ...clockOptions(),
  });
}

/** When a window resets, for sorting: one with no reset time could keep you waiting longest. */
const resetOrder = (w: { resetsAt?: string }) => {
  const at = w.resetsAt === undefined ? NaN : Date.parse(w.resetsAt);
  return Number.isFinite(at) ? at : Infinity;
};

/**
 * Reads the account's live limit windows (shared per host, refreshed each minute) and turns them
 * and the run's latest request telemetry into what the composer shows. Nothing until a host and
 * provider are known.
 */
export function useComposerUsage({
  hostId,
  connected,
  backend,
  kind,
  accountId,
  usage,
}: {
  hostId?: string;
  connected: boolean;
  backend?: string;
  kind?: string;
  accountId?: string;
  usage?: RequestUsage;
}): ComposerUsageData | undefined {
  const key = `${hostId}/${backend}/${accountId}/${connected}`;
  const subscription = connected && !!hostId && !!backend && accountId === backend;
  // The answer for one host, provider, and account.
  const [read, setRead] = useState<{ key: string; limits?: AccountLimits; problem?: string }>();
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (!subscription) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const failed = "This host could not report live subscription limits.";
    const load = async () => {
      try {
        const response = await sharedLimits(hostId);
        if (stopped) return;
        setNow(Date.now());
        if ("result" in response) {
          const found = response.result.accounts.find((entry) => entry.accountId === accountId);
          answered.set(hostId, response);
          setRead({ key, limits: found, problem: found?.problem });
        } else setRead({ key, problem: failed });
      } catch {
        if (stopped) return;
        setRead({ key, problem: failed });
      }
      if (!stopped) timer = setTimeout(() => void load(), refreshMs);
    };
    void load();
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [key, subscription, hostId, accountId]);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 15_000);
    return () => clearInterval(timer);
  }, []);
  if (!hostId || !backend || !accountId) return undefined;

  // Until this key's own answer lands: the host's last one, else the account's last on another
  // computer, so the ring doesn't blink out as the box opens or changes computer.
  const accountIn = (answer?: LimitsAnswer) =>
    answer && "result" in answer
      ? answer.result.accounts.find((entry) => entry.accountId === accountId)
      : undefined;
  const own = answered.get(hostId);
  const held = own ? accountIn(own) : [...answered.values()].map(accountIn).find(Boolean);
  const current =
    read?.key === key ? read : (own ?? held) && { limits: held, problem: held?.problem };
  const windows: Window[] = (subscription ? (current?.limits?.limits ?? []) : []).map((limit) => {
    const used = currentLimit(limit, now);
    return {
      key: limit.window,
      name: windowName(limit.window),
      used,
      resetsAt: limit.resetsAt,
      title: `${limitName(limit.window)} used. ${limitDetails(limit)}${used === undefined ? " Current utilization unavailable." : ""}`,
    };
  });
  const limitsNote = windows.length
    ? undefined
    : {
        text: subscription && !current ? "Reading limits…" : "Limits unavailable",
        title:
          current?.problem ??
          (accountId !== backend
            ? "Subscription limits are unavailable for this API key account."
            : "This provider has not reported live subscription limits."),
      };

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

  // The fullest current window speaks for the account; a later reset, or none, breaks a tie,
  // since that one keeps you waiting longer.
  const fullest = windows
    .filter((w) => w.used !== undefined)
    .sort((a, b) => {
      const later = resetOrder(b) - resetOrder(a);
      return b.used! - a.used! || (Number.isNaN(later) ? 0 : later);
    })[0];
  let summary: Summary | undefined;
  if (fullest) {
    const capped = fullest.used! >= 100;
    summary = {
      used: Math.min(fullest.used!, 100),
      tone: tone(fullest.used!),
      label: capped
        ? `${limitName(fullest.key)} used up${fullest.resetsAt ? `, back ${resetTime(fullest.resetsAt, now)}` : ""}`
        : `${Math.floor(fullest.used!)}% ${ofWindow(fullest.key)} used`,
    };
  } else if (context !== undefined)
    summary = {
      used: contextUsed!,
      tone: tone(contextUsed!),
      label: `${context} of context used`,
    };

  return {
    account: accountId,
    now,
    windows,
    limitsNote,
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
        ? `Approximate output speed: ${measured?.outputTokens?.toLocaleString()} output tokens over ${speedSource[kind]} (${((measured?.outputMs ?? 0) / 1000).toFixed(1)} s).${reportedAt}`
        : timed
          ? "Output speed unavailable until this provider reports output tokens and their timing."
          : "Output speed unavailable. This provider does not report model timing, and turn wall-clock time would include tool runs.",
    summary,
  };
}

const speedText = (speed: number) => `~${speed.toLocaleString()} tok/s`;

/** A small meter, its bar left empty when the value is unknown. */
function Meter({ used, className }: { used?: number; className: string }) {
  return (
    <span aria-hidden className={`overflow-hidden rounded-full bg-selected ${className}`}>
      {used !== undefined && (
        <span
          className={`block h-full rounded-full ${fill[tone(used)]}`}
          style={{ width: `${used}%` }}
        />
      )}
    </span>
  );
}

/**
 * The inline view: one row inside the prompt box, under its pickers. Limit windows sit on the
 * left, each with a small meter, and a used-up one says when it comes back; the thread's context,
 * speed, and cache sit on the right. Only what the provider reported shows, and the row is absent
 * when there is nothing.
 */
export function UsageInline({ data }: { data: ComposerUsageData }) {
  const thread = [
    data.context && { key: "context", title: data.contextTitle, text: `${data.context} context` },
    data.speed !== undefined && {
      key: "speed",
      title: data.speedTitle,
      text: speedText(data.speed),
    },
    data.cache && { key: "cache", title: data.cacheTitle, text: `${data.cache} cached` },
  ].filter((item): item is { key: string; title: string; text: string } => !!item);
  if (data.windows.length === 0 && thread.length === 0) return null;
  return (
    <div
      role="group"
      aria-label="Usage"
      className="mx-3 flex flex-wrap items-center justify-between gap-x-5 gap-y-1.5 border-t border-border px-1.5 pt-2 pb-2.5 text-meta text-muted-foreground tabular-nums"
    >
      <div className="flex min-w-0 flex-wrap items-center gap-x-4 gap-y-1.5">
        {data.windows.map((w) => {
          const capped = w.used !== undefined && w.used >= 100;
          return (
            <span
              key={w.key}
              title={w.title}
              className={`flex items-center gap-1.5 whitespace-nowrap ${capped ? "text-danger" : ""}`}
            >
              {w.name}
              <Meter used={w.used} className="h-1 w-9" />
              {w.used === undefined
                ? "—"
                : capped && w.resetsAt
                  ? `back ${resetTime(w.resetsAt, data.now)}`
                  : `${Math.floor(w.used)}%`}
            </span>
          );
        })}
      </div>
      {thread.length > 0 && (
        <div className="flex items-center gap-2 whitespace-nowrap">
          {thread.map((item, i) => (
            <span key={item.key} className="flex items-center gap-2">
              {i > 0 && (
                <span aria-hidden className="text-faint-foreground">
                  ·
                </span>
              )}
              <span title={item.title}>{item.text}</span>
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

const ringTone = {
  normal: "text-muted-foreground",
  warning: "text-warning",
  danger: "text-danger",
};

/**
 * A ring and its percent by the attach button, filled to the fullest current limit window (or the
 * thread's context when no window is known), amber from 75% and red from 90%. The percent beside it
 * keeps the partial ring from reading as a loading spinner. Hovering or focusing it peeks
 * at a card with every window and the thread's own measurements; a click keeps the card open.
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
  const { summary } = data;
  if (!summary) return null;
  const thread = [
    data.context && {
      label: "Context",
      title: data.contextTitle,
      value: `${data.contextDetail} · ${data.context}`,
    },
    data.cache && { label: "Cached input", title: data.cacheTitle, value: data.cache },
    data.speed !== undefined && {
      label: "Output speed",
      title: data.speedTitle,
      value: speedText(data.speed),
    },
  ].filter((row): row is { label: string; title: string; value: string } => !!row);
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
        <span aria-hidden>{Math.round(summary.used)}%</span>
      </button>
      <div
        id={card}
        role="group"
        aria-label="Usage"
        hidden={!open}
        className="absolute right-0 bottom-full z-20 mb-2 w-80 rounded-xl border border-border bg-surface p-3 text-body text-foreground shadow-composer tabular-nums"
      >
        {/* One grid for every window, so their bars line up. */}
        <div className="grid grid-cols-[3.5rem_1fr_auto] items-center gap-x-2.5 gap-y-2.5 py-0.5">
          {data.windows.map((w) => (
            <div key={w.key} title={w.title} className="contents">
              <span className="truncate text-muted-foreground">{w.name}</span>
              <Meter used={w.used} className="h-1" />
              <span
                className={`text-right whitespace-nowrap ${w.used !== undefined && w.used >= 100 ? "text-danger" : "text-muted-foreground"}`}
              >
                {w.used === undefined ? "—" : `${Math.floor(w.used)}%`}
                {/* A reset time only with a current reading: one past, or behind a stale or
                  malformed reading, would be old news. */}
                {w.used !== undefined && w.resetsAt && ` · ${resetTime(w.resetsAt, data.now)}`}
              </span>
            </div>
          ))}
        </div>
        {data.limitsNote && (
          <p title={data.limitsNote.title} className="text-muted-foreground">
            {data.limitsNote.text}
          </p>
        )}
        {thread.length > 0 && (
          <div className="mt-2.5 border-t border-border pt-2">
            {thread.map((row) => (
              <div key={row.label} title={row.title} className="my-1 flex justify-between gap-3">
                <span className="text-muted-foreground">{row.label}</span>
                <span>{row.value}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
