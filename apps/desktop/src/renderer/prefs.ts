import type { AgentEffort, AgentPermission } from "../protocol/generated/protocol";
import { merged, stored } from "./stored";

/**
 * What a new thread starts with, kept on this computer (PLX-538). The composer's own pickers set
 * them in Settings > General; a thread's composer still changes its own. A default the host
 * can't honor, such as a model its catalog lacks, falls back as an unset one does.
 */
export type NewThreadPrefs = {
  /** The default model, by instance and id. Unset: the backend's first model. */
  model?: { provider: string; id: string };
  effort: AgentEffort;
  /** The context window in tokens. Unset: the model's default. */
  context?: number;
  fast: boolean;
  permission: AgentPermission;
  /** Where a thread in a repository works. */
  workspace: "worktree" | "checkout";
};

export const newThreadDefaults: NewThreadPrefs = {
  effort: "high",
  fast: false,
  permission: "edit",
  workspace: "worktree",
};

export const newThreadPrefs = stored("parallax.newThreads", newThreadDefaults, merged);

export const setNewThreadPrefs = (change: Partial<NewThreadPrefs>) =>
  newThreadPrefs.set({ ...newThreadPrefs.get(), ...change });

/** How the app behaves, kept on this computer (PLX-538). */
export type BehaviorPrefs = {
  /** OS notifications for a thread that finishes or needs you, while the window isn't focused. */
  systemNotifications: boolean;
  /** Toasts for those same threads while the window is focused. */
  inAppNotifications: boolean;
  timeFormat: "system" | "12" | "24";
  /** What sends a prompt. With `modEnter`, Enter starts a new line. */
  sendKey: "enter" | "modEnter";
};

export const behaviorDefaults: BehaviorPrefs = {
  systemNotifications: true,
  inAppNotifications: true,
  timeFormat: "system",
  sendKey: "enter",
};

export const behaviorPrefs = stored("parallax.behavior", behaviorDefaults, merged);

export const setBehaviorPrefs = (change: Partial<BehaviorPrefs>) =>
  behaviorPrefs.set({ ...behaviorPrefs.get(), ...change });

/**
 * A clock time's `Intl` options, in the chosen format. Time formatting calls this on every render,
 * so it reads the pref directly; a change shows on the next render of each time.
 */
export function clockOptions(): Intl.DateTimeFormatOptions {
  return { hour: "numeric", minute: "2-digit", ...hourCycle() };
}

/** `hour12` for a chosen format, for options that already name their own time parts. */
export function hourCycle(): Pick<Intl.DateTimeFormatOptions, "hour12"> {
  const { timeFormat } = behaviorPrefs.get();
  return timeFormat === "system" ? {} : { hour12: timeFormat === "12" };
}
