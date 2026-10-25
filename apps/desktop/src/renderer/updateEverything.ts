import { useEffect, useRef, useState, useSyncExternalStore } from "react";

import { isOlder } from "../main/hostUpdate";
import type { ConnectionState, UpdateState } from "../preload/bridge";
import type { CliKind, ProviderUpdate } from "../protocol/generated/protocol";
import { describeError } from "./errors";
import { localId, useHosts, type Host } from "./hosts";
import { notify } from "./notifications";
import { merged, stored } from "./stored";

// Update everything (PLX-746), as T3 Code's: the app, every remote host's plxd, and every host's
// Claude Code and Codex, reviewed in one dialog behind the sidebar's Update button (PLX-783).

/** How the updater behaves, kept on this computer (PLX-783), set in Settings > General. */
export type UpdatePrefs = {
  /** Download a Parallax release as soon as it's found, so Update only restarts. */
  autoDownload: boolean;
  /** Check each host's Claude Code and Codex for newer releases. */
  providers: boolean;
  /** Update those as soon as a newer release is found. Their running threads keep going. */
  autoProviders: boolean;
};

export const updatePrefs = stored<UpdatePrefs>(
  "parallax.updates",
  { autoDownload: false, providers: true, autoProviders: false },
  merged,
);

/** What updating everything changes on one host. */
export type HostPlan = {
  hostId: string;
  name: string;
  /** The version a remote host's older plxd goes to. */
  server?: string;
  /** The version its plxd is on now, for `server`. */
  plxd?: string;
  /** The version this computer's app goes to. */
  app?: string;
  /** Its agent CLIs with newer releases. */
  providers: ProviderUpdate[];
};

const cliNames: Record<CliKind, string> = {
  claude: "Claude Code",
  codex: "Codex",
  cursor: "Cursor",
};

/** Hosts whose plxd restarts: a remote one for its update, this computer for the app's. */
export const restarts = (plan: HostPlan) => plan.server !== undefined || plan.app !== undefined;

const count = (n: number, noun: string) => `${n} ${noun}${n === 1 ? "" : "s"}`;

/** "2 servers and 2 providers", counting this computer's app as a server, as T3 Code does. */
export function planSummary(plans: HostPlan[]): string {
  const servers = plans.filter(restarts).length;
  const providers = plans.reduce((n, plan) => n + plan.providers.length, 0);
  const parts = [servers && count(servers, "server"), providers && count(providers, "provider")];
  return parts.filter(Boolean).join(" and ");
}

/** One thing to update, as the Update card and dialog list it. */
export type UpdateItem = {
  /** `app`, `server/<host>`, or `provider/<host>/<cli>`. */
  key: string;
  kind: "app" | "server" | "provider";
  hostId: string;
  /** The host's name. */
  host: string;
  cli?: CliKind;
  /** "Parallax", "plxd", or the CLI's name. */
  name: string;
  /** The version on now, when known. */
  from?: string;
  to: string;
};

/** Each plan's updates as items: per host, the app or its plxd, then its providers. */
export function planItems(plans: HostPlan[], appVersion?: string): UpdateItem[] {
  return plans.flatMap(({ hostId, name: host, server, plxd, app, providers }) => [
    ...(app
      ? [
          {
            key: "app",
            kind: "app" as const,
            hostId,
            host,
            name: "Parallax",
            from: appVersion,
            to: app,
          },
        ]
      : []),
    ...(server
      ? [
          {
            key: `server/${hostId}`,
            kind: "server" as const,
            hostId,
            host,
            name: "plxd",
            from: plxd,
            to: server,
          },
        ]
      : []),
    ...providers.map(({ cli, version, latest }) => ({
      key: `provider/${hostId}/${cli}`,
      kind: "provider" as const,
      hostId,
      host,
      cli,
      name: cliNames[cli] ?? cli,
      from: version,
      to: latest,
    })),
  ]);
}

/** The plans with only `keys`' items left in them, and hosts left with none dropped. */
export function selectPlans(plans: HostPlan[], keys: ReadonlySet<string>): HostPlan[] {
  return plans.flatMap((plan) => {
    const kept: HostPlan = {
      ...plan,
      server: keys.has(`server/${plan.hostId}`) ? plan.server : undefined,
      app: keys.has("app") ? plan.app : undefined,
      providers: plan.providers.filter((p) => keys.has(`provider/${plan.hostId}/${p.cli}`)),
    };
    return restarts(kept) || kept.providers.length > 0 ? [kept] : [];
  });
}

/**
 * Each host with something to update, in the sidebar's order. `target` is the version remote
 * hosts' plxd goes to, `app` the app's next release.
 */
