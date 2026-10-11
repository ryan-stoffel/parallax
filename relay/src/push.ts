import type { Env } from "./index";

/** What plxd says about a run. No thread content: the relay never sees any. */
export type Notification = { hostId: string; run: string; state: "needsYou" | "done" | "failed" };

const TEXT: Record<Notification["state"], string> = {
  needsYou: "A thread needs you.",
  done: "A thread finished.",
  failed: "A thread failed.",
};

/** The APNs payload for `notification`. The app opens the run from `hostId` and `run`. */
export function apnsPayload(notification: Notification) {
  return {
    aps: {
      alert: { title: "Parallax", body: TEXT[notification.state] },
      sound: "default",
      "thread-id": notification.hostId,
    },
    ...notification,
  };
}

/**
 * Sends `notification` to the iOS device with APNs token `device`.
 *
 * ponytail: a stub until Ryan's APNs key exists (PLX-653). It logs and answers "stubbed". The
 * real one signs a provider JWT with the key (ES256) and POSTs `apnsPayload` to
 * api.push.apple.com/3/device/<device>, as T3's ApnsClient does.
 */
export async function sendApns(
  _env: Env,
  device: string,
  notification: Notification,
): Promise<"sent" | "stubbed"> {
  console.log("apns (stub)", device.slice(0, 8), JSON.stringify(apnsPayload(notification)));
  return "stubbed";
}
