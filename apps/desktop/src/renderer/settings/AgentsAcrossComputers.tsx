import { Bot, Scale } from "lucide-react";
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
import { Segmented } from "../ui";
import { Section, Switch } from "./parts";

/** A computer's icon and name, then `note` muted on the same line. */
function ComputerName({
  host,
  note,
  quiet,
  order,
}: {
  host: Host;
  note?: ReactNode;
  quiet?: boolean;
  order?: boolean;
}) {
  return (
    <div
      className={`flex min-w-0 flex-1 items-center gap-2.5 ${order ? "order-1" : ""} ${quiet ? "opacity-50" : ""}`}
    >
      <span className="shrink-0 text-muted-foreground [&_img]:size-4 [&_svg]:size-4">
        {hostIcon(host)}
      </span>
      <span className="truncate text-body font-medium">{host.name}</span>
      {note && <span className="shrink-[4] truncate text-meta text-muted-foreground">{note}</span>}
    </div>
  );
}

const computerRow =
  "flex min-h-11 flex-wrap items-center gap-x-4 gap-y-2 border-border/40 px-4 py-2 not-last:border-b";

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
    <div data-computer={host.id} className={computerRow}>
      <ComputerName
        host={host}
        quiet={!!why}
        note={why ?? (read?.on && !read.relay ? "Needs Reach from anywhere" : reach)}
      />
      <Switch
        label={`Let agents on my other computers work on ${host.name}`}
        checked={!why && !!read?.on}
        disabled={!!why || !read}
        onChange={(next) => void toggle(next)}
      />
    </div>
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
      <p className="border-b border-border/40 px-4 py-2.5 text-meta text-muted-foreground">
        Agents on your other computers can run commands on these as you. This also turns on pairing.
      </p>
      {local && (
        <div data-computer={here.id} className={computerRow}>
          <ComputerName
            host={here}
            note={local.on && !local.relay ? "Needs Reach from anywhere" : "This computer"}
          />
          <Switch
            label="Let agents on my other computers work here"
            checked={local.on}
            onChange={local.toggle}
          />
        </div>
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

/** A thin meter of how much of something is in use, with the exact number. */
function Meter({ label, used, title }: { label: string; used?: number; title: string }) {
  const tone =
    used === undefined || used < 80
      ? "bg-muted-foreground/70"
      : used < fullAt
        ? "bg-warning"
        : "bg-danger";
  return (
    <div title={title} className="w-[4.75rem] shrink-0">
      <div className="flex items-baseline justify-between text-caption text-faint-foreground">
        {label}
        <span className="text-meta text-muted-foreground tabular-nums">
          {used === undefined ? "–" : `${used}%`}
        </span>
      </div>
      <div className="mt-1 h-[3px] overflow-hidden rounded-full bg-foreground/10">
        <div
          className={`h-full rounded-full transition-[width] duration-500 motion-reduce:transition-none ${tone}`}
          style={{ width: `${used ?? 0}%` }}
        />
      </div>
    </div>
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
    <div data-computer={host.id} data-next={next || undefined} className={computerRow}>
      <ComputerName
        host={host}
        quiet={leftOut}
        order
        note={
          next ? (
            <span className="font-medium text-accent">Next</span>
          ) : why === "full" ? (
            <span className="font-medium text-warning">Full</span>
          ) : undefined
        }
      />
      {/* On one line with room for it, and under the name without. */}
      <div className="order-3 flex w-full flex-wrap items-center justify-between gap-x-4 gap-y-2 @[41rem]:order-2 @[41rem]:w-auto @[41rem]:flex-nowrap">
        <div className={`flex shrink-0 items-center gap-3.5 ${leftOut ? "opacity-50" : ""}`}>
          {instead || (leftOut && !read) ? (
            <span className="w-[11.5rem] text-right text-meta text-muted-foreground">
              {instead ?? whyText["left-out"]}
            </span>
          ) : (
            <>
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
            </>
          )}
          {/* Its room stays when there's nothing to say, so a row's columns stay put. */}
          <span
            title={agents === undefined ? undefined : `${agents} running`}
            aria-label={agents === undefined ? undefined : `${agents} agents running`}
            className={`flex w-9 items-center justify-end gap-1 text-meta text-muted-foreground tabular-nums [&_svg]:size-3.5 ${agents === undefined ? "invisible" : ""}`}
          >
            <Bot aria-hidden />
            {agents}
          </span>
        </div>
        <Segmented
          small
          label={`How often ${host.name} takes new threads`}
          options={preferences}
          value={candidate.preference}
          disabled={leftOut}
          onChange={(value: Preference) =>
            loadBalancer.set({
              ...settings,
              preferences: { ...settings.preferences, [host.id]: value },
            })
          }
        />
      </div>
      <span className="order-2 flex @[41rem]:order-3">
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
      </span>
    </div>
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
      <Section
        title="Load Balancer"
        icon={<Scale aria-hidden />}
        action={
          <Switch
            label="Balance new threads across my computers"
            checked={settings.on}
            onChange={(on) => loadBalancer.set({ ...settings, on })}
          />
        }
      >
        <p
          aria-live="polite"
          title={pick && "If it has the thread's repository"}
          className={`px-4 py-3 text-body ${settings.on ? "border-b border-border/40" : "text-muted-foreground"}`}
        >
          {!settings.on ? (
            "New threads stay on the computer you pick."
          ) : pick ? (
            <>
              Next thread goes to{" "}
              <span className="font-medium">{hosts.find((h) => h.id === pick)?.name}</span>
            </>
          ) : reading ? (
            <span className="text-muted-foreground">Checking your computers…</span>
          ) : everyOneOut ? (
            <span className="text-warning">Every computer is left out. Turn one on.</span>
          ) : (
            <span className="text-warning">No computer can take a thread right now.</span>
          )}
        </p>
        {settings.on && (
          <div className="@container">
            {hosts.map((h, i) => (
              <BalancedRow
                key={h.id}
                host={h}
                candidate={candidates[i]!}
                next={h.id === pick}
                read={!candidates[i]!.barred ? !!readings[h.id] : true}
                connection={connections[i]}
              />
            ))}
          </div>
        )}
      </Section>
    </div>
  );
}
