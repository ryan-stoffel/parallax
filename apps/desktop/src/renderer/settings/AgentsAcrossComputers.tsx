import { t } from "i18next";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { Trans } from "react-i18next";

import type { ConnectionState, DeviceHost } from "../../preload/bridge";
import { isRelay } from "../../preload/routeList";
import type { ProviderInfo } from "../../protocol/generated/protocol";
import { statusLabel, useRealConnections } from "../ConnectionStatus";
import {
  askComputer,
  assess,
  fullAt,
  loadBalancer,
  pickComputer,
  preferences,
  whyText,
  type Candidate,
  type Health,
  type Preference,
} from "../loadBalancer";
import { localId, type Host } from "../hosts";
import { notify } from "../notifications";
import { newThreadPrefs } from "../prefs";
import { hostIcon } from "../RunTargetMenu";
import { Picker } from "../ui";
import { badge, CollapsibleCard } from "./connectionParts";
import { StatusDot, Switch } from "./parts";

// Agents across computers (0101) in Settings > Computers: whether agents on the user's other
// computers can work on one, in its card, and the Load Balancer (PLX-1492).

/** How an account computer is reached, in words: over the relay, or directly for another route. */
export const reachOf = (route: string | undefined) =>
  route === undefined
    ? "Parallax Connect"
    : isRelay(route)
      ? t("Over Parallax Connect")
      : t("Over your network");

/**
 * `agentWork` on account computer `host`, on a plxd that has it, as a row in its opened card on
 * Settings > Computers, with why it can't take part under it: not connected, an older plxd, or added
 * with Allow alone (PLX-1402). Its `data-setting` is where a search for it lands.
 */
export function AgentWorkRow({
  host,
  device,
}: {
  host: Pick<Host, "id" | "name">;
  device: Pick<DeviceHost, "addedWithAllow">;
}) {
  const [state] = useRealConnections([host.id]);
  const able = state?.status === "connected" && "agentWork" in state.capabilities;
  const [read, setRead] = useState<{ on: boolean; relay: boolean }>();
  useEffect(() => {
    if (!able) return setRead(undefined);
    let live = true;
    void window.parallax.request(host.id, "host/settings/get", {}).then((answer) => {
      if (live && "result" in answer)
        setRead({ on: !!answer.result.agentWork, relay: !!answer.result.relay });
    });
    return () => {
      live = false;
    };
  }, [host.id, able]);
  const toggle = async (next: boolean) => {
    const answer = await window.parallax.request(host.id, "host/settings/set", {
      agentWork: next,
    });
    if ("error" in answer)
      notify({
        key: "agent-work",
        tone: "error",
        title: next
          ? t("Couldn't turn agent work on on {{name}}", { name: host.name })
          : t("Couldn't turn agent work off on {{name}}", { name: host.name }),
        body: answer.error.message,
      });
    else setRead({ on: !!answer.result.agentWork, relay: !!answer.result.relay });
  };
  const why =
    state?.status !== "connected"
      ? state
        ? statusLabel(state)
        : t("Connecting…")
      : !able
        ? t("Needs updating")
        : device.addedWithAllow
          ? t("Added with Allow, so agents can't work with it yet")
          : undefined;
  // Not connected, its card already says so above.
  const note =
    state?.status !== "connected"
      ? undefined
      : (why ?? (read?.on && !read.relay ? t("Needs Parallax Connect") : undefined));
  return (
    <div
      data-setting="agents-can-work-on"
      className="mt-2 flex flex-wrap items-center justify-between gap-x-6 gap-y-2 border-t border-border/40 pt-3"
    >
      <div className="min-w-[min(14rem,100%)] flex-1">
        <span className="block text-body font-medium">
          {t("Agents can work on {{name}}", { name: host.name })}
        </span>
        <span className="mt-0.5 block text-meta text-muted-foreground">
          {t(
            "Agents on your other computers can run commands there as you. Also turns on pairing there.",
          )}
        </span>
        {note && <span className="mt-1 block text-meta text-warning">{note}</span>}
      </div>
      <Switch
        label={t("Let agents on my other computers work on {{name}}", { name: host.name })}
        checked={!why && !!read?.on}
        disabled={!!why || !read}
        onChange={(next) => void toggle(next)}
      />
    </div>
  );
}

