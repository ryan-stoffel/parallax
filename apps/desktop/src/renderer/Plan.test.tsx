// @vitest-environment happy-dom
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, test, vi } from "vite-plus/test";

import type {
  AgentOutputItem,
  AgentTodoItem,
  AgentToolStatus,
  JsonValue,
  LoggedEvent,
  ParallaxEvent,
} from "../protocol/generated/protocol";
import { MarkdownText } from "./AgentChat";
import type { LoaderStyle } from "./Loader";
import {
  latestPlan,
  PlanCard,
  planChanges,
  PlanStrip,
  PlanUpdateLine,
  ProposedPlan,
  withPlans,
  withTaskLists,
  type PlanRow,
  type PlanUpdate,
} from "./Plan";
import { applyEvents, emptyTranscript, type Item } from "./transcript";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

let root: Root | undefined;
afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  document.body.innerHTML = "";
});

function render(node: ReactNode) {
  root ??= createRoot(document.body.appendChild(document.createElement("div")));
  act(() => root!.render(node));
}

const planning: LoaderStyle = { kind: "lift", variant: "breathe" };
const step = (text: string, status: string) => ({ text, status }) as AgentTodoItem;
const steps = (...states: string[]) => states.map((s, i) => step(`Step ${i + 1}`, s));

const user = (key: string): Item => ({ kind: "user", key, text: "go" });
const todo = (key: string, items: AgentTodoItem[]): Item => ({ kind: "todo", key, items });
const todoWrite = (key: string, status?: "ok" | "error"): Item => ({
  kind: "tool",
  key,
  callId: key,
  name: "TodoWrite",
  input: {
    todos: [
      { content: "Step 1", status: "completed", activeForm: "Doing step 1" },
      { content: "Step 2", status: "in_progress", activeForm: "Doing step 2" },
    ],
  },
  ...(status && { status }),
});
const read: Item = { kind: "tool", key: "r", callId: "r", name: "Read", input: {} };

test("a turn's first checklist becomes its plan, showing the turn's latest; later ones are updates", () => {
  const first = steps("inProgress", "pending");
  const second = steps("completed", "inProgress");
  const third = steps("completed", "completed");
  const rows = withPlans([
    user("u1"),
    todoWrite("w1"),
    todo("t1", first),
    read,
    todoWrite("w2"),
    todo("t2", second),
    todoWrite("w3", "ok"),
    todo("t3", third),
    // The same list again, as Codex sends its last one when the turn ends: nothing to say.
    todoWrite("w4", "ok"),
    todo("t4", steps("completed", "completed")),
  ]);
  // Each TodoWrite call goes, as its checklist stands for it.
  expect(rows.map((r) => r.kind)).toEqual(["user", "plan", "tool", "todo", "todo"]);
  // Where the first one was, with the latest.
  expect(rows[1]).toMatchObject({ kind: "plan", key: "t1", items: third, latest: true });
  expect((rows[3] as PlanUpdate).previous).toBe(first);
  expect((rows[4] as PlanUpdate).previous).toBe(second);
});

test("a proposed plan starts afresh, so the work that carries it out gets its own card under it", () => {
  const exit: Item = {
    kind: "tool",
    key: "x",
    callId: "x",
    name: "ExitPlanMode",
    input: { plan: "## Plan" },
  };
  const during = steps("inProgress", "pending");
  const after = steps("completed", "inProgress");
  const rows = withPlans([
    user("u1"),
    todo("t1", during),
    exit,
    todo("t2", during),
    todo("t3", after),
  ]);
  expect(rows.map((r) => [r.kind, r.key])).toEqual([
    ["user", "u1"],
    ["plan", "t1"],
    ["proposedPlan", "x"],
    // Not an unchanged list: the card before the proposal doesn't count.
    ["plan", "t2"],
    ["todo", "t3"],
  ]);
  expect(rows.filter((r): r is PlanRow => r.kind === "plan").map((p) => p.latest)).toEqual([
    undefined,
    true,
  ]);
  // The strip, too: nothing until the work after it writes a list.
  expect(latestPlan([user("u1"), todo("t1", during), exit])).toBeUndefined();
  expect(latestPlan([user("u1"), todo("t1", during), exit, todo("t2", after)])).toEqual({
    items: after,
  });
});

test("user rows split turns: each turn has its own plan, and only the last can be in progress", () => {
  const rows = withPlans([
    user("u1"),
    todo("t1", steps("inProgress")),
    user("u2"),
    read,
    todo("t2", steps("pending")),
  ]);
  const plans = rows.filter((r): r is PlanRow => r.kind === "plan");
  expect(plans.map((p) => [p.key, p.latest])).toEqual([
    ["t1", undefined],
    ["t2", true],
  ]);
  // Rows of other kinds, such as a message on its way, pass through.
  const pending = { kind: "pending" as const, key: "p" };
  expect(withPlans([user("u1"), pending])).toEqual([user("u1"), pending]);
});

