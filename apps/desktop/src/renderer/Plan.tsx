// The agent's plan (RYA-220): its checklist as a card with progress, a strip over the composer
// while the run goes, and Claude Code's proposed plan. The checklist comes from wispd, as for
// TodoWrite, or from Claude Code's task tools (RYA-248). Pure helpers first, then the components.
import { Ban, ChevronDown, ChevronUp, CircleX, ClipboardList, ListChecks } from "lucide-react";
import {
  memo,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
  type ToggleEvent,
} from "react";

import type {
  AgentTodoItem,
  AgentTodoStatus,
  AgentToolStatus,
  JsonValue,
} from "../protocol/generated/protocol";
import { Loader, type LoaderStyle } from "./Loader";
import type { Item } from "./transcript";

type Todo = Extract<Item, { kind: "todo" }>;
type Tool = Extract<Item, { kind: "tool" }>;

/**
 * A turn's plan, in place of its first checklist: the turn's latest checklist, so the card
 * updates in place. `latest` marks the last turn's, the only one that can still be in progress.
 */
export interface PlanRow {
  kind: "plan";
  key: string;
  at?: string;
  items: AgentTodoItem[];
  latest?: boolean;
}

/** A later checklist in the turn, with the one before it, so its line can say what changed. */
export type PlanUpdate = Todo & { previous?: AgentTodoItem[] };

/** Claude Code's `ExitPlanMode` call: the plan it proposes, in Markdown, and the call it answers. */
export interface ProposedPlanRow {
  kind: "proposedPlan";
  key: string;
  at?: string;
  plan: string;
  callId: string;
  status?: AgentToolStatus;
}

const isObject = (v?: JsonValue): v is Record<string, JsonValue> =>
  !!v && typeof v === "object" && !Array.isArray(v);

/** The plan `ExitPlanMode` proposes, when its input carries one. */
function proposedPlan(item: Item): string | undefined {
  if (item.kind !== "tool" || item.name !== "ExitPlanMode" || !isObject(item.input)) return;
  const plan = item.input["plan"];
  return typeof plan === "string" ? plan : undefined;
}

// Rows made from an item keep their object while it's unchanged, so RowView's memo skips them
// (the proposed plan's Markdown isn't parsed again on every event).
const proposals = new WeakMap<Item, ProposedPlanRow>();
const updates = new WeakMap<Item, PlanUpdate>();

/** Whether two checklists have the same steps, in the same order and states. */
const sameList = (a: readonly AgentTodoItem[], b: readonly AgentTodoItem[]) =>
  a.length === b.length && a.every((s, i) => s.text === b[i]!.text && s.status === b[i]!.status);

/** A step of Claude Code's task list: its subject, state, and `activeForm`. */
interface Task {
  text: string;
  status: AgentTodoStatus;
  active?: string;
  /** Done with the rest of a finished list, which a later turn puts away. */
  away?: boolean;
}

const failed = (item: Tool) => item.status === "error" || item.status === "denied";
const field = (input: JsonValue | undefined, name: string) => {
  const value = isObject(input) ? input[name] : undefined;
  return typeof value === "string" ? value : undefined;
};
/** The first of `names` that `input` has as a non-empty string, as Claude Code reads its aliases. */
const aliased = (input: JsonValue | undefined, ...names: string[]) =>
  names.map((name) => field(input, name)).find((value) => value?.trim());
const taskStates: Partial<Record<string, AgentTodoStatus>> = {
  pending: "pending",
  in_progress: "inProgress",
  completed: "completed",
};

/**
 * Applies a call of Claude Code's task tools to `tasks`, and says whether it applied. TaskCreate
 * adds a step under the id its result names, "Task #3 created successfully: …", or under its call
 * until that result arrives or if it can't be read, so the step shows either way. TaskUpdate
 * changes a step's status, subject, or `activeForm`, or removes it, by the id its result names,
 * "Updated task #3 status". Claude Code answers one it couldn't apply in words, such as "Task not
 * found", without failing the call, so only that answer or no result yet counts. TaskList,
 * TaskGet, and failed calls change nothing. 2.1.283 takes `id` or `task_id` for `taskId`, and
 * `active_form` for `activeForm`, so those count too (RYA-250).
 */
