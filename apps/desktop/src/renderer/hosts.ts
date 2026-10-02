import { useEffect, useMemo, useState } from "react";

import type { SshHost } from "../preload/bridge";

/** A host as the sidebar lists it. Only SSH hosts have a destination. */
export type Host = { id: string; name: string; destination?: string };

/** This computer's host id, which is always there. */
export const localId = "local";

/** Every host, kept current: this computer first, then the saved SSH hosts, oldest first. */
export function useHosts(): Host[] {
  const [saved, setSaved] = useState<SshHost[]>([]);
  useEffect(() => {
    const stop = window.parallax.onHosts(setSaved);
    void window.parallax.hosts().then(setSaved);
    return stop;
  }, []);
  // The same array until the saved hosts change, so lists built from it can be kept.
  return useMemo(() => {
    const local = {
      id: localId,
      name: window.parallax.platform === "darwin" ? "This Mac" : "This computer",
    };
    return [local, ...saved];
  }, [saved]);
}
