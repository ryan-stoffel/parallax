import { Check, CircleUser, Link, Pencil } from "lucide-react";
import { useCallback, useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";

import type { UsageHour } from "../protocol/generated/protocol";
import { useConnection } from "./ConnectionStatus";
import type { Host } from "./hosts";
import { ParallaxMark } from "./logos";
import { backends, models } from "./models";
import { activityOf, Avatar, dayKey, useProfile, type Activity } from "./profile";
import { backendLogos } from "./Sidebar";
import type { ThreadsView } from "./threads";
import { Breadcrumb, TopBar } from "./ui";

/** How far back the Tokens chart looks, in days. */
const TOKEN_DAYS = 90;
/** The activity grid's weeks: a year, ending with this one. */
const WEEKS = 53;

const compact = new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 });
const monthYear = new Intl.DateTimeFormat("en", { month: "long", year: "numeric" });
const shortDay = new Intl.DateTimeFormat("en", {
  weekday: "short",
  month: "short",
  day: "numeric",
});
const monthName = new Intl.DateTimeFormat("en", { month: "short" });
const monthDay = new Intl.DateTimeFormat("en", { month: "short", day: "numeric" });

const quietButton =
  "flex items-center gap-1.5 rounded-md border border-border px-2.5 py-1 text-[12.5px] text-muted-foreground hover:bg-hover hover:text-foreground [&_svg]:size-3.5";
const heading = "mb-3 text-[12.5px] font-medium text-muted-foreground";

/** The local midnight of `key`, a `dayKey`. */
function dayOf(key: string): Date {
  const [y, m, d] = key.split("-").map(Number) as [number, number, number];
  return new Date(y, m - 1, d);
}

/**
 * The Profile page, from the sidebar's Profile button: the Parallax account (0037), then what
 * every host's agents add up to. Share copies the top card, account and all, as a picture; Edit
 * and Sign in open Settings > Account.
 */
