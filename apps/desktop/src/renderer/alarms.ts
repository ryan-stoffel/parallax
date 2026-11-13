import { t } from "i18next";
import { useCallback, useEffect, useRef } from "react";

import type { ConnectNotice, ConnectionState, Profile } from "../preload/bridge";
import type { AgentRun, InboxItem, RelayHost, Thread } from "../protocol/generated/protocol";
import { attentionOf, type Attention } from "./attention";
import { onConnectionShown, useShownConnections } from "./ConnectionStatus";
import type { Host } from "./hosts";
import { locale } from "./locale";
import { dismiss, notify, update, type Notice } from "./notifications";
import { relayCapNotice } from "./relayCap";
import type { HostThreads } from "./Sidebar";
import { asksOf, waitingOf } from "./threads";
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
      for (const thread of view.state.threads) {
        if (!thread.snoozedUntil || thread.archived) continue;
        const until = Date.parse(thread.snoozedUntil);
        const key = `${host.id}/${thread.id}/${thread.snoozedUntil}`;
        // ponytail: a snooze past setTimeout's ~24-day limit isn't armed until a later change
        // runs this again; arm from a daily check if long snoozes matter.
        if (until <= now || until - now > 2 ** 31 - 1 || notified.current.has(key)) continue;
        const title = view.state.titles[thread.id] ?? t("Thread");
        const ring = (tone: "attention" | "info", body: string) => {
          notified.current.add(key);
          notify({
            key: `thread/${host.id}/${thread.id}`,
            tone,
            title,
            body,
            action: { label: t("Open thread"), run: () => open.current(host.id, thread.id) },
            system: true,
          });
        };
        const asks = asksOf(view.state, thread.id);
        if (attentionOf(thread, view.state.runs[thread.id], asks) === "needsYou")
          ring("attention", t("Needs you, so it woke early from its snooze."));
        else
          timers.push(
            window.setTimeout(() => ring("info", t("Back from its snooze.")), until - now),
          );
      }
    return () => timers.forEach((timer) => window.clearTimeout(timer));
  }, [hosts]);
}

/**
 * A notification for an orchestrator's new Needs you inbox item (0043). Its action opens the
 * orchestrator, whose orchestrator chat shows the item. Returns what each host's thread list calls
 * with the item (`useThreads`'s `onNeedsYou`).
 */
export function useNeedsYouAlarm(
  hosts: HostThreads[],
  onOpen: (hostId: string, orchestratorId: string) => void,
) {
  const latest = useRef({ hosts, onOpen });
  useEffect(() => {
    latest.current = { hosts, onOpen };
  });
  return useCallback((hostId: string, orchestratorId: string, item: InboxItem) => {
    const orchestrator = latest.current.hosts
      .find((h) => h.host.id === hostId)
      ?.view.state.orchestrators.find((p) => p.id === orchestratorId);
    notify({
      tone: "attention",
      title: orchestrator?.name ?? t("Orchestrator"),
      body: t("Needs you: {{text}}", { text: item.text }),
      action: {
        label: t("Open orchestrator"),
        run: () => latest.current.onOpen(hostId, orchestratorId),
      },
      system: true,
    });
  }, []);
}

/**
 * What a thread's notifications follow: its attention, Waiting and Monitoring included, or that
 * its run waits on a usage limit (`limited`).
 */
export type ThreadMark = Attention | "limited";

export function markOf(
  thread: Thread,
  run: AgentRun | undefined,
  asks: number,
  waiting: "monitoring" | "waiting" | undefined,
): ThreadMark {
  if (asks === 0 && run?.status === "waiting") return "limited";
  return attentionOf(thread, run, asks, waiting);
}

// The marks a thread is busy in: only a change from one of them finished or failed it, rather
// than, say, a pull request linked to a run that finished long ago. A turn that ends while the
// agent waits on background work or a watched pull request is still busy (PLX-1015).
const active: ThreadMark[] = ["working", "monitoring", "waiting", "needsYou", "limited"];

const clock = (at: string) => new Date(at).toLocaleTimeString(locale(), clockOptions());

/**
 * The notice for a thread whose mark changed from `before` to `now`, named `name`, if the change
 * is news: it finished or failed, started needing the user, or hit a usage limit. A thread
 * finishes once its agent waits on nothing, not when a turn ends.
 */