function applyTask(tasks: Map<string, Task>, item: Tool): boolean {
  if (failed(item)) return false;
  const { input, output } = item;
  const active = aliased(input, "activeForm", "active_form");
  if (item.name === "TaskCreate") {
    const subject =
      field(input, "subject") ?? /created successfully: (.+)/s.exec(output ?? "")?.[1];
    if (!subject) return false;
    const id = /^Task #([^\s:]+)/.exec(output ?? "")?.[1] ?? `call:${item.callId}`;
    tasks.set(id, { text: subject, status: "pending", active });
    return true;
  }
  if (item.name !== "TaskUpdate") return false;
  // Until the result arrives, by the id in the call, read in the order Claude Code reads it.
  const id =
    output === undefined
      ? aliased(input, "taskId", "id", "task_id")
      : /^Updated task #(\S+)/.exec(output)?.[1];
  const task = tasks.get(id ?? "");
  if (!id || !task) return false;
  const status = field(input, "status");
  if (status === "deleted") {
    tasks.delete(id);
    return true;
  }
  const next = taskStates[status ?? ""] ?? task.status;
  tasks.set(id, {
    text: field(input, "subject") ?? task.text,
    status: next,
    active: active ?? task.active,
    // A step put away comes back only when it's taken up again, not when it's otherwise changed.
    away: task.away && next === "completed",
  });
  return true;
}

// A task list's checklist keeps its object while the list is unchanged, so its update line's memo
// holds as for wispd's own.
const checklists = new WeakMap<Item, Todo>();

/**
 * The transcript with Claude Code's task tools as checklists (RYA-248). Claude Code 2.1.283 keeps
 * its plan with TaskCreate and TaskUpdate in place of TodoWrite, one step per call, in a list that
 * lasts the session, across turns and resumes. So after each call that changes it, the whole list
 * goes in as a checklist, as wispd puts one after TodoWrite, and the plan card and strip read it
 * the same way. A list whose every step is done is put away when the next turn starts, as Claude
 * Code's own view of it is; a step a later TaskUpdate touches comes back.
 */
export function withTaskLists<R extends { kind: string; key: string }>(
  rows: readonly (Item | R)[],
): (Item | R)[] {
  const tasks = new Map<string, Task>();
  const shown = () => [...tasks.values()].filter((t) => !t.away);
  const out: (Item | R)[] = [];
  for (const row of rows) {
    out.push(row);
    const item = row as Item;
    if (item.kind === "user" && shown().every((t) => t.status === "completed"))
      for (const task of tasks.values()) task.away = true;
    if (item.kind !== "tool" || !applyTask(tasks, item)) continue;
    const steps = shown();
    const items = steps.map(({ text, status }) => ({ text, status }));
    const active = steps.find((t) => t.status === "inProgress")?.active;
    const cached = checklists.get(item);
    if (cached && sameList(cached.items, items) && cached.active === active) {
      out.push(cached);
      continue;
    }
    const { key, at } = item;
    const list: Todo = {
      kind: "todo",
      key: `${key}:tasks`,
      items,
      ...(at && { at }),
      ...(active && { active }),
    };
    checklists.set(item, list);
    out.push(list);
  }
  return out;
}

/** The task tools that only read the list, whose rows say nothing the plan doesn't. */
const taskReads = ["TaskList", "TaskGet"];

/**
 * The transcript with its plans: each turn's first non-empty checklist becomes a plan row showing
 * the turn's latest, and later ones stay as updates, except one that changes nothing, as Codex
 * sends its last list again. A `TodoWrite` call followed by its checklist goes, as the checklist
 * stands for it, unless it failed, and so does a task tool's call (`withTaskLists`); TaskList and
 * TaskGet go unless they failed. `ExitPlanMode` becomes a proposed plan row, out of the work
 * around it. User rows split turns, and so does a proposed plan: the work that carries it out gets
 * its own card, under it.
 */
