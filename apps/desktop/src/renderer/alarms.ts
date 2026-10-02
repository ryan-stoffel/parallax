import { useEffect, useRef } from "react";

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
          const note = new Notification(title, { body });
          note.onclick = () => {
            window.focus();
            open.current(host.id, t.id);
          };
        };
        const asks = asksOf(view.state, t.id);
        if (attentionOf(t, view.state.runs[t.id], asks) === "needsYou")
          ring("Needs you, so it woke early from its snooze.");
        else timers.push(window.setTimeout(() => ring("Back from its snooze."), until - now));
      }
    return () => timers.forEach((timer) => window.clearTimeout(timer));
  }, [hosts]);
}