test("a failed TodoWrite stays, an empty first checklist shows nothing, and a cleared one keeps the card", () => {
  const items = steps("completed");
  const rows = withPlans([
    user("u1"),
    todo("t0", []),
    todoWrite("w1", "error"),
    todo("t1", items),
    todo("t2", []),
  ]);
  expect(rows.map((r) => r.kind)).toEqual(["user", "tool", "plan", "todo"]);
  expect(rows[2]).toMatchObject({ items });
});

test("ExitPlanMode's plan becomes its own row; without a plan it stays a tool call", () => {
  const exit = (input: JsonValue): Item => ({
    kind: "tool",
    key: "x",
    callId: "c1",
    name: "ExitPlanMode",
    input,
    status: "ok",
  });
  expect(withPlans([exit({ plan: "## Plan" })])).toEqual([
    { kind: "proposedPlan", key: "x", plan: "## Plan", callId: "c1", status: "ok" },
  ]);
  // From the same items, the same rows, so the transcript's memo skips them.
  const items = [
    exit({ plan: "## Plan" }),
    todo("t1", steps("pending")),
    todo("t2", steps("done")),
  ];
  const [proposed, , update] = withPlans(items);
  const again = withPlans(items);
  expect(again[0]).toBe(proposed);
  expect(again[2]).toBe(update);
  // Too large to carry, as plxd cuts an input over 32 KiB.
  expect(withPlans([exit({ truncated: true, bytes: 40_000 })])[0]!.kind).toBe("tool");
});

test("the strip's plan is the latest turn's, with the step under way as TodoWrite says it", () => {
  const items = steps("completed", "inProgress");
  expect(latestPlan([user("u1"), todoWrite("w1"), todo("t1", items), read])).toEqual({
    items,
    active: "Doing step 2",
  });
  // Without the call before it, the step's own text serves.
  expect(latestPlan([user("u1"), todo("t1", items)])).toEqual({ items });
  // A later turn with no checklist, or a cleared one, has no plan.
  expect(latestPlan([todo("t1", items), user("u2"), read])).toBeUndefined();
  expect(latestPlan([todo("t1", items), todo("t2", [])])).toBeUndefined();
  expect(latestPlan([])).toBeUndefined();
});

// Claude Code 2.1.283's task tools as plxd logs them (RYA-248): the call, and its result's text,
// which is all plxd keeps of it. Without `output`, the result hasn't arrived.
const taskCall = (
  key: string,
  name: string,
  input: JsonValue,
  output?: string,
  status: AgentToolStatus = "ok",
): Item => ({
  kind: "tool",
  key,
  callId: key,
  name,
  input,
  ...(output !== undefined && { status, output }),
});
const create = (key: string, id: string, subject: string, activeForm?: string) =>
  taskCall(
    key,
    "TaskCreate",
    { subject, description: `${subject}, in full.`, ...(activeForm && { activeForm }) },
    `Task #${id} created successfully: ${subject}`,
  );
/** A TaskUpdate as 2.1.283 answers one it applied: "Updated task #1 status". */
const update = (key: string, input: Record<string, string>) =>
  taskCall(
    key,
    "TaskUpdate",
    input,
    `Updated task #${input["taskId"]} ${Object.keys(input)
      .filter((k) => k !== "taskId")
      .join(", ")}`,
  );
// plxd's log of a run, rebuilt as useAgentRun does: a call and its result are logged apart.
const runId = "01a0d360-1a2b-7c3d-8e4f-5a6b7c8d9e01";
let seq = 0;
const at = (event: ParallaxEvent): LoggedEvent => ({ seq: ++seq, time: "", event });
const output = (...items: AgentOutputItem[]) => at({ kind: "agent.output", runId, items });
const call = (callId: string, name: string, input: JsonValue, result: string) => [
  output({ kind: "toolCall", callId, name, input }),
  output({ kind: "toolResult", callId, status: "ok", output: result }),
];
const plans = (rows: ReturnType<typeof withPlans>) =>
  rows.filter((r): r is PlanRow => r.kind === "plan");
const tools = (rows: ReturnType<typeof withPlans>) =>
  rows.flatMap((r) => (r.kind === "tool" ? [(r as Item & { name: string }).name] : []));

