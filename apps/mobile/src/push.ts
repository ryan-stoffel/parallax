// Notifications: a thread that needs you, or stayed finished or failed for 30 seconds, on any
// computer.
//
// While the app runs, it watches every computer's threads and posts the notification itself,
// with the thread's title and the start of the agent's last reply. For when it doesn't, it hands
// its APNs token to Parallax Relay (0068), which plxd tells about runs and which sends a fixed
// text with the run's id. plxd also seals the title and reply with a key the relay never sees, and
// the notification service extension (plugins/notification-service) opens them into the
// notification, or leaves the fixed text if it can't (0100). Both name one event alike, so iOS
// shows one of them, and a push doesn't show in front for a thread the app notifies about itself.
// Tapping either opens the thread. The extension also keeps what opens for the widget and the Live
// Activity, and the app does that here for the threads it sees and for a push it gets in front.
import Constants from "expo-constants";
import * as Notifications from "expo-notifications";
import * as SecureStore from "expo-secure-store";
import { Platform } from "react-native";

import type { HostResponse } from "../../desktop/src/preload/bridge";
import type { RelayPushKeyResult } from "../../desktop/src/protocol/generated/protocol";
import { ThreadStatus } from "../modules/thread-status";
import { lastReplyIn, type Alert } from "./alerts";
import type { ThreadStatusUpdate } from "./threadStatus";

/** Parallax Relay (0068), or the local one a test's bundle names. */
export const RELAY_URL = process.env.EXPO_PUBLIC_RELAY_URL ?? "https://relay.parallax.codes";

/** The thread on screen, whose own notifications don't show while it's open. */
let viewing: string | undefined;
export const setViewing = (runId: string | undefined) => void (viewing = runId);

/** Whether the app itself notifies about a thread, as one on a computer it's connected to. */
let notifiesFor: (runId: string) => boolean = () => false;
export const setNotifiesFor = (check: typeof notifiesFor) => void (notifiesFor = check);

Notifications.setNotificationHandler({
  handleNotification: async (n) => {
    // Only a push has `run`. This runs only in front, where the app notifies for itself.
    const data = n.request.content.data as { runId?: string; run?: string };
    const shown = (data.runId ?? data.run) !== viewing && !(data.run && notifiesFor(data.run));
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

/**
 * Posts the notification for `alert` on thread `runId`, titled with its title, with `text` or else
 * what `alert` means. Its identifier is the push's collapse id (`relay/src/push.ts`), so whichever
 * comes second replaces the first.
 */
export function notify(alert: Alert, hostId: string, runId: string, title: string, text?: string) {
  void Notifications.scheduleNotificationAsync({
    identifier: `${runId}:${alert}`,
    content: {
      title,
      body: text ?? bodies[alert],
      data: { hostId, runId },
      sound: true,
    },
    trigger: null,
  });
}

/** The start of the agent's last reply in thread `runId`, if its computer can say. */
export async function lastReply(hostId: string, runId: string): Promise<string | undefined> {
  try {
    const answer = await window.parallax.request(hostId, "agent/events", {
      runId,
      after: 0,
      before: Number.MAX_SAFE_INTEGER,
      limit: 200,
    });
    // A plxd too old for `before` answers with no `seq`, and with the run's first page.
    if ("error" in answer || answer.result.seq === undefined) return undefined;
    return lastReplyIn(answer.result.events, runId);
  } catch {
    return undefined;
  }
}

/** The keychain group this app shares with its extensions (`plugins/extensionTarget.js`). Android has neither. */
function sharedGroup(): string | undefined {
  if (Platform.OS !== "ios") return undefined;
  const { appleTeamId, bundleIdentifier } = Constants.expoConfig?.ios ?? {};
  return appleTeamId && bundleIdentifier ? `${appleTeamId}.${bundleIdentifier}.pushKeys` : undefined;
}

/** Tells the widget and the Live Activity what the app sees (`threadStatus` in threadStatus.ts). */
export function showThreadStatus({ seen, connected }: ThreadStatusUpdate) {
  const group = sharedGroup();
  // With no computer known now there's no news, and a sync would mark the Live Activity as current.
  if (group && connected.length > 0)
    void ThreadStatus?.sync(JSON.stringify(seen), connected, group).catch(() => {});
}

/** Takes thread names and push keys off this phone, for signing out, and ends the Live Activity. */
export async function forgetThreadStatus(): Promise<void> {
  const group = sharedGroup();
  if (group) await ThreadStatus?.signOut(group).catch(() => {});
}

/** Gives the widget and the Live Activity each sealed push that comes while the app is in front. */
export function applySealedPushes(): () => void {
  const subscription = Notifications.addNotificationReceivedListener((n) => {
    const data = n.request.content.data as { sealed?: string };
    const group = sharedGroup();
    if (data.sealed && group) void ThreadStatus?.applyPush(data, group).catch(() => {});
  });
  return () => subscription.remove();
}

/**
 * Keeps the push key of the computer behind `request` under its relay id, which its pushes carry,
 * in the keychain group this app shares with its extensions, where the notification service
 * extension reads it while the phone is locked. One that fails leaves the fixed text until the next
 * connection.
 */
export async function savePushKey(
  request: (method: "relay/pushKey", params: object) => Promise<HostResponse<unknown>>,
): Promise<void> {
  const group = sharedGroup();
  if (!group) return;
  const answer = await request("relay/pushKey", {}).catch(() => undefined);
  if (!answer || "error" in answer) return;
  const { hostId, key } = answer.result as RelayPushKeyResult;
  await SecureStore.setItemAsync(hostId, key, {
    keychainService: "pushKeys",
    accessGroup: group,
    keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY,
  }).catch(() => {});
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
  // No Firebase project yet (PLX-1372), so no push token to give on Android.
  if (Platform.OS !== "ios") return "Notifications while Parallax is closed aren't available on Android yet.";
  if (!(await notificationsOn())) return "Notifications are off for Parallax in iOS Settings.";
  const device = await Notifications.getDevicePushTokenAsync().catch(() => undefined);
  if (!device)
    return "This build can't get a push token. It needs the App ID's push capability.";
  // The account's OAuth access token, which the relay takes from the desktop app's client too.
  const session = await token();
  if (!session) return "Sign in to get notifications while Parallax is closed.";
  const answer = await fetch(`${RELAY_URL}/v1/devices`, {
    method: "POST",
    headers: { Authorization: `Bearer ${session}`, "Content-Type": "application/json" },
    body: JSON.stringify({ token: String(device.data) }),
  }).catch(() => undefined);
  if (!answer) return "Parallax Connect isn't reachable, so notifications come only while the app is open.";
  return answer.ok ? undefined : `Parallax Connect refused this phone (${answer.status}).`;
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
