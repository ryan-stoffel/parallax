import { Bot, ChevronDown, Lock } from "lucide-react";
import { useEffect, useId, useState } from "react";

import type { AgentRun, Thread } from "../protocol/generated/protocol";
import { attentionOf, type Attention } from "./attention";
import { duration, WorkingMark } from "./AttentionMark";
import { ClaudeLogo } from "./logos";
import { models } from "./models";
import { age, backendLogos } from "./Sidebar";
import { modelName, type NativeSubagent } from "./Subagents";
import { asksOf, childrenOf, type ThreadsState } from "./threads";
import { isRunning, statusLabel, subagentLabels, type SubagentState } from "./transcript";

const dotColors: Record<Attention, string> = {
  working: "bg-working",
  monitoring: "bg-working",
  waiting: "bg-working",
  needsYou: "bg-warning",
  done: "bg-added",
  failed: "bg-danger",
  settled: "bg-faint-foreground/45",
};
const attentionNames: Record<Exclude<Attention, "settled">, string> = {
  working: "Working",
  monitoring: "Monitoring",
  waiting: "Waiting",
  needsYou: "Needs you",
  done: "Done",
  failed: "Failed",
};
const subagentDots: Record<SubagentState, Attention> = {
  running: "working",
  completed: "settled",
  failed: "failed",
  stopped: "settled",
};
function StatusMark({ attention }: { attention: Attention }) {
  return attention === "working" ? (
    <span className="size-3.5 shrink-0 [&_svg]:size-3.5">
      <WorkingMark />
    </span>
  ) : (
    <span aria-hidden className={`size-1.5 shrink-0 rounded-full ${dotColors[attention]}`} />
  );
}
function ProviderLogo({ run }: { run?: AgentRun }) {
  const Logo = (run && backendLogos[run.backend]) ?? Bot;
  return <Logo aria-hidden className="size-3.5 shrink-0" />;
}
function statusText(attention: Attention, run?: AgentRun) {
  return attention !== "settled"
    ? attentionNames[attention]
    : run
      ? statusLabel(run.status)
      : "Idle";
}

/** A child that's still going, or waiting on the user, shows under Lineage; the rest are previous. */
const isCurrent = (attention: Attention) => attention === "working" || attention === "needsYou";

/**
 * All child threads and the open agent's native subagents. Current ones (working or needing
 * you) show under Lineage; finished ones go in a collapsed Previous agents section, which opens by
 * itself when the open thread is one of them. Each row's status mark sits at its right, by its time.
 */
