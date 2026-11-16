// Android's half of 0100: the push keys, and the task that opens what plxd sealed.
//
// The relay sends Android a data-only FCM message (relay/src/push.ts). expo-notifications shows its
// fixed text under the id the app's own notification for that event has, and runs this task, even
// while the app is closed. The task opens `sealed` with the computer's key and posts the thread's
// title and text under the same id, which replaces the fixed text, as iOS's notification service
// extension does, and keeps the thread's state for the widget (androidThreads.ts). Anything that
// fails leaves the fixed text. index.ts imports this first, since a closed app runs only the task.
import * as Notifications from "expo-notifications";
import * as SecureStore from "expo-secure-store";
import * as TaskManager from "expo-task-manager";
import i18next, { t } from "i18next";
import { Platform } from "react-native";

import { startLanguage } from "./language";
import { keepPush } from "./androidThreads";
import { openSealed, type PushBody } from "./sealed";

const TASK = "parallax-sealed-push";
/** One item holding every computer's push key, by relay id, so signing out removes them at once. */
const KEYS = "pushKeys";
/** A channel with no sound or vibration, for the opened text that replaces a push's fixed text,
 *  which has already alerted. */
const OPENED = "opened";

async function savedKeys(): Promise<Record<string, string>> {
  const saved = await SecureStore.getItemAsync(KEYS).catch(() => null);
  try {
    return saved ? (JSON.parse(saved) as Record<string, string>) : {};
  } catch {
    return {};
  }
}

/** The last change to the keys. Each waits for the one before, so two computers connecting at once
 *  don't both read the same keys and drop each other's. */
let changing = Promise.resolve();
const change = (step: () => Promise<void>) => (changing = changing.then(step).catch(() => {}));

/** Keeps `key`, the push key of the computer with relay id `hostId`. */
export function saveAndroidPushKey(hostId: string, key: string): Promise<void> {
  return change(async () => {
    const keys = await savedKeys();
    if (keys[hostId] !== key) await SecureStore.setItemAsync(KEYS, JSON.stringify({ ...keys, [hostId]: key }));
  });
}

/** Takes every push key off this phone, for signing out. */
export function forgetAndroidPushKeys(): Promise<void> {
  return change(() => SecureStore.deleteItemAsync(KEYS));
}

/** The states a push names (relay/src/push.ts). One naming another is ignored, as ThreadStatus.swift does. */
const STATES: readonly string[] = ["needsYou", "done", "failed"] satisfies PushBody["state"][];

/** The push a task payload carries, if it's one from the relay. */
export function pushIn(payload: Notifications.NotificationTaskPayload | undefined): PushBody | undefined {
  if (!payload || "actionIdentifier" in payload) return undefined;
  try {
    const body = JSON.parse(String(payload.data?.dataString)) as Partial<PushBody>;
    return typeof body.hostId === "string" && typeof body.run === "string" && STATES.includes(String(body.state))
      ? (body as PushBody)
      : undefined;
  } catch {
    return undefined;
  }
}

if (Platform.OS === "android") {
  TaskManager.defineTask<Notifications.NotificationTaskPayload>(TASK, async ({ data }) => {
    const push = pushIn(data);
    const key = push && (await savedKeys())[push.hostId];
    const opened = push && key ? openSealed(push, key) : undefined;
    if (!push || !opened) return;
    // A closed app runs only this task, so its language isn't loaded yet. English is fine if it fails.
    if (!i18next.isInitialized)
      try {
        await startLanguage();
      } catch {}
    await Notifications.setNotificationChannelAsync(OPENED, {
      name: t("Thread updates"),
      importance: Notifications.AndroidImportance.HIGH,
      sound: null,
      enableVibrate: false,
    });
    // The push's own data, so tapping opens the thread, and the app in front hides it as it hid
    // the fixed text (push.ts's handler).
    await Notifications.scheduleNotificationAsync({
      identifier: `${push.run}:${push.state}`,
      content: { title: opened.title, body: opened.text, data: push },
      trigger: { channelId: OPENED },
    });
    // The widget and the ongoing notification, as iOS's extension keeps what opens.
    await keepPush(push, opened.title);
  });
  void Notifications.registerTaskAsync(TASK).catch(() => {});
}
