import { useEffect, useSyncExternalStore } from "react";

import type { ConnectionState } from "../preload/bridge";

// Every host's last known state, shared by all views, so a view that changes host reads the new
// host's state on its first render rather than showing it as connecting until IPC answers. Kept
// only while something listens, since a state nobody hears about can go stale.
const states = new Map<string, ConnectionState>();
const listeners = new Set<() => void>();
let stopListening: (() => void) | undefined;
const put = (hostId: string, state: ConnectionState) => {
  states.set(hostId, state);
  for (const listener of listeners) listener();
};
function subscribe(listener: () => void) {
  listeners.add(listener);
  stopListening ??= window.parallax.onConnectionState(put);
  return () => {
    listeners.delete(listener);
    if (listeners.size > 0) return;
    stopListening?.();
    stopListening = undefined;
    states.clear();
  };
}

/** A host's connection state, kept current. Undefined until the first answer for this host. */
export function useConnection(hostId: string): ConnectionState | undefined {
  const state = useSyncExternalStore(subscribe, () => states.get(hostId));
  useEffect(() => {
    // Asked on every mount too, since the state may have changed while nothing listened. It
    // rejects only for a host just removed, whose views are going away.
    window.parallax.connectionState(hostId).then(
      (next) => put(hostId, next),
      () => {},
    );
  }, [hostId]);
  return state;
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
    <div role="status" className="px-2 py-1 text-[12px] text-muted-foreground">
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
            className="rounded px-1.5 text-foreground hover:bg-hover"
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
