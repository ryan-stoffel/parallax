import { useEffect, useState, type ReactNode } from "react";

import type { ConnectionState, DeviceHost } from "../../preload/bridge";
import { isRelay } from "../../preload/routeList";
import type { ProviderInfo } from "../../protocol/generated/protocol";
import { statusLabel, useRealConnections } from "../ConnectionStatus";
import type { Host } from "../hosts";
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
import { notify } from "../notifications";
import { newThreadPrefs } from "../prefs";
import { Picker } from "../ui";
import { AccessRow, badge, ComputerSetting } from "./connectionParts";
import { Section, Switch } from "./parts";

// Agents across computers (0101) in Settings > Connections: whether agents on the user's other
// computers can work on one, and the Load Balancer. Each computer's part is one of its own
// settings, in its row (PLX-1492).

/** How an account computer is reached, in words: over the relay, or directly for another route. */
export const reachOf = (route: string | undefined) =>
  route === undefined
    ? "Parallax Connect"
    : isRelay(route)
      ? "Over Parallax Relay"
      : "Over your network";

/**
 * `agentWork` on account computer `host`, on a plxd that has it, as one of its settings, with why
 * it can't take part as its note: not connected, an older plxd, or added with Allow alone
 * (PLX-1402).
 */
export function AgentWorkSetting({
  host,
  device,
}: {
  host: Host;
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
        title: `Couldn't turn agent work ${next ? "on" : "off"} on ${host.name}`,
        body: answer.error.message,
      });
    else setRead({ on: !!answer.result.agentWork, relay: !!answer.result.relay });
  };
  const why =
    state?.status !== "connected"
      ? state
        ? statusLabel(state)
        : "Connecting…"
      : !able
        ? "Needs updating"
        : device.addedWithAllow
          ? "Added with Allow, so agents can't work with it yet"
          : undefined;
  return (
    <ComputerSetting
      title="Agents can work here"
      note={
        why ??
        (read?.on && !read.relay
          ? "Needs Reach from anywhere"
          : "Agents on your other computers can run commands there as you. Also turns on pairing there.")
      }
    >
      <Switch
        label={`Let agents on my other computers work on ${host.name}`}
        checked={!why && !!read?.on}
        disabled={!!why || !read}
        onChange={(next) => void toggle(next)}
      />
    </ComputerSetting>
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

/** How much of something is in use: its name, a short thin bar, and the exact number. */
function Meter({ label, used, title }: { label: string; used?: number; title: string }) {
  const tone =
    used === undefined || used < 80
      ? "bg-muted-foreground/60"
      : used < fullAt
        ? "bg-warning"
        : "bg-danger";
  return (
    <span
      title={title}
      className={`inline-flex shrink-0 items-center gap-1.5 ${label === "CPU" ? "w-[6.25rem]" : "w-[8rem]"}`}
    >
      {label}
      <span className="h-[3px] w-8 overflow-hidden rounded-full bg-foreground/15">
        <span
          className={`block h-full rounded-full transition-[width] duration-500 motion-reduce:transition-none ${tone}`}
          style={{ width: `${used ?? 0}%` }}
        />
      </span>
      <span className="tabular-nums">{used === undefined ? "–" : `${used}%`}</span>
    </span>
  );
}

/** One computer's place in the Load Balancer, or nothing for a computer it doesn't list. */
interface Balanced {
  candidate: Candidate;
  /** Whether it has answered, or doesn't need to: it's left out or offline. */
  read: boolean;
  connection?: ConnectionState;
}

/** The Load Balancer as Settings > Connections shows it: its pick, and each computer's place. */
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

/** What the Load Balancer says of computer `hostId` beside its name, while it's on. */
export function balancerBadge(balancer: Balancer, hostId: string): ReactNode {
  const row = balancer.on ? balancer.of(hostId) : undefined;
  if (!row) return null;
  if (hostId === balancer.pick)
    return <span className={`${badge} text-muted-foreground`}>Next</span>;
  if (row.candidate.barred === "left-out")
    return <span className={`${badge} text-faint-foreground`}>Left out</span>;
  const verdict = assess(row.candidate);
  return "why" in verdict && verdict.why === "full" ? (
    <span className={`${badge} text-warning`}>Full</span>
  ) : null;
}

/**
 * One computer in the Load Balancer, as one of its settings while the balancer is on: what it's
 * doing now, how often it takes new threads, and whether it takes part.
 */
export function BalancerSetting({
  host,
  balancer,
  card,
}: {
  host: Host;
  balancer: Balancer;
  /** Draws it as a row of a card, as this computer's is, not as a setting in an opened row. */
  card?: boolean;
}) {
  const settings = loadBalancer.use();
  const row = balancer.on ? balancer.of(host.id) : undefined;
  if (!row) return null;
  const { candidate, read, connection } = row;
  const leftOut = settings.leftOut.includes(host.id);
  const verdict = assess(candidate);
  const why = "why" in verdict ? verdict.why : undefined;
  const load = candidate.health?.load;
  const agents = candidate.health?.runningAgents;
  // Anything but a load to show says so in place of its meters.
  const instead =
    !read || !why || why === "full"
      ? undefined
      : why === "offline" && connection
        ? statusLabel(connection)
        : whyText[why];
  const note =
    instead || (leftOut && !read) ? (
      (instead ?? whyText["left-out"])
    ) : (
      <span className="flex flex-wrap items-center gap-x-3">
        <Meter
          label="CPU"
          used={load?.cpu}
          title={load ? `CPU ${load.cpu}% in use, across ${load.cores} cores` : "CPU"}
        />
        <Meter
          label="Memory"
          used={load?.memory}
          title={load ? `Memory ${load.memory}% in use` : "Memory"}
        />
        {agents !== undefined && (
          <span>
            {agents} {agents === 1 ? "agent" : "agents"}
          </span>
        )}
      </span>
    );
  const controls = (
    <>
      <Picker
        field
        label={`How often ${host.name} takes new threads`}
        options={preferences.map((p) => ({ value: p.value, label: p.name }))}
        value={candidate.preference}
        disabled={leftOut}
        align="end"
        className="w-32"
        onChange={(value) =>
          loadBalancer.set({
            ...settings,
            preferences: { ...settings.preferences, [host.id]: value as Preference },
          })
        }
      />
      <Switch
        label={`Balance new threads onto ${host.name}`}
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
    </>
  );
  return card ? (
    <AccessRow title="Load Balancer" anchor="this-computer-load-balancer" description={note}>
      {controls}
    </AccessRow>
  ) : (
    <ComputerSetting title="Load Balancer" note={note}>
      {controls}
    </ComputerSetting>
  );
}

/**
 * Settings > Connections' Load Balancer (0101), with two or more computers: its switch, and where
 * the next thread goes. Each computer's part is in its own row (`BalancerSetting`).
 */
export function LoadBalancerSettings({ hosts, balancer }: { hosts: Host[]; balancer: Balancer }) {
  const settings = loadBalancer.use();
  if (hosts.length < 2) return null;
  const { pick } = balancer;
  return (
    <Section title="Load Balancer">
      <AccessRow
        title="Balance new threads"
        description={
          <span aria-live="polite" title={pick && "If it has the thread's repository"}>
            {!settings.on ? (
              "Start each new thread on the computer with the most free CPU and memory."
            ) : pick ? (
              <>
                Next thread goes to{" "}
                <span className="text-foreground">{hosts.find((h) => h.id === pick)?.name}</span>
              </>
            ) : balancer.reading ? (
              "Checking your computers…"
            ) : balancer.everyOneOut ? (
              <span className="text-warning">Every computer is left out. Turn one on.</span>
            ) : (
              <span className="text-warning">No computer can take a thread right now.</span>
            )}
          </span>
        }
      >
        <Switch
          label="Balance new threads across my computers"
          checked={settings.on}
          onChange={(on) => loadBalancer.set({ ...settings, on })}
        />
      </AccessRow>
    </Section>
  );
}