test("Claude Code's task tools build the plan: a step for each TaskCreate, changed by TaskUpdate's id", () => {
  const rows = withPlans([
    user("u1"),
    create("c1", "1", "Add tests", "Adding tests"),
    create("c2", "2", "Run the checks"),
    update("p1", { taskId: "1", status: "in_progress" }),
    read,
    update("p2", { taskId: "1", status: "completed" }),
    update("p3", { taskId: "2", subject: "Run all the checks", activeForm: "Running them" }),
    create("c3", "3", "Drop this"),
    update("p4", { taskId: "3", status: "deleted" }),
    update("p5", { taskId: "2", status: "in_progress" }),
  ]);
  // Each call goes, as its checklist stands for it, and the card shows the latest.
  expect(rows.map((r) => r.kind).join(" ")).toBe(
    "user plan todo todo tool todo todo todo todo todo",
  );
  expect(tools(rows)).toEqual(["Read"]);
  expect(rows[1]).toMatchObject({
    key: "c1:tasks",
    items: [step("Add tests", "completed"), step("Run all the checks", "inProgress")],
    latest: true,
  });
  const lines = rows
    .filter((r): r is PlanUpdate => r.kind === "todo")
    .map((r) => planChanges(r.previous!, r.items));
  expect(lines).toEqual([
    "Added: Run the checks",
    "Started: Add tests",
    "Finished: Add tests",
    "Added: Run all the checks · Removed: Run the checks",
    "Added: Drop this",
    "Removed: Drop this",
    "Started: Run all the checks",
  ]);
  // The strip says the step under way as its `activeForm` does, as Claude Code's spinner would.
  const items = [user("u1"), create("c1", "1", "Add tests", "Adding tests")];
  expect(latestPlan(items)).toEqual({ items: [step("Add tests", "pending")] });
  items.push(update("p1", { taskId: "1", status: "in_progress" }));
  expect(latestPlan(items)).toEqual({
    items: [step("Add tests", "inProgress")],
    active: "Adding tests",
  });
  expect(latestPlan([...items, create("c2", "2", "Ship")])?.active).toBe("Adding tests");
  // A step with no `activeForm` is said by its subject, as there.
  expect(
    latestPlan([
      user("u1"),
      create("c2", "2", "Ship"),
      update("p2", { taskId: "2", status: "in_progress" }),
    ]),
  ).toEqual({ items: [step("Ship", "inProgress")] });
});

test("TaskList and TaskGet change nothing and go; calls that failed or matched nothing stay", () => {
  const rows = withPlans([
    user("u1"),
    create("c1", "1", "Add tests"),
    taskCall("l1", "TaskList", {}, "#1 [pending] Add tests"),
    taskCall("g1", "TaskGet", { taskId: "1" }, "Task #1: Add tests\nStatus: pending"),
    // Still running: nothing to say yet either.
    taskCall("l2", "TaskList", {}),
    taskCall("g2", "TaskGet", { taskId: "1" }, "<tool_use_error>Error</tool_use_error>", "error"),
    // 2.1.283 answers an update it didn't apply in words, without failing the call: a task it
    // can't find, or a TaskCompleted hook's refusal.
    taskCall("p1", "TaskUpdate", { taskId: "9", status: "completed" }, "Task not found"),
    taskCall("p2", "TaskUpdate", { taskId: "1", status: "completed" }, "Run the tests first."),
    taskCall("p3", "TaskUpdate", { taskId: "1", status: "bogus" }, "InputValidationError", "error"),
    taskCall("p4", "TaskUpdate", { taskId: "1", status: "completed" }, "Denied.", "denied"),
    taskCall("c2", "TaskCreate", { subject: "Hooked", description: "x" }, "Blocked", "error"),
  ]);
  expect(rows.map((r) => r.kind)).toEqual(["user", "plan", ...Array(6).fill("tool")]);
  expect(rows.slice(2).map((r) => r.key)).toEqual(["g2", "p1", "p2", "p3", "p4", "c2"]);
  expect(plans(rows)[0]!.items).toEqual([step("Add tests", "pending")]);
  // Only a read: no plan at all.
  expect(withPlans([user("u1"), taskCall("l1", "TaskList", {}, "No tasks found")])).toEqual([
    user("u1"),
  ]);
});

test("a TaskCreate shows its step before its result, and when its result can't be read", () => {
  // Before the result: the step shows at once, under its call.
  expect(
    plans(withPlans([user("u1"), taskCall("c1", "TaskCreate", { subject: "Add tests" })])),
  ).toMatchObject([{ items: [step("Add tests", "pending")] }]);
  // A result in other words keeps the step, but no id to update it by: the update's row stays.
  const unread = withPlans([
    user("u1"),
    taskCall("c1", "TaskCreate", { subject: "Add tests" }, "Made it."),
    update("p1", { taskId: "1", status: "completed" }),
  ]);
  expect(unread.map((r) => r.kind)).toEqual(["user", "plan", "tool"]);
  expect(plans(unread)[0]!.items).toEqual([step("Add tests", "pending")]);
  // An input too large to carry still has its subject in the result.
  const cut = taskCall(
    "c1",
    "TaskCreate",
    { truncated: true, bytes: 40_000 },
    "Task #1 created successfully: Add tests",
  );
  expect(plans(withPlans([user("u1"), cut]))[0]!.items).toEqual([step("Add tests", "pending")]);
  // An update still waiting on its result counts, as it almost always lands.
  const waiting = taskCall("p1", "TaskUpdate", { taskId: "1", status: "in_progress" });
  expect(plans(withPlans([user("u1"), cut, waiting]))[0]!.items).toEqual([
    step("Add tests", "inProgress"),
  ]);
});

