// What the widget and the Live Activity show of the threads the app sees (0100), for
// modules/thread-status, and on Android which of them it keeps, as ThreadStatus.swift does on iOS.
// No platform code, for the test.
import { t as translate } from "i18next";

import { phaseOf, type Phase } from "./alerts";
import type { Computer } from "./fleet";
import { accountId } from "./setup";

/** One thread, as ThreadEntry in ThreadStatus.swift decodes it. */
export type StatusEntry = {
  run: string;
  host: string;
  title: string;
  state: Exclude<Phase, "idle">;
  /** When it reached this state, in milliseconds. Fixed while it stays there, so a busy thread doesn't rewrite the keychain. */
  at: number;
  /** Undefined for one only a push told about. */
  link?: string;
};

export type ThreadStatusUpdate = {
  seen: StatusEntry[];
  /** The computers `seen` is complete for, whose other threads the widget drops. */
  connected: string[];
};

/** How long ago a thread can have ended and still show. */
const RECENT_MS = 24 * 60 * 60_000;

export function threadStatus(computers: Computer[], now = Date.now()): ThreadStatusUpdate {
  const seen: StatusEntry[] = [];
  const connected: string[] = [];
  for (const m of computers) {
    if (!m.connectedNow || m.view.loading) continue;
    connected.push(m.machine.id);
    const { state } = m.view;
    for (const t of state.threads) {
      if (t.archived) continue;
      const asks = state.approvals[t.id]?.items.filter((i) => i.kind === "approval" && !i.resolved).length ?? 0;
      const run = state.runs[t.id];
      const phase = phaseOf(run, asks, t.id in state.waiting);
      if (phase === "idle") continue;
      const live = phase === "needsYou" || phase === "working";
      const at = Date.parse(live ? (t.lastPromptAt ?? t.createdAt) : (run?.updatedAt ?? t.createdAt));
      if (!live && now - at > RECENT_MS) continue;
      seen.push({
        run: t.id,
        host: m.machine.id,
        title: state.titles[t.id] ?? translate("A thread"),
        state: phase,
        at,
        link: `parallax://thread/${encodeURIComponent(m.machine.id)}/${encodeURIComponent(t.id)}`,
      });
    }
  }
  return { seen, connected };
}

/** The most entries kept. The widget shows three. */
const KEEP = 8;
/** How long one still going stays with no news, as one on a computer since removed from the phone. */
const GOING_MS = 3 * 24 * 60 * 60_000;
const RANK = { needsYou: 0, working: 1, failed: 2, done: 3 };

/** Whether a thread is still going. */
export const isLive = (e: StatusEntry) => e.state === "needsYou" || e.state === "working";

/** What needs the user first, then what's going, then what ended, newest first within each. Threads
 *  too old to mean anything drop out. */
export function ordered(entries: StatusEntry[], now = Date.now()): StatusEntry[] {
  return entries
    .filter((e) => now - e.at < (isLive(e) ? GOING_MS : RECENT_MS))
    .sort((a, b) => RANK[a.state] - RANK[b.state] || b.at - a.at)
    .slice(0, KEEP);
}

/** Every thread in `seen`, in place of what `kept` held for them or for any computer in `connected`,
 *  which `seen` is complete for. Threads on other computers stay. */
export function mergeSeen({ seen, connected }: ThreadStatusUpdate, kept: StatusEntry[], now = Date.now()) {
  const runs = new Set(seen.map((e) => e.run));
  return ordered([...kept.filter((e) => !runs.has(e.run) && !connected.includes(e.host)), ...seen], now);
}

/** `kept` with what a push that opened says about `run`, on the computer with relay id `relayId`,
 *  named as the app names an account's computer so what the app sees there can replace it. */
export function mergePush(
  push: { hostId: string; run: string; state: StatusEntry["state"] },
  title: string,
  kept: StatusEntry[],
  now = Date.now(),
): StatusEntry[] {
  const link = kept.find((e) => e.run === push.run)?.link;
  const entry: StatusEntry = { run: push.run, host: accountId(push.hostId), title, state: push.state, at: now, link };
  return ordered([...kept.filter((e) => e.run !== push.run), entry], now);
}
