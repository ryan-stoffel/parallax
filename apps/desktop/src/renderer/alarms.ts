import { useCallback, useEffect, useRef } from "react";

import type { InboxItem } from "../protocol/generated/protocol";
import { attentionOf } from "./attention";
import type { HostThreads } from "./Sidebar";
import { asksOf } from "./threads";

/**
 * A system notification for each snoozed thread when its snooze ends, and at once for one that
 * starts needing the user while snoozed (0033). Clicking one opens the thread. The app sends them,
 * so a snooze that ends while the app is closed shows no notification: the thread is just back in
 * the list.
 */
export function useSnoozeAlarms(
  hosts: HostThreads[],
  onOpen: (hostId: string, threadId: string) => void,
) {
  // Threads already notified for a snooze, by host, id, and snooze, so each fires once.
  const notified = useRef(new Set<string>());
  const open = useRef(onOpen);
  useEffect(() => {
    open.current = onOpen;
  });

  useEffect(() => {
    const timers: number[] = [];
    const now = Date.now();
    for (const { host, view } of hosts)
      for (const t of view.state.threads) {
        if (!t.snoozedUntil || t.archived) continue;
        const until = Date.parse(t.snoozedUntil);
        const key = `${host.id}/${t.id}/${t.snoozedUntil}`;
        // ponytail: a snooze past setTimeout's ~24-day limit isn't armed until a later change
        // runs this again; arm from a daily check if long snoozes matter.
        if (until <= now || until - now > 2 ** 31 - 1 || notified.current.has(key)) continue;
        const title = view.state.titles[t.id] ?? "Thread";
        const ring = (body: string) => {
          notified.current.add(key);
          notify(title, body, () => open.current(host.id, t.id));
        };
        const asks = asksOf(view.state, t.id);
        if (attentionOf(t, view.state.runs[t.id], asks) === "needsYou")
          ring("Needs you, so it woke early from its snooze.");
        else timers.push(window.setTimeout(() => ring("Back from its snooze."), until - now));
      }
    return () => timers.forEach((timer) => window.clearTimeout(timer));
  }, [hosts]);
}

/**
 * A system notification for a Project's new Needs you inbox item (0043), as a snooze's (0033).
 * Clicking it opens the Project, whose coordinator chat shows the item. Returns what each host's
 * thread list calls with the item (`useThreads`'s `onNeedsYou`).
 */
export function useNeedsYouAlarm(
  hosts: HostThreads[],
  onOpen: (hostId: string, projectId: string) => void,
) {
  const latest = useRef({ hosts, onOpen });
  useEffect(() => {
    latest.current = { hosts, onOpen };
  });
  return useCallback((hostId: string, projectId: string, item: InboxItem) => {
    const project = latest.current.hosts
      .find((h) => h.host.id === hostId)
      ?.view.state.projects.find((p) => p.id === projectId);
    notify(project?.name ?? "Project", `Needs you: ${item.text}`, () =>
      latest.current.onOpen(hostId, projectId),
    );
  }, []);
}

/** Shows a system notification. Clicking it brings the window forward and calls `onClick`. */
function notify(title: string, body: string, onClick: () => void) {
  const note = new Notification(title, { body });
  note.onclick = () => {
    window.focus();
    onClick();
  };
}
