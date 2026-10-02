import { useSyncExternalStore } from "react";

/**
 * A setting kept in localStorage under `key`, shared by every window of this computer once it
 * reloads. `parse` turns what's stored into a value, given `fallback` for anything missing.
 * `use` re-renders a component on every `set`.
 */
export function stored<T>(key: string, fallback: T, parse: (raw: unknown, fallback: T) => T) {
  let value = fallback;
  try {
    const raw = localStorage.getItem(key);
    if (raw !== null) value = parse(JSON.parse(raw), fallback);
  } catch {
    // Unreadable: the fallback.
  }
  const listeners = new Set<() => void>();
  const subscribe = (listener: () => void) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
  };
  return {
    get: () => value,
    set(next: T) {
      value = next;
      try {
        localStorage.setItem(key, JSON.stringify(next));
      } catch {
        // Storage is off: the change lasts until the window closes.
      }
      for (const listener of listeners) listener();
    },
    use: () => useSyncExternalStore(subscribe, () => value),
  };
}

/** A stored object's fields over `fallback`'s, for `stored`'s `parse`. */
export const merged = <T extends object>(raw: unknown, fallback: T): T =>
  raw && typeof raw === "object" && !Array.isArray(raw) ? { ...fallback, ...raw } : fallback;