test("the task list lasts across turns, and a finished one is put away when the next turn starts", () => {
  const rows = withPlans([
    user("u1"),
    create("c1", "1", "Add tests"),
    create("c2", "2", "Run the checks"),
    update("p1", { taskId: "1", status: "in_progress" }),
    user("u2"),
    read,
    // The next turn picks up where the last stopped: its card is the whole list.
    update("p2", { taskId: "1", status: "completed" }),
    update("p3", { taskId: "2", status: "completed" }),
    user("u3"),
    // All done, so a new turn's plan starts afresh, though ids go on.
    create("c3", "3", "Ship it"),
    user("u4"),
    update("p4", { taskId: "3", status: "completed" }),
    user("u5"),
    // A step taken up again comes back, in its place.
    update("p5", { taskId: "1", status: "in_progress" }),
  ]);
  expect(plans(rows).map((p) => [p.key, p.items, p.latest])).toEqual([
    ["c1:tasks", [step("Add tests", "inProgress"), step("Run the checks", "pending")], undefined],
    ["p2:tasks", [step("Add tests", "completed"), step("Run the checks", "completed")], undefined],
    ["c3:tasks", [step("Ship it", "pending")], undefined],
    ["p4:tasks", [step("Ship it", "completed")], undefined],
    ["p5:tasks", [step("Add tests", "inProgress")], true],
  ]);
  // The strip: a turn whose list hasn't changed yet has none.
  expect(latestPlan([user("u1"), create("c1", "1", "Add tests"), user("u2")])).toBeUndefined();
});

test("TodoWrite and the task tools in one run make one plan: whichever wrote last", () => {
  const rows = withPlans([
    user("u1"),
    todoWrite("w1"),
    todo("t1", steps("completed", "inProgress")),
    user("u2"),
    // A resumed CLI with the task tools, as after an update.
    create("c1", "1", "Add tests", "Adding tests"),
    update("p1", { taskId: "1", status: "in_progress" }),
    user("u3"),
    todoWrite("w2"),
    todo("t2", steps("completed", "completed")),
    update("p2", { taskId: "1", status: "completed" }),
  ]);
  expect(tools(rows)).toEqual([]);
  expect(plans(rows).map((p) => [p.key, p.items])).toEqual([
    ["t1", steps("completed", "inProgress")],
    ["c1:tasks", [step("Add tests", "inProgress")]],
    ["t2", [step("Add tests", "completed")]],
  ]);
  expect(rows.at(-1)).toMatchObject({ kind: "todo", previous: steps("completed", "completed") });
  // The strip, too, reads whichever came last.
  const items = [user("u1"), create("c1", "1", "Add tests", "Adding tests"), todoWrite("w1")];
  expect(latestPlan([...items, todo("t1", steps("completed", "inProgress"))])).toEqual({
    items: steps("completed", "inProgress"),
    active: "Doing step 2",
  });
});

test("a task list rebuilt from the logged events, as on opening a thread or resuming it, is the same plan", () => {
  const events = [
    output({ kind: "turnStarted", turnId: "t1", text: "Add tests" }),
    ...call("c1", "TaskCreate", { subject: "Add tests", description: "d" }, "Task #1 created"),
    ...call("c2", "TaskCreate", { subject: "Run the checks", description: "d" }, "Task #2 created"),
    ...call("p1", "TaskUpdate", { taskId: "1", status: "in_progress" }, "Updated task #1 status"),
    at({ kind: "agent.finished", runId, outcome: { status: "interrupted" } }),
    // The thread resumed: a new CLI, the same session, so the same list.
    output({ kind: "turnStarted", turnId: "t2", text: "Go on" }),
    ...call("p2", "TaskUpdate", { taskId: "1", status: "completed" }, "Updated task #1 status"),
  ];
  const whole = applyEvents(emptyTranscript, events, runId);
  // A page at a time, as useAgentRun loads them, then live events.
  const paged = [events.slice(0, 3), events.slice(3, 8), events.slice(8)].reduce(
    (t, page) => applyEvents(t, page, runId),
    emptyTranscript,
  );
  expect(paged.items).toEqual(whole.items);
  const rows = withPlans(whole.items);
  expect(plans(rows).map((p) => p.items)).toEqual([
    [step("Add tests", "inProgress"), step("Run the checks", "pending")],
    [step("Add tests", "completed"), step("Run the checks", "pending")],
  ]);
  expect(tools(rows)).toEqual([]);
  expect(latestPlan(whole.items)).toEqual({
    items: [step("Add tests", "completed"), step("Run the checks", "pending")],
  });
});

