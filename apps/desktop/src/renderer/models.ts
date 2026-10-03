import { useMemo } from "react";

import type {
  AgentPermission,
  ProviderInfo,
  ThreadStartParams,
} from "../protocol/generated/protocol";
import { useProviders } from "./providers";
import { merged, stored } from "./stored";

// The models each worker backend's CLI took on 2026-09-29, and what to send for each. A
// placeholder until plxd reports them per host. Sources:
// - Claude Code 2.1.283: the full names its aliases (opus, fable, sonnet, haiku) resolve to in
//   its baked-in model catalog. `--model` takes these as they are.
// - codex-cli 0.159.3: the slugs ~/.codex/models_cache.json listed (visibility "list") on
//   2026-10-02, which `-m` takes.
// - Cursor Agent 2026.10.01-14929f9: a model of each family `agent models` listed on 2026-10-01,
//   by the ids `--model` takes, effort included (0036).
// Context windows and fast mode, checked on Claude Code 2.1.286 and codex-cli 0.159.3: Claude's
// models but Haiku run 1M natively and can be capped at 200K, and only Opus 5.5 has fast mode.
// Codex's catalog gives every model 272K by default and all but GPT-5.5 up to 872K, and every one
// the Fast service tier.
// Cursor's backend maps neither, so its models offer none.
// Each model's `provider` here is the kind of instance that runs it: on an old plxd, the built-in
// instance of that id; on one with `providers`, every instance of that kind (`instanceModels`).

/** A provider instance's id, which is also its backend's name (`AccountChoice`'s `backend`). */
export type Provider = string;

export interface Model {
  /** What the backend's CLI takes, sent as `thread/start`'s `model`. */
  id: string;
  name: string;
  /** The instance that runs it. */
  provider: Provider;
  isNew?: boolean;
  /** The context windows it offers, in tokens, its default first. */
  contexts: number[];
  /** Whether it has fast mode. */
  fast?: boolean;
  /** One the user added to its instance (`ProviderInstance.models`). */
  custom?: boolean;
}

const claude1M = [1_000_000, 200_000];
const codex872K = [272_000, 872_000];

/** The built-in catalog, by kind. */
export const models: Model[] = [
  {
    id: "claude-opus-5-5",
    name: "Claude Opus 5.5",
    provider: "claude",
    isNew: true,
    contexts: claude1M,
    fast: true,
  },
  { id: "claude-fable-5-1", name: "Claude Fable 5.1", provider: "claude", contexts: claude1M },
  { id: "claude-sonnet-5", name: "Claude Sonnet 5", provider: "claude", contexts: claude1M },
  { id: "claude-haiku-4-5", name: "Claude Haiku 4.5", provider: "claude", contexts: [200_000] },
  {
    id: "gpt-6.1-sol",
    name: "GPT-6.1 Sol",
    provider: "codex",
    isNew: true,
    contexts: codex872K,
    fast: true,
  },
  {
    id: "gpt-6-astra",
    name: "GPT-6 Astra",
    provider: "codex",
    isNew: true,
    contexts: codex872K,
    fast: true,
  },
  {
    id: "gpt-6-sol",
    name: "GPT-6 Sol",
    provider: "codex",
    isNew: true,
    contexts: codex872K,
    fast: true,
  },
  {
    id: "gpt-6-luna",
    name: "GPT-6 Luna",
    provider: "codex",
    isNew: true,
    contexts: codex872K,
    fast: true,
  },
  { id: "gpt-5.6-sol", name: "GPT-5.6 Sol", provider: "codex", contexts: codex872K, fast: true },
  {
    id: "gpt-5.6-terra",
    name: "GPT-5.6 Terra",
    provider: "codex",
    contexts: codex872K,
    fast: true,
  },
  { id: "gpt-5.6-luna", name: "GPT-5.6 Luna", provider: "codex", contexts: codex872K, fast: true },
  { id: "gpt-5.5", name: "GPT-5.5", provider: "codex", contexts: [272_000], fast: true },
  { id: "auto", name: "Auto", provider: "cursor", contexts: [] },
  { id: "composer-2.5", name: "Composer 2.5", provider: "cursor", contexts: [], isNew: true },
  { id: "composer-2.5-fast", name: "Composer 2.5 Fast", provider: "cursor", contexts: [] },
  { id: "claude-opus-5-5-medium", name: "Claude Opus 5.5", provider: "cursor", contexts: [] },
  { id: "claude-fable-5-1-high", name: "Claude Fable 5.1", provider: "cursor", contexts: [] },
  { id: "claude-sonnet-5-high", name: "Claude Sonnet 5", provider: "cursor", contexts: [] },
  { id: "gpt-5.6-sol-medium", name: "GPT-5.6 Sol", provider: "cursor", contexts: [] },
  { id: "gpt-5.5-medium", name: "GPT-5.5", provider: "cursor", contexts: [] },
  { id: "gpt-5.3-codex", name: "Codex 5.3", provider: "cursor", contexts: [] },
  { id: "gemini-3.1-pro", name: "Gemini 3.1 Pro", provider: "cursor", contexts: [] },
  { id: "grok-4.7-high", name: "Grok 4.7 High", provider: "cursor", contexts: [] },
  { id: "kimi-k3-max", name: "Kimi K3", provider: "cursor", contexts: [] },
];

