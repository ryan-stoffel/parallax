import { useCallback, useSyncExternalStore } from "react";

import { msg } from "../i18n";
import type { GuestLink, GuestListResult } from "../protocol/generated/protocol";

/** Why a thread can't be shared while its computer's `hostedClient` is off. Shown with `t`. */
export const HOSTED_OFF = msg(
  "Parallax on the web is off on this thread's computer. Turn it on in that computer's settings to share threads.",
);

/** What Create link says when the thread already has a live link, which a new one would end. */
export const ALREADY_SHARED = msg(
  "This thread is already shared. Stop sharing to create a new link.",
);

/**
 * What a read-only web browser among a computer's devices says: a browser signs in, so the pairing
 * advice other devices get doesn't fit it (0108). Shown with `t`, with `paired`.
 */
export const HOSTED_READ_ONLY = msg(
  "{{paired}}. It reads threads and can't change anything. For full access, revoke it, then sign in from that browser again and allow it with full control.",
);

// Each computer's live guest links (0108), as `guest/list` answers them: no secret is in one. plxd
// doesn't say when a guest opens a link or suggests a message (PLX-1626), so while something on
// screen reads a computer's links they're read again on a timer, often while one is live.

/** How often a computer with a live link is asked again, and one with none. */
const LIVE_MS = 5_000;
const IDLE_MS = 30_000;

/** A computer's links, and whether plxd has answered for them yet. */
export interface GuestLinks {
  links: readonly GuestLink[];
  read: boolean;
}

const unread: GuestLinks = { links: [], read: false };

interface Store {
  /** Replaced, never changed, so a watcher can compare it. */
  shown: GuestLinks;
  watchers: Set<() => void>;
  timer?: ReturnType<typeof setTimeout>;
}

const stores = new Map<string, Store>();

function storeOf(hostId: string): Store {
  let store = stores.get(hostId);
  if (!store) stores.set(hostId, (store = { shown: unread, watchers: new Set() }));
  return store;
}

/** Keeps `hostId`'s links as plxd just answered them, from a read or a change. */
export function setGuestLinks(hostId: string, { links }: GuestListResult): void {
  const store = storeOf(hostId);
  if (store.shown.read && JSON.stringify(store.shown.links) === JSON.stringify(links)) return;
  store.shown = { links, read: true };
  for (const watcher of store.watchers) watcher();
}

/** `hostId`'s links as last read, without asking. */
export const guestLinksOf = (hostId: string): GuestLinks => storeOf(hostId).shown;

/** Reads `hostId`'s links now, and again later while anything watches them. */
export async function readGuestLinks(hostId: string): Promise<void> {
  const store = storeOf(hostId);
  clearTimeout(store.timer);
  const answer = await window.parallax.request(hostId, "guest/list", {});
  if ("result" in answer) setGuestLinks(hostId, answer.result);
  clearTimeout(store.timer);
  if (store.watchers.size)
    store.timer = setTimeout(
      () => void readGuestLinks(hostId),
      store.shown.links.length ? LIVE_MS : IDLE_MS,
    );
}

/** Watches `hostId`'s links: the first watcher starts the reads, and the last one out ends them. */
function watch(hostId: string, watcher: () => void): () => void {
  const store = storeOf(hostId);
  store.watchers.add(watcher);
  if (store.watchers.size === 1) void readGuestLinks(hostId);
  return () => {
    store.watchers.delete(watcher);
    if (!store.watchers.size) clearTimeout(store.timer);
  };
}

const unwatched = () => () => {};

/**
 * `hostId`'s live guest links, kept current while mounted, and whether they've been read. Not read
 * while `enabled` is false, as for a plxd without `guestLinks` or one that isn't connected.
 */
export function useGuestLinks(hostId: string, enabled: boolean): GuestLinks {
  // Stable between renders: a new one each render would unsubscribe, which ends the reads.
  const subscribe = useCallback(
    (watcher: () => void) => (enabled ? watch(hostId, watcher) : unwatched()),
    [hostId, enabled],
  );
  const shown = useSyncExternalStore(subscribe, () => storeOf(hostId).shown);
  return enabled ? shown : unread;
}

/** Thread `threadId`'s live guest link on `hostId`, kept current while mounted, or undefined. */
export function useGuestLink(
  hostId: string,
  threadId: string,
  enabled: boolean,
): GuestLink | undefined {
  return useGuestLinks(hostId, enabled).links.find((link) => link.threadId === threadId);
}
