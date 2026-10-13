import { useEffect, useState } from "react";

import { isOlder } from "../main/hostUpdate";
import type { ConnectionState, UpdateState } from "../preload/bridge";
import type { CliKind, ProviderUpdate } from "../protocol/generated/protocol";
import { describeError } from "./errors";
import { localId, useHosts, type Host } from "./hosts";
import { notify } from "./notifications";

// Update everything (PLX-746), as T3 Code's: the app, every remote host's plxd, and every host's
// Claude Code and Codex, from one dialog behind the sidebar's Update button.

/** What updating everything changes on one host. */
export type HostPlan = {
  hostId: string;
  name: string;
  /** The version a remote host's older plxd goes to. */
  server?: string;
  /** The version this computer's app goes to. */
  app?: string;
  /** Its agent CLIs with newer releases. */
  providers: ProviderUpdate[];
};

const cliNames: Record<CliKind, string> = { claude: "Claude", codex: "Codex", cursor: "Cursor" };

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

/** One host's line: "alvin: server to 0.0.50, Codex, Claude". */
export function planLine(plan: HostPlan): string {
  const parts = [
    plan.server && `server to ${plan.server}`,
    plan.app && `desktop app to ${plan.app}`,
    ...plan.providers.map((p) => cliNames[p.cli] ?? p.cli),
  ];
  return `${plan.name}: ${parts.filter(Boolean).join(", ")}`;
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
      ...(server && { server }),
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
 * connects and every 30 minutes. `refresh` checks one host's again.
 */
export function useUpdatePlan(update: UpdateState) {
  const hosts = useHosts();
  const [version, setVersion] = useState<string>();
  const [states, setStates] = useState<Record<string, ConnectionState>>({});
  const [providers, setProviders] = useState<Record<string, ProviderUpdate[]>>({});
  useEffect(() => void window.parallax.version().then(setVersion), []);

  const refresh = (hostId: string) =>
    window.parallax.request(hostId, "providers/updates", {}).then((answer) => {
      if ("result" in answer) setProviders((old) => ({ ...old, [hostId]: answer.result.updates }));
    });

  useEffect(() => {
    const ids = new Set(hosts.map((h) => h.id));
    const known: Record<string, ConnectionState> = {};
    const check = (hostId: string, state: ConnectionState) => {
      if (!ids.has(hostId)) return;
      known[hostId] = state;
      setStates((old) => ({ ...old, [hostId]: state }));
      if (state.status === "connected" && "providerUpdates" in state.capabilities)
        void refresh(hostId);
    };
    const stop = window.parallax.onConnectionState(check);
    for (const id of ids)
      window.parallax.connectionState(id).then(
        (s) => check(id, s),
        () => {},
      );
    const timer = setInterval(() => {
      for (const [id, state] of Object.entries(known))
        if (state.status === "connected" && "providerUpdates" in state.capabilities)
          void refresh(id);
    }, CHECK_MS);
    return () => {
      stop();
      clearInterval(timer);
    };
  }, [hosts]);

  const app = update.available?.version;
  const plans = buildPlan(hosts, states, providers, app ?? version, app);
  return { plans, refresh };
}

/**
 * The running threads a restart of each restarting host cuts off, from `host/health`, and
 * whether every restarting host that reports `continueAfterRestart` has it on, the checkbox's
 * starting state.
 */
export async function restartInfo(
  plans: HostPlan[],
): Promise<{ running: number; continueThreads: boolean }> {
  const hosts = await Promise.all(
    plans.filter(restarts).map(async ({ hostId }) => {
      const [health, settings] = await Promise.all([
        window.parallax.request(hostId, "host/health", {}),
        window.parallax.request(hostId, "host/settings/get", {}),
      ]);
      return {
        running: "result" in health ? health.result.runningAgents : 0,
        on: "result" in settings ? settings.result.continueAfterRestart : undefined,
      };
    }),
  );
  return {
    running: hosts.reduce((n, host) => n + host.running, 0),
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

/**
 * Updates everything in `plans`: sets each restarting host's `continueAfterRestart` to
 * `continueThreads` when the user chose it, updates each host's providers and then its plxd,
 * now, and once every host has answered, installs the app's update, downloading it first unless
 * `appReady`, which restarts Parallax. Failures show as notifications; a plxd's comes through
 * `onHostUpdate`.
 */
export async function updateEverything(
  plans: HostPlan[],
  continueThreads: boolean | undefined,
  appReady: boolean,
  refresh: (hostId: string) => Promise<void>,
): Promise<void> {
  await Promise.all(
    plans.map(async (plan) => {
      if (restarts(plan) && continueThreads !== undefined)
        await window.parallax.request(plan.hostId, "host/settings/set", {
          continueAfterRestart: continueThreads,
        });
      for (const { cli, latest } of plan.providers) {
        const answer = await window.parallax.request(plan.hostId, "providers/upgrade", { cli });
        const name = cliNames[cli] ?? cli;
        const key = `providerUpdate/${plan.hostId}/${cli}`;
        if ("error" in answer)
          notify({
            key,
            tone: "error",
            title: `Couldn't update ${name} on ${plan.name}`,
            body: describeError(answer.error),
          });
        else
          notify({
            key,
            tone: "success",
            title: `Updated ${name} on ${plan.name}`,
            body: `Now ${answer.result.version ?? latest}.`,
          });
      }
      if (plan.providers.length > 0) void refresh(plan.hostId);
      if (plan.server) await window.parallax.updateHostNow(plan.hostId);
    }),
  );
  if (!plans.some((plan) => plan.app)) return;
  if (!appReady) {
    const ready = downloaded();
    await window.parallax.update();
    if (!(await ready)) return;
  }
  await window.parallax.update();
}
