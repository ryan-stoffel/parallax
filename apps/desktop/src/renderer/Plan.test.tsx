// @vitest-environment happy-dom
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, test, vi } from "vite-plus/test";

import type { AgentTodoItem, AgentToolStatus, JsonValue } from "../protocol/generated/protocol";
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
  type PlanRow,
  type PlanUpdate,
} from "./Plan";
import type { Item } from "./transcript";

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
  // Too large to carry, as wispd cuts an input over 32 KiB.
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
