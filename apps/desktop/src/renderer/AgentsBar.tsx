import { ChevronUp, CircleAlert, GitBranch, ShieldQuestion } from "lucide-react";
import { useId, useState, type ComponentType, type SVGProps } from "react";

import { DoneMark } from "./AttentionMark";
import { childOrder, runAttention, type Attention } from "./attention";
import type { ProjectAgentsView } from "./ProjectAgents";
import { OpenHint } from "./OpenHint";
import { popoverBeside } from "./ui";
import { instanceLogo, instanceName } from "./providers";
import { age, backendLogos } from "./Sidebar";
import { titleOf } from "./threads";
import { accountLabel } from "./transcript";

type Logo = ComponentType<SVGProps<SVGSVGElement>>;

/** One agent the bar lists: a Project's child, or a thread's own subagent. */
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
 * A Project's children as the bar lists them, oldest first. `needs` are the children whose
 * questions wait in the inbox.
 */
export function projectAgentRows(
  agents: ProjectAgentsView,
  titles: Readonly<Record<string, string>>,
  coordinator?: string,
  needs?: ReadonlySet<string>,
): AgentRow[] {
  return agents.runs
    .filter((r) => r.id !== coordinator && r.policy !== "noWrite")
    .map((run) => {
      const asks = (agents.waiting[run.id]?.length ?? 0) + (needs?.has(run.id) ? 1 : 0);
      return {
        id: run.id,
        title: titles[run.id] ?? titleOf(run),
        attention: runAttention(run, asks),
        Logo: backendLogos[run.backend] ?? instanceLogo(run.backend),
        ...(run.branch && { branch: run.branch }),
        ...(run.diff && { diff: run.diff }),
        updatedAt: run.updatedAt,
        detail: instanceName(run.accountId) ?? accountLabel(run.accountId),
      };
    });
}

/**
 * Agents at work, tucked over the composer as the plan is: a Project's children, or a thread's own
 * subagents. While any of them works or waits on the user, the providers of the first three as
 * stacked logos, a count of the rest, and the agent that matters most. It opens a card over the
 * chat listing them, those that need the user first, then those working, then the latest
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
  const waiting = going.filter((c) => c.attention === "needsYou").length;
  const extra = going.length - 3;

  return (
    <section aria-label={label}>
      <button
        type="button"
        popoverTarget={id}
        aria-expanded={open}
        title={open ? `Hide the ${label.toLowerCase()}` : `Show the ${label.toLowerCase()}`}
        className={`flex min-w-0 items-center gap-2.5 text-left text-body hover:bg-hover ${compact ? "h-7 rounded-lg px-1.5" : "w-full py-1.5 pr-3.5 pl-2"}`}
      >
        {/* The providers at work, as one quiet group. */}
        <span className="flex h-6 shrink-0 items-center gap-1.5 rounded-full border border-border bg-background px-2 [&_svg]:size-3.5">
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
            <span className="truncate">{lead.title}</span>
          </span>
        )}
        <span className="flex shrink-0 items-center gap-1.5 text-meta text-muted-foreground tabular-nums">
          {waiting > 0 ? (
            <>
              <span aria-hidden className="size-1.5 rounded-full bg-warning" />
              {waiting} need you
            </>
          ) : (
            <>
              <span aria-hidden className="size-1.5 animate-pulse rounded-full bg-working" />
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
        onBeforeToggle={(e) => setOpen(e.newState === "open")}
        className={`inset-auto m-0 mb-2 max-h-[min(60vh,32rem)] overflow-y-auto rounded-2xl border border-border bg-surface p-1.5 text-foreground shadow-composer [position-try-fallbacks:flip-block] ${compact ? popoverBeside : "w-[anchor-size(width)] [position-area:top_span-right]"}`}
      >
        {open && (
          <>
            <CardGroup
              label="Working"
              items={going}
              onOpen={(runId) => {
                document.getElementById(id)?.hidePopover();
                onOpen(runId);
              }}
            />
            {finished.length > 0 && (
              <CardGroup
                label="Done"
                items={finished}
                onOpen={(runId) => {
                  document.getElementById(id)?.hidePopover();
                  onOpen(runId);
                }}
              />
            )}
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
      <h3 className="px-2.5 pt-2 pb-1 text-meta text-muted-foreground">
        {label} <span className="text-faint-foreground tabular-nums">{items.length}</span>
      </h3>
      <ul>
        {items.map((c) => (
          <li key={c.id}>
            <button
              type="button"
              onClick={() => onOpen(c.id)}
              className="group flex w-full min-w-0 items-center gap-3 rounded-xl px-2.5 py-2 text-left hover:bg-hover"
            >
              <span className="grid size-5 shrink-0 place-items-center [&_svg]:size-4">
                {c.Logo ? <c.Logo aria-hidden /> : null}
              </span>
              <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                <span className="truncate text-body">{c.title}</span>
                <span className="flex min-w-0 items-center gap-2 font-mono text-caption text-faint-foreground [&_svg]:size-3 [&_svg]:shrink-0">
                  <State attention={c.attention} />
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
              <span className="flex shrink-0 flex-col items-end gap-0.5 font-mono text-caption text-faint-foreground">
                {c.updatedAt && <span className="tabular-nums">{age(c.updatedAt)}</span>}
                {c.detail && <span>{c.detail}</span>}
              </span>
              <OpenHint />
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
        <ShieldQuestion aria-hidden />
        Needs you
      </span>
    );
  if (attention === "working")
    return (
      <span className="flex shrink-0 items-center gap-1.5 text-working">
        <span aria-hidden className="size-1.5 animate-pulse rounded-full bg-working" />
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
