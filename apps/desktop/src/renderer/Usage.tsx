import { RotateCw } from "lucide-react";
import { useEffect, useState, type ComponentType, type SVGProps } from "react";

import type {
  AccountUsage,
  KeyAccount,
  Provider,
  UsageLimitWindow,
  UsagePeriod,
} from "../protocol/generated/protocol";
import { statusLabel, useConnection } from "./ConnectionStatus";
import type { Host } from "./hosts";
import { ClaudeLogo, CursorLogo, OpenAILogo } from "./logos";
import { segment } from "./ui";

/** The two periods `usage/get` reports: today, and this week from Monday, in the host's local time. */
export type Period = "today" | "week";

const periodWords: Record<Period, string> = { today: "today", week: "this week" };

/**
 * How long after each answer the Providers and Usage pages ask for usage again. wispd sends no
 * host-level usage or limit event, so this is what keeps them live while runs go.
 */
const USAGE_POLL_MS = 5000;

/**
 * A host's `usage/get`, by account id, asked again every `USAGE_POLL_MS` while `connected`.
 * Undefined until it first answers, so a wispd without `usage/get` shows no usage at all; a
 * later failure keeps the last answer.
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
      const answer = await window.wisp.request(hostId, "usage/get", {});
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

function limitDetails(limit: UsageLimitWindow): string {
  const resets = limit.resetsAt ? `Resets ${at(limit.resetsAt)}. ` : "";
  return `${resets}Reported ${at(limit.capturedAt)}.`;
}

/**
 * A limit window for its Usage card: a short name ("Session", "Weekly · Opus"), how much is left
 * (0 to 100) when the vendor says, and how long until it resets. Once the reset time has passed,
 * the last percent is stale and the whole window is back.
 */
export function limitCard(
  limit: UsageLimitWindow,
  now: number,
): { name: string; left?: number; resetsIn?: string; reset: boolean } {
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
  if (resets !== undefined && resets <= now) return { name, left: 100, reset: true };
  const left =
    limit.usedPercent === undefined
      ? undefined
      : 100 - Math.min(100, Math.max(0, Math.floor(limit.usedPercent)));
  return {
    name,
    left,
    resetsIn: resets === undefined ? undefined : duration(resets - now),
    reset: false,
  };
}

type Logo = ComponentType<SVGProps<SVGSVGElement>>;

/** A subscription account's id is its backend (0012); its name, logo, and the fill of its bars. */
const subscriptions: Record<string, { name: string; Logo: Logo; fill: string }> = {
  claude: { name: "Claude", Logo: ClaudeLogo, fill: "bg-[#D97757]/45" },
  codex: { name: "Codex", Logo: OpenAILogo, fill: "bg-muted-foreground/35" },
  cursor: { name: "Cursor", Logo: CursorLogo, fill: "bg-muted-foreground/35" },
};
const providerAccount: Record<Provider, string> = {
  anthropic: "claude",
  openai: "codex",
  cursor: "cursor",
};

type Tab = "limits" | "tokens";
const tabs: { value: Tab; name: string }[] = [
  { value: "limits", name: "Limits" },
  { value: "tokens", name: "Tokens" },
];
const periods: { value: Period; name: string }[] = [
  { value: "today", name: "Today" },
  { value: "week", name: "This week" },
];

/** A row of radios drawn as one segmented control. */
function Segmented<T extends string>(props: {
  label: string;
  options: { value: T; name: string }[];
  value: T;
  onChange: (value: T) => void;
}) {
  return (
    <fieldset
      aria-label={props.label}
      className="flex gap-0.5 rounded-lg border border-border p-0.5"
    >
      {props.options.map((o) => (
        <label key={o.value} className={segment}>
          <input
            type="radio"
            name={props.label}
            value={o.value}
            checked={props.value === o.value}
            onChange={() => props.onChange(o.value)}
            className="sr-only"
          />
          {o.name}
        </label>
      ))}
    </fieldset>
  );
}

/**
 * The Usage page, from the sidebar's Usage button: every account on every host, as cards of
 * its limit windows (how much is left and when it resets) or of the tokens and cost it used
 * today or this week. Only what `usage/get` reports, kept live by `useUsage`.
 */
export function UsagePage({ hosts }: { hosts: Host[] }) {
  const [tab, setTab] = useState<Tab>("limits");
  const [period, setPeriod] = useState<Period>("today");
  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto max-w-3xl px-8 pt-6 pb-16">
        <div className="mb-6 flex items-center justify-between gap-4">
          <h1 className="text-xl font-semibold">Usage</h1>
          <div className="flex gap-2">
            {tab === "tokens" && (
              <Segmented
                label="Usage period"
                options={periods}
                value={period}
                onChange={setPeriod}
              />
            )}
            <Segmented label="Usage view" options={tabs} value={tab} onChange={setTab} />
          </div>
        </div>
        {hosts.map((h) => (
          <HostUsage key={h.id} host={h} named={hosts.length > 1} tab={tab} period={period} />
        ))}
      </div>
    </div>
  );
}

