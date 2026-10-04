import { ChevronUp, CircleAlert, CircleCheck, GitBranch, ShieldQuestion } from "lucide-react";
import { useId, useState, type ComponentType, type SVGProps } from "react";

import type { AgentRun } from "../protocol/generated/protocol";
import { childOrder, runAttention, type Attention } from "./attention";
import { Loader } from "./Loader";
import type { ProjectAgentsView } from "./ProjectAgents";
import { instanceLogo, instanceName } from "./providers";
import { age, backendLogos } from "./Sidebar";
import { titleOf } from "./threads";
import { accountLabel } from "./transcript";

type Logo = ComponentType<SVGProps<SVGSVGElement>>;

interface Child {
  run: AgentRun;
  title: string;
  attention: Attention;
  Logo?: Logo;
}

// How many finished children the card lists under those still going.
const finishedShown = 5;

/**
 * A Project's children, tucked over its composer as the plan is: while any of them works or waits
 * on the user, the providers of the first three as stacked logos, a count of the rest, and the
 * child that matters most. It opens a card over the chat listing them, those that need the user
 * first, then those working, then the latest finished; each opens its chat. Hidden while none is
 * going. `needs` are the children whose questions wait in the inbox.
 */
export function AgentsBar({
  agents,
  titles = {},
  coordinator,
  needs,
  onOpen,
}: {
  agents: ProjectAgentsView;
  titles?: Readonly<Record<string, string>>;
  coordinator?: string;
  needs?: ReadonlySet<string>;
  onOpen: (runId: string) => void;
}) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const children: Child[] = agents.runs
    .filter((r) => r.id !== coordinator && r.policy !== "noWrite")
    .map((run) => {
      const asks = (agents.waiting[run.id]?.length ?? 0) + (needs?.has(run.id) ? 1 : 0);
      return {
        run,
        title: titles[run.id] ?? titleOf(run),
        attention: runAttention(run, asks),
        Logo: backendLogos[run.backend] ?? instanceLogo(run.backend),
      };
    })
    .toReversed()
    .toSorted((a, b) => childOrder.indexOf(a.attention) - childOrder.indexOf(b.attention));
  const going = children.filter((c) => c.attention === "needsYou" || c.attention === "working");
  if (going.length === 0) return null;
  const finished = children.filter((c) => !going.includes(c)).slice(0, finishedShown);
  const lead = going[0]!;
  const waiting = going.filter((c) => c.attention === "needsYou").length;
  const extra = going.length - 3;

  return (
    <section
      aria-label="Agents"
      className="mx-5 -mb-4 rounded-t-3xl border border-b-0 border-border bg-surface pb-4"
    >
      <button
        type="button"
        popoverTarget={id}
        aria-expanded={open}
        title={open ? "Hide the agents" : "Show the agents"}
        className="flex w-full min-w-0 items-center gap-2.5 rounded-t-3xl py-1.5 pr-3.5 pl-2 text-left text-[13px] hover:bg-hover"
      >
        {/* The providers at work, as one quiet group. */}
        <span className="flex h-6 shrink-0 items-center gap-1.5 rounded-full border border-border bg-background px-2 [&_svg]:size-3.5">
          {going
            .slice(0, 3)
            .map((c) =>
              c.Logo ? (
                <c.Logo key={c.run.id} aria-hidden />
              ) : (
                <span key={c.run.id} className="size-1.5 rounded-full bg-muted-foreground" />
              ),
            )}
          {extra > 0 && (
            <span className="font-mono text-[11px] text-muted-foreground tabular-nums">
              +{extra}
            </span>
          )}
        </span>
        <span className="sr-only">
          {going.length} {going.length === 1 ? "agent" : "agents"} going
          {waiting > 0 && `, ${waiting} waiting on you`}:{" "}
        </span>
        <span className="flex min-w-0 flex-1 items-center gap-2">
          <span className="truncate">{lead.title}</span>
        </span>
        <span className="flex shrink-0 items-center gap-1.5 font-mono text-[11.5px] text-faint-foreground tabular-nums">
          {waiting > 0 ? (
            <>
              <span aria-hidden className="size-1.5 rounded-full bg-warning" />
              {waiting} need you
            </>
          ) : (
            <>
              <Loader kind="matrix" variant="ripple" size={11} />
              {going.length} working
            </>
          )}
        </span>
        <ChevronUp
          aria-hidden
          className={`size-3.5 shrink-0 text-faint-foreground transition-transform motion-reduce:transition-none ${open ? "rotate-180" : ""}`}
        />
      </button>
      <div
        id={id}
        popover="auto"
        onBeforeToggle={(e) => setOpen(e.newState === "open")}
        className="inset-auto m-0 mb-2 max-h-[min(60vh,32rem)] w-[anchor-size(width)] overflow-y-auto rounded-2xl border border-border bg-surface p-1.5 text-foreground shadow-composer [position-area:top_span-right] [position-try-fallbacks:flip-block]"
      >
        {open && (
          <>
            <CardGroup
              label="Going"
              items={going}
              onOpen={(runId) => {
                document.getElementById(id)?.hidePopover();
                onOpen(runId);
              }}
            />
            {finished.length > 0 && (
              <CardGroup
                label="Finished"
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
  items: Child[];
  onOpen: (runId: string) => void;
}) {
  return (
    <section aria-label={label}>
      <h3 className="px-2.5 pt-1.5 pb-1 font-mono text-[11px] tracking-wide text-faint-foreground uppercase">
        {label} <span className="tabular-nums">{items.length}</span>
      </h3>
      <ul>
        {items.map((c) => (
          <li key={c.run.id}>
            <button
              type="button"
              onClick={() => onOpen(c.run.id)}
              className="flex w-full min-w-0 items-center gap-3 rounded-xl px-2.5 py-2 text-left hover:bg-hover"
            >
              <span className="grid size-7 shrink-0 place-items-center rounded-lg bg-background [&_svg]:size-3.5">
                {c.Logo ? <c.Logo aria-hidden /> : null}
              </span>
              <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                <span className="truncate text-[13px]">{c.title}</span>
                <span className="flex min-w-0 items-center gap-2 font-mono text-[11px] text-faint-foreground [&_svg]:size-3 [&_svg]:shrink-0">
                  <State attention={c.attention} />
                  {c.run.branch && (
                    <span className="flex min-w-0 items-center gap-1">
                      <GitBranch aria-hidden />
                      <span className="truncate">{c.run.branch}</span>
                    </span>
                  )}
                  {c.run.diff && (
                    <span className="shrink-0 tabular-nums">
                      <span className="text-added">+{c.run.diff.insertions}</span>{" "}
                      <span className="text-danger">−{c.run.diff.deletions}</span>
                    </span>
                  )}
                </span>
              </span>
              <span className="flex shrink-0 flex-col items-end gap-0.5 font-mono text-[11px] text-faint-foreground">
                <span className="tabular-nums">{age(c.run.updatedAt)}</span>
                <span>{instanceName(c.run.accountId) ?? accountLabel(c.run.accountId)}</span>
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
        <ShieldQuestion aria-hidden />
        Needs you
      </span>
    );
  if (attention === "working")
    return (
      <span className="flex shrink-0 items-center gap-1.5 text-working">
        <Loader kind="matrix" variant="scan" size={11} />
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
    <span className="flex shrink-0 items-center gap-1">
      <CircleCheck aria-hidden />
      Ready
    </span>
  );
}
