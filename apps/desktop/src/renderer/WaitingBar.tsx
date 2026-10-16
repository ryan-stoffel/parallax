import { Info } from "lucide-react";
import { useId, useState } from "react";

import type { AgentBackgroundKind, AgentBackgroundTask } from "../protocol/generated/protocol";
import { numberOf } from "./PullRequests";
import { menuPanel } from "./ui";

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
  /** Every item's label, for a title that only counts them. */
  labels?: string;
  /** Each item, by kind, for the details popover. */
  items: { kind: string; label: string }[];
}

const joinWithAnd = (parts: string[]) =>
  parts.length <= 1 ? parts.join("") : `${parts.slice(0, -1).join(", ")} and ${parts.at(-1)}`;

/**
 * What a settled thread still waits on, as T3 Code's `presentPendingBackgroundWork` names it
 * (PLX-777): its agent's background tasks and the pull requests plxd watches, which read as
 * Monitoring. Undefined for nothing.
 */
export function presentWaiting(
  background: AgentBackgroundTask[],
  watching: string[],
): WaitingPresentation | undefined {
  const items: Item[] = [
    ...background.map((task) => {
      const kind = task.kind in kinds ? task.kind : "command";
      return { kind, label: task.description.trim() || kinds[kind].singular };
    }),
    ...watching.map((url) => ({ kind: "pullRequest" as const, label: `#${numberOf(url)}` })),
  ].toSorted((a, b) => kinds[a.kind].order - kinds[b.kind].order);
  if (items.length === 0) return undefined;
  const waiting = items.some((item) => item.kind !== "command");
  const details = items.map((item) => ({ kind: kinds[item.kind].singular, label: item.label }));
  const [only] = items;
  if (items.length === 1 && only) {
    const noun = kinds[only.kind].singular;
    const named = only.label !== noun;
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
    labels: items.map((item) => item.label).join(", "),
    items: details,
  };
}

/**
 * What a thread's settled agent still waits on, tucked over its composer as T3 Code's strip is
 * (PLX-777): one line naming its background tasks, such as a Monitor, and the pull requests plxd
 * watches for it, and Stop, which ends them all. Hidden while it waits on nothing.
 */
export function WaitingBar({
  hostId,
  runId,
  background,
  watching,
}: {
  hostId: string;
  runId: string;
  background: AgentBackgroundTask[];
  watching: string[];
}) {
  const [stopping, setStopping] = useState(false);
  const [error, setError] = useState<string>();
  const id = useId();
  const shown = presentWaiting(background, watching);
  if (!shown) return null;

  async function stop() {
    setStopping(true);
    setError(undefined);
    const answers = await Promise.all([
      ...background.map((task) =>
        window.parallax.request(hostId, "agent/stopTask", { runId, taskId: task.taskId }),
      ),
      ...watching.map((url) => window.parallax.request(hostId, "pr/unwatch", { runId, url })),
    ]);
    // Taking the request doesn't end the work: what ends leaves with plxd's events, and what
    // didn't can be stopped again.
    setStopping(false);
    const failed = answers.find((answer) => "error" in answer);
    if (failed && "error" in failed) setError(failed.error.message);
  }

  return (
    <section
      aria-label="Waiting on"
      className="rounded-t-3xl border border-b-0 border-border bg-surface pt-1 pb-5 text-[13px]"
    >
      <div className="flex min-w-0 items-center gap-2.5 py-1 pr-3 pl-4">
        <span aria-hidden className="size-1.5 shrink-0 animate-pulse rounded-full bg-foreground" />
        <span className="min-w-0 truncate font-medium">{shown.title}</span>
        <span className="min-w-0 flex-1 truncate text-muted-foreground">{shown.labels}</span>
        <button
          type="button"
          popoverTarget={`${id}-details`}
          aria-label="What it waits on"
          aria-haspopup="dialog"
          className="grid size-6 shrink-0 place-items-center rounded-md text-muted-foreground hover:bg-hover hover:text-foreground [&_svg]:size-3.5"
        >
          <Info aria-hidden />
        </button>
        <button
          type="button"
          disabled={stopping}
          onClick={() => void stop()}
          className="shrink-0 rounded-md px-2 py-0.5 font-medium text-foreground hover:bg-hover disabled:opacity-40"
        >
          {stopping ? "Stopping…" : "Stop"}
        </button>
      </div>
      <div
        id={`${id}-details`}
        popover="auto"
        role="dialog"
        aria-label="Waiting on"
        className={`${menuPanel("end")} w-80 p-3 text-[12.5px]`}
      >
        <p className="mb-2 text-muted-foreground">
          The agent picks up when one of these ends or changes.
        </p>
        <ul className="space-y-1.5">
          {shown.items.map((item, i) => (
            <li key={i} className="flex min-w-0 gap-2">
              <span className="w-20 shrink-0 text-muted-foreground capitalize">{item.kind}</span>
              <span className="min-w-0 break-words">{item.label}</span>
            </li>
          ))}
        </ul>
      </div>
      {error && (
        <p role="alert" className="px-4 pb-1 text-[12.5px] text-danger">
          {error}
        </p>
      )}
    </section>
  );
}
