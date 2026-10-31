import { ChevronUp, CircleAlert, GitBranch, MessageCircleQuestion } from "lucide-react";
import { useId, useState, type ComponentType, type SVGProps } from "react";

import { DoneMark, WorkingMark } from "./AttentionMark";
import { childOrder, runAttention, type Attention } from "./attention";
import type { OrchestratorAgentsView } from "./OrchestratorAgents";
import { OpenHint } from "./OpenHint";
import { popoverBeside } from "./ui";
import { instanceName } from "./providers";
import { age, backendLogo } from "./Sidebar";
import { titleOf } from "./threads";
import { accountLabel } from "./transcript";

type Logo = ComponentType<SVGProps<SVGSVGElement>>;

/** One agent the bar lists: an orchestrator's child, or a thread's own subagent. */
export interface AgentRow {
  id: string;
  title: string;
  attention: Attention;
  Logo?: Logo;
  branch?: string;
  diff?: { insertions: number; deletions: number };
  updatedAt?: string;
  /** Under its time, such as its account or model. */
  detail?: string;
}

// How many finished agents the card lists under those still going.
const finishedShown = 5;

/** Whether an agent works or waits on the user, which shows the bar. */
export const isGoing = (row: AgentRow) =>
  row.attention === "needsYou" || row.attention === "working";

/**
 * An orchestrator's children as the bar lists them, oldest first. `needs` are the children whose
 * questions wait in the inbox.
 */
export function orchestratorAgentRows(
  agents: OrchestratorAgentsView,
  titles: Readonly<Record<string, string>>,
  orchestratorRun?: string,
  needs?: ReadonlySet<string>,
): AgentRow[] {
  return agents.runs
    .filter((r) => r.id !== orchestratorRun && r.policy !== "noWrite")
    .map((run) => {
      const asks = (agents.waiting[run.id]?.length ?? 0) + (needs?.has(run.id) ? 1 : 0);
      return {
        id: run.id,
        title: titles[run.id] ?? titleOf(run),
        attention: runAttention(run, asks),
        Logo: backendLogo(run.backend),
        ...(run.branch && { branch: run.branch }),
        ...(run.diff && { diff: run.diff }),
        updatedAt: run.updatedAt,
        detail: instanceName(run.accountId) ?? accountLabel(run.accountId),
      };
    });
}

/**
 * Agents at work, tucked over the composer as the plan is: an orchestrator's children, or a
 * thread's own subagents. While any of them works or waits on the user, the providers of the first
 * three as bare logos, a count of the rest, and the agent that matters most. It opens a card
 * grouped by those that need the user, those working, then the latest
 * finished; each opens its chat. Hidden while none is going. `rows` go oldest first. `compact`
 * leaves out the lead agent's title, for a place beside other tabs.
 */
export function AgentsBar({
  rows,
  label = "Agents",
  onOpen,
  compact,
}: {
  rows: readonly AgentRow[];
  label?: string;
  onOpen: (id: string) => void;
  compact?: boolean;
}) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const children = rows
    .toReversed()
    .toSorted((a, b) => childOrder.indexOf(a.attention) - childOrder.indexOf(b.attention));
  const going = children.filter(isGoing);
  if (going.length === 0) return null;
  const finished = children.filter((c) => !isGoing(c)).slice(0, finishedShown);
  const lead = going[0]!;
  const needsYou = going.filter((c) => c.attention === "needsYou");
  const working = going.filter((c) => c.attention === "working");
  const waiting = needsYou.length;
  const extra = going.length - 3;
  const openRow = (runId: string) => {
    document.getElementById(id)?.hidePopover();
    onOpen(runId);
  };

  return (
    <section aria-label={label}>
      <button
        type="button"
        popoverTarget={id}
        aria-expanded={open}
        aria-haspopup="dialog"
        title={open ? `Hide the ${label.toLowerCase()}` : `Show the ${label.toLowerCase()}`}
        className={`flex min-w-0 items-center gap-2.5 rounded-lg text-left text-body text-muted-foreground transition-colors hover:bg-hover hover:text-foreground ${compact ? "h-7 px-2" : "w-full py-1 pr-2.5 pl-2"}`}
      >
        {/* The providers at work, as one quiet group. */}
        <span className="flex h-5 shrink-0 items-center gap-2 text-foreground/80 [&_svg]:size-3.5">
          {going
            .slice(0, 3)
            .map((c) =>
              c.Logo ? (
                <c.Logo key={c.id} aria-hidden />
              ) : (
                <span key={c.id} className="size-1.5 rounded-full bg-muted-foreground" />
              ),
            )}
          {extra > 0 && (
            <span className="font-mono text-caption text-muted-foreground tabular-nums">
              +{extra}
            </span>
          )}
        </span>
        <span className="sr-only">
          {going.length} {going.length === 1 ? "agent" : "agents"} going
          {waiting > 0 && `, ${waiting} waiting on you`}:{" "}
        </span>
        {!compact && (
          <span className="flex min-w-0 flex-1 items-center gap-2">
            <span className="truncate text-foreground/90">{lead.title}</span>
          </span>
        )}
        <span className="flex shrink-0 items-center gap-1.5 text-meta tabular-nums [&_svg]:size-3.5">
          {waiting > 0 ? (
            <>
              <MessageCircleQuestion aria-hidden className="text-warning" />
              {waiting} need you
            </>
          ) : (
            <>
              <WorkingMark />
              {going.length} working
            </>
          )}
        </span>
        {!compact && (
          <ChevronUp
            aria-hidden
            className={`size-3.5 shrink-0 text-faint-foreground transition-transform motion-reduce:transition-none ${open ? "rotate-180" : ""}`}
          />
        )}
      </button>
      <div
        id={id}
        popover="auto"
        role="dialog"
        aria-label={label}
        onBeforeToggle={(e) => setOpen(e.newState === "open")}
        className={`inset-auto m-0 mb-2 max-h-[min(60vh,32rem)] overflow-y-auto rounded-prompt border border-border bg-surface text-foreground shadow-composer [position-try-fallbacks:flip-block] ${compact ? popoverBeside : "w-[anchor-size(width)] max-w-[min(36rem,calc(100vw-2rem))] [position-area:top_span-right]"}`}
      >
        {open && (
          <>
            <header className="flex items-center justify-between gap-3 border-b border-border px-4 py-3">
              <h2 className="text-body font-medium">{label}</h2>
              <span className="text-meta text-faint-foreground tabular-nums">
                {going.length} active
              </span>
            </header>
            <div className="p-1.5">
              {needsYou.length > 0 && (
                <CardGroup label="Needs you" items={needsYou} onOpen={openRow} />
              )}
              {working.length > 0 && <CardGroup label="Working" items={working} onOpen={openRow} />}
              {finished.length > 0 && (
                <CardGroup label="Recent" items={finished} onOpen={openRow} />
              )}
            </div>
          </>
        )}
      </div>
    </section>
  );
}

