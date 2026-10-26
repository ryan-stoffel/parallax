// The agent's plan (PLX-220): its checklist as lines in the transcript, a strip over the
// composer with its card while the run goes, and Claude Code's proposed plan. The checklist comes
// from plxd, as for TodoWrite, or from Claude Code's task tools (PLX-248). Its pure helpers are in
// plans.ts.
import { TraceIcon, TraceLine, TraceTitle } from "./Trace";
import {
  Ban,
  ChevronDown,
  ChevronUp,
  CircleX,
  ClipboardList,
  ListChecks,
  LoaderCircle,
} from "lucide-react";
import {
  memo,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
  type ToggleEvent,
} from "react";

import type { AgentTodoItem, AgentToolStatus } from "../protocol/generated/protocol";
import { planChanges, type PlanRow, type PlanUpdate } from "./plans";
import { popoverBeside } from "./ui";

/** A step's state. A status newer than this app counts as to do. */
const stateOf = (status: string) =>
  status === "completed" ? "done" : status === "inProgress" ? "now" : "todo";
const stateLabels = { done: "Done", now: "In progress", todo: "To do" };
const stateColors = {
  done: "text-faint-foreground",
  now: "text-foreground",
  todo: "text-muted-foreground",
};
const doneCount = (items: readonly AgentTodoItem[]) =>
  items.filter((s) => s.status === "completed").length;
/** Each step's key: its text, counted when repeated, so it keeps its key as steps come and go. */
function stepKeys(items: readonly AgentTodoItem[]) {
  const seen = new Map<string, number>();
  return items.map(({ text }) => {
    const n = (seen.get(text) ?? 0) + 1;
    seen.set(text, n);
    return n > 1 ? `${text}#${n}` : text;
  });
}

/** The plan's progress as a slim bar in the accent, easing to its new width. */
function ProgressBar({
  done,
  total,
  className = "",
}: {
  done: number;
  total: number;
  className?: string;
}) {
  return (
    <span aria-hidden className={`block overflow-hidden rounded-full bg-selected ${className}`}>
      <span
        className="plan-bar block h-full rounded-full bg-accent"
        style={{ width: `${total ? (done / total) * 100 : 0}%` }}
      />
    </span>
  );
}

/**
 * A checklist as a plan: "Plan", how many steps are done, a progress bar, and each step in its
 * state. A step under way shows the planning loader. A step the card showed
 * unfinished draws its check as it finishes; one done before then, as on opening it, or that
 * comes done, as a renamed one, just shows it.
 */
export const PlanCard = memo(function PlanCard({ items }: { items: readonly AgentTodoItem[] }) {
  const id = useId();
  const keys = stepKeys(items);
  const unfinished = keys.filter((_, i) => items[i]!.status !== "completed");
  // The steps this card has shown unfinished, by key.
  const [shown, setShown] = useState<ReadonlySet<string>>(() => new Set(unfinished));
  if (unfinished.some((k) => !shown.has(k))) setShown(new Set([...shown, ...unfinished]));
  const done = doneCount(items);
  return (
    <div
      role="group"
      aria-labelledby={id}
      className="rounded-xl border border-border bg-surface px-4 pt-3 pb-2.5"
    >
      <div className="flex items-center gap-2 text-body">
        <ListChecks aria-hidden className="size-3.5 shrink-0 text-faint-foreground" />
        <span id={id} className="flex-1 font-medium">
          Plan
        </span>
        <span className="text-meta text-muted-foreground tabular-nums">
          {done} of {items.length} done
        </span>
      </div>
      <ProgressBar done={done} total={items.length} className="mt-2.5 h-[3px]" />
      <ol className="mt-2.5">
        {items.map((step, i) => (
          <Step key={keys[i]} step={step} draw={shown.has(keys[i]!)} />
        ))}
      </ol>
    </div>
  );
});

function Step({ step, draw }: { step: AgentTodoItem; draw: boolean }) {
  const state = stateOf(step.status);
  return (
    <li className="plan-step relative flex gap-2.5 py-1">
      <span className="grid h-5 w-4 shrink-0 place-items-center">
        <Marker state={state} draw={draw} />
      </span>
      <span
        className={`min-w-0 text-body leading-5 transition-colors duration-300 motion-reduce:transition-none ${stateColors[state]}`}
      >
        <span className="sr-only">{stateLabels[state]}: </span>
        {step.text}
      </span>
    </li>
  );
}

