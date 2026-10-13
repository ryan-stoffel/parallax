import {
  Activity as ActivityIcon,
  Bot,
  CalendarDays,
  Check,
  CircleUser,
  Flame,
  FolderGit2,
  GitPullRequest,
  Link,
  Moon,
  Network,
  ShieldCheck,
  Sunrise,
  Sun,
  Sunset,
  Trophy,
  X,
  type LucideIcon,
} from "lucide-react";
import { useCallback, useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";

import type { DeviceHost, Profile } from "../preload/bridge";
import type { UsageHour } from "../protocol/generated/protocol";
import { useConnection } from "./ConnectionStatus";
import { osName } from "./ConnectWizard";
import { DeviceIcon } from "./DeviceIcon";
import { localId, useConnect, useHosts, type Host } from "./hosts";
import { ClerkLogo, ParallaxMark } from "./logos";
import { models } from "./models";
import { instanceName, kinds } from "./providers";
import { activityOf, Avatar, dayKey, dayOf, rhythmOf, type Activity } from "./profile";
import { backendLogos } from "./Sidebar";
import { isRepository, type ThreadsView } from "./threads";
import { hourCycle } from "./prefs";
import { compact } from "./Usage";
import { quietButton, Section, settingRow } from "./settings/parts";
import { IconButton } from "./ui";

/** How far back the Tokens chart looks, in days. */
const TOKEN_DAYS = 90;
/** The activity grid's weeks: a year, ending with this one. */
const WEEKS = 53;

const monthYear = new Intl.DateTimeFormat("en", { month: "long", year: "numeric" });
const shortDay = new Intl.DateTimeFormat("en", {
  weekday: "short",
  month: "short",
  day: "numeric",
});
const monthName = new Intl.DateTimeFormat("en", { month: "short" });
const monthDay = new Intl.DateTimeFormat("en", { month: "short", day: "numeric" });
const hourName = () => new Intl.DateTimeFormat("en", { hour: "numeric", ...hourCycle() });

const card = "rounded-2xl border border-border bg-surface";
const heading = "text-[12.5px] font-medium text-muted-foreground";
const outlineButton =
  "flex items-center gap-1.5 rounded-md border border-border bg-surface px-2.5 py-1 text-[12.5px] text-muted-foreground hover:bg-hover hover:text-foreground [&_svg]:size-3.5";
const dangerOutline =
  "rounded-md border border-border bg-surface px-2.5 py-1 text-[12.5px] text-danger hover:bg-hover";

/** "Secured by Clerk", with Clerk's mark, as Clerk's own account pages sign off. */
export function SecuredByClerk() {
  return (
    <span className="flex items-center gap-1 text-[12px] text-faint-foreground">
      Secured by
      <span className="flex items-center gap-0.5 font-semibold text-muted-foreground">
        <ClerkLogo className="size-3.5" />
        Clerk
      </span>
    </span>
  );
}

const tabs = [
  {
    id: "profile",
    name: "Profile",
    Icon: CircleUser,
    about: "Your Parallax account, and what your agents add up to.",
  },
  {
    id: "activity",
    name: "Activity",
    Icon: ActivityIcon,
    about: "When and how much your agents ran, across every host.",
  },
  {
    id: "security",
    name: "Security",
    Icon: ShieldCheck,
    about: "How you sign in, and where. Each opens Clerk's account page in your browser.",
  },
  {
    id: "connect",
    name: "Parallax Connect",
    Icon: Network,
    about: "The computers you added with Parallax Connect. Turn them on or off in Settings.",
  },
] as const;

/**
 * The Account dialog, a native modal <dialog> open while it's mounted, which the profile menu's
 * Manage account opens (0067). Profile is the account's card, with what every host's agents add
 * up to, and its settings. Activity is when and how much those agents ran. Security is how the
 * account signs in, on Clerk's pages. Parallax Connect lists the devices added with it (0056).
 * Share copies the card as a picture.
 */
export function AccountDialog({
  profile,
  listed,
  onClose,
}: {
  profile: Profile;
  listed: { host: Host; view: ThreadsView }[];
  onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const [tab, setTab] = useState<(typeof tabs)[number]["id"]>("profile");
  const current = tabs.find((t) => t.id === tab)!;
  useEffect(() => dialog.current?.showModal(), []);
  const hosts = useHosts();
  const [now] = useState(Date.now);
  const runs = useMemo(
    () => listed.flatMap(({ view }) => Object.values(view.state.runs)),
    [listed],
  );
  const activity = useMemo(() => activityOf(runs, now), [runs, now]);
  const repos = listed.reduce((n, { view }) => n + view.state.repos.filter(isRepository).length, 0);

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

  return (
    <dialog
      ref={dialog}
      aria-labelledby={titleId}
      onClose={onClose}
      className="relative m-auto h-[85vh] w-[60rem] max-w-[92vw] overflow-hidden rounded-xl border border-border bg-background text-foreground shadow-composer backdrop:bg-black/50"
    >
      {hosts.map((h) => (
        <HostUsage key={h.id} host={h} since={since} onLoad={onUsage} />
      ))}
      <div className="flex h-full">
        <nav className="flex w-52 shrink-0 flex-col gap-px border-r border-border bg-sidebar px-2 pt-4 pb-3">
          <h2 id={titleId} className="mb-3 px-2 text-xl font-semibold">
            Account
          </h2>
          {tabs.map((t) => (
            <button
              key={t.id}
              type="button"
              aria-current={t.id === tab ? "page" : undefined}
              onClick={() => setTab(t.id)}
              className={`flex w-full items-center gap-2 rounded-md px-2 py-[5px] text-left text-[13px] hover:bg-hover ${t.id === tab ? "bg-selected text-foreground" : "text-foreground/80"}`}
            >
              <t.Icon aria-hidden className="size-4 shrink-0 text-muted-foreground" />
              {t.name}
            </button>
          ))}
          <div className="mt-auto flex flex-col gap-2 px-2">
            <span className="flex items-center gap-1.5 font-brand text-[13px] font-semibold text-muted-foreground">
              <ParallaxMark className="size-4" />
              Parallax
            </span>
            <SecuredByClerk />
          </div>
        </nav>
        <div className="flex min-w-0 flex-1 flex-col">
          <header className="border-b border-border px-8 pt-5 pb-4">
            <h3 className="text-[15px] font-semibold">{current.name}</h3>
            <p className="mt-0.5 text-[12.5px] text-muted-foreground">{current.about}</p>
          </header>
          <div className="@container min-h-0 flex-1 overflow-y-auto px-8 pt-6 pb-10">
            {tab === "profile" ? (
              <>
                <ProfileCard
                  profile={profile}
                  activity={activity}
                  repos={repos}
                  hosts={hosts.length}
                />
                <AccountRows profile={profile} />
              </>
            ) : tab === "security" ? (
              <SecurityRows />
            ) : tab === "connect" ? (
              <ConnectRows />
            ) : (
              <>
                {activity.agents > 0 && (
                  <div className="mb-8 grid gap-3 @2xl:grid-cols-2">
                    <Hours hours={activity.hours} />
                    <Models activity={activity} />
                  </div>
                )}
                <Heatmap activity={activity} now={now} />
                <Tokens hosts={hosts} usage={usage} now={now} />
              </>
            )}
          </div>
        </div>
      </div>
      <span className="absolute top-3 right-3">
        <IconButton label="Close" onClick={() => dialog.current?.close()}>
          <X aria-hidden />
        </IconButton>
      </span>
    </dialog>
  );
}

/**
 * The card at the top: a banner in the logo's colors, the account, and the stats as tiles.
 * Share copies it as a picture, with the brand mark where the button is.
 */
function ProfileCard({
  profile,
  activity,
  repos,
  hosts,
}: {
  profile: Profile;
  activity: Activity;
  repos: number;
  hosts: number;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [sharing, setSharing] = useState<"capturing" | "copied" | "failed">();
  const share = async () => {
    const el = ref.current;
    if (!el || sharing) return;
    el.scrollIntoView({ block: "nearest" });
    setSharing("capturing");
    let done: "copied" | "failed" = "failed";
    try {
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      // Only what shows: a card taller than the page is cut off where the page is.
      const r = el.getBoundingClientRect();
      const view = el.closest(".overflow-y-auto")?.getBoundingClientRect();
      const top = Math.max(r.top, view?.top ?? 0);
      const bottom = Math.min(r.bottom, view?.bottom ?? window.innerHeight);
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

  const chips: { Icon: LucideIcon; text: string }[] = [];
  if (activity.since)
    chips.push({ Icon: CalendarDays, text: `Building since ${monthYear.format(activity.since)}` });
  if (repos > 0)
    chips.push({
      Icon: FolderGit2,
      text: `${repos} ${repos === 1 ? "repository" : "repositories"}`,
    });

  return (
    <section ref={ref} aria-label="Profile" className={`mb-8 overflow-hidden ${card}`}>
      <Banner />
      <div className="px-6 pb-6">
        <div className="relative -mt-12 flex items-end justify-between gap-4">
          <span className="rounded-full bg-surface p-1">
            <Avatar profile={profile} size={88} />
          </span>
          {sharing === "capturing" ? (
            <span className="flex items-center gap-1.5 pb-1 font-brand text-[15px] font-semibold">
              <ParallaxMark className="size-5" />
              Parallax
            </span>
          ) : (
            <button type="button" onClick={() => void share()} className={`mb-1 ${outlineButton}`}>
              {sharing === "copied" ? <Check /> : <Link />}
              {sharing === "copied" ? "Copied" : sharing === "failed" ? "Couldn't copy" : "Share"}
            </button>
          )}
        </div>

        <h2 className="mt-3 truncate font-brand text-2xl font-semibold tracking-tight">
          {profile.name || profile.email}
        </h2>
        {profile.name && (
          <p className="truncate text-[13px] text-muted-foreground">{profile.email}</p>
        )}
        {chips.length > 0 && (
          <ul className="mt-3 flex flex-wrap gap-1.5">
            {chips.map(({ Icon, text }) => (
              <li
                key={text}
                className="flex items-center gap-1.5 rounded-full bg-selected px-2.5 py-0.5 text-[12px] text-muted-foreground [&_svg]:size-3.5"
              >
                <Icon aria-hidden />
                {text}
              </li>
            ))}
          </ul>
        )}

        <dl className="mt-6 grid grid-cols-2 gap-2.5 @xl:grid-cols-4">
          <Stat Icon={Bot} tone="blue" label="Agents" value={activity.agents} />
          <Stat
            Icon={GitPullRequest}
            tone="blue"
            label="Pull requests"
            value={activity.pullRequests}
          />
          <Stat
            Icon={Trophy}
            tone="coral"
            label="Longest streak"
            value={activity.longest}
            unit="d"
          />
          <Stat
            Icon={Flame}
            tone={activity.current ? "coral" : "off"}
            label="Current streak"
            value={activity.current}
            unit="d"
          />
        </dl>
        {hosts > 1 && (
          <p className="mt-3 text-[12px] text-faint-foreground">Across {hosts} hosts</p>
        )}
      </div>
    </section>
  );
}

/** The card's banner: the logo's two circles, large and soft, over a wash of their colors. */
function Banner() {
  return (
    <div
      aria-hidden
      style={{
        background:
          "linear-gradient(115deg, color-mix(in oklab, var(--mark-blue) 22%, var(--surface)), color-mix(in oklab, var(--mark-coral) 18%, var(--surface)))",
      }}
      className="relative h-28 overflow-hidden"
    >
      <span className="absolute -top-16 right-28 size-52 rounded-full bg-mark-blue opacity-30 blur-2xl" />
      <span className="absolute -top-4 right-4 size-44 rounded-full bg-mark-coral opacity-25 blur-2xl" />
      <ParallaxMark className="absolute top-1/2 right-8 size-16 -translate-y-1/2 opacity-90" />
    </div>
  );
}

const tones = {
  blue: "bg-mark-blue/15 text-mark-blue",
  coral: "bg-mark-coral/15 text-mark-coral",
  off: "bg-selected text-faint-foreground",
};

function Stat({
  Icon,
  tone,
  label,
  value,
  unit,
}: {
  Icon: LucideIcon;
  tone: keyof typeof tones;
  label: string;
  value: number;
  unit?: string;
}) {
  return (
    <div className="rounded-xl border border-border bg-background/60 p-3.5">
      <span
        aria-hidden
        className={`grid size-7 place-items-center rounded-lg ${tones[tone]} [&_svg]:size-4`}
      >
        <Icon />
      </span>
      <dt className="mt-3 text-[12px] text-muted-foreground">{label}</dt>
      <dd className="font-brand text-2xl font-semibold tabular-nums">
        {value.toLocaleString("en")}
        {unit && <span className="ml-0.5 text-base font-normal text-muted-foreground">{unit}</span>}
      </dd>
    </div>
  );
}

/** The icon for a busiest hour of the day: the sun's place then. */
function rhythmIcon(hour: number): LucideIcon {
  if (hour >= 5 && hour < 12) return Sunrise;
  if (hour >= 12 && hour < 18) return Sun;
  if (hour >= 18 && hour < 22) return Sunset;
  return Moon;
}

/**
 * Agents started in each hour of the day as bars, the busiest in the accent, and what that hour
 * says about when someone builds.
 */
function Hours({ hours }: { hours: number[] }) {
  const max = Math.max(...hours);
  if (!max) return null;
  const busiest = hours.indexOf(max);
  const at = (hour: number) => hourName().format(new Date(2000, 0, 1, hour));
  const Icon = rhythmIcon(busiest);
  return (
    <section aria-label="When you build" className={`flex flex-col p-5 ${card}`}>
      <h2 className={heading}>When you build</h2>
      <p className="mt-1 flex items-center gap-1.5 text-[15px] font-medium [&_svg]:size-4 [&_svg]:text-mark-coral">
        <Icon aria-hidden />
        {rhythmOf(busiest)}
        <span className="text-[13px] font-normal text-muted-foreground">
          · busiest around {at(busiest)}
        </span>
      </p>
      <div
        role="img"
        aria-label={`Agents started in each hour of the day, most around ${at(busiest)}`}
        className="mt-4 flex min-h-20 flex-1 items-end gap-[3px]"
      >
        {hours.map((agents, hour) => (
          <div
            key={hour}
            title={`${agents} ${agents === 1 ? "agent" : "agents"} at ${at(hour)}`}
            style={{ height: `${Math.max(6, (agents / max) * 100)}%` }}
            className={`flex-1 rounded-[3px] ${hour === busiest ? "bg-accent" : agents ? "bg-accent/45" : "bg-selected"}`}
          />
        ))}
      </div>
      <div className="mt-1.5 grid grid-cols-4 text-[11px] text-faint-foreground">
        {[0, 6, 12, 18].map((hour) => (
          <span key={hour}>{at(hour)}</span>
        ))}
      </div>
    </section>
  );
}

/** The models the agents ran most, each with its backend's logo, its share as a bar, and its count. */
function Models({ activity }: { activity: Activity }) {
  const top = activity.models.slice(0, 5);
  if (!top.length) return null;
  const max = top[0]!.agents;
  return (
    <section aria-label="Models" className={`p-5 ${card}`}>
      <h2 className={heading}>Models</h2>
      <ul className="mt-3 flex flex-col gap-3">
        {top.map(({ backend, model, agents }) => {
          const Logo = backendLogos[backend];
          const name = model
            ? (models.find((m) => m.id === model)?.name ?? model)
            : `${instanceName(backend) ?? kinds[backend]?.name ?? backend} default`;
          return (
            <li key={`${backend}/${model ?? ""}`} className="text-[13px]">
              <div className="flex items-center gap-2">
                {Logo && <Logo className="size-3.5 shrink-0" />}
                <span className="min-w-0 flex-1 truncate">{name}</span>
                <span className="text-muted-foreground tabular-nums">{agents}</span>
              </div>
              <div className="mt-1.5 h-1.5 rounded-full bg-selected">
                <div
                  style={{ width: `${(agents / max) * 100}%` }}
                  className="h-full rounded-full bg-accent"
                />
              </div>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

const CELL = 12;
const LEFT = 18;
const TOP = 14;
const shades = [0.3, 0.5, 0.75, 1];

/**
 * A year of days as squares, a column per week from Sunday, shaded by the agents started that
 * day relative to the busiest, then the busiest day and the shades' key.
 */
function Heatmap({ activity, now }: { activity: Activity; now: number }) {
  const today = new Date(now);
  today.setHours(0, 0, 0, 0);
  const start = new Date(today);
  start.setDate(start.getDate() - start.getDay() - (WEEKS - 1) * 7);
  // The year's busiest day, which the shades are relative to, and its total.
  const first = dayKey(start.getTime());
  let max = 1;
  let year = 0;
  for (const [day, agents] of activity.days)
    if (day >= first) {
      max = Math.max(max, agents);
      year += agents;
    }

  const cells: ReactNode[] = [];
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
      cells.push(
        <rect
          key={key}
          x={LEFT + week * CELL + 1}
          y={TOP + weekday * CELL + 1}
          width={CELL - 2}
          height={CELL - 2}
          rx={2.5}
          className={shade ? "fill-accent" : "fill-selected"}
          fillOpacity={shade || undefined}
        >
          <title>{`${agents} ${agents === 1 ? "agent" : "agents"} on ${shortDay.format(date)}`}</title>
        </rect>,
      );
    }
  }

  return (
    <section aria-label="Activity" className={`mb-8 p-5 ${card}`}>
      <div className="mb-3 flex items-baseline justify-between gap-4">
        <h2 className={heading}>Activity</h2>
        <p className="text-[12.5px] text-muted-foreground">
          {year.toLocaleString("en")} {year === 1 ? "agent" : "agents"} in the past year
        </p>
      </div>
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
        {cells}
      </svg>
      <div className="mt-3 flex items-center justify-between gap-4 text-[12px] text-muted-foreground">
        <span>
          {activity.busiest &&
            `Busiest day: ${shortDay.format(dayOf(activity.busiest.day))}, ${activity.busiest.agents} ${activity.busiest.agents === 1 ? "agent" : "agents"}`}
        </span>
        <span aria-hidden className="flex items-center gap-1 text-faint-foreground">
          Less
          <span className="size-2.5 rounded-[3px] bg-selected" />
          {shades.map((s) => (
            <span key={s} style={{ opacity: s }} className="size-2.5 rounded-[3px] bg-accent" />
          ))}
          More
        </span>
      </div>
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
    <section aria-label="Tokens" className={`mb-8 p-5 ${card}`}>
      <div className="flex items-baseline justify-between gap-4">
        <h2 className={heading}>Tokens</h2>
        <p className="text-[12.5px] text-muted-foreground">Past {TOKEN_DAYS} days</p>
      </div>
      {total > 0 ? (
        <>
          <p className="mt-1 font-brand text-2xl font-semibold tabular-nums">
            {compact.format(total)}
            <span className="ml-1 text-base font-normal text-muted-foreground">tokens</span>
          </p>
          <svg
            viewBox="0 0 100 100"
            preserveAspectRatio="none"
            className="mt-4 h-32 w-full"
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

/**
 * The account's settings: its name, which Edit changes on Clerk's account page in the browser
 * (0067), its email, and Sign out.
 */
function AccountRows({ profile }: { profile: Profile }) {
  return (
    <Section title="Account settings">
      <div className={settingRow}>
        <div className="min-w-0">
          <span className="block text-[13px] font-medium">Name</span>
          <span className="block truncate text-[12.5px] text-muted-foreground">
            {profile.name || "Shown on your profile and in the sidebar."}
          </span>
        </div>
        <button
          type="button"
          onClick={() => void window.parallax.editProfile()}
          className={outlineButton}
        >
          Edit
        </button>
      </div>
      <div className={settingRow}>
        <div className="min-w-0">
          <span className="block text-[13px] font-medium">Email</span>
          <span className="block truncate text-[12.5px] text-muted-foreground">
            {profile.email}
          </span>
        </div>
      </div>
      <div className={settingRow}>
        <div className="min-w-0">
          <span className="block text-[13px] font-medium">Sign out</span>
          <span className="block text-[12.5px] text-muted-foreground">
            Only on this computer. Your other devices stay signed in.
          </span>
        </div>
        <button
          type="button"
          onClick={() => void window.parallax.signOut()}
          className={quietButton}
        >
          Sign out
        </button>
      </div>
    </Section>
  );
}

/** A row's title and what it says, on the left of a settings row. */
function RowText({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="min-w-0">
      <span className="block text-[13px] font-medium">{title}</span>
      <span className="block text-[12.5px] text-muted-foreground">{children}</span>
    </div>
  );
}

/**
 * The Security tab: password, passkeys, devices, and Delete account. An OAuth token can't read
 * or change them (0067), so each opens Clerk's Security page in the browser. Active devices shows
 * this one, as the app knows it: Clerk lists browser sessions, not the app's sign-ins.
 */
function SecurityRows() {
  const local = useHosts().find((h) => h.id === localId)!;
  const localIcon = useConnect()?.icon ?? "laptop";
  const [version, setVersion] = useState<string>();
  useEffect(() => void window.parallax.version().then(setVersion), []);
  const electron = /Electron\/([\d.]+)/.exec(navigator.userAgent)?.[1];
  const security = () => void window.parallax.editProfile("security");
  return (
    <>
      <Section title="Sign-in">
        <div className={settingRow}>
          <RowText title="Password">Set or change the password you sign in with by email.</RowText>
          <button type="button" onClick={security} className={outlineButton}>
            Set password
          </button>
        </div>
        <div className={settingRow}>
          <RowText title="Passkeys">
            Sign in with Touch ID, Windows Hello, or a security key.
          </RowText>
          <button type="button" onClick={security} className={outlineButton}>
            Add a passkey
          </button>
        </div>
        <div className="flex gap-4 border-border px-4 py-3 not-last:border-b">
          <span className="w-40 shrink-0 text-[13px] font-medium">Active devices</span>
          <div className="min-w-0 flex-1">
            <div className="flex gap-3">
              <DeviceIcon
                icon={localIcon}
                className="mt-0.5 size-5 shrink-0 text-muted-foreground"
              />
              <div className="min-w-0 text-[12.5px] leading-6 text-muted-foreground">
                <span className="flex items-center gap-2 text-[13px] text-foreground">
                  {deviceKinds[window.parallax.platform] ?? "Computer"}
                  <span className="rounded-md border border-border bg-selected px-1.5 text-[11.5px] leading-5 text-muted-foreground">
                    This device
                  </span>
                </span>
                <span className="block truncate">{local.name}</span>
                {version && <span className="block">Parallax {version}</span>}
                {electron && <span className="block">Electron {electron}</span>}
              </div>
            </div>
            <button
              type="button"
              onClick={security}
              className="mt-2 text-[12.5px] text-accent hover:underline"
            >
              Your other devices, on Clerk
            </button>
          </div>
        </div>
      </Section>
      <Section title="Danger zone">
        <div className={settingRow}>
          <RowText title="Delete account">
            Deletes your Parallax account and signs out every device.
          </RowText>
          <button type="button" onClick={security} className={dangerOutline}>
            Delete account
          </button>
        </div>
      </Section>
    </>
  );
}

/** What kind of computer this is, by Node's platform, as Active devices names it. */
const deviceKinds: Record<string, string> = {
  darwin: "Macintosh",
  win32: "Windows PC",
  linux: "Linux PC",
};

/**
 * The Parallax Connect tab: each device added with it (0056), with its icon, address, and whether
 * this app uses it. Remove takes it off this app's list until it's added again; nothing on the
 * device changes.
 */
function ConnectRows() {
  const connect = useConnect();
  const [devices, setDevices] = useState<DeviceHost[]>([]);
  useEffect(() => window.parallax.onDevices(setDevices), []);
  if (!connect?.on)
    return (
      <p className="text-[13px] text-muted-foreground">
        Parallax Connect is off. Turn it on in Settings › Connections to add your other computers.
      </p>
    );
  if (!devices.length)
    return (
      <p className="text-[13px] text-muted-foreground">
        No computers yet. Add one from Settings › Connections.
      </p>
    );
  return (
    <Section title="Computers">
      {devices.map((d) => (
        <div key={d.id} className={settingRow}>
          <div className="flex min-w-0 items-center gap-3">
            <span className="grid size-9 shrink-0 place-items-center rounded-lg border border-border text-muted-foreground [&_svg]:size-4.5">
              <DeviceIcon icon={d.icon} />
            </span>
            <RowText title={d.name}>
              {d.hostName} · {osName(d.os)} · {d.ip}
              {!d.enabled && " · Off here"}
            </RowText>
          </div>
          <button
            type="button"
            onClick={() => void window.parallax.removeDevice(d.id)}
            className={dangerOutline}
          >
            Remove
          </button>
        </div>
      ))}
    </Section>
  );
}
