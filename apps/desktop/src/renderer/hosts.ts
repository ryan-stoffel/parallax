import { useEffect, useMemo, useState } from "react";

import type { ConnectState, DeviceHost, DeviceIcon, SshHost } from "../preload/bridge";

/**
 * A host as the sidebar lists it. Only SSH hosts have a destination, and only Parallax Connect
 * devices (0056) a `device`. `icon` is this computer's or a device's.
 */
export type Host = {
  id: string;
  name: string;
  destination?: string;
  icon?: DeviceIcon;
  device?: Omit<DeviceHost, "id" | "name" | "icon">;
};

/** This computer's host id, which is always there. */
export const localId = "local";

/** Parallax Connect here, kept current; undefined until main answers. */
export function useConnect(): ConnectState | undefined {
  const [state, setState] = useState<ConnectState>();
  useEffect(() => window.parallax.onConnect(setState), []);
  return state;
}

/**
 * Every host, kept current: this computer first, named as Settings > Connections names it, then
 * the saved SSH hosts, oldest first, then the Connect devices, by name.
 */
export function useHosts(): Host[] {
  const [saved, setSaved] = useState<SshHost[]>([]);
  const [devices, setDevices] = useState<DeviceHost[]>([]);
  const [localName, setLocalName] = useState("This computer");
  const connect = useConnect();
  useEffect(() => {
    const stop = window.parallax.onHosts(setSaved);
    void window.parallax.hosts().then(setSaved);
    return stop;
  }, []);
  useEffect(() => window.parallax.onLocalName(setLocalName), []);
  useEffect(() => window.parallax.onDevices(setDevices), []);
  const icon = connect?.on ? connect.icon : undefined;
  // The same array until the hosts change, so lists built from it can be kept.
  return useMemo(
    () => [
      { id: localId, name: localName, ...(icon && { icon }) },
      ...saved,
      ...devices.map(({ id, name, icon, ...device }) => ({ id, name, icon, device })),
    ],
    [saved, devices, localName, icon],
  );
}
