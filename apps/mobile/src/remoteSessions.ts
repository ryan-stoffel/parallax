import { useCallback, useEffect, useState } from "react";

import type { RemoteSessionsResult } from "../../desktop/src/protocol/generated/protocol";

/**
 * Computer `id`'s paired devices and pairing state, where it has `remote`, and how to read them
 * again. They're read while it's really connected, and again each time it comes back.
 */
export function useRemoteSessions(id: string, remote: boolean, connectedNow: boolean) {
  const [status, setStatus] = useState<RemoteSessionsResult>();
  const readSessions = useCallback(async () => {
    const answer = await window.parallax.request(id, "remote/sessions", {});
    if ("result" in answer) setStatus(answer.result);
  }, [id]);
  useEffect(() => {
    if (remote && connectedNow) void readSessions();
  }, [remote, connectedNow, readSessions]);
  return { status, setStatus, readSessions };
}