test("a TaskUpdate counts by the id its result names, whichever name its call gave the id (RYA-250)", () => {
  // 2.1.283 reads `id`, then `task_id`, as `taskId`, and `active_form` as `activeForm`, on both
  // tools. Its answer names the id it used.
  const items = [
    user("u1"),
    create("c1", "1", "Add tests"),
    taskCall(
      "c2",
      "TaskCreate",
      { subject: "Run the checks", description: "d", active_form: "Running the checks" },
      "Task #2 created successfully: Run the checks",
    ),
    taskCall(
      "p1",
      "TaskUpdate",
      { id: "1", status: "in_progress", active_form: "Adding tests" },
      "Updated task #1 status, activeForm",
    ),
  ];
  expect(latestPlan(items)).toEqual({
    items: [step("Add tests", "inProgress"), step("Run the checks", "pending")],
    active: "Adding tests",
  });
  const later = [
    taskCall("p2", "TaskUpdate", { task_id: "1", status: "completed" }, "Updated task #1 status"),
    // With both, the CLI reads `id` first.
    taskCall(
      "p3",
      "TaskUpdate",
      { id: "2", task_id: "1", status: "in_progress" },
      "Updated task #2 status",
    ),
  ];
  const rows = withPlans([...items, ...later]);
  expect(tools(rows)).toEqual([]);
  expect(plans(rows)[0]!.items).toEqual([
    step("Add tests", "completed"),
    step("Run the checks", "inProgress"),
  ]);
  expect(latestPlan([...items, ...later])?.active).toBe("Running the checks");
  // Its result's id counts even when the call's can't be read, as for an input too large to carry:
  // it applied, so its row goes.
  const cut = taskCall(
    "p2",
    "TaskUpdate",
    { truncated: true, bytes: 40_000 },
    "Updated task #1 subject, description",
  );
  expect(tools(withPlans([...items, cut]))).toEqual([]);
  // While the result is on its way, the call's id counts, by whichever name it has.
  for (const name of ["id", "task_id"]) {
    const waiting = taskCall("p2", "TaskUpdate", { [name]: "2", status: "completed" });
    expect(plans(withPlans([...items, waiting]))[0]!.items).toEqual([
      step("Add tests", "inProgress"),
      step("Run the checks", "completed"),
    ]);
  }
});

test("a new session starts a new task list, as an account fallback's does; a resume keeps its own (RYA-250)", () => {
  const events = [
    output({ kind: "sessionStarted", sessionId: "first" }),
    output({ kind: "turnStarted", turnId: "t1", text: "Add tests" }),
    ...call("c1", "TaskCreate", { subject: "Add tests", description: "d" }, "Task #1 created"),
    ...call("c2", "TaskCreate", { subject: "Run the checks", description: "d" }, "Task #2 created"),
    ...call("c3", "TaskCreate", { subject: "Ship it", description: "d" }, "Task #3 created"),
    ...call("p1", "TaskUpdate", { taskId: "1", status: "in_progress" }, "Updated task #1 status"),
    // The attempt was rate limited: the request runs again on another account, in a new session
    // whose ids start at 1 again.
    at({
      kind: "agent.accountFallback",
      runId,
      fromAccount: "claude",
      toAccount: "01a0d34b-3c4d-7e5f-a061-7b8c9d0e1f22",
      reason: "rateLimited",
    }),
    output({ kind: "sessionStarted", sessionId: "second" }),
    ...call("c4", "TaskCreate", { subject: "Write tests", description: "d" }, "Task #1 created"),
    ...call("c5", "TaskCreate", { subject: "Check them", description: "d" }, "Task #2 created"),
    at({ kind: "agent.finished", runId, outcome: { status: "interrupted" } }),
    // The thread resumed: the same session, so the same list.
    output({ kind: "sessionStarted", sessionId: "second" }),
    output({ kind: "turnStarted", turnId: "t2", text: "Go on" }),
    ...call("p2", "TaskUpdate", { taskId: "2", status: "in_progress" }, "Updated task #2 status"),
  ];
  const upTo = (n: number) => applyEvents(emptyTranscript, events.slice(0, n), runId).items;
  // The new session drops the failed attempt's steps, so the strip says nothing until it plans.
  const fallback = events.findIndex((e) => e.event.kind === "agent.accountFallback");
  expect(latestPlan(upTo(fallback + 1))?.items).toHaveLength(3);
  expect(upTo(fallback + 2).at(-1)).toMatchObject({ kind: "session", sessionId: "second" });
  expect(latestPlan(upTo(fallback + 2))).toBeUndefined();

  const { items } = applyEvents(emptyTranscript, events, runId);
  expect(items.filter((i) => i.kind === "session")).toHaveLength(3);
  const rows = withPlans(items);
  // The session rows go; the fallback's notice stays, and the plan says it was cleared after it.
  expect(rows.map((r) => r.kind).join(" ")).toBe(
    "user plan todo todo todo notice todo todo todo end user plan",
  );
  expect(plans(rows).map((p) => p.items)).toEqual([
    [step("Write tests", "pending"), step("Check them", "pending")],
    [step("Write tests", "pending"), step("Check them", "inProgress")],
  ]);
  const lines = rows
    .filter((r): r is PlanUpdate => r.kind === "todo")
    .map((r) => (r.items.length ? planChanges(r.previous!, r.items) : "Cleared the plan"));
  expect(lines).toEqual([
    "Added: Run the checks",
    "Added: Ship it",
    "Started: Add tests",
    "Cleared the plan",
    "Added: Write tests",
    "Added: Check them",
  ]);
  expect(latestPlan(items)).toEqual({
    items: [step("Write tests", "pending"), step("Check them", "inProgress")],
  });
  // A session whose list showed nothing has nothing to clear; the rows just go.
  const session = (key: string, sessionId: string): Item => ({ kind: "session", key, sessionId });
  expect(withTaskLists([session("s1", "first"), user("u1"), session("s2", "second")])).toEqual([
    user("u1"),
  ]);
});

