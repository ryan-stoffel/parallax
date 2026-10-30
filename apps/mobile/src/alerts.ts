// When a thread on a computer is worth a notification: it starts waiting on the user, or a turn
// they may be waiting on ends. Pure, for the test; push.ts posts them.
import type { AgentRun } from "../../desktop/src/protocol/generated/protocol";
import { isRunning } from "../../desktop/src/renderer/transcript";

/** Where a run is, as far as notifying goes. */
export type Phase = "needsYou" | "working" | "done" | "failed" | "idle";

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
export function alertFor(before: Phase | undefined, now: Phase): "needsYou" | "done" | "failed" | undefined {
  if (before === undefined || before === now) return undefined;
  if (now === "needsYou") return now;
  if ((now === "done" || now === "failed") && (before === "working" || before === "needsYou"))
    return now;
  return undefined;
}

