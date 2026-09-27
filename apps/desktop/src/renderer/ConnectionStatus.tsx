import { useEffect, useState } from "react";

import type { ConnectionState } from "../preload/bridge";

/** A host's connection state, kept current. Undefined until the first answer. */
export function useConnection(hostId: string): ConnectionState | undefined {
  const [state, setState] = useState<ConnectionState>();
  useEffect(() => {
    const stop = window.wisp.onConnectionState((id, next) => id === hostId && setState(next));
    void window.wisp.connectionState(hostId).then(setState);
    return stop;
  }, [hostId]);
  return state;
}

/**
 * A quiet status line for the sidebar's footer: a dot and a word while things
 * are fine; on failure, why, and Retry once wispd stops retrying by itself.
 * The tail of attach's stderr is only in the tooltip.
 */
export function ConnectionStatus({ hostId }: { hostId: string }) {
  const state = useConnection(hostId);
  if (!state) return null;

  const failed = state.status === "failed";
  const dot = {
    connected: "bg-emerald-500",
    connecting: "bg-amber-500 animate-pulse",
    failed: "bg-red-500",
  }[state.status];
  let label = "Connected";
  if (state.status === "connecting") label = "Connecting…";
  if (state.status === "failed") label = state.retrying ? "Reconnecting…" : "Disconnected";

  return (
    <div role="status" className="px-2 py-1 text-[12px] text-muted-foreground">
      <div className="flex items-center gap-2">
        {/* As wide as the Settings icon below, so the two line up. */}
        <span aria-hidden className="grid w-4 shrink-0 place-items-center">
          <span className={`size-1.5 rounded-full ${dot}`} />
        </span>
        <span className="min-w-0 flex-1 truncate">
          {label}
          {state.status === "connected" && (
            <span className="text-faint-foreground"> · wispd {state.wispd}</span>
          )}
        </span>
        {failed && !state.retrying && (
          <button
            type="button"
            onClick={() => void window.wisp.retry(hostId)}
            className="rounded px-1.5 text-foreground hover:bg-hover"
          >
            Retry
          </button>
        )}
      </div>
      {failed && (
        <p title={state.error.stderr} className="mt-0.5 line-clamp-2 pl-6 text-faint-foreground">
          {state.error.message}
        </p>
      )}
    </div>
  );
}