export function withPlans<R extends { kind: string; key: string }>(
  transcript: readonly (Item | R)[],
): (Item | R | PlanRow | ProposedPlanRow)[] {
  const rows = withTaskLists(transcript);
  const out: (Item | R | PlanRow | ProposedPlanRow)[] = [];
  let plan: PlanRow | undefined;
  let last: AgentTodoItem[] | undefined;
  rows.forEach((row, i) => {
    const item = row as Item;
    if (item.kind === "user") {
      plan = undefined;
      last = undefined;
    } else if (item.kind === "tool") {
      const next = rows[i + 1] as Item | undefined;
      if (item.name === "TodoWrite" && next?.kind === "todo" && !failed(item)) return;
      if (next?.key === `${item.key}:tasks`) return;
      if (taskReads.includes(item.name ?? "") && !failed(item)) return;
      const proposed = proposedPlan(item);
      if (proposed !== undefined) {
        const { key, at, callId, status } = item;
        const row: ProposedPlanRow = proposals.get(item) ?? {
          kind: "proposedPlan",
          key,
          at,
          plan: proposed,
          callId,
          status,
        };
        proposals.set(item, row);
        out.push(row);
        plan = undefined;
        last = undefined;
        return;
      }
    } else if (item.kind === "todo") {
      if (last && sameList(last, item.items)) {
        last = item.items;
        return;
      }
      if (!plan) {
        // An empty checklist before any plan has nothing to show.
        if (item.items.length === 0) return;
        plan = { kind: "plan", key: item.key, at: item.at, items: item.items };
        out.push(plan);
      } else {
        const cached = updates.get(item);
        const update = cached && cached.previous === last ? cached : { ...item, previous: last };
        updates.set(item, update);
        out.push(update);
        // A cleared checklist leaves the card on the last plan it had.
        if (item.items.length > 0) plan.items = item.items;
      }
      last = item.items;
      return;
    }
    out.push(row);
  });
  if (plan) plan.latest = true;
  return out;
}

/**
 * The latest turn's plan, for the strip: its checklist, and the step under way as it's said. As in
 * `withPlans`, a proposed plan starts afresh.
 */
export function latestPlan(
  transcript: readonly Item[],
): { items: AgentTodoItem[]; active?: string } | undefined {
  const items = withTaskLists(transcript);
  const at = items.findLastIndex(
    (i) => i.kind === "todo" || i.kind === "user" || proposedPlan(i) !== undefined,
  );
  const todo = items[at];
  if (todo?.kind !== "todo" || todo.items.length === 0) return undefined;
  if (todo.active) return { items: todo.items, active: todo.active };
  // TodoWrite says each step's `activeForm`, "Running the tests"; the checklist keeps only `text`.
  const now = todo.items.find((s) => s.status === "inProgress");
  const call = items[at - 1];
  const todos =
    call?.kind === "tool" && call.name === "TodoWrite" && isObject(call.input)
      ? call.input["todos"]
      : undefined;
  const step = Array.isArray(todos)
    ? todos.find((t) => isObject(t) && t["content"] === now?.text)
    : undefined;
  const active = isObject(step) ? step["activeForm"] : undefined;
  return typeof active === "string" && active
    ? { items: todo.items, active }
    : { items: todo.items };
}

/**
 * What an update changed, for its line: "Finished: Add tests · Started: Run the checks". A step by
 * new text, as a renamed one, is added whatever its state, so it never claims to have just
 * finished. More than two steps in a change read as a count. Empty when nothing changed.
 */
export function planChanges(
  before: readonly AgentTodoItem[],
  after: readonly AgentTodoItem[],
): string {
  const was = new Map(before.map((s) => [s.text, s.status]));
  const kept = new Set(after.map((s) => s.text));
  const changes = {
    Finished: [] as string[],
    Started: [] as string[],
    Paused: [] as string[],
    Reopened: [] as string[],
    Added: [] as string[],
    Removed: before.filter((s) => !kept.has(s.text)).map((s) => s.text),
  };
  for (const { text, status } of after) {
    const old = was.get(text);
    if (old === undefined) changes.Added.push(text);
    else if (old === "completed" && status !== "completed") changes.Reopened.push(text);
    else if (status === "completed" && old !== "completed") changes.Finished.push(text);
    else if (status === "inProgress" && old !== "inProgress") changes.Started.push(text);
    else if (old === "inProgress" && status !== "inProgress") changes.Paused.push(text);
  }
  const said = Object.entries(changes)
    .filter(([, steps]) => steps.length > 0)
    .map(([verb, steps]) =>
      steps.length > 2 ? `${verb} ${steps.length} steps` : `${verb}: ${steps.join(", ")}`,
    )
    .join(" · ");
  const order = (list: readonly AgentTodoItem[]) => list.map((s) => s.text).join("\n");
  return said || (order(before) !== order(after) ? "Reordered the steps" : "");
}