function CardGroup({
  label,
  items,
  onOpen,
}: {
  label: string;
  items: AgentRow[];
  onOpen: (runId: string) => void;
}) {
  return (
    <section aria-label={label}>
      <h3 className="flex items-center gap-2 px-2.5 pt-2 pb-1 text-caption font-medium text-faint-foreground">
        {label} <span className="text-faint-foreground tabular-nums">{items.length}</span>
      </h3>
      <ul>
        {items.map((c) => (
          <li key={c.id}>
            <button
              type="button"
              onClick={() => onOpen(c.id)}
              className="group flex w-full min-w-0 items-start gap-3 rounded-lg px-2.5 py-2.5 text-left transition-colors hover:bg-hover"
            >
              <span className="grid size-5 shrink-0 place-items-center text-foreground/80 [&_svg]:size-4">
                {c.Logo ? <c.Logo aria-hidden /> : null}
              </span>
              <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                <span className="truncate text-body font-medium">{c.title}</span>
                <span className="flex min-w-0 items-center gap-2 text-meta text-faint-foreground [&_svg]:size-3 [&_svg]:shrink-0">
                  {c.detail && <span className="max-w-40 truncate">{c.detail}</span>}
                  {c.branch && (
                    <span className="flex min-w-0 items-center gap-1">
                      <GitBranch aria-hidden />
                      <span className="truncate">{c.branch}</span>
                    </span>
                  )}
                  {c.diff && (
                    <span className="shrink-0 tabular-nums">
                      <span className="text-added">+{c.diff.insertions}</span>{" "}
                      <span className="text-danger">−{c.diff.deletions}</span>
                    </span>
                  )}
                </span>
              </span>
              <span className="flex shrink-0 flex-col items-end gap-0.5 text-meta text-faint-foreground [&_svg]:size-3.5">
                <State attention={c.attention} />
                {c.updatedAt && (
                  <span className="text-caption tabular-nums">{age(c.updatedAt)}</span>
                )}
              </span>
              <span className="self-center">
                <OpenHint />
              </span>
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}

function State({ attention }: { attention: Attention }) {
  if (attention === "needsYou")
    return (
      <span className="flex shrink-0 items-center gap-1 text-warning">
        <MessageCircleQuestion aria-hidden />
        Needs you
      </span>
    );
  if (attention === "working")
    return (
      <span className="flex shrink-0 items-center gap-1.5 text-muted-foreground">
        <WorkingMark />
        Working
      </span>
    );
  if (attention === "failed")
    return (
      <span className="flex shrink-0 items-center gap-1 text-danger">
        <CircleAlert aria-hidden />
        Failed
      </span>
    );
  return (
    <span className="flex shrink-0 items-center gap-1 text-added">
      <DoneMark animate={false} />
      Done
    </span>
  );
}
