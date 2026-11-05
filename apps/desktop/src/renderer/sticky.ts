import { useCallback, useState } from "react";

// ponytail: in memory, so typed text lasts until the app quits, as drafts.ts does.
const kept = new Map<string, unknown>();

/**
 * `useState` whose value outlives its component under `key`, for what's typed in a row a virtualized
 * list can unmount by scrolling away. `undefined` forgets it.
 */
export function useSticky<T>(key: string, initial: T) {
  const [value, setValue] = useState<T>(() => (kept.has(key) ? (kept.get(key) as T) : initial));
  const set = useCallback(
    (next: T) => {
      if (next === undefined || next === initial) kept.delete(key);
      else kept.set(key, next);
      setValue(next);
    },
    [key, initial],
  );
  return [value, set] as const;
}