/**
 * What a new thread's run asks of its CLI, sent only to a plxd that advertises `runOptions`, and
 * its context window and fast mode only to one that advertises `contextAndFast`. An open run's
 * message adds the account it moves to, for another provider's model (`sendAccount`).
 */
export type RunOptions = Pick<
  ThreadStartParams,
  "model" | "effort" | "permission" | "contextWindow" | "fast" | "account"
>;

const disabled = stored<string[]>("parallax.disabledProviders", [], (raw, fallback) =>
  Array.isArray(raw) ? raw.filter((c): c is string => typeof c === "string") : fallback,
);

/**
 * The CLIs turned off in Settings > Providers, by `CliKind`, kept current: on an older plxd only.
 * A plxd with `providers` keeps each instance's `enabled` itself.
 */
export const useDisabledClis = disabled.use;

/** Turns a CLI's provider on or off for new threads and model menus on this computer. */
export const setCliEnabled = (cli: string, on: boolean) =>
  disabled.set(
    on ? disabled.get().filter((c) => c !== cli) : [...new Set([...disabled.get(), cli])],
  );

/**
 * A provider instance a thread can run on (`AccountChoice`'s `backend` is its id): what kind it
 * is, the permissions it maps, whether it takes an effort, and whether it can run a Project's
 * coordinator. `enabled` is off while it's turned off in Settings > Providers.
 */
export interface Instance {
  id: string;
  name: string;
  kind: string;
  enabled: boolean;
  permissions: AgentPermission[];
  efforts: boolean;
  coordinator: boolean;
}

/** A host's instances, and the models it offers on them, in the order the model picker lists them. */
export interface Catalog {
  hostId: string;
  instances: Instance[];
  models: Model[];
}

/**
 * The built-in backends of a plxd without `providers`, whose names the model menu has always shown.
 * Every one maps efforts but Cursor, whose model ids carry the effort (RYA-97, RYA-38, 0036).
 * ponytail: mirrors plxd's `Backend::permissions`, `Backend::efforts`, and
 * `Capabilities::coordinator`; a plxd with `providers` reports them (`ProviderInfo`).
 */
const builtIns: Omit<Instance, "enabled">[] = [
  {
    id: "claude",
    name: "Claude",
    kind: "claude",
    permissions: ["auto", "manual", "edit", "plan", "bypass"],
    efforts: true,
    coordinator: true,
  },
  // A Codex thread's modes (0035); Codex's plan mode is experimental, so it has no Plan.
  {
    id: "codex",
    name: "Codex",
    kind: "codex",
    permissions: ["auto", "manual", "edit", "bypass"],
    efforts: true,
    coordinator: false,
  },
  {
    id: "cursor",
    name: "Cursor",
    kind: "cursor",
    permissions: ["edit", "plan", "bypass"],
    efforts: false,
    coordinator: false,
  },
];