test("a finished list stays put away through updates that don't reopen a step (RYA-250)", () => {
  const finished = [
    user("u1"),
    create("c1", "1", "Add tests"),
    update("p1", { taskId: "1", status: "completed" }),
    user("u2"),
  ];
  // 2.1.283's answer names only the fields that changed: none for a no-op, or for a step marked
  // done again.
  for (const later of [
    taskCall("p2", "TaskUpdate", { taskId: "1" }, "Updated task #1 "),
    taskCall(
      "p2",
      "TaskUpdate",
      { taskId: "1", description: "More" },
      "Updated task #1 description",
    ),
    taskCall("p2", "TaskUpdate", { taskId: "1", status: "completed" }, "Updated task #1 "),
    taskCall("p2", "TaskUpdate", { taskId: "1", status: "completed" }),
  ]) {
    expect(withPlans([...finished, later]).map((r) => r.kind)).toEqual([
      "user",
      "plan",
      "todo",
      "user",
    ]);
    expect(latestPlan([...finished, later])).toBeUndefined();
  }
  // Taken up again, to do or under way, it comes back.
  for (const [status, state] of [
    ["pending", "pending"],
    ["in_progress", "inProgress"],
  ] as const)
    expect(
      plans(withPlans([...finished, update("p2", { taskId: "1", status })])).at(-1),
    ).toMatchObject({ key: "p2:tasks", items: [step("Add tests", state)], latest: true });
});

test("a task list's checklists, and their update lines, keep their objects while unchanged", () => {
  const items = [
    user("u1"),
    create("c1", "1", "Add tests"),
    update("p1", { taskId: "1", status: "in_progress" }),
  ];
  const lists = withTaskLists(items);
  expect(withTaskLists(items)).toEqual(lists);
  expect(withTaskLists(items)[2]).toBe(lists[2]);
  const [, , update1] = withPlans(items);
  expect(withPlans(items)[2]).toBe(update1);
  // Rows of other kinds pass through.
  const pending = { kind: "pending" as const, key: "p" };
  expect(withTaskLists([pending])).toEqual([pending]);
});

test("an update says what changed", () => {
  const before = [
    step("Read", "completed"),
    step("Build", "inProgress"),
    step("Test", "pending"),
    step("Old", "pending"),
  ];
  expect(
    planChanges(before, [
      step("Read", "pending"),
      step("Build", "completed"),
      step("Test", "inProgress"),
      step("Ship", "pending"),
    ]),
  ).toBe("Finished: Build · Started: Test · Reopened: Read · Added: Ship · Removed: Old");
  // Two at once by name, as Claude Code often finishes them; more as a count.
  expect(planChanges(steps("inProgress", "pending"), steps("completed", "completed"))).toBe(
    "Finished: Step 1, Step 2",
  );
  expect(planChanges([], steps("pending", "pending", "pending"))).toBe("Added 3 steps");
  // A done step taken up again reopens it, rather than starting it.
  expect(planChanges([step("Read", "completed")], [step("Read", "inProgress")])).toBe(
    "Reopened: Read",
  );
  // A renamed done step is new, not just finished.
  expect(planChanges([step("Old", "completed")], [step("New", "completed")])).toBe(
    "Added: New · Removed: Old",
  );
  // A step set aside, back to to do.
  expect(planChanges([step("Build", "inProgress")], [step("Build", "pending")])).toBe(
    "Paused: Build",
  );
  // The same steps in a new order.
  expect(planChanges(before, [before[2]!, before[0]!, before[1]!, before[3]!])).toBe(
    "Reordered the steps",
  );
  expect(planChanges(before, [...before])).toBe("");
});

test("an update is one line: Updated the plan, and what changed", () => {
  render(
    <PlanUpdateLine
      item={{
        kind: "todo",
        key: "t",
        items: steps("completed", "inProgress"),
        previous: steps("inProgress", "pending"),
      }}
    />,
  );
  expect(document.body.textContent).toBe("Updated the planFinished: Step 1 · Started: Step 2");
  render(<PlanUpdateLine item={{ kind: "todo", key: "t", items: [], previous: steps("done") }} />);
  expect(document.body.textContent).toBe("Cleared the planRemoved: Step 1");
});

