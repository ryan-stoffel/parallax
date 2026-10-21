import type {
  ProviderEnvVar,
  ProviderInfo,
  ProviderInstance,
} from "../protocol/generated/protocol";
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

const onboarded = stored("parallax.onboarded", true, (raw, fallback) =>
  typeof raw === "boolean" ? raw : fallback,
);
// A fresh install (main's `firstRun`) stores that it hasn't onboarded, so quitting midway still
// onboards on the next launch, which is no longer a first run. Any other install never does.
if (window.parallax?.firstRun && localStorage.getItem("parallax.onboarded") === null)
  onboarded.set(false);

/** Whether onboarding should show: on a fresh install, until it's finished or skipped. */
export const useOnboarding = () => !onboarded.use();

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

const sameVars = (a: ProviderEnvVar[], b: ProviderEnvVar[]) =>
  JSON.stringify(a.map((v) => [v.name, v.value, v.secret])) ===
  JSON.stringify(b.map((v) => [v.name, v.value, v.secret]));

/**
 * Whether `instance` is an agent as setup or plxd's first run adds it, under its id and with
 * nothing the user set (a name aside). Setup changes only these, never one the user made.
 */
export function untouched(instance: ProviderInstance): boolean {
  const agent = agents.find((a) => a.id === instance.id && a.kind === instance.kind);
  return (
    !!agent &&
    instance.program === agent.program &&
    !instance.home &&
    instance.args.join(" ") === (agent.args ?? []).join(" ") &&
    sameVars(instance.env, agent.env ?? []) &&
    instance.models.length === 0
  );
}

/**
 * What setting up a host's agents changes, from its probed list, among the `untouched` ones: it
 * removes each that isn't installed (or installing), and turns on each that's ready and off each
 * that isn't. With none ready it turns nothing off, so the host keeps an instance on. Turning on
 * comes first, so one is always on.
 */
export function plan(providers: ProviderInfo[]): { remove: string[]; save: ProviderInstance[] } {
  const ours = providers.filter((p) => untouched(p.instance));
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
 * Sets up `hostId`'s agents: adds each agent it lacks, turned off and all at once, which plxd
 * probes as it saves, then applies `plan`. `refresh` probes the ones it has again, as after a
 * sign-in or an install. Resolves to an error for people.
 */
export function setUpAgents(hostId: string, refresh = false): Promise<string | undefined> {
  const next = queue.then(() => setUp(hostId, refresh));
  queue = next.catch(() => undefined);
  return next;
}

// One setup at a time in this window, so a second never races the first's removes.
let queue: Promise<unknown> = Promise.resolve();

async function setUp(hostId: string, refresh: boolean): Promise<string | undefined> {
  const failed = await loadProviders(hostId, refresh);
  if (failed) return failed;
  // At once, so one slow probe (an agent waiting to sign in takes 20 s) doesn't hold up the rest.
  const missing = agents.filter((agent) => !infoOf(listedProviders(hostId)?.providers, agent));
  const added = await Promise.all(
    missing.map((agent) =>
      saveProvider(hostId, {
        id: agent.id,
        kind: agent.kind,
        name: agent.name,
        enabled: false,
        ...(agent.program && { program: agent.program }),
        args: agent.args ?? [],
        env: agent.env ?? [],
        models: [],
      }),
    ),
  );
  const failedAdd = added.find(Boolean);
  if (failedAdd) return failedAdd;
  // Saves answer in any order, so the last may predate another's add. Every probe is cached now.
  if (missing.length > 0) {
    const reloaded = await loadProviders(hostId);
    if (reloaded) return reloaded;
  }
  const { remove, save } = plan(listedProviders(hostId)?.providers ?? []);
  for (const instance of save) {
    const saved = await saveProvider(hostId, instance);
    if (saved) return saved;
  }
  // One left behind, as when another window removed it first, is off and harmless.
  for (const id of remove) await removeProvider(hostId, id);
  return undefined;
}
