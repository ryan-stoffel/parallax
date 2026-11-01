import { Bot, Cpu } from "lucide-react";
import { useEffect, useSyncExternalStore, type ComponentType, type SVGProps } from "react";

import type { ConnectionState, HostResponse } from "../preload/bridge";
import type {
  ProviderInfo,
  ProviderInstance,
  ProvidersListResult,
} from "../protocol/generated/protocol";
import { models as shippedModels } from "./catalog";
import { describeError } from "./errors";
import { notify } from "./notifications";
import { kindInfo, type KindInfo } from "./providerKinds";
import { merged, stored } from "./stored";
import {
  AmpLogo,
  AntigravityLogo,
  ClaudeLogo,
  ClineLogo,
  CursorLogo,
  GrokLogo,
  HermesLogo,
  maskLogo,
  OllamaLogo,
  OpenAILogo,
  OpenCodeLogo,
  OpenRouterLogo,
  PiLogo,
} from "./logos";

export {
  presets,
  slug,
  unique,
  versionOf,
  versions,
  withVersion,
  type Preset,
  type Version,
} from "./providerKinds";

// A host's provider instances (`providers/list`), on a plxd with `providers`: one list per host,
// shared by Settings and every model picker, and replaced by each save or remove's answer.

const legacyHosts = new Set<string>();
const lists = new Map<string, ProvidersListResult>();
const listeners = new Set<() => void>();
const generations = new Map<string, number>();
const loading = new Map<string, Promise<string | undefined>>();
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

function put(hostId: string, result: ProvidersListResult | undefined) {
  const before = lists.get(hostId);
  if (before && result) notifySignIns(hostId, before, result);
  if (result) {
    rememberModels(hostId, result);
    lists.set(hostId, result);
  } else lists.delete(hostId);
  for (const listener of listeners) listener();
}

// Upstreams often omit release dates. Track when a model first became available here,
// seeding shipped models from their release dates so upgrading does not mark them all New.
const discoveries = stored<Record<string, Record<string, string>>>(
  "parallax.modelDiscoveries",
  {},
  merged,
);
export const discoveredAt = (hostId: string, provider: string, model: string) =>
  discoveries.get()[`${hostId}/${provider}`]?.[model];
function rememberModels(hostId: string, result: ProvidersListResult) {
  const next = { ...discoveries.get() };
  for (const info of result.providers) {
    const key = `${hostId}/${info.instance.id}`;
    const known = { ...next[key] };
    for (const model of info.models ?? []) {
      known[model.id] ??= shippedModels.find(
        (m) => m.provider === info.instance.kind && m.id === model.id,
      )
        ? "1970-01-01"
        : new Date().toISOString();
    }
    next[key] = known;
  }
  discoveries.set(next);
}

/**
 * A notification for each enabled instance whose sign-in changed between two lists (PLX-507):
 * signed in, as when Sign in's terminal ends, or signed out, which its threads would fail on.
 */
function notifySignIns(hostId: string, before: ProvidersListResult, after: ProvidersListResult) {
  for (const { instance, signedIn, account } of after.providers) {
    const was = before.providers.find((p) => p.instance.id === instance.id)?.signedIn;
    if (!instance.enabled || was == null || signedIn == null || was === signedIn) continue;
    const key = `provider/${hostId}/${instance.id}`;
    if (signedIn)
      notify({
        key,
        tone: "success",
        title: `Signed in to ${instance.name}`,
        ...(account && { body: account }),
      });
    else
      notify({
        key,
        tone: "error",
        title: `${instance.name} is signed out`,
        body: "Its threads can't run until you sign in again in Settings > Providers.",
      });
  }
}

/** Keeps a list plxd answered as `hostId`'s, or resolves to why it couldn't, for people. */
function kept(hostId: string, answer: HostResponse<ProvidersListResult>) {
  if ("error" in answer) return describeError(answer.error);
  put(hostId, answer.result);
  return undefined;
}