export function ProfilePage({
  hosts,
  listed,
  leading,
  topBarClassName,
  onOpenAccount,
}: {
  hosts: Host[];
  /** Every host's threads and Projects, as App loads them for the sidebar. */
  listed: { host: Host; view: ThreadsView }[];
  /** Before the breadcrumb, such as Show sidebar. */
  leading?: ReactNode;
  topBarClassName: string;
  onOpenAccount: () => void;
}) {
  const profile = useProfile();
  const [now] = useState(Date.now);
  const runs = useMemo(
    () => listed.flatMap(({ view }) => Object.values(view.state.runs)),
    [listed],
  );
  const activity = useMemo(() => activityOf(runs, now), [runs, now]);
  const repos = listed.reduce(
    (n, { view }) => n + view.state.repos.filter((r) => !r.scratch).length,
    0,
  );

  // Each host's usage since TOKEN_DAYS ago, by host id, as it answers.
  const [since] = useState(() => {
    const d = new Date(now);
    d.setHours(0, 0, 0, 0);
    d.setDate(d.getDate() - (TOKEN_DAYS - 1));
    return d.toISOString();
  });
  const [usage, setUsage] = useState<Readonly<Record<string, UsageHour[]>>>({});
  const onUsage = useCallback(
    (hostId: string, hours: UsageHour[]) => setUsage((prev) => ({ ...prev, [hostId]: hours })),
    [],
  );

  const card = useRef<HTMLDivElement>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const [sharing, setSharing] = useState<"capturing" | "copied" | "failed">();
  const share = async () => {
    const el = card.current;
    if (!el || !scroller.current || sharing) return;
    el.scrollIntoView({ block: "nearest" });
    // The buttons give way to the brand mark for the picture, drawn before it's taken.
    setSharing("capturing");
    let done: "copied" | "failed" = "failed";
    try {
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      // Only what shows: a card taller than the page is cut off where the page is.
      const r = el.getBoundingClientRect();
      const view = scroller.current.getBoundingClientRect();
      const top = Math.max(r.top, view.top);
      const bottom = Math.min(r.bottom, view.bottom);
      await window.parallax.copyPicture({
        x: r.left,
        y: top,
        width: r.width,
        height: bottom - top,
      });
      done = "copied";
    } catch {
      // Said on the button, below.
    }
    setSharing(done);
    setTimeout(() => setSharing(undefined), 2000);
  };

  return (
    <>
      <TopBar className={topBarClassName}>
        {leading}
        <Breadcrumb items={[{ label: "Profile" }]} />
      </TopBar>
      {hosts.map((h) => (
        <HostUsage key={h.id} host={h} since={since} onLoad={onUsage} />
      ))}
      <div ref={scroller} className="min-h-0 flex-1 overflow-y-auto">
        <div className="@container mx-auto max-w-3xl px-2 pt-2 pb-16">
          <div ref={card} className="rounded-2xl bg-background px-6 pt-6 pb-7">
            <header className="flex items-center gap-4">
              {profile ? (
                <Avatar profile={profile} size={60} />
              ) : (
                <span className="grid size-15 shrink-0 place-items-center rounded-full bg-selected text-muted-foreground [&_svg]:size-7">
                  <CircleUser />
                </span>
              )}
              <div className="min-w-0 flex-1">
                <h1 className="truncate text-xl font-semibold">
                  {profile ? profile.name || profile.email : profile === null && "Your profile"}
                </h1>
                {profile?.name && (
                  <p className="truncate text-[13px] text-muted-foreground">{profile.email}</p>
                )}
                <p className="mt-0.5 truncate text-[12.5px] text-faint-foreground">
                  {activity.since
                    ? `Building since ${monthYear.format(activity.since)}`
                    : "No agents yet"}
                  {repos > 0 && ` · ${repos} ${repos === 1 ? "repository" : "repositories"}`}
                  {hosts.length > 1 && ` · ${hosts.length} hosts`}
                </p>
              </div>
              {sharing === "capturing" ? (
                <span className="flex items-center gap-1.5 font-brand text-[15px] font-semibold">
                  <ParallaxMark className="size-5" />
                  Parallax
                </span>
              ) : (
                <div className="flex shrink-0 items-center gap-2">
                  <button type="button" onClick={() => void share()} className={quietButton}>
                    {sharing === "copied" ? <Check /> : <Link />}
                    {sharing === "copied"
                      ? "Copied"
                      : sharing === "failed"
                        ? "Couldn't copy"
                        : "Share"}
                  </button>
                  {profile === null ? (
                    <button
                      type="button"
                      onClick={onOpenAccount}
                      className="rounded-md bg-primary px-3 py-1 text-[12.5px] font-medium text-primary-foreground hover:opacity-90"
                    >
                      Sign in
                    </button>
                  ) : (
                    <button type="button" onClick={onOpenAccount} className={quietButton}>
                      <Pencil />
                      Edit
                    </button>
                  )}
                </div>
              )}
            </header>

            <dl className="mt-8 grid grid-cols-2 gap-y-6 @lg:grid-cols-4">
              <Stat label="Agents" value={activity.agents.toLocaleString("en")} />
              <Stat label="Pull requests" value={activity.pullRequests.toLocaleString("en")} />
              <Stat label="Longest streak" value={activity.longest} unit="d" />
              <Stat label="Current streak" value={activity.current} unit="d" />
            </dl>

            {activity.peak && <Peak {...activity.peak} />}
            <Heatmap activity={activity} now={now} />
          </div>

          <div className="px-6">
            <Models activity={activity} />
            <Tokens hosts={hosts} usage={usage} now={now} />
          </div>
        </div>
      </div>
    </>
  );
}

function Stat({ label, value, unit }: { label: string; value: ReactNode; unit?: string }) {
  return (
    <div>
      <dt className="text-[12.5px] font-medium text-muted-foreground">{label}</dt>
      <dd className="mt-1.5 text-2xl tabular-nums">
        {value}
        {unit && <span className="text-muted-foreground">{unit}</span>}
      </dd>
    </div>
  );
}

/** How many circles the peak draws at most; more say so with a count after them. */
const FAN = 12;

/**
 * The most agents started within an hour, drawn as the mark's circles, blue and coral by turns.
 * They fan out from one when the page opens, then each pair's overlap fills in the mark's
 * overlap color.
 */