/**
 * An instance's models before this device's choices: its kind's built-in catalog, then those plxd
 * found, then the user's own, each id once.
 */
export function instanceModels(info: ProviderInfo): Model[] {
  const { instance } = info;
  const seen = new Set<string>();
  return [
    ...models.filter((m) => m.provider === instance.kind),
    ...info.models.map((m) => ({ ...m, contexts: [] })),
    ...instance.models.map((m) => ({ ...m, contexts: [] })),
  ]
    .filter((m) => !seen.has(m.id) && !!seen.add(m.id))
    .map((m) => ({
      ...m,
      provider: instance.id,
      ...(instance.models.some((c) => c.id === m.id) && { custom: true }),
    }));
}

/** What this device keeps about an instance's models, by model id. */
export interface ModelPrefs {
  /** The order they're listed in. One not in it follows, in its own order. */
  order?: string[];
  /** Those left out of the model picker. */
  hidden?: string[];
  favorites?: string[];
}

const prefs = stored<Record<string, ModelPrefs>>("parallax.modelPrefs", {}, merged);

/** Every instance's `ModelPrefs`, by `prefsKey`, kept current. */
export const useModelPrefs = prefs.use;

/** Where an instance's `ModelPrefs` are kept: per host, since each host has its own instances. */
export const prefsKey = (hostId: string, instance: string) => `${hostId}/${instance}`;

export function updateModelPrefs(key: string, change: (p: ModelPrefs) => ModelPrefs) {
  const all = prefs.get();
  prefs.set({ ...all, [key]: change(all[key] ?? {}) });
}

/** `list` with `id` added, or taken out if it's there. */
export const toggled = (list: string[] = [], id: string) =>
  list.includes(id) ? list.filter((each) => each !== id) : [...list, id];

/** Stars or unstars a model on a host's instance, for this device. */
export const toggleFavorite = (hostId: string, instance: string, id: string) =>
  updateModelPrefs(prefsKey(hostId, instance), (p) => ({
    ...p,
    favorites: toggled(p.favorites, id),
  }));

/** `list` in `p`'s order. */
export function arranged(list: Model[], p: ModelPrefs | undefined): Model[] {
  const order = p?.order ?? [];
  const rank = (m: Model) => {
    const i = order.indexOf(m.id);
    return i < 0 ? order.length + list.indexOf(m) : i;
  };
  return [...list].sort((a, b) => rank(a) - rank(b));
}

/**
 * The model picker's catalog: each instance's models in this device's order, without those it
 * hides. `listed` is plxd's `providers/list`; without it (an older plxd), the built-in backends,
 * turned off by `off`.
 */
export function catalogOf(
  hostId: string,
  listed: ProviderInfo[] | undefined,
  all: Record<string, ModelPrefs>,
  off: string[],
): Catalog {
  const entries = listed
    ? listed.map((info) => ({
        instance: {
          id: info.instance.id,
          name: info.instance.name,
          kind: info.instance.kind,
          enabled: info.instance.enabled,
          permissions: info.permissions,
          efforts: info.efforts,
          coordinator: info.coordinator,
        },
        models: instanceModels(info),
      }))
    : builtIns.map((b) => ({
        instance: { ...b, enabled: !off.includes(b.id) },
        models: models.filter((m) => m.provider === b.id),
      }));
  return {
    hostId,
    instances: entries.map((e) => e.instance),
    models: entries.flatMap(({ instance, models }) => {
      const p = all[prefsKey(hostId, instance.id)];
      return arranged(models, p).filter((m) => !p?.hidden?.includes(m.id));
    }),
  };
}

/** `hostId`'s catalog, kept current. Without a host, the built-in one, as on an older plxd. */
export function useCatalog(hostId: string | undefined): Catalog {
  const listed = useProviders(hostId)?.providers;
  const all = prefs.use();
  const off = disabled.use();
  return useMemo(() => catalogOf(hostId ?? "local", listed, all, off), [hostId, listed, all, off]);
}