/** `hostId`'s last list, or undefined before its first. */
export const listedProviders = (hostId: string) => lists.get(hostId);

/**
 * Lists `hostId`'s instances again, probing each with `refresh`. A load already on its way answers
 * one without `refresh`. Resolves to an error for people.
 */
export function loadProviders(hostId: string, refresh = false): Promise<string | undefined> {
  const pending = loading.get(hostId);
  if (pending && !refresh) return pending;
  const generation = (generations.get(hostId) ?? 0) + 1;
  generations.set(hostId, generation);
  const load = window.parallax.request(hostId, "providers/list", { refresh }).then((answer) => {
    if (loading.get(hostId) === load) loading.delete(hostId);
    if (generations.get(hostId) !== generation) return undefined;
    return kept(hostId, answer);
  });
  loading.set(hostId, load);
  return load;
}

/**
 * Lists `hostId`'s instances after something else changed them, such as a hub: what plxd knows at
 * once, then asking each. A list already on its way predates the change, so it's dropped.
 */
export async function relistProviders(hostId: string): Promise<void> {
  generations.set(hostId, (generations.get(hostId) ?? 0) + 1);
  loading.delete(hostId);
  await loadProviders(hostId);
  await loadProviders(hostId, true);
}

/** Adds `instance` to a host, or replaces the one with its id. Resolves to an error for people. */
export async function saveProvider(
  hostId: string,
  instance: ProviderInstance,
): Promise<string | undefined> {
  generations.set(hostId, (generations.get(hostId) ?? 0) + 1);
  loading.delete(hostId);
  const answer = await window.parallax.request(hostId, "providers/save", { instance });
  generations.set(hostId, (generations.get(hostId) ?? 0) + 1);
  return kept(hostId, answer);
}

/** Removes an instance, and its secrets. Resolves to an error for people. */
export async function removeProvider(hostId: string, id: string): Promise<string | undefined> {
  generations.set(hostId, (generations.get(hostId) ?? 0) + 1);
  loading.delete(hostId);
  const answer = await window.parallax.request(hostId, "providers/remove", { id });
  generations.set(hostId, (generations.get(hostId) ?? 0) + 1);
  return kept(hostId, answer);
}

/**
 * `hostId`'s instances, kept current: listed whenever it connects to a plxd with `providers`, and
 * undefined until then, for no host, and for an older plxd.
 */
export function useProviders(hostId: string | undefined): ProvidersListResult | undefined {
  const listed = useSyncExternalStore(subscribe, () =>
    hostId === undefined ? undefined : lists.get(hostId),
  );
  useEffect(() => {
    if (hostId === undefined) return;
    return observeProviders(hostId);
  }, [hostId]);
  return listed;
}

/** Legacy fallback is allowed only after the host explicitly lacks provider support. */
export const useLegacyProviders = (hostId: string | undefined) =>
  useSyncExternalStore(subscribe, () => hostId === undefined || legacyHosts.has(hostId));

const observers = new Map<string, { count: number; stop: () => void }>();
function observeProviders(hostId: string) {
  let observer = observers.get(hostId);
  if (!observer) {
    let supported = false;
    let connected = false;
    const check = (state: ConnectionState) => {
      const wasConnected = connected;
      connected = state.status === "connected";
      if (state.status !== "connected") {
        if (wasConnected) {
          generations.set(hostId, (generations.get(hostId) ?? 0) + 1);
          loading.delete(hostId);
        }
        return;
      }
      supported = "providers" in state.capabilities;
      if (supported) legacyHosts.delete(hostId);
      else legacyHosts.add(hostId);
      if (supported) {
        if (!wasConnected || !lists.has(hostId)) void loadProviders(hostId);
      } else {
        generations.set(hostId, (generations.get(hostId) ?? 0) + 1);
        put(hostId, undefined);
      }
    };
    const stop = window.parallax.onConnectionState((id, state) => id === hostId && check(state));
    void window.parallax.connectionState(hostId).then(check, () => {});
    const refresh = () => {
      if (connected && supported && document.visibilityState !== "hidden")
        void loadProviders(hostId);
    };
    const timer = setInterval(refresh, 60_000);
    window.addEventListener("focus", refresh);
    observer = {
      count: 0,
      stop: () => {
        stop();
        clearInterval(timer);
        window.removeEventListener("focus", refresh);
      },
    };
    observers.set(hostId, observer);
  }
  observer.count++;
  return () => {
    if (--observer.count === 0) {
      observer.stop();
      observers.delete(hostId);
    }
  };
}

