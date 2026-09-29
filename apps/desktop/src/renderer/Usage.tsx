import { useEffect, useState } from "react";

import type { RpcError } from "../preload/bridge";
import type { AccountUsage, UsageLimitWindow, UsagePeriod } from "../protocol/generated/protocol";

/** The two periods `usage/get` reports: today, and this week from Monday, in the host's local time. */
export type Period = "today" | "week";

const periodWords: Record<Period, string> = { today: "today", week: "this week" };

/** The periods as a segmented control's options. */
export const periods: { value: Period; name: string }[] = [
  { value: "today", name: "Today" },
  { value: "week", name: "This week" },
];

/**
 * How long after each answer the Providers and Usage pages ask for usage again. wispd sends no
 * host-level usage or limit event, so this is what keeps them live while runs go.
 */
const USAGE_POLL_MS = 5000;

/**
 * A host's `usage/get`, by account id, asked again every `USAGE_POLL_MS` while `connected`.
 * `usage` is undefined until it first answers, so a wispd without `usage/get` shows no usage at
 * all; a later failure keeps the last answer. `error` is the latest answer's, until one succeeds.
 */
export function useUsage(
  hostId: string,
  connected: boolean,
): { usage?: ReadonlyMap<string, AccountUsage>; error?: RpcError } {
  const [usage, setUsage] = useState<ReadonlyMap<string, AccountUsage>>();
  const [error, setError] = useState<RpcError>();
  useEffect(() => {
    if (!connected) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    // After each answer rather than on an interval, so a slow host never has two in flight.
    const load = async () => {
      const answer = await window.wisp.request(hostId, "usage/get", {});
      if (stopped) return;
      if ("result" in answer) {
        setUsage(new Map(answer.result.accounts.map((a) => [a.accountId, a])));
        setError(undefined);
      } else setError(answer.error);
      timer = setTimeout(() => void load(), USAGE_POLL_MS);
    };
    void load();
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [hostId, connected]);
  return { usage, error };
}

/**
 * An account's usage over `period`, then a line per limit window, for under its row's details.
 * `usage` is undefined for an account wispd has recorded nothing for.
 */
export function UsageLines({ usage, period }: { usage?: AccountUsage; period: Period }) {
  const spent = usage?.[period];
  const now = Date.now();
  return (
    <>
      <span
        className="block truncate text-[12.5px] text-muted-foreground"
        title={spent && tokenBreakdown(spent)}
      >
        {describeUsage(spent, period)}
      </span>
      {usage?.limits.map((limit) => {
        const { text, used } = describeLimit(limit, now);
        const full = used !== undefined && used >= 100;
        return (
          <span
            key={limit.window}
            title={limitDetails(limit)}
            className={`mt-1 flex items-center gap-2 text-[12px] ${full ? "text-danger" : "text-faint-foreground"}`}
          >
            {used !== undefined && (
              <span
                aria-hidden
                className="h-1 w-12 shrink-0 overflow-hidden rounded-full bg-selected"
              >
                <span
                  className={`block h-full rounded-full ${full ? "bg-danger" : "bg-muted-foreground"}`}
                  style={{ width: `${used}%` }}
                />
              </span>
            )}
            <span className="truncate">{text}</span>
          </span>
        );
      })}
    </>
  );
}

const compact = new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 });
const usd = new Intl.NumberFormat("en", { style: "currency", currency: "USD" });

const tokensIn = (p: UsagePeriod) =>
  p.inputTokens + p.outputTokens + p.cacheReadTokens + p.cacheWriteTokens;

/** "1.2M tokens today, about $3.40". The cost is left out when the vendor reports none. */
export function describeUsage(spent: UsagePeriod | undefined, period: Period): string {
  const when = periodWords[period];
  if (!spent || tokensIn(spent) === 0) return `No usage ${when}`;
  const micros = spent.costUsdMicros;
  const cost =
    micros === undefined
      ? ""
      : micros < 5000
        ? ", under $0.01"
        : `, about ${usd.format(micros / 1_000_000)}`;
  return `${compact.format(tokensIn(spent))} tokens ${when}${cost}`;
}

function tokenBreakdown(p: UsagePeriod): string {
  const f = (n: number) => compact.format(n);
  return `${f(p.inputTokens)} input · ${f(p.outputTokens)} output · ${f(p.cacheReadTokens)} cache read · ${f(p.cacheWriteTokens)} cache write`;
}

/**
 * A limit window in plain words, and how much of it is used (0 to 100) when that's still
 * current: "5-hour limit · 12% used · resets in 2 h 14 min". Once its reset time has passed,
 * the last percent is stale, so it only says it has reset.
 */
export function describeLimit(
  limit: UsageLimitWindow,
  now: number,
): { text: string; used?: number } {
  const name = limitName(limit.window);
  const resets = limit.resetsAt === undefined ? undefined : Date.parse(limit.resetsAt);
  if (resets !== undefined && resets <= now) return { text: `${name} has reset` };
  const used =
    limit.usedPercent === undefined ? undefined : Math.min(100, Math.max(0, limit.usedPercent));
  let text =
    used === undefined
      ? name
      : used >= 100
        ? `${name} reached`
        : `${name} · ${Math.floor(used)}% used`;
  if (resets !== undefined) text += ` · resets in ${duration(resets - now)}`;
  return { text, used };
}

/** A vendor's window name, such as Claude's `five_hour` or `seven_day_opus`, in plain words. */
export function limitName(window: string): string {
  if (window === "five_hour") return "5-hour limit";
  const weekly = /^seven_day(?:_(.+))?$/.exec(window);
  if (weekly) return weekly[1] ? `Weekly ${capitalize(weekly[1])} limit` : "Weekly limit";
  return `${capitalize(window)} limit`;
}

const capitalize = (s: string) => {
  const words = s.replaceAll("_", " ");
  return words.charAt(0).toUpperCase() + words.slice(1);
};

/** "42 min", "2 h 14 min", "3 d 4 h", rounded up to the minute. */
function duration(ms: number): string {
  const minutes = Math.max(1, Math.ceil(ms / 60_000));
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return minutes % 60 ? `${hours} h ${minutes % 60} min` : `${hours} h`;
  const days = Math.floor(hours / 24);
  return hours % 24 ? `${days} d ${hours % 24} h` : `${days} d`;
}

const at = (iso: string) =>
  new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });

/** When a limit resets and when wispd heard about it, for a tooltip. */
export function limitDetails(limit: UsageLimitWindow): string {
  const resets = limit.resetsAt ? `Resets ${at(limit.resetsAt)}. ` : "";
  return `${resets}Reported ${at(limit.capturedAt)}.`;
}

/**
 * A limit window for its Usage card: a short name ("Session", "Weekly · Opus"), how much is left
 * (0 to 100) when the vendor says, a line on what comes back when, and the bar's reset badge.
 * Once the reset time has passed, the last percent is stale and the whole window is back.
 */
export function limitCard(
  limit: UsageLimitWindow,
  now: number,
): { name: string; left?: number; line: string; badge?: string } {
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
  if (resets !== undefined && resets <= now)
    return { name, left: 100, line: "Has reset", badge: "reset" };
  const left =
    limit.usedPercent === undefined
      ? undefined
      : 100 - Math.min(100, Math.max(0, Math.floor(limit.usedPercent)));
  if (resets === undefined) return { name, left, line: "Reset time unknown" };
  const resetsIn = duration(resets - now);
  const line =
    left !== undefined && left < 100 ? `+${100 - left}% in ${resetsIn}` : `Resets in ${resetsIn}`;
  return { name, left, line, badge: resetsIn };
}