/** A step's mark: a check when done, a spinner in a soft accent disc while under way, or a hollow dot. */
function Marker({ state, draw = false }: { state: "done" | "now" | "todo"; draw?: boolean }) {
  if (state === "done") return <Check draw={draw} />;
  if (state === "todo")
    return <span className="size-[9px] rounded-full border-[1.5px] border-faint-foreground/70" />;
  return (
    <span className="grid size-4 place-items-center rounded-full bg-accent/15">
      <LoaderCircle aria-hidden className="size-3.5 animate-spin text-working" />
    </span>
  );
}

/** A done step's check, in a soft disc. `draw` draws it in, as the step finishes. */
function Check({ draw }: { draw: boolean }) {
  return (
    <svg
      aria-hidden
      viewBox="0 0 16 16"
      className={`plan-check size-4 text-muted-foreground ${draw ? "plan-check-draw" : ""}`}
    >
      <circle cx="8" cy="8" r="7" fill="currentColor" opacity="0.16" />
      <path
        d="M5.1 8.3 7.1 10.2 10.9 6.1"
        pathLength={1}
        fill="none"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/**
 * One line for the turn's plan in the transcript: where it was made, with how many steps are
 * done, and each later update with what changed, such as "Finished: Add tests". The full list is
 * the strip's card, over the composer.
 */
export function PlanLine({ item }: { item: PlanRow | PlanUpdate }) {
  const made = item.kind === "plan";
  const changes = made
    ? `${doneCount(item.items)} of ${item.items.length} done`
    : item.previous
      ? planChanges(item.previous, item.items)
      : "";
  return (
    <TraceLine>
      <TraceIcon>
        <ListChecks />
      </TraceIcon>
      <TraceTitle className="shrink-0">
        {made ? "Made a plan" : item.items.length === 0 ? "Cleared the plan" : "Updated the plan"}
      </TraceTitle>
      {changes && (
        <span className="truncate text-faint-foreground" title={changes}>
          {changes}
        </span>
      )}
    </TraceLine>
  );
}

/**
 * The plan over the composer while the run goes: the step under way (as TodoWrite says it, when it
 * does), how many are done, and a mini bar. It's tucked behind the box, as the tab is under it, and
 * opens the full card above itself. `compact` leaves out the step, for a place beside other tabs.
 */
export function PlanStrip({
  items,
  active,
  returnFocus,
  compact,
}: {
  items: readonly AgentTodoItem[];
  active?: string;
  /** Moves focus on, such as to the composer, when the strip goes with focus in it. Read once. */
  returnFocus?: () => void;
  compact?: boolean;
}) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const section = useRef<HTMLElement>(null);
  const [onGone] = useState(() => returnFocus);
  // Before it leaves the page, so focus doesn't fall to the body.
  useLayoutEffect(() => {
    const el = section.current!;
    return () => {
      if (el.contains(document.activeElement)) onGone?.();
    };
  }, [onGone]);
  const done = doneCount(items);
  const now = items.find((s) => s.status === "inProgress");
  const next = now ?? items.find((s) => s.status !== "completed");
  return (
    <section ref={section} aria-label="Plan" className="plan-strip">
      <button
        type="button"
        popoverTarget={id}
        aria-expanded={open}
        title={open ? "Hide the plan" : "Show the plan"}
        className={`flex min-w-0 items-center gap-2.5 text-left text-body hover:bg-hover ${compact ? "h-7 rounded-lg px-1.5" : "w-full py-0.5 pr-3.5 pl-4"}`}
      >
        <span className="grid size-4 shrink-0 place-items-center">
          <Marker state={now ? "now" : next ? "todo" : "done"} />
        </span>
        <span className={compact ? "sr-only" : "min-w-0 flex-1 truncate"}>
          {next ? (
            <>
              <span className="sr-only">{now ? "In progress: " : "Next: "}</span>
              {now ? (active ?? now.text) : next.text}
            </>
          ) : (
            "All steps done"
          )}
        </span>
        <span className="shrink-0 text-meta text-muted-foreground tabular-nums">
          {done} of {items.length}
          <span className="sr-only"> done</span>
        </span>
        <ProgressBar done={done} total={items.length} className="h-[3px] w-12 shrink-0" />
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
        // Before it shows, so it never shows empty.
        onBeforeToggle={(e: ToggleEvent<HTMLDivElement>) => setOpen(e.newState === "open")}
        className={`inset-auto m-0 mb-2 max-h-[min(60vh,32rem)] overflow-y-auto rounded-xl border-0 bg-transparent p-0 text-foreground shadow-composer [position-try-fallbacks:flip-block] ${compact ? popoverBeside : "w-[anchor-size(width)] [position-area:top_span-right]"}`}
      >
        {/* Only while open, so it mounts with the steps done so far drawn, not drawing. */}
        {open && <PlanCard items={items} />}
      </div>
    </section>
  );
}

// About 16 lines of the transcript's Markdown (14px at 1.65). A plan up to two lines longer shows
// whole, so folding never hides just a line or two.
const collapsedHeight = 368;
const slack = 46;

/**
 * Claude Code's proposed plan as a card: `children` is the plan, rendered. Past about 16 lines it
 * folds behind a fade, with Show full plan, and opens when focus moves into it; the transcript
 * keeps whether it's open, by `id`. `actions` go at its foot, such as approving it (PLX-196).
 * Pinned in less room than it wants, the plan gives way, never its header or actions, and in less
 * room than those need, the card scrolls (PLX-259).
 */
export function ProposedPlan({
  id,
  status,
  open,
  onToggle,
  actions,
  foldAt = collapsedHeight,
  openHeight,
  children,
}: {
  id: string;
  /** How its call ended: one that was denied or failed says so. */
  status?: AgentToolStatus;
  open: boolean;
  onToggle: (key: string, open: boolean) => void;
  actions?: ReactNode;
  /** The folded height in px, shorter where it's pinned over the composer. */
  foldAt?: number;
  /** Where it's pinned: the open plan's height at most, as CSS, past which it scrolls. */
  openHeight?: string;
  children: ReactNode;
}) {
  const verdict =
    status === "denied"
      ? { label: "Not approved", icon: <Ban aria-hidden className="size-3.5" /> }
      : status === "error"
        ? { label: "Failed", icon: <CircleX aria-hidden className="size-3.5" /> }
        : undefined;
  const headingId = useId();
  const verdictId = useId();
  const content = useRef<HTMLDivElement>(null);
  const [long, setLong] = useState(false);
  useLayoutEffect(() => {
    const el = content.current!;
    const measure = () => setLong(el.scrollHeight > foldAt + slack);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [foldAt]);
  const folded = long && !open;
  return (
    <div
      role="group"
      aria-labelledby={verdict ? `${headingId} ${verdictId}` : headingId}
      className="flex flex-col overflow-x-hidden overflow-y-auto rounded-xl border border-border bg-surface"
    >
      <div className="flex items-center gap-2 border-b border-border px-4 py-2.5 text-body">
        <ClipboardList aria-hidden className="size-3.5 shrink-0 text-faint-foreground" />
        <span id={headingId} className="flex-1 font-medium">
          Proposed plan
        </span>
        {verdict && (
          <span id={verdictId} className="flex shrink-0 items-center gap-1.5 text-meta text-danger">
            {verdict.icon}
            {verdict.label}
          </span>
        )}
      </div>
      <div
        className="relative overflow-hidden px-4 pt-3 pb-3.5"
        style={
          folded
            ? { maxHeight: foldAt }
            : long && openHeight
              ? { maxHeight: openHeight, overflowY: "auto" }
              : undefined
        }
        // Tabbing into the fold, as to a code block's Copy, opens it rather than scroll within it;
        // a click doesn't.
        onFocus={(e) => folded && e.target.matches(":focus-visible") && onToggle(id, true)}
      >
        <div ref={content} className="proposed-plan">
          {children}
        </div>
        {folded && (
          <div
            aria-hidden
            className="pointer-events-none absolute inset-x-0 bottom-0 h-24 bg-linear-to-t from-surface to-transparent"
          />
        )}
      </div>
      {long && (
        <button
          type="button"
          aria-expanded={open}
          onClick={() => onToggle(id, !open)}
          className="flex w-full items-center gap-1.5 px-4 pt-0.5 pb-3 text-body text-muted-foreground hover:text-foreground"
        >
          {open ? (
            <ChevronUp aria-hidden className="size-3.5" />
          ) : (
            <ChevronDown aria-hidden className="size-3.5" />
          )}
          {open ? "Show less" : "Show full plan"}
        </button>
      )}
      {actions && (
        <div className="flex items-center justify-end gap-2 border-t border-border px-4 py-2.5">
          {actions}
        </div>
      )}
    </div>
  );
}
