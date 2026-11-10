import { useEffect, useState } from "react";

import type { DeviceHost } from "../../preload/bridge";
import { SetupCodeDialog } from "../ConnectWizard";
import { localId, useConnect, useHosts, type Host } from "../hosts";
import { hostIcon } from "../RunTargetMenu";
import { Picker } from "../ui";
import { AgentWorkRow } from "./AgentsAcrossComputers";
import { card } from "./connectionParts";
import { ThisComputerHeading, ThisComputerNotices, VersionRow } from "./ConnectSettings";
import { DevicesWithAccess, SharingRows, useAccountSignIn, useLocalAccess } from "./LanSettings";
import { PageTitle } from "./parts";

/**
 * Another of the account's computers on Sharing & access: its plxd, and the one sharing setting of
 * its own that can be changed from here, whether agents can work on it (0101).
 */
function OtherComputer({ host, device }: { host: Host; device: DeviceHost | undefined }) {
  return (
    <>
      <div className="mb-3 flex min-h-7 items-center gap-2">
        <span className="shrink-0 text-muted-foreground [&_svg]:size-4">{hostIcon(host)}</span>
        <h2 className="truncate text-reading font-semibold">{host.name}</h2>
      </div>
      <div className={`${card} mb-3`}>
        <VersionRow hostId={host.id} />
        <AgentWorkRow host={host} device={device ?? {}} />
      </div>
      <p className="mb-10 px-1 text-meta text-muted-foreground">
        Its other sharing settings are in Settings on {host.name}.
      </p>
    </>
  );
}

/**
 * Settings > Sharing & access (PLX-1492): how a computer is reached, and what can reach it. This
 * computer's plxd and its switches in one card, with what's wrong with it on the account at the
 * top, then the devices with access to it. With other computers on the account, Showing access for
 * picks one of them instead, for the one setting of theirs this app can change. The computers this
 * app uses are the other Connections page, Computers (`ConnectionSettings`).
 */
export function SharingSettings() {
  const hosts = useHosts();
  const connect = useConnect();
  const account = useAccountSignIn();
  const access = useLocalAccess();
  const [devices, setDevices] = useState<DeviceHost[]>([]);
  useEffect(() => window.parallax.onDevices(setDevices), []);
  const [showingCode, setShowingCode] = useState(false);
  const here = hosts.find((h) => h.id === localId)!;
  const others = hosts.filter((h) => h.id.startsWith("account:"));
  const [shownId, setShownId] = useState(localId);
  // This computer, unless another is picked and still there.
  const other = others.find((h) => h.id === shownId);

  return (
    <>
      <PageTitle title="Sharing & access">
        How a computer is reached, and what can reach it.
      </PageTitle>
      {others.length > 0 && (
        <div className="mb-6 flex flex-wrap items-center gap-1.5 text-reading text-muted-foreground">
          Showing access for
          <Picker
            field
            label="Showing access for"
            value={other?.id ?? localId}
            onChange={setShownId}
            options={[here, ...others].map((h) => ({ value: h.id, label: h.name }))}
            className="max-w-56"
            panelClassName="min-w-48"
          />
        </div>
      )}
      {other ? (
        <OtherComputer
          key={other.id}
          host={other}
          device={devices.find((d) => d.id === other.id)}
        />
      ) : (
        <>
          <ThisComputerHeading host={here} connect={connect} />
          <div className={`${card} mb-10`}>
            <ThisComputerNotices />
            <VersionRow hostId={localId} here />
            <SharingRows
              access={access}
              connect={connect}
              signedOut={account.signedOut}
              signingIn={account.signingIn}
              onSignIn={account.onSignIn}
              {...(account.signedIn && { onShowCode: () => setShowingCode(true) })}
            />
          </div>
          <DevicesWithAccess access={access} />
        </>
      )}
      {showingCode && (
        <SetupCodeDialog
          name={here.name}
          onReady={access.reload}
          onClose={() => setShowingCode(false)}
        />
      )}
    </>
  );
}
