import type { AgentRun, Thread } from "../protocol/generated/protocol";
import { isRunning } from "./transcript";

/**
 * What a sidebar row asks of the user (0033): its agent is working, its turn ended but plxd
 * watches a pull request for it (monitoring) or it waits on background work (waiting,
 * PLX-777), it waits on the user, it stopped since the user last looked (done or failed), or
 * there is nothing new (settled).
 */
export type Attention =
  | "working"
  | "monitoring"
  | "waiting"
  | "needsYou"
  | "done"
  | "failed"
  | "settled";

/**
 * A thread's attention, from its run, how many permission requests it waits on, what its agent
 * waits on once its turn ends (`waiting`), and when the user last saw it. A run stopped after
 * `seenAt` (or never seen) is unseen. An archived thread is always settled.
 */
export function attentionOf(
  thread: Thread,
  run: AgentRun | undefined,
  asks: number,
  waiting?: "monitoring" | "waiting",
): Attention {
  if (thread.archived) return "settled";
  if (asks > 0) return "needsYou";
  if (!run) return "settled";
  if (isRunning(run.status)) return "working";
  if (waiting) return waiting;
  // A run waiting out a usage limit (0049) is no news yet: its row shows when it resumes.
  if (run.status === "waiting") return "settled";
  const unseen = !thread.seenAt || Date.parse(run.updatedAt) > Date.parse(thread.seenAt);
  if (!unseen) return "settled";
  return run.status === "failed" ? "failed" : "done";
}

/** An orchestrator's attention, from its runs: any waiting on the user, else any working. */
export function orchestratorAttention(
  runs: AgentRun[],
  asks: (runId: string) => number,
): Attention {
  if (runs.some((r) => asks(r.id) > 0)) return "needsYou";
  return runs.some((r) => isRunning(r.status)) ? "working" : "settled";
}

/**
 * An orchestrator child's attention in its side panel (0042): it waits on the user, it's working,
 * or it stopped, done or failed. It has no seen state, so it never settles.
 */
export function runAttention(run: AgentRun, asks: number): Attention {
  if (asks > 0) return "needsYou";
  if (isRunning(run.status)) return "working";
  return run.status === "failed" ? "failed" : "done";
}

/** The side panel's order for an orchestrator's children (0042). */
export const childOrder: Attention[] = ["needsYou", "working", "done", "failed"];

// Most urgent first: what waits on the user, then news, then work still going.
const urgency: Attention[] = [
  "needsYou",
  "failed",
  "done",
  "working",
  "monitoring",
  "waiting",
  "settled",
];

/** The most urgent of `attentions`, as a collapsed group of threads shows it; settled for none. */
export const mostUrgent = (attentions: Attention[]): Attention =>
  urgency.find((a) => attentions.includes(a)) ?? "settled";

/** Whether a thread is snoozed at `now`. One that needs the user wakes early. */
export const snoozed = (thread: Thread, attention: Attention, now = Date.now()) =>
  !!thread.snoozedUntil && Date.parse(thread.snoozedUntil) > now && attention !== "needsYou";

/** When a thread's newest message was sent. */
export const lastPrompt = (thread: Thread) => thread.lastPromptAt ?? thread.createdAt;

/**
 * When a thread was last active, for the sidebar's order (PLX-1043): its newest message, or when its
 * run last stopped after that (`stoppedAt`, ThreadsState), so a thread that finishes rises to the
 * top. A running thread, or one waiting out a usage limit (0049), keeps its message's time, so its
 * row doesn't move until it finishes.
 */
export function activeAt(thread: Thread, run: AgentRun | undefined, stoppedAt?: string): string {
  const prompt = lastPrompt(thread);
  if (!run || !stoppedAt || isRunning(run.status) || run.status === "waiting") return prompt;
  return Date.parse(stoppedAt) > Date.parse(prompt) ? stoppedAt : prompt;
}

/** When the user last sent a thread a message, for Working's clock: wake-ups don't reset it (PLX-1012). */
export const lastUserPrompt = (thread: Thread) => thread.lastUserPromptAt ?? lastPrompt(thread);

/**
 * A branch name cut to about `max` characters in the middle, at word breaks (`-`, `/`, `_`, `.`),
 * keeping its start and its last word: `feature/PLX-49-…implementation` (PLX-1043).
 */
export function shortBranch(branch: string, max = 24): string {
  if (branch.length <= max) return branch;
  const parts = branch.split(/(?<=[-/_.])/);
  let tail = parts.pop()!;
  let head = "";
  while (parts.length && head.length + parts[0]!.length + tail.length + 1 <= max)
    head += parts.shift();
  while (parts.length && head.length + parts.at(-1)!.length + tail.length + 1 <= max)
    tail = parts.pop() + tail;
  return parts.length ? `${head}…${tail}` : head + tail;
}

/** A repo's default icon: the first letters of its name's first two words, or its first two. */
export function initials(name: string): string {
  const words = name.split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  const letters = words.length > 1 ? words[0]![0]! + words[1]![0]! : (words[0] ?? "?").slice(0, 2);
  return letters.toUpperCase();
}

/** The snooze menu's choices, each a label and its time from `now`. */
export function snoozeChoices(now = new Date()): { label: string; until: Date }[] {
  const at = (days: number, hour: number) => {
    const d = new Date(now);
    d.setDate(d.getDate() + days);
    d.setHours(hour, 0, 0, 0);
    return d;
  };
  // Next Monday, a week out if today is Monday.
  const toMonday = (8 - now.getDay()) % 7 || 7;
  return [
    { label: "In 1 hour", until: new Date(now.getTime() + 3_600_000) },
    { label: "In 3 hours", until: new Date(now.getTime() + 3 * 3_600_000) },
    { label: "Tomorrow", until: at(1, 9) },
    { label: "Next week", until: at(toMonday, 9) },
  ];
}
