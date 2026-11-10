import { KeyRound } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import type { DeviceHost } from "../../preload/bridge";
import { SetupCodeDialog } from "../ConnectWizard";
import { localId, useConnect, useHosts } from "../hosts";
import { notify } from "../notifications";
import { useProfile } from "../profile";
import { BalancerSetting, LoadBalancerSettings, useBalancer } from "./AgentsAcrossComputers";
import { Computers, ThisComputerNotices, ThisComputerRow } from "./ConnectSettings";
import {
  AdvancedSettings,
  DevicesWithAccess,
  ThisComputerAccess,
  useLocalAccess,
} from "./LanSettings";
import { PageTitle, quietButton, Section } from "./parts";

export { plxdFix } from "./ConnectSettings";

/**
 * Settings > Connections, by computer (PLX-1492). This computer: its name, who can reach it, and
 * Show setup code for another computer to add it with.
 * Your computers: every other one once, however it was added, each with its status, the one thing
 * it needs, and its own settings under its row. Then the Load Balancer over them (0101), the
 * devices with access to this computer, and the ways to connect that few need.
 */
export function ConnectionSettings() {
  const hosts = useHosts();
  const connect = useConnect();
  const profile = useProfile();
  const access = useLocalAccess();
  const page = useRef<HTMLDivElement>(null);
  const balancer = useBalancer(hosts, page);
  const [devices, setDevices] = useState<DeviceHost[]>([]);
  useEffect(() => window.parallax.onDevices(setDevices), []);
  const [appVersion, setAppVersion] = useState<string>();
  useEffect(() => void window.parallax.version().then(setAppVersion), []);
  const [showingCode, setShowingCode] = useState(false);
  const [signingIn, setSigningIn] = useState(false);
  const signIn = async () => {
    setSigningIn(true);
    const failed = await window.parallax.signIn(false);
    setSigningIn(false);
    if (failed) notify({ tone: "error", title: "Couldn't sign in", body: failed });
  };
  // Signing in from anywhere turns Reach from anywhere on here, so its row reads it again.
  const signedOut = useRef(false);
  useEffect(() => {
    if (profile === null) {
      signedOut.current = true;
      access.stopExpectingRelay();
    } else if (profile && signedOut.current) {
      signedOut.current = false;
      access.expectRelay();
    }
  }, [profile]);
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
  const here = hosts.find((h) => h.id === localId)!;
  const account = { signedOut: profile === null, signingIn, onSignIn: () => void signIn() };
  // The account's computers this app has no device for, which only their relay entry can remove.
  const accountOnly = (access.relayHosts ?? []).filter(
    (h) => !h.thisComputer && !devices.some((d) => d.id === `account:${h.hostId}`),
  );

  return (
    <div ref={page}>
      <PageTitle title="Connections">
        The computers your agents run on, and what can reach this one.
      </PageTitle>
      <Section
        title="This computer"
        action={
          // Its side of being added from another computer (0091), which Add a computer and the
          // phone send people here for.
          profile && (
            <button
              type="button"
              title="A one-time code to type on another computer that's adding this one."
              onClick={() => setShowingCode(true)}
              className={`${quietButton} flex items-center gap-1 whitespace-nowrap [&_svg]:size-3.5`}
            >
              <KeyRound aria-hidden />
              Show setup code
            </button>
          )
        }
      >
        <ThisComputerNotices />
        <ul aria-label="This computer" className="border-b border-border/40">
          <ThisComputerRow host={here} connect={connect} balancer={balancer} />
        </ul>
        <ThisComputerAccess access={access} {...account} />
        <BalancerSetting host={here} balancer={balancer} card />
      </Section>
      <Computers
        hosts={hosts}
        devices={devices}
        connect={connect}
        {...account}
        balancer={balancer}
        appVersion={appVersion}
        accountOnly={accountOnly}
        removeAccountOnly={access.removeRelayHost}
        removeDevice={removeDevice}
      />
      <LoadBalancerSettings hosts={hosts} balancer={balancer} />
      <DevicesWithAccess access={access} />
      <AdvancedSettings access={access} connect={connect} />
      {showingCode && (
        <SetupCodeDialog
          name={here.name}
          onReady={access.reload}
          onClose={() => setShowingCode(false)}
        />
      )}
    </div>
  );
}