/** A step's state. A status newer than this app counts as to do. */
const stateOf = (status: string) =>
  status === "completed" ? "done" : status === "inProgress" ? "now" : "todo";
const stateLabels = { done: "Done", now: "In progress", todo: "To do" };
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
 * state. A step under way shows `loader` while the run goes (`live`). A step the card showed
 * unfinished draws its check as it finishes; one done before then, as on scrolling back, or that
 * comes done, as a renamed one, just shows it.
 */
export const PlanCard = memo(function PlanCard({
  items,
  live,
  loader,
}: {
  items: readonly AgentTodoItem[];
  live: boolean;
  loader: LoaderStyle;
}) {
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
      <div className="flex items-center gap-2 text-[13px]">
        <ListChecks aria-hidden className="size-3.5 shrink-0 text-faint-foreground" />
        <span id={id} className="flex-1 font-medium">
          Plan
        </span>
        <span className="text-[12px] text-muted-foreground tabular-nums">
          {done} of {items.length} done
        </span>
      </div>
      <ProgressBar done={done} total={items.length} className="mt-2.5 h-[3px]" />
      <ol className="mt-2.5">
        {items.map((step, i) => (
          <Step key={keys[i]} step={step} live={live} loader={loader} draw={shown.has(keys[i]!)} />
        ))}
      </ol>
    </div>
  );
});

function Step({
  step,
  live,
  loader,
  draw,
}: {
  step: AgentTodoItem;
  live: boolean;
  loader: LoaderStyle;
  draw: boolean;
}) {
  const state = stateOf(step.status);
  return (
    <li className="plan-step relative flex gap-2.5 py-1">
      <span className="grid h-5 w-4 shrink-0 place-items-center">
        <Marker state={state} live={live} loader={loader} draw={draw} />
      </span>
      <span
        className={`min-w-0 text-[13px] leading-5 transition-colors duration-300 motion-reduce:transition-none ${
          state === "done"
            ? "text-faint-foreground"
            : state === "now"
              ? "text-foreground"
              : "text-muted-foreground"
        }`}
      >
        <span className="sr-only">{stateLabels[state]}: </span>
        {step.text}
      </span>
    </li>
  );
}

/**
 * A step's mark: a check when done, the loader in a soft accent disc while under way (a still dot
 * once the run stops), or a hollow dot.
 */
