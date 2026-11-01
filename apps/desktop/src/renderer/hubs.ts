import { useSyncExternalStore } from "react";

import type { HostResponse } from "../preload/bridge";
import type { Hub, HubsListResult, HubsSaveParams } from "../protocol/generated/protocol";
import { describeError } from "./errors";
import { loadProviders } from "./providers";

// A host's CLIProxyAPI hubs (`hubs/list`, 0089), on a plxd with `hubs`: one list per host, shared
// by Settings' views, and replaced by each save or remove's answer.

const lists = new Map<string, Hub[]>();
const loading = new Map<string, Promise<string | undefined>>();
const revisions = new Map<string, number>();
const loadedAt = new Map<string, number>();
const listeners = new Set<() => void>();
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

/** CLIProxyAPI's docs, and Theo's guide to setting a hub up. */
export const HUB_DOCS = "https://help.router-for.me/";
export const HUB_GUIDE = "https://gist.github.com/t3dotgg/59a521d2ee8d70aaf90e280c175072af";

/**
 * Keeps a list plxd answered as `hostId`'s, or resolves to why it couldn't, for people. A save or
 * remove changes the host's instances too, so they're listed again.
 */
function kept(hostId: string, answer: HostResponse<HubsListResult>, changed = false) {
  if ("error" in answer) return describeError(answer.error);
  revisions.set(hostId, (revisions.get(hostId) ?? 0) + 1);
  loadedAt.set(hostId, Date.now());
  lists.set(hostId, answer.result.hubs);
  for (const listener of listeners) listener();
  if (changed) void loadProviders(hostId, true);
  return undefined;
}

/** Lists `hostId`'s hubs, asking each again with `refresh`. Resolves to an error for people. */
export function loadHubs(hostId: string, refresh = false): Promise<string | undefined> {
  const pending = loading.get(hostId);
  if (pending && !refresh) return pending;
  const revision = (revisions.get(hostId) ?? 0) + 1;
  revisions.set(hostId, revision);
  const load = window.parallax.request(hostId, "hubs/list", { refresh }).then((answer) => {
    if (loading.get(hostId) === load) loading.delete(hostId);
    if (revisions.get(hostId) !== revision) return undefined;
    return kept(hostId, answer);
  });
  loading.set(hostId, load);
  return load;
}

/** Lazy picker metadata, shared across menus, without repeating management probes within 30 s. */
export function ensureHubs(hostId: string): Promise<string | undefined> {
  if (Date.now() - (loadedAt.get(hostId) ?? 0) < 30_000) return Promise.resolve(undefined);
  return loadHubs(hostId);
}

/** Adds a hub to `hostId`, or replaces the one with its id. Resolves to an error for people. */
export async function saveHub(hostId: string, hub: HubsSaveParams): Promise<string | undefined> {
  return kept(hostId, await window.parallax.request(hostId, "hubs/save", hub), true);
}

/** Removes a hub, its keys, and its instances. Resolves to an error for people. */
export async function removeHub(hostId: string, id: string): Promise<string | undefined> {
  return kept(hostId, await window.parallax.request(hostId, "hubs/remove", { id }), true);
}

/** Turns a hub's account on or off (PLX-1070). Resolves to an error for people. */
export async function setHubAccountEnabled(
  hostId: string,
  hub: string,
  account: string,
  enabled: boolean,
): Promise<string | undefined> {
  return kept(
    hostId,
    await window.parallax.request(hostId, "hubs/accounts/setEnabled", { hub, account, enabled }),
  );
}

/** Deletes a hub's account. Resolves to an error for people. */
export async function removeHubAccount(
  hostId: string,
  hub: string,
  account: string,
): Promise<string | undefined> {
  return kept(
    hostId,
    await window.parallax.request(hostId, "hubs/accounts/remove", { hub, account }),
  );
}

/** `hostId`'s last listed hubs, kept current, or undefined before its first list. */
export const useHubs = (hostId: string): Hub[] | undefined =>
  useSyncExternalStore(subscribe, () => lists.get(hostId));

/** A hub's settings as `hubs/save` takes them, without its keys, which plxd keeps. */
export const settingsOf = ({ id, name, url, enabled }: Hub): HubsSaveParams => ({
  id,
  name,
  url,
  enabled,
});
