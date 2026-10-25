import { useEffect, useState } from "react";

import type { AccountUsage, UsageLimitWindow, UsagePeriod } from "../protocol/generated/protocol";
import { locale } from "./locale";
import { hourCycle } from "./prefs";
import { capitalize, duration, usd } from "./usageStats";

/** The two periods `usage/get` reports: today, and this week from Monday, in the host's local time. */
export type Period = "today" | "week";

const periodWords: Record<Period, string> = { today: "today", week: "this week" };

/** The periods as a segmented control's options. */
export const periods: { value: Period; name: string }[] = [
  { value: "today", name: "Today" },
  { value: "week", name: "This week" },
];

/**
 * How long after each answer the Providers and Usage pages ask for usage again. plxd sends no
 * host-level usage or limit event, so this is what keeps them live while runs go.
 */
const USAGE_POLL_MS = 5000;

/**
 * A host's `usage/get`, by account id, asked again every `USAGE_POLL_MS` while `connected`.
 * Undefined until it first answers, so a plxd without `usage/get` shows no usage at all; a later
 * failure keeps the last answer.
 */
export function useUsage(
  hostId: string,
  connected: boolean,
): ReadonlyMap<string, AccountUsage> | undefined {
  const [usage, setUsage] = useState<ReadonlyMap<string, AccountUsage>>();
  useEffect(() => {
    if (!connected) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    // After each answer rather than on an interval, so a slow host never has two in flight.
    const load = async () => {
      const answer = await window.parallax.request(hostId, "usage/get", {});
      if (stopped) return;
      if ("result" in answer)
        setUsage(new Map(answer.result.accounts.map((a) => [a.accountId, a])));
      timer = setTimeout(() => void load(), USAGE_POLL_MS);
    };
    void load();
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [hostId, connected]);
  return usage;
}

/**
 * An account's usage over `period`, then a line per limit window, for under its row's details.
 * `usage` is undefined for an account plxd has recorded nothing for.
 */
export function UsageLines({ usage, period }: { usage?: AccountUsage; period: Period }) {
  const spent = usage?.[period];
  const now = Date.now();
  return (
    <>
      <span
        className="block truncate text-body text-muted-foreground"
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
            className={`mt-1 flex items-center gap-2 text-meta ${full ? "text-danger" : "text-faint-foreground"}`}
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

export const compact = new Intl.NumberFormat("en", {
  notation: "compact",
  maximumFractionDigits: 1,
});
export { usd };

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

const at = (iso: string) =>
  new Date(iso).toLocaleString(locale(), {
    dateStyle: "medium",
    timeStyle: "short",
    ...hourCycle(),
  });

/** When a limit resets and when plxd heard about it, for a tooltip. */
export function limitDetails(limit: UsageLimitWindow): string {
  const resets = limit.resetsAt ? `Resets ${at(limit.resetsAt)}. ` : "";
  return `${resets}Reported ${at(limit.capturedAt)}.`;
}

export { limitMeter, type LimitTone } from "./usageStats";