export function buildPlan(
  hosts: Host[],
  states: Record<string, ConnectionState>,
  providers: Record<string, ProviderUpdate[]>,
  target: string | undefined,
  app: string | undefined,
): HostPlan[] {
  return hosts.flatMap(({ id, name }) => {
    const state = states[id];
    const connected = state?.status === "connected" ? state : undefined;
    const server =
      id !== localId &&
      target !== undefined &&
      connected !== undefined &&
      // A plxd with `providerUpdates` also takes `host/update`'s `now`; an older one is left to
      // the usual update once its agents finish (`HostUpdater`).
      "hostUpdate" in connected.capabilities &&
      "providerUpdates" in connected.capabilities &&
      isOlder(connected.plxd, target)
        ? target
        : undefined;
    const plan: HostPlan = {
      hostId: id,
      name,
      ...(server && { server, plxd: connected?.plxd }),
      ...(id === localId && app && { app }),
      providers: (connected && providers[id]) ?? [],
    };
    return restarts(plan) || plan.providers.length > 0 ? [plan] : [];
  });
}

/** How often each host's providers are checked for releases. */
const CHECK_MS = 30 * 60_000;

/**
 * What Update everything would do now, kept current: each host's providers are checked when it
 * connects and every 30 minutes, unless `updatePrefs.providers` is off. `refresh` checks one
 * host's again; `upgraded` drops a provider that just updated and checks its host again. A check
 * that answers after a later one started is dropped, so it can't bring back an updated provider.
 */
export function useUpdatePlan(update: UpdateState) {
  const hosts = useHosts();
  const prefs = updatePrefs.use();
  const [version, setVersion] = useState<string>();
  const [states, setStates] = useState<Record<string, ConnectionState>>({});
  const [providers, setProviders] = useState<Record<string, ProviderUpdate[]>>({});
  const checks = useRef<Record<string, number>>({});
  useEffect(() => void window.parallax.version().then(setVersion), []);

  const refresh = async (hostId: string) => {
    const check = (checks.current[hostId] ?? 0) + 1;
    checks.current[hostId] = check;
    const answer = await window.parallax.request(hostId, "providers/updates", {});
    if (checks.current[hostId] !== check) return;
    if ("result" in answer) setProviders((old) => ({ ...old, [hostId]: answer.result.updates }));
  };
  const upgraded = (hostId: string, cli: CliKind) => {
    checks.current[hostId] = (checks.current[hostId] ?? 0) + 1;
    setProviders((old) => ({ ...old, [hostId]: (old[hostId] ?? []).filter((p) => p.cli !== cli) }));
    void refresh(hostId);
  };

  useEffect(() => {
    const ids = new Set(hosts.map((h) => h.id));
    const known: Record<string, ConnectionState> = {};
    const checkable = (state: ConnectionState) =>
      prefs.providers && state.status === "connected" && "providerUpdates" in state.capabilities;
    const check = (hostId: string, state: ConnectionState) => {
      if (!ids.has(hostId)) return;
      known[hostId] = state;
      setStates((old) => ({ ...old, [hostId]: state }));
      if (checkable(state)) void refresh(hostId);
    };
    const stop = window.parallax.onConnectionState(check);
    for (const id of ids)
      window.parallax.connectionState(id).then(
        (s) => check(id, s),
        () => {},
      );
    const timer = setInterval(() => {
      for (const [id, state] of Object.entries(known)) if (checkable(state)) void refresh(id);
    }, CHECK_MS);
    return () => {
      stop();
      clearInterval(timer);
    };
    // `refresh` only reads refs and setters.
  }, [hosts, prefs.providers]);

  const app = update.available?.version;
  const plans = buildPlan(hosts, states, prefs.providers ? providers : {}, app ?? version, app);
  return { plans, items: planItems(plans, version), upgraded };
}

/**
 * The running threads a restart of each restarting host cuts off, by host id, from
 * `host/health`, and whether every restarting host that reports `continueAfterRestart` has it on,
 * the checkbox's starting state.
 */
export async function restartInfo(
  plans: HostPlan[],
): Promise<{ running: Record<string, number>; continueThreads: boolean }> {
  const hosts = await Promise.all(
    plans.filter(restarts).map(async ({ hostId }) => {
      const [health, settings] = await Promise.all([
        window.parallax.request(hostId, "host/health", {}),
        window.parallax.request(hostId, "host/settings/get", {}),
      ]);
      return {
        hostId,
        running: "result" in health ? health.result.runningAgents : 0,
        on: "result" in settings ? settings.result.continueAfterRestart : undefined,
      };
    }),
  );
  return {
    running: Object.fromEntries(hosts.map((host) => [host.hostId, host.running])),
    continueThreads: hosts.every((host) => host.on !== false),
  };
}

/** Resolves once the app's update has downloaded, or to false if the download fails. */
function downloaded(): Promise<boolean> {
  return new Promise((resolve) => {
    let started = false;
    const stop = window.parallax.onUpdateState((state) => {
      if (state.progress !== undefined) started = true;
      const done = state.ready !== undefined || (started && state.progress === undefined);
      if (!done) return;
      stop();
      resolve(state.ready !== undefined);
    });
  });
}