type Logo = ComponentType<SVGProps<SVGSVGElement>>;

/** A kind of provider instance (`ProviderKind`), as Parallax shows it. */
export interface Kind extends KindInfo {
  Logo: Logo;
}

const logos: Record<keyof typeof kindInfo, Logo> = {
  claude: ClaudeLogo,
  codex: OpenAILogo,
  cursor: CursorLogo,
  antigravity: AntigravityLogo,
  opencode: OpenCodeLogo,
  pi: PiLogo,
  grokBuild: GrokLogo,
  hermes: HermesLogo,
  ollamaCloud: OllamaLogo,
  openRouter: OpenRouterLogo,
  localModel: Cpu,
  acp: Bot,
};

export const kinds: Record<string, Kind> = Object.fromEntries(
  Object.entries(kindInfo).map(([kind, info]) => [
    kind,
    { ...info, Logo: logos[kind as keyof typeof kindInfo] },
  ]),
);

/** `kind`'s entry, or the generic ACP one for a kind this app doesn't know. */
export const kindOf = (kind: string): Kind => kinds[kind] ?? kinds["acp"]!;

/** ACP agents with a mark of their own, known by their name or program. */
const acpLogos: [RegExp, Logo][] = [
  [/\bamp\b/i, AmpLogo],
  [/\bcline\b/i, ClineLogo],
];

const registryIcons = stored<Record<string, string>>("parallax.registryIcons", {}, merged);

/** Keeps an ACP Registry agent's icon on this device, for the instances named `name`. */
export const keepRegistryIcon = (name: string, url: string) =>
  registryIcons.set({ ...registryIcons.get(), [name]: url });

/**
 * An instance's logo: its kind's, or for an ACP agent, its own mark, else the icon of the
 * registry agent it was added as (by its name), else the generic one.
 */
export function logoOf(instance: { kind: string; name: string; program?: string }): Logo {
  if (instance.kind !== "acp") return kindOf(instance.kind).Logo;
  const own = `${instance.name} ${instance.program ?? ""}`;
  const known = acpLogos.find(([name]) => name.test(own))?.[1];
  const icon = registryIcons.get()[instance.name];
  return known ?? (icon ? (maskLogo(icon) as Logo) : kindOf("acp").Logo);
}

/** The instance `id` on the first host whose listed instances have it. */
function listedInstance(id: string): ProviderInstance | undefined {
  for (const list of lists.values()) {
    const info = list.providers.find((p) => p.instance.id === id);
    if (info) return info.instance;
  }
  return undefined;
}

/**
 * The logo of the instance a run's `backend` names, on any host whose instances are listed: its
 * kind's, or undefined for a backend no list has yet.
 */
export function instanceLogo(backend: string): Logo | undefined {
  const instance = listedInstance(backend);
  return instance && logoOf(instance);
}

/**
 * The name of the instance `id` on any host whose instances are listed: a subscription account
 * is named by its instance, an added one by the name the user gave it.
 */
export const instanceName = (id: string): string | undefined => listedInstance(id)?.name;

/** A user's label, or the sign-in identity for an account with an automatic provider label. */
export function accountLabel(info: Pick<ProviderInfo, "instance" | "account">): string {
  const { instance, account } = info;
  const automatic = /^(?:Account|Codex|Claude(?: Code)?)(?: \d+)?$/.test(instance.name);
  return automatic && account?.includes("@") ? account : instance.name;
}
