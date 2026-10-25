import { useMemo } from "react";

import type {
  AgentPermission,
  ProviderInfo,
  ThreadStartParams,
} from "../protocol/generated/protocol";
import { instanceModels, models, type Model, type Provider } from "./catalog";
import { useProviders } from "./providers";
import { merged, stored } from "./stored";

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
 * Every one maps efforts but Cursor, whose model ids carry the effort (PLX-97, PLX-38, 0036).
 * ponytail: mirrors plxd's `Backend::permissions`, `Backend::efforts`, and
 * `Capabilities::coordinator`; a plxd with `providers` reports them (`ProviderInfo`).
 */
const builtIns: Omit<Instance, "enabled">[] = [
  {
    id: "claude",
    name: "Claude",
    kind: "claude",
    permissions: ["manual", "edit", "auto", "plan", "bypass"],
    efforts: true,
    coordinator: true,
  },
  // A Codex thread's modes (0035); Codex's plan mode is experimental, so it has no Plan.
  {
    id: "codex",
    name: "Codex",
    kind: "codex",
    permissions: ["manual", "edit", "auto", "bypass"],
    efforts: true,
    coordinator: false,
  },
  {
    id: "cursor",
    name: "Cursor",
    kind: "cursor",
    permissions: ["edit", "plan", "auto", "bypass"],
    efforts: false,
    coordinator: false,
  },
];

/** What this device keeps about an instance's models, by model id. */
interface ModelPrefs {
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

export { instanceModels, models, type Model, type Provider };
