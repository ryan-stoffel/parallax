// A computer's Parallax row (PLX-1366): its plxd version, Update when its channel has a newer
// release for it, and how the update is going.
import { t } from "i18next";
import { ActivityIndicator } from "react-native";

import { isOlder } from "../../desktop/src/main/hostUpdate";
import { restartCutsOff, sameChannel, updateComputer, useComputerUpdate, useNewestVersion } from "./computerUpdate";
import { showAlert } from "./dialogStore";
import { useFleet, type Computer } from "./fleet";
import { Action, can } from "./SettingsParts";
import { Row, useColors } from "./ui";

export function ComputerVersion({ m }: { m: Computer }) {
  const c = useColors();
  const { updateHost } = useFleet();
  const id = m.machine.id;
  const update = useComputerUpdate(id);
  const shown = m.state.status === "connected" ? m.state.plxd : undefined;
  // What it offers goes by the real connection: the shown one holds on through a short reconnect.
  const plxd = m.connectedNow ? shown : undefined;
  const newest = useNewestVersion(id, can(m, "hostUpdate") ? plxd : undefined);

  /** Asks first when the restart may cut off running threads, as Update everything does. */
  const start = async (version: string) => {
    const go = () => void updateComputer(id, version, (target, now) => updateHost(id, target, now));
    const threads = await restartCutsOff(id);
    if (!threads) return go();
    showAlert(
      t("Update {{name}}?", { name: m.machine.name }),
      t("Parallax restarts there now, which cuts off {{threads}}. They go on afterward if Continue threads after restarts is on.", { threads }),
      [
        { text: t("Cancel"), style: "cancel" },
        { text: t("Update"), style: "destructive", onPress: go },
      ],
    );
  };

  const busy = <ActivityIndicator size="small" color={c.mutedForeground} />;
  switch (update?.stage) {
    case "installing":
      return <Row title="Parallax" detail={t("Downloading {{version}}…", { version: update.version })} right={busy} />;
    case "restarting":
      return <Row title="Parallax" detail={t("Restarting on {{version}}…", { version: update.version })} right={busy} />;
    case "waiting":
      return (
        <Row
          title="Parallax"
          detail={t("Restarts on {{version}} when {{count}} running threads end.", { version: update.version, count: update.running, defaultValue_one: "Restarts on {{version}} when {{count}} running thread ends." })}
          right={busy}
        />
      );
    case "failed":
      // One that came back on the version after all, as when the phone slept through it, didn't
      // fail. One now on another channel mustn't retry a version from the last one.
      if (shown && (!isOlder(shown, update.version) || !sameChannel(shown, update.version))) break;
      return (
        <Row
          title="Parallax"
          detail={update.error}
          right={plxd ? <Action label={t("Retry")} onPress={() => void start(update.version)} /> : undefined}
        />
      );
  }
  if (!shown) return null;
  if (plxd && newest && isOlder(plxd, newest))
    return (
      <Row
        title="Parallax"
        detail={t("{{current}} · {{newest}} is out", { current: plxd, newest })}
        right={<Action label={t("Update")} onPress={() => void start(newest)} />}
      />
    );
  return <Row title="Parallax" detail={shown} />;
}
