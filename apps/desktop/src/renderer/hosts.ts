import { useEffect, useMemo, useState } from "react";

import type { SshHost } from "../preload/bridge";

/** A host as the sidebar lists it. Only SSH hosts have a destination. */
export type Host = { id: string; name: string; destination?: string };

/** This computer's host id, which is always there. */
export const localId = "local";

/**
 * Every host, kept current: this computer first, named as Settings > Connections names it, then
 * the saved SSH hosts, oldest first.
 */
export function useHosts(): Host[] {
  const [saved, setSaved] = useState<SshHost[]>([]);
  const [localName, setLocalName] = useState("This computer");
  useEffect(() => {
    const stop = window.parallax.onHosts(setSaved);
    void window.parallax.hosts().then(setSaved);
    return stop;
  }, []);
  useEffect(() => window.parallax.onLocalName(setLocalName), []);
  // The same array until the hosts change, so lists built from it can be kept.
  return useMemo(() => [{ id: localId, name: localName }, ...saved], [saved, localName]);
}
