import { useSyncExternalStore } from "react";

import type { HostResponse } from "../preload/bridge";
import type { Hub, HubsListResult, HubsSaveParams } from "../protocol/generated/protocol";
import { describeError } from "./errors";
import { loadProviders } from "./providers";

// A host's CLIProxyAPI hubs (`hubs/list`, 0089), on a plxd with `hubs`: one list per host, shared
// by Settings' views, and replaced by each save or remove's answer.

const lists = new Map<string, Hub[]>();
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
  lists.set(hostId, answer.result.hubs);
  for (const listener of listeners) listener();
  if (changed) void loadProviders(hostId);
  return undefined;
}

/** Lists `hostId`'s hubs, asking each again with `refresh`. Resolves to an error for people. */
export async function loadHubs(hostId: string, refresh = false): Promise<string | undefined> {
  return kept(hostId, await window.parallax.request(hostId, "hubs/list", { refresh }));
}

/** Adds a hub to `hostId`, or replaces the one with its id. Resolves to an error for people. */
export async function saveHub(hostId: string, hub: HubsSaveParams): Promise<string | undefined> {
  return kept(hostId, await window.parallax.request(hostId, "hubs/save", hub), true);
}

/** Removes a hub, its keys, and its instances. Resolves to an error for people. */
export async function removeHub(hostId: string, id: string): Promise<string | undefined> {
  return kept(hostId, await window.parallax.request(hostId, "hubs/remove", { id }), true);
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