test("the plan card: its progress, then each step in its state, as text for screen readers", () => {
  const items = [
    ...steps("completed", "completed", "inProgress", "pending"),
    step("New", "unknown"),
  ];
  render(<PlanCard items={items} live loader={planning} />);
  const card = document.querySelector('[role="group"]')!;
  expect(card.getAttribute("aria-labelledby")).toBe(card.querySelector("span[id]")!.id);
  expect(card.querySelector("span[id]")!.textContent).toBe("Plan");
  expect(card.textContent).toContain("2 of 5 done");
  expect(card.querySelector<HTMLElement>(".plan-bar")!.style.width).toBe("40%");
  expect([...card.querySelectorAll("li")].map((li) => li.textContent)).toEqual([
    "Done: Step 1",
    "Done: Step 2",
    "In progress: Step 3",
    "To do: Step 4",
    "To do: New",
  ]);
  // The step under way draws the planning loader, and only it does.
  expect(card.querySelectorAll(".loader")).toHaveLength(1);
  expect(
    card.querySelector('li:nth-child(3) [data-loader="lift"][data-variant="breathe"]'),
  ).not.toBeNull();

  // Once the run stops, nothing moves.
  render(<PlanCard items={items} live={false} loader={planning} />);
  expect(document.querySelector(".loader")).toBeNull();
});

test("a step that finishes while the card shows draws its check; one done before, as on scrolling back, doesn't", () => {
  const drawn = () => document.querySelectorAll(".plan-check-draw").length;
  render(<PlanCard items={steps("completed", "inProgress", "pending")} live loader={planning} />);
  expect(document.querySelectorAll(".plan-check")).toHaveLength(1);
  expect(drawn()).toBe(0);
  render(<PlanCard items={steps("completed", "completed", "inProgress")} live loader={planning} />);
  expect(drawn()).toBe(1);
  expect(document.querySelector<HTMLElement>(".plan-bar")!.style.width).toBe(`${(2 / 3) * 100}%`);
  // A fresh card, as a virtualized row remounts.
  act(() => root!.unmount());
  root = undefined;
  render(<PlanCard items={steps("completed", "completed", "inProgress")} live loader={planning} />);
  expect(drawn()).toBe(0);
});

test("a done step keeps its check as steps come and go around it, or as it's renamed", () => {
  const checks = () => [...document.querySelectorAll(".plan-check")];
  const card = (...items: AgentTodoItem[]) =>
    render(<PlanCard items={items} live loader={planning} />);
  card(step("Read", "completed"), step("Build", "inProgress"));
  const read = checks()[0];
  // A step inserted above it: the same check, not drawn again.
  card(step("Plan", "pending"), step("Read", "completed"), step("Build", "inProgress"));
  expect(checks()[0]).toBe(read);
  expect(document.querySelector(".plan-check-draw")).toBeNull();
  // Removed again, and Build finishes: only Build's draws.
  card(step("Read", "completed"), step("Build", "completed"));
  expect(checks()[0]).toBe(read);
  expect(document.querySelectorAll(".plan-check-draw")).toHaveLength(1);
  // Renamed, a done step doesn't draw either; repeated text keeps one key each.
  card(step("Read it", "completed"), step("Build", "completed"), step("Build", "pending"));
  expect(document.querySelectorAll(".plan-check-draw")).toHaveLength(1);
  card(step("Read it", "completed"), step("Build", "completed"), step("Build", "completed"));
  expect(document.querySelectorAll(".plan-check-draw")).toHaveLength(2);
});

test("the strip is a labeled region: the step under way, progress, and a toggle for the whole plan", () => {
  const items = steps("completed", "completed", "inProgress", "pending", "pending");
  render(<PlanStrip items={items} active="Doing step 3" loader={planning} />);
  const region = document.querySelector('section[aria-label="Plan"]')!;
  const toggle = region.querySelector("button")!;
  expect(toggle.textContent).toBe("In progress: Doing step 32 of 5 done");
  expect(toggle.querySelector('[data-loader="lift"]')).not.toBeNull();
  expect(toggle.getAttribute("aria-expanded")).toBe("false");
  const popover = document.getElementById(toggle.getAttribute("popovertarget")!)!;
  expect(popover.getAttribute("popover")).toBe("auto");
  // The card mounts only while it's open, from just before it shows.
  const toggling = (newState: string) =>
    act(() => void popover.dispatchEvent(Object.assign(new Event("beforetoggle"), { newState })));
  expect(popover.childElementCount).toBe(0);
  toggling("open");
  expect(toggle.getAttribute("aria-expanded")).toBe("true");
  expect(popover.querySelector('[role="group"]')!.textContent).toContain("2 of 5 done");
  toggling("closed");
  expect(toggle.getAttribute("aria-expanded")).toBe("false");

  // Going with focus in it, it hands focus on.
  const returnFocus = vi.fn();
  render(<PlanStrip items={items} loader={planning} returnFocus={returnFocus} />);
  render(<p />);
  expect(returnFocus).not.toHaveBeenCalled();
  render(<PlanStrip items={items} loader={planning} returnFocus={returnFocus} />);
  act(() => document.querySelector("button")!.focus());
  render(<p />);
  expect(returnFocus).toHaveBeenCalledOnce();

  // With nothing under way, the next step; with everything done, says so.
  render(<PlanStrip items={steps("completed", "pending")} loader={planning} />);
  expect(document.querySelector("button")!.textContent).toBe("Next: Step 21 of 2 done");
  render(<PlanStrip items={steps("completed")} loader={planning} />);
  expect(document.querySelector("button")!.textContent).toBe("All steps done1 of 1 done");
  expect(document.querySelector(".loader")).toBeNull();
});