export function LineageSection({
  state,
  root,
  openId,
  onOpen,
  subagents = [],
  activeSubagent,
  onOpenSubagent,
  visible,
  includeThreads = true,
}: {
  state: ThreadsState;
  root: Thread;
  openId: string;
  onOpen: (id: string) => void;
  subagents?: NativeSubagent[];
  activeSubagent?: string;
  onOpenSubagent?: (id: string) => void;
  visible: boolean;
  includeThreads?: boolean;
}) {
  const previousId = useId();
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (!visible) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [visible]);

  type Row =
    | { kind: "thread"; key: string; thread: Thread; attention: Attention; depth: number }
    | { kind: "subagent"; key: string; sub: NativeSubagent; attention: Attention; depth: number };
  const rows: Row[] = [];
  const seen = new Set<string>([root.id]);
  const subagentRows = (ancestors: Attention[]) => {
    for (const sub of subagents) {
      const attention = subagentDots[sub.state];
      const depth = ancestors.filter((a) => isCurrent(a) === isCurrent(attention)).length;
      rows.push({ kind: "subagent", key: sub.callId, sub, attention, depth });
    }
  };
  // Depth counts only ancestors in the same section, so a working grandchild of a finished child
  // isn't indented under a row that isn't there.
  const walk = (thread: Thread, ancestors: Attention[]) => {
    if (seen.has(thread.id)) return;
    seen.add(thread.id);
    const attention = attentionOf(thread, state.runs[thread.id], asksOf(state, thread.id));
    const depth = ancestors.filter((a) => isCurrent(a) === isCurrent(attention)).length;
    rows.push({ kind: "thread", key: thread.id, thread, attention, depth });
    if (thread.id === openId) subagentRows([...ancestors, attention]);
    for (const child of childrenOf(state, thread.id)) walk(child, [...ancestors, attention]);
  };
  if (openId === root.id) subagentRows([]);
  if (includeThreads) for (const child of childrenOf(state, root.id)) walk(child, []);
  const current = rows.filter((row) => isCurrent(row.attention));
  const previous = rows.filter((row) => !isCurrent(row.attention));
  const failed = previous.filter((row) => row.attention === "failed").length;
  const working = rows.filter((row) => row.attention === "working").length;

  const isOpen = (row: Row) =>
    row.kind === "thread"
      ? row.thread.id === openId && !activeSubagent
      : row.key === activeSubagent;
  // Opening a previous agent shows the section it's in.
  const openPrevious = previous.some(isOpen);
  const [expanded, setExpanded] = useState(openPrevious);
  const [wasOpenPrevious, setWasOpenPrevious] = useState(openPrevious);
  if (openPrevious !== wasOpenPrevious) {
    setWasOpenPrevious(openPrevious);
    if (openPrevious) setExpanded(true);
  }

  const rowView = (row: Row) => {
    if (row.kind === "subagent") {
      const { sub } = row;
      return (
        <li key={row.key}>
          <button
            type="button"
            aria-current={isOpen(row) ? "page" : undefined}
            aria-label={`${sub.title}, read-only subagent, ${subagentLabels[sub.state]}`}
            title={`${sub.title} · ${subagentLabels[sub.state]} · Read-only subagent`}
            onClick={() => onOpenSubagent?.(sub.callId)}
            style={{ paddingLeft: `${8 + row.depth * 14}px` }}
            className="flex w-full flex-col gap-0.5 rounded-md py-2 pr-2 text-left hover:bg-hover aria-[current=page]:bg-selected"
          >
            <span className="flex w-full min-w-0 items-center gap-2 text-[13px]">
              <ClaudeLogo aria-hidden className="size-3.5 shrink-0" />
              <span data-lineage-title className="min-w-0 flex-1 truncate">
                {sub.title}
              </span>
              <Lock aria-hidden className="size-3 shrink-0 text-faint-foreground" />
              <StatusMark attention={row.attention} />
            </span>
            <span className="w-full truncate pl-5.5 text-[11.5px] text-faint-foreground">
              {[modelName(sub.model), subagentLabels[sub.state], "Read-only subagent"]
                .filter(Boolean)
                .join(" · ")}
            </span>
          </button>
        </li>
      );
    }
    const { thread, attention } = row;
    const run = state.runs[thread.id];
    const title = state.titles[thread.id] ?? "Thread";
    const model = run?.model && (models.find((m) => m.id === run.model)?.name ?? run.model);
    const end = run && (isRunning(run.status) ? now : Date.parse(run.updatedAt));
    const seconds = run && end ? Math.floor((end - Date.parse(run.createdAt)) / 1000) : 0;
    const last = run && age(run.updatedAt, now);
    return (
      <li key={row.key}>
        <button
          type="button"
          aria-current={isOpen(row) ? "page" : undefined}
          title={`${title} · ${statusText(attention, run)}`}
          onClick={() => onOpen(thread.id)}
          style={{ paddingLeft: `${8 + row.depth * 14}px` }}
          className="flex w-full flex-col gap-0.5 rounded-md py-2 pr-2 text-left hover:bg-hover aria-[current=page]:bg-selected"
        >
          <span className="flex w-full min-w-0 items-center gap-2 text-[13px]">
            <ProviderLogo run={run} />
            <span data-lineage-title className="min-w-0 flex-1 truncate">
              {title}
            </span>
            {run && (
              <span className="shrink-0 text-[11.5px] text-faint-foreground tabular-nums">
                {duration(Math.max(0, seconds))}
              </span>
            )}
            <StatusMark attention={attention} />
          </span>
          <span className="w-full truncate pl-5.5 text-[11.5px] text-faint-foreground">
            {[
              model,
              statusText(attention, run),
              last && (last === "now" ? "just now" : `${last} ago`),
            ]
              .filter(Boolean)
              .join(" · ")}
          </span>
        </button>
      </li>
    );
  };

  return (
    <section aria-label="Lineage" className="border-t border-border p-2">
      <h3 className="px-2 pt-1 pb-2 text-[12px] text-muted-foreground">
        Lineage{working > 0 && ` · ${working} running`}
      </h3>
      {current.length > 0 && <ul className="flex flex-col gap-px">{current.map(rowView)}</ul>}
      {previous.length > 0 && (
        <>
          <button
            type="button"
            aria-expanded={expanded}
            aria-controls={previousId}
            onClick={() => setExpanded((was) => !was)}
            className="flex w-full items-center gap-3 rounded-md px-2 py-2 text-[12.5px] text-faint-foreground hover:bg-hover"
          >
            <span className="shrink-0">Previous agents ({previous.length})</span>
            <span aria-hidden className="h-px min-w-4 flex-1 bg-border" />
            {failed > 0 && <span className="shrink-0 text-danger">{failed} failed</span>}
            <ChevronDown
              aria-hidden
              className={`size-3.5 shrink-0 transition-transform ${expanded ? "rotate-180" : ""}`}
            />
          </button>
          <ul id={previousId} hidden={!expanded} className="flex flex-col gap-px">
            {expanded && previous.map(rowView)}
          </ul>
        </>
      )}
      {rows.length === 0 && (
        <p className="px-2 py-1 text-[12px] text-faint-foreground">No child threads yet</p>
      )}
    </section>
  );
}