export function threadNotice(
  before: ThreadMark,
  now: ThreadMark,
  name: string,
  run: AgentRun | undefined,
): Pick<Notice, "tone" | "title" | "body"> | undefined {
  if (before === now) return undefined;
  if (now === "needsYou")
    return { tone: "attention", title: t("Thread needs your input"), body: name };
  if (now === "limited")
    return {
      tone: "info",
      title: t("Thread hit a usage limit"),
      body: run?.resumeAt
        ? t("{{name}}. Resumes at {{time}}.", { name, time: clock(run.resumeAt) })
        : name,
    };
  if (!active.includes(before)) return undefined;
  if (now === "done") return { tone: "success", title: t("Thread finished"), body: name };
  if (now === "failed")
    return {
      tone: "error",
      title: t("Thread failed"),
      body: run?.error ? t("{{name}}: {{error}}", { name, error: run.error }) : name,
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
      for (const thread of view.state.threads) {
        const key = `${host.id}/${thread.id}`;
        const run = view.state.runs[thread.id];
        const mark = markOf(
          thread,
          run,
          asksOf(view.state, thread.id),
          waitingOf(view.state, thread.id),
        );
        const before = marks.current.get(key);
        marks.current.set(key, mark);
        if (before === undefined || thread.archived) continue;
        if (thread.snoozedUntil && Date.parse(thread.snoozedUntil) > now) continue;
        if (latest.current.openKeys.includes(key) && document.hasFocus()) continue;
        const notice = threadNotice(before, mark, view.state.titles[thread.id] ?? t("Thread"), run);
        if (!notice) continue;
        notify({
          ...notice,
          key: `thread/${key}`,
          action: {
            label: t("Open thread"),
            run: () => latest.current.onOpen(host.id, thread.id),
          },
          system: true,
        });
      }
    }
  }, [hosts]);
}

/**
 * A notification when a host that was connected drops (it reconnects by itself), when it comes
 * back, and when it stops retrying, with Retry. Connecting at launch is never news, and neither is
 * a restart for an update, unless it isn't back in time.
 */
export function useConnectionAlarms(hosts: Host[]) {
  const names = useRef(hosts);
  // Known here, so a host's drop waits out its grace, and a reconnect in time is no news.
  useShownConnections(hosts.map((h) => h.id));
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
    return onConnectionShown((hostId, state) => {
      const before = last.current.get(hostId);
      last.current.set(hostId, state);
      const name = names.current.find((h) => h.id === hostId)?.name ?? t("a host");
      const key = `connection/${hostId}`;
      if (state.status === "connected") {
        if (troubled.delete(hostId))
          notify({ key, tone: "success", title: t("Reconnected to {{name}}", { name }) });
      } else if (state.status === "failed" && !state.retrying) {
        if (before?.status === "failed" && !before.retrying) return;
        // An account computer with no session here signs in, or waits for its code, which
        // Settings > Connections and its own prompts show, so it isn't an error (0091).
        if (state.error.reason === "refused" && hostId.startsWith("account:")) return;
        troubled.add(hostId);
        notify({
          key,
          tone: "error",
          title: t("Couldn't connect to {{name}}", { name }),
          body: state.error.message,
          action: { label: t("Retry"), run: () => void window.parallax.retry(hostId) },
        });
      } else if (!state.updating && (before?.status === "connected" || before?.updating)) {
        // A restart for an update isn't a drop, until it runs out of time.
        troubled.add(hostId);
        notify({
          key,
          tone: "error",
          title: t("Lost connection to {{name}}", { name }),
          body: t("Reconnecting…"),
        });
      }
    });
  }, []);
}

/**
 * A notification when a host's plxd is too old for this app to load its lists (its `outdated`),
 * once until it's updated, and when it is. The sidebar stays quiet about it.
 */
export function useOutdatedAlarms(hosts: HostThreads[]) {
  const outdated = useRef(new Set<string>());
  useEffect(() => {
    for (const { host, view } of hosts) {
      const key = `outdated/${host.id}`;
      if (view.outdated && !outdated.current.has(host.id)) {
        outdated.current.add(host.id);
        notify({
          key,
          tone: "error",
          title: t("{{name}}'s plxd is out of date", { name: host.name }),
          body: t(
            "Its threads can't load. Update Parallax there, or run npx plx-cli setup on a Linux computer that runs only plxd.",
          ),
        });
      } else if (!view.outdated && !view.loading && outdated.current.delete(host.id)) {
        notify({
          key,
          tone: "success",
          title: t("{{name}}'s plxd is up to date", { name: host.name }),
        });
      }
    }
  }, [hosts]);
}

/**
 * A notification when main updated a computer's plxd to the app's version, and a sticky one,
 * with Retry, when it couldn't (PLX-700). Each host has one, which the next replaces.
 */
