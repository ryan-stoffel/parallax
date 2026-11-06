import { expect, test } from "vite-plus/test";

import type {
  AgentOutputItem,
  AgentTodoItem,
  AgentToolStatus,
  JsonValue,
  LoggedEvent,
  ParallaxEvent,
} from "../protocol/generated/protocol";
import {
  latestPlan,
  planChanges,
  withPlans,
  withTaskLists,
  type PlanRow,
  type PlanUpdate,
} from "./plans";
import { applyEvents, emptyTranscript, type Item } from "./transcript";

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
  expect(rows[1]).toMatchObject({ kind: "plan", key: "t1", items: third });
  expect((rows[3] as PlanUpdate).previous).toBe(first);
  expect((rows[4] as PlanUpdate).previous).toBe(second);
});

// Claude Code 2.1.283's task tools as plxd logs them (PLX-248): the call, and its result's text,
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
  expect(plans(rows).map((p) => [p.key, p.items])).toEqual([
    ["c1:tasks", [step("Add tests", "inProgress"), step("Run the checks", "pending")]],
    ["p2:tasks", [step("Add tests", "completed"), step("Run the checks", "completed")]],
    ["c3:tasks", [step("Ship it", "pending")]],
    ["p4:tasks", [step("Ship it", "completed")]],
    ["p5:tasks", [step("Add tests", "inProgress")]],
  ]);
  // The strip: a turn whose list hasn't changed yet has none.
  expect(latestPlan([user("u1"), create("c1", "1", "Add tests"), user("u2")])).toBeUndefined();
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

test("a TaskUpdate counts by the id its result names, whichever name its call gave the id (PLX-250)", () => {
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

test("a new session starts a new task list, as an account fallback's does; a resume keeps its own (PLX-250)", () => {
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