// happy-dom lays nothing out: the proposed plan's height, as measured.
let planHeight = 0;
Object.defineProperty(HTMLElement.prototype, "scrollHeight", {
  configurable: true,
  get(this: HTMLElement) {
    return this.classList.contains("proposed-plan") ? planHeight : 0;
  },
});

test("a proposed plan renders its Markdown safely, folds when long, and keeps room for actions", () => {
  const onToggle = vi.fn();
  const plan = "## Plan\n\n1. Read <b>it</b>\n2. ![x](https://example.com/x.png)\n\n```\nls\n```";
  const proposed = (open: boolean, actions?: ReactNode) =>
    render(
      <ProposedPlan id="x" open={open} onToggle={onToggle} actions={actions}>
        <MarkdownText text={plan} />
      </ProposedPlan>,
    );

  planHeight = 200;
  proposed(false);
  const card = document.querySelector('[role="group"]')!;
  expect(document.getElementById(card.getAttribute("aria-labelledby")!)!.textContent).toBe(
    "Proposed plan",
  );
  expect(card.querySelector("h2")!.textContent).toBe("Plan");
  // No raw HTML, and no images loaded.
  expect(card.querySelector("b")).toBeNull();
  expect(card.querySelector("img")).toBeNull();
  // Short: no fold.
  expect(card.querySelector("button[aria-expanded]")).toBeNull();
  // Focus within doesn't open what isn't folded.
  act(() => card.querySelector<HTMLButtonElement>('[aria-label="Copy code"]')!.focus());
  expect(onToggle).not.toHaveBeenCalled();

  act(() => root!.unmount());
  root = undefined;
  planHeight = 1000;
  proposed(false);
  const more = document.querySelector<HTMLButtonElement>("button[aria-expanded]")!;
  expect(more.textContent).toBe("Show full plan");
  expect(more.getAttribute("aria-expanded")).toBe("false");
  expect(
    document.querySelector<HTMLElement>(".proposed-plan")!.parentElement!.style.maxHeight,
  ).toBe("368px");
  act(() => more.click());
  expect(onToggle).toHaveBeenLastCalledWith("x", true);
  // Tabbing to a control under the fold, as a code block's Copy, opens it. A click doesn't, as
  // mouse focus isn't :focus-visible (which happy-dom doesn't tell apart, so it's stubbed).
  const copy = document.querySelector<HTMLButtonElement>('[aria-label="Copy code"]')!;
  const byMouse = vi.spyOn(copy, "matches").mockReturnValue(false);
  onToggle.mockClear();
  act(() => copy.focus());
  expect(onToggle).not.toHaveBeenCalled();
  act(() => copy.blur());
  byMouse.mockRestore();
  act(() => copy.focus());
  expect(onToggle).toHaveBeenCalledWith("x", true);

  proposed(true, <button type="button">Approve</button>);
  expect(document.querySelector("button[aria-expanded]")!.textContent).toBe("Show less");
  expect(
    document.querySelector<HTMLElement>(".proposed-plan")!.parentElement!.style.maxHeight,
  ).toBe("");
  expect([...document.querySelectorAll("button")].at(-1)!.textContent).toBe("Approve");
});

test("a proposed plan that was denied or failed says so", () => {
  const header = (status?: AgentToolStatus) => {
    render(
      <ProposedPlan id="x" status={status} open={false} onToggle={() => {}}>
        <MarkdownText text="## Plan" />
      </ProposedPlan>,
    );
    const card = document.querySelector('[role="group"]')!;
    const heading = card.querySelector(":scope > div")!;
    // The card's accessible name, from what labels it.
    const name = card
      .getAttribute("aria-labelledby")!
      .split(" ")
      .map((id) => document.getElementById(id)!.textContent)
      .join(" ");
    return [heading.textContent, name, heading.querySelector(".text-danger svg") !== null];
  };
  expect(header("denied")).toEqual([
    "Proposed planNot approved",
    "Proposed plan Not approved",
    true,
  ]);
  expect(header("error")).toEqual(["Proposed planFailed", "Proposed plan Failed", true]);
  expect(header("ok")).toEqual(["Proposed plan", "Proposed plan", false]);
  expect(header()).toEqual(["Proposed plan", "Proposed plan", false]);
});