function Marker({
  state,
  live,
  loader,
  draw = false,
}: {
  state: "done" | "now" | "todo";
  live: boolean;
  loader: LoaderStyle;
  draw?: boolean;
}) {
  if (state === "done") return <Check draw={draw} />;
  if (state === "todo")
    return <span className="size-[9px] rounded-full border-[1.5px] border-faint-foreground/70" />;
  return (
    <span className="grid size-4 place-items-center rounded-full bg-accent/15">
      {live ? (
        <Loader {...loader} size={14} />
      ) : (
        <span className="size-1.5 rounded-full bg-accent" />
      )}
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
 * One line for a later update to the turn's plan, in the work it came in: what changed, such as
 * "Finished: Add tests". The full list is the turn's plan card.
 */
export function PlanUpdateLine({ item }: { item: PlanUpdate }) {
  const changes = item.previous ? planChanges(item.previous, item.items) : "";
  return (
    // Indented past a tool call's chevron, so its icon lines up with theirs.
    <p className="flex min-w-0 items-center gap-2 py-0.5 pl-5.5 text-[13px]">
      <ListChecks aria-hidden className="size-3.5 shrink-0 text-faint-foreground" />
      <span className="shrink-0 font-medium">
        {item.items.length === 0 ? "Cleared the plan" : "Updated the plan"}
      </span>
      {changes && (
        <span className="truncate text-muted-foreground" title={changes}>
          {changes}
        </span>
      )}
    </p>
  );
}

/**
 * The plan over the composer while the run goes: the step under way (as TodoWrite says it, when it
 * does), how many are done, and a mini bar. It's tucked behind the box, as the tab is under it, and
 * opens the full card above itself.
 */
export function PlanStrip({
  items,
  active,
  loader,
  returnFocus,
}: {
  items: readonly AgentTodoItem[];
  active?: string;
  loader: LoaderStyle;
  /** Moves focus on, such as to the composer, when the strip goes with focus in it. Read once. */
  returnFocus?: () => void;
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
    <section
      ref={section}
      aria-label="Plan"
      className="plan-strip mx-5 -mb-4 rounded-t-3xl border border-b-0 border-border bg-surface pb-4"
    >
      <button
        type="button"
        popoverTarget={id}
        aria-expanded={open}
        title={open ? "Hide the plan" : "Show the plan"}
        className="flex w-full min-w-0 items-center gap-2.5 rounded-t-3xl py-2 pr-3.5 pl-4 text-left text-[13px] hover:bg-hover"
      >
        <span className="grid size-4 shrink-0 place-items-center">
          <Marker state={now ? "now" : next ? "todo" : "done"} live loader={loader} />
        </span>
        <span className="min-w-0 flex-1 truncate">
          {next ? (
            <>
              <span className="sr-only">{now ? "In progress: " : "Next: "}</span>
              {now ? (active ?? now.text) : next.text}
            </>
          ) : (
            "All steps done"
          )}
        </span>
        <span className="shrink-0 text-[12px] text-muted-foreground tabular-nums">
          {done} of {items.length}
          <span className="sr-only"> done</span>
        </span>
        <ProgressBar done={done} total={items.length} className="h-[3px] w-12 shrink-0" />
        <ChevronUp
          aria-hidden
          className={`size-3.5 shrink-0 text-faint-foreground transition-transform motion-reduce:transition-none ${open ? "rotate-180" : ""}`}
        />
      </button>
      <div
        id={id}
        popover="auto"
        // Before it shows, so it never shows empty.
        onBeforeToggle={(e: ToggleEvent<HTMLDivElement>) => setOpen(e.newState === "open")}
        className="inset-auto m-0 mb-2 max-h-[min(60vh,32rem)] w-[anchor-size(width)] overflow-y-auto rounded-xl border-0 bg-transparent p-0 text-foreground shadow-composer [position-area:top_span-right] [position-try-fallbacks:flip-block]"
      >
        {/* Only while open, so it mounts with the steps done so far drawn, not drawing. */}
        {open && <PlanCard items={items} live loader={loader} />}
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
 * keeps whether it's open, by `id`. `actions` go at its foot, such as approving it (RYA-196).
 */
export function ProposedPlan({
  id,
  status,
  open,
  onToggle,
  actions,
  children,
}: {
  id: string;
  /** How its call ended: one that was denied or failed says so. */
  status?: AgentToolStatus;
  open: boolean;
  onToggle: (key: string, open: boolean) => void;
  actions?: ReactNode;
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
    const measure = () => setLong(el.scrollHeight > collapsedHeight + slack);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  const folded = long && !open;
  return (
    <div
      role="group"
      aria-labelledby={verdict ? `${headingId} ${verdictId}` : headingId}
      className="overflow-hidden rounded-xl border border-border bg-surface"
    >
      <div className="flex items-center gap-2 border-b border-border px-4 py-2.5 text-[13px]">
        <ClipboardList aria-hidden className="size-3.5 shrink-0 text-faint-foreground" />
        <span id={headingId} className="flex-1 font-medium">
          Proposed plan
        </span>
        {verdict && (
          <span
            id={verdictId}
            className="flex shrink-0 items-center gap-1.5 text-[12px] text-danger"
          >
            {verdict.icon}
            {verdict.label}
          </span>
        )}
      </div>
      <div
        className="relative overflow-hidden px-4 pt-3 pb-3.5"
        style={folded ? { maxHeight: collapsedHeight } : undefined}
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
          className="flex w-full items-center gap-1.5 px-4 pt-0.5 pb-3 text-[12.5px] text-muted-foreground hover:text-foreground"
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
