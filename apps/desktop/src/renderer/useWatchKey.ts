import { useCallback, useState } from "react";

/**
 * When to open a `window.parallax.watch` (0059) on `id`: once its host first connects. It stays
 * open across disconnects, so main resumes it after its last event and plxd replays the gap, or
 * sends a snapshot when the gap is too long. One that ended with an error opens again when the
 * host next reconnects, as after updating its plxd. Returns the key to open it under, undefined
 * until then, which changes only to open it again, and the function to call on its error.
 */
export function useWatchKey(id: string, connected: boolean): [string | undefined, () => void] {
  const [opened, setOpened] = useState<{ id: string; key: string; failed?: boolean }>();
  const [count, setCount] = useState(0);
  if (connected && opened?.id !== id) {
    setOpened({ id, key: `${id}\n${count}` });
    setCount(count + 1);
  }
  // Ended with an error: closed now, and opened again on the next connection.
  if (!connected && opened?.failed) setOpened(undefined);
  const failed = useCallback(() => setOpened((o) => o && { ...o, failed: true }), []);
  return [opened?.id === id ? opened.key : undefined, failed];
}
