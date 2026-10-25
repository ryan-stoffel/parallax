// What a settled thread still waits on (PLX-777): its agent's background tasks, such as a Monitor,
// and the pull requests plxd watches, in words. Pure, so the mobile app shares it; WaitingBar.tsx
// draws it.
import type { AgentBackgroundKind, AgentBackgroundTask } from "../protocol/generated/protocol";
import { numberOf } from "./github";

type Kind = AgentBackgroundKind | "pullRequest";

// As T3 Code groups them: agents first, then commands, monitors, and pull requests.
const kinds: Record<Kind, { order: number; singular: string; plural: string }> = {
  agent: { order: 0, singular: "subagent", plural: "subagents" },
  command: { order: 1, singular: "command", plural: "commands" },
  monitor: { order: 2, singular: "monitor", plural: "monitors" },
  pullRequest: { order: 3, singular: "pull request", plural: "pull requests" },
};

interface Item {
  kind: Kind;
  label: string;
}

export interface WaitingPresentation {
  /** "Waiting on subagent Review src/math.ts", "Waiting on 1 command and 1 monitor", "Monitoring pull request #750", or "Running: npm run dev". */
  title: string;
  /** The labels of the items the title counts, leaving out subagents the tab over it lists. */
  labels?: string;
  /** Each item, by kind, for the details popover. */
  items: { kind: string; label: string }[];
}

const joinWithAnd = (parts: string[]) =>
  parts.length <= 1 ? parts.join("") : `${parts.slice(0, -1).join(", ")} and ${parts.at(-1)}`;

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
      return { kind, label: task.description.trim() || kinds[kind].singular };
    }),
    ...watching.map((url) => ({ kind: "pullRequest" as const, label: `#${numberOf(url)}` })),
  ].sort((a, b) => kinds[a.kind].order - kinds[b.kind].order);
  if (all.length === 0) return undefined;
  const details = all.map((item) => ({ kind: kinds[item.kind].singular, label: item.label }));
  const unnamed = (item: Item) => agentsShown && item.kind === "agent";
  const items = all.every(unnamed) ? all : all.filter((item) => !unnamed(item));
  const waiting = items.some((item) => item.kind !== "command");
  const [only] = items;
  if (items.length === 1 && only) {
    const noun = kinds[only.kind].singular;
    const named = only.label !== noun && !unnamed(only);
    const title =
      only.kind === "pullRequest"
        ? `Monitoring pull request ${only.label}`
        : !waiting
          ? named
            ? `Running: ${only.label}`
            : `Running a ${noun}`
          : !named
            ? `Waiting on a ${noun}`
            : only.kind === "monitor"
              ? only.label
              : `Waiting on ${noun} ${only.label}`;
    return { title, items: details };
  }
  const counts = new Map<Kind, number>();
  for (const item of items) counts.set(item.kind, (counts.get(item.kind) ?? 0) + 1);
  const groups = [...counts].map(
    ([kind, n]) => `${n} ${n === 1 ? kinds[kind].singular : kinds[kind].plural}`,
  );
  const verb = items.every((item) => item.kind === "pullRequest")
    ? "Monitoring"
    : waiting
      ? "Waiting on"
      : "Running";
  return {
    title: `${verb} ${joinWithAnd(groups)}`,
    labels: items
      .filter((item) => !unnamed(item))
      .map((item) => item.label)
      .join(", "),
    items: details,
  };
}