/** How often the Load Balancer's rows read each computer's load, while they're on screen. */
const refreshMs = 3000;

/** What a computer last answered. */
interface Reading {
  health?: Health;
  providers?: ProviderInfo[];
}

/**
 * What each of `ids` answers, every few seconds while `active`, this window is showing, and `seen`'s
 * element is on screen, and never otherwise. Only `host/health` goes every time.
 */
function useReadings(ids: string[], active: boolean, seen: { current: Element | null }) {
  const [readings, setReadings] = useState<Record<string, Reading>>({});
  const key = ids.join("\n");
  useEffect(() => {
    const element = seen.current;
    if (!active || !key || !element) return;
    const wanted = key.split("\n");
    let onScreen = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let turn = 0;
    // Providers change rarely, so only the first read asks for them again.
    let fresh = true;
    const read = async () => {
      clearTimeout(timer);
      const mine = ++turn;
      if (!onScreen || document.visibilityState === "hidden") return;
      const answers = await Promise.all(
        wanted.map(async (id) => [id, await askComputer(id, fresh)] as const),
      );
      if (mine !== turn) return;
      fresh = false;
      setReadings(Object.fromEntries(answers));
      timer = setTimeout(() => void read(), refreshMs);
    };
    const observer = new IntersectionObserver(([entry]) => {
      onScreen = !!entry?.isIntersecting;
      if (onScreen) void read();
      else {
        turn++;
        clearTimeout(timer);
      }
    });
    observer.observe(element);
    const shown = () => void read();
    document.addEventListener("visibilitychange", shown);
    return () => {
      turn++;
      clearTimeout(timer);
      observer.disconnect();
      document.removeEventListener("visibilitychange", shown);
    };
  }, [key, active, seen]);
  return readings;
}

/**
 * How much of something is in use: its name and number over a bar that fills the column. Calm until
 * it's near full: amber from 80 %, red once the Load Balancer counts it full.
 */
function Meter({ label, used, title }: { label: string; used?: number; title: string }) {
  const tone =
    used === undefined || used < 80
      ? "bg-muted-foreground/70"
      : used < fullAt
        ? "bg-warning"
        : "bg-danger";
  return (
    <div title={title} className="min-w-0">
      <div className="flex items-baseline justify-between gap-2 text-meta text-muted-foreground">
        <span>{label}</span>
        <span className="text-foreground tabular-nums">
          {used === undefined ? "–" : `${used}%`}
        </span>
      </div>
      <div
        role="meter"
        aria-label={label}
        aria-valuenow={used ?? 0}
        aria-valuemin={0}
        aria-valuemax={100}
        className="mt-1 h-1.5 overflow-hidden rounded-full bg-foreground/10"
      >
        <div
          className={`h-full rounded-full transition-[width] duration-500 motion-reduce:transition-none ${tone}`}
          style={{ width: `${used ?? 0}%` }}
        />
      </div>
    </div>
  );
}

/** One computer's place in the Load Balancer, or nothing for a computer it doesn't list. */
interface Balanced {
  candidate: Candidate;
  /** Whether it has answered, or doesn't need to: it's left out or offline. */
  read: boolean;
  connection?: ConnectionState;
}

/** The Load Balancer as Settings > Computers shows it: its pick, and each computer's place. */
export interface Balancer {
  /** On, with two or more computers to balance. */
  on: boolean;
  /** The computer the next thread goes to. */
  pick?: string;
  /** Still waiting for a computer's first answer. */
  reading: boolean;
  everyOneOut: boolean;
  of: (hostId: string) => Balanced | undefined;
}