function Peak({ agents, at }: { agents: number; at: number }) {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const frame = requestAnimationFrame(() => setOpen(true));
    return () => cancelAnimationFrame(frame);
  }, []);
  const shown = Math.min(agents, FAN);
  const r = 15;
  const step = 19;
  // Where two neighbors' edges cross, above and below the midpoint between their centers.
  const h = Math.sqrt(r * r - (step / 2) ** 2);
  const lens = `M${r + step / 2},${r - h} A${r},${r} 0 0 1 ${r + step / 2},${r + h} A${r},${r} 0 0 1 ${r + step / 2},${r - h}Z`;
  const move = (i: number) => ({
    transform: `translateX(${open ? i * step : 0}px)`,
    transitionDelay: `${i * 35}ms`,
  });
  return (
    <div className="mt-8 flex items-center justify-between gap-6 rounded-xl border border-border bg-surface px-5 py-4">
      <div className="min-w-0">
        <p className="text-[12.5px] font-medium text-muted-foreground">Most at once</p>
        <p className="mt-1.5 text-2xl tabular-nums">
          {agents}
          <span className="text-muted-foreground"> {agents === 1 ? "agent" : "agents"}</span>
        </p>
        <p className="mt-1 text-[12.5px] text-faint-foreground">
          Started within an hour, {shortDay.format(at)}
        </p>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        <svg aria-hidden width={2 * r + (shown - 1) * step} height={2 * r}>
          {Array.from({ length: shown }, (_, i) => (
            <circle
              key={i}
              cx={r}
              cy={r}
              r={r}
              style={move(i)}
              className={`motion-safe:transition-transform motion-safe:duration-700 motion-safe:ease-out ${i % 2 ? "fill-mark-coral" : "fill-mark-blue"}`}
            />
          ))}
          {Array.from({ length: shown - 1 }, (_, i) => (
            <path
              key={i}
              d={lens}
              style={{ ...move(i), opacity: open ? 1 : 0, transitionDelay: `${500 + i * 35}ms` }}
              className="fill-mark-overlap motion-safe:transition-opacity motion-safe:duration-300"
            />
          ))}
        </svg>
        {agents > FAN && (
          <span className="text-[12.5px] text-muted-foreground tabular-nums">+{agents - FAN}</span>
        )}
      </div>
    </div>
  );
}

const CELL = 12;
const LEFT = 18;
const TOP = 14;
const shades = [0.3, 0.5, 0.75, 1];

/**
 * A year of days as dots, a column per week from Sunday, shaded by the agents started that day
 * relative to the busiest, then the busiest day.
 */
function Heatmap({ activity, now }: { activity: Activity; now: number }) {
  const today = new Date(now);
  today.setHours(0, 0, 0, 0);
  const start = new Date(today);
  start.setDate(start.getDate() - start.getDay() - (WEEKS - 1) * 7);
  // The year's busiest day, which the shades are relative to.
  const first = dayKey(start.getTime());
  let max = 1;
  for (const [day, agents] of activity.days) if (day >= first) max = Math.max(max, agents);

  const dots: ReactNode[] = [];
  const months: ReactNode[] = [];
  for (let week = 0; week < WEEKS; week++) {
    for (let weekday = 0; weekday < 7; weekday++) {
      const date = new Date(start);
      date.setDate(start.getDate() + week * 7 + weekday);
      if (date > today) break;
      const key = dayKey(date.getTime());
      const agents = activity.days.get(key) ?? 0;
      // A square root, so one big day leaves the others visible.
      const shade = agents && shades[Math.ceil(Math.sqrt(agents / max) * 4) - 1];
      // A month's name over the week of its 1st, but the first week's and the last two's, where it won't fit.
      if (date.getDate() === 1 && week > 0 && week < WEEKS - 2)
        months.push(
          <text key={key} x={LEFT + week * CELL} y={9}>
            {monthName.format(date)}
          </text>,
        );
      dots.push(
        <circle
          key={key}
          cx={LEFT + week * CELL + CELL / 2}
          cy={TOP + weekday * CELL + CELL / 2}
          r={4.5}
          className={shade ? "fill-accent" : "fill-selected"}
          fillOpacity={shade || undefined}
        >
          <title>{`${agents} ${agents === 1 ? "agent" : "agents"} on ${shortDay.format(date)}`}</title>
        </circle>,
      );
    }
  }

  return (
    <section aria-label="Activity" className="mt-8">
      <svg
        viewBox={`0 0 ${LEFT + WEEKS * CELL} ${TOP + 7 * CELL}`}
        className="w-full fill-faint-foreground text-[9px]"
        role="img"
        aria-label="Agents started each day for the past year"
      >
        {months}
        {(["M", "W", "F"] as const).map((d, i) => (
          <text key={d} x={0} y={TOP + (i * 2 + 1) * CELL + 9}>
            {d}
          </text>
        ))}
        {dots}
      </svg>
      {activity.busiest && (
        <p className="mt-2 text-[12.5px] text-muted-foreground">
          Busiest day: {shortDay.format(dayOf(activity.busiest.day))}, {activity.busiest.agents}{" "}
          {activity.busiest.agents === 1 ? "agent" : "agents"}
        </p>
      )}
    </section>
  );
}

