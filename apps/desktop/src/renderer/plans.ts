// The agent's plan as the transcript and the strip over the composer read it (PLX-220): a turn's
// checklist from TodoWrite or Claude Code's task tools (PLX-248), its updates, and Claude Code's
// proposed plan. Pure, so the mobile app shares it; Plan.tsx draws them.
import type {
  AgentTodoItem,
  AgentTodoStatus,
  AgentToolStatus,
  JsonValue,
} from "../protocol/generated/protocol";
import { field, isObject, type Item } from "./transcript";

type Todo = Extract<Item, { kind: "todo" }>;
type Tool = Extract<Item, { kind: "tool" }>;

/**
 * A turn's plan, in place of its first checklist: the turn's latest checklist, so its line
 * updates in place.
 */
export interface PlanRow {
  kind: "plan";
  key: string;
  at?: string;
  items: AgentTodoItem[];
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
 * `active_form` for `activeForm`, so those count too (PLX-250).
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
// holds as for plxd's own.
const checklists = new WeakMap<Item, Todo>();

/**
 * The transcript with Claude Code's task tools as checklists (PLX-248). Claude Code 2.1.283 keeps
 * its plan with TaskCreate and TaskUpdate in place of TodoWrite, one step per call, in a list that
 * lasts the session, across turns and resumes. So after each call that changes it, the whole list
 * goes in as a checklist, as plxd puts one after TodoWrite, and the plan lines and strip read it
 * the same way. A list whose every step is done is put away when the next turn starts, as Claude
 * Code's own view of it is; a step a later TaskUpdate reopens comes back. The session rows go: a
 * new session, as an account fallback starts with ids from 1 again, starts a new list, and clears
 * the plan if it showed steps, while a resume keeps its session and so its list (PLX-250).
 */
export function withTaskLists<R extends { kind: string; key: string }>(
  rows: readonly (Item | R)[],
): (Item | R)[] {
  const tasks = new Map<string, Task>();
  const shown = () => [...tasks.values()].filter((t) => !t.away);
  let session: string | undefined;
  const out: (Item | R)[] = [];
  for (const row of rows) {
    const item = row as Item;
    if (item.kind === "session") {
      const fresh = session !== undefined && item.sessionId !== session;
      session = item.sessionId;
      if (!fresh) continue;
      // Steps that showed give way to an empty checklist, so the strip drops them.
      const showing = shown().length > 0;
      tasks.clear();
      if (!showing) continue;
    } else {
      out.push(row);
      if (item.kind === "user" && shown().every((t) => t.status === "completed"))
        for (const task of tasks.values()) task.away = true;
      if (item.kind !== "tool" || !applyTask(tasks, item)) continue;
    }
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
 * its own plan, under it.
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
        // A cleared checklist leaves the plan on the last list it had.
        if (item.items.length > 0) plan.items = item.items;
      }
      last = item.items;
      return;
    }
    out.push(row);
  });
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