/**
 * The Load Balancer over `hosts` (0101): where the next thread goes and what each computer is doing
 * now. Its pick comes from the same scoring a new draft uses, with the default provider. It can't
 * know the next thread's repository. The computers are read only while `seen` is on screen.
 */
export function useBalancer(hosts: Host[], seen: { current: Element | null }): Balancer {
  const settings = loadBalancer.use();
  const provider = newThreadPrefs.use().model?.provider;
  const connections = useRealConnections(hosts.map((h) => h.id));
  const on = settings.on && hosts.length >= 2;
  const asked = hosts.filter(
    (h, i) => connections[i]?.status === "connected" && !settings.leftOut.includes(h.id),
  );
  const readings = useReadings(
    asked.map((h) => h.id),
    on,
    seen,
  );
  const candidates = hosts.map((h, i): Candidate => ({
    id: h.id,
    preference: settings.preferences[h.id] ?? "normal",
    barred: settings.leftOut.includes(h.id)
      ? "left-out"
      : connections[i]?.status !== "connected"
        ? "offline"
        : undefined,
    ...readings[h.id],
    provider,
  }));
  return {
    on,
    pick: on ? pickComputer(candidates) : undefined,
    reading: asked.some((h) => !readings[h.id]),
    everyOneOut: hosts.every((h) => settings.leftOut.includes(h.id)),
    of: (hostId) => {
      const i = hosts.findIndex((h) => h.id === hostId);
      const candidate = candidates[i];
      return candidate
        ? {
            candidate,
            read: candidate.barred ? true : !!readings[hostId],
            connection: connections[i],
          }
        : undefined;
    },
  };
}

/** What the Load Balancer says of computer `hostId` beside its name. */
function balancerBadge(balancer: Balancer, hostId: string): ReactNode {
  const row = balancer.of(hostId);
  if (!row) return null;
  if (hostId === balancer.pick)
    return <span className={`${badge} text-muted-foreground`}>{t("Next")}</span>;
  if (row.candidate.barred === "left-out")
    return <span className={`${badge} text-faint-foreground`}>{t("Left out")}</span>;
  const verdict = assess(row.candidate);
  return "why" in verdict && verdict.why === "full" ? (
    <span className={`${badge} text-warning`}>{t("Full")}</span>
  ) : null;
}

/**
 * One computer in the Load Balancer's card: its name and whether it's next, full or left out, with
 * how often it takes new threads and whether it takes part at the end of that line. Under them, what
 * it's running and its CPU and memory as two bars. A computer that can't take a thread says why in
 * their place, and one that isn't connected is greyed.
 */
