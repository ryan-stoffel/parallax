import { useEffect, useState } from "react";

import type { ConnectionState } from "../preload/bridge";

/** A host's connection state, kept current. Undefined until the first answer for this host. */
export function useConnection(hostId: string): ConnectionState | undefined {
  // Tagged with its host, so switching hosts never shows the last host's state.
  const [known, setKnown] = useState<{ hostId: string; state: ConnectionState }>();
  useEffect(() => {
    const set = (state: ConnectionState) => setKnown({ hostId, state });
    const stop = window.parallax.onConnectionState((id, next) => id === hostId && set(next));
    // It rejects only for a host just removed, whose views are going away.
    window.parallax.connectionState(hostId).then(set, () => {});
    return stop;
  }, [hostId]);
  return known?.hostId === hostId ? known.state : undefined;
}

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
 * A quiet status line for the sidebar's footer, for the open host: a dot and a
 * word while things are fine; on failure, why, and Retry once it stops retrying
 * by itself. The tail of attach's (and ssh's) stderr is only in the tooltip.
 */
export function ConnectionStatus({ hostId }: { hostId: string }) {
  const state = useConnection(hostId);
  if (!state) return null;

  const failed = state.status === "failed";
  const label = statusLabel(state);

  return (
    <div role="status" className="px-2 py-1 text-[12px] text-muted-foreground">
      <div className="flex items-center gap-2">
        {/* As wide as the Settings icon below, so the two line up. */}
        <span aria-hidden className="grid w-4 shrink-0 place-items-center">
          <StatusDot state={state} />
        </span>
        <span className="min-w-0 flex-1 truncate">
          {label}
          {state.status === "connected" && (
            <span className="text-faint-foreground"> · plxd {state.plxd}</span>
          )}
        </span>
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
