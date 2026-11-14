import { t } from "i18next";
import { useState } from "react";

import { SetupCodeDialog } from "../ConnectWizard";
import { localId, useConnect, useHosts } from "../hosts";
import { ThisComputerHeading, ThisComputerNotices, VersionRow } from "./ConnectSettings";
import {
  ConnectCard,
  DevicesWithAccess,
  MoreWaysIn,
  SshCard,
  useAccountSignIn,
  useLocalAccess,
} from "./LanSettings";
import { PageTitle } from "./parts";

/**
 * Settings > Sharing & access (PLX-1492): how this computer is reached, and what can reach it. Its
 * name, and what's wrong with it on the account, then the two main ways in, Parallax Connect and
 * SSH, then the less common ones, the devices with access, and its version. Another computer's
 * settings are in its card on Computers (`ConnectionSettings`).
 */
export function SharingSettings() {
  const hosts = useHosts();
  const connect = useConnect();
  const account = useAccountSignIn();
  const access = useLocalAccess();
  const [showingCode, setShowingCode] = useState(false);
  const here = hosts.find((h) => h.id === localId)!;

  return (
    <>
      <PageTitle title={t("Sharing & access")}>
        {t("How your other devices reach this computer, and which ones can.")}
      </PageTitle>
      <ThisComputerHeading host={here} connect={connect} />
      <ThisComputerNotices />
      <ConnectCard
        access={access}
        signedOut={account.signedOut}
        signingIn={account.signingIn}
        onSignIn={account.onSignIn}
        {...(account.signedIn && { onShowCode: () => setShowingCode(true) })}
      />
      <SshCard />
      <MoreWaysIn access={access} connect={connect} />
      <DevicesWithAccess access={access} />
      <VersionRow />
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
