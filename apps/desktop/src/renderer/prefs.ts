import type {
  AgentEffort,
  AgentPermission,
  OrchestratorAutonomy,
  PrMergeMethod,
} from "../protocol/generated/protocol";
import { localId } from "./hosts";
import { merged, stored } from "./stored";
import type { ToolCallVisibility } from "./transcript";

/**
 * What a new thread starts with, kept on this computer (PLX-538). The composer's own pickers set
 * them in Settings > General; a thread's composer still changes its own. A default the host
 * can't honor, such as a model its catalog lacks, falls back as an unset one does.
 */
export type NewThreadPrefs = {
  /** The computer a new thread starts on, by host id. One that's gone or offline: the open one. */
  host: string;
  /** The default model, by instance and id. Unset: the backend's first model. */
  model?: { provider: string; id: string };
  effort: AgentEffort;
  /** The context window in tokens. Unset: the model's default. */
  context?: number;
  fast: boolean;
  permission: AgentPermission;
  /** Where a thread in a repository works. */
  workspace: "worktree" | "checkout";
  /** What a new worktree starts from: the repository's default branch, or its checkout's. */
  worktreeBase: "default" | "current";
  /**
   * The model the host's plxd names a new thread and its branch with (0058), by instance and id.
   * A host without that instance uses the thread's own instance's default.
   */
  naming: { provider: string; id: string };
  namingEffort: AgentEffort;
  /**
   * The user's own instructions for a new thread's title, which a plxd with
   * `threadTitleInstructions` adds to that model's prompt (PLX-1523). Empty: none.
   */
  namingInstructions: string;
};

export const newThreadDefaults: NewThreadPrefs = {
  host: localId,
  effort: "high",
  fast: false,
  permission: "edit",
  workspace: "worktree",
  worktreeBase: "default",
  naming: { provider: "codex", id: "gpt-6-luna" },
  namingEffort: "low",
  namingInstructions: "",
};

export const newThreadPrefs = stored("parallax.newThreads", newThreadDefaults, merged);

export const setNewThreadPrefs = (change: Partial<NewThreadPrefs>) =>
  newThreadPrefs.set({ ...newThreadPrefs.get(), ...change });

/** How New thread's picker lists its rows, kept on this computer (PLX-1252). */
export type PickerPrefs = {
  /** The order of its repositories. No repo stays last. */
  order: "recent" | "name" | "added";
  /** One line per row, rather than two. */
  compact: boolean;
  /** Whether Thread lists the orchestrator threads to continue, as Orchestrator always does. */
  orchestrators: boolean;
};

export const pickerPrefs = stored<PickerPrefs>(
  "parallax.newThreadPicker",
  { order: "recent", compact: false, orchestrators: true },
  merged,
);

export const setPickerPrefs = (change: Partial<PickerPrefs>) =>
  pickerPrefs.set({ ...pickerPrefs.get(), ...change });

/** How the app behaves, kept on this computer (PLX-538). */
export type BehaviorPrefs = {
  /** OS notifications for a thread that finishes or needs you, while the window isn't focused. */
  systemNotifications: boolean;
  /** Toasts for those same threads while the window is focused. */
  inAppNotifications: boolean;
  timeFormat: "system" | "12" | "24";
  /** What sends a prompt. With `modEnter`, Enter starts a new line. */
  sendKey: "enter" | "modEnter";
  /**
   * When a reply's text shows while it arrives (PLX-1523): `live` as it's written, `paragraphs`
   * each paragraph, list, or code block once it's complete, `full` once the reply is. A finished
   * reply always shows whole.
   */
  responseStreaming: "live" | "paragraphs" | "full";
  /** Where a pull request's Open on GitHub goes: the system browser, or the side panel's Browser. */
  openPrsIn: "external" | "browser";
  /**
   * What a click on a link to a thread's pull request does: open its view in Parallax, or GitHub
   * in the browser. Cmd+click (Ctrl+click elsewhere) or Shift+click does the other.
   */
  prLinkClick: "parallax" | "github";
  /** Whether dictated text is tidied by a small model, which then receives it (PLX-1232). */
  cleanDictation: boolean;
  /** The merge method a pull request's merge box starts on, where the repository allows it. */
  mergeMethod?: PrMergeMethod;
  /** Whether a merge deletes the branch, as the merge box's checkbox starts. */
  deleteBranchOnMerge: boolean;
};

