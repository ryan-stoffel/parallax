// Notifications: a thread that needs you, finished, or failed, on any computer.
//
// While the app runs, it watches every computer's threads and posts the notification itself,
// with the thread's title, which never leaves the phone. For when it doesn't, it hands its APNs
// token to Parallax Relay (0068), which plxd tells about runs and which sends a fixed text with
// the run's id. Tapping either opens the thread.
import * as Notifications from "expo-notifications";

const RELAY = "https://relay.parallx.dev";

/** The thread on screen, whose own notifications don't show while it's open. */
let viewing: string | undefined;
export const setViewing = (runId: string | undefined) => void (viewing = runId);

Notifications.setNotificationHandler({
  handleNotification: async (n) => {
    const data = n.request.content.data as { runId?: string; run?: string };
    const shown = (data.runId ?? data.run) !== viewing;
    return {
      shouldShowBanner: shown,
      shouldShowList: shown,
      shouldPlaySound: shown,
      shouldSetBadge: false,
    };
  },
});

const bodies = {
  needsYou: "Needs your approval",
  done: "Finished",
  failed: "Failed",
};

/** Posts the notification for `alert` on thread `runId`, titled with its title. */
export function notify(
  alert: "needsYou" | "done" | "failed",
  hostId: string,
  runId: string,
  title: string,
  machine: string,
) {
  void Notifications.scheduleNotificationAsync({
    content: {
      title,
      body: `${bodies[alert]} · ${machine}`,
      data: { hostId, runId },
      sound: true,
    },
    trigger: null,
  });
}

/** Asks for permission once. Resolves to whether notifications are on. */
export async function askForNotifications(): Promise<boolean> {
  const { granted } = await Notifications.requestPermissionsAsync();
  return granted;
}

export async function notificationsOn(): Promise<boolean> {
  return (await Notifications.getPermissionsAsync()).granted;
}

/**
 * Gives Parallax Relay this phone's APNs token under the signed-in account, so plxd's runs
 * notify it while the app isn't running. Resolves to why that isn't on, for people, or
 * undefined once it is.
 */
export async function registerWithRelay(
  token: () => Promise<string | undefined>,
): Promise<string | undefined> {
  if (!(await notificationsOn())) return "Notifications are off for Parallax in iOS Settings.";
  const device = await Notifications.getDevicePushTokenAsync().catch(() => undefined);
  if (!device)
    return "This build can't get a push token. It needs the App ID's push capability.";
  // The account's OAuth access token, which the relay takes from the desktop app's client too.
  const session = await token();
  if (!session) return "Sign in to get notifications while Parallax is closed.";
  const answer = await fetch(`${RELAY}/v1/devices`, {
    method: "POST",
    headers: { Authorization: `Bearer ${session}`, "Content-Type": "application/json" },
    body: JSON.stringify({ token: String(device.data) }),
  }).catch(() => undefined);
  if (!answer) return "Parallax Relay isn't reachable, so notifications come only while the app is open.";
  return answer.ok ? undefined : `Parallax Relay refused this phone (${answer.status}).`;
}

/** Calls `open` with the thread a tapped notification is about, including the one that launched the app. */
export function onOpened(open: (data: { hostId?: string; runId: string }) => void): () => void {
  const handle = (response: Notifications.NotificationResponse | null) => {
    const data = response?.notification.request.content.data as
      | { hostId?: string; runId?: string; run?: string }
      | undefined;
    const runId = data?.runId ?? data?.run;
    if (runId) open({ hostId: data?.runId ? data.hostId : undefined, runId });
  };
  void Notifications.getLastNotificationResponseAsync().then(handle);
  const subscription = Notifications.addNotificationResponseReceivedListener(handle);
  return () => subscription.remove();
}
