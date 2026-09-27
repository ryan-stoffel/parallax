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

/** One line: connected, connecting, or why it failed, with Retry. RYA-13 places and styles it. */
export function ConnectionStatus({ hostId }: { hostId: string }) {
  const state = useConnection(hostId);
  if (!state) return null;
  if (state.status !== "failed") {
    return (
      <p className="text-xs text-neutral-500">
        {state.status === "connected"
          ? `Connected to wispd ${state.wispd}`
          : "Connecting to wispd…"}
      </p>
    );
  }
  const { error, retrying } = state;
  return (
    <p className="max-w-xl text-center text-xs text-red-400" title={error.stderr}>
      {error.message}
      {error.stderr && `: ${error.stderr.split("\n").at(-1)}`}
      {retrying ? " Retrying…" : " "}
      {!retrying && (
        <button className="underline" onClick={() => void window.wisp.retry(hostId)}>
          Retry
        </button>
      )}
    </p>
  );
}
