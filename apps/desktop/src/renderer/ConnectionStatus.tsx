import { useEffect, useRef, useSyncExternalStore } from "react";

import type { ConnectionState } from "../preload/bridge";
import { ReconnectGrace } from "./reconnectGrace";

// Every host's connection state as clients show it, shared by all views, so a view that changes
// host reads the new host's state on its first render rather than showing it as connecting until
// IPC answers. A reconnect stays hidden here for a few seconds (`ReconnectGrace`), so what needs
// the truth, such as whether a request can go now, asks `window.parallax` instead. Kept only while
// something listens, since a state nobody hears about can go stale.
const states = new Map<string, ConnectionState>();
const listeners = new Set<() => void>();
const changeListeners = new Set<(hostId: string, state: ConnectionState) => void>();
let stopListening: (() => void) | undefined;
const changed = () => {
  for (const listener of listeners) listener();
};
const grace = new ReconnectGrace(
  (hostId) => states.get(hostId),
  (hostId, state) => {
    states.set(hostId, state);
    changed();
    for (const listener of changeListeners) listener(hostId, state);
  },
);
function subscribe(listener: () => void) {
  listeners.add(listener);
  stopListening ??= window.parallax.onConnectionState((hostId, state) => grace.hear(hostId, state));
  return () => {
    listeners.delete(listener);
    if (listeners.size > 0) return;
    stopListening?.();
    stopListening = undefined;
    grace.clear();
    states.clear();
  };
}

/** Asks for `hostId`'s state, unless it's known already, in which case every change was heard. */
function ask(hostId: string) {
  // It rejects only for a host just removed, whose views are going away.
  window.parallax.connectionState(hostId).then(
    (state) => {
      if (listeners.size === 0 || states.has(hostId)) return;
      states.set(hostId, state);
      changed();
    },
    () => {},
  );
}

/** A host's connection state as shown, kept current. Undefined until the first answer for it. */
export function useConnection(hostId: string): ConnectionState | undefined {
  const state = useSyncExternalStore(subscribe, () => states.get(hostId));
  // On every mount too, since the state may have changed while nothing listened.
  useEffect(() => ask(hostId), [hostId]);
  return state;
}

/** Each of `hostIds`' connection states, in order, kept current, as `useConnection` for several. */
export function useConnections(hostIds: string[]): (ConnectionState | undefined)[] {
  const last = useRef<(ConnectionState | undefined)[]>([]);
  // The same array until a state changes, as useSyncExternalStore needs.
  const read = () => {
    const next = hostIds.map((id) => states.get(id));
    const same = next.length === last.current.length && next.every((s, i) => s === last.current[i]);
    if (!same) last.current = next;
    return last.current;
  };
  const listed = useSyncExternalStore(subscribe, read);
  const key = hostIds.join("\n");
  useEffect(() => {
    for (const id of key.split("\n")) ask(id);
  }, [key]);
  return listed;
}

/**
 * Hears each change to any host's state as shown, for what reports a drop rather than renders it.
 * Returns the unsubscribe function. A host nothing has asked about yet shows its drop at once, so
 * pass its id to `useConnections` too.
 */
export function onConnectionShown(
  listener: (hostId: string, state: ConnectionState) => void,
): () => void {
  const stop = subscribe(() => {});
  changeListeners.add(listener);
  return () => {
    changeListeners.delete(listener);
    stop();
  };
}

/**
 * Forgets each host that leaves `hosts`, so adding it back is a first connect, shown as it happens.
 * Main says nothing when it drops a host's connection, as for a device turned off.
 */
export function useForgetRemoved(hosts: { id: string }[]) {
  const before = useRef(hosts);
  useEffect(() => {
    for (const { id } of before.current) {
      if (hosts.some((host) => host.id === id)) continue;
      grace.forget(id);
      if (states.delete(id)) changed();
    }
    before.current = hosts;
  }, [hosts]);
}

/** Why a host's chat is off while it isn't connected, or undefined once it is. */
export const offlineReason = (state?: ConnectionState) =>
  state?.status === "connected"
    ? undefined
    : state?.status === "failed"
      ? "Disconnected from plxd"
      : "Connecting to plxd…";

/** A small dot in the state's color: green, pulsing amber, or red. */
export function StatusDot({ state }: { state: ConnectionState | undefined }) {
  const color = {
    connected: "bg-emerald-500",
    connecting: "bg-amber-500 animate-pulse",
    failed: "bg-red-500",
  }[state?.status ?? "connecting"];
  return <span aria-hidden className={`size-1.5 shrink-0 rounded-full ${color}`} />;
}

/** The state in a word or two. */
export function statusLabel(state: ConnectionState): string {
  if (state.status === "connected") return "Connected";
  if (state.status === "connecting") return "Connecting…";
  return state.retrying ? "Reconnecting…" : "Disconnected";
}

/**
 * A quiet status line for the sidebar's footer, for the open host, shown only while it isn't
 * connected: a dot and a word while connecting; on failure, why, and Retry once it stops retrying
 * by itself. The tail of attach's (and ssh's) stderr is only in the tooltip.
 */
export function ConnectionStatus({ hostId }: { hostId: string }) {
  const state = useConnection(hostId);
  if (!state || state.status === "connected") return null;

  const failed = state.status === "failed";
  const label = statusLabel(state);

  return (
    <div role="status" className="px-2 py-1 text-meta text-muted-foreground">
      <div className="flex items-center gap-2">
        {/* As wide as the Settings icon below, so the two line up. */}
        <span aria-hidden className="grid w-4 shrink-0 place-items-center">
          <StatusDot state={state} />
        </span>
        <span className="min-w-0 flex-1 truncate">{label}</span>
        {failed && !state.retrying && (
          <button
            type="button"
            onClick={() => void window.parallax.retry(hostId)}
            className="rounded-sm px-1.5 text-foreground hover:bg-hover"
          >
            Retry
          </button>
        )}
      </div>
      {failed && (
        <p title={state.error.stderr} className="mt-0.5 line-clamp-4 pl-6 text-faint-foreground">
          {state.error.message}
        </p>
      )}
    </div>
  );
}
