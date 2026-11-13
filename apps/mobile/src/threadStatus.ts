// What the widget and the Live Activity show of the threads the app sees (0100), for
// modules/thread-status. No platform code, for the test.
import { t as translate } from "i18next";

import { phaseOf, type Phase } from "./alerts";
import type { Computer } from "./fleet";

/** One thread, as ThreadEntry in ThreadStatus.swift decodes it. */
export type StatusEntry = {
  run: string;
  host: string;
  title: string;
  state: Exclude<Phase, "idle">;
  /** When it reached this state, in milliseconds. Fixed while it stays there, so a busy thread doesn't rewrite the keychain. */
  at: number;
  link: string;
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