/** How one item's update is going: chosen and queued, running, or done either way. */
export type ItemStatus =
  | { state: "waiting" }
  | { state: "running" }
  | { state: "done"; version?: string }
  | { state: "failed"; error: string };

/** Whether a status is still to finish. */
export const unsettled = (status: ItemStatus) =>
  status.state === "waiting" || status.state === "running";

/**
 * The last Update's run, kept outside the Update button, which Settings unmounts (it swaps the
 * sidebar for its nav): each item's status by key, the items the dialog's Update took, and each
 * release and provider version already tried on its own, so an automatic one that failed isn't
 * run again.
 */
type UpdateRun = {
  statuses: Record<string, ItemStatus>;
  taken?: UpdateItem[];
  tried: ReadonlySet<string>;
};

let run: UpdateRun = { statuses: {}, tried: new Set() };
const runListeners = new Set<() => void>();
export const updateRun = {
  set(change: Partial<UpdateRun>) {
    run = { ...run, ...change };
    for (const listener of runListeners) listener();
  },
  /** Sets one item's status. */
  report: (key: string, status: ItemStatus) =>
    updateRun.set({ statuses: { ...run.statuses, [key]: status } }),
  use: () =>
    useSyncExternalStore(
      (listener) => {
        runListeners.add(listener);
        return () => runListeners.delete(listener);
      },
      () => run,
    ),
};

/**
 * Resolves once a remote host's plxd reconnects on `version` or its update fails, from
 * `onHostUpdate`. One already on `version` resolves at once.
 */
async function hostUpdated(hostId: string, version: string): Promise<ItemStatus> {
  const result = new Promise<ItemStatus>((resolve) => {
    const stop = window.parallax.onHostUpdate((event) => {
      if (event.hostId !== hostId) return;
      stop();
      resolve(
        event.status === "updated"
          ? { state: "done", version: event.version }
          : { state: "failed", error: event.error },
      );
    });
  });
  await window.parallax.updateHostNow(hostId);
  const state = await window.parallax.connectionState(hostId);
  if (state.status === "connected" && !isOlder(state.plxd, version))
    return { state: "done", version: state.plxd };
  return result;
}

/**
 * Updates everything in `plans`: sets each restarting host's `continueAfterRestart` to
 * `continueThreads` when the user chose it, updates each host's providers and then its plxd,
 * now, and once every host has answered, installs the app's update, downloading it first unless
 * `appReady`, which restarts Parallax. `onStatus` hears each item's progress by its key, every
 * one `waiting` first, and `upgraded` each provider that updated. A failure also shows as a
 * notification.
 */
export async function updateEverything(
  plans: HostPlan[],
  continueThreads: boolean | undefined,
  appReady: boolean,
  upgraded: (hostId: string, cli: CliKind) => void,
  onStatus: (key: string, status: ItemStatus) => void,
): Promise<void> {
  for (const plan of plans) {
    if (plan.app) onStatus("app", { state: "waiting" });
    if (plan.server) onStatus(`server/${plan.hostId}`, { state: "waiting" });
    for (const { cli } of plan.providers)
      onStatus(`provider/${plan.hostId}/${cli}`, { state: "waiting" });
  }
  await Promise.all(
    plans.map(async (plan) => {
      if (restarts(plan) && continueThreads !== undefined)
        await window.parallax.request(plan.hostId, "host/settings/set", {
          continueAfterRestart: continueThreads,
        });
      for (const { cli, latest } of plan.providers) {
        const key = `provider/${plan.hostId}/${cli}`;
        onStatus(key, { state: "running" });
        const answer = await window.parallax.request(plan.hostId, "providers/upgrade", { cli });
        const name = cliNames[cli] ?? cli;
        if ("error" in answer) {
          const error = describeError(answer.error);
          onStatus(key, { state: "failed", error });
          notify({
            key,
            tone: "error",
            title: `Couldn't update ${name} on ${plan.name}`,
            body: error,
          });
        } else {
          const version = answer.result.version ?? latest;
          onStatus(key, { state: "done", version });
          notify({
            key,
            tone: "success",
            title: `Updated ${name} on ${plan.name}`,
            body: `Now ${version}.`,
          });
          upgraded(plan.hostId, cli);
        }
      }
      if (plan.server) {
        const key = `server/${plan.hostId}`;
        onStatus(key, { state: "running" });
        onStatus(key, await hostUpdated(plan.hostId, plan.server));
      }
    }),
  );
  if (!plans.some((plan) => plan.app)) return;
  onStatus("app", { state: "running" });
  if (!appReady) {
    const ready = downloaded();
    await window.parallax.update();
    if (!(await ready)) return onStatus("app", { state: "failed", error: "The download failed." });
  }
  await window.parallax.update();
}
