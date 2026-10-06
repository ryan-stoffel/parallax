import { useCallback, useEffect, useRef } from "react";

import type { ConnectionState, Profile } from "../preload/bridge";
import type { AgentRun, InboxItem, Thread } from "../protocol/generated/protocol";
import { attentionOf, type Attention } from "./attention";
import type { Host } from "./hosts";
import { notify, type Notice } from "./notifications";
import type { HostThreads } from "./Sidebar";
import { asksOf } from "./threads";
import { clockOptions } from "./prefs";

// The app's notifications about things that happen away from the screen the user is on (PLX-507).
// Each hook watches one source and calls `notify`.

/**
 * A notification for each snoozed thread when its snooze ends, and at once for one that starts
 * needing the user while snoozed (0033). Its action opens the thread. The app sends them, so a
 * snooze that ends while the app is closed shows nothing: the thread is just back in the list.
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
        const ring = (tone: "attention" | "info", body: string) => {
          notified.current.add(key);
          notify({
            key: `thread/${host.id}/${t.id}`,
            tone,
            title,
            body,
            action: { label: "Open thread", run: () => open.current(host.id, t.id) },
            system: true,
          });
        };
        const asks = asksOf(view.state, t.id);
        if (attentionOf(t, view.state.runs[t.id], asks) === "needsYou")
          ring("attention", "Needs you, so it woke early from its snooze.");
        else
          timers.push(window.setTimeout(() => ring("info", "Back from its snooze."), until - now));
      }
    return () => timers.forEach((timer) => window.clearTimeout(timer));
  }, [hosts]);
}

/**
 * A notification for a Project's new Needs you inbox item (0043). Its action opens the Project,
 * whose coordinator chat shows the item. Returns what each host's thread list calls with the item
 * (`useThreads`'s `onNeedsYou`).
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
    notify({
      tone: "attention",
      title: project?.name ?? "Project",
      body: `Needs you: ${item.text}`,
      action: { label: "Open Project", run: () => latest.current.onOpen(hostId, projectId) },
      system: true,
    });
  }, []);
}

/** What a thread's notifications follow: its attention, or that its run waits on a usage limit. */
export type ThreadMark = Attention | "waiting";

export function markOf(thread: Thread, run: AgentRun | undefined, asks: number): ThreadMark {
  if (asks === 0 && run?.status === "waiting") return "waiting";
  return attentionOf(thread, run, asks);
}

// The marks a turn is under way in: only a change from one of them finished or failed a turn,
// rather than, say, a pull request linked to a run that finished long ago.
const active: ThreadMark[] = ["working", "needsYou", "waiting"];

const clock = (at: string) => new Date(at).toLocaleTimeString([], clockOptions());

/**
 * The notice for a thread whose mark changed from `before` to `now`, named `name`, if the change
 * is news: it finished or failed a turn, started needing the user, or hit a usage limit.
 */
export function threadNotice(
  before: ThreadMark,
  now: ThreadMark,
  name: string,
  run: AgentRun | undefined,
): Pick<Notice, "tone" | "title" | "body"> | undefined {
  if (before === now) return undefined;
  if (now === "needsYou")
    return { tone: "attention", title: "Thread needs your input", body: name };
  if (now === "waiting")
    return {
      tone: "info",
      title: "Thread hit a usage limit",
      body: run?.resumeAt ? `${name}. Resumes at ${clock(run.resumeAt)}.` : name,
    };
  if (!active.includes(before)) return undefined;
  if (now === "done") return { tone: "success", title: "Thread finished", body: name };
  if (now === "failed")
    return {
      tone: "error",
      title: "Thread failed",
      body: run?.error ? `${name}: ${run.error}` : name,
    };
  return undefined;
}

/**
 * A notification when any host's thread finishes, fails, needs the user, or hits a usage limit,
 * with Open thread. A thread's state when it's first listed is never news, nor is any change
 * while its host's list loads. The threads `openKeys`
 * names (`hostId/threadId`), the ones on screen, are skipped while the window is focused, as are
 * snoozed and archived threads: the snooze alarm covers those.
 */