/** The models the agents ran most, each with its backend's logo and count. */
function Models({ activity }: { activity: Activity }) {
  const top = activity.models.slice(0, 6);
  if (!top.length) return null;
  return (
    <section aria-label="Models" className="mt-4">
      <h2 className={heading}>Models</h2>
      <ul className="flex flex-wrap gap-2">
        {top.map(({ backend, model, agents }) => {
          const Logo = backendLogos[backend];
          const name = model
            ? (models.find((m) => m.id === model)?.name ?? model)
            : `${backends[backend]?.provider ?? backend} default`;
          return (
            <li
              key={`${backend}/${model ?? ""}`}
              className="flex items-center gap-2 rounded-lg border border-border bg-surface py-2 pr-2 pl-3 text-[13px]"
            >
              {Logo && <Logo className="size-4 shrink-0" />}
              {name}
              <span className="rounded bg-selected px-1.5 text-[11.5px] text-muted-foreground tabular-nums">
                {agents}
              </span>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

/** Asks one host for its usage `since`, once it's connected, and hands up the hours. */
function HostUsage({
  host,
  since,
  onLoad,
}: {
  host: Host;
  since: string;
  onLoad: (hostId: string, hours: UsageHour[]) => void;
}) {
  const connected = useConnection(host.id)?.status === "connected";
  useEffect(() => {
    if (!connected) return;
    let stopped = false;
    void window.parallax.request(host.id, "usage/history", { since }).then((answer) => {
      if (!stopped && "result" in answer) onLoad(host.id, answer.result.hours);
    });
    return () => {
      stopped = true;
    };
  }, [host.id, connected, since, onLoad]);
  return null;
}

/** Every host's tokens over the past TOKEN_DAYS days, by local day, as an area while there are any. */
function Tokens({
  hosts,
  usage,
  now,
}: {
  hosts: Host[];
  usage: Readonly<Record<string, UsageHour[]>>;
  now: number;
}) {
  const gradient = useId();
  const byDay = new Map<string, number>();
  for (const h of hosts)
    for (const hour of usage[h.id] ?? []) {
      const key = dayKey(Date.parse(hour.hour));
      const tokens =
        hour.inputTokens + hour.outputTokens + hour.cacheReadTokens + hour.cacheWriteTokens;
      byDay.set(key, (byDay.get(key) ?? 0) + tokens);
    }
  const days = Array.from({ length: TOKEN_DAYS }, (_, i) => {
    const d = new Date(now);
    d.setDate(d.getDate() - (TOKEN_DAYS - 1 - i));
    return d;
  });
  const series = days.map((d) => byDay.get(dayKey(d.getTime())) ?? 0);
  const total = series.reduce((a, b) => a + b, 0);
  const top = Math.max(...series, 1);
  const line = series
    .map((v, i) => `${i ? "L" : "M"}${(i / (TOKEN_DAYS - 1)) * 100},${100 - (v / top) * 94}`)
    .join(" ");

  return (
    <section aria-label="Tokens" className="mt-10">
      <h2 className={heading}>Tokens</h2>
      {total > 0 ? (
        <>
          <p className="text-2xl tabular-nums">
            {compact.format(total)}
            <span className="text-muted-foreground"> tokens</span>
          </p>
          <svg
            viewBox="0 0 100 100"
            preserveAspectRatio="none"
            className="mt-4 h-36 w-full"
            role="img"
            aria-label={`${compact.format(total)} tokens in the past ${TOKEN_DAYS} days`}
          >
            <defs>
              <linearGradient id={gradient} x1="0" y1="0" x2="0" y2="1">
                <stop offset="0" stopColor="var(--accent)" stopOpacity="0.35" />
                <stop offset="1" stopColor="var(--accent)" stopOpacity="0" />
              </linearGradient>
            </defs>
            <path d={`${line} L100,100 L0,100 Z`} fill={`url(#${gradient})`} />
            <path
              d={line}
              fill="none"
              stroke="var(--accent)"
              strokeWidth={1.5}
              strokeLinejoin="round"
              vectorEffect="non-scaling-stroke"
            />
          </svg>
          <div className="mt-2 flex justify-between text-[12px] text-faint-foreground">
            <span>{monthDay.format(days[0])}</span>
            <span>Today</span>
          </div>
        </>
      ) : (
        <p className="mt-2 text-[12.5px] text-muted-foreground">
          No usage in the past {TOKEN_DAYS} days.
        </p>
      )}
    </section>
  );
}
