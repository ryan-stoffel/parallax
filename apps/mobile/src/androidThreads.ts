// Android's widget and its stand-in for the Live Activity (0100): the threads to show, kept by
// ThreadWidgetModule.kt, from what the app sees and from each push that opens (androidPush.ts), and
// an ongoing notification while any is going. The notification counts threads and names none, so a
// locked phone shows no thread's name, as on iOS. The widget is for the home screen only.
import * as Notifications from "expo-notifications";
import { t } from "i18next";

import { ThreadWidget } from "../modules/thread-status";
import { isLive, mergePush, mergeSeen, type StatusEntry, type ThreadStatusUpdate } from "./threadStatus";

/** The ongoing notification's id and channel. */
export const RUNNING = "parallax-running";

function kept(): StatusEntry[] {
  try {
    return JSON.parse(ThreadWidget?.read() ?? "[]") as StatusEntry[];
  } catch {
    return [];
  }
}

/** "1 needs you, 2 working", for the ongoing notification, or nothing when no thread is going. */
export function summary(entries: StatusEntry[]): string | undefined {
  const live = entries.filter(isLive);
  const needsYou = live.filter((e) => e.state === "needsYou").length;
  const working = live.length - needsYou;
  const parts = [
    needsYou > 0 ? t("{{count}} need you", { count: needsYou }) : undefined,
    working > 0 ? t("{{count}} working", { count: working }) : undefined,
  ].filter(Boolean);
  return parts.length > 0 ? parts.join(", ") : undefined;
}

async function show(entries: StatusEntry[]) {
  ThreadWidget?.show(
    JSON.stringify(entries),
    JSON.stringify({
      needsYou: t("Needs you"),
      working: t("Working"),
      failed: t("Failed"),
      done: t("Finished"),
      empty: t("No recent threads"),
    }),
  );
  const title = summary(entries);
  if (!title) return Notifications.dismissNotificationAsync(RUNNING);
  await Notifications.setNotificationChannelAsync(RUNNING, {
    name: t("Running threads"),
    importance: Notifications.AndroidImportance.LOW,
    sound: null,
    enableVibrate: false,
    showBadge: false,
  });
  await Notifications.scheduleNotificationAsync({
    identifier: RUNNING,
    content: { title, body: "Parallax", sticky: true, autoDismiss: false },
    trigger: { channelId: RUNNING },
  });
}

/** The last change. Each waits for the one before, so the app and a push don't drop each other's. */
let changing = Promise.resolve();
const change = (step: () => Promise<unknown>) => (changing = changing.then(step).then(() => {}, () => {}));

/** Keeps what the app sees now (`threadStatus`), in place of what's kept for those computers. */
export const keepSeen = (update: ThreadStatusUpdate) => change(() => show(mergeSeen(update, kept())));

/** Keeps what a push that opened says: its run's state, under the title sealed with it. */
export const keepPush = (push: Parameters<typeof mergePush>[0], title: string) =>
  change(() => show(mergePush(push, title, kept())));

/** Takes every thread off the widget, and the ongoing notification away, for signing out. */
export const forgetThreads = () =>
  change(async () => {
    ThreadWidget?.clear();
    await Notifications.dismissNotificationAsync(RUNNING);
  });