function BalancerRow({ host, balancer }: { host: Host; balancer: Balancer }) {
  const settings = loadBalancer.use();
  const row = balancer.of(host.id);
  if (!row) return null;
  const { candidate, read, connection } = row;
  const leftOut = settings.leftOut.includes(host.id);
  const verdict = assess(candidate);
  const why = "why" in verdict ? verdict.why : undefined;
  const load = candidate.health?.load;
  const agents = candidate.health?.runningAgents;
  const offline = why === "offline";
  // Anything but a load to show says so in place of its bars.
  const instead =
    !read || !why || why === "full"
      ? undefined
      : offline && connection
        ? statusLabel(connection)
        : t(whyText[why]);
  const facts = [
    host.id === localId && t("This computer"),
    // Left out, its mark by its name says so.
    !leftOut && instead,
    !leftOut &&
      !instead &&
      agents !== undefined &&
      t("{{count}} agents", { count: agents, defaultValue_one: "{{count}} agent" }),
  ].filter(Boolean);
  const bars = !leftOut && !instead;
  return (
    <li className="border-border/40 px-4 py-3 not-last:border-b">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <div
          className={`flex min-w-[min(12rem,100%)] flex-1 items-center gap-3 ${offline || leftOut ? "opacity-55" : ""}`}
        >
          <span className="shrink-0 text-muted-foreground [&_svg]:size-5">{hostIcon(host)}</span>
          <div className="min-w-0 flex-1">
            <p className="flex items-center gap-2 text-body font-medium">
              <span className="truncate">{host.name}</span>
              {balancerBadge(balancer, host.id)}
            </p>
            {facts.length > 0 && (
              <p className="mt-0.5 flex items-center gap-1.5 text-meta text-muted-foreground">
                {offline && !leftOut && <StatusDot tone="off" />}
                {facts.join(" · ")}
              </p>
            )}
          </div>
        </div>
        <div className="ml-auto flex shrink-0 items-center gap-3">
          <Picker
            field
            label={t("How often {{name}} takes new threads", { name: host.name })}
            options={preferences.map((p) => ({ value: p.value, label: t(p.name) }))}
            value={candidate.preference}
            disabled={leftOut}
            align="end"
            className="w-28"
            onChange={(value) =>
              loadBalancer.set({
                ...settings,
                preferences: { ...settings.preferences, [host.id]: value as Preference },
              })
            }
          />
          <Switch
            label={t("Balance new threads onto {{name}}", { name: host.name })}
            checked={!leftOut}
            onChange={(on) =>
              loadBalancer.set({
                ...settings,
                leftOut: on
                  ? settings.leftOut.filter((id) => id !== host.id)
                  : [...settings.leftOut, host.id],
              })
            }
          />
        </div>
      </div>
      {bars && (
        // Side by side while there's room, one over the other on a narrow card.
        <div className="mt-2 ml-8 grid max-w-md grid-cols-[repeat(auto-fit,minmax(9rem,1fr))] gap-x-6 gap-y-2">
          <Meter
            label={t("CPU")}
            used={load?.cpu}
            title={
              load
                ? t("CPU {{cpu}}% in use, across {{count}} cores", {
                    cpu: load.cpu,
                    count: load.cores,
                    defaultValue_one: "CPU {{cpu}}% in use, across {{count}} core",
                  })
                : t("CPU")
            }
          />
          <Meter
            label={t("Memory")}
            used={load?.memory}
            title={load ? t("Memory {{memory}}% in use", { memory: load.memory }) : t("Memory")}
          />
        </div>
      )}
    </li>
  );
}

/**
 * Settings > Computers' Load Balancer (0101), with two or more computers, as a card that opens and
 * closes: its switch and where the next thread goes in its heading, then what it does, and while
 * it's on, each computer with its weight. The computers are read only while the card is on screen.
 */
export function LoadBalancerCard({ hosts }: { hosts: Host[] }) {
  const settings = loadBalancer.use();
  const seen = useRef<HTMLElement>(null);
  const balancer = useBalancer(hosts, seen);
  if (hosts.length < 2) return null;
  const { pick } = balancer;
  return (
    <CollapsibleCard
      ref={seen}
      title={t("Load Balancer")}
      summary={
        <span aria-live="polite" title={pick && t("If it has the thread's repository")}>
          {!settings.on ? null : pick ? (
            <Trans values={{ name: hosts.find((h) => h.id === pick)?.name ?? "" }}>
              Next thread goes to <span className="text-foreground">{"{{name}}"}</span>
            </Trans>
          ) : balancer.reading ? (
            t("Checking your computers…")
          ) : balancer.everyOneOut ? (
            <span className="text-warning">{t("Every computer is left out. Turn one on.")}</span>
          ) : (
            <span className="text-warning">{t("No computer can take a thread right now.")}</span>
          )}
        </span>
      }
      action={
        <Switch
          label={t("Balance new threads across my computers")}
          checked={settings.on}
          onChange={(on) => loadBalancer.set({ ...settings, on })}
        />
      }
    >
      <p className="border-border/40 px-4 py-3 text-meta text-muted-foreground not-last:border-b">
        {t("Start each new thread on the computer with the most free CPU and memory.")}
      </p>
      {balancer.on && (
        <ul aria-label={t("Computers the Load Balancer uses")}>
          {hosts.map((h) => (
            <BalancerRow key={h.id} host={h} balancer={balancer} />
          ))}
        </ul>
      )}
    </CollapsibleCard>
  );
}