/** One host's accounts on the Usage page, under the host's name when there are several. */
function HostUsage({
  host,
  named,
  tab,
  period,
}: {
  host: Host;
  named: boolean;
  tab: Tab;
  period: Period;
}) {
  const connection = useConnection(host.id);
  const connected = connection?.status === "connected";
  const usage = useUsage(host.id, connected);
  // API keys, to name their accounts; a subscription's account id is already its backend.
  const [keys, setKeys] = useState<KeyAccount[]>([]);
  useEffect(() => {
    if (!connected) return;
    void window.wisp.request(host.id, "accounts/keys/list", {}).then((answer) => {
      if ("result" in answer) setKeys(answer.result.accounts);
    });
  }, [host.id, connected]);

  let note: string | undefined;
  if (!usage) note = connection && !connected ? statusLabel(connection) : "Loading…";
  else if (usage.size === 0) note = "No usage yet. It shows here once an agent runs.";

  const accounts = [...(usage?.values() ?? [])].map((a) => {
    const key = keys.find((k) => k.id === a.accountId);
    const sub = subscriptions[key ? providerAccount[key.provider] : a.accountId];
    return {
      usage: a,
      name: key?.label ?? sub?.name ?? a.accountId,
      Logo: sub?.Logo,
      fill: sub?.fill,
    };
  });
  accounts.sort((a, b) => a.name.localeCompare(b.name));

  return (
    <section aria-label={host.name} className="mb-10">
      {named && <h2 className="mb-4 text-[13px] font-medium text-muted-foreground">{host.name}</h2>}
      {note && <p className="text-[13px] text-muted-foreground">{note}</p>}
      {accounts.map(({ usage: a, name, Logo, fill = "bg-muted-foreground/35" }) => (
        <section key={a.accountId} aria-label={name} className="mb-8">
          <h3 className="mb-3 flex items-center gap-2.5 text-[15px] font-medium">
            {Logo && <Logo className="size-5" />}
            {name}
          </h3>
          {tab === "tokens" ? (
            <TokensCard spent={a[period]} period={period} />
          ) : a.limits.length === 0 ? (
            <p className="text-[13px] text-muted-foreground">
              No limits reported for this account.
            </p>
          ) : (
            <div className="flex flex-col gap-3">
              {a.limits.map((limit) => (
                <LimitCard key={limit.window} limit={limit} account={name} fill={fill} />
              ))}
            </div>
          )}
        </section>
      ))}
    </section>
  );
}

const card = "rounded-xl border border-border bg-surface px-5 py-4";

/**
 * One limit window: how much is left in large type and how much comes back when, then a bar of
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
  const { name, left, resetsIn, reset } = limitCard(limit, Date.now());
  const empty = left === 0;
  return (
    <div title={limitDetails(limit)} className={`${card} flex items-center gap-8`}>
      <div className="w-40 shrink-0">
        <span className="block text-[13px] font-medium">{name}</span>
        {left !== undefined && (
          <span
            className={`mt-1 block text-[32px] leading-tight font-semibold tabular-nums ${empty ? "text-danger" : ""}`}
          >
            {left}%
            <span className="ml-1.5 text-[14px] font-normal text-muted-foreground">left</span>
          </span>
        )}
        <span className="mt-1 flex items-center gap-1.5 text-[12.5px] text-muted-foreground [&_svg]:size-3.5">
          <RotateCw aria-hidden />
          {reset
            ? "Has reset"
            : left !== undefined && resetsIn
              ? `+${100 - left}% in ${resetsIn}`
              : resetsIn
                ? `Resets in ${resetsIn}`
                : "Reset time unknown"}
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
        {(resetsIn || reset) && (
          <span className="absolute inset-y-0 right-2 flex items-center">
            <span className="flex items-center gap-1 rounded-md bg-background/85 px-2 py-0.5 text-[12px] [&_svg]:size-3">
              <RotateCw />
              {reset ? "reset" : resetsIn}
            </span>
          </span>
        )}
      </div>
    </div>
  );
}

/** An account's tokens over `period`, by kind, with the total and cost on top. */
function TokensCard({ spent, period }: { spent: UsagePeriod; period: Period }) {
  const kinds = [
    ["Input", spent.inputTokens],
    ["Output", spent.outputTokens],
    ["Cache read", spent.cacheReadTokens],
    ["Cache write", spent.cacheWriteTokens],
  ] as const;
  return (
    <div className={card}>
      <span className="block text-[13px] text-muted-foreground">
        {describeUsage(spent, period)}
      </span>
      <dl className="mt-3 grid grid-cols-4 gap-4">
        {kinds.map(([kind, n]) => (
          <div key={kind}>
            <dt className="text-[12.5px] text-muted-foreground">{kind}</dt>
            <dd title={n.toLocaleString()} className="text-[22px] font-semibold tabular-nums">
              {compact.format(n)}
            </dd>
          </div>
        ))}
      </dl>
    </div>
  );
}