export function useHostUpdateAlarms(hosts: Host[]) {
  const names = useRef(hosts);
  useEffect(() => {
    names.current = hosts;
  }, [hosts]);
  useEffect(
    () =>
      window.parallax.onHostUpdate((event) => {
        const { hostId } = event;
        const name = names.current.find((h) => h.id === hostId)?.name ?? t("a computer");
        const key = `hostUpdate/${hostId}`;
        if (event.status === "updated")
          notify({ key, tone: "success", title: t("Updated plxd on {{name}}", { name }) });
        else
          notify({
            key,
            tone: "error",
            title: t("Couldn't update plxd on {{name}}", { name }),
            body: event.error,
            action: { label: t("Retry"), run: () => void window.parallax.retryHostUpdate(hostId) },
          });
      }),
    [],
  );
}

/**
 * What each notice says, for people: what's wrong, and what still works (PLX-1351). Each is read
 * in the current language when it's used.
 */
export const CONNECT_NOTICE_TEXT: Record<ConnectNotice, { title: string; body: string }> = {
  relay: {
    get title() {
      return t("Can't reach Parallax Connect");
    },
    get body() {
      return t(
        "Computers on this network keep working. The rest reconnect when Parallax Connect is back.",
      );
    },
  },
  clerk: {
    get title() {
      return t("Can't reach Clerk sign-in");
    },
    get body() {
      return t(
        "Computers on this network keep working. New Parallax Connect connections and sign-ins wait until it's back.",
      );
    },
  },
  notListed: {
    get title() {
      return t("This computer isn't on your account");
    },
    get body() {
      return t(
        "Parallax Connect doesn't list it. If you didn't remove it, set it up again so your devices can reach it.",
      );
    },
  },
};

/** Registers this computer again, the one click `notListed` offers, and says why it couldn't. */
export async function setUpAgain() {
  const failed = await window.parallax.registerRelay();
  if (failed) notify({ tone: "error", title: t("Couldn't set up this computer"), body: failed });
}

/** Says what's wrong with Parallax Connect while it lasts, and offers `notListed`'s one click. */
export function useConnectNotices() {
  useEffect(
    () =>
      window.parallax.onConnectNotice((notice) => {
        if (!notice) return dismiss("connect");
        notify({
          key: "connect",
          tone: "error",
          ...CONNECT_NOTICE_TEXT[notice],
          ...(notice === "notListed" && { action: { label: t("Set up again"), run: setUpAgain } }),
        });
      }),
    [],
  );
}

/** What to say about `host`'s traffic through Parallax Relay today, if anything. */
export const relayCapOf = (host: RelayHost) =>
  relayCapNotice(host.name, host.usage, (at) =>
    new Date(at).toLocaleTimeString(locale(), clockOptions()),
  );

/**
 * A notice when a computer on the account passes 80% of its relay's daily cap, another when it
 * reaches it, and none once it resets (PLX-1357). A notice the user closed stays closed until the
 * next of those, while one still shown follows the count.
 */
export function useRelayCapNotices() {
  useEffect(() => {
    const reached = new Map<string, boolean>();
    return window.parallax.onRelayUsage((hosts) => {
      const near = new Set<string>();
      for (const host of hosts) {
        const cap = relayCapOf(host);
        if (!cap) continue;
        near.add(host.hostId);
        const notice = {
          key: `relayCap:${host.hostId}`,
          tone: cap.reached ? "error" : "info",
          sticky: true,
          title: cap.title,
          body: cap.body,
        } as const;
        if (reached.get(host.hostId) === cap.reached) update(notice);
        else notify(notice);
        reached.set(host.hostId, cap.reached);
      }
      for (const hostId of reached.keys())
        if (!near.has(hostId)) {
          reached.delete(hostId);
          dismiss(`relayCap:${hostId}`);
        }
    });
  }, []);
}

/** A notification when the user signs in to or out of their Parallax account (0067). */
export function useAccountAlarms() {
  useEffect(() => {
    let last: Profile | null | undefined;
    return window.parallax.onProfile((profile) => {
      const before = last;
      last = profile;
      if (before === undefined) {
        // Signed out at launch because accounts moved to another Clerk instance (PLX-1049).
        if (!profile)
          void window.parallax.accountMoved().then(
            (moved) =>
              moved &&
              notify({
                key: "account",
                tone: "info",
                title: t("Sign in to Parallax again"),
                body: t(
                  "Parallax accounts moved. Sign in again, then set up each of your computers again.",
                ),
              }),
          );
        return;
      }
      if (profile && !before)
        notify({
          key: "account",
          tone: "success",
          title: t("Signed in to Parallax"),
          // A notification is plain text, so it names the account without its email (PLX-1067).
          ...(profile.name && { body: t("As {{name}}.", { name: profile.name }) }),
        });
      else if (!profile && before)
        notify({ key: "account", tone: "info", title: t("Signed out of Parallax") });
    });
  }, []);
}
