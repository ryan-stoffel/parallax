// What an orchestrator's inbox shows on the phone (0043), in what order, and what opening it marks
// seen. Pure, so it's tested without React Native.
import { t } from "i18next";

import type { InboxItem, Question } from "../../desktop/src/protocol/generated/protocol";
import { questionOf } from "../../desktop/src/renderer/Inbox";
import { dayLabel } from "../../desktop/src/renderer/locale";

/**
 * Whether `item` still waits on the user: an unread Needs you whose question, if it has one, isn't
 * answered. Only answering reads it, as on the desktop, whose Needs you lists unread items, so
 * opening the inbox here can't take a question off it.
 */
export const waitsOnUser = (item: InboxItem, questions: readonly Question[]) =>
  item.kind === "needsYou" && !item.seenAt && questionOf(item, questions)?.status !== "answered";

/** The unread items opening the inbox reads: all but those that wait on the user. */
export const readByOpening = (items: readonly InboxItem[], questions: readonly Question[]) =>
  items.filter((i) => !i.seenAt && !waitsOnUser(i, questions)).map((i) => i.id);

export interface InboxSection {
  title: string;
  items: InboxItem[];
}

/** Needs you, then the rest under their day, Today, Yesterday, or the date, each newest first. */
export function inboxSections(
  items: readonly InboxItem[],
  questions: readonly Question[],
  now = Date.now(),
): InboxSection[] {
  const newest = [...items].reverse();
  const waiting = newest.filter((i) => waitsOnUser(i, questions));
  const sections: InboxSection[] = waiting.length ? [{ title: t("Needs you"), items: waiting }] : [];
  let day: InboxSection | undefined;
  for (const item of newest) {
    if (waitsOnUser(item, questions)) continue;
    const title = dayLabel(Date.parse(item.createdAt), now);
    if (day?.title !== title) sections.push((day = { title, items: [] }));
    day.items.push(item);
  }
  return sections;
}
