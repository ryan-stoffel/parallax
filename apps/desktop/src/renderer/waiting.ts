// What a settled thread still waits on (PLX-777): its agent's background tasks, such as a Monitor,
// and the pull requests plxd watches, in words. Pure, so the mobile app shares it; WaitingBar.tsx
// draws it.
import { t } from "i18next";

import type { AgentBackgroundKind, AgentBackgroundTask } from "../protocol/generated/protocol";
import { numberOf } from "./github";

type Kind = AgentBackgroundKind | "pullRequest";

// As T3 Code groups them: agents first, then commands, monitors, and pull requests.
// `singular` is the kind's English word, which `items` carries for the apps to tell kinds apart.
const kinds: Record<Kind, { order: number; singular: string }> = {
  agent: { order: 0, singular: "subagent" },
  command: { order: 1, singular: "command" },
  monitor: { order: 2, singular: "monitor" },
  pullRequest: { order: 3, singular: "pull request" },
};

interface Item {
  kind: Kind;
  label: string;
  /** Whether `label` is the task's own description, not its kind's word. */
  described: boolean;
}

export interface WaitingPresentation {
  /** "Waiting on subagent Review src/math.ts", "Waiting on 1 command and 1 monitor", "Monitoring pull request #750", or "Running: npm run dev". */
  title: string;
  /** The labels of the items the title counts, leaving out subagents the tab over it lists. */
  labels?: string;
  /** Each item, by kind in English ("command"), for the details popover. */
  items: { kind: string; label: string }[];
}

const joinWithAnd = (parts: string[]) =>
  parts.length <= 1
    ? parts.join("")
    : t("{{list}} and {{last}}", { list: parts.slice(0, -1).join(", "), last: parts.at(-1) });

/** `n` items of `kind`, in words: "2 commands". */
function countOf(kind: Kind, count: number) {
  switch (kind) {
    case "agent":
      return t("{{count}} subagents", { count, defaultValue_one: "{{count}} subagent" });
    case "command":
      return t("{{count}} commands", { count, defaultValue_one: "{{count}} command" });
    case "monitor":
      return t("{{count}} monitors", { count, defaultValue_one: "{{count}} monitor" });
    case "pullRequest":
      return t("{{count}} pull requests", { count, defaultValue_one: "{{count}} pull request" });
  }
}

/** A kind's word, as an unnamed item's label. */
function kindWord(kind: Kind) {
  const context = "kind of background task";
  switch (kind) {
    case "agent":
      return t("subagent", { context });
    case "command":
      return t("command", { context });
    case "monitor":
      return t("monitor", { context });
    case "pullRequest":
      return t("pull request", { context });
  }
}

/**
 * What a settled thread still waits on, as T3 Code's `presentPendingBackgroundWork` names it
 * (PLX-777): its agent's background tasks and the pull requests plxd watches, which read as
 * Monitoring. With `agentsShown`, the subagents tab over it already lists its subagents, so the
 * title leaves them out, or only counts them when they're all it waits on. The details name every
 * item. Undefined for nothing.
 */
export function presentWaiting(
  background: AgentBackgroundTask[],
  watching: string[],
  agentsShown = false,
): WaitingPresentation | undefined {
  const all: Item[] = [
    ...background.map((task) => {
      const kind = task.kind in kinds ? task.kind : "command";
      const description = task.description.trim();
      return { kind, label: description || kindWord(kind), described: !!description };
    }),
    ...watching.map((url) => ({
      kind: "pullRequest" as const,
      label: `#${numberOf(url)}`,
      described: true,
    })),
  ].sort((a, b) => kinds[a.kind].order - kinds[b.kind].order);
  if (all.length === 0) return undefined;
  const details = all.map((item) => ({ kind: kinds[item.kind].singular, label: item.label }));
  const unnamed = (item: Item) => agentsShown && item.kind === "agent";
  const items = all.every(unnamed) ? all : all.filter((item) => !unnamed(item));
  const waiting = items.some((item) => item.kind !== "command");
  const [only] = items;
  if (items.length === 1 && only) {
    const named = only.described && !unnamed(only);
    const label = only.label;
    const title =
      only.kind === "pullRequest"
        ? t("Monitoring pull request {{number}}", { number: label })
        : !waiting
          ? named
            ? t("Running: {{label}}", { label })
            : t("Running a command")
          : !named
            ? only.kind === "monitor"
              ? t("Waiting on a monitor")
              : t("Waiting on a subagent")
            : only.kind === "monitor"
              ? label
              : t("Waiting on subagent {{label}}", { label });
    return { title, items: details };
  }
  const counts = new Map<Kind, number>();
  for (const item of items) counts.set(item.kind, (counts.get(item.kind) ?? 0) + 1);
  const groups = joinWithAnd([...counts].map(([kind, n]) => countOf(kind, n)));
  const title = items.every((item) => item.kind === "pullRequest")
    ? t("Monitoring {{items}}", { items: groups })
    : waiting
      ? t("Waiting on {{items}}", { items: groups })
      : t("Running {{items}}", { items: groups });
  return {
    title,
    labels: items
      .filter((item) => !unnamed(item))
      .map((item) => item.label)
      .join(", "),
    items: details,
  };
}
