import { useEffect, useState } from "react";

import type { HostSettings, HostSettingsSetParams } from "../../protocol/generated/protocol";
import { useShownConnections, useRealConnections } from "../ConnectionStatus";
import { describeError } from "../errors";
import type { Host } from "../hosts";
import { notify } from "../notifications";

/**
 * Whether `hostId`'s plxd keeps a deleted thread's worktree and branch on disk, for a delete's
 * warning: its `deletedThreadWorktrees` is off. False for a plxd without the setting, and for one
 * that doesn't answer, since deleting them is what plxd does unless told otherwise.
 */
export async function keepsDeletedWorktrees(hostId: string): Promise<boolean> {
  const answer = await window.parallax.request(hostId, "host/settings/get", {});
  return "result" in answer && answer.result.deletedThreadWorktrees === false;
}

/**
 * `host/settings` on each of `targets` that's connected, for a page that changes them on one
 * computer or on all of them. `able` names those whose plxd has a capability, `shared` reads a
 * setting across them, and `set` changes it on each, saying which one refused.
 */
export function useHostSettings(targets: Host[]) {
  const connections = useShownConnections(targets.map((h) => h.id));
  const connected = targets.flatMap((host, i) => {
    const state = connections[i];
    return state?.status === "connected" ? [{ host, capabilities: state.capabilities }] : [];
  });
  // Read by the real connections, each time one comes back. What's read stays while one is away, so
  // a short reconnect doesn't empty the page.
  const real = useRealConnections(targets.map((h) => h.id));
  const up = targets.filter((_, i) => real[i]?.status === "connected");
  const key = up.map((host) => host.id).join("\n");
  const [settings, setSettings] = useState<Record<string, HostSettings>>({});
  const [error, setError] = useState<string>();
  useEffect(() => {
    setError(undefined);
    let stale = false;
    for (const host of up)
      void window.parallax.request(host.id, "host/settings/get", {}).then((answer) => {
        if (stale) return;
        if ("error" in answer) setError(`${host.name}: ${describeError(answer.error)}`);
        else setSettings((all) => ({ ...all, [host.id]: answer.result }));
      });
    return () => {
      stale = true;
    };
  }, [key]);

  const able = (capability: string) =>
    connected.filter((c) => capability in c.capabilities).map((c) => c.host);

  return {
    able,
    /** Whether any target is connected. */
    connected: connected.length > 0,
    error,
    /** What `read` says on the computers with `capability`, and whether they differ. */
    shared: <T>(capability: string, read: (settings: HostSettings) => T) => {
      const values = able(capability).flatMap((h) => {
        const loaded = settings[h.id];
        return loaded ? [read(loaded)] : [];
      });
      return {
        loaded: values.length > 0,
        value: values[0],
        mixed: values.some((v) => v !== values[0]),
      };
    },
    /** Changes a setting on every computer with `capability`. `failed` titles a refusal. */
    set: (capability: string, change: HostSettingsSetParams, failed: string) =>
      Promise.all(
        able(capability).map(async (host) => {
          const answer = await window.parallax.request(host.id, "host/settings/set", change);
          if ("error" in answer)
            notify({
              tone: "error",
              title: `${failed} on ${host.name}`,
              body: describeError(answer.error),
            });
          else setSettings((all) => ({ ...all, [host.id]: answer.result }));
        }),
      ),
  };
}