export const behaviorDefaults: BehaviorPrefs = {
  systemNotifications: true,
  inAppNotifications: true,
  timeFormat: "system",
  sendKey: "enter",
  responseStreaming: "live",
  openPrsIn: "external",
  prLinkClick: "parallax",
  cleanDictation: true,
  deleteBranchOnMerge: true,
};

export const behaviorPrefs = stored("parallax.behavior", behaviorDefaults, merged);

export const setBehaviorPrefs = (change: Partial<BehaviorPrefs>) =>
  behaviorPrefs.set({ ...behaviorPrefs.get(), ...change });

/** How a chat reads and its box writes, kept on this computer (PLX-1519). */
export type ChatPrefs = {
  /** Whether the composer formats Markdown as it's typed. Off, it shows the text as typed. */
  richComposer: boolean;
  /** Whether LaTeX in messages is typeset. Off, it shows as its source. */
  math: boolean;
  /** Which of the agent's tool calls a transcript shows (`shownRows`). */
  toolCalls: ToolCallVisibility;
};

export const chatDefaults: ChatPrefs = { richComposer: true, math: true, toolCalls: "showAll" };

export const chatPrefs = stored("parallax.chat", chatDefaults, merged);

export const setChatPrefs = (change: Partial<ChatPrefs>) =>
  chatPrefs.set({ ...chatPrefs.get(), ...change });

/** What a new orchestrator's form starts with, kept on this computer. */
export type OrchestratorPrefs = {
  fullAccess: boolean;
  autonomy: OrchestratorAutonomy;
};

export const orchestratorPrefs = stored<OrchestratorPrefs>(
  "parallax.newOrchestrators",
  { fullAccess: true, autonomy: "routine" },
  merged,
);

/**
 * A repository's own defaults for a new thread, over `newThreadPrefs`, kept on this computer by
 * host and repository. An unset one follows the global default. `base` names the ref a new worktree
 * starts from.
 */
export type RepoPrefs = Partial<
  Pick<NewThreadPrefs, "model" | "effort" | "context" | "fast" | "permission" | "workspace">
> & { base?: string };

const repoPrefStore = stored<Record<string, RepoPrefs>>("parallax.repoDefaults", {}, merged);

const repoKey = (hostId: string, repo: string) => `${hostId}/${repo}`;

/** `repo`'s own defaults on `hostId`, kept current, or none. */
export const useRepoPrefs = (hostId: string, repo: string): RepoPrefs =>
  repoPrefStore.use()[repoKey(hostId, repo)] ?? noRepoPrefs;
const noRepoPrefs: RepoPrefs = {};

/** Sets `repo`'s own defaults on `hostId`: a field given as undefined follows the global one again. */
export function setRepoPrefs(hostId: string, repo: string, change: RepoPrefs) {
  const key = repoKey(hostId, repo);
  const all = repoPrefStore.get();
  const next: RepoPrefs = { ...all[key], ...change };
  for (const field of Object.keys(next) as (keyof RepoPrefs)[])
    if (next[field] === undefined) delete next[field];
  const { [key]: _, ...rest } = all;
  repoPrefStore.set(Object.keys(next).length ? { ...rest, [key]: next } : rest);
}

/** Each provider instance's labels, by host and instance, kept on this computer. */
const providerLabelStore = stored<Record<string, string[]>>("parallax.providerLabels", {}, merged);

/** Every instance's labels, kept current. */
export const useProviderLabels = providerLabelStore.use;

/** Sets an instance's labels. */
export function setProviderLabels(hostId: string, instance: string, labels: string[]) {
  const key = `${hostId}/${instance}`;
  const { [key]: _, ...rest } = providerLabelStore.get();
  providerLabelStore.set(labels.length ? { ...rest, [key]: labels } : rest);
}

/** Every label in use, in order, to filter by and suggest. */
export const allProviderLabels = (all: Record<string, string[]>) =>
  [...new Set(Object.values(all).flat())].sort((a, b) => a.localeCompare(b));

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
