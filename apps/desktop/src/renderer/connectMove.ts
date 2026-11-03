import { useEffect, useState } from "react";

import type { DeviceHost } from "../preload/bridge";
import { useConnect } from "./hosts";
import { notify } from "./notifications";
import { useProfile } from "./profile";

// Moving off the Tailscale-only way of Parallax Connect (0056) to the account and relay (0091).
// Settings > Connections has the button, and the notice below offers it once.

const KEY = "connect-move";
/** How long a move waits for its computers to answer through the account. */
export const MOVE_WAIT_MS = 60_000;

/** The computers this app still uses over Tailscale, less those turned off here. */
const onTailscale = (devices: DeviceHost[]) =>
  devices.filter((d) => d.enabled && d.id.startsWith("tailnet:"));

/**
 * Whether this computer still runs Connect over Tailscale: Connect is on here, and a computer is
 * still reached that way, or this app is signed out, so nothing has moved to the account.
 */
export function useNeedsConnectMove(): boolean {
  const connect = useConnect();
  const profile = useProfile();
  const [devices, setDevices] = useState<DeviceHost[]>([]);
  useEffect(() => window.parallax.onDevices(setDevices), []);
  return !!connect?.on && (onTailscale(devices).length > 0 || profile === null);
}

/** The names of the computers still on Tailscale, once none are or `MOVE_WAIT_MS` passes. */
function moved(): Promise<string[]> {
  return new Promise((resolve) => {
    let left: string[] | undefined;
    const finish = () => {
      window.clearTimeout(timer);
      stop();
      resolve(left ?? []);
    };
    const timer = window.setTimeout(finish, MOVE_WAIT_MS);
    const stop = window.parallax.onDevices((devices) => {
      left = onTailscale(devices).map((d) => d.name);
      if (!left.length) queueMicrotask(finish);
    });
  });
}

let running: Promise<void> | undefined;

async function run(): Promise<void> {
  notify({
    key: KEY,
    tone: "info",
    title: "Moving to the new Parallax Connect",
    body: "If your browser opens, sign in there. Parallax does the rest.",
    progress: {},
  });
  const failed = await window.parallax.moveConnect();
  if (failed)
    return notify({
      key: KEY,
      tone: "error",
      title: "Couldn't move to the new Parallax Connect",
      body: failed,
      action: { label: "Try again", run: () => void moveConnect() },
    });
  const left = await moved();
  if (left.length)
    return notify({
      key: KEY,
      tone: "info",
      title: "Almost moved to the new Parallax Connect",
      body: `Still waiting on ${left.join(", ")}. Leave ${left.length === 1 ? "it" : "them"} on and Parallax finishes the move.`,
    });
  notify({
    key: KEY,
    tone: "success",
    title: "You're on the new Parallax Connect",
    body: "Your computers now connect through your Parallax account, with no Tailscale needed.",
  });
}

/** Moves everything to the new Connect, telling the user how it goes. One move runs at a time. */
export function moveConnect(): Promise<void> {
  running ??= run().finally(() => (running = undefined));
  return running;
}

/** Recommends the new Connect once on a computer that still runs it over Tailscale. */
export function useConnectMoveAlarm() {
  const needed = useNeedsConnectMove();
  useEffect(() => {
    if (!needed) return;
    void window.parallax.claimConnectMove().then((first) => {
      if (!first) return;
      notify({
        key: KEY,
        tone: "info",
        title: "Try the new Parallax Connect",
        body: "Reach your computers from anywhere through Parallax's own tunnel, with no Tailscale needed.",
        action: { label: "Move to new Connect", run: () => void moveConnect() },
        // It shows only once, so it stays until closed.
        sticky: true,
      });
    });
  }, [needed]);
}
