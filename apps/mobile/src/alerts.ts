// When a thread on a computer is worth a notification, and what it says: it starts waiting on the
// user, or a turn they may be waiting on ends and stays ended. No platform code, for the test;
// push.ts posts them.
import type { AgentRun, LoggedEvent } from "../../desktop/src/protocol/generated/protocol";
import { emptyTranscript, isRunning, rebuild } from "../../desktop/src/renderer/transcript";

/** Where a run is, as far as notifying goes. */
export type Phase = "needsYou" | "working" | "done" | "failed" | "idle";

export type Alert = "needsYou" | "done" | "failed";

/**
 * How long a run must stay done or failed before it notifies (PLX-1337): an agent that goes again
 * within it wasn't finished. plxd holds its push as long (`HOLD`).
 */
export const HOLD_MS = 30_000;

/** The longest a notification's text gets from a reply. */
const REPLY_CHARS = 140;

/**
 * `waiting`: the run's agent still waits on background work or a watched pull request (PLX-777),
 * so a turn that ended isn't done yet: the agent wakes for it and carries on.
 */
export function phaseOf(run: AgentRun | undefined, asks: number, waiting = false): Phase {
  if (asks > 0) return "needsYou";
  if (!run) return "idle";
  if (isRunning(run.status) || (run.status === "completed" && waiting)) return "working";
  if (run.status === "completed") return "done";
  return run.status === "failed" ? "failed" : "idle";
}

/**
 * What to tell the user when a run goes from `before` to `now`: it started waiting on them, or
 * a turn they may be waiting on ended. A run seen for the first time tells nothing.
 */
export function alertFor(before: Phase | undefined, now: Phase): Alert | undefined {
  if (before === undefined || before === now) return undefined;
  if (now === "needsYou") return now;
  if ((now === "done" || now === "failed") && (before === "working" || before === "needsYou"))
    return now;
  return undefined;
}

/**
 * Calls `fire` when a run earns an alert: `needsYou` at once, `done` or `failed` once the run has
 * stayed that way for `ms`, with any other phase cancelling it. `see` takes a run's phase as often
 * as a render comes: the same phase again leaves its timer alone. `clear` drops every timer.
 */
export function holdAlerts(
  fire: (hostId: string, runId: string, alert: Alert) => void,
  ms = HOLD_MS,
) {
  const phases = new Map<string, Phase>();
  const held = new Map<string, { phase: Phase; timer: ReturnType<typeof setTimeout> }>();
  const drop = (key: string) => {
    clearTimeout(held.get(key)?.timer);
    held.delete(key);
  };
  return {
    see(hostId: string, runId: string, now: Phase) {
      const key = `${hostId}:${runId}`;
      const alert = alertFor(phases.get(key), now);
      phases.set(key, now);
      if (held.get(key)?.phase !== now) drop(key);
      if (alert === "needsYou") fire(hostId, runId, alert);
      else if (alert) {
        const timer = setTimeout(() => {
          held.delete(key);
          fire(hostId, runId, alert);
        }, ms);
        held.set(key, { phase: now, timer });
      }
    },
    clear() {
      for (const key of [...held.keys()]) drop(key);
    },
  };
}

/** `markdown` as plain text on one line, cut to about [`REPLY_CHARS`]. Undefined when empty. */
export function replyText(markdown: string): string | undefined {
  const text = markdown
    .replace(/```[^\n]*/g, "")
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/^\s*(#{1,6}\s+|>\s?|[-*+]\s+|\d+\.\s+)/gm, "")
    .replace(/(\*\*|__|~~)(.+?)\1/g, "$2")
    .replace(/\*(.+?)\*/g, "$1")
    .replace(/`/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (text.length <= REPLY_CHARS) return text || undefined;
  const cut = text.slice(0, REPLY_CHARS);
  const word = cut.lastIndexOf(" ");
  // A break inside an emoji would show a broken character.
  return `${(word > REPLY_CHARS / 2 ? cut.slice(0, word) : cut).replace(/[\uD800-\uDBFF]$/, "").trimEnd()}…`;
}

/** The start of the agent's last reply among `events`, the newest of run `runId`'s, oldest first. */
export function lastReplyIn(events: LoggedEvent[], runId: string): string | undefined {
  const said = rebuild(emptyTranscript, events, runId).items.findLast((i) => i.kind === "assistant");
  return said?.kind === "assistant" ? replyText(said.text) : undefined;
}
