import { useEffect, useRef, useState } from "react";

import type { DeviceHost } from "../../preload/bridge";
import { useConnect, useHosts } from "../hosts";
import { LoadBalancerCard } from "./AgentsAcrossComputers";
import { Computers } from "./ConnectSettings";
import { useAccountSignIn, useLocalAccess } from "./LanSettings";

export { plxdFix } from "./ConnectSettings";

/**
 * Settings > Computers (PLX-1492): the computers this app uses. Every other computer is a card,
 * however it was added, with its status, the one thing it needs, whether the app uses it, and its
 * routes inside. Under them, the Load Balancer over all of them (0101). How this computer is reached
 * is the other Connections page, Sharing & access (`SharingSettings`).
 */
export function ConnectionSettings() {
  const hosts = useHosts();
  const connect = useConnect();
  const account = useAccountSignIn();
  const access = useLocalAccess();
  const [devices, setDevices] = useState<DeviceHost[]>([]);
  useEffect(() => window.parallax.onDevices(setDevices), []);
  const [appVersion, setAppVersion] = useState<string>();
  useEffect(() => void window.parallax.version().then(setAppVersion), []);
  // The account's list follows its computers: one that joins or leaves changes the list.
  const onAccount = devices
    .filter((d) => d.id.startsWith("account:"))
    .map((d) => d.id)
    .join(" ");
  const listed = useRef(onAccount);
  useEffect(() => {
    if (listed.current === onAccount) return;
    listed.current = onAccount;
    access.refreshRelayHosts();
  }, [onAccount]);
  // A removed account computer leaves the list held here at once, not at the next read, so it
  // can't show again as a computer this app has no device for.
  const removeDevice = async (deviceId: string) => {
    if (deviceId.startsWith("account:")) access.forgetRelayHost(deviceId.slice("account:".length));
    const failed = await window.parallax.removeDevice(deviceId);
    access.refreshRelayHosts();
    return failed;
  };
  // The account's computers this app has no device for, which only their relay entry can remove.
  const accountOnly = (access.relayHosts ?? []).filter(
    (h) => !h.thisComputer && !devices.some((d) => d.id === `account:${h.hostId}`),
  );

  return (
    <>
      <Computers
        hosts={hosts}
        devices={devices}
        connect={connect}
        signedOut={account.signedOut}
        signingIn={account.signingIn}
        onSignIn={account.onSignIn}
        appVersion={appVersion}
        accountOnly={accountOnly}
        removeAccountOnly={access.removeRelayHost}
        removeDevice={removeDevice}
      />
      <LoadBalancerCard hosts={hosts} />
    </>
  );
}
