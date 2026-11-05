// A computer's Parallax row (PLX-1366): its plxd version, Update when its channel has a newer
// release for it, and how the update is going.
import { ActivityIndicator } from "react-native";

import { isOlder } from "../../desktop/src/main/hostUpdate";
import { updateComputer, useComputerUpdate, useNewestVersion } from "./computerUpdate";
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

  /** Asks first when the restart would cut off running threads, as Update everything does. */
  const start = async (version: string) => {
    const health = await window.parallax.request(id, "host/health", {});
    const running = "result" in health ? health.result.runningAgents : 0;
    const go = () => void updateComputer(id, version, (target, now) => updateHost(id, target, now));
    if (running === 0) return go();
    const threads = running === 1 ? "1 running thread" : `${running} running threads`;
    showAlert(
      `Update ${m.machine.name}?`,
      `Parallax restarts there now, which cuts off ${threads}. They go on afterward if Continue threads after restarts is on.`,
      [
        { text: "Cancel", style: "cancel" },
        { text: "Update", style: "destructive", onPress: go },
      ],
    );
  };

  const busy = <ActivityIndicator size="small" color={c.mutedForeground} />;
  switch (update?.stage) {
    case "installing":
      return <Row title="Parallax" detail={`Downloading ${update.version}…`} right={busy} />;
    case "restarting":
      return <Row title="Parallax" detail={`Restarting on ${update.version}…`} right={busy} />;
    case "waiting":
      return (
        <Row
          title="Parallax"
          detail={`Restarts on ${update.version} when ${update.running === 1 ? "1 running thread ends" : `${update.running} running threads end`}.`}
          right={busy}
        />
      );
    case "failed":
      // One that came back on the version after all, as when the phone slept through it, didn't fail.
      if (shown && !isOlder(shown, update.version)) break;
      return (
        <Row
          title="Parallax"
          detail={update.error}
          right={plxd ? <Action label="Retry" onPress={() => void start(update.version)} /> : undefined}
        />
      );
  }
  if (!shown) return null;
  if (plxd && newest && isOlder(plxd, newest))
    return (
      <Row
        title="Parallax"
        detail={`${plxd} · ${newest} is out`}
        right={<Action label="Update" onPress={() => void start(newest)} />}
      />
    );
  return <Row title="Parallax" detail={shown} />;
}