export function useThreadAlarms(
  hosts: HostThreads[],
  onOpen: (hostId: string, threadId: string) => void,
  openKeys: readonly string[],
) {
  const marks = useRef(new Map<string, ThreadMark>());
  const latest = useRef({ onOpen, openKeys });
  useEffect(() => {
    latest.current = { onOpen, openKeys };
  });

  useEffect(() => {
    const now = Date.now();
    for (const { host, view } of hosts) {
      // Mid-load, a thread's requests may not be in yet; its marks wait for the whole answer.
      if (view.loading) continue;
      for (const t of view.state.threads) {
        const key = `${host.id}/${t.id}`;
        const run = view.state.runs[t.id];
        const mark = markOf(t, run, asksOf(view.state, t.id));
        const before = marks.current.get(key);
        marks.current.set(key, mark);
        if (before === undefined || t.archived) continue;
        if (t.snoozedUntil && Date.parse(t.snoozedUntil) > now) continue;
        if (latest.current.openKeys.includes(key) && document.hasFocus()) continue;
        const notice = threadNotice(before, mark, view.state.titles[t.id] ?? "Thread", run);
        if (!notice) continue;
        notify({
          ...notice,
          key: `thread/${key}`,
          action: { label: "Open thread", run: () => latest.current.onOpen(host.id, t.id) },
          system: true,
        });
      }
    }
  }, [hosts]);
}

/**
 * A notification when a host that was connected drops (it reconnects by itself), when it comes
 * back, and when it stops retrying, with Retry. Connecting at launch is never news.
 */
export function useConnectionAlarms(hosts: Host[]) {
  const names = useRef(hosts);
  // Each host's last state. Main connects hosts before the window listens, so each host's
  // current state is read too, unless a change has come by then.
  const last = useRef(new Map<string, ConnectionState>());
  useEffect(() => {
    names.current = hosts;
    for (const { id } of hosts)
      if (!last.current.has(id))
        window.parallax.connectionState(id).then(
          (state) => void (last.current.has(id) || last.current.set(id, state)),
          // It rejects only for a host just removed.
          () => {},
        );
  }, [hosts]);
  useEffect(() => {
    // Hosts with a lost or failed notice up, which connecting replaces.
    const troubled = new Set<string>();
    return window.parallax.onConnectionState((hostId, state) => {
      const before = last.current.get(hostId);
      last.current.set(hostId, state);
      const name = names.current.find((h) => h.id === hostId)?.name ?? "a host";
      const key = `connection/${hostId}`;
      if (state.status === "connected") {
        if (troubled.delete(hostId))
          notify({ key, tone: "success", title: `Reconnected to ${name}` });
      } else if (state.status === "failed" && !state.retrying) {
        if (before?.status === "failed" && !before.retrying) return;
        troubled.add(hostId);
        notify({
          key,
          tone: "error",
          title: `Couldn't connect to ${name}`,
          body: state.error.message,
          action: { label: "Retry", run: () => void window.parallax.retry(hostId) },
        });
      } else if (before?.status === "connected") {
        troubled.add(hostId);
        notify({ key, tone: "error", title: `Lost connection to ${name}`, body: "Reconnecting…" });
      }
    });
  }, []);
}

/** A notification when the user signs in to or out of their Parallax account (0037). */
export function useAccountAlarms() {
  useEffect(() => {
    let last: Profile | null | undefined;
    return window.parallax.onProfile((profile) => {
      const before = last;
      last = profile;
      if (before === undefined) return;
      if (profile && !before)
        notify({
          key: "account",
          tone: "success",
          title: "Signed in to Parallax",
          body: `As ${profile.name || profile.email}.`,
        });
      else if (!profile && before)
        notify({ key: "account", tone: "info", title: "Signed out of Parallax" });
    });
  }, []);
}
