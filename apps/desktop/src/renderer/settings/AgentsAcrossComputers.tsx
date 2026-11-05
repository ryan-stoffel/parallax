import { useEffect, useRef, useState, type ReactNode } from "react";

import type { ConnectionState, DeviceHost } from "../../preload/bridge";
import { isRelay } from "../../preload/routeList";
import type { ProviderInfo } from "../../protocol/generated/protocol";
import { statusLabel, useRealConnections } from "../ConnectionStatus";
import { localId, useHosts, type Host } from "../hosts";
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
import { connection, hostIcon } from "../RunTargetMenu";
import { Picker } from "../ui";
import { Row, Section, settingRow, Switch } from "./parts";

/**
 * A computer as a settings row: its own icon, its name over `detail`, and `children`, its controls,
 * at the end, in the page's row (`settingRow`). `quiet` dims what it says about the computer.
 */
function ComputerRow({
  host,
  badge,
  detail,
  quiet,
  next,
  children,
}: {
  host: Host;
  badge?: ReactNode;
  detail: ReactNode;
  quiet?: boolean;
  next?: boolean;
  children: ReactNode;
}) {
  return (
    <div data-computer={host.id} data-next={next || undefined} className={settingRow}>
      <div className={`flex min-w-0 flex-1 items-center gap-3 ${quiet ? "opacity-50" : ""}`}>
        <span className="shrink-0 text-muted-foreground [&_svg]:size-5">{hostIcon(host)}</span>
        <div className="min-w-0 flex-1">
          <span className="flex items-center gap-2 text-body font-medium">
            <span className="truncate">{host.name}</span>
            {badge}
          </span>
          <span className="mt-0.5 block truncate text-meta text-muted-foreground">{detail}</span>
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-2">{children}</div>
    </div>
  );
}

/** A small label after a computer's name, as Settings draws one. */
const label = "rounded-sm bg-hover px-1.5 py-px text-caption font-normal";

/** The account's computers and tailnet devices, kept current. */
function useDevices() {
  const [devices, setDevices] = useState<DeviceHost[]>([]);
  useEffect(() => window.parallax.onDevices(setDevices), []);
  return devices;
}

/** How `host` is reached, in words: over the relay, or directly for a route of another kind. */
function reachOf(host: Host, devices: readonly DeviceHost[]) {
  const route = devices.find((d) => d.id === host.id)?.route;
  if (route === undefined) return connection(host);
  return isRelay(route) ? "Over Parallax Relay" : "Over your network";
}

/**
 * `agentWork` on an account computer, on a plxd that has it, with why it can't take part as its
 * note: not connected, an older plxd, or added with Allow alone (PLX-1402).
 */
function OtherAgentWork({
  host,
  reach,
  allowedOnly,
}: {
  host: Host;
  reach: string;
  allowedOnly: boolean;
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
        : allowedOnly
          ? "Added with Allow, so agents can't work with it yet"
          : undefined;
  return (
    <ComputerRow
      host={host}
      quiet={!!why}
      detail={why ?? (read?.on && !read.relay ? "Needs Reach from anywhere" : reach)}
    >
      <Switch
        label={`Let agents on my other computers work on ${host.name}`}
        checked={!why && !!read?.on}
        disabled={!!why || !read}
        onChange={(next) => void toggle(next)}
      />
    </ComputerRow>
  );
}

/**
 * Settings > Connections' Agents can work here (0101): this computer and each account computer on
 * one list, each with its `agentWork`. `local` is this computer's, which LanSettings holds, since
 * it and pairing change each other.
 */
export function AgentWorkSettings({
  local,
}: {
  local?: { on: boolean; relay: boolean; toggle: (next: boolean) => void };
}) {
  const hosts = useHosts();
  const devices = useDevices();
  const here = hosts.find((h) => h.id === localId);
  const others = hosts.filter((h) => h.id.startsWith("account:"));
  if (!here || (!local && others.length === 0)) return null;
  return (
    <Section title="Agents can work here">
      <p className="border-b border-border/40 px-4 py-3 text-meta text-muted-foreground">
        Agents on your other computers can run commands on these as you. This also turns on pairing.
      </p>
      {local && (
        <ComputerRow
          host={here}
          detail={local.on && !local.relay ? "Needs Reach from anywhere" : "This computer"}
        >
          <Switch
            label="Let agents on my other computers work here"
            checked={local.on}
            onChange={local.toggle}
          />
        </ComputerRow>
      )}
      {others.map((h) => (
        <OtherAgentWork
          key={h.id}
          host={h}
          reach={reachOf(h, devices)}
          allowedOnly={!!devices.find((d) => d.id === h.id)?.addedWithAllow}
        />
      ))}
    </Section>
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

/** One computer in the Load Balancer: what it's doing now, its preference, and whether it takes part. */
function BalancedRow({
  host,
  candidate,
  next,
  read,
  connection: state,
}: {
  host: Host;
  candidate: Candidate;
  next: boolean;
  read: boolean;
  connection?: ConnectionState;
}) {
  const settings = loadBalancer.use();
  const leftOut = settings.leftOut.includes(host.id);
  const verdict = assess(candidate);
  const why = "why" in verdict ? verdict.why : undefined;
  const load = candidate.health?.load;
  const agents = candidate.health?.runningAgents;
  // Anything but a load to show says so in place of its meters, so a row's columns stay put.
  const instead =
    !read || !why || why === "full"
      ? undefined
      : why === "offline" && state
        ? statusLabel(state)
        : whyText[why];
  return (
    <ComputerRow
      host={host}
      quiet={leftOut}
      next={next}
      badge={
        next ? (
          <span className={`${label} text-muted-foreground`}>Next</span>
        ) : why === "full" ? (
          <span className={`${label} text-warning`}>Full</span>
        ) : undefined
      }
      detail={
        // Anything but a load says so in place of it.
        instead || (leftOut && !read) ? (
          (instead ?? whyText["left-out"])
        ) : (
          <span className="flex items-center gap-3">
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
        )
      }
    >
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
    </ComputerRow>
  );
}

/**
 * Settings > Connections' Load Balancer (0101), with two or more computers: where the next thread
 * goes, what each computer is doing now, and whether it takes part. Its pick comes from the same
 * scoring a new draft uses, with the default provider. It can't know the next thread's repository.
 */
export function LoadBalancerSettings() {
  const hosts = useHosts();
  const settings = loadBalancer.use();
  const provider = newThreadPrefs.use().model?.provider;
  const connections = useRealConnections(hosts.map((h) => h.id));
  const section = useRef<HTMLDivElement>(null);
  const asked = hosts.filter(
    (h, i) => connections[i]?.status === "connected" && !settings.leftOut.includes(h.id),
  );
  const readings = useReadings(
    asked.map((h) => h.id),
    settings.on,
    section,
  );
  if (hosts.length < 2) return null;
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
  const pick = pickComputer(candidates);
  const reading = asked.some((h) => !readings[h.id]);
  const everyOneOut = hosts.every((h) => settings.leftOut.includes(h.id));
  return (
    <div ref={section}>
      <Section title="Load Balancer">
        <Row
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
              ) : reading ? (
                "Checking your computers…"
              ) : everyOneOut ? (
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
        </Row>
        {settings.on &&
          hosts.map((h, i) => (
            <BalancedRow
              key={h.id}
              host={h}
              candidate={candidates[i]!}
              next={h.id === pick}
              read={!candidates[i]!.barred ? !!readings[h.id] : true}
              connection={connections[i]}
            />
          ))}
      </Section>
    </div>
  );
}
