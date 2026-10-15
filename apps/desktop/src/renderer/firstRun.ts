import type { ProviderInfo, ProviderInstance } from "../protocol/generated/protocol";
import {
  listedProviders,
  loadProviders,
  presets,
  removeProvider,
  saveProvider,
  type Preset,
} from "./providers";
import { stored } from "./stored";

// First-launch onboarding (PLX-806): whether it's done here, and setting up the agents it finds.

// Read before this run stores anything: an install that ran before onboarding shipped has keys.
const ranBefore = localStorage.length > 0;
const onboarded = stored("parallax.onboarded", ranBefore, (raw, fallback) =>
  typeof raw === "boolean" ? raw : fallback,
);
// Kept now, so a first run quit midway, after other settings were stored, still onboards next time.
if (!ranBefore) onboarded.set(false);

/** Whether onboarding should show: until it's finished or skipped, on a fresh install. */
export const useOnboarding = () => !onboarded.use() && !window.parallax.onboarded;

/** Ends onboarding on this computer for good. */
export const finishOnboarding = () => onboarded.set(true);

/** An agent onboarding looks for: its Add provider preset, and the id it's added under. */
export type Agent = Preset & { id: string };

/**
 * The agents onboarding looks for, in the order it lists them. A built-in takes its kind's id, as
 * Add provider gives it. Model services are left out: each needs an API key first.
 */
export const agents: Agent[] = [
  ...presets
    .filter((p) => ["claude", "codex", "cursor", "pi", "opencode", "hermes"].includes(p.kind))
    .map((p) => ({ ...p, id: p.kind })),
  { kind: "grokBuild", name: "Grok Build", blurb: "xAI's agent", id: "grok-build" },
];

/** The instance on a host for `agent`: one with its id, else the first of its kind. */
export const infoOf = (providers: ProviderInfo[] | undefined, agent: Agent) =>
  providers?.find((p) => p.instance.id === agent.id) ??
  providers?.find((p) => p.instance.kind === agent.kind);

/** Whether an instance can run threads now: installed, and not signed out. */
export const ready = (info: ProviderInfo) => info.installed && info.signedIn !== false;

/**
 * What setting up a host's agents changes, from its probed list: it removes each agent that isn't
 * installed (or installing), and turns on each that's ready and off each that isn't. With none
 * ready it turns nothing off, so the host keeps an instance on. Turning on comes first, so one is
 * always on.
 */
export function plan(providers: ProviderInfo[]): { remove: string[]; save: ProviderInstance[] } {
  const ours = providers.filter((p) => agents.some((a) => a.kind === p.instance.kind));
  const gone = ours.filter((p) => !p.installed && !p.installing);
  const kept = ours.filter((p) => !gone.includes(p));
  const any = kept.some(ready);
  const save = kept
    .filter((p) => (ready(p) ? !p.instance.enabled : any && p.instance.enabled))
    .map((p) => ({ ...p.instance, enabled: ready(p) }))
    .sort((a, b) => Number(b.enabled) - Number(a.enabled));
  return { remove: gone.map((p) => p.instance.id), save };
}

/**
 * Sets up `hostId`'s agents: adds each agent it lacks, turned off, which plxd probes as it saves,
 * then applies `plan`. `refresh` probes the ones it has again, as after a sign-in or an install.
 * Resolves to an error for people.
 */
export async function setUpAgents(hostId: string, refresh = false): Promise<string | undefined> {
  const failed = await loadProviders(hostId, refresh);
  if (failed) return failed;
  for (const agent of agents) {
    if (infoOf(listedProviders(hostId)?.providers, agent)) continue;
    const added = await saveProvider(hostId, {
      id: agent.id,
      kind: agent.kind,
      name: agent.name,
      enabled: false,
      ...(agent.program && { program: agent.program }),
      args: agent.args ?? [],
      env: agent.env ?? [],
      models: [],
    });
    if (added) return added;
  }
  const { remove, save } = plan(listedProviders(hostId)?.providers ?? []);
  for (const instance of save) {
    const saved = await saveProvider(hostId, instance);
    if (saved) return saved;
  }
  for (const id of remove) {
    const removed = await removeProvider(hostId, id);
    if (removed) return removed;
  }
  return undefined;
}
