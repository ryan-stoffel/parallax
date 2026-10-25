import type { WatchMessage } from "../preload/bridge";
import type { ThreadSnapshot } from "../protocol/generated/protocol";

export type ThreadMessage = WatchMessage<ThreadSnapshot>;

/** How many closed threads stay watched, so reopening one shows it as it is now, at once. */
const KEPT = 6;
/** A closed thread's watch closes once this many events since its snapshot pile up. */
const MAX_EVENTS = 5000;
/** How long the pointer rests on a thread's row before its watch opens. */
const PREFETCH_MS = 120;

/**
 * One thread's watch: its last snapshot and every event since, who shows it, and whether anyone
 * has, unlike one only prefetched.
 */
type Entry = {
  messages: ThreadMessage[];
  listeners: Set<(messages: ThreadMessage[]) => void>;
  stop: () => void;
  shown: boolean;
};

/**
 * The watches by host and thread, least recently used first, and the bridge they watch through.
 * Another bridge, as each test fakes, starts with none.
 */
let cache: { bridge: object; entries: Map<string, Entry> } | undefined;
let pending: ReturnType<typeof setTimeout> | undefined;

const keyOf = (hostId: string, threadId: string) => `${hostId}\n${threadId}`;

function current() {
  if (cache?.bridge !== window.parallax) {
    for (const e of cache?.entries.values() ?? []) e.stop();
    cache = { bridge: window.parallax, entries: new Map() };
  }
  return cache.entries;
}

function close(entries: Map<string, Entry>, key: string) {
  entries.get(key)?.stop();
  entries.delete(key);
}

/** Closes the least recently used closed threads' watches beyond `KEPT`, prefetched ones aside. */
function trim(entries: Map<string, Entry>) {
  const kept = (e: Entry) => e.shown && e.listeners.size === 0;
  let idle = [...entries.values()].filter(kept).length;
  for (const [key, e] of entries) {
    if (idle <= KEPT) return;
    if (!kept(e)) continue;
    close(entries, key);
    idle--;
  }
}

/** Thread `threadId`'s entry, opening its watch if it has none, now the most recently used. */
function open(entries: Map<string, Entry>, hostId: string, threadId: string): Entry {
  const key = keyOf(hostId, threadId);
  const found = entries.get(key);
  if (found) {
    entries.delete(key);
    entries.set(key, found);
    return found;
  }
  const e: Entry = { messages: [], listeners: new Set(), stop: () => {}, shown: false };
  e.stop = window.parallax.watch(hostId, { threadId }, (message) => {
    if (message.type === "snapshot") e.messages = [message];
    else e.messages.push(message);
    // An error ended it, as when its host's connection closed, so the next to show the thread
    // opens it again.
    if (message.type === "error" && entries.get(key) === e) entries.delete(key);
    else if (e.listeners.size === 0 && e.messages.length > MAX_EVENTS) close(entries, key);
    for (const l of e.listeners) l([message]);
  });
  entries.set(key, e);
  return e;
}

/**
 * Watches thread `threadId` on host `hostId` through `window.parallax.watch` (0059), shared by
 * everyone who shows it and kept open a while after the last one leaves. `listener` first gets
 * the snapshot and every event since at once, then each message as it comes. Returns the function
 * that stops listening.
 */
export function watchThread(
  hostId: string,
  threadId: string,
  listener: (messages: ThreadMessage[]) => void,
): () => void {
  const entries = current();
  const key = keyOf(hostId, threadId);
  const e = open(entries, hostId, threadId);
  e.shown = true;
  e.listeners.add(listener);
  if (e.messages.length > 0) listener([...e.messages]);
  return () => {
    if (!e.listeners.delete(listener) || e.listeners.size > 0 || entries.get(key) !== e) return;
    if (e.messages.length > MAX_EVENTS) return close(entries, key);
    // The most recently used: last in line to close.
    entries.delete(key);
    entries.set(key, e);
    trim(entries);
  };
}

/**
 * Opens thread `threadId`'s watch once the pointer rests on its row, so a click shows it at once.
 * Only the latest row's stays prefetched, so resting on rows never closes threads the user opened.
 */
export function prefetchThread(hostId: string, threadId: string) {
  clearTimeout(pending);
  pending = setTimeout(() => {
    const entries = current();
    const key = keyOf(hostId, threadId);
    for (const [k, e] of entries) if (k !== key && !e.shown) close(entries, k);
    open(entries, hostId, threadId);
  }, PREFETCH_MS);
}

/** Cancels a prefetch whose row the pointer left. */
export function cancelPrefetch() {
  clearTimeout(pending);
}
