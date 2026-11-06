import { useCallback, useEffect, useRef, useState } from "react";

/**
 * When to open a `window.parallax.watch` (0059) on `id`: once its host first connects. It stays
 * open across disconnects, so main resumes it after its last event and plxd replays the gap, or
 * sends a snapshot when the gap is too long. One that ended with an error opens again when the
 * host next reconnects, as after updating its plxd. Returns the key to open it under, undefined
 * until then, which changes only to open it again, and the function to call on its error.
 */
export function useWatchKey(
  id: string,
  connected: boolean,
  hostId: string,
): [string | undefined, () => void] {
  const [opened, setOpened] = useState<{ id: string; key: string }>();
  const [count, setCount] = useState(0);
  const failedKey = useRef<string>(undefined);
  if (connected && opened?.id !== id) {
    setOpened({ id, key: `${id}\n${count}` });
    setCount(count + 1);
  }
  // Read each connection event. React may batch a fast disconnect/reconnect into one render.
  useEffect(
    () =>
      window.parallax.onConnectionState((host, state) => {
        if (
          host === hostId &&
          state.status === "connected" &&
          opened &&
          failedKey.current === opened.key
        ) {
          failedKey.current = undefined;
          setOpened(undefined);
        }
      }),
    [hostId, opened],
  );
  const failed = useCallback(() => {
    failedKey.current = opened?.key;
  }, [opened?.key]);
  return [opened?.id === id ? opened.key : undefined, failed];
}
